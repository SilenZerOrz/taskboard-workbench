#!/usr/bin/env node
/**
 * tools/build-norms.mjs —— 机器规范 manifest 的构建与校验（P1 · 方案 §7.1）
 *
 * 用法：
 *   node tools/build-norms.mjs            # 重新生成 spec/norms/manifest.json
 *   node tools/build-norms.mjs --check    # 只校验（CI / npm test 用），不写文件
 *
 * 为什么要这个脚本：`spec/norms/*.md` 是**随包分发的唯一真源**，`version` + `digest` 是
 * 写操作校验的依据（`NORM_STALE`）。正文悄悄改了却不动 `version`，校验就形同虚设 ——
 * 这里把它变成**构建期红**，而不是运行期事故。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNormsManifest, diffNormsManifest, loadNorms } from "../src/core/contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// `TB_NORMS_DIR` 只给测试用（造夹具目录），正常构建永远用包内 spec/norms。
const NORMS_DIR = process.env.TB_NORMS_DIR ? path.resolve(process.env.TB_NORMS_DIR) : path.join(ROOT, "spec", "norms");
const MANIFEST = path.join(NORMS_DIR, "manifest.json");

const checkOnly = process.argv.includes("--check");

let norms;
try {
  norms = loadNorms(NORMS_DIR);
} catch (error) {
  console.error(`✗ 规范加载失败：${error.code ?? ""} ${error.message}`);
  process.exit(1);
}

const current = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { norms: [] };
const diff = diffNormsManifest(norms, current);

if (checkOnly) {
  if (diff.ok && !diff.needsWrite) {
    console.log(`✓ 规范 manifest 已是最新（${norms.length} 份：${norms.map((n) => `${n.id}@v${n.version}`).join(" · ")}）`);
    process.exit(0);
  }
  for (const issue of diff.issues) console.error(`✗ ${issue.code} · ${issue.message}`);
  if (diff.ok && diff.needsWrite) console.error("✗ manifest 与文件不一致（版本正确但未重新生成）：跑 node tools/build-norms.mjs");
  process.exit(1);
}

// 硬拒：只有「新增规范」允许直接写；`正文变了没 bump` / `版本回退` / `文件缺失` 一律不写 ——
// 否则等于用 manifest 把守卫抹平（这正是「悄悄改规范」的入口）。
const blocking = diff.issues.filter((i) => i.code !== "NORM_UNLISTED");
if (blocking.length) {
  for (const issue of blocking) console.error(`✗ ${issue.code} · ${issue.message}`);
  console.error("拒绝写入：先 bump 对应规范的 version，再重跑 node tools/build-norms.mjs");
  process.exit(1);
}
writeFileSync(MANIFEST, `${JSON.stringify(buildNormsManifest(norms), null, 2)}\n`);
console.log(`✓ 已写入 spec/norms/manifest.json（${norms.length} 份）`);
for (const issue of diff.issues) console.warn(`! ${issue.code} · ${issue.message}`);
