/**
 * 会话命名口径（2026-10-23 用户新增约束）。
 *
 * 用户口径（原话）：
 *   1. 由任务看板下发的会话，统一「**【任务】+ 任务标题 + 时间**」；
 *   2. 项目主会话统一「**【项目】+ 项目名称**」；**重载 / 重绑**的，名称后跟备注；
 *   3. 其他会话（专属文档 / 修复 / 评审 …）在任务会话约束**基础上额外备注**。
 *
 * 为什么做成纯函数：命名是**可判定的口径**，不该在调用点各拼一次字符串 —— 单测直接钉住字符串形状，
 * 调用点只负责提供「标题 / 项目名 / 备注」。
 *
 * ⚠️ 宿主约束（实测契约）：DSH 的 `sessionController.create()` **不接受 title**
 * （`SessionCreateRequest` 只有 `workspaceId / cwd / sessionId / agentPreset`），只有
 * `rename({ sessionId, title })`。故一律**建完再改名**（见 `index.js` 的宿主端口），
 * 且改名失败要**如实回原因**，不谎报成功。
 */
export const TASK_PREFIX = "【任务】";
export const PROJECT_PREFIX = "【项目】";

/** 其他会话的备注词表（口径 3）。**未收录的 kind 一律回 `null`** —— 不臆造备注。 */
export const NOTE_KINDS = Object.freeze({
  doc: "专属文档",
  fix: "修复",
  review: "评审",
  test: "测试",
  design: "设计",
  rebuild: "重建",
  rebind: "重绑",
});

export function noteForKind(kind) {
  if (typeof kind !== "string") return null;
  const key = kind.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(NOTE_KINDS, key) ? NOTE_KINDS[key] : null;
}

/** 把多行 / 多余空白压成单行并限长（会话名是一行，别把整段描述灌进去）。 */
export function cleanLabel(text, { max = 80 } = {}) {
  const s = String(text ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  if (max > 0 && s.length > max) return `${s.slice(0, max - 1)}…`;
  return s;
}

/** 时间戳（本地时区，分钟精度）：`2026-10-23 12:40`。取不到有效时间回空串（调用方不拼半个时间）。 */
export function formatStamp(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 口径 1 / 3：`【任务】<标题> · <时间>`，带备注时 `…（<备注>）`。 */
export function taskSessionTitle(title, { at = new Date(), note = null } = {}) {
  const head = `${TASK_PREFIX}${cleanLabel(title) || "（无标题）"}`;
  const stamp = formatStamp(at);
  const tail = note ? `（${cleanLabel(note, { max: 30 })}）` : "";
  return stamp ? `${head} · ${stamp}${tail}` : `${head}${tail}`;
}

/** 口径 2：`【项目】<项目名称>`；重载 / 重绑时 `…（<备注>）`。 */
export function projectMainSessionTitle(name, { note = null } = {}) {
  const head = `${PROJECT_PREFIX}${cleanLabel(name) || "（未命名项目）"}`;
  return note ? `${head}（${cleanLabel(note, { max: 30 })}）` : head;
}
