#!/usr/bin/env node
/**
 * release-precheck.mjs —— **发布前敏感信息门禁**（零依赖）。
 *
 * 依据：
 *   · `docs/发布与收录/`（本项目发布 SOP，本地维护）
 *   · `项目-dsh-acp/docs/规范/敏感信息审查规范.md`（L1/L2/L3 分级与本级扫描口径）
 *
 * 用法：
 *   node tools/release-precheck.mjs                 # = --scope all
 *   node tools/release-precheck.mjs --scope head    # 只看当前提交树（clone 到的内容）
 *   node tools/release-precheck.mjs --scope history # 看 HEAD 可达的全部历史
 *   node tools/release-precheck.mjs --scope pack    # 只看 npm tarball 内容边界
 *   node tools/release-precheck.mjs --json
 *
 * 退出码：0 = 通过；1 = 命中（**阻断发布**）；2 = 环境不满足（不在 git 仓库 / 无 npm）。
 *
 * 约定：`扫描失败 = 阻断发布`。本脚本绝不修改任何文件。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

/** L1 高危：凭据 / 密钥 / 私有 token —— 永不出现。 */
export const L1 = [
  { id: "openai-key", re: /sk-[A-Za-z0-9]{20,}/ },
  { id: "npm-token", re: /npm_[A-Za-z0-9]{20,}/ },
  { id: "gh-pat", re: /ghp_[A-Za-z0-9]{30,}/ },
  { id: "gh-pat-fine", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { id: "aws-akid", re: /AKIA[0-9A-Z]{16}/ },
  { id: "bearer", re: /Bearer [A-Za-z0-9._-]{20,}/ },
  { id: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // 掩码形态（8+4 / 6+4）同样泄露前缀长度与后缀，一并拦
  { id: "masked-token", re: /(npm_|sk-|ghp_)[A-Za-z0-9]{6,}\.{3}[A-Za-z0-9]{4}/ },
];

/** L2 中危：内部资产标识 —— 永不进 git / npm。 */
export const L2 = [
  { id: "mac-home", re: /\/Users\/[A-Za-z0-9_-]+/ },
  { id: "linux-home", re: /\/home\/[A-Za-z0-9_-]+/ },
  { id: "ip-10", re: /(^|[^0-9.])10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)/ },
  { id: "ip-192-168", re: /192\.168\.[0-9]{1,3}\.[0-9]{1,3}/ },
  { id: "internal-domain", re: /shenkeinfo\.(net|com)/i },
];

/** L3 白名单：公开默认标识，命中不算问题。 */
export const L3_WHITELIST = ["jl-token"];

/** 必被 .gitignore 覆盖的本地目录 / 文件（发布边界）。 */
export const MUST_BE_IGNORED = ["docs/", ".archify/", ".data/", "AGENTS.md"];

/** 对一段文本做分级扫描（纯函数，便于测试）。 */
export function scanText(text, { level = "all" } = {}) {
  const hits = [];
  const rules = [
    ...(level === "L2" ? [] : L1.map((r) => ({ ...r, level: "L1" }))),
    ...(level === "L1" ? [] : L2.map((r) => ({ ...r, level: "L2" }))),
  ];
  const lines = String(text ?? "").split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (L3_WHITELIST.some((w) => line.includes(w))) continue;
    for (const rule of rules) {
      if (rule.re.test(line)) hits.push({ level: rule.level, rule: rule.id, line: i + 1, text: line.trim().slice(0, 160) });
    }
  }
  return hits;
}

/**
 * N8 发布完整性：`CHANGELOG.md` 的**第一个**版本标题。
 *
 * 只认 `## [x]` 二级标题（`### 修复` 这类小节不算），返回 `{ raw, version }`；找不到返回 `null`。
 * 纯函数：不读盘、不看 git，便于单测。
 */
export function parseChangelogHead(text) {
  for (const line of String(text ?? "").split("\n")) {
    const m = /^##\s+\[([^\]]+)\]/.exec(line);
    if (m) return { raw: line.trim(), version: m[1].trim() };
  }
  return null;
}

/**
 * N8 发布完整性：**CHANGELOG 头部版本必须 == `package.json` version，且不得停在 `[Unreleased]`**。
 *
 * 为什么需要它（0.2.1 实测教训）：tag 当时打在 `7162ab3`，CHANGELOG 定稿在其后的 `bf4139f` ⇒
 * 「已发布内容与声明不一致」；当时没有任何机器守卫能在 tag / publish 前拦住，只能靠人记得先定稿。
 *
 * 返回阻断项数组（空数组 = 通过）。纯函数，便于测试。
 */
export function changelogProblems(text, pkgVersion) {
  const head = parseChangelogHead(text);
  if (!head) return ["CHANGELOG 未找到版本标题（期望形如 `## [0.2.3] - 2026-10-30`）"];
  if (/^unreleased$/i.test(head.version)) {
    return [`CHANGELOG 头部仍是 [Unreleased]：发布前必须定稿为 \`## [${pkgVersion}] - <日期>\`（N8）`];
  }
  if (head.version !== String(pkgVersion)) {
    return [`CHANGELOG 头部版本 ${head.version} ≠ package.json ${String(pkgVersion)}（版本漂移，N8）`];
  }
  return [];
}

function run(cmd, args, opts = {}) {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }) };
  } catch (e) {
    return { ok: false, status: e.status, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** `git grep` 命中（退出码 1 = 无命中，不是错误）。 */
function gitGrep(pattern, ref) {
  const r = run("git", ["grep", "-InE", "--no-color", pattern, ref, "--", "."]);
  if (r.ok) return r.out.split("\n").filter(Boolean);
  if (r.status === 1) return [];
  return [`ERROR: git grep ${ref} 执行失败：${r.out.trim()}`];
}

function combined(rules) {
  return rules.map((r) => r.re.source).join("|");
}

function ruleIdsFor(line, rules) {
  return rules.filter((r) => r.re.test(line)).map((r) => r.id);
}

function scanRef(ref, label, problems) {
  const found = [];
  for (const [level, rules] of [["L1", L1], ["L2", L2]]) {
    for (const line of gitGrep(combined(rules), ref)) {
      if (line.startsWith("ERROR:")) { problems.push(line); continue; }
      if (L3_WHITELIST.some((w) => line.includes(w))) continue;
      const [, file, lineNo, ...rest] = line.split(":");
      found.push({ level, ref: label, file, line: Number(lineNo), rules: ruleIdsFor(rest.join(":"), rules) });
    }
  }
  return found;
}

function historyRefs(head) {
  const r = run("git", ["rev-list", head]);
  if (!r.ok) return [];
  return r.out.split("\n").filter(Boolean);
}

function packCheck(problems) {
  const cache = path.join(os.tmpdir(), "tb-npm-cache-precheck");
  const r = run("npm", ["pack", "--dry-run", "--json", "--cache", cache]);
  if (!r.ok) { problems.push(`npm pack --dry-run 执行失败：${r.out.trim().slice(0, 300)}`); return null; }
  let parsed;
  try { parsed = JSON.parse(r.out); } catch { problems.push("npm pack --dry-run 输出无法解析为 JSON"); return null; }
  const files = (parsed[0]?.files ?? []).map((f) => f.path);
  const bad = files.filter((p) => /^(docs|test|tests|\.git|node_modules)\//.test(p));
  const missing = ["LICENSE", "README.md", "package.json"].filter((f) => !files.includes(f));
  return { total: files.length, bad, missing, files };
}

function main(argv) {
  const json = argv.includes("--json");
  const scopeArg = argv.find((a) => a.startsWith("--scope="))?.slice(8) ?? (argv.includes("--scope") ? argv[argv.indexOf("--scope") + 1] : "all");
  const scope = scopeArg ?? "all";
  if (!["all", "head", "history", "pack", "ignore"].includes(scope)) {
    console.error(`未知 --scope：${scope}（可选 all|head|history|pack|ignore）`);
    return 2;
  }
  const inGit = run("git", ["rev-parse", "--is-inside-work-tree"]).ok;
  if (!inGit && scope !== "pack") {
    console.error("✗ 当前目录不是 git 仓库，无法扫描 tracked tree / history。");
    return 2;
  }
  const problems = [];
  const findings = [];
  let pack = null;

  if (scope === "all" || scope === "head") findings.push(...scanRef("HEAD", "HEAD", problems));

  if (scope === "all" || scope === "history") {
    for (const sha of historyRefs("HEAD")) {
      for (const hit of scanRef(sha, sha.slice(0, 7), problems)) {
        if (hit.ref !== "HEAD") findings.push({ ...hit, ref: `history:${hit.ref}` });
      }
    }
  }

  if (scope === "all" || scope === "pack") pack = packCheck(problems);

  if (scope === "all" || scope === "ignore") {
    for (const p of MUST_BE_IGNORED) {
      const r = run("git", ["check-ignore", "-q", p]);
      if (!r.ok) problems.push(`发布边界失守：${p} 未被 .gitignore 覆盖`);
    }
  }

  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const pkgProblems = [];
  // N8（卡 `-181` / 需求 `R136`）：发布完整性 —— CHANGELOG 头版本必须等于 package.json 且非 [Unreleased]。
  let changelogHead = null;
  try {
    const changelogText = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    changelogHead = parseChangelogHead(changelogText);
    pkgProblems.push(...changelogProblems(changelogText, pkg.version));
  } catch (e) {
    pkgProblems.push(`CHANGELOG.md 读取失败：${e?.message ?? String(e)}`);
  }
  if (pkg.files?.includes?.("docs")) pkgProblems.push("package.json#files 含整个 docs 目录");
  if (!pkg.files?.includes?.("spec/团队agent.md")) pkgProblems.push("package.json#files 缺随包契约 spec/团队agent.md（FR-22）");

  const fatal = findings.length > 0 || problems.length > 0 || pkgProblems.length > 0 ||
    (pack ? pack.bad.length > 0 || pack.missing.length > 0 : false);

  if (json) {
    console.log(JSON.stringify({
      ok: !fatal,
      scope,
      findings,
      problems: [...problems, ...pkgProblems],
      pack: pack ? { total: pack.total, bad: pack.bad, missing: pack.missing } : null,
      release: { changelogHead: changelogHead?.version ?? null, pkgVersion: pkg.version },
    }, null, 2));
    return fatal ? 1 : 0;
  }

  console.log(`release-precheck · scope=${scope} · ${new Date().toISOString()}`);
  if (findings.length === 0) console.log("  ✓ tracked tree / history：L1 凭据 0、L2 内部资产 0");
  for (const f of findings) console.log(`  ✗ [${f.level}] ${f.file}:${f.line} (${f.rules.join(",")}) @ ${f.ref}`);
  if (pack) {
    console.log(`  ${pack.bad.length === 0 ? "✓" : "✗"} npm tarball：${pack.total} 文件${pack.bad.length ? `，越界 ${pack.bad.join(", ")}` : "，无 docs/tests/.git"}`);
    if (pack.missing.length) console.log(`  ✗ npm tarball 缺必需文件：${pack.missing.join(", ")}`);
  }
  const releaseGate = pkgProblems.filter((p) => /CHANGELOG|unreleased/i.test(p));
  if (releaseGate.length === 0) console.log(`  ✓ 发布完整性（N8）：CHANGELOG 头 ${changelogHead?.version ?? "?"} = package.json ${pkg.version}`);
  for (const p of [...problems, ...pkgProblems]) console.log(`  ✗ ${p}`);
  console.log(fatal ? "结论：✗ 阻断发布（请处理后重跑）" : "结论：✓ 通过（可继续发布流程）");
  return fatal ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
