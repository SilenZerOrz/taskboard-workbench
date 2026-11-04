/**
 * 缺口守卫（卡 `-186` / 需求 `R141`）：`flow_inject_policy` 是**未实现的配置位**。
 *
 * ## 为什么需要这条测试
 * `flow_inject_policy` 自 P1 起就写在 `skills/taskboard-flow/references/injection.md` 里，
 * 但**全仓没有任何代码读它** —— 改它不改变任何行为。这是个**静默缺口**：
 * 人会以为「我把 policy 设成 main-only 就自动注入了」，而实际上什么都不会发生，且**不会报错、不进日志**。
 *
 * 处置（口径 B，人拍）：**把静默缺口变成显式缺口** —— 文档明写「未实现（全仓无 reader）」，
 * 并用这条测试把它钉成**机器可守的判据**：
 *   · 现在：代码里 0 命中 ⇒ 绿；
 *   · 将来有人接线（P5 / 卡 `-210`）：命中 > 0 ⇒ **红**，强制他同时更新文档与卡状态。
 *
 * 这条测试守的不是"功能对不对"，而是**"文档别撒谎"**（与 `-179` 那条「数据对、人读的那层在撒谎」同型）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const FIELD = "flow_inject_policy";
/** 只扫**运行时/工具**代码；`skills/**` 是文档、`tests/**` 是本测试自身，不参与。 */
const CODE_DIRS = ["src", "scripts", "web", "cli", "tools", "spec"];
const CODE_EXT = new Set([".mjs", ".js", ".cjs"]);

function collect(dir, acc = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return acc;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(rel, acc);
    else if (CODE_EXT.has(path.extname(entry.name))) acc.push(rel);
  }
  return acc;
}

test("缺口守卫：`flow_inject_policy` 仍无任何代码读取点（一旦接线必须同步改文档）", () => {
  const hits = [];
  for (const file of CODE_DIRS.flatMap((d) => collect(d))) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    if (src.includes(FIELD)) hits.push(file);
  }
  assert.deepEqual(
    hits,
    [],
    `\`${FIELD}\` 出现了代码读取点 ⇒ 说明档 C 已经接线了。请同步：\n`
      + "  ① `skills/taskboard-flow/references/injection.md` 顶部与预埋项表格：「未实现（全仓无 reader）」→「已实现」；\n"
      + "  ② 卡 `-186` / 需求 `R141` 收口为「已被 P5（`-210`）取代」；\n"
      + "  ③ 把本测试改成「注入面」的正向守卫（断言 policy 四档真的分流）。",
  );
});

test("缺口标注在位：文档明写「未实现（全仓无 reader）」", () => {
  const md = fs.readFileSync(path.join(ROOT, "skills/taskboard-flow/references/injection.md"), "utf8");
  assert.match(md, /未实现（全仓无 reader）/, "injection.md 必须明写「未实现（全仓无 reader）」");
  assert.match(md, /改它不改变任何行为|改它\*\*不改变任何行为\*\*/, "必须说清「改它不改变行为」");
  // 反向对照：不许悄悄改回「已可用 / 已启用」
  assert.match(md, /档 C 预埋，\*\*未实现\*\*/, "标题必须保持「未实现」口径");
});

test("档 C 仍是「未启用」：三档表里 C 的现状列不得写成已可用", () => {
  const md = fs.readFileSync(path.join(ROOT, "skills/taskboard-flow/references/injection.md"), "utf8");
  const row = md.split("\n").find((l) => l.startsWith("| **C 宿主自动注入**"));
  assert.ok(row, "三档表必须有「C 宿主自动注入」一行");
  assert.match(row, /未启用/, "档 C 现状列必须仍是「未启用」");
});
