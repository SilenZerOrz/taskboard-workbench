/**
 * 卡 `-260`（需求 `R185`）：经主会话下发的执行也有心跳；进「待验收」即在途尝试当场闭合。
 *
 * 真机 `-248` 的两个读数就是本卡的靶子：
 *   ① 一条 22 分 51 秒的成功尝试，`heartbeats = 1`（只有认领那一拍）—— 主会话下发没有本地进程可挂心跳；
 *   ② 卡片 08:37:13 已 `in_review`，`run_ended` 晚到 08:41:08 —— 3 分 55 秒「待验收 vs 进行中」并存。
 *
 * 口径红线：**只给「会话确实在跑」的尝试心跳**；会话空闲一拍都不打（不臆造进度）。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";

function setup({ sessionState = null } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  if (sessionState) store.hostSessionPort = { sessionState: () => sessionState };
  return { store, t };
}

const RUNNING = { sessionId: "s1", live: true, running: true, status: "running", pending: 0 };
const IDLE = { sessionId: "s1", live: true, running: false, status: "idle", pending: 0 };

function lastRun(store, t) {
  const runs = store.listTaskRuns(t.identifier);
  return runs[runs.length - 1];
}

test("A 会话在跑 ⇒ 心跳计数增长，且**不写 heartbeat 事件**（避免 40 条噪音）", () => {
  const { store, t } = setup({ sessionState: RUNNING });
  // 模拟「主会话下发」：认领 + 进进行中
  store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_progress", actor: "agent" });
  const before = lastRun(store, t).heartbeats;
  const eventsBefore = store.listTaskEvents(t.identifier).filter((e) => e.type === "heartbeat").length;

  const beat = store.heartbeatDispatchedRuns();
  assert.deepEqual(beat, [t.identifier], "会话在跑 ⇒ 应给这张卡打心跳");

  const after = lastRun(store, t);
  assert.equal(after.heartbeats, before + 1, "心跳计数必须增长");
  assert.ok(new Date(after.lastHeartbeatAt).getTime() > new Date(before === 1 ? 0 : after.startedAt).getTime() - 1);
  const eventsAfter = store.listTaskEvents(t.identifier).filter((e) => e.type === "heartbeat").length;
  assert.equal(eventsAfter, eventsBefore, "批量心跳不得往事件流里塞 heartbeat 事件");
});

test("B 会话空闲 ⇒ 一拍都不打（不臆造进度）", () => {
  const { store, t } = setup({ sessionState: IDLE });
  store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_progress", actor: "agent" });
  const before = lastRun(store, t).heartbeats;
  assert.deepEqual(store.heartbeatDispatchedRuns(), []);
  assert.equal(lastRun(store, t).heartbeats, before);
});

test("C 无宿主会话状态（独立进程）⇒ 不心跳，但也不报错", () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_progress", actor: "agent" });
  assert.deepEqual(store.heartbeatDispatchedRuns(), [], "读不到会话状态 ⇒ 不臆造");
});

test("D 进「待验收」即在途尝试当场闭合（前后对照）", () => {
  const { store, t } = setup({ sessionState: RUNNING });
  store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });
  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_progress", actor: "agent" });
  store.addTaskEvidence(t.identifier, { verdict: "判定：完成，已提交待验收", deviation: "无", boundary: "未碰 :3080", artifacts: ["a.mjs"], actor: "codex" });

  assert.equal(lastRun(store, t).status, "running", "前置：进待验收前尝试确实是 running（对照成立）");

  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_review", actor: "human" });
  const after = lastRun(store, t);
  assert.notEqual(after.status, "running", "进待验收后不得再有在途尝试");
  assert.equal(after.outcome, "success");
  assert.equal(after.summary, "判定：完成，已提交待验收", "摘要沿用 -259 口径（最近证据 verdict）");
  assert.ok(after.endedAt, "必须写 ended_at");
});

test("E 进「待验收」时本就没有在途尝试 ⇒ 不报错、不产生第二条尝试", () => {
  const { store, t } = setup({ sessionState: RUNNING });
  const before = store.listTaskRuns(t.identifier).length;
  store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, status: "in_review", actor: "human" });
  assert.equal(store.listTaskRuns(t.identifier).length, before, "不得凭空造出尝试记录");
});
