/**
 * 守卫（2026-11-12 · 卡 `-243` / 需求 `R177`）：`tools/bench-kickoff-prompt.mjs` 必须**持续**证明
 * 「配置页复制出来的开局提示词真的带上了当前项目与工作目录」。
 *
 * 为什么需要这条：本轮的缺陷**长着完全正常的外形** —— 按钮在、点了也有「已复制」横幅、
 * 复制出来的还是一段读起来很通顺的流程说明，只有**逐字读剪贴板里的文本**才发现里头的目录是个尖括号占位符。
 * 后来者最容易做的一次「简化」就是把这些断言删回去（比如不再读剪贴板、只断言按钮存在），
 * 那种台子会全绿而缺陷原样复活 ⇒ 与 `-224`/`-225`/`-226`/`-227`/`-228` 五台守卫同一条规矩。
 *
 * 钉住八件事：
 *   ① 台必须**真读剪贴板投递的文本**（页内 spy 覆写 `navigator.clipboard.writeText`），不得只断言按钮存在；
 *   ② 台必须断言文本含 `项目：<id>` 与 `工作目录：<真实绝对路径>`；
 *   ③ 台必须断言文本**不含**尖括号占位符，且工作目录行排在 ① 之前；
 *   ④ 台必须**切项目再复制一次**并断言跟着换（这是本轮最容易漏的半边：界面写 B、复制出来是 A）；
 *   ⑤ 台必须覆盖「未设 workspacePath」形态（如实写「请先在配置页补」，不留 undefined/null）；
 *   ⑥ 台必须断言界面**明文写出**带的是哪个项目/哪个目录（人不必点也能看出）；
 *   ⑦ 台必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与退出码 0/1/2；
 *   ⑧ `web/app.js` 侧：占位符 0 命中、复制入口按 `state.projectId` 现算、`KICKOFF_STEPS` 与
 *      `buildKickoffPrompt` 分工不得被合回一条静态常量。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools", "bench-kickoff-prompt.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");

test("守卫：`-243` 台必须真读剪贴板投递的文本（不得只断言按钮在）", () => {
  assert.match(bench, /navigator\.clipboard/, "必须覆写 navigator.clipboard（页内 spy）");
  assert.match(bench, /window\.__CLIP__/, "必须记录 writeText 的实参");
  assert.match(bench, /Page\.addScriptToEvaluateOnNewDocument/, "spy 必须在页面脚本之前注入（否则绑不到）");
  assert.match(bench, /const textA = String\(copyA\.clip \?\? ""\)/, "必须对**捕获到的文本**做断言");
});

test("守卫：`-243` 台必须断言「项目 id + 真实绝对路径」两件都在", () => {
  assert.match(bench, /textA\.includes\("项目：proj-a"\)/, "必须核对项目 id");
  assert.match(bench, /textA\.includes\(`工作目录：\$\{wsA\}`\)/, "必须核对真实绝对路径（种子目录）");
});

test("守卫：`-243` 台必须断言不含占位符且工作目录在 ① 之前", () => {
  assert.match(bench, /!textA\.includes\("<项目绝对路径>"\)/, "必须禁止尖括号占位符");
  assert.match(bench, /textA\.indexOf\("工作目录："\)[\s\S]{0,80}textA\.indexOf\("①"\)/, "工作目录必须排在流程正文之前");
});

test("守卫：`-243` 台必须「切项目再复制」一次并断言跟着换（本轮最容易漏的半边）", () => {
  assert.match(bench, /const bSel = await selectProject\("proj-b"/, "必须真切到另一个项目");
  assert.match(bench, /textB\.includes\("项目：proj-b"\)/, "切换后文本必须换成新项目");
  assert.match(bench, /!textB\.includes\(wsA\)/, "切换后不得残留旧项目路径");
});

test("守卫：`-243` 台必须覆盖「未设 workspacePath」形态", () => {
  assert.match(bench, /store\.createProject\(\{ id: "proj-c", name: "项目丙" \}\)/, "种子必须有一个未设 workspacePath 的项目");
  assert.match(bench, /（项目未设 workspacePath → 请先在配置页补）/, "未设目录必须如实写「请先在配置页补」");
  assert.match(bench, /!textC\.includes\("undefined"\)/, "不得把 undefined 印进提示词");
});

test("守卫：`-243` 台必须断言界面明文写出带的是哪个项目/目录", () => {
  assert.match(bench, /h\.startsWith\("开工语已带上"\)/, "必须有「开工语已带上：…」的人可见提示");
  assert.match(bench, /hintA\.includes\("proj-a"\) && hintA\.includes\(wsA\)/, "提示必须写出项目与目录");
});

test("守卫：`-243` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(bench, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(bench, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(bench, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(bench, /process\.exit\(1\)/, "失败必须体现在退出码上");
});

test("守卫：`web/app.js` 侧不得退回静态常量", () => {
  assert.ok(!app.includes("<项目绝对路径>"), "web/app.js 不得再有该占位符（R177 验收①）");
  assert.ok(!app.includes("const KICKOFF_PROMPT ="), "不得退回单条静态常量（KICKOFF_PROMPT）");
  assert.match(app, /function buildKickoffPrompt\(project\)/, "必须保留按项目插值的构建函数");
  assert.match(app, /const KICKOFF_STEPS = "① 先做「项目开局对齐」/, "流程正文必须仍是可独立核对的常量");
  assert.match(app, /const kickoffText = buildKickoffPrompt\(kickoffProject\);/, "复制入口必须现算");
  assert.match(app, /\.find\(\(p\) => p\.id === state\.projectId\)/, "必须按配置对象取项目（不是 /api/context 的全局绑定）");
});
