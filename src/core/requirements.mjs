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
      // 卡 `-273`（需求 `R189`）：acceptance 也必须**穿过**校验层。
      // 2026-11-17 真机读数：批量生成 16 张卡 desc=0 / acc=0，而条目本身 desc 4509 / acc 213
      // —— 内容全被这一层丢掉，与 2026-10-28 `kind` 丢失是**同一个缺陷形状**（界面/接口给了，实现静默丢）。
      acceptance: t.acceptance === undefined || t.acceptance === null ? "" : String(t.acceptance),
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

/** 条目正文里取「标签：」段（含后续同段行；用于兜底装配卡片正文；取不到返回空串）。 */
const BLOCK_LABELS = ["目标", "范围", "改动范围", "禁止", "约束", "硬约束", "做法", "报告", "停下", "验收", "关联", "背景"];
const LABEL_LINE_RE = new RegExp(`^[\\s>*【]*(?:${BLOCK_LABELS.join("|")})\\s*[】]*\\s*[：:]`);

/** 显式截断：**不静默砍**（-232 的教训：静默 slice 比报错更难查）。 */
function clipText(text, maxChars) {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, maxChars);
  // 尽量在句读处断开，别把一句话砍成半个词。
  const cut = Math.max(head.lastIndexOf("；"), head.lastIndexOf("。"), head.lastIndexOf("、"));
  const body = cut > maxChars * 0.4 ? head.slice(0, cut) : head;
  return `${body}…（截断，全文见需求条目）`;
}

function pickLabelledBlock(body, labels, maxChars = 9999) {
  const lines = String(body ?? "").split(/\r?\n/);
  for (const label of labels) {
    const head = new RegExp(`^[\\s>*【]*(?:${label})\\s*[】]*\\s*[：:]\\s*(.*)$`);
    for (let i = 0; i < lines.length; i += 1) {
      const m = head.exec(lines[i]);
      if (!m) continue;
      const parts = [];
      if (m[1].trim()) parts.push(m[1].trim());
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j];
        if (line.trim() === "") break;
        if (LABEL_LINE_RE.test(line)) break;
        parts.push(line.trim());
      }
      const text = parts.join("；").replace(/；{2,}/g, "；").replace(/：；/g, "：").trim();
      if (text === "") return "";
      return clipText(text, maxChars);
    }
  }
  return "";
}

/**
 * 卡 `-273`（需求 `R189`）：**批量/分拆生成任务时的兜底正文**（规范 `docs/规范/07-条目详情规范.md` §2.1 七块）。
 *
 * 为什么要有兜底：入口（界面「批量生成任务」、MCP、CLI）都只传 `{title}` 时，旧实现会建出
 * **description 为空**的卡 —— 执行者打开只看到一句标题，没有范围、没有禁止、没有验收，
 * 于是「怎么做都对」「做没做完说不清」。条目上明明写着这些内容，却在建卡时丢了。
 *
 * 口径：**只装配、不臆造** —— 条目写了「范围：」「约束：」就摘出来；没写就如实写「未写，开工前须补」，
 * 绝不替人编一个范围。八个标签顺序固定，便于逐行核对。
 *
 * 2026-11-17 二修：首版只摘「范围：」**同一行**，而本仓条目普遍写成「范围：」换行 + ①②③ 清单
 * ⇒ 摘出来只剩一句「包含（本仓库可改）：」，等于没写。改为**摘整段**并按预算显式截断。
 */
export function buildSplitTaskDescription(item, title) {
  const ref = String(item?.identifier ?? "").trim();
  const body = String(item?.description ?? "");
  const itemTitle = String(item?.title ?? "").trim() || String(title ?? "").trim();
  const scopeFull = pickLabelledBlock(body, ["范围", "改动范围"]);
  const forbidFull = pickLabelledBlock(body, ["禁止", "约束", "硬约束"]);
  const acceptance = String(item?.acceptance ?? "").trim();
  // 验收整段照搬会把正文顶出 800 字预算（-272 实测 593 字）⇒ 超过 200 字改指向验收字段，不重复粘贴。
  const accLine = acceptance === ""
    ? "需求条目未写验收 —— 开工前必须补，否则本卡无法判定完成"
    : acceptance.length <= 200
      ? acceptance
      : `见本卡「验收标准」字段（原文 ${acceptance.length} 字，此处不重复粘贴）`;

  const assemble = (scopeChars, forbidChars) => [
    `${String(title ?? "").trim()}（来自需求 ${ref || "（未命名）"}）`,
    "",
    `目标：${itemTitle}`,
    `范围：${scopeFull ? clipText(scopeFull, scopeChars) : `包含：按需求 ${ref || "（未命名）"} 正文所列落点；移出：需求之外的一切（条目未写「范围」段 —— 开工前须补）`}`,
    `禁止：AGENTS.md §3 硬禁令（不碰 :3080 运行实例 / 不改 ~/.dsh/** / 不删用户数据 / 对外动作须报批）${forbidFull ? `；本轮特禁：${clipText(forbidFull, forbidChars)}` : "；本轮特禁：未指定（开工前须补）"}`,
    "做法：1) 读需求条目正文与相关文件，先贴原文；2) 按「范围」改动，一次一处；3) 改完再贴改后原文",
    "报告：四节证据（判定 / 偏离说明 / 边界自查 / 产物路径 + sha256）",
    "停下：报错 / 超范围 / 验收不满足 / 需新变量 ⇒ 停，不重试",
    `验收：${accLine}`,
    `关联：需求 ${ref || "（未命名）"}；规范 docs/规范/07-条目详情规范.md §2.1`,
  ].join("\n");

  // 预算 800（规范 07 §4）：从宽到紧逐档收缩，**每一档都是显式截断**（带「截断」字样）。
  const caps = [[360, 220], [260, 150], [180, 100], [120, 70], [80, 50]];
  let text = "";
  for (const [scopeChars, forbidChars] of caps) {
    text = assemble(scopeChars, forbidChars);
    if (text.length <= 800) break;
  }
  return text;
}

/** 卡 `-273`（需求 `R189`）：兜底验收 —— 条目有验收就逐字沿用，没有就**显式标注缺口**（不留空）。 */
export function buildSplitTaskAcceptance(item) {
  const acceptance = String(item?.acceptance ?? "").trim();
  return acceptance || "需求条目未写验收 —— 开工前必须补";
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

/**
 * 条目详情的**完整性形态**（`R159` D-1=`c` / D-3=派生，2026-11-04 人拍）。
 *
 * 为什么是派生而不是落库：判据客观（长度 + 末字符 + 归类前缀），随数据自动更新，
 * 不需要迁移与历史回填；真要「人工豁免某一条」时再升级成字段。
 *
 * 三态（顺序有意义 —— 镜像优先，因为镜像是**设计上限**而不是事故）：
 *   · `mirror`    —— 文档镜像/归类归档条目（`【归类 YYYY-MM-DD · …】非需求条目`），正文本来就是片段；
 *   · `truncated` —— 正文被 2000 字符截断的残片（早期导入 `slice(0,2000)` 的历史损伤）；
 *   · `full`      —— 其余（含空描述：那是另一种缺口，由 `acceptanceSet` 负责，不是残片）。
 *
 * ⚠️ 只判「形状」，不读盘 ⇒ 判不出「源文已演进 / 源档缺失」（那两条要 cwd + 文件比对，
 *    只在一次性分析工具里做，见 docs/进度/2026-11-04-R159判据说明与R160范围扩写.md §A4）。
 */
export const DETAIL_STATES = Object.freeze(["full", "truncated", "mirror"]);

/** 2000 字符截断的**下界**（实测 1999/2000 都有，留 10 字符容差）。 */
export const TRUNCATED_MIN_LEN = 1990;

/** 句读/收尾字符：末字符属于它就不算被截断（`|` `>` 是 markdown 表格行尾）。 */
const SENTENCE_END_CHARS = new Set([..."。！？…；）)】」』”\"'.:;!?]`|>"]);

const MIRROR_PREFIX = /^【归类\s*\d{4}-\d{2}-\d{2}\s*·/;

/**
 * @param {string|null|undefined} description
 * @returns {"full"|"truncated"|"mirror"}
 */
export function deriveDetailState(description) {
  const text = typeof description === "string" ? description : "";
  const head = text.trimStart();
  if (MIRROR_PREFIX.test(head)) return "mirror";
  const trimmed = text.trimEnd();
  if (trimmed === "") return "full";
  if (trimmed.length >= TRUNCATED_MIN_LEN && !SENTENCE_END_CHARS.has(trimmed.at(-1))) return "truncated";
  return "full";
}
