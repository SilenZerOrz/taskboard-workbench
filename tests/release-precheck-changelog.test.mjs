/**
 * 发布完整性守卫（N8 · 卡 `-181` / 需求 `R136`）· `tools/release-precheck.mjs`
 *
 * 钉三件事：
 *   ① **正例通过**：CHANGELOG 头部版本 == package.json 且非 `[Unreleased]`；
 *   ② **两类反例必红**：头部停在 `[Unreleased]` / 头部版本与 package.json 漂移（外加「无标题」）；
 *   ③ **本仓库真实文件当前必须过**（对 0.2.3 不误伤），且**反向对照**——把真实 CHANGELOG 的头部
 *      标题改成 `[Unreleased]` 后必须转红（证明这条守卫真在测东西，不是摆设）。
 *
 * 为什么需要（0.2.1 实测教训）：tag 打在 `7162ab3`、CHANGELOG 定稿在其后的 `bf4139f`
 * ⇒ 「已发布内容与声明不一致」，当时没有任何机器守卫能拦。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { changelogProblems, parseChangelogHead } from "../tools/release-precheck.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const realChangelog = readFileSync(`${root}/CHANGELOG.md`, "utf8");
const realVersion = JSON.parse(readFileSync(`${root}/package.json`, "utf8")).version;

test("N8 守卫 · 正例：头部版本 == package.json 且非 Unreleased ⇒ 通过", () => {
  const text = ["# Changelog", "", "## [0.2.3] - 2026-10-30", "", "### 修复", "- 一条修复"].join("\n");
  assert.deepEqual(changelogProblems(text, "0.2.3"), []);
});

test("N8 守卫 · 反例1：头部仍是 [Unreleased] ⇒ 阻断", () => {
  const text = ["# Changelog", "", "## [Unreleased] — 目标 0.2.4", "", "### 修复", "- 未定稿"].join("\n");
  const problems = changelogProblems(text, "0.2.3");
  assert.equal(problems.length, 1, "必须恰好报一条");
  assert.match(problems[0], /Unreleased/, "必须点名 [Unreleased]");
  assert.match(problems[0], /0\.2\.3/, "提示里要给出期望的标题（package.json 版本）");
});

test("N8 守卫 · 反例2：CHANGELOG 0.2.3 / package.json 0.2.4 ⇒ 阻断（版本漂移）", () => {
  const problems = changelogProblems("## [0.2.3] - 2026-10-30\n", "0.2.4");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /0\.2\.3/);
  assert.match(problems[0], /0\.2\.4/);
  assert.match(problems[0], /漂移/);
});

test("N8 守卫 · 反例3：完全没有 `## [x]` 标题 ⇒ 阻断", () => {
  const problems = changelogProblems("# Changelog\n\n还没写任何版本。\n", "0.2.3");
  assert.equal(problems.length, 1);
  assert.match(problems[0], /未找到版本标题/);
});

test("N8 守卫 · 解析口径：只看第一个 `## [x]`，`### 子节` 不算标题", () => {
  const text = ["# Changelog", "## [0.2.3] - 2026-10-30", "### [不是标题] 这是三级小节的文字", "## [0.2.2] - 2026-10-29"].join("\n");
  assert.deepEqual(parseChangelogHead(text), { raw: "## [0.2.3] - 2026-10-30", version: "0.2.3" });
  assert.equal(parseChangelogHead("# 只有大标题\n"), null, "没有二级版本标题时返回 null");
});

test(`N8 守卫 · 本仓库真实文件当前必须通过（不误伤 ${realVersion}）`, () => {
  assert.deepEqual(changelogProblems(realChangelog, realVersion), []);
});

test("N8 守卫 · 反向对照：把真实 CHANGELOG 的头部标题改成 [Unreleased] ⇒ 必须转红", () => {
  const mutated = realChangelog.replace(/^##\s+\[[^\]]+\]/m, "## [Unreleased]");
  assert.notEqual(mutated, realChangelog, "替换必须真的命中头部标题（否则本用例是空转）");
  const problems = changelogProblems(mutated, realVersion);
  assert.equal(problems.length, 1, "改回 Unreleased 后必须报一条");
  assert.match(problems[0], /Unreleased/);
});
