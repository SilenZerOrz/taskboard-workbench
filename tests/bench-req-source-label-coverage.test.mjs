/**
 * 「来源标签」验证台的守卫（卡 `-179` / 需求 `R134`）：这台真浏览器台必须**持续**在，不许被悄悄削薄；
 * 同时补一条**源码守卫** —— 两处来源文案三元都必须含 `mcp` 分支（列表与详情各一处）。
 *
 * 分工：源码守卫防「改回去」，验证台防「渲染层被顶掉」（三元在、但胶囊被另一个 `pill()` 覆盖，
 * 或详情字段读的不是这个变量 —— 这类只有真渲染读得出）。两条缺一都不够。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-req-source-label.mjs"), "utf8");
const APP = readFileSync(path.join(ROOT, "web/app.js"), "utf8");

test("源码守卫：列表与详情两处来源文案都含 mcp 分支", () => {
  const listLine = APP.split("\n").find((l) => l.includes('const srcLabel = it.source === "intake" ? "资料索引"'));
  assert.ok(listLine, "列表来源文案行必须存在（列表渲染处）");
  assert.ok(listLine.includes('it.source === "mcp" ? "MCP"'), "列表来源文案必须含 mcp → MCP 分支");

  const detailLine = APP.split("\n").find((l) => l.includes('const srcLabel = item.source === "intake" ? "资料索引(引入)"'));
  assert.ok(detailLine, "详情来源文案行必须存在（详情渲染处）");
  assert.ok(detailLine.includes('item.source === "mcp" ? "MCP"'), "详情来源文案必须含 mcp → MCP 分支");

  // 兜底档位不得被改写：其余来源仍回落「手工」
  assert.ok(/it\.source === "mcp" \? "MCP" : "手工"/.test(APP), "列表兜底档必须仍是「手工」");
  assert.ok(/item\.source === "mcp" \? "MCP" : "手工"/.test(APP), "详情兜底档必须仍是「手工」");
});

test("台1：隔离形态（临时 dataDir/profile + 随机端口，跑完即删，不碰 :3080）", () => {
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-srclabel-"\)\)/);
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-srclabel-chrome-"\)\)/);
  assert.match(BENCH, /await rm\(d, \{ recursive: true, force: true \}\)/);
  assert.match(BENCH, /process\.env\.CODEX_SANDBOX/, "必须带沙箱自检（沙箱内起 Chrome 必崩）");
  assert.equal(/127\.0\.0\.1:3080/.test(BENCH), false, "不得接触用户的 :3080 实例");
});

test("台2：五档来源都要一行（只测 mcp 等于只守一半）", () => {
  for (const source of ["manual", "intake", "elaborated-ai", "elaborated-rule", "mcp"]) {
    assert.ok(BENCH.includes(`source: "${source}"`), `种子必须含 source=${source}`);
  }
  assert.match(BENCH, /mcp: "MCP"/, "期望表必须写明 mcp → MCP");
  assert.match(BENCH, /EXPECT_LIST\[s\.source\]/, "A 条必须逐档比对期望文案");
});

test("台3：详情必须读 `来源` 字段（不是只看胶囊）", () => {
  assert.ok(BENCH.includes(".req-fields dt"), "详情必须从 dl 的 dt 里找「来源」");
  assert.ok(BENCH.includes('来源-MCP条目') && BENCH.includes('来源-资料索引条目'), "B/C 两条要各点一条");
});

test("台4：反向对照入口 + 退出码契约", () => {
  assert.match(BENCH, /TB_BENCH_WEB_DIR/, "必须留反向对照入口");
  assert.match(BENCH, /未找到 Chrome/);
  assert.match(BENCH, /process\.exit\(2\)/);
  assert.match(BENCH, /process\.exitCode = failed\.length \? 1 : 0/, "有用例 FAIL 必须退出码 1");
});
