/** 「下一步」引导（deriveNextStep）：逐分支口径 + 优先级（人工校验门 > 评审 > 其它状态）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { deriveNextStep, NEXT_STEP_CODES } from "../src/core/next-step.mjs";

const ids = (r) => r.actions.map((a) => a.id);
const assertShape = (r) => {
  assert.ok(NEXT_STEP_CODES.includes(r.code), `未知引导码 ${r.code}`);
  assert.equal(typeof r.title, "string");
  assert.ok(r.title.length > 0, "title 不得为空");
  assert.equal(typeof r.hint, "string");
  assert.ok(Array.isArray(r.actions));
  for (const a of r.actions) {
    assert.equal(typeof a.id, "string");
    assert.ok(a.label.length > 0);
    assert.ok(["primary", "default", "danger"].includes(a.kind), `未知按钮语义 ${a.kind}`);
  }
  assert.ok(r.actions.filter((a) => a.kind === "primary").length <= 1, "最多一个主按钮");
  // FR-89：引导还要回答「只该动哪一处」（focus，供前端默认折叠）与「按什么顺序做」（steps）。
  assert.ok(r.focus === null || Array.isArray(r.focus), "focus 必须是字符串数组或 null");
  if (r.focus) for (const k of r.focus) assert.equal(typeof k, "string");
  assert.ok(Array.isArray(r.steps), "steps 必须是数组");
  for (const s of r.steps) assert.ok(typeof s === "string" && s.length > 0, "步骤文案不得为空");
};

test("人工校验卡待结论：唯一出口是下结论", () => {
  const r = deriveNextStep({ status: "backlog", labels: ["FR-85", "human_review"], humanReviewState: "pending" });
  assertShape(r);
  assert.equal(r.code, "human-review-pending");
  assert.deepEqual(ids(r), ["conclude-human-review"]);
  assert.equal(r.actions[0].kind, "primary");
});

test("人工校验卡已结论：不再按人环门拦（回落按状态推导）", () => {
  const r = deriveNextStep({ status: "canceled", labels: ["human_review"], humanReviewState: "concluded", humanReviewConclusion: "continue" });
  assertShape(r);
  assert.equal(r.code, "canceled");
  assert.deepEqual(r.actions, []);
});

test("被人工校验门挡住：先说清被谁挡，并给直达入口（这是 -116 真机那次卡住的情形）", () => {
  const r = deriveNextStep(
    { status: "in_review", reviewState: "pending", requirementId: "4-0209cddcb5c4" },
    { humanReviewBlocker: { identifier: "taskboard-workbench-117", title: "【人工校验】与上游需求不符", category: "upstream-mismatch" } },
  );
  assertShape(r);
  assert.equal(r.code, "blocked-by-human-review");
  assert.deepEqual(ids(r), ["open-blocker", "goto-deps"]);
  assert.equal(r.actions[0].kind, "primary");
  assert.match(r.actions[0].label, /taskboard-workbench-117/);
  assert.match(r.hint, /upstream-mismatch/);
  assert.equal(r.blocker.identifier, "taskboard-workbench-117");
});

test("人环门优先级高于评审态：即使已评审通过也先解门", () => {
  const r = deriveNextStep(
    { status: "in_review", reviewState: "approved" },
    { humanReviewBlocker: { identifier: "taskboard-workbench-200" } },
  );
  assert.equal(r.code, "blocked-by-human-review");
});

test("已收口的卡不再受前置门影响", () => {
  const r = deriveNextStep({ status: "done" }, { humanReviewBlocker: { identifier: "taskboard-workbench-117" } });
  assert.equal(r.code, "done");
  assert.equal(r.blocker, null);
});

test("待验收 + 评审通过：只差人工点完成", () => {
  const r = deriveNextStep({ status: "in_review", reviewState: "approved" });
  assertShape(r);
  assert.equal(r.code, "awaiting-human-done");
  assert.deepEqual(ids(r), ["complete"]);
  assert.match(r.hint, /完成只能由人确认/);
});

test("待验收 + 待评审：给通过入口，返工走填说明（不给一键返工，避免绕过必填说明）", () => {
  const r = deriveNextStep({ status: "in_review", reviewState: "pending", reviewer: null });
  assertShape(r);
  assert.equal(r.code, "review-pending");
  assert.deepEqual(ids(r), ["review-approve", "goto-review"]);
  assert.doesNotMatch(ids(r).join(","), /review-changes/);
  assert.match(r.hint, /评审死锁/);
});

test("待验收 + 返工中：去评审区块按说明返工", () => {
  const r = deriveNextStep({ status: "in_review", reviewState: "changes_requested", reviewRound: 2, reviewSourceStatus: "in_progress" });
  assertShape(r);
  assert.equal(r.code, "rework");
  assert.deepEqual(ids(r), ["goto-review"]);
  assert.match(r.hint, /第 2 轮/);
});

test("待验收 + 无评审态：仍按待评审引导（不臆断已评审）", () => {
  const r = deriveNextStep({ status: "in_review", reviewState: null });
  assert.equal(r.code, "review-pending");
});

test("受阻：先重试，并可看诊断（已归因 → 另给两个调试出口，FR-97）", () => {
  const r = deriveNextStep({ status: "blocked", requirementId: "r-1", blockKind: "transient", blockRecurrences: 3, triageAt: "2026-10-22T00:00:00.000Z" });
  assertShape(r);
  assert.equal(r.code, "blocked");
  // FR-97：受阻且**已归因**的卡，除重试/看诊断外，还给「交主会话执行」「转为执行调试」两个出口。
  assert.deepEqual(ids(r), ["retry", "dispatch-main-session", "to-debug", "goto-diagnostics"]);
  assert.match(r.hint, /同因复发 3 次/);
  assert.match(r.hint, /人工兜底/);
});

test("FR-97 受阻且未归因：先归因，不给调试出口", () => {
  const r = deriveNextStep({ status: "blocked", blockKind: "transient" });
  assertShape(r);
  assert.equal(r.code, "blocked-no-attribution");
  assert.deepEqual(ids(r), ["goto-attribution", "goto-diagnostics"]);
  assert.ok(!ids(r).includes("dispatch-main-session"), "未归因时交主会话也走不通，不给该出口");
  assert.ok(!ids(r).includes("to-debug"), "未归因时先归因，不给转调试出口");
});

test("待办池：先授权开工", () => {
  const r = deriveNextStep({ status: "backlog", requirementId: "6-1f4d88abd86c" });
  assertShape(r);
  assert.equal(r.code, "backlog");
  assert.deepEqual(ids(r), ["authorize"]);
});

// 2026-10-22（第十报）：门序列是「归因门 → 授权门」（store.assertExecutable）⇒ 未归因的待办池卡
// 先给「去归因」；否则「先授权 → 再启动执行」会在可开工被归因门拒，同一句报错再来一次。
test("待办池且未归因：先归因，再授权开工（归因门在授权门之前）", () => {
  const r = deriveNextStep({ status: "backlog", requirementId: null });
  assertShape(r);
  assert.equal(r.code, "backlog-no-attribution");
  assert.deepEqual(ids(r), ["goto-attribution"]);
  assert.deepEqual(r.focus, ["归因"]);
  assert.match(r.hint, /EXECUTION_NOT_ATTRIBUTED/);
});

test("可开工但未归因：先去归因（否则被归因门拦下）", () => {
  const r = deriveNextStep({ status: "todo", requirementId: null });
  assertShape(r);
  assert.equal(r.code, "todo-no-attribution");
  assert.deepEqual(ids(r), ["goto-attribution"]);
  assert.match(r.hint, /EXECUTION_NOT_ATTRIBUTED/);
});

test("可开工且已归因：启动执行", () => {
  const r = deriveNextStep({ status: "todo", requirementId: "6-1f4d88abd86c" });
  assertShape(r);
  assert.equal(r.code, "todo");
  assert.deepEqual(ids(r), ["start-execution"]);
});

test("进行中：看会话或退回待办；停滞时给出停滞引导", () => {
  const normal = deriveNextStep({ status: "in_progress" });
  assert.equal(normal.code, "in-progress");
  assertShape(normal);
  const stalled = deriveNextStep({ status: "in_progress" }, { stalled: true });
  assert.equal(stalled.code, "in-progress-stalled");
  assert.match(stalled.title, /停滞/);
  assert.deepEqual(ids(stalled), ["open-session", "retry"]);
});

test("看护读数判停滞（watchdog.state≠ok）也走停滞分支", () => {
  const r = deriveNextStep({ status: "in_progress", watchdog: { state: "stalled" } });
  assert.equal(r.code, "in-progress-stalled");
});

test("取消 / 未知状态：无可执行动作，不抛错", () => {
  const canceled = deriveNextStep({ status: "canceled" });
  assertShape(canceled);
  assert.deepEqual(canceled.actions, []);
  const unknown = deriveNextStep({ status: "" });
  assertShape(unknown);
  assert.equal(unknown.code, "unknown");
  const nul = deriveNextStep(null);
  assertShape(nul);
  assert.equal(nul.code, "unknown");
});

test("所有分支都不返回重复的 action id（前端按钮去重的前提）", () => {
  const cases = [
    { status: "in_review", reviewState: "approved" },
    { status: "in_review", reviewState: "pending" },
    { status: "in_review", reviewState: "changes_requested" },
    { status: "blocked" },
    { status: "backlog" },
    { status: "todo" },
    { status: "todo", requirementId: "x" },
    { status: "in_progress" },
    { status: "done" },
  ];
  for (const c of cases) {
    const r = deriveNextStep(c);
    assert.equal(new Set(ids(r)).size, ids(r).length, `重复 action id：${r.code}`);
  }
});

test("FR-89 focus/steps：收口卡不摆处置按钮（只默认展开「操作」），也不给操作顺序", () => {
  for (const status of ["done", "canceled"]) {
    const r = deriveNextStep({ status });
    assertShape(r);
    assert.deepEqual(r.steps, [], `${status} 已收口，不需要 1-2-3`);
    assert.deepEqual(r.focus, ["操作"], `${status} 只默认展开「操作」（编辑等），评审/人工校验/执行会话收起`);
  }
});

test("FR-89 focus/steps：异常态给出 1-2-3 顺序，且只展开该动的那个区块", () => {
  const gated = deriveNextStep(
    { status: "in_review", reviewState: "pending" },
    { humanReviewBlocker: { identifier: "x-1", category: "upstream-mismatch" } },
  );
  assert.equal(gated.code, "blocked-by-human-review");
  assert.deepEqual(gated.focus, ["人工校验"], "被人工校验门挡住时先展开「人工校验」，不是「评审」");
  assert.ok(gated.steps.length >= 2, "被挡住必须给按顺序的出路");

  const noAttr = deriveNextStep({ status: "todo" });
  assert.equal(noAttr.code, "todo-no-attribution");
  assert.deepEqual(noAttr.focus, ["归因"]);

  const blocked = deriveNextStep({ status: "blocked", requirementId: "r-1" });
  assert.equal(blocked.code, "blocked");
  assert.deepEqual(blocked.focus, ["诊断与恢复动作"], "受阻时先看诊断，不是先去点重试");
  assert.ok(blocked.steps.length >= 2);

  const rework = deriveNextStep({ status: "in_review", reviewState: "changes_requested" });
  assert.equal(rework.code, "rework");
  assert.deepEqual(rework.focus, ["评审"]);
  assert.ok(rework.steps.length >= 2);

  const humanCard = deriveNextStep({ status: "backlog", labels: ["human_review"], humanReviewState: "pending" });
  assert.equal(humanCard.code, "human-review-pending");
  assert.deepEqual(humanCard.focus, ["人工校验"]);
  assert.equal(humanCard.steps.length, 3, "人工校验卡必须给完整三步（读证据 → 填说明 → 三选一）");
});

test("FR-89 focus：状态未识别时不干预界面（focus=null ⇒ 前端不按猜测折叠）", () => {
  const r = deriveNextStep({ status: "" });
  assert.equal(r.code, "unknown");
  assert.equal(r.focus, null);
  assert.deepEqual(r.steps, []);
});
