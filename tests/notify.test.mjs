/** FR-81 纯函数：交付模式归一化 / 终态判定 / 事件挑选与去重 / 消息构造 / 汇总。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKED_RUN_OUTCOMES, COMPLETED_RUN_OUTCOMES, IGNORED_RUN_OUTCOMES, NOTIFY_DELIVERY_MODES,
  buildNotifyMessage, isTerminalNotifyEvent, normalizeDeliveryMode, selectNotifyEvents, summarizeNotifyDelivery,
} from "../src/core/notify.mjs";

const evt = (over = {}) => ({ id: `e${over.cursor ?? 1}`, taskId: "t1", cursor: 1, seq: 1, type: "run_ended", from: "running", to: "success", actor: "system", detail: null, at: "2026-10-17T00:00:00.000Z", ...over });

test("交付模式：三种合法模式 + 各自 wake/comment 语义 + 非法值不抛错", () => {
  assert.deepEqual([...NOTIFY_DELIVERY_MODES], ["notify", "notify+wake", "wake"]);
  assert.deepEqual(normalizeDeliveryMode("notify"), { mode: "notify", valid: true, reason: null, wake: false, comment: true });
  assert.deepEqual(normalizeDeliveryMode("notify+wake"), { mode: "notify+wake", valid: true, reason: null, wake: true, comment: true });
  assert.deepEqual(normalizeDeliveryMode("wake"), { mode: "wake", valid: true, reason: null, wake: true, comment: false });
  assert.equal(normalizeDeliveryMode("  notify  ").mode, "notify", "两侧空白应被裁掉");
  for (const bad of ["sms", "NOTIFY", "", null, undefined, 42]) {
    const norm = normalizeDeliveryMode(bad);
    assert.equal(norm.valid, false, `非法模式必须判无效：${String(bad)}`);
    assert.equal(norm.mode, null);
    assert.match(norm.reason, /未知交付模式/);
    assert.equal(norm.wake, false);
    assert.equal(norm.comment, false);
  }
});

test("终态判定 · run_ended：success=完成；blocked/failed/crash/timeout=受阻；回收与人工退回不推", () => {
  for (const to of COMPLETED_RUN_OUTCOMES) {
    const r = isTerminalNotifyEvent(evt({ to }));
    assert.deepEqual([r.notifiable, r.kind, r.terminal], [true, "completed", true], `run_ended/${to} 应为完成`);
  }
  for (const to of BLOCKED_RUN_OUTCOMES) {
    const r = isTerminalNotifyEvent(evt({ to }));
    assert.deepEqual([r.notifiable, r.kind, r.terminal], [true, "blocked", true], `run_ended/${to} 应为受阻`);
  }
  for (const to of IGNORED_RUN_OUTCOMES) {
    const r = isTerminalNotifyEvent(evt({ to }));
    assert.equal(r.notifiable, false, `run_ended/${to} 不该推送`);
    assert.equal(r.terminal, false);
  }
  assert.equal(isTerminalNotifyEvent(evt({ to: "success" })).kind, "completed");
  assert.match(isTerminalNotifyEvent(evt({ to: "reclaimed" })).reason, /非终态收场/);
  assert.equal(isTerminalNotifyEvent(evt({ to: "wat" })).notifiable, false, "未知收场按不推送处理（保守）");
});

test("终态判定 · blocked 事件：人工兜底=自动阻断 / 普通=受阻 / 回待执行（依赖未就绪）不推", () => {
  const auto = isTerminalNotifyEvent({ type: "blocked", to: "blocked", detail: "类型=transient recurrences=2（人工兜底）" });
  assert.deepEqual([auto.notifiable, auto.kind], [true, "auto_blocked"]);
  assert.match(auto.reason, /人工兜底/);
  const plain = isTerminalNotifyEvent({ type: "blocked", to: "blocked", detail: "类型=capability recurrences=1" });
  assert.deepEqual([plain.notifiable, plain.kind], [true, "blocked"]);
  const dep = isTerminalNotifyEvent({ type: "blocked", to: "todo", detail: "类型=dependency" });
  assert.equal(dep.notifiable, false, "依赖未就绪回「可开工」不算终态阻断");
  assert.match(dep.reason, /依赖未就绪/);
});

test("终态判定 · status_changed：done=完成 / blocked=受阻 / in_review 等不单独判终态", () => {
  assert.deepEqual([isTerminalNotifyEvent({ type: "status_changed", to: "done" }).notifiable, isTerminalNotifyEvent({ type: "status_changed", to: "done" }).kind], [true, "completed"]);
  assert.deepEqual([isTerminalNotifyEvent({ type: "status_changed", to: "blocked" }).notifiable, isTerminalNotifyEvent({ type: "status_changed", to: "blocked" }).kind], [true, "blocked"]);
  for (const to of ["in_review", "in_progress", "todo", "backlog", "canceled"]) {
    assert.equal(isTerminalNotifyEvent({ type: "status_changed", to }).notifiable, false, `${to} 不是终态`);
  }
});

test("终态判定 · 其它事件类型（评论/心跳/失败记账/评审）一律不推", () => {
  for (const type of ["created", "claimed", "heartbeat", "run_started", "failure_recorded", "review_requested", "review_approved", "changes_requested", "requeued", "released", "comment", ""]) {
    const r = isTerminalNotifyEvent({ type, to: "success" });
    assert.equal(r.notifiable, false, `类型 ${type || "(空)"} 不该推送`);
  }
  assert.match(isTerminalNotifyEvent({ type: "review_approved" }).reason, /不参与通知/);
});

test("事件挑选：跳过非终态 + 游标推进到最大 cursor + 计数（scanned/skipped/deduped）", () => {
  const stream = [
    evt({ cursor: 1, type: "created", to: "todo" }),
    evt({ cursor: 2, type: "run_started", to: "running" }),
    evt({ cursor: 3, taskId: "t1", to: "success" }),
    evt({ cursor: 4, taskId: "t2", type: "heartbeat", to: "running" }),
    evt({ cursor: 5, taskId: "t2", type: "blocked", to: "blocked", detail: "类型=transient recurrences=1" }),
  ];
  const picked = selectNotifyEvents(stream, { since: 0 });
  assert.equal(picked.scanned, 5);
  assert.equal(picked.skipped, 3, "created / run_started / heartbeat 都不推");
  assert.equal(picked.deduped, 0);
  assert.equal(picked.cursor, 5, "游标要推进到见到的最大 cursor（含被跳过的事件）");
  assert.deepEqual(picked.events.map((e) => [e.taskId, e.kind]), [["t1", "completed"], ["t2", "blocked"]]);
});

test("事件挑选：同一任务只留首条终态（run_ended 与随后的 status_changed 不重复推）", () => {
  const stream = [
    evt({ cursor: 7, taskId: "t1", type: "run_ended", to: "success" }),
    evt({ cursor: 8, taskId: "t1", type: "status_changed", to: "done" }),
    evt({ cursor: 9, taskId: "t1", type: "blocked", to: "blocked", detail: "类型=transient recurrences=1" }),
  ];
  const picked = selectNotifyEvents(stream, { since: 0 });
  assert.equal(picked.events.length, 1);
  assert.equal(picked.deduped, 2);
  assert.equal(picked.events[0].cursor, 7);
  assert.equal(picked.events[0].kind, "completed");
});

test("事件挑选：since 之前的旧事件不重复推；空输入安全", () => {
  const stream = [evt({ cursor: 3, taskId: "t1", to: "success" }), evt({ cursor: 9, taskId: "t2", to: "success" })];
  const picked = selectNotifyEvents(stream, { since: 3 });
  assert.deepEqual(picked.events.map((e) => e.cursor), [9], "cursor=3 已推过，不再推");
  assert.equal(picked.cursor, 9);
  assert.deepEqual(selectNotifyEvents([]), { events: [], cursor: 0, scanned: 0, skipped: 0, deduped: 0 });
  assert.deepEqual(selectNotifyEvents(null, { since: 5 }).events, []);
  assert.equal(selectNotifyEvents(null, { since: 5 }).cursor, 5, "空输入也要保留传入游标");
});

test("消息构造 · notify：只出评论体（不投会话），含任务编号与类别", () => {
  const events = selectNotifyEvents([
    evt({ cursor: 1, taskId: "t1", to: "success" }),
    evt({ cursor: 2, taskId: "t2", type: "blocked", to: "blocked", detail: "类型=transient recurrences=2（人工兜底）" }),
  ]).events;
  const msg = buildNotifyMessage({
    project: { id: "p1", name: "P1" }, events, mode: "notify",
    taskOf: (id) => ({ id, identifier: id === "t1" ? "TB-1" : "TB-2", title: id === "t1" ? "实现 A" : "实现 B" }),
  });
  assert.equal(msg.prompt, null, "notify 不投会话");
  assert.equal(msg.mode, "notify");
  assert.deepEqual(msg.taskIds, ["t1", "t2"]);
  assert.deepEqual(msg.kinds.sort(), ["auto_blocked", "completed"]);
  assert.match(msg.commentBody, /TB-1/);
  assert.match(msg.commentBody, /TB-2/);
  assert.match(msg.commentBody, /自动阻断/);
  assert.match(msg.commentBody, /仅通知，未投递会话/);
  assert.ok(!/已同时唤醒/.test(msg.commentBody));
});

test("消息构造 · notify+wake：评论体与投递文本都要有（且重申「不得置 done」）", () => {
  const events = selectNotifyEvents([evt({ cursor: 1, taskId: "t1", to: "success" })]).events;
  const msg = buildNotifyMessage({ project: { id: "p1", name: "P1" }, events, mode: "notify+wake", taskOf: () => ({ identifier: "TB-1", title: "实现 A" }) });
  assert.ok(msg.prompt, "notify+wake 必须投递");
  assert.match(msg.prompt, /TB-1/);
  assert.match(msg.prompt, /不得置 done/, "投递文本要重申红线");
  assert.match(msg.prompt, /人工验收/);
  assert.match(msg.commentBody, /已同时唤醒/);
});

test("消息构造 · wake：极简唤醒信号（不含逐条明细），且**不产生评论体**", () => {
  const events = selectNotifyEvents([
    evt({ cursor: 1, taskId: "t1", to: "success" }),
    evt({ cursor: 2, taskId: "t2", to: "success" }),
  ]).events;
  const wake = buildNotifyMessage({ project: { id: "p1", name: "P1" }, events, mode: "wake", taskOf: (id) => ({ identifier: `TB-${id}`, title: "标题" }) });
  const both = buildNotifyMessage({ project: { id: "p1", name: "P1" }, events, mode: "notify+wake", taskOf: (id) => ({ identifier: `TB-${id}`, title: "标题" }) });
  assert.equal(wake.commentBody, null, "wake 不留评论");
  assert.match(wake.prompt, /【唤醒】/);
  assert.match(wake.prompt, /2 个任务已到终态/);
  assert.ok(wake.prompt.length < both.prompt.length, "wake 必须比 notify+wake 更简");
  assert.ok(!/TB-t1/.test(wake.prompt), "wake 不带逐条明细");
});

test("消息构造：非法模式抛错；空事件返回全空（调用方据此跳过投递）", () => {
  assert.throws(() => buildNotifyMessage({ events: [evt()], mode: "sms" }), /未知交付模式/);
  const empty = buildNotifyMessage({ events: [], mode: "notify+wake" });
  assert.deepEqual([empty.prompt, empty.commentBody, empty.taskIds.length], [null, null, 0]);
});

test("汇总：delivered/failed/pending/noop/byMode 的分摊口径", () => {
  const summary = summarizeNotifyDelivery([
    { mode: "notify+wake", delivered: true, commented: 2, count: 2 },
    { mode: "notify", delivered: true, commented: 1, count: 1 },
    { mode: "wake", delivered: false, error: "会话已失效", count: 3 },
    { mode: "wake", delivered: false, reason: "no-terminal-events", count: 0 },
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.delivered, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.noop, 1);
  assert.equal(summary.commented, 3);
  assert.equal(summary.pending, 3, "只有投递失败的订阅，其事件才算还在队列里");
  assert.deepEqual(summary.byMode, { "notify+wake": 1, notify: 1, wake: 2 });
  assert.deepEqual(summarizeNotifyDelivery(), { total: 0, delivered: 0, failed: 0, pending: 0, commented: 0, noop: 0, byMode: {} });
});
