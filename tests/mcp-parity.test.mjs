/**
 * P3 · `mcp-parity` 守卫 —— MCP 与 HTTP **同一批 store 用例**，不得一个拒一个放。
 *
 * 判据（方案 §6.5「防双门面漂移」）：
 *   A 建卡缺归因：HTTP（`TB_STRICT_ATTRIBUTION=1`）与 MCP ⇒ 同码 `REQUIREMENT_REQUIRED`
 *   B 跨项目归因：两条路 ⇒ 同码 `DEPENDENCY_CROSS_PROJECT`，且**都零建卡**
 *   C 执行侧写 done：HTTP `/team-status` 与 MCP `card_progress` ⇒ 同码 `GOVERNANCE_AGENT_DONE`
 *   D 副作用同形：同一输入建出的卡 —— 状态、归属条目、归因事件类型**逐项一致**
 *
 * 为什么必须两路对照：MCP 里复制一份业务判断，就会出现「Web/CLI 允许、MCP 拒绝」或
 * 更糟的「MCP 允许、Web 拒绝」—— 两个门面两种语义，谁都不知道该信哪个。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { loadNorms } from "../src/core/contract.mjs";
import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(ROOT, "src", "mcp", "server.mjs");
const CARD_UPDATE = loadNorms(path.join(ROOT, "spec", "norms")).find((n) => n.id === "card-update");
const STRICT = { TB_STRICT_ATTRIBUTION: "1" };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

function freshDir(label) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `tb-parity-${label}-`));
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "AGENTS.md"), "# 项目补充\n");
  return dir;
}

/** 两套环境用**同一份种子**：p1（含条目 R1）+ p2（含条目 R1），一个卡。
 *  返回的 `otherRequirement` 是 p2 的条目编号（跨项目用）。 */
function seed(dir) {
  const store = openStore({ dataDir: dir, env: STRICT });
  store.createProject({ id: "p1", name: "P1", workspacePath: path.join(dir, "ws") });
  store.ensureRequirementDoc("p1", { body: "# 需求 v1\n" });
  store.createRequirementItem({ projectId: "p1", title: "P1 需求一" });
  store.createProject({ id: "p2", name: "P2" });
  store.ensureRequirementDoc("p2", { body: "# 需求 v1\n" });
  store.createRequirementItem({ projectId: "p2", title: "P2 需求一" });
  store.close();
  const reread = openStore({ dataDir: dir, env: STRICT });
  const p1Item = reread.listRequirementItems({ projectId: "p1" })[0];
  const p2Item = reread.listRequirementItems({ projectId: "p2" })[0];
  reread.close();
  return { p1Item, p2Item };
}

function startMcp(dir) {
  const child = spawn(process.execPath, [MCP, "--data-dir", dir], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...STRICT } });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 15000);
  });
  const tool = async (name, args) => {
    const msg = await rpc("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { isError: Boolean(msg.result?.isError), value };
  };
  return { child, rpc, tool, close: async () => { try { child.stdin.end(); } catch { /* 已关 */ } try { child.kill("SIGKILL"); } catch { /* 已退出 */ } } };
}

async function startHttp(dir) {
  const store = openStore({ dataDir: dir, env: STRICT });
  const server = createServer({ store });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  return {
    store, base,
    post: async (p, payload) => {
      const res = await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      return { status: res.status, json, code: json?.error?.code ?? null };
    },
    close: async () => { server.closeAllConnections?.(); await new Promise((r) => server.close(r)); store.close(); },
  };
}

/** 一条用例同时在两条路上跑 ⇒ 回两个读数（错误码 or 结果） */
async function bothWays(fn) {
  const dirHttp = freshDir("http");
  const dirMcp = freshDir("mcp");
  const sHttp = seed(dirHttp);
  const sMcp = seed(dirMcp);
  const http = await startHttp(dirHttp);
  const mcp = startMcp(dirMcp);
  try {
    await mcp.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "parity", version: "0" } });
    return await fn({ http, mcp, sHttp, sMcp, dirHttp, dirMcp });
  } finally {
    await http.close();
    await mcp.close();
    rmSync(dirHttp, { recursive: true, force: true });
    rmSync(dirMcp, { recursive: true, force: true });
  }
}

/* ---------------- A ---------------- */
test("P3/A 建卡缺归因：HTTP 与 MCP 同码 REQUIREMENT_REQUIRED", async () => {
  await bothWays(async ({ http, mcp }) => {
    const h = await http.post("/api/tasks", { projectId: "p1", title: "忘了归因" });
    const m = await mcp.tool("card_create", { project: "p1", title: "忘了归因" });
    assert.equal(h.code, "REQUIREMENT_REQUIRED", `HTTP 应拒：${JSON.stringify(h.json).slice(0, 200)}`);
    assert.equal(m.value.error.code, "REQUIREMENT_REQUIRED");
    assert.equal(h.code, m.value.error.code, "两个门面必须同码");
  });
});

/* ---------------- B ---------------- */
test("P3/B 跨项目归因：两条路同码 DEPENDENCY_CROSS_PROJECT，且都零建卡", async () => {
  await bothWays(async ({ http, mcp, sHttp, sMcp, dirMcp }) => {
    const h = await http.post("/api/tasks", { projectId: "p1", title: "跨项目归因", requirementId: sHttp.p2Item.identifier });
    const m = await mcp.tool("card_create", { project: "p1", title: "跨项目归因", requirement: sMcp.p2Item.identifier });
    assert.equal(h.code, "DEPENDENCY_CROSS_PROJECT", JSON.stringify(h.json).slice(0, 200));
    assert.equal(m.value.error.code, "DEPENDENCY_CROSS_PROJECT");
    assert.equal(h.code, m.value.error.code);

    assert.equal(http.store.listTasks({ projectId: "p1" }).length, 0, "HTTP 侧被拒后不得留卡");
    const reread = openStore({ dataDir: dirMcp, env: STRICT });
    assert.equal(reread.listTasks({ projectId: "p1" }).length, 0, "MCP 侧被拒后同样不得留卡");
    reread.close();
  });
});

/* ---------------- C ---------------- */
test("P3/C 执行侧写 done：HTTP /team-status 与 MCP card_progress 同码 GOVERNANCE_AGENT_DONE", async () => {
  await bothWays(async ({ http, mcp, sHttp, sMcp, dirMcp }) => {
    const hCard = http.store.createTask({ projectId: "p1", title: "HTTP 的卡", requirementId: sHttp.p1Item.identifier, actor: "human" });
    const mCard = mcp.tool("card_create", { project: "p1", title: "MCP 的卡", requirement: sMcp.p1Item.identifier });

    const h = await http.post(`/api/tasks/${hCard.identifier}/team-status`, { status: "done", actor: "agent" });
    const created = await mCard;
    const m = await mcp.tool("card_progress", {
      card: created.value.card.identifier,
      status: "done",
      evidence: [{ kind: "command", ref: "npm test", note: "全绿" }],
      norm_digest: CARD_UPDATE.digest,
    });
    assert.equal(h.code, "GOVERNANCE_AGENT_DONE", JSON.stringify(h.json).slice(0, 200));
    assert.equal(m.value.error.code, "GOVERNANCE_AGENT_DONE");
    assert.equal(h.code, m.value.error.code);

    const reread = openStore({ dataDir: dirMcp, env: STRICT });
    const t = reread.listTasks({ projectId: "p1" }).find((x) => x.identifier === created.value.card.identifier);
    assert.notEqual(t.status, "done", "MCP 侧被拒后状态不得变成 done");
    reread.close();
  });
});

/* ---------------- D ---------------- */
test("P3/D 副作用同形：同一输入建出的卡在两条路上逐项一致", async () => {
  await bothWays(async ({ http, mcp, sHttp, sMcp, dirHttp, dirMcp }) => {
    const payload = (req) => ({ projectId: "p1", title: "同一张卡", acceptance: "npm test 全绿", verifyCommand: "npm test", requirementId: req });
    const h = await http.post("/api/tasks", payload(sHttp.p1Item.identifier));
    assert.equal(h.status, 201, JSON.stringify(h.json).slice(0, 200));
    const m = await mcp.tool("card_create", { project: "p1", title: "同一张卡", acceptance: "npm test 全绿", verifyCommand: "npm test", requirement: sMcp.p1Item.identifier });
    assert.equal(m.isError, false);

    const shape = (store, identifier) => {
      const t = store.listTasks({ projectId: "p1" }).find((x) => x.identifier === identifier);
      const item = t.requirementId ? store.getRequirementItemById(t.requirementId) : null;
      const events = store.listTaskEvents(t.id).map((e) => e.type);
      return { status: t.status, priority: t.priority, acceptance: t.acceptance, verifyCommand: t.verifyCommand, requirementTitle: item?.title ?? null, events };
    };
    const a = openStore({ dataDir: dirHttp, env: STRICT });
    const b = openStore({ dataDir: dirMcp, env: STRICT });
    try {
      const hs = shape(a, h.json.task.identifier);
      const ms = shape(b, m.value.card.identifier);
      assert.deepEqual(ms, hs, `两条路的副作用必须同形：HTTP=${JSON.stringify(hs)} MCP=${JSON.stringify(ms)}`);
      assert.deepEqual(hs.events, ["created", "attributed"], "归因卡的两条路都要落 created + attributed");
    } finally { a.close(); b.close(); }
  });
});
