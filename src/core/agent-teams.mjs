/**
 * agent-teams.mjs —— 列出"可用于执行的团队"（供工作台配置页做"任务执行团队选择"）。
 *
 * 来源：
 *  - official  : DSH 官方自带「智能体团队」(spawn_teammate / team_task_*) —— 不落本项目文件，作为常驻选项。
 *  - third-party: 工作区 `.agent-teams/<teamId>/team.json`（如 @nanmicoder/dsh-agent-teams）。
 * （工作台本地 team_runs 由 store 侧提供。）
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const OFFICIAL_TEAM = {
  id: "official",
  name: "DSH 官方自带 · 智能体团队（编队）",
  source: "official",
  phase: "dsd-side",
  memberCount: null,
  members: [],
  taskCount: null,
  note: "由队长用 spawn_teammate 召集；编队页可见；不落项目文件",
};

/**
 * 扫描工作区 `.agent-teams/*`（第三方引擎）。
 * 只保留"由本项目主会话创建"的团队：`captainSessionId === mainSessionId`（未提供则全量）。
 */
export async function scanAgentTeams(workspacePath, { mainSessionId = null } = {}) {
  if (!workspacePath) return [];
  const root = join(workspacePath, ".agent-teams");
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    try {
      const j = JSON.parse(await readFile(join(root, entry.name, "team.json"), "utf8"));
      const captainSessionId = j.captainSessionId ?? null;
      if (mainSessionId && captainSessionId && captainSessionId !== mainSessionId) continue; // 非主会话创建 → 不列
      out.push({
        id: j.id ?? entry.name, name: j.name ?? entry.name, source: "third-party",
        phase: j.phase ?? null, memberCount: (j.members || []).length,
        members: (j.members || []).map((m) => m.name), taskCount: (j.tasks || []).length,
        captainSessionId,
      });
    } catch { /* 跳过非法 */ }
  }
  return out;
}
