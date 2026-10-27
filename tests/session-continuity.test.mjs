/**
 * FR-84 会话引用存活判定与主会话接续：
 *   · 打开会话的**三级回落链**（任务会话 → 项目主会话 → 项目已关联会话）
 *   · 打开前**探活**：`exists=false` → `session-gone` 且不尝试打开；`exists=null` → 照旧尝试（不误判失效）
 *   · 会话存活端点 / 绑定列表存活徽标 / 主会话失效标记
 *   · 重建并重绑主会话（需 confirm；投递开局提示词；写审计）
 *   · 诊断动作设防：无可解析会话 → 不产出「打开执行会话」，改产「重建并绑定主会话」
 * 真机事故对照：点「打开执行会话」→ "无法自动打开，已复制会话标识：-"（空标识污染 UI）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { evaluateTaskDiagnostics, resolveSessionRef } from "../src/core/diagnostics.mjs";

const sp = (qs = "") => new URLSearchParams(qs);

function setup({ main = null, bound = [], taskSession = null, workspacePath = null, extraProjects = [] } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath });
  for (const p of extraProjects) store.createProject(p);
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  if (main) store.bindInitialSession("p1", main);
  for (const { sessionId, status } of bound) {
    if (status === "approved") store.approveSessionAssociation("p1", sessionId);
    else store.requestSessionAssociation("p1", sessionId);
  }
  // 只有「可开工(todo)」才能启动执行；`startTaskExecution` 会把任务推进到 in_progress
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);   // 归因门：启动执行前必须已归因
  if (taskSession) store.startTaskExecution(t.identifier, { sessionId: taskSession });
  return { store, t };
}

/** 造一个宿主投递端口（可选注入 exists 三态）。 */
function mockPort({ exists = true, openResult = { opened: true }, sent = true, originCwd = null, originSource = "mock", hostSessions = [] } = {}) {
  const calls = { open: [], prompt: [], created: 0, origin: [], createArgs: [], listed: [] };
  const port = {
    available: true,
    async openSession(sessionId) { calls.open.push(sessionId); return typeof openResult === "function" ? openResult(sessionId) : openResult; },
    async sendPrompt(sessionId, text) { calls.prompt.push({ sessionId, text }); return { sent, reason: sent ? null : "test-unsent" }; },
    async sessionExists(sessionId) { return { sessionId, exists, source: "mock" }; },
    // FR-84 补口：会话创建时的 cwd（宿主 `sessionQuery` 提供）。默认 null = 判不准。
    async sessionOrigin(sessionId) { calls.origin.push(sessionId); return { sessionId, cwd: originCwd, source: originSource }; },
    async listSessions({ cwd } = {}) { calls.listed.push(cwd ?? null); const all = hostSessions ?? []; return { sessions: cwd ? all.filter((r) => r.cwd === cwd) : all, source: "mock" }; },
    async createSession(args) { calls.created += 1; calls.createArgs.push(args ?? null); return { sessionId: `session-new-${calls.created}` }; },
    async probeHost() { calls.probed = (calls.probed ?? 0) + 1; return { verdict: "create-available", scopedCreate: true, rootCreate: true }; }
  };
  return { port, calls };
}

test("宿主探测端点：只读 —— 如实回传探测结果，**不建会话**（建会话＝写用户数据）", async () => {
  const { store } = setup({});
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/host/probe", searchParams: sp(), body: null });
  assert.equal(r.status, 200);
  assert.equal(r.payload.probe.verdict, "create-available");
  assert.equal(calls.probed, 1);
  assert.equal(calls.created, 0, "探测绝不建会话");
});

test("宿主探测端点：没有宿主端口时如实回 probe=null（不谎报能力）", async () => {
  const { store } = setup({});
  store.hostSessionPort = null;
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/host/probe", searchParams: sp(), body: null });
  assert.equal(r.status, 200);
  assert.equal(r.payload.probe, null);
});

test("端口自带 probeHost：无 ctx / 无宿主服务时必须如实报不可用，且不抛、不建会话", async () => {
  const { createHostSessionPort } = await import("../index.js");
  const port = createHostSessionPort({});
  const probe = await port.probeHost();
  assert.equal(typeof probe, "object");
  assert.equal(probe.rootCreate, false);
  assert.ok(typeof probe.verdict === "string" && probe.verdict.length > 0);
  assert.ok(["scope-factory-unavailable", "scoped-ctx-unavailable", "create-unavailable"].includes(probe.verdict), "无宿主时必须落在明确的不可用判定上，实际：" + probe.verdict);
  assert.notEqual(probe.verdict, "create-available");
});

const openSession = (router, ref) => router.route({ method: "POST", pathname: `/api/tasks/${encodeURIComponent(ref)}/open-session`, searchParams: sp(), body: {} });

test("回落链一：任务自身有执行会话 → source=task", async () => {
  const { store, t } = setup({ main: "session-main", taskSession: "session-task" });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true);
  assert.equal(r.payload.sessionId, "session-task");
  assert.equal(r.payload.source, "task");
  assert.deepEqual(calls.open, ["session-task"]);
  store.close();
});

test("回落链二：任务无会话 → 回落项目主会话（source=project-main），不得返回空标识", async () => {
  const { store, t } = setup({ main: "session-main" });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true);
  assert.equal(r.payload.sessionId, "session-main");
  assert.equal(r.payload.source, "project-main");
  assert.equal(r.payload.sessionId === "" || r.payload.sessionId === "-", false, "不得返回空标识（真机事故）");
  assert.deepEqual(calls.open, ["session-main"]);
  store.close();
});

test("回落链三：任务与主会话都没有 → 回落 project_sessions 最新一条未拒绝的绑定", async () => {
  const { store, t } = setup({ bound: [{ sessionId: "session-a", status: "approved" }, { sessionId: "session-b", status: "pending" }] });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.source, "project-bound");
  assert.equal(r.payload.sessionId, "session-b", "取最新一条**未被拒**的绑定（rejected 必须跳过）");
  assert.deepEqual(calls.open, ["session-b"]);
  store.close();
});

test("回落链三（筛选口径）：rejected 绑定必须跳过，只认未拒绝的最新一条", () => {
  const stub = {
    getProject: () => ({ id: "p1", initialSessionId: null }),
    listProjectSessions: () => ([
      { sessionId: "session-ok", status: "approved", createdAt: "2026-10-17T01:00:00.000Z" },
      { sessionId: "session-rejected", status: "rejected", createdAt: "2026-10-17T02:00:00.000Z" },
    ]),
  };
  const ref = resolveSessionRef(stub, { projectId: "p1", sessionId: null });
  assert.equal(ref.sessionId, "session-ok");
  assert.equal(ref.source, "project-bound");
  assert.equal(resolveSessionRef({ getProject: () => ({ id: "p1", initialSessionId: null }), listProjectSessions: () => [] }, { projectId: "p1" }).sessionId, null);
});

test("三级都无引用 → no-session / sessionId=null（前端据此走「重建主会话」而非复制空串）", async () => {
  const { store, t } = setup();
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, false);
  assert.equal(r.payload.reason, "no-session");
  assert.equal(r.payload.sessionId, null);
  assert.equal(r.payload.stale, false);
  assert.deepEqual(calls.open, [], "无引用时不得尝试打开");
  store.close();
});

test("引用已失效（exists=false）→ session-gone + stale=true，且**不尝试打开**", async () => {
  const { store, t } = setup({ main: "session-gone-1" });
  const { port, calls } = mockPort({ exists: false, openResult: { opened: true } });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, false);
  assert.equal(r.payload.reason, "session-gone");
  assert.equal(r.payload.stale, true);
  assert.equal(r.payload.sessionId, "session-gone-1");
  assert.deepEqual(calls.open, [], "已确认失效 → 不得再尝试打开");
  store.close();
});

test("存活判不准（exists=null）→ 照旧尝试打开，绝不当作失效", async () => {
  const { store, t } = setup({ main: "session-unknown" });
  const { port, calls } = mockPort({ exists: null, openResult: { opened: true } });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true, "exists=null ≠ 失效");
  assert.equal(r.payload.stale, false);
  assert.deepEqual(calls.open, ["session-unknown"]);
  store.close();
});

test("GET /api/sessions/:id/state：三态如实上报（true / false / null）", async () => {
  const { store } = setup();
  const router = createApiRouter({ store });
  for (const [exists, expect] of [[true, true], [false, false], [null, null]]) {
    store.hostSessionPort = mockPort({ exists }).port;
    const r = await router.route({ method: "GET", pathname: "/api/sessions/session-x/state", searchParams: sp() });
    assert.equal(r.status, 200);
    assert.equal(r.payload.sessionId, "session-x");
    assert.equal(r.payload.exists, expect);
  }
  store.close();
});

test("GET /api/projects/:id/sessions：每条绑定带存活徽标；主会话失效 → staleMain=true", async () => {
  const { store } = setup({ main: "session-main-gone", bound: [{ sessionId: "session-ok", status: "approved" }] });
  store.hostSessionPort = {
    available: true,
    async sessionExists(sessionId) { return { sessionId, exists: sessionId !== "session-main-gone", source: "mock" }; },
  };
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/projects/p1/sessions", searchParams: sp() });
  assert.equal(r.payload.main.sessionId, "session-main-gone");
  assert.equal(r.payload.main.liveness.exists, false);
  assert.equal(r.payload.staleMain, true, "主会话失效必须显式标出（配置页给一键重建）");
  assert.equal(r.payload.sessions[0].liveness.exists, true);
  store.close();
});

test("重建并重绑主会话：缺 confirm 不动手；带 confirm → 建会话 + 写回指针 + 投递开局提示词 + 审计", async () => {
  const { store } = setup({ main: "session-old" });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const router = createApiRouter({ store });

  const denied = await router.route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: {} });
  assert.equal(denied.payload.rebound, false);
  assert.equal(denied.payload.reason, "confirm-required");
  assert.equal(calls.created, 0, "未确认不得新建会话");
  assert.equal(store.getProject("p1").initialSessionId, "session-old");

  const ok = await router.route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } });
  assert.equal(ok.payload.rebound, true);
  assert.equal(ok.payload.before, "session-old");
  assert.equal(ok.payload.after, "session-new-1");
  assert.equal(ok.payload.openingDelivered, true);
  assert.equal(store.getProject("p1").initialSessionId, "session-new-1", "指针必须写回新会话");
  assert.equal(calls.prompt.length, 1);
  assert.match(calls.prompt[0].text, /主会话/, "必须投递 FR-61 开局提示词");
  const audit = store.listGovernanceAudit({ action: "rebind-initial-session" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].target, "p1");
  assert.match(String(audit[0].detail), /session-new-1/);
  store.close();
});

test("重建：必须把**项目工作区**作为 cwd 交给宿主（否则新会话落在 dsh 进程目录 → 归属门继续拦，形成「重建了还是打不开」的锁死）", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  const r = await createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } });
  assert.equal(r.payload.rebound, true);
  assert.equal(calls.createArgs.length, 1);
  assert.equal(calls.createArgs[0]?.cwd, "/ws/p1", "必须把项目 workspacePath 当 cwd 传下去（宿主 session.create 支持 cwd）");
  store.close();
});

test("重建：项目没有 workspacePath → 不传 cwd（交宿主默认，不臆造路径）", async () => {
  const { store } = setup({ main: "session-old" });
  const { port, calls } = mockPort();
  store.hostSessionPort = port;
  await createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } });
  assert.equal(calls.createArgs[0]?.cwd, undefined, "没有工作区就不要编一个");
  store.close();
});

test("重建：宿主不支持建会话 → 明确报错（不静默改动指针）", async () => {
  const { store } = setup({ main: "session-old" });
  store.hostSessionPort = { available: false, async sendPrompt() { return { sent: true }; } };
  await assert.rejects(
    () => createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } }),
    /宿主不支持建会话/,
  );
  assert.equal(store.getProject("p1").initialSessionId, "session-old");
  store.close();
});

test("执行详情带 sessionRef（三级回落 + 存活），前端据此渲染接续徽标", async () => {
  const { store, t } = setup({ main: "session-main" });
  store.hostSessionPort = mockPort({ exists: true }).port;
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: sp() });
  assert.equal(r.payload.sessionRef.sessionId, "session-main");
  assert.equal(r.payload.sessionRef.source, "project-main");
  assert.equal(r.payload.sessionRef.liveness.exists, true);
  store.close();
});

test("诊断设防：任务与项目都无会话引用 → 不产出「打开执行会话」，改产「重建并绑定主会话」且 suggested 指向已存在动作", () => {
  const { store, t } = setup();
  store.startTaskRun(t.identifier, { actor: "tester" });
  store.endTaskRun(t.identifier, { outcome: "crash", summary: "SIGKILL", actor: "tester" });
  store.startTaskRun(t.identifier, { actor: "tester" });
  store.endTaskRun(t.identifier, { outcome: "crash", summary: "SIGKILL again", actor: "tester" });
  const d = evaluateTaskDiagnostics(store, t.identifier).diagnostics.find((x) => x.kind === "repeated_crash");
  assert.ok(d, "应有 repeated_crash 诊断");
  const ids = d.actions.map((a) => a.id);
  assert.equal(ids.includes("open_session"), false, "无可用会话时不得产出打开动作");
  assert.equal(ids.includes("bind_session"), true, "应改产「重建并绑定主会话」");
  const bind = d.actions.find((a) => a.id === "bind_session");
  assert.equal(bind.path, "/api/projects/p1/sessions/rebind");
  assert.deepEqual(bind.body, { confirm: true });
  assert.equal(d.suggested, "bind_session", "suggested 必须指向真实存在的动作");
  assert.ok(d.actions.some((a) => a.id === d.suggested));
  store.close();
});

test("诊断设防：有可解析会话 → 正常产出「打开执行会话」，不产出重建动作", () => {
  const { store, t } = setup({ main: "session-main" });
  const ref = resolveSessionRef(store, store.requireTaskRef(t.identifier));
  assert.equal(ref.sessionId, "session-main");
  assert.equal(ref.source, "project-main");
  const crashed = [{ outcome: "crash" }, { outcome: "crash" }];
  const d = evaluateTaskDiagnostics(store, t.identifier, { runs: crashed }).diagnostics.find((x) => x.kind === "repeated_crash");
  const ids = d.actions.map((a) => a.id);
  assert.equal(ids.includes("open_session"), true);
  assert.equal(ids.includes("bind_session"), false);
  assert.equal(d.suggested, "open_session");
  store.close();
});

// ---------------------------------------------------------------------------
// FR-84 补口（2026-10-19）：**接续会话的工作区归属**
// 真机事故：本项目主会话指针被指到**另一个工作区**的 6.3 MB 会话上 → 每张卡「打开执行会话」都打开
// 别人的、巨大的会话，对话页长时间只剩输入框。故：打开前判归属，不符则**默认不打开**并明说；判不准不误拦。
// ---------------------------------------------------------------------------
const openSessionBody = (router, ref, body = {}) =>
  router.route({ method: "POST", pathname: `/api/tasks/${encodeURIComponent(ref)}/open-session`, searchParams: sp(), body });

test("FR-84 补口：会话属于本项目工作区 → 正常打开，origin.mismatch=false", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort({ originCwd: "/ws/p1" });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true);
  assert.equal(r.payload.origin.mismatch, false);
  assert.equal(r.payload.origin.projectId, "p1");
  assert.equal(r.payload.origin.cwd, "/ws/p1");
  assert.deepEqual(calls.origin, ["session-main"], "必须真的问过归属");
  store.close();
});

test("FR-84 补口：会话属于**别的工作区** → 默认不打开（session-other-workspace），openSession 不被调用", async () => {
  const { store, t } = setup({
    main: "session-main", workspacePath: "/ws/p1",
    extraProjects: [{ id: "p2", name: "P2", workspacePath: "/ws/p2" }],
  });
  const { port, calls } = mockPort({ originCwd: "/ws/p2" });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, false);
  assert.equal(r.payload.reason, "session-other-workspace");
  assert.equal(r.payload.sessionId, "session-main", "仍须回真实会话 id（不得是空串/-）");
  assert.equal(r.payload.origin.mismatch, true);
  assert.equal(r.payload.origin.projectId, "p2");
  assert.equal(r.payload.origin.projectName, "P2");
  assert.deepEqual(calls.open, [], "归属不符时不得静默打开别人的会话");
  store.close();
});

test("FR-84 补口：归属不符 + force:true → 按用户显式要求仍打开", async () => {
  const { store, t } = setup({
    main: "session-main", workspacePath: "/ws/p1",
    extraProjects: [{ id: "p2", name: "P2", workspacePath: "/ws/p2" }],
  });
  const { port, calls } = mockPort({ originCwd: "/ws/p2" });
  store.hostSessionPort = port;
  const r = await openSessionBody(createApiRouter({ store }), t.identifier, { force: true });
  assert.equal(r.payload.opened, true);
  assert.equal(r.payload.origin.mismatch, true, "放了行也必须如实标注归属不符");
  assert.deepEqual(calls.open, ["session-main"]);
  store.close();
});

test("FR-84 补口：会话 cwd 不属于任何项目 → 仍算归属不符（**不得回落成「本项目」**）", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/ws/p1" });
  const { port } = mockPort({ originCwd: "/somewhere/else" });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.reason, "session-other-workspace");
  assert.equal(r.payload.origin.mismatch, true);
  assert.equal(r.payload.origin.projectId, null, "谁都不属于 → projectId 为 null，不臆断");
  store.close();
});

test("FR-84 补口：宿主判不出 cwd → mismatch=null，不误拦（照旧打开）", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort({ originCwd: null, originSource: "unavailable" });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true, "判不准 ≠ 判定不属于 → 不得拦截");
  assert.equal(r.payload.origin.mismatch, null);
  assert.equal(r.payload.origin.cwd, null);
  store.close();
});

test("FR-84 补口：项目没有 workspacePath → mismatch=null（无从比对，不误拦）", async () => {
  const { store, t } = setup({ main: "session-main" });
  const { port } = mockPort({ originCwd: "/ws/anywhere" });
  store.hostSessionPort = port;
  const r = await openSession(createApiRouter({ store }), t.identifier);
  assert.equal(r.payload.opened, true);
  assert.equal(r.payload.origin.mismatch, null);
  store.close();
});

test("FR-84 补口：GET /execution 带 sessionRef.origin —— 前端据此渲染「接续归属」", async () => {
  const { store, t } = setup({
    main: "session-main", workspacePath: "/ws/p1",
    extraProjects: [{ id: "p2", name: "P2", workspacePath: "/ws/p2" }],
  });
  store.hostSessionPort = mockPort({ originCwd: "/ws/p2/a/sub" }).port;
  const r = await createApiRouter({ store }).route({
    method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: sp(), body: {},
  });
  assert.equal(r.payload.sessionRef.origin.mismatch, true);
  assert.equal(r.payload.sessionRef.origin.projectId, "p2", "子目录也应按最长前缀归到 p2");
  assert.equal(r.payload.sessionRef.origin.cwd, "/ws/p2/a/sub");
  store.close();
});


// ---------------------------------------------------------------------------
// FR-84 补口（2026-10-22）· **改绑已有会话**（不新建）
// 真机现场：:3080 实例未加载宿主 shim 时 createSession() 必抛错 ⇒「重建并绑定项目主会话」点不通；
// 而项目主会话指针又指着**另一个工作区**的旧会话 ⇒ 用户「从任务台回不到项目主会话」。
// 改绑路径的前提校验一条都不能省：先**探活**、再**校验工作区归属**（默认拒绝，force 才放行）。
// ---------------------------------------------------------------------------

const rebind = (router, body) => router.route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body });

test("改绑已有会话：显式 sessionId → 不新建、指针写回、审计 reason=bind-existing、默认不投递开局提示词", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort({ originCwd: "/ws/p1" });
  store.hostSessionPort = port;
  const r = await rebind(createApiRouter({ store }), { confirm: true, sessionId: "session-existing-1" });
  assert.equal(r.payload.rebound, true);
  assert.equal(r.payload.mode, "bind-existing");
  assert.equal(r.payload.before, "session-old");
  assert.equal(r.payload.after, "session-existing-1");
  assert.equal(r.payload.mismatch, false);
  assert.equal(calls.created, 0, "改绑路径**绝不能**调 createSession（那正是不可用的能力）");
  assert.equal(calls.prompt.length, 0, "已有会话默认不投递开局提示词（避免往用户历史会话里塞指令）");
  assert.equal(store.getProject("p1").initialSessionId, "session-existing-1");
  const audit = store.listGovernanceAudit({ action: "rebind-initial-session" });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].allowed, true);
  assert.match(String(audit[0].detail), /bind-existing/);
  store.close();
});

test("改绑已有会话：deliverOpening:true 时才投递 FR-61 开局提示词", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort({ originCwd: "/ws/p1" });
  store.hostSessionPort = port;
  const r = await rebind(createApiRouter({ store }), { confirm: true, sessionId: "session-existing-1", deliverOpening: true });
  assert.equal(r.payload.openingDelivered, true);
  assert.equal(calls.prompt.length, 1);
  assert.match(calls.prompt[0].text, /主会话/);
  store.close();
});

test("改绑已有会话：必须探活 —— 本机不存在的会话不让绑（指针不得被改成死指针）", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  const { port } = mockPort({ exists: false, originCwd: "/ws/p1" });
  store.hostSessionPort = port;
  await assert.rejects(
    () => rebind(createApiRouter({ store }), { confirm: true, sessionId: "session-gone-x" }),
    (e) => e.code === "SESSION_NOT_FOUND",
  );
  assert.equal(store.getProject("p1").initialSessionId, "session-old", "拒绝时不得改动指针");
  store.close();
});

test("改绑已有会话：归属门默认拒绝跨工作区会话（这正是要修的病根），force 才放行", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  const { port } = mockPort({ originCwd: "/ws/other-project" });
  store.hostSessionPort = port;
  const router = createApiRouter({ store });
  await assert.rejects(
    () => rebind(router, { confirm: true, sessionId: "session-foreign" }),
    (e) => e.code === "SESSION_OTHER_WORKSPACE",
  );
  assert.equal(store.getProject("p1").initialSessionId, "session-old");
  const forced = await rebind(router, { confirm: true, sessionId: "session-foreign", force: true });
  assert.equal(forced.payload.rebound, true);
  assert.equal(forced.payload.mismatch, true);
  assert.equal(store.getProject("p1").initialSessionId, "session-foreign");
  const audit = store.listGovernanceAudit({ action: "rebind-initial-session" });
  assert.match(String(audit[0].detail), /"mismatch":true/);
  store.close();
});

test("改绑已有会话：项目未设工作区 / 归属判不准 → 不误拦（mismatch=false）", async () => {
  const a = setup({ main: "session-old" });
  a.store.hostSessionPort = mockPort({ originCwd: "/ws/whatever" }).port;
  const ra = await rebind(createApiRouter({ store: a.store }), { confirm: true, sessionId: "session-x" });
  assert.equal(ra.payload.mismatch, false, "项目没有 workspacePath 时不得凭 cwd 臆断不符");
  a.store.close();

  const b = setup({ main: "session-old", workspacePath: "/ws/p1" });
  b.store.hostSessionPort = mockPort({ originCwd: null }).port;
  const rb = await rebind(createApiRouter({ store: b.store }), { confirm: true, sessionId: "session-y" });
  assert.equal(rb.payload.mismatch, false, "归属判不准（cwd=null）不得当成不符");
  b.store.close();
});

test("改绑已有会话：仍需 confirm（未确认不得改动指针）", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/ws/p1" });
  store.hostSessionPort = mockPort({ originCwd: "/ws/p1" }).port;
  const r = await rebind(createApiRouter({ store }), { sessionId: "session-existing-1" });
  assert.equal(r.payload.rebound, false);
  assert.equal(r.payload.reason, "confirm-required");
  assert.equal(store.getProject("p1").initialSessionId, "session-old");
  store.close();
});

test("候选会话端点：按项目工作区过滤 + 标注当前主会话 + 带存活徽标", async () => {
  const { store } = setup({ main: "session-mine", workspacePath: "/ws/p1" });
  const { port, calls } = mockPort({
    originCwd: "/ws/p1",
    hostSessions: [
      { sessionId: "session-mine", cwd: "/ws/p1", title: "本项目会话", updatedAt: "2026-10-22T01:00:00.000Z" },
      { sessionId: "session-other", cwd: "/ws/other", title: "别家会话", updatedAt: "2026-10-22T02:00:00.000Z" },
    ],
  });
  store.hostSessionPort = port;
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/projects/p1/sessions/candidates", searchParams: sp() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.workspacePath, "/ws/p1");
  assert.equal(r.payload.candidates.length, 1, "只列本工作区的会话");
  assert.equal(r.payload.candidates[0].sessionId, "session-mine");
  assert.equal(r.payload.candidates[0].isCurrent, true);
  assert.equal(r.payload.candidates[0].title, "本项目会话");
  assert.equal(r.payload.candidates[0].liveness.exists, true);
  assert.deepEqual(calls.listed, ["/ws/p1"], "过滤必须下推到宿主（不把全量会话拉回前端）");
  store.close();
});

test("候选会话端点：宿主不支持列会话 → 如实回 source=unavailable（不假装没有会话）", async () => {
  const { store } = setup({ main: "session-mine", workspacePath: "/ws/p1" });
  store.hostSessionPort = { available: true, async sessionExists() { return { exists: true }; } };
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/projects/p1/sessions/candidates", searchParams: sp() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.source, "unavailable");
  assert.equal(r.payload.reason, "host-cannot-list-sessions");
  assert.deepEqual(r.payload.candidates, []);
  store.close();
});

test("候选会话端点：宿主列会话**失败** → 透出原因（不得把故障说成「暂无会话」）", async () => {
  const { store } = setup({ main: "session-mine", workspacePath: "/ws/p1" });
  store.hostSessionPort = {
    available: true,
    async sessionExists() { return { exists: true }; },
    async listSessions() { return { sessions: [], source: "error", reason: "list-failed:EACCES" }; },
  };
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: "/api/projects/p1/sessions/candidates", searchParams: sp() });
  assert.equal(r.status, 200);
  assert.equal(r.payload.source, "error");
  assert.equal(r.payload.reason, "list-failed:EACCES", "失败原因必须原样透出，供前端与排障使用");
  assert.deepEqual(r.payload.candidates, []);
  store.close();
});

// ---------------- FR-84 补口（2026-10-23）：任务级接续会话改指 + 建会话后工作区校验 ----------------
// 真机病根：任务级 `session_id` 落在别的工作区（实测 `cwd="/"`）时，抽屉一直报归属门，
// 而「重建并绑定项目主会话」**只改项目指针、改不动任务级引用** ⇒ 用户按提示重建完仍是同一句话。

const rebindTask = (router, ref, body) =>
  router.route({ method: "POST", pathname: `/api/tasks/${ref}/session/rebind`, searchParams: sp(), body });

test("任务级改指：改指到项目主会话成功 —— 只改任务引用，不动状态、不新建会话", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/w/p1", taskSession: "session-foreign" });
  const { port, calls } = mockPort({ originCwd: "/w/p1" });
  store.hostSessionPort = port;
  const before = store.getTaskById(t.id);
  const r = await rebindTask(createApiRouter({ store }), t.identifier, { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(r.payload.rebound, true);
  assert.equal(r.payload.before, "session-foreign");
  assert.equal(r.payload.after, "session-main");
  const after = store.getTaskById(t.id);
  assert.equal(after.sessionId, "session-main");
  assert.equal(after.status, before.status, "改指不得改状态");
  assert.equal(after.version, before.version + 1, "改指要推进版本（供并发校验）");
  assert.equal(store.listGovernanceAudit({ action: "rebind-task-session" }).length, 1, "必须写审计");
  assert.equal(calls.created, 0, "改指不新建会话");
});

test("任务级改指：缺 confirm 不动手（如实回 confirm-required）", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/w/p1", taskSession: "session-foreign" });
  store.hostSessionPort = mockPort({ originCwd: "/w/p1" }).port;
  const r = await rebindTask(createApiRouter({ store }), t.identifier, {});
  assert.equal(r.payload.rebound, false);
  assert.equal(r.payload.reason, "confirm-required");
  assert.equal(store.getTaskById(t.id).sessionId, "session-foreign");
});

test("任务级改指：目标会话属于别的工作区 → 拒绝（SESSION_OTHER_WORKSPACE），任务引用不动", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/w/p1", taskSession: "session-foreign" });
  store.hostSessionPort = mockPort({ originCwd: "/" }).port;
  await assert.rejects(
    () => rebindTask(createApiRouter({ store }), t.identifier, { confirm: true }),
    (e) => e.code === "SESSION_OTHER_WORKSPACE",
  );
  assert.equal(store.getTaskById(t.id).sessionId, "session-foreign", "拒绝时不得改指");
});

test("任务级改指：目标会话本机不存在 → SESSION_NOT_FOUND", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/w/p1", taskSession: "session-foreign" });
  store.hostSessionPort = mockPort({ exists: false, originCwd: "/w/p1" }).port;
  await assert.rejects(
    () => rebindTask(createApiRouter({ store }), t.identifier, { confirm: true }),
    (e) => e.code === "SESSION_NOT_FOUND",
  );
  assert.equal(store.getTaskById(t.id).sessionId, "session-foreign");
});

test("任务级改指：项目还没有主会话 → NO_PROJECT_MAIN_SESSION（不臆造目标）", async () => {
  const { store, t } = setup({ workspacePath: "/w/p1", taskSession: "session-foreign" });
  store.hostSessionPort = mockPort({ originCwd: "/w/p1" }).port;
  await assert.rejects(
    () => rebindTask(createApiRouter({ store }), t.identifier, { confirm: true }),
    (e) => e.code === "NO_PROJECT_MAIN_SESSION",
  );
});

test("重建主会话：宿主建出的会话落在别的工作区 → 如实失败（SESSION_WORKSPACE_MISMATCH）且**不写回指针**", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/w/p1" });
  const { port, calls } = mockPort({ originCwd: "/" });
  store.hostSessionPort = port;
  await assert.rejects(
    () => createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } }),
    (e) => e.code === "SESSION_WORKSPACE_MISMATCH",
  );
  assert.equal(calls.created, 1, "建会话确实发生过");
  assert.equal(store.getProject("p1").initialSessionId, "session-old", "工作区不符时**不得**静默错绑");
});

test("重建主会话：工作区相符时照旧成功（新校验不误拦）", async () => {
  const { store } = setup({ main: "session-old", workspacePath: "/w/p1" });
  store.hostSessionPort = mockPort({ originCwd: "/w/p1" }).port;
  const r = await createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } });
  assert.equal(r.payload.rebound, true);
  assert.equal(store.getProject("p1").initialSessionId, "session-new-1");
});

test("execution 端点：任务级引用落在别的工作区 → 附 projectMain（工作区正确的那个），供前端给出**有效**动作", async () => {
  const { store, t } = setup({ main: "session-main", workspacePath: "/w/p1", taskSession: "session-bad" });
  store.hostSessionPort = {
    available: true,
    async sessionExists(id) { return { sessionId: id, exists: true, source: "mock" }; },
    async sessionState() { return null; },
    async sessionOrigin(id) { return { sessionId: id, cwd: id === "session-bad" ? "/" : "/w/p1", source: "mock" }; },
  };
  const r = await createApiRouter({ store }).route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: sp(), body: null });
  const ref = r.payload.sessionRef;
  assert.equal(ref.sessionId, "session-bad");
  assert.equal(ref.origin.mismatch, true);
  assert.ok(ref.projectMain, "工作区不符时必须附项目主会话信息（否则前端只能给出无效指引）");
  assert.equal(ref.projectMain.sessionId, "session-main");
  assert.equal(ref.projectMain.origin.mismatch, false);
});

test("GET /api/context：带 session 时如实带出本会话的工作区归属（供「新开 dsh」实例工作区预检）", async () => {
  const { store } = setup({ main: "session-main", workspacePath: "/w/p1" });
  store.hostSessionPort = {
    available: true,
    async sessionOrigin(id) { return { sessionId: id, cwd: id === "session-here" ? "/w/p1" : "/", source: "mock" }; },
  };
  const router = createApiRouter({ store });
  const here = await router.route({ method: "GET", pathname: "/api/context", searchParams: sp("session=session-here&project=p1"), body: null });
  assert.equal(here.payload.sessionOrigin.cwd, "/w/p1");
  assert.equal(here.payload.sessionOrigin.mismatch, false);
  const elsewhere = await router.route({ method: "GET", pathname: "/api/context", searchParams: sp("session=session-elsewhere&project=p1"), body: null });
  assert.equal(elsewhere.payload.sessionOrigin.mismatch, true, "实例工作在别处 → 预检必须报不一致（别让用户走「重建还是不对」的弯路）");
  const noSession = await router.route({ method: "GET", pathname: "/api/context", searchParams: sp("project=p1"), body: null });
  assert.equal(noSession.payload.sessionOrigin, null, "没有会话就不臆断实例工作区");
});
