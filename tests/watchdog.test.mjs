/** 执行看护（FR-75 停滞检测 / FR-76 "下一步建议"跟进）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { assessTask, extractFollowups, latestProgressComment, looksLikeQuestion, projectWatchdog, STALL_THRESHOLD_MS } from "../src/core/watchdog.mjs";

const NOW = new Date("2026-10-16T02:00:00Z").getTime();
const at = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();
const task = (over = {}) => ({ status: "in_progress", updatedAt: at(0), ...over });
const session = (over = {}) => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0, ...over });

test("extractFollowups：抓取「下一步/建议」块（含列表与疑问句），普通段落即止", () => {
  const text = [
    "已完成 工具定位：…",
    "下一步（马上做）：",
    "- 把整体横向收窄到 ≤1390px",
    "- 重跑 finalize，再做 visual-check",
    "要我现在继续收窄并跑完 finalize 吗？",
    "",
    "红线遵守：未改需求文档、未 commit/push。",
    "顺带一提，这里不该被当成建议",
  ].join("\n");
  const items = extractFollowups(text);
  assert.deepEqual(items, ["把整体横向收窄到 ≤1390px", "重跑 finalize，再做 visual-check", "要我现在继续收窄并跑完 finalize 吗？"]);
});

test("extractFollowups：内联 `下一步（马上做）：X` 去掉限定语前缀", () => {
  assert.deepEqual(extractFollowups("下一步（马上做）：把整体横向收窄到 ≤1390px，重跑 finalize。"), ["把整体横向收窄到 ≤1390px，重跑 finalize。"]);
});

test("extractFollowups：无建议 → 空数组", () => {
  assert.deepEqual(extractFollowups("执行完成，未产生变更。\n结论：提交待验收。"), []);
});

test("latestProgressComment：取最近一条「有进展意义」的评论", () => {
  const comments = [
    { body: "团队回报：失败 → 受阻", createdAt: at(30) },
    { body: "【反馈】进度汇报…", createdAt: at(5) },
    { body: "路过的一句闲聊", createdAt: at(1) },
  ];
  assert.equal(latestProgressComment(comments).createdAt, at(5));
});

test("assessTask：会话仍在 running → 永不判停滞", () => {
  const r = assessTask({ task: task(), comments: [{ body: "进度：跑了很久", createdAt: at(60) }], sessionState: session({ running: true, status: "running" }), now: NOW });
  assert.equal(r.state, "running");
});

test("assessTask：会话空闲 + 有「下一步建议」→ awaiting-decision（等人决策，不算卡死）", () => {
  const r = assessTask({ task: task(), comments: [{ body: "【反馈】\n下一步：\n- 收窄到 ≤1390px", createdAt: at(3) }], sessionState: session(), now: NOW });
  assert.equal(r.state, "awaiting-decision");
  assert.equal(r.followups.length, 1);
  assert.equal(r.reason, "session-idle");
});

test("assessTask：会话空闲 + 无建议 + 超阈值 → stalled；阈值内 → idle", () => {
  const comments = [{ body: "进度：做了一半", createdAt: at(27) }];
  assert.equal(assessTask({ task: task(), comments, sessionState: session(), now: NOW }).state, "stalled");
  assert.equal(assessTask({ task: task({ updatedAt: at(2) }, ), comments: [{ body: "进度：刚开始", createdAt: at(2) }], sessionState: session(), now: NOW }).state, "idle");
  assert.equal(Math.ceil(STALL_THRESHOLD_MS / 60000), 10);
});

test("assessTask：会话未在线也按同样口径；非 in_progress 直接 ok", () => {
  const r = assessTask({ task: task(), comments: [{ body: "进度：…", createdAt: at(30) }], sessionState: session({ live: false }), now: NOW });
  assert.equal(r.state, "stalled");
  assert.equal(r.reason, "session-offline");
  assert.equal(assessTask({ task: task({ status: "in_review" }), comments: [], sessionState: session(), now: NOW }).state, "ok");
});

test("looksLikeQuestion：疑问句/征询确认", () => {
  assert.equal(looksLikeQuestion("要我现在继续收窄并跑完 finalize 吗？"), true);
  assert.equal(looksLikeQuestion("是否继续"), true);
  assert.equal(looksLikeQuestion("已完成，无变更"), false);
});

test("API：/execution 带 watchdog；/followup derive 生成关联子任务；dismiss 登记忽略", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0 }) };
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  store.addComment(t.id, { body: "【反馈】\n已完成 X。\n下一步：\n- 做 Y\n- 做 Z" });
  const router = createApiRouter({ store });

  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.equal(exec.payload.watchdog.state, "awaiting-decision");
  assert.deepEqual(exec.payload.watchdog.followups, ["做 Y", "做 Z"]);

  const derived = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/followup`, searchParams: new URLSearchParams(), body: { action: "derive", title: "做 Y" } });
  assert.equal(derived.status, 201);
  const child = derived.payload.child;
  assert.equal(child.parentId, t.id);
  assert.equal(child.requirementId, item.id);
  assert.equal(child.status, "backlog");

  const dismissed = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/followup`, searchParams: new URLSearchParams(), body: { action: "dismiss", title: "做 Z" } });
  assert.equal(dismissed.payload.dismissed, true);
  assert.ok(store.listComments(t.id).some((c) => /已忽略/.test(c.body)));

  // 看板列表按需带 watchdog
  const listed = await router.route({ method: "GET", pathname: "/api/tasks", searchParams: new URLSearchParams({ project: "p1", withWatchdog: "1" }) });
  assert.ok(listed.payload.tasks.every((x) => x.status !== "in_progress" || x.watchdog));
  store.close();
});

test("API：/api/projects/:id/watchdog 汇总停滞与待决策", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0 }) };
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "B", status: "todo" });
  store.associateRequirementTask(item.id, a.id);
  store.associateRequirementTask(item.id, b.id);
  store.startTaskExecution(a.identifier, { sessionId: "s1" });
  store.startTaskExecution(b.identifier, { sessionId: "s1" });
  store.addComment(b.id, { body: "下一步：\n- 做 B1" });
  const router = createApiRouter({ store });
  const res = await router.route({ method: "GET", pathname: "/api/projects/p1/watchdog", searchParams: new URLSearchParams() });
  // A 刚开工、无进展评论 → 阈值内 idle（不算停滞，不误报）；B 有"下一步" → 待决策
  assert.equal(res.payload.count, 1);
  assert.equal(res.payload.awaitingDecision, 1);
  assert.equal(res.payload.stalled, 0);
  assert.equal(res.payload.tasks[0].identifier, b.identifier);
  store.close();
});

test("projectWatchdog：超过阈值后 A 转为 stalled，且停滞排在待决策之前", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.hostSessionPort = { sessionState: () => ({ sessionId: "s1", live: true, running: false, status: "idle", pending: 0 }) };
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "B", status: "todo" });
  store.associateRequirementTask(item.id, a.id);
  store.associateRequirementTask(item.id, b.id);
  store.startTaskExecution(a.identifier, { sessionId: "s1" });
  store.startTaskExecution(b.identifier, { sessionId: "s1" });
  store.addComment(b.id, { body: "下一步：\n- 做 B1" });
  const rows = projectWatchdog(store, "p1", { now: Date.now() + 30 * 60000 }); // 30 分钟后
  assert.deepEqual(rows.map((r) => [r.identifier, r.state]), [[a.identifier, "stalled"], [b.identifier, "awaiting-decision"]]);
  store.close();
});
