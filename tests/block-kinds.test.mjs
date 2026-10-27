/** FR-80：阻断原因分类 + 复发升级。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, BLOCK_KINDS, BLOCK_RECURRENCE_LIMIT, TRIAGE_LABEL, routeBlock } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

test("routeBlock（纯函数）：dependency 回待执行；其它进受阻；同因复发递达阈值即人工兜底", () => {
  assert.equal(BLOCK_RECURRENCE_LIMIT, 2);
  const dep = routeBlock({ kind: "dependency" });
  assert.equal(dep.status, "todo");
  assert.equal(dep.eventKind, "dependency_wait");
  assert.equal(dep.triage, false);

  const first = routeBlock({ kind: "transient", prevKind: null, prevRecurrences: 0 });
  assert.equal(first.status, "blocked");
  assert.equal(first.recurrences, 1);
  assert.equal(first.triage, false);

  const second = routeBlock({ kind: "transient", prevKind: "transient", prevRecurrences: 1 });
  assert.equal(second.recurrences, 2);
  assert.equal(second.triage, true, "同因第二次即升级人工兜底");
  assert.equal(second.eventKind, "block-loop-detected");

  const diffKind = routeBlock({ kind: "needs_input", prevKind: "transient", prevRecurrences: 5 });
  assert.equal(diffKind.recurrences, 1, "换了原因则重新计数");
  assert.equal(diffKind.triage, false);
});

test("blockTask：dependency 回「可开工」且不进人工受阻；其它类型进受阻并记录类型", () => {
  const { store, t } = setup();
  const dep = store.blockTask(t.identifier, { kind: "dependency", reason: "等父任务" });
  assert.equal(dep.task.status, "todo", "依赖类回到待执行等父任务");
  assert.equal(dep.task.blockKind, "dependency");
  assert.equal(dep.task.triageAt, null);
  assert.ok(store.listComments(t.id).some((c) => /依赖未就绪/.test(c.body)));

  const blk = store.blockTask(t.identifier, { kind: "needs_input", reason: "需要人给参数" });
  assert.equal(blk.task.status, "blocked");
  assert.equal(blk.task.blockKind, "needs_input");
  assert.equal(blk.task.blockRecurrences, 1);
  store.close();
});

test("复发升级：同因再次阻断 → 人工兜底标记 + triage 标签 + 审计", () => {
  const { store, t } = setup();
  store.blockTask(t.identifier, { kind: "capability", reason: "缺能力" });
  store.retryTaskExecution(t.identifier); // 人工介入（撤下兜底标记；**复发计数保留**）
  assert.equal(store.getTaskRef(t.identifier).blockRecurrences, 1, "人工重跑不得清零复发计数（防失忆）");
  assert.equal(store.getTaskRef(t.identifier).blockKind, "capability", "保留 kind 以便识别同因循环");
  const r2 = store.blockTask(t.identifier, { kind: "capability", reason: "还是缺能力" });
  assert.equal(r2.task.status, "blocked");
  assert.equal(r2.task.blockRecurrences, 2, "同因再次阻断即达阈值");
  assert.ok(r2.task.triageAt, "达阈值 → 人工兜底");
  assert.ok(r2.task.labels.includes(TRIAGE_LABEL));
  assert.ok(store.listComments(t.id).some((c) => /阻断循环检测/.test(c.body)));
  assert.ok(store.listGovernanceAudit().some((a) => a.action === "triage"));
  store.close();
});

test("成功清零：提交待验收后 block_kind / 复发计数 / 人工兜底标记全部清除", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.blockTask(t.identifier, { kind: "transient", reason: "a" });
  store.startTaskExecution; // no-op
  const cur = store.getTaskRef(t.identifier);
  store.updateTask(t.identifier, { expectedVersion: cur.version, status: "todo" });
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.submitTaskForReview(t.identifier, {});
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.blockKind, null);
  assert.equal(after.blockRecurrences, 0);
  assert.equal(after.triageAt, null);
  assert.ok(!after.labels.includes(TRIAGE_LABEL));
  store.close();
});

test("类型校验：非法 kind 被拒", () => {
  const { store, t } = setup();
  assert.throws(() => store.blockTask(t.identifier, { kind: "whatever" }), (e) => e.code === "INVALID_FIELD");
  for (const k of BLOCK_KINDS) assert.doesNotThrow(() => store.blockTask(t.identifier, { kind: k }));
  store.close();
});

test("API：/triage 列出人工兜底任务；/execution 暴露 block 信息；执行侧工具带 kind", async () => {
  const { store, t } = setup();
  store.blockTask(t.identifier, { kind: "transient", reason: "x" });
  store.blockTask(t.identifier, { kind: "transient", reason: "y" }); // → triage
  const router = createApiRouter({ store });
  const triage = await router.route({ method: "GET", pathname: "/api/projects/p1/triage", searchParams: new URLSearchParams() });
  assert.equal(triage.payload.count, 1);
  assert.equal(triage.payload.tasks[0].identifier, t.identifier);
  assert.equal(triage.payload.tasks[0].blockKind, "transient");
  assert.equal(triage.payload.tasks[0].blockRecurrences, 2);
  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.equal(exec.payload.blockKind, "transient");
  assert.ok(exec.payload.triageAt);
  store.close();
});

test("执行侧工具：taskboard_update_status 置受阻时带 kind → 走分类入口", async () => {
  const { store, t } = setup();
  const defs = new Map();
  registerTaskboardTools({ store, tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const r = await defs.get("taskboard_update_status").execute({ ref: t.identifier, status: "blocked", kind: "needs_input", reason: "缺参数" }, { agent: { id: "s1" } });
  assert.equal(r.status, "blocked");
  assert.equal(r.blockKind, "needs_input");
  assert.equal(store.getTaskRef(t.identifier).blockKind, "needs_input");
  // done 仍被治理拒绝
  await assert.rejects(
    () => defs.get("taskboard_update_status").execute({ ref: t.identifier, status: "done" }, { agent: { id: "s1" } }),
    (e) => e.code === "GOVERNANCE_AGENT_DONE",
  );
  store.close();
});
