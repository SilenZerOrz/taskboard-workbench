/**
 * 守卫（FR-91 补口 · 2026-10-29 真机批注）：「从需求条目点击查看，看到受阻的任务 DAG 提醒，支持点击跳转任务查看」。
 *
 * 现象：需求条目详情抽屉下方「任务 DAG」里的节点原来是纯展示 `<div>`，点了没反应；
 * 而同一抽屉里「关联任务完成情况」那一行已经有「打开任务」按钮 —— **同一张卡，两种可达性**。
 *
 * 为什么会漏：DAG 段是「阅读型」区块，写的时候只想着把 status + 编号 + 标题铺出来；
 * 「有入口」的判据被默认落在按钮形态上，于是 div 形态天然不被算作入口。
 *
 * 守卫三条（只读源码文本，毫秒级，不起浏览器）：
 *   ① DAG 节点必须是 `button` 且挂 click → `openTaskByRef`（键盘可达顺带拿到）；
 *   ② 打开任务不能只依赖 `state.tasks`（筛选/分页下必然查不到）⇒ 必须有 `GET /api/tasks/:ref` 兜底；
 *   ③ `.req-node` 必须复位按钮 UA 样式（`font-family: inherit` / `text-align: left` / `width: 100%` / `cursor: pointer`），
 *      否则从 div 变 button 会静默变成「灰底/居中/默认字号」的视觉回归。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

/** 从 `openTaskByRef` 的定义处切到下一个顶格成员（`\n    }` 收边），只在这一段里断言。 */
function openTaskByRefBody() {
  const start = app.indexOf("async function openTaskByRef(");
  assert.ok(start > 0, "web/app.js 必须有 openTaskByRef（唯一按编号打开任务的入口）");
  const end = app.indexOf("\n    }", start);
  assert.ok(end > start, "openTaskByRef 必须能收边（否则切片守卫失效）");
  return app.slice(start, end);
}

test("DAG 节点可点：button + click → openTaskByRef + title 提示", () => {
  const dagStart = app.indexOf("任务 DAG（");
  assert.ok(dagStart > 0, "必须有「任务 DAG」段");
  const seg = app.slice(dagStart, dagStart + 4000);
  assert.match(seg, /const node = mk\("button", "req-node"\)/, "DAG 节点必须是 button（div 点不动）");
  assert.match(seg, /node\.type = "button"/, "必须显式 type=button（避免被表单当 submit）");
  assert.match(seg, /node\.title = `打开任务 \$\{n\.identifier\}`/, "必须给 title 提示，人不用先点才知道能点");
  assert.match(seg, /node\.addEventListener\("click", \(\) => void openTaskByRef\(n\.identifier\)\)/, "必须挂 click → openTaskByRef");
  assert.ok(!/const node = mk\("div", "req-node"\)/.test(app), "不得回退成纯展示 div");
});

test("打开任务有兜底：列表里没有就按编号现取一张（GET /api/tasks/:ref）", () => {
  const body = openTaskByRefBody();
  assert.match(body, /state\.tasks/, "应优先命中当前列表（省一次请求）");
  assert.match(body, /api\("GET", `\/api\/tasks\/\$\{encodeURIComponent\(ref\)\}`\)/, "查不到必须按编号现取，不能直接报错");
  assert.match(body, /openTaskDetail\(/, "两条路径都必须真的打开详情抽屉");
  assert.ok(
    !app.includes("该任务不在当前列表（可能已归档）"),
    "旧的「列表查不到就报可能已归档」的死路必须消失（列表查不到 ≠ 任务不存在）",
  );
});

test("同一张卡的另一个入口同样走 openTaskByRef（不留第二套解析）", () => {
  assert.match(
    app,
    /openT\.addEventListener\("click", \(\) => void openTaskByRef\(t\.identifier\)\)/,
    "「关联任务完成情况」行的「打开任务」必须复用同一入口",
  );
});

test("CSS 复位：.req-node 从 div 变 button 不得留下 UA 默认样式", () => {
  const start = css.indexOf(".req-node {");
  assert.ok(start > 0, "必须有 .req-node 规则");
  const seg = css.slice(start, css.indexOf("}", start));
  assert.match(seg, /font-family: inherit/, "必须继承字体（否则按钮用 UA 默认字体）");
  assert.match(seg, /color: inherit/, "必须继承文字颜色（否则与相邻行不一致）");
  assert.match(seg, /text-align: left/, "必须左对齐（按钮默认居中）");
  assert.match(seg, /width: 100%/, "必须撑满（按钮默认按内容收缩，会把 DAG 拉成千层饼）");
  assert.match(seg, /cursor: pointer/, "必须给出可点的指针反馈");
  assert.match(css, /\.req-node:hover \{ border-color: var\(--accent\); \}/, "必须有 hover 态（可点性要看得见）");
});
