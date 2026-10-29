/**
 * 需求条目详情抽屉：宽度 / 拖拽 / 全屏 —— **源码守卫**。
 *
 * 真机批注（2026-10-28）：「需求条目详情点击后，太过靠右，如内容详情过长不便查看」。
 * 根因＝`.tb-req-drawer` 把宽度**死钉在 560px**，且盖掉了 `.tb-drawer` 的按视口分级，
 * 于是长描述只能一行一行挤（更早的 FR-87 早已给**任务**抽屉补过「拖拽调宽 + 全屏」，
 * 需求抽屉**从没享受过**这套能力）。
 *
 * 本测试只守"规则在不在、旧值有没有被删干净"；**规则真的生效**由真浏览器读数证明
 * （1723 视口：560 → 1440，全屏 1715，双击手柄还原，`.req-desc` 无横向溢出）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(ROOT, "web/tokens.css"), "utf8");
const js = readFileSync(path.join(ROOT, "web/app.js"), "utf8");

/** 去掉注释再看规则 —— 否则"解释旧值为什么被换掉"的注释本身会把守卫判红。 */
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("CSS：需求详情抽屉不再钉死 560px（旧值必须删干净）", () => {
  assert.equal(/\.tb-req-drawer\s*\{[^}]*width:\s*min\(560px/.test(cssRules), false, "旧的 560px 死宽必须删掉");
  // 560px 本身是「新建 / 编辑」dialog 的正当宽度（tokens.css 的 `dialog { width: min(560px, …) }`），
  // 不能一竿子禁掉；只要求它**不再出现在任何抽屉规则里**。按选择器逐块点名，比"全文不许出现"更准。
  const owners = [...cssRules.matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter((m) => /min\(560px/.test(m[2]))
    .map((m) => m[1].trim().replace(/\s+/g, " "));
  assert.deepEqual(owners, ["dialog"], `560px 只应留在 dialog（新建/编辑对话框）上，实际出现在：${JSON.stringify(owners)}`);
});

test("CSS：需求详情抽屉继承分级宽度，并给长正文更宽的排版上限", () => {
  assert.match(css, /\.tb-req-drawer\s*\{[^}]*max-width:\s*calc\(100vw - 8px\)/, "应只留 max-width，宽度交给 .tb-drawer 的分级 + --drawer-width");
  assert.match(css, /\.tb-req-drawer \.req-desc\s*\{[^}]*max-height:\s*42vh/, "长描述的高度上限应按视口给（42vh）");
  assert.match(css, /\.tb-req-drawer \.req-desc\.is-expanded\s*\{[^}]*max-height:\s*none/, "展开态必须能完全展开");
});

test("CSS：基础抽屉确实带按视口分级宽度（需求抽屉靠它生效）", () => {
  assert.match(css, /\.tb-drawer\s*\{[^}]*width:\s*var\(--drawer-width, min\(920px/, "基础抽屉应提供 --drawer-width 回落宽度");
});

test("JS：需求抽屉有独立的宽度记忆键与拖拽/全屏动作", () => {
  assert.match(js, /REQ_DRAWER_WIDTH_KEY\s*=\s*"tb\.reqDrawer\.width"/, "需求抽屉要独立记忆，不能覆盖任务抽屉的 tb.drawer.width");
  assert.match(js, /const reqDrawerResize = mk\("div", "tb-drawer-resize"\)/, "要挂左缘拖拽手柄");
  assert.match(js, /const syncReqDrawerWidth = \(\) =>/, "要有宽度同步函数");
  assert.match(js, /detailFull\.addEventListener\("click"/, "全屏/还原按钮要绑事件");
  assert.match(js, /reqDrawerResize\.addEventListener\("dblclick"/, "双击手柄应还原默认宽度");
  assert.match(js, /detailPanel\.append\(reqDrawerResize, detailHead, detailBody\)/, "手柄必须在抽屉内部（否则拖不到）");
});

test("JS：拖拽落盘只在松手时写（拖动中只改行内变量）", () => {
  assert.match(js, /const onUp = \(\) => \{[\s\S]{0,400}?writeReqDrawerWidth\(/, "松手才写记忆，避免拖动中疯狂落盘");
});
