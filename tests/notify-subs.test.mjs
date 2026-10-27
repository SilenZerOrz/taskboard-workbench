/**
 * FR-81 通知订阅与唤醒：订阅表 / 事件游标 / 三种交付模式 / 失败保留游标 / HTTP 端点。
 * 纯函数（终态判定、事件挑选、消息构造）的用例在同轮的 `tests/notify.test.mjs`；
 * 这里只测 **store + API + 投递闭环**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const t1 = store.createTask({ projectId: "p1", title: "实现 A", status: "in_progress" });
  const t2 = store.createTask({ projectId: "p1", title: "实现 B", status: "in_progress" });
  return { store, t1, t2 };
}

/** 造一条终态：开一次尝试并按给定 outcome 闭合（success = 完成；blocked/failed… = 受阻）。 */
function finishRun(store, task, outcome = "success") {
  store.startTaskRun(task.identifier, { actor: "tester" });
  return store.endTaskRun(task.identifier, { outcome, summary: `tester 造的 ${outcome}`, actor: "tester" });
}

function collector() {
  const calls = [];
  const deliver = async (sessionId, text) => { calls.push({ sessionId, text }); return { sent: true, via: "fake" }; };
  return { calls, deliver };
}

const sp = () => new URLSearchParams();

test("建订阅：项目级 / 任务级 / 同键复用 / 非法模式与空会话被拒", () => {
  const { store, t1 } = setup();
  const proj = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "notify+wake" });
  assert.equal(proj.scope, "project");
  assert.equal(proj.taskId, null);
  assert.equal(proj.active, true);
  assert.equal(proj.lastCursor, 0);
  const taskSub = store.createNotifySubscription({ projectId: "p1", taskRef: t1.identifier, sessionId: "s1", mode: "notify" });
  assert.equal(taskSub.scope, "task");
  assert.equal(taskSub.taskId, t1.id);
  store.updateNotifySubscription(proj.id, { active: false });
  const again = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "notify+wake" });
  assert.equal(again.id, proj.id, "同键必须复用而不是新建");
  assert.equal(again.active, true, "复用即重新启用");
  assert.equal(store.listNotifySubscriptions({ projectId: "p1" }).length, 2);
  assert.throws(() => store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "sms" }), /交付模式/);
  assert.throws(() => store.createNotifySubscription({ projectId: "p1", sessionId: "   ", mode: "notify" }), /目标会话/);
  store.close();
});

test("作用域：任务级订阅只看得见该任务的终态；项目级看得见全项目", () => {
  const { store, t1, t2 } = setup();
  const taskSub = store.createNotifySubscription({ projectId: "p1", taskRef: t1.identifier, sessionId: "s1", mode: "notify" });
  const projSub = store.createNotifySubscription({ projectId: "p1", sessionId: "s2", mode: "notify" });
  finishRun(store, t2);
  assert.equal(store.notifySubPending(taskSub.id).count, 0, "别的任务的终态不该进任务级订阅");
  assert.equal(store.notifySubPending(projSub.id).count, 1);
  finishRun(store, t1);
  assert.equal(store.notifySubPending(taskSub.id).count, 1);
  assert.equal(store.notifySubPending(projSub.id).count, 2);
  store.close();
});

test("flush 成功：投递摘要 + 写评论留痕 + 推进游标；再 flush 不重复推送", async () => {
  const { store, t1 } = setup();
  const sub = store.createNotifySubscription({ projectId: "p1", sessionId: "s-main", mode: "notify+wake" });
  finishRun(store, t1);
  const fake = collector();
  const first = await store.flushNotifySubscriptions({ projectId: "p1", deliver: fake.deliver });
  const item = first.results[0];
  assert.equal(item.delivered, true);
  assert.equal(item.count, 1);
  assert.deepEqual(item.kinds, ["completed"]);
  assert.equal(fake.calls.length, 1, "notify+wake 必须投递一次");
  assert.equal(fake.calls[0].sessionId, "s-main");
  assert.match(fake.calls[0].text, new RegExp(t1.identifier), "投递文本要能让会话定位到任务");
  assert.equal(item.commented, 1, "notify+wake 要在任务里留痕");
  assert.match(store.listComments(t1.id).at(-1).body, /FR-81/);
  const after = store.getNotifySubscription(sub.id);
  assert.equal(after.deliveredCount, 1);
  assert.equal(after.lastCursor, item.cursor);
  assert.equal(after.lastError, null);
  const second = await store.flushNotifySubscriptions({ projectId: "p1", deliver: fake.deliver });
  assert.equal(second.results[0].count, 0);
  assert.equal(second.results[0].delivered, false);
  assert.equal(second.results[0].reason, "no-terminal-events");
  assert.equal(fake.calls.length, 1, "游标已前进 → 不得重复投递");
  store.close();
});

test("投递失败：如实记录 + 保留游标（不静默丢失），恢复后能补推同一批", async () => {
  const { store, t1 } = setup();
  const sub = store.createNotifySubscription({ projectId: "p1", sessionId: "s-dead", mode: "notify+wake" });
  finishRun(store, t1);
  const failed = await store.flushNotifySubscriptions({
    projectId: "p1",
    deliver: async () => ({ sent: false, via: "sessionController.prompt", error: "会话已失效" }),
  });
  assert.equal(failed.results[0].delivered, false);
  assert.match(failed.results[0].error, /会话已失效/);
  const afterFail = store.getNotifySubscription(sub.id);
  assert.equal(afterFail.lastCursor, 0, "失败必须保留游标");
  assert.equal(afterFail.failedCount, 1);
  assert.match(afterFail.lastError, /会话已失效/);
  assert.equal(afterFail.deliveredCount, 0);
  const fake = collector();
  const retry = await store.flushNotifySubscriptions({ projectId: "p1", deliver: fake.deliver });
  assert.equal(retry.results[0].delivered, true, "目标恢复后同一批要补推成功");
  assert.equal(retry.results[0].count, 1);
  assert.equal(store.getNotifySubscription(sub.id).lastError, null);
  assert.equal(store.getNotifySubscription(sub.id).lastCursor, retry.results[0].cursor);
  store.close();
});

test("投递抛异常也算失败（不推进游标、不计成功）", async () => {
  const { store, t1 } = setup();
  const sub = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "wake" });
  finishRun(store, t1);
  const r = await store.flushNotifySubscriptions({ projectId: "p1", deliver: async () => { throw new Error("boom"); } });
  assert.equal(r.results[0].delivered, false);
  assert.match(r.results[0].error, /boom/);
  assert.equal(store.getNotifySubscription(sub.id).lastCursor, 0);
  assert.equal(store.getNotifySubscription(sub.id).failedCount, 1);
  store.close();
});

test("三种交付模式差异：wake 只唤醒 / notify 只留痕 / notify+wake 两者都做", async () => {
  const { store, t1, t2 } = setup();
  const wakeSub = store.createNotifySubscription({ projectId: "p1", sessionId: "s-wake", mode: "wake" });
  const notifySub = store.createNotifySubscription({ projectId: "p1", sessionId: "s-notify", mode: "notify" });
  const bothSub = store.createNotifySubscription({ projectId: "p1", sessionId: "s-both", mode: "notify+wake" });
  finishRun(store, t1);
  finishRun(store, t2);
  const fake = collector();
  const r = await store.flushNotifySubscriptions({ projectId: "p1", deliver: fake.deliver });
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId[wakeSub.id].commented, 0, "wake 不写评论");
  assert.equal(byId[notifySub.id].commented, 2, "notify 只在任务里留痕（两个任务各一条）");
  assert.equal(byId[bothSub.id].commented, 2);
  assert.equal(fake.calls.length, 2, "只有含 wake 的两种模式调投递通道");
  assert.deepEqual(fake.calls.map((c) => c.sessionId).sort(), ["s-both", "s-wake"]);
  const wakeText = fake.calls.find((c) => c.sessionId === "s-wake").text;
  const bothText = fake.calls.find((c) => c.sessionId === "s-both").text;
  assert.ok(wakeText.length < bothText.length, "wake 是极简唤醒信号，不带事件明细");
  store.close();
});

test("宿主通道不可用（未挂 hostSessionPort）：wake 记失败并保留游标，notify 仍成功推进", async () => {
  const { store, t1 } = setup();
  const wakeSub = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "wake" });
  const notifySub = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "notify" });
  finishRun(store, t1);
  const r = await store.flushNotifySubscriptions({ projectId: "p1" });
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId[wakeSub.id].delivered, false);
  assert.match(byId[wakeSub.id].error, /不可用|失效/);
  assert.equal(store.getNotifySubscription(wakeSub.id).lastCursor, 0);
  assert.equal(byId[notifySub.id].delivered, true, "只留痕的模式不依赖宿主通道");
  assert.ok(store.getNotifySubscription(notifySub.id).lastCursor > 0);
  store.close();
});

test("HTTP：建订阅 / 列表带待推送摘要 / 改模式 / 停用 / 软删 vs purge", async () => {
  const { store, t1 } = setup();
  const router = createApiRouter({ store });
  const created = await router.route({ method: "POST", pathname: "/api/projects/p1/notify", searchParams: sp(), body: { sessionId: "s1", mode: "notify+wake", taskRef: t1.identifier } });
  assert.equal(created.status, 201);
  const id = created.payload.subscription.id;
  finishRun(store, t1);
  const list = await router.route({ method: "GET", pathname: "/api/projects/p1/notify", searchParams: sp() });
  assert.equal(list.payload.count, 1);
  assert.equal(list.payload.summary.pending, 1);
  assert.deepEqual(list.payload.subscriptions[0].pending.kinds, ["completed"]);
  await assert.rejects(
    () => router.route({ method: "POST", pathname: "/api/projects/p1/notify", searchParams: sp(), body: { sessionId: "s1", mode: "carrier-pigeon" } }),
    (e) => e.code === "INVALID_FIELD",
    "非法交付模式必须被拒（服务端转 400）",
  );
  const patched = await router.route({ method: "PATCH", pathname: `/api/notify/${id}`, searchParams: sp(), body: { mode: "wake" } });
  assert.equal(patched.payload.subscription.mode, "wake");
  await router.route({ method: "PATCH", pathname: `/api/notify/${id}`, searchParams: sp(), body: { active: false } });
  const active = await router.route({ method: "GET", pathname: "/api/projects/p1/notify", searchParams: sp() });
  assert.equal(active.payload.count, 0, "停用后不出现在默认列表");
  const all = await router.route({ method: "GET", pathname: "/api/projects/p1/notify", searchParams: new URLSearchParams("activeOnly=0") });
  assert.equal(all.payload.count, 1, "activeOnly=0 时仍能看到");
  const soft = await router.route({ method: "DELETE", pathname: `/api/notify/${id}`, searchParams: sp() });
  assert.equal(soft.payload.purged, false);
  assert.equal(soft.payload.subscription.active, false);
  assert.ok(store.getNotifySubscription(id), "软停用不得删数据");
  const purged = await router.route({ method: "DELETE", pathname: `/api/notify/${id}`, searchParams: new URLSearchParams("purge=1") });
  assert.equal(purged.payload.purged, true);
  assert.equal(store.getNotifySubscription(id), null);
  await assert.rejects(
    () => router.route({ method: "GET", pathname: "/api/notify/nope", searchParams: sp() }),
    (e) => e.code === "NOT_FOUND",
    "查不存在的订阅要 NOT_FOUND（服务端转 404）",
  );
  store.close();
});

test("HTTP：notify/events 预览只看不推（游标不动）+ notify/flush 真推（游标前进）", async () => {
  const { store, t1 } = setup();
  const router = createApiRouter({ store });
  const sub = store.createNotifySubscription({ projectId: "p1", sessionId: "s1", mode: "notify" });
  finishRun(store, t1);
  const preview = await router.route({ method: "GET", pathname: "/api/projects/p1/notify/events", searchParams: sp() });
  assert.equal(preview.payload.count, 1);
  assert.equal(store.getNotifySubscription(sub.id).lastCursor, 0, "预览不推进游标");
  const flush = await router.route({ method: "POST", pathname: "/api/projects/p1/notify/flush", searchParams: sp(), body: {} });
  assert.equal(flush.status, 200);
  assert.equal(flush.payload.summary.delivered, 1);
  assert.equal(flush.payload.results[0].delivered, true);
  assert.ok(store.getNotifySubscription(sub.id).lastCursor > 0, "flush 真推 → 游标前进");
  const cursor = flush.payload.results[0].cursor;
  const previewAfter = await router.route({ method: "GET", pathname: "/api/projects/p1/notify/events", searchParams: new URLSearchParams(`since=${cursor}`) });
  assert.equal(previewAfter.payload.count, 0, "已推送过的游标之后再预览应为空");
  store.close();
});

test("旧库迁移：新增 notify_subs 不破坏老库，重开幂等且可立即订阅", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t24-notify-"));
  try {
    const dbPath = path.join(dir, "taskboard.sqlite");
    const first = openStore({ dbPath });
    first.createProject({ id: "p1", name: "P1" });
    const t = first.createTask({ projectId: "p1", title: "旧库任务", status: "in_progress" });
    first.close();
    const again = openStore({ dbPath });
    assert.equal(again.stats().schemaVersion, 10);
    const sub = again.createNotifySubscription({ projectId: "p1", taskRef: t.identifier, sessionId: "s1", mode: "notify+wake" });
    finishRun(again, again.getTaskRef(t.identifier));
    assert.equal(again.notifySubPending(sub.id).count, 1, "重开后的老库要能立即用订阅");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
