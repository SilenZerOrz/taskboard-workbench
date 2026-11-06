/**
 * 守卫（2026-11-05 · 卡 `-228` / 需求 `R169`）：`tools/bench-config-guide.mjs` 必须**持续**证明
 * 「配置页开局向导的步骤语义与判据取自真实数据」。
 *
 * 为什么需要这条：本轮的缺陷**全部长着正确的外形** —— 两行 `srow(false, 4|8, …)` 与其它步骤写法一致，
 * 界面上只是永远 ○，单看代码看不出错。后来者若为了省事把三态退回布尔、或把开工语塞回编号，
 * 台子会全绿而缺陷原样复活 ⇒ 与 `-224`/`-225`/`-226`/`-227` 四台守卫同一条规矩。
 *
 * 钉住九件事：
 *   ① 台必须断言全卡**没有**「第 8 步」，且徽标 `1–7` 连续（防「再塞一个假步骤」）；
 *   ② 台必须断言「开工语」行在「第 1 步」**之前**且有「复制开局提示词」；
 *   ③ 台必须断言第 4 步是 `◐` 待核验（**不得**退回 `○` 谎报未做）；
 *   ④ 台必须断言第 6 步「待确认 1 · 已确认 3」（done/closed 计入已确认）；
 *   ⑤ 台必须断言「复制团队创建指令」全卡唯一；
 *   ⑥ 台必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与退出码；
 *   ⑦ `web/app.js` 的 `srow` 必须是三态，且 `null` 渲染成 `◐` + title「待核验」；
 *   ⑧ `web/app.js` 必须**不再有** `srow(false, 4` / `srow(false, 8` 这类假判据；
 *   ⑨ 「已确认」必须按 `status !== "draft"` 计（不得退回只数 `open`）。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools/bench-config-guide.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");

test("守卫：`-228` 台必须断言没有「第 8 步」且徽标 1–7 连续", () => {
  assert.match(bench, /!\/第\\s\*8\\s\*步\/\.test\(g\.text\)/, "必须禁止「第 8 步」");
  assert.match(bench, /JSON\.stringify\(badgeNums\) === JSON\.stringify\(\[1, 2, 3, 4, 5, 6, 7\]\)/, "编号必须 1–7 连续且按 DOM 顺序");
});

test("守卫：`-228` 台必须断言开工语置顶且可复制", () => {
  assert.match(bench, /kickIdx >= 0 && step1Idx > kickIdx/, "开工语必须排在第一步之前");
  assert.match(bench, /buttons\.includes\("复制开局提示词"\)/, "开工语行必须有复制按钮");
});

test("守卫：`-228` 台必须断言第 4 步是 ◐ 待核验（不是 ○）", () => {
  assert.match(bench, /step4\.badge\.startsWith\("◐"\)/, "第 4 步必须是待核验态");
  assert.match(bench, /第 4 步是 ◐ 待核验（不谎报成 ○ 未做）/, "用例名必须写清口径");
});

test("守卫：`-228` 台必须断言第 6 步把 done/closed 计入已确认", () => {
  assert.match(bench, /待确认 1/, "必须核对待确认数");
  assert.match(bench, /已确认 3/, "必须核对已确认数（2 done + 1 closed + 1 open ⇒ 3）");
});

test("守卫：`-228` 台必须断言创建指令按钮唯一", () => {
  assert.match(bench, /createCmds\.length === 1/, "同一动作不得有两个按钮");
});

test("守卫：`-228` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(bench, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(bench, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(bench, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(bench, /process\.exit\(1\)/, "失败必须体现在退出码上");
});

test("守卫：`srow` 必须是三态，`null` 渲染为 ◐ + 待核验说明", () => {
  assert.match(app, /const srow = \(state, n, title, \.\.\.actions\) => \{/, "srow 必须接三态参数");
  assert.match(app, /state === true[\s\S]{0,120}state === false[\s\S]{0,160}pill\(`◐ 第 \$\{n\} 步`, "", "本机没有可核验信号/, "null 必须落到 ◐ + title");
});

test("守卫：开工语行必须存在、先于步骤追加，且不编号", () => {
  assert.match(app, /const kickoffRow = mk\("div", "config-row"\);/, "必须有独立开工语行");
  assert.match(app, /kickoffRow\.appendChild\(pill\("开工语", "warn"/, "开工语徽标不编号");
  const guideBlock = app.slice(app.indexOf('const guide = mk("section", "config-card");'), app.indexOf("box.appendChild(guide);"));
  assert.ok(guideBlock.indexOf("guide.appendChild(kickoffRow);") < guideBlock.indexOf("guide.append("), "开工语必须先于 1–7 步追加");
});

test("守卫：不得再有 `srow(false, N` 假判据，且已确认按非 draft 计", () => {
  assert.ok(!/srow\(false,\s*\d/.test(app), "不得用硬编码 false 充当「未完成」");
  assert.match(app, /const gConfirmed = gItemsAll\.filter\(\(i\) => i\.status !== "draft"\)\.length/, "已确认必须含 done/closed");
  assert.ok(!/const gOpen = gItemsAll\.filter\(\(i\) => i\.status === "open"\)/.test(app), "不得退回只数 open");
});
