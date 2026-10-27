/** 「下一步」引导 —— API 层装配（GET /api/tasks/:ref/next-step）：只读、不写状态。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { buildHumanReviewContext, buildHumanReviewDraft, classifyHumanReview } from "../src/core/human-review.mjs";

function draftFor(overrides = {}) {
  const input = { blockRecurrences: 2, evidence: ["退出码 1"], taskTitle: "实现 X", ...overrides };
  const classification = classifyHumanReview(input);
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

test("next-step：被「待结论」的人工校验前置挡住 → 给出直达入口，且不改任何状态", async () => {
  const { store, route } = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "todo" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: draftFor(), relatedTask: original.identifier });
  const before = store.getTaskRef(original.identifier);

  const r = await route("GET", `/api/tasks/${original.identifier}/next-step`);
  assert.equal(r.status, 200);
  assert.equal(r.payload.nextStep.code, "blocked-by-human-review");
  assert.equal(r.payload.humanReviewBlocker.identifier, human.identifier);
  assert.equal(r.payload.nextStep.actions[0].id, "open-blocker");
  assert.match(r.payload.nextStep.actions[0].label, new RegExp(human.identifier));
  const after = store.getTaskRef(original.identifier);
  assert.equal(after.status, before.status, "引导不得改状态");
  assert.equal(after.version, before.version, "引导不得写库");
});

test("next-step：人工结论给出后不再按人环门拦（门已消耗）", async () => {
  const { store, route } = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "todo" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: draftFor(), relatedTask: original.identifier });
  store.concludeHumanReview(human.identifier, { conclusion: "close", actor: "human" });

  const r = await route("GET", `/api/tasks/${original.identifier}/next-step`);
  assert.equal(r.status, 200);
  assert.equal(r.payload.humanReviewBlocker, null);
  assert.notEqual(r.payload.nextStep.code, "blocked-by-human-review");
});

test("next-step：人工校验卡自己 → 引导去下结论", async () => {
  const { store, route } = setup();
  const original = store.createTask({ projectId: "p1", title: "原任务", status: "todo" });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: draftFor(), relatedTask: original.identifier });
  const r = await route("GET", `/api/tasks/${human.identifier}/next-step`);
  assert.equal(r.payload.nextStep.code, "human-review-pending");
  assert.equal(r.payload.nextStep.actions[0].id, "conclude-human-review");
});

test("next-step：待验收 + 评审通过 → 只差人工点完成", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "待验收任务", status: "in_progress" });
  store.requestReview(t.identifier, { reviewer: "reviewer", comment: "" });
  store.approveReview(t.identifier, { comment: "", actor: "reviewer" });
  const r = await route("GET", `/api/tasks/${t.identifier}/next-step`);
  assert.equal(r.payload.nextStep.code, "awaiting-human-done");
  assert.deepEqual(r.payload.nextStep.actions.map((a) => a.id), ["complete"]);
});

test("next-step：可开工但未归因 → 先去归因", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "无归因", status: "todo" });
  const r = await route("GET", `/api/tasks/${t.identifier}/next-step`);
  assert.equal(r.payload.nextStep.code, "todo-no-attribution");
});

test("next-step：待办池且未归因 → 先归因（归因门在授权门之前，第十报）", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "待办池无归因", status: "backlog" });
  const r = await route("GET", `/api/tasks/${t.identifier}/next-step`);
  assert.equal(r.payload.nextStep.code, "backlog-no-attribution");
  assert.deepEqual(r.payload.nextStep.actions.map((a) => a.id), ["goto-attribution"]);
});

test("next-step：未知任务抛 TASK_NOT_FOUND；非 GET 抛 USAGE_ERROR（错误映射在 HTTP 层）", async () => {
  const { route } = setup();
  await assert.rejects(() => route("GET", "/api/tasks/taskboard-workbench-99999/next-step"), (e) => e.code === "TASK_NOT_FOUND");
  await assert.rejects(() => route("POST", "/api/tasks/taskboard-workbench-99999/next-step", {}), (e) => e.code === "USAGE_ERROR");
});
