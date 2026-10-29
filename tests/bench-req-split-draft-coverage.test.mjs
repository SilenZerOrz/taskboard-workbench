/**
 * 「分拆草稿」验证台的守卫：这台真浏览器台必须**持续**在，且不许被悄悄削薄。
 *
 * 单测（`tests/fr-req-split-ask.test.mjs`）证明得了端点无副作用、指令里有边界；
 * 证明不了**按钮真的接上线、粘回来的依赖真的变成边** —— 那是这台的责任。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-req-split-draft.mjs"), "utf8");

test("台1：隔离形态（临时 dataDir/profile + 随机端口 + 假宿主通道，跑完即删）", () => {
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-splitdraft-"\)\)/);
  assert.match(BENCH, /store\.hostSessionPort = \{ sendPrompt/, "必须用假宿主通道只记录不真投");
  assert.match(BENCH, /await rm\(dir, \{ recursive: true, force: true \}\)/);
  assert.equal(/127\.0\.0\.1:3080/.test(BENCH), false, "不得接触用户的 :3080 实例");
});

test("台2：三个按钮 + 意见框都要在渲染后的 DOM 里点到", () => {
  assert.ok(BENCH.includes("自动生成（交主会话）"));
  assert.ok(BENCH.includes("按意见重生成"));
  assert.ok(BENCH.includes("生成任务 + 依赖"));
  assert.ok(BENCH.includes("修改意见"), "必须验意见框与任务行框是两个");
});

test("台3：必须验「投递不建卡」与「落库带 kind/依赖」（两条都是本轮修的真缺陷）", () => {
  assert.match(BENCH, /不建卡/, "必须断言投递零副作用");
  assert.ok(BENCH.includes("kind/review") && BENCH.includes("kind/work"), "必须验 kind 落标签");
  assert.match(BENCH, /requirementTaskGraph\(item\.identifier\)/, "必须验依赖真的成边");
});

test("台4：反向对照入口 + 退出码契约", () => {
  assert.match(BENCH, /TB_BENCH_WEB_DIR/, "必须留反向对照入口");
  assert.match(BENCH, /未找到 Chrome/);
  assert.match(BENCH, /process\.exit\(2\)/);
});
