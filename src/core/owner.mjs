/**
 * owner.mjs —— 负责人（owner）的一等字段辅助：规范化 + 历史标签约定的迁移解析。
 *
 * 背景：t21 用 `owner:<role>` 标签承载负责人；t24 起 owner 是 tasks 表的正式列，
 * 本模块只保留「读取历史标签」的能力用于一次性迁移，新数据一律写 owner 列。
 */
import { TbError } from "./errors.mjs";

/** 历史标签前缀（仅迁移期使用） */
export const OWNER_LABEL_PREFIX = "owner:";
export const OWNER_MAX_LENGTH = 40;

/** 规范化 owner：trim、压缩内部空白、空串 → null；超长报错。 */
export function normalizeOwner(value) {
  if (value === undefined || value === null) return null;
  const owner = String(value).trim().replace(/\s+/g, " ");
  if (owner === "") return null;
  if (owner.length > OWNER_MAX_LENGTH) {
    throw new TbError("INVALID_FIELD", `owner 过长（上限 ${OWNER_MAX_LENGTH}）：${owner}`);
  }
  return owner;
}

/**
 * 从 labels 中拆出历史 owner 标签。
 * @returns {{ owner: string, labels: string[] }} owner 为空串表示没有历史标签；labels 已剔除 owner 标签。
 */
export function splitOwnerLabels(input) {
  const labels = Array.isArray(input) ? input : [];
  const kept = [];
  let owner = "";
  for (const item of labels) {
    if (typeof item === "string" && item.startsWith(OWNER_LABEL_PREFIX)) {
      const value = item.slice(OWNER_LABEL_PREFIX.length).trim();
      if (value) owner = value;
      continue;
    }
    kept.push(item);
  }
  return { owner, labels: kept };
}
