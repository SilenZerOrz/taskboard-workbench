/**
 * team.mjs —— 切片3 团队领域纯函数层（FR-42/43）。
 * 只描述数据形状与状态映射；不调 agent-teams / 宿主运行时（那属宿主集成期）。
 *
 * 唯一权威原则：本项目库 = 任务记录权威；团队状态 = 执行权威；用 teamId + attemptId 关联；
 * **done 永不由执行侧写**（由治理层拦截，见 store 的 teamSetTaskStatus）。
 */
import { invalidField, TbError } from "./errors.mjs";

export const TEAM_RUN_STATUSES = Object.freeze(["staged", "running", "completed", "failed", "cancelled"]);
export const TEAM_MEMBER_STATUSES = Object.freeze(["ready", "idle", "running", "done"]);
export const TEAM_TASK_STATUSES = Object.freeze(["open", "running", "completed", "failed", "cancelled"]);
export const TEAM_TASK_KINDS = Object.freeze(["work", "review"]);
export const TEAM_ATTEMPT_RESULTS = Object.freeze(["passed", "failed"]);

export function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw invalidField(field, `${field} 必须是 ${allowed.join(" / ")} 之一，收到：${JSON.stringify(value)}`);
  return value;
}

/**
 * 状态映射表：本项目 7 状态 ↔ 团队（agent-teams 视觉/执行）状态。
 * 说明：`backlog` 不派发（未授权开工）；`done` 由人工置，执行侧不可写。
 *
 * 语义约定（2026-10-13 裁决）：**部分完成 = run.status = "completed" 且存在 blocked 子任务**；
 * 不引入独立 partial 状态，不加新状态、不改本映射。
 */
export const STATUS_MAPPING = Object.freeze({
  projectToTeam: Object.freeze({
    backlog: null,          // 不派发
    todo: "open",           // 就绪可领取
    in_progress: "running",
    in_review: "completed", // 已提交，待人工验收
    done: "completed",      // 终态（人工确认）
    blocked: "failed",      // 受阻
    canceled: "cancelled",
  }),
  teamToProject: Object.freeze({
    open: "todo",
    running: "in_progress",
    completed: "in_review", // 执行侧完成 → 只到"待验收"
    failed: "blocked",
    cancelled: "canceled",
  }),
});

/** 执行侧允许写入的项目状态（**不含 done**）。 */
export const TEAM_WRITABLE_STATUSES = Object.freeze(["in_progress", "in_review", "blocked", "canceled"]);

/**
 * FR-50：团队模板的**角色集合**——权威来源是 `spec/团队agent.md` §一 的角色表（id 列）。
 * 只认这 6 个派发角色；用于创建团队时校验模板里出现的角色名。
 */
export const TEAM_ROLES = Object.freeze(["lead", "planner", "engineer", "tester", "reviewer", "archivist"]);

/** FR-50：单角色**默认数量**（模板未写 `count` 时按 `spec/团队agent.md` 的默认编制取 1）。 */
export const DEFAULT_ROLE_COUNT = 1;

/**
 * FR-50：单角色数量的**上限**（防止模板写一个大数把一次建队放大成海量成员行）。
 * 契约里的角色只有 6 个、编制都是个位数量级，正常模板永远碰不到这条；
 * 超过上限一律按「模板非法」拒绝（reason=`role-count-too-large`），**不静默截断**。
 */
export const MAX_ROLE_COUNT = 50;

/**
 * FR-50：**质量门顺序**的契约集合——权威来源是 `spec/团队agent.md` §二 第 4 项
 * 「quality gates：质量门顺序（默认 `需求→实现→验证→审查→集成`）」。
 *
 * 该数组顺序即**默认链路**（未配置时回落它）；配置值只允许取自这 5 个门名。
 */
export const QUALITY_GATES = Object.freeze(["需求", "实现", "验证", "审查", "集成"]);

/**
 * FR-50：解析模板里的**质量门顺序**（纯函数，无副作用）。
 *
 * 口径（与裁定口径一致）：
 *   · **未配置 ⇒ 不算非法**：`undefined` / `null` / 空数组一律视作"未配置"，
 *     回落 `QUALITY_GATES` 默认链，`source = "default"`（向后兼容，老模板不受影响）。
 *   · 已配置 ⇒ 顺序**完全等于数组声明顺序**（不做去重、不重排、不补默认项），`source = "configured"`。
 *   · 宽容之处：条目两端空白会被 trim（`" 需求 "` 视同 `"需求"`）。
 * 返回 `{ gates, source }`；**合法性**由 `assertTeamTemplate` 判定（本函数不抛错）。
 */
export function normalizeQualityGates(tpl) {
  const raw = tpl?.qualityGates;
  if (!Array.isArray(raw) || raw.length === 0) return { gates: [...QUALITY_GATES], source: "default" };
  const gates = raw.map((g) => (typeof g === "string" ? g.trim() : g));
  return { gates, source: "configured" };
}

/** FR-50：`normalizeQualityGates` 产物的**合法**判定（已配置但取值越界 ⇒ 非法）。 */
export function assertQualityGates(tpl) {
  const { gates, source } = normalizeQualityGates(tpl);
  if (source === "default") return { gates, source };
  gates.forEach((gate, index) => {
    if (!QUALITY_GATES.includes(gate)) {
      throw new TbError("INVALID_TEAM_TEMPLATE", `团队模板非法：第 ${index + 1} 个质量门 ${JSON.stringify(gate ?? null)} 不在契约集合内（${QUALITY_GATES.join(" / ")}）`, { reason: "quality-gate-unknown", field: `qualityGates[${index}]`, gate: gate ?? null, allowed: [...QUALITY_GATES] });
    }
  });
  return { gates, source };
}

/**
 * FR-50 验收第三条（模板非法 ⇒ 拒绝）：`assertTeamTemplate(tpl)`。
 *
 * 纯函数，**不产生任何副作用**（不写库、不建 run）——调用方须在**建团队之前**调用它。
 * 校验三条（全部命中即抛 `INVALID_TEAM_TEMPLATE`，`details.reason` 指明是哪一条）：
 *   ① `roles` 缺失或为空数组 ⇒ 拒绝（reason=`roles-missing-or-empty`）；
 *   ② 任一角色 `count` 不是正整数（`0` / 负数 / 非数 / 小数）⇒ 拒绝（reason=`role-count-invalid`）；
 *   ②b 任一角色 `count` **超过 `MAX_ROLE_COUNT`**（50）⇒ 拒绝（reason=`role-count-too-large`；防放大）；
 *   ③ 角色名不在 `TEAM_ROLES`（即 `spec/团队agent.md` 定义的角色集合）内 ⇒ 拒绝（reason=`role-unknown`）；
 *   ④ `qualityGates` **已配置但取值越界** ⇒ 拒绝（reason=`quality-gate-unknown`；**未配置不算非法**，见 `assertQualityGates`）。
 *
 * 宽容之处（与团队契约的默认编制一致，不算非法）：`count` 缺省视为 `DEFAULT_ROLE_COUNT`（1）；
 * 角色条目允许是字符串（`"engineer"`）或对象（`{ role, count, model, executor }`）。
 * 返回**规范化**后的角色列表 `[{ role, count }]`，供调用方装配成员（不改变入参对象）。
 */
export function assertTeamTemplate(tpl) {
  const roles = tpl?.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new TbError("INVALID_TEAM_TEMPLATE", "团队模板非法：roles 缺失或为空（FR-50：角色缺失 ⇒ 拒绝建队）", { reason: "roles-missing-or-empty", field: "roles" });
  }
  const normalized = [];
  roles.forEach((entry, index) => {
    const role = typeof entry === "string" ? entry : entry?.role;
    if (!TEAM_ROLES.includes(role)) {
      throw new TbError("INVALID_TEAM_TEMPLATE", `团队模板非法：第 ${index + 1} 个角色的名字 ${JSON.stringify(role ?? null)} 不在团队契约的角色集合内（${TEAM_ROLES.join(" / ")}）`, { reason: "role-unknown", field: `roles[${index}].role`, role: role ?? null, allowed: [...TEAM_ROLES] });
    }
    const rawCount = typeof entry === "string" ? undefined : entry?.count;
    const count = rawCount === undefined || rawCount === null ? DEFAULT_ROLE_COUNT : rawCount;
    if (!Number.isInteger(count) || count <= 0) {
      throw new TbError("INVALID_TEAM_TEMPLATE", `团队模板非法：角色 ${role} 的数量 ${JSON.stringify(rawCount ?? count)} 不是正整数（FR-50：数量为 0 ⇒ 拒绝建队）`, { reason: "role-count-invalid", field: `roles[${index}].count`, role, count: rawCount ?? count });
    }
    if (count > MAX_ROLE_COUNT) {
      throw new TbError("INVALID_TEAM_TEMPLATE", `团队模板非法：角色 ${role} 的数量 ${count} 超过上限 ${MAX_ROLE_COUNT}（防止一次建队放大成海量成员行）`, { reason: "role-count-too-large", field: `roles[${index}].count`, role, count, max: MAX_ROLE_COUNT });
    }
    normalized.push({ role, count });
  });
  // ④ 质量门顺序：**已配置但越界**才拒绝（未配置回落默认链，不算非法）。
  assertQualityGates(tpl);
  return normalized;
}

/**
 * FR-50 验收第一条（**装配计划**，纯函数，无副作用）：
 * 「Given 一份团队模板，When 创建团队，Then 按模板生成成员（角色 / 模型 / 执行器）」。
 *
 * 把**已校验**的模板角色表展开成「一个成员一行」的计划：
 *   · `count` 缺省 ⇒ `DEFAULT_ROLE_COUNT`（1）；`count:2` ⇒ **同角色 2 个成员**（不是 1 个）；
 *   · `model` / `executor` 逐字带下去（字符串条目 ⇒ 两者为 `null`＝"未配置"）；
 *   · **顺序 = 模板声明顺序**（同一角色内部按 1..count 排），调用方按序 insert 即可。
 *
 * 与 `assertTeamTemplate` 的分工：**合法性由门判**（本函数不抛错，也不放宽门）；
 * `count` 非法时这里兜底为 1，只用于「门已被绕过」的极端情形，不放大成员数。
 * 返回 `[{ role, model, executor }]`（**不改动入参对象**）。
 */
export function planTeamMembers(roles) {
  const plan = [];
  for (const entry of Array.isArray(roles) ? roles : []) {
    const role = typeof entry === "string" ? entry : entry?.role;
    if (role === undefined || role === null || role === "") continue;
    const rawCount = typeof entry === "string" ? undefined : entry?.count;
    const count = rawCount === undefined || rawCount === null ? DEFAULT_ROLE_COUNT : rawCount;
    const times = Number.isInteger(count) && count > 0 ? count : DEFAULT_ROLE_COUNT;
    const model = typeof entry === "string" ? null : (entry?.model ?? null);
    const executor = typeof entry === "string" ? null : (entry?.executor ?? null);
    for (let i = 0; i < times; i += 1) plan.push({ role: String(role), model, executor });
  }
  return plan;
}
