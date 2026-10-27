/** 双引擎团队对接：official 下发指令 + 可用团队列表。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

test("双引擎下发：engine=official → mode=official 且指令含 spawn_teammate", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official", roles: [{ role: "lead" }] } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body: { targetTask: t.identifier, tasks: [{ task: t.identifier, kind: "work" }] } });
  assert.equal(res.payload.mode, "official");
  assert.ok(String(res.payload.draft?.directive ?? "").includes("spawn_teammate"));
  store.close();
});

test("可用团队列表 GET /api/projects/:id/agent-teams 含 official", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const res = await router.route({ method: "GET", pathname: "/api/projects/p1/agent-teams", searchParams: new URLSearchParams() });
  assert.ok(res.payload.teams.some((x) => x.source === "official"), "应含 official 团队");
  store.close();
});

test("拆解：POST /api/tasks/:ref/decompose 生成关联子任务", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "大任务", description: "- 甲\n- 乙\n- 丙", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/decompose`, searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.children.length, 3);
  assert.equal(store.listTasks({ projectId: "p1" }).filter((x) => x.parentId === t.id).length, 3);
  store.close();
});

test("执行循环：todo+已归因 → 自动派发(任务 in_progress + 团队锁)", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official" } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.dispatched.length, 1);
  assert.equal(res.payload.engine, "official");
  assert.equal(store.getTaskById(t.id).status, "in_progress");
  store.close();
});

test("执行循环：复杂任务（多行描述）→ 自动拆解为子任务并派发", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official" } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "复杂任务", description: "- 甲\n- 乙\n- 丙", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.decomposed.length, 1);
  assert.equal(res.payload.decomposed[0].children.length, 3);
  assert.equal(res.payload.dispatched.length, 3);
  assert.equal(store.getTaskById(t.id).status, "in_progress");
  assert.equal(store.listTasks({ projectId: "p1" }).filter((x) => x.parentId === t.id).length, 3);
  store.close();
});

test("前后关联/阻塞因素：依赖带 reason 可回读；派生=parentId", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const a = store.createTask({ projectId: "p1", title: "主任务A", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "主任务B", status: "todo" });
  store.addTaskDependency({ blocker: a.identifier, blocked: b.identifier, reason: "等待A的接口" });
  const deps = store.listTaskDependencies(b.identifier);
  assert.equal(deps.blockers[0].identifier, a.identifier);
  assert.equal(deps.blockers[0].reason, "等待A的接口");
  const child = store.createTask({ projectId: "p1", title: "派生：调研X", status: "backlog", parentId: b.id });
  assert.equal(store.getTaskById(child.id).parentId, b.id);
  store.close();
});

test("团队回报失败/完成 → 自动登记反馈（评论）", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const run = store.createTeamRun({ targetTask: t.id });
  const tt = store.acquireTeamTask({ teamId: run.id, task: t.id, kind: "work" });
  const before = store.listComments(t.id).length;
  store.applyTeamTaskOutcome(tt.id, { outcome: "failed", evidence: "编译失败" });
  const after = store.listComments(t.id);
  assert.equal(after.length, before + 1);
  assert.ok(/失败/.test(after[after.length - 1].body));
  assert.equal(store.getTaskById(t.id).status, "blocked");
  store.close();
});

test("防重复下发：任务执行会话仍在 running → 循环停发并列入 blockedByInflight", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.bindInitialSession("p1", "session-live");
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official" } });
  // 宿主会话状态替身：目标会话仍在执行
  store.hostSessionPort = { sessionState: (id) => ({ sessionId: id, live: true, running: true, status: "running", pending: 0 }) };
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.startTaskExecution(t.identifier, { sessionId: "session-live" }); // in_progress + 记录执行会话
  store.retryTaskExecution(t.identifier); // 退回 todo（保留 session_id + 释放锁）
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.dispatched.length, 0, "会话仍在执行时不得再次下发");
  assert.equal(res.payload.blockedByInflight.length, 1);
  assert.equal(res.payload.blockedByInflight[0].sessionId, "session-live");
  assert.equal(store.getTaskById(t.id).status, "todo", "任务保持 todo，等会话结束再派发");
  store.close();
});

test("防重复下发：GET /api/tasks/:ref/execution 带 sessionState；手动 execute 返回 409", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.hostSessionPort = { sessionState: (id) => ({ sessionId: id, live: true, running: true, status: "running", pending: 2 }) };
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.startTaskExecution(t.identifier, { sessionId: "session-busy" });
  const router = createApiRouter({ store });
  const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: new URLSearchParams() });
  assert.equal(exec.payload.sessionState.running, true);
  assert.equal(exec.payload.sessionState.pending, 2);
  await assert.rejects(
    () => router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: new URLSearchParams(), body: {} }),
    (error) => error.code === "EXECUTION_ALREADY_RUNNING",
  );
  store.close();
});

// ---- FR-67：活跃执行者（executionTeam）接入派发引擎选择 ----

test("FR-67 验收②：设活跃执行者=official 时，下发走 official 引擎（覆盖 teamTemplate.engine=instruction）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  // 项目引擎配置为 instruction，但活跃执行者选了官方团队 → 派发必须走 official。
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", executionTeam: "official:official" } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.engine, "official");
  assert.equal(res.payload.engineSource, "execution-team");
  assert.equal(res.payload.executionTeam, "official:official");
  assert.match(String(res.payload.dispatched[0].directive), /spawn_teammate/); // 指令按 official 引擎生成
  store.close();
});

test("FR-67：活跃执行者=third-party → 派发引擎数化到 nanmicoder", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official", executionTeam: "third-party:team-alpha" } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.engine, "nanmicoder");
  assert.equal(res.payload.engineSource, "execution-team");
  store.close();
});

test("FR-67 回落：未选活跃执行者（或来源未知）→ 派发引擎回落 teamTemplate.engine", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  store.saveProjectSettings("p1", { teamTemplate: { engine: "official" } });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res.payload.engine, "official");
  assert.equal(res.payload.engineSource, "team-template");
  assert.equal(res.payload.executionTeam, null);
  // 来源未知（形态不合法）同样回落，而不是静默改引擎
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", executionTeam: "mystery:x" } });
  const t2 = store.createTask({ projectId: "p1", title: "T2", status: "todo" });
  store.associateRequirementTask(item.id, t2.id);
  const res2 = await router.route({ method: "POST", pathname: "/api/projects/p1/execution-loop", searchParams: new URLSearchParams(), body: {} });
  assert.equal(res2.payload.engine, "instruction");
  assert.equal(res2.payload.engineSource, "team-template");
  store.close();
});

test("FR-67 验收①：PUT /projects/:id/settings 写 executionTeam 后回读一致（配置更新且回显）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  await router.route({ method: "PUT", pathname: "/api/projects/p1/settings", searchParams: new URLSearchParams(), body: { teamTemplate: { engine: "instruction", executionTeam: "official:official" } } });
  const res = await router.route({ method: "GET", pathname: "/api/projects/p1/settings", searchParams: new URLSearchParams() });
  assert.equal(res.payload.teamTemplate.executionTeam, "official:official");
  store.close();
});
