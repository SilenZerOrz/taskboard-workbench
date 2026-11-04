/**
 * 随包人读文档（`spec/docs/`）与**项目副本**的位置解析 / 物化 —— 卡 `-220` / 需求 `R161`
 *
 * ## 与 `norms.mjs` 的分工（别合并）
 * - `norms.mjs`：**机器规范**（`spec/norms/`）。它的正文被 digest 进契约 ⇒ 改正文必须 bump
 *   `version`，否则写操作按旧契约被拦。它是**会改变系统行为**的那一份。
 * - 本文件：**人读文档**（`spec/docs/`，开局 / 流程 / 条目 + 模板）。改了**不影响契约、不影响门禁**，
 *   只是「照着做」的说明书。两者放同一张配置卡会让人以为改文档会改行为，所以刻意分开。
 *
 * ## 三处位置（用户要的「可查可看可改」）
 * 1. **包内默认**：随包（`<安装目录>/spec/docs`）—— 只读，升级即被覆盖；
 * 2. **项目存放**：默认 `<工作区>/.taskboard/docs`，**可改**（项目设置 `envConfig.docsDir`）；
 * 3. **生效来源**：项目副本存在时以它为准；否则回落包内（逐文件比对，缺的从包内列出来）。
 *
 * ## 纪律
 * - 物化**只在显式调用时**发生（`materializeProjectDocs`），建项目不静默写用户工作区；
 * - 已存在的文件默认**不覆盖**（`kept`），要覆盖必须显式 `overwrite: true`（「恢复默认」按钮）；
 * - 目录可不存在：视图层如实回 `exists: false`，不替用户创建。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { TbError } from "./errors.mjs";

/** 项目副本相对工作区的默认位置。 */
export const PROJECT_DOCS_SUBDIR = path.join(".taskboard", "docs");

/** 副本目录里用的 README（**新增**于副本，不进包内默认目录，避免包内多一份自述）。 */
const PROJECT_README = `# 本项目的开局与流程文档（可改）

这里是**本项目的副本**，来源是任务工作台随包分发的默认文档（开局 / 流程 / 条目 + 模板）。
看板「文档与规范位置」优先读这里；缺哪份就回落用安装包里那份（不会报错）。

- 改这里的 \`.md\` **不会**改变看板行为（门禁与契约只吃 \`spec/norms/\` 的机器规范）；
- 这些文档是写给人看的：可以直接按自己项目的习惯改，删到只剩需要的几份也行；
- 要不要把本目录 \`git add\` 进仓库由你定：想团队共享就入库，只想本机生效就加进 \`.gitignore\`。
`;

/** @param {string|null|undefined} workspacePath */
export function projectDocsDir(workspacePath) {
  const ws = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!ws) return null;
  return path.join(ws, PROJECT_DOCS_SUBDIR);
}

/**
 * 覆盖目录解析：绝对路径直接用；相对路径按工作区解析（空 ⇒ null = 用默认）。
 * 之所以允许相对：项目里常想写 `.taskboard/docs` 这种可入库的路径，而不是钉死本机绝对路径。
 */
export function resolveOverrideDir(overrideDir, workspacePath) {
  const raw = typeof overrideDir === "string" ? overrideDir.trim() : "";
  if (!raw) return null;
  if (path.isAbsolute(raw)) return path.normalize(raw);
  const ws = typeof workspacePath === "string" ? workspacePath.trim() : "";
  if (!ws) throw new TbError("WORKSPACE_MISSING", "存放位置写的是相对路径，但项目未配置工作区目录 ⇒ 无法解析");
  return path.normalize(path.join(ws, raw));
}

/** 递归列 md（副本里可能有 assets/ 子目录）。 */
export function listDocs(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = (d, base) => {
    for (const name of readdirSync(d).sort()) {
      const abs = path.join(d, name);
      if (statSync(abs).isDirectory()) walk(abs, base);
      else if (name.endsWith(".md")) out.push(path.relative(base, abs));
    }
  };
  walk(dir, dir);
  return out.sort();
}

/**
 * 只读视图：包内默认 / 项目存放 / 生效来源。
 * @param {{packagedDir:string, workspacePath?:string|null, overrideDir?:string|null}} input
 */
export function docsView({ packagedDir, workspacePath = null, overrideDir = null }) {
  const defaultDir = projectDocsDir(workspacePath);
  const resolvedOverride = resolveOverrideDir(overrideDir, workspacePath);
  const projectDir = resolvedOverride ?? defaultDir;
  const packagedFiles = listDocs(packagedDir);
  const projectFiles = listDocs(projectDir);
  const hasProjectCopy = projectFiles.length > 0;
  return {
    packaged: { dir: packagedDir, files: packagedFiles },
    project: {
      dir: projectDir,
      dirIsOverride: Boolean(resolvedOverride),
      exists: Boolean(projectDir && existsSync(projectDir)),
      files: projectFiles,
    },
    effective: hasProjectCopy ? { source: "project", dir: projectDir } : { source: "packaged", dir: packagedDir },
    missingInProject: hasProjectCopy ? packagedFiles.filter((f) => !projectFiles.includes(f)) : [],
    workspacePath: workspacePath ?? null,
  };
}

/**
 * 把包内默认文档复制成项目副本（显式动作）。
 * @param {{packagedDir:string, workspacePath?:string|null, overrideDir?:string|null, overwrite?:boolean}} input
 */
export function materializeProjectDocs({ packagedDir, workspacePath = null, overrideDir = null, overwrite = false }) {
  const resolvedOverride = resolveOverrideDir(overrideDir, workspacePath);
  const dir = resolvedOverride ?? projectDocsDir(workspacePath);
  if (!dir) throw new TbError("WORKSPACE_MISSING", "项目未配置工作区目录 ⇒ 无法生成文档副本；请先在「配置 → 当前绑定」填工作区");
  if (!existsSync(packagedDir)) throw new TbError("DOCS_NOT_FOUND", `随包文档目录不存在：${packagedDir}`);
  mkdirSync(dir, { recursive: true });
  const written = []; const kept = [];
  for (const rel of listDocs(packagedDir)) {
    const target = path.join(dir, rel);
    if (existsSync(target) && !overwrite) { kept.push(rel); continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(packagedDir, rel), target);
    written.push(rel);
  }
  const readme = path.join(dir, "README.md");
  // 包内也有 README：上面已复制成包内版本；这里只在「包内没有 README」时补项目自述，避免互相覆盖。
  if (!existsSync(readme)) { writeText(readme, PROJECT_README); written.push("README.md"); }
  return { dir, written, kept, count: listDocs(dir).length };
}

function writeText(abs, text) {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
}

/** 读一份文档正文（配置页「看一眼」用，只读）。 */
export function readDocFile(dir, rel) {
  const safe = String(rel ?? "").replace(/^[/\\]+/, "");
  if (!safe || safe.includes("..")) throw new TbError("USAGE_ERROR", "非法文档路径");
  const abs = path.join(dir, safe);
  if (!existsSync(abs)) throw new TbError("DOCS_NOT_FOUND", `文档不存在：${safe}`);
  return { file: safe, text: readFileSync(abs, "utf8") };
}
