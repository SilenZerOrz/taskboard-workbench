/**
 * 卡 `-240`（需求 `R176`）：**宿主内嵌环境不支持浏览器原生 prompt()**。
 *
 * 真机 2026-11-12：在 DSH 内嵌宿主里点工具栏「新建项目」，界面直接弹
 * 「脚本错误：prompt() is not supported」—— 新建项目整个功能不可用（不是体验问题）。
 * 根因是 `window.prompt()` 在 Electron / 受限 webview 里不存在。
 *
 * 这组测试守三件事：
 *   ① **源码门**：`web/` 下不允许再出现 `window.prompt(...)` 调用 —— 这是「改回去就会复发」的那类缺陷，
 *      只有读源码才拦得住（渲染层测试读不出「调用了一个不存在的函数」，它只会抛异常）；
 *   ② **结构门**：`askFields()` 仍在，且「取消 / Esc / 点遮罩」三条出口都走 `finish(null)` ——
 *      缺一条就会出现「对话框关掉了但 Promise 永远挂起」或「取消了却仍在发请求」；
 *   ③ **反向对照**：扫描器对合成样本（真调用 / 注释里提到 / `confirm`）的判定各对一次 ——
 *      否则「0 命中」可能只是正则写错了（恒假扫描器同样返回 0）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** 扫描器：只认**调用**（`window.prompt(` / `window.prompt (...)`），注释里不带 `window.` 的提及不算。 */
const PROMPT_CALL = /window\s*\.\s*prompt\s*\(/g;
const scanPromptCalls = (text) => [...String(text).matchAll(PROMPT_CALL)];

/** 递归列出 `web/` 下的文本文件（跳过明显二进制：无扩展名的也读，web/ 里全是源文件）。 */
function webFiles(dir = path.join(ROOT, "web")) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...webFiles(full));
    else out.push(full);
  }
  return out;
}

test("① web/ 下不存在 window.prompt 调用（宿主不支持，调用即抛）", () => {
  const hits = [];
  for (const file of webFiles()) {
    const text = readFileSync(file, "utf8");
    for (const m of scanPromptCalls(text)) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push(`${path.relative(ROOT, file)}:${line}`);
    }
  }
  assert.deepEqual(hits, [], `宿主内嵌环境不支持 window.prompt，必须用页面内 dialog：\n  ${hits.join("\n  ")}`);
  assert.ok(webFiles().length >= 2, "web/ 至少要扫到 app.js 与 tokens.css —— 0 个文件说明扫描根路径写错了");
});

test("② 反向对照：扫描器能抓到合成调用、不误报注释与 confirm", () => {
  // 真调用（含空格变体）——必须抓到，否则「0 命中」是假绿
  assert.equal(scanPromptCalls('const n = window.prompt("x");').length, 1);
  assert.equal(scanPromptCalls("const n = window . prompt ( 'x' )").length, 1);
  assert.equal(scanPromptCalls('const a = window.prompt("x"); const b = window.prompt("y");').length, 2);
  // 注释里只提 prompt()（不带 window. 前缀）不算调用
  assert.equal(scanPromptCalls("// 宿主不支持浏览器原生 prompt()，改用 dialog").length, 0);
  // confirm 不在本卡范围（同一宿主里实测可用），扫描器不得顺手把它算进来
  assert.equal(scanPromptCalls('if (!window.confirm("确定？")) return;').length, 0);
});

test("③ askFields 结构门：三条取消出口都归到 finish(null)，提交走 collect()", () => {
  const app = read("web/app.js");
  assert.match(app, /function askFields\(\{ title, hint = "", fields = \[\], submit = "确定" \}\)/, "askFields 取值器必须存在且签名稳定");
  // 取消按钮 / Esc / 点遮罩 三条出口，一条都不能少
  assert.ok(
    (app.match(/finish\(null\)/g) ?? []).length >= 3,
    "取消按钮、Esc、点遮罩三条出口都必须 finish(null)（少一条 ⇒ 关得掉但 Promise 挂起）",
  );
  assert.match(app, /addEventListener\("cancel", \(event\) => \{ event\.preventDefault\(\); finish\(null\); \}\)/, "Esc 必须拦下 cancel 事件并走同一条取消路径");
  // 提交按钮 click 与表单 submit 双入口：只挂 submit 会赌宿主派发 submit
  assert.match(app, /form\.addEventListener\("submit", \(event\) => \{ event\.preventDefault\(\); collect\(\); \}\)/, "回车提交必须走 collect()");
  assert.match(app, /ok\.addEventListener\("click", \(event\) => \{ event\.preventDefault\(\); collect\(\); \}\)/, "提交按钮 click 必须走同一个 collect()（防宿主不派发 submit）");
  // 必填校验在本地做，且不关闭对话框
  assert.match(app, /if \(entry\.spec\.required && !value\.trim\(\)\)/, "必填字段必须在本地校验");
});

test("④ 四个功能入口都改走 askFields / askNewProject，且不再各自拼 prompt", () => {
  const app = read("web/app.js");
  // 新建项目：会话绑定门 + 工具栏，共用一份字段表（避免两处文案漂移）
  assert.equal(
    (app.match(/await askNewProject\(\)/g) ?? []).length, 2,
    "两个「新建项目」入口都必须走 askNewProject()",
  );
  // 另外三处（返工说明 / 人工结论 / 需求条目标题）各一次，加上 askNewProject 内部一次 = 4
  assert.equal(
    (app.match(/await askFields\(\{/g) ?? []).length, 4,
    "返工说明 / 人工结论 / 需求条目标题 + askNewProject 内部，共 4 处必须走 askFields()",
  );
  // 无条件调用（不 await、不判空）会让取消路径变成「用空值发请求」
  assert.match(app, /const input = await askFields\(\{/, "askFields 的返回值必须接住");
  assert.match(app, /if \(!input(?: \|\| !input\.conclusion\.trim\(\))?\) return;/, "取消（null）必须先 return，再发请求");
});

test("⑤ window.confirm 未被顺手改掉（不在本卡范围，动了就是扩大风险面）", () => {
  const app = read("web/app.js");
  assert.ok((app.match(/window\.confirm\(/g) ?? []).length >= 3, "confirm 在本宿主里实测可用，本卡只替换 prompt");
});
