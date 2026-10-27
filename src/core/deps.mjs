/**
 * deps.mjs —— 任务依赖（blocks）纯函数层（FR-39）。
 * 有向依赖 A blocks B；同项目、无自环、无环。环检测的权威实现基于存储层递归 CTE，
 * 本模块提供可单测的纯函数版本（供 domain 层复用）。
 */
import { TbError, invalidField } from "./errors.mjs";

/** 断言：不能自环。 */
export function assertNotSelfDependency(blockerId, blockedId) {
  if (blockerId === blockedId) {
    throw new TbError("DEPENDENCY_SELF", "任务不能依赖自己", { taskId: blockerId });
  }
}

/** 断言：依赖两端必须同项目。 */
export function assertSameProjectDependency(blocker, blocked) {
  if (blocker.projectId !== blocked.projectId) {
    throw new TbError(
      "DEPENDENCY_CROSS_PROJECT",
      `依赖不能跨项目（前置 ${blocker.projectId}，后继 ${blocked.projectId}）`,
      { blockerProjectId: blocker.projectId, blockedProjectId: blocked.projectId },
    );
  }
}

/**
 * 环检测（纯函数版）：新增 blocker→blocked 是否成环。
 * 成环 ⇔ 沿现有 blocker→blocked 边，从 `blockedId` 能回到 `blockerId`。
 * @param {string} blockerId
 * @param {string} blockedId
 * @param {(id: string) => string[]} dependentsOf 返回某任务的直接后继（blocked）列表
 */
export function assertNoDependencyCycle(blockerId, blockedId, dependentsOf) {
  const seen = new Set();
  const stack = [blockedId];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === blockerId) {
      throw new TbError("DEPENDENCY_CYCLE", "依赖会形成环，已拒绝", { blockerId, blockedId });
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of dependentsOf(cur) ?? []) stack.push(nxt);
  }
}

/** 断言：blocker 不是 blocked 的必填字段缺失。 */
export function requireTaskRef(task, ref) {
  if (!task) throw new TbError("TASK_NOT_FOUND", `任务不存在：${ref}`, { ref });
  return task;
}

export { invalidField };
