/**
 * 守卫（FR-99 / FR-100 · 2026-10-28）：推进清单与待确认记忆**必须有看板入口**，且守两条红线。
 *
 * 为什么需要它：本轮之前清单只有 API —— 用户"看不见"，等于没做（技术评估 F6）。而入口一旦做出来，
 * 两条红线最容易在后续迭代里被悄悄拆掉：
 *   ① 「完成」只能人点 ⇒ 前端提交必须 `actor: "human"`，且不得出现"批量代点完成"的按钮；
 *   ② 「补归因 / 派发」不得在本页另造写路径 ⇒ 必须指回既有入口（需求页 / 看板），而不是自己调执行端点。
 *
 * 只读源码文本，不起浏览器、不连网，毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

test("FR-99 入口存在：导航按钮 + 独立视图 + 三条取数/投递调用", () => {
  assert.match(app, /const advanceToggle = mk\("button", "ghost", "推进"\)/, "导航必须有「推进」入口");
  assert.match(app, /advance:\s*advanceToggle/, "导航按钮表必须登记 advance");
  assert.match(app, /const advanceRoot = mk\("div", "advance-view"\)/, "必须有独立视图容器");
  assert.match(app, /advanceScroll\.hidden = next !== "advance"/, "视图切换必须接管显隐（否则会与看板叠在一起）");
  assert.match(app, /\/advance\?format=block/, "必须消费 FR-99 的装载块格式（一次取清单+记忆）");
  assert.match(app, /\/advance\/announce/, "必须能一键投给主会话");
  assert.match(app, /\/advance\/\$\{encodeURIComponent\(item\.id\)\}\/decide/, "决定必须走 FR-99 的 decide 端点（幂等由服务端保证）");
});

test("红线①：「完成」只能人点 —— 前端提交 actor 固定 human，且无批量代点", () => {
  assert.match(app, /choice, note, actor: "human"/, "decide 提交必须带 actor: \"human\"");
  assert.match(app, /if \(action\.code === "complete"\)/, "accept 类必须有显式完成入口");
  assert.ok(!/actor:\s*"agent/.test(app), "前端不得以 agent 身份提交决定（服务端会 409）");
});

test("红线②：补归因 / 派发不另造写路径 —— 只跳视图 + 提示", () => {
  assert.match(app, /setView\(action\.code === "attribute" \? "req" : "board"\)/, "两条动作必须指回既有视图");
  assert.ok(!app.includes("/execution/start"), "本页不得自己调执行端点（派发只能走看板既有入口）");
});

test("FR-100 待确认记忆：能列出 proposed 且能一键确认", () => {
  assert.match(app, /includeProposed=1/, "必须能取到 proposed（默认列表不含）");
  assert.match(app, /\/memory\/\$\{encodeURIComponent\(entry\.id\)\}\/accept/, "必须能走 accept 端点");
  assert.match(app, /没有待确认记忆/, "空态要说明白（否则用户以为坏了）");
});

test("样式：行用 minmax(0,1fr) 中间列 + 窄视口动作换行（不许把标题挤成一字一行）", () => {
  assert.match(css, /\.advance-row\s*\{[^}]*grid-template-columns:\s*84px minmax\(0, 1fr\) auto/, "中间列必须 minmax(0,1fr)");
  assert.match(css, /@media \(max-width: 760px\)[\s\S]{0,400}\.advance-row/, "窄视口必须换行");
  assert.match(css, /\.advance-kind\.k-accept/, "五类胶囊要有各自配色（否则五类看起来一样）");
});
