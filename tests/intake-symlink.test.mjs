/**
 * 卡 `-175`（2026-10-29）：intake 扫描器**静默跳过符号链接**。
 *
 * 根因：`walk()` 只判 `entry.isFile()` / `entry.isDirectory()`，而 `Dirent.isFile()` 对符号链接**恒为 false**
 * ⇒ 软链文档既不进索引、也不报错、也不计数。本仓 `docs/团队agent.md → ../spec/团队agent.md` 就是这么丢的
 * （`docsTotal` 长期少 1，且没有任何读数提示）。
 *
 * 本文件把「跟随 / 断链 / 越界 / 环路 / 目录软链」五种情形都钉成可复跑判据。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { scanProjectMaterials } from "../src/core/intake.mjs";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "tb-symlink-"));

test("-175 ① 软链文档被跟随：进索引 + 标 symlink:true + followed 计数", async () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "spec"));
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "spec", "团队agent.md"), "# 团队契约\n");
    symlinkSync("../spec/团队agent.md", path.join(root, "docs", "团队agent.md"));

    const r = await scanProjectMaterials(root);
    const hit = r.files.find((f) => f.relPath === "docs/团队agent.md");
    assert.ok(hit, "软链文档必须进索引（此前被静默跳过）");
    assert.equal(hit.symlink, true, "要能区分「这是软链」——否则排障时看不出它是跟随来的");
    assert.equal(r.symlinks.followed, 1);
    assert.deepEqual(r.symlinks.skipped, []);
    // 目标真身也在索引里（跟随不替代真身），两条 relPath 不同 ⇒ 不去重
    assert.ok(r.files.some((f) => f.relPath === "spec/团队agent.md"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("-175 ② 断链被跳过但**记账**（reason=broken），不静默", async () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
    symlinkSync("../nowhere/missing.md", path.join(root, "docs", "dead.md"));

    const r = await scanProjectMaterials(root);
    assert.equal(r.files.some((f) => f.relPath === "docs/dead.md"), false);
    const sk = r.symlinks.skipped.find((s) => s.relPath === "docs/dead.md");
    assert.ok(sk, "断链必须进 skipped 清单（否则又是静默）");
    assert.equal(sk.reason, "broken");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("-175 ③ 指向 root 之外的软链被拒（reason=outside-root）", async () => {
  const outer = tmp();
  const root = path.join(outer, "root");
  try {
    mkdirSync(root, { recursive: true });
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(outer, "outside.md"), "# 不该被引入\n");
    symlinkSync("../../outside.md", path.join(root, "docs", "escape.md"));  // root/docs → outer/outside.md = root 之外

    const r = await scanProjectMaterials(root);
    assert.equal(r.files.some((f) => f.relPath === "docs/escape.md"), false, "越界软链不得被引入");
    const sk = r.symlinks.skipped.find((s) => s.relPath === "docs/escape.md");
    assert.ok(sk);
    assert.equal(sk.reason, "outside-root");
  } finally { rmSync(outer, { recursive: true, force: true }); }
});

test("-175 ④ 环路软链不会无限递归（目录软链指回祖先）", async () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "docs"));
    writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
    symlinkSync("..", path.join(root, "docs", "loop"));

    const r = await scanProjectMaterials(root, { maxDepth: 6 });
    assert.equal(r.truncated, false, "环路必须靠 realpath 去重挡住，而不是靠 maxDepth 截断");
    assert.equal(r.files.filter((f) => f.relPath === "docs/a.md").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("-175 ⑤ 目录软链指向 root 内的真目录：被展开且文件路径按**链接路径**记", async () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, "real", "sub"), { recursive: true });
    writeFileSync(path.join(root, "real", "sub", "x.md"), "# X\n");
    symlinkSync("real/sub", path.join(root, "alias"));

    const r = await scanProjectMaterials(root);
    // 目录软链内的**子文件**本身不是软链（软链是那层目录），故只断言路径出现、不要求 symlink 标记。
    assert.ok(r.files.some((f) => f.relPath === "alias/x.md"), "目录软链内的文件要按链接路径出现");
    assert.ok(r.files.some((f) => f.relPath === "real/sub/x.md"), "真身路径也要在（跟随不替代）");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("-175 ⑥ 本仓实测：docs/团队agent.md 进索引，且没有软链被静默丢弃", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const r = await scanProjectMaterials(root);
  const link = path.join(root, "docs", "团队agent.md");
  let exists = true;
  try { realpathSync(link); } catch { exists = false; }
  if (!exists) return; // 没有该软链的环境（如干净 worktree）跳过
  assert.ok(r.files.some((f) => f.relPath === "docs/团队agent.md"), "本仓的 docs/团队agent.md 必须进索引");
  assert.equal(r.symlinks.skipped.filter((s) => s.reason !== "ext-not-allowed").length, 0);
});

test("-175 ⑦ 祖先链不被「早退」打断：环路之后同一批文件不得被重复收进索引", async () => {
  // 反证对象：chain 的 push/pop 若由**调用方**负责，被调方在 push 之前早退
  // （这里是最常见的 `depth > maxDepth`）就会把调用方自己的条目弹掉 ⇒ 链损坏
  // ⇒ 排在后面的兄弟软链不再被识别为环 ⇒ 同一批文件以不同 relPath 再收一遍（静默重复，正是 -175 要消灭的形态）。
  const root = tmp();
  try {
    mkdirSync(path.join(root, "a", "b"), { recursive: true }); // a/b 的深度超过 maxDepth ⇒ a 的子调用会早退
    writeFileSync(path.join(root, "x.md"), "# X\n");
    symlinkSync(".", path.join(root, "z"));                     // 兄弟软链指回 root 自身（排序在 a 之后）

    const r = await scanProjectMaterials(root, { maxDepth: 1 });
    assert.equal(r.truncated, false, "不得靠 maxFiles 截断来掩盖问题");
    assert.equal(r.files.filter((f) => f.relPath === "x.md").length, 1, "x.md 只能出现一次");
    assert.equal(r.files.length, 1, "整次扫描只该有 1 份文档");
    const sk = r.symlinks.skipped.find((s) => s.relPath === "z");
    assert.ok(sk, "指回 root 的软链要进 skipped 记账");
    assert.equal(sk.reason, "loop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
