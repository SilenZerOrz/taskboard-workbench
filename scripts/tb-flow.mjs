#!/usr/bin/env node
/**
 * tb-flow.mjs —— 开局装载块（P4 档 A / 档 B 的同一个入口 + P5 档 C 的人工出口）
 *
 * 用法：
 *   node scripts/tb-flow.mjs start   [--project <id>] [--cwd <dir>] [--json]
 *   node scripts/tb-flow.mjs snippet [--project <id>]      # 打给项目 AGENTS.md 用的片段
 *   node scripts/tb-flow.mjs check                          # 只自检（不读写库）
 *   node scripts/tb-flow.mjs inject --session <id> [--role main|exec|related] [--project <id>]
 *                                [--host <url>] [--verify-bytes] [--json]
 *
 * 数据源：`--data-dir` > `$TB_DATA_DIR` > 默认（与 Web / CLI / MCP 同一份 `taskboard.sqlite`）。
 *
 * `start` / `snippet` / `check` **只读**：不建卡、不改状态、不写评论。
 * 与 MCP prompt `taskboard.flow` 共用 `src/mcp/flow-block.mjs`，输出**逐字节相同**。
 *
 * `inject`（P5 档 C · 卡 `-210`）：把**同一份**装载块投进指定会话，并落 `flow_injections` 审计行。
 *   · 它是**人工一次性**投递（审计 `policy=manual`）—— 自动注入由宿主 `createSession()` 按项目
 *     `flow_inject_policy` 决定，两者共用 `src/core/flow-inject.mjs`，所以内容不会出现第二真源；
 *   · 必须有一个**带宿主会话通道**的实例在跑（默认 `http://127.0.0.1:3080`，可用 `--host` 指到隔离实例）；
 *   · `--verify-bytes`：本地复算同一份正文的 sha256 与宿主回报的 `digest` 对拍（验收 ③ 的自检口）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentsSnippet, buildFlowBlock, buildFlowSummary, readSkill, SKILL_PATH } from "../src/mcp/flow-block.mjs";
import { openStore } from "../src/core/store.mjs";
import { resolveDataDir } from "../src/core/config.mjs";
import { resolveProject } from "../src/mcp/tools.mjs";
import { sha256 } from "../src/core/contract.mjs";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
/** 只跳过**带值**的选项，别把 `--session` 后面的会话 id 当成子命令。 */
const VALUE_FLAGS = new Set(["--project", "--cwd", "--data-dir", "--session", "--host", "--role"]);
const command = argv.find((a, i) => !a.startsWith("-") && !VALUE_FLAGS.has(argv[i - 1] ?? "")) ?? "start";
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

if (has("--help") || has("-h")) {
  process.stdout.write(`tb-flow · 任务看板开局装载块
用法:
  node scripts/tb-flow.mjs start   [--project <id>] [--cwd <dir>] [--json] [--data-dir <dir>]
  node scripts/tb-flow.mjs snippet [--project <id>]
  node scripts/tb-flow.mjs check
  node scripts/tb-flow.mjs inject --session <id> [--role main|exec|related] [--project <id>]
                                 [--host <url>] [--verify-bytes] [--json]
只读脚本：start / snippet / check 不建卡 / 不改状态 / 不写评论。
inject 是人工一次性投递（落 flow_injections 审计行，policy=manual），需要带宿主会话通道的实例在跑。
数据源同 Web/CLI（--data-dir > $TB_DATA_DIR > 默认）；--host 默认 $TB_HOST_URL 或 http://127.0.0.1:3080。
`);
  process.exit(0);
}

if (command === "check") {
  const skill = readSkill();
  process.stdout.write(`skill: ${skill.relPath} · name=${skill.meta.name} · version=${skill.meta.version} · requires_contract=${skill.meta.requires_contract}\n`);
  process.stdout.write(`八步段落: ${skill.steps.split("\n").filter((l) => l.startsWith("| **S")).length} 行 · 硬规则: ${skill.rules.split("\n").filter((l) => /^\d+\./.test(l)).length} 条\n`);
  process.exit(0);
}

if (command === "snippet") {
  process.stdout.write(`${buildAgentsSnippet({ project: argOf("--project"), pkgPath: PKG_ROOT })}\n`);
  process.exit(0);
}

if (command === "inject") {
  const sessionId = argOf("--session");
  if (!sessionId) {
    process.stderr.write("缺 --session <id>：要投进哪个会话\n");
    process.exit(2);
  }
  const role = argOf("--role");
  if (role && !["main", "exec", "related", "subagent"].includes(role)) {
    process.stderr.write(`--role 只能是 main / exec / related / subagent（收到 ${role}）\n`);
    process.exit(2);
  }
  const host = (argOf("--host") ?? process.env.TB_HOST_URL ?? "http://127.0.0.1:3080").replace(/\/+$/, "");
  let store = null;
  try {
    // 只传 `--project` 且不要求逐字节复算时，**不打开本地库**（投递本身在宿主侧完成）。
    let projectId = argOf("--project");
    if (!projectId || has("--verify-bytes")) {
      store = openStore({ dataDir: argOf("--data-dir") ?? resolveDataDir({ env: process.env }), env: process.env });
    }
    if (!projectId) {
      projectId = resolveProject(store, { cwd: argOf("--cwd") ?? process.cwd() }).project.id;
    }
    const url = `${host}/integrations/taskboard-workbench/api/projects/${encodeURIComponent(projectId)}/flow/inject`;
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ sessionId, ...(role ? { role } : {}), source: "tb-flow-cli" }),
      });
    } catch (error) {
      process.stderr.write(`HOST_UNREACHABLE: 连不上 ${url}（${error?.cause?.code ?? error?.message ?? error}）\n`);
      process.stderr.write("提示：inject 需要 DSH 内的任务工作台实例（或任意带宿主会话通道的实例）；可用 --host 指到隔离验证实例。\n");
      process.exit(4);
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok || !payload) {
      process.stderr.write(`HTTP ${res.status}: ${payload?.error ?? payload?.message ?? "宿主未回可解析的 JSON"}\n`);
      process.exit(1);
    }

    // 验收 ③ 的自检口：本地复算同一份正文，与宿主回报的 digest 对拍。
    let verify = null;
    if (has("--verify-bytes") && payload.digest) {
      try {
        const block = buildFlowBlock({ store, project: projectId });
        const localText = payload.version === "summary" ? buildFlowSummary(block) : block.text;
        const localDigest = sha256(localText);
        verify = { localDigest, match: localDigest === payload.digest, version: payload.version ?? null };
      } catch (error) {
        verify = { localDigest: null, match: null, reason: error?.code ?? String(error?.message ?? error) };
      }
    }

    if (has("--json")) {
      process.stdout.write(`${JSON.stringify({ projectId, sessionId, host, ...payload, verify }, null, 2)}\n`);
    } else if (payload.delivered) {
      process.stdout.write(`已注入 ${sessionId}（policy=${payload.policy} · version=${payload.version} · ${payload.chars} 字符）\n`);
      process.stdout.write(`project=${projectId} · contract=${payload.contractVersion} · digest=${payload.digest}\n`);
      process.stdout.write(`审计行：flow_injections#${payload.injection?.id ?? "?"} · injected_at=${payload.injection?.injectedAt ?? "?"}\n`);
      if (verify) process.stdout.write(`逐字节复算：${verify.match === true ? "一致" : verify.match === false ? "**不一致**" : `无法复算（${verify.reason}）`}\n`);
    } else {
      process.stderr.write(`未投递：${payload.reason}${payload.nextAction ? ` —— ${payload.nextAction}` : ""}\n`);
      if (payload.prompt) {
        // 投不进去的最坏情况：至少把正文原样交给人（粘贴即可），不让人空手。
        process.stderr.write("—— 以下是同一份正文，可直接粘贴到会话 ——\n");
        process.stdout.write(payload.prompt);
        if (!payload.prompt.endsWith("\n")) process.stdout.write("\n");
      }
    }
    if (verify && verify.match === false) process.exit(6);
    process.exit(payload.delivered ? 0 : 5);
  } catch (error) {
    process.stderr.write(`${error?.code ?? "ERROR"}: ${error?.message ?? String(error)}\n`);
    if (error?.code === "PROJECT_NOT_FOUND") {
      process.stderr.write(`提示：当前数据目录不含该项目；显式带 --project <id>，或用 --data-dir 指到真库。\n`);
      process.exit(3);
    }
    process.exit(1);
  } finally {
    try { store?.close(); } catch { /* ignore */ }
  }
}

if (command !== "start") {
  process.stderr.write(`未知子命令：${command}（可用：start / snippet / check / inject）\n`);
  process.exit(2);
}

const dataDir = argOf("--data-dir") ?? resolveDataDir({ env: process.env });
const store = openStore({ dataDir, env: process.env });
try {
  const block = buildFlowBlock({ store, project: argOf("--project"), cwd: argOf("--cwd") ?? process.cwd() });
  if (has("--json")) {
    process.stdout.write(`${JSON.stringify({
      project: block.project,
      contract: block.contract,
      gaps: block.gaps,
      nextStep: block.nextStep,
      skill: { ...block.skill, path: SKILL_PATH },
      dataDir: store.dataDir,
      block: block.text,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(block.text);
    process.stderr.write(`[tb-flow] dataDir=${store.dataDir} · 只读 · 与 MCP prompt taskboard.flow 同源\n`);
  }
} catch (error) {
  process.stderr.write(`${error?.code ?? "ERROR"}: ${error?.message ?? String(error)}\n`);
  if (error?.code === "PROJECT_NOT_FOUND") {
    // 默认数据目录是临时目录 ⇒ 用户几乎总会撞这一下。把「怎么指到真库」直接写出来。
    process.stderr.write(`提示：当前数据目录是 ${store.dataDir}（不含该项目）。看板在别的目录时显式带 --data-dir，例如：\n`);
    process.stderr.write(`  node scripts/tb-flow.mjs start --project <id> --data-dir .data\n`);
  }
  process.exit(error?.code === "PROJECT_NOT_FOUND" ? 3 : 1);
} finally {
  try { store.close(); } catch { /* ignore */ }
}
