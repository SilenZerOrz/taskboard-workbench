/**
 * intake.mjs —— 项目资料引入（本地项目文件夹 → 工作台）。
 *
 * 背景：工作台此前只有"手工建条目/任务"，本地项目文件夹里的 md/doc 资料
 * **没有被引入**，导致"需求文档为空、团队/需求像摆设"。本模块把项目文件夹扫一遍，
 * 汇总成"资料索引"写入需求文档，并可按文档生成需求条目（可判定的初始资料引入）。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, basename } from "node:path";

/** 默认可引入的文档后缀（文本类可读，二进制类只登记）。 */
export const DEFAULT_DOC_EXTS = [".md", ".markdown", ".txt", ".rst", ".doc", ".docx", ".pdf"];
const TEXT_EXTS = new Set([".md", ".markdown", ".txt", ".rst"]);
/** 遍历时跳过的重目录（避免把依赖/产物当资料）。 */
const SKIP_DIRS = new Set(["node_modules", ".git", ".data", ".archify", ".cache", "dist", "build", "coverage", ".next", ".turbo"]);

/**
 * 递归扫描项目文件夹中的文档。
 * @returns {{ root:string, files:Array, count:number, truncated:boolean }}
 */
export async function scanProjectMaterials(rootDir, { maxFiles = 500, maxDepth = 8, exts = DEFAULT_DOC_EXTS, include = null, exclude = null } = {}) {
  const allowed = new Set(exts.map((e) => e.toLowerCase()));
  const norm = (s) => String(s).replace(/^\/+/, "").replace(/\/+$/, "");
  const inc = include && include.length ? include.map(norm) : null;
  const exc = (exclude ?? []).map(norm);
  const under = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));
  const files = [];
  let truncated = false;
  async function walk(dir, depth) {
    if (files.length >= maxFiles) { truncated = true; return; }
    if (depth > maxDepth) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (files.length >= maxFiles) { truncated = true; return; }
      if (entry.name.startsWith(".")) continue; // 跳过隐藏文件/目录
      const absPath = join(dir, entry.name);
      const relPath = relative(rootDir, absPath);
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
  }
  await walk(rootDir, 0);
  return { root: rootDir, files, count: files.length, truncated };
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
