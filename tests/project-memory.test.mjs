/**
 * 项目记忆骨架（FR-116 / 卡 `-298` · 设计稿 `-288` C-1/C-2/C-3/C-12）
 *
 * 守四件事：① 六份文件一次成型且 digest 可复算；② **不覆盖已有正文**（二次 init zero write）；
 * ③ 坏文件不炸（跳过并报错，同 `readProjectNorms` 的逐份容错口径）；④ 索引是派生品，可重生成且幂等。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MEMORY_FILES, MEMORY_FILE_NAMES, ensureProjectMemory, memoryDigest, memoryDirOf,
  normalizeMemoryBody, parseMemoryFile, refreshMemoryIndex, scanProjectMemory,
} from "../src/core/project-memory.mjs";

const freshWs = (label) => mkdtempSync(path.join(os.tmpdir(), `tb-mem-${label}-`));
const cleanup = (ws) => rmSync(ws, { recursive: true, force: true });

test("初始化：六份文件齐、frontmatter 六字段齐、digest 与正文可复算", () => {
  const ws = freshWs("init");
  try {
    const r = ensureProjectMemory({ workspacePath: ws, date: "2026-11-24" });
    assert.equal(r.created.length, 6);
    assert.deepEqual(r.created.sort(), [...MEMORY_FILE_NAMES].sort());
    const dir = memoryDirOf(ws);
    assert.equal(r.dir, dir);
    for (const name of MEMORY_FILE_NAMES) {
      const parsed = parseMemoryFile(readFileSync(path.join(dir, name), "utf8"), name);
      assert.equal(parsed.ok, true, `${name} 必须可解析`);
      assert.equal(parsed.meta.scope, "project");
      assert.equal(parsed.meta.updated, "2026-11-24");
      assert.equal(parsed.meta.provenance, "human");
      assert.equal(parsed.meta.norm_version, "1");
      assert.equal(parsed.meta.digest, memoryDigest(parsed.body), `${name} 的 digest 必须是正文现算值`);
    }
    const scan = scanProjectMemory({ workspacePath: ws });
    assert.equal(scan.errors.length, 0);
    assert.equal(scan.extra.length, 0);
    assert.ok(scan.files.every((f) => f.digestMatches), "全部文件 digestMatches 必须为 true");
  } finally { cleanup(ws); }
});

test("不覆盖：二次 init 一字不动（created 为空、内容与 mtime 不变）", () => {
  const ws = freshWs("nooverwrite");
  try {
    const dir = ensureProjectMemory({ workspacePath: ws, date: "2026-11-24" }).dir;
    const target = path.join(dir, "decisions.md");
    appendFileSync(target, "\n## decision:keep · 人写的决策\n正文不许被初始化覆盖。\n");
    const before = readFileSync(target, "utf8");
    const beforeMtime = statSync(target).mtimeMs;
    const again = ensureProjectMemory({ workspacePath: ws, date: "2026-11-25" });
    assert.deepEqual(again.created, []);
    assert.equal(again.existing.length, 6);
    assert.equal(readFileSync(target, "utf8"), before, "正文不得被覆盖");
    assert.equal(statSync(target).mtimeMs, beforeMtime, "未写就不该更新 mtime");
  } finally { cleanup(ws); }
});

test("digest 随正文变化：手写 digest 被视为过期（digestMatches=false），刷新索引后对齐", () => {
  const ws = freshWs("digest");
  try {
    const dir = ensureProjectMemory({ workspacePath: ws, date: "2026-11-24" }).dir;
    const target = path.join(dir, "facts.md");
    appendFileSync(target, "\n## fact:dsh-version · 真机版本\n- 值：0.2.2-rc.5\n");
    let scan = scanProjectMemory({ workspacePath: ws });
    let facts = scan.files.find((f) => f.name === "facts.md");
    assert.equal(facts.entries, 1);
    assert.equal(facts.digestMatches, false, "改了正文却没重算 digest ⇒ 必须报不一致");
    const first = refreshMemoryIndex({ workspacePath: ws, date: "2026-11-24" });
    assert.equal(first.changed, true);
    const index = readFileSync(path.join(dir, "README.md"), "utf8");
    assert.ok(index.includes(facts.digestShort), "索引必须写现算的 digest 短码");
    assert.ok(index.includes("| `facts.md`"), "索引必须有 facts.md 行");
    const second = refreshMemoryIndex({ workspacePath: ws, date: "2026-11-24" });
    assert.equal(second.changed, false, "索引刷新必须幂等");
  } finally { cleanup(ws); }
});

test("坏文件不炸：缺 title ⇒ errors 命中 MISSING_TITLE，其余文件照常入索引", () => {
  const ws = freshWs("bad");
  try {
    const dir = ensureProjectMemory({ workspacePath: ws, date: "2026-11-24" }).dir;
    const target = path.join(dir, "glossary.md");
    const broken = readFileSync(target, "utf8").replace(/^title:.*\n/m, "");
    writeFileSync(target, broken, "utf8");
    const scan = scanProjectMemory({ workspacePath: ws });
    assert.ok(scan.errors.some((e) => e.file === "glossary.md" && e.error === "MISSING_TITLE"));
    assert.ok(!scan.files.some((f) => f.name === "glossary.md"), "坏文件不进 files");
    assert.ok(scan.files.some((f) => f.name === "decisions.md"), "好文件不受影响");
  } finally { cleanup(ws); }
});

test("漂移可见：多余 .md 进 extra；缺文件进 errors(MISSING)", () => {
  const ws = freshWs("drift");
  try {
    const dir = ensureProjectMemory({ workspacePath: ws, date: "2026-11-24" }).dir;
    writeFileSync(path.join(dir, "notes.md"), "# 野文件\n", "utf8");
    rmSync(path.join(dir, "handoff.md"));
    const scan = scanProjectMemory({ workspacePath: ws });
    assert.deepEqual(scan.extra, ["notes.md"]);
    assert.ok(scan.errors.some((e) => e.file === "handoff.md" && e.error === "MISSING"));
  } finally { cleanup(ws); }
});

test("归一化：CRLF / 行尾空白 / 多余空行不影响 digest", () => {
  const a = "line1\nline2\n";
  const b = "line1  \r\nline2\t\r\n\r\n\r\n";
  assert.equal(normalizeMemoryBody(a), normalizeMemoryBody(b));
  assert.equal(memoryDigest(a), memoryDigest(b));
});

test("npm 包边界：`package.json#files` 不含 `.taskboard/`（记忆不进包）", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const files = pkg.files ?? [];
  assert.ok(!files.some((f) => String(f).includes(".taskboard")), "记忆目录不得随包分发");
  assert.ok(MEMORY_FILES.length === 6, "六份文件钉死，多一份少一份都算改格式");
});
