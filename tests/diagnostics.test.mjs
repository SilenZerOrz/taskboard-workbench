/** FR-79：可操作诊断框架（规则集 / 计数与自动消解 / 卡片摘要 / API / 忽略留痕）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import {
  DIAGNOSTIC_KINDS, DIAGNOSTIC_RULES, buildDiagnostics, dismissedKinds,
  evaluateTaskDiagnostics, projectDiagnostics, summarizeDiagnostics,
} from "../src/core/diagnostics.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

/** 每个诊断都必须"有恢复动作，且标出首选" —— FR-79 的硬验收。 */
function assertActionable(list, label = "") {
  assert.ok(list.length > 0, `${label} 应至少产出一条诊断`);
  for (const d of list) {
    assert.ok(DIAGNOSTIC_KINDS.includes(d.kind), `${label} kind 必须是约定类型：${d.kind}`);
    assert.ok(["high", "medium", "low"].includes(d.severity), `${label} severity 非法：${d.severity}`);
    assert.ok(d.title && d.detail, `${label} 需要标题与说明`);
    assert.ok(Array.isArray(d.actions) && d.actions.length >= 1, `${label} 每条诊断至少一个恢复动作`);
    assert.ok(d.actions.some((a) => a.kind === "primary"), `${label} 需标注首选动作`);
    assert.ok(d.suggested, `${label} 需给出 suggested`);
  }
}

test("规则集覆盖 FR-79 点名的八类诊断，且每类都有对应规则", () => {
  const kinds = new Set(DIAGNOSTIC_RULES.map((r) => r.kind));
  for (const k of DIAGNOSTIC_KINDS) assert.ok(kinds.has(k), `缺少规则：${k}`);
});

test("stalled：进行中 + 无进展回报 → 高危诊断 + 可操作动作", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "进度：做了一半" });
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: { stallMs: 0, blockedMs: 60 * 60 * 1000, recurrenceLimit: 2 } });
  const d = r.diagnostics.find((x) => x.kind === "stalled");
  assertActionable([d], "stalled");
  assert.equal(d.severity, "high");
  assert.equal(d.suggested, "retry");
  assert.equal(d.count, 1);
  store.close();
});

test("unclaimed：进行中但无有效认领且会话不在跑 → 提示无人认领，首选回收", () => {
  const { store, t } = setup();
  const r = evaluateTaskDiagnostics(store, t.identifier);
  const d = r.diagnostics.find((x) => x.kind === "unclaimed");
  assertActionable([d], "unclaimed");
  assert.equal(d.actions.find((a) => a.kind === "primary").id, "reclaim");
  // 认领并保持新鲜 → 诊断消失（自动消解）
  store.claimTask(t.identifier, { sessionId: "s1" });
  const after = evaluateTaskDiagnostics(store, t.identifier);
  assert.equal(after.diagnostics.some((x) => x.kind === "unclaimed"), false);
  assert.ok(after.resolved.some((x) => x.kind === "unclaimed"), "问题消失应自动消解");
  store.close();
});

test("repeated_failure：连续失败达阈值 → 熔断诊断；配额类改写标题", () => {
  const { store, t } = setup();
  store.recordTaskFailure(t.identifier, { error: "boom" });
  store.recordTaskFailure(t.identifier, { error: "boom again" });
  let d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "repeated_failure");
  assertActionable([d], "repeated_failure");
  assert.equal(d.actions.find((a) => a.kind === "primary").id, "reset_failures");
  assert.match(d.title, /连续失败 2\/2/);

  const { store: s2, t: t2 } = setup();
  s2.recordTaskFailure(t2.identifier, { error: "429 rate limit exceeded" });
  s2.recordTaskFailure(t2.identifier, { error: "429 rate limit exceeded" });
  d = evaluateTaskDiagnostics(s2, t2.identifier).diagnostics.find((x) => x.kind === "repeated_failure");
  assert.match(d.title, /配额\/鉴权类失败/);
  s2.close();
  store.close();
});

test("repeated_crash：多次尝试以崩溃/超时收场 → 崩溃诊断（有会话则首选看日志，无会话改产重建动作）", () => {
  const { store, t } = setup();
  const runs = [{ outcome: "crash", summary: "SIGKILL" }, { outcome: "timeout", summary: "120s 超时" }];
  const r = evaluateTaskDiagnostics(store, t.identifier, { runs });
  const d = r.diagnostics.find((x) => x.kind === "repeated_crash");
  assertActionable([d], "repeated_crash");
  // 该任务既无执行会话、项目也无主会话 → FR-84 不产出「打开执行会话」，改产「重建并绑定主会话」
  assert.equal(d.actions.find((a) => a.kind === "primary").id, "bind_session");
  assert.equal(d.suggested, "bind_session");
  assert.match(d.detail, /2 次尝试/);
  store.close();
});

test("stuck_blocked：卡在受阻超阈值 → 诊断（转人工兜底则升级为高危）", () => {
  const { store, t } = setup();
  store.blockTask(t.identifier, { kind: "needs_input", reason: "等人给料" });
  const tight = { stallMs: 10 * 60 * 1000, blockedMs: 0, recurrenceLimit: 2 };
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: tight });
  const d = r.diagnostics.find((x) => x.kind === "stuck_blocked");
  assertActionable([d], "stuck_blocked");
  assert.equal(d.severity, "medium");
  // 未达阈值（默认 1h）不产出 —— 避免把正常等待误报成卡住
  const calm = evaluateTaskDiagnostics(store, t.identifier);
  assert.equal(calm.diagnostics.some((x) => x.kind === "stuck_blocked"), false);
  store.close();
});

test("block_loop：同因重复阻断升级人工兜底 → 高危「阻断循环」诊断", () => {
  const { store, t } = setup();
  // FR-80：同因阻断第二次即升级「人工兜底」→ 正是"阻断循环"诊断的判据
  store.blockTask(t.identifier, { kind: "transient", reason: "挂" });
  store.blockTask(t.identifier, { kind: "transient", reason: "又挂" });
  const d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "block_loop");
  assertActionable([d], "block_loop");
  assert.equal(d.severity, "high");
  assert.match(d.title, /同因阻断 2 次/);
  store.close();
});

test("awaiting_decision：执行侧留下「下一步」→ 待决策诊断（派生 / 忽略 / 开会话）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "【反馈】进度：跑完一半\n下一步：\n- 收窄到 ≤1390px" });
  const d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "awaiting_decision");
  assertActionable([d], "awaiting_decision");
  assert.equal(d.severity, "medium");
  assert.equal(d.actions.find((a) => a.kind === "primary").needs, "title", "派生需要标题（UI 用建议内容预填）");
  assert.match(d.detail, /收窄到 ≤1390px/);
  store.close();
});

test("review_deadlock：评审链死锁 → 高危诊断（完成仍需人确认）", () => {
  const { store, t } = setup();
  const r = evaluateTaskDiagnostics(store, t.identifier, { review: { deadlocked: true, reason: "评审者不可用" } });
  const d = r.diagnostics.find((x) => x.kind === "review_deadlock");
  assertActionable([d], "review_deadlock");
  assert.match(d.detail, /评审者不可用/);
  store.close();
});

test("计数与消解：同一问题持续 → count 递增且只留一行；问题消失 → 自动消解", () => {
  const { store, t } = setup();
  const now = Date.now();
  const first = evaluateTaskDiagnostics(store, t.identifier, { now });
  assert.equal(first.diagnostics.find((x) => x.kind === "unclaimed").count, 1);
  // 阈值内重复评估：只刷新、不刷屏、计数不加
  const second = evaluateTaskDiagnostics(store, t.identifier, { now: now + 1000 });
  assert.equal(second.diagnostics.filter((x) => x.kind === "unclaimed").length, 1, "同一问题只留一条");
  assert.equal(second.diagnostics.find((x) => x.kind === "unclaimed").count, 1, "同一分钟内的轮询不加计数");
  // 超过合并窗口 → 计为"再次出现"
  const third = evaluateTaskDiagnostics(store, t.identifier, { now: now + 5 * 60 * 1000 });
  const row = third.diagnostics.find((x) => x.kind === "unclaimed");
  assert.equal(row.count, 2);
  assert.ok(new Date(row.lastSeenAt) > new Date(row.firstSeenAt));
  assert.equal(store.listTaskDiagnostics(t.identifier).length, 1, "库里只有一行");

  // 收尾任务 → 诊断自动消解，历史仍可回溯
  store.submitTaskForReview(t.identifier, { comment: "完成，待验收" });
  const cleared = evaluateTaskDiagnostics(store, t.identifier, { now: now + 6 * 60 * 1000 });
  assert.equal(cleared.diagnostics.length, 0);
  assert.ok(cleared.resolved.some((x) => x.kind === "unclaimed"));
  assert.equal(store.listTaskDiagnostics(t.identifier).length, 0);
  assert.equal(store.listTaskDiagnostics(t.identifier, { includeResolved: true }).length, 1);
  store.close();
});

test("忽略留痕：dismissedKinds 只在忽略晚于最近进展时生效；出现更新的进展即复活", () => {
  const base = [{ body: "【反馈】进度：一半", createdAt: "2026-10-17T10:00:00.000Z" }];
  const before = [...base, { body: "已忽略诊断「awaiting_decision」：待决策（人工决策）", createdAt: "2026-10-17T09:00:00.000Z" }];
  assert.equal(dismissedKinds(before).has("awaiting_decision"), false, "忽略早于进展 → 不生效");
  const after = [...base, { body: "已忽略诊断「awaiting_decision」：待决策（人工决策）", createdAt: "2026-10-17T11:00:00.000Z" }];
  assert.equal(dismissedKinds(after).has("awaiting_decision"), true);
  const revived = [...after, { body: "【反馈】进度：又跑了一轮\n下一步：\n- 再试一次", createdAt: "2026-10-17T12:00:00.000Z" }];
  assert.equal(dismissedKinds(revived).has("awaiting_decision"), false, "更新的进展评论使诊断复活");
});

test("忽略一条诊断：写留痕评论 + 立即消解（原文可回溯）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "【反馈】进度：一半\n下一步：\n- 收窄到 ≤1390px" });
  evaluateTaskDiagnostics(store, t.identifier);
  const r = store.dismissTaskDiagnostic(t.identifier, "awaiting_decision");
  assert.equal(r.dismissed, true);
  assert.equal(r.hadRecord, true);
  const after = evaluateTaskDiagnostics(store, t.identifier);
  assert.equal(after.diagnostics.some((x) => x.kind === "awaiting_decision"), false);
  const comment = store.listComments(t.id).at(-1);
  assert.match(comment.body, /已忽略诊断「awaiting_decision」/);
  store.close();
});

test("卡片摘要：只给 {count, kinds, highestSeverity}", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "【反馈】进度：一半\n下一步：\n- 收窄" });
  const r = evaluateTaskDiagnostics(store, t.identifier);
  const summary = summarizeDiagnostics(r.diagnostics);
  assert.deepEqual(Object.keys(summary).sort(), ["count", "highestSeverity", "kinds"]);
  assert.equal(summary.count, r.diagnostics.length);
  assert.equal(summary.highestSeverity, "high", "unclaimed 是高危 → 摘要取最高");
  assert.ok(summary.kinds.includes("awaiting_decision"));
  assert.equal(summarizeDiagnostics([]), null);
  store.close();
});

test("buildDiagnostics 是纯函数：入参不变则结果稳定（不依赖 store）", () => {
  const ctx = {
    task: { identifier: "p1-1", status: "in_progress", blockKind: null, blockRecurrences: 0, triageAt: null, blockedAt: null, consecutiveFailures: 0 },
    watchdog: { state: "stalled", minutes: 42, reason: "session-idle" },
    claim: { locked: false, expired: false },
    sessionState: { running: false, live: false },
    failures: { consecutive: 0, limit: 2, limitSource: "default" },
    runs: [], review: null, now: Date.now(),
    thresholds: { stallMs: 0, blockedMs: 60 * 60 * 1000, recurrenceLimit: 2 },
    dismissed: new Set(),
  };
  const a = buildDiagnostics(ctx);
  const b = buildDiagnostics(ctx);
  assert.deepEqual(a.map((d) => d.kind), b.map((d) => d.kind));
  assert.deepEqual(a.map((d) => d.kind), ["stalled", "unclaimed"]);
});

test("API：/api/tasks/:ref/diagnostics 一次取回完整列表；dismiss 校验 kind", async () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "【反馈】进度：一半\n下一步：\n- 收窄到 ≤1390px" });
  const router = createApiRouter({ store });
  const res = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/diagnostics`, searchParams: new URLSearchParams() });
  assert.equal(res.status, 200);
  assert.equal(res.payload.count, res.payload.diagnostics.length);
  assert.ok(res.payload.summary.count >= 1);
  assertActionable(res.payload.diagnostics, "API/diagnostics");
  // FR-84：动作既可能是任务级（/api/tasks/…），也可能是项目级（无可解析会话时的
  // 「重建并绑定主会话」→ /api/projects/:id/sessions/rebind）。
  assert.ok(res.payload.diagnostics[0].actions.every((a) => typeof a.path === "string" && a.path.startsWith("/api/")));

  await assert.rejects(
    () => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/diagnostics/dismiss`, searchParams: new URLSearchParams(), body: { kind: "nope" } }),
    (e) => e.code === "INVALID_FIELD",
  );
  await assert.rejects(
    () => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/diagnostics/dismiss`, searchParams: new URLSearchParams(), body: {} }),
    (e) => e.code === "INVALID_FIELD",
  );
  const ok = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/diagnostics/dismiss`, searchParams: new URLSearchParams(), body: { kind: "awaiting_decision" } });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.dismissed, true);
  assert.equal(ok.payload.diagnostics.some((d) => d.kind === "awaiting_decision"), false, "忽略后该类型不再产出");
  assert.ok(ok.payload.summary && !ok.payload.summary.kinds.includes("awaiting_decision"));
  store.close();
});

test("API：项目级诊断汇总 + 看板列表带卡片摘要", async () => {
  const { store, t } = setup();
  store.blockTask(t.identifier, { kind: "transient", reason: "挂了" });
  store.blockTask(t.identifier, { kind: "transient", reason: "又挂" });
  store.recordTaskFailure(t.identifier, { error: "挂了" });
  const router = createApiRouter({ store });

  const project = await router.route({ method: "GET", pathname: "/api/projects/p1/diagnostics", searchParams: new URLSearchParams() });
  assert.equal(project.status, 200);
  assert.equal(project.payload.count, project.payload.diagnostics.length);
  assert.ok(project.payload.summary.bySeverity.high >= 1);
  assert.ok(project.payload.summary.byKind.block_loop >= 1);

  const list = await router.route({ method: "GET", pathname: "/api/tasks", searchParams: new URLSearchParams({ project: "p1", withWatchdog: "1" }) });
  const card = list.payload.tasks.find((x) => x.identifier === t.identifier);
  assert.deepEqual(Object.keys(card.diagnostics).sort(), ["count", "highestSeverity", "kinds"]);
  assert.ok(card.diagnostics.count >= 1);

  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.ok(Array.isArray(exec.payload.diagnostics));
  assert.equal(exec.payload.diagnosticSummary.count, exec.payload.diagnostics.length);
  store.close();
});

test("projectDiagnostics：只看进行中 / 受阻 / 待验收，且结果按严重度排序", () => {
  const { store, t } = setup();
  const done = store.createTask({ projectId: "p1", title: "Done", status: "done" });
  store.blockTask(t.identifier, { kind: "needs_input", reason: "等人" });
  const { rows, summary } = projectDiagnostics(store, "p1", { thresholds: { stallMs: 0, blockedMs: 0, recurrenceLimit: 2 } });
  assert.ok(rows.every((r) => r.identifier !== done.identifier), "已完成任务不该出现在诊断里");
  assert.equal(summary.total, rows.length);
  const rank = { high: 3, medium: 2, low: 1 };
  for (let i = 1; i < rows.length; i += 1) assert.ok(rank[rows[i - 1].severity] >= rank[rows[i].severity], "按严重度降序");
  store.close();
});
