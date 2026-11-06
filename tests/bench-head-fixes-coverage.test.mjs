/**
 * 守卫（2026-11-05 · 卡 `-223` / 需求 `R165`）：三台既有验证台在 HEAD 上曾「红 / 不退出」——
 * 本守卫钉住三处**根因级**修复，防它们被下一次「让台子安静」的改动悄悄改回去：
 *
 *   ① `bench-next-column`：种子必须**先建需求条目、再取 identifier**（不得写占位串 `4-abc`）。
 *      归因校验（`REQUIREMENT_NOT_FOUND`）落地后，占位串会让台子在建数据阶段就崩，一条断言都跑不到
 *      —— 那会让「11/11」变成历史读数，而不是回归证据。
 *   ② `bench-reconnect`：headless Chrome 必须带 `--no-sandbox` 系列。缺了就在 `Page.enable` 超时，
 *      现象像「环境噪音」，实际是台子自己起不来渲染进程（同 `bench-next-column` 2026-10-27 的结论）。
 *   ③ `bench-next-step-shape`：只置 `process.exitCode`、不 `process.exit()` 的台，必须在 `finally` 里
 *      关掉 **CDP WebSocket** 与 server 连接 —— 否则「11/11 PASS 却不退出」（被 `timeout` 杀成 124）。
 *
 * 只读源码文本（不起浏览器、不连网），毫秒级；真跑仍以三台脚本自身的退出码与 PASS 计数为准。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(ROOT, "tools", name), "utf8");

test("守卫：`bench-next-column` 种子必须真建需求条目再归因，不得用占位串", () => {
  const src = read("bench-next-column.mjs");
  assert.match(src, /store\.createRequirementItem\(/, "必须真建一条需求条目（走真实 store 写路径）");
  assert.match(src, /const REQUIREMENT = seedRequirement\.identifier/, "必须取条目真实 identifier 作为归因");
  assert.match(src, /requirement: REQUIREMENT/, "建卡必须用真实 identifier 归因");
  assert.doesNotMatch(src, /requirementId: "4-abc"/, "不得再写库中不存在的占位串 `4-abc`");
  assert.doesNotMatch(src, /requirement: "4-abc"/, "不得再写库中不存在的占位串 `4-abc`");
});

test("守卫：`bench-reconnect` 的 headless Chrome 必须带 --no-sandbox 系列", () => {
  const src = read("bench-reconnect.mjs");
  assert.match(src, /"--no-sandbox"/, "缺 --no-sandbox ⇒ 沙箱内渲染进程起不来 ⇒ Page.enable 超时");
  assert.match(src, /"--disable-setuid-sandbox"/, "--no-sandbox 需配套 --disable-setuid-sandbox");
  assert.match(src, /"--disable-dev-shm-usage"/, "小 /dev/shm 环境需要此开关，避免渲染进程崩溃");
});

test("守卫：`bench-next-step-shape` 必须在 finally 清掉 CDP WebSocket 与 server 连接", () => {
  const src = read("bench-next-step-shape.mjs");
  assert.match(src, /ws\?\.close\(\)/, "CDP WebSocket 不关 ⇒ 事件循环永远有活 ⇒ 进程不退出");
  assert.match(src, /proxy\?\.closeAllConnections\?\.\(\)/, "代理 server 需断开存量连接（close() 只停 accept）");
  assert.match(src, /inner\?\.closeAllConnections\?\.\(\)/, "内层 server 需断开存量连接");
  assert.match(src, /process\.exitCode = failed\.length \? 1 : 0/, "仍以 exitCode 表达结论，不强制 process.exit");
});

test("守卫：三台都保留 TB_BENCH_WEB_DIR 反证入口（判据不得被删弱）", () => {
  for (const name of ["bench-next-column.mjs", "bench-reconnect.mjs", "bench-next-step-shape.mjs"]) {
    assert.match(read(name), /process\.env\.TB_BENCH_WEB_DIR/, `${name} 必须能换 web/ 目录做反证`);
  }
});
