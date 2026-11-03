/**
 * 0-A1（卡 `-196` · FR-108）：`ticketStage()` 单一口径。
 *
 * 钉四件事：
 *   1. **七状态 × 评审态 × 证据/判定** 的完整对照表（fixture 逐条比对，不靠"跑一遍看看"）
 *   2. **`format_ok` ≠ `ready`** —— 四字段齐全但无 LLM 判定，只能到 format_ok（GWT-2）
 *   3. **判过又变 = `stale`** —— evidence_id 或 task_version 与当前不符，不得显示 ready（GWT-3）
 *   4. **四套旧口径同批一致** —— 同一 fixture 下，`next-step` / `watchdog` / `verify` / `diagnostics` 的读数
 *      与本函数给出的读数一致（GWT-1）；且 `awaiting_review_request` 先于其他分支（GWT-4）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ticketStage, deriveDelivery, TICKET_STAGES } from "../src/core/ticket-stage.mjs";
import { deriveNextStep } from "../src/core/next-step.mjs";
import { assessTask } from "../src/core/watchdog.mjs";
import { formatVerifyComment } from "../src/core/verify.mjs";

const NOW = Date.parse("2026-11-03T12:00:00.000Z");

/** 造一张卡：默认最小字段，按需覆盖。 */
function card(over = {}) {
  return { status: "in_progress", version: 3, labels: [], reviewState: null, reviewRequestedAt: null, requirementId: "req-1", updatedAt: new Date(NOW).toISOString(), ...over };
}
/** 造一条"四字段齐全"的证据行（形状对齐 store 的 task_evidence）。 */
function evidence(over = {}) {
  return { id: "ev-1", taskVersion: 3, verdict: "判定", deviation: "无", boundary: "未碰 :3080", artifacts: ["docs/a.md"], artifactRefs: [], refsState: "unchecked", ...over };
}
const READY_DECISION = Object.freeze({ layer: "llm", decision: "ready", evidenceId: "ev-1", taskVersion: 3 });

test("A 七状态基线：无证据时阶段 = 状态本身（done/canceled 为终态）", () => {
  const cases = [
    ["backlog", "backlog"],
    ["todo", "todo"],
    ["in_progress", "in_progress"],
    ["blocked", "blocked"],
    ["done", "done"],
    ["canceled", "canceled"],
  ];
  for (const [status, expected] of cases) {
    assert.equal(ticketStage(card({ status }), { now: NOW }).stage, expected, `${status} ⇒ ${expected}`);
  }
  // in_review 单独：从未发起评审 ⇒ awaiting_review_request（不是 review_pending）
  assert.equal(ticketStage(card({ status: "in_review" }), { now: NOW }).stage, "awaiting_review_request");
});

test("B 评审流程态：发起后按 review_state 分流", () => {
  const at = new Date(NOW).toISOString();
  assert.equal(ticketStage(card({ status: "in_review", reviewRequestedAt: at }), { now: NOW }).stage, "review_pending");
  assert.equal(ticketStage(card({ status: "in_review", reviewRequestedAt: at, reviewState: "pending" }), { now: NOW }).stage, "review_pending");
  assert.equal(ticketStage(card({ status: "in_review", reviewRequestedAt: at, reviewState: "changes_requested" }), { now: NOW }).stage, "rework");
  assert.equal(ticketStage(card({ status: "in_review", reviewRequestedAt: at, reviewState: "approved" }), { now: NOW }).stage, "awaiting_human_done");
});

test("C 人工校验门：卡自己待结论 / 被别人的门挡住", () => {
  const hr = card({ labels: ["human_review"], humanReviewState: "pending" });
  assert.equal(ticketStage(hr, { now: NOW }).stage, "human_review_pending");
  // 结论给出后不再算待结论
  assert.equal(ticketStage({ ...hr, humanReviewState: "concluded" }, { now: NOW }).stage, "in_progress");
  const blocked = card({ status: "blocked" });
  assert.equal(ticketStage(blocked, { now: NOW, humanReviewBlocker: { identifier: "taskboard-workbench-9" } }).stage, "blocked_by_human_review");
});

test("D GWT-2：四字段齐全但无 LLM 判定 ⇒ format_ok，绝不是 ready", () => {
  const r = ticketStage(card(), { now: NOW, evidence: evidence() });
  assert.equal(r.stage, "format_ok");
  assert.equal(r.delivery.state, "format_ok");
  // 规则层判定不能冒充内容判定
  const ruleDecision = { layer: "rule", decision: "ready", evidenceId: "ev-1", taskVersion: 3 };
  assert.equal(ticketStage(card(), { now: NOW, evidence: evidence(), decision: ruleDecision }).stage, "format_ok", "rule 层判定不算内容已判");
  // 判定层说 needs_changes ⇒ 不是 ready
  const nc = { layer: "llm", decision: "needs_changes", evidenceId: "ev-1", taskVersion: 3 };
  assert.equal(ticketStage(card(), { now: NOW, evidence: evidence(), decision: nc }).stage, "in_progress", "判过但没判成 ready ⇒ 回到流程态，由人看理由");
});

test("E GWT-3：判过又变 ⇒ stale（证据换了 / 版本涨了）", () => {
  const evMismatch = ticketStage(card(), { now: NOW, evidence: evidence({ id: "ev-2" }), decision: READY_DECISION });
  assert.equal(evMismatch.stage, "stale");
  assert.match(evMismatch.reason, /证据/);

  const verMismatch = ticketStage(card({ version: 4 }), { now: NOW, evidence: evidence(), decision: READY_DECISION });
  assert.equal(verMismatch.stage, "stale");
  assert.match(verMismatch.reason, /版本/);

  const ok = ticketStage(card(), { now: NOW, evidence: evidence(), decision: READY_DECISION });
  assert.equal(ok.stage, "ready");
});

test("F GWT-4 + 安全优先级：未发起评审先于一切；stale 前置于「只差点完成」", () => {
  // 未发起评审，即使证据/判定都齐，也先说「去发起评审」
  const never = ticketStage(card({ status: "in_review" }), { now: NOW, evidence: evidence(), decision: READY_DECISION });
  assert.equal(never.stage, "awaiting_review_request");

  // 已评审通过但证据已变 ⇒ 必须 stale，不能是 awaiting_human_done（否则人确认的是没见过的那版）
  const at = new Date(NOW).toISOString();
  const stale = ticketStage(card({ status: "in_review", reviewRequestedAt: at, reviewState: "approved", version: 4 }), { now: NOW, evidence: evidence(), decision: READY_DECISION });
  assert.equal(stale.stage, "stale");
});

test("G refs 解不开 / 证据不全：都不进 format_ok", () => {
  assert.equal(ticketStage(card(), { now: NOW, evidence: evidence({ refsState: "unresolved" }) }).stage, "refs_unresolved");
  assert.equal(ticketStage(card(), { now: NOW, evidence: evidence({ artifacts: [] }) }).stage, "in_progress", "四字段不全 ⇒ 退回流程态，不是 format_ok");
  assert.equal(deriveDelivery({ task: card(), evidence: null, decision: null }).state, "none");
});

test("H GWT-1 四口径同批一致：同一 fixture 下 next-step / watchdog / verify / diagnostics 读数对齐", () => {
  const autoReviewBody = formatVerifyComment({ command: "npm test", exitCode: 0, durationMs: 1234, summary: "960/0" });
  const comments = [
    { id: "c1", body: "执行中：写测试", createdAt: new Date(NOW - 60_000).toISOString() },
    { id: "c2", body: autoReviewBody, createdAt: new Date(NOW - 30_000).toISOString() },
  ];

  const fixtures = [
    // 会话可判且仍在跑 ⇒ running（watchdog 只认会话状态，不认"刚有评论"）
    { name: "进行中（会话在跑）", task: card(), ctx: { comments, now: NOW, sessionState: { sessionId: "sess-1", live: true, running: true } }, expectStage: "in_progress", expectNext: "in-progress", expectWatch: "running", expectVerify: "通过" },
    // 无会话信号（如 CLI 执行器路径 sessionId 恒 null）且无在途尝试 ⇒ idle，不是 running
    { name: "进行中（会话未知）", task: card(), ctx: { comments, now: NOW }, expectStage: "in_progress", expectNext: "in-progress", expectWatch: "idle", expectVerify: "通过" },
    { name: "进行中（停滞）", task: card({ updatedAt: new Date(NOW - 30 * 60_000).toISOString() }), ctx: { comments: [], now: NOW }, expectStage: "in_progress", expectNext: "in-progress-stalled", expectWatch: "stalled" },
    { name: "待验收未发起", task: card({ status: "in_review" }), ctx: { now: NOW }, expectStage: "awaiting_review_request", expectNext: "review-pending", expectWatch: "ok" },
    { name: "评审待办", task: card({ status: "in_review", reviewRequestedAt: new Date(NOW).toISOString() }), ctx: { now: NOW }, expectStage: "review_pending", expectNext: "review-pending", expectWatch: "ok" },
    { name: "评审通过", task: card({ status: "in_review", reviewRequestedAt: new Date(NOW).toISOString(), reviewState: "approved" }), ctx: { now: NOW }, expectStage: "awaiting_human_done", expectNext: "awaiting-human-done", expectWatch: "ok" },
    { name: "受阻未归因", task: card({ status: "blocked", requirementId: null }), ctx: { now: NOW }, expectStage: "blocked", expectNext: "blocked-no-attribution", expectWatch: "ok" },
    { name: "待办池", task: card({ status: "backlog" }), ctx: { now: NOW }, expectStage: "backlog", expectNext: "backlog", expectWatch: "ok" },
    { name: "完成", task: card({ status: "done" }), ctx: { now: NOW }, expectStage: "done", expectNext: "done", expectWatch: "ok" },
    { name: "取消", task: card({ status: "canceled" }), ctx: { now: NOW }, expectStage: "canceled", expectNext: "canceled", expectWatch: "ok" },
  ];

  for (const f of fixtures) {
    const got = ticketStage(f.task, f.ctx);
    assert.ok(TICKET_STAGES.includes(got.stage), `${f.name}: stage 必须在白名单内，实得 ${got.stage}`);
    assert.equal(got.stage, f.expectStage, `${f.name}: stage`);

    // ① next-step：同一入参独立跑一次，必须与本函数给出的 next 完全一致（防复制规则后漂移）
    // 先把 watchdog 独立跑一次（下一步的「停滞」由它推导，不是测试自己再判一次）
    const watch = assessTask({ task: f.task, comments: f.ctx.comments ?? [], sessionState: f.ctx.sessionState ?? null, currentRun: null, now: NOW });
    const next = deriveNextStep(f.task, { humanReviewBlocker: null, stalled: watch.state === "stalled" });
    assert.equal(got.next.code, next.code, `${f.name}: next-step 独立读数必须一致`);
    assert.equal(got.next.code, f.expectNext, `${f.name}: next-step 期望`);

    // ② watchdog：同一入参独立跑一次，state 必须一致
    assert.equal(got.watch.state, watch.state, `${f.name}: watchdog 独立读数必须一致`);
    assert.equal(got.watch.state, f.expectWatch, `${f.name}: watchdog 期望`);

    // ③ verify：有自动复核评论时，两处读到的结论必须是同一条
    assert.equal(got.verify?.verdict ?? null, f.expectVerify ?? null, `${f.name}: verify 结论`);
  }

  // ④ diagnostics：本层不重算，原样透传（0-A1 边界：不引入第二条诊断规则）
  const withDiag = ticketStage(card(), { now: NOW, diagnostics: ["stalled", "unclaimed"] });
  assert.deepEqual(withDiag.diagnostics, ["stalled", "unclaimed"]);
  assert.equal(withDiag.stage, "in_progress", "诊断不改变 stage（stage 只看流程/交付物）");
});
