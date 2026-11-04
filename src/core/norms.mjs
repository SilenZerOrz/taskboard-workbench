/**
 * 项目级机器规范（卡 `-216` / 需求 `R160`，2026-11-04 人拍）。
 *
 * 为什么需要：`spec/norms/*.md` 是随包分发的**默认**规范，但它躺在 `node_modules` 里 ——
 * 用户要按自己团队的口径改，只能改安装目录（升级即丢），或者改 `docs/`（不入 git、不进包）。
 * 所以给每个项目一份**可改副本**：`<项目工作区>/.taskboard/norms/`。
 *
 * 三条设计口径（对应决策点）：
 *   · **D-A 位置**：`.taskboard/norms/` —— 不与用户自己的 `spec/` 撞名，且一眼看出是工具产物；
 *   · **D-B 时机**：只在**显式动作**（配置页按钮 / API）时复制，**建项目不静默写用户目录**；
 *   · **D-C 改动**：改正文必须 bump `version`，否则 `build-norms --check` / digest 校验红。
 *
 * 读优先级：项目副本存在 → 用它；**缺哪一份就用包内那份**（逐份回落，不是整目录回落，
 * 也不是报错 —— 升级新增规范时，旧副本必然缺新那份，报错等于把用户挡在门外）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadNorms, parseNormDoc } from "./contract.mjs";
import { TbError } from "./errors.mjs";

/** 项目副本相对工作区的位置。 */
export const PROJECT_NORMS_SUBDIR = path.join(".taskboard", "norms");

/** @param {string|null|undefined} workspacePath */
export function projectNormsDir(workspacePath) {
  const ws = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!ws) return null;
  return path.join(ws, PROJECT_NORMS_SUBDIR);
}

function hasMarkdown(dir) {
  try {
    return readdirSync(dir).some((f) => f.endsWith(".md"));
  } catch {
    return false;
  }
}

/**
 * 解析「本项目实际生效的规范」。
 *
 * @param {{packagedDir:string, workspacePath?:string|null}} input
 * @returns {{source:"packaged"|"project", dir:string, projectDir:string|null, hasProjectCopy:boolean,
 *            norms:Array, fallbackIds:string[], ignoredFiles:string[]}}
 */
/**
 * 读项目副本（**逐文件容错**）：README / 用户自己的笔记这类没有 frontmatter 的文件直接跳过；
 * 有 frontmatter 但格式坏的，记进 `ignored` 而不抛 —— 否则一份坏文件会把整个看板挡在门外。
 */
export function readProjectNorms(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const norms = []; const ignored = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    const text = readFileSync(abs, "utf8");
    if (!text.replace(/^\uFEFF/, "").startsWith("---\n")) { ignored.push({ file: f, reason: "no-frontmatter" }); continue; }
    try {
      const parsed = parseNormDoc(text, abs, { allowUnknown: true });
      norms.push({
        id: parsed.meta.norm_id, version: parsed.meta.version, updated: parsed.meta.updated,
        appliesTo: parsed.meta.applies_to, digest: parsed.digest, file: abs,
        relPath: path.join(PROJECT_NORMS_SUBDIR, f), body: parsed.body,
      });
    } catch (error) {
      ignored.push({ file: f, reason: error?.code ?? "invalid", message: error?.message ?? String(error) });
    }
  }
  return { norms, ignored };
}

export function resolveNorms({ packagedDir, workspacePath = null }) {
  const packaged = loadNorms(packagedDir);
  const dir = projectNormsDir(workspacePath);
  if (!dir || !hasMarkdown(dir)) {
    return { source: "packaged", dir: packagedDir, projectDir: dir, hasProjectCopy: false, norms: packaged, fallbackIds: [], ignoredFiles: [] };
  }
  const local = readProjectNorms(dir);
  const byId = new Map(local.norms.map((n) => [n.id, n]));
  const packagedIds = new Set(packaged.map((n) => n.id));
  const fallbackIds = [];
  const norms = packaged.map((p) => {
    const mine = byId.get(p.id);
    if (!mine) { fallbackIds.push(p.id); return p; }
    return mine;
  });
  const unknown = local.norms.filter((n) => !packagedIds.has(n.id)).map((n) => ({ file: path.basename(n.file), reason: "unknown-id" }));
  return { source: "project", dir, projectDir: dir, hasProjectCopy: true, norms, fallbackIds, ignoredFiles: [...local.ignored, ...unknown] };
}

/** 配置页/接口用的只读视图（带「与内置是否不同」）。 */
export function normsView({ packagedDir, workspacePath = null }) {
  const resolved = resolveNorms({ packagedDir, workspacePath });
  const packaged = loadNorms(packagedDir);
  const packagedById = new Map(packaged.map((n) => [n.id, n]));
  return {
    source: resolved.source,
    dir: resolved.dir,
    projectDir: resolved.projectDir,
    packagedDir: packagedDir,
    hasProjectCopy: resolved.hasProjectCopy,
    fallbackIds: resolved.fallbackIds,
    ignoredFiles: resolved.ignoredFiles,
    norms: resolved.norms.map((n) => {
      const base = packagedById.get(n.id);
      return {
        id: n.id,
        version: n.version,
        updated: n.updated,
        digest: n.digest,
        origin: resolved.hasProjectCopy && resolved.fallbackIds.includes(n.id) ? "packaged" : resolved.source,
        modified: Boolean(base) && base.digest !== n.digest,
        file: path.basename(n.file),
      };
    }),
  };
}

const README = `# 本项目的机器规范（可改）

这个目录是**本项目的规范副本**，来源是任务工作台随包分发的默认规范（共 N 份）。
看板读写时**优先读这里**；这里缺哪一份，就回落用安装包里那份（不会报错）。

## 怎么改

1. 直接编辑 \`.md\` 正文（frontmatter 的 \`norm_id\` 不要动）；
2. **改正文必须同时把 \`version\` 加 1**，否则会被判「规范被偷偷改了」；
3. 改完自检：\`node <安装包>/tools/build-norms.mjs --dir .taskboard/norms --check\`
4. 改完要重算契约基线（否则写操作会按「旧契约」被拦）：配置页 →「规范来源」→ 重算 / 或 \`POST /api/projects/<id>/contract/recheck\`。

## 要不要入库

这个目录在**你的项目工作区**里，要不要 \`git add\` 由你定 —— 想让团队共享就入库，只想本机生效就加进 \`.gitignore\`。

## 恢复默认

配置页 →「规范来源」→「恢复默认」（会用安装包里的版本覆盖本目录）。
`;

/**
 * 把包内默认规范复制成项目副本。
 * @param {{packagedDir:string, workspacePath?:string|null, overwrite?:boolean}} input
 */
export function materializeProjectNorms({ packagedDir, workspacePath = null, overwrite = false }) {
  const dir = projectNormsDir(workspacePath);
  if (!dir) throw new TbError("WORKSPACE_MISSING", "项目未配置工作区目录（workspacePath）⇒ 无法生成规范副本；请先在「配置 → 当前绑定」填工作区");
  mkdirSync(dir, { recursive: true });
  const packaged = loadNorms(packagedDir);
  const written = []; const kept = [];
  for (const n of packaged) {
    const target = path.join(dir, path.basename(n.file));
    if (existsSync(target) && !overwrite) { kept.push(n.id); continue; }
    copyFileSync(n.file, target);
    written.push(n.id);
  }
  const manifestSrc = path.join(packagedDir, "manifest.json");
  const manifestDst = path.join(dir, "manifest.json");
  if (existsSync(manifestSrc) && (overwrite || !existsSync(manifestDst))) copyFileSync(manifestSrc, manifestDst);
  const readme = path.join(dir, "README.md");
  if (overwrite || !existsSync(readme)) writeFileSync(readme, README.replace("N 份", `${packaged.length} 份`), "utf8");
  return { dir, written, kept, count: packaged.length };
}

/** 只读：副本里是否有内容（给「恢复默认」按钮判断要不要二次确认）。 */
export function projectNormsPresent(workspacePath) {
  const dir = projectNormsDir(workspacePath);
  return Boolean(dir && hasMarkdown(dir));
}

/** 读一份规范正文（给配置页「预览」用；不做任何写）。 */
export function readNormFile(dir, file) {
  const base = path.basename(String(file ?? ""));
  if (!base.endsWith(".md")) throw new TbError("USAGE_ERROR", "只允许读 .md");
  const target = path.join(dir, base);
  if (!existsSync(target)) throw new TbError("NORM_NOT_FOUND", `规范文件不存在：${base}`);
  return readFileSync(target, "utf8");
}
