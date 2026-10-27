/**
 * FR-17 · 评论编辑（验收要点③「编辑一条评论后内容更新、**原内容不被静默覆盖**」）
 *
 * 条款（docs/需求文档.md §FR-17）：
 *  · 评论可编辑与删除；编辑遵循并发保护（FR-18）。
 *  · 验收要点③：编辑后内容更新，**原内容不被静默覆盖**。
 *
 * 本仓落的口径（三条，用例逐条坐实，不靠注释）：
 *  1. `PATCH /api/tasks/:ref/comments/:id` 返回**更新后的评论**；
 *  2. 乐观锁：`expectedVersion` 必填，不符即 `VERSION_CONFLICT`（退出码 5）——**绝不覆盖**；
 *  3. 留痕＝**保留原文本**（`comment_revisions` 逐版存编辑前正文，可回看），
 *     而非只记"已编辑 N 次"（选强口径的理由见 `store.assertCommentEditable` 上方注释）。
 *
 * 红线（本卡要求④）：编辑不得成为**改写评审证据**的旁路 —— `【自动复核】…` 证据评论只读。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter, httpStatusFor } from "../src/server/api.mjs";
import { EXIT, TbError, toErrorPayload } from "../src/core/errors.mjs";

const staleError = (code) => new TbError(code, "x");

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const task = store.createTask({ projectId: "p1", title: "评论宿主张" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  const patch = (commentId, body) => route("PATCH", `/api/tasks/${task.identifier}/comments/${commentId}`, body);
  return { store, task, router, route, patch };
}

/** 路由层**抛** `TbError`（由 server 统一转错误载荷）；测试里等价于"取回 {error, exitCode}"。 */
async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return { error: error.toJSON(), exitCode: error.exitCode, code: error.code, details: error.details };
  }
  throw new Error("预期本次请求应失败，但它成功了（红线：不得静默通过）");
}

// ── ① 编辑成功：内容更新 + 返回更新后的评论 ──────────────────────────────────
test("PATCH 编辑成功：正文更新、版本 +1、返回体含更新后的评论", async () => {
  const { store, task, patch } = setup();
  const created = store.addComment(task.id, { body: "初次结论：**未复现**" });

  const r = await patch(created.id, { version: created.version, body: "复核后结论：**已复现**（见下方日志）" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.comment.body, "复核后结论：**已复现**（见下方日志）");
  assert.equal(r.payload.changed, true);
  assert.equal(r.payload.comment.version, 2, "编辑后版本递增");
  assert.equal(r.payload.comment.id, created.id, "同一条评论，不是新插入一条");
  assert.equal(r.payload.comment.edited, true);
  assert.equal(r.payload.comment.editCount, 1);
  assert.ok(r.payload.comment.editedAt);

  // 列表里看到的也是新正文，且仍是**一条**评论（没有复制成两条）
  const list = store.listComments(task.id);
  assert.equal(list.length, 1);
  assert.equal(list[0].body, "复核后结论：**已复现**（见下方日志）");
  store.close();
});

test("编辑走 GET 详情：单条评论可读，带历史版本", async () => {
  const { store, task, route, patch } = setup();
  const c = store.addComment(task.id, { body: "第一版" });
  await patch(c.id, { version: c.version, body: "第二版" });
  const got = await route("GET", `/api/tasks/${task.identifier}/comments/${c.id}`);
  assert.equal(got.status, 200);
  assert.equal(got.payload.comment.body, "第二版");
  assert.equal(got.payload.revisions.length, 1);
  assert.equal(got.payload.revisions[0].body, "第一版", "历史里存的是**编辑前**的原正文");
  store.close();
});

// ── ② 冲突拒绝：不静默覆盖（退出码 5） ───────────────────────────────────────
test("版本冲突：expectedVersion 陈旧 → VERSION_CONFLICT（退出码 5），旧内容**原样保留**", async () => {
  const { store, task, patch } = setup();
  const created = store.addComment(task.id, { body: "A 的结论" });

  // 甲先编辑成功
  const first = await patch(created.id, { version: created.version, body: "A 的结论（甲已修订）" });
  assert.equal(first.payload.comment.version, 2);

  // 乙拿着读到的旧版本 v1 提交 —— 必须被拒
  const stale = await failure(patch(created.id, { version: created.version, body: "B 的结论（覆盖）" }));
  assert.equal(stale.error.code, "VERSION_CONFLICT");
  assert.equal(stale.exitCode, EXIT.CONFLICT, "退出码 5");
  assert.equal(httpStatusFor(staleError("VERSION_CONFLICT")), 409, "冲突映射 HTTP 409");
  assert.equal(stale.error.details.expectedVersion, 1);
  assert.equal(stale.error.details.currentVersion, 2);

  // 关键：乙的正文**一个字都没落盘**（不静默覆盖）
  const after = store.getComment(created.id);
  assert.equal(after.body, "A 的结论（甲已修订）");
  assert.equal(after.version, 2);
  assert.equal(after.editCount, 1, "被拒的提交不得产生留痕（它根本没发生过）");
  store.close();
});

test("缺 expectedVersion → MISSING_VERSION（退出码 2），不当作无锁编辑放行", async () => {
  const { store, task, patch } = setup();
  const c = store.addComment(task.id, { body: "原文" });
  const r = await failure(patch(c.id, { body: "想无锁改" }));
  assert.equal(r.error.code, "MISSING_VERSION");
  assert.equal(r.exitCode, EXIT.USAGE);
  assert.equal(store.getComment(c.id).body, "原文");
  // 非法版本值同样拒绝
  const bad = await failure(patch(c.id, { version: 0, body: "x" }));
  assert.equal(bad.error.code, "INVALID_FIELD");
  store.close();
});

test("并发同一版本两次提交：只有一次成功，另一次冲突（CAS 生效）", async () => {
  const { store, task, patch } = setup();
  const c = store.addComment(task.id, { body: "v1" });
  const [a, b] = await Promise.all([
    patch(c.id, { version: 1, body: "甲改" }).catch((e) => e),
    patch(c.id, { version: 1, body: "乙改" }).catch((e) => e),
  ]);
  const codes = [a, b].map((x) => x?.code).sort();
  assert.deepEqual(codes, ["VERSION_CONFLICT", undefined], "恰好一个成功、一个冲突，绝不双双写入");
  assert.equal(store.getComment(c.id).version, 2);
  assert.equal(store.listCommentRevisions(c.id).length, 1, "只留一条痕迹");
  store.close();
});

// ── ③ 留痕：原内容不得无痕消失 ───────────────────────────────────────────────
test("留痕＝保留原文本：多次编辑逐版可回看，且记时间/次数", async () => {
  const { store, task, patch } = setup();
  const c = store.addComment(task.id, { body: "V1 原文" });
  await patch(c.id, { version: 1, body: "V2 正文" });
  const second = await patch(c.id, { version: 2, body: "V3 正文" });

  assert.equal(second.payload.comment.editCount, 2, "编辑次数");
  const revs = store.listCommentRevisions(c.id);
  assert.deepEqual(revs.map((r) => r.body), ["V1 原文", "V2 正文"], "每一版**编辑前的原正文**都在，按序可回放");
  assert.deepEqual(revs.map((r) => r.rev), [1, 2]);
  for (const r of revs) assert.ok(r.editedAt, "每版带编辑时间");

  // 事件流也留一笔（可回溯谁在什么时候编辑过）
  const types = store.listTaskEvents(task.identifier).map((e) => e.type);
  assert.ok(types.includes("comment_edited"));
  store.close();
});

test("无变化提交：不涨版本、不留痕（避免空编辑刷版本）", async () => {
  const { store, task, patch } = setup();
  const c = store.addComment(task.id, { body: "内容不变" });
  const r = await patch(c.id, { version: 1, body: "内容不变" });
  assert.equal(r.payload.changed, false);
  assert.equal(store.getComment(c.id).version, 1);
  assert.equal(store.listCommentRevisions(c.id).length, 0);
  store.close();
});

test("留痕随评论级联删除（不产生孤儿历史）", () => {
  const { store, task } = setup();
  const c = store.addComment(task.id, { body: "会被删" });
  const keep = store.addComment(task.id, { body: "同卡另一条" });
  store.updateComment(c.id, { expectedVersion: 1, body: "改过一次" });
  assert.equal(store.listCommentRevisions(c.id).length, 1);
  store.deleteTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version });
  void keep;
  assert.equal(store.listCommentRevisions(c.id).length, 0);
  assert.equal(store.stats().comments, 0);
  store.close();
});

// ── ④ 红线：不得成为改写评审证据的旁路 ───────────────────────────────────────
test("机器证据评论（【自动复核】…）只读：编辑被拒 COMMENT_NOT_EDITABLE", async () => {
  const { store, task, patch } = setup();
  const evidence = store.addComment(task.id, {
    body: "【自动复核】命令=npm test；退出码=1；耗时=12.3s；结论=失败（退出码 1）\n总结：3 例失败",
  });
  const r = await failure(patch(evidence.id, { version: evidence.version, body: "【自动复核】命令=npm test；退出码=0；耗时=12.3s；结论=通过" }));
  assert.equal(r.error.code, "COMMENT_NOT_EDITABLE");
  assert.equal(r.error.details.reason, "review-evidence-readonly");
  // 证据一字未改
  assert.match(store.getComment(evidence.id).body, /退出码=1/);
  assert.equal(store.listCommentRevisions(evidence.id).length, 0);
  store.close();
});

test("红线的反方向：普通评论不得被**编辑成**证据形态（禁伪造证据）", async () => {
  const { store, task, patch } = setup();
  const plain = store.addComment(task.id, { body: "我手工写的" });
  const r = await failure(patch(plain.id, { version: 1, body: "【自动复核】命令=npm test；退出码=0；耗时=1.0s；结论=通过" }));
  assert.equal(r.error.code, "COMMENT_NOT_EDITABLE");
  assert.equal(r.error.details.reason, "cannot-forge-evidence");
  assert.equal(store.getComment(plain.id).body, "我手工写的");
  store.close();
});

test("人工校验申报评论只读：FR-85 升级门的判定依据不得被事后改写", async () => {
  const { store, task, patch } = setup();
  const decl = store.addComment(task.id, { body: "【人工校验申报】类别=与上游需求不符；证据=R1 验收口径无法满足" });
  const r = await failure(patch(decl.id, { version: 1, body: "【人工校验申报】类别=架构变化；证据=随便改改" }));
  assert.equal(r.error.code, "COMMENT_NOT_EDITABLE");
  assert.equal(r.error.details.reason, "declaration-readonly");
  assert.match(store.getComment(decl.id).body, /与上游需求不符/, "申报原文一字未改");
  store.close();
});

test("编辑**不改任务状态**（执行侧不得借编辑旁路改状态）", async () => {
  const { store, task, patch } = setup();
  const c = store.addComment(task.id, { body: "正文" });
  const statusBefore = store.getTaskRef(task.identifier).status;
  const taskVersionBefore = store.getTaskRef(task.identifier).version;
  // 即便请求里夹带 status，也不在编辑口径内
  await patch(c.id, { version: 1, body: "改过", status: "done" });
  assert.equal(store.getTaskRef(task.identifier).status, statusBefore, "任务状态不变");
  assert.equal(store.getTaskRef(task.identifier).version, taskVersionBefore, "任务版本不变");
  store.close();
});

// ── ⑤ 非法 id / 归属：如实报错 ──────────────────────────────────────────────
test("非法评论 id → COMMENT_NOT_FOUND（退出码 4）", async () => {
  const { task, patch } = setup();
  const r = await failure(patch("not-a-real-id", { version: 1, body: "x" }));
  assert.equal(r.error.code, "COMMENT_NOT_FOUND");
  assert.equal(r.exitCode, EXIT.DATA);
});

test("跨任务编辑：拿别的卡下的评论 id 一律 COMMENT_NOT_FOUND（不越权）", async () => {
  const { store, task, patch } = setup();
  const other = store.createTask({ projectId: "p1", title: "另一张卡" });
  const foreign = store.addComment(other.id, { body: "别的卡的评论" });
  const r = await failure(patch(foreign.id, { version: 1, body: "试图改写" }));
  assert.equal(r.error.code, "COMMENT_NOT_FOUND");
  assert.equal(store.getComment(foreign.id).body, "别的卡的评论", "跨卡不能改");
  // 本卡路径 + 本卡评论仍然正常
  const own = store.addComment(task.id, { body: "本卡" });
  assert.equal((await patch(own.id, { version: 1, body: "本卡改过" })).status, 200);
  store.close();
});

test("任务不存在 → TASK_NOT_FOUND；非 PATCH/GET 的方法被拒", async () => {
  const { store, route, task } = setup();
  const missing = await failure(route("PATCH", "/api/tasks/nope-999/comments/whatever", { version: 1, body: "x" }));
  assert.equal(missing.error.code, "TASK_NOT_FOUND");
  const c = store.addComment(task.id, { body: "x" });
  const del = await failure(route("DELETE", `/api/tasks/${task.identifier}/comments/${c.id}`, {}));
  assert.equal(del.error.code, "USAGE_ERROR");
  store.close();
});

// ── 序列化 / 错误载荷契约 ───────────────────────────────────────────────────
test("评论对象带编辑字段；错误载荷可 JSON 序列化（CLI 口径）", () => {
  const { store, task } = setup();
  const c = store.addComment(task.id, { body: "x" });
  assert.deepEqual(Object.keys(c).sort(), ["body", "createdAt", "editCount", "edited", "editedAt", "editedBy", "id", "taskId", "updatedAt", "version"].sort());
  assert.equal(c.edited, false);
  assert.equal(c.editCount, 0);
  assert.equal(c.editedAt, null);

  let payload = null;
  try {
    store.updateComment(c.id, { expectedVersion: 0, body: "y" });
  } catch (error) {
    payload = toErrorPayload(error);
  }
  assert.equal(payload.error.code, "INVALID_FIELD");
  assert.doesNotThrow(() => JSON.stringify(payload));
  store.close();
});

// ── 老库迁移：comment_revisions 表与 edited_* 列自动补齐（幂等） ─────────────
test("老库（无 edited_at / comment_revisions）打开即幂等补齐", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(os.tmpdir(), "fr17-legacy-"));
  const dbPath = path.join(dir, "taskboard.sqlite");
  try {
    // 造一个"老库"：comments 表没有 edited_at / edited_by 列，也没有 comment_revisions 表
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`create table comments (id text primary key, task_id text not null, body text not null default '', version integer not null default 1, created_at text not null, updated_at text not null);`);
    legacy.exec(`insert into comments values ('c-old', 't-old', '老正文', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`);
    legacy.close();

    const store = openStore({ dbPath });
    try {
      // store 不对外暴露 db 句柄（正确设计）——另开一条只读连接查列，不触碰 store 内部。
      const probe = new DatabaseSync(dbPath);
      const cols = probe.prepare("pragma table_info(comments)").all().map((r) => r.name);
      const tables = probe.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name);
      probe.close();
      assert.ok(cols.includes("edited_at") && cols.includes("edited_by"), "老库自动补 edited_* 列");
      assert.ok(tables.includes("comment_revisions"), "老库自动建留痕表");
      const c = store.getComment("c-old");
      assert.equal(c.body, "老正文", "老数据仍在");
      assert.equal(c.edited, false);
      assert.equal(c.editCount, 0);
      // 老库上编辑也能留痕（表已建）
      const r = store.updateComment("c-old", { expectedVersion: 1, body: "新正文" });
      assert.equal(r.changed, true);
      assert.equal(store.listCommentRevisions("c-old")[0].body, "老正文");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
