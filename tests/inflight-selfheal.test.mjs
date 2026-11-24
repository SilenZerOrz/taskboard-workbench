/**
 * 卡 `-294` · 需求 `R198`：**执行中断自愈**。
 *
 * 背景（真机 `-293` · 2026-11-23 16:52 派单 → 17:03 进程中断 → 次日 11:37 仍在「进行中」/停滞 1148m）：
 *   · `exec-cli` 在「已在 `in_progress` 的卡」上再派单 ⇒ `claimForCliExecution` 走 `already-in-progress`
 *     分支 ⇒ `claimed:false`、**既不建认领锁也不建心跳**；
 *   · 回收器 `reclaimStaleClaims()` **只扫有锁的卡** ⇒ 这张卡永远停在「进行中」，人看到的是「运行中」。
 *
 * 本组测三件事：
 *   ① 派单**无条件**建立 / 续租认领并开心跳（已持有则续租，不重复建 run）；
 *   ② 心跳**续租**（认领锁不再到点自毁 ⇒ 活任务不会被当成死的）；
 *   ③ 「无心跳在途卡」的自愈回收：**只改状态与留痕**，不删卡、不删证据、不删尝试记录；
 *      并且**双向反证** —— 心跳持续 / 会话还在 / 有效租约 ⇒ 一律不回收。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, DEFAULT_CLAIM_TTL_MS, DEFAULT_HEARTBEAT_GAP_MS } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { claimForCliExecution, ensureClaimLease } from "../src/core/executor.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const attributed = (title, extra = {}) => {
    const t = store.createTask({ projectId: "p1", title, ...extra });
    store.associateRequirementTask(item.id, t.id);
    return t;
  };
  return { store, item, attributed };
}

const sp = (qs = "") => new URLSearchParams(qs);

// =====================================================================================
// ① 派单无条件建锁 / 续租 + 开心跳
// =====================================================================================

test("派单：卡已在「进行中」⇒ **也建认领锁并写心跳**（改前 claimed:false ⇒ 无心跳）", () => {
  const { store, attributed } = setup();
  const t = attributed("已在进行中", { status: "todo" });
  // 复现事故形状：`in_progress` 且**没有认领锁**（`teamSetTaskStatus` 推进状态不建锁）。
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  assert.equal(store.taskClaimState(t.identifier).locked, false, "前置：这张卡没有认领锁");

  const r = claimForCliExecution(store, t.identifier, { actor: "cli-executor" });
  const claim = store.taskClaimState(t.identifier);
  const task = store.requireTaskRef(t.identifier);
  assert.equal(r.claimed, true, "派单回包必须 claimed=true（这是「有没有心跳」的唯一对外信号）");
  assert.equal(r.claimState, "established");
  assert.equal(claim.locked, true, "必须建认领锁 ⇒ 回收器才扫得到这张卡");
  assert.ok(task.lastHeartbeatAt, "必须写任务级心跳");
  assert.ok(claim.expiresAt, "认领锁必须带过期时间（不会永久占位）");
  store.close();
});

test("派单：已持有有效认领 ⇒ **续租**（心跳刷新 + 到期时间延长），且不重复建 run", () => {
  const { store, attributed } = setup();
  const t = attributed("已认领", { status: "todo" });
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const before = store.taskClaimState(t.identifier);
  assert.equal(store.listTaskRuns(t.identifier).length, 1);

  const r = claimForCliExecution(store, t.identifier, { actor: "cli-executor" });
  const after = store.taskClaimState(t.identifier);
  assert.equal(r.claimed, true);
  assert.equal(r.claimState, "renewed", "已持有 ⇒ 续租，不重建");
  assert.equal(after.lock, before.lock, "续租不得换锁（换锁＝把别人的活抢过来）");
  assert.ok(
    new Date(after.expiresAt).getTime() >= new Date(before.expiresAt).getTime(),
    `续租只许把到期时间往后推（before=${before.expiresAt} after=${after.expiresAt}）`,
  );
  assert.equal(after.expired, false, "续租后认领仍然有效");
  assert.equal(store.listTaskRuns(t.identifier).length, 1, "不得重复开尝试记录");
  store.close();
});

test("派单：todo 走授权门的老口径**一字不变**（claimed=true / note=authorized）", () => {
  const { store, attributed } = setup();
  const t = attributed("可开工", { status: "todo" });
  const r = claimForCliExecution(store, t.identifier);
  assert.equal(r.claimed, true);
  assert.equal(r.note, "authorized");
  assert.equal(store.requireTaskRef(t.identifier).status, "in_progress");
  store.close();
});

test("ensureClaimLease：锁已过期 ⇒ 接管（CAS 允许）；没有锁 ⇒ 新建", () => {
  const { store, attributed } = setup();
  const t = attributed("接管", { status: "todo" });
  store.claimTask(t.identifier, { sessionId: "s1", ttlMs: 1000, now: Date.now() - 5000 });
  assert.equal(store.taskClaimState(t.identifier).locked, true);
  assert.equal(store.taskClaimState(t.identifier).expired, true, "前置：认领已过期");

  const r = ensureClaimLease(store, t.identifier, { sessionId: "s2" });
  assert.equal(r.ok, true);
  assert.equal(r.state, "established");
  const claim = store.taskClaimState(t.identifier);
  assert.equal(claim.locked, true);
  assert.equal(claim.expired, false, "接管后是有效认领");
  store.close();
});

// =====================================================================================
// ② 心跳续租
// =====================================================================================

test("心跳续租：带 `renewLease` ⇒ 认领到期时间被推后；不带 ⇒ 原样不动", () => {
  const { store, attributed } = setup();
  const t = attributed("续租", { status: "todo" });
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", ttlMs: DEFAULT_CLAIM_TTL_MS, now });
  const before = store.taskClaimState(t.identifier, { now }).expiresAt;

  const plain = store.heartbeatTask(t.identifier, { now: now + 60_000, silent: true });
  assert.equal(plain.ok, true);
  assert.equal(store.taskClaimState(t.identifier, { now: now + 60_000 }).expiresAt, before, "默认心跳不续租（老口径不变）");

  const renewed = store.heartbeatTask(t.identifier, { now: now + 90_000, silent: true, renewLease: true });
  assert.equal(renewed.ok, true);
  const after = store.taskClaimState(t.identifier, { now: now + 90_000 }).expiresAt;
  assert.equal(new Date(after).getTime(), now + 90_000 + DEFAULT_CLAIM_TTL_MS, "续租 ⇒ 到期时间 = 现在 + TTL");
  store.close();
});

test("心跳续租：**不复活已过期的认领**（过期后心跳仍被拒 —— 与既有口径一致）", () => {
  const { store, attributed } = setup();
  const t = attributed("过期", { status: "todo" });
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", ttlMs: DEFAULT_CLAIM_TTL_MS, now });
  const late = now + DEFAULT_CLAIM_TTL_MS + 10_000;
  const r = store.heartbeatTask(t.identifier, { now: late, renewLease: true });
  assert.equal(r.ok, false, "过期认领不得被心跳复活（否则永远回收不掉）");
  assert.equal(r.reason, "not-claimed-or-expired");
  store.close();
});

// =====================================================================================
// ③ 在途状态 + 自愈回收
// =====================================================================================

test("在途状态：在途但心跳陈旧 ⇒ unwatched=true；心跳新鲜 ⇒ false", () => {
  const { store, attributed } = setup();
  const t = attributed("在途", { status: "todo" });
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor" });
  const now = Date.now();

  const fresh = store.inflightState(t.identifier, { now });
  assert.equal(fresh.hasRun, true);
  assert.equal(fresh.heartbeatStale, false);
  assert.equal(fresh.unwatched, false);

  const stale = store.inflightState(t.identifier, { now: now + DEFAULT_HEARTBEAT_GAP_MS + 60_000 });
  assert.equal(stale.heartbeatStale, true);
  assert.equal(stale.unwatched, true, "在途 + 心跳陈旧 = 没人真在跑");
  store.close();
});

test("自愈回收：心跳陈旧 + 进程不在 ⇒ 退回「可开工」+ 留痕 + **尝试记录保留** + 不删卡", () => {
  const { store, attributed } = setup();
  const t = attributed("中断", { status: "todo" });
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor", sessionId: "sess-dead" });
  const now = Date.now();
  // 心跳停在那一刻（11 分钟前 ⇒ 已过 10 分钟阈值）
  store.heartbeatTaskRun(t.identifier, { now: now - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  // 会话已从宿主注册表里消失 ＝ 进程不在了
  store.hostSessionPort = { sessionState: () => ({ sessionId: "sess-dead", live: false, running: false, status: null, pending: 0 }) };

  const r = store.reclaimUnwatchedInflight(t.identifier, { now });
  assert.equal(r.reclaimed, true, `应被回收，实际 reason=${r.reason}`);
  assert.equal(r.status, "todo");
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "todo");
  assert.equal(after.claimLock, null, "回收要松开认领");
  const comments = store.listComments(t.identifier);
  assert.ok(comments.some((c) => /执行进程已中断，已回收/.test(c.body)), "必须有一条可读留痕");
  assert.ok(store.listGovernanceAudit().some((a) => a.action === "reclaim" && a.reason === "inflight-no-heartbeat"), "必须留审计");
  const runs = store.listTaskRuns(t.identifier);
  assert.equal(runs.length, 1, "尝试记录**保留**（不删）");
  assert.equal(runs[0].outcome, "reclaimed", "只闭合，不删");
  store.close();
});

test("自愈回收 · 双向反证：心跳新鲜 / 有效租约 / 会话还在 ⇒ **一律不回收**", () => {
  const { store, attributed } = setup();
  const now = Date.now();
  const mk = (title) => {
    const t = attributed(title, { status: "todo" });
    store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
    store.startTaskRun(t.identifier, { actor: "cli-executor", sessionId: "sess-x" });
    return t;
  };

  // ① 心跳新鲜 ⇒ 不回收
  const t1 = mk("心跳新鲜");
  const r1 = store.reclaimUnwatchedInflight(t1.identifier, { now });
  assert.equal(r1.reclaimed, false);
  assert.equal(r1.reason, "heartbeat-fresh");

  // ② 有效租约（心跳刚续过）⇒ 不回收
  //    （先把**尝试**心跳做旧，只让租约保持有效 —— 这样才真的走到「租约有效」那条闸）
  const t2 = mk("有效租约");
  store.claimTask(t2.identifier, { sessionId: "sess-x", now });
  store.heartbeatTask(t2.identifier, { now, silent: true, renewLease: true });
  store.heartbeatTaskRun(t2.identifier, { now: now - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  const r2 = store.reclaimUnwatchedInflight(t2.identifier, { now: now + 60_000 });
  assert.equal(r2.reclaimed, false);
  assert.equal(r2.reason, "lease-valid", `reason=${r2.reason}`);

  // ③ 会话还在（只是空闲，agent 可能正在思考）⇒ 自愈路径**不抢**
  const t3 = mk("会话还在");
  store.heartbeatTaskRun(t3.identifier, { now: now - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "sess-x", live: true, running: false, status: "idle", pending: 0 }) };
  const r3 = store.reclaimUnwatchedInflight(t3.identifier, { now });
  assert.equal(r3.reclaimed, false);
  assert.equal(r3.reason, "session-alive", `reason=${r3.reason}`);

  // ④ 会话在跑 ⇒ 不回收
  const t4 = mk("会话在跑");
  store.heartbeatTaskRun(t4.identifier, { now: now - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "sess-x", live: true, running: true, status: "running", pending: 0 }) };
  const r4 = store.reclaimUnwatchedInflight(t4.identifier, { now });
  assert.equal(r4.reclaimed, false);
  assert.equal(r4.reason, "worker-alive");

  // ⑤ 没有尝试记录 ⇒ 不动（没有「进程死过」的证据）
  const t5 = attributed("无尝试", { status: "todo" });
  store.teamSetTaskStatus(t5.identifier, { status: "in_progress", actor: "cli-executor" });
  const r5 = store.reclaimUnwatchedInflight(t5.identifier, { now });
  assert.equal(r5.reclaimed, false);
  assert.equal(r5.reason, "no-run");

  for (const t of [t1, t2, t3, t4, t5]) assert.equal(store.requireTaskRef(t.identifier).status, "in_progress");
  store.close();
});

test("批量自愈：只收「无心跳在途」的卡，其余原样不动", () => {
  const { store, attributed } = setup();
  const now = Date.now();
  const dead = attributed("死的", { status: "todo" });
  store.teamSetTaskStatus(dead.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(dead.identifier, { actor: "cli-executor" });
  store.heartbeatTaskRun(dead.identifier, { now: now - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });

  const alive = attributed("活的", { status: "todo" });
  store.teamSetTaskStatus(alive.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(alive.identifier, { actor: "cli-executor" });
  store.heartbeatTaskRun(alive.identifier, { now, silent: true });

  const reclaimed = store.reclaimUnwatchedInflights({ now });
  assert.deepEqual(reclaimed.map((r) => r.identifier), [dead.identifier]);
  assert.equal(store.requireTaskRef(dead.identifier).status, "todo");
  assert.equal(store.requireTaskRef(alive.identifier).status, "in_progress", "活卡不许动");
  store.close();
});

// =====================================================================================
// ④ 看板处置入口（真 HTTP）
// =====================================================================================

test("API：`POST /reclaim` 对**没有认领锁**的在途卡也能回收（改前恒 409 ⇒ 人点不动）", async () => {
  const { store, attributed } = setup();
  const t = attributed("看板处置", { status: "todo" });
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor" });
  store.heartbeatTaskRun(t.identifier, { now: Date.now() - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  const router = createApiRouter({ store });
  const r = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/reclaim`, searchParams: sp(), body: {} });
  assert.equal(r.status, 200);
  assert.equal(r.payload.reclaimed, true);
  assert.equal(store.requireTaskRef(t.identifier).status, "todo");
  store.close();
});

test("API：看板列表与详情都带 `inflight` 在途事实（界面据此说「无心跳」而不是谎称「运行中」）", async () => {
  const { store, attributed } = setup();
  const t = attributed("在途事实", { status: "todo" });
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor" });
  store.heartbeatTaskRun(t.identifier, { now: Date.now() - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  const router = createApiRouter({ store });

  const list = await router.route({ method: "GET", pathname: "/api/tasks", searchParams: sp("project=p1&withWatchdog=1"), body: {} });
  const row = (list.payload.tasks ?? []).find((x) => x.identifier === t.identifier);
  assert.equal(row?.inflight?.unwatched, true, "在途但心跳陈旧 ⇒ unwatched=true");

  const detail = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}`, searchParams: sp(), body: {} });
  assert.equal(detail.payload.inflight?.unwatched, true);
  assert.equal(detail.payload.inflight?.attempt, 1);
  store.close();
});

test("API：诊断给出「回收 / 重派 / 释放归属」三个可点处置，正文写明「无心跳」事实", async () => {
  const { store, attributed } = setup();
  const t = attributed("诊断", { status: "todo" });
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor" });
  store.heartbeatTaskRun(t.identifier, { now: Date.now() - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  const router = createApiRouter({ store });
  const r = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: sp(), body: {} });
  const d = (r.payload.diagnostics ?? []).find((x) => x.kind === "unclaimed");
  assert.ok(d, "应有「无人认领」诊断（= 没人真在跑）");
  const ids = (d.actions ?? []).map((a) => a.id);
  assert.ok(ids.includes("reclaim"), "处置：立即回收");
  assert.ok(ids.includes("retry"), "处置：退回待办（重新派发）");
  assert.ok(ids.includes("release"), "处置：释放归属");
  assert.match(String(d.detail), /心跳/, "正文必须写明「无心跳」这个可核对的事实");
  store.close();
});
