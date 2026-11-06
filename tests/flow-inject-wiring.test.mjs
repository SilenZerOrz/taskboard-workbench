/**
 * 开局注入 · **接线面**（P5 档 C · 卡 `-210`）—— 验收 ①②③⑤ 的端到端部分。
 *
 * 三处接线各测一遍，且都**不碰 `:3080`**：
 *   A 宿主 `createSession()` 出口（`index.js`）：`main-only` 只注主会话 / 执行会话不注 / `off` 零注入（差分对照）/
 *     注入异常不阻断会话创建；
 *   B HTTP 出口（`src/server/api.mjs`）：`POST /flow/inject` 真投递 + 六字段审计 + `GET /flow/injections` 可查 +
 *     无宿主通道时回带正文（人工可粘贴）；`flowInjectPolicy` 写前校验；
 *   C CLI 出口（`scripts/tb-flow.mjs inject`）：**独立进程**跑真 HTTP + 真 sqlite 文件，
 *     并与 `tb-flow start` 的 stdout **逐字节对拍**（验收 ③ 的跨进程证据）。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createHostSessionPort } from "../index.js";
import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createServer } from "../src/server/server.mjs";
import { buildFlowBlock, buildFlowSummary } from "../src/mcp/flow-block.mjs";
import { sha256 } from "../src/core/contract.mjs";
import { estimateFlowTokens } from "../src/core/flow-inject.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "tb-flow.mjs");
const payloadOf = (r) => r.payload ?? r.body ?? r;

function seed(store) {
  store.createProject({ id: "p1", name: "注入项目", workspacePath: "/tmp/ws-p1" });
  store.ensureRequirementDoc("p1", { body: "# 需求\n\n- R1 开局注入\n" });
  store.bindInitialSession("p1", "sess-main");
  return store;
}

/** 假宿主会话通道：只记录，不真投 —— 判据是「投了什么 / 投没投」。 */
function fakeHost({ store }) {
  const calls = { create: [], rename: [], prompt: [] };
  let n = 0;
  const sc = {
    async create(opts) { calls.create.push(opts ?? {}); return { sessionId: `session-fake-${++n}` }; },
    async rename(args) { calls.rename.push(args); return { title: args.title, seq: 1 }; },
    async prompt(req) { calls.prompt.push(req); return { ok: true }; },
  };
  const port = createHostSessionPort({
    getService: (name) => (name === "sessionController" ? sc : undefined),
    getStore: () => store,
  });
  return { calls, port };
}

// ------------------------------------------------------------------ A. 宿主出口

test("A1 宿主 main-only：主会话拿到**完整版**（与生成器逐字节相同），审计 policy=main-only", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  store.saveProjectSettings("p1", { flowInjectPolicy: "main-only" });
  const { calls, port } = fakeHost({ store });
  const created = await port.createSession({ cwd: "/tmp/ws-p1", role: "main", projectId: "p1" });
  assert.ok(created.sessionId, JSON.stringify(created));
  assert.equal(created.injection?.injected, true, JSON.stringify(created.injection));
  assert.equal(created.injection.version, "full");
  assert.equal(calls.prompt.length, 1, "只该有一次注入投递（本用例不给 preset）");
  assert.equal(calls.prompt[0].content[0].text, buildFlowBlock({ store, project: "p1" }).text);
  const rows = store.listFlowInjections({ projectId: "p1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].policy, "main-only");
  assert.equal(rows[0].sessionId, created.sessionId);
  store.close();
});

test("A2 宿主 main-only：执行会话**不注入**（单一定位：注入只投主会话）", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  store.saveProjectSettings("p1", { flowInjectPolicy: "main-only" });
  const { calls, port } = fakeHost({ store });
  const created = await port.createSession({ preset: "任务 -1：做点事", cwd: "/tmp/ws-p1", role: "exec", projectId: "p1" });
  assert.equal(created.injection?.injected, false);
  assert.equal(created.injection.reason, "policy-main-only");
  assert.equal(calls.prompt.length, 1, "执行会话只有预置任务指令，没有装载块");
  assert.equal(calls.prompt[0].content[0].text, "任务 -1：做点事");
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 0);
  store.close();
});

test("A3 宿主 off（缺省）零注入 —— 与 A1 只差一个策略位（差分对照）", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  const { calls, port } = fakeHost({ store });
  const created = await port.createSession({ cwd: "/tmp/ws-p1", role: "main", projectId: "p1" });
  assert.equal(created.injection?.injected, false);
  assert.equal(created.injection.reason, "policy-off");
  assert.equal(calls.prompt.length, 0, "off 档必须零投递");
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 0, "off 档必须零审计行");
  store.close();
});

test("A4 宿主 main+exec：执行会话拿**摘要版**（≤300 tokens，且不是完整版）", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  store.saveProjectSettings("p1", { flowInjectPolicy: "main+exec" });
  const { calls, port } = fakeHost({ store });
  const created = await port.createSession({ cwd: "/tmp/ws-p1", role: "exec", projectId: "p1" });
  assert.equal(created.injection.version, "summary");
  const text = calls.prompt[0].content[0].text;
  assert.ok(estimateFlowTokens(text) <= 300, `摘要版 ${estimateFlowTokens(text)} tokens 超上限`);
  assert.notEqual(text, buildFlowBlock({ store, project: "p1" }).text);
  assert.match(text, /当前步：S\d/);
  store.close();
});

test("A5 角色未知 ⇒ 不注入（role-unknown）；`all` 也不注子 agent", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  store.saveProjectSettings("p1", { flowInjectPolicy: "all" });
  const { calls, port } = fakeHost({ store });
  const noRole = await port.createSession({ cwd: "/tmp/ws-p1", projectId: "p1" });
  assert.equal(noRole.injection.reason, "role-unknown");
  const sub = await port.createSession({ cwd: "/tmp/ws-p1", role: "subagent", projectId: "p1" });
  assert.equal(sub.injection.reason, "subagent-never");
  assert.equal(calls.prompt.length, 0);
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 0);
  store.close();
});

test("A6 注入异常不阻断会话创建（验收 ⑤）：store 炸了照样回 sessionId，只带 reason", async () => {
  const brokenStore = {
    requireProject: () => ({ id: "p1", name: "注入项目" }),
    getProjectSettings() { throw new Error("db gone"); },
  };
  let n = 0;
  const sc = {
    async create() { return { sessionId: `session-ok-${++n}` }; },
    async rename() { return {}; },
    async prompt() { return { ok: true }; },
  };
  const port = createHostSessionPort({
    getService: (name) => (name === "sessionController" ? sc : undefined),
    getStore: () => brokenStore,
  });
  const created = await port.createSession({ cwd: "/tmp/ws-p1", role: "main", projectId: "p1" });
  assert.equal(created.sessionId, "session-ok-1", "会话创建必须照旧成功");
  assert.equal(created.injection.injected, false);
  assert.match(String(created.injection.reason), /db gone/);
});

test("A7 没给 store（-legacy adapter 用法）⇒ 行为与接线前完全一致：不注入、不抛错", async () => {
  const calls = { prompt: [] };
  const sc = {
    async create() { return { sessionId: "session-legacy" }; },
    async rename() { return {}; },
    async prompt(req) { calls.prompt.push(req); return { ok: true }; },
  };
  const port = createHostSessionPort({ getService: (name) => (name === "sessionController" ? sc : undefined) });
  const created = await port.createSession({ cwd: "/tmp/ws-p1", role: "main", projectId: "p1" });
  assert.equal(created.sessionId, "session-legacy");
  assert.equal(created.injection.injected, false);
  assert.equal(created.injection.reason, "no-store");
  assert.equal(calls.prompt.length, 0);
});

// ------------------------------------------------------------------ B. HTTP 出口

function apiSetup() {
  const store = seed(openStore({ dbPath: ":memory:" }));
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; } };
  const router = createApiRouter({ store });
  const route = (method, pathname, body = null, query = "") =>
    router.route({ method, pathname, searchParams: new URLSearchParams(query), body });
  return { store, sent, route };
}

test("B1 POST /flow/inject：真投递 + 六字段审计 + digest=sha256(正文)；GET /flow/injections 可查", async () => {
  const { store, sent, route } = apiSetup();
  const r = payloadOf(await route("POST", "/api/projects/p1/flow/inject", { sessionId: "sess-main" }));
  assert.equal(r.delivered, true, JSON.stringify(r));
  assert.equal(r.role, "main", "默认按「是不是项目主会话」推角色");
  assert.equal(r.version, "full");
  assert.equal(r.policy, "manual");
  const expected = buildFlowBlock({ store, project: "p1" }).text;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, expected, "注入正文与 tb-flow start 生成器逐字节相同");
  assert.equal(r.digest, sha256(expected));
  for (const key of ["id", "projectId", "sessionId", "policy", "contractVersion", "digest", "injectedAt"]) {
    assert.ok(r.injection[key] !== undefined && r.injection[key] !== null, `审计回包缺字段：${key}`);
  }
  assert.equal(r.injection.sessionId, "sess-main");
  assert.equal(r.injection.projectId, "p1");
  const list = payloadOf(await route("GET", "/api/projects/p1/flow/injections"));
  assert.equal(list.injections.length, 1);
  assert.equal(list.injections[0].digest, r.digest);
  assert.equal(list.policy, "off", "策略位与「这一次人工投递」是两件事：policy 位仍 off");
  store.close();
});

test("B2 POST /flow/inject：非主会话默认摘要版；显式 role=subagent 拒绝注入（硬规则）", async () => {
  const { store, sent, route } = apiSetup();
  const exec = payloadOf(await route("POST", "/api/projects/p1/flow/inject", { sessionId: "sess-other" }));
  assert.equal(exec.role, "exec");
  assert.equal(exec.version, "summary");
  assert.ok(estimateFlowTokens(sent[0].text) <= 300);

  const sub = payloadOf(await route("POST", "/api/projects/p1/flow/inject", { sessionId: "sess-sub", role: "subagent" }));
  assert.equal(sub.delivered, false);
  assert.equal(sub.reason, "subagent-never");
  assert.equal(sent.length, 1, "子 agent 不投递");
  store.close();
});

test("B3 无宿主通道：不谎报成功，但把**同一份正文**回带（人工可粘贴）+ 明确指路", async () => {
  const store = seed(openStore({ dbPath: ":memory:" }));
  const router = createApiRouter({ store });
  const r = payloadOf(await router.route({
    method: "POST", pathname: "/api/projects/p1/flow/inject", searchParams: new URLSearchParams(),
    body: { sessionId: "sess-main" },
  }));
  assert.equal(r.delivered, false);
  assert.equal(r.reason, "host-unavailable");
  assert.match(String(r.nextAction), /宿主会话通道/);
  assert.equal(r.prompt, buildFlowBlock({ store, project: "p1" }).text, "兜底正文必须与正常注入同一份");
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 0, "没投进去就不该有审计行");
  store.close();
});

test("B4 settings 写前校验：非法 flowInjectPolicy 不落库；合法值 GET 可读", async () => {
  const { store, route } = apiSetup();
  await assert.rejects(
    () => route("PUT", "/api/projects/p1/settings", { flowInjectPolicy: "always" }),
    /flow_inject_policy/,
  );
  assert.equal(store.getProjectSettings("p1").flowInjectPolicy, "off", "非法值不得落库");
  const saved = payloadOf(await route("PUT", "/api/projects/p1/settings", { flowInjectPolicy: "MAIN_ONLY" }));
  assert.equal(saved.flowInjectPolicy, "main-only", "归一化后落库");
  const got = payloadOf(await route("GET", "/api/projects/p1/settings"));
  assert.equal(got.flowInjectPolicy, "main-only");
  store.close();
});

// ------------------------------------------------------------------ C. CLI 出口（跨进程）

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

test("C1 `tb-flow inject --session` 独立进程真投递：与 `tb-flow start` 的 stdout **逐字节相同**", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-flow-inject-"));
  const store = seed(openStore({ dataDir: dir }));
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; } };
  const server = createServer({ store, basePath: "/integrations/taskboard-workbench" });
  const portNumber = await listen(server);
  try {
    const started = await execFileAsync(process.execPath, [SCRIPT, "start", "--project", "p1", "--data-dir", dir], { encoding: "utf8" });
    const inject = await execFileAsync(process.execPath, [
      SCRIPT, "inject", "--session", "sess-main", "--project", "p1",
      "--host", `http://127.0.0.1:${portNumber}`, "--data-dir", dir, "--json", "--verify-bytes",
    ], { encoding: "utf8" });
    const out = JSON.parse(inject.stdout);
    assert.equal(out.delivered, true, inject.stdout);
    assert.equal(out.policy, "manual");
    assert.equal(out.version, "full");
    // ① 跨进程逐字节：CLI start 的 stdout ≡ 宿主实际投出的正文
    assert.equal(sent[0].text, started.stdout, "注入正文与 `tb-flow start` 输出必须逐字节相同");
    // ② sha256 也对得上（digest 是投出正文的摘要）
    assert.equal(out.digest, sha256(started.stdout));
    // ③ --verify-bytes：CLI 自己复算的结果也一致
    assert.equal(out.verify.match, true, JSON.stringify(out.verify));
    // ④ 审计行落库
    const rows = store.listFlowInjections({ projectId: "p1" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, "sess-main");
    assert.equal(rows[0].policy, "manual");
    assert.equal(rows[0].digest, out.digest);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2 `tb-flow inject`：执行会话拿摘要版；连不上宿主 ⇒ 退出码 4（不静默成功）", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-flow-inject-"));
  const store = seed(openStore({ dataDir: dir }));
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; } };
  const server = createServer({ store, basePath: "/integrations/taskboard-workbench" });
  const portNumber = await listen(server);
  try {
    const inject = await execFileAsync(process.execPath, [
      SCRIPT, "inject", "--session", "sess-exec", "--role", "exec", "--project", "p1",
      "--host", `http://127.0.0.1:${portNumber}`, "--data-dir", dir, "--json",
    ], { encoding: "utf8" });
    const out = JSON.parse(inject.stdout);
    assert.equal(out.version, "summary");
    assert.ok(estimateFlowTokens(sent[0].text) <= 300);
    assert.equal(sent[0].text.trimEnd(), buildFlowSummary(buildFlowBlock({ store, project: "p1" })).trimEnd());
  } finally {
    await new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
  }
  // 宿主不在：必须是明确的连接失败（退出码 4），而不是「成功但什么也没做」
  const deadPort = await freePort();
  await assert.rejects(
    () => execFileAsync(process.execPath, [SCRIPT, "inject", "--session", "sess-x", "--project", "p1",
      "--host", `http://127.0.0.1:${deadPort}`, "--data-dir", dir], { encoding: "utf8" }),
    (error) => error.code === 4 && /HOST_UNREACHABLE/.test(String(error.stderr)),
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("C3 `tb-flow inject` 缺 --session ⇒ 退出码 2（用法错误，不去瞎猜目标）", async () => {
  await assert.rejects(
    () => execFileAsync(process.execPath, [SCRIPT, "inject"], { encoding: "utf8" }),
    (error) => error.code === 2 && /--session/.test(String(error.stderr)),
  );
});
