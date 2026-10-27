/**
 * delivery.mjs —— 「投递到会话」与「会话里真的交了作业」的**分档判定**（FR-79 / FR-82 补口）。
 *
 * 背景（真机 2026-10-22 · 续二十二）：看板把派发指令投进项目主会话后，会话里的 agent 确实在干活
 * （会话记录里能看到改 `web/app.js`、调 `taskboard_*` 工具），但**既没有提交「待验收」，也没有留评论**
 * ⇒ 30 分钟后被看护按「认领心跳陈旧」回收，任务静默退回「todo」。看板上只留下一句「认领已回收」，
 * **看不出**「这次是投递给会话的、会话没交作业、工作区可能已经有改动」——工作成果与看板状态脱钩。
 *
 * 本模块**只做判定**（纯函数、零副作用、零 I/O），措辞与落盘由调用方决定：
 *   · `store` 在收口（回收 / 超时）时用它决定是否补一条「未收尾」留痕（评论 + 事件）；
 *   · `diagnostics` 用它产出 `delivery_untaken` 诊断 —— 走 FR-79 的统一出口：**可见 + 给恢复动作**。
 *
 * 判据（四条，缺一不算）：
 *   ① 任务仍停在**可执行侧**（`todo` / `in_progress`）—— 已提交待验收 / 已完成 / 已取消的任务都有结论；
 *   ② 最近一次尝试是**会话投递**（`run.sessionId` 非空）—— CLI 执行器投递以退出码收口，成败都是结论；
 *   ③ 该次尝试的收口结局是「**被回收 / 超时**」（有结论的结局是 `success` / `failed` / `cancelled` …）；
 *   ④ 该次尝试**开始之后没有任何评论**（提交待验收、进展汇报、人工反馈都会留评论）。
 *
 * 判定为“未收尾”不等于“失败了” —— 它表达的是：**投出去的东西没有回报**，需要人看一眼工作区。
 */

/** 「会话投递没回报」的收口结局。`interrupted`（进程重启）不在此列：那是另一类事故，已有自己的留痕。 */
export const UNTAKEN_RUN_OUTCOMES = Object.freeze(["reclaimed", "timeout"]);

/** 只有还站在可执行侧的任务才算“未收尾”（有结论的任务不会命中）。 */
export const UNTAKEN_STATUSES = Object.freeze(["todo", "in_progress"]);

/** 收口留痕用的固定前缀 —— 也用于把「系统留痕」与「人的结论」区分开。 */
export const UNTAKEN_COMMENT_MARKER = "【投递未收尾】";

/**
 * **系统留痕**（不是结论）。判定「该次尝试有没有交作业」时必须把它们排除，否则：
 *   · 投递那一刻写的「派发指令已投递到项目主会话…」会把自己这次尝试判成“已回报”；
 *   · 收口时写的「【投递未收尾】…」会让 FR-79 诊断再也命中不了（自己消掉自己的证据）。
 * 三处留痕的措辞都从这里取，避免又出现两份常量。
 */
export const SYSTEM_TRACE_MARKERS = Object.freeze([
  UNTAKEN_COMMENT_MARKER,
  "派发指令已投递到项目主会话",
  "已交给 CLI 执行器",
  // 看护回收时写的那句「认领已回收（…）→ 退回「todo」」同样是**系统留痕**：它描述的是"锁被收回"，
  // 不是"会话交过作业"。不排除它，回收动作会**自己消掉自己**要暴露的证据（第一次接线上就被这条挡住过）。
  "认领已回收",
]);

/** 这条评论算不算「结论/进展」（系统留痕不算）。 */
export function isConclusionComment(body) {
  const text = String(body ?? "");
  return !SYSTEM_TRACE_MARKERS.some((marker) => text.includes(marker));
}

/** 取最近一次尝试（按 attempt 取最大；attempt 相同则靠后写入者胜）。 */
export function findLatestRun(runs = []) {
  let best = null;
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run) continue;
    if (!best) { best = run; continue; }
    const a = Number(run.attempt ?? 0);
    const b = Number(best.attempt ?? 0);
    if (a > b) best = run;
    else if (a === b) best = run; // 同 attempt：以列表更靠后的为准（与 listTaskRuns 的 order by attempt,rowid 对齐）
  }
  return best;
}

/** 结局 → 人话（用于评论/诊断文案）。 */
export function untakenReasonLabel(outcome) {
  if (outcome === "reclaimed") return "认领被回收（心跳陈旧 / 认领过期）";
  if (outcome === "timeout") return "超过运行时上限被收口";
  return `收口结局 ${outcome ?? "未知"}`;
}

/**
 * 判定最近一次尝试是否属「投递到会话后没有收尾」。
 * @returns {{run: object, reason: string}|null} 命中时给出该次尝试与结局说明；否则 `null`。
 */
export function detectUntakenDelivery({ task = null, runs = [], comments = [] } = {}) {
  if (!task) return null;
  if (!UNTAKEN_STATUSES.includes(task.status)) return null;
  const run = findLatestRun(runs);
  if (!run) return null;
  if (!run.sessionId) return null;
  if (!UNTAKEN_RUN_OUTCOMES.includes(run.outcome)) return null;
  const startedAt = Date.parse(run.startedAt ?? "");
  if (!Number.isFinite(startedAt)) return null;
  const reported = (Array.isArray(comments) ? comments : []).some((c) => {
    if (!isConclusionComment(c?.body)) return false;
    const at = Date.parse(c?.createdAt ?? "");
    return Number.isFinite(at) && at >= startedAt;
  });
  if (reported) return null;
  return { run, reason: untakenReasonLabel(run.outcome) };
}
