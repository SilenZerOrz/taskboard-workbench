/**
 * FR-96 需求文档「引入的文件」按文件夹呈现（2026-10-23 真机反馈：
 * 「需求文档的展示按文件夹的列表样式呈现」）。
 *
 * 现场：需求文档的「资料清单」解析出 181 个文件，平铺成一列 —— 无处查阅、看不出目录结构。
 * 本组钉两件事：
 *   A. 领域层（app.js 内的纯函数 `buildFileFolderTree`）—— 分层 / 排序 / 单链合并 / 计数 /
 *      **一个文件都不能丢** / 异常输入不炸且不臆造。
 *   B. 接线层 —— 呈现改走文件夹树（目录节点可展开收起、默认展开），旧平铺渲染必须已被替换；
 *      CSS 用**独立类名**，不得借用需求条目列表的 `.req-list` 网格口径（那是 FR-91 的列表）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const SOURCE = read("web/app.js");
const CSS = read("web/tokens.css");

/** 从 app.js 切出纯函数区（与既有 FR-11 / panel-asset-selfheal 同一手法：切片 + new Function 驱动）。 */
function loadTreeHelpers() {
  const start = SOURCE.indexOf("function buildFileFolderTree(files) {");
  assert.ok(start > 0, "app.js 里找不到 buildFileFolderTree（FR-96 未接线？）");
  const end = SOURCE.indexOf("/** FR-96：一键展开 / 收起本区块内的所有文件夹。 */");
  assert.ok(end > start, "切片区结束标记缺失");
  const region = SOURCE.slice(start, end);
  return new Function(`${region}; return { buildFileFolderTree, finalizeFileTree };`)();
}

const { buildFileFolderTree } = loadTreeHelpers();
const names = (arr) => arr.map((x) => x.name);

test("FR-96-1：按目录分层，目录在前、文件在后，根级文件留在 files", () => {
  const tree = buildFileFolderTree([
    { path: "b.md", bytes: 10 },
    { path: "docs/交付/x.md", bytes: 40 },
    { path: "docs/a.md", bytes: 30 },
    { path: "docs/z.md", bytes: 20 },
    { path: "AGENTS.md", bytes: 50 },
  ]);
  assert.deepEqual(names(tree.folders), ["docs"], "只有 docs 一个顶层目录");
  assert.deepEqual(names(tree.files), ["AGENTS.md", "b.md"], "根级文件按名排序");
  const docs = tree.folders[0];
  assert.deepEqual(names(docs.folders), ["交付"], "docs 下还有一个子目录");
  assert.deepEqual(names(docs.files), ["a.md", "z.md"], "docs 自己的文件按名排序");
  assert.deepEqual(names(docs.folders[0].files), ["x.md"]);
  // 计数：2 个目录（docs / docs/交付），5 个文件，字节求和
  assert.equal(tree.folderCount, 2);
  assert.equal(tree.fileTotal, 5);
  assert.equal(tree.byteTotal, 150);
  assert.equal(docs.fileTotal, 3, "docs 的文件数含子树");
});

test("FR-96-2：单链合并 —— a/b 不会让用户点两层才见到文件", () => {
  const tree = buildFileFolderTree([{ path: "a/b/c.md", bytes: 1 }]);
  assert.deepEqual(names(tree.folders), ["a/b"], "只有一条子目录且自身无文件 ⇒ 并成一个节点");
  assert.deepEqual(names(tree.folders[0].files), ["c.md"]);
  assert.equal(tree.folders[0].path, "a/b", "path 仍是真实目录路径");
  assert.equal(tree.folderCount, 1);
  // 反例：目录自己**也有**文件时不得合并（否则那些文件会挂错父节点）
  const mixed = buildFileFolderTree([{ path: "a/readme.md", bytes: 1 }, { path: "a/b/c.md", bytes: 1 }]);
  assert.deepEqual(names(mixed.folders), ["a"]);
  assert.deepEqual(names(mixed.folders[0].files), ["readme.md"]);
  assert.deepEqual(names(mixed.folders[0].folders), ["b"]);
});

test("FR-96-3：路径归一（反斜杠 / 前缀 ./）与非法项处理", () => {
  const t = buildFileFolderTree([
    { path: "docs\\win.md", bytes: 5 },
    { path: "./AGENTS.md", bytes: 7 },
    { path: "", bytes: 9 },
    { path: null, bytes: 9 },
    { path: "no-bytes.md" },
  ]);
  assert.deepEqual(names(t.folders), ["docs"], "反斜杠按分隔符归一");
  assert.deepEqual(names(t.files), ["AGENTS.md", "no-bytes.md"]);
  assert.equal(t.files[0].bytes, 7);
  assert.equal(t.files[1].bytes, 0, "bytes 缺失/非法 ⇒ 0（不编造大小）");
  assert.equal(t.fileTotal, 3, "空 / null 路径被跳过，不产出幽灵文件");
});

test("FR-96-4：空输入不炸，形状稳定", () => {
  for (const input of [[], null, undefined, "not-array"]) {
    const t = buildFileFolderTree(input);
    assert.deepEqual(t, { folders: [], files: [], folderCount: 0, fileTotal: 0, byteTotal: 0 });
  }
});

test("FR-96-5：叶子保留完整 path（供 title 悬浮提示）且**一项不丢**", () => {
  const files = [
    { path: "docs/交付/DASH 安装与自检-2026-10-13.md", bytes: 6307 },
    { path: "docs/README.md", bytes: 174490 },
    { path: "AGENTS.md", bytes: 7155 },
  ];
  const tree = buildFileFolderTree(files);
  assert.equal(tree.fileTotal, files.length, "fileTotal 必须等于输入项数");
  const flat = [];
  const walk = (n) => { for (const f of n.files) flat.push(f); for (const d of n.folders) walk(d); };
  walk(tree);
  assert.deepEqual(flat.map((f) => f.path).sort(), files.map((f) => f.path).sort(), "任何一项都不得丢");
  assert.deepEqual(flat.map((f) => f.bytes).sort((a, b) => a - b), [6307, 7155, 174490], "字节数原样保留");
  assert.ok(flat.every((f) => !f.path.includes("/") || f.path.includes("/") && f.name === f.path.split("/").pop()), "叶子只显示文件名");
});

test("FR-96-6：呈现接线 —— 走文件夹树，旧平铺渲染已被替换", () => {
  assert.match(SOURCE, /const tree = buildFileFolderTree\(files\);/, "必须由纯函数建树");
  assert.match(SOURCE, /fs\.appendChild\(renderFileTree\(tree\)\)/, "必须渲染文件夹树");
  assert.match(SOURCE, /const details = mk\("details", "req-folder"\);/, "目录节点用 <details>");
  assert.match(SOURCE, /details\.open = true;/, "默认展开（不得隐藏任何文件）");
  assert.match(SOURCE, /querySelectorAll\("details\.req-folder"\)/, "一键展开/收起要作用于本区块内的目录节点");
  assert.match(SOURCE, /btn\("全部展开"/);
  assert.match(SOURCE, /btn\("全部收起"/);
  assert.match(SOURCE, /引入的文件（\$\{files\.length\}）/, "总数仍要显式告知（不隐藏规模）");
  assert.equal(SOURCE.includes('mk("span", "req-title", f.path)'), false, "旧的「一列平铺文件路径」渲染必须已被替换");
});

test("FR-96-7：样式独立 —— 不借用需求条目列表的 .req-list 网格（那是 FR-91 的口径）", () => {
  assert.match(CSS, /\.req-tree \{/);
  assert.match(CSS, /\.req-folder \{/);
  assert.match(CSS, /\.req-folder > summary \{/);
  assert.match(CSS, /\.req-list-files \{/);
  assert.match(CSS, /\.req-file \{/);
  assert.match(CSS, /\.req-files-head \{/);
  // 文件树样式必须独立于需求条目列表（2026-10-27 起条目已从网格改成单列列表，仍不许复用条目类）
  assert.match(CSS, /\.req-tree \{/, "文件树要有自己的容器类");
  assert.ok(!/\.req-tree[^{]*\{[^}]*\.req-item/.test(CSS), "文件树不得借用条目样式");
});
