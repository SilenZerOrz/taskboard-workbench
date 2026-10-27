/**
 * FR-92「项目开局对齐」—— 标准步骤程序（**纯函数**，不碰文件系统/数据库，可单测）。
 *
 * 来源：用户 2026-10-22 指定引入鱼皮《Vibe Coding 团队协作技巧》
 * （https://github.com/liyupi/ai-guide/blob/main/Vibe%20Coding%20零基础教程/30%20经验技巧/11%20Vibe%20Coding%20团队协作技巧.md），
 * 要求「作为项目任务看板工作台的项目开局对齐事项，建立相关团队&配置约束」，并
 * 「把该对齐作为标准化流程引入，作为任务工作台标准步骤程序执行」。
 *
 * 该文七条要点（统一代码规范 / 文档驱动 / Git 协作流程 / 代码审查 / AI 团队功能 / 协作机制 / 明确分工）
 * 在这里被压成 **6 个可自检的开局步骤**：每一步都有**可核验的判据**（工作区里存在哪些文件、
 * 项目设置里哪些约束已填），而不是"读一读就好"的口号 —— 这样工作台能自己回答"这个项目对齐了没有"。
 *
 * 红线（与 FR-85 同口径）：**自检只给结论，不改任何数据**；缺什么由人（或用既有入口）去补。
 */

/** 出处（写进报告，便于追溯；引用不复制原文）。 */
export const KICKOFF_SOURCE = Object.freeze({
  title: "Vibe Coding 团队协作技巧（鱼皮 / ai-guide）",
  url: "https://github.com/liyupi/ai-guide/blob/main/Vibe%20Coding%20%E9%9B%B6%E5%9F%BA%E7%A1%80%E6%95%99%E7%A8%8B/30%20%E7%BB%8F%E9%AA%8C%E6%8A%80%E5%B7%A7/11%20Vibe%20Coding%20%E5%9B%A2%E9%98%9F%E5%8D%8F%E4%BD%9C%E6%8A%80%E5%B7%A7.md",
  note: "本仓只落**可执行的检查单与约束**，不搬运原文；需要原文请点链接。",
});

/**
 * 六个标准步骤。`checks` 每条：`paths`（工作区相对路径，任一存在即通过）或 `setting`
 * （项目设置里的点路径，非空即通过）或 `custom`（由调用方注入的布尔）。
 */
export const KICKOFF_ALIGNMENT_STEPS = Object.freeze([
  {
    id: "code-style",
    title: "① 统一代码规范",
    why: "各人用 AI 生成的风格不一致（React/Vue、camelCase/snake_case 混用）会让项目无法维护。",
    spec: "落一份规范文档 + 用 Linter/Formatter 强制执行 + 一份 AI 规则文件（AGENTS.md / CLAUDE.md / .cursorrules）。",
    checks: [
      { id: "style-doc", label: "规范文档（CODE_STYLE.md / AGENTS.md / CLAUDE.md / .cursorrules 任一）", paths: ["CODE_STYLE.md", "AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules"] },
      { id: "linter", label: "Linter 配置", paths: [".eslintrc", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"] },
      { id: "formatter", label: "Formatter 配置", paths: [".prettierrc", ".prettierrc.json", ".prettierrc.cjs", ".prettierrc.js", "prettier.config.js", "prettier.config.cjs"] },
    ],
  },
  {
    id: "docs-first",
    title: "② 文档驱动开发",
    why: "文档是协作基础：新人靠它上手，跨人交接靠它对齐。",
    spec: "README（简介/快速开始/技术栈/目录结构）+ 参与指南 + 变更记录。",
    checks: [
      { id: "readme", label: "README.md", paths: ["README.md", "readme.md"] },
      { id: "contributing", label: "参与指南（CONTRIBUTING.md 或 docs/规范/）", paths: ["CONTRIBUTING.md", "docs/规范", "docs/规范/README.md"] },
      { id: "changelog", label: "变更记录（CHANGELOG.md 或 docs/进度/）", paths: ["CHANGELOG.md", "docs/进度", "docs/进度/README.md"] },
    ],
  },
  {
    id: "git-flow",
    title: "③ Git 协作流程",
    why: "分支与提交不规范 ⇒ 冲突频发、历史不可追溯。",
    spec: "分支策略（main/develop/feature/bugfix）+ Conventional Commits + PR 模板与评审。",
    checks: [
      { id: "pr-template", label: "PR 模板（.github/PULL_REQUEST_TEMPLATE.md）", paths: [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md"] },
      { id: "git-convention", label: "项目设置里写明 Git/提交约定（envConfig.gitFlow）", setting: "envConfig.gitFlow" },
    ],
  },
  {
    id: "review-gate",
    title: "④ 代码审查门",
    why: "审查是质量关键：上线前拦 Bug、统一风格，也是团队学习机会。",
    spec: "至少一人审查 + AI 初审 + 多 AI 交叉验证；审查未过不得合并/解锁下游。",
    checks: [
      { id: "reviewer-role", label: "团队模板里有 reviewer（审计）角色", custom: "reviewerRole" },
      { id: "review-gate", label: "项目设置里定义质量门（envConfig.qualityGates 或 teamTemplate.qualityGates）", setting: ["envConfig.qualityGates", "teamTemplate.qualityGates"] },
    ],
  },
  {
    id: "collaboration",
    title: "⑤ 协作机制与知识沉淀",
    why: "定期同步、知识分享、共享资源能避免重复踩坑。",
    spec: "站会/周会节奏 + 知识库 + 提示词与代码片段等共享资源。",
    checks: [
      { id: "cadence", label: "项目设置里写明同步节奏（envConfig.cadence）", setting: "envConfig.cadence" },
      { id: "knowledge", label: "知识沉淀目录（docs/规范/ 或 个人笔记/踩坑经验/）", paths: ["docs/规范", "docs/规范/README.md", "个人笔记/踩坑经验"] },
    ],
  },
  {
    id: "roles",
    title: "⑥ 明确分工",
    why: "谁负责什么要说清，避免重复工作或遗漏；同时别养成 AI 依赖症。",
    spec: "团队模板定义 lead/planner/engineer/tester/reviewer/archivist 的职责与模型。",
    checks: [
      { id: "roles-defined", label: "团队模板包含角色编制（teamTemplate.roles）", setting: "teamTemplate.roles" },
      { id: "executor", label: "工程师角色的执行器与验证命令已约定（teamTemplate.roles[engineer].executor / teamTemplate.engineer.verifyCommand）", custom: "engineerExecutor" },
    ],
  },
]);

/** 点路径取值（`a.b.c`）；空串/空数组/空对象都算"没填"。 */
export function pickSetting(settings, dotted) {
  let cur = settings;
  for (const key of String(dotted ?? "").split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** "有没有填"的判定：undefined/null/""/[]/{} 都算没填。 */
export function isFilled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * 自检：`files` 是「工作区相对路径 → 是否存在」的映射（由 `../server/kickoff.mjs` 采集），
 * `settings` 是项目设置，`custom` 放调用方算好的布尔（如"团队模板里有 reviewer"）。
 */
export function evaluateKickoff({ files = {}, settings = {}, custom = {} } = {}) {
  const hasFile = (p) => files[p] === true;
  const steps = KICKOFF_ALIGNMENT_STEPS.map((step) => {
    const checks = step.checks.map((c) => {
      let ok;
      if (c.paths) ok = c.paths.some(hasFile);
      // `setting` 允许给一组候选点路径（各仓把同一件事放在不同位置，如 qualityGates 在
      // envConfig 或 teamTemplate 下都有先例）——任一已填即算通过。
      else if (c.setting) ok = (Array.isArray(c.setting) ? c.setting : [c.setting]).some((k) => isFilled(pickSetting(settings, k)));
      else if (c.custom) ok = custom[c.custom] === true;
      else ok = false;
      const settingHit = c.setting ? (Array.isArray(c.setting) ? c.setting : [c.setting]).find((k) => isFilled(pickSetting(settings, k))) : null;
      return { id: c.id, label: c.label, ok, evidence: c.paths ? c.paths.filter(hasFile).join(" / ") || null : settingHit ?? c.custom ?? null };
    });
    const done = checks.filter((c) => c.ok).length;
    const status = done === checks.length ? "done" : done === 0 ? "missing" : "partial";
    return { id: step.id, title: step.title, why: step.why, spec: step.spec, status, done, total: checks.length, checks };
  });
  const doneCount = steps.filter((s) => s.status === "done").length;
  const missing = steps.filter((s) => s.status !== "done");
  return {
    source: KICKOFF_SOURCE,
    steps,
    total: steps.length,
    doneCount,
    // 只有六步全 done 才算"对齐完成"；未对齐不阻断（不替用户做决定），但**必须显式提示**。
    ready: doneCount === steps.length,
    missing: missing.map((s) => ({ id: s.id, title: s.title, status: s.status, todo: s.checks.filter((c) => !c.ok).map((c) => c.label) })),
    verdict: doneCount === steps.length
      ? "开局对齐已完成（6/6）：可以进入拆解与派发。"
      : `开局对齐未完成（${doneCount}/${steps.length}）：未对齐项 ${missing.map((s) => s.title).join("、")}；建议先补齐再派发执行。`,
  };
}
