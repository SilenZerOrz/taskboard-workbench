/**
 * 注入面 · **正向守卫**（原「缺口守卫」的接续 · 卡 `-186` → 卡 `-210` / 需求 `R128` / `R141`）
 *
 * ## 这条测试的来历（别把它删成「重复测试」）
 * `flow_inject_policy` 曾自 P1 起就写在 `injection.md` 里，但**全仓没有任何代码读它** ——
 * 改它不改变任何行为，也不报错、不进日志。当时的处置是「把静默缺口变成显式缺口」：
 * 文档明写「未实现（全仓无 reader）」，并用一条**反向**守卫钉住（代码里 0 命中 ⇒ 绿）。
 *
 * P5 档 C（卡 `-210`）接线后，那条反向守卫按设计**转红**，并把它翻成本条**正向**守卫：
 *   · 代码侧：读点必须真在（`store` 列 + `flow-inject.mjs` 判定 + 宿主/HTTP/CLI 三处接线）；
 *   · 文档侧：`injection.md` 必须已改成「已实现」，**不得**再写「未实现（全仓无 reader）」；
 *   · 行为侧：真正的四档分流由 `tests/flow-inject.test.mjs` / `tests/flow-inject-wiring.test.mjs` 钉住
 *     （本条只守「结构还在、文档没撒谎」，不重复断言行为）。
 *
 * 一句话：这条测试守的仍是**「文档别撒谎」**，只是方向从「别声称能用」翻成「别声称不能用」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("读点在位：store 列 + flow-inject 判定 + 宿主/HTTP/CLI 三处接线（少一处就是半截接线）", () => {
  const store = read("src/core/store.mjs");
  assert.match(store, /flow_inject_policy/, "project_settings 必须有 flow_inject_policy 列");
  assert.match(store, /flowInjectPolicy/, "getProjectSettings/saveProjectSettings 必须读写该字段");
  assert.match(store, /recordFlowInjection/, "审计写入必须仍在 store 层");

  const core = read("src/core/flow-inject.mjs");
  for (const symbol of ["decideFlowInjection", "injectFlow", "normalizeFlowInjectPolicy", "buildFlowSummary"]) {
    assert.match(core, new RegExp(`\\b${symbol}\\b`), `flow-inject.mjs 必须提供 ${symbol}`);
  }

  // 宿主出口：createSession 建完必须调用注入（且带回 injection 结果，便于调用方如实显示）
  const index = read("index.js");
  assert.match(index, /injectOpeningFlow|injectFlow\(/, "宿主 createSession 出口必须接注入");
  assert.match(index, /getStore/, "宿主 port 必须能取到 store，否则注入永远 no-op");

  // HTTP 出口：C-1 的人工投递 + 审计查询
  const api = read("src/server/api.mjs");
  assert.match(api, /flow\\\/\(inject\|injections\)|flow\/\(inject\|injections\)/, "api 必须提供 flow/inject(ions) 路由");
  assert.match(api, /normalizeFlowInjectPolicy\(body\.flowInjectPolicy/, "settings 必须校验 flowInjectPolicy");

  // CLI 出口
  const cli = read("scripts/tb-flow.mjs");
  assert.match(cli, /command === "inject"/, "tb-flow 必须有 inject 子命令");
  assert.match(cli, /--session/, "inject 必须按会话投递（--session）");
});

test("文档口径已翻面：injection.md 说「已实现」，不再说「未实现（全仓无 reader）」", () => {
  const md = read("skills/taskboard-flow/references/injection.md");
  assert.doesNotMatch(md, /未实现（全仓无 reader）/, "缺口已接线，文档不得再声称「全仓无 reader」");
  assert.doesNotMatch(md, /档 C 预埋，\*\*未实现\*\*/, "标题必须改成「已实现」口径");
  const row = md.split("\n").find((l) => l.startsWith("| **C 宿主自动注入**"));
  assert.ok(row, "三档表必须有「C 宿主自动注入」一行");
  assert.doesNotMatch(row, /未启用/, "档 C 现状列不得再写「未启用」");
  assert.match(row, /已实现|可用/, "档 C 现状列必须写「已实现」");
});

test("文档补齐了接线后才存在的四件事：策略值 / 角色分层 / manual 审计 / 开关位置", () => {
  const md = read("skills/taskboard-flow/references/injection.md");
  for (const needle of ["main-only", "main+exec", "all", "manual", "subagent"]) {
    assert.match(md, new RegExp(needle.replace("+", "\\+")), `injection.md 必须写清 ${needle}`);
  }
  assert.match(md, /flowInjectPolicy|flow_inject_policy/, "必须写清开关落在哪（项目设置）");
  assert.match(md, /inject --session/, "必须给出人工投递入口");
  // 反证：文档里那个**不存在的**错误码曾出现在摘要版草案里 ⇒ 示例块必须用真码。
  // （允许在正文里点名这个历史错误并解释，但**示例/正文行**不得再拿它当错误码用。）
  const gateLine = md.split("\n").find((l) => l.startsWith("两道门：")) ?? "";
  assert.match(gateLine, /EXECUTION_NOT_AUTHORIZED/, "摘要示例的授权门必须用真码 EXECUTION_NOT_AUTHORIZED");
  const offenders = md.split("\n").filter((l) => !l.trim().startsWith(">") && l.includes("AUTHORIZATION_REQUIRED"));
  assert.deepEqual(offenders, [], "除了解释「旧版写错了」的引用行，不得再出现 AUTHORIZATION_REQUIRED");
});
