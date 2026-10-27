/** FR-83：评审返工与评审死锁诊断（请求评审 / 请求返工退回来源列 / 通过不自动完成 / 死锁诊断 / 评审门）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";
import { REVIEW_SOURCE_STATUSES, detectReviewDeadlock, reviewReturnStatus } from "../src/core/review.mjs";
import { evaluateTaskDiagnostics } from "../src/core/diagnostics.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const t = store.createTask({ projectId: "p1", title: "实现", status: "in_progress" });
  return { store, t };
}

test("请求评审（一等流程）：进「待验收」+ 指派评审者 + 记来源列 + 释放认领 + 事件留痕", () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1" });
  const r = store.requestReview(t.identifier, { reviewer: "reviewer-1", comment: "完成，待验收" });
  assert.equal(r.task.status, "in_review");
  assert.equal(r.task.reviewState, "pending");
  assert.equal(r.task.reviewer, "reviewer-1");
  assert.equal(r.task.reviewSourceStatus, "in_progress", "记下来源列，返工才回得去");
  assert.equal(r.task.claimLock, null, "交接给评审：释放实现认领");
  assert.equal(r.task.reviewRound, 0);
  assert.ok(r.task.reviewRequestedAt);
  assert.equal(store.listTaskRuns(t.identifier).at(-1).outcome, "success", "提交待验收 = 本次执行成功");
  const types = store.listTaskEvents(t.identifier, { order: "asc" }).map((e) => e.type);
  assert.ok(types.includes("review_requested"));
  store.close();
});

test("请求返工：**退回来源列**（不是错列）+ 返工说明留痕 + 轮次 +1 + 释放认领", () => {
  const { store, t } = setup();
  store.requestReview(t.identifier, { comment: "待验收" });
  const r = store.requestChanges(t.identifier, { comment: "断言缺失，请补测试" });
  assert.equal(r.returnedTo, "in_progress");
  assert.equal(r.round, 1);
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.status, "in_progress", "回到实现列");
  assert.equal(after.reviewState, "changes_requested");
  assert.equal(after.reviewRound, 1);
  assert.equal(after.reviewRequestedAt, null);
  assert.match(store.listComments(after.id).at(-1).body, /退回「in_progress」.*第 1 轮/s);
  assert.match(store.listComments(after.id).at(-1).body, /断言缺失/);
  const types = store.listTaskEvents(t.identifier, { order: "asc" }).map((e) => e.type);
  assert.ok(types.includes("changes_requested"));
  // 返工后执行侧可重新认领（返工不是"卡住"）
  assert.equal(store.claimTask(t.identifier, { sessionId: "s2" }).claimed, true);
  store.close();
});

test("返工回列口径：来源列只认实现列，非法来源（backlog 等）一律回落 in_progress", () => {
  assert.equal(reviewReturnStatus("in_progress"), "in_progress");
  assert.equal(reviewReturnStatus("todo"), "todo");
  for (const bad of ["backlog", "done", "canceled", "in_review", null, ""]) {
    assert.equal(reviewReturnStatus(bad), "in_progress", `非法来源列必须回落：${bad}`);
  }
  assert.deepEqual([...REVIEW_SOURCE_STATUSES], ["in_progress", "todo"]);

  const { store } = setup();
  const back = store.createTask({ projectId: "p1", title: "未授权的", status: "backlog" });
  store.requestReview(back.identifier);
  assert.equal(store.getTaskRef(back.identifier).reviewSourceStatus, "in_progress", "backlog 不得成为返工回列");
  const r = store.requestChanges(back.identifier, { comment: "不合格" });
  assert.equal(r.returnedTo, "in_progress");
  assert.notEqual(store.getTaskRef(back.identifier).status, "backlog", "不得退回待办池（未授权开工列）");
  store.close();
});

test("评审通过：只记评审态，**保持「待验收」不自动置完成**（红线：完成只能人确认）", () => {
  const { store, t } = setup();
  store.requestReview(t.identifier, { reviewer: "r1" });
  const r = store.approveReview(t.identifier, { comment: "实现与验收一致" });
  assert.equal(r.needsHumanConfirmation, true);
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.reviewState, "approved");
  assert.equal(after.status, "in_review", "评审通过 ≠ 完成");
  assert.match(store.listComments(after.id).at(-1).body, /人工确认后置「完成」/);
  // 死锁判定对"已通过"直接放行（只差人确认）
  assert.equal(detectReviewDeadlock(store, after), null);
  store.close();
});

test("评审态校验：不在「待验收」时请求返工 / 通过 → REVIEW_NOT_PENDING", () => {
  const { store, t } = setup();
  assert.throws(() => store.requestChanges(t.identifier, { comment: "x" }), (e) => e.code === "REVIEW_NOT_PENDING");
  assert.throws(() => store.approveReview(t.identifier), (e) => e.code === "REVIEW_NOT_PENDING");
  assert.throws(() => store.requestChanges("p1-999", { comment: "x" }), (e) => e.code === "TASK_NOT_FOUND");
  store.close();
});

test("评审死锁：链成环 → cycle；评审者自身受阻 → reviewer-blocked；无人评审超时 → unassigned", () => {
  const { store, t } = setup();
  const b = store.createTask({ projectId: "p1", title: "另一条", status: "in_progress" });
  // 成环：t 等 b 评审，b 等 t 评审
  store.requestReview(t.identifier, { dependsOn: b.id });
  store.requestReview(b.identifier, { dependsOn: t.id });
  const dead = detectReviewDeadlock(store, store.getTaskRef(t.identifier));
  assert.equal(dead?.deadlocked, true);
  assert.equal(dead.kind, "cycle");
  assert.match(dead.reason, /成环/);
  store.close();

  const s2 = setup();
  const blocker = s2.store.createTask({ projectId: "p1", title: "评审者的任务", status: "in_progress" });
  s2.store.blockTask(blocker.identifier, { kind: "needs_input", reason: "等料" });
  s2.store.requestReview(s2.t.identifier, { dependsOn: blocker.id });
  const d2 = detectReviewDeadlock(s2.store, s2.store.getTaskRef(s2.t.identifier));
  assert.equal(d2?.kind, "reviewer-blocked");
  assert.match(d2.reason, /评审者自身受阻/);
  s2.store.close();

  const s3 = setup();
  s3.store.requestReview(s3.t.identifier); // 不指派评审者
  assert.equal(detectReviewDeadlock(s3.store, s3.store.getTaskRef(s3.t.identifier), { idleMs: 60_000 }), null, "阈值内不算死锁");
  const d3 = detectReviewDeadlock(s3.store, s3.store.getTaskRef(s3.t.identifier), { idleMs: 0 });
  assert.equal(d3?.kind, "unassigned");
  assert.equal(detectReviewDeadlock(s3.store, s3.store.getTaskRef(s3.t.identifier)), null, "30 分钟内不算死锁（默认阈值）");
  s3.store.close();
});

test("诊断联动：评审死锁 → 产出高危急诊断，且带恢复动作", () => {
  const { store, t } = setup();
  const b = store.createTask({ projectId: "p1", title: "另一条", status: "in_progress" });
  store.requestReview(t.identifier, { dependsOn: b.id });
  store.requestReview(b.identifier, { dependsOn: t.id });
  const d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "review_deadlock");
  assert.ok(d, "应产出评审死锁诊断");
  assert.equal(d.severity, "high");
  assert.match(d.detail, /成环/);
  assert.ok(d.actions.length >= 1 && d.actions.some((a) => a.kind === "primary"));
  store.close();
});

test("评审门（红线③）：审查未过 / 上游失败 → 下游**保持受阻**且带分类与留痕", () => {
  const { store, t } = setup();
  const down = store.createTask({ projectId: "p1", title: "下游", status: "todo" });
  store.addTaskDependency({ blocker: t.identifier, blocked: down.identifier, reason: "先做实现" });
  store.requestReview(t.identifier, { comment: "待验收" });
  const blocked = store.blockDownstream(store.getTaskRef(t.identifier).id, "review-not-passed");
  assert.deepEqual(blocked, [down.identifier]);
  const after = store.getTaskRef(down.identifier);
  assert.equal(after.status, "blocked", "评审未过 → 下游不得回到「可开工」（否则会被循环直接派发）");
  assert.equal(after.blockKind, "dependency", "依赖未就绪分类");
  assert.ok(after.blockedAt, "受阻起始时间（FR-79 卡在受阻判据）");
  assert.equal(after.triageAt, null, "评审门不是'同因复发'升级，不进人工兜底队列");
  const types = store.listTaskEvents(down.identifier, { order: "asc" }).map((e) => e.type);
  assert.ok(types.includes("blocked"), "受阻事件入流");
  store.close();
});

test("评审门联动：团队回报 completed 且评审未过 → 下游保持受阻（不再直写 status）", () => {
  const { store, t } = setup();
  const down = store.createTask({ projectId: "p1", title: "下游", status: "todo" });
  store.addTaskDependency({ blocker: t.identifier, blocked: down.identifier });
  const run = store.createTeamRun({ targetTask: t.id });
  const tt = store.acquireTeamTask({ teamId: run.id, task: t.id, kind: "review" });
  store.applyTeamTaskOutcome(tt.id, { outcome: "completed", reviewPassed: false, evidence: "评审未过" });
  const after = store.getTaskRef(down.identifier);
  assert.equal(after.status, "blocked");
  assert.equal(after.blockKind, "dependency");
  store.close();
});

test("API：GET/POST /api/tasks/:ref/review 与 GET /api/projects/:id/reviews", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store });
  const req = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams(), body: { action: "request", reviewer: "r1", comment: "请评审" } });
  assert.equal(req.status, 200);
  assert.equal(req.payload.task.reviewer, "r1");
  assert.equal(req.payload.task.reviewSourceStatus, "in_progress");

  const get = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams() });
  assert.equal(get.payload.reviewState, "pending");
  assert.equal(get.payload.reviewer, "r1");

  const changes = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams(), body: { action: "changes", comment: "补测试" } });
  assert.equal(changes.payload.returnedTo, "in_progress");
  assert.equal(changes.payload.round, 1);

  await assert.rejects(() => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams(), body: { action: "nope" } }), (e) => e.code === "INVALID_FIELD");

  // 重新提交后再通过
  await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams(), body: { action: "request", reviewer: "r2" } });
  const approved = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/review`, searchParams: new URLSearchParams(), body: { action: "approve", comment: "OK" } });
  assert.equal(approved.payload.needsHumanConfirmation, true);
  assert.equal(approved.payload.task.status, "in_review");
  assert.equal(approved.payload.task.reviewRound, 1, "轮次保留（返工过 1 轮）");

  const queue = await router.route({ method: "GET", pathname: "/api/projects/p1/reviews", searchParams: new URLSearchParams() });
  assert.equal(queue.payload.count, 1);
  assert.equal(queue.payload.approved, 1);
  assert.equal(queue.payload.deadlocked, 0);
  store.close();
});

test("执行侧工具：置「待验收」= 请求评审（记来源列，不是裸改状态）", async () => {
  const { store, t } = setup();
  const defs = new Map();
  registerTaskboardTools({ tools: { register: (d) => defs.set(d.name, d) }, store });
  store.claimTask(t.identifier, { sessionId: "s1" });
  const r = await defs.get("taskboard_update_status").execute({ ref: t.identifier, status: "in_review", comment: "实现完成，请评审" }, { agent: { id: "s1" } });
  assert.equal(r.status, "in_review");
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.reviewState, "pending");
  assert.equal(after.reviewSourceStatus, "in_progress");
  assert.ok(store.listComments(after.id).some((c) => /实现完成，请评审/.test(c.body)), "评审说明应写进反馈留痕");
  store.close();
});
