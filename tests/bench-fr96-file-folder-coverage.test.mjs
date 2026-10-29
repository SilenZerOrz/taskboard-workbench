/**
 * FR-96 守卫：「引入的文件按文件夹呈现」必须**持续**有一台读渲染后 DOM 的验证台。
 *
 * 为什么需要这条（卡 `-163`）：FR-96 曾长期只有域层单测（纯函数 + 「接线存在」的文本断言）。
 * 2026-10-27 起这块被改成**默认折叠**的 `<details>`，「树画出来了」与「点了才看得见」是两件事，
 * 而单测两条都读不到 —— 于是有了 `tools/bench-fr96-file-folder.mjs`。
 * 本测试钉住：① 它读的是**渲染后 DOM**；② 覆盖折叠/展开、目录在前、单链合并、叶子 path、子树计数；
 * ③ 带**反向对照**（打平后判据必须转红）；④ 隔离边界（临时 dataDir + 临时 Chrome profile）。
 * 任一条被静默删掉 ⇒ 本测试变红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-fr96-file-folder.mjs"), "utf8");

test("FR-96-台1：必须是**真浏览器读 DOM**的台，而不是再读一遍源码文本", () => {
  assert.match(BENCH, /"--headless=new"/, "必须起真 headless Chrome");
  assert.match(BENCH, /Runtime\.evaluate/, "必须通过 CDP 读页内 DOM");
  assert.match(BENCH, /querySelectorAll\("details\.req-folder"\)/, "必须读渲染后的文件夹节点");
});

test("FR-96-台2：隔离边界（临时 dataDir + 临时 Chrome profile + 随机端口）", () => {
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-fr96-data-"\)\)/, "必须用临时数据目录");
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-fr96-chrome-"\)\)/, "必须用临时 Chrome profile");
  assert.match(BENCH, /listen\(port, "127\.0\.0\.1"/, "必须绑随机端口到本机回环");
  assert.match(BENCH, /TB_BENCH_WEB_DIR/, "必须保留反证入口（指向改动前的 web 目录）");
});

test("FR-96-台3：覆盖折叠/展开、目录在前、单链合并、叶子 path、子树计数", () => {
  assert.ok(BENCH.includes("默认折叠"), "必须断言默认折叠（`details.open === false`）");
  assert.match(BENCH, /sectionOpen === true/, "必须断言点开 summary 后 `open === true`");
  assert.match(BENCH, /foldersBeforeFiles/, "必须断言目录排在根级文件之前（DOM 顺序）");
  assert.ok(BENCH.includes('"a/b/"'), "必须断言单链合并成 `a/b/`");
  assert.ok(BENCH.includes("不存在独立的 `a/`"), "必须断言没有独立的 `a/` 节点");
  assert.match(BENCH, /leafTitles/, "必须逐个核对叶子 `title`（完整 path）");
  assert.match(BENCH, /EXPECT\.docsPill/, "必须断言子树计数胶囊（含子树，不是只数直属）");
});

test("FR-96-台4：必须带**反向对照**（打平后判据转红），否则判据恒真", () => {
  assert.match(BENCH, /const FLATTEN =/, "必须有「打平成旧口径」的注入步骤");
  assert.ok(BENCH.includes("D红=") && BENCH.includes("E红="), "必须分别报告 D/E 是否转红");
  assert.match(BENCH, /flat\?\.ok === true && dRed && eRed/, "反向对照不转红时本台必须判红");
});
