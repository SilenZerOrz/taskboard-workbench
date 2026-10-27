// verify.mjs —— 证明「宿主核心包只剩一份物理副本」＝「模块实例唯一」＝「Symbol 唯一」。
//
// 必须在**不带 NODE_OPTIONS**（即没挂 tools/ 下那两个运行时 shim）的环境下跑：
//   带 shim 时归一由 shim 完成，测的是 shim 而不是盘上形态；
//   不带 shim 时若仍「实例唯一」，说明 node_modules 本身已经只有一份 —— 这就是根因级修复的判据。
//
// 判据三层：
//   ① 物理层：.pnpm 下的「真实副本目录」必须只剩符号链接（无独立物理目录）；
//   ② realpath 层：所有副本解析到的真实路径都必须等于宿主那份；
//   ③ 实例层（强判据）：分别 import 宿主那份与每一份副本，比较 dsh-tools 导出的
//      TOOL_RUNTIME_SCHEDULER 是否**同一个** Symbol。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PROFILE_DIR = process.env.TB_PROFILE_DIR || path.join(os.homedir(), ".dsh/profiles/web");
const CANON_ROOT =
  process.env.TB_CANON_ROOT ||
  path.join(os.homedir(), ".npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai");
const PKGS = ["dsh-tools", "dsh-agent-loop", "dsh-scope"];
const ENTRY = "lib/index.js";

const NM = path.join(PROFILE_DIR, "node_modules");
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };

// 只枚举 .pnpm 下的「真实副本目录」（peer 符号链接不算，它们只是指向上面的真实副本）
function copiesOf(pkg) {
  const pnpm = path.join(NM, ".pnpm");
  let entries = [];
  try { entries = fs.readdirSync(pnpm, { withFileTypes: true }); } catch { return []; }
  const prefix = `@deepseek-ai+${pkg}@`;
  const out = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix)) continue;
    const inner = path.join(pnpm, e.name, "node_modules/@deepseek-ai", pkg);
    let st = null;
    try { st = fs.lstatSync(inner); } catch { continue; }
    if (st.isSymbolicLink()) { out.push({ dir: inner, isLink: true }); continue; }
    if (st.isDirectory()) out.push({ dir: inner, isLink: false });
  }
  return out;
}

let failures = 0;
let realDirs = 0;
let links = 0;

for (const pkg of PKGS) {
  const canonDir = path.join(CANON_ROOT, pkg);
  const canonReal = real(path.join(canonDir, ENTRY));
  console.log(`### ${pkg}`);
  console.log(`    宿主唯一副本：${canonDir}`);
  if (!canonReal) { console.log("    ✗ 宿主副本不存在"); failures++; continue; }

  const copies = copiesOf(pkg);
  if (copies.length === 0) console.log("    · .pnpm 下无该包条目");

  for (const { dir, isLink } of copies) {
    if (!isLink) { realDirs++; } else { links++; }
    const entry = path.join(dir, ENTRY);
    const copyReal = real(entry);
    const same = copyReal === canonReal;
    console.log(`    · ${(isLink ? "symlink" : "REAL DIR").padEnd(9)} ${dir.replace(NM + "/", "")}`);
    if (!isLink) console.log(`        真实路径 = ${same ? "宿主那份 ✓" : copyReal + "  ✗ 独立物理副本"}`);
    if (!same) failures++;
  }

  if (pkg === "dsh-tools") {
    const canonMod = await import(path.join(canonDir, ENTRY));
    for (const { dir } of copies) {
      const mod = await import(path.join(dir, ENTRY));
      const identical = mod.TOOL_RUNTIME_SCHEDULER === canonMod.TOOL_RUNTIME_SCHEDULER;
      console.log(`    · Symbol 同一性：${identical ? "SAME INSTANCE ✓" : "DIFFERENT INSTANCE ✗"}`);
      if (!identical) failures++;
    }
  }
}

console.log("");
console.log(`真实副本目录：${realDirs} 个   指向宿主的条目：${links} 个   失败项：${failures}`);
console.log(
  failures === 0 && realDirs === 0
    ? "✓ PASS —— .pnpm 下已无独立物理副本，全部解析到宿主那一份；不需要运行时 shim 也不会出现 reading 'prepare'"
    : "✗ FAIL —— 仍有多物理副本（会造出第二个 Symbol）。跑： bash tools/dsh-core-pkg-dedupe/apply.sh --apply",
);
process.exit(failures === 0 && realDirs === 0 ? 0 : 1);
