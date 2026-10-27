/** FR-77：执行认领锁 + 心跳 + 过期回收。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, DEFAULT_CLAIM_TTL_MS, DEFAULT_HEARTBEAT_GAP_MS } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

test("认领 CAS：首次认领成功并写锁/过期/心跳/来源列；重复认领被拒", () => {
  const { store, t } = setup();
  const r1 = store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  assert.equal(r1.claimed, true);
  assert.ok(r1.claim.lock);
  assert.equal(r1.task.claimSource, "todo");
  assert.ok(r1.task.lastHeartbeatAt, "认领即写起始心跳");
  const r2 = store.claimTask(t.identifier, { sessionId: "s2" });
  assert.equal(r2.claimed, false);
  assert.equal(r2.reason, "already-claimed");
  store.close();
});

test("认领 CAS：原认领已过期时可被他人接管（不会被永久占位）", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", ttlMs: 1000, now });
  const later = now + 5000; // 过期
  const r = store.claimTask(t.identifier, { sessionId: "s2", now: later });
  assert.equal(r.claimed, true, "过期后应可重新认领");
  assert.equal(store.getTaskRef(t.identifier).claimOwner, "s2");
  store.close();
});

test("心跳：认领态可刷新；未被认领/已过期则拒绝；心跳可带备注", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.claimTask(t.identifier, { sessionId: "s1", ttlMs: DEFAULT_CLAIM_TTL_MS, now });
  const ok = store.heartbeatTask(t.identifier, { note: "正在跑测试", now: now + 60_000 });
  assert.equal(ok.ok, true);
  assert.ok(store.listComments(t.id).some((c) => /心跳：正在跑测试/.test(c.body)));
  // 过期后心跳应被拒（认领已失效）
  const late = now + DEFAULT_CLAIM_TTL_MS + 10_000;
  assert.equal(store.heartbeatTask(t.identifier, { now: late }).ok, false);
  store.close();
});

test("回收：认领过期 → 退回来源列 + 清锁 + 留痕 + 审计", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.startTaskExecution(t.identifier, { sessionId: "s1" }); // in_progress + 认领（来源 todo）
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: false, running: false, status: null, pending: 0 }) };
  const r = store.reclaimStaleClaim(t.identifier, { now: now + DEFAULT_CLAIM_TTL_MS + 60_000 });
  assert.equal(r.reclaimed, true);
  assert.equal(r.status, "todo", "退回来源列（todo）");
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.status, "todo");
  assert.equal(after.claimLock, null);
  assert.ok(store.listComments(t.id).some((c) => /认领已回收/.test(c.body)));
  assert.ok(store.listGovernanceAudit().some((a) => a.action === "reclaim" && a.allowed));
  store.close();
});

test("回收守卫：执行侧仍 running → 暂不回收（避免重复派发）；心跳新鲜也不回收", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: true, status: "running", pending: 0 }) };
  const expired = now + DEFAULT_CLAIM_TTL_MS + 60_000;
  const r1 = store.reclaimStaleClaim(t.identifier, { now: expired });
  assert.equal(r1.reclaimed, false);
  assert.equal(r1.reason, "worker-alive");
  // 心跳新鲜（未过期、心跳在阈值内）→ 也不回收
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0 }) };
  store.claimTask(t.identifier, { sessionId: "s1", now: expired, ttlMs: 10 * 60 * 1000 });
  const r2 = store.reclaimStaleClaim(t.identifier, { now: expired + 1000, heartbeatGapMs: DEFAULT_HEARTBEAT_GAP_MS });
  assert.equal(r2.reclaimed, false);
  assert.equal(r2.reason === "claim-fresh" || r2.reason === "worker-alive", true);
  store.close();
});

test("批量回收：只动失效认领，返回清单", () => {
  const { store, t } = setup();
  const item2 = store.createRequirementItem({ projectId: "p1", title: "R2" });
  const t2 = store.createTask({ projectId: "p1", title: "T2", status: "todo" });
  store.associateRequirementTask(item2.id, t2.id);
  const now = Date.now();
  const ttl = DEFAULT_CLAIM_TTL_MS;
  store.startTaskExecution(t.identifier, { sessionId: "s1" }); // in_progress + 认领（默认 TTL）
  store.startTaskExecution(t2.identifier, { sessionId: "s2" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "x", live: false, running: false, status: null, pending: 0 }) };
  // t2 在**到期前**刚心跳过 → 回收时刻心跳仍新鲜 → 不回收
  assert.equal(store.heartbeatTask(t2.identifier, { now: now + ttl - 60_000 }).ok, true);
  const reclaimed = store.reclaimStaleClaims({ now: now + ttl + 1000 });
  assert.deepEqual(reclaimed.map((r) => r.identifier), [t.identifier]);
  assert.equal(store.getTaskRef(t2.identifier).status, "in_progress");
  store.close();
});

test("API：在途判定以认领为准 → 重复 execute 返 409；心跳端点可用；/execution 带 claim", async () => {
  const { store, t } = setup();
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0 }) };
  const router = createApiRouter({ store });
  await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: new URLSearchParams(), body: { sessionId: "s1" } });
  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.equal(exec.payload.claim.locked, true);
  assert.equal(exec.payload.claim.expired, false);
  // 会话 idle 但认领+心跳新鲜 → 仍视为在途，拒绝重复下发
  await assert.rejects(
    () => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: new URLSearchParams(), body: {} }),
    (e) => e.code === "EXECUTION_ALREADY_RUNNING" && e.details.via === "claim",
  );
  const hb = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/heartbeat`, searchParams: new URLSearchParams(), body: { note: "仍在跑" } });
  assert.equal(hb.status, 200);
  assert.equal(hb.payload.ok, true);
  store.close();
});
