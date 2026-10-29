/**
 * store.mjs —— 存储与用例层（零依赖，node:sqlite）。
 * 单文件库 <dataDir>/taskboard.sqlite；幂等建库；编号事务内递增；乐观版本；
 * owner 为 tasks 正式列（t24）——老库的 `owner:<role>` 标签在打开时一次性迁移（幂等）。
 * 注意：tasks_owner_idx 只在迁移函数里创建（老库建表语句是 no-op，提前建索引会因缺列失败）。
 */
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveDataDir, resolveDbPath } from "./config.mjs";
import {
  DEFAULT_PRIORITY, DEFAULT_STATUS, GOVERNANCE_DEFAULTS,
  assertActor, assertNoCycle, assertParentLink, assertPriority, assertProjectId,
  assertStatus, assertTitle, checkGovernance, compareByPriority, formatIdentifier,
  normalizeDescription, normalizeLabels, parseIdentifier, slugify,
} from "./domain.mjs";
import { normalizeOwner, splitOwnerLabels } from "./owner.mjs";
import { TbError, invalidField } from "./errors.mjs";
import { computeContract, diffContract, evaluateSubmittedContract, loadNorms } from "./contract.mjs";
import { UNTAKEN_COMMENT_MARKER, detectUntakenDelivery } from "./delivery.mjs";
import { VERIFY_MAX_COMMAND, parseVerifyComment } from "./verify.mjs";
import {
  assertFeasibilityVerdict, assertRequirementSource, assertSplitTasks,
  elaborateDocument, formatRequirementIdentifier, normalizeTitle, parseRequirementIdentifier,
  titleKey, assertRequirementStatus, normalizeCandidates, summarizeRequirementCompletion,
  clampElaborateLimit, ELABORATE_PREVIEW_SIZE, DEFAULT_ELABORATE_LIMIT, MAX_ELABORATE_LIMIT,
} from "./requirements.mjs";
import { TEAM_WRITABLE_STATUSES } from "./team.mjs";
import { REVIEW_SOURCE_STATUSES, REVIEW_IDLE_MS, detectReviewDeadlock, reviewReturnStatus } from "./review.mjs";
import { NOTIFY_DELIVERY_MODES, buildNotifyMessage, normalizeDeliveryMode, selectNotifyEvents } from "./notify.mjs";
import { HUMAN_REVIEW_LABEL, assertConclusion, categoryLabel, conclusionOutcome, isHumanReviewTask, validateHumanReviewDraft } from "./human-review.mjs";
// 项目记忆（2026-10-28 拍板 D-M1）：L2 记忆条目，与内核表同库；**不是第二真源**（必带 provenance）。
import { createMemoryApi } from "./memory.mjs";

export const SCHEMA_VERSION = 12; // 12：契约快照（project_contract / flow_injections · P1）
// 条目化数量口径（卡 `-169` P4②）：定义在 requirements.mjs（纯模块），此处转发以便调用方就近取用。
export { clampElaborateLimit, DEFAULT_ELABORATE_LIMIT, MAX_ELABORATE_LIMIT, ELABORATE_PREVIEW_SIZE };


// ---- 任务级验收标准与复核动作（FR-94） ---------------------------------------
/**
 * 真机反馈（2026-10-22，用户在概览页标注）：「**为方便任务执行情况确认，应该在概览内任务添加时
 * 即记录完成验收及复核动作标准，以便快速复核**」。
 *
 * 缺口：此前只有**需求条目**带 `acceptance`，任务级没有 —— 卡做到「待验收」时，评审人手里
 * 只有 FR-90 的机器结论，**没有"这张卡当初说好按什么判定"** ⇒ 验收只能凭感觉。
 * 处置：任务也带两个字段，且**添加任务时就能写**。
 */
/** 验收标准上限（Markdown 原文保留；只是防把日志整段塞进来）。 */
export const ACCEPTANCE_MAX = 4000;

/** 验收标准归一：非字符串/未传 → `""`（未记录）；只截断，不改写、不臆断措辞。 */
export function normalizeAcceptance(value) {
  if (value === undefined || value === null) return "";
  return String(value).slice(0, ACCEPTANCE_MAX);
}

/**
 * 任务级「复核动作」（命令）归一：空串/未传 → `null` ＝**回落**（任务级 → 项目 `envConfig.verifyCommand`
 * → 内置默认），只有显式写了命令才覆盖。长度上限与 FR-90 的 `normalizeVerifyCommand` **同口径**
 * （常量从 `verify.mjs` 取，避免两份）。
 */
export function normalizeTaskVerifyCommand(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s === "" ? null : s.slice(0, VERIFY_MAX_COMMAND);
}

// ---- 尝试记录与事件流（FR-82） ------------------------------------------------
/** 单次尝试的默认运行时上限（毫秒）；超过即视为"超时"（看护/诊断据此给结论）。 */
export const DEFAULT_RUN_MAX_MS = 30 * 60 * 1000;
/** 尝试的终态取值（照抄 hermes `_end_run` 的 outcome 口径）。 */
export const RUN_OUTCOMES = Object.freeze(["success", "blocked", "failed", "crash", "timeout", "reclaimed", "cancelled", "released", "ended"]);

// ---- 评审流程（FR-83） ------------------------------------------------------
/** 置"受阻"的路由方式：`wait`=等父任务（回可开工，FR-80 默认）；`hold`=保持受阻直到外部解除（评审门红线③）。 */
export const BLOCK_ROUTES = Object.freeze(["wait", "hold"]);

/**
 * 纯函数：一次尝试是否**超过运行时上限**（FR-82 的 `max_ms`）。
 * 未结束的尝试按 `now` 计；已结束的按 `ended_at` 计 —— 用于把"跑太久"判成 `timeout` 而非"停滞"。
 */
export function runExceededMax(run, { now = Date.now(), maxMs = null } = {}) {
  if (!run || !run.startedAt) return false;
  const limit = Number(maxMs ?? run.maxMs ?? DEFAULT_RUN_MAX_MS);
  if (!Number.isFinite(limit) || limit <= 0) return false;
  const end = run.endedAt ? new Date(run.endedAt).getTime() : now;
  return end - new Date(run.startedAt).getTime() > limit;
}

// ---- 执行认领（FR-77）：带过期的认领锁 + 心跳 ------------------------------------
/** 认领默认存活时长；到期未续即视为"在途失效"。 */
export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;
/** 心跳新鲜度阈值：超过即认为执行侧已停止推进（**缺心跳本身不计为失败**）。 */
export const DEFAULT_HEARTBEAT_GAP_MS = 10 * 60 * 1000;
// ---- 失败会计与熔断（FR-78） ------------------------------------------------
/** 连续非成功次数的默认阈值；达到即自动置"受阻"并停止自动重试。 */
export const DEFAULT_FAILURE_LIMIT = 2;
/** 近期成功窗口：窗口内成功过的任务不得被再次自动派发（除非人工显式重跑）。 */
export const DEFAULT_SUCCESS_WINDOW_MS = 60 * 60 * 1000;
/**
 * 配额 / 鉴权类错误：**立即阻塞、不重试**（重试不会让配额回来）。
 * 正则照搬 hermes `_RESPAWN_BLOCKER_RE`（kanban_db_dispatch.py:43）。
 */
export const QUOTA_AUTH_ERROR_RE = /\b(quota|rate[\s_-]?limit|429|403|auth\w*|unauthorized|forbidden|billing|subscription|access[\s_]denied|permission[\s_]denied|invalid[\s_]api[\s_]key)\b/i;
// ---- 阻断原因分类与复发升级（FR-80） ----------------------------------------
/** 阻断类型（照搬 hermes `VALID_BLOCK_KINDS`，kanban_db.py:93）。 */
export const BLOCK_KINDS = Object.freeze(["dependency", "needs_input", "capability", "transient"]);
/** 同因重复阻断的升级阈值（照搬 hermes `BLOCK_RECURRENCE_LIMIT = 2`）。 */
export const BLOCK_RECURRENCE_LIMIT = 2;
/** 升级到"人工兜底队列"时打的标签。 */
export const TRIAGE_LABEL = "triage";

const SCHEMA_SQL = `
create table if not exists projects (
  id text primary key, name text not null, workspace_path text,
  initial_session_id text,
  next_seq integer not null default 1, next_req_seq integer not null default 1,
  created_at text not null, updated_at text not null
);
create table if not exists tasks (
  id text primary key, identifier text not null unique,
  project_id text not null references projects(id) on delete cascade,
  title text not null, description text not null default '',
  -- 任务级验收标准与复核动作（FR-94）：添加任务时即记录，供评审/复核时快速判定
  acceptance text not null default '', verify_command text,
  status text not null, priority text not null default 'none',
  labels text not null default '[]', owner text,
  parent_id text references tasks(id) on delete set null,
  requirement_id text,
  session_id text,
  -- FR-11：列内手工顺序（拖拽落点）。为空 = 从未手工排过 ⇒ 排在已排过的卡之后，同为空者按 created_at。
  board_position integer,
  -- 执行认领（FR-77）：claim_lock 为空即"未被认领"；到期或心跳陈旧即可回收。
  claim_lock text, claim_expires text, claim_owner text, claim_source text, last_heartbeat_at text,
  -- 失败会计与熔断（FR-78）：连续非成功计数（仅成功完成时清零）+ 最近失败原因 + 最近成功/重新入队时间
  consecutive_failures integer not null default 0, last_failure_error text,
  last_success_at text, requeued_at text, max_retries integer,
  -- 阻断原因分类与复发升级（FR-80）
  block_kind text, block_recurrences integer not null default 0, triage_at text,
  -- 受阻起始时间（FR-79 "卡在受阻"诊断判据；离开受阻即清空）
  blocked_at text,
  -- 当前进行中的尝试（FR-82）：认领即开一条 run，结束时清空
  current_run_id text,
  -- 评审流程（FR-83）：评审者 / 评审态 / 返工轮次 / 请求时间 / 来源列（返工退回哪一列）/ 评审依赖
  reviewer text, review_state text, review_round integer not null default 0,
  review_requested_at text, review_source_status text, review_depends_on text,
  -- 人工校验任务（FR-85b）：判定类别 / 状态（pending|concluded）/ 结论 / 结论时间与操作者
  human_review_category text, human_review_state text, human_review_conclusion text,
  human_review_concluded_at text, human_review_concluded_by text,
  version integer not null default 1, created_at text not null, updated_at text not null
);
create index if not exists tasks_project_status_idx on tasks(project_id, status);
create index if not exists tasks_parent_idx on tasks(parent_id);
create table if not exists comments (
  id text primary key, task_id text not null references tasks(id) on delete cascade,
  body text not null default '', version integer not null default 1,
  -- FR-17：编辑留痕（最后一次编辑的时间/操作者；完整历史在 comment_revisions）
  edited_at text, edited_by text,
  created_at text not null, updated_at text not null
);
create index if not exists comments_task_idx on comments(task_id, created_at);
-- FR-17：评论编辑留痕（**保留原文本**，二选一里的强口径）。每次编辑先把**编辑前**的正文原样存一行，
-- 因此「原内容不被静默覆盖」是**可回看**的事实，而不是一句"已编辑 N 次"的声明。
create table if not exists comment_revisions (
  id text primary key, comment_id text not null references comments(id) on delete cascade,
  rev integer not null, body text not null, edited_at text not null, edited_by text,
  unique (comment_id, rev)
);
create index if not exists comment_revisions_comment_idx on comment_revisions(comment_id, rev);
create table if not exists requirement_docs (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  body text not null default '', version integer not null default 1,
  created_at text not null, updated_at text not null
);
create unique index if not exists requirement_docs_project_idx on requirement_docs(project_id);
create table if not exists requirement_items (
  id text primary key, identifier text not null unique,
  project_id text not null references projects(id) on delete cascade,
  doc_id text references requirement_docs(id) on delete set null,
  title text not null, description text not null default '', acceptance text not null default '',
  priority text not null default 'none', status text not null default 'open',
  source text not null default 'manual', norm_title text,
  feasibility text, feasibility_reason text, feasibility_by text, feasibility_override text,
  created_at text not null, updated_at text not null
);
create index if not exists requirement_items_project_idx on requirement_items(project_id, status);
create index if not exists requirement_items_doc_idx on requirement_items(doc_id);
create table if not exists requirement_candidates (
  id text primary key, doc_id text not null references requirement_docs(id) on delete cascade,
  project_id text not null, title text not null, description text not null default '',
  acceptance text not null default '', priority text not null default 'none',
  norm_title text, source text not null default 'elaborated-rule',
  status text not null default 'pending', created_at text not null
);
create index if not exists requirement_candidates_doc_idx on requirement_candidates(doc_id, status);
create table if not exists task_dependencies (
  project_id text not null,
  blocker_id text not null references tasks(id) on delete cascade,
  blocked_id text not null references tasks(id) on delete cascade,
  reason text,
  created_at text not null,
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists task_dependencies_blocked_idx on task_dependencies(blocked_id);
create index if not exists task_dependencies_blocker_idx on task_dependencies(blocker_id);
create table if not exists team_runs (
  id text primary key,
  target_task_id text references tasks(id) on delete set null,
  target_requirement_id text references requirement_items(id) on delete set null,
  status text not null default 'staged',
  created_at text not null, updated_at text not null
);
create table if not exists team_members (
  id text primary key, team_id text not null references team_runs(id) on delete cascade,
  role text not null, model text, executor text, status text not null default 'ready', created_at text not null
);
create table if not exists team_tasks (
  id text primary key, team_id text not null references team_runs(id) on delete cascade,
  task_id text not null references tasks(id) on delete cascade,
  member_id text, kind text not null default 'work', status text not null default 'open',
  attempt integer, created_at text not null, updated_at text not null
);
create unique index if not exists team_tasks_active_lock on team_tasks(task_id) where status in ('open','running');
create table if not exists team_attempts (
  id text primary key, team_task_id text not null references team_tasks(id) on delete cascade,
  attempt_id text, result text, created_at text not null
);
create table if not exists governance_audit (
  id text primary key, at text not null, actor text, action text not null,
  target text, allowed integer not null, reason text, detail text
);
create table if not exists project_settings (
  project_id text primary key references projects(id) on delete cascade,
  env_config text not null default '{}',
  team_template text not null default '{}',
  loop_config text not null default '{}',
  updated_at text not null
);
create table if not exists project_sessions (
  project_id text not null references projects(id) on delete cascade,
  session_id text not null,
  status text not null default 'pending',
  created_at text not null,
  updated_at text not null,
  primary key (project_id, session_id)
);
-- 可操作诊断（FR-79）：一条任务同一类型只留一行；问题消失即 resolved_at（自动消解）。
create table if not exists task_diagnostics (
  id text primary key, task_id text not null references tasks(id) on delete cascade,
  kind text not null, severity text not null default 'medium', title text not null,
  detail text not null default '', suggested text, actions text not null default '[]',
  count integer not null default 1, first_seen_at text not null, last_seen_at text not null,
  resolved_at text, dismissed_at text, version integer not null default 1
);
create unique index if not exists task_diagnostics_task_kind_idx on task_diagnostics(task_id, kind);
create index if not exists task_diagnostics_active_idx on task_diagnostics(task_id, resolved_at);
-- 尝试记录（FR-82）：**每次认领执行**=一条 run；结束即闭合（outcome/摘要/错误/起止/心跳/运行时上限）。
create table if not exists task_runs (
  id text primary key, task_id text not null references tasks(id) on delete cascade,
  attempt integer not null, status text not null default 'running',
  outcome text, summary text, error text,
  claim_lock text, session_id text, actor text,
  started_at text not null, ended_at text, duration_ms integer,
  heartbeats integer not null default 1, last_heartbeat_at text, max_ms integer,
  created_at text not null, updated_at text not null
);
create unique index if not exists task_runs_task_attempt_idx on task_runs(task_id, attempt);
create index if not exists task_runs_task_idx on task_runs(task_id, started_at);
-- 任务事件流（FR-82）：**追加式**，任务内 seq 单调 + 全库 cursor 单调（FR-81 的推送游标）。
create table if not exists task_events (
  id text primary key, task_id text not null references tasks(id) on delete cascade,
  cursor integer not null, seq integer not null, type text not null,
  from_value text, to_value text, actor text, detail text, at text not null
);
create unique index if not exists task_events_cursor_idx on task_events(cursor);
create unique index if not exists task_events_task_seq_idx on task_events(task_id, seq);
create index if not exists task_events_task_at_idx on task_events(task_id, at);
-- 全库单调游标（独立计数表：任务被删也**不回收**已发号，保证 FR-81 的"只推未推过的"）
create table if not exists event_cursor (id integer primary key check (id = 1), value integer not null default 0);
insert into event_cursor (id, value) values (1, 0) on conflict(id) do nothing;
-- 通知订阅（FR-81）：订阅"任务终态"，带**事件游标**只推未推过的；三种交付模式 notify / notify+wake / wake。
-- task_id 为空 = **项目级**订阅（该项目所有任务的终态）；否则只订阅该任务。
create table if not exists notify_subs (
  id text primary key, project_id text not null references projects(id) on delete cascade,
  task_id text references tasks(id) on delete cascade, session_id text not null,
  mode text not null default 'notify+wake', active integer not null default 1,
  last_cursor integer not null default 0,
  delivered_count integer not null default 0, failed_count integer not null default 0,
  last_delivery_at text, last_error text, last_kinds text not null default '[]',
  created_at text not null, updated_at text not null
);
create unique index if not exists notify_subs_uniq_idx on notify_subs(project_id, ifnull(task_id, ''), session_id, mode);
create index if not exists notify_subs_project_idx on notify_subs(project_id, active);
-- 项目记忆（2026-10-28 · D-M1/D-M2/D-M5）：结论条目 + 挂载关系 + 召回审计。
-- 铁律：**不是第二真源** —— 每条必带 provenance 指回 task_events/文档/会话；唯一索引去重。
create table if not exists memory_entries (
  id text primary key,
  scope text not null,                -- project | agent | org
  project_id text, agent_id text,
  kind text not null,                 -- convention | decision | pitfall | fact | procedure
  title text not null, body text not null, tags text not null default '[]',
  provenance text not null,           -- event:<cursor> | doc:<path>#<anchor> | session:<id> | run:<id>
  confidence text not null default 'proposed',   -- proposed | accepted
  visibility text not null default 'shared',     -- private | shared | org
  verified_at text, ttl_days integer,            -- kind=fact 必填 verified_at；过期即不召回
  supersedes text,                               -- 被本条目取代的旧条目（**不删只取代**）
  created_by text not null, created_at text not null, updated_at text not null
);
create unique index if not exists memory_dedupe_idx on memory_entries(scope, kind, title, provenance);
create index if not exists memory_scope_idx on memory_entries(scope, project_id, confidence);
create table if not exists memory_links (
  entry_id text not null, entity_type text not null, entity_id text not null,
  primary key (entry_id, entity_type, entity_id)
);
create table if not exists memory_recalls (
  id integer primary key autoincrement,
  session_id text, entry_id text not null, reason text, injected_chars integer, created_at text not null
);
-- 契约快照（P1 · 方案 §8 数据模型）：每个项目一行「上次算出来的契约」。
-- 作用：① 让 CONTRACT_STALE 能报出「哪份文件变了」；② 让漂移盘点有基线。
-- 注意：**只是缓存，不是真源** —— 真源永远是 requirement_docs + spec/norms/*.md，删表只丢基线。
create table if not exists project_contract (
  project_id text primary key references projects(id) on delete cascade,
  contract_version text not null,
  doc_digest text not null,
  doc_version integer,
  norms_json text not null default '[]',
  gates_json text not null default '{}',
  computed_at text not null,
  updated_at text not null
);
-- 装载块注入审计（P1 建表 · D3 档 C 推迟，这里只留审计位，默认策略 off 不写）
create table if not exists flow_injections (
  id integer primary key autoincrement,
  project_id text,
  session_id text,
  policy text not null,
  contract_version text not null,
  digest text,
  injected_at text not null
);
create index if not exists flow_injections_project_idx on flow_injections(project_id, injected_at);
`;

const nowIso = () => new Date().toISOString();

/** 包根（`src/core/` 往上两级）——机器规范默认从 `<包根>/spec/norms` 读，随包分发。 */
const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * FR-80：阻断路由（纯函数）。对齐 hermes `_route_block`（kanban_db.py:2955）。
 * - `dependency`：**不进人工受阻队列**，回到"可开工(todo)"等父任务（事件 `dependency_wait`）
 * - 其它三类：进入 `blocked`；**同因再次阻断**时复发计数 +1；达阈值 → 转"人工兜底"（事件 `block-loop-detected`）
 * 复发计数**只在成功完成时清零**（不在解除受阻时清零——那正是让循环无限跑下去的失忆）。
 */
export function routeBlock({ kind = null, reason = null, prevKind = null, prevRecurrences = 0 } = {}) {
  const payload = { reason, kind: kind ?? null };
  if (kind === "dependency") {
    return { status: "todo", eventKind: "dependency_wait", recurrences: 0, triage: false, payload };
  }
  const recurrences = prevKind === kind ? Number(prevRecurrences ?? 0) + 1 : 1;
  const triage = recurrences >= BLOCK_RECURRENCE_LIMIT;
  return {
    status: "blocked",
    eventKind: triage ? "block-loop-detected" : "blocked",
    recurrences,
    triage,
    payload: { ...payload, recurrences, ...(triage ? { limit: BLOCK_RECURRENCE_LIMIT } : {}) },
  };
}

/**
 * FR-14：任务关键词匹配（大小写不敏感，子串命中）。
 *
 * 覆盖四类字段（验收要点逐项可测）：
 *   · `identifier` —— 任务编号（如 `p1-3`；「编号片段」也能命中）
 *   · `title`      —— 标题
 *   · `description`—— 描述
 *   · `labels`     —— 标签（任一项命中即可）
 *
 * @param {{identifier?: string, title?: string, description?: string, labels?: string[]}} task
 * @param {string} keyword 已 trim + 小写化的关键词（调用方保证非空）
 * @returns {boolean}
 */
function taskMatchesKeyword(task, keyword) {
  const haystacks = [
    task?.identifier,
    task?.title,
    task?.description,
    ...(Array.isArray(task?.labels) ? task.labels : []),
  ];
  return haystacks.some((value) => typeof value === "string" && value.toLowerCase().includes(keyword));
}

const rowToProject = (row) => (row ? {
  id: row.id, name: row.name, workspacePath: row.workspace_path, initialSessionId: row.initial_session_id ?? null,
  nextSequence: row.next_seq,
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null);

function rowToTask(row) {
  if (!row) return null;
  let labels = [];
  try {
    labels = JSON.parse(row.labels);
  } catch {
    labels = [];
  }
  return {
    id: row.id, identifier: row.identifier, projectId: row.project_id, title: row.title,
    description: row.description, status: row.status, priority: row.priority,
    acceptance: row.acceptance ?? "", verifyCommand: row.verify_command ?? null,
    labels: Array.isArray(labels) ? labels : [], owner: row.owner ?? null,
    requirementId: row.requirement_id ?? null,
    sessionId: row.session_id ?? null,
    // FR-11：列内手工顺序（null = 从未手工排过）。前端据此算拖拽落点，后端据此排序。
    boardPosition: row.board_position === null || row.board_position === undefined ? null : Number(row.board_position),
    claimLock: row.claim_lock ?? null,
    claimExpires: row.claim_expires ?? null,
    claimOwner: row.claim_owner ?? null,
    claimSource: row.claim_source ?? null,
    lastHeartbeatAt: row.last_heartbeat_at ?? null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    lastFailureError: row.last_failure_error ?? null,
    lastSuccessAt: row.last_success_at ?? null,
    requeuedAt: row.requeued_at ?? null,
    maxRetries: row.max_retries ?? null,
    blockKind: row.block_kind ?? null,
    blockRecurrences: Number(row.block_recurrences ?? 0),
    triageAt: row.triage_at ?? null,
    blockedAt: row.blocked_at ?? null,
    currentRunId: row.current_run_id ?? null,
    reviewer: row.reviewer ?? null,
    reviewState: row.review_state ?? null,
    reviewRound: Number(row.review_round ?? 0),
    reviewRequestedAt: row.review_requested_at ?? null,
    reviewSourceStatus: row.review_source_status ?? null,
    reviewDependsOn: row.review_depends_on ?? null,
    humanReviewCategory: row.human_review_category ?? null,
    humanReviewState: row.human_review_state ?? null,
    humanReviewConclusion: row.human_review_conclusion ?? null,
    humanReviewConcludedAt: row.human_review_concluded_at ?? null,
    humanReviewConcludedBy: row.human_review_concluded_by ?? null,
    parentId: row.parent_id, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

const rowToRun = (row) => (row ? {
  id: row.id, taskId: row.task_id, attempt: Number(row.attempt ?? 1), status: row.status,
  outcome: row.outcome ?? null, summary: row.summary ?? null, error: row.error ?? null,
  claimLock: row.claim_lock ?? null, sessionId: row.session_id ?? null, actor: row.actor ?? null,
  startedAt: row.started_at, endedAt: row.ended_at ?? null,
  durationMs: row.duration_ms ?? (row.ended_at ? Math.max(0, new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) : null),
  heartbeats: Number(row.heartbeats ?? 1), lastHeartbeatAt: row.last_heartbeat_at ?? null,
  maxMs: row.max_ms ?? null,
} : null);

const rowToTaskEvent = (row) => (row ? {
  id: row.id, taskId: row.task_id, cursor: Number(row.cursor), seq: Number(row.seq), type: row.type,
  from: row.from_value ?? null, to: row.to_value ?? null, actor: row.actor ?? null,
  detail: row.detail ?? null, at: row.at,
} : null);

/** FR-81：订阅行 → 领域对象（`scope` 由 task_id 是否为空推导，UI 直接可用）。 */
const rowToNotifySub = (row) => (row ? {
  id: row.id, projectId: row.project_id, taskId: row.task_id ?? null,
  scope: row.task_id ? "task" : "project", sessionId: row.session_id,
  mode: row.mode, active: Boolean(row.active), lastCursor: Number(row.last_cursor ?? 0),
  deliveredCount: Number(row.delivered_count ?? 0), failedCount: Number(row.failed_count ?? 0),
  lastDeliveryAt: row.last_delivery_at ?? null, lastError: row.last_error ?? null,
  lastKinds: (() => { try { const a = JSON.parse(row.last_kinds ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })(),
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null);

const rowToDiagnostic = (row) => (row ? {
  id: row.id, taskId: row.task_id, kind: row.kind, severity: row.severity ?? "medium",
  title: row.title, detail: row.detail ?? "", suggested: row.suggested ?? null,
  actions: (() => { try { const a = JSON.parse(row.actions ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; } })(),
  count: Number(row.count ?? 1), firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
  resolvedAt: row.resolved_at ?? null, dismissedAt: row.dismissed_at ?? null, version: row.version,
} : null);

/**
 * FR-17：评论行 → 对外对象。
 * 编辑留痕口径（见 §评论编辑）：`edited` = 是否被编辑过；`editCount` = 编辑次数（= 历史版本数）；
 * `editedAt` / `editedBy` = **最后一次**编辑的时间与操作者。`revisions` 只在详情路径按需附带。
 */
const rowToComment = (row) => (row ? {
  id: row.id, taskId: row.task_id, body: row.body, version: row.version,
  createdAt: row.created_at, updatedAt: row.updated_at,
  edited: Boolean(row.edited_at),
  editCount: Number(row.edit_count ?? 0),
  editedAt: row.edited_at ?? null,
  editedBy: row.edited_by ?? null,
} : null);

/** 评论编辑留痕行 → 对外对象（历史正文，按 rev 升序回放）。 */
const rowToCommentRevision = (row) => (row ? {
  id: row.id, commentId: row.comment_id, rev: row.rev, body: row.body,
  editedAt: row.edited_at, editedBy: row.edited_by ?? null,
} : null);

/** 评论查询统一出口：把留痕条数（= 编辑次数）一并取出，避免各处重复子查询。 */
const COMMENT_SELECT = `select c.*, (select count(*) from comment_revisions r where r.comment_id = c.id) as edit_count from comments c`;

// ---- 评论编辑（FR-17） --------------------------------------------------------
/**
 * FR-85 升级门的「显式申报」标记。
 * 权威定义在 `diagnostics.mjs` 的 `HUMAN_REVIEW_DECLARATION_MARKER`；此处**字面量重写**是
 * 为了避开循环依赖（`diagnostics.mjs` 反向 import 本模块）。改动该标记时必须同步两处。
 */
const HUMAN_REVIEW_DECLARATION_MARKER = "【人工校验申报】";

/**
 * 评论可否编辑（纯函数，抛 `TbError`）。
 *
 * **红线（FR-17 验收要点③ + 评审证据旁路）**：编辑不得成为**改写评审证据**的旁路。
 * 判定与处置（选定「禁止编辑」而非「仅追加更正」，理由见下）：
 * 1. **机器证据评论只读** —— 正文能被 `parseVerifyComment()` 解析出来的（`【自动复核】命令=…；退出码=…`，
 *    FR-90 自动复核落盘的证据）一律拒绝编辑。这些正是一条条**带结论的评审凭据**，
 *    允许改写就等于允许把"失败（退出码 1）"改成"通过"，评审人再也无法信任证据。
 * 2. **不得伪造证据** —— 普通评论也不许被编辑**成**证据形态（同上，反方向的旁路）。
 * 3. **人工校验申报只读** —— `【人工校验申报】` 是 FR-85 升级门的**判定输入**（`declarationEvidence()`
 *    读**当前**正文，且"申报优先"直接决定判定类别）。允许事后编辑就等于允许改变门的结论，
 *    而这正是评审依据之一 ⇒ 同理只读。需要改口径请**另发一条**申报评论（追加更正）。
 * 4. 人写的进展/反馈评论**仍可编辑**：留痕口径是「**保留原文本**」（`comment_revisions` 逐版存原正文），
 *    所以即便评审已引用过某条进展评论，其**当时原文随时可回看**，证据链不断。
 *    需要更正已引用评论时，正解同样是**另发一条评论**（追加更正）—— `POST /comments` 始终可用。
 */
export function assertCommentEditable(originalBody, nextBody, commentId = null) {
  if (parseVerifyComment(originalBody)) {
    throw new TbError("COMMENT_NOT_EDITABLE", "该评论是机器复核产出的评审证据（【自动复核】…），只读不可编辑；需要更正请另发一条评论追加说明", { commentId, reason: "review-evidence-readonly" });
  }
  if (parseVerifyComment(nextBody)) {
    throw new TbError("COMMENT_NOT_EDITABLE", "评论不得被编辑成【自动复核】证据形态（那等于伪造评审证据）；证据只能由自动复核产出", { commentId, reason: "cannot-forge-evidence" });
  }
  if (String(originalBody ?? "").includes(HUMAN_REVIEW_DECLARATION_MARKER)) {
    throw new TbError("COMMENT_NOT_EDITABLE", "该评论是人工校验「显式申报」（【人工校验申报】…），是升级门的判定依据，只读不可编辑；需要更正口径请另发一条申报评论", { commentId, reason: "declaration-readonly" });
  }
  return true;
}

const rowToRequirementDoc = (row) => (row ? {
  id: row.id, projectId: row.project_id, body: row.body, version: row.version,
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null);

const rowToRequirementItem = (row) => (row ? {
  id: row.id, identifier: row.identifier, projectId: row.project_id, docId: row.doc_id,
  title: row.title, description: row.description, acceptance: row.acceptance,
  priority: row.priority, status: row.status, source: row.source, normTitle: row.norm_title,
  feasibility: row.feasibility ?? null, feasibilityReason: row.feasibility_reason ?? null,
  feasibilityBy: row.feasibility_by ?? null, feasibilityOverride: row.feasibility_override ?? null,
  createdAt: row.created_at, updatedAt: row.updated_at,
} : null);

const rowToRequirementCandidate = (row) => (row ? {
  id: row.id, docId: row.doc_id, projectId: row.project_id, title: row.title,
  description: row.description, acceptance: row.acceptance, priority: row.priority,
  normTitle: row.norm_title, source: row.source ?? "elaborated-rule", status: row.status, createdAt: row.created_at,
} : null);

/** 生成并插入一条需求条目（调用方负责事务；返回新编号）。 */
function insertRequirementItem(db, { id, projectId, docId, title, description, acceptance, priority, status, source, ts }) {
  const project = db.prepare("select * from projects where id = ?").get(projectId);
  const seq = project.next_req_seq ?? 1;
  const identifier = formatRequirementIdentifier(projectId, seq);
  db.prepare("update projects set next_req_seq = ?, updated_at = ? where id = ?").run(seq + 1, ts, projectId);
  db.prepare(
    `insert into requirement_items (id, identifier, project_id, doc_id, title, description, acceptance, priority, status, source, norm_title, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, identifier, projectId, docId, title, description, acceptance, priority, status, source, titleKey(title), ts, ts);
  return identifier;
}

function isConstraintError(error, needle) {
  const message = String(error?.message ?? "");
  return message.includes("UNIQUE constraint failed") && message.includes(needle);
}

/** 一次性迁移（幂等）：1) 老库补 owner 列；2) `owner:<role>` 标签搬进 owner 并从 labels 移除。 */
export function migrateOwnerField(db) {
  const columns = db.prepare("pragma table_info(tasks)").all().map((row) => row.name);
  let addedColumn = false;
  if (!columns.includes("owner")) {
    db.exec("alter table tasks add column owner text");
    addedColumn = true;
  }
  db.exec("create index if not exists tasks_owner_idx on tasks(owner)");

  const rows = db.prepare("select id, owner, labels from tasks").all();
  const update = db.prepare("update tasks set owner = ?, labels = ? where id = ?");
  let migratedTasks = 0;
  let strippedLabels = 0;
  db.exec("begin immediate");
  try {
    for (const row of rows) {
      let labels = [];
      try {
        labels = JSON.parse(row.labels);
      } catch {
        labels = [];
      }
      if (!Array.isArray(labels)) labels = [];
      const split = splitOwnerLabels(labels);
      const currentOwner = typeof row.owner === "string" && row.owner.trim() !== "" ? row.owner : null;
      const nextOwner = currentOwner ?? (split.owner || null);
      const labelsChanged = split.labels.length !== labels.length;
      if (!labelsChanged && nextOwner === currentOwner) continue;
      update.run(nextOwner, JSON.stringify(split.labels), row.id);
      migratedTasks += 1;
      if (labelsChanged) strippedLabels += 1;
    }
    db.exec("commit");
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
  return { addedOwnerColumn: addedColumn, migratedTasks, strippedLabels };
}

/**
 * 迁移（幂等）：老库的 `team_members` 表补 `executor` 列（FR-50 验收第一条：成员要带「执行器」）。
 * 与 `migrateOwnerField` 同模式：`pragma table_info` 探列名，缺列才 `alter table add column`。
 * 老行补列后为 `null`（＝"未配置执行器"，与新建库的默认语义一致）。
 */
export function migrateTeamMembers(db) {
  const columns = db.prepare("pragma table_info(team_members)").all().map((row) => row.name);
  if (columns.length && !columns.includes("executor")) {
    db.exec("alter table team_members add column executor text");
    return { addedTeamMemberExecutorColumn: true };
  }
  return { addedTeamMemberExecutorColumn: false };
}

/** 迁移（幂等）：老库的 projects 表补 `next_req_seq` 列（需求条目编号序列）。 */
export function migrateRequirementSeq(db) {
  const projectColumns = db.prepare("pragma table_info(projects)").all().map((row) => row.name);
  const taskColumns = db.prepare("pragma table_info(tasks)").all().map((row) => row.name);
  const candidateColumns = db.prepare("pragma table_info(requirement_candidates)").all().map((row) => row.name);
  const result = { addedReqSeqColumn: false, addedTaskRequirementColumn: false, addedCandidateSourceColumn: false, addedTaskSessionColumn: false, addedProjectSessionColumn: false, addedClaimColumn: false, addedFailureColumn: false, addedBlockColumn: false, addedRunColumn: false, addedReviewColumn: false, addedCommentEditColumn: false, addedBoardPositionColumn: false };
  if (!projectColumns.includes("next_req_seq")) {
    db.exec("alter table projects add column next_req_seq integer not null default 1");
    result.addedReqSeqColumn = true;
  }
  if (!projectColumns.includes("initial_session_id")) {
    db.exec("alter table projects add column initial_session_id text");
    result.addedProjectSessionColumn = true;
  }
  const psColumns = db.prepare("pragma table_info(project_settings)").all().map((row) => row.name);
  if (psColumns.length && !psColumns.includes("loop_config")) {
    db.exec("alter table project_settings add column loop_config text not null default '{}'");
    result.addedLoopColumn = true;
  }
  const depColumns = db.prepare("pragma table_info(task_dependencies)").all().map((row) => row.name);
  if (depColumns.length && !depColumns.includes("reason")) {
    db.exec("alter table task_dependencies add column reason text");
    result.addedDepReasonColumn = true;
  }
  if (!taskColumns.includes("requirement_id")) {
    db.exec("alter table tasks add column requirement_id text");
    result.addedTaskRequirementColumn = true;
  }
  if (!candidateColumns.includes("source")) {
    db.exec("alter table requirement_candidates add column source text not null default 'elaborated-rule'");
    result.addedCandidateSourceColumn = true;
  }
  if (!taskColumns.includes("session_id")) {
    db.exec("alter table tasks add column session_id text");
    result.addedTaskSessionColumn = true;
  }
  // FR-94：任务级验收标准 + 复核动作（老库补列，幂等）
  if (!taskColumns.includes("acceptance")) {
    db.exec("alter table tasks add column acceptance text not null default ''");
    result.addedTaskAcceptanceColumn = true;
  }
  if (!taskColumns.includes("verify_command")) {
    db.exec("alter table tasks add column verify_command text");
    result.addedTaskVerifyCommandColumn = true;
  }
  // FR-77：执行认领锁 + 心跳（老库补列，幂等）
  const claimColumns = { claim_lock: "text", claim_expires: "text", claim_owner: "text", claim_source: "text", last_heartbeat_at: "text" };
  for (const [col, type] of Object.entries(claimColumns)) {
    if (!taskColumns.includes(col)) {
      db.exec(`alter table tasks add column ${col} ${type}`);
      result.addedClaimColumn = true;
    }
  }
  // FR-78：失败会计与熔断（老库补列，幂等）
  const failureColumns = {
    consecutive_failures: "integer not null default 0", last_failure_error: "text",
    last_success_at: "text", requeued_at: "text", max_retries: "integer",
  };
  for (const [col, type] of Object.entries(failureColumns)) {
    if (!taskColumns.includes(col)) {
      db.exec(`alter table tasks add column ${col} ${type}`);
      result.addedFailureColumn = true;
    }
  }
  // FR-80：阻断原因分类 + 复发计数 + 人工兜底标记（老库补列，幂等）
  // FR-79 追加 blocked_at（受阻起始时间，"卡在受阻"诊断判据）。
  const blockColumns = { block_kind: "text", block_recurrences: "integer not null default 0", triage_at: "text", blocked_at: "text" };
  for (const [col, type] of Object.entries(blockColumns)) {
    if (!taskColumns.includes(col)) {
      db.exec(`alter table tasks add column ${col} ${type}`);
      result.addedBlockColumn = true;
    }
  }
  // FR-82：当前尝试指针（老库补列，幂等）
  if (!taskColumns.includes("current_run_id")) {
    db.exec("alter table tasks add column current_run_id text");
    result.addedRunColumn = true;
  }
  // FR-83：评审流程列（老库补列，幂等）
  const reviewColumns = {
    reviewer: "text", review_state: "text", review_round: "integer not null default 0",
    review_requested_at: "text", review_source_status: "text", review_depends_on: "text",
  };
  for (const [col, type] of Object.entries(reviewColumns)) {
    if (!taskColumns.includes(col)) {
      db.exec(`alter table tasks add column ${col} ${type}`);
      result.addedReviewColumn = true;
    }
  }
  // FR-85b：人工校验任务列（老库补列，幂等）
  const humanReviewColumns = {
    human_review_category: "text", human_review_state: "text", human_review_conclusion: "text",
    human_review_concluded_at: "text", human_review_concluded_by: "text",
  };
  for (const [col, type] of Object.entries(humanReviewColumns)) {
    if (!taskColumns.includes(col)) {
      db.exec(`alter table tasks add column ${col} ${type}`);
      result.addedHumanReviewColumn = true;
    }
  }
  // FR-17：评论编辑留痕列（老库补列，幂等）。`comment_revisions` 表由 SCHEMA_SQL 的
  // `create table if not exists` 直接补齐老库（无需 alter），这里只补 comments 上的两个冗余列。
  const commentColumns = db.prepare("pragma table_info(comments)").all().map((row) => row.name);
  // FR-11：列内手工顺序（老库补列，幂等）。索引**必须在这里建**：老库的建表语句是 no-op，
  // 若把 `create index ... board_position` 写进 SCHEMA_SQL，老库（还没有该列时）会因缺列直接失败
  // —— 与顶部 `tasks_owner_idx` 的注释同一个坑。先补列、再建索引，两种库都覆盖。
  if (!taskColumns.includes("board_position")) {
    db.exec("alter table tasks add column board_position integer");
    result.addedBoardPositionColumn = true;
  }
  db.exec("create index if not exists tasks_board_order_idx on tasks(project_id, status, board_position)");
  for (const [col, type] of Object.entries({ edited_at: "text", edited_by: "text" })) {
    if (!commentColumns.includes(col)) {
      db.exec(`alter table comments add column ${col} ${type}`);
      result.addedCommentEditColumn = true;
    }
  }
  return result;
}

/**
 * FR-11：**列内手工顺序**的落点计算与写回（拖拽落点 → 持久化的 `board_position`）。
 *
 * 口径（写在函数里，避免各处各猜）：
 *  1. `board_position` 是**列内**的顺序键（列 = 同 project + 同 status），跨列无意义。`resolveBoardOrder`
 *     每次显式落点都会把**目标列**整列重编号成稠密 `0..n-1`；但**被移走的卡不会触发源列重编号**，
 *     故源列可能留下空洞（如 `[1,2]`）—— 这只影响**数值**，**不影响相对顺序**（排序键只看大小），
 *     且下一次对该列的显式落点会把空洞抹平。任何调用方**不得**假设 `board_position` 恒为稠密序列。
 *  2. 列的**展示顺序** = `(board_position is null), board_position, created_at, rowid` —— 与 `listTasks`
 *     的 ORDER BY 逐字一致；本函数按下标插入后**整列重编号**，保证"下次读出来的顺序"就是人看到的顺序。
 *  3. 从未手工排过的卡（`board_position` 为空）在重编号时被赋上具体位置 —— 顺序**不变**（它们本就按
 *     created_at 排在已有位置之后），但从此成为"显式顺序"，后续新建的卡会追加在它们之后（可预期）。
 *  4. 写回**不动兄弟卡的 `version` / `updated_at`**：手工顺序是看板版式，兄弟卡内容一个字没变 ——
 *     跟着涨版本会让别人的编辑无端撞 `VERSION_CONFLICT`（那是假冲突）。被移动的卡自己由 `updateTask`
 *     主语句负责涨版本。这也是本函数**不写事件流**的原因：版式调整不该进任务生命周期事件。
 *
 * @param {*} db        已打开的库
 * @param {{taskId: string, projectId: string, status: string, desiredIndex: number|{before: string|null}|null}} input
 *        `desiredIndex` 三种形态（前端用第一种，测试 / CLI 用第二种）：
 *        · `{ before: <编号|id> }` —— **锚点式落点**：插到「该卡之前」（`before: null` = 列尾）。
 *          这是**筛选生效时唯一正确的口径**：前端只看得到可见卡，锚点按可见邻居给，
 *          服务端在**整列**里解析它的真实下标 ⇒ 隐藏卡不会让落点漂移。
 *        · `整数 n` —— 整列的 0-based 下标（含被移动卡自己之前的兄弟序列）；超出上界**夹取**到列尾
 *          （渲染与落点之间列内容被别人改了是真实竞态，夹取是唯一不臆断的处置）。
 *        · `null` —— 追加到列尾。
 * @returns {{ordered: string[], position: number}} 重编号后的整列 id 序列 + 移动卡的新位置
 */
function resolveBoardOrder(db, { taskId, projectId, status, desiredIndex = null }) {
  // 目标列里**除被移动卡之外**的卡，按当前展示顺序取出
  const siblings = db.prepare(
    `select id from tasks where project_id = ? and status = ? and id != ?
     order by (board_position is null), board_position, created_at, rowid`,
  ).all(projectId, status, taskId).map((row) => row.id);
  let index;
  if (desiredIndex === null || desiredIndex === undefined) index = siblings.length; // 落列尾
  else if (typeof desiredIndex === "object" && !Array.isArray(desiredIndex)) {
    const before = desiredIndex.before ?? null;
    if (before === null || before === "") index = siblings.length;
    else {
      const anchor = db.prepare("select id, project_id, status from tasks where id = ? or identifier = ?").get(String(before), String(before));
      if (!anchor) throw new TbError("TASK_NOT_FOUND", `落点锚点任务不存在：${before}`, { ref: before });
      if (anchor.project_id !== projectId || anchor.status !== status) {
        throw invalidField("boardPosition.before", `落点锚点必须与被打分卡同项目、同列（锚点 ${before} 在 ${anchor.project_id}/${anchor.status}），收到跨列/跨项目锚点`);
      }
      const at = siblings.indexOf(anchor.id);
      if (at < 0) throw invalidField("boardPosition.before", `落点锚点 ${before} 不在目标列里（可能刚被移动/删除）`);
      index = at;
    }
  } else {
    if (!Number.isInteger(desiredIndex) || desiredIndex < 0) {
      throw invalidField("boardPosition", `boardPosition 必须是 ≥0 的整数（列的 0-based 下标）、{before} 锚点或 null，收到：${JSON.stringify(desiredIndex)}`);
    }
    index = Math.min(desiredIndex, siblings.length);
  }
  return { ordered: siblings.slice(0, index).concat([taskId], siblings.slice(index)), position: index };
}

/** 把 `resolveBoardOrder` 的结果写库（整列重编号）。**只写 `board_position`**，不动兄弟卡的版本/时间。 */
function applyBoardOrder(db, ordered) {
  const write = db.prepare("update tasks set board_position = ? where id = ?");
  ordered.forEach((id, i) => write.run(i, id));
}

/**
 * 归一「不归因理由」（P0 / D1 的逃生口）。
 * 缺口径：给了就必须**非空**（空字符串等于没给），上限 500 字防灌水；没给返回 `null`。
 */
function normalizeUnattributedReason(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === "") {
    throw new TbError("USAGE_ERROR", "unattributedReason 不能是空字符串：要么不传，要么给一句真实理由（会落审计）");
  }
  if (text.length > 500) throw new TbError("USAGE_ERROR", "unattributedReason 过长（上限 500 字）");
  return text;
}

export function openStore(options = {}) {
  const dataDir = resolveDataDir({ dataDir: options.dataDir, env: options.env });
  const dbPath = options.dbPath ?? resolveDbPath(dataDir);
  const policy = { ...GOVERNANCE_DEFAULTS, ...(options.policy ?? {}) };
  // P0 归因门（D1 拍板「硬门 + 逃生口」）的**上线闸门**：默认 warn（建卡成功但返回可见警告 +
  // 落 `attribution_missing` 事件），设 `TB_STRICT_ATTRIBUTION=1` 时才拒绝（`REQUIREMENT_REQUIRED`）。
  // 为什么不一上来就拒：现有 Web 新建对话框 / seed / 部分团队路径还没有条目字段，直接拒会把
  // 797 条既有用例与真机交互一起打红；按 §17.5「先 warn 后 reject」两步走，P3 随 MCP 一起翻默认。
  const strictAttribution =
    String((options.env ?? process.env)?.TB_STRICT_ATTRIBUTION ?? "") === "1";
  // P1 契约快照：机器规范默认随包读 `spec/norms/*.md`；测试可传 `normsDir` 或直接传 `norms`。
  const normsDir = options.normsDir ?? path.join(PKG_ROOT, "spec", "norms");
  const injectedNorms = Array.isArray(options.norms) ? options.norms : null;
  const loadNormsForContract = () => injectedNorms ?? loadNorms(normsDir);

  let db;
  let migration;
  try {
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("pragma foreign_keys = on");
    db.exec("pragma busy_timeout = 5000");
    db.exec(SCHEMA_SQL);
    migration = { ...migrateOwnerField(db), ...migrateRequirementSeq(db), ...migrateTeamMembers(db) };
  } catch (error) {
    const wrapped = new TbError(
      "STORE_UNAVAILABLE",
      `无法打开或初始化数据存储：${error instanceof Error ? error.message : String(error)}`,
      { dbPath },
    );
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    throw wrapped;
  }

  // ---- P1.5 · D2 `warn` 档：写路径上的契约校验（内核层，不阻断）---------------------
  // 为什么放内核：MCP / HTTP / CLI / Web / dsh-tool 五个入口都落到这里；放在门面层就会
  // 「六个入口两种语义」（方案 §17.3 D2 拍板 B）。warn 档只记审计，观察一周后再切 reject。
  const CONTRACT_CHECK_TTL_MS = 20000; // 每次写都读五份规范 + 需求文档太重，短 TTL 缓存足够
  const contractCheckCache = { at: 0, byProject: new Map() };
  function currentContractCached(projectId) {
    const now = Date.now();
    if (now - contractCheckCache.at > CONTRACT_CHECK_TTL_MS) { contractCheckCache.at = now; contractCheckCache.byProject.clear(); }
    if (!contractCheckCache.byProject.has(projectId)) {
      try { contractCheckCache.byProject.set(projectId, store.contractSnapshot(projectId).snapshot); }
      catch { contractCheckCache.byProject.set(projectId, null); }
    }
    return contractCheckCache.byProject.get(projectId);
  }
  /**
   * 只有**调用方显式带 `contract`** 才校验（老客户端不带 ⇒ skipped，零打扰）。
   * 判 `warn` **不阻断写入**，只落一条 `contract-warn` 审计；
   * 之后可用 `GET /api/governance/audit?action=contract-warn` 查「谁在用旧规范干活」。
   */
  function noteContractUse(projectId, submitted, target) {
    const current = currentContractCached(projectId);
    const verdict = evaluateSubmittedContract(current, submitted);
    if (verdict.verdict !== "warn") return verdict;
    try {
      store.recordAudit({
        actor: String(submitted?.actor ?? "unknown"),
        action: "contract-warn",
        target: String(target ?? projectId),
        allowed: true,
        reason: "stale",
        detail: JSON.stringify({ problems: verdict.problems, current_version: current?.contractVersion ?? null }),
      });
    } catch { /* 审计写失败也不能影响业务写入 */ }
    return verdict;
  }

  const store = {
    schemaVersion: SCHEMA_VERSION,
    dataDir,
    dbPath,
    policy,
    migration,

    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },

    createProject(input = {}) {
      const name = assertTitle(input.name, "name");
      const id = assertProjectId(input.id ?? slugify(name), "id");
      const workspacePath = input.workspacePath == null ? null : String(input.workspacePath);
      const timestamp = nowIso();
      try {
        db.prepare(
          `insert into projects (id, name, workspace_path, next_seq, created_at, updated_at) values (?, ?, ?, 1, ?, ?)`,
        ).run(id, name, workspacePath, timestamp, timestamp);
      } catch (error) {
        if (isConstraintError(error, "projects.id")) throw new TbError("PROJECT_EXISTS", `项目已存在：${id}`, { id });
        throw error;
      }
      return rowToProject(db.prepare("select * from projects where id = ?").get(id));
    },

    listProjects() {
      return db.prepare("select * from projects order by created_at, rowid").all().map(rowToProject);
    },

    getProject(id) {
      if (typeof id !== "string" || id === "") return null;
      return rowToProject(db.prepare("select * from projects where id = ?").get(id));
    },

    requireProject(id) {
      const project = store.getProject(id);
      if (!project) throw new TbError("PROJECT_NOT_FOUND", `项目不存在：${id}`, { id });
      return project;
    },

    /**
     * P1 · 契约快照（**纯读**，不写库）。
     *
     * `contractVersion = f(需求文档 digest, 机器规范 digest×版本, 门配置)`；
     * 同时把「与上次落库的基线相比哪份文件变了」一起返回 —— 这正是 `CONTRACT_STALE`
     * 必须能报出 `changed[]` 的来源（D5 硬要求：只报「过期」不报「哪份变了」＝让人猜）。
     */
    contractSnapshot(projectId) {
      const project = store.requireProject(projectId);
      const doc = store.getRequirementDoc(projectId);
      const norms = loadNormsForContract();
      const gates = {
        attribution: strictAttribution ? "reject" : "warn",
        authorization: "hard",
        review: "hard",
        humanReview: "hard",
      };
      const snapshot = computeContract({ requirementsText: doc?.body ?? "", norms, gates, docVersion: doc?.version ?? null });
      const stored = store.getProjectContract(projectId);
      const changed = stored
        ? diffContract({ contractVersion: stored.contractVersion, docDigest: stored.docDigest, norms: stored.norms, gates: stored.gates }, snapshot)
        : null;
      return {
        project: { id: project.id, name: project.name },
        normsDir,
        snapshot,
        baseline: stored,
        changed,
        stale: Boolean(changed?.versionChanged),
      };
    },

    /** P1 · 重算并落基线（`project_contract` 唯一写入点）。只存缓存，不影响业务状态。 */
    refreshProjectContract(projectId, { reason = null } = {}) {
      const result = store.contractSnapshot(projectId);
      const ts = nowIso();
      const { snapshot } = result;
      db.prepare(
        `insert into project_contract (project_id, contract_version, doc_digest, doc_version, norms_json, gates_json, computed_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict(project_id) do update set
           contract_version = excluded.contract_version, doc_digest = excluded.doc_digest,
           doc_version = excluded.doc_version, norms_json = excluded.norms_json,
           gates_json = excluded.gates_json, computed_at = excluded.computed_at, updated_at = excluded.updated_at`,
      ).run(projectId, snapshot.contractVersion, snapshot.docDigest, snapshot.docVersion ?? null,
        JSON.stringify(snapshot.norms), JSON.stringify(snapshot.gates), ts, ts);
      return { ...result, baseline: store.getProjectContract(projectId), reason };
    },

    getProjectContract(projectId) {
      const row = db.prepare("select * from project_contract where project_id = ?").get(projectId);
      if (!row) return null;
      const parse = (text, fallback) => {
        try { return JSON.parse(text ?? ""); } catch { return fallback; }
      };
      return {
        projectId: row.project_id,
        contractVersion: row.contract_version,
        docDigest: row.doc_digest,
        docVersion: row.doc_version ?? null,
        norms: parse(row.norms_json, []),
        gates: parse(row.gates_json, {}),
        computedAt: row.computed_at,
        updatedAt: row.updated_at,
      };
    },

    /** P1 · 装载块注入审计（D3 档 C 推迟：默认策略 off，这张表只是「将来要能追」的位子）。 */
    recordFlowInjection({ projectId = null, sessionId = null, policy = "off", contractVersion, digest = null } = {}) {
      if (!contractVersion) throw invalidField("contractVersion", "recordFlowInjection 必须带 contractVersion");
      const ts = nowIso();
      const info = db.prepare(
        "insert into flow_injections (project_id, session_id, policy, contract_version, digest, injected_at) values (?, ?, ?, ?, ?, ?)",
      ).run(projectId, sessionId, String(policy), String(contractVersion), digest, ts);
      return { id: Number(info.lastInsertRowid), projectId, sessionId, policy: String(policy), contractVersion, digest, injectedAt: ts };
    },

    listFlowInjections(filter = {}) {
      const clauses = [];
      const args = [];
      if (filter.projectId) { clauses.push("project_id = ?"); args.push(filter.projectId); }
      if (filter.sessionId) { clauses.push("session_id = ?"); args.push(filter.sessionId); }
      const where = clauses.length ? ` where ${clauses.join(" and ")}` : "";
      return db.prepare(`select * from flow_injections${where} order by id`).all(...args).map((row) => ({
        id: row.id, projectId: row.project_id, sessionId: row.session_id, policy: row.policy,
        contractVersion: row.contract_version, digest: row.digest, injectedAt: row.injected_at,
      }));
    },

    /**
     * FR-03：删除项目 —— **非空守卫**（验收要点：删除非空项目被拒绝且有明确提示）。
     *
     * 三条纪律：
     * 1. **必须显式确认**：`confirm !== true` ⇒ 拒绝（`PROJECT_DELETE_UNCONFIRMED`），防误触。
     * 2. **非空即拒**：项目下仍有**任务 / 需求条目 / 需求文档正文 / 项目会话关联**时一律拒绝，
     *    并把**剩余数量**放进错误的 `details.remaining`，让上层能给出具体的人话提示。
     * 3. **绝不级联删除**：本方法只在"确认为空"时删 `projects` 一行；任何情况下都不删任务、需求、
     *    评论、事件等用户数据（守卫就是为此存在的——宁可拒绝，不可误删）。
     */
    deleteProject(projectId, { confirm, actor = "human", reason = null } = {}) {
      const project = store.requireProject(projectId);
      if (confirm !== true) {
        store.recordAudit({ actor, action: "delete-project", target: project.id, allowed: false, reason: "confirm-required", detail: null });
        throw new TbError("PROJECT_DELETE_UNCONFIRMED", `删除项目必须先显式确认（confirm: true）：${project.id}`, { id: project.id });
      }
      // 非空判定：按"用户可感知的占用物"逐类计数（任务 / 需求条目 / 需求文档正文 / 项目会话关联）。
      const tasks = db.prepare("select count(*) as n from tasks where project_id = ?").get(project.id).n;
      const requirementItems = db.prepare("select count(*) as n from requirement_items where project_id = ?").get(project.id).n;
      const doc = db.prepare("select id, body from requirement_docs where project_id = ?").get(project.id) ?? null;
      const docBody = doc && String(doc.body ?? "").trim() !== "" ? 1 : 0;
      const sessions = db.prepare("select count(*) as n from project_sessions where project_id = ?").get(project.id).n;
      const remaining = { tasks, requirementItems, requirementDocs: docBody, sessions };
      const total = tasks + requirementItems + docBody + sessions;
      if (total > 0) {
        store.recordAudit({ actor, action: "delete-project", target: project.id, allowed: false, reason: "project-not-empty", detail: JSON.stringify(remaining) });
        throw new TbError(
          "PROJECT_NOT_EMPTY",
          `项目「${project.name}」仍非空，已拒绝删除：任务 ${tasks} 个、需求条目 ${requirementItems} 条、需求文档正文 ${docBody} 份、项目会话关联 ${sessions} 条。请先清空后再删（本操作不会级联删除任何数据）。`,
          { id: project.id, remaining, total },
        );
      }
      db.prepare("delete from projects where id = ?").run(project.id);
      store.recordAudit({ actor, action: "delete-project", target: project.id, allowed: true, reason: reason ?? "empty-project", detail: JSON.stringify(remaining) });
      return { id: project.id, name: project.name, deleted: true };
    },

    /** FR-60：把项目绑定到它的"初始会话"（首次绑定后不再改写）。 */
    bindInitialSession(projectId, sessionId) {
      const project = store.requireProject(projectId);
      if (!sessionId) return project;
      if (!project.initialSessionId) {
        db.prepare("update projects set initial_session_id = ?, updated_at = ? where id = ?").run(String(sessionId), nowIso(), project.id);
      }
      return store.requireProject(project.id);
    },
    /** 默认（近期执行）项目：最近有任务活动的项目；无任务时回退到最近创建的项目。 */
    /**
     * FR-84：把项目主会话**替换**为给定会话——与 `bindInitialSession` 的"首次绑定不改写"相对，
     * 供"主会话已失效 → 重建/重绑"使用。返回 `{ project, before, after, changed }` 便于审计与回滚。
     */
    rebindInitialSession(projectId, sessionId) {
      const project = store.requireProject(projectId);
      if (!sessionId) throw invalidField("sessionId", "必须提供会话标识");
      const before = project.initialSessionId ?? null;
      const after = String(sessionId);
      if (before !== after) {
        db.prepare("update projects set initial_session_id = ?, updated_at = ? where id = ?").run(after, nowIso(), project.id);
      }
      return { project: store.requireProject(project.id), before, after, changed: before !== after };
    },
    /**
     * FR-84 补口（2026-10-23）：把**某张任务的接续会话**改指到给定会话。
     *
     * 真机病根：任务级 `session_id` 是**派发/启动执行时写入的引用**。一旦它指向一个
     * **别的或未归属工作区**的会话（实测 `obsidian-dsh-acp-15` → `cwd="/"`），任务详情里的
     * 工作区归属门就会一直报警；而「重建并绑定项目主会话」只改**项目主会话指针**，
     * **动不到任务级引用** ⇒ 用户按提示重建完，同一张卡仍然报同一句话（提示指了一条对该卡无效的路）。
     *
     * 本方法**只改** `tasks.session_id`：不碰状态、不碰认领锁（任务可能正被认领，
     * 改指针 ≠ 重开执行）。返回 `{ task, before, after, changed }` 供审计与回滚。
     */
    rebindTaskSession(ref, sessionId) {
      const task = store.requireTaskRef(ref);
      if (!sessionId) throw invalidField("sessionId", "必须提供会话标识");
      const before = task.sessionId ?? null;
      const after = String(sessionId);
      if (before !== after) {
        db.prepare("update tasks set session_id = ?, version = version + 1, updated_at = ? where id = ?").run(after, nowIso(), task.id);
      }
      return { task: store.requireTaskRef(ref), before, after, changed: before !== after };
    },
    defaultProject() {
      const row = db.prepare(
        `select p.* from projects p
           left join (select project_id, max(updated_at) as last from tasks group by project_id) t on t.project_id = p.id
          order by coalesce(t.last, p.updated_at) desc, p.rowid desc limit 1`,
      ).get();
      return rowToProject(row);
    },
    /** 会话 ↔ 项目关联（FR-63）：主会话之外，其它会话需申请、由主会话批准。 */
    listProjectSessions(projectId) {
      store.requireProject(projectId);
      return db.prepare("select * from project_sessions where project_id = ? order by created_at, rowid").all(projectId)
        .map((r) => ({ projectId: r.project_id, sessionId: r.session_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at }));
    },
    requestSessionAssociation(projectId, sessionId) {
      const project = store.requireProject(projectId);
      if (!sessionId) throw invalidField("sessionId", "必须提供会话标识");
      const ts = nowIso();
      const existing = db.prepare("select status from project_sessions where project_id = ? and session_id = ?").get(project.id, String(sessionId));
      if (existing?.status === "approved") return { projectId: project.id, sessionId: String(sessionId), status: "approved" };
      db.prepare(
        `insert into project_sessions (project_id, session_id, status, created_at, updated_at) values (?,?, 'pending', ?, ?)
         on conflict(project_id, session_id) do update set status = 'pending', updated_at = excluded.updated_at`,
      ).run(project.id, String(sessionId), ts, ts);
      return { projectId: project.id, sessionId: String(sessionId), status: "pending" };
    },
    approveSessionAssociation(projectId, sessionId) {
      const project = store.requireProject(projectId);
      if (!sessionId) throw invalidField("sessionId", "必须提供会话标识");
      const ts = nowIso();
      db.prepare(
        `insert into project_sessions (project_id, session_id, status, created_at, updated_at) values (?,?, 'approved', ?, ?)
         on conflict(project_id, session_id) do update set status = 'approved', updated_at = excluded.updated_at`,
      ).run(project.id, String(sessionId), ts, ts);
      return { projectId: project.id, sessionId: String(sessionId), status: "approved" };
    },
    /** 该会话是否已绑定该项目：主会话=main；已批准=associated；否则 none/pending。 */
    sessionBinding(projectId, sessionId) {
      const project = store.requireProject(projectId);
      if (sessionId && project.initialSessionId && project.initialSessionId === String(sessionId)) {
        return { bound: true, role: "main", sessionId: String(sessionId) };
      }
      const row = db.prepare("select status from project_sessions where project_id = ? and session_id = ?").get(project.id, String(sessionId ?? ""));
      if (row?.status === "approved") return { bound: true, role: "associated", sessionId: String(sessionId) };
      return { bound: false, role: row?.status ?? "none", sessionId: sessionId ? String(sessionId) : null };
    },
    /** 反查：某会话归属哪个项目（主会话优先，其次已批准/待批准的关联）。用于 `/api/context?session=` 的项目解析。 */
    findProjectBySession(sessionId) {
      const s = String(sessionId ?? "");
      if (!s) return null;
      const main = db.prepare("select * from projects where initial_session_id = ? order by rowid limit 1").get(s);
      if (main) return { project: rowToProject(main), role: "main" };
      const row = db.prepare("select project_id, status from project_sessions where session_id = ? order by (status = 'approved') desc, rowid desc limit 1").get(s);
      if (row) return { project: store.requireProject(row.project_id), role: row.status };
      return null;
    },

    createTask(input = {}) {
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      if (projectId === "") throw invalidField("projectId", "必须指定项目（--project <项目id>）");
      store.requireProject(projectId);
      const title = assertTitle(input.title);
      const description = normalizeDescription(input.description);
      // FR-94：添加任务时即记录「完成验收标准 + 复核动作」（真机反馈：便于快速复核）
      const acceptance = normalizeAcceptance(input.acceptance);
      const verifyCommand = normalizeTaskVerifyCommand(input.verifyCommand);
      const status = assertStatus(input.status ?? DEFAULT_STATUS);
      const priority = assertPriority(input.priority ?? DEFAULT_PRIORITY);
      const labels = normalizeLabels(input.labels ?? []);
      const owner = normalizeOwner(input.owner);
      const parentRef = input.parentId ?? input.parent ?? null;
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();

      // ---- P0：归因在**建卡事务内**完成（本轮拍板 D1）----------------------------------
      // 为什么必须在事务内：`POST /api/tasks` + 事后 `/attribution` 是两步，中间任何失败都会留
      // 一张无归因卡；2026-10-28 一次全量修补 69 张，其中 56 张真实来源**已不可考**，只能挂兜底条目。
      // 形状：requirement（归因）与 unattributedReason（显式声明不归因）**二选一**，都给是用法错误。
      const requirementRefRaw = input.requirementId ?? input.requirement ?? null;
      const requirementRef = requirementRefRaw == null ? "" : String(requirementRefRaw).trim();
      const unattributedReason = normalizeUnattributedReason(input.unattributedReason);
      if (requirementRef !== "" && unattributedReason) {
        throw new TbError("USAGE_ERROR", "requirement 与 unattributedReason 不能同时给：要么归属需求条目，要么显式声明不归因");
      }
      if (requirementRef === "" && !unattributedReason && strictAttribution) {
        throw new TbError("REQUIREMENT_REQUIRED", "建卡必须归属需求条目：请给 requirement <条目>；确实不需要归属时用 unattributedReason <理由> 显式声明（会落审计）", { projectId });
      }

      let requirementId = null; // 事务内解析、事务外留痕（故声明在 try 之外）

      db.exec("begin immediate");
      try {
        let parentId = null;
        if (parentRef) {
          const parent = store.requireTaskRef(parentRef);
          assertParentLink({ id, projectId, parentId: null }, parent);
          assertNoCycle(id, parent.id, (candidate) => store.getTaskById(candidate));
          parentId = parent.id;
        }
        // 归因校验必须在**同一事务内**：条目不存在 / 跨项目 ⇒ 整笔回滚（连 next_seq 一起回滚，
        // 不留编号空洞、不留孤儿卡）。
        if (requirementRef !== "") {
          const item = store.requireRequirementItemRef(requirementRef);
          if (item.projectId !== projectId) {
            throw new TbError("DEPENDENCY_CROSS_PROJECT", `条目与任务必须同项目（条目 ${item.projectId}，任务 ${projectId}）`, { requirementProjectId: item.projectId, taskProjectId: projectId });
          }
          requirementId = item.id;
        }
        const project = db.prepare("select * from projects where id = ?").get(projectId);
        const sequence = project.next_seq;
        const identifier = formatIdentifier(projectId, sequence);
        db.prepare("update projects set next_seq = ?, updated_at = ? where id = ?").run(sequence + 1, timestamp, projectId);
        db.prepare(
          `insert into tasks (id, identifier, project_id, title, description, acceptance, verify_command, status, priority, labels, owner, parent_id, requirement_id, version, created_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).run(id, identifier, projectId, title, description, acceptance, verifyCommand, status, priority, JSON.stringify(labels), owner, parentId, requirementId, timestamp, timestamp);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        if (isConstraintError(error, "tasks.identifier")) throw new TbError("IDENTIFIER_CONFLICT", "可读编号冲突，请重试", { projectId });
        throw error;
      }
      // FR-82：任务生命周期变化写入追加式事件流（详情 / 看护 / 通知共同消费）
      store.recordTaskEvent(id, { type: "created", to: status, actor: "human", detail: `创建任务（${status}）` });
      // P0 归因留痕：三种落法都要能事后盘点（这是「逃生口」与「漏填」的唯一区别所在）
      if (requirementId) {
        store.recordTaskEvent(id, { type: "attributed", to: status, actor: "human", detail: `建卡即归属需求条目（${requirementId}）` });
      } else if (unattributedReason) {
        store.recordTaskEvent(id, { type: "attribution_skipped", to: status, actor: "human", detail: `建卡未归属需求条目（显式声明：${unattributedReason}）` });
      } else {
        store.recordTaskEvent(id, { type: "attribution_missing", to: status, actor: "human", detail: "建卡未归属需求条目（未声明理由）—— 启动执行/派发团队会被归因门拒绝" });
      }
      const created = store.getTaskById(id);
      // P1.5 · warn 档：审计要指到**这张卡**（不是 `task:new`）。切 reject 时必须把这行挪到 `begin` 之前。
      noteContractUse(projectId, input.contract, created.identifier);
      return created;
    },

    getTaskRef(ref) {
      if (typeof ref !== "string" || ref.trim() === "") return null;
      const value = ref.trim();
      return store.getTaskById(value) ?? store.getTaskByIdentifier(value);
    },

    requireTaskRef(ref) {
      const task = store.getTaskRef(ref);
      if (!task) throw new TbError("TASK_NOT_FOUND", `任务不存在：${ref}`, { ref });
      return task;
    },

    getTaskById(id) {
      if (typeof id !== "string" || id === "") return null;
      return rowToTask(db.prepare("select * from tasks where id = ?").get(id));
    },

    getTaskByIdentifier(identifier) {
      if (typeof identifier !== "string" || !parseIdentifier(identifier)) return null;
      return rowToTask(db.prepare("select * from tasks where identifier = ?").get(identifier));
    },

    listTasks(filter = {}) {
      const clauses = [];
      const params = [];
      if (filter.projectId) {
        clauses.push("project_id = ?");
        params.push(filter.projectId);
      }
      // FR-26 / FR-28：会话归属维度（与 FR-13 的其它维度取交集）。
      // 归属判据＝`session_id`（该列只在认领 / 启动执行时写入，FR-25，无需人工填写）。四档：
      //   · `linked`          —— 有没有关联会话（FR-26：「已关联」）
      //   · `unlinked`        —— 有没有关联会话（FR-26：「未关联」）
      //   · `session:<id>`    —— 关联的是**不是这一个具体会话**（FR-28：「仅本会话」，`session_id = <id>`）
      // 缺省（undefined/null/""）＝「全部」，不加任何条件。
      // 非法值（含空 id 的 `session:`）**如实报错**，不得静默降级成「全部」。
      if (filter.sessionScope !== undefined && filter.sessionScope !== null && filter.sessionScope !== "") {
        const scope = String(filter.sessionScope);
        if (scope === "linked") clauses.push("(session_id is not null and session_id != '')");
        else if (scope === "unlinked") clauses.push("(session_id is null or session_id = '')");
        else if (scope.startsWith("session:")) {
          const wanted = scope.slice("session:".length).trim();
          if (wanted === "") throw invalidField("sessionScope", `sessionScope 的 session:<会话标识> 形式必须带非空会话标识，收到：${JSON.stringify(filter.sessionScope)}`);
          clauses.push("session_id = ?");
          params.push(wanted);
        } else throw invalidField("sessionScope", `sessionScope 必须是 linked / unlinked / session:<会话标识> 之一，收到：${JSON.stringify(filter.sessionScope)}`);
      }
      if (filter.status !== undefined && filter.status !== null) {
        clauses.push("status = ?");
        params.push(assertStatus(filter.status));
      }
      if (filter.priority !== undefined && filter.priority !== null) {
        clauses.push("priority = ?");
        params.push(assertPriority(filter.priority));
      }
      if (filter.owner !== undefined && filter.owner !== null) {
        const owner = normalizeOwner(filter.owner);
        if (owner === null) clauses.push("(owner is null or owner = '')");
        else {
          clauses.push("owner = ?");
          params.push(owner);
        }
      }
      if (filter.parentId !== undefined) {
        if (filter.parentId === null) clauses.push("parent_id is null");
        else {
          clauses.push("parent_id = ?");
          params.push(filter.parentId);
        }
      }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      // FR-11 / FR-15：**列内手工顺序优先**。排序键 `(board_position is null, board_position, created_at, rowid)`：
      //   · 手工排过的卡（`board_position` 非空）按人工顺序在前；从未排过的卡保持"创建顺序"接在后面。
      //   · `board_position` 只在**列内**有意义（同 status 的卡共享一个 0..n-1 序列）；跨状态取数时各列
      //     位置会交叠，但前端按状态分列渲染，列内相对顺序即人工顺序 —— 这正是 FR-11 要的口径。
      //   · 该 ORDER BY 对"全部为空"的库**与旧的 `order by created_at, rowid` 逐行等价**（不影响既有行为）。
      let tasks = db.prepare(`select * from tasks ${where} order by (board_position is null), board_position, created_at, rowid`).all(...params).map(rowToTask);
      // FR-14：关键词搜索 —— 与上面各维度**取交集**（同一取数路径，不另开分支）。
      // 覆盖「任务编号 / 标题 / 描述 / 标签」四类字段，大小写不敏感。
      // 口径：缺省（undefined/null/空串/纯空白）＝不搜索（等价于「全部」）；
      // 非字符串入参**如实报错**，不静默当成「不搜索」。
      if (filter.q !== undefined && filter.q !== null) {
        if (typeof filter.q !== "string") throw invalidField("q", `搜索关键词 q 必须是字符串，收到：${JSON.stringify(filter.q)}`);
        const keyword = filter.q.trim().toLowerCase();
        if (keyword !== "") tasks = tasks.filter((task) => taskMatchesKeyword(task, keyword));
      }
      const wantedLabels = normalizeLabels(filter.labels ?? []);
      if (wantedLabels.length > 0) tasks = tasks.filter((task) => wantedLabels.every((label) => task.labels.includes(label)));
      // FR-15：`sort=priority` = 优先级档，**覆盖**手工顺序（这是"两档排序"里的另一档，二者互斥地主导顺序）；
      // 缺省（含 `created`）＝默认档，即 FR-15 的「默认顺序（由人工拖拽/创建顺序决定）」。
      if (filter.sort === "priority") tasks = tasks.slice().sort(compareByPriority);
      return tasks;
    },

    updateTask(ref, changes = {}) {
      const current = store.requireTaskRef(ref);
      noteContractUse(current.projectId, changes.contract, current.identifier);
      const { expectedVersion } = changes;
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new TbError("MISSING_VERSION", "更新必须提供 expectedVersion（我读到的版本）", { taskId: current.id, currentVersion: current.version });
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalidField("expectedVersion", "expectedVersion 必须是 ≥1 的整数");
      if (expectedVersion !== current.version) {
        throw new TbError("VERSION_CONFLICT", "任务已被他人修改，请重新读取后再提交", {
          taskId: current.id, identifier: current.identifier, expectedVersion, currentVersion: current.version,
        });
      }

      const actor = assertActor(changes.actor ?? "human");
      const nextStatus = changes.status === undefined ? current.status : assertStatus(changes.status);
      // FR-85b：人工校验任务是升级门，不是交付物 —— 不得被置「完成」；
      // 它的唯一出口是 concludeHumanReview（结论给出后任务自动转「已取消」）。
      if (nextStatus === "done" && nextStatus !== current.status && isHumanReviewTask(current)) {
        try { store.recordAudit({ actor, action: "set-status", target: current.identifier, allowed: false, reason: "human-review-cannot-done", detail: "人工校验任务不得置 done，请用人工结论入口" }); } catch { /* ignore */ }
        throw new TbError("HUMAN_REVIEW_CANNOT_DONE", `任务 ${current.identifier} 是人工校验任务：不得置「完成」，请用人工结论入口（continue / change-requirement / close）`, { identifier: current.identifier });
      }
      // FR-83 补口（2026-10-27 · 卡 `-162`，人拍板口径 **C：门 + 显式逃生口**）：
      // `in_review → done` 必须**评审通过**，默认拒（退出码 5 冲突类，**零副作用** —— 门在 `begin` 之前）。
      //
      // 原先为何没有这道门（-158 的登记理由仍成立，只是裁定改了）：FR-83 验收原文只约束「评审通过
      // **不自动**置完成」（红线是**不得自动化**），并未要求「完成必须先评审通过」⇒ 属口径选择。
      // 裁定前 `PATCH /api/tasks/:ref` 对评审态**无任何校验**：拖拽落到「完成」列就能把未评审的卡静默收口
      // （卡片「→」/ 抽屉「下一列」已由 -158 收敛，拖拽是剩下的那条）。
      //
      // 口径边界（三条，刻意如此）：
      //   · **只约束「从待验收收口」**：从未请求过评审的卡（`todo → done`）照旧可完成；
      //     `in_review → blocked/canceled/todo`（受阻、取消、退回返工）不受影响 —— 它们不是收口。
      //   · **逃生口是显式的**：`skipReview === true`（严格布尔；字符串 `"true"` 一律不算）才放行。
      //     人有权跳过评审（完成只能人确认），但必须是**明示的一次决定**，不能是位移动作的副作用；
      //     放行后落审计 + 事件留痕（`review_skipped`），事后可回看。
      //   · **不看 `actor`**：这道门只问"这张卡的评审态够不够格收口"；"自动化不得写 done"的红线在
      //     `governance` 与 `teamSetTaskStatus` 里，两件事不混。
      const skipReview = changes.skipReview === true;
      const closingWithoutApproval = nextStatus === "done" && nextStatus !== current.status
        && current.status === "in_review" && current.reviewState !== "approved";
      if (closingWithoutApproval && !skipReview) {
        try { store.recordAudit({ actor, action: "set-status", target: current.identifier, allowed: false, reason: "review-not-approved", detail: `review_state=${current.reviewState ?? "null"} → done 被拒` }); } catch { /* ignore */ }
        throw new TbError(
          "REVIEW_NOT_APPROVED",
          `任务 ${current.identifier} 还在「待验收」且评审未通过（review_state=${current.reviewState ?? "pending"}）：请先「评审通过」再置「完成」；确需跳过评审，请显式提交 skipReview=true`,
          { identifier: current.identifier, reviewState: current.reviewState ?? null, status: current.status, nextStatus },
        );
      }
      const nextPriority = changes.priority === undefined ? current.priority : assertPriority(changes.priority);
      const nextTitle = changes.title === undefined ? current.title : assertTitle(changes.title);
      const nextDescription = changes.description === undefined ? current.description : normalizeDescription(changes.description);
      // FR-94：验收标准 / 复核动作可编辑（显式传空串即清空；复核动作清空 ⇒ 回落项目设置）
      const nextAcceptance = changes.acceptance === undefined ? (current.acceptance ?? "") : normalizeAcceptance(changes.acceptance);
      const nextVerifyCommand = changes.verifyCommand === undefined ? (current.verifyCommand ?? null) : normalizeTaskVerifyCommand(changes.verifyCommand);
      const nextOwner = changes.owner === undefined ? current.owner : normalizeOwner(changes.owner);

      let nextLabels = current.labels;
      if (changes.labels !== undefined) nextLabels = normalizeLabels(changes.labels);
      else if (changes.addLabels !== undefined || changes.removeLabels !== undefined) {
        const merged = new Set(current.labels);
        for (const label of normalizeLabels(changes.addLabels ?? [])) merged.add(label);
        for (const label of normalizeLabels(changes.removeLabels ?? [])) merged.delete(label);
        nextLabels = normalizeLabels([...merged]);
      }
      nextLabels = nextLabels.filter((label) => !String(label).startsWith("owner:"));

      const governance = checkGovernance({ actor, from: current.status, to: nextStatus }, store.policy);
      if (governance) throw governance;

      let nextParentId = current.parentId;
      if (changes.parentId !== undefined || changes.clearParent === true) {
        if (changes.clearParent === true || changes.parentId === null) nextParentId = null;
        else {
          const parent = store.requireTaskRef(changes.parentId);
          assertParentLink({ id: current.id, projectId: current.projectId, parentId: current.parentId }, parent);
          assertNoCycle(current.id, parent.id, (candidate) => store.getTaskById(candidate));
          nextParentId = parent.id;
        }
      }

      const timestamp = nowIso();
      // FR-78：任务级熔断阈值可编辑（整数 ≥1 或 null=回落到默认）
      let nextMaxRetries = current.maxRetries ?? null;
      if (changes.maxRetries !== undefined) {
        if (changes.maxRetries === null || changes.maxRetries === "") nextMaxRetries = null;
        else {
          const n = Number(changes.maxRetries);
          if (!Number.isInteger(n) || n < 1) throw invalidField("maxRetries", "maxRetries 必须是 ≥1 的整数，或 null");
          nextMaxRetries = n;
        }
      }
      // FR-77 口径对齐 `teamSetTaskStatus`：**状态离开「进行中」即释放认领**。
      // 此前人工/看板 PATCH 不走这条规则 —— 真机现场（2026-10-18）`-63`/`-69` 已进「待验收」却仍锁着
      // 一把过期认领，而回收器只扫 `in_progress`，那把锁永远没人清（幽灵在途）。
      const releaseClaim = nextStatus === "in_progress" ? "" : ", claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null";
      // FR-11：跨列移动（仅改状态、没带落点）⇒ **清空手工位置**。旧列的位置数字是**列内**坐标，
      // 带着它进新列会插到新列中间（看着像"随机插入"）；清空后按 created_at 落在新列的"未手工排过"段，
      // 这是"按钮换列"这条路径下唯一不臆断的落点。带落点的拖拽则由下面 resolveBoardOrder 显式定位。
      const clearOrder = nextStatus !== current.status ? ", board_position = null" : "";
      // FR-11 + 门序（`tests/gate-before-side-effects.test.mjs` 同一口径）：**落点必须先解析、后写库**。
      // `resolveBoardOrder` 会因「锚点不存在 / 跨列 / 非法下标」抛错 —— 若等主 UPDATE 之后再解析，
      // 被拒的拖拽就已经把状态改了、版本涨了（门后于副作用），正是那条红线要钉死的情形。
      // 错误一律在 `begin` 之前抛出 ⇒ 连事务都不开，一个字段都不写。
      const order = changes.boardPosition !== undefined
        ? resolveBoardOrder(db, { taskId: current.id, projectId: current.projectId, status: nextStatus, desiredIndex: changes.boardPosition })
        : null;
      db.exec("begin immediate");
      try {
        db.prepare(
          `update tasks set title = ?, description = ?, acceptance = ?, verify_command = ?, status = ?, priority = ?, labels = ?, owner = ?,
                  parent_id = ?, max_retries = ?, blocked_at = ?${releaseClaim}${clearOrder}, version = version + 1, updated_at = ? where id = ? and version = ?`,
        ).run(nextTitle, nextDescription, nextAcceptance, nextVerifyCommand, nextStatus, nextPriority, JSON.stringify(nextLabels), nextOwner,
          nextParentId, nextMaxRetries,
          // FR-79：受阻起始时间（人工置"受阻"也记；离开受阻即清空）
          nextStatus === "blocked" ? (current.blockedAt ?? timestamp) : null,
          timestamp, current.id, expectedVersion);
        // FR-11：显式落点（拖拽）写回 —— 放在状态更新**之后**，才能把卡放进"目标列"的正确下标
        // （列集合此刻已含它自己）。状态与位置是**同一次** PATCH 的两个字段，必须同生共死 ⇒ 同一事务。
        if (order) applyBoardOrder(db, order.ordered);
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      if (nextStatus !== current.status) {
        // FR-82：状态变化 → 事件流追加（不再让各处各自造"状态历史"）。
        // 注意：**纯列内排序不写任何事件** —— 版式调整不是任务生命周期事件，塞进去只会污染事件流与通知口径。
        store.recordTaskEvent(current.id, { type: "status_changed", from: current.status, to: nextStatus, actor: changes.actor ?? "human" });
      }
      // FR-83 补口（卡 `-162`）：逃生口放行后必须**可回看** —— 这是"人显式决定跳过评审"的取证点，
      // 否则事后只看到一张 done 卡，分不清"评审通过后收口"与"跳过评审收口"。
      if (closingWithoutApproval && skipReview) {
        store.recordTaskEvent(current.id, {
          type: "review_skipped", from: "in_review", to: "done", actor,
          detail: `跳过评审直接完成（review_state=${current.reviewState ?? "null"}）`,
        });
        try { store.recordAudit({ actor, action: "set-status", target: current.identifier, allowed: true, reason: "review-skipped", detail: `skipReview=true（review_state=${current.reviewState ?? "null"}）` }); } catch { /* ignore */ }
      }
      // 返回形状与其它路径一致（就是任务本身；`boardPosition` 是它的一个正式字段，前端重取即见）。
      return store.getTaskById(current.id);
    },

    deleteTask(ref, { expectedVersion } = {}) {
      const current = store.requireTaskRef(ref);
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new TbError("MISSING_VERSION", "删除必须提供 expectedVersion（我读到的版本）", { taskId: current.id, currentVersion: current.version });
      }
      if (expectedVersion !== current.version) {
        throw new TbError("VERSION_CONFLICT", "任务已被他人修改，请重新读取后再删除", {
          taskId: current.id, expectedVersion, currentVersion: current.version,
        });
      }
      db.prepare("delete from tasks where id = ?").run(current.id);
      return { id: current.id, identifier: current.identifier, deleted: true };
    },

    addComment(ref, input = {}) {
      const task = store.requireTaskRef(ref);
      noteContractUse(task.projectId, input.contract, task.identifier);
      const body = normalizeDescription(input.body);
      const id = input.id ?? randomUUID();
      const timestamp = nowIso();
      db.prepare(`insert into comments (id, task_id, body, version, created_at, updated_at) values (?, ?, ?, 1, ?, ?)`)
        .run(id, task.id, body, timestamp, timestamp);
      return rowToComment(db.prepare("select * from comments where id = ?").get(id));
    },

    listComments(ref) {
      const task = store.requireTaskRef(ref);
      return db.prepare(COMMENT_SELECT + " where c.task_id = ? order by c.created_at, c.rowid").all(task.id).map(rowToComment);
    },

    /** 单条评论（FR-17 编辑入口要先读到 `version` 才能带乐观锁提交）。 */
    getComment(commentId) {
      if (typeof commentId !== "string" || commentId === "") return null;
      return rowToComment(db.prepare(COMMENT_SELECT + " where c.id = ?").get(commentId));
    },

    /**
     * FR-17：编辑一条评论（**不静默覆盖**）。
     *
     * 三条纪律：
     * 1. **乐观锁**：必须带 `expectedVersion`（= 我读到的 `comment.version`），写时用
     *    `where id = ? and version = ?` 做 CAS；冲突抛 `VERSION_CONFLICT`（退出码 5），绝不覆盖。
     * 2. **留痕**：编辑前先把**原正文原样**写进 `comment_revisions`（rev = 被取代的那一版），
     *    所以"原内容"是**可回看的历史**，而不是一句"已编辑 N 次"的声明。
     * 3. **证据红线**：机器产出的证据评论（`【自动复核】…`）**只读**；且**不得把普通评论改成
     *    证据形态**（否则等于伪造评审证据）。见 `assertCommentEditable`。
     *
     * 正文与当前完全一致时视为无变化：不涨版本、不留痕（避免空编辑刷版本）。
     */
    updateComment(commentId, { expectedVersion, body, actor = "human" } = {}) {
      const row = db.prepare(COMMENT_SELECT + " where c.id = ?").get(commentId);
      if (!row) throw new TbError("COMMENT_NOT_FOUND", `评论不存在：${commentId}`, { commentId });
      const current = rowToComment(row);
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new TbError("MISSING_VERSION", "编辑评论必须提供 expectedVersion（我读到的版本）", { commentId, currentVersion: current.version });
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalidField("expectedVersion", "expectedVersion 必须是 ≥1 的整数");
      if (expectedVersion !== current.version) {
        throw new TbError("VERSION_CONFLICT", "评论已被他人修改，请重新读取后再提交（不静默覆盖）", {
          commentId, expectedVersion, currentVersion: current.version,
        });
      }
      const nextBody = normalizeDescription(body);
      assertCommentEditable(current.body, nextBody, commentId);
      if (nextBody === current.body) return { comment: current, changed: false, revision: null };

      const timestamp = nowIso();
      const revisions = Number(db.prepare("select count(*) as n from comment_revisions where comment_id = ?").get(commentId)?.n ?? 0);
      // 留痕：存**编辑前**的正文（rev 从 1 起；列表按 rev 升序 = 历史回放顺序）
      db.prepare("insert into comment_revisions (id, comment_id, rev, body, edited_at, edited_by) values (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), commentId, revisions + 1, current.body, timestamp, actor);
      const res = db.prepare("update comments set body = ?, version = version + 1, updated_at = ?, edited_at = ?, edited_by = ? where id = ? and version = ?")
        .run(nextBody, timestamp, timestamp, actor, commentId, expectedVersion);
      if (res.changes !== 1) {
        // CAS 兜底（极端并发）：回滚刚写的留痕行，保持"未发生"。
        db.prepare("delete from comment_revisions where comment_id = ? and rev = ?").run(commentId, revisions + 1);
        throw new TbError("VERSION_CONFLICT", "评论已被他人修改，请重新读取后再提交（不静默覆盖）", {
          commentId, expectedVersion, currentVersion: Number(db.prepare("select version from comments where id = ?").get(commentId)?.version ?? 0),
        });
      }
      const comment = store.getComment(commentId);
      store.recordTaskEvent(row.task_id, { type: "comment_edited", to: "edited", actor, detail: `编辑评论（第 ${revisions + 1} 次；原正文已留痕）` });
      return { comment, changed: true, revision: store.listCommentRevisions(commentId).at(-1) };
    },

    /** 评论编辑历史（按 rev 升序；最后一个 = 上一版正文）。 */
    listCommentRevisions(commentId) {
      if (typeof commentId !== "string" || commentId === "") return [];
      return db.prepare("select * from comment_revisions where comment_id = ? order by rev").all(commentId).map(rowToCommentRevision);
    },

    deleteComment(commentId) {
      const row = db.prepare("select * from comments where id = ?").get(commentId);
      if (!row) throw new TbError("COMMENT_NOT_FOUND", `评论不存在：${commentId}`, { commentId });
      db.prepare("delete from comments where id = ?").run(commentId);
      return { id: commentId, deleted: true };
    },

    // ---------------------------------------------------------------- 需求文档（FR-34）
    getRequirementDoc(projectId) {
      if (typeof projectId !== "string" || projectId === "") return null;
      return rowToRequirementDoc(db.prepare("select * from requirement_docs where project_id = ?").get(projectId));
    },
    getRequirementDocById(id) {
      if (typeof id !== "string" || id === "") return null;
      return rowToRequirementDoc(db.prepare("select * from requirement_docs where id = ?").get(id));
    },
    listRequirementDocs(filter = {}) {
      const rows = filter.projectId
        ? db.prepare("select * from requirement_docs where project_id = ? order by created_at, rowid").all(filter.projectId)
        : db.prepare("select * from requirement_docs order by created_at, rowid").all();
      return rows.map(rowToRequirementDoc);
    },
    ensureRequirementDoc(projectId, { body = "" } = {}) {
      store.requireProject(projectId);
      const existing = store.getRequirementDoc(projectId);
      if (existing) return existing;
      const id = randomUUID();
      const ts = nowIso();
      db.prepare("insert into requirement_docs (id, project_id, body, version, created_at, updated_at) values (?, ?, ?, 1, ?, ?)")
        .run(id, projectId, String(body), ts, ts);
      return store.getRequirementDoc(projectId);
    },
    updateRequirementDoc(ref, changes = {}) {
      const doc = store.getRequirementDocById(ref) ?? store.getRequirementDoc(ref);
      if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${ref}`, { ref });
      const { expectedVersion } = changes;
      if (expectedVersion === undefined || expectedVersion === null) {
        throw new TbError("MISSING_VERSION", "更新需求文档必须提供 expectedVersion（我读到的版本）", { docId: doc.id, currentVersion: doc.version });
      }
      if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw invalidField("expectedVersion", "expectedVersion 必须是 ≥1 的整数");
      if (expectedVersion !== doc.version) {
        throw new TbError("VERSION_CONFLICT", "需求文档已被他人修改，请重新读取后再提交", { docId: doc.id, expectedVersion, currentVersion: doc.version });
      }
      const body = changes.body === undefined ? doc.body : String(changes.body);
      db.prepare("update requirement_docs set body = ?, version = version + 1, updated_at = ? where id = ? and version = ?")
        .run(body, nowIso(), doc.id, expectedVersion);
      return store.getRequirementDocById(doc.id);
    },

    // ---------------------------------------------------------------- 需求条目（FR-35）
    getRequirementItemRef(ref) {
      if (typeof ref !== "string" || ref.trim() === "") return null;
      const value = ref.trim();
      return store.getRequirementItemById(value) ?? store.getRequirementItemByIdentifier(value);
    },
    requireRequirementItemRef(ref) {
      const item = store.getRequirementItemRef(ref);
      if (!item) throw new TbError("REQUIREMENT_NOT_FOUND", `需求条目不存在：${ref}`, { ref });
      return item;
    },
    getRequirementItemById(id) {
      if (typeof id !== "string" || id === "") return null;
      return rowToRequirementItem(db.prepare("select * from requirement_items where id = ?").get(id));
    },
    getRequirementItemByIdentifier(identifier) {
      if (typeof identifier !== "string" || !parseRequirementIdentifier(identifier)) return null;
      return rowToRequirementItem(db.prepare("select * from requirement_items where identifier = ?").get(identifier));
    },
    listRequirementItems(filter = {}) {
      const clauses = []; const params = [];
      if (filter.projectId) { clauses.push("project_id = ?"); params.push(filter.projectId); }
      if (filter.docId) { clauses.push("doc_id = ?"); params.push(filter.docId); }
      if (filter.status) { clauses.push("status = ?"); params.push(assertRequirementStatus(filter.status)); }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return db.prepare(`select * from requirement_items ${where} order by created_at, rowid`).all(...params).map(rowToRequirementItem);
    },
    createRequirementItem(input = {}) {
      const projectId = typeof input.projectId === "string" ? input.projectId : "";
      if (projectId === "") throw invalidField("projectId", "必须指定项目（--project <项目id>）");
      store.requireProject(projectId);
      const title = assertTitle(input.title);
      const description = normalizeDescription(input.description);
      const acceptance = input.acceptance == null ? "" : String(input.acceptance);
      const priority = assertPriority(input.priority ?? DEFAULT_PRIORITY);
      const status = input.status == null ? "open" : assertRequirementStatus(input.status);
      const source = assertRequirementSource(input.source ?? "manual");
      let docId = null;
      if (input.docId) {
        const doc = store.getRequirementDocById(input.docId);
        if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${input.docId}`, { docId: input.docId });
        docId = doc.id;
      }
      const id = input.id ?? randomUUID();
      const ts = nowIso();
      db.exec("begin immediate");
      try {
        insertRequirementItem(db, { id, projectId, docId, title, description, acceptance, priority, status, source, ts });
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        if (isConstraintError(error, "requirement_items.identifier")) throw new TbError("REQ_IDENTIFIER_CONFLICT", "需求条目编号冲突，请重试", { projectId });
        throw error;
      }
      const createdItem = store.getRequirementItemById(id);
      noteContractUse(projectId, input.contract, createdItem.identifier);
      return createdItem;
    },
    /** 更新需求条目（状态/标题/说明/验收/优先级）——资料引入后的"确认/修订"。 */
    updateRequirementItem(ref, changes = {}) {
      const item = store.requireRequirementItemRef(ref);
      noteContractUse(item.projectId, changes.contract, item.identifier);
      const sets = []; const params = [];
      if (changes.title !== undefined) {
        const nextTitle = assertTitle(changes.title);
        sets.push("title = ?"); params.push(nextTitle);
        // 卡 `-178`（2026-10-29）：改标题**必须同步去重键** `norm_title`。
        // 此前只写 `title` ⇒ 条目改名后 `norm_title` 仍指向旧标题，而 `confirmRequirementCandidates`
        // 是按 `norm_title` 去重的 ⇒ 同一条目会被当成「新条目」再插一次（陈旧键 = 静默重复）。
        // 存量实测 `normTitleMismatch = 0`（`tools/audit-intake.mjs`），所以这是**防新增**而非修存量。
        sets.push("norm_title = ?"); params.push(titleKey(nextTitle));
      }
      if (changes.description !== undefined) { sets.push("description = ?"); params.push(normalizeDescription(changes.description)); }
      if (changes.acceptance !== undefined) { sets.push("acceptance = ?"); params.push(String(changes.acceptance)); }
      if (changes.priority !== undefined) { sets.push("priority = ?"); params.push(assertPriority(changes.priority)); }
      if (changes.status !== undefined) { sets.push("status = ?"); params.push(assertRequirementStatus(changes.status)); }
      // FR-91 补口：条目 ↔ 需求文档的**关联**此前无法修改（引入资料时一次性写入、之后只能删），
      // 真机上就出现了「条目没关联到需求文档」却补不回来的死结。这里补上（docId=null 表示解除关联）。
      if (changes.docId !== undefined) {
        if (changes.docId === null || changes.docId === "") { sets.push("doc_id = ?"); params.push(null); }
        else {
          const doc = store.getRequirementDocById(String(changes.docId));
          if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${changes.docId}`, { docId: changes.docId });
          sets.push("doc_id = ?"); params.push(doc.id);
        }
      }
      if (!sets.length) return item;
      sets.push("updated_at = ?"); params.push(nowIso());
      db.prepare(`update requirement_items set ${sets.join(", ")} where id = ?`).run(...params, item.id);
      return store.getRequirementItemById(item.id);
    },
    /** 删除需求条目（资料引入误建 / 收编合并时清理）。 */
    deleteRequirementItem(ref) {
      const item = store.requireRequirementItemRef(ref);
      db.prepare("delete from requirement_items where id = ?").run(item.id);
      return { identifier: item.identifier, deleted: true };
    },

    // ---------------------------------------------------------------- 可行性门（FR-37，追加字段）
    setRequirementFeasibility(ref, changes = {}) {
      const item = store.requireRequirementItemRef(ref);
      const verdict = assertFeasibilityVerdict(changes.verdict);
      const reason = changes.reason == null ? "" : String(changes.reason);
      const by = changes.by === "human" ? "human" : "machine";
      const override = changes.override == null ? null : String(changes.override);
      db.prepare(
        "update requirement_items set feasibility = ?, feasibility_reason = ?, feasibility_by = ?, feasibility_override = ?, updated_at = ? where id = ?",
      ).run(verdict, reason, by, override, nowIso(), item.id);
      return store.getRequirementItemById(item.id);
    },

    // ---------------------------------------------------------------- 条目化（FR-36，规则解析，MVP 不用 AI）
    elaborateRequirementDoc(ref, options = {}) {
      const doc = options.docId
        ? store.getRequirementDocById(options.docId)
        : (store.getRequirementDocById(ref) ?? store.getRequirementDoc(ref ?? options.projectId));
      if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${options.docId ?? ref ?? options.projectId}`, { ref: options.docId ?? ref ?? options.projectId });
      // 规则解析 = fallback 路径（AI 版见切片2，或由宿主注入 aiElaborator）
      // B-2：规则条目化可能一次产出成百上千条（尤其对"资料索引"这类文档）→ 加数量上限，防"候选洪水"
      // 卡 `-169` P4②（2026-10-29）：默认 100 → **20**，硬顶 200，见文件头 DEFAULT_ELABORATE_LIMIT 注释。
      const limit = clampElaborateLimit(options.limit);
      const all = elaborateDocument(doc.body);
      const capped = all.slice(0, limit);
      const truncated = all.length > capped.length;
      // dryRun：**零落库**，只回预览（规则模式此前"一点就写"，人没有反悔的机会）
      if (options.dryRun === true) {
        const preview = capped.slice(0, ELABORATE_PREVIEW_SIZE).map((c) => ({
          title: c.title, description: c.description, acceptance: c.acceptance, priority: c.priority,
        }));
        return {
          docId: doc.id, dryRun: true, source: "elaborated-rule", mode: "rule",
          limit, totalFound: all.length, truncated,
          preview, previewCount: preview.length,
          candidates: [], duplicatesSkipped: 0,
        };
      }
      const res = store.addRequirementCandidates(doc.id, capped, { source: "elaborated-rule" });
      return { ...res, limit, truncated, totalFound: all.length };
    },
    /** 写入一组候选条目（AI 或规则产出共用）；去重、未确认不落 requirement_items。 */
    addRequirementCandidates(ref, candidates, { source = "elaborated-rule" } = {}) {
      const doc = store.getRequirementDocById(ref) ?? store.getRequirementDoc(ref);
      if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${ref}`, { ref });
      const list = normalizeCandidates(candidates);
      const existingItems = new Set(store.listRequirementItems({ projectId: doc.projectId }).map((x) => x.normTitle));
      const pending = db.prepare("select norm_title from requirement_candidates where doc_id = ? and status = 'pending'").all(doc.id).map((r) => r.norm_title);
      const seen = new Set([...existingItems, ...pending]);
      const created = [];
      const ts = nowIso();
      const insert = db.prepare(
        `insert into requirement_candidates (id, doc_id, project_id, title, description, acceptance, priority, norm_title, source, status, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      );
      for (const c of list) {
        const key = titleKey(c.title);
        if (key === "" || seen.has(key)) continue;
        seen.add(key);
        const id = randomUUID();
        insert.run(id, doc.id, doc.projectId, c.title, c.description, c.acceptance, c.priority, key, source, ts);
        created.push(rowToRequirementCandidate(db.prepare("select * from requirement_candidates where id = ?").get(id)));
      }
      return { docId: doc.id, candidates: created, duplicatesSkipped: list.length - created.length, source };
    },
    listRequirementCandidates(filter = {}) {
      const clauses = []; const params = [];
      if (filter.docId) { clauses.push("doc_id = ?"); params.push(filter.docId); }
      if (filter.status) { clauses.push("status = ?"); params.push(filter.status); }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return db.prepare(`select * from requirement_candidates ${where} order by created_at, rowid`).all(...params).map(rowToRequirementCandidate);
    },
    /** 批量清理候选（B-4）：按 ids 或 docId+status 删除。 */
    deleteRequirementCandidates({ ids = null, docId = undefined, status = undefined } = {}) {
      let removed = 0;
      if (Array.isArray(ids) && ids.length) {
        const stmt = db.prepare("delete from requirement_candidates where id = ?");
        for (const id of ids) { const r = stmt.run(id); removed += r.changes ?? 0; }
        return { removed };
      }
      const clauses = []; const params = [];
      if (docId) { clauses.push("doc_id = ?"); params.push(docId); }
      if (status) { clauses.push("status = ?"); params.push(status); }
      if (!clauses.length) throw invalidField("candidates", "批量删除需指定 ids 或 docId/status");
      const r = db.prepare(`delete from requirement_candidates where ${clauses.join(" and ")}`).run(...params);
      return { removed: r.changes ?? 0 };
    },
    confirmRequirementCandidates(ids) {
      if (!Array.isArray(ids) || ids.length === 0) throw invalidField("ids", "必须提供要确认的候选 id 列表（非空）");
      const created = [];
      const ts = nowIso();
      const mark = db.prepare("update requirement_candidates set status = 'confirmed' where id = ? and status = 'pending'");
      db.exec("begin immediate");
      try {
        for (const cid of ids) {
          const row = db.prepare("select * from requirement_candidates where id = ?").get(cid);
          if (!row) throw new TbError("CANDIDATE_NOT_FOUND", `候选不存在：${cid}`, { candidateId: cid });
          if (row.status !== "pending") continue;
          const id = randomUUID();
          insertRequirementItem(db, {
            id, projectId: row.project_id, docId: row.doc_id, title: row.title,
            description: row.description, acceptance: row.acceptance, priority: row.priority,
            status: "open", source: row.source ?? "elaborated-rule", ts,
          });
          mark.run(cid);
          created.push(store.getRequirementItemById(id));
        }
        db.exec("commit");
      } catch (error) {
        db.exec("rollback");
        throw error;
      }
      return { created };
    },
    rejectRequirementCandidates(ids) {
      if (!Array.isArray(ids) || ids.length === 0) throw invalidField("ids", "必须提供要拒绝的候选 id 列表（非空）");
      const run = db.prepare("update requirement_candidates set status = 'rejected' where id = ? and status = 'pending'");
      let rejected = 0;
      db.exec("begin immediate");
      try { for (const cid of ids) rejected += run.run(cid).changes; db.exec("commit"); } catch (error) { db.exec("rollback"); throw error; }
      return { rejected };
    },

    // ---------------------------------------------------------------- 任务依赖（FR-39）
    addTaskDependency(input = {}) {
      const blocker = store.requireTaskRef(input.blocker ?? input.blockerId);
      const blocked = store.requireTaskRef(input.blocked ?? input.blockedId);
      if (blocker.id === blocked.id) throw new TbError("DEPENDENCY_SELF", "任务不能依赖自己", { taskId: blocker.id });
      if (blocker.projectId !== blocked.projectId) {
        throw new TbError("DEPENDENCY_CROSS_PROJECT", `依赖不能跨项目（前置 ${blocker.projectId}，后继 ${blocked.projectId}）`, { blockerProjectId: blocker.projectId, blockedProjectId: blocked.projectId });
      }
      const cyc = db.prepare(
        `with recursive reach(x) as (
           select ?
           union
           select d.blocked_id from task_dependencies d join reach r on d.blocker_id = r.x
         ) select 1 as c from reach where x = ? limit 1`,
      ).get(blocked.id, blocker.id);
      if (cyc) throw new TbError("DEPENDENCY_CYCLE", "依赖会形成环，已拒绝", { blockerId: blocker.id, blockedId: blocked.id });
      const reason = input.reason == null || input.reason === "" ? null : String(input.reason);
      try {
        db.prepare("insert into task_dependencies (project_id, blocker_id, blocked_id, reason, created_at) values (?, ?, ?, ?, ?)")
          .run(blocker.projectId, blocker.id, blocked.id, reason, nowIso());
      } catch (error) {
        if (isConstraintError(error, "task_dependencies")) throw new TbError("DEPENDENCY_EXISTS", "该依赖已存在", { blocker: blocker.identifier, blocked: blocked.identifier });
        throw error;
      }
      return store.listTaskDependencies(blocked.id);
    },
    removeTaskDependency(input = {}) {
      const blocker = store.getTaskRef(input.blocker ?? input.blockerId);
      const blocked = store.getTaskRef(input.blocked ?? input.blockedId);
      if (!blocker || !blocked) return { removed: false };
      const r = db.prepare("delete from task_dependencies where blocker_id = ? and blocked_id = ?").run(blocker.id, blocked.id);
      return { removed: r.changes > 0 };
    },
    listTaskDependencies(ref) {
      const task = store.requireTaskRef(ref);
      const blockers = db.prepare(
        "select d.blocker_id as id, t.identifier as identifier, t.title as title, t.status as status, d.reason as reason from task_dependencies d join tasks t on t.id = d.blocker_id where d.blocked_id = ? order by d.created_at",
      ).all(task.id);
      const blocks = db.prepare(
        "select d.blocked_id as id, t.identifier as identifier, t.title as title, t.status as status from task_dependencies d join tasks t on t.id = d.blocked_id where d.blocker_id = ? order by d.created_at",
      ).all(task.id);
      return { taskId: task.id, identifier: task.identifier, blockers, blocks };
    },
    isTaskReady(ref) {
      const task = store.requireTaskRef(ref);
      const rows = db.prepare(
        "select d.blocker_id as id, t.identifier as identifier, t.status as status from task_dependencies d join tasks t on t.id = d.blocker_id where d.blocked_id = ?",
      ).all(task.id);
      const unfinished = rows.filter((r) => r.status !== "done");
      return { taskId: task.id, identifier: task.identifier, ready: unfinished.length === 0, blockers: rows };
    },

    // ---------------------------------------------------------------- 分拆（FR-38）
    splitRequirement(ref, { tasks } = {}) {
      const item = store.requireRequirementItemRef(ref);
      const list = assertSplitTasks(tasks ?? []);
      if (list.length === 0) throw new TbError("SPLIT_EMPTY", "分拆产出为空：未提供任何任务", { requirement: item.identifier });
      const created = [];
      const byTitle = new Map();
      for (const t of list) {
        // 2026-10-28：`kind` 落到标签 `kind/work` / `kind/review`（任务表没有 kind 列，也不值得为此加列）。
        // 用标签而不是拼进描述：卡片与抽屉都能直接看到，且可按标签筛。
        const labels = [...(Array.isArray(t.labels) ? t.labels : [])];
        if (t.kind) labels.push(`kind/${t.kind}`);
        const task = store.createTask({
          projectId: item.projectId, title: t.title, description: t.description,
          owner: t.owner, priority: t.priority, labels, status: "backlog",
        });
        const linked = store.associateRequirementTask(item.id, task.id);
        created.push(linked);
        byTitle.set(titleKey(t.title), linked);
      }
      for (const t of list) {
        const task = byTitle.get(titleKey(t.title));
        for (const dep of t.dependsOn) {
          const target = byTitle.get(titleKey(dep)) ?? store.getTaskRef(dep);
          if (!target) throw new TbError("TASK_NOT_FOUND", `依赖目标不存在：${dep}`, { dep });
          store.addTaskDependency({ blocker: target.id, blocked: task.id });
        }
      }
      return { requirement: item.identifier, tasks: created };
    },
    associateRequirementTask(ref, taskRef) {
      const item = store.requireRequirementItemRef(ref);
      const task = store.requireTaskRef(taskRef);
      if (item.projectId !== task.projectId) {
        throw new TbError("DEPENDENCY_CROSS_PROJECT", `条目与任务必须同项目（条目 ${item.projectId}，任务 ${task.projectId}）`, { requirementProjectId: item.projectId, taskProjectId: task.projectId });
      }
      db.prepare("update tasks set requirement_id = ?, updated_at = ? where id = ?").run(item.id, nowIso(), task.id);
      return store.getTaskById(task.id);
    },
    listTasksByRequirement(ref) {
      const item = store.requireRequirementItemRef(ref);
      return db.prepare("select * from tasks where requirement_id = ? order by created_at, rowid").all(item.id).map(rowToTask);
    },
    /**
     * 只读：条目的「完成度」——关联任务清单 + 汇总结论（FR-91）。
     * 需求详情靠它回答「这条需求关联的任务做完了没有」，自动给建议、终态仍由人确认。
     */
    requirementCompletion(ref) {
      const item = store.requireRequirementItemRef(ref);
      const tasks = store.listTasksByRequirement(item.id);
      return { item, ...summarizeRequirementCompletion(tasks) };
    },
    /** 只读：条目的技术任务 DAG（任务节点 + 依赖边），供 UI 展示。 */
    /**
     * 需求条目的「任务 DAG」投影（FR-91 补口 · 2026-10-29 二轮优化）。
     *
     * 三条口径（都是真机读出来的，不是设计想象）：
     *   ① **前置在上**：按依赖做**稳定拓扑序**（Kahn；同层保持 `created_at, rowid`）。人从上往下读就是执行顺序。
     *      环在 `addTaskDependency` 已被 reach 检查拒掉，这里仍防御一次：排不进去的尾巴按原序追加，**绝不丢节点**。
     *   ② **每个节点带 `blockedBy`**：前端不必自己反算边，节点上就能写「⬅ 前置 A、B」——
     *      真机批注只看到「⛔ 受阻」四个字，等于让人自己去猜"卡在谁身上"。
     *   ③ **每条边带 `reason`**：`task_dependencies.reason` 本来就是"为什么卡住"的原文（如「停写窗口未确认」），
     *      投影里丢掉它，等于把最有用的那句话留在库里。
     */
    requirementTaskGraph(ref) {
      const item = store.requireRequirementItemRef(ref);
      const tasks = db.prepare("select * from tasks where requirement_id = ? order by created_at, rowid").all(item.id).map(rowToTask);
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const rows = db.prepare("select blocker_id, blocked_id, reason from task_dependencies").all()
        .filter((r) => byId.has(r.blocker_id) && byId.has(r.blocked_id));
      // ---- ① 稳定拓扑序 ----
      const indeg = new Map(tasks.map((t) => [t.id, 0]));
      const downstream = new Map(tasks.map((t) => [t.id, []]));
      for (const r of rows) {
        indeg.set(r.blocked_id, (indeg.get(r.blocked_id) ?? 0) + 1);
        downstream.get(r.blocker_id).push(r.blocked_id);
      }
      const queue = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
      const ordered = [];
      const placed = new Set();
      while (queue.length) {
        const id = queue.shift();
        ordered.push(id);
        placed.add(id);
        for (const nextId of downstream.get(id) ?? []) {
          const left = (indeg.get(nextId) ?? 0) - 1;
          indeg.set(nextId, left);
          if (left === 0) queue.push(nextId);
        }
      }
      for (const t of tasks) if (!placed.has(t.id)) ordered.push(t.id); // 防御：环残留按原序追加
      // ---- ② 每个节点的「被谁卡住」 ----
      const blockedBy = new Map(tasks.map((t) => [t.id, []]));
      for (const r of rows) {
        const blocker = byId.get(r.blocker_id);
        blockedBy.get(r.blocked_id).push({ identifier: blocker.identifier, title: blocker.title, status: blocker.status, reason: r.reason ?? null });
      }
      return {
        item: { id: item.id, identifier: item.identifier, title: item.title, feasibility: item.feasibility },
        nodes: ordered.map((id) => {
          const t = byId.get(id);
          return { id: t.id, identifier: t.identifier, title: t.title, status: t.status, blockedBy: blockedBy.get(id) };
        }),
        // ---- ③ 边上带原始 reason ----
        edges: rows.map((r) => ({ blocker: byId.get(r.blocker_id).identifier, blocked: byId.get(r.blocked_id).identifier, reason: r.reason ?? null })),
      };
    },
    // ---------------------------------------------------------------- 执行（FR-40 启动 / FR-41 跟踪与失败）
    /** 归因门（共享断言）：任务必须归属需求条目。单执行(FR-40)与派发(FR-42)共用，防漂移。 */
    assertAttributed(ref) {
      const task = store.requireTaskRef(ref);
      if (!task.requirementId) throw new TbError("EXECUTION_NOT_ATTRIBUTED", "任务未归属需求条目：请先关联需求条目（归因门）", { taskId: task.id, identifier: task.identifier });
      return task;
    },
    /**
     * 「启动执行」的**门序列唯一来源**：人工校验门 → 归因门 → 授权/状态门。
     *
     * 真机 2026-10-22（续四十一）：`POST /api/tasks/:ref/execute` 原先**先**建宿主会话
     * （`port.createSession()` + `port.openSession()`，会把主视图切走），**之后**才在
     * `startTaskExecution` 里判这三道门 ⇒ **被拒绝的动作照样留下副作用**（多出一个空会话 +
     * 视图被切），而这条路径恰恰是用户反复踩的（可开工卡点「启动执行」被归因门/授权门拒）。
     * 修法：门序列提成这一个方法，api 层在建会话**之前**先调；`startTaskExecution` 也用它
     * （复检不算重复实现，仍只有这一份口径）。
     *
     * 顺序有意为之（FR-85b）：先判「是不是人工校验任务」再判归因门 —— 否则会先抛
     * `EXECUTION_NOT_ATTRIBUTED`，把"这是升级门"这个更根本的原因盖掉。
     */
    assertExecutable(ref) {
      const pre = store.requireTaskRef(ref);
      if (isHumanReviewTask(pre)) {
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${pre.identifier} 是人工校验任务：不得派发执行，请用人工结论入口处置`, { identifier: pre.identifier });
      }
      const task = store.assertAttributed(ref);
      if (task.status === "backlog") throw new TbError("EXECUTION_NOT_AUTHORIZED", "任务未授权开工：请先移出待办池（backlog → todo）", { taskId: task.id, identifier: task.identifier });
      if (task.status !== "todo") throw new TbError("EXECUTION_NOT_AUTHORIZED", `只有"可开工(todo)"的任务可启动执行（当前 ${task.status}）`, { taskId: task.id, status: task.status });
      return task;
    },
    startTaskExecution(ref, { sessionId = null } = {}) {
      // 门序列见 store.assertExecutable（唯一来源）；这里必须复检 —— 调用方可能跳过 api 层的预判。
      const task = store.assertExecutable(ref);
      const directive = `任务 ${task.identifier}：${task.title}\n操作指引：认领 → 执行 → 提交"待验收"；不得置"完成"（人工确认）。`;
      db.prepare("update tasks set status = 'in_progress', session_id = ?, version = version + 1, updated_at = ? where id = ?")
        .run(sessionId ?? null, nowIso(), task.id);
      // FR-77：认领即建带过期的认领锁 + 起始心跳（来源列=todo，回收时退回这里）
      const claim = store.claimTask(task.id, { sessionId, sourceStatus: "todo" });
      return { task: store.getTaskById(task.id), claim, launch: { mode: sessionId ? "session" : "degraded", sessionId: sessionId ?? null, directive } };
    },
    getTaskExecution(ref) {
      const task = store.requireTaskRef(ref);
      return {
        taskId: task.id, identifier: task.identifier, status: task.status,
        sessionId: task.sessionId ?? null, attributed: Boolean(task.requirementId),
        sessionState: store.taskSessionState(ref),
        // FR-78：失败会计可见
        consecutiveFailures: Number(task.consecutiveFailures ?? 0),
        failureLimit: task.maxRetries ?? DEFAULT_FAILURE_LIMIT,
        lastFailureError: task.lastFailureError ?? null,
        lastSuccessAt: task.lastSuccessAt ?? null,
        guard: store.dispatchGuard(task),
        // FR-80：阻断分类与复发可见
        blockKind: task.blockKind ?? null,
        blockRecurrences: task.blockRecurrences ?? 0,
        triageAt: task.triageAt ?? null,
        // FR-82：当前尝试 + 历史尝试数（"按尝试看历史"的数据源）
        currentRun: store.getCurrentRun(task),
        attempts: store.listTaskRuns(task).length,
      };
    },
    /**
     * 执行会话实时状态（宿主 `agents` 注册表）：会话是否仍在该进程内、是否 running、还有多少待消费消息。
     * 无宿主端口（沙箱/测试）时如实返回 unknown。
     */
    taskSessionState(ref) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const sessionId = task.sessionId ?? null;
      if (!sessionId) return { sessionId: null, live: false, running: false, status: null, pending: 0, known: false };
      let state = null;
      try { state = store.hostSessionPort?.sessionState?.(sessionId) ?? null; } catch { state = null; }
      return state ?? { sessionId, live: false, running: false, status: null, pending: 0, known: false };
    },
    // ---------------- 执行认领锁 + 心跳（FR-77） ----------------
    /**
     * 认领任务（CAS）：仅当**未被认领或原认领已过期**时成功；写 claim_lock/claim_expires/心跳/来源列。
     * 对齐 hermes `_claim_task_cas`：`rowcount!=1` 即"没抢到"，返回 claimed:false（不抛错）。
     */
    claimTask(ref, { sessionId = null, ttlMs = DEFAULT_CLAIM_TTL_MS, sourceStatus = null, now = null } = {}) {
      const task = store.requireTaskRef(ref);
      // FR-85b：人工校验任务是"人在环升级门"，执行侧不得认领（结论只能由人给出）
      if (isHumanReviewTask(task)) {
        try { store.recordAudit({ actor: sessionId ?? "team", action: "claim", target: task.identifier, allowed: false, reason: "human-review-not-claimable", detail: "人工校验任务执行侧不得认领" }); } catch { /* ignore */ }
        throw new TbError("HUMAN_REVIEW_NOT_CLAIMABLE", `任务 ${task.identifier} 是人工校验任务：执行侧不得认领，结论只能由人给出`, { identifier: task.identifier });
      }
      const ts = now ?? Date.now();
      const at = new Date(ts).toISOString();
      const expires = new Date(ts + ttlMs).toISOString();
      const lock = randomUUID();
      const cur = db.prepare("select claim_lock, claim_expires, status from tasks where id = ?").get(task.id);
      const held = cur?.claim_lock && cur.claim_expires && String(cur.claim_expires) > at;
      if (held) return { claimed: false, reason: "already-claimed", claim: { lock: cur.claim_lock, expiresAt: cur.claim_expires }, task: store.getTaskById(task.id) };
      const res = db.prepare(
        `update tasks set claim_lock = ?, claim_expires = ?, claim_owner = coalesce(?, claim_owner),
              claim_source = coalesce(?, claim_source), last_heartbeat_at = ?,
              session_id = coalesce(?, session_id), version = version + 1, updated_at = ?
          where id = ? and (claim_lock is null or claim_expires is null or claim_expires < ?)`,
      ).run(lock, expires, sessionId, sourceStatus, at, sessionId, at, task.id, at);
      if (res.changes !== 1) return { claimed: false, reason: "cas-lost", task: store.getTaskById(task.id) };
      // FR-82：**认领即开一条尝试记录**（授权→尝试→结论 可回看）
      const run = store.startTaskRun(task.identifier, { sessionId, claimLock: lock, actor: sessionId ?? "team", now: ts });
      store.recordTaskEvent(task.id, { type: "claimed", to: "claimed", actor: sessionId ?? "team", detail: `认领（来源 ${sourceStatus ?? cur?.status ?? "-"}）`, now: ts });
      return { claimed: true, claim: { lock, expiresAt: expires, owner: sessionId ?? null, source: sourceStatus ?? cur?.status ?? null }, run: run.started ? run.run : null, task: store.getTaskById(task.id) };
    },
    /**
     * 执行侧心跳（FR-77）：只更新 `last_heartbeat_at`（可带备注）。
     * 任务不在认领态 / 认领已过期 → 返回 false（对齐 hermes `heartbeat_worker`）。
     * **缺心跳本身不计为失败**，因此这里不碰 consecutive_failures。
     */
    heartbeatTask(ref, { lock = null, note = null, now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      const args = [at, at, task.id, at];
      let sql = "update tasks set last_heartbeat_at = ?, updated_at = ? where id = ? and claim_lock is not null and (claim_expires is null or claim_expires >= ?)";
      if (lock) { sql += " and claim_lock = ?"; args.push(lock); }
      const res = db.prepare(sql).run(...args);
      if (res.changes !== 1) return { ok: false, reason: "not-claimed-or-expired" };
      // FR-82：心跳同时计入当前尝试（heartbeats / last_heartbeat_at）
      store.heartbeatTaskRun(task.identifier, { now: now ?? Date.now() });
      if (note) { try { store.addComment(task.id, { body: `心跳：${note}` }); } catch { /* ignore */ } }
      return { ok: true, at };
    },
    /** 认领状态只读查询（FR-77）：是否被认领 / 是否过期 / 心跳年龄（秒）。 */
    taskClaimState(ref, { now = null, heartbeatGapMs = DEFAULT_HEARTBEAT_GAP_MS } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const ts = now ?? Date.now();
      const lock = task.claimLock ?? null;
      const expiresAt = task.claimExpires ?? null;
      const lastAt = task.lastHeartbeatAt ?? null;
      if (!lock) return { locked: false, expired: false, stale: false, lock: null, owner: task.claimOwner ?? null, source: task.claimSource ?? null, expiresAt: null, lastHeartbeatAt: null, heartbeatAgeSeconds: null };
      const expired = !expiresAt || String(expiresAt) < new Date(ts).toISOString();
      const hbAge = lastAt ? Math.max(0, Math.round((ts - new Date(lastAt).getTime()) / 1000)) : null;
      const stale = hbAge === null || hbAge * 1000 >= heartbeatGapMs;
      return { locked: true, expired, stale, lock, owner: task.claimOwner ?? null, source: task.claimSource ?? null, expiresAt, lastHeartbeatAt: lastAt, heartbeatAgeSeconds: hbAge };
    },
    /**
     * 回收失效认领（FR-77）：认领已过期**或**心跳陈旧 → 释放认领并把任务退回**来源列**。
     * 守卫（对齐 hermes `_defer_reclaim_for_live_worker`）：**执行侧仍存活则不释放**（避免重复派发）。
     */
    /**
     * 「投递到会话但没交作业」的**收口留痕**（FR-79 / FR-82 补口，真机续二十二）。
     *
     * 为什么需要：看板把派发指令投进项目主会话后，会话里的 agent 可能真干了活却**不回报**
     * （不提交「待验收」、不留评论）⇒ 被看护按心跳陈旧回收，看板只剩一句「认领已回收」，
     * 人看不出「成果可能已经落在工作区」，于是**工作成果与看板状态脱钩**。
     *
     * 判定唯一来源＝`core/delivery.mjs` 的 `detectUntakenDelivery()`（纯函数，FR-79 诊断同用一份，
     * 防两份口径漂移）；本方法只负责**落痕**：一条带 `【投递未收尾】` 前缀的评论 + 一条事件。
     * 措辞不许在这里重写一遍 —— 诊断里的文案由 diagnostics 侧从同一个 hit 产出。
     *
     * 调用时机（两处收口共用）：`reclaimStaleClaim()`（回收）与 `reconcileOrphanRuns()`（超时）。
     * **必须在写「认领已回收」那条留痕之前调用**：虽然该文案已列入系统留痕，但"先判后写"更不容易被
     * 后续改动破坏顺序（`delivery.mjs` 的系统留痕清单是第二道保险）。
     */
    noteUntakenDelivery(ref, { now = null } = {}) {
      const task = store.requireTaskRef(ref);
      let hit = null;
      try {
        // 注意：`listComments()` 只接受 ref（内部直接走 requireTaskRef），传对象会抛 TASK_NOT_FOUND ——
        // 而这里外面包着 try/catch（故意不阻断收口）⇒ 传错就**静默永不命中**（本轮实测踩到过）。统一传 identifier。
        hit = detectUntakenDelivery({ task, runs: store.listTaskRuns(task.identifier), comments: store.listComments(task.identifier) });
      } catch { hit = null; }
      if (!hit) return null;
      const sid = String(hit.run.sessionId ?? "");
      const body = `${UNTAKEN_COMMENT_MARKER}第 ${hit.run.attempt} 次尝试是**投递给执行会话**${sid ? ` ${sid.slice(0, 18)}…` : ""} 的，`
        + `但会话里没有交作业（没提交「待验收」，且该次开始后没有任何评论）⇒ 已按「${hit.reason}」收口。\n`
        + `⚠ 工作区可能已有未提交的改动：请先人工核对（打开执行会话看现场，或直接看工作目录 diff），再决定重派还是作废。`;
      try { store.addComment(task.id, { body }); } catch { /* ignore */ }
      try {
        store.recordTaskEvent(task.id, {
          type: "delivery_untaken", actor: "watchdog", to: task.status,
          detail: `投递到会话后未收尾：第 ${hit.run.attempt} 次尝试 ${hit.reason}${sid ? `（session ${sid.slice(0, 18)}…）` : ""}`,
          now: now ?? Date.now(),
        });
      } catch { /* ignore */ }
      return { run: hit.run, reason: hit.reason };
    },
    reclaimStaleClaim(ref, { now = null, heartbeatGapMs = DEFAULT_HEARTBEAT_GAP_MS, sessionState = undefined } = {}) {
      const task = store.requireTaskRef(ref);
      const state = store.taskClaimState(task, { now, heartbeatGapMs });
      if (!state.locked) return { reclaimed: false, reason: "not-claimed" };
      // 对齐 hermes `detect_stale_running`：**过期 且 心跳陈旧**才算失效——
      // 心跳新鲜即视为"执行侧仍在推进"，即便认领时间已过也先不回收。
      if (!(state.expired && state.stale)) return { reclaimed: false, reason: state.expired ? "heartbeat-fresh" : "claim-fresh" };
      // 执行侧仍活跃 → 暂不回收（下一次检查再试）
      const live = sessionState === undefined ? store.taskSessionState(task) : sessionState;
      if (live?.running) return { reclaimed: false, reason: "worker-alive", claim: state };
      const at = new Date(now ?? Date.now()).toISOString();
      const target = state.source && TEAM_WRITABLE_STATUSES.includes(state.source) ? state.source : (state.source || "todo");
      // FR-82：回收失效认领 = 本次尝试以「被回收」收场
      store.endTaskRun(task.identifier, { outcome: "reclaimed", summary: state.expired ? "认领过期被回收" : "心跳陈旧被回收", actor: "watchdog", now: now ?? Date.now() });
      db.prepare(
        "update tasks set status = ?, claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null, version = version + 1, updated_at = ? where id = ? and claim_lock = ?",
      ).run(target, at, task.id, state.lock);
      try { db.prepare("update team_tasks set status = 'cancelled', updated_at = ? where task_id = ? and status in ('open','running')").run(at, task.id); } catch { /* ignore */ }
      // FR-79/82 补口：这次收口若是「投递到会话但没交作业」，补一条可见留痕（判定只看 delivery.mjs）。
      // 必须排在下面那条「认领已回收」之前：先据事实判定，再写系统留痕。
      const untaken = (() => { try { return store.noteUntakenDelivery(task.identifier, { now: now ?? Date.now() }); } catch { return null; } })();
      try { store.addComment(task.id, { body: `认领已回收（${state.expired ? "认领过期" : "心跳陈旧"}${state.heartbeatAgeSeconds === null ? "" : `，心跳 ${state.heartbeatAgeSeconds}s 前`}）→ 退回「${target}」` }); } catch { /* ignore */ }
      try { store.recordAudit({ actor: "watchdog", action: "reclaim", target: task.identifier, allowed: true, reason: state.expired ? "claim-expired" : "heartbeat-stale" }); } catch { /* ignore */ }
      return { reclaimed: true, status: target, claim: state, untaken: untaken ? { attempt: untaken.run.attempt, reason: untaken.reason } : null };
    },
    /** 批量回收（看护/定时器用）：返回被回收的任务引用清单。 */
    reclaimStaleClaims({ projectId = undefined, now = null, heartbeatGapMs = DEFAULT_HEARTBEAT_GAP_MS } = {}) {
      const candidates = db.prepare("select identifier from tasks where claim_lock is not null and status = 'in_progress'").all().map((r) => r.identifier);
      const reclaimed = [];
      for (const ref of candidates) {
        const task = store.requireTaskRef(ref);
        if (projectId && task.projectId !== projectId) continue;
        const r = store.reclaimStaleClaim(ref, { now, heartbeatGapMs });
        if (r.reclaimed) reclaimed.push({ identifier: ref, status: r.status });
      }
      return reclaimed;
    },
    // ---------------- 失败会计与熔断（FR-78） ----------------
    /**
     * 记录一次**非成功**（派发失败 / 超时 / 崩溃 / 团队回报失败）。
     * 所有非成功路径都必须走这里，保证 `consecutive_failures` 一致；**成功才清零**。
     * 阈值优先级照抄 hermes：`tasks.max_retries` > 调用方 `limit` > `DEFAULT_FAILURE_LIMIT`。
     * 配额/鉴权类错误**立即熔断**（重试不会让配额回来）。
     * 返回 `{tripped, failures, effectiveLimit, limitSource, quota}`。
     */
    recordTaskFailure(ref, { error = "", outcome = "failed", limit = null, now = null, releaseClaim = true } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      const msg = String(error ?? "").slice(0, 500);
      const failures = Number(task.consecutiveFailures ?? 0) + 1;
      const override = task.maxRetries ?? null;
      const effectiveLimit = override != null ? Number(override) : (limit != null ? Number(limit) : DEFAULT_FAILURE_LIMIT);
      const limitSource = override != null ? "task" : (limit != null ? "caller" : "default");
      const quota = QUOTA_AUTH_ERROR_RE.test(msg);
      const tripped = quota || failures >= effectiveLimit;
      if (tripped) {
        // 熔断：先记计数与原因，再走 FR-80 的统一受阻入口（配额类 → capability，其它 → transient）
        db.prepare("update tasks set consecutive_failures = ?, last_failure_error = ?, version = version + 1, updated_at = ? where id = ?").run(failures, msg, at, task.id);
        try { db.prepare("update team_tasks set status = 'failed', updated_at = ? where task_id = ? and status in ('open','running')").run(at, task.id); } catch { /* ignore */ }
        // FR-82：先按**失败口径**闭合尝试（blockTask 之后还会补一条"受阻"事件）
        store.endTaskRun(task.identifier, { outcome, summary: msg, error: msg, actor: "watchdog", now: now ?? Date.now() });
        store.blockTask(task.identifier, { kind: quota ? "capability" : "transient", reason: msg, actor: "watchdog", now: now ?? Date.now() });
        try {
          store.addComment(task.id, {
            body: `执行失败已熔断（第 ${failures} 次，阈值 ${effectiveLimit}${limitSource === "task" ? " · 任务级" : ""}${quota ? " · 配额/鉴权类，不重试" : ""}）→ 置「受阻」并停止自动重试。${msg ? `\n原因：${msg}` : ""}`,
          });
        } catch { /* ignore */ }
        try { store.recordAudit({ actor: "watchdog", action: "gave-up", target: task.identifier, allowed: false, reason: quota ? "quota-or-auth" : "failure-limit", detail: `failures=${failures}/${effectiveLimit}` }); } catch { /* ignore */ }
      } else {
        db.prepare(
          `update tasks set consecutive_failures = ?, last_failure_error = ?${releaseClaim ? ", claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null" : ""}, version = version + 1, updated_at = ? where id = ?`,
        ).run(failures, msg, at, task.id);
        try { db.prepare("update team_tasks set status = 'failed', updated_at = ? where task_id = ? and status in ('open','running')").run(at, task.id); } catch { /* ignore */ }
        // FR-82：非熔断的失败同样要闭合尝试（照实记 outcome，供"按尝试看历史"用）
        store.endTaskRun(task.identifier, { outcome, summary: msg, error: msg, actor: "watchdog", now: now ?? Date.now() });
      }
      store.recordTaskEvent(task.id, { type: "failure_recorded", to: quota ? "capability" : "transient", actor: "watchdog", detail: `第 ${failures}/${effectiveLimit} 次非成功：${msg || "(无原因)"}`, now: now ?? Date.now() });
      return { tripped, failures, effectiveLimit, limitSource, quota, task: store.getTaskById(task.id) };
    },
    /** 成功即清零（FR-78）；成功 = 产出已提交待验收（含团队回报完成）。 */
    markTaskSucceeded(ref, { now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      // FR-80：复发计数/阻断类型/人工兜底标记**只在成功时清零**
      db.prepare("update tasks set consecutive_failures = 0, last_failure_error = null, last_success_at = ?, block_kind = null, block_recurrences = 0, triage_at = null, blocked_at = null, version = version + 1, updated_at = ? where id = ?").run(at, at, task.id);
      try {
        const labels = (store.getTaskById(task.id).labels || []).filter((l) => l !== TRIAGE_LABEL);
        db.prepare("update tasks set labels = ? where id = ?").run(JSON.stringify(labels), task.id);
      } catch { /* ignore */ }
      // FR-82：成功 = 本次尝试的终态；事件流追加（"完成"仍需人确认，这一步只记成功会计）
      store.endTaskRun(task.identifier, { outcome: "success", summary: "按成功完成记账（失败计数清零）", actor: "system", now: now ?? Date.now() });
      return store.getTaskById(task.id);
    },
    /**
     * FR-80：**置"受阻"的唯一入口**（带类型 + 复发升级）。
     * `dependency` 走"回到待执行等父任务"；其它类型进入受阻，同因复发达阈值 → 人工兜底。
     */
    blockTask(ref, { kind = null, reason = null, actor = "system", now = null, route: routeMode = "wait" } = {}) {
      const task = store.requireTaskRef(ref);
      if (kind !== null && !BLOCK_KINDS.includes(kind)) throw invalidField("kind", `阻断类型必须是 ${BLOCK_KINDS.join(" / ")} 之一，或 null`);
      if (!BLOCK_ROUTES.includes(routeMode)) throw invalidField("route", `route 必须是 ${BLOCK_ROUTES.join(" / ")} 之一`);
      const at = new Date(now ?? Date.now()).toISOString();
      const route = routeBlock({ kind, reason, prevKind: task.blockKind ?? null, prevRecurrences: task.blockRecurrences ?? 0 });
      // FR-83 红线③：评审门走 `hold` —— 依赖未就绪但**必须保持受阻**（等上游整改 + 评审通过），
      // 不能按 FR-80 的默认 `wait` 回落到"可开工"，否则下游会被执行循环直接派发。
      if (routeMode === "hold") route.status = "blocked";
      const triageAt = route.triage ? at : null;
      db.prepare(
        `update tasks set status = ?, block_kind = ?, block_recurrences = ?, triage_at = ?, blocked_at = ?,
              claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null,
              version = version + 1, updated_at = ? where id = ?`,
      ).run(route.status, kind, route.recurrences, triageAt,
        // FR-79：首次受阻时间保留（"卡在受阻 N 分钟"从第一次受阻算起）；dependency 回待执行 → 清空
        route.status === "blocked" ? (task.blockedAt ?? at) : null, at, task.id);
      if (route.triage) {
        try {
          const labels = store.getTaskById(task.id).labels || [];
          if (!labels.includes(TRIAGE_LABEL)) db.prepare("update tasks set labels = ? where id = ?").run(JSON.stringify([...labels, TRIAGE_LABEL]), task.id);
        } catch { /* ignore */ }
      }
      const kindLabel = kind ? `类型=${kind}` : "类型=未分类";
      const body = route.triage
        ? `阻断循环检测：同因重复阻断 ${route.recurrences} 次（阈值 ${BLOCK_RECURRENCE_LIMIT}）→ 已转「人工兜底」。${kindLabel}${reason ? `\n原因：${reason}` : ""}`
        : route.eventKind === "dependency_wait"
        ? `依赖未就绪 → 回到「可开工」等待父任务完成（不进人工受阻队列）。${reason ? `\n原因：${reason}` : ""}`
        : `已置「受阻」。${kindLabel}${route.recurrences > 1 ? `（同因第 ${route.recurrences} 次）` : ""}${reason ? `\n原因：${reason}` : ""}`;
      try { store.addComment(task.id, { body }); } catch { /* ignore */ }
      try { store.recordAudit({ actor, action: route.triage ? "triage" : "block", target: task.identifier, allowed: route.triage, reason: route.eventKind, detail: `${kindLabel} recurrences=${route.recurrences}` }); } catch { /* ignore */ }
      // FR-82：本次尝试以「受阻」收场 + 事件流留痕（诊断/通知据此判断终态）
      store.endTaskRun(task.identifier, { outcome: "blocked", summary: reason ?? kindLabel, actor, now: at ? new Date(at).getTime() : null });
      store.recordTaskEvent(task.id, { type: "blocked", to: route.status, actor, detail: `${kindLabel} recurrences=${route.recurrences}${route.triage ? "（人工兜底）" : ""}`, now: at ? new Date(at).getTime() : null });
      return { task: store.getTaskById(task.id), route: { ...route, kind } };
    },
    /** 人工显式重跑：清计数 + 记 `requeued_at`（用于放宽"近期成功窗口"）。 */
    resetTaskFailures(ref, { now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      db.prepare("update tasks set consecutive_failures = 0, last_failure_error = null, requeued_at = ?, version = version + 1, updated_at = ? where id = ?").run(at, at, task.id);
      return store.getTaskById(task.id);
    },
    /**
     * 派发前置守卫（FR-78）：返回 null（可派发）或原因字符串。
     * - `circuit-open`：连续失败已达阈值（不自动重试）
     * - `quota-blocked`：上次失败是配额/鉴权类（不重试）
     * - `recent-success`：窗口内已成功且之后无人工重跑（防抖动/防重复产出）
     */
    dispatchGuard(ref, { limit = null, successWindowMs = DEFAULT_SUCCESS_WINDOW_MS, now = null } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const ts = now ?? Date.now();
      const override = task.maxRetries ?? null;
      const effectiveLimit = override != null ? Number(override) : (limit != null ? Number(limit) : DEFAULT_FAILURE_LIMIT);
      const failures = Number(task.consecutiveFailures ?? 0);
      // 配额/鉴权类优先（照抄 hermes：重试不会让配额回来，与计数无关）
      if (QUOTA_AUTH_ERROR_RE.test(String(task.lastFailureError ?? ""))) return "quota-blocked";
      if (failures >= effectiveLimit) return "circuit-open";
      if (task.lastSuccessAt) {
        const okAt = new Date(task.lastSuccessAt).getTime();
        const requeuedAt = task.requeuedAt ? new Date(task.requeuedAt).getTime() : 0;
        // 同毫秒视为"人工重跑优先"（重跑发生在成功之后），避免同 ms 竞态误判
        if (Number.isFinite(okAt) && ts - okAt < successWindowMs && requeuedAt < okAt) return "recent-success";
      }
      return null;
    },
    recordTaskExecutionFailure(ref, { evidence = "", kind = "transient", error = null, count = true } = {}) {
      const task = store.requireTaskRef(ref);
      const at = nowIso();
      // 「结构字段里的原因」优先取 `error`（执行器传 stderr/stdout 尾段），没有才退回 `evidence`。
      const msg = String(error ?? evidence ?? "").slice(0, 500);
      if (evidence) store.addComment(task.id, { body: `执行失败：${evidence}` });
      // FR-82：人工标记失败 = 本次尝试以失败收场（再走 FR-80 的统一受阻入口）
      store.endTaskRun(task.identifier, { outcome: "failed", summary: evidence || "人工标记失败", error: msg || null, actor: "human" });
      // FR-78 记账（2026-10-26 修 · 运行期发现）：本入口此前**不写** `consecutive_failures` / `last_failure_error`，
      // 而 **CLI 执行器真跑失败走的正是这里**（`executor.mjs#executeTaskWithCli` 的失败分支）⇒ 三个下游同时瞎：
      //   ① 熔断诊断（`diagnostics.mjs` 连续失败 / 配额类）读不到数；
      //   ② `dispatchGuard` 的 `quota-blocked` 分支永不触发（`last_failure_error` 恒空）；
      //   ③ 用户可见的受阻原因（`api.mjs` 读 `task.lastFailureError`）为空 —— 卡「受阻」却不写为什么。
      // 上游注释（`recordTaskFailure` 头）早已声明「所有非成功路径都必须走这里保证计数一致」⇒ 本入口是漏网路径。
      if (count) {
        db.prepare("update tasks set consecutive_failures = consecutive_failures + 1, last_failure_error = ?, version = version + 1, updated_at = ? where id = ?")
          .run(msg, at, task.id);
        store.recordTaskEvent(task.id, { type: "failure_recorded", to: kind, actor: "executor", detail: msg || "(无原因)", now: Date.now() });
      }
      // FR-80：人工「标记失败」也走统一受阻入口（默认 transient；复发同样会升级到人工兜底）
      const r = store.blockTask(task.identifier, { kind, reason: evidence || msg || "人工标记失败", actor: "human" });
      // 释放该任务的活跃团队锁（否则一直锁着，循环永久跳过；重试才可再派发）
      db.prepare("update team_tasks set status = 'failed', updated_at = ? where task_id = ? and status in ('open','running')").run(nowIso(), task.id);
      return r.task;
    },
    submitTaskForReview(ref, { comment = "" } = {}) {
      // FR-83：提交待验收 = 请求评审（从这里进评审一等流程）
      return store.requestReview(ref, { comment, actor: "team" }).task;
    },
    // ---------------- 评审流程（FR-83） ----------------
    /**
     * 请求评审（FR-83 的一等流程）：进「待验收」+ **指派评审者** + 记下**来源列**（返工退回哪一列）。
     * 释放实现认领（FR-77）；执行成功照 FR-78 记账；事件流写 `review_requested`。
     */
    requestReview(ref, { reviewer = null, dependsOn = null, comment = "", actor = "team", now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      // 来源列：第一次提交时记下当前列；返工后重提则**沿用**上次来源列（保证返工总回同一实现列）
      const source = task.status === "in_review"
        ? (task.reviewSourceStatus ?? "in_progress")
        : (REVIEW_SOURCE_STATUSES.includes(task.status) ? task.status : "in_progress");
      db.prepare(
        `update tasks set status = 'in_review', review_state = 'pending', reviewer = coalesce(?, reviewer),
              review_requested_at = ?, review_source_status = ?,
              review_depends_on = case when ? is null then review_depends_on else ? end,
              claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null,
              version = version + 1, updated_at = ? where id = ?`,
      ).run(reviewer, at, source, dependsOn, dependsOn, at, task.id);
      if (comment) store.addComment(task.id, { body: comment });
      store.markTaskSucceeded(task.identifier); // FR-78：产出已提交待验收 = 本次执行成功
      store.recordTaskEvent(task.id, { type: "status_changed", from: task.status, to: "in_review", actor });
      store.recordTaskEvent(task.id, { type: "review_requested", to: "in_review", actor, detail: `${reviewer ? `指派评审者 ${reviewer}` : "未指派评审者"}·来源列 ${source}${comment ? `｜${comment}` : ""}` });
      const next = store.getTaskById(task.id);
      if (!reviewer) {
        try { store.addComment(task.id, { body: `待评审（未指派评审者）：${REVIEW_IDLE_MS / 60000} 分钟无人处理将产出「评审死锁」诊断。` }); } catch { /* ignore */ }
      }
      return { task: next, review: { state: next.reviewState, reviewer: next.reviewer, sourceStatus: source, round: next.reviewRound }, deadlock: detectReviewDeadlock(store, next) };
    },
    /**
     * 请求返工（FR-83）：**退回来源列**（不得退成"实现"以外的错列）+ 返工说明 + 轮次 +1。
     * 释放认领让执行侧重新接手；事件流写 `changes_requested`。
     */
    requestChanges(ref, { comment = "", actor = "reviewer", now = null } = {}) {
      const task = store.requireTaskRef(ref);
      if (task.status !== "in_review") {
        throw new TbError("REVIEW_NOT_PENDING", `任务不在「待验收」，无法请求返工（当前 ${task.status}）`, { identifier: task.identifier, status: task.status });
      }
      const at = new Date(now ?? Date.now()).toISOString();
      const target = reviewReturnStatus(task.reviewSourceStatus);
      const round = Number(task.reviewRound ?? 0) + 1;
      db.prepare(
        `update tasks set status = ?, review_state = 'changes_requested', review_round = ?,
              review_requested_at = null, claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null,
              version = version + 1, updated_at = ? where id = ?`,
      ).run(target, round, at, task.id);
      store.recordTaskEvent(task.id, { type: "status_changed", from: "in_review", to: target, actor });
      store.recordTaskEvent(task.id, { type: "changes_requested", from: "in_review", to: target, actor, detail: `第 ${round} 轮返工${comment ? `｜${comment}` : ""}` });
      store.addComment(task.id, {
        body: `评审未通过 → **退回「${target}」**并请求返工（第 ${round} 轮）。${comment ? `\n返工说明：${comment}` : ""}\n（返工只回来源列；下游仍保持受阻，等评审通过才解锁）`,
      });
      try { store.recordAudit({ actor, action: "review-changes", target: task.identifier, allowed: true, reason: "review-not-passed", detail: `round=${round} → ${target}` }); } catch { /* ignore */ }
      return { task: store.getTaskById(task.id), returnedTo: target, round };
    },
    /**
     * 评审通过（FR-83）：只记"评审态=通过"，**保持「待验收」**——红线：完成只能人确认，评审通过不自动置 done。
     */
    approveReview(ref, { comment = "", actor = "reviewer", now = null } = {}) {
      const task = store.requireTaskRef(ref);
      if (task.status !== "in_review") {
        throw new TbError("REVIEW_NOT_PENDING", `任务不在「待验收」，无法评审通过（当前 ${task.status}）`, { identifier: task.identifier, status: task.status });
      }
      const at = new Date(now ?? Date.now()).toISOString();
      const round = Number(task.reviewRound ?? 0);
      db.prepare("update tasks set review_state = 'approved', review_requested_at = null, version = version + 1, updated_at = ? where id = ?").run(at, task.id);
      store.recordTaskEvent(task.id, { type: "review_approved", to: "approved", actor, detail: `评审通过（第 ${round} 轮）${comment ? `｜${comment}` : ""}` });
      store.addComment(task.id, { body: `评审通过（第 ${round} 轮）。${comment ? `\n结论：${comment}\n` : ""}**仍需人工确认后置「完成」**（红线：完成只能人确认，执行侧与评审侧都不得置 done）。` });
      try { store.recordAudit({ actor, action: "review-approved", target: task.identifier, allowed: true, reason: "review-passed", detail: `round=${round}` }); } catch { /* ignore */ }
      return { task: store.getTaskById(task.id), needsHumanConfirmation: true, round };
    },
    /** 评审队列（FR-83）：默认列出全部「待验收」任务；可按 review_state 过滤。 */
    listReviews(projectId, { state = null } = {}) {
      const tasks = store.listTasks({ projectId, status: "in_review" });
      return tasks
        .filter((t) => (state ? (t.reviewState ?? "pending") === state : true))
        .map((t) => ({ ...t, deadlock: detectReviewDeadlock(store, t) }))
        .sort((a, b) => String(a.reviewRequestedAt ?? a.updatedAt).localeCompare(String(b.reviewRequestedAt ?? b.updatedAt)));
    },
    retryTaskExecution(ref) {
      const task = store.requireTaskRef(ref);
      // 保留 session_id：派发前要据此判断"原执行会话是否仍在执行"（防重复下发）。
      // 需要显式解绑请用 releaseTaskAssignment（释放归属）。
      // FR-78：人工显式重跑 → 记 `requeued_at`（放宽"近期成功窗口"）并清零失败计数。
      // FR-80：人工介入 → 撤下「人工兜底」标记（人已看过），但**复发计数绝不清零**——
      // 清零正是 hermes 注释警告的"失忆"，会让"阻断→重跑→再阻断"无限循环且永远不升级。
      db.prepare("update tasks set status = 'todo', claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null, consecutive_failures = 0, last_failure_error = null, requeued_at = ?, triage_at = null, blocked_at = null, version = version + 1, updated_at = ? where id = ?").run(nowIso(), nowIso(), task.id);
      // FR-82：人工重跑 = 上一次尝试作废（若还挂着），并追加事件
      store.endTaskRun(task.identifier, { outcome: "cancelled", summary: "人工退回待办（重新派发）", actor: "human" });
      store.recordTaskEvent(task.id, { type: "requeued", from: task.status, to: "todo", actor: "human", detail: "人工退回待办（重新派发）" });
      try {
        const labels = (store.getTaskById(task.id).labels || []).filter((l) => l !== TRIAGE_LABEL);
        db.prepare("update tasks set labels = ? where id = ?").run(JSON.stringify(labels), task.id);
      } catch { /* ignore */ }
      // 释放该任务的活跃团队锁（否则"退回待办"后循环仍会因任务级锁跳过，永远不再派发）
      db.prepare("update team_tasks set status = 'cancelled', updated_at = ? where task_id = ? and status in ('open','running')").run(nowIso(), task.id);
      return store.getTaskById(task.id);
    },
    releaseTaskAssignment(ref) {
      const task = store.requireTaskRef(ref);
      db.prepare("update tasks set session_id = null, claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null, version = version + 1, updated_at = ? where id = ?").run(nowIso(), task.id);
      // FR-82：释放归属 = 尝试终止（避免留下永远 running 的孤儿尝试）
      store.endTaskRun(task.identifier, { outcome: "released", summary: "人工释放归属", actor: "human" });
      store.recordTaskEvent(task.id, { type: "released", actor: "human", detail: "释放执行归属" });
      return store.getTaskById(task.id);
    },
    // ---------------- 可操作诊断（FR-79） ----------------
    /**
     * 落库一批诊断（**诊断的唯一写入口**，规则在 `src/core/diagnostics.mjs`）：
     * - 同一 `(task, kind)` 只留一行：问题仍在 → `count + 1` / `last_seen_at` 前进（不重复刷屏）；
     *   曾经消解过又重新出现 → 计数重开（`count = 1`，`first_seen_at` 重置）
     * - 本次**未产出**的活跃行 → 写 `resolved_at`（问题消失即**自动消解**）
     * `minGapMs`（默认 60s）：看板轮询会反复评估同一问题，此窗口内的重复评估**只刷新文案、不再加计数**
     * —— 让 `count` 表示"问题出现的次数（分钟粒度合并）"，而不是"被轮询了几次"。
     * 返回 `{ active, resolved }`（active 已按严重度排序）。
     */
    saveTaskDiagnostics(ref, diagnostics = [], { now = null, minGapMs = 60 * 1000 } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const ts = now ?? Date.now();
      const at = new Date(ts).toISOString();
      const existing = db.prepare("select * from task_diagnostics where task_id = ?").all(task.id).map(rowToDiagnostic);
      const byKind = new Map(existing.map((d) => [d.kind, d]));
      const upsert = db.prepare(
        `update task_diagnostics set severity = ?, title = ?, detail = ?, suggested = ?, actions = ?,
              count = ?, first_seen_at = ?, last_seen_at = ?, resolved_at = null, version = version + 1 where id = ?`,
      );
      const insert = db.prepare(
        `insert into task_diagnostics (id, task_id, kind, severity, title, detail, suggested, actions, count, first_seen_at, last_seen_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const active = [];
      for (const d of diagnostics) {
        if (!d?.kind) continue;
        const prev = byKind.get(d.kind);
        const stillActive = Boolean(prev && !prev.resolvedAt);
        const tooSoon = stillActive && (ts - new Date(prev.lastSeenAt).getTime()) < minGapMs;
        const count = stillActive ? (tooSoon ? prev.count : prev.count + 1) : 1;
        const firstSeenAt = stillActive ? prev.firstSeenAt : at;
        const lastSeenAt = tooSoon ? prev.lastSeenAt : at;
        const actions = JSON.stringify(d.actions ?? []);
        // 同一分钟内、内容也没变的重复评估 → 不写库（避免轮询制造无意义写入与版本号膨胀）
        if (prev && tooSoon && prev.severity === d.severity && prev.title === d.title && prev.detail === (d.detail ?? "") && JSON.stringify(prev.actions) === actions) {
          active.push({ ...d, taskId: task.id, taskIdentifier: task.identifier, taskTitle: task.title, count, firstSeenAt, lastSeenAt, resolvedAt: null });
          continue;
        }
        if (prev) upsert.run(d.severity, d.title, d.detail ?? "", d.suggested ?? null, actions, count, firstSeenAt, lastSeenAt, prev.id);
        else insert.run(randomUUID(), task.id, d.kind, d.severity, d.title, d.detail ?? "", d.suggested ?? null, actions, count, firstSeenAt, lastSeenAt);
        active.push({ ...d, taskId: task.id, taskIdentifier: task.identifier, taskTitle: task.title, count, firstSeenAt, lastSeenAt, resolvedAt: null });
      }
      const activeKinds = new Set(active.map((d) => d.kind));
      const resolved = [];
      const resolveSql = db.prepare("update task_diagnostics set resolved_at = ?, last_seen_at = ?, version = version + 1 where id = ?");
      for (const d of existing) {
        if (activeKinds.has(d.kind) || d.resolvedAt) continue;
        resolveSql.run(at, at, d.id);
        resolved.push({ kind: d.kind, resolvedAt: at, count: d.count });
      }
      const rank = { high: 3, medium: 2, low: 1 };
      active.sort((a, b) => (rank[b.severity] - rank[a.severity]) || a.kind.localeCompare(b.kind));
      return { active, resolved };
    },
    /** 读诊断（默认只读活跃项；`includeResolved` 带历史，供详情回溯）。 */
    listTaskDiagnostics(ref, { includeResolved = false } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const rows = db.prepare("select * from task_diagnostics where task_id = ? order by rowid").all(task.id).map(rowToDiagnostic);
      const list = includeResolved ? rows : rows.filter((d) => !d.resolvedAt);
      const rank = { high: 3, medium: 2, low: 1 };
      return list
        .map((d) => ({ ...d, taskIdentifier: task.identifier, taskTitle: task.title }))
        .sort((a, b) => (rank[b.severity] - rank[a.severity]) || a.kind.localeCompare(b.kind));
    },
    /**
     * 人工忽略一条诊断（FR-79 / FR-76）：写**忽略留痕评论**（原文可回溯）+ 标记 `resolved_at`/`dismissed_at`。
     * 规则侧据此停止产出（见 `diagnostics.dismissedKinds`），直到出现**更新的进展评论**。
     */
    dismissTaskDiagnostic(ref, kind, { actor = "human", note = null, now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      const row = db.prepare("select * from task_diagnostics where task_id = ? and kind = ?").get(task.id, String(kind));
      const body = `已忽略诊断「${kind}」：${row?.title ?? "（无记录）"}（人工决策${note ? `：${note}` : ""}）`;
      store.addComment(task.id, { body });
      if (row) db.prepare("update task_diagnostics set resolved_at = ?, dismissed_at = ?, version = version + 1 where id = ?").run(at, at, row.id);
      try { store.recordAudit({ actor, action: "diagnostic-dismiss", target: task.identifier, allowed: true, reason: String(kind) }); } catch { /* ignore */ }
      return { dismissed: true, kind: String(kind), identifier: task.identifier, hadRecord: Boolean(row) };
    },
    // ---------------- 尝试记录与事件流（FR-82） ----------------
    /** 全库单调事件游标（**FR-81 的推送游标**就是它；独立计数表，任务删除也不回收已发号）。 */
    nextEventCursor() {
      db.prepare("insert into event_cursor (id, value) values (1, 1) on conflict(id) do update set value = value + 1").run();
      return Number(db.prepare("select value from event_cursor where id = 1").get()?.value ?? 0);
    },
    /**
     * 追加一条任务事件（**追加式**，供看护 / 通知 / 详情共同消费——不各自造数）。
     * 事件写失败不阻断主流程（返回 null），保证生命周期方法不被可观测性拖垮。
     */
    recordTaskEvent(ref, { type, from = null, to = null, actor = "system", detail = null, now = null } = {}) {
      try {
        if (!type) return null;
        const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
        const at = new Date(now ?? Date.now()).toISOString();
        const seq = Number(db.prepare("select coalesce(max(seq), 0) + 1 as n from task_events where task_id = ?").get(task.id)?.n ?? 1);
        const cursor = store.nextEventCursor();
        db.prepare(
          `insert into task_events (id, task_id, cursor, seq, type, from_value, to_value, actor, detail, at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(randomUUID(), task.id, cursor, seq, String(type), from, to, actor, detail, at);
        return { cursor, seq, type: String(type), at };
      } catch { return null; }
    },
    /** 读任务事件流（`since` = 已见到的 cursor，返回 **cursor 更大**的增量；FR-81 直接复用）。 */
    listTaskEvents(ref, { since = 0, limit = 200, order = "asc" } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const dir = String(order).toLowerCase() === "desc" ? "desc" : "asc";
      return db.prepare(`select * from task_events where task_id = ? and cursor > ? order by cursor ${dir} limit ?`)
        .all(task.id, Number(since) || 0, Math.max(1, Number(limit) || 200)).map(rowToTaskEvent);
    },
    /** 读项目事件流（跨任务按全库游标排序；FR-81 订阅推送的数据源）。 */
    listProjectEvents(projectId, { since = 0, limit = 200, order = "asc" } = {}) {
      const project = store.getProject(projectId) ?? store.requireProject(projectId);
      const dir = String(order).toLowerCase() === "desc" ? "desc" : "asc";
      return db.prepare(
        `select e.* from task_events e join tasks t on t.id = e.task_id
          where t.project_id = ? and e.cursor > ? order by e.cursor ${dir} limit ?`,
      ).all(project.id, Number(since) || 0, Math.max(1, Number(limit) || 200)).map(rowToTaskEvent);
    },
    /** 全部尝试记录（按第几次尝试升序）。 */
    listTaskRuns(ref) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      return db.prepare("select * from task_runs where task_id = ? order by attempt, rowid").all(task.id).map(rowToRun);
    },
    getTaskRun(runId) {
      return rowToRun(db.prepare("select * from task_runs where id = ?").get(String(runId)));
    },
    /** 进行中的尝试（任务指针优先，兜底查最新 running 行）。 */
    getCurrentRun(ref) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      if (task.currentRunId) {
        const row = db.prepare("select * from task_runs where id = ? and status = 'running'").get(task.currentRunId);
        if (row) return rowToRun(row);
      }
      return rowToRun(db.prepare("select * from task_runs where task_id = ? and status = 'running' order by attempt desc limit 1").get(task.id));
    },
    /**
     * 开一条尝试记录（FR-82）：**认领执行即自动开**（`claimTask` 已接线），也可显式调用。
     * 已在跑则返回 `{started:false}`（幂等，不产生重复尝试）。
     */
    startTaskRun(ref, { sessionId = null, claimLock = null, maxMs = DEFAULT_RUN_MAX_MS, actor = "system", now = null } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      // FR-85b：人工校验任务不产生"尝试"（它不是可执行工作）
      if (isHumanReviewTask(task)) {
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${task.identifier} 是人工校验任务：不得开启执行尝试`, { identifier: task.identifier });
      }
      const existing = store.getCurrentRun(task);
      if (existing) return { started: false, reason: "already-running", run: existing };
      const at = new Date(now ?? Date.now()).toISOString();
      const attempt = Number(db.prepare("select coalesce(max(attempt), 0) + 1 as n from task_runs where task_id = ?").get(task.id)?.n ?? 1);
      const id = randomUUID();
      db.prepare(
        `insert into task_runs (id, task_id, attempt, status, claim_lock, session_id, actor, started_at, heartbeats, last_heartbeat_at, max_ms, created_at, updated_at)
         values (?, ?, ?, 'running', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).run(id, task.id, attempt, claimLock, sessionId, actor, at, at, maxMs == null ? null : Number(maxMs), at, at);
      db.prepare("update tasks set current_run_id = ?, version = version + 1, updated_at = ? where id = ?").run(id, at, task.id);
      store.recordTaskEvent(task.id, { type: "run_started", actor, to: "running", detail: `第 ${attempt} 次尝试开始`, now });
      return { started: true, run: rowToRun(db.prepare("select * from task_runs where id = ?").get(id)) };
    },
    /** 尝试心跳（FR-82 的 heartbeats 计数；与 FR-77 的认领心跳同源，缺心跳本身不算失败）。 */
    heartbeatTaskRun(ref, { now = null, maxMs = null } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const run = store.getCurrentRun(task);
      if (!run) return { ok: false, reason: "no-running-run" };
      const at = new Date(now ?? Date.now()).toISOString();
      db.prepare("update task_runs set heartbeats = heartbeats + 1, last_heartbeat_at = ?, updated_at = ? where id = ? and status = 'running'").run(at, at, run.id);
      if (maxMs != null) db.prepare("update task_runs set max_ms = ? where id = ?").run(Number(maxMs), run.id);
      store.recordTaskEvent(task.id, { type: "heartbeat", to: "running", detail: `第 ${run.attempt} 次尝试心跳`, now });
      return { ok: true, runId: run.id, attempt: run.attempt, at };
    },
    /**
     * 闭合当前尝试（FR-82）：写 `outcome` + 摘要/错误 + `ended_at`/`duration_ms`，清空任务指针。
     * 只有**成功完成**（`outcome:"success"`）才算任务层面的成功；其余口径（blocked/crash/timeout/reclaimed…）照实记录。
     */
    endTaskRun(ref, { outcome = "ended", summary = null, error = null, actor = "system", now = null } = {}) {
      const task = ref && typeof ref === "object" && ref.id ? ref : store.requireTaskRef(ref);
      const run = store.getCurrentRun(task);
      if (!run) return { ended: false, reason: "no-running-run" };
      const at = new Date(now ?? Date.now()).toISOString();
      const durationMs = Math.max(0, new Date(at).getTime() - new Date(run.startedAt).getTime());
      db.prepare(
        "update task_runs set status = 'ended', outcome = ?, summary = ?, error = ?, ended_at = ?, duration_ms = ?, updated_at = ? where id = ? and status = 'running'",
      ).run(String(outcome), summary == null ? null : String(summary).slice(0, 500), error == null ? null : String(error).slice(0, 1000), at, durationMs, at, run.id);
      db.prepare("update tasks set current_run_id = null, version = version + 1, updated_at = ? where id = ?").run(at, task.id);
      store.recordTaskEvent(task.id, { type: "run_ended", actor, from: "running", to: String(outcome), detail: `第 ${run.attempt} 次尝试结束：${outcome}${summary ? ` — ${String(summary).slice(0, 200)}` : ""}`, now });
      return { ended: true, run: rowToRun(db.prepare("select * from task_runs where id = ?").get(run.id)) };
    },
    /**
     * FR-82 / FR-77 **收口**：结掉「孤儿尝试」，并清掉「幽灵认领」。
     *
     * 为什么会孤儿：尝试记录由**本进程内**的执行器收尾（`endTaskRun`）。插件进程一重启，
     * 那条尝试就再也没人闭合 → 永远停在 `running`（卡片「尝试记录」显示在跑，实际没有任何进程）。
     * **真机现场（2026-10-18）**：`taskboard-workbench-63` 第 3 次尝试、`-69` 第 1 次尝试，
     * 跨约 24 小时仍是 `running`；两张卡还各自挂着一把**早已过期**的认领锁。
     *
     * 两种触发，判据**故意不同**（这是本方法最容易写错的地方）：
     *   · `boot: true`（插件加载时调用一次）—— 本进程之前的所有执行都已随进程消失，**不看时长**，一律收口为 `interrupted`；
     *   · `boot: false`（定时器轮询）—— 只用 `runExceededMax()`（尊重该次自己的 `max_ms`）判超时收口为 `timeout`，
     *     **绝不误杀**正在跑的尝试。
     *
     * 另外收掉**幽灵认领**：任务已不在执行态（不是 `in_progress`）**且该认领已过期** —— `reclaimStaleClaims()`
     * 只扫 `status = 'in_progress'` 的已认领任务，这类锁它永远扫不到，会一直挂在卡片上。
     * **口径必须收在「已过期」上**：`claimTask` 本身不改任务状态，所以「刚认领、还没被推进到 in_progress
     * 的 todo 任务」天生就是「有锁且非 in_progress」，那是**正常在途**，不许清（单测当场抓到过这条）。
     */
    reconcileOrphanRuns({ projectId = undefined, now = null, boot = false, maxMs = null } = {}) {
      const ts = now ?? Date.now();
      const at = new Date(ts).toISOString();
      const rows = db.prepare(
        `select r.*, t.identifier as task_identifier, t.project_id as task_project_id, t.status as task_status
           from task_runs r join tasks t on t.id = r.task_id
          where r.status = 'running'`,
      ).all();
      const ended = [];
      for (const row of rows) {
        if (projectId && row.task_project_id !== projectId) continue;
        const run = rowToRun(row);
        if (!boot && !runExceededMax(run, { now: ts, maxMs })) continue;
        const outcome = boot ? "interrupted" : "timeout";
        const durationMs = Math.max(0, ts - new Date(run.startedAt).getTime());
        const summary = boot
          ? "插件进程重启：本次尝试随进程消失，收口为 interrupted"
          : `本次尝试超过运行时上限（已 ${Math.round(durationMs / 1000)}s），收口为 timeout`;
        db.prepare(
          "update task_runs set status = 'ended', outcome = ?, summary = ?, ended_at = ?, duration_ms = ?, updated_at = ? where id = ? and status = 'running'",
        ).run(outcome, summary, at, durationMs, at, run.id);
        // 只在指针确实指向这条时才清指针，避免误清别人刚开的新尝试
        db.prepare("update tasks set current_run_id = null, version = version + 1, updated_at = ? where id = ? and current_run_id = ?").run(at, row.task_id, run.id);
        store.recordTaskEvent(row.task_id, {
          type: "run_ended", actor: "system", from: "running", to: outcome,
          detail: `第 ${run.attempt} 次尝试收口：${outcome}${boot ? "（进程重启）" : "（超过运行时上限）"}`,
          now: ts,
        });
        try { store.recordAudit({ actor: "system", action: "reconcile-run", target: row.task_identifier, allowed: true, reason: boot ? "boot" : "run-exceeded-max", detail: `attempt=${run.attempt} outcome=${outcome}` }); } catch { /* ignore */ }
        // 超时收口同理（`boot` 的 `interrupted` 不在此列：那是进程重启，属另一类事故，已有自己的留痕）。
        const untakenRun = boot ? null : (() => { try { return store.noteUntakenDelivery(row.task_identifier, { now: ts }); } catch { return null; } })();
        ended.push({ identifier: row.task_identifier, attempt: run.attempt, outcome, untaken: untakenRun ? untakenRun.reason : null });
      }
      const ghostClaims = db.prepare(
        "select identifier from tasks where claim_lock is not null and status <> 'in_progress' and (claim_expires is null or claim_expires < ?)",
      ).all(at).map((r) => r.identifier);
      for (const ref of ghostClaims) {
        db.prepare(
          "update tasks set claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null, version = version + 1, updated_at = ? where identifier = ? and claim_lock is not null and status <> 'in_progress' and (claim_expires is null or claim_expires < ?)",
        ).run(at, ref, at);
        try { store.recordAudit({ actor: "system", action: "reconcile-claim", target: ref, allowed: true, reason: "claim-on-non-executing-task" }); } catch { /* ignore */ }
      }
      return { ended, ghostClaims };
    },
    /**
     * FR-76：把执行反馈里的"下一步建议"**派生为关联子任务**。
     * 子任务：`parentId=原任务`、归因**同一需求条目**、状态=待办池（`backlog`，不自动开工）。
     */
    deriveSubtask(ref, { title, description = "", actor = "human" } = {}) {
      const parent = store.requireTaskRef(ref);
      const t = assertTitle(title);
      const child = store.createTask({
        projectId: parent.projectId, title: t,
        description: description || `由 ${parent.identifier} 的执行反馈「下一步建议」派生（来源：${actor}）`,
        status: "backlog", parentId: parent.id,
      });
      if (parent.requirementId) { try { store.associateRequirementTask(parent.requirementId, child.id); } catch { /* ignore */ } }
      store.addComment(parent.id, { body: `由「下一步建议」派生为子任务 ${child.identifier}：${t}` });
      return store.getTaskById(child.id);
    },
    // ---------------- 通知订阅与唤醒（FR-81） ----------------
    /**
     * 建订阅（同 `项目 + 任务 + 会话 + 模式` 唯一，重复即复用并重新启用）。
     * `taskRef` 为空 = **项目级**订阅（该项目所有任务的终态）；`since` 可把游标放到指定位置（默认 0 = 从现在起全量）。
     */
    createNotifySubscription({ projectId, taskRef = null, sessionId = null, mode = "notify+wake", since = null } = {}) {
      const project = store.requireProject(projectId);
      const norm = normalizeDeliveryMode(mode);
      if (!norm.valid) throw invalidField("mode", `交付模式必须是 ${NOTIFY_DELIVERY_MODES.join(" / ")} 之一：${mode}`);
      const sid = String(sessionId ?? "").trim();
      if (!sid) throw invalidField("sessionId", "订阅必须指定目标会话（工作台关着时把终态闭环回去的那条会话）");
      const task = taskRef ? store.requireTaskRef(taskRef) : null;
      if (task && task.projectId !== project.id) throw invalidField("taskRef", `任务 ${task.identifier} 不属于项目 ${project.id}`);
      const ts = nowIso();
      const cursor = since == null ? null : Math.max(0, Number(since) || 0);
      const existing = db.prepare("select * from notify_subs where project_id = ? and ifnull(task_id, '') = ? and session_id = ? and mode = ?")
        .get(project.id, task?.id ?? "", sid, norm.mode);
      if (existing) {
        db.prepare("update notify_subs set active = 1, last_cursor = ?, updated_at = ? where id = ?")
          .run(cursor ?? Number(existing.last_cursor ?? 0), ts, existing.id);
        return rowToNotifySub(db.prepare("select * from notify_subs where id = ?").get(existing.id));
      }
      const id = randomUUID();
      db.prepare(
        `insert into notify_subs (id, project_id, task_id, session_id, mode, active, last_cursor, last_kinds, created_at, updated_at)
         values (?, ?, ?, ?, ?, 1, ?, '[]', ?, ?)`,
      ).run(id, project.id, task?.id ?? null, sid, norm.mode, cursor ?? 0, ts, ts);
      try {
        store.recordAudit({ actor: "human", action: "notify-subscribe", target: task ? task.identifier : project.id, allowed: true, reason: norm.mode, detail: `session=${sid}` });
      } catch { /* ignore */ }
      return rowToNotifySub(db.prepare("select * from notify_subs where id = ?").get(id));
    },
    /** 列出订阅（默认只看启用的；可按项目/任务过滤）。 */
    listNotifySubscriptions({ projectId = null, taskRef = null, activeOnly = true } = {}) {
      const clauses = []; const params = [];
      if (projectId) { clauses.push("project_id = ?"); params.push(store.requireProject(projectId).id); }
      if (taskRef) { clauses.push("task_id = ?"); params.push(store.requireTaskRef(taskRef).id); }
      if (activeOnly) clauses.push("active = 1");
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return db.prepare(`select * from notify_subs ${where} order by created_at, rowid`).all(...params).map(rowToNotifySub);
    },
    getNotifySubscription(id) {
      return rowToNotifySub(db.prepare("select * from notify_subs where id = ?").get(String(id)));
    },
    requireNotifySubscription(id) {
      const sub = store.getNotifySubscription(id);
      if (!sub) throw new TbError("NOT_FOUND", `订阅不存在：${id}`, { id });
      return sub;
    },
    /** 局部更新：只改传了的字段（`since` 可重置游标；`active:false` = 软停用）。 */
    updateNotifySubscription(id, { mode, active, sessionId, since } = {}) {
      const sub = store.requireNotifySubscription(id);
      const sets = []; const params = [];
      if (mode !== undefined) {
        const norm = normalizeDeliveryMode(mode);
        if (!norm.valid) throw invalidField("mode", `交付模式必须是 ${NOTIFY_DELIVERY_MODES.join(" / ")} 之一：${mode}`);
        sets.push("mode = ?"); params.push(norm.mode);
      }
      if (sessionId !== undefined) {
        const sid = String(sessionId ?? "").trim();
        if (!sid) throw invalidField("sessionId", "目标会话不能为空");
        sets.push("session_id = ?"); params.push(sid);
      }
      if (active !== undefined) { sets.push("active = ?"); params.push(active ? 1 : 0); }
      if (since !== undefined) { sets.push("last_cursor = ?"); params.push(Math.max(0, Number(since) || 0)); }
      if (!sets.length) return sub;
      sets.push("updated_at = ?"); params.push(nowIso());
      db.prepare(`update notify_subs set ${sets.join(", ")} where id = ?`).run(...params, sub.id);
      try {
        store.recordAudit({ actor: "human", action: "notify-update", target: sub.id, allowed: true, reason: Object.keys({ mode, active, sessionId, since }).filter((k) => ({ mode, active, sessionId, since })[k] !== undefined).join(",") });
      } catch { /* ignore */ }
      return store.getNotifySubscription(sub.id);
    },
    /** 默认**软停用**（保数据、保留游标）；`purge:true` 才真删（必须先有明确人工指示）。 */
    deleteNotifySubscription(id, { purge = false } = {}) {
      const sub = store.requireNotifySubscription(id);
      if (purge) {
        db.prepare("delete from notify_subs where id = ?").run(sub.id);
        try { store.recordAudit({ actor: "human", action: "notify-unsubscribe", target: sub.id, allowed: true, reason: "purge", detail: `${sub.mode} session=${sub.sessionId}` }); } catch { /* ignore */ }
        return { subscription: { ...sub, active: false }, purged: true };
      }
      const updated = store.updateNotifySubscription(sub.id, { active: false });
      try { store.recordAudit({ actor: "human", action: "notify-unsubscribe", target: sub.id, allowed: true, reason: "deactivate", detail: `${sub.mode} session=${sub.sessionId}` }); } catch { /* ignore */ }
      return { subscription: updated, purged: false };
    },
    /** 订阅可见的**未推送终态事件**（不推进游标；`since` 默认取订阅自己的游标）。 */
    notifySubPending(id, { since = null, limit = 200 } = {}) {
      const sub = store.getNotifySubscription(id);
      if (!sub) throw new TbError("NOT_FOUND", `订阅不存在：${id}`, { id });
      const from = since == null ? sub.lastCursor : Math.max(0, Number(since) || 0);
      const scoped = sub.taskId
        ? store.listTaskEvents(sub.taskId, { since: from, limit })
        : store.listProjectEvents(sub.projectId, { since: from, limit });
      const picked = selectNotifyEvents(scoped, { since: from });
      return {
        subscription: sub, since: from, cursor: picked.cursor, count: picked.events.length,
        events: picked.events, kinds: [...new Set(picked.events.map((e) => e.kind))],
        scanned: picked.scanned, skipped: picked.skipped, deduped: picked.deduped,
      };
    },
    /** 项目级"通知预览"：看某项目游标之后有哪些终态事件待推（不落库、不推进游标）。 */
    notifyPreviewEvents({ projectId, taskRef = null, since = 0, limit = 200 } = {}) {
      const project = store.requireProject(projectId);
      const scoped = taskRef
        ? store.listTaskEvents(taskRef, { since, limit })
        : store.listProjectEvents(project.id, { since, limit });
      const picked = selectNotifyEvents(scoped, { since });
      return { project: project.id, since: Number(since) || 0, cursor: picked.cursor, count: picked.events.length, events: picked.events, kinds: [...new Set(picked.events.map((e) => e.kind))] };
    },
    /**
     * 推送一轮（FR-81 的**唯一投递入口**）。
     * - 成功 → 按模式写评论留痕（`notify` / `notify+wake`）+ 推进 `last_cursor`；
     * - 失败 → **不推进游标**、`failed_count+1`、`last_error` 照实记录（不静默丢失，下轮自动重试）。
     * `deliver` 由调用方注入（`sync`）；不传则回落到 `store.hostSessionPort.sendPrompt`（宿主不可用 → 记为失败）。
     */
    async flushNotifySubscriptions({ projectId = null, subId = null, deliver = null, now = null } = {}) {
      const subs = subId ? [store.requireNotifySubscription(subId)] : store.listNotifySubscriptions({ projectId, activeOnly: true });
      const results = [];
      for (const sub of subs) {
        const pending = store.notifySubPending(sub.id);
        if (!pending.count) {
          results.push({ id: sub.id, projectId: sub.projectId, sessionId: sub.sessionId, mode: sub.mode, scope: sub.scope, kinds: [], count: 0, cursor: pending.cursor, delivered: false, via: null, error: null, commented: 0, reason: "no-terminal-events" });
          continue;
        }
        const project = store.getProject(sub.projectId);
        const msg = buildNotifyMessage({ project, events: pending.events, mode: sub.mode, taskOf: (tid) => store.getTaskById(tid) });
        const send = deliver ?? ((target, text) => (typeof store.hostSessionPort?.sendPrompt === "function"
          ? store.hostSessionPort.sendPrompt(target, text)
          : Promise.resolve({ sent: false, via: "unavailable", error: "宿主会话通道不可用（sessionController 未注册）" })));
        let ok = true; let via = "comment"; let error = null; let commented = 0;
        if (msg.prompt) {
          try {
            const r = await send(sub.sessionId, msg.prompt);
            ok = r?.sent !== false;
            via = r?.via ?? null;
            if (!ok) error = String(r?.error ?? "投递失败（目标会话可能已失效）");
          } catch (e) {
            ok = false; via = null; error = String(e?.message ?? e);
          }
        }
        if (ok && msg.commentBody) {
          for (const tid of msg.taskIds) {
            try { store.addComment(tid, { body: msg.commentBody }); commented += 1; } catch { /* ignore */ }
          }
        }
        const at = new Date(now ?? Date.now()).toISOString();
        if (ok) {
          db.prepare("update notify_subs set last_cursor = ?, delivered_count = delivered_count + 1, last_kinds = ?, last_delivery_at = ?, last_error = null, updated_at = ? where id = ?")
            .run(pending.cursor, JSON.stringify(pending.kinds), at, at, sub.id);
        } else {
          db.prepare("update notify_subs set failed_count = failed_count + 1, last_error = ?, last_kinds = ?, updated_at = ? where id = ?")
            .run(`${at}｜${error}`.slice(0, 500), JSON.stringify(pending.kinds), at, sub.id);
        }
        results.push({
          id: sub.id, projectId: sub.projectId, sessionId: sub.sessionId, mode: sub.mode, scope: sub.scope,
          kinds: pending.kinds, count: pending.count, cursor: pending.cursor, delivered: ok, via, error, commented,
          taskIds: msg.taskIds,
        });
      }
      return { count: results.length, results };
    },
    // ---------------- 团队执行记录（FR-42） ----------------
    createTeamRun({ targetTask = null, targetRequirement = null, status = "staged" } = {}) {
      const id = randomUUID(); const ts = nowIso();
      let taskId = null; let reqId = null;
      if (targetTask) taskId = store.requireTaskRef(targetTask).id;
      if (targetRequirement) reqId = store.requireRequirementItemRef(targetRequirement).id;
      db.prepare("insert into team_runs (id, target_task_id, target_requirement_id, status, created_at, updated_at) values (?,?,?,?,?,?)").run(id, taskId, reqId, status, ts, ts);
      return store.getTeamRun(id);
    },
    getTeamRun(id) {
      const row = db.prepare("select * from team_runs where id = ?").get(id);
      return row ? { id: row.id, targetTaskId: row.target_task_id, targetRequirementId: row.target_requirement_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null;
    },
    // ---------------- 项目设置（FR-56）：项目环境约束 + agent 执行团队模板 ----------------
    getProjectSettings(projectId) {
      store.requireProject(projectId);
      const row = db.prepare("select * from project_settings where project_id = ?").get(projectId);
      const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
      return row
        ? { projectId, envConfig: parse(row.env_config), teamTemplate: parse(row.team_template), loop: parse(row.loop_config), updatedAt: row.updated_at }
        : { projectId, envConfig: {}, teamTemplate: {}, loop: {}, updatedAt: null };
    },
    saveProjectSettings(projectId, { envConfig, teamTemplate, loop } = {}) {
      store.requireProject(projectId);
      const current = store.getProjectSettings(projectId);
      const nextEnv = envConfig === undefined ? current.envConfig : envConfig;
      const nextTpl = teamTemplate === undefined ? current.teamTemplate : teamTemplate;
      const nextLoop = loop === undefined ? current.loop : loop;
      const ts = nowIso();
      db.prepare(
        `insert into project_settings (project_id, env_config, team_template, loop_config, updated_at) values (?,?,?,?,?)
         on conflict(project_id) do update set env_config = excluded.env_config, team_template = excluded.team_template, loop_config = excluded.loop_config, updated_at = excluded.updated_at`,
      ).run(projectId, JSON.stringify(nextEnv ?? {}), JSON.stringify(nextTpl ?? {}), JSON.stringify(nextLoop ?? {}), ts);
      return store.getProjectSettings(projectId);
    },
    /** 列出团队执行记录（可按目标任务过滤），并带出目标任务编号/标题，供工作台"归属团队"视图使用。 */
    listTeamRuns({ targetTask = null, status = null, limit = 100 } = {}) {
      const clauses = []; const params = [];
      if (targetTask) { const t = store.requireTaskRef(targetTask); clauses.push("r.target_task_id = ?"); params.push(t.id); }
      if (status) { clauses.push("r.status = ?"); params.push(status); }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      const rows = db.prepare(
        `select r.*, t.identifier as target_identifier, t.title as target_title, t.status as target_status
           from team_runs r left join tasks t on t.id = r.target_task_id ${where}
          order by r.created_at desc, r.rowid desc limit ?`,
      ).all(...params, limit);
      return rows.map((r) => ({
        id: r.id, targetTaskId: r.target_task_id, targetTaskIdentifier: r.target_identifier ?? null,
        targetTaskTitle: r.target_title ?? null, targetTaskStatus: r.target_status ?? null,
        targetRequirementId: r.target_requirement_id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
      }));
    },
    addTeamMember({ teamId, role, model = null, executor = null, status = "ready" } = {}) {
      if (!store.getTeamRun(teamId)) throw new TbError("TEAM_NOT_FOUND", `团队不存在：${teamId}`, { teamId });
      // FR-50 验收第一条（2026-10-26 修）：模板声明的是「角色集合与**数量**、每角色模型与**执行器**」，
      // 因此同一团队同一角色**可以有多名成员**（`count>1`）——这里**不再按 role 去重**。
      // 去重会在 `count:2` 时把两名 engineer 折叠成一名，并使「按模板装配」名不副实。
      // 需要「只有一个」的调用方，请在装配计划里自行保证（建队路径已按 count 展开）。
      const id = randomUUID();
      db.prepare("insert into team_members (id, team_id, role, model, executor, status, created_at) values (?,?,?,?,?,?,?)").run(id, teamId, String(role), model, executor, status, nowIso());
      return { id, teamId, role: String(role), model, executor, status };
    },
    listTeamMembers(teamId) {
      return db.prepare("select * from team_members where team_id = ? order by created_at, rowid").all(teamId).map((r) => ({ id: r.id, teamId: r.team_id, role: r.role, model: r.model ?? null, executor: r.executor ?? null, status: r.status }));
    },
    getTeamTask(teamTaskId) {
      const r = db.prepare("select * from team_tasks where id = ?").get(teamTaskId);
      return r ? { id: r.id, teamId: r.team_id, taskId: r.task_id, memberId: r.member_id ?? null, kind: r.kind, status: r.status, attempt: r.attempt ?? null } : null;
    },
    listTeamTasks(teamId) {
      return db.prepare("select * from team_tasks where team_id = ? order by created_at, rowid").all(teamId).map((r) => ({ id: r.id, teamId: r.team_id, taskId: r.task_id, memberId: r.member_id ?? null, kind: r.kind, status: r.status, attempt: r.attempt ?? null }));
    },
    listTeamAttempts(teamTaskId) {
      return db.prepare("select * from team_attempts where team_task_id = ? order by created_at, rowid").all(teamTaskId).map((r) => ({ id: r.id, teamTaskId: r.team_task_id, attemptId: r.attempt_id ?? null, result: r.result ?? null, createdAt: r.created_at }));
    },
    /** 任务级执行锁：同任务同时只 1 个活跃团队任务；backlog 不得被团队认领（C5-②）。 */
    acquireTeamTask({ teamId, task, member = null, kind = "work" } = {}) {
      if (!store.getTeamRun(teamId)) throw new TbError("TEAM_NOT_FOUND", `团队不存在：${teamId}`, { teamId });
      const t = store.assertTeamClaimable(task);
      const id = randomUUID(); const ts = nowIso();
      try {
        db.prepare("insert into team_tasks (id, team_id, task_id, member_id, kind, status, created_at, updated_at) values (?,?,?,?,?, 'running', ?, ?)").run(id, teamId, t.id, member, kind, ts, ts);
      } catch (error) {
        if (String(error?.message ?? "").includes("team_tasks_active_lock") || String(error?.message ?? "").includes("UNIQUE")) {
          store.recordAudit({ actor: "team", action: "claim", target: t.identifier, allowed: false, reason: "task-locked" });
          throw new TbError("TASK_LOCKED", "该任务已有活跃执行单元（任务级执行锁）", { identifier: t.identifier });
        }
        throw error;
      }
      return store.getTeamTask(id);
    },
    /**
     * 「团队不得认领」的唯一判据来源（C5-②）：backlog = 未授权开工。
     *
     * 真机 2026-10-22（续四十一）：`POST /api/teams` 原先**先** `createTeamRun()`（并写成员），
     * **之后**才在 `acquireTeamTask()` 里做这条判定 ⇒ 只要 `tasks` 里混进一张 backlog 卡，
     * 请求虽被拒，库里却留下一个**空团队 run**（团队视图可见的孤儿记录）。
     * 修法：判据提成这个方法，api 层在建 run **之前**先对每个待认领 ref 预判一遍；
     * `acquireTeamTask` 仍调用它复检（口径只有这一份）。
     */
    assertTeamClaimable(ref) {
      const t = store.requireTaskRef(ref);
      if (t.status === "backlog") {
        store.recordAudit({ actor: "team", action: "claim", target: t.identifier, allowed: false, reason: "backlog-not-authorized" });
        throw new TbError("EXECUTION_NOT_AUTHORIZED", "未授权不开工：backlog 任务不得被团队认领", { identifier: t.identifier });
      }
      return t;
    },
    getTaskLock(ref) {
      const t = store.requireTaskRef(ref);
      const row = db.prepare("select * from team_tasks where task_id = ? and status in ('open','running') order by created_at desc limit 1").get(t.id);
      return row ? { id: row.id, teamId: row.team_id, taskId: row.task_id, status: row.status } : null;
    },
    releaseTeamTask(teamTaskId) {
      const row = db.prepare("select * from team_tasks where id = ?").get(teamTaskId);
      if (!row) throw new TbError("TEAM_TASK_NOT_FOUND", `团队任务不存在：${teamTaskId}`, { teamTaskId });
      db.prepare("update team_tasks set status = 'cancelled', updated_at = ? where id = ?").run(nowIso(), teamTaskId);
      return { id: teamTaskId, released: true };
    },
    recordTeamAttempt({ teamTaskId, attemptId = null, result = null } = {}) {
      const row = db.prepare("select * from team_tasks where id = ?").get(teamTaskId);
      if (!row) throw new TbError("TEAM_TASK_NOT_FOUND", `团队任务不存在：${teamTaskId}`, { teamTaskId });
      const id = randomUUID();
      db.prepare("insert into team_attempts (id, team_task_id, attempt_id, result, created_at) values (?,?,?,?,?)").run(id, teamTaskId, attemptId, result, nowIso());
      return { id, teamTaskId, attemptId, result };
    },

    // ---------------- 人工校验任务（FR-85b · 人在环升级门） ----------------
    /**
     * 由诊断 / 阻断升级落成一条**人工校验任务**（FR-85）。
     *
     * 三条硬口径：
     *   ① 只有**证据充分**才落卡 —— `draft` 必须通过 `validateHumanReviewDraft`，否则抛
     *      `HUMAN_REVIEW_DRAFT_INVALID`。「判不准就不升级」是 FR-85 的原话，不许自动臆断。
     *   ② **幂等**：同项目同类别仍有未结论的人工校验任务时抛 `HUMAN_REVIEW_ALREADY_EXISTS`，
     *      否则诊断每轮都会重复造卡。
     *   ③ 任务本身**不可执行**：执行侧认领 / 派发 / 开尝试 / 改状态 / 置 done 全部被拦（见各入口守卫）。
     */
    createHumanReviewTask({ projectId, draft, actor = "system", requirementId = null, relatedTask = null, priority = "high" } = {}) {
      const validation = validateHumanReviewDraft(draft ?? {});
      if (!validation?.ok) {
        throw new TbError("HUMAN_REVIEW_DRAFT_INVALID", `人工校验任务草案不完整：${(validation?.errors ?? []).join("；") || "未知原因"}`, { errors: validation?.errors ?? [] });
      }
      const category = String(draft.category ?? "").trim();
      const pending = store.listHumanReviews({ projectId, state: "pending" }).find((t) => (t.humanReviewCategory ?? null) === category);
      if (pending) {
        throw new TbError("HUMAN_REVIEW_ALREADY_EXISTS", `项目 ${projectId} 已有同类人工校验任务待结论：${pending.identifier}`, { identifier: pending.identifier, category });
      }
      const task = store.createTask({
        projectId,
        title: draft.title,
        description: draft.description,
        status: "backlog",
        priority,
        labels: ["FR-85", HUMAN_REVIEW_LABEL, category].filter(Boolean),
      });
      const at = nowIso();
      db.prepare(
        `update tasks set human_review_category = ?, human_review_state = 'pending',
              requirement_id = coalesce(?, requirement_id), version = version + 1, updated_at = ?
          where id = ?`,
      ).run(category, requirementId, at, task.id);
      store.recordTaskEvent(task.id, { type: "human_review_created", to: "pending", actor, detail: `人工校验（类别 ${categoryLabel(category) ?? category}）：${draft.title}` });
      try { store.recordAudit({ actor, action: "human-review-created", target: task.identifier, allowed: true, reason: "escalation", detail: `category=${category}` }); } catch { /* ignore */ }
      // 影响域：把"被这扇门挡住的下游"写成真实依赖边，结论后才能按图放行（FR-86 的"只停影响域"）。
      if (relatedTask) {
        try { store.addTaskDependency({ blocker: task.identifier, blocked: relatedTask, reason: "人在环升级门：需人工校验结论后才可推进" }); } catch { /* 建边失败不阻断建卡 */ }
      }
      return store.getTaskById(task.id);
    },
    /**
     * FR-85b：把原任务**停手**在「人在环升级门」后面（等人给结论期间不许再被派发）。
     *
     * 为什么不复用 `blockTask`：`blockTask` 是 FR-80 的**阻断分类唯一入口**，会按 kind 重算
     * `block_kind` / `block_recurrences` —— 而升级门的**证据恰恰就是这两列**（同因复发 ≥2 + 阻断类型）。
     * 用它去"挡住"原任务会把刚成立的证据抹掉（复发归 1、类型被改写），门一旦成立就自毁证据链，
     * 于是幂等判定与复核都失去依据。所以这里只做"移出可开工池"这一件事，**不碰阻断会计**。
     */
    holdForHumanReview(ref, { reason = null, actor = "human", reviewTask = null, now = null } = {}) {
      const task = store.requireTaskRef(ref);
      const at = new Date(now ?? Date.now()).toISOString();
      db.prepare(
        `update tasks set status = 'blocked', blocked_at = coalesce(blocked_at, ?),
              claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null,
              version = version + 1, updated_at = ? where id = ?`,
      ).run(at, at, task.id);
      try { store.endTaskRun(task.identifier, { outcome: "blocked", summary: reason ?? "停在人在环升级门", actor, now: now ?? Date.now() }); } catch { /* 无在途尝试则忽略 */ }
      try {
        store.addComment(task.id, {
          body: `已停在「人在环升级门」后${reviewTask ? `（人工校验任务 ${reviewTask}）` : ""}：${reason ?? "等人工结论"}\n结论给出前不会被自动派发；放行请走人工校验结论入口（continue / change-requirement / close）。`,
        });
      } catch { /* ignore */ }
      try { store.recordAudit({ actor, action: "hold-human-review", target: task.identifier, allowed: true, reason: "human-review-gate", detail: reviewTask ?? null }); } catch { /* ignore */ }
      store.recordTaskEvent(task.id, { type: "blocked", to: "blocked", actor, detail: `人在环升级门${reviewTask ? `：${reviewTask}` : ""}`, now: now ?? Date.now() });
      return store.getTaskById(task.id);
    },
    /** 人工校验任务队列（FR-85b）。`state` ∈ `pending` / `concluded`；不传即全部。 */
    listHumanReviews({ projectId, state = null } = {}) {
      return store.listTasks({ projectId })
        .filter((t) => isHumanReviewTask(t))
        .filter((t) => (state ? (t.humanReviewState ?? "pending") === state : true))
        .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    },
    /** 待人工校验（FR-85b）：看板"待人工校验"计数与诊断去重都用它。 */
    humanReviewPending(projectId) {
      return store.listHumanReviews({ projectId, state: "pending" });
    },
    /**
     * 人工回填结论（FR-85b）：**唯一的放行出口**。
     *
     * 结论语义**只认** `human-review.mjs` 的 `conclusionOutcome()`（口径只此一处，store 不另立一套）：
     *   · `continue`            → 放行影响域（被这扇门挡住的直接下游，且其自身依赖已就绪的，回「可开工」）
     *   · `change-requirement`  → 不放行（需按新口径改写需求后由人重开）
     *   · `close`               → 不放行（等人工另行处置）
     * 结论一旦给出，这扇门就**消耗掉了**：任务本身转「已取消」（于是不再挡依赖），原任务与下游的放行
     * 由上面的影响域决定。重复结论抛 `HUMAN_REVIEW_ALREADY_CONCLUDED`。
     */
    concludeHumanReview(ref, { conclusion, comment = "", actor = "human", now = null } = {}) {
      const task = store.requireTaskRef(ref);
      if (!isHumanReviewTask(task)) {
        throw new TbError("HUMAN_REVIEW_NOT_KIND", `任务 ${task.identifier} 不是人工校验任务`, { identifier: task.identifier });
      }
      if ((task.humanReviewState ?? "pending") === "concluded") {
        throw new TbError("HUMAN_REVIEW_ALREADY_CONCLUDED", `人工校验任务 ${task.identifier} 已有结论（${task.humanReviewConclusion}），不得重复结论`, { identifier: task.identifier, conclusion: task.humanReviewConclusion });
      }
      let normalized;
      try { normalized = assertConclusion(conclusion); } catch (error) { throw invalidField("conclusion", String(error?.message ?? error)); }
      const outcome = conclusionOutcome(normalized);
      const at = new Date(now ?? Date.now()).toISOString();
      db.prepare(
        `update tasks set human_review_state = 'concluded', human_review_conclusion = ?,
              human_review_concluded_at = ?, human_review_concluded_by = ?, version = version + 1, updated_at = ?
          where id = ?`,
      ).run(normalized, at, actor, at, task.id);
      // 门已消耗：转「已取消」（canceled 不再构成阻塞，下游可被放行）
      db.prepare("update tasks set status = 'canceled', version = version + 1, updated_at = ? where id = ?").run(at, task.id);
      store.recordTaskEvent(task.id, { type: "human_review_concluded", to: "concluded", actor, detail: `人工结论=${normalized}${comment ? `｜${comment}` : ""}` });
      try { store.addComment(task.id, { body: `人工校验结论：**${normalized}**${comment ? `\n说明：${comment}` : ""}\n口径：${outcome.note ?? ""}\n操作者：${actor}` }); } catch { /* ignore */ }
      try { store.recordAudit({ actor, action: "human-review-concluded", target: task.identifier, allowed: true, reason: normalized, detail: outcome.note ?? null }); } catch { /* ignore */ }
      const released = [];
      if (outcome.releaseDownstream) {
        const downstream = db.prepare("select d.blocked_id as id from task_dependencies d where d.blocker_id = ?").all(task.id);
        for (const row of downstream) {
          const t = store.getTaskById(row.id);
          if (!t || (t.status !== "blocked" && t.status !== "todo")) continue;
          // 就绪判定：其余前置必须都已「完成」或「已取消」（**不能用 isTaskReady** —— 它把 canceled 也算未完成）
          const blockers = db.prepare("select t.status as status from task_dependencies d join tasks t on t.id = d.blocker_id where d.blocked_id = ?").all(t.id);
          if (!blockers.every((b) => b.status === "done" || b.status === "canceled")) continue;
          db.prepare(
            `update tasks set status = 'todo', blocked_at = null, claim_lock = null, claim_expires = null,
                  claim_owner = null, last_heartbeat_at = null, version = version + 1, updated_at = ?
              where id = ?`,
          ).run(at, t.id);
          store.recordTaskEvent(t.id, { type: "human_review_released", from: t.status, to: "todo", actor, detail: `人工校验结论=${normalized} → 放行回「可开工」` });
          try { store.addComment(t.id, { body: `人工校验结论「${normalized}」→ 本任务已放行回「可开工」。${comment ? `\n结论说明：${comment}` : ""}` }); } catch { /* ignore */ }
          released.push(t.identifier);
        }
      }
      return { task: store.getTaskById(task.id), conclusion: normalized, outcome, released };
    },

    // ---------------- 治理层（C5 固定红线，不可配） ----------------
    recordAudit({ actor = null, action, target = null, allowed = true, reason = null, detail = null } = {}) {
      const id = randomUUID();
      db.prepare("insert into governance_audit (id, at, actor, action, target, allowed, reason, detail) values (?,?,?,?,?,?,?,?)").run(id, nowIso(), actor, action, target, allowed ? 1 : 0, reason, detail);
      return id;
    },
    listGovernanceAudit(filter = {}) {
      const clauses = []; const params = [];
      if (filter.action) { clauses.push("action = ?"); params.push(filter.action); }
      if (filter.allowed !== undefined) { clauses.push("allowed = ?"); params.push(filter.allowed ? 1 : 0); }
      const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
      return db.prepare(`select * from governance_audit ${where} order by at, rowid`).all(...params).map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, target: r.target, allowed: !!r.allowed, reason: r.reason, detail: r.detail }));
    },
    /** 红线①：执行侧不得写 done → 拒绝 + 审计。 */
    teamSetTaskStatus(ref, { status, actor = "team" } = {}) {
      const t = store.requireTaskRef(ref);
      if (status === "done") {
        store.recordAudit({ actor, action: "set-status", target: t.identifier, allowed: false, reason: "agent-cannot-write-done", detail: `requested done (from ${t.status})` });
        throw new TbError("GOVERNANCE_AGENT_DONE", "红线：完成只能由人确认，执行侧不得写 done", { identifier: t.identifier });
      }
      // FR-85b：人工校验任务连状态都不许执行侧改（唯一出口是人工结论入口）
      if (isHumanReviewTask(t)) {
        store.recordAudit({ actor, action: "set-status", target: t.identifier, allowed: false, reason: "human-review-not-executable", detail: `requested ${status}` });
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${t.identifier} 是人工校验任务：执行侧不得改其状态`, { identifier: t.identifier });
      }
      if (!TEAM_WRITABLE_STATUSES.includes(status)) throw invalidField("status", `执行侧不允许写入 ${status}`);
      // 状态离开"进行中"即释放认领（FR-77）
      const clearClaim = status === "in_progress" ? "" : ", claim_lock = null, claim_expires = null, claim_owner = null, last_heartbeat_at = null";
      db.prepare(`update tasks set status = ?${clearClaim}, version = version + 1, updated_at = ? where id = ?`).run(status, nowIso(), t.id);
      store.recordAudit({ actor, action: "set-status", target: t.identifier, allowed: true, reason: "team-writable", detail: status });
      return store.getTaskById(t.id);
    },
    /** 红线③：审查未过 / 上游失败 → 下游保持 blocked（不解锁）。 */
    blockDownstream(taskId, reason = "review-not-passed") {
      const downstream = db.prepare("select d.blocked_id as id, t.identifier as identifier, t.status as status from task_dependencies d join tasks t on t.id = d.blocked_id where d.blocker_id = ?").all(taskId);
      const blocked = [];
      for (const d of downstream) {
        if (d.status !== "done" && d.status !== "canceled") {
          // FR-83：改走统一受阻入口（`hold` 路由）—— 补齐 block_kind/blocked_at/评论/事件/尝试收口，
          // 但**保持受阻**（评审门不是"等父任务自动提升"）。
          try {
            store.blockTask(d.identifier, { kind: "dependency", reason: `上游${reason === "upstream-failed" ? "失败" : "评审未过"}：${taskId}`, actor: "team", route: "hold" });
            blocked.push(d.identifier);
          } catch { /* 单个下游失败不影响其它下游 */ }
        }
      }
      if (blocked.length) store.recordAudit({ actor: "team", action: "review-gate", target: taskId, allowed: false, reason, detail: blocked.join(",") });
      return blocked;
    },
    /** 团队任务结果 → 项目任务状态（部分完成回流；不自动解锁下游）。 */
    applyTeamTaskOutcome(teamTaskId, { outcome, reviewPassed = true, evidence = "" } = {}) {
      const row = db.prepare("select * from team_tasks where id = ?").get(teamTaskId);
      if (!row) throw new TbError("TEAM_TASK_NOT_FOUND", `团队任务不存在：${teamTaskId}`, { teamTaskId });
      const t = store.getTaskById(row.task_id);
      const ev = evidence ? `（证据：${evidence}）` : "";
      if (outcome === "completed") {
        db.prepare("update tasks set status = 'in_review', version = version + 1, updated_at = ? where id = ?").run(nowIso(), t.id);
        db.prepare("update team_tasks set status = 'completed', updated_at = ? where id = ?").run(nowIso(), teamTaskId);
        if (row.kind === "review" && reviewPassed !== true) store.blockDownstream(t.id, "review-not-passed");
        store.addComment(t.id, { body: `团队回报：完成 → 提交待验收${ev}` }); // 自动登记反馈
        store.markTaskSucceeded(t.identifier); // FR-78：成功即清零失败计数
      } else if (outcome === "failed") {
        // FR-80：团队回报失败也走统一受阻入口（transient）
        db.prepare("update tasks set status = 'blocked', version = version + 1, updated_at = ? where id = ?").run(nowIso(), t.id);
        db.prepare("update team_tasks set status = 'failed', updated_at = ? where id = ?").run(nowIso(), teamTaskId);
        store.blockDownstream(t.id, "upstream-failed");
        store.addComment(t.id, { body: `团队回报：失败 → 受阻${ev}` }); // 自动登记失败反馈
        store.recordTaskFailure(t.identifier, { error: evidence || "团队回报失败", outcome: "failed" }); // FR-78：计入熔断
      } else {
        throw invalidField("outcome", "outcome 必须是 completed 或 failed");
      }
      return store.getTaskById(t.id);
    },
    applyTeamRunProgress(teamId, outcomes = []) {
      if (!store.getTeamRun(teamId)) throw new TbError("TEAM_NOT_FOUND", `团队不存在：${teamId}`, { teamId });
      const results = outcomes.map((o) => ({ teamTaskId: o.teamTaskId, task: store.applyTeamTaskOutcome(o.teamTaskId, { outcome: o.outcome, reviewPassed: o.reviewPassed }) }));
      const status = store.finishTeamRun(teamId);
      return { teamId, status, results };
    },
    finishTeamRun(teamId) {
      if (!store.getTeamRun(teamId)) throw new TbError("TEAM_NOT_FOUND", `团队不存在：${teamId}`, { teamId });
      const tasks = db.prepare("select status from team_tasks where team_id = ?").all(teamId).map((r) => r.status);
      let status;
      if (tasks.length === 0) status = "staged";
      else if (tasks.some((s) => s === "open" || s === "running")) status = "running";
      else if (tasks.every((s) => s === "failed")) status = "failed";
      else status = "completed";
      db.prepare("update team_runs set status = ?, updated_at = ? where id = ?").run(status, nowIso(), teamId);
      return status;
    },
    stats() {
      const count = (sql) => db.prepare(sql).get().n;
      return {
        projects: count("select count(*) as n from projects"),
        tasks: count("select count(*) as n from tasks"),
        comments: count("select count(*) as n from comments"),
        ownedTasks: count("select count(*) as n from tasks where owner is not null and owner <> ''"),
        legacyOwnerLabels: count("select count(*) as n from tasks where labels like '%owner:%'"),
        dbPath,
        dataDir,
        schemaVersion: SCHEMA_VERSION,
        migration,
      };
    },
  };

  // 项目记忆：同库、同事务语义，但**不感知** MCP/CLI/Web（只是用例层的又一扇门）。
  Object.assign(store, createMemoryApi({ db, nowIso, randomUUID }));

  return store;
}
