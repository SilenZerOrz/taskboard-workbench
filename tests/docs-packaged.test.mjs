/**
 * 随包人读文档守卫（卡 `-219` / 需求 `R161`）
 *
 * 守四件事：
 *  ① 必备四份文档在位、README 目录与磁盘**双向**一致（漏一份、多一行都算坏）；
 *  ② **无私货**：绝对路径 / 临时目录 / 宿主 pid / 本仓条目号不得出现在「写给所有人」的文档里；
 *  ③ **反向对照**：往临时目录里塞一条私货 ⇒ 守卫必须转红（否则它只是「总返回 0」的摆设）；
 *  ④ `files` 白名单真的收了这个目录 —— 否则文件在位但不进包，等于没发。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkDocs, readmeManifest, REQUIRED_DOCS } from "../tools/check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "spec", "docs");

test("真实目录全过：必备四份在位 + README 与磁盘一致 + 无私货", () => {
  const r = checkDocs(DOCS);
  assert.equal(r.problems.length, 0, JSON.stringify(r.problems, null, 2));
  assert.deepEqual(REQUIRED_DOCS.filter((f) => !r.files.includes(f)), []);
});

test("README 目录段解析：拿到 3 条（除 README 外的全部 md）", () => {
  const listed = readmeManifest(readFileSync(path.join(DOCS, "README.md"), "utf8"));
  assert.deepEqual(listed, ["01-项目开局.md", "02-流程执行与条目.md", "assets/条目详情模板.md"]);
});

test("反向对照：塞一条作者本机绝对路径 ⇒ 转红", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-guard-"));
  try {
    cpSync(DOCS, dir, { recursive: true });
    // 夹具里的绝对路径**必须在运行时拼**：把 `/Users/...` 字面写进源码会被发布门禁的 L2（mac-home）判红 ——
    // 这条测试恰恰是「扫描绝对路径」的反向对照，它自己不能携带一条真的绝对路径。
    const fakeHome = ["", "Users", "someone", "work", "secret.md"].join("/");
    writeFileSync(path.join(dir, "01-项目开局.md"), readFileSync(path.join(dir, "01-项目开局.md"), "utf8") + `\n见 ${fakeHome}\n`);
    const r = checkDocs(dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.kind === "private-content"), JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("反向对照：删掉必备文档 ⇒ 转红（missing-file）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-guard-"));
  try {
    cpSync(DOCS, dir, { recursive: true });
    unlinkSync(path.join(dir, REQUIRED_DOCS[1]));
    const r = checkDocs(dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.kind === "missing-file"), JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("反向对照：README 与磁盘分叉 ⇒ readme-missing-entry 转红", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "docs-guard-"));
  try {
    cpSync(DOCS, dir, { recursive: true });
    writeFileSync(path.join(dir, "03-新增但没登记.md"), "# 新文档\n");
    const r = checkDocs(dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.kind === "readme-missing-entry" && p.target === "03-新增但没登记.md"), JSON.stringify(r.problems));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("files 白名单收了 `spec/docs`（文件在位但不进包＝没发）", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(pkg.files.includes("spec/docs"), "package.json files 缺 spec/docs");
  assert.ok(!pkg.files.includes("docs"), "docs/ 不得进包（本仓过程文档）");
});
