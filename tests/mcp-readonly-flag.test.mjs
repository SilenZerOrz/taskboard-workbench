/**
 * P3 回滚开关 · `--read-only`（2026-11-04）
 *
 * 方案 §十 的回滚列承诺「关闭写工具开关（--read-only）」，风险表 R2 也把它列为
 * 「契约太严」的显式逃生口。本守卫盯的是**逃生口真的能开**，而不是文档里写着：
 *
 *   A `--print-tools --read-only`：`readOnly:true` 且工具面只剩五件只读
 *   B `--print-tools`（默认）：`readOnly:false` 且仍是 9 件（**默认零变化**）
 *   C `tools/list`（--read-only）：五件；`tools/call` 调写工具 ⇒ `isError:true` + `READ_ONLY_MODE`
 *   D **差分对照**：不带 flag 调同一个写工具 ⇒ **不是** `READ_ONLY_MODE`
 *      （否则上一条就变成「任何调用都失败」，测不出开关本身）
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "mcp", "server.mjs");

const READ_TOOLS = ["flow_start", "norm_get", "project_info", "requirement_list", "workbench_audit"];
const ALL_TOOLS = [...READ_TOOLS, "card_create", "card_progress", "requirement_change", "requirement_upsert"];

const printTools = (extra = []) => {
  const out = spawnSync(process.execPath, [SERVER, "--print-tools", ...extra], { encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout);
};

function seed(dir) {
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "AGENTS.md"), "# 项目\n\n- 构建：npm test\n");
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const item = store.createRequirementItem({ projectId: "p1", title: "需求一" });
  store.createTask({ projectId: "p1", title: "卡一", requirementId: item.identifier, actor: "human" });
  store.close();
}

function startServer(dir, extra = []) {
  const child = spawn(process.execPath, [SERVER, "--data-dir", dir, ...extra], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    if (line.trim() === "") return;
    const msg = JSON.parse(line);
    const entry = pending.get(msg.id);
    if (entry) { pending.delete(msg.id); clearTimeout(entry.timer); entry.resolve(msg); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    // 定时器必须随应答清掉：否则每个请求留一个 10s 的 pending timer，测试会白等 10s 才退出。
    const timer = setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, timer });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const tool = async (name, args = {}) => {
    const msg = await rpc("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { isError: Boolean(msg.result?.isError), value, msg };
  };
  return { child, rpc, tool };
}

test("P3 回滚开关 · --read-only", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-mcp-ro-"));
  seed(dir);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // A / B：`--print-tools` 反映当前模式
  const roPrint = printTools(["--read-only"]);
  assert.equal(roPrint.readOnly, true, "--print-tools 必须报 readOnly:true");
  assert.deepEqual([...roPrint.tools].sort(), [...READ_TOOLS].sort(), "只读模式只暴露五件只读工具");

  const defPrint = printTools();
  assert.equal(defPrint.readOnly, false, "默认必须是 readOnly:false");
  assert.deepEqual([...defPrint.tools].sort(), [...ALL_TOOLS].sort(), "默认仍是 9 件（默认零变化）");

  // C：stdio 只读模式 —— 清单过滤 + 写工具调用被拒（工具错误，不是协议错误）
  const ro = startServer(dir, ["--read-only"]);
  t.after(() => { try { ro.child.kill(); } catch { /* ignore */ } });
  await ro.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });
  const roList = await ro.rpc("tools/list", {});
  assert.deepEqual([...roList.result.tools.map((x) => x.name)].sort(), [...READ_TOOLS].sort(), "只读模式 tools/list 只给五件");

  const blocked = await ro.tool("card_create", { project: "p1", title: "不该建成" });
  assert.equal(blocked.isError, true, "只读模式下写工具必须失败");
  assert.equal(blocked.value?.error?.code, "READ_ONLY_MODE", "必须是 READ_ONLY_MODE（不是 -32602 未知工具）");
  assert.equal(blocked.value?.error?.details?.readOnly, true);

  const stillReads = await ro.tool("flow_start", { project: "p1" });
  assert.equal(stillReads.isError, false, "只读模式不得影响只读工具");
  assert.equal(stillReads.value.project.id, "p1");

  // D：差分对照 —— 同一条写调用在默认模式下**不是** READ_ONLY_MODE
  const def = startServer(dir);
  t.after(() => { try { def.child.kill(); } catch { /* ignore */ } });
  await def.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });
  const defBlocked = await def.tool("card_create", { project: "p1", title: "" });
  assert.notEqual(defBlocked.value?.error?.code, "READ_ONLY_MODE", "默认模式必须真的执行到工具内部（差分对照）");
});
