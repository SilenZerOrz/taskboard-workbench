/**
 * 阶段推导**单一口径**（FR-108 / 卡 `-196` · 0-A1）。
 *
 * 这一层只做「判」，不碰库、不发请求（0-A1 的边界）：输入的 `evidence` / `decision` / `comments`
 * 由调用方给，输出一个 `stage` 加上四套旧口径的**同批读数**。
 *
 * 为什么不是"再写第五套判断"：四套旧口径（`next-step` / `verify` / `watchdog` / `diagnostics`）
 * 各自回答一个侧面的问题，谁都不是"这张卡到哪一步"的唯一答案。本函数**直接复用**它们的纯函数
 * （`deriveNextStep` / `assessTask` / `latestAutoReview`），只做**归一**，不复制任何判定规则 ——
 * 规则一复制就必然漂移（这正是 FR-108 要消灭的东西）。
 *
 * 交付物漏斗（stage 的核心，按优先级）：
 *   `done` / `canceled` → `human_review_pending` → `blocked_by_human_review`
 *   → `awaiting_review_request` → `stale` → `rework` → `awaiting_human_done` → `review_pending`
 *   → `ready` → `refs_unresolved` → `format_ok` → `blocked` → `in_progress` → `todo` → `backlog` → `not_ready`
 *
 * 三条**刻意**的优先级（都有测试钉住，改动即红）：
 *   1. `awaiting_review_request` 在 `stale` **之前**：卡还没发起评审，先说"去发起"，别拿证据态盖住流程态。
 *   2. `stale` 在 `awaiting_human_done` / `review_pending` **之前**：证据或版本变了就**不许**再邀请人点「完成」
 *      （GWT-3 的产品含义就是这一条 —— 否则人点下去确认的是他没看过的那一版）。
 *   3. `review_pending` 在 `format_ok` **之前**：卡已在评审队列里，"等你评审"比"格式合格"更该先说。
 */
import { deriveNextStep } from "./next-step.mjs";
import { assessTask } from "./watchdog.mjs";
import { latestAutoReview } from "./verify.mjs";
import { evidenceFormatOk } from "./evidence.mjs";

/** 全部可能的阶段（同时也是**优先级**顺序的声明式副本，测试用它做白名单校验）。 */
export const TICKET_STAGES = Object.freeze([
  "done", "canceled",
  "human_review_pending", "blocked_by_human_review",
  "awaiting_review_request", "stale",
  "rework", "awaiting_human_done", "review_pending",
  "ready", "refs_unresolved", "format_ok",
  "blocked", "in_progress", "todo", "backlog", "not_ready",
]);

/** 交付物漏斗状态（`stage` 的候选来源）。 */
export const DELIVERY_STATES = Object.freeze(["none", "incomplete", "refs_unresolved", "format_ok", "ready", "stale"]);

const text = (v) => (typeof v === "string" ? v.trim() : "");
const norm = (v) => (v === null || v === undefined || v === "" ? null : String(v));

function labelList(task) {
  return Array.isArray(task?.labels) ? task.labels.map((l) => text(l)) : [];
}

/**
 * 交付物漏斗（纯）：`none` → `incomplete` / `refs_unresolved` → `format_ok` → `ready`，判过又变 → `stale`。
 *
 * 只认 `layer="llm"` 的判定：规则层通过（`format_ok`）不是"内容已判"，不能冒充 `ready`（GWT-2）。
 */
export function deriveDelivery({ task = {}, evidence = null, decision = null } = {}) {
  const llm = decision && String(decision.layer ?? "") === "llm" ? decision : null;
  if (llm) {
    const decisionVerdict = String(llm.decision ?? "");
    if (decisionVerdict !== "ready") {
      // 判过但没判成 ready（如 needs_changes）：不是 ready，也不是 stale —— 交回人看判定理由。
      return { state: "incomplete", reason: `判定层结论 ${decisionVerdict || "(空)"}`, decision: llm };
    }
    const evidenceIdMismatch = !evidence || (llm.evidenceId ?? null) !== evidence.id;
    const versionMismatch = Number(llm.taskVersion) !== Number(task?.version);
    if (evidenceIdMismatch || versionMismatch) {
      return {
        state: "stale",
        reason: evidenceIdMismatch
          ? `判定绑定的证据 ${llm.evidenceId ?? "(空)"} 不是当前最新证据 ${evidence?.id ?? "(无)"}`
          : `判定绑定版本 v${llm.taskVersion} ≠ 当前 v${task?.version}`,
        decision: llm,
        evidenceId: evidence?.id ?? null,
      };
    }
    return { state: "ready", reason: "判定与证据/版本一致", decision: llm, evidenceId: evidence.id };
  }
  if (!evidence) return { state: "none", reason: "尚无结构化证据" };
  if (evidence.refsState === "unresolved") {
    return { state: "refs_unresolved", reason: "artifact_refs 有解不开的 commit/file", evidenceId: evidence.id };
  }
  if (!evidenceFormatOk(evidence)) {
    return { state: "incomplete", reason: "证据四字段不全", evidenceId: evidence.id };
  }
  return { state: "format_ok", reason: "四字段齐、无内容判定", evidenceId: evidence.id };
}

/**
 * 归一为单一 `stage`（纯）。优先级见文件头三条。
 * 返回 `{ stage, reason, delivery, next, watch, verify, diagnostics }` ——
 * 后四者是**同批读数**（不参与 stage 计算，但同一函数给出，避免调用方各取一套再自己拼）。
 */
export function ticketStage(task = {}, ctx = {}) {
  const t = task ?? {};
  const status = String(t.status ?? "");
  const review = norm(t.reviewState);
  const labels = labelList(t);
  const delivery = deriveDelivery({ task: t, evidence: ctx.evidence ?? null, decision: ctx.decision ?? null });

  const watch = assessTask({
    task: t,
    comments: ctx.comments ?? [],
    sessionState: ctx.sessionState ?? null,
    currentRun: ctx.currentRun ?? null,
    now: ctx.now,
    thresholdMs: ctx.thresholdMs,
  });
  // 「停滞」只有一个来源：看护读数。**不接受调用方另给一个布尔** —— 那等于在同一条链上留第二个口径
  // （真机教训：`next-step` 与 `watchdog` 对同一张卡给出相反结论时，人不知道该信哪个）。
  const stalled = watch.state === "stalled";
  const next = deriveNextStep(t, { humanReviewBlocker: ctx.humanReviewBlocker ?? null, stalled });
  const autoReview = latestAutoReview(ctx.comments ?? []);

  const base = { delivery, next: { code: next.code, title: next.title }, watch: { state: watch.state, minutes: watch.minutes }, verify: autoReview ? { verdict: autoReview.verdict ?? null, at: autoReview.at ?? null } : null, diagnostics: Array.isArray(ctx.diagnostics) ? ctx.diagnostics.slice() : [] };

  // 1) 终态
  if (status === "done") return { stage: "done", reason: "已完成", ...base };
  if (status === "canceled") return { stage: "canceled", reason: "已取消", ...base };

  // 2) 人工校验门（人在环升级门：执行侧不得认领/不得 done）
  const humanReview = labels.includes("human_review");
  if (humanReview && String(t.humanReviewState ?? "pending") !== "concluded") {
    return { stage: "human_review_pending", reason: "人工校验卡待结论", ...base };
  }
  if (ctx.humanReviewBlocker) {
    return { stage: "blocked_by_human_review", reason: `被人工校验门挡住：${ctx.humanReviewBlocker.identifier ?? "?"}`, ...base };
  }

  // 3) 待验收但从未发起评审（GWT-4：先于其他分支）
  if (status === "in_review" && !t.reviewRequestedAt) {
    return { stage: "awaiting_review_request", reason: "在待验收但未发起评审", ...base };
  }

  // 4) 证据/版本已变（GWT-3：不得显示为 ready，也不得邀请人点完成）
  if (delivery.state === "stale") return { stage: "stale", reason: delivery.reason, ...base };

  // 5) 评审流程态
  if (status === "in_review" && review === "changes_requested") return { stage: "rework", reason: "评审要求返工", ...base };
  if (status === "in_review" && review === "approved") return { stage: "awaiting_human_done", reason: "评审已通过，等人工确认完成", ...base };
  if (status === "in_review") return { stage: "review_pending", reason: "等待评审", ...base };

  // 6) 交付物漏斗（非评审队列时，"交付物到哪一步"就是这张卡的阶段）
  if (delivery.state === "ready") return { stage: "ready", reason: delivery.reason, ...base };
  if (delivery.state === "refs_unresolved") return { stage: "refs_unresolved", reason: delivery.reason, ...base };
  if (delivery.state === "format_ok") return { stage: "format_ok", reason: delivery.reason, ...base };

  // 7) 普通流程态
  if (status === "blocked") return { stage: "blocked", reason: "受阻", ...base };
  if (status === "in_progress") return { stage: "in_progress", reason: "进行中", ...base };
  if (status === "todo") return { stage: "todo", reason: "待办", ...base };
  if (status === "backlog") return { stage: "backlog", reason: "待办池", ...base };
  return { stage: "not_ready", reason: delivery.reason, ...base };
}
