#!/usr/bin/env node
/**
 * 项目记忆初始化 / 重建索引（FR-116 / 卡 `-298`）
 *
 * 用法：
 *   node tools/memory-init.mjs --workspace /path/to/project            # 只补缺文件（不覆盖）
 *   node tools/memory-init.mjs --workspace /path/to/project --refresh-index
 *   node tools/memory-init.mjs --workspace /path/to/project --json
 *
 * 退出码：0 成功 · 2 参数错误 · 3 工作区不存在
 */
import { existsSync, statSync } from "node:fs";
import {
  MEMORY_FILE_NAMES, ensureProjectMemory, memoryDirOf, refreshMemoryIndex, scanProjectMemory,
} from "../src/core/project-memory.mjs";

function parseArgs(argv) {
  const out = { workspace: null, date: undefined, provenance: "human", refreshIndex: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--workspace" || a === "-w") out.workspace = argv[++i];
    else if (a === "--date") out.date = argv[++i];
    else if (a === "--provenance") out.provenance = argv[++i];
    else if (a === "--refresh-index") out.refreshIndex = true;
    else if (a === "--json") out.json = true;
    else if (a === "--help" || a === "-h") out.help = true;
    else out.bad = a;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log("用法: node tools/memory-init.mjs --workspace <项目工作区> [--refresh-index] [--json]");
  process.exit(0);
}
if (args.bad) { console.error(`未知参数：${args.bad}`); process.exit(2); }
if (!args.workspace) { console.error("缺少 --workspace <项目工作区>"); process.exit(2); }
if (!existsSync(args.workspace) || !statSync(args.workspace).isDirectory()) {
  console.error(`工作区不存在：${args.workspace}`);
  process.exit(3);
}

const ensured = ensureProjectMemory({ workspacePath: args.workspace, date: args.date, provenance: args.provenance });
const refreshed = args.refreshIndex ? refreshMemoryIndex({ workspacePath: args.workspace, date: args.date }) : null;
const scan = scanProjectMemory({ workspacePath: args.workspace });

const summary = {
  dir: memoryDirOf(args.workspace),
  files: MEMORY_FILE_NAMES,
  created: ensured.created,
  existing: ensured.existing,
  indexChanged: refreshed ? refreshed.changed : null,
  scan: {
    files: scan.files.map((f) => ({ name: f.name, entries: f.entries, digestShort: f.digestShort, digestMatches: f.digestMatches })),
    errors: scan.errors,
    extra: scan.extra,
  },
};

if (args.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`项目记忆目录：${summary.dir}`);
  console.log(`新建：${summary.created.length ? summary.created.join(", ") : "（无）"}`);
  console.log(`已存在：${summary.existing.length} 份`);
  if (refreshed) console.log(`索引：${refreshed.changed ? "已重写" : "无变化"}`);
  if (scan.errors.length) console.log(`坏/缺文件：${scan.errors.map((e) => `${e.file}(${e.error})`).join(", ")}`);
  if (scan.extra.length) console.log(`多余文件：${scan.extra.join(", ")}`);
}
