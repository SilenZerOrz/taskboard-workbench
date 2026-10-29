/**
 * 守卫（2026-10-27 · 卡 `-160` 第二轮）：`tools/bench-req-item-list.mjs` 必须**持续**验证
 * 「列表内完成度结论」这件事，且必须保留**反向对照**与**反证入口**。
 *
 * 为什么需要这条：本轮的改动仍然全在呈现层（`web/app.js` 的行结构 + `web/tokens.css`），
 * 而呈现层的唯一硬证据就是那台真浏览器验证台。后来者为了「让台子变绿」而删掉 K/K2/L/M
 * 或反向对照，台子会永久全绿却什么都没证明。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-req-item-list.mjs"), "utf8");

test("守卫：`-160` 台必须是**真浏览器 + 读渲染后 DOM**（不能退化成读源码）", () => {
  assert.match(src, /--headless=new/, "必须起真 headless Chrome");
  assert.match(src, /Runtime\.evaluate/, "必须通过 CDP 在页面里求值");
  assert.match(src, /getBoundingClientRect\(\)/, "必须读真实布局尺寸（不是读源码文本）");
  assert.match(src, /dataset\.verdict/, "完成度胶囊要读渲染后的 data-verdict");
});

test("守卫：`-160` 台必须保留 K / K2 / L / M 四条「列表内完成度」判据", () => {
  assert.match(src, /check\("K 列表内逐行显示完成度结论/, "必须逐行比对完成度文案与档位（验收第 2 条）");
  assert.match(src, /check\("K2 面板头「可收口 N」/, "必须有面板级「可收口 N」断言");
  assert.match(src, /check\("L 完成度列定宽逐行对齐、列表无横向滚动/, "必须断言完成度列定宽对齐且不撑宽行");
  assert.match(src, /check\("M 点完成度胶囊/, "必须断言点胶囊能开抽屉并定位");
});

test("守卫：`-160` 台的反向对照必须覆盖完成度列（K 也要能转红）", () => {
  assert.match(src, /req-completion-chip\{display:none!important\}/, "反证样式要能隐藏完成度列");
  assert.match(src, /const redK = /, "反向对照必须算出 K 红");
  assert.match(src, /C\/E\/F\/G\/K 五条判据转红/, "汇总断言必须把 K 算进去");
});

test("守卫：`-160` 台的 M 判据不得退化成「反正一开始就看得见」", () => {
  assert.match(src, /scrollTop > 0/, "必须要求真滚动（否则抽屉内容短时天然为 0 也能过）");
  assert.match(src, /scrollable/, "必须要求抽屉内容确实高于一屏");
  assert.match(src, /超长验收要点/, "必须用超长内容把「关联任务完成情况」段顶出一屏");
});

test("守卫：`-160` 台的种子必须覆盖五档结论，且「可收口」计数有独立期望", () => {
  for (const verdict of ["no-tasks", "in-progress", "in-review", "blocked", "all-closed"]) {
    assert.match(src, new RegExp(`verdict: "${verdict}"`), `种子缺结论档：${verdict}`);
  }
  assert.match(src, /const EXPECT_READY = /, "「可收口 N」必须有独立期望值（不拿产品函数自证）");
  assert.match(src, /store\.associateRequirementTask\(/, "任务必须真归因到需求条目（否则完成度恒为 no-tasks）");
});

test("守卫：`-160` 台必须是隔离台（临时目录 + 随机端口），且保留反证入口与退出码", () => {
  assert.match(src, /mkdtemp\(/, "必须用临时 dataDir / profile");
  assert.match(src, /const freePort = /, "必须随机端口（不占用用户服务端口）");
  assert.ok(!/127\.0\.0\.1:3080/.test(src), "不得碰用户的 :3080");
  assert.match(src, /process\.env\.TB_BENCH_WEB_DIR/, "必须保留 TB_BENCH_WEB_DIR 反证入口");
  assert.match(src, /process\.exit\(failed\.length \? 1 : 0\)/, "失败必须体现在退出码上");
});
