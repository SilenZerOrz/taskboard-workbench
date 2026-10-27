/** 工作区↔项目↔需求绑定 + taskboard_* 工具（反向链路：认领/反馈）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { resolveProjectForCwd, resolveContext } from "../src/core/binding.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "taskboard-workbench", name: "TW", workspacePath: "/repo/tw" });
  store.createProject({ id: "default", name: "默认项目", workspacePath: null });
  const item = store.createRequirementItem({ projectId: "taskboard-workbench", title: "需求A" });
  return { store, item };
}
// 用假 registry 捕获工具定义，再直接调用 execute
function surface(store) {
  const defs = new Map();
  registerTaskboardTools({ store, tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  return { call: (name, args, exec) => defs.get(name).execute(args ?? {}, exec ?? {}), names: [...defs.keys()] };
}
// 宿主 tools 服务校验 JSON-schema 子集（dsh-tools/json-schema）：type 只能是这些之一。
const HOST_SCHEMA_TYPES = ["object", "array", "string", "number", "integer", "boolean", "null"];

test("工具面 schema 合法：output.schema.type 属于宿主允许的类型（否则注册失败）", () => {
  const defs = new Map();
  registerTaskboardTools({ store: openStore({ dbPath: ":memory:" }), tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  for (const [name, def] of defs) {
    assert.ok(HOST_SCHEMA_TYPES.includes(def.output?.schema?.type), `${name} 的 output.schema.type 非法：${def.output?.schema?.type}`);
  }
  assert.equal(defs.size, 9);
});

test("绑定：workspacePath 最长前缀 → 项目；无匹配 → 默认项目；需求文档自动建立", () => {
  const { store } = setup();
  assert.equal(resolveProjectForCwd(store, "/repo/tw/sub").id, "taskboard-workbench");
  assert.equal(resolveProjectForCwd(store, "/repo/tw").id, "taskboard-workbench");
  assert.equal(resolveProjectForCwd(store, "/elsewhere").id, "default");
  const ctx = resolveContext(store, "/repo/tw");
  assert.equal(ctx.project.id, "taskboard-workbench");
  assert.ok(ctx.requirementDoc && ctx.requirementDoc.version >= 1);
  store.close();
});

test("工具面：注册 9 个 taskboard_* ；context/list/requirements 只读可用", async () => {
  const { store } = setup();
  const s = surface(store);
  assert.deepEqual(s.names.sort(), ["taskboard_claim_task","taskboard_comment","taskboard_context","taskboard_create_task","taskboard_get_task","taskboard_heartbeat","taskboard_list_requirements","taskboard_list_tasks","taskboard_update_status"]);
  const c = await s.call("taskboard_context", { cwd: "/repo/tw" });
  assert.equal(c.project.id, "taskboard-workbench");
  const r = await s.call("taskboard_list_requirements", { project: "taskboard-workbench" });
  assert.equal(r.count, 1);
  store.close();
});

test("认领/反馈：claim 写归属到 exec.agent.id；backlog 不得认领；done 被治理拒绝", async () => {
  const { store, item } = setup();
  const s = surface(store);
  const t = store.createTask({ projectId: "taskboard-workbench", title: "实现", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const claimed = await s.call("taskboard_claim_task", { ref: t.identifier }, { agent: { id: "sess-1" } });
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.sessionId, "sess-1");
  await s.call("taskboard_comment", { ref: t.identifier, body: "已开始，计划 X" });
  assert.ok(store.listComments(t.id).some((x) => x.body.includes("计划 X")));
  const reviewed = await s.call("taskboard_update_status", { ref: t.identifier, status: "in_review" }, { agent: { id: "sess-1" } });
  assert.equal(reviewed.status, "in_review");
  await assert.rejects(() => s.call("taskboard_update_status", { ref: t.identifier, status: "done" }, { agent: { id: "sess-1" } }), (e) => e.code === "GOVERNANCE_AGENT_DONE");
  const backlog = store.createTask({ projectId: "taskboard-workbench", title: "未授权" });
  store.associateRequirementTask(item.id, backlog.id);
  await assert.rejects(() => s.call("taskboard_claim_task", { ref: backlog.identifier }, { agent: { id: "sess-2" } }), (e) => e.code === "EXECUTION_NOT_AUTHORIZED");
  store.close();
});

// FR-29：会话中创建任务并回流。三条验收要点各一条断言：① 编号可引用、看板可见；② 改状态同步；③ 落默认项目有明确提示。
test("FR-29 create：cwd 命中项目 → 落到该项目 + 返回可引用编号（backlog，不越授权）", async () => {
  const { store } = setup();
  const s = surface(store);
  const r = await s.call("taskboard_create_task", { title: "会话里顺手指派", cwd: "/repo/tw/src" }, { agent: { id: "sess-1" } });
  assert.equal(r.project.id, "taskboard-workbench");
  assert.equal(r.matchedBy, "cwd");
  assert.equal(r.fallback, false);
  assert.equal(r.status, "backlog");            // 执行侧建卡不得自授开工
  assert.match(r.identifier, /^taskboard-workbench-\d+$/);
  // ① 看板可见 + 编号可引用：list 能查到、get 能按编号取回同一张
  const listed = await s.call("taskboard_list_tasks", { cwd: "/repo/tw" });
  assert.ok(listed.tasks.some((t) => t.identifier === r.identifier));
  const got = await s.call("taskboard_get_task", { ref: r.identifier });
  assert.equal(got.task.title, "会话里顺手指派");
  store.close();
});

test("FR-29 create：cwd 无法匹配 → 回落默认项目 + 返回里明确提示（不得静默）", async () => {
  const { store } = setup();
  const s = surface(store);
  const r = await s.call("taskboard_create_task", { title: "落默认", cwd: "/tmp/elsewhere" }, { agent: { id: "sess-1" } });
  assert.equal(r.project.id, "default");
  assert.equal(r.matchedBy, "fallback");
  assert.equal(r.fallback, true);
  assert.match(r.hint, /未匹配任何项目/);
  assert.match(r.hint, /默认项目/);
  store.close();
});

test("FR-29 create：显式 project 覆盖 cwd；条目跨项目时如实报错", async () => {
  const { store } = setup();
  const s = surface(store);
  const forced = await s.call("taskboard_create_task", { title: "显式", project: "default", cwd: "/repo/tw" }, { agent: { id: "sess-1" } });
  assert.equal(forced.project.id, "default");
  assert.equal(forced.matchedBy, "explicit");
  const other = store.createProject({ id: "other", name: "其它", workspacePath: "/repo/other" });
  assert.ok(other);
  const item = store.createRequirementItem({ projectId: "other", title: "他项目条目" });
  await assert.rejects(
    () => s.call("taskboard_create_task", { title: "跨项目归因", project: "default", requirement: item.identifier }, { agent: { id: "sess-1" } }),
    (e) => e.code === "DEPENDENCY_CROSS_PROJECT",
  );
  store.close();
});

test("FR-29 create：可带条目归因（省一次归因门）；标题缺失如实报错", async () => {
  const { store, item } = setup();
  const s = surface(store);
  const r = await s.call("taskboard_create_task", { title: "带归因", cwd: "/repo/tw", requirement: item.identifier }, { agent: { id: "sess-1" } });
  assert.equal(r.requirementId, item.id);
  assert.ok(store.getTaskRef(r.identifier).requirementId);
  await assert.rejects(() => s.call("taskboard_create_task", { title: "  ", cwd: "/repo/tw" }, { agent: { id: "sess-1" } }), (e) => e.code === "INVALID_FIELD");
  store.close();
});

test("FR-29 回流②：会话里改状态（经由 update_status）→ 看板取数同步变化", async () => {
  const { store, item } = setup();
  const s = surface(store);
  const created = await s.call("taskboard_create_task", { title: "改状态", cwd: "/repo/tw", requirement: item.identifier }, { agent: { id: "sess-1" } });
  // backlog 不得执行 ⇒ 先由人授权开工（todo），会话再认领 → 待验收
  store.updateTask(created.identifier, { status: "todo", expectedVersion: store.getTaskRef(created.identifier).version, actor: "human" });
  await s.call("taskboard_claim_task", { ref: created.identifier }, { agent: { id: "sess-1" } });
  await s.call("taskboard_update_status", { ref: created.identifier, status: "in_review" }, { agent: { id: "sess-1" } });
  const onBoard = store.listTasks({ projectId: "taskboard-workbench" }).find((t) => t.identifier === created.identifier);
  assert.equal(onBoard.status, "in_review"); // 看板取数看到的即最新状态
  store.close();
});

test("FR-29 红线继承：新建的 backlog 卡不得被会话认领；done 仍被治理拒绝", async () => {
  const { store, item } = setup();
  const s = surface(store);
  const r = await s.call("taskboard_create_task", { title: "未授权", cwd: "/repo/tw", requirement: item.identifier }, { agent: { id: "sess-1" } });
  await assert.rejects(() => s.call("taskboard_claim_task", { ref: r.identifier }, { agent: { id: "sess-1" } }), (e) => e.code === "EXECUTION_NOT_AUTHORIZED");
  await assert.rejects(() => s.call("taskboard_update_status", { ref: r.identifier, status: "done" }, { agent: { id: "sess-1" } }), (e) => e.code === "GOVERNANCE_AGENT_DONE");
  store.close();
});

test("/api/context：工作区→项目→需求文档", async () => {
  const { store } = setup();
  const { createApiRouter } = await import("../src/server/api.mjs");
  const router = createApiRouter({ store });
  const res = await router.route({ method: "GET", pathname: "/api/context", searchParams: new URLSearchParams({ cwd: "/repo/tw/x" }) });
  assert.equal(res.status, 200);
  assert.equal(res.payload.project.id, "taskboard-workbench");
  assert.ok(res.payload.requirementDoc?.id);
  store.close();
});

test("FR-60 /api/context：session= 绑定项目初始会话；首次绑定后不再改写", async () => {
  const { store } = setup();
  const { createApiRouter } = await import("../src/server/api.mjs");
  const router = createApiRouter({ store });
  const at = (session) => router.route({ method: "GET", pathname: "/api/context", searchParams: new URLSearchParams({ cwd: "/repo/tw", session }) });
  const first = await at("sess-alpha");
  assert.equal(first.payload.project.initialSessionId, "sess-alpha");
  const second = await at("sess-beta");
  assert.equal(second.payload.project.initialSessionId, "sess-alpha"); // 不被后续会话改写
  assert.equal(second.payload.session, "sess-beta");
  store.close();
});

test("FR-62 全局入口：默认进入近期有任务活动的项目", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "alpha", name: "Alpha" });
  store.createProject({ id: "beta", name: "Beta" });
  store.createTask({ projectId: "beta", title: "最近活动" });
  const { createApiRouter } = await import("../src/server/api.mjs");
  const router = createApiRouter({ store });
  const res = await router.route({ method: "GET", pathname: "/api/context", searchParams: new URLSearchParams() });
  assert.equal(res.payload.project.id, "beta");
  store.close();
});

test("FR-63 会话关联：申请=待批准(未绑定)；主会话批准=已绑定", async () => {
  const { store } = setup();
  const { createApiRouter } = await import("../src/server/api.mjs");
  const router = createApiRouter({ store });
  const ctxAt = (session) => router.route({ method: "GET", pathname: "/api/context", searchParams: new URLSearchParams({ cwd: "/repo/tw", session }) });
  const post = (pathname, body) => router.route({ method: "POST", pathname, searchParams: new URLSearchParams(), body });

  const main = await ctxAt("sess-main");         // 首个进入者成为主会话
  assert.equal(main.payload.project.initialSessionId, "sess-main");
  assert.equal(main.payload.sessionBound, true);

  const other = await ctxAt("sess-other");       // 未绑定 → 不显示数据
  assert.equal(other.payload.sessionBound, false);
  assert.equal(other.payload.mainSessionId, "sess-main");

  await post("/api/projects/taskboard-workbench/sessions/request", { sessionId: "sess-other" });
  const pending = await ctxAt("sess-other");
  assert.equal(pending.payload.sessionBound, false);
  assert.equal(pending.payload.association, "pending");

  await post("/api/projects/taskboard-workbench/sessions/approve", { sessionId: "sess-other" });
  const approved = await ctxAt("sess-other");
  assert.equal(approved.payload.sessionBound, true);
  assert.equal(approved.payload.association, "associated");
  store.close();
});

test("FR-60/63 /api/context：session 归属优先于 cwd（避免误落其它项目）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "proj-a", name: "A", workspacePath: "/repo/a" });
  store.createProject({ id: "proj-b", name: "B", workspacePath: "/repo/b" });
  store.bindInitialSession("proj-b", "sess-b-main");
  const { createApiRouter } = await import("../src/server/api.mjs");
  const router = createApiRouter({ store });
  // cwd 指向 proj-a，但该会话是 proj-b 的主会话 → 必须解析到 proj-b（而不是 proj-a）
  const res = await router.route({ method: "GET", pathname: "/api/context", searchParams: new URLSearchParams({ cwd: "/repo/a", session: "sess-b-main" }) });
  assert.equal(res.payload.project.id, "proj-b");
  assert.equal(res.payload.sessionBound, true);
  store.close();
});
