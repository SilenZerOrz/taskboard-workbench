#!/usr/bin/env node
/**
 * server.mjs —— Taskboard Workbench MCP server（stdio · 零依赖 · 只读四工具）。
 *
 * 方案依据：§6.1 —— **stdio 而不是 HTTP**：① 不占端口、不碰 `:3080`；② 不需要重载宿主、
 * 不写 `~/.dsh/**`；③ 每个 agent 会话一个进程，天然隔离。数据连**同一个** `taskboard.sqlite`。
 *
 * 用法：
 *   node src/mcp/server.mjs --data-dir <dir>     # 由 MCP 客户端作为子进程拉起
 *   node src/mcp/server.mjs --print-tools        # 打印工具清单（调试 / 守卫测试用）
 *
 * 传输：newline-delimited JSON-RPC 2.0（MCP stdio transport）。
 * stdout **只允许**出现协议消息；日志一律走 stderr（否则客户端解析失败）。
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../core/store.mjs";
import { TbError } from "../core/errors.mjs";
import { TOOLS, TOOL_NAMES, PKG_ROOT } from "./tools.mjs";
import { buildFlowBlock, readSkill } from "./flow-block.mjs";

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const has = (name) => argv.includes(name);

if (has("--help") || has("-h")) {
  process.stderr.write(`taskboard-workbench MCP server（9 个工具：只读五 / 写四 · prompt 1）
用法: node src/mcp/server.mjs [--data-dir <dir>] [--print-tools]
工具: ${TOOL_NAMES.join(", ")}
提示: prompt taskboard.flow（= node scripts/tb-flow.mjs start 的输出）
数据: --data-dir > $TB_DATA_DIR > 默认（同 Web/CLI）
`);
  process.exit(0);
}

const pkg = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

if (has("--print-tools")) {
  process.stdout.write(`${JSON.stringify({ name: pkg.name, version: pkg.version, tools: TOOLS.map((t) => t.name) }, null, 2)}\n`);
  process.exit(0);
}

const dataDir = argOf("--data-dir") ?? process.env.TB_DATA_DIR ?? undefined;
const store = openStore({ dataDir, env: process.env });
const ctx = { store };
let skillMeta = null;
try { skillMeta = readSkill().meta; } catch { /* skill 缺失时不影响工具面；prompts/* 会报出具体原因 */ }
process.stderr.write(`[tb-mcp] ready dataDir=${store.dataDir} tools=${TOOL_NAMES.join(",")} prompt=taskboard.flow skill=${skillMeta ? `v${skillMeta.version}` : "missing"}\n`);

const SERVER_INFO = { name: "taskboard-workbench", version: pkg.version };
const DEFAULT_PROTOCOL = "2025-06-18";

const send = (payload) => {
  if (payload === null || payload === undefined) return;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};
const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const rpcError = (id, code, message, data) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });

/** 工具错误 → `isError:true` 的 content（协议层没坏，是这次调用不成立）。 */
const toolError = (error) => {
  const body = error instanceof TbError
    ? { error: { code: error.code, message: error.message, details: error.details ?? null } }
    : { error: { code: "INTERNAL_ERROR", message: error?.message ?? String(error) } };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
};

function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

async function handle(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "Invalid Request");
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;

  if (method === "initialize") {
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL;
    return result(id, { protocolVersion: requested, capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } }, serverInfo: SERVER_INFO });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: listTools() });
  if (method === "tools/call") {
    const name = params?.name;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name ?? "(missing)"}`, { tools: TOOL_NAMES });
    try {
      const value = await tool.handler(ctx, params?.arguments ?? {});
      return result(id, { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], isError: false });
    } catch (error) {
      return result(id, toolError(error));
    }
  }
  // ---- prompts：档 A「一键拉取装载块」 ----
  // 与 `node scripts/tb-flow.mjs start` 共用 buildFlowBlock() ⇒ 两处输出**必须逐字节相同**（守卫测试钉住）。
  if (method === "prompts/list") {
    return result(id, {
      prompts: [{
        name: "taskboard.flow",
        title: "任务看板主流程装载块",
        description: "八步主流程 + 当前项目快照 + 本轮该先做的事（只读；与 `tb-flow start` 同源）",
        arguments: [
          { name: "project", description: "项目 id（省略则按 cwd 匹配）", required: false },
          { name: "cwd", description: "工作目录（默认进程 cwd）", required: false },
        ],
      }],
    });
  }
  if (method === "prompts/get") {
    const name = params?.name;
    if (name !== "taskboard.flow") return rpcError(id, -32602, `Unknown prompt: ${name ?? "(missing)"}`, { prompts: ["taskboard.flow"] });
    const args = params?.arguments ?? {};
    try {
      const block = buildFlowBlock({ store: ctx.store, project: args.project, cwd: args.cwd });
      return result(id, {
        description: `任务看板主流程装载块（${block.project.id} · 契约 ${block.contract.version}）`,
        messages: [{ role: "user", content: { type: "text", text: block.text } }],
      });
    } catch (error) {
      return rpcError(id, -32603, error instanceof TbError ? `${error.code}: ${error.message}` : (error?.message ?? String(error)), error instanceof TbError ? { code: error.code, details: error.details ?? null } : undefined);
    }
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method ?? "(missing)"}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const text = line.trim();
  if (text === "") return;
  let message;
  try { message = JSON.parse(text); }
  catch (error) {
    send(rpcError(null, -32700, `Parse error: ${error.message}`));
    return;
  }
  Promise.resolve(handle(message)).then(send).catch((error) => {
    send(rpcError(message?.id ?? null, -32603, error?.message ?? "Internal error"));
  });
});
rl.on("close", () => {
  try { store.close(); } catch { /* ignore */ }
  process.exit(0);
});
