/**
 * review.mjs —— 评审流程与评审死锁诊断（FR-83）。
 *
 * 对齐 hermes `request_changes` + `_rule_review_dependency_deadlock`（见 设计/hermes-kanban评估-2026-10-16.md §6.7）：
 *   · 评审是**一等流程**：请求评审（指派评审者）→ 请求返工（退回**来源列**）/ 评审通过
 *   · 返工**退回来源列**，不得退成"实现"以外的错列（来源列在请求评审时记下）
 *   · "评审者自身被阻塞 / 评审链成环 / 无人评审"必须被**显式诊断**出来，并给恢复动作
 *   · 红线不动：**评审通过也不自动置"完成"**（完成只能人确认）
 *
 * 本模块只做纯函数 + 只读遍历；写库在 store（`requestReview` / `requestChanges` / `approveReview`）。
 */

/** 评审态（tasks.review_state）。 */
export const REVIEW_STATES = Object.freeze(["pending", "approved", "changes_requested"]);
/** 默认"无人评审"多久算停摆。 */
export const REVIEW_IDLE_MS = 30 * 60 * 1000;
/** 返工允许退回的"实现列"（其余一律回落到 in_progress，**不得退到 backlog/done 这类错列**）。 */
export const REVIEW_SOURCE_STATUSES = Object.freeze(["in_progress", "todo"]);

/** 返工应退回哪一列：请求评审时记下的来源列；非法/缺失 → 回落到"进行中"（实现列）。 */
export function reviewReturnStatus(reviewSourceStatus) {
  const src = String(reviewSourceStatus ?? "");
  return REVIEW_SOURCE_STATUSES.includes(src) ? src : "in_progress";
}

/** 评审链是否成环（沿 reviewDependsOn 走；names 便于人读）。 */
export function reviewChain(store, task, { maxHops = 20 } = {}) {
  const names = [task.identifier];
  const ids = new Set([task.id]);
  let cursor = task;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const nextId = cursor?.reviewDependsOn ? String(cursor.reviewDependsOn) : "";
    if (!nextId) break;
    if (ids.has(nextId)) return { names, cycle: true, cycleTo: nextId, nodes: [] };
    const next = (() => { try { return store.getTaskById(nextId); } catch { return null; } })();
    if (!next) return { names, cycle: false, missing: nextId, nodes: [] };
    ids.add(next.id);
    names.push(next.identifier);
    cursor = next;
  }
  return { names, cycle: false, nodes: [] };
}

/**
 * 评审死锁判定（只读遍历）。返回 null（正常）或 {deadlocked, kind, reason, chain}。
 * 四种死锁：
 *   · cycle            评审链成环（A 等 B 评审、B 等 A 评审）
 *   · reviewer-blocked 评审者自身被阻断（"评审者被阻塞"）
 *   · reviewer-missing 依赖的评审任务已不存在
 *   · unassigned       未指派评审者且已停摆超阈值
 */
export function detectReviewDeadlock(store, task, { now = Date.now(), idleMs = REVIEW_IDLE_MS } = {}) {
  if (!task || task.status !== "in_review") return null;
  const state = task.reviewState ?? "pending";
  if (state === "approved") return null; // 已通过，只差人确认完成
  const chain = reviewChain(store, task);
  if (chain.cycle) return { deadlocked: true, kind: "cycle", reason: `评审链成环：${chain.names.join(" → ")} →（回到起点）`, chain: chain.names };
  if (chain.missing) return { deadlocked: true, kind: "reviewer-missing", reason: `评审依赖的任务已不存在（${chain.missing}）`, chain: chain.names };
  let cursor = task;
  const seen = new Set([task.id]);
  for (let hop = 0; hop < 20; hop += 1) {
    const nextId = cursor?.reviewDependsOn ? String(cursor.reviewDependsOn) : "";
    if (!nextId) break;
    if (seen.has(nextId)) break;
    seen.add(nextId);
    const next = (() => { try { return store.getTaskById(nextId); } catch { return null; } })();
    if (!next) break;
    if (next.status === "blocked") {
      return { deadlocked: true, kind: "reviewer-blocked", reason: `评审者自身受阻：${next.identifier}（${next.blockKind ?? "未分类"}）`, chain: chain.names };
    }
    cursor = next;
  }
  if (!task.reviewer) {
    const since = task.reviewRequestedAt ?? task.updatedAt;
    const minutes = since ? Math.max(0, Math.round((now - new Date(since).getTime()) / 60000)) : 0;
    if (minutes * 60000 >= idleMs) {
      return { deadlocked: true, kind: "unassigned", reason: `未指派评审者，已 ${minutes} 分钟无人评审`, chain: chain.names, minutes };
    }
  }
  return null;
}

