/**
 * 守卫（2026-11-05 · 卡 `-224` / 需求 `R164`）：`tools/bench-drawer-button-hierarchy.mjs`
 * 必须**持续**验证「按钮位置 / 层级 / 尺寸」三件事，且必须保留**反向对照**。
 *
 * 为什么需要这条：本轮改动全在呈现层（`web/app.js` 的标题栏分区 + `web/tokens.css` 的层级与尺寸），
 * 唯一的证据就是那台真浏览器验证台。后来者若为了让台子变绿而删掉「primary ≤ 1」或「同高」的断言，
 * 台子会永久全绿却什么都没证明 —— 这正是 `-158` 台守卫立过的同一条规矩。
 *
 * 本守卫钉住五件事：
 *   ① 必须断言头部**两段** + 分隔线（位置统一，不再由 append 顺序决定）；
 *   ② 必须断言工具组顺序 `全部收起 → 全屏 → ✕`；
 *   ③ 必须断言**全抽屉 primary ≤ 1** 且落在「下一步」区（层级统一）；
 *   ④ 必须断言三处按钮**同高**（尺寸统一）—— 这是「样式不统一」里唯一无法靠源码断言的部分；
 *   ⑤ 必须保留 `TB_BENCH_WEB_DIR` 反证入口与退出码，并保留沙箱自检（不许在沙箱里硬起 Chrome）。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-drawer-button-hierarchy.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

test("守卫：`-224` 台必须断言头部两段 + 分隔线（位置统一）", () => {
  assert.match(src, /hasActions/, "必须读 `.tb-drawer-actions`");
  assert.match(src, /hasUtils/, "必须读 `.tb-drawer-utils`");
  assert.match(src, /tb-drawer-sep/, "必须读分隔线");
  assert.match(src, /actions → sep → utils|actions < d1\.order\.sep/, "必须断言 DOM 顺序");
});

test("守卫：`-224` 台必须断言工具组顺序固定", () => {
  assert.match(src, /全部收起 → 全屏 → ✕/, "必须把顺序写进断言文案");
  assert.match(src, /\[\"全部收起\", \"全屏\", \"✕\"\]/, "必须逐项比对三个工具按钮");
});

test("守卫：`-224` 台必须断言 primary ≤ 1 且落在「下一步」区（层级统一）", () => {
  assert.match(src, /primaryCount/, "必须数 primary");
  assert.match(src, /primaryInNextStep/, "必须断言主按钮的归属区块");
  assert.match(src, /primary ≤ 1/, "断言文案必须说明口径是可判定的一条");
});

test("守卫：`-224` 台必须断言三处按钮同高（尺寸统一 —— 源码断言替代不了）", () => {
  assert.match(src, /getBoundingClientRect\(\)\.height/, "必须读真实几何");
  assert.match(src, /new Set\(heights\)\.size === 1/, "必须断言高度集合只有一个值");
});

test("守卫：`-224` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(src, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(src, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(src, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(src, /process\.exit\(1\)/, "失败必须体现在退出码上");
  assert.match(src, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "必须有汇总判定");
});

test("守卫：前端必须真的实现两段头部 + 层级归一（否则台子断言的是空气）", () => {
  assert.match(app, /const drawerUtils = mk\("div", "tb-drawer-utils"\)/, "头部必须有工具段容器");
  assert.match(app, /drawerUtils\.append\(drawerExpandAll, drawerFull, drawerClose\)/, "工具组顺序必须写死");
  assert.match(app, /const normalizeActionTiers = \(\) => \{/, "必须有层级归一函数");
  assert.match(app, /normalizeActionTiers\(\);/, "必须在渲染收尾调用");
  assert.match(css, /\.tb-drawer button:not\(\.link\):not\(\.icon\) \{/, "抽屉按钮必须收敛成一套规则");
  assert.match(css, /\.tb-drawer-utils \{/, "工具组必须有自己的布局规则");
});
