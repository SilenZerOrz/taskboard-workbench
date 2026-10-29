/**
 * 存储层测试（node:sqlite）：项目/任务 CRUD、可读编号、七状态、五优先级、标签、
 * 父子（单父/同项目/禁环）、乐观版本冲突、重启后保留、评论。
 *
 * 所有数据都落在 os.tmpdir() 下的临时目录，绝不写入仓库（运行不写仓库的硬约束）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PRIORITIES, STATUSES } from "../src/core/domain.mjs";
import { openStore } from "../src/core/store.mjs";

function freshDir(label) {
  return mkdtempSync(path.join(os.tmpdir(), `t21-${label}-`));
}

function withStore(label, fn) {
  const dir = freshDir(label);
  const store = openStore({ dataDir: dir });
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("项目：创建 / 列表 / 读取；重复 id 冲突；库落在指定数据目录", () => {
  withStore("project", (store, dir) => {
    const demo = store.createProject({ name: "Demo" });
    const other = store.createProject({ id: "other-app", name: "Other", workspacePath: "/tmp/ws" });
    assert.equal(demo.id, "demo");
    assert.equal(demo.name, "Demo");
    assert.equal(other.workspacePath, "/tmp/ws");
    assert.deepEqual(store.listProjects().map((project) => project.id), ["demo", "other-app"]);
    assert.equal(store.getProject("demo").id, "demo");
    assert.equal(store.getProject("missing"), null);
    assert.throws(() => store.createProject({ id: "demo", name: "again" }), (error) => error.code === "PROJECT_EXISTS");
    assert.throws(() => store.requireProject("nope"), (error) => error.code === "PROJECT_NOT_FOUND");

    const dbPath = path.join(dir, "taskboard.sqlite");
    assert.equal(store.dbPath, dbPath);
    assert.ok(statSync(dbPath).size > 0, "SQLite 文件应已落盘");
    assert.equal(store.dataDir, dir);
  });
});

test("任务：创建/读取/更新/删除 + 可读编号项目内单调递增且唯一", () => {
  withStore("task-crud", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const first = store.createTask({ projectId: "demo", title: "第一条" });
    const second = store.createTask({ projectId: "demo", title: "第二条" });
    const third = store.createTask({ projectId: "demo", title: "第三条" });

    assert.equal(first.identifier, "demo-1");
    assert.equal(second.identifier, "demo-2");
    assert.equal(third.identifier, "demo-3");
    assert.equal(new Set([first.identifier, second.identifier, third.identifier]).size, 3);
    assert.equal(first.version, 1);
    assert.equal(first.status, "backlog");
    assert.equal(first.priority, "none");

    // 编号与内部 id 都能定位任务
    assert.equal(store.getTaskRef("demo-2").id, second.id);
    assert.equal(store.getTaskRef(second.id).identifier, "demo-2");
    assert.equal(store.getTaskRef("demo-999"), null);

    const updated = store.updateTask("demo-1", {
      expectedVersion: first.version,
      title: "第一条（改）",
      description: "**Markdown** 描述",
    });
    assert.equal(updated.title, "第一条（改）");
    assert.equal(updated.description, "**Markdown** 描述");
    assert.equal(updated.version, 2);
    assert.equal(updated.identifier, "demo-1", "更新不应改变可读编号");

    const deleted = store.deleteTask("demo-3", { expectedVersion: third.version });
    assert.equal(deleted.identifier, "demo-3");
    assert.equal(store.getTaskRef("demo-3"), null);
    assert.deepEqual(store.listTasks({ projectId: "demo" }).map((task) => task.identifier), ["demo-1", "demo-2"]);

    // 编号继续递增（不回收已删除的序号）
    const fourth = store.createTask({ projectId: "demo", title: "第四条" });
    assert.equal(fourth.identifier, "demo-4");
  });
});

test("七状态与五优先级：逐项可写可读；非法值被拒", () => {
  withStore("enums", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    let sequence = 0;
    for (const status of STATUSES) {
      const task = store.createTask({ projectId: "demo", title: `状态-${status}`, status });
      assert.equal(task.status, status);
      sequence += 1;
      assert.equal(task.identifier, `demo-${sequence}`);
    }
    for (const priority of PRIORITIES) {
      const task = store.createTask({ projectId: "demo", title: `优先级-${priority}`, priority });
      assert.equal(task.priority, priority);
      sequence += 1;
    }
    const template = store.createTask({ projectId: "demo", title: "模板" });
    // 任意状态互转（核心层不限制转移）。
    // 唯一例外（FR-83 补口 · 卡 `-162`）：**从「待验收」收口**要走评审门 —— 这里用 `skipReview: true`
    // 表达「人显式决定跳过评审」，门本身另有 `tests/review-gate.test.mjs` 逐条钉住。
    for (const status of STATUSES) {
      const current = store.getTaskRef(template.id);
      const task = store.updateTask(template.id, { expectedVersion: current.version, status, skipReview: true });
      assert.equal(task.status, status);
    }
    assert.throws(() => store.createTask({ projectId: "demo", title: "坏状态", status: "doing" }), (error) => error.code === "INVALID_STATUS");
    assert.throws(() => store.createTask({ projectId: "demo", title: "坏优先级", priority: "p0" }), (error) => error.code === "INVALID_PRIORITY");
    assert.throws(() => store.createTask({ projectId: "demo", title: "   " }), (error) => error.code === "INVALID_FIELD");
    assert.throws(() => store.createTask({ projectId: "nope", title: "无项目" }), (error) => error.code === "PROJECT_NOT_FOUND");
  });
});

test("标签：添加/移除/筛选", () => {
  withStore("labels", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "带标签", labels: "bug, ui" });
    assert.deepEqual(task.labels, ["bug", "ui"]);

    const added = store.updateTask(task.id, {
      expectedVersion: task.version,
      addLabels: "p1",
      removeLabels: "ui",
    });
    assert.deepEqual(added.labels, ["bug", "p1"]);

    store.createTask({ projectId: "demo", title: "只有 bug", labels: "bug" });
    assert.deepEqual(store.listTasks({ projectId: "demo", labels: ["bug"] }).map((task) => task.title), ["带标签", "只有 bug"]);
    assert.deepEqual(store.listTasks({ projectId: "demo", labels: ["p1"] }).map((task) => task.title), ["带标签"]);
    assert.deepEqual(store.listTasks({ projectId: "demo", labels: ["bug", "p1"] }).map((task) => task.title), ["带标签"]);

    const cleared = store.updateTask(added.id, { expectedVersion: added.version, labels: [] });
    assert.deepEqual(cleared.labels, []);
  });
});

test("父子：单父、同项目、禁止成环；清除后可重新挂载；删父自动解除", () => {
  withStore("parent", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    store.createProject({ id: "other", name: "Other" });
    const parent = store.createTask({ projectId: "demo", title: "父" });
    const child = store.createTask({ projectId: "demo", title: "子", parent: parent.id });
    assert.equal(parent.identifier, "demo-1");
    assert.equal(child.identifier, "demo-2");
    assert.equal(child.parentId, parent.id);

    // 子任务出现在父任务下
    assert.deepEqual(
      store.listTasks({ projectId: "demo", parentId: parent.id }).map((task) => task.identifier),
      [child.identifier],
    );
    // 根任务列表此时只有父任务（子任务被 parentId: null 正确排除）
    assert.deepEqual(
      store.listTasks({ projectId: "demo", parentId: null }).map((task) => task.identifier),
      [parent.identifier],
    );

    const otherParent = store.createTask({ projectId: "demo", title: "另一个父" });
    assert.equal(otherParent.identifier, "demo-3");
    // 新建另一个根任务后，根任务列表为两个，子任务仍被排除
    assert.deepEqual(
      store.listTasks({ projectId: "demo", parentId: null }).map((task) => task.identifier),
      [parent.identifier, otherParent.identifier],
    );

    // 单父：已有父任务时改挂另一个父任务 → 拒绝
    assert.throws(
      () => store.updateTask(child.id, { expectedVersion: child.version, parentId: otherParent.id }),
      (error) => error.code === "PARENT_ALREADY_SET",
    );

    // 跨项目 → 拒绝
    const foreign = store.createTask({ projectId: "other", title: "别的项目的任务" });
    const anotherChild = store.createTask({ projectId: "demo", title: "另一个子" });
    assert.throws(
      () => store.updateTask(anotherChild.id, { expectedVersion: anotherChild.version, parentId: foreign.id }),
      (error) => error.code === "PARENT_CROSS_PROJECT",
    );

    // 成环：parent <- child，再让 parent 的父为 child → 拒绝
    assert.throws(
      () => store.updateTask(parent.id, { expectedVersion: parent.version, parentId: child.id }),
      (error) => error.code === "PARENT_CYCLE",
    );
    // 自环 → 拒绝
    assert.throws(
      () => store.updateTask(parent.id, { expectedVersion: parent.version, parentId: parent.id }),
      (error) => error.code === "PARENT_CYCLE",
    );

    // 清除父后可以重新挂载
    const cleared = store.updateTask(child.id, { expectedVersion: child.version, clearParent: true });
    assert.equal(cleared.parentId, null);
    const reattached = store.updateTask(cleared.id, { expectedVersion: cleared.version, parentId: otherParent.id });
    assert.equal(reattached.parentId, otherParent.id);

    // 删除父任务后，子任务的父子关系被自动解除（FK on delete set null）
    store.deleteTask(otherParent.id, { expectedVersion: otherParent.version });
    assert.equal(store.getTaskRef(reattached.id).parentId, null);
  });
});

test("乐观版本：缺版本/过期版本被拒；成功更新递增版本", () => {
  withStore("version", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "并发" });
    assert.throws(() => store.updateTask(task.id, { status: "todo" }), (error) => error.code === "MISSING_VERSION");
    assert.throws(
      () => store.updateTask(task.id, { expectedVersion: 99, status: "todo" }),
      (error) => error.code === "VERSION_CONFLICT" && error.exitCode === 5,
    );
    const v2 = store.updateTask(task.id, { expectedVersion: task.version, status: "todo" });
    assert.equal(v2.version, 2);
    assert.throws(
      () => store.updateTask(task.id, { expectedVersion: task.version, status: "done" }),
      (error) => error.code === "VERSION_CONFLICT",
    );
    const v3 = store.updateTask(task.id, { expectedVersion: v2.version, status: "done" });
    assert.equal(v3.status, "done");
    assert.equal(v3.version, 3);
    assert.throws(() => store.deleteTask(task.id, { expectedVersion: 1 }), (error) => error.code === "VERSION_CONFLICT");
  });
});

test("重启后数据保留（关闭并重开同一数据目录）", () => {
  const dir = freshDir("reopen");
  try {
    const first = openStore({ dataDir: dir });
    first.createProject({ id: "demo", name: "Demo" });
    const task = first.createTask({ projectId: "demo", title: "重启前", status: "in_review", priority: "high", labels: "persist" });
    first.addComment(task.id, { body: "**重启前**的评论" });
    const before = first.stats();
    first.close();

    const second = openStore({ dataDir: dir });
    const reopened = second.getTaskRef("demo-1");
    assert.equal(reopened.title, "重启前");
    assert.equal(reopened.status, "in_review");
    assert.equal(reopened.priority, "high");
    assert.deepEqual(reopened.labels, ["persist"]);
    assert.equal(reopened.version, task.version);
    const comments = second.listComments("demo-1");
    assert.equal(comments.length, 1);
    assert.equal(comments[0].body, "**重启前**的评论");

    // 编号继续递增（计数器同样持久）
    const next = second.createTask({ projectId: "demo", title: "重启后" });
    assert.equal(next.identifier, "demo-2");
    assert.deepEqual(second.stats(), { ...before, tasks: before.tasks + 1 });
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("评论：可为空/长 Markdown，与任务绑定，任务删除后级联删除", () => {
  withStore("comments", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "评论宿主" });
    const empty = store.addComment(task.id, { body: "" });
    assert.equal(empty.body, "");
    const rich = store.addComment("demo-1", { body: "# 标题\n\n- [ ] 待办\n\n| a | b |\n| - | - |\n| 1 | 2 |" });
    assert.match(rich.body, /\| a \| b \|/);
    // 插入顺序稳定（同一毫秒也按 rowid 排序）
    assert.deepEqual(store.listComments(task.id).map((comment) => comment.id), [empty.id, rich.id]);
    assert.throws(() => store.listComments("missing-1"), (error) => error.code === "TASK_NOT_FOUND");
    assert.equal(store.stats().comments, 2);

    store.deleteTask(task.id, { expectedVersion: task.version });
    assert.equal(store.stats().comments, 0, "任务删除应级联删除评论");
    assert.throws(() => store.listComments("demo-1"), (error) => error.code === "TASK_NOT_FOUND");
    assert.throws(() => store.deleteComment(rich.id), (error) => error.code === "COMMENT_NOT_FOUND");
  });
});

test("治理能力位：默认允许智能体置 done；enforce 时拒绝（能力位不改默认行为）", () => {
  withStore("governance-default", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "治理" });
    const done = store.updateTask(task.id, { expectedVersion: task.version, status: "done", actor: "agent" });
    assert.equal(done.status, "done");
  });

  const dir = freshDir("governance-enforce");
  try {
    const store = openStore({ dataDir: dir, policy: { enforce: true } });
    store.createProject({ id: "demo", name: "Demo" });
    const task = store.createTask({ projectId: "demo", title: "治理" });
    assert.throws(
      () => store.updateTask(task.id, { expectedVersion: task.version, status: "done", actor: "agent" }),
      (error) => error.code === "AGENT_CANNOT_SET_DONE",
    );
    assert.throws(
      () => store.updateTask(task.id, { expectedVersion: task.version, status: "in_progress", actor: "agent" }),
      (error) => error.code === "AGENT_CANNOT_CLAIM_BACKLOG",
    );
    const human = store.updateTask(task.id, { expectedVersion: task.version, status: "done", actor: "human" });
    assert.equal(human.status, "done");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("查询筛选：按项目/状态/优先级/父任务过滤，按优先级排序", () => {
  withStore("filters", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    store.createProject({ id: "other", name: "Other" });
    store.createTask({ projectId: "demo", title: "高", priority: "high" });
    store.createTask({ projectId: "demo", title: "急", priority: "urgent", status: "todo" });
    store.createTask({ projectId: "demo", title: "无", priority: "none", status: "done" });
    store.createTask({ projectId: "other", title: "别家的" });

    assert.equal(store.listTasks({ projectId: "demo" }).length, 3);
    assert.equal(store.listTasks().length, 4, "不传 projectId 时列出全部项目");
    assert.deepEqual(store.listTasks({ projectId: "demo", status: "todo" }).map((task) => task.title), ["急"]);
    assert.deepEqual(store.listTasks({ projectId: "demo", priority: "urgent" }).map((task) => task.title), ["急"]);
    assert.deepEqual(store.listTasks({ projectId: "demo", sort: "priority" }).map((task) => task.priority), ["urgent", "high", "none"]);
    assert.deepEqual(store.listTasks({ projectId: "demo", parentId: null }).map((task) => task.title), ["高", "急", "无"]);
  });
});
