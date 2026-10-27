/** FR-85b：人工校验任务（人在环升级门）—— store 层：落卡 / 幂等 / 四重执行拦截 / 结论与影响域放行。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { buildHumanReviewDraft, buildHumanReviewContext, classifyHumanReview, HUMAN_REVIEW_LABEL } from "../src/core/human-review.mjs";

/** 造一个**证据充分**的草案（真实 bug 阻塞：复发 ≥2 且带失败证据）。 */
function confidentDraft(overrides = {}) {
  const input = {
    blockRecurrences: 2,
    evidence: ["退出码 1", "stack: TypeError at loop.mjs:88"],
    taskTitle: "实现 X",
    ...overrides,
  };
  const classification = classifyHumanReview(input);
  assert.equal(classification.confident, true, "前置：探针输入必须是 confident=true");
  return buildHumanReviewDraft({ ...buildHumanReviewContext(input), ...input, classification });
}

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  return store;
}

const codeOf = (fn) => {
  try { fn(); return null; } catch (error) { return error?.code ?? "NO_CODE"; }
};

test("落卡：草案通过校验才建卡，标签带 human_review、类别与状态落库、事件留痕", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), actor: "diagnostics" });
  assert.ok(task.labels.includes(HUMAN_REVIEW_LABEL), "标签即任务类型（幂等迁移不新增列）");
  assert.equal(task.humanReviewState, "pending");
  assert.equal(task.humanReviewCategory, "real-bug-blocked");
  assert.equal(task.status, "backlog");
  assert.ok(String(task.description).includes("判定类别"), "草案正文自包含（四段）");
  const types = store.listTaskEvents(task.identifier, { order: "asc" }).map((e) => e.type);
  assert.ok(types.includes("human_review_created"));
  assert.equal(store.listHumanReviews({ projectId: "p1" }).length, 1);
  assert.equal(store.humanReviewPending("p1").length, 1);
});

test("落卡：证据不足的草案一律拒绝（判不准就不升级，不自动臆断）", () => {
  const store = setup();
  const code = codeOf(() => store.createHumanReviewTask({ projectId: "p1", draft: { title: "空壳" } }));
  assert.equal(code, "HUMAN_REVIEW_DRAFT_INVALID");
  assert.equal(store.listHumanReviews({ projectId: "p1" }).length, 0, "被拒后不留卡");
});

test("幂等：同项目同类别仍有未结论任务时拒绝重复建卡", () => {
  const store = setup();
  store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  const code = codeOf(() => store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() }));
  assert.equal(code, "HUMAN_REVIEW_ALREADY_EXISTS");
  assert.equal(store.listHumanReviews({ projectId: "p1" }).length, 1);
});

test("执行拦截①：执行侧不得认领（含审计留痕）", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  const code = codeOf(() => store.claimTask(task.identifier, { sessionId: "agent-1" }));
  assert.equal(code, "HUMAN_REVIEW_NOT_CLAIMABLE");
  const audit = store.listGovernanceAudit({ action: "claim" });
  assert.equal(audit.at(-1).allowed, false, "拒绝必须留审计");
  assert.equal(audit.at(-1).reason, "human-review-not-claimable");
});

test("执行拦截②：不得启动执行 / 不得开执行尝试", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  store.updateTask(task.identifier, { status: "todo", expectedVersion: store.requireTaskRef(task.identifier).version });
  assert.equal(codeOf(() => store.startTaskExecution(task.identifier, { sessionId: "s1" })), "HUMAN_REVIEW_NOT_EXECUTABLE");
  assert.equal(codeOf(() => store.startTaskRun(task.identifier, { actor: "cli-executor" })), "HUMAN_REVIEW_NOT_EXECUTABLE");
  assert.equal(store.listTaskRuns(task.identifier).length, 0, "人工校验任务不产生尝试记录");
});

test("执行拦截③：不得置「完成」（唯一出口是人工结论入口）", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  const code = codeOf(() => store.updateTask(task.identifier, { status: "done", expectedVersion: store.requireTaskRef(task.identifier).version }));
  assert.equal(code, "HUMAN_REVIEW_CANNOT_DONE");
  assert.equal(store.requireTaskRef(task.identifier).status, "backlog", "被拒后状态不变");
  const audit = store.listGovernanceAudit({ action: "set-status" });
  assert.equal(audit.at(-1).reason, "human-review-cannot-done");
});

test("执行拦截④：执行侧工具（teamSetTaskStatus）不得改其状态", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  assert.equal(codeOf(() => store.teamSetTaskStatus(task.identifier, { status: "in_progress", actor: "team" })), "HUMAN_REVIEW_NOT_EXECUTABLE");
});

test("结论：非法结论被拒（INVALID_FIELD），且不留结论", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  assert.equal(codeOf(() => store.concludeHumanReview(task.identifier, { conclusion: "maybe" })), "INVALID_FIELD");
  assert.equal(store.requireTaskRef(task.identifier).humanReviewState, "pending");
});

test("结论：非人工校验任务调用结论入口被拒", () => {
  const store = setup();
  const plain = store.createTask({ projectId: "p1", title: "普通任务" });
  assert.equal(codeOf(() => store.concludeHumanReview(plain.identifier, { conclusion: "continue" })), "HUMAN_REVIEW_NOT_KIND");
});

test("结论 continue：门被消耗（转已取消）+ 影响域内下游放行回「可开工」", () => {
  const store = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "blocked" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), relatedTask: original.identifier });
  assert.equal(store.listTaskDependencies(original.identifier).blockers.length, 1, "影响域写成真实依赖边");
  const r = store.concludeHumanReview(human.identifier, { conclusion: "continue", comment: "确认是真实 bug，已修上游", actor: "human" });
  assert.equal(r.conclusion, "continue");
  assert.equal(r.task.humanReviewState, "concluded");
  assert.equal(r.task.humanReviewConclusion, "continue");
  assert.equal(r.task.status, "canceled", "门已消耗，不再挡依赖");
  assert.deepEqual(r.released, [original.identifier]);
  assert.equal(store.requireTaskRef(original.identifier).status, "todo", "原任务回「可开工」重派");
});

test("结论 change-requirement / close：不放行影响域（下游保持受阻）", () => {
  for (const conclusion of ["change-requirement", "close"]) {
    const store = setup();
    const original = store.createTask({ projectId: "p1", title: "原任务", status: "blocked" });
    const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), relatedTask: original.identifier });
    const r = store.concludeHumanReview(human.identifier, { conclusion, actor: "human" });
    assert.equal(r.conclusion, conclusion);
    assert.deepEqual(r.released, [], "只有 continue 才放行影响域");
    assert.equal(store.requireTaskRef(original.identifier).status, "blocked", `结论 ${conclusion} 下下游必须保持受阻`);
  }
});

test("结论：不得重复结论（门只消耗一次）", () => {
  const store = setup();
  const task = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  store.concludeHumanReview(task.identifier, { conclusion: "close", actor: "human" });
  assert.equal(codeOf(() => store.concludeHumanReview(task.identifier, { conclusion: "continue", actor: "human" })), "HUMAN_REVIEW_ALREADY_CONCLUDED");
  assert.equal(store.humanReviewPending("p1").length, 0, "结论后不再计入待人工校验");
});

test("结论后放行需看全部前置：还有未完成的其他前置时不放行", () => {
  const store = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "blocked" });
  const other = store.createTask({ projectId: "p1", title: "另一个前置", status: "in_progress" });
  store.addTaskDependency({ blocker: other.identifier, blocked: original.identifier });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), relatedTask: original.identifier });
  const r = store.concludeHumanReview(human.identifier, { conclusion: "continue", actor: "human" });
  assert.deepEqual(r.released, [], "其余前置未完成 → 不放行");
  assert.equal(store.requireTaskRef(original.identifier).status, "blocked");
});
