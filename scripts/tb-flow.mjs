#!/usr/bin/env node
/**
 * tb-flow.mjs —— 开局装载块（P4 · 档 A / 档 B 的同一个入口）
 *
 * 用法：
 *   node scripts/tb-flow.mjs start [--project <id>] [--cwd <dir>] [--json]
 *   node scripts/tb-flow.mjs snippet [--project <id>]      # 打给项目 AGENTS.md 用的片段
 *   node scripts/tb-flow.mjs check                          # 只自检（不读写库）
 *
 * 数据源：`--data-dir` > `$TB_DATA_DIR` > 默认（与 Web / CLI / MCP 同一份 `taskboard.sqlite`）。
 *
 * **只读**：本脚本不建卡、不改状态、不写评论、不写审计 —— 它只把"现在该干什么"打印出来。
 * 与 MCP prompt `taskboard.flow` 共用 `src/mcp/flow-block.mjs`，输出**逐字节相同**。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAgentsSnippet, buildFlowBlock, readSkill, SKILL_PATH } from "../src/mcp/flow-block.mjs";
import { openStore } from "../src/core/store.mjs";
import { resolveDataDir } from "../src/core/config.mjs";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const command = argv.find((a) => !a.startsWith("-") && argv[argv.indexOf(a) - 1] !== "--project" && argv[argv.indexOf(a) - 1] !== "--cwd" && argv[argv.indexOf(a) - 1] !== "--data-dir") ?? "start";

if (has("--help") || has("-h")) {
  process.stdout.write(`tb-flow · 任务看板开局装载块
用法:
  node scripts/tb-flow.mjs start   [--project <id>] [--cwd <dir>] [--json] [--data-dir <dir>]
  node scripts/tb-flow.mjs snippet [--project <id>]
  node scripts/tb-flow.mjs check
只读脚本：不建卡 / 不改状态 / 不写评论。数据源同 Web/CLI（--data-dir > $TB_DATA_DIR > 默认）。
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
  process.stdout.write(`${buildAgentsSnippet({ project: argOf("--project"), pkgPath: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") })}\n`);
  process.exit(0);
}

if (command !== "start") {
  process.stderr.write(`未知子命令：${command}（可用：start / snippet / check）\n`);
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
