/**
 * binding.mjs —— 工作区 ↔ 项目 ↔ 需求文档 的绑定核心（FR-02/34）。
 * 会话/工作区（cwd）→ 最长前缀匹配项目（workspacePath）；无匹配回落默认项目；项目必有需求文档。
 */
const norm = (p) => String(p ?? "").replace(/\/+$/, "");

/**
 * 按 cwd 解析所属项目：workspacePath 最长前缀命中优先；否则回落第一个项目（默认项目）。
 * 与 `matchProjectForCwd` 同一口径 —— 两者的唯一差别只是**要不要如实报告"是否命中"**。
 */
export function resolveProjectForCwd(store, cwd) {
  return matchProjectForCwd(store, cwd).project;
}

/**
 * 与 `resolveProjectForCwd` 同口径，但**额外如实报告是否由 cwd 命中**。
 * 用途：FR-29 要求"cwd 无法匹配项目而回落默认项目时**必须提示用户**" —— 只拿到 project
 * 是分不出"真命中"和"回落"的（回落也是返回一个项目）。
 */
export function matchProjectForCwd(store, cwd) {
  const projects = store.listProjects();
  if (projects.length === 0) return { project: null, matched: false };
  const target = norm(cwd);
  if (target) {
    let best = null;
    for (const p of projects) {
      const wp = norm(p.workspacePath);
      if (!wp) continue;
      if (target === wp || target.startsWith(`${wp}/`)) {
        if (!best || wp.length > norm(best.workspacePath).length) best = p;
      }
    }
    if (best) return { project: best, matched: true };
  }
  return { project: projects.find((p) => p.id === "default") ?? projects[0], matched: false };
}

/** 解析"当前工作区上下文"：{ project, requirementDoc }（需求文档不存在则自动建立）。 */
export function resolveContext(store, cwd) {
  const project = resolveProjectForCwd(store, cwd);
  if (!project) return { project: null, requirementDoc: null };
  const requirementDoc = store.ensureRequirementDoc(project.id);
  return { project, requirementDoc };
}
