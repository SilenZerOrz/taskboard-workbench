/**
 * 守卫（卡 `-222` / 需求 `R163` ④⑤）：`tools/bench-bootstrap-resilience.mjs` 必须**持续**证明
 * 「bootstrap 分步容错」的三件事，且必须保留能让它转红的东西。
 *
 * 为什么需要这条：本轮改动**全在呈现层**，而呈现层的证据只有那台真浏览器验证台。如果后来者为了
 * 「让台子变绿」把网络层注入换成桩、把反向对照删掉、或只测一条失败路径，台子会永久全绿却什么都没证明。
 *
 * 本守卫钉住六件事：
 *   ① 注入必须是**浏览器网络层**（CDP `Network.setBlockedURLs` ⇒ 页面收到真的 `TypeError: Failed to fetch`），
 *      不是把 `api()` 换成假函数那种自证；
 *   ② 需求验收 ① 点名的四条失败路径**一条都不能少**：`/api/meta`、`/api/projects`、`/api/context`、
 *      `/api/projects/:id/settings`；
 *   ③ 每条路径都要断言「有可读错误态」+「有可见重试按钮」（只断言其一可被半吊子实现蒙过）；
 *   ④ 验收 ②③ 必须各有独立证据：**重试真能恢复且不刷新整页**（页面标记 + `navigation` 条目数）、
 *      **11s 后失败横幅仍在**（既有 error banner 只活 10s）；
 *   ⑤ 必须有**反向对照**：基线不注入时看板真渲染、无失败态 UI（否则「任何时候都画面板」也能全绿）；
 *   ⑥ 台的可读选择器必须与 `web/app.js` 的实现一一对应（.tb-boot-panel / .tb-boot-strip / #tb-boot-retry），
 *      并保留 `TB_BENCH_WEB_DIR` 反证入口、180s 看门狗与「找不到浏览器 ⇒ SKIP + 退出码 2」。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools/bench-bootstrap-resilience.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web/app.js"), "utf8");

test("守卫 -222：注入必须是**浏览器网络层**失败（不是把 api() 换成假函数）", () => {
  assert.match(bench, /Network\.setBlockedURLs/, "必须用 CDP 网络层拦截（与真机同一个失败层）");
  assert.match(bench, /Failed to fetch\|Failed to load\|NetworkError\|net::/, "必须断言页面真收到了网络层失败");
  assert.doesNotMatch(bench, /window\.fetch\s*=/, "不得把 fetch 换成假的（那是自证，不是证据）");
});

test("守卫 -222：验收 ① 点名的四条失败路径一条都不能少", () => {
  assert.match(bench, /"\*\/api\/meta\*"/, "必须测必要步 /api/meta");
  assert.match(bench, /"\*\/api\/projects"/, "必须测必要步 /api/projects");
  assert.match(bench, /"\*\/api\/context\*"/, "必须测可降级步 /api/context");
  assert.match(bench, /"\*\/api\/projects\/\*\/settings\*"/, "必须测可降级步 /api/projects/:id/settings");
});

test("守卫 -222：每条失败路径既断言「可读错误态」也断言「可见重试按钮」", () => {
  // B 段（meta）：面板 + 失败行 + 重试按钮 + 「不画假空看板」
  assert.match(bench, /B0 必要步 \/api\/meta 失败/, "必须有 meta 面板断言");
  assert.match(bench, /B3 面板内「重试」是可见可点的 BUTTON/, "必须有 meta 路径的重试按钮断言");
  assert.match(bench, /B4 不画「假空看板」/, "必须断言失败时不是空看板（列/空列都为 0 且画了面板）");
  // C 段（projects）
  assert.match(bench, /C0 必要步 \/api\/projects 失败/, "必须有 projects 面板断言");
  assert.match(bench, /C1 该路径下同样有可见「重试」按钮/, "必须有 projects 路径的重试断言");
  // D/E/F 段（可降级三条）：看板照常 + 常驻条点名
  assert.match(bench, /D0 可降级步 \/api\/health 失败/, "必须有 health 降级断言");
  assert.match(bench, /D1 常驻条列出失败步 health/, "必须断言 health 被常驻条点名（可降级 ≠ 静默）");
  assert.match(bench, /D3 常驻条内也有「重试」按钮/, "必须有降级路径的重试断言");
  assert.match(bench, /E0 可降级步 \/api\/context 失败/, "必须有 context 降级断言");
  assert.match(bench, /F0 可降级步 \/api\/projects\/:id\/settings 失败/, "必须有 settings 降级断言");
});

test("守卫 -222：验收 ②「重试即恢复」必须证明**没有刷新整页**", () => {
  assert.match(bench, /window\.__tbBenchMark = 1/, "必须在恢复前打页面标记");
  assert.match(bench, /navs === 1 &&|g\.navs === 1|\.navs === 1/, "必须断言 navigation 条目数仍为 1");
  assert.match(bench, /G1 点「重试」后看板真渲染/, "必须断言恢复后看板真渲染");
  assert.match(bench, /G2 恢复路径\*\*没有刷新整页\*\*/, "必须显式断言没刷新整页（刷新整页不是唯一恢复手段）");
});

test("守卫 -222：验收 ③「失败横幅不被清」必须是**时间证据**（11s 后仍在）", () => {
  assert.match(bench, /sleep\(11200\)/, "必须等过既有 error banner 的 10s 自动消失窗");
  assert.match(bench, /B6 11s 后失败横幅仍在/, "必须断言横幅仍在");
  assert.match(app, /tb-banner-sticky/, "前端必须给失败横幅打 sticky 标记（不被定时器藏掉）");
  assert.match(app, /sticky \? null : setTimeout/, "sticky 横幅不得挂自动消失定时器");
});

test("守卫 -222：必须有反向对照（基线不注入 ⇒ 看板真渲染、无失败态 UI）", () => {
  assert.match(bench, /A0 基线：看板真渲染/, "必须有基线正读（防空跑）");
  assert.match(bench, /A1 基线：不得出现初始化面板\/常驻条/, "基线必须断言无失败态 UI（否则「总画面板」也能全绿）");
  assert.match(bench, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "必须有汇总判定");
  assert.match(bench, /process\.exit\(1\)/, "失败必须体现在退出码上");
});

test("守卫 -222：台的选择器必须与 web/app.js 的实现一一对应（两边不走样）", () => {
  // 台按 DOM 读：类名选择器 + `dataset.bootStep`（即 `data-boot-step`）——写死的是同一份契约。
  for (const selector of [".tb-boot-panel", ".tb-boot-strip", "#tb-boot-retry", ".tb-boot-failure", "dataset.bootStep"]) {
    assert.ok(bench.includes(selector), `验证台必须读 ${selector}`);
  }
  for (const marker of ['"empty-guide tb-boot-panel"', '"empty-guide tb-boot-strip"', "retry.id = \"tb-boot-retry\"", "dataset.bootStep = f.id"]) {
    assert.ok(app.includes(marker), `web/app.js 必须提供 ${marker}`);
  }
});

test("守卫 -222：前端的六步都必须经 runBootStep（不是又退回裸 await）", () => {
  for (const step of ["health", "meta", "context", "projects", "settings"]) {
    assert.match(app, new RegExp(`runBootStep\\("${step}"`), `bootstrap 的 ${step} 步必须走 runBootStep`);
  }
  assert.match(app, /if \(bootState\.running\) noteBootFailure\("binding"/, "绑定步失败也必须记账（bootstrap 期间）");
  assert.match(app, /if \(bootEssentialFailure\(\)\) \{ showBootPanel\(\); syncBootBanner\(\); return; \}/, "必要步失败必须只画面板（不画空看板）");
  assert.match(app, /if \(bootState\.failures\.length\) \{ renderBootStrip\(\); syncBootBanner\(\); \}/, "有失败时必须留常驻条与横幅");
  assert.match(app, /bootFailureSticky = false; hideBanner\(\); \}/, "只有全部成功才允许解锁并 hideBanner");
});

test("守卫 -222：失败面板不许被**定时刷新路径**顶掉（SSE / 60s 轮询 / 重新同步都走 loadTasks）", () => {  const loadTasksAt = app.indexOf("async function loadTasks()");
  assert.ok(loadTasksAt > 0, "loadTasks 必须在盘");
  const region = app.slice(loadTasksAt, loadTasksAt + 900);
  assert.match(region, /if \(bootEssentialFailure\(\)\) \{ showBootPanel\(\); return; \}/,
    "必要步失败期间 loadTasks 必须先画面板并退出（否则一次后台重取就把面板顶成空看板）");
  // 反向：不许用「反正会被 hideBanner 清掉」的实现 —— 失败未解除时 hideBanner 必须锁住。
  const hideAt = app.indexOf("const hideBanner = () => {");
  assert.ok(hideAt > 0, "hideBanner 必须在盘");
  assert.match(app.slice(hideAt, hideAt + 260), /if \(bootFailureSticky\) return;/,
    "失败未解除时 hideBanner 必须直接返回（任何后续收起都不得抹掉失败理由）");
  // 这条复发路径必须有**真渲染**证据：台内派发 focus 事件（窗口回流）驱动一次 loadTasks。
  assert.match(bench, /B7 后台刷新路径（focus 回流 → loadTasks）/, "必须断言后台刷新不顶掉面板");
  assert.match(bench, /dispatchEvent\(new Event\('focus'\)\)/, "必须真派发 focus 事件（不是假装调过）");
});

test("守卫 -222：必须保留 TB_BENCH_WEB_DIR 反证入口 + 看门狗 + 找不到浏览器给 SKIP/2", () => {
  assert.match(bench, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 目录做反证");
  assert.match(bench, /setTimeout\(\(\) => \{ console\.error\("FAIL  验证台整体超时/, "必须有 180s 看门狗");
  assert.match(bench, /process\.exit\(2\)/, "环境不具备必须 SKIP + 退出码 2");
  assert.match(bench, /CODEX_SANDBOX/, "沙箱内必须自检退出（不 spawn Chrome）");
});

test("守卫 -222：面板/常驻条必须**几何可读**（7 列网格里 grid-column:1/-1 会横跨整张网格）", () => {
  // 实测（1440 视口）：不收敛时面板 2172px 宽（画到视口外）；收敛后 760px，常驻条 1248px 居中。
  // 这条只有真渲染 rect 读得出 —— 源码守卫只能证明「规则在不在」，证明不了「最终谁胜出」。
  assert.match(bench, /B8 面板几何可读/, "必须断言面板不超出视口 + 页面无横向溢出");
  assert.match(bench, /D4 常驻条几何可读/, "必须断言常驻条不超出视口 + 按钮在条内");
  assert.match(bench, /retryInsidePanel/, "必须断言重试按钮在面板矩形内");
  assert.match(bench, /getBoundingClientRect/, "必须真读 rect（不是猜）");
  const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");
  assert.match(css, /\.tb-boot-panel \{ max-width: min\(760px, calc\(100vw - 24px\)\); \}/,
    "面板必须有宽度上限**且**按视口收敛（否则 7 列网格里横跨 2172px；窄视口 756px 时 760px 会溢出）");
  assert.match(css, /\.tb-boot-strip \{[^}]*max-width: var\(--board-max-width\)/, "常驻条必须与 banner 同宽上限");
});
