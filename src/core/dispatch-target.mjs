/**
 * 派发目标解析（卡 `-264` / 需求 `R188`）—— **纯逻辑 + 注入探活**，不碰宿主、不写库。
 *
 * 背景（用户原话，2026-11-13）：默认指派 dsh 或其他 agent 授权执行任务卡片时，**应优先选取已绑定本项目的
 * 空闲会话接手**；没有绑定会话时，**要求第一次授权**，或在卡片点「执行」时**把授权指令一并带进去**。
 *
 * 此前行为：`/api/tasks/:ref/execute` 在没显式给 sessionId 时**一律新建会话** ——
 *   · 每派一张卡就多一条孤立会话（`project_sessions` 无行），只能靠 `-263` 的派生绑定才不被门挡住；
 *   · 项目里明明有空闲的主会话 / 已批准会话，却完全没被利用（主会话闲着也不用）。
 *
 * 判据分层（**只选判得出空闲的**，判不准一律不算 —— 不猜）：
 *   1. 主会话（`projects.initial_session_id`）
 *   2. 已批准关联会话（`project_sessions.status='approved'`，最近活跃优先）
 *   3. 派生执行会话（`tasks.session_id`，`-263`）—— **仅当它名下没有 `in_progress` 卡**（干完了待验收的才算空闲）
 * 空闲 = 宿主判得出：`exists !== false && live === true && running === false && pending === 0`。
 */

/** 会话是否「此刻空闲」——判不准（live=false / 无宿主通道 / 存在性未知但无 live）一律 false。 */
export function isIdleLiveness(liveness) {
  if (!liveness || typeof liveness !== "object") return false;
  if (liveness.exists === false) return false;         // 确认失效
  if (liveness.live !== true) return false;            // 进程内没有 Agent ⇒ 不知道它空不空闲（不猜）
  if (liveness.running === true) return false;         // 正在跑
  if (Number(liveness.pending ?? 0) > 0) return false; // inbox 里还有没消费的指令
  return true;
}

/**
 * 候选来源的**验收口径命名** —— `main` / `approved` / `executor`（需求 `R188` 验收①点名的三档）。
 *
 * 为什么另起一档（不直接用 `role`）：`role` 是**内部**说法（`associated` = 已批准关联会话），
 * 而验收条款对外说的是「main / approved / executor」—— 对外回包与界面文案用 `kind`，
 * 免得「同一个东西两个名字」在回包里对不上。
 */
const REUSED_FROM_KINDS = { main: "main", associated: "approved", executor: "executor" };

/** 把内部 `role` 映射成验收口径的来源名（认不出来的角色 ⇒ null，不臆断）。 */
export function reusedFromKind(role) {
  return Object.prototype.hasOwnProperty.call(REUSED_FROM_KINDS, role) ? REUSED_FROM_KINDS[role] : null;
}

/**
 * 枚举「已绑定本项目的会话」候选（**未探活**，纯读库）。
 * 顺序 = 主会话 > 已批准关联 > 派生执行会话；同一会话只出现一次（高优先级的那条胜出）。
 */
export function listBoundCandidates(store, projectId) {
  const project = store.getProject(projectId) ?? null;
  const out = [];
  const seen = new Set();
  const push = (item) => {
    if (!item?.sessionId || seen.has(item.sessionId)) return;
    seen.add(item.sessionId);
    out.push(item);
  };
  if (project?.initialSessionId) push({ sessionId: project.initialSessionId, role: "main", kind: "main", source: "project-main" });
  const approved = (store.listProjectSessions(projectId) ?? [])
    .filter((row) => row.sessionId && row.status === "approved")
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  for (const row of approved) push({ sessionId: row.sessionId, role: "associated", kind: "approved", source: "project-approved", updatedAt: row.updatedAt ?? null });
  // 派生执行会话：名下只要还有 in_progress 卡，就说明它正干着别的活 —— 不作为「空闲候选」。
  for (const ex of store.listExecutorSessions(projectId) ?? []) {
    const statuses = Array.isArray(ex.statuses) ? ex.statuses : [];
    if (statuses.includes("in_progress")) continue;
    push({ sessionId: ex.sessionId, role: "executor", kind: "executor", source: "task-derived", updatedAt: ex.lastActivityAt ?? null, tasks: ex.tasks ?? [] });
  }
  return out;
}

/**
 * 选出派发目标。返回：
 * ```
 * { decision: "reuse" | "create-and-authorize",
 *   target: { sessionId, role, kind, source, liveness } | null,
 *   candidates: [{ sessionId, role, kind, source, idle, why, liveness }],
 *   reason }
 * ```
 * `sessionStateOf(sessionId)` / `sessionOriginOf(sessionId, project)` 由调用方注入（api 层已有同一份实现，
 * 这里**不另写第二份探活**）。
 */
export async function pickDispatchTarget(store, projectId, { sessionStateOf = null, sessionOriginOf = null } = {}) {
  const project = store.getProject(projectId) ?? null;
  const candidates = [];
  for (const c of listBoundCandidates(store, projectId)) {
    // 归属校验：别把**别的项目工作区**的会话派给这张卡（FR-84 的同一把尺子）。
    let origin = null;
    if (typeof sessionOriginOf === "function") {
      try { origin = await sessionOriginOf(c.sessionId, project); } catch { origin = null; }
    }
    let liveness = null;
    if (typeof sessionStateOf === "function") {
      try { liveness = await sessionStateOf(c.sessionId); } catch { liveness = null; }
    }
    let why = null;
    let idle = false;
    if (origin?.mismatch === true) why = "other-workspace";
    else if (!liveness) why = "no-liveness";
    else if (liveness.exists === false) why = "session-gone";
    else if (liveness.live !== true) why = "liveness-unknown";
    else if (liveness.running === true) why = "running";
    else if (Number(liveness.pending ?? 0) > 0) why = "pending-prompts";
    else { idle = true; why = "idle"; }
    candidates.push({ ...c, idle, why, liveness, originCwd: origin?.cwd ?? null });
  }
  const hit = candidates.find((c) => c.idle) ?? null;
  return {
    decision: hit ? "reuse" : "create-and-authorize",
    target: hit ? { sessionId: hit.sessionId, role: hit.role, kind: hit.kind ?? reusedFromKind(hit.role), source: hit.source, liveness: hit.liveness } : null,
    candidates,
    reason: hit ? "bound-idle" : (candidates.length ? "bound-but-busy-or-unknown" : "no-bound-session"),
  };
}

/**
 * 投给**复用会话**的任务书。与 CLI 任务书（`executor.mjs#buildTaskPrompt`）不同：
 * 这是给**宿主会话**的短指令 —— 它本来就在工作区里，不需要 `--add-dir` / `cd` 那一套。
 * 但必须说清三件事：① 已授权（别再申请关联）；② 回写口径（四节）；③ 红线（不得置 done）。
 */
export function buildReuseDirective({ task, project, target = null } = {}) {
  const lines = [
    `任务 ${task?.identifier ?? ""}：${task?.title ?? ""}`,
    ``,
    `本会话已绑定项目「${project?.name ?? project?.id ?? ""}」（${project?.id ?? ""}）—— 工作台不会挡你；`,
    `这是**已授权**的派发（来源：${target?.role ?? "已绑定会话"}），**不需要再申请关联**。`,
  ];
  if (task?.acceptance) lines.push(`验收：${task.acceptance}`);
  if (task?.verifyCommand) lines.push(`复核动作：${task.verifyCommand}`);
  lines.push("操作指引：执行 → 回写四节证据（判定 / 偏离说明 / 边界自查 / 产物路径）→ 提交「待验收」；**不得置「完成」**（人工确认）。");
  lines.push("若本会话正在处理别的任务：先做完或显式说明冲突，不要静默丢弃本单。");
  return lines.join("\n");
}

/** 投给**新建会话**的授权段（会拼进 `createSession({preset})` 与任务书）。 */
export function buildAuthorizationDirective({ task, project, sessionId = null } = {}) {
  return [
    `【授权】本会话由看板「启动执行」显式授权，**首次绑定**项目「${project?.name ?? project?.id ?? ""}」（${project?.id ?? ""}）。`,
    `你**不得再申请**关联（本会话已被授权），配置页「会话关联」会显示本会话；工作台不会挡你。`,
    task?.identifier ? `本单：任务 ${task.identifier}：${task.title}` : "",
    // 与**复用路径**的任务书对齐：新建出来的会话同样是「空手接单」，不告诉它验收标准与复核动作，
    // 它就只能凭标题猜「做成什么样算做完」。（`R188` 判据锚点：任务书要写明哪张卡 + 回写与红线。）
    task?.acceptance ? `验收：${task.acceptance}` : "",
    task?.verifyCommand ? `复核动作：${task.verifyCommand}` : "",
    `完成后回写四节证据并提交「待验收」；**不得置「完成」**（人工确认）。`,
  ].filter(Boolean).join("\n");
}
