/**
 * watchdog.mjs —— 执行看护（FR-75 停滞检测 / FR-76 "下一步建议"跟进）。
 *
 * 纯函数 + 只读 store 访问，零依赖，便于单测；**不写库**（副作用留给调用方）。
 * 判定口径（与 需求文档.md §二 N FR-75/FR-76 对齐）：
 *   · running             —— 执行**仍在进行**（会话在跑，或 CLI 执行器子进程在途）—— **永不**判停滞
 *   · awaiting-decision   —— 会话已空闲，但最新反馈含"下一步 / 建议"等可跟进项（等人决策，不是卡死）
 *   · stalled             —— 会话已空闲/未在线，且超过阈值无进展回报（疑似卡住）
 *   · idle / ok           —— 其它情况（含阈值内）
 *
 * 2026-10-22 真机 `-122` 补口：原口径只看**会话**（`sessionState.running`），而 CLI 执行器那条路
 * `sessionId` 恒为 `null` ⇒ 一路落 `session-offline`。真机现场：子进程真在跑（688s），看护却报
 * `stalled/high`「疑似停滞 11 分钟」，主按钮变「退回待办（重新派发）」——人一点就与仍在写文件的
 * 子进程并发同文件双写（违反 FR-86）。故补一路**与会话无关**的在途信号：当前尝试记录仍在跑
 * 且心跳新鲜（CLI 执行期每 45s 一次，见 `executor.HEARTBEAT_INTERVAL_MS`）。心跳一停（子进程结束 /
 * 执行器收尾），该信号自然消失 —— 不新增常驻心跳。
 */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;
export const WATCHDOG_STATES = Object.freeze(["ok", "idle", "running", "awaiting-decision", "stalled"]);

/** 有"进展意义"的评论标记（进度 / 反馈 / 团队回报 / 失败证据）。 */
const PROGRESS_MARKERS = ["进度", "【反馈】", "团队回报", "执行失败", "执行记录"];
/**
 * "下一步 / 建议"块的起始标记。
 * 注意：**不能用 `\b`**——中日韩字符在 JS 正则里不属于 `\w`，`\b` 在"下一步"之后不成立。
 */
const FOLLOWUP_HEAD = /^(后续步骤|下一步|后续|待决策|建议|next\s*step)/i;
/** 列表行（- / * / · / 1. / 1) / 1、）。 */
const LIST_ITEM = /^(?:[-*·]|\d+[.)、])\s+(.*)$/;

/**
 * 取最近一次"有报告意义"的评论：命中进展标记（进度/反馈/团队回报/失败/执行记录）
 * **或**含"下一步 / 建议"可跟进项（后者常以独立评论出现，未必带进展前缀）。
 */
export function latestProgressComment(comments = []) {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const body = String(comments[i]?.body ?? "");
    if (PROGRESS_MARKERS.some((marker) => body.includes(marker))) return comments[i];
    if (extractFollowups(body).length > 0) return comments[i];
  }
  return null;
}

/**
 * 从反馈文本提取"下一步 / 建议"条目。
 * 规则：命中起始标记后，收集紧随其后的列表行 / 疑问句；遇到普通段落即结束该块。
 */
export function extractFollowups(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const head = FOLLOWUP_HEAD.exec(line);
    if (head) {
      inBlock = true;
      // 标记行本身只在"非括号包裹的内联内容"时算条目（如 `下一步：直接重跑 finalize`）；
      // `下一步（马上做）：` 这类限定语不算。
      const rest = line.slice(head[0].length)
        .replace(/^[\s:：\-–]+/, "")
        .replace(/^[（(【][^）)】]*[）)】]\s*[：:]?\s*/, "") // `下一步（马上做）：X` → `X`
        .replace(/[：:]+$/, "")
        .trim();
      if (rest && !/^[（(【].*[）)】]$/.test(rest)) out.push(rest);
      continue;
    }
    if (!inBlock) continue;
    const item = LIST_ITEM.exec(line);
    if (item) { out.push(item[1].trim()); continue; }
    if (/[？?]$/.test(line) || /^(要|是否|请|需要)/.test(line)) { out.push(line); continue; }
    inBlock = false; // 普通段落 → 结束该块
  }
  return [...new Set(out.filter(Boolean))].slice(0, 10);
}

/** 反馈是否含"征询/待确认"信号（疑问句或明确请求确认）。 */
export function looksLikeQuestion(text) {
  const t = String(text ?? "");
  return /[？?]/.test(t) || /(是否|能不能|要不要|需要我|要我现在|请确认|待确认|等你)/.test(t);
}

/**
 * 在途尝试的**新鲜度**判定（纯函数）：当前尝试仍在跑，且心跳不比阈值旧 ⇒ 视为"仍在推进"。
 * CLI 执行器这条路的唯一在途信号（`sessionId` 恒为 null），因此这里是它不被误判停滞的着力点。
 * 心跳字段缺失 / 解析不出 → 用 `startedAt` 兜底（尝试刚开始时心跳就是 `startedAt`）。
 */
export function runInFlight(currentRun = null, { now = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  if (!currentRun || currentRun.status !== "running") return false;
  const at = currentRun.lastHeartbeatAt ?? currentRun.startedAt ?? null;
  if (!at) return true; // 在跑但没有时间戳：宁可算"在途"（误报停滞的代价更大）
  return now - new Date(at).getTime() < thresholdMs;
}

/** 单任务看护评估（纯函数）。 */
export function assessTask({ task, comments = [], sessionState = null, currentRun = null, now = Date.now(), thresholdMs = STALL_THRESHOLD_MS } = {}) {
  const base = { state: "ok", minutes: 0, lastProgressAt: null, followups: [], question: false, reason: null, session: sessionState ?? null };
  if (!task || task.status !== "in_progress") return base;
  const last = latestProgressComment(comments);
  const lastAt = last?.createdAt ?? task.updatedAt ?? null;
  const minutes = lastAt ? Math.max(0, Math.round((now - new Date(lastAt).getTime()) / 60000)) : 0;
  const body = String(last?.body ?? "");
  const followups = extractFollowups(body);
  const question = followups.length > 0 && looksLikeQuestion(body);
  // 会话可判（有 sessionId）时**只认会话状态**（那是精确信号，且会话路径的尝试记录要等 agent
  // 回写才闭合，拿它当在途信号会把"会话已空闲、等人回话"误判成"在跑"）。
  // 会话**不可判**（CLI 执行器路径 sessionId 恒为 null）时才补尝试心跳这一路。
  const sessionKnown = Boolean(sessionState?.sessionId);
  const running = Boolean(sessionState?.running) || (!sessionKnown && runInFlight(currentRun, { now, thresholdMs }));
  const live = Boolean(sessionState?.live);
  const reason = running ? null : live ? "session-idle" : "session-offline";
  if (running) return { ...base, state: "running", minutes, lastProgressAt: lastAt, followups, question };
  // 会话已不在执行：有可跟进项 → 等人决策；否则超阈值 → 停滞
  if (followups.length > 0) return { ...base, state: "awaiting-decision", minutes, lastProgressAt: lastAt, followups, question, reason };
  if (minutes >= Math.ceil(thresholdMs / 60000)) return { ...base, state: "stalled", minutes, lastProgressAt: lastAt, followups, question: false, reason };
  return { ...base, state: "idle", minutes, lastProgressAt: lastAt, followups, question: false, reason };
}

/** 便捷：按任务引用评估（读 store；不写）。 */
export function assessTaskRef(store, ref, options = {}) {
  const task = store.requireTaskRef(ref);
  return assessTask({
    task,
    comments: store.listComments(task.id),
    sessionState: store.taskSessionState(task),
    // CLI 执行器那条路 sessionId 恒为 null ⇒ 会话状态恒「不在线」。在途信号只能来自当前尝试
    // （执行期每 45s 续心跳，见 `executor.HEARTBEAT_INTERVAL_MS`）—— 少这一路就会误判停滞。
    currentRun: typeof store.getCurrentRun === "function" ? store.getCurrentRun(task) : null,
    ...options,
  });
}

/** 项目看护清单：只看需要人介入的状态（stalled / awaiting-decision），按严重度与停滞时长排序。 */
export function projectWatchdog(store, projectId, options = {}) {
  const tasks = store.listTasks({ projectId, status: "in_progress" });
  const rows = [];
  for (const task of tasks) {
    const assessed = assessTaskRef(store, task.identifier, options);
    if (assessed.state === "stalled" || assessed.state === "awaiting-decision") {
      rows.push({ identifier: task.identifier, title: task.title, ...assessed });
    }
  }
  const rank = { stalled: 0, "awaiting-decision": 1 };
  return rows.sort((a, b) => (rank[a.state] - rank[b.state]) || (b.minutes - a.minutes));
}
