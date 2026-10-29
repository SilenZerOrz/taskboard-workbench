/**
 * advance.mjs —— 项目级「推进清单」与「决定回写」（2026-10-28 拍板 E1–E3）。
 *
 * 为什么需要它：工作台已有三份**按状态切片**的只读视图
 *   `projectWatchdog`（只扫 in_progress）· `projectDiagnostics`（in_progress/blocked/in_review）·
 *   `GET /reviews`（评审态）。三者都**不含 `todo`（可派发）卡**，也都不产出 `action` / `decision_id`
 *   ⇒ 人只能逐卡点开才知道"现在该干什么"。
 *
 * 本模块只做两件事：
 *   ① `buildAdvance` —— 五类合一、按"先解锁再推进"排序的**纯投影**（不写库、可复算、同状态字节级一致）；
 *   ② `applyDecision` —— 把主会话里人的一句结论**幂等**落回卡（同 `decisionId` 只产生一次副作用）。
 *
 * 铁律（E3）：**`done` 仍只由人点** —— `accept/complete` 必须 `actor === "human"`，否则 409。
 */
import { createHash } from "node:crypto";

import { TbError } from "./errors.mjs";
import { projectWatchdog } from "./watchdog.mjs";

/** 五类待办；排序＝先解锁（等人定）再推进（可开工）。 */
export const ADVANCE_KINDS = Object.freeze(["decide", "blocked", "review", "accept", "dispatch"]);
const KIND_RANK = Object.freeze({ decide: 0, blocked: 1, review: 2, accept: 3, dispatch: 4 });

/**
 * 稳定的 `decision_id`：**不含时间戳、不含序号** ⇒ 同一待办在两次请求里 id 相同，
 * 重复提交才能幂等；待办消失（卡进 done）后 id 自然不再出现。
 */
export function advanceItemId(projectId, kind, taskRef, discriminator = "") {
  return `adv-${createHash("sha1").update(`${projectId}|${kind}|${taskRef}|${discriminator}`).digest("hex").slice(0, 12)}`;
}

const refSortValue = (identifier) => {
  const n = Number(String(identifier ?? "").replace(/^[^0-9]*/, ""));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
};

/** 分类一条卡（返回 null＝不进清单，例如正常跑着的 in_progress / backlog）。 */
function classify(task, watchdog) {
  const state = watchdog?.state ?? null;
  const unattributed = !task.requirementId;
  if (task.humanReviewState === "pending" || state === "awaiting-decision") {
    return {
      kind: "decide",
      why: task.humanReviewState === "pending" ? "人工校验待结论" : "执行侧在提问，等人给结论",
      actions: [{ code: "choose", label: "给结论" }],
    };
  }
  if (task.status === "blocked" || state === "stalled") {
    if (task.status === "blocked" && unattributed) {
      return {
        kind: "blocked",
        why: "卡住了 + 未归因：补上需求条目前派发会被拒（EXECUTION_NOT_ATTRIBUTED）",
        actions: [{ code: "attribute", label: "补归因" }, { code: "retry", label: "重试" }],
      };
    }
    if (task.status === "blocked") {
      return { kind: "blocked", why: `卡住了：${task.blockKind ?? "未分类"}`, actions: [{ code: "retry", label: "重试" }] };
    }
    return { kind: "blocked", why: "停滞：长时间无进展", actions: [{ code: "retry", label: "重试" }] };
  }
  if (task.status === "in_review") {
    if (task.reviewState === "approved") {
      return { kind: "accept", why: "评审已通过，等你点「完成」", actions: [{ code: "complete", label: "完成（只人）" }] };
    }
    return { kind: "review", why: "等评审", actions: [{ code: "approve", label: "评审通过" }, { code: "changes", label: "返工" }] };
  }
  if (task.status === "todo") {
    if (unattributed) {
      return {
        kind: "blocked",
        why: "未归因：派发会被拒（EXECUTION_NOT_ATTRIBUTED），先补需求条目",
        actions: [{ code: "attribute", label: "补归因" }],
      };
    }
    return { kind: "dispatch", why: "可开工（已归因），等你派发", actions: [{ code: "dispatch", label: "派发" }] };
  }
  return null;
}

/**
 * 纯投影：同一状态重复调用**字节级一致**（不含 `now`/`minutes` 等随时间变化的字段）。
 * `done` / `canceled` 一律不出现。
 */
export function buildAdvance(store, projectId, { now = null } = {}) {
  const project = store.requireProject(projectId);
  const tasks = store.listTasks({ projectId })
    .filter((t) => t.status !== "done" && t.status !== "canceled");
  const watched = new Map((projectWatchdog(store, projectId, { now: now ?? Date.now() }) ?? []).map((r) => [r.identifier, r]));
  const items = [];
  for (const task of tasks) {
    const verdict = classify(task, watched.get(task.identifier) ?? null);
    if (!verdict) continue;
    items.push({
      id: advanceItemId(projectId, verdict.kind, task.identifier, verdict.why.includes("未归因") ? "unattributed" : ""),
      kind: verdict.kind,
      taskId: task.id,
      taskRef: task.identifier,
      title: task.title,
      status: task.status,
      requirementId: task.requirementId ?? null,
      why: verdict.why,
      actions: verdict.actions,
    });
  }
  items.sort((a, b) => (KIND_RANK[a.kind] - KIND_RANK[b.kind]) || (refSortValue(a.taskRef) - refSortValue(b.taskRef)) || String(a.taskRef).localeCompare(String(b.taskRef)));
  const counts = Object.fromEntries(ADVANCE_KINDS.map((k) => [k, 0]));
  for (const item of items) counts[item.kind] += 1;
  return { project: project.id, projectName: project.name ?? null, count: items.length, counts, items };
}

/** 把清单渲染成**可直接投给主会话**的指令装载块（P-B）。 */
export function renderAdvanceBlock(list) {
  const head = `【项目推进清单 · ${list.projectName ?? list.project}】`;
  if (list.count === 0) return `${head}\n当前无待办（0 项）。不需要写 todo。`;
  const tally = ADVANCE_KINDS.map((k) => `${k} ${list.counts[k]}`).join(" / ");
  const lines = list.items.map((item, i) => (
    `${i + 1}. [${item.kind}] #${item.taskRef} ${item.title} —— ${item.why}    decision_id=${item.id}`
  ));
  return [
    head,
    `共 ${list.count} 项待办（${tally}）。请用 todo_write 把它们写成你的 todo，然后逐项推进：`,
    ...lines,
    "规则：① 卡片的「完成」**不是你勾 todo**，只能由人点（accept 类必须人工确认）；",
    `      ② 需要人定的事项**停下来等人回复**，拿到结论后调用 POST /api/projects/${list.project}/advance/<decision_id>/decide；`,
    "      ③ dispatch 类请走既有派发入口（派发团队 / 交主会话执行），不要自己改卡状态。",
  ].join("\n");
}

/** 在主会话里找这条决定是否已经执行过（幂等重放判据）。 */
function findAppliedDecision(store, projectId, decisionId) {
  const events = store.listProjectEvents(projectId, { limit: 500, order: "desc" }) ?? [];
  for (const ev of events) {
    if (ev.type !== "decision" || !ev.detail) continue;
    try {
      const parsed = JSON.parse(ev.detail);
      if (parsed?.decisionId === decisionId) return { ...parsed, cursor: ev.cursor, taskRef: parsed.taskRef ?? null, at: ev.at };
    } catch { /* 非 JSON 的历史 detail 忽略 */ }
  }
  return null;
}

/**
 * 把一句决定落回卡：**幂等**（同 `decisionId` 第二次只返回首次结果，不再产生副作用）。
 * 支持 choice：accept/complete（**仅人**）· review/approve · review/changes · blocked/retry · decide/&lt;任意结论&gt;
 */
export function applyDecision(store, projectId, decisionId, { choice, note = null, actor = "human" } = {}) {
  store.requireProject(projectId);
  if (!choice) throw new TbError("USAGE_ERROR", "decide 必须带 choice（如 complete / approve / changes / retry，或一句结论）", { decisionId });
  const applied = findAppliedDecision(store, projectId, decisionId);
  if (applied) return { replay: true, decisionId, applied };

  const list = buildAdvance(store, projectId);
  const item = list.items.find((i) => i.id === decisionId);
  if (!item) throw new TbError("ADVANCE_ITEM_NOT_FOUND", "该待办已不存在（可能已收口或状态已变），请重新拉取清单", { decisionId, projectId });

  const task = store.getTaskById(item.taskId);
  const wanted = String(choice);
  let task2 = task;
  if (item.kind === "accept") {
    if (wanted !== "complete") throw new TbError("USAGE_ERROR", `accept 类只接受 choice=complete，收到 ${wanted}`, { decisionId });
    // E3 红线：完成只能由人确认，执行侧/评审都不代点
    if (String(actor) !== "human") throw new TbError("HUMAN_CONFIRM_REQUIRED", "「完成」只能由人确认（actor 必须是 human）", { decisionId, actor });
    task2 = store.updateTask(task.identifier, { status: "done", expectedVersion: task.version, actor });
  } else if (item.kind === "review") {
    if (wanted === "approve") task2 = store.approveReview(task.identifier, { actor, comment: note ?? "" });
    else if (wanted === "changes") task2 = store.requestChanges(task.identifier, { actor, comment: note ?? "" });
    else throw new TbError("USAGE_ERROR", `review 类只接受 approve / changes，收到 ${wanted}`, { decisionId });
  } else if (item.kind === "blocked") {
    if (wanted === "retry") task2 = store.retryTaskExecution(task.identifier);
    else if (wanted === "attribute") {
      throw new TbError("ADVANCE_CHOICE_UNSUPPORTED", "补归因请走 POST /api/tasks/<ref>/attribution（本条决定不代做）", { decisionId, remedy: `POST /api/tasks/${task.identifier}/attribution {"requirement":"<条目>"}` });
    } else throw new TbError("USAGE_ERROR", `blocked 类只接受 retry，收到 ${wanted}`, { decisionId });
  } else if (item.kind === "dispatch") {
    throw new TbError("ADVANCE_CHOICE_UNSUPPORTED", "派发请走既有派发入口，decide 不做派发", { decisionId, remedy: "POST /api/tasks/<ref>/execution/start 或团队派发端点" });
  }

  const detail = JSON.stringify({ decisionId, kind: item.kind, choice: wanted, note, actor, taskRef: item.taskRef });
  const ev = store.recordTaskEvent(task.id, { type: "decision", to: wanted, actor: String(actor), detail });
  const after = buildAdvance(store, projectId);
  const stillThere = after.items.some((i) => i.id === decisionId);
  return {
    replay: false,
    decisionId,
    kind: item.kind,
    choice: wanted,
    taskRef: item.taskRef,
    taskStatus: (task2 && task2.status) || task.status,
    eventCursor: ev?.cursor ?? null,
    remaining: after.count,
    stillListed: stillThere,
  };
}
