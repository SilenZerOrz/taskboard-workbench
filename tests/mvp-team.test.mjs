/** 切片3 沙箱可闭环部分：团队数据模型 / 任务级锁 / 治理拦截 / 部分完成回流（FR-42/43）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";
import { STATUS_MAPPING, TEAM_WRITABLE_STATUSES } from "../src/core/team.mjs";

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  return { store, item };
}
const mk = (store, item, title, status = "todo") => {
  const t = store.createTask({ projectId: "demo", title, status });
  store.associateRequirementTask(item.id, t.id);
  return t;
};

test("A 团队数据模型：run/member/task/attempt 四表可用 + 状态映射显式", () => {
  const { store, item } = fresh();
  const t = mk(store, item, "T1");
  const run = store.createTeamRun({ targetTask: t.id, targetRequirement: item.id });
  assert.equal(run.status, "staged");
  store.addTeamMember({ teamId: run.id, role: "engineer", model: "m" });
  const tt = store.acquireTeamTask({ teamId: run.id, task: t.id, kind: "work" });
  store.recordTeamAttempt({ teamTaskId: tt.id, attemptId: "a1", result: "passed" });
  assert.equal(store.listTeamMembers(run.id).length, 1);
  assert.equal(store.listTeamTasks(run.id).length, 1);
  assert.equal(STATUS_MAPPING.projectToTeam.in_progress, "running");
  assert.equal(STATUS_MAPPING.teamToProject.completed, "in_review");
  assert.ok(TEAM_WRITABLE_STATUSES.includes("in_review") && !TEAM_WRITABLE_STATUSES.includes("done"));
  store.close();
});

test("B 任务级执行锁：二次派发被拒；解锁后可再生效", () => {
  const { store, item } = fresh();
  const t = mk(store, item, "T1");
  const r1 = store.createTeamRun({ targetTask: t.id });
  const r2 = store.createTeamRun({ targetTask: t.id });
  const tt1 = store.acquireTeamTask({ teamId: r1.id, task: t.id });
  assert.throws(() => store.acquireTeamTask({ teamId: r2.id, task: t.id }), (e) => e.code === "TASK_LOCKED");
  assert.ok(store.getTaskLock(t.id));
  store.releaseTeamTask(tt1.id);
  assert.equal(store.getTaskLock(t.id), null);
  const tt2 = store.acquireTeamTask({ teamId: r2.id, task: t.id }); // 解锁后可再生效
  assert.ok(tt2.id);
  store.close();
});

test("C1 治理红线①：执行侧不得写 done → 拒绝 + 审计", () => {
  const { store, item } = fresh();
  const t = mk(store, item, "T1", "in_progress");
  assert.throws(() => store.teamSetTaskStatus(t.id, { status: "done", actor: "team" }), (e) => e.code === "GOVERNANCE_AGENT_DONE");
  const audit = store.listGovernanceAudit({ action: "set-status" }).filter((a) => a.allowed === false);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, "agent-cannot-write-done");
  store.close();
});

test("C2 治理红线②：backlog 不得被团队认领 + 审计", () => {
  const { store, item } = fresh();
  const backlog = mk(store, item, "T-backlog", "backlog");
  const run = store.createTeamRun({ targetTask: backlog.id });
  assert.throws(() => store.acquireTeamTask({ teamId: run.id, task: backlog.id }), (e) => e.code === "EXECUTION_NOT_AUTHORIZED");
  assert.ok(store.listGovernanceAudit({ action: "claim" }).some((a) => a.reason === "backlog-not-authorized"));
  store.close();
});

test("C3 治理红线③：审查未过 → 下游不解锁（blocked）+ 审计", () => {
  const { store, item } = fresh();
  const a = mk(store, item, "A", "todo");
  const b = mk(store, item, "B", "todo");
  store.addTaskDependency({ blocker: a.id, blocked: b.id });
  const run = store.createTeamRun({ targetTask: a.id });
  const tt = store.acquireTeamTask({ teamId: run.id, task: a.id, kind: "review" });
  store.applyTeamTaskOutcome(tt.id, { outcome: "completed", reviewPassed: false });
  assert.equal(store.getTaskById(b.id).status, "blocked");
  assert.ok(store.listGovernanceAudit({ action: "review-gate" }).length >= 1);
  store.close();
});

test("D 部分完成回流：完成→in_review、失败→blocked、下游不因完成而解锁", () => {
  const { store, item } = fresh();
  const a = mk(store, item, "A", "todo");
  const e = mk(store, item, "E", "todo");
  store.addTaskDependency({ blocker: a.id, blocked: e.id }); // A blocks E
  const c = mk(store, item, "C", "todo");
  const f = mk(store, item, "F", "todo");
  store.addTaskDependency({ blocker: c.id, blocked: f.id }); // C blocks F
  const run = store.createTeamRun({ targetTask: a.id });
  const ttA = store.acquireTeamTask({ teamId: run.id, task: a.id });
  const ttC = store.acquireTeamTask({ teamId: run.id, task: c.id });
  const r = store.applyTeamRunProgress(run.id, [{ teamTaskId: ttA.id, outcome: "completed" }, { teamTaskId: ttC.id, outcome: "failed" }]);
  assert.equal(store.getTaskById(a.id).status, "in_review"); // 完成项
  assert.equal(store.getTaskById(c.id).status, "blocked"); // 失败项
  assert.equal(store.getTaskById(e.id).status, "todo"); // 完成**不**解锁下游
  assert.equal(store.getTaskById(f.id).status, "blocked"); // 上游失败 → 下游 blocked
  assert.ok(["running", "completed", "failed"].includes(r.status));
  store.close();
});

test("D 全队失败：团队整体失败 + 可重试", () => {
  const { store, item } = fresh();
  const a = mk(store, item, "A", "todo");
  const c = mk(store, item, "C", "todo");
  const run = store.createTeamRun({ targetTask: a.id });
  const ttA = store.acquireTeamTask({ teamId: run.id, task: a.id });
  const ttC = store.acquireTeamTask({ teamId: run.id, task: c.id });
  store.applyTeamTaskOutcome(ttA.id, { outcome: "failed" });
  store.applyTeamTaskOutcome(ttC.id, { outcome: "failed" });
  const status = store.finishTeamRun(run.id);
  assert.equal(status, "failed");
  const retried = store.retryTaskExecution(a.id);
  assert.equal(retried.status, "todo");
  store.close();
});

test("D SSE：团队/任务变更发布失效信号", async () => {
  const { store, item } = fresh();
  const t = mk(store, item, "T1");
  const hub = createEventHub();
  const chunks = [];
  const unsub = hub.subscribe({ writeHead() {}, write(c) { chunks.push(c); }, on() {} });
  const router = createApiRouter({ store, events: hub });
  // FR-50 验收第三条（模板非法 ⇒ 拒绝建队）：建队必须带**有效角色来源**（body.members 或项目 teamTemplate），
  // 否则先在模板门前被拒（本用例原本只关心 SSE 失效信号，故显式给一员角色）。
  const created = await router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body: { targetTask: t.id, members: [{ role: "engineer" }] } });
  await router.route({ method: "POST", pathname: `/api/teams/${created.payload.team.id}/tasks`, searchParams: new URLSearchParams(), body: { task: t.id } });
  assert.ok(chunks.join("").includes("event: team.updated"));
  assert.ok(chunks.join("").includes("event: task.updated"));
  unsub();
  store.close();
});

// ---- 切片3 宿主集成：TeamEnginePort 双实现 + /api/teams 派发接线 ----
import { createTeamEnginePort } from "../src/host/team-engine.mjs";

test("TEAM-PORT P2：instruction adapter 生成派发指令（有会话则预置）", async () => {
  const sent = [];
  const port = createTeamEnginePort({
    mode: "instruction",
    getService: (n) => (n === "sessions"
      ? { create: async () => "sess-1", sendMessage: async (id, msg) => sent.push([id, msg]) }
      : undefined),
  });
  assert.equal(port.mode, "instruction");
  const r = await port.createDraft({ teamId: "t1", targetTask: "demo-1", members: [{ role: "engineer" }], tasks: ["建表"] });
  assert.equal(r.mode, "instruction");
  assert.match(r.draft.directive, /teamId=t1/);
  assert.equal(r.presetApplied, true);
  assert.equal(sent.length, 1);
  assert.equal((await port.approve("t1")).approved, true); // no-op
});

test("TEAM-PORT P1：agent-teams adapter 占位（有 tools.call → agent-teams；否则降级）", async () => {
  const withTools = createTeamEnginePort({
    mode: "agent-teams",
    getService: (n) => (n === "tools" ? { call: async (name) => ({ ok: true, name }) } : undefined),
  });
  const r1 = await withTools.createDraft({ teamId: "t2", members: [], tasks: [] });
  assert.equal(r1.mode, "agent-teams");
  const noTools = createTeamEnginePort({ mode: "agent-teams", getService: () => undefined });
  const r2 = await noTools.createDraft({ teamId: "t3", members: [], tasks: [] });
  assert.equal(r2.mode, "agent-teams-fallback");
  assert.equal(r2.fallbackReason, "agent-teams-unavailable");
});

test("TEAM-WIRE /api/teams：归因门 + 引擎模式 + 任务级锁", async () => {
  const { store, item } = fresh();
  const t = mk(store, item, "目标", "todo");
  store.teamEnginePort = createTeamEnginePort({ mode: "instruction", getService: () => undefined });
  const router = createApiRouter({ store });
  const post = (body) => router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body });

  // FR-50：建队需带有效角色来源（同 D SSE 用例注释）。
  const res = await post({ targetTask: t.id, tasks: [t.id], members: [{ role: "engineer" }] });
  assert.equal(res.status, 201);
  assert.equal(res.payload.mode, "instruction");
  assert.equal(res.payload.locks.length, 1);
  // 同任务二次派发 → TASK_LOCKED
  await assert.rejects(() => post({ targetTask: t.id, tasks: [t.id], members: [{ role: "engineer" }] }), (e) => e.code === "TASK_LOCKED");

  // 未归因目标 → 拦截
  const orphan = store.createTask({ projectId: "demo", title: "游离", status: "todo" });
  await assert.rejects(() => post({ targetTask: orphan.id }), (e) => e.code === "EXECUTION_NOT_ATTRIBUTED");
  store.close();
});

test("FR-50 门：建队无有效角色来源 ⇒ 拒绝（INVALID_TEAM_TEMPLATE）且不留下孤儿团队 run", async () => {
  const { store, item } = fresh();
  const t = mk(store, item, "无模板目标", "todo");
  const router = createApiRouter({ store });
  const post = (body) => router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body });
  await assert.rejects(() => post({ targetTask: t.id, tasks: [t.id] }), (e) => e.code === "INVALID_TEAM_TEMPLATE");
  // 校验在 `createTeamRun` **之前**：被拒的派发不得留下空团队 run（真机 2026-10-22 的孤儿 run 事故）。
  assert.equal(store.listTeamRuns().length, 0);
  store.close();
});

test("ORG-47/48 API：GET /api/teams 列表 + GET /api/tasks/:ref/team 关联（成员/团队任务/锁）", async () => {
  const { store, item } = fresh();
  const t = mk(store, item, "关联目标任务", "todo");
  const router = createApiRouter({ store });
  const post = (pathname, body) => router.route({ method: "POST", pathname, searchParams: new URLSearchParams(), body });

  const created = await post("/api/teams", {
    targetTask: t.identifier,
    tasks: [{ task: t.identifier, kind: "work" }],
    members: [{ role: "engineer" }],
  });
  assert.equal(created.status, 201);
  const teamId = created.payload.team.id;
  await post(`/api/teams/${teamId}/members`, { role: "engineer" });
  await post(`/api/teams/${teamId}/members`, { role: "tester" });

  // 列表视图（FR-47）：带出目标任务 + 成员
  const list = await router.route({ method: "GET", pathname: "/api/teams", searchParams: new URLSearchParams() });
  assert.equal(list.status, 200);
  assert.equal(list.payload.count, 1);
  // 建队时已按 `members` 装配 1 名 engineer；随后 members 端点**追加**（现在同角色也可多名）⇒ 3。
  assert.equal(list.payload.teams[0].members.length, 3);
  assert.equal(list.payload.teams[0].targetTaskIdentifier, t.identifier);

  // 任务详情关联视图（FR-48）：成员 + 团队任务 + 任务级锁
  const one = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/team`, searchParams: new URLSearchParams() });
  assert.equal(one.status, 200);
  assert.equal(one.payload.count, 1);
  assert.equal(one.payload.teams[0].members.length, 3);
  assert.equal(one.payload.teams[0].tasks.length, 1);
  assert.ok(one.payload.lock);
  assert.equal(one.payload.task.sessionId, null); // 未启动执行 → 会话关联降级可见

  // 按任务过滤
  const filtered = await router.route({ method: "GET", pathname: "/api/teams", searchParams: new URLSearchParams({ task: t.identifier }) });
  assert.equal(filtered.payload.count, 1);
  store.close();
});
