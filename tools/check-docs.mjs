#!/usr/bin/env node
/**
 * 随包人读文档守卫（**只读**）—— 卡 `-219` / 需求 `R161`
 *
 * ## 它在防什么
 * `spec/docs/` 是**装机后唯一能看到的人读约束**（开局 / 流程 / 条目 + 模板）。它有三个只会
 * 「静默坏掉」的风险，且都不会报错、不会让测试变红：
 *   ① **文件漏**：加了新文档忘了进 `files` 白名单，或删了文件但 README 还列着；
 *   ② **README 与磁盘分叉**：目录清单写着 3 份、实际 4 份 —— 读者按清单找，找不到就以为没有；
 *   ③ **私货泄漏**：把作者本仓的绝对路径（`/Users/...`）、临时目录、宿主进程号、内部条目号
 *     写进「写给所有人」的文档里。这类内容**读起来完全正常**，只有扫特征才拦得住。
 *
 * ## 纪律
 * - **只读**：只 `readFileSync` / `readdirSync`，零写入、零网络。
 * - **判据来自文件本身**：必备清单与白名单都写在本文件里（它们是「这份包该有什么」的定义），
 *   README 的目录清单则与磁盘**双向对齐**校验。
 * - 退出码：0 = 全过；1 = 有问题（逐条打印）。
 *
 * 用法：`node tools/check-docs.mjs`；测试里 `import { checkDocs }`。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 「这份包必须有的」人读文档（相对 `spec/docs/`）。少一份就算守卫失败。 */
export const REQUIRED_DOCS = ["README.md", "01-项目开局.md", "02-流程执行与条目.md", "assets/条目详情模板.md"];

/** 私货特征：出现在「写给所有人」的文档里就是泄漏或误导。 */
export const PRIVATE_MARKERS = [
  { re: /\/Users\/[A-Za-z0-9._-]+/, why: "作者本机绝对路径" },
  { re: /\/private\/var\/|\/var\/folders\//, why: "本机临时目录" },
  { re: /~\/\.dsh\b/, why: "本机宿主目录" },
  { re: /\bpid\s*[:=]?\s*\d{3,}/i, why: "宿主进程号（只对当时那台机器成立）" },
  { re: /taskboard-workbench-[A-Z]?\d+/, why: "作者本仓的内部条目/卡号" },
  { re: /\b03taskboard_workbench\b/, why: "作者本仓目录名" },
];

const listMarkdown = (dir, base = dir) => {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...listMarkdown(abs, base));
    else if (name.endsWith(".md")) out.push(path.relative(base, abs));
  }
  return out.sort();
};

/** README 里「## 目录」段列出的本地 md 链接（只取同目录/子目录的相对链接）。 */
export function readmeManifest(readmeText) {
  const m = /^##\s*目录\s*$([\s\S]*?)(?=^##\s|\Z)/m.exec(readmeText);
  if (!m) return null;
  return [...m[1].matchAll(/\]\(\.\/([^)]+\.md)\)/g)].map((x) => x[1]).sort();
}

/**
 * 只读守卫。
 * @param {string} dir `spec/docs` 绝对路径
 * @returns {{ok:boolean, dir:string, files:string[], problems:Array<{kind:string,target?:string,why:string}>}}
 */
export function checkDocs(dir = path.join(ROOT, "spec", "docs")) {
  const problems = [];
  const files = existsSync(dir) ? listMarkdown(dir) : [];
  if (!existsSync(dir)) return { ok: false, dir, files, problems: [{ kind: "missing-dir", why: `目录不存在：${dir}` }] };

  // ① 必备文件
  for (const rel of REQUIRED_DOCS) {
    if (!existsSync(path.join(dir, rel))) problems.push({ kind: "missing-file", target: rel, why: "必备文档缺失" });
  }

  // ② README 清单 vs 磁盘（双向）
  const readmePath = path.join(dir, "README.md");
  if (existsSync(readmePath)) {
    const listed = readmeManifest(readFileSync(readmePath, "utf8"));
    if (listed === null) problems.push({ kind: "readme-no-manifest", target: "README.md", why: "README 缺「## 目录」段" });
    else {
      const actual = files.filter((f) => f !== "README.md").sort();
      for (const f of actual) if (!listed.includes(f)) problems.push({ kind: "readme-missing-entry", target: f, why: "磁盘有、README 目录没列" });
      for (const f of listed) if (!actual.includes(f)) problems.push({ kind: "readme-stale-entry", target: f, why: "README 列了、磁盘没有" });
    }
  }

  // ③ 私货扫描
  for (const rel of files) {
    const text = readFileSync(path.join(dir, rel), "utf8");
    for (const { re, why } of PRIVATE_MARKERS) {
      const hit = re.exec(text);
      if (hit) problems.push({ kind: "private-content", target: rel, why: `${why}：${hit[0].slice(0, 40)}` });
    }
  }
  return { ok: problems.length === 0, dir, files, problems };
}

function main() {
  const dir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, "spec", "docs");
  const r = checkDocs(dir);
  console.log(`随包人读文档守卫 · ${r.dir}`);
  console.log(`  文件 ${r.files.length} 份：${r.files.join(" · ")}`);
  if (r.ok) console.log("  ✓ 全过（必备在位 · README 与磁盘一致 · 无私货）");
  else {
    console.log(`  ✗ ${r.problems.length} 个问题：`);
    for (const p of r.problems) console.log(`    · [${p.kind}] ${p.target ?? "-"} —— ${p.why}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
