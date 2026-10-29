/**
 * intake.mjs —— 项目资料引入（本地项目文件夹 → 工作台）。
 *
 * 背景：工作台此前只有"手工建条目/任务"，本地项目文件夹里的 md/doc 资料
 * **没有被引入**，导致"需求文档为空、团队/需求像摆设"。本模块把项目文件夹扫一遍，
 * 汇总成"资料索引"写入需求文档，并可按文档生成需求条目（可判定的初始资料引入）。
 */
import { readdir, readFile, stat, realpath, readlink } from "node:fs/promises";
import { join, relative, extname, basename, sep } from "node:path";

/** 默认可引入的文档后缀（文本类可读，二进制类只登记）。 */
export const DEFAULT_DOC_EXTS = [".md", ".markdown", ".txt", ".rst", ".doc", ".docx", ".pdf"];
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".rst"]);
/** 遍历时跳过的重目录（避免把依赖/产物当资料）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".data", ".archify", ".cache", "dist", "build", "coverage", ".next", ".turbo"]);

/**
 * 递归扫描项目文件夹中的文档。
 *
 * **符号链接（2026-10-29 · 卡 `-175`）**：此前的判据是 `entry.isFile()` / `entry.isDirectory()`，
 * 而 `Dirent.isFile()` 对**符号链接恒为 false** ⇒ 软链文档被**静默跳过**（无告警、无计数）。
 * 本仓 `docs/团队agent.md → ../spec/团队agent.md` 因此一直没进索引（`docsTotal` 少 1）。
 * 现在按软链处理：`stat` 跟随判类型 → 环路保护（`realpath` 去重）→ 越界判定（`realpath` 必须仍在 root 内），
 * 跳过的每一条都进 `symlinks.skipped`（带 reason），**不再静默**。
 *
 * @returns {{ root:string, files:Array, count:number, truncated:boolean,
 *   symlinks:{ followed:number, skipped:Array<{relPath:string,target:string|null,reason:string}> } }}
 */
export async function scanProjectMaterials(rootDir, { maxFiles = 500, maxDepth = 8, exts = DEFAULT_DOC_EXTS, include = null, exclude = null } = {}) {
  const allowed = new Set(exts.map((e) => e.toLowerCase()));
  const norm = (s) => String(s).replace(/^\/+/, "").replace(/\/+$/, "");
  const inc = include && include.length ? include.map(norm) : null;
  const exc = (exclude ?? []).map(norm);
  const under = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
  const files = [];
  let truncated = false;
  const symlinks = { followed: 0, skipped: [] };
  let rootReal = rootDir;
  try { rootReal = await realpath(rootDir); } catch { /* root 不可解析时退回字面路径 */ }
  const insideRoot = (real) => real === rootReal || real.startsWith(rootReal + sep);
  /**
   * 环路保护用**祖先链**，不用全局 seen 集合。
   * 全局去重会让「同一真目录被两条路径引用」时后者凭空消失（example：`alias/ → real/sub`，两个 relPath 只留一个），
   * 那不是防环，那是悄悄丢文件。祖先链只挡「指回自己祖先/自身」，两个别名各走各的。
   */
  const chain = [];
  const skipLink = (relPath, target, reason) => symlinks.skipped.push({ relPath, target, reason });
  async function walk(dir, depth) {
    if (files.length >= maxFiles) { truncated = true; return; }
    if (depth > maxDepth) return;
    let dirReal = dir;
    try { dirReal = await realpath(dir); } catch { /* 保持字面路径 */ }
    if (chain.includes(dirReal)) {
      // 指回祖先（软链最常见的自环形态）：记账后返回，不递归
      if (depth > 0) skipLink(relative(rootDir, dir) || ".", dirReal, "loop");
      return;
    }
    chain.push(dirReal);
    // push/pop 必须由 walk 自己配对（try/finally）。此前由调用方 `chain.pop()`：
    // 一旦被调方在 push 之前早退（maxDepth / maxFiles / 指回祖先），调用方就会把**自家**条目弹掉，
    // 祖先链随之损坏 ⇒ 后面的兄弟软链不再被识别为环，同一批文件被重复收进索引。测试 ⑦ 是这条的反证。
    try {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (files.length >= maxFiles) { truncated = true; return; }
        if (entry.name.startsWith(".")) continue; // 跳过隐藏文件/目录
        const absPath = join(dir, entry.name);
        const relPath = relative(rootDir, absPath);
        if (entry.isSymbolicLink()) {
          let info;
          try { info = await stat(absPath); } catch {
            let target = null;
            try { target = await readlink(absPath); } catch { /* 读不到目标 */ }
            skipLink(relPath, target, "broken");
            continue;
          }
          let real;
          try { real = await realpath(absPath); } catch { skipLink(relPath, null, "unreadable"); continue; }
          if (!insideRoot(real)) { skipLink(relPath, real, "outside-root"); continue; }
          if (info.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) { skipLink(relPath, real, "skip-dir"); continue; }
            if (under(relPath, exc)) { skipLink(relPath, real, "excluded"); continue; }
            symlinks.followed += 1;
            await walk(absPath, depth + 1);
            continue;
          }
          if (!info.isFile()) { skipLink(relPath, real, "not-a-file"); continue; }
          const ext = extname(entry.name).toLowerCase();
          if (!allowed.has(ext)) { skipLink(relPath, real, "ext-not-allowed"); continue; }
          if (inc && !under(relPath, inc)) { skipLink(relPath, real, "not-included"); continue; }
          if (under(relPath, exc)) { skipLink(relPath, real, "excluded"); continue; }
          let bytes = 0;
          try { bytes = (await stat(absPath)).size; } catch { /* ignore */ }
          files.push({ absPath, relPath, ext, name: entry.name, bytes, readable: TEXT_EXTS.has(ext), symlink: true });
          symlinks.followed += 1;
          continue;
        }
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;
          if (under(relPath, exc)) continue;
          await walk(absPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).toLowerCase();
          if (!allowed.has(ext)) continue;
          if (inc && !under(relPath, inc)) continue;
          if (under(relPath, exc)) continue;
          let bytes = 0;
          try { bytes = (await stat(absPath)).size; } catch { /* ignore */ }
          files.push({ absPath, relPath, ext, name: entry.name, bytes, readable: TEXT_EXTS.has(ext) });
        }
      }
    } finally {
      chain.pop();
    }
  }
  await walk(rootDir, 0);
  return { root: rootDir, files, count: files.length, truncated, symlinks };
}

/**
 * 收集"工作区外的显式文件"（按引用纳入，不拷贝）。
 * 用于 survey 这类位于项目根之外、但属 SSOT 的技术细节文档。
 */
export async function collectExternalFiles(paths = []) {
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    try {
      const info = await stat(p);
      if (!info.isFile()) continue;
      const ext = extname(p).toLowerCase();
      out.push({ absPath: p, relPath: `«外部» ${p}`, ext, name: basename(p), bytes: info.size, readable: TEXT_EXTS.has(ext), external: true });
    } catch { /* 路径不存在则跳过 */ }
  }
  return out;
}

/** 从内容或文件名推断标题（优先首个一级标题）。 */
export function titleOf(file, content) {
  if (content) {
    const m = content.match(/^\s*#\s+(.+)$/m);
    if (m) return m[1].trim().slice(0, 120);
  }
  return basename(file.name, file.ext).replace(/[-_]+/g, " ").trim().slice(0, 120) || file.name;
}

/**
 * 生成"资料索引"（写入需求文档）+ 可读文档内容（用于生成条目）。
 * @returns {{ index:string, docs:Array<{relPath,title,content}> }}
 */
export async function buildMaterialIndex(scan, { maxBytesPerFile = 8000, includeContent = true } = {}) {
  const lines = [
    `# 项目资料引入`,
    "",
    `- 目录：\`${scan.root}\``,
    `- 扫描到文档：**${scan.count}** 个${scan.truncated ? "（已按上限截断）" : ""}`,
    `- 引入时间：${new Date().toISOString()}`,
    "",
    "## 资料清单",
    "",
  ];
  for (const f of scan.files) lines.push(`- \`${f.relPath}\` — ${f.bytes} B${f.readable ? "" : "（二进制/需人工）"}`);
  lines.push("");
  const docs = [];
  if (includeContent) {
    lines.push("## 文档内容（文本类）", "");
    for (const f of scan.files) {
      if (!f.readable) continue;
      let content = "";
      try { content = await readFile(f.absPath, "utf8"); } catch { continue; }
      const trimmed = content.length > maxBytesPerFile ? `${content.slice(0, maxBytesPerFile)}\n\n…（已截断，全文见源文件）` : content;
      docs.push({ relPath: f.relPath, title: titleOf(f, content), content });
      lines.push(`### ${f.relPath}`, "", trimmed, "");
    }
  }
  return { index: lines.join("\n"), docs };
}
