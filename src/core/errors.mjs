/**
 * 统一错误与退出码（FR-21 / FR-33 契约）。
 *
 * 退出码：0 成功 · 2 输入错误 · 3 服务或存储不可用 · 4 数据或响应错误 · 5 冲突
 * 所有错误都带机器可读的 `code`，CLI 以 JSON 形式写到 stderr。
 */

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  SERVICE: 3,
  DATA: 4,
  CONFLICT: 5,
});

/** 类别 → 退出码的权威映射（新增错误码时必须在此登记类别）。 */
export const ERROR_CATEGORY = Object.freeze({
  // 输入/用法
  USAGE_ERROR: EXIT.USAGE,
  MISSING_FIELD: EXIT.USAGE,
  INVALID_FIELD: EXIT.USAGE,
  INVALID_ID: EXIT.USAGE,
  INVALID_STATUS: EXIT.USAGE,
  INVALID_PRIORITY: EXIT.USAGE,
  INVALID_LABEL: EXIT.USAGE,
  MISSING_VERSION: EXIT.USAGE,
  UNKNOWN_COMMAND: EXIT.USAGE,
  UNKNOWN_OPTION: EXIT.USAGE,
  // FR-03：删除项目必须先显式确认（缺确认 ⇒ 用法错误，避免误触删掉项目）
  PROJECT_DELETE_UNCONFIRMED: EXIT.USAGE,
  // FR-57（2026-10-29 修订 · A）：资料引入**只建索引、不产生条目**。
  // 旧 `mode:"items"/"both"` 显式拒绝（不静默降级成 doc-only）——「那条路不存在」要在契约层成立。
  INTAKE_ITEMS_DISABLED: EXIT.USAGE,

  // 存储不可用
  STORE_UNAVAILABLE: EXIT.SERVICE,
  DB_OPEN_FAILED: EXIT.SERVICE,

  // 数据/响应错误
  DATA_ERROR: EXIT.DATA,
  NOT_FOUND: EXIT.DATA,
  PROJECT_NOT_FOUND: EXIT.DATA,
  TASK_NOT_FOUND: EXIT.DATA,
  COMMENT_NOT_FOUND: EXIT.DATA,
  // FR-17 红线④：机器证据评论（【自动复核】…）一旦可能被评审引用，编辑即"改写证据"的旁路 ⇒ 拒绝编辑
  COMMENT_NOT_EDITABLE: EXIT.DATA,
  PARENT_NOT_FOUND: EXIT.DATA,
  PARENT_CROSS_PROJECT: EXIT.DATA,
  PARENT_ALREADY_SET: EXIT.DATA,
  PARENT_CYCLE: EXIT.DATA,
  REQUIREMENT_NOT_FOUND: EXIT.DATA,
  REQUIREMENT_DOC_NOT_FOUND: EXIT.DATA,
  CANDIDATE_NOT_FOUND: EXIT.DATA,
  DEPENDENCY_SELF: EXIT.USAGE,
  DEPENDENCY_CROSS_PROJECT: EXIT.DATA,
  DEPENDENCY_CYCLE: EXIT.DATA,
  SPLIT_EMPTY: EXIT.DATA,
  AI_OUTPUT_INVALID: EXIT.DATA,
  AI_UNAVAILABLE: EXIT.SERVICE,
  EXECUTION_NOT_AUTHORIZED: EXIT.DATA,
  EXECUTION_NOT_ATTRIBUTED: EXIT.DATA,
  EXECUTION_ALREADY_RUNNING: EXIT.CONFLICT,
  EXECUTION_CIRCUIT_OPEN: EXIT.CONFLICT,
  TASK_LOCKED: EXIT.CONFLICT,
  // 人工校验任务（FR-85b）：人在环升级门的拒绝类错误
  HUMAN_REVIEW_NOT_CLAIMABLE: EXIT.CONFLICT,
  HUMAN_REVIEW_NOT_EXECUTABLE: EXIT.CONFLICT,
  // 评审门（FR-83 补口 · 卡 `-162`）：待验收卡未评审通过就想收口 ⇒ 冲突类（可重试的同类语义：
  // "先评审"是可走通的另一条路），显式 skipReview=true 才是合法逃生口
  REVIEW_NOT_APPROVED: EXIT.CONFLICT,
  // 自动复核（FR-90）：项目没配工作区目录，没地方跑验证命令
  PROJECT_WORKSPACE_MISSING: EXIT.USAGE,
  HUMAN_REVIEW_ALREADY_EXISTS: EXIT.CONFLICT,
  HUMAN_REVIEW_ALREADY_CONCLUDED: EXIT.CONFLICT,
  HUMAN_REVIEW_PENDING: EXIT.CONFLICT,
  HUMAN_REVIEW_NOT_CONFIDENT: EXIT.DATA,
  HUMAN_REVIEW_CANNOT_DONE: EXIT.DATA,
  HUMAN_REVIEW_NOT_KIND: EXIT.DATA,
  HUMAN_REVIEW_DRAFT_INVALID: EXIT.DATA,
  GOVERNANCE_AGENT_DONE: EXIT.DATA,
  GOVERNANCE_REVIEW_BLOCKED: EXIT.DATA,
  TEAM_NOT_FOUND: EXIT.DATA,
  TEAM_TASK_NOT_FOUND: EXIT.DATA,
  // FR-50：团队模板非法（角色缺失 / 数量为 0 / 角色名不在契约集合内）⇒ 拒绝建队
  INVALID_TEAM_TEMPLATE: EXIT.USAGE,
  AGENT_CANNOT_CLAIM_BACKLOG: EXIT.DATA,
  AGENT_CANNOT_SET_DONE: EXIT.DATA,
  AGENT_CANNOT_FINALIZE: EXIT.DATA,

  // 冲突
  VERSION_CONFLICT: EXIT.CONFLICT,
  PROJECT_EXISTS: EXIT.CONFLICT,
  // FR-03：非空项目不得删除（仍有任务/需求条目/需求文档正文）⇒ 冲突，须先清空
  PROJECT_NOT_EMPTY: EXIT.CONFLICT,
  IDENTIFIER_CONFLICT: EXIT.CONFLICT,
  REQ_IDENTIFIER_CONFLICT: EXIT.CONFLICT,
  DEPENDENCY_EXISTS: EXIT.CONFLICT,
  DOC_EXISTS: EXIT.CONFLICT,
});

/** 领域错误：带 code / 退出码 / 可选细节。 */
export class TbError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "TbError";
    this.code = code;
    this.details = details;
    this.exitCode = ERROR_CATEGORY[code] ?? EXIT.DATA;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function usageError(message, details) {
  return new TbError("USAGE_ERROR", message, details);
}

export function invalidField(field, message, details) {
  return new TbError("INVALID_FIELD", message ?? `字段 ${field} 非法`, details);
}

export function notFound(kind, key) {
  return new TbError(kind, `未找到：${key}`, { key });
}

/** 对外统一出口：任何异常都转成 { error, exitCode }。 */
export function toErrorPayload(error) {
  if (error instanceof TbError) {
    return { error: error.toJSON(), exitCode: error.exitCode };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: { code: "DATA_ERROR", message },
    exitCode: EXIT.DATA,
  };
}
