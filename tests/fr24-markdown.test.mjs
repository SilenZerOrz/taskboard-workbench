/**
 * FR-24（Markdown 呈现与内容安全）专项测试。
 *
 * 口径：把 `web/app.js` 里 `// == FR-24-MD-BEGIN/END ==` 区段**原样取出**，用最小假 DOM 真跑
 * （与 tests/fr28-session-current-scope.test.mjs / tests/dsh-plugin.test.mjs 既有做法同型），
 * 而不是只做正则断言 —— 否则「表格 / 任务清单到底会不会渲染」验证不到。
 *
 * 覆盖：① 七类标记（标题 / 列表 / 任务清单 / 表格 / 代码块 / 链接 / 引用）各渲染一次；
 *      ② HTML 注释不可见；③ 脚本 / 事件属性标签既不可执行也不呈现为可交互内容；
 *      ④ 既有 `**加粗**` 不回退；⑤ 描述与评论共用同一份渲染函数。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const APP = read("web/app.js");

// ---------------------------------------------------------------- 最小假 DOM
/** 只够 renderMarkdown 跑起来：建元素 / 建文本 / 追加 / 属性 / 读文字。 */
function makeDoc() {
  const makeNode = (tag) => {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k] ?? null; },
      appendChild(child) { this.children.push(child); return child; },
      append(...nodes) { for (const n of nodes) this.appendChild(n); return this; },
    };
    return node;
  };
  return {
    createElement: (tag) => makeNode(tag),
    createTextNode: (text) => ({ tagName: "#text", textContent: String(text), children: [], attrs: {}, appendChild() {} }),
  };
}

/** 从 app.js 抽出 FR-24 渲染区段，返回 { renderMarkdown, stripHtmlComments, safeHref }。 */
function loadRenderer() {
  const block = /\/\/ == FR-24-MD-BEGIN ==([\s\S]*?)\/\/ == FR-24-MD-END ==/.exec(APP);
  assert.ok(block, "必须能定位到 FR-24 渲染区段（== FR-24-MD-BEGIN/END ==）");
  const factory = new Function(`${block[1]}\nreturn { renderMarkdown, stripHtmlComments, safeHref };`);
  return factory();
}

const R = loadRenderer();
const render = (text) => R.renderMarkdown(makeDoc(), text);

/** 深度遍历出所有节点的 tagName（元素 + 文本）。 */
function tags(node, out = []) {
  out.push(node.tagName);
  for (const c of node.children ?? []) tags(c, out);
  return out;
}
/** 取第一个指定标签的节点。 */
function find(node, tag) {
  if (node.tagName === String(tag).toUpperCase()) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, tag);
    if (hit) return hit;
  }
  return null;
}
/** 收集某标签的全部节点。 */
function findAll(node, tag, out = []) {
  if (node.tagName === String(tag).toUpperCase()) out.push(node);
  for (const c of node.children ?? []) findAll(c, tag, out);
  return out;
}
/** 某节点的全部可见文本（含后代）——「注释不可见」的判定依据。 */
function textOf(node) {
  if (node.tagName === "#text") return node.textContent;
  let s = node.children?.length ? "" : (node.textContent ?? "");
  for (const c of node.children ?? []) s += textOf(c);
  return s;
}

// ---------------------------------------------------------------- ① 七类标记
test("FR-24：标题 / 列表 / 任务清单 / 表格 / 代码块 / 链接 / 引用 七类标记各渲染一次", () => {
  const md = [
    "# 一级标题",
    "",
    "- 无序项一",
    "- 无序项二",
    "",
    "1. 有序项一",
    "2. 有序项二",
    "",
    "- [x] 已完成项",
    "- [ ] 未完成项",
    "",
    "| 名称 | 状态 |",
    "| --- | --- |",
    "| 甲 | 通过 |",
    "| 乙 | 失败 |",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "见 [任务台](https://example.com/x) 说明。",
    "",
    "> 引用一行",
    "> 引用二行",
  ].join("\n");
  const body = render(md);

  // 标题
  const h = find(body, "h3");
  assert.ok(h, "`# 标题` 必须渲染为标题元素（降级到 h3，不与页面 h1/h2 抢层级）");
  assert.equal(textOf(h).trim(), "一级标题");

  // 列表（无序 / 有序）
  const uls = findAll(body, "ul");
  const ols = findAll(body, "ol");
  assert.ok(uls.length >= 1, "无序列表必须渲染为 <ul>");
  assert.ok(ols.length >= 1, "有序列表必须渲染为 <ol>");
  assert.equal(findAll(body, "li").length, 6, "两个无序 + 两个有序 + 两个任务清单 = 6 个 <li>");

  // 任务清单：只读字形，绝不是可交互 input
  const tasks = find(body, "ul.md-tasks") ?? findAll(body, "ul").find((u) => u.className.includes("md-tasks"));
  assert.ok(tasks, "任务清单必须渲染为 `.md-tasks`");
  assert.equal(findAll(tasks, "li").length, 2, "两条任务清单项");
  assert.match(textOf(tasks), /☑/, "已勾选项需有勾选字形");
  assert.match(textOf(tasks), /☐/, "未勾选项需有空框字形");
  assert.equal(findAll(body, "input").length, 0, "任务清单不得生成真正可点的 <input>（只读呈现）");

  // 表格
  const table = find(body, "table");
  assert.ok(table, "表格必须渲染为 <table>");
  assert.equal(findAll(table, "th").length, 2, "表头两列");
  assert.equal(findAll(table, "tr").length, 3, "一行表头 + 两行数据");
  assert.match(textOf(table), /甲/);
  assert.match(textOf(table), /失败/);

  // 代码块：原样保留
  const pre = find(body, "pre");
  assert.ok(pre, "``` 围栏必须渲染为 <pre>");
  assert.equal(textOf(pre), "const x = 1;", "代码块内容原样，不做行内解析");

  // 链接：真 <a>，带 noopener
  const a = find(body, "a");
  assert.ok(a, "`[文本](url)` 必须渲染为 <a>");
  assert.equal(a.getAttribute("href"), "https://example.com/x");
  assert.equal(a.getAttribute("rel"), "noopener noreferrer");
  assert.equal(a.getAttribute("target"), "_blank");

  // 引用
  const bq = find(body, "blockquote");
  assert.ok(bq, "`>` 必须渲染为 <blockquote>");
  assert.match(textOf(bq), /引用一行[\s\S]*引用二行/, "连续引用行需合并进同一引用块");
});

// ---------------------------------------------------------------- ② HTML 注释
test("FR-24②：HTML 注释在页面不可见（含跨行与未闭合）", () => {
  assert.equal(R.stripHtmlComments("前<!-- 内部标注 -->后"), "前后");
  assert.equal(R.stripHtmlComments("a<!--\n跨行\n注释\n-->b"), "ab");
  assert.equal(R.stripHtmlComments("尾<!-- 没闭合"), "尾", "未闭合注释须吃到文末（不得泄漏进正文）");

  const body = render("上行\n<!-- 内部标注：不要显示 -->\n下行");
  const visible = textOf(body);
  assert.equal(/内部标注/.test(visible), false, "注释文字不得出现在可见文本里");
  assert.equal(/<!--|-->/.test(visible), false, "注释定界符不得残留");
  assert.match(visible, /上行/);
  assert.match(visible, /下行/);

  // 跨行注释同样不可见
  const multi = render("甲\n<!--\n多行\n内部\n标注\n-->\n乙");
  assert.equal(/多行|内部|标注/.test(textOf(multi)), false, "跨行注释整体不可见");
});

// ---------------------------------------------------------------- ③ 安全
test("FR-24③：脚本与事件属性标签既不执行、也不呈现为可交互内容", () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">点我</a>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg/onload=alert(1)>',
  ];
  for (const payload of attacks) {
    const body = render(payload);
    const all = tags(body);
    for (const forbidden of ["SCRIPT", "IMG", "IFRAME", "SVG", "A", "INPUT", "BUTTON"]) {
      assert.equal(all.includes(forbidden), false, `危险载荷 ${payload} 不得产出 <${forbidden}> 元素`);
    }
    // 内容退化为**纯文本节点**（惰性、不可点、不可执行）—— 载荷原样可见，不带任何 DOM 语义
    const texts = [];
    const collectText = (n) => { if (n.tagName === "#text") texts.push(n.textContent); for (const c of n.children ?? []) collectText(c); };
    collectText(body);
    assert.ok(texts.some((s) => s.includes(payload.slice(0, 7))), `危险载荷需以纯文本形态保留（不至于是 HTML 节点）：${payload}`);
  }

  // javascript: 协议的 Markdown 链接 ⇒ 不生成 <a>，原样文本
  const jsLink = render("[点我](javascript:alert(1))");
  assert.equal(find(jsLink, "a"), null, "javascript: 链接不得渲染为 <a>");
  assert.match(textOf(jsLink), /\[点我\]\(javascript:alert\(1\)\)/, "危险链接退化为原样文本");
  assert.equal(R.safeHref("javascript:alert(1)"), null);
  assert.equal(R.safeHref("data:text/html,<script>"), null);
  assert.equal(R.safeHref("https://ok.example/a"), "https://ok.example/a");
  assert.equal(R.safeHref("./relative/path.md"), "./relative/path.md");

  // 全文件**零 HTML 注入属性写入** —— 这是「用户内容永不成 HTML 节点」的根保证。
  // 按**用法**判定（`x.innerHTML = …` / `x.insertAdjacentHTML(`），不按字面词 —— 注释里提到这些名字是允许的。
  const htmlSink = /\.\s*(?:innerHTML|outerHTML)\s*(?:=|\+=)|\.\s*insertAdjacentHTML\s*\(|document\.write\s*\(/;
  assert.equal(htmlSink.test(APP), false, "web/app.js 不得把用户内容写进 innerHTML / outerHTML / insertAdjacentHTML / document.write");
  assert.equal(htmlSink.test(read("lib/client.js")), false, "lib/client.js 同样不得有 HTML 注入面");
});

// ---------------------------------------------------------------- ④ 加粗不回退
test("FR-24④：既有 `**加粗**` 行为不回退，且段落口径保持", () => {
  const body = render("普通 **加粗** 普通");
  const strongs = findAll(body, "strong");
  assert.equal(strongs.length, 1, "`**加粗**` 仍渲染为 <strong>");
  assert.equal(textOf(strongs[0]), "加粗");
  assert.equal(/[*]{2}/.test(textOf(body)), false, "可见文本里不得残留 `**` 字面量");

  // 行内代码
  const withCode = render("请跑 `npm test` 验证");
  assert.equal(textOf(find(withCode, "code")), "npm test");

  // 段落：按空行切段，段内换行保留（CSS pre-wrap 口径）
  const paras = findAll(render("第一段\n续行\n\n第二段"), "p");
  assert.equal(paras.length, 2, "空行切段 = 2 个 <p>");
  assert.equal(textOf(paras[0]), "第一段\n续行", "段内换行原样保留（由 pre-wrap 呈现）");

  // 纯文本正文（无任何标记）不得被吞
  assert.equal(textOf(render("就是一句普通的话。")), "就是一句普通的话。");
});

// ---------------------------------------------------------------- ⑤ 描述 / 评论同源
test("FR-24：描述与评论共用同一份渲染函数（避免两套口径）", () => {
  assert.match(APP, /const richText = \(text\) => renderMarkdown\(doc, text\);/, "richText 必须委托给 renderMarkdown");
  assert.match(APP, /if \(t\.description\) overview\.appendChild\(richText\(t\.description\)\);/, "任务描述走 richText");
  // 窗口放宽到 1200：FR-17 在评论项里插入了"已编辑"meta 与编辑按钮（renders 仍走 richText）。
  const commentBlock = /for \(const c of comments\) \{[\s\S]{0,1200}?item\.appendChild\(richText\(c\.body\)\);/.exec(APP);
  assert.ok(commentBlock, "评论正文必须同样走 richText（与描述同一份渲染）");
  assert.equal(/item\.textContent = `\$\{fmtTime/.test(APP), false, "评论不得再直接塞 textContent（否则 Markdown 在评论里成字面量）");
  // 呈现面 CSS 就位
  const css = read("web/tokens.css");
  for (const sel of [".rich-body table.md-table", ".rich-body .md-tasks", ".rich-body .md-pre", ".rich-body .md-quote", ".rich-body a {"]) {
    assert.ok(css.includes(sel), `缺少 Markdown 呈现样式：${sel}`);
  }
});
