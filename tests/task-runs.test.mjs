/** FR-82：尝试记录 + 任务事件流（认领即开 run / 结束即闭合 / 事件追加 / 按尝试看历史）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openStore, runExceededMax, RUN_OUTCOMES, DEFAULT_RUN_MAX_MS } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { evaluateTaskDiagnostics } from "../src/core/diagnostics.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  return { store, t };
}

test("认领即开一条尝试记录；重复认领不产生第二条", () => {
  const { store, t } = setup();
  assert.equal(store.listTaskRuns(t.identifier).length, 0);
  const r1 = store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  assert.equal(r1.claimed, true);
  assert.ok(r1.run, "认领应返回新开的尝试记录");
  assert.equal(r1.run.attempt, 1);
  assert.equal(r1.run.status, "running");
  assert.equal(r1.run.sessionId, "s1");
  assert.equal(r1.run.heartbeats, 1);
  assert.ok(r1.run.startedAt);
  assert.equal(store.getTaskRef(t.identifier).currentRunId, r1.run.id, "任务指针指向进行中的尝试");

  const r2 = store.claimTask(t.identifier, { sessionId: "s2" });
  assert.equal(r2.claimed, false, "已被认领 → 抢不到");
  assert.equal(store.listTaskRuns(t.identifier).length, 1, "不得重复开尝试");
  store.close();
});

test("心跳计入尝试（heartbeats 递增 + last_heartbeat_at 前进）", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", now });
  store.heartbeatTask(t.identifier, { note: "还在跑", now: now + 60_000 });
  store.heartbeatTask(t.identifier, { now: now + 120_000 });
  const run = store.listTaskRuns(t.identifier)[0];
  assert.equal(run.heartbeats, 3, "认领 1 次 + 心跳 2 次");
  assert.equal(run.lastHeartbeatAt, new Date(now + 120_000).toISOString());
  store.close();
});

test("结束尝试：写 outcome/摘要/错误/起止/耗时，并清空任务指针（可重复调用但只闭合一次）", () => {
  const { store, t } = setup();
  const now = Date.now();
  const r1 = store.claimTask(t.identifier, { sessionId: "s1", now });
  const ended = store.endTaskRun(t.identifier, { outcome: "crash", summary: "进程被 SIGKILL", error: "SIGKILL", now: now + 30_000 });
  assert.equal(ended.ended, true);
  assert.equal(ended.run.status, "ended");
  assert.equal(ended.run.outcome, "crash");
  assert.equal(ended.run.summary, "进程被 SIGKILL");
  assert.equal(ended.run.error, "SIGKILL");
  assert.equal(ended.run.durationMs, 30_000);
  assert.equal(store.getTaskRef(t.identifier).currentRunId, null);
  const again = store.endTaskRun(t.identifier, { outcome: "failed" });
  assert.equal(again.ended, false, "没有进行中的尝试时不得再闭合");
  assert.equal(store.getTaskRun(r1.run.id).outcome, "crash", "结论不被覆盖");
  store.close();
});

test("多次重试 → 按尝试列出每次结论与证据（attempt 递增、历史保留）", () => {
  const { store, t } = setup();
  const now = Date.now();
  // 第 1 次：失败
  store.claimTask(t.identifier, { sessionId: "s1", now });
  store.recordTaskFailure(t.identifier, { outcome: "failed", error: "编译不过", now: now + 1000 });
  // 第 2 次：超时
  store.retryTaskExecution(t.identifier);
  store.claimTask(t.identifier, { sessionId: "s2", now: now + 2000 });
  store.endTaskRun(t.identifier, { outcome: "timeout", summary: "超过运行时上限", now: now + 3000 });
  // 第 3 次：成功
  store.retryTaskExecution(t.identifier);
  store.claimTask(t.identifier, { sessionId: "s3", now: now + 4000 });
  store.submitTaskForReview(t.identifier, { comment: "完成，待验收" });

  const runs = store.listTaskRuns(t.identifier);
  assert.equal(runs.length, 3, "三次认领 = 三条尝试");
  assert.deepEqual(runs.map((r) => r.attempt), [1, 2, 3]);
  assert.equal(runs[0].outcome, "failed");
  assert.match(runs[0].error, /编译不过/);
  assert.equal(runs[1].outcome, "timeout");
  assert.equal(runs[2].outcome, "success");
  assert.ok(runs.every((r) => r.status === "ended" && r.endedAt), "每条都闭合");
  store.close();
});

test("受阻 / 被回收 / 释放归属 各自成为一次尝试的终态", () => {
  const { store, t } = setup();
  const now = Date.now();
  // 受阻
  store.claimTask(t.identifier, { sessionId: "s1", now });
  store.blockTask(t.identifier, { kind: "needs_input", reason: "等人给料", now: now + 1000 });
  assert.equal(store.listTaskRuns(t.identifier).at(-1).outcome, "blocked");
  // 回待办后认领，再让它过期被回收
  store.retryTaskExecution(t.identifier);
  store.claimTask(t.identifier, { sessionId: "s2", ttlMs: 1000, now: now + 2000 });
  const rc = store.reclaimStaleClaim(t.identifier, { now: now + 60 * 60 * 1000, sessionState: { running: false, live: false } });
  assert.equal(rc.reclaimed, true);
  assert.equal(store.listTaskRuns(t.identifier).at(-1).outcome, "reclaimed");
  // 释放归属
  const r3 = store.claimTask(t.identifier, { sessionId: "s3", now: now + 61 * 60 * 1000 });
  assert.equal(r3.claimed, true);
  store.releaseTaskAssignment(t.identifier);
  assert.equal(store.listTaskRuns(t.identifier).at(-1).outcome, "released");
  assert.deepEqual([...new Set(store.listTaskRuns(t.identifier).map((r) => r.outcome))].sort(), ["blocked", "reclaimed", "released"]);
  for (const o of store.listTaskRuns(t.identifier).map((r) => r.outcome)) assert.ok(RUN_OUTCOMES.includes(o), `outcome 必须是约定口径：${o}`);
  store.close();
});

test("runExceededMax：运行时上限判定（进行中按 now 计，已结束按 ended_at 计）", () => {
  const start = new Date("2026-10-17T10:00:00.000Z").toISOString();
  const run = { startedAt: start, endedAt: null, maxMs: 60_000 };
  assert.equal(runExceededMax(run, { now: new Date("2026-10-17T10:00:30.000Z").getTime() }), false);
  assert.equal(runExceededMax(run, { now: new Date("2026-10-17T10:02:00.000Z").getTime() }), true);
  assert.equal(runExceededMax({ ...run, endedAt: new Date("2026-10-17T10:05:00.000Z").toISOString() }, { now: Date.now() }), true);
  assert.equal(runExceededMax(null), false);
  assert.equal(DEFAULT_RUN_MAX_MS, 30 * 60 * 1000);
});

test("事件流：任务内 seq 单调 + 全库 cursor 单调；按 since 取增量", () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1" });
  store.heartbeatTask(t.identifier, { now: Date.now() + 1000 });
  store.blockTask(t.identifier, { kind: "transient", reason: "挂了" });
  const events = store.listTaskEvents(t.identifier, { order: "asc" });
  assert.ok(events.length >= 5, `至少 created/claimed/run_started/heartbeat/... 实为 ${events.length}`);
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1), "任务内 seq 从 1 递增");
  const cursors = events.map((e) => e.cursor);
  assert.deepEqual(cursors, cursors.slice().sort((a, b) => a - b), "cursor 单调");
  assert.equal(events[0].type, "created");
  assert.ok(events.some((e) => e.type === "claimed"));
  assert.ok(events.some((e) => e.type === "run_started"));
  assert.ok(events.some((e) => e.type === "blocked" && e.to === "blocked"));

  const mid = cursors[2];
  const delta = store.listTaskEvents(t.identifier, { since: mid, order: "asc" });
  assert.ok(delta.every((e) => e.cursor > mid), "只返回游标之后的增量");
  assert.equal(delta.length, cursors.length - 3);
  store.close();
});

test("状态变化 / 请求评审 / 退回待办 都会追加事件（不各自造数）", () => {
  const { store, t } = setup();
  store.updateTask(t.identifier, { expectedVersion: 1, status: "in_progress" });
  store.claimTask(t.identifier, { sessionId: "s1" });
  store.submitTaskForReview(t.identifier, { comment: "完成" });
  const types = store.listTaskEvents(t.identifier, { order: "asc" }).map((e) => e.type);
  assert.ok(types.includes("status_changed"), types.join(","));
  assert.ok(types.includes("review_requested"));
  assert.ok(types.includes("run_ended"));
  const statusEvent = store.listTaskEvents(t.identifier, { order: "asc" }).find((e) => e.type === "status_changed");
  assert.equal(statusEvent.from, "todo");
  assert.equal(statusEvent.to, "in_progress");
  store.close();
});

test("项目事件流：跨任务按全库游标合并，可做订阅游标", () => {
  const { store, t } = setup();
  const t2 = store.createTask({ projectId: "p1", title: "T2", status: "todo" });
  store.claimTask(t.identifier, { sessionId: "s1" });
  store.claimTask(t2.identifier, { sessionId: "s2" });
  const all = store.listProjectEvents("p1", { order: "asc" });
  assert.ok(all.length >= 4);
  const cursors = all.map((e) => e.cursor);
  assert.deepEqual(cursors, cursors.slice().sort((a, b) => a - b));
  const other = store.createProject({ id: "p2", name: "P2" });
  store.createTask({ projectId: other.id, title: "X" });
  assert.ok(store.listProjectEvents("p1", { order: "asc" }).every((e) => e.cursor < store.listProjectEvents("p2")[0].cursor), "项目事件流互不串台");
  store.close();
});

test("诊断联动：重复崩溃以**尝试记录**为一等判据（不再只靠错误文本猜）", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", now });
  store.endTaskRun(t.identifier, { outcome: "crash", summary: "SIGSEGV", now: now + 1000 });
  store.retryTaskExecution(t.identifier);
  store.claimTask(t.identifier, { sessionId: "s2", now: now + 2000 });
  store.endTaskRun(t.identifier, { outcome: "timeout", summary: "超过上限", now: now + 3000 });
  const d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "repeated_crash");
  assert.ok(d, "两次崩溃/超时的尝试 → 应产出「重复崩溃」诊断");
  assert.match(d.detail, /2 次尝试/);
  store.close();
});

test("API：/runs 与 /events 可用；/execution 附带 currentRun 与 runs", async () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1" });
  store.endTaskRun(t.identifier, { outcome: "failed", summary: "跑挂了", error: "boom" });
  const router = createApiRouter({ store });

  const runs = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/runs`, searchParams: new URLSearchParams() });
  assert.equal(runs.status, 200);
  assert.equal(runs.payload.count, 1);
  assert.equal(runs.payload.runs[0].outcome, "failed");
  assert.equal(runs.payload.currentRun, null, "已结束 → 没有进行中的尝试");

  const events = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/events`, searchParams: new URLSearchParams({ limit: "5" }) });
  assert.equal(events.status, 200);
  assert.ok(events.payload.cursor > 0);
  assert.equal(events.payload.identifier, t.identifier);
  assert.ok(Array.isArray(events.payload.events));
  const since = events.payload.cursor;
  const delta = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/events`, searchParams: new URLSearchParams({ since: String(since) }) });
  assert.equal(delta.payload.count, 0, "游标之后没有新事件");

  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.equal(exec.payload.attempts, 1);
  assert.equal(exec.payload.currentRun, null);
  assert.equal(exec.payload.runs.length, 1);

  const proj = await router.route({ method: "GET", pathname: "/api/projects/p1/events", searchParams: new URLSearchParams() });
  assert.ok(proj.payload.count >= 3);
  assert.equal(proj.payload.project, "p1");
  store.close();
});

// ---- FR-82 收口：孤儿尝试与幽灵认领（2026-10-18 真机发现：-63 第 3 次尝试 / -69 第 1 次尝试跨 ~24h 仍 running） ----

test("启动收口：进程重启后遗留的 running 尝试一律收口为 interrupted（不看时长）", () => {
  const { store, t } = setup();
  const now = Date.now();
  const claim = store.claimTask(t.identifier, { sessionId: "s1", now });
  assert.equal(claim.run.status, "running");
  const rec = store.reconcileOrphanRuns({ boot: true, now: now + 1_000 });
  assert.equal(rec.ended.length, 1);
  assert.equal(rec.ended[0].outcome, "interrupted");
  const run = store.listTaskRuns(t.identifier)[0];
  assert.equal(run.status, "ended");
  assert.equal(run.outcome, "interrupted");
  assert.ok(run.endedAt, "必须写 ended_at");
  assert.equal(store.getTaskRef(t.identifier).currentRunId, null, "任务指针要清空");
  assert.ok(store.listTaskEvents(t.identifier).some((e) => e.type === "run_ended" && e.to === "interrupted"));
  assert.equal(store.listGovernanceAudit({ action: "reconcile-run" }).length, 1);
  const again = store.reconcileOrphanRuns({ boot: true });
  assert.equal(again.ended.length, 0, "幂等：第二次无副作用");
  store.close();
});

test("定时器收口：不误杀仍在跑的尝试（尚未超过运行时上限）", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", now });
  const rec = store.reconcileOrphanRuns({ now: now + 60_000 });
  assert.equal(rec.ended.length, 0, "才跑 1 分钟不得被收口");
  assert.equal(store.listTaskRuns(t.identifier)[0].status, "running");
  store.close();
});

test("定时器收口：超过该次自己的 max_ms → 收口为 timeout", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", now: now - 40 * 60 * 1000 });
  const rec = store.reconcileOrphanRuns({ now });
  assert.equal(rec.ended.length, 1);
  assert.equal(rec.ended[0].outcome, "timeout");
  const run = store.listTaskRuns(t.identifier)[0];
  assert.equal(run.status, "ended");
  assert.equal(run.outcome, "timeout");
  assert.ok(run.durationMs >= 39 * 60 * 1000, "时长按真实区间记");
  assert.equal(store.getTaskRef(t.identifier).currentRunId, null);
  store.close();
});

test("人工/看板改状态：离开「进行中」即释放认领（与执行侧 FR-77 口径对齐）", () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1" });
  const claimed = store.getTaskRef(t.identifier);
  assert.ok(claimed.claimLock, "先确认认领锁在");
  store.updateTask(t.identifier, { status: "in_review", expectedVersion: claimed.version });
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.status, "in_review");
  assert.equal(after.claimLock, null, "离开执行态必须释放认领（此前这里会留下幽灵锁）");
  assert.equal(after.claimExpires, null);
  assert.equal(after.claimOwner, null);
  store.close();
});

test("遗留幽灵认领收口：不在执行态却仍锁着认领 → 清掉；在途任务的认领与尝试不动", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-runs-"));
  const dbPath = path.join(dir, "taskboard.sqlite");
  const store = openStore({ dbPath });
  store.createProject({ id: "p1", name: "P1" });
  const ghost = store.createTask({ projectId: "p1", title: "幽灵锁", status: "in_review" });
  const live = store.createTask({ projectId: "p1", title: "在途", status: "todo" });
  store.claimTask(live.identifier, { sessionId: "s-live" });
  // 直接写库，模拟「修复前留下的历史残留」（当时 updateTask 不释放认领）
  const raw = new DatabaseSync(dbPath);
  raw.prepare("update tasks set claim_lock = 'legacy-lock', claim_expires = '2026-10-17T19:01:48.143Z', claim_owner = 'session-legacy', last_heartbeat_at = '2026-10-17T18:53:16.676Z' where id = ?").run(ghost.id);
  raw.close();
  const rec = store.reconcileOrphanRuns();
  assert.deepEqual(rec.ghostClaims, [ghost.identifier]);
  const afterGhost = store.getTaskRef(ghost.identifier);
  assert.equal(afterGhost.claimLock, null);
  assert.equal(afterGhost.claimExpires, null);
  const afterLive = store.getTaskRef(live.identifier);
  assert.ok(afterLive.claimLock, "在途任务的认领不得被清");
  assert.equal(store.listTaskRuns(live.identifier)[0].status, "running", "在途尝试不得被收口");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
