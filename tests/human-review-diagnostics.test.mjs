/**
 * FR-85b-3：人在环升级门的三处接线 —— ①诊断规则 `human_review_required`
 * ②执行循环跳过人工校验任务 ③派发端点的三态（建卡 / 幂等 / 证据不足拒绝）与结论放行。
 *
 * 口径来源：FR-85「判不准就不升级」+「派发 human_review 后**停手等人**」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { DIAGNOSTIC_RULES, evaluateTaskDiagnostics, humanReviewProbe } from "../src/core/diagnostics.mjs";
import { runExecutionLoop } from "../src/core/loop.mjs";
import { HUMAN_REVIEW_LABEL, planHumanReview } from "../src/core/human-review.mjs";

test("回归（真机 2026-10-18）：humanReviewProbe 对真实失败尝试必须给出 kind=failure 证据", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const t = store.createTask({ projectId: "p1", title: "反复超时的任务", status: "todo" });
  store.recordTaskExecutionFailure(t.identifier, { evidence: "CLI 执行器超时（2s）", kind: "capability" });
  store.recordTaskExecutionFailure(t.identifier, { evidence: "CLI 执行器超时（2s）", kind: "capability" });
  const runs = [
    { id: "r1", attempt: 1, status: "ended", outcome: "timeout", summary: "CLI 执行器超时（2s）", error: "[claude-code:unrecognized_model]" },
    { id: "r2", attempt: 2, status: "ended", outcome: "timeout", summary: "CLI 执行器超时（2s）", error: "" },
  ];
  const probe = humanReviewProbe(store, store.requireTaskRef(t.identifier), runs);
  assert.equal(probe.classification.confident, true, "反复真实失败 → 必须能升级人工校验");
  assert.equal(probe.classification.category, "real-bug-blocked");
  assert.ok(probe.evidence.some((e) => e && e.kind === "failure"), "失败尝试必须带 kind=failure");
  store.close();
});

/* -------------------- FR-85 三类可达：显式申报（真机 2026-10-18 补） -------------------- */

test("FR-85：评论里的【显式申报】必须让「需求异化/架构变化/与上游不符」三类可达", () => {
  const { store } = setup();
  const cases = [
    ["需求异化", "requirement-drift"],
    ["架构变化", "architecture-change"],
    ["与上游需求不符", "upstream-mismatch"],
  ];
  const bad = [];
  for (const [label, category] of cases) {
    const t = store.createTask({ projectId: "p1", title: `申报：${label}`, status: "todo" });
    const c = store.addComment(t.identifier, { body: `【人工校验申报】类别=${label}；证据=与 R1 的验收口径相互矛盾。` });
    const probe = humanReviewProbe(store, store.requireTaskRef(t.identifier));
    // 一次性汇总三类结果：反证时能同时看到三类各自的状态，而不是在第一条就中断。
    if (!probe.classification.confident) bad.push(`${label}: 未升级（修复前恒 400）`);
    else if (probe.classification.category !== category) bad.push(`${label}: 判成了 ${probe.classification.category}`);
    if (!probe.evidence.some((e) => e && e.kind === category && e.ref === c.id)) bad.push(`${label}: 证据缺 kind/ref（不可回溯）`);
  }
  assert.deepEqual(bad, [], "三类都必须可达且证据可回溯");
  store.close();
});

test("FR-85 红线：评论**自由正文**（无申报标记）绝不触发升级门", () => {
  const { store } = setup();
  const t = store.createTask({ projectId: "p1", title: "纯散文评论", status: "todo" });
  store.addComment(t.identifier, { body: "这个任务和需求矛盾，属于架构变化，与上游不符；顺便说退出码 0。" });
  const probe = humanReviewProbe(store, store.requireTaskRef(t.identifier));
  assert.equal(probe.classification.confident, false, "散文不得当证据（判不准不升级）");
  assert.equal(probe.classification.category, null);
  store.close();
});

test("FR-85：有申报标记但类别写错/没写 → 仍然不升级（不许猜）", () => {
  const { store } = setup();
  for (const body of ["【人工校验申报】类别=随便写写", "【人工校验申报】证据=忘了写类别", "【人工校验申报】"]) {
    const t = store.createTask({ projectId: "p1", title: "错类别", status: "todo" });
    store.addComment(t.identifier, { body });
    const probe = humanReviewProbe(store, store.requireTaskRef(t.identifier));
    assert.equal(probe.classification.confident, false, `「${body}」不得升级`);
  }
  store.close();
});

const RULE = DIAGNOSTIC_RULES.find((r) => r.kind === "human_review_required");

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) =>
    router.route({ method, pathname, searchParams: new URLSearchParams(""), body });
  return { store, item, route };
}

/** 造一条**证据充分**的上游任务：同一类阻断复发 2 次 + 有失败证据（退出码 1，非 0）。 */
function escalatedTask(store, item) {
  const t = store.createTask({ projectId: "p1", title: "实现 Y", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.recordTaskFailure(t.identifier, { error: "退出码 1：TypeError at store.mjs:88", outcome: "failed", limit: 5 });
  store.blockTask(t.identifier, { kind: "transient", reason: "同一个崩溃再次出现：退出码 1" });
  store.blockTask(t.identifier, { kind: "transient", reason: "同一个崩溃再次出现：退出码 1" });
  return store.requireTaskRef(t.identifier);
}

/** 纯规则用的手搓上下文（用来穷举边界，不依赖真实库）。 */
function ruleCtx(overrides = {}) {
  return {
    task: { identifier: "p1-9", projectId: "p1" },
    humanReview: {
      classification: { confident: true, category: "real-bug-blocked", confidenceReason: "同一 bug 复发 2 次且有失败证据" },
      evidence: ["退出码 1"], pending: [], pendingSameCategory: null,
    },
    isHumanReviewTask: false,
    dismissed: new Set(),
    ...overrides,
  };
}

test("命中：证据充分 → 产出 high 诊断，首选动作直连派发端点", () => {
  const d = RULE.evaluate(ruleCtx());
  assert.ok(d, "confident=true 必须产出诊断");
  assert.equal(d.kind, "human_review_required");
  assert.equal(d.severity, "high");
  assert.equal(d.suggested, "human_review");
  const primary = d.actions.find((a) => a.kind === "primary");
  assert.equal(primary.id, "human_review");
  assert.equal(primary.path, "/api/tasks/p1-9/human-review");
  assert.ok(d.actions.some((a) => a.id === "dismiss"), "必须给出「忽略」出口（忽略留痕可回溯）");
});

test("判不准就不升级：confident=false / category=null → 一律不产出", () => {
  assert.equal(RULE.evaluate(ruleCtx({ humanReview: { classification: { confident: false, category: null, confidenceReason: "证据不足" }, evidence: [], pending: [], pendingSameCategory: null } })), null);
  assert.equal(RULE.evaluate(ruleCtx({ humanReview: { classification: { confident: true, category: null, confidenceReason: "类别未定" }, evidence: ["x"], pending: [], pendingSameCategory: null } })), null);
  assert.equal(RULE.evaluate(ruleCtx({ humanReview: {} })), null, "拿不到判定结果时不得臆断");
});

test("去重与自身豁免：同类已有待结论 / 本就是人工校验任务 / 已忽略 → 不产出", () => {
  assert.equal(RULE.evaluate(ruleCtx({ humanReview: { classification: { confident: true, category: "real-bug-blocked" }, evidence: ["退出码 1"], pendingSameCategory: { identifier: "p1-8" } } })), null, "同类已有 pending 不重复造卡");
  assert.equal(RULE.evaluate(ruleCtx({ isHumanReviewTask: true })), null, "人工校验任务自身不再升级（防自我繁殖）");
  assert.equal(RULE.evaluate(ruleCtx({ dismissed: new Set(["human_review_required"]) })), null);
});

test("真实库：复发 + 失败证据 → evaluateTaskDiagnostics 落出该诊断并给出可点动作", () => {
  const { store, item } = setup();
  const t = escalatedTask(store, item);
  const probe = humanReviewProbe(store, t);
  assert.equal(probe.classification.confident, true, "前置：探针必须判为证据充分");
  assert.equal(probe.classification.category, "real-bug-blocked");
  const r = evaluateTaskDiagnostics(store, t.identifier);
  const d = r.diagnostics.find((x) => x.kind === "human_review_required");
  assert.ok(d, "应产出人工校验诊断");
  assert.equal(d.suggested, "human_review");
  assert.ok(d.actions.some((a) => a.path === `/api/tasks/${t.identifier}/human-review`));
  // 增补：把已派发的人工校验任务算进上下文后，同一规则不再重复产出
  const human = store.createHumanReviewTask({ projectId: "p1", draft: humanReviewDraftFrom(store, t), relatedTask: t.identifier });
  const again = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "human_review_required");
  assert.equal(again, undefined, `已有待结论的人工校验任务（${human.identifier}）后不得再产出门`);
});

test("执行循环：人工校验任务进「可开工」也不派发，如实给 reason=human-review", async () => {
  const { store, item } = setup();
  const human = store.createHumanReviewTask({ projectId: "p1", draft: humanReviewDraftFrom(store, escalatedTask(store, item)), requirementId: item.id });
  store.updateTask(human.identifier, { expectedVersion: human.version, status: "todo" });
  const normal = store.createTask({ projectId: "p1", title: "正常任务", status: "todo" });
  store.associateRequirementTask(item.id, normal.id);

  const r = await runExecutionLoop({ store, projectId: "p1" });
  assert.deepEqual(r.blockedByHumanReview, [{ task: human.identifier, reason: "human-review" }]);
  assert.ok(!r.dispatched.some((d) => d.task === human.identifier), "人工校验任务绝不能被派发");
  assert.ok(r.dispatched.some((d) => d.task === normal.identifier), "同批的普通任务仍应正常派发（跳过是定向的）");
  assert.equal(store.requireTaskRef(human.identifier).status, "todo", "被跳过时状态不动（不认领、不置进行中）");
});

test("派发端点：201 建卡 + 原任务停手受阻 + 重复派发 409 + 证据不足拒绝", async () => {
  const { store, item, route } = setup();
  const t = escalatedTask(store, item);
  const r = await route("POST", `/api/tasks/${t.identifier}/human-review`, { actor: "human" });
  assert.equal(r.status, 201);
  assert.equal(r.payload.classification.category, "real-bug-blocked");
  assert.ok(r.payload.task.labels.includes(HUMAN_REVIEW_LABEL));
  assert.equal(r.payload.task.humanReviewState, "pending");
  assert.equal(store.requireTaskRef(t.identifier).status, "blocked", "停手等人：原任务必须移出可开工池");
  assert.ok(!store.listTasks({ projectId: "p1", status: "todo" }).some((x) => x.identifier === t.identifier));
  // 幂等：同类已有 pending → 拒绝，而不是再建一张
  await assert.rejects(() => route("POST", `/api/tasks/${t.identifier}/human-review`, {}), (e) => e.code === "HUMAN_REVIEW_ALREADY_EXISTS" || e.code === "HUMAN_REVIEW_PENDING");
  // 证据不足 → 拒绝升级
  const clean = store.createTask({ projectId: "p1", title: "没证据的任务", status: "todo" });
  await assert.rejects(() => route("POST", `/api/tasks/${clean.identifier}/human-review`, {}), (e) => e.code === "HUMAN_REVIEW_NOT_CONFIDENT");
  // 人工结论 → 门被消耗，原任务放行回「可开工」
  const done = await route("POST", `/api/tasks/${r.payload.task.identifier}/human-review/conclude`, { conclusion: "continue", comment: "确认真实 bug，上游已修" });
  assert.equal(done.status, 200);
  assert.deepEqual(done.payload.released, [t.identifier]);
  assert.equal(store.requireTaskRef(t.identifier).status, "todo");
  assert.equal(store.humanReviewPending("p1").length, 0);
});

/** 由真实库里的任务直接算出可落卡草案（复用探针，避免测试自己重造判定）。 */
function humanReviewDraftFrom(store, task) {
  return planHumanReview(humanReviewProbe(store, task).input).draft;
}
