/**
 * 「交项目主会话生成任务分拆」的指令构造（纯函数）—— 2026-10-28 真机批注。
 *
 * 现象：需求条目详情里的「生成看板任务（分拆）」此前**只有一个人工 textarea** ——
 * 人按 `标题 | 负责人 | kind` 一行一条手打，没有建议、没有草稿、没有修订回路。
 * 用户要求：「引入自动生成按钮，并可交互提交修改意见变更优化」。
 *
 * 口径（人拍 **方案 C：走项目主会话**）：不新增第二条 LLM 通道，把「先出草稿」这一步交给
 * **项目主会话**里的 agent —— 它本来就有仓库上下文与 `taskboard_*` 工具。
 * 本模块只负责把**要求、格式、边界**写成一段可投递的文本（与 FR-97 的 `debug-dispatch` 同法）：
 * 收方 agent 跑在另一个会话，不读本仓 `AGENTS.md`，这段文本是唯一能把纪律带过去的通道。
 *
 * 本模块**不碰 DOM / 不发请求 / 不读库**，因此可被单测逐段断言。
 */

/** 收方 agent 必须遵守的边界（与 `debug-dispatch.mjs` 同口径，不得随意删改）。 */
export const SPLIT_ASK_BOUNDARIES = Object.freeze([
  "**先不要建卡**：本轮只出建议清单，等人在看板点「生成任务」再落库（避免一次对话把看板灌满）",
  "不 commit、不 push（commit 归队长/人）",
  "不改范围外文件；只读分析条目与本仓库",
  "不删用户数据（看板项目 / 任务 / 需求条目）",
  "不把任务置「完成(done)」：完成只能由人确认",
  "动 ~/.dsh/profiles/**、LaunchAgent plist、dsh plugin add/remove、宿主进程重启 —— 必须先汇报并取得用户明确审批",
]);

/**
 * 回帖里**唯一**被看板解析的格式（人把它粘回「生成看板任务」的输入框即可落库）。
 * 冒号、竖线、箭头都是**半角**，为保证 `split` 端点能直接吃这份文本。
 */
export const SPLIT_ASK_LINE_FORMAT = Object.freeze([
  "每行一个任务，字段用半角 `|` 分隔：",
  "`序号 | 标题 | 负责人 | kind | 依赖`",
  "- 负责人：`planner` / `engineer` / `tester` / `reviewer` / `archivist`，不确定就留空",
  "- kind：`work` / `review`，不确定就留空",
  "- 依赖：填**前置任务的序号**（多个用逗号，如 `1,2`），没有就留空",
  "- 例：`3 | 补前端抽屉宽度 | engineer | work | 1,2`",
]);

function line(value, fallback = "（未填写）") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * 拼「生成任务分拆」的指令。
 *
 * @param {object} input
 * @param {object} input.item 需求条目（identifier / title / description / acceptance / priority / status）
 * @param {object} [input.project] 项目（id / name / workspacePath）
 * @param {string} [input.feedback] 人提交的**修改意见**（第二轮起才有）
 * @param {string[]} [input.previous] 上一版草稿的**原始行**（用于"只改受影响的行"）
 * @param {number} [input.maxTasks] 期望条数上限（默认 7）
 * @returns {string} 可直接投递的完整指令文本（纯字符串，无副作用）
 */
export function buildSplitAskPrompt({ item, project, feedback, previous, maxTasks } = {}) {
  const it = item ?? {};
  const p = project ?? {};
  const cap = Number.isFinite(maxTasks) && maxTasks > 0 ? Math.min(Math.trunc(maxTasks), 12) : 7;
  const prev = Array.isArray(previous) ? previous.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
  const note = String(feedback ?? "").trim();

  const parts = [];
  parts.push(`# 任务：为需求条目 ${line(it.identifier, "（无编号）")} 生成「看板任务分拆」建议（只出建议，不要建卡）`);
  parts.push("");
  parts.push("## 条目原文（请先读懂再拆）");
  parts.push(`- 编号：${line(it.identifier)}`);
  parts.push(`- 标题：${line(it.title)}`);
  parts.push(`- 优先级：${line(it.priority, "none")}　状态：${line(it.status)}`);
  parts.push(`- 所属项目：${line(p.name ?? p.id)}　工作区：${line(p.workspacePath)}`);
  parts.push("");
  parts.push("### 描述");
  parts.push(line(it.description, "（条目无描述）"));
  parts.push("");
  parts.push("### 验收标准");
  parts.push(line(it.acceptance, "（条目无验收标准 —— 请在建议里顺带指出这一点）"));
  parts.push("");

  if (note) {
    parts.push("## 修改意见（本轮必须按它改）");
    parts.push(note);
    parts.push("");
  }
  if (prev.length) {
    parts.push("## 上一版草稿（**只改受意见影响的行**，其余原样保留）");
    parts.push("```");
    for (const l of prev) parts.push(l);
    parts.push("```");
    parts.push("");
  }

  parts.push(`## 产出要求`);
  parts.push(`- 拆出 **3–${cap}** 个技术任务，覆盖「实现 / 验证 / 评审」三条线，粒度做到"一个人半天到两天能干完"。`);
  parts.push(`- 依赖要写清：先做后做靠「依赖」列表达，不要靠标题里的"然后/接着"。`);
  parts.push("");
  parts.push("### 回帖格式（**只有这个格式会被看板解析**）");
  for (const l of SPLIT_ASK_LINE_FORMAT) parts.push(l);
  parts.push("");
  parts.push("先给一段 3 行以内的拆解思路，然后**只用一个 ``` 代码块**装任务行，代码块里除任务行外不要有别的文字。");
  parts.push("");

  parts.push("## 边界红线（逐条遵守，并在回帖末尾自查一行）");
  for (const l of SPLIT_ASK_BOUNDARIES) parts.push(`- ${l}`);
  parts.push("");
  parts.push("## 回报");
  parts.push("拆解思路（≤3 行）→ 任务行代码块 → 边界自查一行。**不要**调用任何建卡工具。");
  return parts.join("\n");
}
