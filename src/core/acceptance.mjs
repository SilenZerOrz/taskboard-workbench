/**
 * acceptance.mjs —— 「验收标准缺省」的**唯一**口径入口（卡 `-176` / `-177`，2026-10-29）。
 *
 * 背景（口径 **X**，人拍板于 2026-10-29）：`requirement_items.acceptance` **不做必填、不改 schema**。
 * 实测 129 条里 **99 条 acceptance 为空**，而「空」与「当初没收集」不可辨 —— 强制必填会一刀切破
 * 「改标题」这类无关操作；schema 迁移不可逆，审计 join 可查。故取**显式缺口标记**：
 *
 *   · 回包 `acceptanceSet:false` —— 调用方一眼看出「这条没有验收口径」，而不是拿到一个看似成功的 201；
 *   · 缺省落一条 `governance_audit`（`action = requirement-acceptance-missing`）
 *     —— 「当初给没给验收」可事后按 `target = 条目编号` 查审计，不必加列。
 *
 * 纪律来源（产品内既有先例）：`-172` 把「失败被包装成成功」改成显式
 * （`AI_UNAVAILABLE` / `fallback:"rule"` / `dryRun`）—— 同一纪律套到 acceptance 上就是「显式缺口」。
 *
 * **HTTP 与 MCP 必须共用本文件**：两条写入口各写一份判断必然漂移 —— `-176` / `-177` 本来就是
 * 「同一个缺口的两半」，各修各的就会长出两个口径。
 *
 * 落审计的**边界**（刻意如此，防审计洪水）：只有**这次写入碰了 `acceptance`** 才落审计
 * （新建条目 = 每次；改条目 = 仅当 patch 里带 `acceptance`）。`acceptanceSet` 则**永远**反映写入后的
 * 真实状态 —— 于是一条 99/129 的空验收条目改标题时，回包照样会诚实告诉你 `acceptanceSet:false`，
 * 但不会给审计表再添一行。
 */

export const ACCEPTANCE_MISSING_ACTION = "requirement-acceptance-missing";

/** 「没给验收」的判定：`null` / `undefined` / 纯空白都算缺省（与 store 侧清空语义一致）。 */
export function isAcceptanceMissing(value) {
  return value == null || String(value).trim() === "";
}

/**
 * 给一次需求条目写入打「验收缺口」标记。
 *
 * @param {{recordAudit:Function}} store
 * @param {{identifier?:string|null, acceptance?:any, actor?:string, entry?:string, detail?:object|null}} opts
 *   `entry` 必填语义上是「哪条写路径」（如 `mcp:requirement_upsert` / `http:POST /api/requirements/items`），
 *   进 `governance_audit.reason`，便于按入口统计缺口。
 * @returns {{acceptanceSet:boolean, auditId:string|null}}
 */
export function markAcceptance(store, { identifier = null, acceptance = null, actor = "human", entry = "unknown", detail = null } = {}) {
  if (!isAcceptanceMissing(acceptance)) return { acceptanceSet: true, auditId: null };
  let auditId = null;
  try {
    auditId = store.recordAudit({
      actor,
      action: ACCEPTANCE_MISSING_ACTION,
      target: identifier,
      allowed: true,
      reason: entry,
      detail: JSON.stringify({ entry, identifier, ...(detail && typeof detail === "object" ? detail : {}) }),
    });
  } catch { auditId = null; } // 审计是旁证不是阻断：写审计失败不得让业务写入失败（与 contract-warn 同口径）
  return { acceptanceSet: false, auditId };
}

/**
 * 只读版：给「这次写入没碰 acceptance」的路径算回包标记（**不落审计**）。
 * @returns {{acceptanceSet:boolean, auditId:null}}
 */
export function acceptanceFlag(acceptance) {
  return { acceptanceSet: !isAcceptanceMissing(acceptance), auditId: null };
}
