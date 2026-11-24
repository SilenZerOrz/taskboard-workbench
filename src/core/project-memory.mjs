/**
 * 项目记忆（FR-116 / 卡 `-298` · 设计稿 `-288`）
 *
 * 口径（C-1 / C-2 / C-3 / C-12）：
 * - 位置：`<项目工作区>/.taskboard/memory/`（与 `.taskboard/norms/`、`.taskboard/docs/` 同族）
 * - 六份文件钉死：`README.md`（索引）+ `decisions` / `facts` / `pitfalls` / `glossary` / `handoff`
 * - 每份带 frontmatter：`title` / `scope` / `updated` / `digest` / `provenance` / `norm_version`
 * - **digest 由工具算，不许人手写**：归一化后 `sha256(正文)`（去 BOM → LF → 逐行去行尾空白 → 末尾恰一个换行）
 * - **不覆盖已有正文**：初始化只补缺文件（`wx`），索引可重写（它是派生品）
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MEMORY_SUBDIR = path.join(".taskboard", "memory");
export const MEMORY_FORMAT_VERSION = 1;
export const MEMORY_PROVENANCES = ["human", "agent", "mixed"];

/** 六份文件（顺序即索引顺序）。 */
export const MEMORY_FILES = [
  { name: "README.md", title: "项目记忆 · 索引", prefix: null, summary: "索引：一行一条（键 / 标题 / 条目数 / digest 短码 / 确认人 / 确认时间）" },
  { name: "decisions.md", title: "已拍板决策", prefix: "decision:", summary: "已拍板决策（含被推翻的旧决策与理由）" },
  { name: "facts.md", title: "事实快照", prefix: "fact:", summary: "会漂移的事实快照（版本 / pid / 兼容区间 / 端口）" },
  { name: "pitfalls.md", title: "踩坑与规避", prefix: "pitfall:", summary: "踩坑与规避（必须带证据引用）" },
  { name: "glossary.md", title: "术语与缩写", prefix: "term:", summary: "术语与缩写（本仓专用说法）" },
  { name: "handoff.md", title: "进行中上下文", prefix: "handoff:", summary: "进行中上下文（给下一会话 / 下一终端）" },
];

export const MEMORY_FILE_NAMES = MEMORY_FILES.map((f) => f.name);
const INDEX_FILE = "README.md";

/** `<workspace>/.taskboard/memory`；工作区为空返回 null（**绝不落到进程 cwd**）。 */
export function memoryDirOf(workspacePath) {
  const ws = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!ws) return null;
  return path.join(ws, MEMORY_SUBDIR);
}

/** 归一化（C-12）：去 BOM → LF → 逐行去行尾空白 → 末尾恰好一个换行。 */
export function normalizeMemoryBody(text) {
  const raw = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = raw.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  const joined = lines.join("\n").replace(/\n+$/, "");
  return `${joined}\n`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** 文件 digest = sha256(归一化(正文))。 */
export function memoryDigest(body) {
  return sha256Hex(normalizeMemoryBody(body));
}

/** 极简 frontmatter 解析（只认本模块写出的那六个字段；坏文件返回 error，**不抛**）。 */
export function parseMemoryFile(text, file = "<memory>") {
  const raw = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!raw.startsWith("---\n")) return { ok: false, error: "NO_FRONTMATTER", file };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) return { ok: false, error: "FRONTMATTER_UNCLOSED", file };
  const head = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta = {};
  for (const line of head.split("\n")) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  if (!meta.title) return { ok: false, error: "MISSING_TITLE", file };
  if (meta.scope !== "project") return { ok: false, error: "BAD_SCOPE", file };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.updated ?? ""))) return { ok: false, error: "BAD_UPDATED", file };
  if (!MEMORY_PROVENANCES.includes(String(meta.provenance ?? ""))) return { ok: false, error: "BAD_PROVENANCE", file };
  if (!/^[0-9a-f]{64}$/.test(String(meta.digest ?? ""))) return { ok: false, error: "BAD_DIGEST", file };
  if (!Number.isInteger(Number(meta.norm_version)) || Number(meta.norm_version) < 1) return { ok: false, error: "BAD_NORM_VERSION", file };
  return { ok: true, meta, body, digest: memoryDigest(body) };
}

/** 条目数：正文里的 H2（模板说明用引用块，不占 H2）。 */
export function countEntries(body) {
  return (String(body ?? "").match(/^## /gm) ?? []).length;
}

function renderFrontmatter({ title, updated, digest, provenance }) {
  return [
    "---",
    `title: ${title}`,
    "scope: project",
    `updated: ${updated}`,
    `digest: ${digest}`,
    `provenance: ${provenance}`,
    `norm_version: ${MEMORY_FORMAT_VERSION}`,
    "---",
    "",
  ].join("\n");
}

function renderFileBody(spec) {
  const guide = spec.prefix
    ? `> 每条一个 H2：\`## ${spec.prefix}<key> · <标题>\`。正文必须能被证据复算；**agent 只能提 proposed，人确认后才转 accepted**。\n`
    : "> 本文件由工具生成（`node tools/memory-init.mjs --refresh-index`）：只重写索引，不动其他文件正文。\n";
  return `# ${spec.title}\n\n${guide}\n`;
}

/** 生成一份记忆文件的全文（frontmatter digest 按正文现算）。 */
export function renderMemoryFile(spec, { updated, provenance = "human" } = {}) {
  const body = renderFileBody(spec);
  const digest = memoryDigest(body);
  return `${renderFrontmatter({ title: spec.title, updated, digest, provenance })}${normalizeMemoryBody(body)}`;
}

function todayLocal(date) {
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  const d = date instanceof Date ? date : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 初始化记忆目录：**只补缺文件**，已有文件一字不动（`wx` 打开，存在即跳过）。
 * @returns {{dir:string, created:string[], existing:string[]}}
 */
export function ensureProjectMemory({ workspacePath, date, provenance = "human" } = {}) {
  const dir = memoryDirOf(workspacePath);
  if (!dir) return { dir: null, created: [], existing: [], error: "WORKSPACE_MISSING" };
  mkdirSync(dir, { recursive: true });
  const updated = todayLocal(date);
  const created = [];
  const existing = [];
  for (const spec of MEMORY_FILES) {
    const target = path.join(dir, spec.name);
    if (existsSync(target)) { existing.push(spec.name); continue; }
    writeFileSync(target, renderMemoryFile(spec, { updated, provenance }), { encoding: "utf8", flag: "wx" });
    created.push(spec.name);
  }
  return { dir, created, existing };
}

/**
 * 扫盘：以**磁盘为真源**。坏文件跳过并记一条 error（不抛），多出/缺失的 .md 也算漂移。
 */
export function scanProjectMemory({ workspacePath } = {}) {
  const dir = memoryDirOf(workspacePath);
  if (!dir || !existsSync(dir)) return { dir, exists: false, files: [], errors: [], extra: [] };
  const files = [];
  const errors = [];
  for (const spec of MEMORY_FILES) {
    const target = path.join(dir, spec.name);
    if (!existsSync(target)) { errors.push({ file: spec.name, error: "MISSING" }); continue; }
    const parsed = parseMemoryFile(readFileSync(target, "utf8"), spec.name);
    if (!parsed.ok) { errors.push({ file: spec.name, error: parsed.error }); continue; }
    files.push({
      name: spec.name,
      title: parsed.meta.title,
      updated: parsed.meta.updated,
      provenance: parsed.meta.provenance,
      digest: parsed.digest,
      digestShort: parsed.digest.slice(0, 8),
      digestStored: parsed.meta.digest,
      digestMatches: parsed.meta.digest === parsed.digest,
      entries: countEntries(parsed.body),
    });
  }
  const onDisk = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const extra = onDisk.filter((f) => !MEMORY_FILE_NAMES.includes(f));
  return { dir, exists: true, files, errors, extra };
}

/** 索引正文（不含 frontmatter）。 */
export function renderIndexBody(scan) {
  const rows = scan.files
    .filter((f) => f.name !== INDEX_FILE)
    .map((f) => `| \`${f.name}\` | ${MEMORY_FILES.find((s) => s.name === f.name)?.summary ?? ""} | ${f.entries} | \`${f.digestShort}\` | ${f.provenance} | ${f.updated} |`);
  return [
    "# 项目记忆 · 索引",
    "",
    "| 文件 | 一句话 | 条目 | digest（前 8 位） | 最后确认 | 确认时间 |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "读取顺序：先本表 → 再 `handoff.md` → 再按需读 `decisions` / `pitfalls` / `facts` / `glossary`。",
    "写入规则：agent 只能提 `proposed`；人确认后才转 `accepted`；已 `accepted` 的条目不得覆盖。",
  ].join("\n");
}

/** 重新生成索引：**只写 README**；内容没变就不落盘（二次运行 changed=false）。 */
export function refreshMemoryIndex({ workspacePath, date } = {}) {
  const scan = scanProjectMemory({ workspacePath });
  if (!scan.exists) return { changed: false, reason: "MEMORY_DIR_MISSING", scan };
  const body = normalizeMemoryBody(renderIndexBody(scan));
  const digest = memoryDigest(body);
  const updated = todayLocal(date);
  const text = `${renderFrontmatter({ title: "项目记忆 · 索引", updated, digest, provenance: "mixed" })}${body}`;
  const target = path.join(scan.dir, INDEX_FILE);
  const before = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (before === text) return { changed: false, digest, scan };
  writeFileSync(target, text, "utf8");
  return { changed: true, digest, scan };
}
