/**
 * 守卫（2026-11-05 · 卡 `-225` / 需求 `R166`）：`tools/bench-req-toolbar.mjs` 必须**持续**验证
 * 需求条目面板工具区的四件事（对齐 / 宽度 / 右边缘 / 同高），且必须保留**反向对照**。
 *
 * 为什么需要这条：本轮的改动**全在呈现层**（`web/app.js` 的三段重排 + `web/tokens.css` 的尺寸口径），
 * 唯一的证据就是那台真浏览器几何验证台。后来者若为了让台子变绿而删掉「右边缘对齐」或「同高」断言，
 * 台子会永久全绿却什么都没证明 —— 与 `-158` / `-224` 两台守卫同一条规矩。
 *
 * 本守卫钉住五件事：
 *   ① 必须断言两行首个控件**左边缘对齐**（同类输入框在同一列起头）；
 *   ② 必须断言输入宽 **200–420** 与"输入→按钮"间距（宽度可由 UA 默认值决定，是这条批注的直接成因）；
 *   ③ 必须断言提示与批量动作组**右边缘对齐**（真机批注的另一半：右侧空一大片、动作挤左边）；
 *   ④ 必须断言**同高**且**无横向溢出**（几何，源码断言替代不了）；
 *   ⑤ 必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与退出码。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-req-toolbar.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

test("守卫：`-225` 台必须断言两行首控件左边缘对齐", () => {
  assert.match(src, /leftCreate/, "必须读新建行首控件左边缘");
  assert.match(src, /leftFilter/, "必须读筛选行首控件左边缘");
  assert.match(src, /Math\.abs\(geo\.leftCreate - geo\.leftFilter\) <= 1/, "必须断言 |Δx| ≤ 1px");
});

test("守卫：`-225` 台必须断言输入宽度与输入→按钮间距", () => {
  assert.match(src, /inputW/, "必须读输入框宽度");
  assert.match(src, /gapInputBtn/, "必须读输入与按钮间距");
  assert.match(src, /geo\.inputW >= 200 && geo\.inputW <= 420/, "必须断言宽度区间 200–420");
  assert.match(src, /geo\.gapInputBtn <= 12/, "必须断言间距 ≤ 12px");
});

test("守卫：`-225` 台必须断言提示与批量动作组右边缘对齐", () => {
  assert.match(src, /hintRight/, "必须读提示右边缘");
  assert.match(src, /bulkRight/, "必须读批量动作组右边缘");
  assert.match(src, /deleteDanger/, "必须断言「批量删除」为 danger 档（不与主按钮同色）");
});

test("守卫：`-225` 台必须断言控件同高与无横向溢出（几何，源码替代不了）", () => {
  assert.match(src, /heights/, "必须读真实高度");
  assert.match(src, /hSpread <= 1/, "必须断言高度差 ≤ 1px");
  assert.match(src, /scrollWidth - body\.clientWidth/, "必须读真实溢出量");
  assert.match(src, /geo\.overflow <= 1/, "必须断言无横向溢出");
});

test("守卫：`-225` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(src, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(src, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(src, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(src, /process\.exit\(1\)/, "失败必须体现在退出码上");
  assert.match(src, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "必须有汇总判定");
});

test("守卫：前端必须真的实现三段结构（否则台子断言的是空气）", () => {
  assert.match(app, /const reqToolbar = mk\("div", "req-toolbar"\)/, "必须有 .req-toolbar 容器");
  assert.match(app, /req-toolbar-row req-toolbar-create/, "新建行必须有独立类");
  assert.match(app, /req-toolbar-row req-toolbar-filter/, "筛选行必须有独立类");
  assert.match(app, /req-toolbar-hint/, "提示必须并到筛选行");
  assert.match(app, /const bulkActions = mk\("div", "req-bulk-actions"\)/, "批量动作必须有独立容器");
  assert.match(app, /"danger"\),\n        \);\n        \/\/ 五个动作整体挪到右侧动作组/, "批量删除必须是 danger 档");
  assert.match(css, /\.req-toolbar-row > input\[type="text"\],/, "必须有输入宽度口径");
  assert.match(css, /height: 30px; min-height: 30px/, "必须显式钉高（min-height 会保留原生 31/29/28）");
});
