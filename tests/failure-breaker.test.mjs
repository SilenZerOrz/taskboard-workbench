/** FR-78：失败会计与熔断（连续失败计数 / 配额不重试 / 近期成功窗口）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, DEFAULT_FAILURE_LIMIT, DEFAULT_SUCCESS_WINDOW_MS } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

test("连续失败：达阈值（默认 2）→ 自动受阻 + 熔断留痕 + 审计 gave-up", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const r1 = store.recordTaskFailure(t.identifier, { error: "第一次失败" });
  assert.equal(r1.tripped, false);
  assert.equal(r1.failures, 1);
  assert.equal(store.getTaskRef(t.identifier).status, "in_progress", "未达阈值不改变状态");
  const r2 = store.recordTaskFailure(t.identifier, { error: "第二次失败" });
  assert.equal(r2.tripped, true);
  assert.equal(r2.failures, 2);
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.status, "blocked", "达阈值自动置受阻");
  assert.equal(after.claimLock, null, "熔断时释放认领");
  assert.ok(store.listComments(t.id).some((c) => /已熔断/.test(c.body)));
  assert.ok(store.listGovernanceAudit().some((a) => a.action === "gave-up" && !a.allowed));
  assert.equal(store.dispatchGuard(t.identifier), "circuit-open");
  store.close();
});

test("成功清零：提交待验收后失败计数归零、熔断解除", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.recordTaskFailure(t.identifier, { error: "偶发失败" });
  assert.equal(store.getTaskRef(t.identifier).consecutiveFailures, 1);
  store.submitTaskForReview(t.identifier, { comment: "本轮通过" });
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.status, "in_review");
  assert.equal(after.consecutiveFailures, 0, "成功（提交待验收）即清零");
  assert.ok(after.lastSuccessAt);
  store.close();
});

test("配额/鉴权类错误：一次即熔断，且 guard 报 quota-blocked", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const r = store.recordTaskFailure(t.identifier, { error: "HTTP 429 rate limit exceeded" });
  assert.equal(r.quota, true);
  assert.equal(r.tripped, true, "配额类不重试，首次即熔断");
  assert.equal(store.getTaskRef(t.identifier).status, "blocked");
  assert.equal(store.dispatchGuard(t.identifier), "quota-blocked");
  store.close();
});

test("任务级 max_retries 覆盖默认阈值", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const cur = store.getTaskRef(t.identifier);
  store.updateTask(t.identifier, { expectedVersion: cur.version, maxRetries: 3 });
  const r1 = store.recordTaskFailure(t.identifier, { error: "第1次" });
  const r2 = store.recordTaskFailure(t.identifier, { error: "第2次" });
  assert.equal(r1.tripped, false);
  assert.equal(r2.tripped, false, "max_retries=3 时前两次不熔断");
  assert.equal(r2.effectiveLimit, 3);
  assert.equal(r2.limitSource, "task");
  const r3 = store.recordTaskFailure(t.identifier, { error: "第3次" });
  assert.equal(r3.tripped, true);
  store.close();
});

test("近期成功窗口：窗口内成功过 → 守卫拦截；人工重跑（requeued_at）后放行", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.submitTaskForReview(t.identifier, {}); // 成功
  const now = Date.now();
  assert.equal(store.dispatchGuard(t.identifier, { now }), "recent-success");
  // 超出窗口 → 放行
  assert.equal(store.dispatchGuard(t.identifier, { now: now + DEFAULT_SUCCESS_WINDOW_MS + 1000 }), null);
  // 窗口内但人工显式重跑 → 放行
  store.retryTaskExecution(t.identifier);
  assert.equal(store.dispatchGuard(t.identifier, { now: now + 1000 }), null);
  store.close();
});

test("回收认领不算失败（缺心跳不计为失败）", () => {
  const { store, t } = setup();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: false, running: false, status: null, pending: 0 }) };
  const reclaimed = store.reclaimStaleClaim(t.identifier, { now: Date.now() + 40 * 60 * 1000 });
  assert.equal(reclaimed.reclaimed, true);
  assert.equal(store.getTaskRef(t.identifier).consecutiveFailures, 0, "回收不得计入失败");
  store.close();
});

test("API：熔断时 /execute 返 409 EXECUTION_CIRCUIT_OPEN；重置失败计数后放行", async () => {
  const { store, t } = setup();
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: false, running: false, status: "idle", pending: 0 }) };
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.recordTaskFailure(t.identifier, { error: "boom" });
  store.recordTaskFailure(t.identifier, { error: "boom again" });
  const router = createApiRouter({ store });
  // 熔断后任务已是 blocked；直接改回 todo（不经过"人工重跑"，保留熔断计数）
  const cur = store.getTaskRef(t.identifier);
  store.updateTask(t.identifier, { expectedVersion: cur.version, status: "todo" });
  await assert.rejects(
    () => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: new URLSearchParams(), body: { sessionId: "s1" } }),
    (e) => e.code === "EXECUTION_CIRCUIT_OPEN",
  );
  const reset = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/reset-failures`, searchParams: new URLSearchParams(), body: {} });
  assert.equal(reset.status, 200);
  assert.equal(reset.payload.guard, null);
  const ok = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: new URLSearchParams(), body: { sessionId: "s1" } });
  assert.equal(ok.status, 200);
  store.close();
});

test("执行循环：熔断任务不自动重派，列入 blockedByGuard", async () => {
  const { store, t } = setup();
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official" }, loop: { enabled: true } });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: false, running: false, status: null, pending: 0 }), sendPrompt: async () => ({ sent: true }) };
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.recordTaskFailure(t.identifier, { error: "x" });
  store.recordTaskFailure(t.identifier, { error: "y" }); // 熔断 → blocked
  // 模拟"任务被改回可开工但熔断未解除"（例如人工改了状态而没重置计数）
  const cur = store.getTaskRef(t.identifier);
  store.updateTask(t.identifier, { expectedVersion: cur.version, status: "todo" });
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.dispatched.length, 0);
  assert.ok(res.payload.blockedByGuard.some((x) => x.task === t.identifier));
  store.close();
});
