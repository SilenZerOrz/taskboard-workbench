#!/usr/bin/env node
/**
 * tools/dsh-profile-relink.mjs
 *
 * 用途：修复 dsh profile 的 node_modules 顶层符号链接被「插件管理器裁掉」导致
 *      启动时 `skipping profile bundle "<pkg>"`（插件市场/外装插件不加载）的问题。
 *
 * 做法：不装包、不动 lockfile、不联网 —— 只依据 profile 自己的
 *      `node_modules/.package-map.json`（pnpm 的「依赖路径 → 解析后包 id」映射）
 *      在 `node_modules/.pnpm/` 里定位到**版本与 peer 解析都吻合**的那一份，
 *      然后把顶层链接按 pnpm 的既有形状补回来。
 *
 * 默认 dry-run（只打印，不写盘）。真正落盘需显式 `--apply`。
 * 不会删除任何文件；歧义（多候选且无法判定）时拒绝动手并如实报出。
 *
 * 用法：
 *   node tools/dsh-profile-relink.mjs                 # dry-run
 *   node tools/dsh-profile-relink.mjs --apply         # 落盘
 *   node tools/dsh-profile-relink.mjs --profile web --apply
 *
 * 隔离验证台：设 DSH_HOME=<临时目录> 即可对临时 profile 施加同一动作（不碰真实 profile）。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function parseArgs(argv) {
  const out = { apply: false, profile: "web", only: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--only") out.only = String(argv[++i] || "").split(",").filter(Boolean);
    else if (a === "-h" || a === "--help") out.help = true;
  }
  return out;
}

/** `name@version(peer...)(peer...)` → { name, version, peers:[{name,version,hash?}] } */
function parsePackageId(id) {
  const nameEnd = id.indexOf("@", 1);
  const name = id.slice(0, nameEnd);
  const rest = id.slice(nameEnd + 1);
  const paren = rest.indexOf("(");
  const version = paren === -1 ? rest : rest.slice(0, paren);
  const tail = paren === -1 ? "" : rest.slice(paren);
  // pnpm 的「单哈希」形态：name@ver(<32hex>) —— 该哈希就是 .pnpm 目录名的后缀，可直接定位实例。
  const bare = /^\(([0-9a-f]{32})\)$/.exec(tail);
  if (bare) return { name, version, peers: [], instanceHash: bare[1] };
  const peers = [];
  let s = tail;
  let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") { depth++; if (depth === 1) { cur = ""; continue; } }
    if (ch === ")") { depth--; if (depth === 0) { peers.push(parsePeer(cur)); continue; } }
    if (depth >= 1) cur += ch;
  }
  return { name, version, peers: peers.filter(Boolean), instanceHash: null };
}

function parsePeer(txt) {
  const m = /^(.*)\(([0-9a-f]{32})\)$/.exec(txt);
  if (m) {
    const inner = parsePeer(m[1]);
    return inner ? { ...inner, hash: m[2] } : null;
  }
  const nameEnd = txt.indexOf("@", 1);
  if (nameEnd === -1) return null;
  return { name: txt.slice(0, nameEnd), version: txt.slice(nameEnd + 1) };
}

const esc = (pkgName) => pkgName.replace(/\//g, "+");
const escFile = (v) => v.replace(/\//g, "+").replace(/:/g, "+").replace(/^file\+/, "file+");

function candidatesFor(virtualDir, pkgName, version) {
  const prefix = version.startsWith("file:")
    ? `${esc(pkgName)}@${escFile(version)}_`
    : `${esc(pkgName)}@${version}_`;
  let entries = [];
  try { entries = fs.readdirSync(virtualDir); } catch { return []; }
  return entries.filter((e) => e.startsWith(prefix)).filter((e) => {
    const inner = path.join(virtualDir, e, "node_modules", pkgName);
    return fs.existsSync(inner);
  });
}

/** 用 peer 约束给候选打分：peer 链接存在且（若给出 hash）目标目录名含该 hash 才算 +1 */
function scoreCandidate(virtualDir, dir, pkgName, peers) {
  let score = 0;
  const missing = [];
  for (const p of peers) {
    const link = path.join(virtualDir, dir, "node_modules", p.name);
    if (!fs.existsSync(link)) { missing.push(p.name); continue; }
    let target = "";
    try { target = fs.realpathSync(link); } catch { target = link; }
    if (p.hash && !target.includes(p.hash)) { missing.push(`${p.name}(hash≠${p.hash.slice(0, 8)})`); continue; }
    score++;
  }
  return { score, missing };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log("usage: node tools/dsh-profile-relink.mjs [--profile web] [--apply] [--only a,b]"); return; }
  // 与 dsh 自身一致：优先 $DSH_HOME（隔离验证台用），否则 ~/.dsh
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
  const profileDir = path.join(dshHome, "profiles", args.profile);
  const nm = path.join(profileDir, "node_modules");
  const virtualDir = path.join(nm, ".pnpm");
  if (!fs.existsSync(path.join(profileDir, "package.json"))) { console.error(`profile 不存在: ${profileDir}`); process.exitCode = 2; return; }
  if (!fs.existsSync(virtualDir)) { console.error(`缺失 .pnpm 虚拟store: ${virtualDir}`); process.exitCode = 2; return; }
  const mapPath = path.join(nm, ".package-map.json");
  if (!fs.existsSync(mapPath)) { console.error(`缺失 .package-map.json（无法无歧义定位，拒绝动手）: ${mapPath}`); process.exitCode = 2; return; }

  const profilePkg = JSON.parse(fs.readFileSync(path.join(profileDir, "package.json"), "utf8"));
  const deps = Object.keys(profilePkg.dependencies || {});
  const map = JSON.parse(fs.readFileSync(mapPath, "utf8"));
  const mapDeps = (map.packages && map.packages["."] && map.packages["."].dependencies) || {};

  console.log(`profile      : ${profileDir}`);
  console.log(`mode         : ${args.apply ? "APPLY（会写盘）" : "DRY-RUN（只打印）"}`);
  console.log(`声明依赖     : ${deps.length} 个\n`);

  const plan = [], problems = [], ok = [];
  for (const name of deps) {
    if (args.only && !args.only.includes(name)) continue;
    const top = path.join(nm, name);
    if (fs.existsSync(top)) { ok.push(name); continue; }
    const id = mapDeps[name];
    if (!id) { problems.push([name, "在 .package-map.json 中无解析记录（需 dsh plugin install）"]); continue; }
    const { version, peers, instanceHash } = parsePackageId(id);
    let cands = candidatesFor(virtualDir, name, version);
    if (instanceHash && cands.length > 1) {
      const exact = cands.filter((d) => d.endsWith(`_${instanceHash}`));
      if (exact.length === 1) cands = exact;
    }
    if (!cands.length) { problems.push([name, `在 .pnpm 中找不到 ${name}@${version} 的实例（需 dsh plugin install）`]); continue; }
    let pick = null, why = "";
    if (cands.length === 1) { pick = cands[0]; why = "唯一候选"; }
    else {
      const scored = cands.map((d) => ({ d, ...scoreCandidate(virtualDir, d, name, peers) })).sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best.score > 0 && (scored.length === 1 || best.score > scored[1].score)) { pick = best.d; why = `peer 命中 ${best.score}/${peers.length}`; }
      else { problems.push([name, `候选 ${cands.length} 个且无法判定（best ${best.score}/${peers.length}）: ${cands.join(" | ")}`]); continue; }
    }
    // pnpm 的链接形状：目标相对**链接自身所在目录**书写 —— 无作用域包是 `.pnpm/…`，
    // 作用域包（@scope/pkg）则多退一层变成 `../.pnpm/…`。写错会得到悬空链接（真机实测过）。
    const linkDir = path.dirname(top);
    const destAbs = path.join(virtualDir, pick, "node_modules", name);
    const relTarget = path.relative(linkDir, destAbs);
    plan.push({ name, id, target: relTarget, why, pick });
  }

  console.log(`已存在顶层链接 : ${ok.length} 个（跳过）`);
  if (plan.length) {
    console.log(`\n待补链接 ${plan.length} 个：`);
    for (const p of plan) console.log(`  + ${p.name.padEnd(38)} → ${p.target}   [${p.why}]`);
  }
  if (problems.length) {
    console.log(`\n无法自动处理 ${problems.length} 个：`);
    for (const [n, r] of problems) console.log(`  ! ${n}: ${r}`);
  }
  if (!args.apply) { console.log("\nDRY-RUN 结束：未写盘。确认无误后加 --apply。"); return; }

  let made = 0;
  for (const p of plan) {
    const scopeDir = path.dirname(path.join(nm, p.name));
    if (!fs.existsSync(scopeDir)) fs.mkdirSync(scopeDir, { recursive: true });
    const top = path.join(nm, p.name);
    if (fs.existsSync(top)) continue;
    fs.symlinkSync(p.target, top);
    made++;
    console.log(`  ✓ 已补 ${p.name}`);
  }
  console.log(`\nAPPLY 完成：补了 ${made} 个顶层链接。下一步：重启宿主（bash tools/dsh-mvp-autostart.sh）并复核启动日志无 skipping profile bundle。`);
}

main();
