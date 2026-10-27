/**
 * FR-50 验收（质量门顺序）：**模板装配的 `qualityGates` 驱动派发指令里的质量门链**。
 *
 * 落点：
 *   · 纯函数 `normalizeQualityGates` / `assertQualityGates`（`src/core/team.mjs`）—— 解析与合法性；
 *   · `buildTeamDirective`（`src/host/team-engine.mjs`）—— 用配置值渲染质量门链；
 *   · 建队门 `POST /api/teams`（`src/server/api.mjs`）—— 已配置但越界 ⇒ 拒绝（`quality-gate-unknown`）。
 *
 * FR-50 残留（卡 `taskboard-workbench-157`）另两处落点，同文件续验：
 *   · `directiveFor`（`src/core/loop.mjs`）—— **执行循环**派发指令也按配置渲染门链并注明来源；
 *   · `PUT|POST /api/projects/:id/settings`（`src/server/api.mjs`）—— 保存前过同一道模板门，
 *     非法门 ⇒ 拒绝且**不落盘**（保存前后设置逐字不变）。
 *
 * 钉死四件事（对应 2026-10-26 裁定「选项 A」的验收 GWT）：
 *   ① 合法 `qualityGates` ⇒ 指令里的门链**逐项等于配置顺序**（不是硬编码串）；
 *   ② 取值不在契约集合内 ⇒ 校验**拒绝**，`details.reason === "quality-gate-unknown"`；
 *   ③ **未配置 ⇒ 放行**（向后兼容），并回落默认链、指令注明来源「默认」；
 *   ④ 已配置 ⇒ 指令注明来源「配置」；拒绝时**零副作用**（无 team_run 落库）。
 *
 * 契约集合来源：`spec/团队agent.md` §二 第 4 项（默认 `需求→实现→验证→审查→集成`）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { assertTeamTemplate, normalizeQualityGates, QUALITY_GATES } from "../src/core/team.mjs";
import { buildTeamDirective, createTeamEnginePort } from "../src/host/team-engine.mjs";
import { runExecutionLoop } from "../src/core/loop.mjs";

const DEFAULT_CHAIN = "需求→实现→验证→审查→集成";

// ---------------- 纯函数：解析与合法性 ----------------

test("FR-50 质量门：未配置（undefined / null / 空数组）⇒ 回落默认链，source=default", () => {
  for (const tpl of [{}, { qualityGates: undefined }, { qualityGates: null }, { qualityGates: [] }]) {
    const r = normalizeQualityGates(tpl);
    assert.deepEqual(r.gates, [...QUALITY_GATES]);
    assert.equal(r.source, "default");
    assert.equal(r.gates.join("→"), DEFAULT_CHAIN);
  }
});

test("FR-50 质量门：已配置 ⇒ 顺序**完全等于数组声明顺序**（不去重 / 不重排）", () => {
  const r = normalizeQualityGates({ qualityGates: ["验证", "需求", "审查"] });
  assert.deepEqual(r.gates, ["验证", "需求", "审查"], "顺序必须逐项照抄配置，不得重排成契约默认序");
  assert.equal(r.source, "configured");
});

test("FR-50 质量门：条目两端空白被 trim（宽容），非字符串条目不被静默吞掉", () => {
  assert.deepEqual(normalizeQualityGates({ qualityGates: [" 需求 ", "实现"] }).gates, ["需求", "实现"]);
  assert.deepEqual(normalizeQualityGates({ qualityGates: [42] }).gates, [42]);
});

test("FR-50 质量门：已配置但取值越界 ⇒ INVALID_TEAM_TEMPLATE（reason=quality-gate-unknown，details.allowed 给出合法集）", () => {
  const tpl = { roles: [{ role: "engineer" }], qualityGates: ["需求", "上线"] };
  assert.throws(() => assertTeamTemplate(tpl), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "quality-gate-unknown");
    assert.equal(e.details.gate, "上线");
    assert.deepEqual(e.details.allowed, [...QUALITY_GATES]);
    return true;
  });
  // 非字符串取值同样越界（不猜、不放过）
  assert.throws(() => assertTeamTemplate({ roles: ["engineer"], qualityGates: [42] }), (e) => e.details.reason === "quality-gate-unknown");
});

test("FR-50 质量门：未配置 ⇒ assertTeamTemplate 放行（向后兼容，老模板不受影响）", () => {
  assert.deepEqual(assertTeamTemplate({ roles: [{ role: "engineer" }] }), [{ role: "engineer", count: 1 }]);
  assert.deepEqual(assertTeamTemplate({ roles: [{ role: "engineer" }], qualityGates: [] }), [{ role: "engineer", count: 1 }]);
});

// ---------------- 派发指令：按配置渲染门链 ----------------

test("FR-50 质量门：合法配置 ⇒ 指令门链逐项等于配置顺序（非硬编码串）", () => {
  const d = buildTeamDirective({ teamId: "t1", members: ["engineer"], qualityGates: ["验证", "需求"] }, "official");
  assert.ok(d.includes("质量门（配置）：验证→需求"), `指令须按配置顺序渲染门链，实得：\n${d}`);
  assert.ok(!d.includes(DEFAULT_CHAIN), "已配置时不得再出现默认硬编码链");
});

test("FR-50 质量门：未配置 ⇒ 指令回落默认链并注明来源「默认」", () => {
  for (const engine of ["official", "instruction", "nanmicoder"]) {
    const d = buildTeamDirective({ teamId: "t1", qualityGates: null }, engine);
    assert.ok(d.includes(`质量门（默认）：${DEFAULT_CHAIN}`), `${engine} 引擎未配置时应回落默认链并注明来源，实得：\n${d}`);
  }
});

// ---------------- 建队门：拒绝 + 零副作用 ----------------

test("FR-50 质量门：项目模板里 qualityGates 越界 ⇒ 建队被拒，且不留下孤儿 team_run / 锁", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["需求", "上线"] } });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const t = store.createTask({ projectId: "demo", title: "目标", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  await assert.rejects(
    () => router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body: { targetTask: t.id, tasks: [t.id], members: [{ role: "engineer" }] } }),
    (e) => { assert.equal(e.code, "INVALID_TEAM_TEMPLATE"); assert.equal(e.details.reason, "quality-gate-unknown"); return true; },
  );
  assert.equal(store.listTeamRuns({}).length, 0, "被拒的建队不得留下 team_run");
  assert.equal(store.getTaskLock(t.identifier), null, "被拒的建队不得留下任务级锁");
  store.close();
});

test("FR-50 质量门：合法配置 ⇒ 建队 201，且**派发指令**按配置顺序渲染门链（端到端）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["验证", "需求", "审查"] } });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const t = store.createTask({ projectId: "demo", title: "目标", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body: { targetTask: t.id, tasks: [t.id] } });
  assert.equal(res.status, 201);
  assert.ok(String(res.payload.draft?.directive ?? "").includes("质量门（配置）：验证→需求→审查"), `实得：\n${res.payload.draft?.directive}`);
  store.close();
});

// ---------------- 残留①：执行循环派发指令（loop.mjs#directiveFor） ----------------

/** 建一个"可被执行循环派发"的最小项目：一条已归因的 todo 任务。 */
function loopSetup(projectId = "demo") {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: projectId, name: "Demo" });
  const item = store.createRequirementItem({ projectId, title: "需求A" });
  const t = store.createTask({ projectId, title: "目标", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, task: t };
}

test("FR-50 残留·循环指令：配置 qualityGates ⇒ 执行循环派发指令的**门链逐项同序**（非硬编码）", async () => {
  const { store, task } = loopSetup();
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["验证", "需求", "实现"] } });
  const r = await runExecutionLoop({ store, projectId: "demo" });
  assert.equal(r.dispatched.length, 1, "任务应被派发");
  const directive = String(r.dispatched[0].directive ?? "");
  assert.ok(directive.includes("质量门（配置）：验证→需求→实现"), `门链须逐项等于配置声明顺序，实得：\n${directive}`);
  assert.ok(!directive.includes(DEFAULT_CHAIN), "已配置时不得再出现默认硬编码链");
  assert.equal(store.requireTaskRef(task.identifier).status, "in_progress");
  store.close();
});

test("FR-50 残留·循环指令：未配置 qualityGates ⇒ 回落默认链并注明来源「默认」", async () => {
  const { store } = loopSetup();
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer" }] } });
  const r = await runExecutionLoop({ store, projectId: "demo" });
  const directive = String(r.dispatched[0]?.directive ?? "");
  assert.ok(directive.includes(`质量门（默认）：${DEFAULT_CHAIN}`), `未配置须回落默认链并注明来源，实得：\n${directive}`);
  store.close();
});

// ---------------- 残留②：设置保存校验（PUT /api/projects/:id/settings） ----------------

test("FR-50 残留·设置 PUT：已配置但越界的门 ⇒ 拒绝（quality-gate-unknown）且**设置未被修改**", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  // 基线：先存一份**合法**设置（roles + 合法质量门）
  await call("PUT", "/api/projects/demo/settings", { teamTemplate: { engine: "instruction", roles: [{ role: "engineer" }], qualityGates: ["需求", "实现"] } });
  const before = await call("GET", "/api/projects/demo/settings");

  await assert.rejects(
    () => call("PUT", "/api/projects/demo/settings", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["不存在的门"] } }),
    (e) => { assert.equal(e.code, "INVALID_TEAM_TEMPLATE"); assert.equal(e.details.reason, "quality-gate-unknown"); return true; },
  );
  const after = await call("GET", "/api/projects/demo/settings");
  assert.deepEqual(after.payload, before.payload, "被拒的保存不得改动任何设置（逐字不变）");
  // 只改 engine、roles 未传但带越界门 ⇒ 同样拒绝（不得借"未传 roles"绕过质量门校验）
  await assert.rejects(
    () => call("PUT", "/api/projects/demo/settings", { teamTemplate: { engine: "official", qualityGates: ["上线"] } }),
    (e) => e.details?.reason === "quality-gate-unknown",
  );
  assert.deepEqual((await call("GET", "/api/projects/demo/settings")).payload, before.payload);
  store.close();
});

test("FR-50 残留·设置 PUT：合法 qualityGates ⇒ 保存成功，且 GET 回读**同序**", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  const saved = await call("PUT", "/api/projects/demo/settings", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["验证", "需求", "集成"] } });
  assert.equal(saved.status, 200);
  const back = await call("GET", "/api/projects/demo/settings");
  assert.deepEqual(back.payload.teamTemplate.qualityGates, ["验证", "需求", "集成"], "回读顺序必须与写入一致");
  store.close();
});

// ---------------- 补口（2026-10-27）：端口路径（nanmicoder / 退路）也不得丢门链 ----------------

test("FR-50 补口·端口路径：`createTeamEnginePort` 的 P2 指令按配置渲染门链（与建队/循环同口径）", async () => {
  const port = createTeamEnginePort({ mode: "instruction" }); // 无宿主服务 ⇒ 只产指令，不建会话
  const r = await port.createDraft({ teamId: "t1", targetTask: "demo-1", qualityGates: ["验证", "需求"] });
  const directive = String(r.draft?.directive ?? "");
  assert.ok(directive.includes("质量门（配置）：验证→需求"), `端口路径须渲染配置门链，实得：\n${directive}`);
  assert.ok(!directive.includes(DEFAULT_CHAIN), "已配置时不得再出现默认硬编码链");

  const dflt = await port.createDraft({ teamId: "t2", targetTask: "demo-2" });
  assert.ok(String(dflt.draft?.directive ?? "").includes(`质量门（默认）：${DEFAULT_CHAIN}`), "未配置须回落默认链并注明来源");
});

test("FR-50 补口·建队端口：`POST /api/teams` 把**已校验**的 qualityGates 原样传给 `teamEnginePort.createDraft`", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["验证", "需求"] } });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const t = store.createTask({ projectId: "demo", title: "目标", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  let captured = null;
  store.teamEnginePort = {
    mode: "nanmicoder",
    async createDraft(input) {
      captured = input;
      return { mode: "nanmicoder", draft: { directive: "stub" }, sessionId: null, presetApplied: null };
    },
  };
  const router = createApiRouter({ store });
  const res = await router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body: { targetTask: t.id, tasks: [t.id] } });
  assert.equal(res.status, 201);
  assert.deepEqual(captured?.qualityGates, ["验证", "需求"], "端口路径必须拿到与建队门同一份已校验配置");
  store.close();
});
