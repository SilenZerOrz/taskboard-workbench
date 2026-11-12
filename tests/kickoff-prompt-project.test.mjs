/**
 * 守卫（需求 `R177` / 卡 `-243`，2026-11-12 真机）：**配置页「复制开局提示词」必须注入当前项目标识与工作目录**。
 *
 * ## 为什么需要它
 * 原实现是 `web/app.js` 里一条**纯静态常量**，工作目录写死一个尖括号占位符 ⇒
 * 从**任何**项目配置页复制出来的开局提示词**一字不差**：新会话里的 agent 拿不到项目标识，
 * `taskboard_context` 按会话 cwd 匹配不到项目 ⇒ `src/core/binding.mjs` 的 `matchProjectForCwd`
 * **静默回落默认项目** ⇒ agent 按**别的仓库**的目录开工（真机：读 `taskboard-workbench` 的 AGENTS.md
 * 去改另一个项目的活）。这类缺陷**不报错、不进日志**，界面上还"看起来正常"，只能靠真渲染/真插值发现。
 *
 * ## 断言口径（对应 R177 验收 ①②③）
 *   A. 源码层面：`web/app.js` 里那个占位符字面量 **0 命中**，且复制入口走的是 `buildKickoffPrompt(...)`
 *      （反向对照：改回静态常量 ⇒ 本组立刻红 —— 函数切不出来 / 调用点回退成常量）；
 *   B. 同一份代码喂**两个不同项目**（不同 id + 不同 workspacePath）⇒ 文本互不相同，且各含自身 id 与路径；
 *   C. 未设 workspacePath ⇒ 写「（项目未设 workspacePath → 请先在配置页补）」，不留空值 / `undefined` / `null`；
 *   D. ①–⑧ 流程正文一字未丢（改的只是抬头，不是流程）。
 *
 * 手法沿用本仓「源码切片 + `new Function` 驱动」（见 `tests/attribution-guidance.test.mjs` /
 * `tests/fr96-*`）：`web/app.js` 是 IIFE 经典脚本（不能 import），只能这样把真函数跑起来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const PLACEHOLDER = "<项目绝对路径>";
const NO_WS = "（项目未设 workspacePath → 请先在配置页补）";

/** 从 `from` 处的 `{` 起配平花括号，返回函数体结束下标（含）。找不到配平即抛（源码结构变了要人看）。 */
function matchBrace(src, from) {
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error("找不到配平的 `}` —— web/app.js 里 buildKickoffPrompt 的结构变了");
}

/** 切出 `KICKOFF_STEPS` 常量语句（到该行以 `";` 收尾为止）。 */
function sliceSteps() {
  const start = APP.indexOf("const KICKOFF_STEPS =");
  assert.ok(start > 0, "web/app.js 里找不到 `const KICKOFF_STEPS`（流程正文被改名/删除）");
  const end = APP.indexOf('";', start);
  assert.ok(end > start, "`const KICKOFF_STEPS` 不是以 `\";` 收尾的字符串常量");
  return APP.slice(start, end + 2);
}

/** 切出 `buildKickoffPrompt` 函数声明全文。 */
function sliceBuilder() {
  const start = APP.indexOf("function buildKickoffPrompt(");
  assert.ok(start > 0, "web/app.js 里找不到 `function buildKickoffPrompt(`（被改回静态常量了？）");
  const brace = APP.indexOf("{", start);
  assert.ok(brace > start, "`buildKickoffPrompt` 没有函数体");
  return APP.slice(start, matchBrace(APP, brace) + 1);
}

/** 把真函数跑起来（只注入它依赖的常量，不给任何全局状态）。 */
function loadBuilder() {
  const source = `${sliceSteps()}\n${sliceBuilder()}\nreturn { buildKickoffPrompt, KICKOFF_STEPS };`;
  return new Function(source)();
}

const PROJ_A = { id: "taskboard-workbench", name: "任务工作台", workspacePath: "/tmp/tb-home/work/03taskboard_workbench" };
const PROJ_B = { id: "scada-board", name: "SCADA 看板", workspacePath: "/tmp/tb-home/work/07scada_docs" };

test("A 源码层：占位符 0 命中，且复制入口按当前项目插值（静态常量 ⇒ 红）", () => {
  const hits = APP.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => line.includes(PLACEHOLDER));
  assert.deepEqual(hits, [], `web/app.js 里不得再出现「${PLACEHOLDER}」占位符（复制出去会原样带着它）`);
  // 复制入口必须是「现算」，不是「读常量」—— 这一条是反向对照：改回 `gcopy("…", KICKOFF_PROMPT)` ⇒ 红。
  assert.match(APP, /const kickoffText = buildKickoffPrompt\(kickoffProject\)/, "复制入口必须以当前项目现算文本");
  assert.match(APP, /gcopy\("复制开局提示词", kickoffText\)/, "「复制开局提示词」按钮必须复制现算出的文本");
  // 取项目必须按「配置对象」(`state.projectId`)，不能只按 `/api/context` 的全局绑定 —— 否则切项目后仍复制旧项目。
  assert.match(APP, /\.find\(\(p\) => p\.id === state\.projectId\)/, "插值用的项目必须按配置对象 state.projectId 取");
});

test("B 两个不同项目 ⇒ 文本互不相同，且各含自身 id 与工作目录", () => {
  const { buildKickoffPrompt } = loadBuilder();
  const a = buildKickoffPrompt(PROJ_A);
  const b = buildKickoffPrompt(PROJ_B);
  assert.notEqual(a, b, "两个项目的开局提示词必须不同（相同即说明没有插值）");
  for (const [text, project] of [[a, PROJ_A], [b, PROJ_B]]) {
    assert.ok(text.includes(`项目：${project.id}`), `文本必须含「项目：${project.id}」（实际抬头：${text.split("\n")[1]}）`);
    assert.ok(text.includes(`工作目录：${project.workspacePath}`), `文本必须含真实绝对路径「工作目录：${project.workspacePath}」`);
    // 交叉污染检查：A 的文本不得出现 B 的路径，反之亦然。
    const other = project === PROJ_A ? PROJ_B : PROJ_A;
    assert.ok(!text.includes(other.workspacePath), `项目 ${project.id} 的文本里混进了别的项目的路径 ${other.workspacePath}`);
    assert.ok(!text.includes(other.id), `项目 ${project.id} 的文本里混进了别的项目的 id ${other.id}`);
  }
  // 工作目录必须落在抬头（第一条 ① 之前），否则新会话要读完整段才知道该在哪开工。
  assert.ok(a.indexOf("工作目录：") < a.indexOf("① 先做"), "「工作目录」必须排在 ①–⑧ 之前");
  // 不留任何尖括号占位符（复制即用，不需要人再替换）。
  assert.ok(!/工作目录：\s*[<‹]/.test(a), "工作目录不得是占位符形态");
});

test("C 未设 workspacePath ⇒ 如实写「请先在配置页补」，不写空值/undefined/null", () => {
  const { buildKickoffPrompt } = loadBuilder();
  for (const project of [
    { id: "no-ws", name: "没目录的项目", workspacePath: null },
    { id: "empty-ws", name: "空目录的项目", workspacePath: "   " },
    { id: "missing-ws", name: "字段缺失的项目" },
  ]) {
    const text = buildKickoffPrompt(project);
    assert.ok(text.includes(`工作目录：${NO_WS}`), `${project.id}：未设工作目录时必须写「${NO_WS}」，实际：${text.split("\n")[2]}`);
    assert.ok(!/undefined|null/.test(text), `${project.id}：文本里不得出现 undefined/null`);
    assert.ok(!text.includes(PLACEHOLDER), `${project.id}：文本里不得出现占位符`);
  }
  // 极端输入（null）也不许崩 —— 复制按钮不能因一个空项目就整页报错。
  assert.doesNotThrow(() => loadBuilder().buildKickoffPrompt(null));
});

test("D ①–⑧ 流程正文逐项保留（只加抬头，不改流程）", () => {
  const { buildKickoffPrompt, KICKOFF_STEPS } = loadBuilder();
  const text = buildKickoffPrompt(PROJ_A);
  const marks = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧"];
  for (const mark of marks) assert.ok(text.includes(mark), `流程正文必须仍有 ${mark}`);
  assert.ok(text.endsWith(KICKOFF_STEPS), "抬头之后必须**整段**接原流程正文（不许截断）");
  // 流程正文本身不含项目信息（与项目无关 ⇒ 两个项目共用同一段）；翻转即说明有人把插值塞回了正文。
  assert.ok(!KICKOFF_STEPS.includes(PROJ_A.workspacePath), "流程正文不该含具体项目路径");
});
