/**
 * notify.mjs —— 通知订阅与唤醒（FR-81）的**纯函数**部分。
 *
 * 职责边界：只做"哪些事件算终态 / 该推哪些 / 推什么文本 / 汇总结果"，**不碰 db、不碰宿主会话通道**
 * （落库在 `store.mjs`，投递通道由调用方注入）。这样"什么算终态"这条口径可以被单测穷举。
 *
 * 三模式语义（本项目口径，见需求 FR-81 与轮次记录）：
 * - `notify`      ：只通知——在任务里**留一条评论**（工作台可见），不打扰任何会话；
 * - `notify+wake` ：通知并唤醒——留评论 + 把摘要**投递到目标会话**；
 * - `wake`        ：只唤醒——只投一条**极简**唤醒信号，不留评论。
 */

export const NOTIFY_DELIVERY_MODES = Object.freeze(["notify", "notify+wake", "wake"]);

/** 本次尝试"成功收场"（产出待验收）的口径 —— 见 `store.endTaskRun` 的调用点。 */
export const COMPLETED_RUN_OUTCOMES = Object.freeze(["success"]);
/** 本次尝试"以失败/受阻收场"的口径（含崩溃与超时）。 */
export const BLOCKED_RUN_OUTCOMES = Object.freeze(["blocked", "failed", "crash", "timeout"]);
/** 这些收场**不推送**：回收/人工退回/人工释放/无结论 —— 任务还会被重新派发，不是终态。 */
export const IGNORED_RUN_OUTCOMES = Object.freeze(["reclaimed", "cancelled", "released", "ended"]);

export const NOTIFY_KIND_LABELS = Object.freeze({
  completed: "完成（产出待验收）",
  blocked: "受阻",
  auto_blocked: "自动阻断（同因复发 → 人工兜底）",
});

/**
 * 归一化交付模式。非法值**不抛错**（返回 `valid:false` + `reason`），由调用方决定转成哪种错误。
 * `wake` = 是否要投递会话；`comment` = 是否要在任务里留痕。
 */
export function normalizeDeliveryMode(mode) {
  const m = String(mode ?? "").trim();
  const valid = NOTIFY_DELIVERY_MODES.includes(m);
  return {
    mode: valid ? m : null,
    valid,
    reason: valid ? null : `未知交付模式：${mode ?? "(空)"}（可选 ${NOTIFY_DELIVERY_MODES.join(" / ")}）`,
    wake: valid && m.includes("wake"),
    comment: valid && m !== "wake",
  };
}

/**
 * 单条事件是否属于"要推送的终态"，以及属于哪一类。
 * 判定表（与轮次记录一致，改动必须同步文档）：
 * - `run_ended`  `success` → completed；`blocked|failed|crash|timeout` → blocked；`reclaimed|cancelled|released|ended` → 不推
 * - `blocked`    `to=blocked` 且 detail 含"人工兜底" → auto_blocked；`to=blocked` → blocked；`to=todo`（依赖未就绪）→ 不推
 * - `status_changed` `to=done` → completed；`to=blocked` → blocked；其余（含 in_review）**不单独判终态**
 * - 其它类型（评论/心跳/失败记账/评审…）→ 不推
 */
export function isTerminalNotifyEvent(event) {
  const type = String(event?.type ?? "");
  const to = event?.to == null ? null : String(event.to);
  const detail = String(event?.detail ?? "");
  if (type === "run_ended") {
    if (COMPLETED_RUN_OUTCOMES.includes(to)) {
      return { notifiable: true, kind: "completed", terminal: true, reason: "本次执行成功（产出待验收）" };
    }
    if (BLOCKED_RUN_OUTCOMES.includes(to)) {
      return { notifiable: true, kind: "blocked", terminal: true, reason: `本次执行以「${to}」收场` };
    }
    return {
      notifiable: false, kind: null, terminal: false,
      reason: IGNORED_RUN_OUTCOMES.includes(to) ? `非终态收场（${to}），等重新派发` : `未知收场：${to ?? "(空)"}`,
    };
  }
  if (type === "blocked") {
    if (to !== "blocked") {
      return { notifiable: false, kind: null, terminal: false, reason: "依赖未就绪 → 回「可开工」，不算终态阻断" };
    }
    // 复发升级到人工兜底（`store.blockTask` 的 detail 带"人工兜底"字样）——与人工阻断分开报，好让人一眼看出"这是循环"。
    const triaged = /人工兜底/.test(detail);
    return {
      notifiable: true, kind: triaged ? "auto_blocked" : "blocked", terminal: true,
      reason: triaged ? "同因重复阻断已升级「人工兜底」" : "已置受阻",
    };
  }
  if (type === "status_changed") {
    if (to === "done") return { notifiable: true, kind: "completed", terminal: true, reason: "人工确认完成" };
    if (to === "blocked") return { notifiable: true, kind: "blocked", terminal: true, reason: "人工置受阻" };
    return { notifiable: false, kind: null, terminal: false, reason: `状态变化不是终态：${to ?? "(空)"}` };
  }
  return { notifiable: false, kind: null, terminal: false, reason: `该事件类型不参与通知：${type || "(空)"}` };
}

/**
 * 从（按 cursor 升序的）事件流里挑出**待推送**的事件：
 * - 非终态直接跳过；
 * - **同一任务只留首条终态**（`run_ended success` 与随后的 `status_changed` 不会重复推一个人）；
 * - 游标推进到"见到的最大 cursor"（包含被跳过的事件——它们已经消费过，不必再扫）。
 * 返回的每条事件额外带 `kind`，供消息构造与汇总直接使用。
 */
export function selectNotifyEvents(events, { since = 0 } = {}) {
  const list = Array.isArray(events) ? events : [];
  const threshold = Math.max(0, Number(since) || 0);
  const seen = new Set();
  const picked = [];
  let cursor = threshold;
  let scanned = 0;
  let skipped = 0;
  let deduped = 0;
  for (const event of list) {
    const c = Number(event?.cursor ?? 0);
    if (Number.isFinite(c) && c > cursor) cursor = c;
    scanned += 1;
    // 已经在 `since` 之前推送过的事件不再推（幂等：调用方即使多查了一段也不会重复推）
    if (!Number.isFinite(c) || c <= threshold) { skipped += 1; continue; }
    const verdict = isTerminalNotifyEvent(event);
    if (!verdict.notifiable) { skipped += 1; continue; }
    const key = String(event?.taskId ?? event?.identifier ?? "");
    if (seen.has(key)) { deduped += 1; continue; }
    seen.add(key);
    picked.push({ ...event, kind: verdict.kind, notifyKind: verdict.kind });
  }
  return { events: picked, cursor, scanned, skipped, deduped };
}

/**
 * 构造消息体。`events` 应为 `selectNotifyEvents` 的产出（已按任务去重）。
 * `taskOf(taskId)` 由调用方注入（查任务拿编号/标题）。
 * 返回：`prompt`（要投递到会话的文本；`notify` 模式为 null）、`commentBody`（要在任务里留痕的文本；`wake` 模式为 null）。
 */
export function buildNotifyMessage({ project = null, events = [], mode = "notify+wake", taskOf = null } = {}) {
  const norm = normalizeDeliveryMode(mode);
  if (!norm.valid) throw new Error(norm.reason);
  const list = Array.isArray(events) ? events : [];
  const lookup = typeof taskOf === "function" ? taskOf : () => null;
  const byTask = new Map();
  const taskIds = [];
  for (const event of list) {
    const tid = String(event?.taskId ?? "");
    if (!byTask.has(tid)) {
      const task = tid ? lookup(tid) : null;
      const identifier = task?.identifier ?? String(event?.identifier ?? tid ?? "(未知任务)");
      byTask.set(tid, { task, identifier, title: task?.title ?? null, kinds: new Set() });
      if (tid) taskIds.push(tid);
    }
    byTask.get(tid).kinds.add(String(event?.kind ?? "blocked"));
  }
  const entries = [...byTask.values()];
  const kinds = [...new Set(entries.flatMap((e) => [...e.kinds]))];
  if (!entries.length) return { prompt: null, commentBody: null, taskIds, mode: norm.mode, kinds: [] };
  const projectLabel = project?.name ? `${project.name}（${project.id}）` : String(project?.id ?? "（项目）");
  const labelOf = (kind) => NOTIFY_KIND_LABELS[kind] ?? String(kind);
  if (norm.mode === "wake") {
    const head = entries.length === 1 ? `任务 ${entries[0].identifier} 已到终态` : `${entries.length} 个任务已到终态`;
    return {
      prompt: `【唤醒】任务工作台：${projectLabel} ${head}（${kinds.map(labelOf).join("／")}）。请查看任务详情并处理；本条只做唤醒，无需回执。`,
      commentBody: null, taskIds, mode: norm.mode, kinds,
    };
  }
  const lines = [`【任务工作台 · 通知】${projectLabel} 有 ${entries.length} 个任务到了终态：`];
  for (const entry of entries) {
    lines.push(`· ${entry.identifier}${entry.title ? ` ${entry.title}` : ""} — ${[...entry.kinds].map(labelOf).join("／")}`);
  }
  lines.push("下一步：完成 → 请人工验收（执行侧不得置 done）；受阻/自动阻断 → 按任务详情的诊断建议恢复，或人工解除。");
  const prompt = norm.wake ? lines.join("\n") : null;
  const commentBody = `【FR-81 通知】${entries.length} 个任务到终态：${entries.map((e) => `${e.identifier}（${[...e.kinds].map(labelOf).join("／")}）`).join("、")}${norm.wake ? "；已同时唤醒目标会话。" : "（仅通知，未投递会话）。"}`;
  return { prompt, commentBody, taskIds, mode: norm.mode, kinds };
}

/** 一轮 flush 的汇总（API/UI 与轮次记录共用同一口径）。 */
export function summarizeNotifyDelivery(results = []) {
  const list = Array.isArray(results) ? results : [];
  const summary = { total: 0, delivered: 0, failed: 0, pending: 0, commented: 0, noop: 0, byMode: {} };
  for (const r of list) {
    summary.total += 1;
    const mode = String(r?.mode ?? "unknown");
    summary.byMode[mode] = (summary.byMode[mode] ?? 0) + 1;
    const count = Number(r?.count ?? 0);
    if (r?.delivered) {
      summary.delivered += 1;
      summary.commented += Number(r?.commented ?? 0);
    } else if (r?.error) {
      summary.failed += 1;
      summary.pending += count; // 失败：事件仍在队列里，下轮自动重试
    } else {
      summary.noop += 1; // 无待推送（游标后没有终态事件）
    }
  }
  return summary;
}
