/**
 * diagnostics.mjs —— 可操作诊断框架（FR-79）。
 *
 * 设计对齐 hermes `Diagnostic / DiagnosticAction`（见 设计/hermes-kanban评估-2026-10-16.md §6.4）：
 *   · 每条诊断 = 类型(kind) + 严重度(severity) + 标题 + 说明 + 恢复动作(可多条，标首选) + suggested
 *   · 诊断只在"人能处理"时出现（看护规则命中才产出）；问题消失即自动消解（落库时收口）
 *   · 同一问题持续 → count / last_seen_at 递增，不重复刷屏（同一 kind 只留一条）
 *   · 卡片只带 {count, kinds, highestSeverity} 摘要；详情带完整列表（一次请求取回）
 *
 * 本模块只做纯规则 + 只读上下文装配；写库统一交给 store.saveTaskDiagnostics()，
 * 这样规则可单测、可回放，也不产生与 store.mjs 的循环依赖（store 不反向 import 本模块）。
 */
import { BLOCK_RECURRENCE_LIMIT, DEFAULT_FAILURE_LIMIT, QUOTA_AUTH_ERROR_RE } from "./store.mjs";
import { STALL_THRESHOLD_MS, assessTask, latestProgressComment, runInFlight } from "./watchdog.mjs";
import { REVIEW_IDLE_MS, detectReviewDeadlock } from "./review.mjs";
import { categoryLabel, classifyHumanReview, isHumanReviewTask } from "./human-review.mjs";
import { detectUntakenDelivery } from "./delivery.mjs";

/** 诊断类型（FR-79 验收里逐个点名的八类规则）。 */
export const DIAGNOSTIC_KINDS = Object.freeze([
  "stalled", "awaiting_decision", "repeated_failure", "repeated_crash",
  "stuck_blocked", "block_loop", "unclaimed", "review_deadlock",
  "human_review_required",
  // 2026-10-22 补口：把「投递到会话但没交作业」从**静默回收**变成**可见 + 有恢复动作**。
  "delivery_untaken",
]);

/** 严重度取值；high 最重（UI 用它排序与着色）。 */
export const DIAGNOSTIC_SEVERITIES = Object.freeze(["high", "medium", "low"]);
export const SEVERITY_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });

/**
 * FR-85 升级门的**显式申报**通道（2026-10-18 真机补）。
 *
 * 背景：四类情形里「真实 bug 阻塞」能靠运行痕迹（复发 + 失败证据）自动判定，
 * 但「需求异化 / 技术架构变化 / 与上游需求不符」这三类**没有任何可持久化来源** ——
 * 真机实测：即便把最明确的申报写进任务评论，升级门仍回 400「输入未提供任何可用证据或信号」，
 * 即 FR-85 的四类里只有一类真正可达。
 *
 * 口径：**只认这一种机器可读写法** —— 评论里出现 `【人工校验申报】` 且随带 `类别=<四类之一>`。
 * 评论的**自由正文一律不当证据**（原有决策不变：否则一句"退出码 0"的评论就能造出误升级）；
 * 因此这里读的是**结构化声明**，不是散文，既不违反红线，也让三类情形重新可达。
 *
 * 写法（任选一行放在评论正文里即可）：
 *   【人工校验申报】类别=需求异化；证据=<与哪条需求条目/上游条款如何矛盾>
 *   【人工校验申报】类别=架构变化；证据=<要改哪块基线架构/跨模块契约>
 *   【人工校验申报】类别=与上游需求不符；证据=<哪条验收口径无法满足/需求已被取代>
 */
export const HUMAN_REVIEW_DECLARATION_MARKER = "【人工校验申报】";
/** 申报类别（中/英/下划线三种写法都认）→ 与 `classifyHumanReview` 四类判定一一对应。 */
export const HUMAN_REVIEW_DECLARATION_CATEGORIES = Object.freeze({
  "需求异化": "requirement-drift", "requirement-drift": "requirement-drift", "requirement_drift": "requirement-drift",
  "架构变化": "architecture-change", "技术架构变化": "architecture-change",
  "architecture-change": "architecture-change", "architecture_change": "architecture-change",
  "与上游需求不符": "upstream-mismatch", "上游不符": "upstream-mismatch",
  "upstream-mismatch": "upstream-mismatch", "upstream_mismatch": "upstream-mismatch",
});
/** 申报可映射到的三个类别（`real-bug-blocked` 不靠申报 —— 它由复发 + 失败证据自动判定）。 */
const DECLARABLE_CATEGORIES = new Set(["requirement-drift", "architecture-change", "upstream-mismatch"]);

const collapse = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/**
 * 从评论里抽出**显式申报**证据（纯函数，只认标记，不猜散文）。
 * 返回结构化证据：`kind` = 四类之一（下游判定器按 kind 精确命中），`ref` = 评论 id（可回溯原文）。
 */
export function declarationEvidence(comments = []) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    const text = String(c?.body ?? "");
    const at = text.indexOf(HUMAN_REVIEW_DECLARATION_MARKER);
    if (at < 0) continue;
    const tail = text.slice(at + HUMAN_REVIEW_DECLARATION_MARKER.length);
    const m = /类别\s*[=:：]\s*([^\n；;，,]+)/.exec(tail);
    const raw = collapse(m ? m[1] : "");
    const kind = HUMAN_REVIEW_DECLARATION_CATEGORIES[raw] ?? HUMAN_REVIEW_DECLARATION_CATEGORIES[raw.toLowerCase()] ?? null;
    const body = collapse(tail).slice(0, 300);
    out.push({
      kind: kind ?? "human-review-declaration",
      summary: kind ? `人工校验显式申报（${raw}）：${body}` : `人工校验显式申报（未识别类别「${raw}」）：${body}`,
      text: body,
      ref: c?.id ?? null,
      at: c?.createdAt ?? null,
    });
  }
  return out;
}

/**
 * FR-85 升级门「已结论」水位线（2026-10-19 真机补）。
 *
 * 现场：任务 `taskboard-workbench-90` 的申报评论（`【人工校验申报】类别=与上游需求不符`）已按门径落了卡
 * `-91`，人也给出了结论 `continue`（`-91` → `canceled`）。但**申报评论永远留在评论历史里**，而
 * `human_review_required` 的幂等只对「**待结论**」的同类卡去重 ⇒ 结论之后诊断照旧每轮产出，
 * 它给的**主按钮还会再造一张同类卡**（`createHumanReviewTask` 同样只挡 pending）—— 这扇门再也关不上。
 *
 * 口径（最小改动、不削弱 FR-85）：只有当本次判定**由申报评论驱动**、且该申报**不晚于**同类别的结论时，
 * 才算「人已经就这条证据回答过」→ 不再提示、不得再造卡。**结论之后又出现更新的申报**（新证据）则门重新成立；
 * 由**运行痕迹**驱动的类别（如 `real-bug-blocked`）**不适用**本水位线 —— 那是「又坏了一次」，本就应该重新升级。
 *
 * @returns 命中的那张已结论人工校验任务；未命中返回 `null`。
 */
export function humanReviewAnsweredBy(classification, declarations = [], concluded = []) {
  const category = classification?.category ?? null;
  if (!category) return null;
  const declAt = (Array.isArray(declarations) ? declarations : [])
    .filter((d) => d && DECLARABLE_CATEGORIES.has(d.kind))
    .map((d) => Date.parse(String(d.at ?? "")))
    .filter((t) => Number.isFinite(t))
    .reduce((a, b) => Math.max(a, b), -Infinity);
  if (!Number.isFinite(declAt)) return null;
  const rows = (Array.isArray(concluded) ? concluded : [])
    .filter((t) => (t?.humanReviewCategory ?? null) === category)
    .map((t) => ({ t, at: Date.parse(String(t?.humanReviewConcludedAt ?? t?.updatedAt ?? "")) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => b.at - a.at);
  if (!rows.length) return null;
  return declAt <= rows[0].at ? rows[0].t : null;
}

/** 阈值（可被调用方覆盖，便于单测与真机调参）。 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** 停滞：沿用 FR-75 的 10 分钟口径。 */
  stallMs: STALL_THRESHOLD_MS,
  /** 卡在受阻：默认 1 小时无人处理才算"卡住"（低于此值只是正常等待）。 */
  blockedMs: 60 * 60 * 1000,
  /** 循环阻断：复发阈值沿用 FR-80。 */
  recurrenceLimit: BLOCK_RECURRENCE_LIMIT,
  /** 评审停摆：无人评审多久算死锁（FR-83）。 */
  reviewIdleMs: REVIEW_IDLE_MS,
});

/** 崩溃类错误特征（"重复崩溃"规则的兜底判据）。 */
export const CRASH_ERROR_RE = /\b(segfault|crash(ed)?|panic|killed|SIGKILL|SIGSEGV|OOM|out of memory|exit code|ENOENT|ELIFECYCLE|EPERM|EACCES)\b/i;

const encodeRef = (ref) => encodeURIComponent(String(ref));

/** 构造一条恢复动作（UI 可直接按 method/path/body 渲染成按钮）。 */
function action(id, label, { kind = "secondary", method = "POST", path = null, body = null, hint = null, needs = null } = {}) {
  return { id, label, kind, method, path, body, hint, needs };
}

/**
 * 会话引用解析（FR-84）：任务自身会话 → 项目主会话 → 项目已关联会话（排除 rejected，取最新）。
 * 返回 `{ sessionId, source, projectId }`；三级都拿不到时 `sessionId === null`。
 */
export function resolveSessionRef(store, task) {
  const own = task?.sessionId ?? null;
  if (own) return { sessionId: own, source: "task", projectId: task?.projectId ?? null };
  const project = (typeof store?.getProject === "function" && task?.projectId) ? store.getProject(task.projectId) ?? null : null;
  if (project?.initialSessionId) return { sessionId: project.initialSessionId, source: "project-main", projectId: project.id };
  const bound = (typeof store?.listProjectSessions === "function" && task?.projectId)
    ? (store.listProjectSessions(task.projectId).filter((row) => row.sessionId && row.status !== "rejected").at(-1) ?? null)
    : null;
  if (bound) return { sessionId: bound.sessionId, source: "project-bound", projectId: task.projectId };
  return { sessionId: null, source: null, projectId: task?.projectId ?? null };
}

/**
 * 会话类动作（FR-84）：**有可解析会话才产出「打开执行会话」**；
 * 一个都解析不到时改为「重建并绑定项目主会话」——避免产出空会话标识的打开动作
 * （真机事故：点「打开执行会话」→ "无法自动打开，已复制会话标识：-"）。
 */
function sessionActions(ctx, { kind = "secondary", label = "打开执行会话" } = {}) {
  const ref = ctx.task.identifier;
  const sid = ctx.sessionRef?.sessionId ?? null;
  if (sid) return [action("open_session", label, { kind, path: `/api/tasks/${encodeRef(ref)}/open-session`, hint: `会话来源：${ctx.sessionRef?.source ?? "task"}` })];
  const projectId = ctx.sessionRef?.projectId ?? ctx.task.projectId ?? null;
  if (!projectId) return [];
  return [action("bind_session", "重建并绑定项目主会话", {
    kind,
    path: `/api/projects/${encodeRef(projectId)}/sessions/rebind`,
    body: { confirm: true },
    hint: "任务与项目都无可用会话引用：先重建主会话再谈打开",
  })];
}

/** 恢复动作的公共部分：绝大多数诊断都能"退回待办重派 / 打开（或重建）会话 / 标记失败"。 */
function commonActions(ctx, { retryLabel = "退回待办（重新派发）", retryHint = null } = {}) {
  const enc = encodeRef(ctx.task.identifier);
  return [
    action("retry", retryLabel, { kind: "secondary", path: `/api/tasks/${enc}/execution/retry`, hint: retryHint }),
    ...sessionActions(ctx),
    action("fail", "标记失败（留证据）", { path: `/api/tasks/${enc}/execution/fail` }),
  ];
}

/** 人工忽略留痕标记：`已忽略诊断「<kind>」…`（FR-79「忽略即消解且保留原文可回溯」）。 */
const DISMISS_RE = /已忽略诊断[「"]?([a-zA-Z_]+)/;

/**
 * 已被人工忽略的诊断类型（且忽略发生在最近一次进展之后）。
 * 口径：忽略留痕比"最近一次有进展意义的评论"更新 → 该项不再产出；
 * 一旦出现更新的进展评论（说明情形已变），诊断重新生效。
 */
export function dismissedKinds(comments = []) {
  const last = latestProgressComment(comments);
  const lastAt = last?.createdAt ? new Date(last.createdAt).getTime() : -Infinity;
  const out = new Set();
  for (const c of comments) {
    const m = DISMISS_RE.exec(String(c?.body ?? ""));
    if (!m) continue;
    const at = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    if (at >= lastAt) out.add(m[1].toLowerCase());
  }
  return out;
}

const minutesOf = (fromIso, now) => (fromIso ? Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 60000)) : null);

/**
 * 规则集：每条规则吃同一个上下文 ctx，返回诊断（未命中返回 null）。
 * ctx 字段由 collectContext 装配：task / comments / watchdog / claim / sessionState /
 * failures / runs / review / now / thresholds / dismissed。
 */
/**
 * 诊断 detail 里的证据渲染（2026-10-19 真机补）。
 *
 * 证据项是**结构化对象**（`{kind, summary, text, ref, at}`，见 `humanReviewProbe`），
 * 早前直接 `String(e)` 拼串 ⇒ 真机上「可核验证据」两行渲染成 `· [object Object]`，
 * 人要据此判断「是否升级人工校验」，看到的却是乱码。
 */
function evidenceText(e) {
  if (e === null || e === undefined) return "";
  if (typeof e === "string") return e;
  const text = e.summary ?? e.text ?? e.title ?? null;
  if (typeof text === "string" && text !== "") return text;
  try { return JSON.stringify(e); } catch { return String(e); }
}

export const DIAGNOSTIC_RULES = Object.freeze([
  {
    kind: "block_loop",
    evaluate(ctx) {
      const { task, thresholds, dismissed } = ctx;
      if (dismissed.has("block_loop")) return null;
      const rec = Number(task.blockRecurrences ?? 0);
      if (!(task.triageAt || rec >= thresholds.recurrenceLimit) || !task.blockKind) return null;
      const enc = encodeRef(task.identifier);
      return {
        kind: "block_loop", severity: "high",
        title: `阻断循环：同因阻断 ${rec} 次`,
        detail: `阻断类型=${task.blockKind}，同因阻断已复发 ${rec} 次（阈值 ${thresholds.recurrenceLimit}）→ 已转「人工兜底」，自动重派已停止；需人判断是改方案还是调依赖。`,
        suggested: "retry",
        actions: [
          action("retry", "重新派发（你已介入）", { kind: "primary", path: `/api/tasks/${enc}/execution/retry`, hint: "复发计数不会清零（FR-80）" }),
          ...sessionActions(ctx),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "block_loop" } }),
        ],
      };
    },
  },
  {
    kind: "stalled",
    evaluate(ctx) {
      const { task, watchdog, dismissed } = ctx;
      if (dismissed.has("stalled")) return null;
      if (watchdog?.state !== "stalled") return null;
      const enc = encodeRef(task.identifier);
      const offline = watchdog.reason === "session-offline";
      return {
        kind: "stalled", severity: "high",
        title: `疑似停滞：${watchdog.minutes} 分钟无进展`,
        detail: `任务仍在「进行中」，但执行会话${offline ? "未在线" : "已空闲"}且已 ${watchdog.minutes} 分钟无进展回报。任务会一直占着「进行中」列，需要人决定重派还是收尾。`,
        suggested: "retry",
        actions: [
          action("retry", "退回待办（重新派发）", { kind: "primary", path: `/api/tasks/${enc}/execution/retry` }),
          ...sessionActions(ctx),
          action("fail", "标记失败（留证据）", { path: `/api/tasks/${enc}/execution/fail` }),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "stalled" } }),
        ],
      };
    },
  },
  {
    kind: "unclaimed",
    evaluate(ctx) {
      const { task, claim, sessionState, currentRun, dismissed } = ctx;
      if (dismissed.has("unclaimed")) return null;
      if (task.status !== "in_progress") return null;
      // 2026-10-22（真机 `-122` 同批）：在途的 CLI 执行也必须排除 —— `direct-handoff` 那条路
      // （非 todo 状态手工点执行）**不建认领锁**，只判 claim 就会把真在跑的子进程报成"没人干"，
      // 主按钮变「回收失效认领（退回来源列）」⇒ 与仍在写文件的子进程并发（同 FR-86 双写风险）。
      // 与看护同一份口径：**会话不可判**（CLI 路径）时才用尝试心跳兜底的"在途"信号。
      if (sessionState?.running) return null;
      if (!sessionState?.sessionId && runInFlight(currentRun, { now: ctx.now, thresholdMs: ctx.thresholds?.stallMs })) return null;
      if (claim?.locked && !claim?.expired) return null;
      const why = claim?.locked && claim?.expired ? "认领已过期" : claim?.locked ? "认领心跳陈旧" : "未被执行者认领";
      return {
        kind: "unclaimed", severity: "high",
        title: "无人认领的「进行中」任务",
        detail: `任务处于「进行中」，但${why}（无有效认领锁），且执行会话不在运行——这条任务事实上没人干。`,
        suggested: "reclaim",
        actions: [
          action("reclaim", "回收失效认领（退回来源列）", { kind: "primary", path: `/api/tasks/${encodeRef(task.identifier)}/reclaim` }),
          ...commonActions(ctx),
        ],
      };
    },
  },
  {
    /**
     * 2026-10-22 补口（真机续二十二）：看板把派发指令投进会话后，会话里的 agent 可能**干了活但不回报**
     * （改了文件、没提交「待验收」、没留评论）⇒ 看护按心跳陈旧回收、任务静默退回「todo」，而看板上
     * 只有一句「认领已回收」，看不出"成果可能已经落在工作区"。这条规则把它变成**可见 + 有恢复动作**：
     * 判据与文案见 `core/delivery.mjs`（纯函数，与 store 收口留痕共用同一份判定，防漂移）。
     */
    kind: "delivery_untaken",
    evaluate(ctx) {
      const { task, runs, comments, dismissed } = ctx;
      if (dismissed.has("delivery_untaken")) return null;
      const hit = detectUntakenDelivery({ task, runs, comments });
      if (!hit) return null;
      const enc = encodeRef(task.identifier);
      const sid = String(hit.run.sessionId ?? "");
      return {
        kind: "delivery_untaken", severity: "medium",
        title: "投递到会话后没有收尾（成果可能与看板脱钩）",
        detail: `第 ${hit.run.attempt} 次尝试是**投递到执行会话**${sid ? ` ${sid.slice(0, 18)}…` : ""} 的，`
          + `但会话里没有交作业（无「待验收」提交，且该次尝试开始后没有任何评论）⇒ 已按「${hit.reason}」收口。`
          + `\n工作区可能已有未提交的改动：请先人工核对（点「打开执行会话」看现场，或直接看工作目录 diff），再决定重派还是作废。`,
        suggested: "open_session",
        actions: [
          ...sessionActions(ctx, { kind: "primary", label: "打开执行会话（看现场）" }),
          action("dismiss", "忽略此项（已人工核对工作区）", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "delivery_untaken" }, hint: "写一条忽略留痕，原文可回溯" }),
        ],
      };
    },
  },
  {
    kind: "repeated_failure",
    evaluate(ctx) {
      const { task, failures, dismissed } = ctx;
      if (dismissed.has("repeated_failure")) return null;
      if (failures.consecutive < failures.limit) return null;
      const quota = QUOTA_AUTH_ERROR_RE.test(String(task.lastFailureError ?? ""));
      const tail = task.lastFailureError ? `\n最近失败：${String(task.lastFailureError).slice(0, 300)}` : "";
      return {
        kind: "repeated_failure", severity: "high",
        title: quota ? "配额/鉴权类失败：不重试" : `连续失败 ${failures.consecutive}/${failures.limit}`,
        detail: `${quota ? "上次失败属配额或鉴权类错误（重试不会让配额回来），" : ""}连续非成功已达 ${failures.consecutive} 次（阈值 ${failures.limit}，来源 ${failures.limitSource}）→ 已熔断，自动派发停止。${tail}`,
        suggested: "reset_failures",
        actions: [
          action("reset_failures", "重置失败计数（放行重派）", { kind: "primary", path: `/api/tasks/${encodeRef(task.identifier)}/reset-failures`, hint: "人工显式重跑 = 新意图" }),
          ...commonActions(ctx),
        ],
      };
    },
  },
  {
    kind: "repeated_crash",
    evaluate(ctx) {
      const { task, runs, failures, dismissed } = ctx;
      if (dismissed.has("repeated_crash")) return null;
      const crashed = (runs ?? []).filter((r) => ["crash", "crashed", "timeout", "killed"].includes(String(r.outcome ?? r.result ?? "").toLowerCase()));
      const byError = failures.consecutive >= 2 && CRASH_ERROR_RE.test(String(task.lastFailureError ?? ""));
      if (crashed.length < 2 && !byError) return null;
      const lastRun = crashed[crashed.length - 1];
      const evidence = crashed.length >= 2
        ? `${crashed.length} 次尝试以崩溃/超时结束（最近：${lastRun?.summary ?? lastRun?.outcome ?? "crash"}）`
        : `最近失败疑似崩溃类：${String(task.lastFailureError ?? "").slice(0, 200)}`;
      const enc = encodeRef(task.identifier);
      return {
        kind: "repeated_crash", severity: "high",
        title: "重复崩溃 / 超时",
        detail: `同一任务反复以崩溃或超时收场（${evidence}）。自动化重试大概率还会崩，需要人看日志或先修环境。`,
        suggested: "open_session",
        actions: [
          ...sessionActions(ctx, { kind: "primary", label: "打开执行会话（看日志）" }),
          action("reset_failures", "重置失败计数", { path: `/api/tasks/${enc}/reset-failures` }),
          action("retry", "退回待办（重新派发）", { path: `/api/tasks/${enc}/execution/retry` }),
        ],
      };
    },
  },
  {
    kind: "stuck_blocked",
    evaluate(ctx) {
      const { task, thresholds, now, dismissed } = ctx;
      if (dismissed.has("stuck_blocked")) return null;
      if (task.status !== "blocked") return null;
      const minutes = minutesOf(task.blockedAt, now);
      if (minutes === null || minutes * 60000 < thresholds.blockedMs) return null;
      const enc = encodeRef(task.identifier);
      const kindLabel = task.blockKind ? `类型=${task.blockKind}` : "类型=未分类";
      return {
        kind: "stuck_blocked", severity: task.triageAt ? "high" : "medium",
        title: `卡在受阻 ${minutes} 分钟`,
        detail: `已受阻 ${minutes} 分钟（${kindLabel}），期间无人处理。受阻任务不会自己动——需要人给料、改判或撤障。`,
        suggested: "retry",
        actions: [
          action("retry", "退回待办（重新派发）", { kind: "primary", path: `/api/tasks/${enc}/execution/retry` }),
          ...sessionActions(ctx),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "stuck_blocked" } }),
        ],
      };
    },
  },
  {
    kind: "awaiting_decision",
    evaluate(ctx) {
      const { task, watchdog, dismissed } = ctx;
      if (dismissed.has("awaiting_decision")) return null;
      if (watchdog?.state !== "awaiting-decision") return null;
      const items = (watchdog.followups ?? []).slice(0, 3);
      const enc = encodeRef(task.identifier);
      return {
        kind: "awaiting_decision", severity: "medium",
        title: watchdog.question ? "等你确认：执行侧在提问" : "待决策：有「下一步」建议",
        detail: `执行会话已空闲并留下可跟进项（不算卡死，算等人）：${items.length ? `\n- ${items.join("\n- ")}` : ""}`,
        suggested: "derive",
        actions: [
          action("derive", "派生为子任务", { kind: "primary", path: `/api/tasks/${enc}/followup`, body: { action: "derive" }, needs: "title", hint: "父任务=原任务、归因同一需求条目、状态=待办池" }),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "awaiting_decision" }, hint: "写一条忽略留痕，原文可回溯" }),
          ...sessionActions(ctx),
        ],
      };
    },
  },
  {
    kind: "review_deadlock",
    evaluate(ctx) {
      const { task, review, dismissed } = ctx;
      if (dismissed.has("review_deadlock")) return null;
      if (!review?.deadlocked) return null;
      const enc = encodeRef(task.identifier);
      return {
        kind: "review_deadlock", severity: "high",
        title: "评审死锁",
        detail: `评审链无法推进：${review.reason ?? "评审者不可用或评审依赖成环"}。任务会一直停在「待验收」，等人来打破。`,
        suggested: "review",
        actions: [
          action("review", "请求评审 / 指派评审者", { kind: "primary", path: `/api/tasks/${enc}/execution/review` }),
          ...sessionActions(ctx),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "review_deadlock" } }),
        ],
      };
    },
  },
  {
    kind: "human_review_required",
    evaluate(ctx) {
      const { task, humanReview, dismissed } = ctx;
      if (dismissed.has("human_review_required")) return null;
      // 人工校验任务自己不再触发升级门（否则会自我繁殖）
      if (ctx.isHumanReviewTask) return null;
      const c = humanReview?.classification ?? null;
      // FR-85 红线：判不准就不升级 —— confident=false 时**绝不产出**（不许自动臆断）
      if (!c?.confident || !c.category) return null;
      // 幂等：同项目同类已有待结论的人工校验任务 → 不重复造卡（否则诊断每轮都造一条）
      if (humanReview.pendingSameCategory) return null;
      // 2026-10-19 真机补：同类**已给出结论**、且本次判定由**更早的**申报驱动 ⇒ 这扇门已被人回答过。
      // 否则一条常驻的申报评论会让 `-90` 这类卡在人已结论后**永远**挂着 high 级「需人工校验」。
      if (humanReview.answeredSameCategory) return null;
      const enc = encodeRef(task.identifier);
      const label = categoryLabel(c.category) ?? c.category;
      const evidence = (humanReview.evidence ?? []).slice(0, 5);
      const tail = evidence.length ? `\n可核验证据：\n${evidence.map((e) => `  · ${evidenceText(e).slice(0, 200)}`).join("\n")}` : "";
      return {
        kind: "human_review_required", severity: "high",
        title: `需人工校验：${label}`,
        detail: `${c.confidenceReason ?? "证据充分"}——已命中 FR-85 的四类情形之一，自动化到此为止。派发人工校验任务后**停手等人**：结论（继续 / 变更需求 / 关闭）给出前，本任务与下游都不会被自动推进。${tail}`,
        suggested: "human_review",
        actions: [
          action("human_review", "派发人工校验任务（停手等人）", { kind: "primary", path: `/api/tasks/${enc}/human-review`, hint: `类别=${label}；执行侧不得认领、不得置 done` }),
          action("dismiss", "忽略此项", { path: `/api/tasks/${enc}/diagnostics/dismiss`, body: { kind: "human_review_required" }, hint: "忽略后同类情形不再提示，直到出现更新的进展评论" }),
        ],
      };
    },
  },
]);

/** 纯函数：按规则集产出诊断列表（按严重度 → kind 稳定排序）。 */
export function buildDiagnostics(ctx) {
  const out = [];
  for (const rule of DIAGNOSTIC_RULES) {
    let d = null;
    try { d = rule.evaluate(ctx); } catch { d = null; }
    if (!d || !DIAGNOSTIC_KINDS.includes(d.kind)) continue;
    const actions = d.actions ?? [];
    // FR-84：`suggested` 必须指向**真实存在**的动作——会话类动作可能因"无可解析会话"
    // 被换成「重建并绑定主会话」（id: bind_session），此时不能宣称"首选=打开执行会话"。
    let suggested = d.suggested;
    if (actions.length && !actions.some((a) => a.id === suggested)) {
      suggested = (actions.find((a) => a.kind === "primary") ?? actions[0]).id;
    }
    out.push({ ...d, suggested, actions });
  }
  return out.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || a.kind.localeCompare(b.kind));
}

/** 卡片摘要（FR-79：卡片只带 {count, kinds, highestSeverity}）。 */
export function summarizeDiagnostics(list = []) {
  const rows = (list ?? []).filter(Boolean);
  if (!rows.length) return null;
  const highest = rows.reduce((acc, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[acc] ? d.severity : acc), "low");
  return { count: rows.length, kinds: [...new Set(rows.map((d) => d.kind))].sort(), highestSeverity: highest };
}

/** 项目级汇总：按严重度与 kind 计数。 */
export function summarizeProject(rows = []) {
  const bySeverity = { high: 0, medium: 0, low: 0 };
  const byKind = {};
  for (const r of rows) {
    bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + 1;
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  }
  return { total: rows.length, bySeverity, byKind };
}

/** 装配规则上下文（只读 store；不写库）。 */
/**
 * FR-85b：把任务的当前状态收敛成"人在环升级门"的判定输入（只读，不写库）。
 *
 * 证据只取**可核验的运行痕迹**（尝试记录的结论/错误 + 最近失败原因）与**已落库的诊断**；
 * **不把聊天/评论正文当证据** —— 否则一句"退出码 0"的评论就足以造出误升级。
 */
export function humanReviewProbe(store, task, runs = null) {
  const attempts = runs ?? (typeof store.listTaskRuns === "function" ? store.listTaskRuns(task) : []);
  let persisted = [];
  try { persisted = typeof store.listTaskDiagnostics === "function" ? store.listTaskDiagnostics(task) : []; } catch { persisted = []; }
  // FR-85（2026-10-18 真机补）：显式申报是「需求异化 / 架构变化 / 与上游不符」三类**唯一**的可持久化来源。
  let comments = [];
  try { comments = typeof store.listComments === "function" ? store.listComments(task.id) : []; } catch { comments = []; }
  // 需求条目（真实关联，不是猜的）：判定「需求已被取代/作废」分支要用它。
  let requirementItem = null;
  try {
    requirementItem = (task.requirementId && typeof store.getRequirementItemById === "function")
      ? store.getRequirementItemById(task.requirementId) ?? null
      : null;
  } catch { requirementItem = null; }
  const failedRuns = attempts.filter((r) => r.outcome && r.outcome !== "success");
  // 2026-10-18 真机发现：这些证据此前被折成**纯字符串**，于是丢掉 kind → `kindIn(e,["failure",…])` 永不命中，
  // 升级门对"反复真实失败"的任务恒报「失败证据 0 条」。改为带上 `kind: "failure"` 的结构化证据
  // （仍保留同一份可读文本），语义与既有的 `outcome !== "success"` 过滤口径一致。
  const declarations = declarationEvidence(comments);
  const evidence = [
    ...declarations,
    ...failedRuns.map((r) => ({
      kind: "failure",
      summary: `${r.outcome}${r.summary ? `：${r.summary}` : ""}`,
      text: `${r.outcome}${r.summary ? `：${r.summary}` : ""}${r.error ? `。${r.error}` : ""}`,
      ref: r.id ?? null,
    })),
    task.lastFailureError ? `最近失败：${task.lastFailureError}` : "",
  ].filter(Boolean);
  const input = {
    task,
    requirementItem,
    // 显式申报的类别（若有）：判定器据此直接出该类别结论（见 human-review.classifyHumanReview 的"申报优先"）。
    declaration: (declarations.find((d) => DECLARABLE_CATEGORIES.has(d.kind)) ?? null)?.kind ?? null,
    blockRecurrences: Number(task.blockRecurrences ?? 0),
    blockKind: task.blockKind ?? null,
    diagnosis: persisted.map((d) => ({ kind: d.kind, severity: d.severity, title: d.title, detail: d.detail, count: d.count })),
    evidence,
  };
  return { input, classification: classifyHumanReview(input), evidence, declarations };
}

/** 规则上下文里的 FR-85b 切片：判定结果 + 该项目下已待结论的人工校验任务（去重用）。 */
function humanReviewContext(store, task, runs = null) {
  const probe = humanReviewProbe(store, task, runs);
  let pending = [];
  try { pending = typeof store.humanReviewPending === "function" ? store.humanReviewPending(task.projectId) : []; } catch { pending = []; }
  let concluded = [];
  try { concluded = typeof store.listHumanReviews === "function" ? store.listHumanReviews({ projectId: task.projectId, state: "concluded" }) : []; } catch { concluded = []; }
  const own = isHumanReviewTask(task);
  const category = probe.classification.confident ? probe.classification.category ?? null : null;
  return {
    humanReview: {
      ...probe,
      pending,
      pendingSameCategory: category ? pending.find((t) => (t.humanReviewCategory ?? null) === category) ?? null : null,
      // FR-85 已结论水位线：由**申报**驱动且申报不晚于结论 ⇒ 人已答过（见 humanReviewAnsweredBy）。
      answeredSameCategory: category ? humanReviewAnsweredBy(probe.classification, probe.declarations, concluded) : null,
    },
    isHumanReviewTask: own,
  };
}
export function collectContext(store, task, { now = Date.now(), thresholds = DEFAULT_THRESHOLDS, runs = null, review = null } = {}) {
  const comments = store.listComments(task.id);
  const sessionState = store.taskSessionState(task);
  const limitOverride = task.maxRetries ?? null;
  // FR-82：尝试记录是"重复崩溃"诊断的**一等判据**（不再只靠错误文本猜）
  const attempts = runs ?? (typeof store.listTaskRuns === "function" ? store.listTaskRuns(task) : []);
  // 2026-10-22：当前尝试（CLI 执行器**唯一**的在途信号 —— 那条路 sessionId 恒为 null）。
  // 必须与看护共用同一份，否则 /execution 与诊断会给出两套口径。
  const currentRun = typeof store.getCurrentRun === "function" ? store.getCurrentRun(task) : null;
  return {
    task,
    comments,
    claim: store.taskClaimState(task, { now }),
    sessionState,
    currentRun,
    // FR-84：会话引用解析结果（供"打开会话 / 重建主会话"动作抉择）
    sessionRef: resolveSessionRef(store, task),
    // FR-85b：人在环升级门的判定（含 pending 去重信息）
    ...humanReviewContext(store, task, attempts),
    watchdog: assessTask({ task, comments, sessionState, currentRun, now, thresholdMs: thresholds.stallMs }),
    failures: {
      consecutive: Number(task.consecutiveFailures ?? 0),
      limit: limitOverride != null ? Number(limitOverride) : DEFAULT_FAILURE_LIMIT,
      limitSource: limitOverride != null ? "task" : "default",
    },
    runs: attempts,
    // FR-83：评审死锁由**真实判定**给出（调用方可显式覆盖，便于单测/回放）
    review: review === null
      ? detectReviewDeadlock(store, task, { now, idleMs: thresholds.reviewIdleMs ?? REVIEW_IDLE_MS })
      : review,
    now,
    thresholds,
    dismissed: dismissedKinds(comments),
  };
}

/**
 * 评估单个任务并落库（诊断的唯一写入口）。
 * 返回 { task, diagnostics（当前生效，含 count/firstSeenAt）, summary, resolved }。
 * `persist:false` 用于只读预览（不写库、不带计数）。
 */
export function evaluateTaskDiagnostics(store, ref, { now = Date.now(), thresholds = DEFAULT_THRESHOLDS, persist = true, runs = null, review = null } = {}) {
  const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
  const ctx = collectContext(store, task, { now, thresholds, runs, review });
  const found = buildDiagnostics(ctx);
  if (!persist) {
    const preview = found.map((d) => ({ ...d, id: `preview:${task.id}:${d.kind}`, taskId: task.id, taskIdentifier: task.identifier, count: 1, firstSeenAt: null, lastSeenAt: new Date(now).toISOString(), resolvedAt: null }));
    return { task, diagnostics: preview, summary: summarizeDiagnostics(preview), resolved: [] };
  }
  const saved = store.saveTaskDiagnostics(task.identifier, found, { now });
  return { task, diagnostics: saved.active, summary: summarizeDiagnostics(saved.active), resolved: saved.resolved };
}

/**
 * 项目级诊断：对"可能需要人介入"的任务逐个评估（进行中 / 受阻 / 待验收），
 * 返回 { rows, summary }。只读路径也可以调用（会同步落库，保证 count 有意义）。
 */
export function projectDiagnostics(store, projectId, { now = Date.now(), thresholds = DEFAULT_THRESHOLDS, persist = true } = {}) {
  const statuses = new Set(["in_progress", "blocked", "in_review"]);
  const tasks = store.listTasks({ projectId }).filter((t) => statuses.has(t.status) || t.triageAt);
  const rows = [];
  for (const task of tasks) {
    const r = evaluateTaskDiagnostics(store, task, { now, thresholds, persist });
    for (const d of r.diagnostics) rows.push({ ...d, identifier: task.identifier, title: task.title, status: task.status });
  }
  rows.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || String(a.identifier).localeCompare(String(b.identifier)));
  return { rows, summary: summarizeProject(rows) };
}

