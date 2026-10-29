/**
 * owner 字段测试（t24）：单元、存储读写与过滤、老库迁移正确性与幂等性（任务数不变）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { normalizeOwner, splitOwnerLabels } from "../src/core/owner.mjs";
import { openStore } from "../src/core/store.mjs";

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `t24-${label}-`));

test("normalizeOwner：trim / 压缩空白 / 空值 → null / 超长报错", () => {
  assert.equal(normalizeOwner("  engineer "), "engineer");
  assert.equal(normalizeOwner("dev   team"), "dev team");
  assert.equal(normalizeOwner(""), null);
  assert.equal(normalizeOwner("   "), null);
  assert.equal(normalizeOwner(null), null);
  assert.equal(normalizeOwner(undefined), null);
  assert.throws(() => normalizeOwner("x".repeat(41)), (error) => error.code === "INVALID_FIELD");
});

test("splitOwnerLabels：抽出最后的 owner 标签，其余标签原样保留", () => {
  assert.deepEqual(splitOwnerLabels(["bug", "owner:engineer", "ui"]), { owner: "engineer", labels: ["bug", "ui"] });
  assert.deepEqual(splitOwnerLabels(["owner:planner", "owner:reviewer"]), { owner: "reviewer", labels: [] });
  assert.deepEqual(splitOwnerLabels(["bug"]), { owner: "", labels: ["bug"] });
  assert.deepEqual(splitOwnerLabels([]), { owner: "", labels: [] });
  assert.deepEqual(splitOwnerLabels(["owner:"]), { owner: "", labels: [] });
});

test("存储：owner 字段读写与过滤（不再写进 labels）", () => {
  const dir = freshDir("store");
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "带负责人", owner: "engineer", labels: "bug, ui" });
    assert.equal(task.owner, "engineer");
    assert.deepEqual(task.labels, ["bug", "ui"], "owner 不得出现在 labels 里");

    const second = store.createTask({ projectId: "demo", title: "无负责人" });
    assert.equal(second.owner, null);

    assert.deepEqual(store.listTasks({ owner: "engineer" }).map((t) => t.identifier), ["demo-1"]);
    assert.deepEqual(store.listTasks({ owner: "nobody" }).map((t) => t.identifier), []);
    // owner="" 规范化为 null → 语义是「筛选未指派」
    assert.deepEqual(store.listTasks({ owner: "" }).map((t) => t.identifier), ["demo-2"]);

    const updated = store.updateTask(task.id, { expectedVersion: task.version, owner: "tester" });
    assert.equal(updated.owner, "tester");
    assert.equal(updated.version, 2);
    assert.deepEqual(store.listTasks({ owner: "tester" }).map((t) => t.identifier), ["demo-1"]);
    assert.deepEqual(store.listTasks({ owner: "engineer" }).map((t) => t.identifier), []);

    const cleared = store.updateTask(updated.id, { expectedVersion: updated.version, owner: null });
    assert.equal(cleared.owner, null);
    assert.deepEqual(store.listTasks({ owner: "" }).map((t) => t.identifier), ["demo-1", "demo-2"]);

    // 防御：即使直接塞 owner 标签进 labels，更新时也会被剔除
    const dirty = store.updateTask(cleared.id, { expectedVersion: cleared.version, labels: ["bug", "owner:planner"] });
    assert.deepEqual(dirty.labels, ["bug"], "labels 中的历史 owner 标签应被剔除");

    const stats = store.stats();
    assert.equal(stats.tasks, 2);
    assert.equal(stats.ownedTasks, 0, "两个任务的 owner 都为空");
    assert.equal(stats.legacyOwnerLabels, 0);
    // FR-79/FR-82/FR-83/FR-81 + FR-50（team_members.executor）：schema 版本 10
    assert.equal(stats.schemaVersion, 11); // 11：+ 项目记忆（memory_entries / memory_links / memory_recalls）
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 造一个「老库」：t21 结构（tasks 无 owner 列）+ 含 owner:<role> 标签的两条任务。 */
function makeLegacyDatabase(dir) {
  const dbPath = path.join(dir, "taskboard.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table projects (
      id text primary key, name text not null, workspace_path text,
      next_seq integer not null default 1, created_at text not null, updated_at text not null
    );
    create table tasks (
      id text primary key, identifier text not null unique,
      project_id text not null references projects(id) on delete cascade,
      title text not null, description text not null default '',
      status text not null, priority text not null default 'none',
      labels text not null default '[]',
      parent_id text references tasks(id) on delete set null,
      version integer not null default 1, created_at text not null, updated_at text not null
    );
    create table comments (
      id text primary key, task_id text not null references tasks(id) on delete cascade,
      body text not null default '', version integer not null default 1,
      created_at text not null, updated_at text not null
    );
  `);
  const now = "2026-10-01T00:00:00.000Z";
  db.prepare("insert into projects (id,name,workspace_path,next_seq,created_at,updated_at) values (?,?,?,?,?,?)")
    .run("legacy", "Legacy", null, 3, now, now);
  const insert = db.prepare(
    `insert into tasks (id,identifier,project_id,title,description,status,priority,labels,parent_id,version,created_at,updated_at)
     values (?,?,?,?,?,?,?,?,?,1,?,?)`,
  );
  insert.run("t1", "legacy-1", "legacy", "历史任务一", "", "todo", "high", JSON.stringify(["bug", "owner:engineer"]), null, now, now);
  insert.run("t2", "legacy-2", "legacy", "历史任务二", "", "in_progress", "urgent", JSON.stringify(["owner:planner", "ui"]), null, now, now);
  db.close();
  return dbPath;
}

test("迁移：老库的 owner:<role> 标签搬进 owner 字段，labels 被清理，任务数不变", () => {
  const dir = freshDir("migrate");
  try {
    makeLegacyDatabase(dir);

    const store = openStore({ dataDir: dir });
    try {
      assert.deepEqual(store.migration, { addedOwnerColumn: true, migratedTasks: 2, strippedLabels: 2, addedReqSeqColumn: true, addedTaskRequirementColumn: true, addedCandidateSourceColumn: false, addedTaskSessionColumn: true, addedProjectSessionColumn: true, addedClaimColumn: true, addedFailureColumn: true, addedBlockColumn: true, addedRunColumn: true, addedReviewColumn: true, addedHumanReviewColumn: true, addedTaskAcceptanceColumn: true, addedTaskVerifyCommandColumn: true, addedCommentEditColumn: true, addedBoardPositionColumn: true, addedTeamMemberExecutorColumn: false });
      assert.equal(store.stats().tasks, 2, "迁移前后任务数必须不变");
      const one = store.getTaskRef("legacy-1");
      assert.equal(one.owner, "engineer");
      assert.deepEqual(one.labels, ["bug"]);
      const two = store.getTaskRef("legacy-2");
      assert.equal(two.owner, "planner");
      assert.deepEqual(two.labels, ["ui"]);
      assert.deepEqual(store.listTasks({ owner: "engineer" }).map((t) => t.identifier), ["legacy-1"]);
      assert.equal(store.stats().legacyOwnerLabels, 0, "迁移后不应再存在 owner: 标签");
      const next = store.createTask({ projectId: "legacy", title: "迁移后新建" });
      assert.equal(next.identifier, "legacy-3", "编号计数不受迁移影响");
    } finally {
      store.close();
    }

    // 幂等：再次打开同一库不重复迁移、不丢数据
    const again = openStore({ dataDir: dir });
    try {
      assert.deepEqual(again.migration, { addedOwnerColumn: false, migratedTasks: 0, strippedLabels: 0, addedReqSeqColumn: false, addedTaskRequirementColumn: false, addedCandidateSourceColumn: false, addedTaskSessionColumn: false, addedProjectSessionColumn: false, addedClaimColumn: false, addedFailureColumn: false, addedBlockColumn: false, addedRunColumn: false, addedReviewColumn: false, addedCommentEditColumn: false, addedBoardPositionColumn: false, addedTeamMemberExecutorColumn: false });
      assert.equal(again.stats().tasks, 3, "二次打开不得改变任务数");
      assert.equal(again.getTaskRef("legacy-1").owner, "engineer");
      assert.deepEqual(again.getTaskRef("legacy-1").labels, ["bug"]);
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移：owner 已有值时以字段为准，仅清理残留标签（不覆盖）", () => {
  const dir = freshDir("migrate-partial");
  try {
    makeLegacyDatabase(dir);
    // 模拟「列已存在且 owner 已填」的半迁移状态
    const db = new DatabaseSync(path.join(dir, "taskboard.sqlite"));
    db.exec("alter table tasks add column owner text");
    db.prepare("update tasks set owner = ? where id = ?").run("reviewer", "t1");
    db.close();

    const store = openStore({ dataDir: dir });
    try {
      assert.equal(store.migration.addedOwnerColumn, false);
      assert.equal(store.migration.migratedTasks, 2, "t1 需清标签、t2 需补 owner");
      assert.equal(store.getTaskRef("legacy-1").owner, "reviewer", "已有 owner 不被标签覆盖");
      assert.deepEqual(store.getTaskRef("legacy-1").labels, ["bug"]);
      assert.equal(store.getTaskRef("legacy-2").owner, "planner");
      assert.equal(store.stats().tasks, 2);

      // 再打开一次仍然是 0（幂等）
      store.close();
      const again = openStore({ dataDir: dir });
      try {
        // FR-17：新增 `addedCommentEditColumn`（评论编辑留痕列，老库补列）
        assert.deepEqual(again.migration, { addedOwnerColumn: false, migratedTasks: 0, strippedLabels: 0, addedReqSeqColumn: false, addedTaskRequirementColumn: false, addedCandidateSourceColumn: false, addedTaskSessionColumn: false, addedProjectSessionColumn: false, addedClaimColumn: false, addedFailureColumn: false, addedBlockColumn: false, addedRunColumn: false, addedReviewColumn: false, addedCommentEditColumn: false, addedBoardPositionColumn: false, addedTeamMemberExecutorColumn: false });
      } finally {
        again.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
