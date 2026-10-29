/**
 * requirements.mjs —— 需求域纯函数层（FR-34/35/36/37）。
 * 不触碰文件系统与数据库，可单独测试。核心层不依赖 DSH。
 *
 * 注意（MVP 边界）：本模块的"条目化"用**规则解析**（从需求文档抽取候选），
 * 不使用任何会话/智能体（MVP 红线：不碰执行侧）。AI 版条目化属切片2。
 */
import { normalizeLabels } from "./domain.mjs";
import { invalidField, TbError } from "./errors.mjs";

/**
 * 需求条目状态：draft=待确认（资料引入）/ open=已确认（在办）/ done=已完成（关联任务已收口，人工确认）/
 * closed=已关闭（不再做：作废、并入他条、明确不做）。
 *
 * FR-91（2026-10-22 真机反馈）：「新增需求是否完成&关闭等状态更新」—— 此前只有 draft/open/closed，
 * 「这条需求做完了没有」没有落点，需求层与任务层对不上账。新增 `done`，并明确 `done`/`closed` 都是
 * **终态**（`REQUIREMENT_DONE_STATUSES`），终态由**人**确认（自动只给建议，见 `summarizeRequirementCompletion`）。
 */
export const REQUIREMENT_STATUSES = Object.freeze(["draft", "open", "done", "closed"]);
/** 需求终态：已完成 / 已关闭（都不再产生新任务；`done` 需关联任务先收口）。 */
export const REQUIREMENT_DONE_STATUSES = Object.freeze(["done", "closed"]);
/** 需求条目来源：手工 / 规则解析（fallback）/ AI 拆解（首选）/ 资料引入。 */
// 卡 `-176`（2026-10-29）：补 `mcp`。此前 MCP `requirement_upsert` 建条目一律落默认 `manual`
// ⇒ 「这条是人手建的还是 MCP 建的」在库里不可辨（审计也就无从按入口统计）。
export const REQUIREMENT_SOURCES = Object.freeze(["manual", "elaborated-rule", "elaborated-ai", "intake", "mcp"]);
/** 可行性结论取值（追加字段）。 */
export const FEASIBILITY_VERDICTS = Object.freeze(["feasible", "infeasible"]);

export function isRequirementStatus(v) {
  return REQUIREMENT_STATUSES.includes(v);
}
export function assertRequirementStatus(v, field = "status") {
  if (!isRequirementStatus(v)) {
    throw invalidField(field, `${field} 必须是 ${REQUIREMENT_STATUSES.join(" / ")} 之一，收到：${JSON.stringify(v)}`);
  }
  return v;
}
export function assertRequirementSource(v, field = "source") {
  if (!REQUIREMENT_SOURCES.includes(v)) {
    throw invalidField(field, `${field} 必须是 ${REQUIREMENT_SOURCES.join(" / ")} 之一，收到：${JSON.stringify(v)}`);
  }
  return v;
}
export function assertFeasibilityVerdict(v, field = "verdict") {
  if (!FEASIBILITY_VERDICTS.includes(v)) {
    throw invalidField(field, `${field} 必须是 ${FEASIBILITY_VERDICTS.join(" / ")} 之一，收到：${JSON.stringify(v)}`);
  }
  return v;
}

/** 需求条目可读编号：`<项目id>-R<序号>`（与任务 `<项目id>-<序号>` 区分）。 */
export function formatRequirementIdentifier(projectId, sequence) {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw invalidField("sequence", `序号必须是 ≥1 的整数，收到：${JSON.stringify(sequence)}`);
  }
  return `${projectId}-R${sequence}`;
}

/** 解析 `p-R12` → { prefix: "p", sequence: 12 }；不匹配返回 null。 */
export function parseRequirementIdentifier(value) {
  const m = /^([a-z][a-z0-9-]*)-R(\d+)$/.exec(String(value ?? ""));
  if (!m) return null;
  const sequence = Number(m[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { prefix: m[1], sequence };
}

/** 标题归一化（去首尾空白、压缩内部空白）。 */
export function normalizeTitle(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

/** 去重键：标题小写 + 去 markdown 强调符。 */
export function titleKey(value) {
  return normalizeTitle(value)
    .toLowerCase()
    .replace(/[*_`#]/g, "")
    .trim();
}

/** 抽取需求文档正文里的候选条目（规则解析，非 AI）。 */
// ---- 条目化的数量口径（卡 `-169` P4② · 2026-10-29 口径变更） -----------------
/**
 * 真机实证（2026-10-28）：一份「资料索引」类需求文档走**规则**条目化，产出 **4213 条**，
 * 其中 0 条是真需求 —— 全是**文件清单行**（`- docs/a.md` 这种）。
 * 旧口径 `limit` 默认 **100** 且 **body 传了也不生效** ⇒ 一按按钮就落 100 条 `pending` 候选，
 * 这就是「100 条 pending」的直接来路。
 *
 * 新口径（本卡批准的 P4②）：
 * 1. `limit` **默认 20**（100 → 20），**硬顶 200**，且**从 body 透传**；
 * 2. `auto` 模式**只用 AI**，AI 不可用 ⇒ **拒绝**（`AI_UNAVAILABLE`，零落库）——
 *    要规则降级必须**显式** `fallback:"rule"`（把「其实没 AI」从「看起来成功」改成「明确失败」）；
 * 3. 规则模式支持 `dryRun` 预览（零落库）。
 */
export const DEFAULT_ELABORATE_LIMIT = 20;
export const MAX_ELABORATE_LIMIT = 200;
export const ELABORATE_PREVIEW_SIZE = 10;

/**
 * `limit` 归一：空 ⇒ 默认 20；非正整数 ⇒ **报错**（不静默回落 —— 否则「我传了 5 却写了 20」极难查）；
 * 超硬顶 ⇒ 夹到 200（上限语义，夹取比报错更符合预期）。
 */
export function clampElaborateLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_ELABORATE_LIMIT;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw invalidField("limit", `limit 必须是正整数，收到：${String(value)}`);
  return Math.min(n, MAX_ELABORATE_LIMIT);
}

export function elaborateDocument(body) {
  if (typeof body !== "string") throw invalidField("body", "需求文档正文必须是字符串");
  const candidates = [];
  const seen = new Set();
  const push = (rawTitle, priority = "none") => {
    const title = normalizeTitle(rawTitle).replace(/[*_`]/g, "").replace(/[：:]\s*$/, "").trim();
    if (title === "") return;
    const key = titleKey(title);
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    candidates.push({ title, description: "", acceptance: "", priority });
  };
  for (const line of body.split(/\r?\n/)) {
    let m;
    if ((m = /^(#{1,6})\s+(.+?)\s*$/.exec(line))) { push(m[2]); continue; }
    if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(.+?)\s*$/.exec(line))) { push(m[1]); continue; }
  }
  return candidates;
}

/** 校验分拆产出的任务数组（FR-38）。 */
/** 分拆任务的 kind 取值（2026-10-28 补：此前**收到就丢**，界面承诺了却落不了库）。 */
export const SPLIT_KINDS = Object.freeze(["work", "review"]);

/**
 * kind 归一：空 → null；已知值 → 原值；**未知值直接报错**。
 *
 * 为什么"未知值报错"而不是静默丢成 null：2026-10-28 真机排查发现旧实现把 `kind` 整个丢弃
 * （`assertSplitTasks` 只保留 6 个字段），用户在界面填 `review` **看起来生效、实际什么都没有** ——
 * 这正是"界面承诺 ≠ 实现"的典型。宁可当场报错，也不许再出现"填了等于没填"。
 */
export function normalizeSplitKind(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (text === "") return null;
  if (!SPLIT_KINDS.includes(text)) throw invalidField("tasks[].kind", `kind 只能是 ${SPLIT_KINDS.join(" / ")}，收到：${value}`);
  return text;
}

export function assertSplitTasks(tasks) {
  if (!Array.isArray(tasks)) throw invalidField("tasks", "分拆产出必须是任务数组");
  const out = [];
  for (const t of tasks) {
    if (!t || typeof t !== "object") throw invalidField("tasks", "任务项必须是对象");
    const title = normalizeTitle(t.title);
    if (title === "") throw invalidField("tasks[].title", "任务标题不能为空");
    const dependsOn = Array.isArray(t.dependsOn) ? t.dependsOn.slice() : [];
    out.push({
      title,
      description: t.description === undefined || t.description === null ? "" : String(t.description),
      owner: t.owner === undefined || t.owner === null ? null : String(t.owner),
      // 2026-10-28：kind 必须**穿过**校验层（旧实现丢字段 ⇒ 界面填了等于没填）
      kind: normalizeSplitKind(t.kind),
      priority: t.priority ?? "none",
      labels: normalizeLabels(t.labels ?? []),
      dependsOn,
    });
  }
  return out;
}

// ------------------------------------------------------------------ AI 条目化（FR-36，首选路径；规则解析为 fallback）

/** 构造 AI 条目化的系统提示（要求严格 JSON 输出）。 */
export function buildElaborationSystem() {
  return [
    "你是需求分析助手。把给定的需求文档拆解成需求条目。",
    '只输出一个 JSON 数组，每个元素形如 {"title":string,"description":string,"acceptance":string,"priority":"none|low|medium|high|urgent"}。',
    "不要输出 JSON 以外的任何文字、不要用代码块包裹。标题必填；无法确定时 acceptance/description 用空串。",
  ].join("\n");
}

/** 构造 AI 条目化的消息（含文档正文）。 */
export function buildElaborationMessages(body) {
  return {
    system: buildElaborationSystem(),
    messages: [{ role: "user", content: `需求文档正文：\n\n${String(body ?? "")}` }],
  };
}

/**
 * 解析 AI 产出为候选条目；格式非法即抛错（AI 产出格式非法 → 走降级/失败处理）。
 * 容忍代码块包裹与首尾噪声。
 */
export function parseElaborationOutput(text) {
  if (typeof text !== "string" || text.trim() === "") {
    throw new TbError("AI_OUTPUT_INVALID", "AI 产出为空或无法解析");
  }
  let raw = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(raw);
  if (fence) raw = fence[1].trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new TbError("AI_OUTPUT_INVALID", "AI 产出不是 JSON 数组");
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new TbError("AI_OUTPUT_INVALID", `AI 产出 JSON 解析失败：${error.message}`);
  }
  if (!Array.isArray(parsed)) throw new TbError("AI_OUTPUT_INVALID", "AI 产出不是数组");
  const out = [];
  for (const c of parsed) {
    if (!c || typeof c !== "object") continue;
    const title = normalizeTitle(c.title);
    if (title === "") continue;
    const priority = ["none", "low", "medium", "high", "urgent"].includes(c.priority) ? c.priority : "none";
    out.push({
      title,
      description: c.description == null ? "" : String(c.description),
      acceptance: c.acceptance == null ? "" : String(c.acceptance),
      priority,
    });
  }
  if (out.length === 0) throw new TbError("AI_OUTPUT_INVALID", "AI 产出未包含任何有效条目");
  return out;
}

/** 归一化外部（AI/规则）给出的候选条目列表。 */
export function normalizeCandidates(input) {
  if (!Array.isArray(input)) throw invalidField("candidates", "候选条目必须是数组");
  const out = [];
  const seen = new Set();
  for (const c of input) {
    if (!c || typeof c !== "object") continue;
    const title = normalizeTitle(c.title);
    if (title === "") continue;
    const key = titleKey(title);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      description: c.description == null ? "" : String(c.description),
      acceptance: c.acceptance == null ? "" : String(c.acceptance),
      priority: c.priority ?? "none",
    });
  }
  return out;
}

/**
 * 需求完成度（FR-91，纯函数）：把**关联任务**的状态汇总成一句可核验的结论，供「自动/人工评审需求是否完成」。
 *
 * 需求详情里必须能看到「这条需求关联的任务做完了没有」，否则需求层与任务层对不上账，人只能凭印象点完成。
 * 本函数只做口径汇总、**不查库不改状态**；给出的是**建议**（`ready`），终态仍由人确认。
 *
 * 判据（优先级从高到低）：
 * - 无关联任务 → `no-tasks`（先「生成任务」，不然无从评审）；
 * - 关联任务全部收口（done/canceled）→ `all-closed`，`ready=true`；
 * - 有受阻任务 → `blocked`；有待验收任务 → `in-review`；其余 → `in-progress`（都 `ready=false`）。
 */
export function summarizeRequirementCompletion(tasks = []) {
  const list = (Array.isArray(tasks) ? tasks : []).map((t) => ({
    identifier: t?.identifier ?? null,
    title: t?.title ?? "",
    status: t?.status ?? null,
    reviewState: t?.reviewState ?? null,
  }));
  const counts = { backlog: 0, todo: 0, in_progress: 0, in_review: 0, blocked: 0, done: 0, canceled: 0 };
  for (const t of list) if (t.status in counts) counts[t.status] += 1;
  const total = list.length;
  const closed = counts.done + counts.canceled;
  const active = total - closed;

  let verdict; let text; let ready = false;
  if (total === 0) {
    verdict = "no-tasks";
    text = "尚无关联任务：请先「生成任务」再评审本条需求是否完成。";
  } else if (active === 0) {
    verdict = "all-closed";
    ready = true;
    text = `关联任务 ${total} 个已全部收口（完成 ${counts.done}${counts.canceled ? ` · 已取消 ${counts.canceled}` : ""}）：可判定本条需求完成。`;
  } else if (counts.blocked > 0) {
    verdict = "blocked";
    text = `还有 ${active} 个关联任务未收口，其中 ${counts.blocked} 个受阻：先解阻塞再评审需求完成。`;
  } else if (counts.in_review > 0) {
    verdict = "in-review";
    text = `还有 ${active} 个关联任务未收口，其中 ${counts.in_review} 个待验收：先在任务上完成评审（通过不等于完成，仍需人工点 done）。`;
  } else {
    verdict = "in-progress";
    text = `还有 ${active} 个关联任务未收口（待办 ${counts.backlog + counts.todo} · 进行中 ${counts.in_progress}）：需求尚未完成。`;
  }
  return { total, closed, active, counts, verdict, ready, text, tasks: list };
}
