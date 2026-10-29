/**
 * P1 · 机器规范同源守卫（2026-10-29 · 方案 §7.1 / §17.3.1 D4 最终裁定）
 *
 * 为什么要有这份测试：`spec/norms/*.md` 是**随包分发的唯一真源**，`version` + `digest`
 * 是「用旧规范干活 ⇒ `NORM_STALE`」的依据。若允许「悄悄改正文不动 version」，整套校验就形同虚设。
 *
 * 判据：
 *   A 五份规范齐全、frontmatter 合法、与 manifest 完全一致（`--check` 语义）
 *   B **正文变了但 version 没 bump ⇒ `NORM_VERSION_NOT_BUMPED`**（这是本测试存在的理由）
 *   C bump version 后 ⇒ 仅需重写 manifest（`needsWrite`），不算错
 *   D manifest 登记了目录里不存在的规范 ⇒ `NORM_MISSING`
 *   E frontmatter 非法（缺 / norm_id 未知 / version 非整数）⇒ `NORM_INVALID`
 *   F 规范正文必须真写清四道门的错误码（防「空壳规范」——文件在、内容不在）
 *   G `node tools/build-norms.mjs --check` 真跑退出码 0
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NORM_IDS, buildNormsManifest, diffNormsManifest, loadNorms, parseNormDoc } from "../src/core/contract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMS_DIR = path.join(ROOT, "spec", "norms");
const MANIFEST = path.join(NORMS_DIR, "manifest.json");
const readManifest = () => JSON.parse(readFileSync(MANIFEST, "utf8"));

test("P1/A 五份机器规范齐全且 manifest 一致", () => {
  const norms = loadNorms(NORMS_DIR);
  assert.deepEqual(norms.map((n) => n.id).sort(), [...NORM_IDS].sort());
  for (const n of norms) {
    assert.ok(n.version >= 1, `${n.id} version 必须 ≥1`);
    assert.equal(typeof n.digest, "string");
    assert.equal(n.digest.length, 64);
    assert.match(n.updated, /^\d{4}-\d{2}-\d{2}$/);
  }
  const diff = diffNormsManifest(norms, readManifest());
  assert.equal(diff.ok, true, `manifest 与文件不一致：${JSON.stringify(diff.issues)}`);
  assert.equal(diff.needsWrite, false, "manifest 已过期，跑 node tools/build-norms.mjs");
});

test("P1/B 正文改了但 version 没 bump ⇒ NORM_VERSION_NOT_BUMPED", () => {
  const norms = loadNorms(NORMS_DIR);
  const manifest = buildNormsManifest(norms);
  const tampered = norms.map((n) => (n.id === "flow" ? { ...n, body: `${n.body}\n偷偷加一句\n`, digest: "0".repeat(64) } : n));
  const diff = diffNormsManifest(tampered, manifest);
  assert.equal(diff.ok, false);
  const issue = diff.issues.find((i) => i.code === "NORM_VERSION_NOT_BUMPED");
  assert.ok(issue, `期望 NORM_VERSION_NOT_BUMPED，实际 ${JSON.stringify(diff.issues)}`);
  assert.equal(issue.norm, "flow");
  assert.match(issue.message, /version/);
});

test("P1/C bump version 后只需重写 manifest，不算错", () => {
  const norms = loadNorms(NORMS_DIR);
  const manifest = buildNormsManifest(norms);
  const bumped = norms.map((n) => (n.id === "flow" ? { ...n, version: n.version + 1, digest: "1".repeat(64) } : n));
  const diff = diffNormsManifest(bumped, manifest);
  assert.equal(diff.ok, true, JSON.stringify(diff.issues));
  assert.equal(diff.needsWrite, true);
});

test("P1/D manifest 登记了不存在的规范 ⇒ NORM_MISSING", () => {
  const norms = loadNorms(NORMS_DIR).filter((n) => n.id !== "acceptance");
  const diff = diffNormsManifest(norms, readManifest());
  assert.equal(diff.ok, false);
  assert.ok(diff.issues.some((i) => i.code === "NORM_MISSING" && i.norm === "acceptance"), JSON.stringify(diff.issues));
});

test("P1/E frontmatter 非法 ⇒ NORM_INVALID（缺 / norm_id 未知 / version 非整数）", () => {
  assert.throws(() => parseNormDoc("# 没有 frontmatter\n"), (e) => e.code === "NORM_INVALID");
  assert.throws(() => parseNormDoc("---\nnorm_id: nope\nversion: 1\nupdated: 2026-10-29\napplies_to: [\"*\"]\n---\n正文\n"), (e) => e.code === "NORM_INVALID");
  assert.throws(() => parseNormDoc("---\nnorm_id: flow\nversion: one\nupdated: 2026-10-29\napplies_to: [\"*\"]\n---\n正文\n"), (e) => e.code === "NORM_INVALID");
  assert.throws(() => parseNormDoc("---\nnorm_id: flow\nversion: 1\nupdated: 2026/10/29\napplies_to: [\"*\"]\n---\n正文\n"), (e) => e.code === "NORM_INVALID");
});

test("P1/F 规范正文必须写清四道门的错误码（防空壳规范）", () => {
  const byId = new Map(loadNorms(NORMS_DIR).map((n) => [n.id, n.body]));
  const must = {
    flow: ["EXECUTION_NOT_ATTRIBUTED", "GOVERNANCE_AGENT_DONE", "HUMAN_REVIEW_NOT_EXECUTABLE", "REVIEW_NOT_APPROVED", "CONTRACT_STALE", "NORM_STALE"],
    "card-update": ["in_review", "approved", "skipReview", "blocked"],
    "doc-editing": ["当前状态.md", "脱敏"],
    acceptance: ["npm test", "node --check", "chrome-outside"],
    "project-defaults": ["verifyCommand", "workspacePath", "notApplicable", "NORM_OVERRIDE_FORBIDDEN"],
  };
  for (const [id, needles] of Object.entries(must)) {
    for (const needle of needles) assert.ok(byId.get(id).includes(needle), `${id}.md 缺关键内容：${needle}`);
  }
});

test("P1/G node tools/build-norms.mjs --check 退出码 0", () => {
  const res = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-norms.mjs"), "--check"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /已是最新/);
});

test("P1/H 临时目录里造一份缺文件的规范集 ⇒ loadNorms 报 NORM_NOT_FOUND", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "norms-"));
  try {
    const one = readFileSync(path.join(NORMS_DIR, "flow.md"), "utf8");
    writeFileSync(path.join(dir, "flow.md"), one);
    assert.throws(() => loadNorms(dir), (e) => e.code === "NORM_NOT_FOUND" && e.details?.missing?.includes("acceptance"));
    // 关掉 requireAll 后可单独读
    assert.equal(loadNorms(dir, { requireAll: false }).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("P1/I 构建期硬拒：正文变了没 bump ⇒ build-norms 退出码 1 且 manifest 不被覆盖", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "norms-build-"));
  try {
    for (const id of NORM_IDS) {
      // 只拷文件，不拷 manifest（先按当前内容生成一份）
      const src = path.join(NORMS_DIR, `${id}.md`);
      writeFileSync(path.join(dir, `${id}.md`), readFileSync(src, "utf8"));
    }
    const first = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-norms.mjs")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TB_NORMS_DIR: dir } });
    assert.equal(first.status, 0, first.stderr);
    const before = readFileSync(path.join(dir, "manifest.json"), "utf8");

    // 改正文不动 version（模拟「悄悄改规范」）
    const flow = path.join(dir, "flow.md");
    writeFileSync(flow, `${readFileSync(flow, "utf8")}\n偷偷加一句\n`);
    const bad = spawnSync(process.execPath, [path.join(ROOT, "tools", "build-norms.mjs")], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TB_NORMS_DIR: dir } });
    assert.equal(bad.status, 1, `期望拒绝写入，实际退出码 ${bad.status}`);
    assert.match(bad.stderr, /NORM_VERSION_NOT_BUMPED/);
    assert.equal(readFileSync(path.join(dir, "manifest.json"), "utf8"), before, "被拒绝时 manifest 不得被覆盖");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
