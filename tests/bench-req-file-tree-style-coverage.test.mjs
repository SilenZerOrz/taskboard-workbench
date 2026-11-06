/**
 * 守卫（2026-11-05 · 卡 `-226` / 需求 `R167`）：`tools/bench-req-file-tree-style.mjs` 必须**持续**验证
 * 「引入的文件」树的侧栏形态（无卡片盒 / 箭头两态 / 缩进步长 / 类型徽标 / 定宽体积列 / FR-96 零回归）。
 *
 * 为什么需要这条：本轮改动**全在呈现层**，唯一的证据就是那台真几何验证台。后来者若为了让台子变绿
 * 而删掉「三色互不相同」或「FR-96 零回归」这类断言，台子会永久全绿却什么都没证明。
 * 同样的规矩已在 `-158` / `-224` / `-225` 三台守卫上用过了。
 *
 * 钉住九件事：
 *   ① 台必须断言**文件夹不再是卡片盒**（边框 0 + 背景透明）；
 *   ② 台必须断言**箭头两态**（展开 rotate、未展开 none）—— 只断言"有三角"等于放过了静态装饰；
 *   ③ 台必须断言**缩进步长 13 + 7** 与发丝引导线；
 *   ④ 台必须断言**类型徽标 14×14** 且 `js/md/json` 三色互不相同（只断言"有图标"会放过一张灰图）；
 *   ⑤ 台必须断言**体积列定宽 68 + 右边缘齐平**；
 *   ⑥ 台必须断言 **FR-96 语义零回归**（目录顺序 / 目录在前 / 叶子 title / `docs/` 含子树计数）；
 *   ⑦ 台必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与退出码；
 *   ⑧ `web/app.js` 必须真渲染 `[data-kind]` 徽标并给体积列；
 *   ⑨ `web/tokens.css` 必须是侧栏语言（无盒子 / 三角 / 14px 图标 / 68px 体积列）。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-req-file-tree-style.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

test("守卫：`-226` 台必须断言文件夹不再是卡片盒", () => {
  assert.match(src, /borderTop/, "必须读真实上边框宽度");
  assert.match(src, /borderLeft/, "必须读真实左边框宽度");
  assert.match(src, /bg: cs\.backgroundColor/, "必须读真实背景色");
  assert.match(src, /boxy\.length === 0/, "必须断言「没有一个是盒子」");
});

test("守卫：`-226` 台必须断言箭头两态（展开转、未展开不转）", () => {
  assert.match(src, /chevronTransform/, "必须读 ::before 的 transform");
  assert.match(src, /const closedTransform/, "必须构造一个未展开的同类节点做对照");
  assert.match(src, /chevron >= 4/, "必须断言三角真的画出来了");
  assert.match(src, /chevronTransform !== "none"/, "必须断言展开时确实转了");
  assert.match(src, /closedTransform\.transform === "none"/, "必须断言未展开时不转");
});

test("守卫：`-226` 台必须断言缩进步长与引导线", () => {
  assert.match(src, /paddingLeft === 13/, "必须断言左内边距 13");
  assert.match(src, /marginLeft === 7/, "必须断言外边距 7");
  assert.match(src, /deep - shallow\) >= 13/, "必须断言深一层真的右移 ≥13px");
});

test("守卫：`-226` 台必须断言类型徽标三色互不相同", () => {
  assert.match(src, /iconKind/, "必须读 kind");
  assert.match(src, /iconBg/, "必须读图标底色");
  assert.match(src, /Math\.abs\(l\.iconW - 14\) <= 0\.6/, "必须断言图标宽 14");
  assert.match(src, /new Set\(\[js\.iconBg, md\.iconBg, json\.iconBg\]\)\.size === 3/, "必须断言 js/md/json 三色互不相同");
});

test("守卫：`-226` 台必须断言体积列定宽右对齐", () => {
  assert.match(src, /sizeRight/, "必须读体积列右边缘");
  assert.match(src, /Math\.abs\(w - 68\) <= 0\.5/, "必须断言宽度 68");
  assert.match(src, /spread <= 1/, "必须断言右边缘齐平");
  assert.match(src, /sizeAlign === "right"/, "必须断言右对齐");
});

test("守卫：`-226` 台必须断言 FR-96 语义零回归", () => {
  assert.match(src, /EXPECT\.faceFolders/, "必须对照第一层目录顺序");
  assert.match(src, /foldersBeforeFiles === true/, "必须对照「目录在前」");
  assert.match(src, /EXPECT\.leafTitles/, "必须对照叶子 title 一项不丢");
  assert.match(src, /EXPECT\.docsPill/, "必须对照 docs/ 含子树计数");
});

test("守卫：`-226` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(src, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(src, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(src, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(src, /process\.exit\(1\)/, "失败必须体现在退出码上");
  assert.match(src, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "必须有汇总判定");
});

test("守卫：`web/app.js` 必须真渲染 [data-kind] 徽标与定宽体积列", () => {
  assert.match(app, /function fileKind\(name\)/, "必须有类型判定");
  assert.match(app, /icon\.dataset\.kind = kind/, "必须把 kind 写进 DOM（CSS 才染得上色）");
  assert.match(app, /req-file-icon/, "必须渲染图标元素");
  assert.match(app, /req-file-size/, "必须渲染定宽体积列");
  assert.ok(!/li\.append\(mk\("span", "req-file-name", f\.name\), mk\("span", "spacer"\), pill\(/.test(app),
    "叶子行不得回到「名字 + 弹簧 + 体积胶囊」旧形态");
});

test("守卫：`web/tokens.css` 必须是侧栏语言（无盒子 / 三角 / 14px 图标 / 68px 体积列）", () => {
  assert.match(css, /\.req-folder \{[^}]*border: 0;[^}]*background: transparent;/, "`.req-folder` 必须去边框去底色");
  assert.match(css, /\.req-folder > summary::before \{[^}]*border-left: 4\.5px solid currentColor/, "必须用 CSS 画三角");
  assert.match(css, /\.req-folder\[open\] > summary::before \{ transform: rotate\(90deg\); \}/, "展开必须转 90°");
  assert.match(css, /\.req-file-icon \{[^}]*width: 14px; height: 14px/, "图标必须 14×14");
  assert.match(css, /\.req-file-size \{[^}]*width: 68px; text-align: right/, "体积列必须定宽 68 且右对齐");
});
