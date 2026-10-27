/** FR-85b：人工校验任务 —— API 层（列表 / 人工结论 / 三个反路径 / CLI 执行器不得跑掉）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { buildHumanReviewContext, buildHumanReviewDraft, classifyHumanReview } from "../src/core/human-review.mjs";

function confidentDraft(overrides = {}) {
  const input = { blockRecurrences: 2, evidence: ["退出码 1"], taskTitle: "实现 X", ...overrides };
  const classification = classifyHumanReview(input);
  assert.equal(classification.confident, true);
  return buildHumanReviewDraft({ ...buildHumanReviewContext(input), ...input, classification });
}

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}

test("GET /api/projects/:id/human-reviews：列出待人工校验并给计数", async () => {
  const { store, route } = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "blocked" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), relatedTask: original.identifier });
  const r = await route("GET", "/api/projects/p1/human-reviews");
  assert.equal(r.status, 200);
  assert.equal(r.payload.count, 1);
  assert.equal(r.payload.pendingCount, 1);
  assert.equal(r.payload.items[0].identifier, human.identifier);
  assert.equal(r.payload.pending[0].category, "real-bug-blocked");
  // state 过滤
  const filtered = await route("GET", "/api/projects/p1/human-reviews?state=concluded");
  assert.equal(filtered.payload.count, 0);
});

test("POST /api/tasks/:ref/human-review/conclude：continue 放行影响域 + 事件回流", async () => {
  const { store, route } = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "blocked" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft(), relatedTask: original.identifier });
  const r = await route("POST", `/api/tasks/${human.identifier}/human-review/conclude`, { conclusion: "continue", comment: "确认真实 bug，上游已修", actor: "human" });
  assert.equal(r.status, 200);
  assert.equal(r.payload.conclusion, "continue");
  assert.deepEqual(r.payload.released, [original.identifier]);
  assert.equal(store.requireTaskRef(original.identifier).status, "todo");
  assert.equal(store.humanReviewPending("p1").length, 0);
});

test("反路径：非法 conclusion → INVALID_FIELD；非人工校验任务 → HUMAN_REVIEW_NOT_KIND；重复结论 → HUMAN_REVIEW_ALREADY_CONCLUDED", async () => {
  const { store, route } = setup();
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  await assert.rejects(() => route("POST", `/api/tasks/${human.identifier}/human-review/conclude`, { conclusion: "maybe" }), (e) => e.code === "INVALID_FIELD");
  const plain = store.createTask({ projectId: "p1", title: "普通任务" });
  await assert.rejects(() => route("POST", `/api/tasks/${plain.identifier}/human-review/conclude`, { conclusion: "close" }), (e) => e.code === "HUMAN_REVIEW_NOT_KIND");
  await route("POST", `/api/tasks/${human.identifier}/human-review/conclude`, { conclusion: "close", actor: "human" });
  await assert.rejects(() => route("POST", `/api/tasks/${human.identifier}/human-review/conclude`, { conclusion: "continue" }), (e) => e.code === "HUMAN_REVIEW_ALREADY_CONCLUDED");
});

test("反路径：CLI 执行器不得跑人工校验任务（exec-cli 直接拒绝）", async () => {
  const { store, route } = setup();
  const human = store.createHumanReviewTask({ projectId: "p1", draft: confidentDraft() });
  await assert.rejects(() => route("POST", `/api/tasks/${human.identifier}/exec-cli`, { async: true }), (e) => e.code === "HUMAN_REVIEW_NOT_EXECUTABLE");
  assert.equal(store.listTaskRuns(human.identifier).length, 0);
});

test("反路径：human-reviews 只支持 GET", async () => {
  const { route } = setup();
  await assert.rejects(() => route("POST", "/api/projects/p1/human-reviews", {}), (e) => e.code === "USAGE_ERROR");
});
