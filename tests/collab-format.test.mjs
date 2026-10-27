/**
 * 卡 `-145` · `docs/规范/01-协作规范.md` 落地自检（§一 指令 / §二 报告 / §三 自检清单）。
 *
 * 背景：2026-10-23 反向核查结论 —— 规范已落盘但**两端都未承载**：
 *   · 指令侧：`buildTaskPrompt()`（`claude -p` 任务书，唯一代码产出点）与 `buildOpeningPrompt()`
 *     （项目主会话开局指令）只有「目标 / 边界 / 纪律」几行，**无**五段，尤其**无可判定的停下情形**。
 *   · 报告侧：`evidenceComment()` 四节不齐（上一轮实测「偏离说明」命中 0 条）。
 *
 * 本测试把 §一 / §二 / §三 的口径**变成可复跑的断言** —— 口径写在文档里不会被执行，
 * 写在测试里才会每次回归都被检查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildTaskPrompt, evidenceComment } from "../src/core/executor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPEC = readFileSync(join(ROOT, "docs/规范/01-协作规范.md"), "utf8");

/** §一 的五段 + 回报格式：字段齐备是硬要求（§七.2 反向核查口径第 1 条）。 */
const SECTION_1 = [
  ["已获授权", /^## 已获授权$/m],
  ["硬边界", /^## 硬边界$/m],
  ["分步判据", /^## Step 1/m],
  ["停下情形", /^## 停下情形（严格，逐条编号；命中即停，不要继续往下做）$/m],
  ["回报格式", /^## 回报格式（严格按这四节，逐节都写，缺节＝不合格）$/m],
];

/** §二 的四节：判定 / 偏离说明 / 边界自查 / 产物路径。 */
const SECTION_2 = [
  ["判定", /\*\*判定\*\*：/],
  ["偏离说明", /\*\*偏离说明\*\*：/],
  ["边界自查", /\*\*边界自查\*\*：/],
  ["产物路径", /\*\*产物路径\*\*：/],
];

const promptOf = () => buildTaskPrompt(
  { identifier: "p1-1", title: "实现 X", description: "描述正文", acceptance: "npm test 全绿" },
  { project: { workspacePath: "/tmp/ws" }, requirementId: "R1", verifyCommand: "npm test" },
);

// ── §一 指令侧 ────────────────────────────────────────────────────────────────

test("§一 buildTaskPrompt：五段齐备（授权 / 硬边界 / 判据 / 停下情形 / 回报格式）", () => {
  const p = promptOf();
  for (const [name, re] of SECTION_1) assert.match(p, re, `§一 缺「${name}」段`);
});

test("§一 buildTaskPrompt：硬规则 #2 —— 每个 Step 必须同时给出判据与停下情形", () => {
  const p = promptOf();
  // Step 0 / Step 1 / Step 2 三步，每步都要有「判据：」与「停下情形：」
  const stepCount = (p.match(/^## Step \d+/gm) ?? []).length;
  assert.ok(stepCount >= 3, `至少 3 个 Step，实际 ${stepCount}`);
  const criterionCount = (p.match(/判据：/g) ?? []).length;
  const stopCount = (p.match(/停下情形：/g) ?? []).length;
  assert.ok(criterionCount >= stepCount, `每个 Step 都要有判据：${criterionCount} < ${stepCount}`);
  assert.ok(stopCount >= stepCount, `每个 Step 都要有停下情形：${stopCount} < ${stepCount}`);
});

test("§一 buildTaskPrompt：停下情形四类齐（前置 / 门禁 / 不可逆 / 偏离）", () => {
  const p = promptOf();
  assert.match(p, /1\. \*\*前置不满足\*\*/, "① 前置不满足");
  assert.match(p, /2\. \*\*门禁不过\*\*/, "② 门禁不过");
  assert.match(p, /3\. \*\*需要越权时\*\*/, "③ 不可逆动作前");
  assert.match(p, /5\. \*\*偏离预期\*\*/, "④ 偏离预期");
  // §一 补充：触及宿主级动作必须写成停下情形的一条（指令不得自带该授权）
  assert.match(p, /4\. \*\*触及宿主级动作\*\*/, "宿主级动作须单列为停下情形（AGENTS.md §3 报批范围）");
});

test("§一 buildTaskPrompt：硬规则 #1 —— 嵌套代码块一律 4 反引号（§四 bug #1）", () => {
  const p = promptOf();
  // 逐个 fence 计长度：凡出现围栏，长度必须 ≥ 4（本仓模板内层最低 4 反引号）
  for (const m of p.matchAll(/^`{3,}/gm)) {
    assert.ok(m[0].length >= 4, `发现 ${m[0].length} 反引号围栏 —— 会被外层 \`\`\` 提前闭合`);
  }
  assert.match(p, /^````bash$/m, "预检与复核动作都应是 4 反引号代码块");
  assert.match(p, /^````$/m, "每个代码块都要有配对的 4 反引号结束围栏");
  // 围栏必须成对（§三 自检清单第 1 条：代码块数量成对）
  assert.equal((p.match(/^````/gm) ?? []).length % 2, 0, "4 反引号围栏未成对闭合");
});

test("§一 buildTaskPrompt：自包含（任务号 / 工作目录 / 需求条目 / 复核动作）与红线（§二 2.2 边界自查）", () => {
  const p = promptOf();
  assert.match(p, /p1-1/);
  assert.match(p, /\/tmp\/ws/);
  assert.match(p, /R1/);
  assert.match(p, /npm test/);
  for (const kw of [/不 commit、不 push/, /不删任何既有数据/, /不自行置「完成\(done\)」/]) {
    assert.match(p, kw, "硬边界须逐条含既有红线");
  }
});

test("§一 buildTaskPrompt：回报格式自身也按 §二 四节展开（指令与报告同口径）", () => {
  const p = promptOf();
  for (const [name, re] of SECTION_2) assert.match(p, re, `回报模板缺「${name}」节`);
  assert.match(p, /无偏离也要显式写「无」/, "§二.3：偏离报告是强制项，无偏离也要显式写");
});

test("§一 buildTaskPrompt：verifyCommand 缺失时仍保持五段齐备（不臆造命令）", () => {
  const p = buildTaskPrompt(
    { identifier: "p1-9", title: "无复核命令的卡" },
    { project: { workspacePath: "/tmp/ws2" } },
  );
  for (const [name, re] of SECTION_1) assert.match(p, re, `缺「${name}」段`);
  assert.match(p, /运行相关自测/, "无复核命令时回落为「运行相关自测」，不得编造命令");
  assert.doesNotMatch(p, /````bash\nnpm test/, "不得凭空写出不存在的复核命令");
});

test("§一 buildOpeningPrompt：开局提示词同样齐备（授权 / 硬边界 / 停下情形 / 回报格式）", () => {
  // 服务端产出点在本函数内（闭包，不导出）⇒ 按真实口径从源码取：取出函数体字面量做断言，
  // 与 tests/fr22-packaged-spec.test.mjs 同型（既不断言私有导出，也不做正则猜测行为）。
  const src = readFileSync(join(ROOT, "src/server/api.mjs"), "utf8");
  const start = src.indexOf("function buildOpeningPrompt");
  assert.ok(start > 0, "应能找到 buildOpeningPrompt");
  const body = src.slice(start, src.indexOf("\n  async function route(", start));
  for (const re of [/## 已获授权/, /## 硬边界/, /## 停下情形（严格，逐条编号；命中即停）/, /## 回报格式（严格按这四节，缺节＝不合格）/]) {
    assert.match(body, re, `开局提示词缺 ${re}`);
  }
  for (const [name, re] of SECTION_2) assert.match(body, re, `开局回报模板缺「${name}」节`);
  assert.match(body, /不自行重载 \/ 重启 dsh 宿主进程/, "AGENTS.md §3 报批范围须进硬边界");
});

// ── §二 报告侧 ────────────────────────────────────────────────────────────────

const resultOf = (over = {}) => ({
  ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0,
  durationMs: 12000, stdout: "done", stderr: "", baseline: "ok",
  diff: { files: ["src/a.mjs"], baselineFiles: 0, stat: "a.mjs | 2 +", mode: "git" },
  ...over,
});

test("§二 evidenceComment：四节齐备（判定 / 偏离说明 / 边界自查 / 产物路径）", () => {
  const body = evidenceComment({ identifier: "p1-1" }, resultOf());
  for (const [name, re] of SECTION_2) assert.match(body, re, `§二 缺「${name}」节`);
});

test("§二.3 evidenceComment：偏离报告是强制项 —— 机器不得静默省略本节", () => {
  const body = evidenceComment({ identifier: "p1-1" }, resultOf());
  assert.match(body, /\*\*偏离说明\*\*：/, "缺「偏离说明」＝隐藏信息，比写错更糟");
  assert.match(body, /不由机器填写/, "须如实写明执行器无「指令假设」可核");
  assert.match(body, /§二\.3/, "须指回规范条款，便于人工补写");
});

test("§二 evidenceComment：判定节按结果分档（完成 / 部分 / 停下）", () => {
  const ok = evidenceComment({ identifier: "p1-1" }, resultOf());
  assert.match(ok, /\*\*判定\*\*：完成$/m);

  const noDiff = evidenceComment({ identifier: "p1-1" }, resultOf({ diff: { files: [], baselineFiles: 0, stat: "", mode: "git" } }));
  assert.match(noDiff, /\*\*判定\*\*：部分（退出码 0，但未取得任何工作区改动）/, "退出码 0 却零改动 ⇒ 部分，不谎报完成");

  const failed = evidenceComment({ identifier: "p1-1" }, resultOf({ ok: false, exitCode: 3 }));
  assert.match(failed, /\*\*判定\*\*：停下（执行失败：退出码 3）/, "失败 ⇒ 停下并写明退出码");

  const timedOut = evidenceComment({ identifier: "p1-1" }, resultOf({ ok: false, timedOut: true, exitCode: null }));
  assert.match(timedOut, /\*\*判定\*\*：停下（执行超时/, "超时 ⇒ 停下（超时）");

  const unknown = evidenceComment({ identifier: "p1-1" }, resultOf({ baseline: "unavailable", diff: { files: ["a.mjs"], baselineFiles: null, stat: "" } }));
  assert.match(unknown, /\*\*判定\*\*：完成（附保留/, "基线不可得 ⇒ 判定须带保留，不得干脆写「完成」");
});

test("§二 evidenceComment：四节化后既有措辞逐字保留（不回归 FR-74 证据口径）", () => {
  const base = resultOf();
  assert.match(evidenceComment({ identifier: "p1-1" }, base), /执行前基线已有 0 条改动，已剔除/);
  assert.match(evidenceComment({ identifier: "p1-1" }, base), /本次工作区改动（1）/);
  assert.match(evidenceComment({ identifier: "p1-1" }, base), /退出码：0/);

  const lost = evidenceComment({ identifier: "p1-1" }, resultOf({ baseline: "unavailable", diff: { files: ["a.mjs"], baselineFiles: null, stat: "" } }));
  assert.match(lost, /无法取得执行前基线/, "基线不可得必须告警");
  assert.doesNotMatch(lost, /已剔除/, "基线不可得时不得声称已剔除（FR-74 红线）");

  const none = evidenceComment({ identifier: "p1-1" }, resultOf({ diff: { files: [], baselineFiles: 0, stat: "", mode: "fs" } }));
  assert.match(none, /对比方式：文件快照|本次工作区改动：无/);
});

test("§二 evidenceComment：边界自查逐条呼应指令红线（含 done 只能人点）", () => {
  const body = evidenceComment({ identifier: "p1-1" }, resultOf());
  assert.match(body, /\*\*边界自查\*\*：执行侧不 commit \/ 不 push/, "边界自查须含不 commit / 不 push");
  assert.match(body, /不自行置「完成\(done\)」/, "「done 只能人点」是本仓硬约束，须显式自查");
  assert.match(body, /不删既有数据/);
});

// ── §三 自检清单：模板与规范正本同源 ───────────────────────────────────────────

test("§三 自检：规范正本存在且五段标题与代码内断言同名（口径不分叉）", () => {
  // 2026-10-27：规范合并后标题层级下沉一级（## → ###），断言改为「标题文本必须存在」而不锁死级别
  for (const title of ["一、指令格式", "二、报告格式", "三、发指令前的自检清单"]) {
    assert.match(SPEC, new RegExp(`^#{2,4} ${title}`, "m"), `规范正本缺「${title}」`);
  }
  for (const kw of ["已获授权", "硬边界", "停下情形", "回报格式", "偏离说明", "边界自查", "产物路径"]) {
    assert.ok(SPEC.includes(kw), `规范正本缺关键词「${kw}」`);
  }
  // §一 硬规则 #1 / #2 与 §二.3 必须仍在正本里，否则模板与文档已分叉
  assert.match(SPEC, /4 反引号/, "§一 硬规则 #1（4 反引号）不得从正本消失");
  assert.match(SPEC, /偏离报告是强制项/, "§二.3 偏离报告强制项不得从正本消失");
});

test("§三 自检：模板正文 markdown 表格 / 列表写法合规（| 前后空格、- 后空格）", () => {
  const p = promptOf();
  // 列表项必须是 `- ` 开头（§三 自检清单：列表 - 后有空格）
  for (const line of p.split("\n")) {
    assert.doesNotMatch(line, /^-[^ -]/, `列表项缺空格：${line}`);
    assert.doesNotMatch(line, /^\*[^ *]/, `列表项缺空格：${line}`);
  }
});