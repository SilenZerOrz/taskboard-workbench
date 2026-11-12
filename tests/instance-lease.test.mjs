/**
 * 卡 `-237` / 需求 `R173`：同一份库、多个实例 ⇒ 单写者租约。
 *
 * 为什么需要它（真机 2026-11-10）：dsh web 与 dsh desktop 同时打开同一个库时，
 * 两份 `index.js` 各起一份执行循环、各跑一次 boot 收口 —— 对端正跑着的执行会被当孤儿结清，
 * 同一张卡也可能被双派发。租约把「谁能写」收敛成**库里的一行**（跨进程可用、不依赖宿主）。
 *
 * 语义钉子（全都是「保守」方向，防止静默夺权）：
 *  - 空库首次 acquire ⇒ writer；
 *  - 同一个实例重复 acquire ⇒ 续约（心跳），仍是 writer；
 *  - 对端心跳还新鲜 ⇒ follower，**不改写**对端的行；
 *  - 对端过期（默认 45s）⇒ 才接管，并回 `tookOver: true`；
 *  - release 只清自己那行，follower 调 release 不许清掉别人的租约。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { LEASE_TTL_MS, LEASE_HEARTBEAT_MS } from "../src/core/instance-lease.mjs";

function withTwoStores(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-lease-"));
  const dbPath = path.join(dir, "taskboard.sqlite");
  const a = openStore({ dbPath });
  const b = openStore({ dbPath });
  try {
    return fn({ a, b, dbPath });
  } finally {
    try { a.close(); } catch { /* ignore */ }
    try { b.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("租约常量：心跳 15s 必须显著短于过期 45s（否则正常心跳也会被误判为过期）", () => {
  assert.equal(LEASE_HEARTBEAT_MS, 15_000);
  assert.equal(LEASE_TTL_MS, 45_000);
  assert.ok(LEASE_HEARTBEAT_MS * 2 <= LEASE_TTL_MS, "至少容忍漏掉一拍心跳");
});

test("空库首次 acquire ⇒ writer；重复 acquire 是续约，不是夺权", () => {
  const t0 = Date.now();
  withTwoStores(({ a }) => {
    const first = a.acquireInstanceLease({ host: "h1", pid: 111, nowMs: t0 });
    assert.equal(first.role, "writer");
    assert.equal(first.tookOver, false);
    assert.equal(first.owner, null, "自己是写者时没有 owner");

    const again = a.acquireInstanceLease({ host: "h1", pid: 111, nowMs: t0 + 1000 });
    assert.equal(again.role, "writer");
    assert.equal(again.tookOver, false);
    assert.equal(again.instanceId, first.instanceId, "同一实例的 instanceId 必须稳定");
  });
});

test("对端心跳新鲜 ⇒ follower，且不抢占（对端仍 writer）", () => {
  const t0 = Date.now();
  withTwoStores(({ a, b }) => {
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 });
    const r = b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + 1000 });
    assert.equal(r.role, "follower");
    assert.equal(r.tookOver, false);
    assert.equal(r.owner.pid, 111);
    assert.equal(r.owner.host, "web");
    assert.equal(a.instanceRole(), "writer", "被跟随的一方不受影响");
    assert.equal(b.instanceRole(), "follower");
    assert.equal(a.instanceRoleFresh(), "writer");
    assert.equal(b.instanceRoleFresh(), "follower", "现读也要一致（写门吃的是这一条）");
  });
});

test("续约有效：不能靠「对端早已停止心跳」偷走租约", () => {
  const t0 = Date.now();
  withTwoStores(({ a, b }) => {
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 });
    // 对端在 50s 时还在心跳（此刻若按 t0 起算早已过期）
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 + 50_000 });
    const r = b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + 50_001 });
    assert.equal(r.role, "follower", "续约过的对端必须仍被认作活着");
  });
});

test("对端过期 ⇒ 接管（tookOver=true 且带回上一任是谁）", () => {
  const t0 = Date.now();
  withTwoStores(({ a, b }) => {
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 });
    const r = b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + LEASE_TTL_MS + 1000 });
    assert.equal(r.role, "writer");
    assert.equal(r.tookOver, true);
    assert.equal(r.previous.pid, 111, "接管必须留下「上一任是谁」供日志与收口判断");
    // 被夺权方的**本地缓存**要到下一次心跳才知道（≤15s 有界滞后）——
    // 所以写门不能吃缓存：`instanceRoleFresh` 必须当场就是 follower。
    assert.equal(a.instanceRoleFresh(), "follower", "现读必须立刻降级");
    const aNext = a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 + LEASE_TTL_MS + 2000 });
    assert.equal(aNext.role, "follower", "下一次心跳必须发现自己已被接管");
    assert.equal(a.instanceRole(), "follower");
  });
});

test("release 只清自己的租约：follower 释放不许把对端的租约删掉", () => {
  const t0 = Date.now();
  withTwoStores(({ a, b }) => {
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 });
    b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + 1000 });
    assert.equal(b.releaseInstanceLease(), false, "follower 没有租约可释放");

    const stillWriter = a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 + 2000 });
    assert.equal(stillWriter.role, "writer", "对端的租约必须还在");

    assert.equal(a.releaseInstanceLease(), true);
    const after = b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + 3000 });
    assert.equal(after.role, "writer");
    assert.equal(after.tookOver, false, "干净释放后是空库首抢，不是接管");
  });
});

test("stats() 如实报 role / leaseOwner（/api/health 的数据来源）", () => {
  const t0 = Date.now();
  withTwoStores(({ a, b }) => {
    a.acquireInstanceLease({ host: "web", pid: 111, nowMs: t0 });
    assert.equal(a.stats().role, "writer");
    assert.equal(a.stats().leaseOwner, null);

    b.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: t0 + 1000 });
    const s = b.stats();
    assert.equal(s.role, "follower");
    assert.equal(s.leaseOwner.pid, 111);
    assert.equal(s.leaseOwner.host, "web");
  });
});
