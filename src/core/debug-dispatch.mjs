/**
 * 「交项目主会话执行调试」的指令构造（纯函数）——FR-97。
 *
 * 为什么单独成一个模块：投递给宿主会话的文本是**契约的一部分**（收方 agent 完全靠它知道
 * 边界红线与回报格式），必须能被单测逐段断言，也必须与 HTTP 路由、store 写入解耦。
 * 本模块**不碰 DOM / 不发请求 / 不读库**。
 *
 * 边界红线必须原样出现在指令里：收方 agent 运行在另一个会话，不会读本仓 `AGENTS.md`，
 * 看不到看板卡上的验收标准 —— 这是唯一能把纪律带过去的通道。
 */

/** 收方 agent 必须遵守的边界（真机教训沉淀，不得随意删改）。 */
export const DEBUG_DISPATCH_BOUNDARIES = Object.freeze([
  "不 commit、不 push（commit 归队长/人）",
  "不改范围外文件；共享文件串行修改",
  "不改历史决策文档（docs/历史归档/、已定稿的需求与计划条款）",
  "不删用户数据（看板项目 / 任务 / 需求条目）：删除类操作必须先获得用户明确指示",
  "不把任务置「完成(done)」：完成只能由人确认，执行侧最多置「待验收」",
  "动 ~/.dsh/profiles/**、LaunchAgent plist、dsh plugin add/remove、宿主进程重启 —— 必须先汇报并取得用户明确审批",
  "不隐藏失败：失败原样上报，禁止「重试到成功再报」",
]);

/** 收方 agent 的回报格式（四节，与 docs/规范/01-协作规范.md §二 对齐）。 */
export const DEBUG_DISPATCH_REPORT_FORMAT = Object.freeze([
  "判定：完成 / 部分 / 停下（哪一步）",
  "偏离说明：与本指令不符之处如实写（不写偏离＝隐藏信息）",
  "边界自查：逐条对齐上面的边界红线",
  "产物路径：落盘文件 / 验证读数的位置",
]);

function line(value, fallback = "（未填写）") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

/**
 * 拼「调试修复指令」。
 *
 * @param {object} input
 * @param {object} input.task 任务行（identifier / title / status / description / labels）
 * @param {object} [input.project] 项目行（id / name / workspacePath）
 * @param {string} [input.note] 人工补充说明（可空）
 * @param {string} [input.nextStep] 本卡「下一步」引导标题/提示，供收方知道卡面已判定为什么状态
 * @returns {string} 可直接投递给宿主会话的完整指令文本（纯字符串，无副作用）
 */
export function buildDebugDispatchPrompt({ task, project, note, nextStep } = {}) {
  const t = task ?? {};
  const p = project ?? {};
  const identifier = line(t.identifier, "（无编号）");
  const title = line(t.title, "（无标题）");
  const status = line(t.status, "（未知）");
  const labels = Array.isArray(t.labels) ? t.labels.filter((l) => String(l ?? "").trim()) : [];

  const parts = [];
  parts.push(`# 任务：修复看板卡 ${identifier} 无法规范流转的问题（调试修复）`);
  parts.push("");
  parts.push(`## 卡号与标题`);
  parts.push(`- 卡号：${identifier}`);
  parts.push(`- 标题：${title}`);
  parts.push(`- 当前状态：${status}${labels.length ? `（标签：${labels.join(" / ")}）` : ""}`);
  parts.push(`- 所属项目：${line(p.name ?? p.id)}`);
  parts.push(`- 工作区：${line(p.workspacePath)}`);
  parts.push("");

  parts.push(`## 现状与现象（卡面原文，请先读懂再动手）`);
  parts.push(line(t.description, "（卡面无描述）"));
  parts.push("");

  if (nextStep) {
    parts.push(`## 看板已给出的「下一步」判定`);
    parts.push(line(nextStep));
    parts.push("");
  }

  if (note && String(note).trim()) {
    parts.push(`## 派发人补充说明`);
    parts.push(String(note).trim());
    parts.push("");
  }

  parts.push(`## 边界红线（必须遵守；违反其一即视为交付失败）`);
  for (const b of DEBUG_DISPATCH_BOUNDARIES) parts.push(`- ${b}`);
  parts.push("");

  parts.push(`## 回报格式（四节，缺节视为未完成）`);
  for (const r of DEBUG_DISPATCH_REPORT_FORMAT) parts.push(`- ${r}`);
  parts.push("");

  parts.push(`## 完成后`);
  parts.push(`- 把结论回写到看板卡 ${identifier}（评论 + 状态），**不要置「完成」**。`);
  parts.push(`- 验证读数要可复跑（如 \`npm test\` 的通过/失败计数），不要只写「已验证」。`);

  return parts.join("\n");
}