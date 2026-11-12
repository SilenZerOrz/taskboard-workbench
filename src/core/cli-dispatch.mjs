/**
 * CLI 执行器 · **经项目主会话下发**的指令构造（需求 `R183` / 卡 `-257`）。
 *
 * 背景（2026-11-12 真机 `-246`）：服务端直接 `spawn claude -p` 时，执行过程与该会话无关 ——
 * 人点「打开执行会话」只看得到项目主会话、里面一条记录都没有，`task_runs` 也只有
 * `actor=cli-executor`、磁盘上更没有任何输出。用户拍板的口径由此而来：
 *
 *   **除「DSH 宿主会话」直接执行外，其他 agent 执行者一律交给项目主会话下发并跟踪，
 *     卡片的任务执行反馈也由主会话回写。**
 *
 * 所以这里生成的不是"给 CLI 的任务书"（那个是 `buildTaskPrompt`），而是**给主会话的派单指令**：
 * 确切命令 + 回写要求 + 红线，三样都得写在正文里，否则主会话要么自己重写任务书（漂移），
 * 要么跑完不写卡（看板又变成黑盒）。
 */

/** 看板 API 基址（与 `kickoff.mjs` 的 `SETTINGS_BASE` 同一口径：DSH 内嵌命名空间）。 */
export const TB_API_BASE = "http://127.0.0.1:3080/integrations/taskboard-workbench";

/** 单引号包裹并转义 —— 命令里出现中文/空格/特殊符号时也能安全粘进 shell。 */
function shq(value) {
  const s = String(value ?? "");
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * 拼出主会话要执行的那条 shell 命令。
 *
 * 两种投递形态（与 `executors.mjs` 的 `promptVia` 一一对应）：
 * - `stdin`（claude / codex）：任务书走 heredoc，避免超长命令行；
 * - `argv`（hermes `-z <prompt>`）：任务书已经在参数里（`buildExecutorArgs` 拼好的），不再重复投递。
 */
export function buildCliCommand({ plan }) {
  const cli = plan?.cli ?? "";
  const args = Array.isArray(plan?.args) ? plan.args : [];
  const base = [cli, ...args].join(" ");
  if (plan?.promptVia === "argv") return base;
  const delim = `TB_PROMPT_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  return `${base} <<'${delim}'\n${plan?.prompt ?? ""}\n${delim}`;
}

/**
 * 给项目主会话的派单指令。
 *
 * @param {object} input
 * @param {object} input.task 任务卡（`identifier` / `title` / `acceptance` / `verifyCommand`）
 * @param {object|null} input.project 项目（`workspacePath` 用作工作目录）
 * @param {object} input.executor 执行者（`id` / `role`）
 * @param {object} input.plan 执行计划（`cli` / `args` / `cwd` / `promptVia` / `prompt`）
 * @param {string} input.apiBase 看板 API 基址（回写用）
 */
export function buildMainSessionCliPrompt({ task, project, executor, plan, apiBase = TB_API_BASE }) {
  const cwd = plan?.cwd ?? project?.workspacePath ?? "（未设置工作目录）";
  const command = buildCliCommand({ plan });
  const ref = task?.identifier ?? "";
  const acceptance = String(task?.acceptance ?? "").trim();
  const verify = String(task?.verifyCommand ?? "").trim();
  return [
    `# 派单：${ref} 由你（项目主会话）用 ${executor?.id ?? "CLI"} 执行并回写`,
    ``,
    `看板把这张卡交给**本会话**下发跟踪 —— 请**在这里**跑下面的命令，让执行记录留在本会话里，`,
    `不要转手丢到别处静默跑完。`,
    ``,
    `## 这是哪张卡`,
    `- 编号：${ref}`,
    `- 标题：${task?.title ?? "（无标题）"}`,
    acceptance ? `- 验收：${acceptance}` : `- 验收：（该卡未写验收标准 —— 跑完在证据里如实说明）`,
    verify ? `- 复核动作：${verify}` : `- 复核动作：（沿用项目设置）`,
    ``,
    `## 执行命令（工作目录 ${cwd}）`,
    "```bash",
    command,
    "```",
    ``,
    `## 跑完之后（三件都做，缺一不合格）`,
    `1. 把**四节证据**写进卡片（判定 / 偏离说明 / 边界自查 / 产物路径）：`,
    `   \`POST ${apiBase}/api/tasks/${ref}/evidence\``,
    `   body 至少含 \`verdict\` \`deviation\` \`boundary\` \`artifacts\` 四个字段，\`actor\` 写 \`agent\`。`,
    `   若你有任务工作台的 MCP 工具，用 \`card_evidence_submit\`（同一道门、同一套错误码）。`,
    `2. 把卡提交「待验收」：\`POST ${apiBase}/api/tasks/${ref}/execution/review\``,
    `3. 失败就 \`POST ${apiBase}/api/tasks/${ref}/execution/fail\`，并在 body 里写清原因与错误尾段。`,
    ``,
    `## 红线`,
    `- **不得置 done**（完成只能人点）；`,
    `- 不 commit、不 push、不改历史决策文档、不删既有数据；`,
    `- 命令退出码非 0 或零改动时，照实写进证据，不要美化成"完成"。`,
    ``,
    `## 回报`,
    `做完在本会话回一句：退出码 / 改了哪些文件 / 卡片当前状态。`,
  ].join("\n");
}
