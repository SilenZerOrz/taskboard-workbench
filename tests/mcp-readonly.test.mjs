/**
 * P2 · MCP 只读四工具（stdio · 2026-10-29）
 *
 * 判据（对齐方案 §6.1/§6.2/§7.3）：
 *   A stdio 握手：`initialize` 回协议版本 + `tools` 能力 + serverInfo
 *   B `tools/list`：**只读恰好五件**（`readOnlyHint` 不得跑到写四件上），共 9 个工具
 *   C `flow_start`：项目 + contract_version + gaps（未归因 / 未绑定 / 待确认候选）+ 下一步建议
 *   D `project_info`：计数与库内一致
 *   E `norm_get`：正文 + digest；未知规范 ⇒ `NORM_NOT_FOUND`（工具错误，不是协议错误）
 *   F `workbench_audit`：四类漂移都在（contract-stale / unattributed / unbound-session / candidate-flood）
 *   G **只读**：跑完一轮工具调用后，库内计数与审计条数**逐项不变**
 *   H 协议层：未知工具 ⇒ JSON-RPC `-32602`（与工具错误区分开）
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "mcp", "server.mjs");

function seed(dir) {
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "AGENTS.md"), "# 项目补充\n\n- 构建：mvn -q test\n");
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1 演示", workspacePath: ws });
  store.ensureRequirementDoc("p1", { body: "# 需求 v1\n" });
  const item = store.createRequirementItem({ projectId: "p1", title: "需求一" });
  store.createTask({ projectId: "p1", title: "已归因", requirementId: item.identifier, actor: "human" });
  store.createTask({ projectId: "p1", title: "未归因", unattributedReason: "演示" });
  const current = store.contractSnapshot("p1").snapshot.contractVersion;
  // 留一条 contract-warn：让 workbench_audit 的 contract-stale 有东西可报
  store.createTask({ projectId: "p1", title: "拿旧契约", requirementId: item.identifier, contract: { version: "v1-000000000000", actor: "agent" } });
  const before = { ...store.stats(), audit: store.listGovernanceAudit().length };
  store.close();
  return { ws, current, before };
}

function startServer(dataDir) {
  const child = spawn(process.execPath, [SERVER, "--data-dir", dataDir], { stdio: ["pipe", "pipe", "pipe"] });
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
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 10000);
  });
  const tool = async (name, args) => {
    const msg = await rpc("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { isError: Boolean(msg.result?.isError), value, msg };
  };
  return { child, rpc, tool };
}

test("P2 · MCP 只读四工具（stdio 握手 + 只读保证）", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-mcp-"));
  const { ws, current, before } = seed(dir);
  const { child, rpc, tool } = startServer(dir);
  try {
    // A 握手
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.equal(init.result.serverInfo.name, "taskboard-workbench");
    assert.ok(init.result.capabilities.tools);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    // B 工具清单：P2 只读四件 + P3 写四件与条目列表（共 9）
    // 这里守的是**只读那四件的边界**：readOnlyHint 必须恰好在它们身上 ——
    // 写工具若被误标 readOnlyHint，客户端会以为「调用无副作用」而放心重试（那才是灾难）。
    const list = await rpc("tools/list", {});
    const names = list.result.tools.map((x) => x.name).sort();
    assert.deepEqual(names, ["card_create", "card_progress", "flow_start", "norm_get", "project_info",
      "requirement_change", "requirement_list", "requirement_upsert", "workbench_audit"]);
    const readOnly = list.result.tools.filter((x) => x.annotations?.readOnlyHint).map((x) => x.name).sort();
    // P3 的 `requirement_list` 也是纯读（只是 P2 没做），所以这里列 5 件；**写四件一个都不许进来**。
    assert.deepEqual(readOnly, ["flow_start", "norm_get", "project_info", "requirement_list", "workbench_audit"], "只读集合必须恰好是这五件");
    for (const tool of list.result.tools) {
      assert.equal(tool.inputSchema?.type, "object", `${tool.name} 必须有 object schema`);
      if (!tool.annotations?.readOnlyHint) {
        assert.equal(tool.annotations?.destructiveHint, false, `${tool.name} 是写工具：不得标 destructive（都是可恢复的增改）`);
      }
    }

    // C flow_start
    const flow = await tool("flow_start", { project: "p1" });
    assert.equal(flow.isError, false);
    assert.equal(flow.value.project.id, "p1");
    assert.equal(flow.value.contract.version, current);
    assert.equal(flow.value.gaps.unattributedTasks, 1);
    assert.equal(flow.value.gaps.unboundSession, true);
    assert.equal(flow.value.nextStep.step, "S2", "有未归因卡时下一步应是补归因");
    assert.match(flow.value.normNotice, /四道门/);

    // D project_info
    const info = await tool("project_info", { project: "p1" });
    assert.equal(info.value.counts.tasks, 3);
    assert.equal(info.value.counts.requirements, 1);

    // E norm_get（正文 + digest；project 档读 AGENTS.md；未知 ⇒ 工具错误）
    const norm = await tool("norm_get", { norm: "flow" });
    assert.equal(norm.isError, false);
    assert.equal(norm.value.norm, "flow");
    assert.match(norm.value.digest, /^[0-9a-f]{64}$/);
    assert.ok(norm.value.body.includes("S0"));

    const proj = await tool("norm_get", { norm: "project", project: "p1" });
    assert.equal(proj.value.found, true);
    assert.ok(proj.value.body.includes("mvn -q test"));
    assert.ok(proj.value.file.startsWith(ws));

    const bad = await tool("norm_get", { norm: "nope" });
    assert.equal(bad.isError, true);
    assert.equal(bad.value.error.code, "NORM_NOT_FOUND");

    // F workbench_audit 四类齐
    const audit = await tool("workbench_audit", { project: "p1" });
    assert.deepEqual(audit.value.items.map((i) => i.type).sort(), ["candidate-flood", "contract-stale", "unattributed", "unbound-session"]);
    const stale = audit.value.items.find((i) => i.type === "contract-stale");
    assert.ok(stale.count >= 1, "P1.5 的 contract-warn 必须能被盘点出来");
    assert.equal(audit.value.ok, false);

    // H 协议层：未知工具 ⇒ -32602（不是工具错误）
    const unknown = await rpc("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknown.error.code, -32602);

    // G 只读：关服务后重开库，计数逐项不变
    child.stdin.end();
    await new Promise((r) => child.once("exit", r));
    const store = openStore({ dataDir: dir });
    try {
      const after = { ...store.stats(), audit: store.listGovernanceAudit().length };
      for (const key of ["projects", "tasks", "comments", "ownedTasks", "audit"]) {
        assert.equal(after[key], before[key], `只读工具不得改变 ${key}`);
      }
    } finally { store.close(); }
  } finally {
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
