/**
 * 守卫（2026-11-13 · 卡 `-271` / 需求 `R187`）：`tools/bench-config-executor-session.mjs` 必须**持续**证明
 * 「执行会话能打开工作台，且配置页把派生执行会话如实列出来、不给解除后门」。
 *
 * 为什么需要这条：本台的断言全是**渲染后**才成形的东西（派生行在不在、那行有没有解除按钮、
 * 角色文案说没说清来源）—— 源码里 grep 得出「有一行 `⚙ 执行会话（派生）`」完全不够：
 * 它可以被写在一个永远不触发的分支里，也可以旁边多一个能点的「解除」。
 * 后来者若为了让台子变绿而删掉「只读不可解除」或「门没被拆掉」那条，台子会永久全绿却什么都没证明 ——
 * 与 `-224` / `-225` / `-226` / `-227` 四台守卫同一条规矩。
 *
 * 钉住八件事：
 *   ① 台必须**按 h3 精确标题**定位「会话关联（主会话批准）」卡 —— 配置页有两张标题都含「会话关联」
 *      的卡（另一张是「会话区 / 会话关联」静态说明），首版用 `includes('会话关联')` 命中了同壳兄弟
 *       ⇒ C/D/E/F 四条**假红**（读数 `rows=["来源会话"]`）。这是本仓已记过的坑（复用壳需排除兄弟）。
 *   ② 台必须保留「门是开的」（A1/A2）与「门没被拆掉」（B，陌生会话仍被挡）**双向**断言。
 *   ③ 台必须断言该行**只读**：无解除/解绑/移除类按钮，且**至少有一个**按钮（防空数组真空通过）。
 *   ④ 台必须断言该行说得出**来源与生命周期**（任务编号 + 「自动收回」）。
 *   ⑤ 台必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与三档退出码。
 *   ⑥ `web/app.js` 必须真的渲染派生行（`sessList.executors` 分支 + `derived` 来源）。
 *   ⑦ 配置页「本会话角色」必须中文化，且带 `executorTasks` 派生依据（不许直接把英文枚举印给人）。
 *   ⑧ `-263` 的入口（/api/context 的 roleDerived/executorTasks、/sessions 的 executors）必须在位。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools", "bench-config-executor-session.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const api = readFileSync(join(ROOT, "src", "server", "api.mjs"), "utf8");

test("守卫：`-271` 台必须按 h3 精确标题定位「会话关联（主会话批准）」，不得用 includes 撞同壳兄弟", () => {
  assert.match(bench, /CONFIG_CARD_TITLE = "会话关联（主会话批准）"/, "必须把目标卡标题写成常量");
  assert.match(bench, /c\.querySelector\('h3'\)\?\.textContent \?\? ''\)\.trim\(\) === want/, "必须按 h3 精确相等定位");
  assert.ok(
    !/find\(\(c\) => \(c\.textContent \|\| ''\)\.includes\('会话关联'\)\)/.test(bench),
    "不得回退成 `textContent.includes('会话关联')` —— 那会命中「会话区 / 会话关联」这张同壳兄弟卡",
  );
  assert.match(bench, /同壳兄弟/, "必须在注释里写明为什么要精确匹配");
});

test("守卫：`-271` 台必须同时证明「门是开的」与「门没被拆掉」", () => {
  assert.match(bench, /A1 执行会话打开工作台\*\*不是\*\*门页/, "必须有正例：执行会话不被挡");
  assert.match(bench, /A2 执行会话下看板可见/, "必须有正例：看板真可见（不是空壳）");
  assert.match(bench, /B 陌生会话仍然是门页（门没被整体拆掉）/, "必须有反例：陌生人仍被挡（门没被整体拆掉）");
});

test("守卫：`-271` 台必须断言派生行只读——无解除按钮，且至少有一个按钮", () => {
  assert.match(bench, /const revokePattern = \/\(解除\|解绑\|移除\|撤销\|取消关联\)\//, "必须列出禁止的解除类文案");
  assert.match(bench, /derivedRow\.buttons\.every\(\(b\) => !revokePattern\.test\(b\.text\)\)/, "必须逐按钮断言不是解除类");
  assert.match(bench, /derivedRow\.buttons\.length > 0/, "必须有按钮（防空数组 every() 真空通过）");
  assert.match(bench, /derivedRow\.buttons\.some\(\(b\) => b\.text === "打开会话"\)/, "必须断言「打开会话」存在");
});

test("守卫：`-271` 台必须断言派生行说得出来源与生命周期", () => {
  assert.match(bench, /derivedRow\.text\.includes\(execTask\.identifier\)/, "必须带任务编号");
  assert.match(bench, /derivedRow\.text\.includes\("自动收回"\)/, "必须说明任务收口后自动收回");
});

test("守卫：`-271` 台必须保留反证入口、沙箱自检与三档退出码", () => {
  assert.match(bench, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(bench, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出");
  assert.match(bench, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(bench, /process\.exit\(failed\.length \? 1 : 0\)/, "失败必须体现在退出码上");
});

test("守卫：`web/app.js` 必须真的渲染派生执行会话行（来源 + 生命周期文案）", () => {
  const block = app.slice(app.indexOf('if ((sessList.executors ?? []).length) {'), app.indexOf('links.appendChild(mk("p", "hint", "存活判定来源'));
  assert.ok(block.length > 0, "必须有 sessList.executors 渲染分支");
  assert.match(block, /⚙ 执行会话（派生）/, "行标签必须点明是派生（不是批准过的）");
  assert.match(block, /自动收回/, "必须说明生命周期（任务收口自动收回）");
  assert.match(block, /hostBtn\("打开会话"/, "必须走 hostBtn（能力门）；且**不得**出现解除按钮");
  assert.ok(!/(解除|解绑|移除|撤销关联)/.test(block), "派生行不得给解除入口（它不是授权记录）");
});

test("守卫：配置页「本会话角色」必须中文化并带派生依据", () => {
  assert.match(app, /executor: "执行会话（按任务归属派生）"/, "必须有中文角色名");
  assert.match(app, /任务 \$\{tasks\.join\(" \/ "\)\}/, "必须带上是哪些任务派生的");
  assert.match(app, /roleLabel\(state\.context\?\.association, state\.context\?\.executorTasks\)/, "必须消费 executorTasks");
});

test("守卫：服务端必须同时回 roleDerived/executorTasks 与 executors（派生入口在位）", () => {
  assert.match(api, /roleDerived = binding\.derived === true/, "/api/context 必须回 roleDerived");
  assert.match(api, /executorTasks = Array\.isArray\(binding\.tasks\) \? binding\.tasks : \[\]/, "/api/context 必须回 executorTasks");
  assert.match(api, /for \(const ex of store\.listExecutorSessions\(project\.id\)\)/, "/projects/:id/sessions 必须列派生执行会话");
  assert.match(api, /executors\.push\(\{ \.\.\.ex, derived: true/, "派生行必须自报 derived:true");
});
