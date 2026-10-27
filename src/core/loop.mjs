/**
 * loop.mjs —— 看板执行循环（FR-68/70）。
 * 把"人工设为待执行(todo)且已归因"的任务，按活跃执行者引擎自动派发（建团队记录 + 任务级锁 + 转进行中）。
 * 供 ①API 手动触发 ②插件定时器周期触发 共用。
 */
import { resolveCliExecutor, executeTaskWithCli, DEFAULT_TIMEOUT_MS } from "./executor.mjs";
import { isHumanReviewTask } from "./human-review.mjs";
import { normalizeQualityGates } from "./team.mjs";

/**
 * 正在后台跑的 CLI 执行（任务 id → Promise）。用途：①防重复启动 ②供 API/UI 显示"执行中"。
 */
const cliRuns = new Map();
export function activeCliRuns() { return [...cliRuns.keys()]; }
function directiveFor(engine, { teamId, taskRef, requirementId, qualityGates = null }) {
  const head = engine === "official"
    ? `[派发团队 · DSH官方自带] teamId=${teamId} 请作为 Lead 用 spawn_teammate 召集成员、team_task_create 建任务看板。`
    : engine === "nanmicoder"
      ? `[派发团队 · @nanmicoder] teamId=${teamId}（agent_teams_create）`
      : `[派发团队] teamId=${teamId}`;
  // FR-50：质量门链按项目 `teamTemplate.qualityGates` 渲染（顺序 = 配置声明顺序）；
  // 未配置回落契约默认链，并在行内**注明来源**（配置 / 默认），与建队派发指令同口径。
  const { gates, source } = normalizeQualityGates({ qualityGates });
  return [
    head,
    `目标：${taskRef}`,
    requirementId ? `需求：${requirementId}` : "",
    `工作台任务标识：${taskRef}（执行/受阻请更新工作台状态：进行中→待验收；失败→受阻）`,
    `质量门（${source === "configured" ? "配置" : "默认"}）：${gates.join("→")}`,
    "操作指引：按依赖就绪认领 → 执行 → 提交\"待验收\"；不得置\"完成\"。",
  ].filter(Boolean).join("\n");
}

/**
 * FR-67：由「活跃执行者」团队（`teamTemplate.executionTeam`，形如 `<source>:<id>`）推导派发引擎。
 * 口径（团队来源 → 引擎）：
 *   · `official:*`      → `official`（DSH 官方自带智能体团队，spawn_teammate / team_task_*）
 *   · `third-party:*`   → `nanmicoder`（工作区 `.agent-teams/*`，@nanmicoder/dsh-agent-teams）
 * 未选择 / 形态不合法（取不到已知 source）→ 返回 `null`，表示"不参与覆盖"，回落项目引擎配置。
 */
export function engineOfExecutionTeam(executionTeam) {
  const raw = String(executionTeam ?? "").trim();
  if (!raw) return null;
  const idx = raw.indexOf(":");
  const source = idx >= 0 ? raw.slice(0, idx).trim() : raw;
  if (source === "official") return "official";
  if (source === "third-party") return "nanmicoder";
  return null;
}

/**
 * FR-67 + FR-68：**派发引擎解析** —— 活跃执行者团队优先，未选择时回落 `teamTemplate.engine`。
 * 返回 `{ engine, source }`，`source` ∈ `execution-team` / `team-template` / `port`（供核对口径）。
 */
export function resolveEngine(store, projectId) {
  const tpl = store.getProjectSettings(projectId).teamTemplate ?? {};
  const fromTeam = engineOfExecutionTeam(tpl.executionTeam);
  if (fromTeam) return { engine: fromTeam, source: "execution-team", executionTeam: String(tpl.executionTeam).trim() };
  const fromTpl = String(tpl.engine ?? "").trim();
  if (fromTpl) return { engine: fromTpl, source: "team-template", executionTeam: null };
  return { engine: store.teamEnginePort?.mode ?? "instruction", source: "port", executionTeam: null };
}

export function activeEngine(store, projectId) {
  return resolveEngine(store, projectId).engine;
}

/** 列表行标记（`- ` / `* ` / `1. ` / `1)` / `1、`）。 */
const LIST_MARKER = /^([-*]|\d+[.)、])\s+/;
/** 句末标点：出现即视为散文正文（非可拆解清单）。 */
const SENTENCE_END = /[。！？；]/;
/** 自动拆解的列表行数量上下限（含）与单行正文长度上限。 */
const MIN_LIST_LINES = 2;
const MAX_LIST_LINES = 6;
const MAX_LINE_BODY = 80;

/**
 * 提取描述里的列表行正文（去掉列表标记后的文本）。
 * 只做纯文本判定，不产生任何副作用。
 */
function listLineBodies(description) {
  return String(description || "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => LIST_MARKER.test(l))
    .map((l) => l.replace(LIST_MARKER, "").trim());
}

/**
 * 复杂任务判定（P0-7 收紧）：只认**显式可拆解**。
 * ① 带 `complex` / `复杂` 标签 → 复杂；
 * ② 否则要求描述里的列表行数在 2–6 条之间（含），每条去标记后正文 ≤80 字符，
 *    且不含句末标点（。！？；）——出现任一条即视为散文正文，不自动拆解。
 */
export function isComplexTask(task) {
  if ((task.labels || []).some((l) => /complex|复杂/i.test(String(l)))) return true;
  const bodies = listLineBodies(task.description);
  if (bodies.length < MIN_LIST_LINES || bodies.length > MAX_LIST_LINES) return false;
  return bodies.every((b) => b.length > 0 && b.length <= MAX_LINE_BODY && !SENTENCE_END.test(b));
}

function decomposeTitles(task) {
  const lines = String(task.description || "").split("\n").map((l) => l.trim().replace(/^([-*]|\d+[.)、])\s+/, "").trim()).filter((l) => l && l.length <= 100);
  return lines.length >= 2 ? lines : [`${task.title} — 实现`, `${task.title} — 验证`];
}

/**
 * FR-86：**共享文件**清单一——同轮并行改同一个文件即"共享文件冲突"，必须显式串行。
 * 只认这几个跨层共享文件（其余文件并行改动不构成必须串行的关键冲突）。
 */
export const SHARED_FILES = Object.freeze(["store.mjs", "api.mjs", "web/app.js", "index.js"]);

/**
 * FR-86：从任务**标题 + 描述**里解析"目标文件集合"。
 * 判定口径：文本里出现上述共享文件名的**路径引用**（可带目录前缀，如 `src/core/store.mjs`）即算引用；
 * **解析不到就视为无冲突**（空集合不参与冲突判定，绝不臆测）。
 */
export function targetFilesOf(task) {
  const text = String(`${task?.title ?? ""}\n${task?.description ?? ""}`);
  const found = [];
  for (const file of SHARED_FILES) {
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 前置：串首或分隔符（路径分隔 / 空白 / 引号括号等）；后置：不得紧跟文件名字符（避免 store.mjsx / index.json 误命中）
    const re = new RegExp(`(^|[\\s/\\\\"'\`(\\[=:,>])${escaped}(?![\\w.-])`);
    if (re.test(text)) found.push(file);
  }
  return found;
}

/** 需求条目的可读编号（取不到就回落 null，绝不因缺编号而抛错）。 */
function requirementLabel(store, requirementId) {
  if (!requirementId) return null;
  try { return store.getRequirementItemById(requirementId)?.identifier ?? null; } catch { return null; }
}

/**
 * FR-86：**影响域**——该任务**自身及其下游**（沿依赖图可达的后继），排除已完结(done)/已取消(canceled)。
 * 关键阻塞叫停只覆盖这个集合，**不得整批停**同需求其余任务。
 */
export function downstreamOf(store, task) {
  const out = [];
  const seen = new Set([task.id]);
  const queue = [task.id];
  while (queue.length) {
    let edges = [];
    try { edges = store.listTaskDependencies(queue.shift())?.blocks ?? []; } catch { edges = []; }
    for (const edge of edges) {
      if (seen.has(edge.id)) continue;
      seen.add(edge.id);
      const t = (() => { try { return store.getTaskById(edge.id); } catch { return null; } })();
      if (t) out.push({ id: t.id, identifier: t.identifier, title: t.title, status: t.status, requirementId: t.requirementId ?? null });
      if (!t || (t.status !== "done" && t.status !== "canceled")) queue.push(edge.id);
    }
  }
  return out;
}

/**
 * FR-86 关键阻塞判定（**只读**，纯函数：不改库、不抛错）→ 返回 `null`（可派发）或 `{ reason, detail }`。
 *
 * 三种"关键阻塞"（其余一律不叫停——同需求其余任务照常并行）：
 *   · `review-not-passed`   FR-83 评审未过：`review_state=changes_requested` 的任务已完成过一轮评审门
 *                           却被退回，**不得**被当作"全新 todo"再自动派发。
 *   · `human-review-pending` FR-85 人工校验未结论：上游挂了人在环升级门且尚无结论，不得越过门推进。
 *   · `upstream-blocked`    上游依赖未就绪：前置处于**不会自行变 done** 的终态（受阻 / 人工停手 / 待办池 / 待验收）。
 *
 * 明确**不算**关键阻塞的情形：前置是普通未完成 todo —— 那些任务本身同轮就在派发队列里（FR-86 要的是最大并行，
 * 不是串行等待），因此不因"上游还没 done"就叫停下游。
 */
export function keyBlockOf(store, task) {
  if (task?.reviewState === "changes_requested") {
    return {
      reason: "review-not-passed",
      detail: `第 ${Number(task.reviewRound ?? 0)} 轮返工未通过（已退回来源列 ${task.reviewSourceStatus ?? "in_progress"}），须返工后再提交评审`,
    };
  }
  let blockers = [];
  try { blockers = store.listTaskDependencies(task.id)?.blockers ?? []; } catch { blockers = []; }
  const unmet = blockers.filter((b) => b.status !== "done" && b.status !== "canceled");
  if (!unmet.length) return null;
  const gate = unmet.find((b) => {
    const bt = store.getTaskById(b.id);
    return bt && isHumanReviewTask(bt) && (bt.humanReviewState ?? "pending") === "pending";
  });
  if (gate) {
    return { reason: "human-review-pending", detail: `上游人工校验门 ${gate.identifier} 尚无结论（FR-85），不得越过该门推进` };
  }
  return { reason: "upstream-blocked", detail: `上游依赖未就绪：${unmet.map((b) => `${b.identifier}(${b.status})`).join("、")}` };
}

/**
 * FR-86：同需求并行度汇总（"同轮尽多派发"的可核对证据）。
 * 每条带原因：该需求下被裁剪过则说明裁剪条数，否则说明只受并发上限约束。
 */
function summarizeParallel(store, dispatched, stopped, serialized) {
  const groups = new Map();
  for (const d of dispatched) {
    const t = store.getTaskRef(d.task);
    const key = t?.requirementId ?? null;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d.task);
  }
  return [...groups.entries()]
    .map(([requirementId, tasks]) => {
      let identifier = null;
      try { identifier = requirementId ? (store.getRequirementItemById(requirementId)?.identifier ?? null) : null; } catch { identifier = null; }
      const cut = stopped.filter((s) => s.requirementId === requirementId).length + serialized.filter((s) => s.requirementId === requirementId).length;
      return {
        requirement: identifier ?? requirementId,
        requirementId: requirementId ?? null,
        dispatched: tasks,
        count: tasks.length,
        reason: cut
          ? `同需求最大并行：同轮派发 ${tasks.length} 条；另有 ${cut} 条因关键阻塞/共享文件冲突被裁剪（未整批停）`
          : `同需求最大并行：同轮派发 ${tasks.length} 条（仅受并发上限与任务级锁约束）`,
      };
    })
    .sort((a, b) => b.count - a.count);
}

/** FR-86：串行化让行时在看板**显式标注原因**（同因去重，避免定时循环反复刷屏）。 */
function markSerialized(store, task, holder, file) {
  const body = `【FR-86 串行化】与任务 ${holder} 冲突于共享文件 ${file}：本轮让行（待其执行结束后才放行；同需求其余任务照常并行）。`;
  try {
    if (store.listComments(task.identifier).some((c) => c.body === body)) return;
    store.addComment(task.identifier, { body });
  } catch { /* 标注失败不影响裁剪结论 */ }
}

/** 派发单个任务：建团队记录 + 任务级锁 + 转"进行中"（把派发目标会话写进任务，供"是否仍在执行"跟踪）。 */
function dispatchOne(store, emit, task, engine, targetSessionId = null) {
  if (store.getTaskLock(task.id)) return null;
  const run = store.createTeamRun({ targetTask: task.id });
  // 记录团队成员（来自项目团队模板；无则按任务归属角色/默认 engineer）——避免"成员为空"
  const tpl = store.getProjectSettings(task.projectId).teamTemplate ?? {};
  const roles = (tpl.roles || []).map((r) => r.role).filter(Boolean);
  for (const role of (roles.length ? roles : [task.owner || "engineer"])) { try { store.addTeamMember({ teamId: run.id, role }); } catch { /* ignore */ } }
  try { store.acquireTeamTask({ teamId: run.id, task: task.id, kind: "work" }); } catch { return null; }
  store.startTaskExecution(task.id, { sessionId: targetSessionId ?? null });
  emit("task.updated", { taskId: task.id, identifier: task.identifier, status: "in_progress" });
  const directive = directiveFor(engine, { teamId: run.id, taskRef: task.identifier, requirementId: task.requirementId, qualityGates: tpl.qualityGates ?? null });
  return { task: task.identifier, teamId: run.id, mode: engine, sessionId: targetSessionId ?? null, head: directive.split("\n")[0], directive };
}

/**
 * 已有执行会话仍在执行且未返回结论 → 不得再次下发。
 * 判定：该任务已记录执行会话，且宿主 agents 注册表显示该会话 `running`（或 inbox 仍有待消费消息）。
 */
function inflightOf(store, task) {
  const state = store.taskSessionState(task);
  if (!state?.sessionId) return null;
  if (state.running || (state.live && (state.pending ?? 0) > 0)) {
    return { sessionId: state.sessionId, status: state.status ?? null, pending: state.pending ?? 0 };
  }
  return null;
}

/**
 * 任务下发：把派发指令投递到项目**主会话**（真实闭环）。无绑定会话 / 宿主无 prompt 能力则如实标注降级。
 */
async function deliverDispatched(store, project, dispatched) {
  const boundSessionId = project?.initialSessionId ?? null;
  const port = store.hostSessionPort;
  const result = { boundSessionId, delivered: 0 };
  if (!dispatched.length) return result;
  const reason = boundSessionId ? "prompt-unavailable" : "no-bound-session";
  for (const d of dispatched) { d.delivered = false; d.deliveryReason = reason; }
  if (!boundSessionId || typeof port?.sendPrompt !== "function") return result;
  // 一轮只投递**一条**汇总指令（避免拆解出大量子任务时刷屏目标会话）。
  const lines = [`[任务工作台下发] 本轮派发 ${dispatched.length} 条任务（请作为项目执行团队承接）：`];
  for (const d of dispatched) lines.push(`· ${d.task}（teamId=${d.teamId}）`);
  lines.push("操作指引：按依赖就绪逐个认领 → 执行 → 提交\"待验收\"（失败→受阻）；不得置\"完成\"（人工确认）。");
  lines.push("状态回写：任务看板 taskboard_update_status（进行中/待验收/受阻），完成由人工确认。");
  let r = null;
  try { r = await port.sendPrompt(boundSessionId, lines.join("\n")); } catch { r = null; }
  const sent = Boolean(r?.sent);
  for (const d of dispatched) {
    d.delivered = sent;
    d.deliveryReason = sent ? null : (r?.reason ?? "unknown");
    if (sent) { try { store.addComment(store.requireTaskRef(d.task).id, { body: `已下发派发指令到主会话 ${boundSessionId}` }); } catch { /* ignore */ } }
  }
  if (sent) result.delivered = dispatched.length;
  return result;
}

/**
 * CLI 执行器派发（"由看板侧真的调 claude CLI 干活"）。
 * 命中条件：项目设置里角色执行器是 `cli:*`（本仓库约定 engineer → `cli:claude`）。
 * 语义：**后台启动**（一次真实开发可能几十分钟，不能阻塞 HTTP 请求）→ 立即把任务标为已投递，
 *      执行结果由执行器自己回写看板（评论证据 + 尝试记录 + 状态回流）。
 * 返回 `null` 表示该项目没有配 CLI 执行器（调用方回落原"投递主会话"路径）。
 */
function deliverViaCliExecutors(store, project, dispatched, options = {}) {
  if (!dispatched.length) return null;
  const settings = store.getProjectSettings(project.id);
  const executor = resolveCliExecutor(settings);
  if (!executor) return null;
  const { spawnImpl, env, now, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  for (const d of dispatched) {
    const task = store.requireTaskRef(d.task);
    if (cliRuns.has(task.id)) { d.delivered = false; d.deliveryReason = "cli-already-running"; continue; }
    d.delivered = true; d.deliveryReason = null; d.via = executor.id;
    const promise = executeTaskWithCli({ store, task, project, settings, spawnImpl, env, now, timeoutMs })
      .catch((error) => ({ ran: false, reason: String(error?.message ?? error) }))
      .finally(() => { cliRuns.delete(task.id); try { options.onFinish?.({ task: task.identifier }); } catch { /* ignore */ } });
    cliRuns.set(task.id, promise);
  }
  const delivered = dispatched.filter((d) => d.delivered).length;
  return { boundSessionId: project.initialSessionId ?? null, delivered, via: executor.id, executor: executor.id, background: true };
}

/**
 * 任务的"逻辑身份"：同需求 + 同派生链（parentId 根）+ 同标题 → 视为**同一逻辑任务**。
 * 用途：防重复派发（历史遗留的兄弟任务不得被再次拆解派发），与"共享文件冲突"无关。
 */
function logicalKeyOf(task, rootOf) {
  return `${task.requirementId ?? ""}|${rootOf(task)}|${String(task.title ?? "").trim()}`;
}

export async function runExecutionLoop({ store, events, projectId, limit = 20, cliOptions = null } = {}) {
  const project = store.requireProject(projectId);
  // FR-67：派发引擎 = 活跃执行者团队优先（`executionTeam`）→ 回落项目引擎配置。
  const { engine, source: engineSource, executionTeam } = resolveEngine(store, project.id);
  const targetSessionId = project.initialSessionId ?? null; // 派发目标=项目主会话（也写入任务，供状态跟踪）
  const emit = (type, payload) => { try { events?.publish?.(type, payload); } catch { /* ignore */ } };
  const todos = store.listTasks({ projectId: project.id, status: "todo" }).filter((t) => t.requirementId);
  const dispatched = []; const decomposed = []; const blockedByInflight = []; const blockedByGuard = []; let skipped = 0;
  // FR-85b：人工校验任务**不是可派发的工作**（执行侧不得认领、不得置 done）。
  // 一旦它出现在「可开工」列，这里必须整批跳过并如实给出原因，绝不投递给任何执行者。
  const blockedByHumanReview = [];
  // FR-86：被关键阻塞裁剪的任务（结构化，带原因与影响域）。
  const stopped = []; const blockedByUpstream = [];
  // FR-86：因共享文件冲突被显式串行化的任务（同轮只放行一条）。
  const serialized = [];

  // ---- FR-86 批级索引 ----
  // ① 同轮已占用的共享文件（file → 已放行任务标识）：同轮只放行一条，其余串行化。
  const batchFiles = new Map();
  // ② "逻辑任务"去重：同需求同派生链下已有同名任务（非本批）→ 本批同名 todo 视为历史遗留，不再派发。
  const projectTasks = store.listTasks({ projectId: project.id });
  const byId = new Map(projectTasks.map((t) => [t.id, t]));
  // FR-86 跨轮（真机复现 2026-10-18）：冲突表若只统计**本轮**放行的任务，被让行的那条会在下一跳
  // 因前一条已离开 `todo`（转进行中）而被放行 —— 于是同一共享文件被两条任务**并行修改**
  // （实测两条 claude 任务重叠执行约 105s）。故把**在途**任务的共享文件占用也并进本轮索引，
  // 让"让行"判定跨轮成立：只要占用方仍在执行（有认领锁或未结束的尝试记录），本轮就不放行。
  const occupying = (t) => {
    if (t?.status !== "in_progress") return false;
    if (t.claimLock) return true;
    try { if (store.getCurrentRun(t)) return true; } catch { /* ignore */ }
    // 会话投递路径不建尝试记录，但派发时必留下任务级执行锁（团队执行单元 open/running）；
    // 该锁在任务离开"进行中"时一并关闭，故可安全用作"仍在执行"的判据。
    try { return Boolean(store.getTaskLock(t.id)); } catch { return false; }
  };
  for (const t of projectTasks) {
    if (!occupying(t)) continue;
    for (const f of targetFilesOf(t)) if (!batchFiles.has(f)) batchFiles.set(f, t.identifier);
  }
  const rootOf = (t) => {
    let cur = t; const seen = new Set([t.id]);
    while (cur?.parentId && byId.has(cur.parentId) && !seen.has(cur.parentId)) { seen.add(cur.parentId); cur = byId.get(cur.parentId); }
    return cur?.id ?? t.id;
  };
  const batchIds = new Set(todos.map((t) => t.id));
  const batchKeys = new Set(todos.map((t) => logicalKeyOf(t, rootOf)));
  const substantive = new Set(["blocked", "in_review", "in_progress", "done", "canceled", "todo"]);
  const dupKeys = new Set();
  for (const t of projectTasks) {
    if (batchIds.has(t.id)) continue;
    if (!substantive.has(t.status)) continue;
    const key = logicalKeyOf(t, rootOf);
    if (batchKeys.has(key)) dupKeys.add(key);
  }

  // 派发槽位：共享文件冲突检查（显式串行）→ 建锁派发 → 占用文件。
  let slotCount = 0;
  const dispatchSlot = (task, files) => {
    const holder = files.map((f) => ({ file: f, task: batchFiles.get(f) })).find((x) => x.task);
    if (holder) {
      serialized.push({
        task: task.identifier, requirementId: task.requirementId, requirement: requirementLabel(store, task.requirementId),
        reason: "shared-file-conflict", file: holder.file, heldBy: holder.task,
        detail: `目标文件 ${holder.file} 与任务 ${holder.task} 冲突（该任务本轮已放行或仍在执行中）：本轮只放行一条，其余显式串行`,
      });
      markSerialized(store, task, holder.task, holder.file);
      return false;
    }
    const d = dispatchOne(store, emit, task, engine, targetSessionId);
    if (!d) { skipped += 1; return false; }
    dispatched.push(d); slotCount += 1;
    for (const f of files) batchFiles.set(f, task.identifier);
    return true;
  };

  // 候选项队列：本批 todo + 复杂任务拆解出的子任务（子任务继承授权点=todo，同轮尽多派发）。
  const candidates = todos.map((t) => ({ task: t, parent: null }));
  for (let i = 0; i < candidates.length && slotCount < limit; i += 1) {
    const t = candidates[i].task;
    if (isHumanReviewTask(t)) { blockedByHumanReview.push({ task: t.identifier, reason: "human-review" }); continue; }
    if (store.getTaskLock(t.id)) { skipped += 1; continue; }
    if (dupKeys.has(logicalKeyOf(t, rootOf))) {
      stopped.push({
        task: t.identifier, requirementId: t.requirementId, requirement: requirementLabel(store, t.requirementId),
        reason: "duplicate-of-existing", detail: "同需求同派生链下已存在同名任务：防重复派发（历史遗留副本不再派发）",
      });
      continue;
    }
    // 防重复下发：已有执行会话仍在执行（未返回结论）→ 停发并记录提醒。
    const inflight = inflightOf(store, t);
    if (inflight) { blockedByInflight.push({ task: t.identifier, ...inflight }); continue; }
    // FR-86：关键阻塞 → 只停**该任务 + 依赖它的下游**（记影响域），同需求其余任务照常并行。
    // 顺序上先于 FR-78 守卫：评审未过/上游未就绪是**批次级**的关键阻塞，原因比"近期成功窗口"这类
    // 单任务守卫更根本 —— 若先判守卫，返工退回的任务会被报成 `recent-success`，把真实原因盖掉。
    const key = keyBlockOf(store, t);
    if (key) {
      const entry = {
        task: t.identifier, requirementId: t.requirementId, requirement: requirementLabel(store, t.requirementId),
        reason: key.reason, detail: key.detail, downstream: downstreamOf(store, t),
      };
      stopped.push(entry);
      if (key.reason === "upstream-blocked") blockedByUpstream.push({ task: t.identifier, reason: key.reason, detail: key.detail });
      continue;
    }
    // FR-78：失败熔断 / 配额鉴权 / 近期成功窗口 → 不自动重试
    const guard = typeof store.dispatchGuard === "function" ? store.dispatchGuard(t) : null;
    if (guard) { blockedByGuard.push({ task: t.identifier, reason: guard }); continue; }
    // FR-69：复杂任务 → 先自动拆解为关联子任务（子任务继承授权点=todo）→ 再派发子任务
    if (isComplexTask(t)) {
      const children = [];
      for (const title of decomposeTitles(t)) {
        const child = store.createTask({ projectId: project.id, title, status: "todo", parentId: t.id, description: t.description });
        if (t.requirementId) { try { store.associateRequirementTask(t.requirementId, child.id); } catch { /* ignore */ } }
        children.push(child);
      }
      try { store.updateTask(t.identifier, { expectedVersion: t.version, status: "in_progress" }); } catch { /* ignore */ }
      emit("task.updated", { taskId: t.id, identifier: t.identifier, status: "in_progress" });
      decomposed.push({ parent: t.identifier, children: children.map((c) => c.identifier) });
      // 子任务同轮尽多派发（上限前直接派发，不再一条一条串）
      for (const c of children) {
        if (slotCount >= limit) {
          stopped.push({
            task: c.identifier, requirementId: c.requirementId, requirement: requirementLabel(store, c.requirementId),
            reason: "batch-limit", detail: `同轮并发上限 ${limit} 已用满：本轮不再派发（下一轮继续）`,
          });
          continue;
        }
        dispatchSlot(c, targetFilesOf(c));
      }
      continue;
    }
    if (slotCount >= limit) {
      stopped.push({
        task: t.identifier, requirementId: t.requirementId, requirement: requirementLabel(store, t.requirementId),
        reason: "batch-limit", detail: `同轮并发上限 ${limit} 已用满：本轮不再派发（下一轮继续）`,
      });
      continue;
    }
    dispatchSlot(t, targetFilesOf(t));
  }
  // 下发：①项目配了 CLI 执行器（`cli:*`）→ 由看板侧**真的**调 CLI 干活（后台）；
  //      ②否则回落"把派发指令投递到项目主会话"（当前 DSH 版本受 preset/scope 限制，多会降级）。
  const cliDelivery = deliverViaCliExecutors(store, project, dispatched, {
    ...(cliOptions ?? {}), onFinish: (info) => emit("task.updated", { identifier: info.task, status: "cli-finished" }),
  });
  const delivery = cliDelivery ?? await deliverDispatched(store, project, dispatched);
  if (cliDelivery) {
    for (const d of dispatched) {
      if (!d.delivered) continue;
      try { store.addComment(store.requireTaskRef(d.task).id, { body: `已交给 CLI 执行器 ${cliDelivery.executor} 后台执行（${d.task}）` }); } catch { /* ignore */ }
    }
  }
  // FR-81：本轮结束后把各订阅游标之后的**终态事件**推送出去（工作台关着也能闭环回会话）。
  // 投递失败不抛错：订阅自己保留游标、记 last_error，下轮（或人工 flush）自动重试。
  let notifications = { count: 0, results: [] };
  try { notifications = await store.flushNotifySubscriptions({ projectId: project.id }); } catch { notifications = { count: 0, results: [], error: "flush-failed" }; }
  for (const item of notifications.results) {
    if (item.delivered) emit("notify.delivered", { projectId: project.id, subscriptionId: item.id, kinds: item.kinds, count: item.count });
  }
  return {
    engine, engineSource, executionTeam, candidates: todos.length, dispatched, decomposed, skipped,
    blockedByInflight, blockedByGuard, blockedByHumanReview, boundSessionId: delivery.boundSessionId, delivered: delivery.delivered,
    deliveryVia: delivery.via ?? (delivery.delivered ? "session" : null),
    notifications,
    // FR-86：并行策略的**结构化裁剪结果**（每条带原因）。
    // 已有字段名与语义一律不动：下面三项是**新增**的观测口径。
    //   · parallel   —— 按需求条目汇总的"同轮尽多派发"结果（含每条需求被裁剪几条）
    //   · serialized —— 因共享文件冲突被显式串行化的任务（带冲突文件与让行对象）
    //   · stopped    —— 被关键阻塞/并发上限裁剪的任务（带原因 + 影响域 downstream）
    parallel: summarizeParallel(store, dispatched, stopped, serialized),
    serialized,
    stopped,
    blockedByUpstream,
  };
}

/** 已开启"执行循环"的项目。 */
export function listLoopProjects(store) {
  return store.listProjects().filter((p) => store.getProjectSettings(p.id).loop?.enabled);
}
