/**
 * human-review.mjs —— 人工校验任务的判定与草案构造（FR-85）。
 *
 * 定位：FR-85 要求"自动化无法自决"时**必须**自动派发一条人工校验任务（人在环升级门），
 * 携带四要素——判定类别 / 证据 / 候选处置 / 阻塞边界；且执行侧**不得认领、不得置 done**。
 *
 * 本模块是这门"升级门"的**地基**：把四类判定与草案收敛成**可穷举的纯函数**，
 * 便于单测覆盖、便于在不碰 store/api 的前提下先定口径。**不 import 任何既有模块**（零依赖）。
 *
 * 四类判据（显式，逐条可查）：
 *   1. real-bug-blocked  真实 bug 阻塞：**同一 bug 重复复发**（复发 ≥ 2 次，或 block_loop /
 *                        repeated_crash / repeated_failure 诊断）**且**有**失败证据**（退出码 ≠ 0 或栈）
 *   2. requirement-drift 需求异化：**任务描述与需求条目 / 上游 FR 条款相互矛盾**（矛盾证据显式申报）
 *   3. architecture-change 架构变化：**实现需要改动基线架构或跨模块契约**
 *   4. upstream-mismatch 与上游需求不符：**验收口径无法满足**或**需求已被取代/作废**
 *
 * 判定纪律：**证据不足一律 `confident=false` 且 `category=null`，绝不臆断**。
 * 多类同时命中时按 `HUMAN_REVIEW_CATEGORIES` 的顺序取**首命中**（客观硬证据优先：先看"同一 bug 反复砸"，
 * 再看契约层冲突）。
 *
 * 依赖关系：FR-79（诊断条目）/ FR-80（阻断分类与复发计数）/ FR-76（待决策项）/ FR-86（阻塞影响域）。
 * 本模块只做纯函数；**派发任务、置受阻、写审计**等写库动作留给后续接线（不改本文件之外的口径）。
 */

/** 四类判定类别（**顺序即优先级**：多类同时命中时取首命中）。 */
export const HUMAN_REVIEW_CATEGORIES = Object.freeze([
  "real-bug-blocked",
  "requirement-drift",
  "architecture-change",
  "upstream-mismatch",
]);

/** 类别 → 中文标签（看板呈现与人读草案均用它）。键集必须与 HUMAN_REVIEW_CATEGORIES 完全一致。 */
export const HUMAN_REVIEW_CATEGORY_LABELS = Object.freeze({
  "real-bug-blocked": "真实 bug 阻塞",
  "requirement-drift": "需求异化",
  "architecture-change": "技术架构变化",
  "upstream-mismatch": "与上游需求不符",
});

/** 类别的中文标签；未知类别回落到类别本身（不抛错，便于前端容错）。 */
export function categoryLabel(category) {
  return HUMAN_REVIEW_CATEGORY_LABELS[String(category ?? "")] ?? (category == null ? null : String(category));
}

/** 复发阈值：同一 bug 复发到这个次数才算"反复砸"（沿用 FR-80 的人工兜底口径）。 */
export const HUMAN_REVIEW_RECURRENCE_THRESHOLD = 2;

/** 已"退出历史舞台"的需求/条款状态：命中即视为"与上游需求不符"。 */
export const SUPERSEDED_REQUIREMENT_STATUSES = Object.freeze([
  "superseded", "obsolete", "deprecated", "replaced", "cancelled", "canceled", "rejected",
]);

/** 执行侧红线（草案正文必须原样写明）。 */
export const EXECUTION_RED_LINE =
  "执行侧约束：本任务为人工校验任务，执行侧**不得认领**、**不得写 done**；结论只能由人给出。";

/**
 * 人工校验任务的**任务类型标记**（FR-85b：执行侧不可认领、不可置 done 的判定依据）。
 * 落库口径：`tasks.labels` 里带该标签（幂等迁移不新增列，老库无需回填）。
 */
export const HUMAN_REVIEW_LABEL = "human_review";

/** 判定该任务是否为人工校验任务（标签判定；传入 task 或 labels 数组均可）。 */
export function isHumanReviewTask(taskOrLabels) {
  const labels = Array.isArray(taskOrLabels) ? taskOrLabels : (taskOrLabels?.labels ?? []);
  return Array.isArray(labels) && labels.some((l) => String(l ?? "").trim() === HUMAN_REVIEW_LABEL);
}

/** 人工结论取值（FR-85 的三个出口）。 */
export const HUMAN_REVIEW_CONCLUSIONS = Object.freeze(["continue", "change-requirement", "close"]);

/** 结论 → 中文标签。 */
export const HUMAN_REVIEW_CONCLUSION_LABELS = Object.freeze({
  continue: "继续（按原口径放行下游）",
  "change-requirement": "变更需求（按新口径重开原任务）",
  close: "关闭（不再推进该任务）",
});

/** 结论标签；未知结论回落为原值（不抛错，便于前端容错）。 */
export function conclusionLabel(conclusion) {
  const key = String(conclusion ?? "");
  return HUMAN_REVIEW_CONCLUSION_LABELS[key] ?? (key || null);
}

/** 结论校验：必须在三值之内。 */
export function assertConclusion(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!HUMAN_REVIEW_CONCLUSIONS.includes(v)) {
    throw new Error(`人工结论必须是 ${HUMAN_REVIEW_CONCLUSIONS.join(" / ")} 之一，收到：${JSON.stringify(value)}`);
  }
  return v;
}

/** 结论 → 原任务/下游的放行方式（**纯函数**：接线侧照此写库，口径只此一处）。 */
export function conclusionOutcome(conclusion) {
  const key = String(conclusion ?? "").trim().toLowerCase();
  if (key === "continue") {
    return { conclusion: key, reopenOriginal: true, target: "todo", closeOriginal: false, releaseDownstream: true, note: "按原口径继续：原任务退回「可开工」重派，下游解除人工校验门。" };
  }
  if (key === "change-requirement") {
    return { conclusion: key, reopenOriginal: true, target: "todo", closeOriginal: false, releaseDownstream: false, note: "需求变更：原任务**不自动重开**（需按新口径改写需求条目/任务描述后由人重开），下游保持受阻直到按新口径放行。" };
  }
  if (key === "close") {
    return { conclusion: key, reopenOriginal: false, target: "canceled", closeOriginal: false, releaseDownstream: false, note: "关闭：原任务不推进（保持当前状态），下游保持受阻，等人工另行处置。" };
  }
  return { conclusion: null, reopenOriginal: false, target: null, closeOriginal: false, releaseDownstream: false, note: "未识别的结论：不做任何放行动作。" };
}

/** 默认阻塞边界（未显式给出影响域时的兜底；FR-86 的"关键阻塞只叫停影响域"由调用方补 downstream）。 */
export const DEFAULT_BLOCK_BOUNDARY = Object.freeze({
  scope: "self-and-downstream",
  description: "该任务自身及其下游依赖任务保持受阻；人工校验任务出结论之前，不得自动重派、不得静默推进。",
  downstream: Object.freeze([]),
  autoRetry: false,
  autoAdvance: false,
});

/**
 * 失败证据的文本特征（栈 / 断言失败 / 崩溃信号等）。
 *
 * **刻意不含「退出码 / exit code」**：退出码不能只看关键字、必须**看值**——
 * `退出码 0` 是成功。退出码一律交给下面的 `exitCodeVerdict()` 判。
 * （-75 P1：旧版把关键字当判据，「退出码 0」被判成失败证据 → 误升级。）
 */
const FAILURE_TEXT_RE =
  /(失败|报错|错误|异常|栈|堆栈|stack|traceback|assertionerror|npm\s+err|not\s+ok|segfault|panic|SIGSEGV|SIGKILL|ENOENT|EACCES)/i;
/**
 * 裸栈 / 异常名（-75 P3）：栈的常见形态就是**没有** `stack:` 前缀的
 * `TypeError: x is not a function`，以及 `at fn (file.mjs:12:3)` 这样的帧。
 * 只认**首字母大写**的 `XxxError|XxxException`，避免误伤 `noError`/`onError`/`hasError` 这类标识符。
 */
const BARE_STACK_RE =
  /(?:^|[\s("'`])[A-Z][A-Za-z0-9_$]*(?:Error|Exception)\b|\bat\s+(?:[^\s()]*\s*\()?[^\s():]*\.[A-Za-z0-9]{1,8}:\d+(?::\d+)?/;
/** 退出码（-75 P1/P2）：**带值**解析——值才是判据，别把 `退出码 0` 读成失败。 */
const EXIT_CODE_RE = /(?:退出码|退出状态|exit\s*code|exit\s*status|returncode|return\s*code|exit)\s*[:：=＝]?\s*(-?\d+)/gi;
/** "同一 bug 重复复发"的文本特征。 */
const RECURRENCE_TEXT_RE = /(复发|重复(出现|发生|报错)|再次出现|又(一次)?出现|recurr|repeat(ed|ing)?|again|第二次|第三次)/i;
/** 需求矛盾 / 冲突的文本特征。 */
const CONTRADICTION_TEXT_RE =
  /(矛盾|相悖|冲突|与需求.{0,8}不符|与(上游|需求)条款.{0,8}(不符|背离)|contradict|conflict(s|ing)?\s+with)/i;
/** 基线架构 / 跨模块契约改动的文本特征。 */
const ARCHITECTURE_TEXT_RE =
  /(架构(变化|变更|改动|调整|重设计)|基线架构|跨模块(契约|接口|边界)?|改(动|变|写).{0,6}契约|ADR|breaking\s+change)/i;
/** 验收口径不可满足 / 需求被取代的文本特征。 */
const UPSTREAM_TEXT_RE =
  /(验收口径.{0,10}(无法|不能|不可|难以)满足|需求.{0,8}(已被取代|已作废|已废弃|已变更)|上游(需求|口径|条款).{0,8}(不符|已变|变更|取代)|supersed|deprecat|obsolet)/i;

const collapsed = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

const firstString = (...vals) => {
  for (const v of vals) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

/** 把任意值安全转成有限数字（拿不到返回 null）。 */
function asNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * 归一化一条"证据/信号"。
 * 接受字符串（自由文本）或对象；对象可带 kind/type、summary、ref、exitCode、stack、contradicts 等。
 */
function normalizeEntry(entry, source) {
  if (entry == null) return null;
  if (typeof entry === "string") {
    const text = collapsed(entry);
    if (!text) return null;
    return { kind: "note", summary: text, text, ref: null, at: null, exitCode: null, stack: null, contradicts: [], source };
  }
  if (typeof entry !== "object") {
    const text = collapsed(entry);
    if (!text) return null;
    return { kind: "note", summary: text, text, ref: null, at: null, exitCode: null, stack: null, contradicts: [], source };
  }
  const kind = collapsed(entry.kind ?? entry.type ?? entry.category ?? "note") || "note";
  const summary =
    firstString(entry.summary, entry.title, entry.message, entry.detail, entry.reason, entry.body, entry.text, entry.note) ??
    `（${kind} 证据，未提供摘要）`;
  const parts = [summary, entry.detail, entry.reason, entry.message, entry.body, entry.text, entry.note]
    .filter((v) => typeof v === "string" && v.trim())
    .map(collapsed);
  const contradictsRaw = entry.contradicts ?? entry.conflictsWith ?? entry.contradictsWith ?? null;
  const contradicts = Array.isArray(contradictsRaw)
    ? contradictsRaw.map((v) => collapsed(v)).filter(Boolean)
    : (contradictsRaw ? [collapsed(contradictsRaw)] : []);
  return {
    kind: kind.toLowerCase(),
    summary,
    text: [...new Set(parts)].join(" · "),
    ref: firstString(entry.ref, entry.identifier, entry.taskRef, entry.id, entry.source),
    at: firstString(entry.at, entry.createdAt, entry.observedAt, entry.timestamp),
    exitCode: asNumber(entry.exitCode ?? entry.exit_code ?? entry.status_code ?? entry.code),
    stack: firstString(entry.stack, entry.stackTrace, entry.trace, entry.errorStack),
    contradicts,
    source,
  };
}

/** 归一化一个列表（丢掉空项 + 按 kind|summary 去重）。 */
function normalizeList(list, source) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const e = normalizeEntry(raw, source);
    if (!e) continue;
    const key = `${e.kind}|${e.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** 归一化诊断条目（FR-79）：接受单条对象或数组。 */
function normalizeDiagnoses(diagnosis) {
  const list = Array.isArray(diagnosis) ? diagnosis : (diagnosis ? [diagnosis] : []);
  return list
    .filter((d) => d && typeof d === "object")
    .map((d) => ({
      // 诊断 kind 统一成连字符形式：FR-79 用下划线（block_loop / repeated_crash），FR-85 类别用连字符。
      kind: collapsed(d.kind ?? d.type ?? "").toLowerCase().replace(/_/g, "-"),
      title: firstString(d.title, d.summary) ?? "",
      detail: firstString(d.detail, d.reason) ?? "",
      count: asNumber(d.count ?? d.recurrences ?? d.recurrence),
      ref: firstString(d.ref, d.taskRef, d.identifier),
      raw: d,
    }))
    .filter((d) => d.kind || d.title || d.detail);
}

/** 组装判定上下文（所有取数都做防御，任意字段缺失都不抛错）。 */
export function buildHumanReviewContext(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const evidence = normalizeList(src.evidence, "evidence");
  const signals = normalizeList(src.signals ?? src.signal, "signals");
  // -75 P2：**结构化退出码字段**是一等证据。上游（CLI 执行器 / 尝试记录）本来就是数字，
  // 不能要求接线方「先把数字写成一句带值的话」——那是靠约定，不是靠代码。
  // 这里把 `exitCode` / `exitCodes`（数字或数字数组）折成结构证据；
  // kind 用中性的 `exit-code`（**不用** `failure`），否则 `退出码 0` 会被"kind=failure"直接当失败，绕回 P1。
  const exitEvidence = normalizeExitCodes(
    src.exitCode ?? src.exitCodes ?? src.exit_code ?? src.exit_codes ?? src.status_code ?? src.statusCode ?? src.code,
  ).map((code) => ({ kind: "exit-code", summary: `退出码 ${code}`, text: `退出码 ${code}`, ref: null, at: null, exitCode: code, stack: null, contradicts: [], source: "exit-code" }));
  const pool = [...evidence, ...signals, ...exitEvidence];
  const task = src.task && typeof src.task === "object" ? src.task : {};
  const requirementItem = src.requirementItem && typeof src.requirementItem === "object" ? src.requirementItem : null;
  const upstreamClauses = Array.isArray(src.upstreamClauses)
    ? src.upstreamClauses.filter((c) => c && typeof c === "object")
    : [];
  return {
    task,
    requirementItem,
    upstreamClauses,
    diagnoses: normalizeDiagnoses(src.diagnosis ?? src.diagnoses),
    evidence,
    signals,
    pool,
    blockKind: src.blockKind != null ? collapsed(src.blockKind) || null : (task.blockKind ?? null),
    blockRecurrences: asNumber(src.blockRecurrences ?? src.recurrences ?? task.blockRecurrences) ?? 0,
    downstream: normalizeRefs(src.downstream ?? src.blockedDownstream ?? src.downstreamRefs),
    crossModuleContracts: normalizeRefs(src.crossModuleContracts),
    // FR-85（2026-10-18）：**显式申报**的类别（来自升级门读到的结构化声明，见 diagnostics.declarationEvidence）。
    // 它是"判定成立"的直接依据 —— 申报了哪一类，就按那一类出结论（不让关键词误判把类别抢走）。
    declaration: HUMAN_REVIEW_CATEGORIES.includes(collapsed(src.declaration ?? "").toLowerCase().replace(/_/g, "-"))
      ? collapsed(src.declaration).toLowerCase().replace(/_/g, "-")
      : null,
    flags: {
      contradiction: src.contradiction === true || src.requirementDrift === true,
      architecture: src.touchesBaselineArchitecture === true,
      crossModuleContracts: normalizeRefs(src.crossModuleContracts).length > 0,
      upstream: src.acceptanceUnsatisfiable === true,
    },
  };
}

function normalizeRefs(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((v) => collapsed(v)).filter(Boolean))];
}

/** 归一化退出码入参：接受单个数字 / 数字字符串 / 数组；丢掉非数字项（不做"猜"）。 */
function normalizeExitCodes(raw) {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((v) => (v && typeof v === "object" ? (v.exitCode ?? v.code ?? v.status_code ?? null) : v))
    .map((v) => asNumber(v))
    .filter((v) => v != null);
}

const hasText = (entry, re) => re.test(entry.text);
const kindIn = (entry, kinds) => kinds.includes(entry.kind);
const mentions = (entries, re) => entries.filter((e) => hasText(e, re));

/** 由非证据来源（诊断/状态/显式标志）合成一条证据，保证"有判定必有证据"。 */
function synth(kind, summary, { ref = null, at = null, exitCode = null } = {}) {
  return { kind, summary, text: summary, ref, at, exitCode, stack: null, contradicts: [], source: "synthesized" };
}

/**
 * 退出码判定（-75 P1/P2）。
 *
 * @returns {boolean|null} `true`=非零（=失败证据）· `false`=**显式为零**（成功，绝不当作失败证据）· `null`=未提及（交给其它判据）
 *
 * 结构化 `exitCode` 数值字段优先（上游执行器 / 尝试记录本来就是数字）；
 * 文本路径必须**带值**才算数 —— 只有"出现退出码这个词"不构成失败证据。
 */
function exitCodeVerdict(entry) {
  if (entry?.exitCode != null) return Number(entry.exitCode) !== 0;
  const text = String(entry?.text ?? "");
  EXIT_CODE_RE.lastIndex = 0;
  let m;
  let sawAny = false;
  let sawNonZero = false;
  while ((m = EXIT_CODE_RE.exec(text)) !== null) {
    sawAny = true;
    if (Number(m[1]) !== 0) sawNonZero = true;
  }
  if (!sawAny) return null;
  return sawNonZero;
}

/**
 * ① 真实 bug 阻塞：同一 bug 重复复发 **且** 有失败证据（退出码 / 栈）。
 * 只有一边（只复发没证据 / 只有一次失败）→ 不命中，走"证据不足"降级。
 */
function detectRealBugBlocked(ctx) {
  // kind 比对用**连字符**形态：`normalizeDiagnoses` 已把 FR-79 的下划线写法（block_loop / …）归一化成连字符，
  // 此处**不要**再反向归一化一次（2026-10-18 复核：那一层是冗余的）。
  const recDiag = ctx.diagnoses.filter((d) => ["block-loop", "repeated-crash", "repeated-failure"].includes(d.kind));
  const recEntries = ctx.pool.filter(
    (e) =>
      kindIn(e, ["recurrence", "repeat", "repeated", "same-bug", "block-loop", "repeat-failure"]) ||
      hasText(e, RECURRENCE_TEXT_RE),
  );
  const recurrence = [];
  if (ctx.blockRecurrences >= HUMAN_REVIEW_RECURRENCE_THRESHOLD) {
    recurrence.push(
      synth("recurrence", `同一 bug 已复发 ${ctx.blockRecurrences} 次（阈值 ${HUMAN_REVIEW_RECURRENCE_THRESHOLD}）${ctx.blockKind ? `，阻断类型=${ctx.blockKind}` : ""}`),
    );
  }
  for (const d of recDiag) {
    const n = d.count ?? null;
    recurrence.push(
      synth(
        "recurrence",
        `诊断「${d.kind}」${n != null && n >= HUMAN_REVIEW_RECURRENCE_THRESHOLD ? `计数 ${n}` : ""}${d.title ? `：${d.title}` : ""}${d.detail ? `（${collapsed(d.detail)}）` : ""}`.trim(),
        { ref: d.ref },
      ),
    );
  }
  recurrence.push(...recEntries);

  const failure = ctx.pool.filter(
    (e) =>
      exitCodeVerdict(e) === true ||                      // -75 P1/P2：退出码**非零**才算失败（结构化字段或带值文本）
      Boolean(e.stack) ||
      BARE_STACK_RE.test(String(e.text ?? "")) ||         // -75 P3：裸栈/异常名（`TypeError: ...`、`at f (x.mjs:1:2)`）
      kindIn(e, ["failure", "error", "crash", "failed-test", "test-failure", "exception"]) ||
      hasText(e, FAILURE_TEXT_RE),
  );
  const failDiag = ctx.diagnoses.filter((d) => ["repeated-crash", "repeated-failure"].includes(d.kind));
  for (const d of failDiag) {
    failure.push(synth("failure", `诊断「${d.kind}」为失败类：${d.title || collapsed(d.detail) || d.kind}`, { ref: d.ref }));
  }

  const matched = recurrence.length > 0 && failure.length > 0;
  return {
    category: "real-bug-blocked",
    matched,
    evidence: dedupe([...recurrence, ...failure]),
    reasons: matched
      ? [
          `同一 bug 重复复发（${recurrence.length} 条复发证据）`,
          `有失败证据（${failure.length} 条：退出码/栈/失败记录）`,
        ]
      : [],
    missing: [
      ...(recurrence.length ? [] : [`同一 bug 重复复发（复发 ≥ ${HUMAN_REVIEW_RECURRENCE_THRESHOLD} 次，或 block_loop/repeated_crash/repeated_failure 诊断）`]),
      ...(failure.length ? [] : ["失败证据（退出码 ≠ 0 或栈）"]),
    ],
    observed: { recurrence: recurrence.length, failure: failure.length },
  };
}

/** ② 需求异化：任务描述与需求条目 / 上游 FR 条款**相互矛盾**（矛盾必须是显式申报的证据）。 */
function detectRequirementDrift(ctx) {
  const contradiction = ctx.pool.filter(
    (e) => kindIn(e, ["contradiction", "conflict", "requirement-drift", "drift", "mismatch"]) || e.contradicts.length > 0 || hasText(e, CONTRADICTION_TEXT_RE),
  );
  const driftDiag = ctx.diagnoses.filter((d) => d.kind === "requirement-drift");
  const evidence = [...contradiction];
  for (const d of driftDiag) {
    evidence.push(synth("contradiction", `诊断「requirement_drift」：${d.title || collapsed(d.detail) || "需求异化"}`, { ref: d.ref }));
  }
  if (ctx.flags.contradiction) {
    evidence.push(synth("contradiction", "调用方显式申报：任务口径与需求条目相互矛盾"));
  }
  const itemRef = ctx.requirementItem?.identifier ?? ctx.requirementItem?.ref ?? null;
  const matched = evidence.length > 0;
  return {
    category: "requirement-drift",
    matched,
    evidence: dedupe(evidence),
    reasons: matched
      ? [`任务描述与需求条目/上游 FR 条款相互矛盾（${evidence.length} 条矛盾证据${itemRef ? `，涉及需求条目 ${itemRef}` : ""}）`]
      : [],
    missing: matched ? [] : ["任务描述与需求条目/上游 FR 条款相互矛盾（需显式矛盾证据：contradicts 字段或矛盾类信号）"],
    observed: { contradiction: contradiction.length },
  };
}

/** ③ 架构变化：实现需要改动**基线架构**或**跨模块契约**。 */
function detectArchitectureChange(ctx) {
  const arch = ctx.pool.filter(
    (e) => kindIn(e, ["architecture", "architecture-change", "baseline-architecture", "cross-module-contract", "contract-change", "structural"]) || hasText(e, ARCHITECTURE_TEXT_RE),
  );
  const diag = ctx.diagnoses.filter((d) => d.kind === "architecture-change");
  const evidence = [...arch];
  for (const d of diag) {
    evidence.push(synth("architecture", `诊断「architecture_change」：${d.title || collapsed(d.detail) || "架构变化"}`, { ref: d.ref }));
  }
  if (ctx.flags.architecture) evidence.push(synth("architecture", "调用方显式申报：实现需要改动基线架构"));
  if (ctx.flags.crossModuleContracts) {
    evidence.push(synth("cross-module-contract", `涉及跨模块契约改动：${(ctx.crossModuleContracts ?? []).join("、")}`.trim()));
  }
  const matched = evidence.length > 0;
  return {
    category: "architecture-change",
    matched,
    evidence: dedupe(evidence),
    reasons: matched ? [`实现需要改动基线架构或跨模块契约（${evidence.length} 条架构证据）`] : [],
    missing: matched ? [] : ["实现需要改动基线架构或跨模块契约"],
    observed: { architecture: arch.length },
  };
}

/** ④ 与上游需求不符：**验收口径无法满足**或**需求已被取代**。 */
function detectUpstreamMismatch(ctx) {
  const up = ctx.pool.filter(
    (e) => kindIn(e, ["upstream-mismatch", "acceptance-unsatisfiable", "superseded", "replaced", "obsolete", "deprecated"]) || hasText(e, UPSTREAM_TEXT_RE),
  );
  const diag = ctx.diagnoses.filter((d) => d.kind === "upstream-mismatch");
  const evidence = [...up];
  for (const d of diag) {
    evidence.push(synth("upstream-mismatch", `诊断「upstream_mismatch」：${d.title || collapsed(d.detail) || "与上游需求不符"}`, { ref: d.ref }));
  }
  if (ctx.flags.upstream) evidence.push(synth("acceptance-unsatisfiable", "调用方显式申报：验收口径无法满足"));

  const itemStatus = collapsed(ctx.requirementItem?.status ?? "").toLowerCase();
  if (SUPERSEDED_REQUIREMENT_STATUSES.includes(itemStatus)) {
    evidence.push(
      synth("superseded", `需求条目 ${ctx.requirementItem.identifier ?? ctx.requirementItem.id ?? ""} 状态为 ${itemStatus}（已被取代/作废）`.trim()),
    );
  }
  for (const c of ctx.upstreamClauses) {
    const st = collapsed(c.status ?? "").toLowerCase();
    if (!SUPERSEDED_REQUIREMENT_STATUSES.includes(st)) continue;
    evidence.push(synth("superseded", `上游条款 ${c.ref ?? c.identifier ?? c.id ?? ""} 状态为 ${st}（已被取代/作废）`.trim()));
  }

  const matched = evidence.length > 0;
  return {
    category: "upstream-mismatch",
    matched,
    evidence: dedupe(evidence),
    reasons: matched ? [`验收口径无法满足或需求已被取代（${evidence.length} 条上游不符证据）`] : [],
    missing: matched ? [] : ["验收口径无法满足或需求已被取代（含需求/条款状态为 superseded）"],
    observed: { upstream: up.length },
  };
}

function dedupe(entries) {
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (!e || !e.summary) continue;
    const key = `${e.kind}|${e.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/** 四类判据的求值顺序（= HUMAN_REVIEW_CATEGORIES 顺序 = 优先级）。 */
const DETECTORS = Object.freeze([
  detectRealBugBlocked,
  detectRequirementDrift,
  detectArchitectureChange,
  detectUpstreamMismatch,
]);

/** 类别 → 候选处置（候选**不是**自动动作：全部 needsHuman=true，等人拍板）。 */
export const CANDIDATE_ACTIONS = Object.freeze({
  "real-bug-blocked": Object.freeze([
    { id: "fix-then-reopen", label: "人确认修复方案后重开原任务", detail: "先定位同一 bug 的根因并给出修复方案，人确认后清复发计数、重开原任务。", needsHuman: true },
    { id: "change-approach", label: "更换实现路径或降级依赖", detail: "同一路径反复失败时，改走等价实现或换依赖版本，避免在死路上重试。", needsHuman: true },
    { id: "adjust-acceptance", label: "调整验收口径（若 bug 系环境导致）", detail: "若失败证据表明是环境/工具链问题而非真实 bug，需人改验收口径后重开。", needsHuman: true },
    { id: "escalate-capability", label: "转派给具备该能力的执行者", detail: "若属能力缺口（capability），换执行者或换执行器后重开。", needsHuman: true },
  ]),
  "requirement-drift": Object.freeze([
    { id: "follow-requirement", label: "以需求条目为准，改写任务描述后重开", detail: "任务口径偏离需求条目：按需求条目改写任务描述（保留原始证据）再重开。", needsHuman: true },
    { id: "amend-requirement", label: "以任务为准，修订需求条目并留变更记录", detail: "若实现过程中确认需求该变，走需求变更（新增变更记录、不改历史条款原文）后重开。", needsHuman: true },
    { id: "split-conflict", label: "把冲突部分拆成新任务", detail: "原任务先按无争议部分推进，冲突部分单独立项后再定。", needsHuman: true },
  ]),
  "architecture-change": Object.freeze([
    { id: "approve-architecture", label: "先立项架构变更，再回填任务", detail: "改动基线架构/跨模块契约需先出方案（ADR/评审）并获人批准，之后按新口径重开任务。", needsHuman: true },
    { id: "narrow-scope", label: "缩小实现范围以绕开架构改动", detail: "在不动基线架构的前提下找到最小可用实现，作为过渡方案。", needsHuman: true },
    { id: "review-then-reopen", label: "走评审门后再重开", detail: "把架构改动提交评审；评审通过前该任务及其下游保持受阻。", needsHuman: true },
  ]),
  "upstream-mismatch": Object.freeze([
    { id: "reopen-under-upstream", label: "按上游新口径重开原任务（保留原始证据）", detail: "上游条款已变更/被取代：按新口径重建验收标准后重开，旧的尝试与证据只做保留不做删除。", needsHuman: true },
    { id: "request-clarification", label: "请求上游澄清或等待上游定稿", detail: "上游口径本身未定：向人（上游）发起澄清，未定稿前不自动推进。", needsHuman: true },
    { id: "close-as-superseded", label: "关闭任务并标注取代关系", detail: "若该任务已被上游需求取代，标注取代关系后关闭（不置 done，走人工结论）。", needsHuman: true },
  ]),
});

/** 取某类别的候选处置（拷贝，避免调用方改到常量）。 */
export function candidateActionsFor(category) {
  const list = CANDIDATE_ACTIONS[String(category ?? "")] ?? [];
  return list.map((a) => ({ ...a, category: String(category) }));
}

/** 由判定上下文求"阻塞边界"（保留调用方给的 downstream；缺省见 DEFAULT_BLOCK_BOUNDARY）。 */
export function resolveBlockBoundary(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const downstream = normalizeRefs(src.downstream ?? src.blockedDownstream ?? src.downstreamRefs);
  const explicit = typeof src.blockBoundary === "string" ? collapsed(src.blockBoundary) : (src.blockBoundary && typeof src.blockBoundary === "object" ? src.blockBoundary : null);
  const base = {
    scope: explicit?.scope ?? (downstream.length ? "self-and-downstream" : DEFAULT_BLOCK_BOUNDARY.scope),
    description: explicit?.description ?? DEFAULT_BLOCK_BOUNDARY.description,
    downstream,
    autoRetry: false,
    autoAdvance: false,
  };
  if (explicit?.autoRetry === true || explicit?.autoAdvance === true) {
    // 人工校验未结论前**不允许**自动重派/推进：显式要求也被拒绝（红线优先）。
    base.rejectedAutoFlags = true;
  }
  return base;
}

/** 阻塞边界 → 可读文本（草案正文第四段）。 */
export function blockBoundaryText(boundary) {
  const b = boundary && typeof boundary === "object" ? boundary : {};
  const downstream = Array.isArray(b.downstream) ? b.downstream.filter(Boolean) : [];
  const lines = [
    `影响域=${b.scope ?? DEFAULT_BLOCK_BOUNDARY.scope}`,
    collapsed(b.description) || DEFAULT_BLOCK_BOUNDARY.description,
    downstream.length ? `被卡住的下游任务：${downstream.join("、")}` : "被卡住的下游任务：以依赖图解析（本草案未携带明细）",
    "自动重派：禁止；自动推进：禁止；人工校验出结论后由人放行。",
  ];
  return lines.join("\n");
}

/**
 * 四类判定（纯函数）。
 *
 * @param {object} input
 *   · diagnosis     FR-79 诊断条目（对象或数组）
 *   · blockKind     FR-80 阻断分类
 *   · signals       自由文本/证据数组（字符串或对象）
 *   · evidence      证据列表（对象：kind/summary/ref/exitCode/stack/contradicts…）
 *   · 可选：task / requirementItem / upstreamClauses / blockRecurrences / downstream /
 *          contradiction / touchesBaselineArchitecture / crossModuleContracts / acceptanceUnsatisfiable
 * @returns {{category:string|null, confident:boolean, confidenceReason:string, evidence:object[], candidateActions:object[], categoryLabel:string|null, missing:string[], observed:object}}
 */
export function classifyHumanReview(input = {}) {
  const ctx = buildHumanReviewContext(input);
  const evaluations = DETECTORS.map((fn) => fn(ctx));
  // FR-85（2026-10-18）：**显式申报优先** —— 申报本身即"判定成立"，
  // 按申报类别出结论，避免申报正文里的关键词把类别判到别的 detector 去（例如"架构变化"正文里写了"矛盾"）。
  const declared = ctx.declaration ? (evaluations.find((e) => e.category === ctx.declaration) ?? null) : null;
  const hit = declared
    ? { ...declared, matched: true, reasons: [`人工校验显式申报：${categoryLabel(declared.category)}`, ...declared.reasons], missing: [] }
    : (evaluations.find((e) => e.matched && e.evidence.length > 0) ?? null);

  if (!hit) {
    const observed = {
      failure: evaluations[0].observed.failure,
      recurrence: evaluations[0].observed.recurrence,
      contradiction: evaluations[1].observed.contradiction,
      architecture: evaluations[2].observed.architecture,
      upstream: evaluations[3].observed.upstream,
    };
    const seenAnything = Object.values(observed).some((n) => n > 0);
    const confidenceReason = [
      "证据不足：四类判据均未命中，category=null（不臆断）。",
      seenAnything
        ? `已观察到：失败证据 ${observed.failure} 条 / 复发证据 ${observed.recurrence} 条 / 需求矛盾证据 ${observed.contradiction} 条 / 架构证据 ${observed.architecture} 条 / 上游不符证据 ${observed.upstream} 条。`
        : "输入未提供任何可用证据或信号。",
      `未满足的关键条件：${evaluations.map((e) => `${categoryLabel(e.category)}=${e.missing[0]}`).join("；")}。`,
    ].join(" ");
    return {
      category: null,
      categoryLabel: null,
      confident: false,
      confidenceReason,
      evidence: dedupe(ctx.pool),
      candidateActions: [],
      missing: evaluations.flatMap((e) => e.missing),
      observed,
    };
  }

  const otherHits = evaluations.filter((e) => e.matched && e.category !== hit.category).map((e) => categoryLabel(e.category));
  const confidenceReason = [
    `判为「${categoryLabel(hit.category)}」：${hit.reasons.join("；")}。`,
    otherHits.length ? `另有同类命中（未取用，按优先级取首命中）：${otherHits.join("、")}。` : "",
    hit.category === "real-bug-blocked" && ctx.blockKind ? `阻断类型=${ctx.blockKind}（FR-80）。` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    category: hit.category,
    categoryLabel: categoryLabel(hit.category),
    confident: true,
    confidenceReason,
    evidence: hit.evidence,
    candidateActions: candidateActionsFor(hit.category),
    missing: [],
    observed: {
      failure: evaluations[0].observed.failure,
      recurrence: evaluations[0].observed.recurrence,
      contradiction: evaluations[1].observed.contradiction,
      architecture: evaluations[2].observed.architecture,
      upstream: evaluations[3].observed.upstream,
    },
  };
}

/** 证据 → 草案正文行。 */
function evidenceLines(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  if (!list.length) return ["（无）"];
  return list.map((e, i) => {
    const bits = [`[${e.kind ?? "note"}]`, e.summary ?? collapsed(e.text) ?? "（无摘要）"];
    if (e.ref) bits.push(`来源=${e.ref}`);
    if (e.at) bits.push(`时间=${e.at}`);
    if (e.exitCode != null) bits.push(`退出码=${e.exitCode}`);
    if (e.stack) bits.push(`栈=${collapsed(e.stack).slice(0, 160)}`);
    return `${i + 1}. ${bits.join(" ")}`;
  });
}

/** 候选处置 → 草案正文行。 */
function actionLines(actions) {
  const list = Array.isArray(actions) ? actions : [];
  if (!list.length) return ["（无）"];
  return list.map((a, i) => `${i + 1}. ${a.label ?? a.id}${a.detail ? `：${a.detail}` : ""}（需人决策）`);
}

/**
 * 构造 `human_review` 任务草案（纯函数，不落库）。
 *
 * `input` 可直接是 classifyHumanReview 的入参（内含 task/description 等），
 * 也可显式传 `input.classification`（已判定结果）以复用同一次判定。
 * **判定不置信时抛错**——证据不足不得构造人工校验任务（FR-85：绝不臆断）。
 *
 * @returns {{title:string, description:string, category:string, categoryLabel:string,
 *            evidence:object[], candidateActions:object[], blockBoundary:object, forbiddenForExecution:true}}
 */
export function buildHumanReviewDraft(input = {}) {
  const src = input && typeof input === "object" ? input : {};
  const classification = src.classification && typeof src.classification === "object" ? src.classification : classifyHumanReview(src);
  if (!classification.confident || !classification.category) {
    throw new Error(`证据不足，不得构造人工校验任务草案：${classification.confidenceReason ?? "四类判据均未命中"}`);
  }
  const category = classification.category;
  const label = categoryLabel(category);
  const task = src.task && typeof src.task === "object" ? src.task : {};
  const taskRef = firstString(task.identifier, src.taskRef, src.identifier, src.ref) ?? "（未标明任务）";
  const taskTitle = firstString(task.title, src.title, src.taskTitle) ?? "";
  const evidence = dedupe(Array.isArray(classification.evidence) ? classification.evidence : []);
  const candidateActions = Array.isArray(classification.candidateActions) && classification.candidateActions.length
    ? classification.candidateActions
    : candidateActionsFor(category);
  const blockBoundary = resolveBlockBoundary({ ...src, blockBoundary: src.blockBoundary ?? src.boundary });

  const title = `【人工校验】${label} · ${taskRef}${taskTitle ? ` ${taskTitle}` : ""}`;
  const description = [
    "【人工校验任务（FR-85 人在环升级门）】",
    `原任务：${taskRef}${taskTitle ? `（${taskTitle}）` : ""}`,
    `判定结论：${label}（category=${category}）`,
    "",
    "一、判定类别",
    `${label}（category=${category}）`,
    `判定依据：${classification.confidenceReason}`,
    "",
    "二、证据",
    evidenceLines(evidence).join("\n"),
    "",
    "三、候选处置",
    actionLines(candidateActions).join("\n"),
    "",
    "四、阻塞边界",
    blockBoundaryText(blockBoundary),
    "",
    EXECUTION_RED_LINE,
    "人工校验出结论后，请据结论放行原任务（保留原始证据，不删除既有尝试记录）。",
  ].join("\n");

  return {
    title,
    description,
    category,
    categoryLabel: label,
    evidence,
    candidateActions,
    blockBoundary,
    forbiddenForExecution: true,
  };
}

const nonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;

/**
 * 校验 `human_review` 草案四要素（FR-85 验收）。
 * 缺**类别 / 证据 / 候选处置 / 阻塞边界**任一项即 `ok=false` 且 errors 说明缺哪一项。
 *
 * @returns {{ok:boolean, errors:string[]}}
 */
export function validateHumanReviewDraft(draft) {
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) {
    return { ok: false, errors: ["draft 必须是对象"] };
  }
  const errors = [];
  const category = String(draft.category ?? "").trim();
  if (!category) errors.push("缺少判定类别：category 必填");
  else if (!HUMAN_REVIEW_CATEGORIES.includes(category)) {
    errors.push(`判定类别非法：category 必须是 ${HUMAN_REVIEW_CATEGORIES.join(" / ")} 之一（当前 ${category}）`);
  }

  const evidence = Array.isArray(draft.evidence)
    ? draft.evidence.filter((e) => (nonEmptyStr(e) ? true : Boolean(e && typeof e === "object" && (nonEmptyStr(e.summary) || nonEmptyStr(e.text) || nonEmptyStr(e.kind)))))
    : [];
  if (evidence.length === 0) errors.push("缺少证据：evidence 至少 1 条（判定不得无凭）");

  const actions = Array.isArray(draft.candidateActions)
    ? draft.candidateActions.filter((a) => a && typeof a === "object" && (nonEmptyStr(a.id) || nonEmptyStr(a.label)))
    : [];
  if (actions.length === 0) errors.push("缺少候选处置：candidateActions 至少 1 条");

  const boundary = draft.blockBoundary;
  const boundaryOk =
    nonEmptyStr(boundary) ||
    (Boolean(boundary) && typeof boundary === "object" && !Array.isArray(boundary) && (nonEmptyStr(boundary.description) || nonEmptyStr(boundary.scope)));
  if (!boundaryOk) errors.push("缺少阻塞边界：blockBoundary 必须是非空字符串，或含 description/scope 的对象");

  if (draft.forbiddenForExecution === false) {
    errors.push("执行侧红线被破坏：forbiddenForExecution 不得为 false（执行侧不得认领、不得置 done）");
  }

  return { ok: errors.length === 0, errors };
}

/** 便捷入口：判定 + 构造 + 校验一次到位（判定不置信时抛错，同 buildHumanReviewDraft）。 */
export function planHumanReview(input = {}) {
  const classification = classifyHumanReview(input);
  const draft = buildHumanReviewDraft({ ...input, classification });
  const validation = validateHumanReviewDraft(draft);
  return { classification, draft, validation };
}

export default { classifyHumanReview, buildHumanReviewDraft, validateHumanReviewDraft, planHumanReview };
