/**
 * 卡 `-268`（需求 `R184`）· 任务抽屉「执行记录」统一入口 —— **服务端展示口径 + 前端首屏锚点**守卫。
 *
 * 与另外两份守卫的分工（**三层各守一半，不许互相顶替**）：
 *   · `tests/execution-record-api.test.mjs`（`-258`）钉**形状**：回包带 `executionRecord`、只读、前端消费；
 *   · `tests/run-summary.test.mjs`（`-259`）钉**写路径**：新行不再写死记账文案；
 *   · 本份钉**读路径 + 首屏** —— `-259` 只管得住新行，而真实库里躺着 **22 行**老口径
 *     「按成功完成记账（失败计数清零）」（实测读数 · 2026-11-13 · `.data/taskboard.sqlite`）。
 *     只修写路径 ⇒ 老卡打开仍是那句账务说明，正是验收第 2 条要禁的。
 *
 * 钉六件事：
 *   1. `displayRunSummary` 三档（空 / 记账文案 / 真摘要）+ 500 字符封顶
 *   2. `withDisplaySummary`：在途尝试**不套**回落文案（把「还在跑」说成「没回写」是另一种撒谎），
 *      `summaryRaw` 原样保留（改历史 = 篡改过程证据）
 *   3. 真 HTTP 路由：`GET /api/tasks/:ref` 与 `/execution`、`/runs` 三处回包口径一致
 *   4. 前端常量与服务端 `RUN_SUMMARY_FALLBACK` **逐字一致**（两份不许漂）
 *   5. 前端真吃这口数据：执行记录段 + 摘要行 + **标题栏首屏徽标**（徽标与段同源）
 *   6. 徽标是「跳转锚点」而不是装饰：点它必须滚到「执行记录」段
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  openStore, displayRunSummary, normalizeRunSummary, RUN_SUMMARY_FALLBACK, BOOKKEEPING_RUN_SUMMARY_RE,
} from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const LEGACY = "按成功完成记账（失败计数清零）";
const web = () => fs.readFileSync(path.resolve("web", "app.js"), "utf8");

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, t, route };
}

test("A displayRunSummary：空 / 记账文案 ⇒ 「执行方未回写摘要」；真摘要原样；500 封顶", () => {
  assert.equal(displayRunSummary(null), RUN_SUMMARY_FALLBACK);
  assert.equal(displayRunSummary(undefined), RUN_SUMMARY_FALLBACK);
  assert.equal(displayRunSummary("   \n\t "), RUN_SUMMARY_FALLBACK);
  // 老口径（库里 22 行的原文）**必须**被兜住 —— 它是机器的账务说明，不是执行方结论
  assert.equal(displayRunSummary(LEGACY), RUN_SUMMARY_FALLBACK);
  assert.ok(BOOKKEEPING_RUN_SUMMARY_RE.test(LEGACY), "记账文案识别式必须命中真机库里的原文");
  // 真摘要：压单行、原样保留
  assert.equal(displayRunSummary("改了 store.mjs\n\nnpm test 1328/1328/0"), "改了 store.mjs npm test 1328/1328/0");
  assert.equal(displayRunSummary("CLI 执行器成功（cli:claude）"), "CLI 执行器成功（cli:claude）");
  // 封顶与写路径同一口径（500，末位省略号）
  assert.equal(displayRunSummary("x".repeat(900)).length, 500);
  assert.equal(normalizeRunSummary("x".repeat(900)).length, 500);
});

test("B 真 HTTP：/api/tasks/:ref 的 run.summary 走展示口径，原文留在 summaryRaw", async () => {
  const { store, t, route } = setup();
  const now = Date.now();
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor", now });
  // 直接写一条老口径的摘要（复刻库里已有的历史行 —— 写路径已修，但历史行改不掉也不该改）
  store.endTaskRun(t.identifier, { outcome: "success", summary: LEGACY, actor: "system", now: now + 1000 });

  const r = await route("GET", `/api/tasks/${t.identifier}`);
  const run = r.payload.executionRecord.run;
  assert.equal(run.summary, RUN_SUMMARY_FALLBACK, "读路径必须兜住记账文案，不许原样露出去");
  assert.equal(run.summaryRaw, LEGACY, "原文必须一字不改地另存（改历史 = 篡改过程证据）");
});

test("C 三处回包口径一致（/:ref · /execution · /runs），且都不露记账文案", async () => {
  const { store, t, route } = setup();
  const now = Date.now();
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor", now });
  store.endTaskRun(t.identifier, { outcome: "success", summary: LEGACY, actor: "system", now: now + 1000 });

  const detail = await route("GET", `/api/tasks/${t.identifier}`);
  const exec = await route("GET", `/api/tasks/${t.identifier}/execution`);
  const runs = await route("GET", `/api/tasks/${t.identifier}/runs`);

  assert.equal(detail.payload.executionRecord.run.summary, RUN_SUMMARY_FALLBACK);
  assert.equal(exec.payload.runs[0].summary, RUN_SUMMARY_FALLBACK);
  assert.equal(runs.payload.runs[0].summary, RUN_SUMMARY_FALLBACK);
  // 给人看的那些 run 对象里都不许出现那句账务说明。
  // `summaryRaw` **例外**（它就是库里的原文，故意保留）—— 所以这里逐个字段点名比，而不是整包 JSON 匹配：
  // 整包匹配会把「如实保留原文」判成缺陷，那种守卫会逼着人把过程证据抹掉。
  const displayFields = (run) => JSON.stringify({ ...run, summaryRaw: undefined });
  for (const [name, run] of [
    ["detail", detail.payload.executionRecord.run],
    ["execution", exec.payload.runs[0]],
    ["runs", runs.payload.runs[0]],
  ]) {
    assert.ok(!displayFields(run).includes(LEGACY), `${name} 回包的展示字段仍露记账文案`);
  }
});

test("D 在途尝试不套回落文案（「还在跑」≠「没回写」）", async () => {
  const { store, t, route } = setup();
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });

  const r = await route("GET", `/api/tasks/${t.identifier}`);
  const run = r.payload.executionRecord.run;
  assert.equal(run.status, "running");
  assert.equal(run.summary, null, "在途尝试的 summary 恒为 null —— 不能说成「执行方未回写摘要」");
  assert.equal(run.summaryRaw, null);
});

test("E 前端常量与服务端逐字一致（两份不许漂）", () => {
  const src = web();
  const m = /const RUN_SUMMARY_FALLBACK = "([^"]*)";/.exec(src);
  assert.ok(m, "web/app.js 必须有 RUN_SUMMARY_FALLBACK 常量");
  assert.equal(m[1], RUN_SUMMARY_FALLBACK, "前端兜底文案必须与服务端 RUN_SUMMARY_FALLBACK 逐字一致");
});

test("F 前端真吃这口数据：执行记录段 + 摘要行 + 标题栏首屏徽标", () => {
  const src = web();
  // ① 执行记录段（`-258` 的落地，本卡不许弄丢）
  assert.ok(src.includes('mk("div", "drawer-section exec-record")'), "执行记录段必须仍在");
  assert.ok(src.includes("exec-record-summary"), "摘要行必须带稳定类名（验证台按它定位）");
  // ② 首屏徽标：渲染函数 + 挂载在标题栏 + 由同一份 executionRecord 驱动
  assert.ok(src.includes("function renderExecBadge("), "必须有标题栏执行记录徽标的渲染函数");
  assert.ok(/drawerHeadMain\.append\([^)]*drawerExecBadge[^)]*\)/.test(src),
    "徽标必须挂在抽屉标题栏（首屏），不是正文里再加一段");
  assert.ok(/renderExecBadge\(detail\.executionRecord/.test(src),
    "徽标数据源必须是同一份 executionRecord（与正文段同源，不许另立一套判据）");
  // ③ 换卡复位：不许把上一张卡的读数挂在新卡上
  assert.ok(/drawerExecBadge\.hidden = true/.test(src), "换卡必须先复位徽标");
});

test("G 徽标是**跳转锚点**而不是装饰：点击必须滚到执行记录段", () => {
  const src = web();
  const i = src.indexOf("drawerExecBadge.addEventListener");
  assert.ok(i > 0, "徽标必须有点击处理器 —— 不然它只是又一个看不出所以然的标签");
  const block = src.slice(i, i + 800);
  assert.ok(/exec-record/.test(block), "点击必须定位到 `.exec-record` 段");
  assert.ok(/scrollIntoView/.test(block), "点击必须真的滚过去");
  assert.ok(/classList\.remove\("collapsed"\)/.test(block),
    "折叠态下必须先展开 —— 否则「跳过去」看到的是一片空白（FR-87 折叠状态会记忆）");
});

test("H 徽标空态恒在：没有记录时也显示「尚无」，不藏起来", () => {
  const src = web();
  const i = src.indexOf("function renderExecBadge(");
  const block = src.slice(i, i + 2600);
  assert.ok(/执行记录：尚无/.test(block), "无记录时徽标文案必须是「执行记录：尚无」（空态本身也是读数）");
  assert.ok(/drawerExecBadge\.hidden = false/.test(block), "有数据/无数据都要显示 —— 藏起来就退回「不知道跑没跑过」");
  // 在途单独一档（与前端的「跑着」区分）
  assert.ok(/run\?\.status === "running"/.test(block), "在途尝试必须单独一档文案");
});

test("I 源码守卫：抽屉里不再有任何地方把记账文案当摘要渲染", () => {
  const src = web();
  // 只允许它**出现在注释里**（解释为什么要兜住它）—— 一旦落到代码行就是真渲染。
  const codeLines = src.split("\n").filter((line) => {
    const t = line.trim();
    return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
  });
  const hits = codeLines.filter((line) => line.includes(LEGACY));
  assert.deepEqual(hits, [], `前端代码行不许硬编码那句记账文案（它不是展示内容）：\n${hits.join("\n")}`);
});
