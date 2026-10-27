/**
 * 领域模型：七状态、五优先级、标签、可读编号、父子与版本语义（FR-04/06/08/09/10/18）。
 * 本模块是纯函数层：不触碰文件系统与数据库，可单独测试（核心层不依赖 DSH）。
 */
import { invalidField, TbError } from "./errors.mjs";

/** 七状态（顺序即看板列顺序）。核心层不限制转移，任意互转都允许。 */
export const STATUSES = Object.freeze([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "canceled",
]);

/** 五优先级；rank 越小越紧急，用于排序（FR-08：紧急在前）。 */
export const PRIORITIES = Object.freeze(["none", "low", "medium", "high", "urgent"]);
export const PRIORITY_RANK = Object.freeze({
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
});

/** 默认值 */
export const DEFAULT_STATUS = "backlog";
export const DEFAULT_PRIORITY = "none";

/** 治理能力位（FR-07）：默认不强制；上层可打开 enforcement。 */
export const GOVERNANCE_DEFAULTS = Object.freeze({
  /** 是否禁止智能体把任务置为 done（默认关闭 = 核心层不拦截任意转移）。 */
  enforce: false,
  /** 打开 enforcement 时同时禁止智能体把 backlog 任务推进到其它状态。 */
  blockAgentClaimFromBacklog: true,
});

export const ACTORS = Object.freeze(["human", "agent"]);

export function isStatus(value) {
  return STATUSES.includes(value);
}

export function isPriority(value) {
  return PRIORITIES.includes(value);
}

export function assertStatus(value, field = "status") {
  if (!isStatus(value)) {
    throw new TbError(
      "INVALID_STATUS",
      `${field} 必须是 ${STATUSES.join(" / ")} 之一，收到：${JSON.stringify(value)}`,
      { allowed: STATUSES.slice() },
    );
  }
  return value;
}

export function assertPriority(value, field = "priority") {
  if (!isPriority(value)) {
    throw new TbError(
      "INVALID_PRIORITY",
      `${field} 必须是 ${PRIORITIES.join(" / ")} 之一，收到：${JSON.stringify(value)}`,
      { allowed: PRIORITIES.slice() },
    );
  }
  return value;
}

export function assertActor(value, field = "actor") {
  if (!ACTORS.includes(value)) {
    throw invalidField(field, `${field} 必须是 human 或 agent，收到：${JSON.stringify(value)}`);
  }
  return value;
}

/** 项目 id：小写字母开头，允许小写字母/数字/连字符，2–32 字符；同时作为可读编号前缀。 */
export const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function assertProjectId(value, field = "id") {
  if (typeof value !== "string" || !PROJECT_ID_PATTERN.test(value)) {
    throw new TbError(
      "INVALID_ID",
      `${field} 必须匹配 ${PROJECT_ID_PATTERN}（小写字母开头，仅含小写字母/数字/连字符，2–32 字符），收到：${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** 由项目名派生 id/前缀：中文等非 ASCII 会得到空串，需要调用方显式给 --id。 */
export function slugify(name) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

/** 可读编号：`<前缀>-<序号>`，序号项目内单调递增（FR-04）。 */
export function formatIdentifier(prefix, sequence) {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw invalidField("sequence", `序号必须是 ≥1 的整数，收到：${JSON.stringify(sequence)}`);
  }
  return `${prefix}-${sequence}`;
}

/** 解析 `demo-12` → { prefix: "demo", sequence: 12 }；不匹配返回 null。 */
export function parseIdentifier(value) {
  const match = /^([a-z][a-z0-9-]*)-(\d+)$/.exec(String(value ?? ""));
  if (!match) return null;
  const sequence = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  return { prefix: match[1], sequence };
}

export const LABEL_MAX_LENGTH = 40;
export const LABEL_MAX_COUNT = 20;

/**
 * 标签规范化：支持 `["a,b"]`、`["a","b"]`、`"a,b"` 三种输入形态；
 * 每个元素再按逗号拆分，去首尾空白、压缩内部空白、去重；拒绝空标签与超长标签（FR-09）。
 */
export function normalizeLabels(input) {
  const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  const out = [];
  for (const item of raw) {
    for (const piece of String(item ?? "").split(",")) {
      const label = piece.trim().replace(/\s+/g, " ");
      if (label === "") continue;
      if (label.length > LABEL_MAX_LENGTH) {
        throw new TbError("INVALID_LABEL", `标签过长（上限 ${LABEL_MAX_LENGTH}）：${label}`);
      }
      if (!out.includes(label)) out.push(label);
    }
  }
  if (out.length > LABEL_MAX_COUNT) {
    throw new TbError("INVALID_LABEL", `标签过多（上限 ${LABEL_MAX_COUNT}）：${out.length}`);
  }
  return out;
}

export function assertTitle(value, field = "title") {
  const title = String(value ?? "").trim();
  if (title === "") throw invalidField(field, "title 不能为空（标题必填）");
  if (title.length > 200) throw invalidField(field, `title 过长（上限 200）：${title.length}`);
  return title;
}

export function normalizeDescription(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

/**
 * 父子关系校验（FR-10）：单父、同项目、禁止成环。
 * @param {{ id: string, projectId: string, parentId: string|null }} child
 * @param {{ id: string, projectId: string, parentId: string|null }} parent
 */
export function assertParentLink(child, parent) {
  if (child.id === parent.id) {
    throw new TbError("PARENT_CYCLE", "父子关系不能指向自己（会形成环）", { taskId: child.id });
  }
  if (child.parentId && child.parentId !== parent.id) {
    throw new TbError(
      "PARENT_ALREADY_SET",
      `任务已存在父任务（${child.parentId}）；如需更换请先清除父任务（FR-10：最多一个父任务）`,
      { taskId: child.id, currentParentId: child.parentId, requestedParentId: parent.id },
    );
  }
  if (child.projectId !== parent.projectId) {
    throw new TbError(
      "PARENT_CROSS_PROJECT",
      `父子关系不能跨项目（子任务项目 ${child.projectId}，父任务项目 ${parent.projectId}）`,
      { childProjectId: child.projectId, parentProjectId: parent.projectId },
    );
  }
}

/**
 * 成环检测：沿 parent 链向上走，若遇到 childId 即成环。
 * @param {string} childId
 * @param {string} parentId
 * @param {(id: string) => ({ id: string, parentId: string|null } | undefined)} getTask
 */
export function assertNoCycle(childId, parentId, getTask) {
  const seen = new Set([childId]);
  let cursor = parentId;
  while (cursor) {
    if (seen.has(cursor)) {
      throw new TbError("PARENT_CYCLE", "父子关系会形成环，已拒绝", {
        childId,
        parentId,
        at: cursor,
      });
    }
    seen.add(cursor);
    const node = getTask(cursor);
    if (!node) break;
    cursor = node.parentId ?? null;
  }
}

/**
 * 治理校验（FR-07）：能力位默认关闭（核心层不拦截）；打开后按约定拒绝智能体的越权动作。
 * @param {{ actor: string, from: string|null, to: string }} change
 * @param {{ enforce: boolean, blockAgentClaimFromBacklog: boolean }} policy
 */
export function checkGovernance(change, policy = GOVERNANCE_DEFAULTS) {
  if (!policy?.enforce) return null;
  const actor = change.actor ?? "human";
  if (actor !== "agent") return null;
  if (change.to === "done") {
    return new TbError("AGENT_CANNOT_SET_DONE", "智能体不能把任务置为 done（FR-07：完成必须由人确认）", {
      from: change.from,
      to: change.to,
    });
  }
  if (policy.blockAgentClaimFromBacklog && change.from === "backlog" && change.to !== "backlog") {
    return new TbError(
      "AGENT_CANNOT_CLAIM_BACKLOG",
      "智能体不能推进 backlog 任务（FR-07：未授权不得开工）",
      { from: change.from, to: change.to },
    );
  }
  return null;
}

/** 按优先级排序（紧急在前），同优先级按 created_at 升序 → 稳定可预期（FR-08/FR-15）。 */
export function compareByPriority(a, b) {
  const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (rankDiff !== 0) return rankDiff;
  return String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? ""));
}
