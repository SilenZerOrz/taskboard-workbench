/**
 * 卡 `-263` / 需求 `R187`：**执行会话**必须能打开工作台。
 *
 * 真机事故（2026-11-13）：dsh 会话从看板认领卡片（`taskboard_start_execution` / 「启动执行」）后，
 * 用该会话打开工作台被「当前会话未绑定该项目的工作台」挡住 —— 四个视图全不可见。
 *
 * 根因不是前端画错，而是**两套事实没有接上**：
 *   · 认领 / 启动执行 / 改指 → 写 `tasks.session_id`（执行归属）；
 *   · FR-63 绑定门           → 只读 `projects.initial_session_id` + `project_sessions.status='approved'`。
 *
 * 本文件守的是**派生判据的三条边界**：
 *   ① 正例：持有本项目非终态任务的会话 ⇒ bound=true / role=executor / derived=true；
 *   ② 终态自收回：任务转 canceled ⇒ 同一会话回到 bound=false（不产生永久授权）；
 *   ③ 优先级：显式批准(associated) > 派生(executor) > 待批(pending)，且派生不得把陌生人放进来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, EXECUTOR_LIVE_STATUSES } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const sp = (qs = "") => new URLSearchParams(qs);

/** 建项目 + 需求 + 一张 todo 卡（归因已就绪，可直接启动执行）。 */
function seed({ projectId = "p1", workspacePath = "/repo/p1", sessionId = null } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: projectId, name: projectId, workspacePath });
  const item = store.createRequirementItem({ projectId, title: `R-${projectId}` });
  const task = store.createTask({ projectId, title: `T-${projectId}`, status: "todo" });
  store.associateRequirementTask(item.id, task.id);
  if (sessionId) store.startTaskExecution(task.identifier, { sessionId });
  return { store, item, task };
}

test("判据口径：非终态集合 = todo / in_progress / in_review / blocked（done / canceled 不在内）", () => {
  assert.deepEqual([...EXECUTOR_LIVE_STATUSES], ["todo", "in_progress", "in_review", "blocked"]);
  assert.ok(!EXECUTOR_LIVE_STATUSES.includes("done"));
  assert.ok(!EXECUTOR_LIVE_STATUSES.includes("canceled"));
});

test("正例：认领（startTaskExecution）写下的 session_id ⇒ 该会话绑定为 executor", () => {
  const { store, task } = seed({ sessionId: "sess-exec" });
  const b = store.sessionBinding("p1", "sess-exec");
  assert.equal(b.bound, true, "执行会话必须被视为已绑定（否则前端全视图挡住）");
  assert.equal(b.role, "executor");
  assert.equal(b.derived, true, "派生绑定必须自报来源，不能被当成「批准过」");
  assert.deepEqual(b.tasks, [task.identifier], "要带上是哪张卡派生的");
  store.close();
});

test("反例：没有任何任务、也没有批准的会话 ⇒ 仍然 bound=false（派生不得放陌生人进来）", () => {
  const { store } = seed({ sessionId: "sess-exec" });
  const b = store.sessionBinding("p1", "sess-stranger");
  assert.equal(b.bound, false);
  assert.equal(b.role, "none");
  assert.deepEqual(b.tasks ?? [], []);
  store.close();
});

test("终态自收回：任务 canceled ⇒ 同一会话立刻回到 bound=false（不留永久授权）", () => {
  const { store, task } = seed({ sessionId: "sess-exec" });
  assert.equal(store.sessionBinding("p1", "sess-exec").bound, true);
  const cur = store.requireTaskRef(task.identifier);
  store.updateTask(task.identifier, { status: "canceled", expectedVersion: cur.version, actor: "agent" });
  const after = store.sessionBinding("p1", "sess-exec");
  assert.equal(after.bound, false, "任务收口后绑定必须自动收回");
  assert.equal(after.role, "none");
  store.close();
});

test("优先级：显式批准(associated) 压过派生(executor)", () => {
  const { store } = seed({ sessionId: "sess-exec" });
  store.approveSessionAssociation("p1", "sess-exec");
  const b = store.sessionBinding("p1", "sess-exec");
  assert.equal(b.bound, true);
  assert.equal(b.role, "associated", "人工批准过的会话应显示为已关联，而不是被派生覆盖");
  assert.equal(b.derived, undefined);
  store.close();
});

test("项目解析：执行会话优先于 pending 申请（正在干活 > 只是申请）", () => {
  const { store } = seed({ projectId: "p-work", workspacePath: "/repo/work", sessionId: "sess-exec" });
  store.createProject({ id: "p-other", name: "other", workspacePath: "/repo/other" });
  store.requestSessionAssociation("p-other", "sess-exec"); // 同一会话对「另一个项目」有待批申请
  const hit = store.findProjectBySession("sess-exec");
  assert.equal(hit.project.id, "p-work", "派生（正在干）必须压过 pending（只是申请）");
  assert.equal(hit.role, "executor");
  store.close();
});

test("项目解析：已批准关联压过派生", () => {
  const { store } = seed({ projectId: "p-work", workspacePath: "/repo/work", sessionId: "sess-exec" });
  store.createProject({ id: "p-other", name: "other", workspacePath: "/repo/other" });
  store.approveSessionAssociation("p-other", "sess-exec");
  const hit = store.findProjectBySession("sess-exec");
  assert.equal(hit.project.id, "p-other");
  assert.equal(hit.role, "associated");
  store.close();
});

test("/api/context：执行会话解析到任务所属项目，且不被 cwd 带偏", async () => {
  const { store, task } = seed({ projectId: "p-work", workspacePath: "/repo/work", sessionId: "sess-exec" });
  store.createProject({ id: "p-other", name: "other", workspacePath: "/repo/other" });
  // 先有主会话：否则 /api/context 的「首个进入者成为主会话」会把这个会话升成 main，
  // 就测不到 executor 这一档了（那条路径本身是既有行为，不在本卡范围）。
  store.bindInitialSession("p-work", "sess-main");
  const router = createApiRouter({ store });
  const r = await router.route({
    method: "GET", pathname: "/api/context",
    searchParams: sp("cwd=/repo/other&session=sess-exec"),
  });
  assert.equal(r.status, 200);
  assert.equal(r.payload.project.id, "p-work", "会话归属必须优先于 cwd 回落");
  assert.equal(r.payload.sessionBound, true);
  assert.equal(r.payload.association, "executor");
  assert.equal(r.payload.roleDerived, true);
  assert.deepEqual(r.payload.executorTasks, [task.identifier]);
  store.close();
});

test("/api/projects/:id/sessions：派生执行会话可见且不与已批准/主会话重复", async () => {
  const { store, task } = seed({ projectId: "p1", sessionId: "sess-exec" });
  // 另建一个会话：也有任务，但已被显式批准 ⇒ 只在批准列表出现一次
  const t2 = store.createTask({ projectId: "p1", title: "T2", status: "todo" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R2" });
  store.associateRequirementTask(item.id, t2.id);
  store.startTaskExecution(t2.identifier, { sessionId: "sess-approved" });
  store.approveSessionAssociation("p1", "sess-approved");

  const router = createApiRouter({ store });
  const r = await router.route({ method: "GET", pathname: "/api/projects/p1/sessions", searchParams: sp() });
  assert.equal(r.status, 200);
  const executors = r.payload.executors ?? [];
  assert.equal(executors.length, 1, "只应列出未被批准覆盖的派生会话");
  assert.equal(executors[0].sessionId, "sess-exec");
  assert.equal(executors[0].derived, true);
  assert.deepEqual(executors[0].tasks, [task.identifier]);
  assert.ok(!executors.some((e) => e.sessionId === "sess-approved"), "已批准会话不得在派生里重复出现");
  store.close();
});
