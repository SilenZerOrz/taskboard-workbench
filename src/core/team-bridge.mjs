/**
 * team-bridge.mjs —— 团队任务 ↔ 看板卡映射（**只读同步器** · 卡 `-247` / 需求 `R178` ④）。
 *
 * ## 背景：两套系统零桥接
 *
 * | 侧 | 真源 | 与看板卡的关联 |
 * | --- | --- | --- |
 * | 工作台本地 | `team_runs` / `team_members` / `team_tasks`（`POST /api/teams/:id/tasks` 写入） | `team_tasks.task_id → tasks.id`，**真外键** |
 * | 承载环境 agent-team 插件 | 工作区 `.agent-teams/<team>/team.json`（插件写） | **无字段**：插件任务只有自己的 `t1/t2/…` |
 *
 * 真机读数（2026-11-12 · `R178` ④）：`team_tasks` 18 行全是 10 月旧队，`scada-vibe` 项目 **0 行**；
 * 插件侧 `scada-vibe-squad` 8 条团队任务在跑，但看板侧查不到任何 t-id —— 两套系统平行。
 *
 * ## 口径（方案二 + 方案三兜底）
 *
 * 插件侧任务与看板卡的关联**只存在于文本里**（任务描述 / 产出 / 验收结果里出现卡号），
 * 插件**没有**卡号字段 ⇒ 本模块用「**项目自有卡号全词命中**」推导，并**保留证据**（命中字段 + 片段）。
 *
 * - 命中 ⇒ 该卡可反查团队侧 `t-id`；
 * - 未命中 ⇒ **明文声明**「看板只展示、不参与团队状态」（不是"查不到就是没有"，是明说边界）。
 *
 * ## 只读纪律（硬约束）
 *
 * - **不写 `team_tasks`**：那张表上有 `team_tasks_active_lock`（同一卡只允许一个活跃团队任务），
 *   把插件团队写进去会让看板侧的合法派发被 `TASK_LOCKED` 挡死 ⇒ 写库方案天然带这个雷。
 * - **不改 `.agent-teams/**`**：那是宿主插件的产物（卡面「不改宿主插件」）。
 * - **不改 schema、不动历史数据**。
 * - 推导结果**不入库**，每次请求现读现算 ⇒ 没有第二份真源，也就没有漂移。
 *
 * 本模块**刻意不复用** `src/core/agent-teams.mjs` 的扫描器：那个只返回团队摘要（成员数 / 任务数），
 * 本模块要任务全文；改它会给既有 `GET /api/projects/:id/agent-teams` 带来回归风险。
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 映射口径标识（回包里如实带出，别让人以为这是真外键）。 */
export const BRIDGE_MODE = "read-only-sync";

/** 明文声明（卡面「或明文声明『看板只展示不参与状态』」的落点；未命中映射时逐字展示）。 */
export const BRIDGE_POLICY_TITLE = "看板只展示、不参与团队状态";

export const BRIDGE_POLICY = [
  "两套系统并列：工作台本地（team_runs/team_members/team_tasks）与承载环境 agent-team 插件（工作区 .agent-teams/<team>/team.json）**各自记账、互不驱动**。",
  `本映射是**只读推导**（${BRIDGE_MODE}）：插件侧任务没有卡号字段，映射由「项目自有卡号在团队任务文本里全词命中」得出，并附命中字段与片段。`,
  `未命中映射的卡：${BRIDGE_POLICY_TITLE} —— 看板侧状态与团队侧状态互不影响；看板的「完成」仍只能由人确认。`,
  "回滚：本映射不写任何表、不改任何文件 ⇒ 回滚＝撤掉本路由与前端展示，历史数据零影响。",
].join("\n");

const MAX_DEPTH = 6;
const SNIPPET_PAD = 40;

/* ───────────────────────── 只读扫描：插件侧团队 ───────────────────────── */

/**
 * 读工作区 `.agent-teams/*\/team.json`（**只读**）。
 *
 * @param {string|null} workspacePath
 * @returns {Promise<Array<{id:string,name:string,phase:string|null,captainSessionId:string|null,memberCount:number,taskCount:number,tasks:Array<object>}>>}
 */
export async function readPluginTeams(workspacePath) {
  if (!workspacePath) return [];
  const root = join(workspacePath, ".agent-teams");
  let entries = [];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return []; // 工作区没有 .agent-teams/ 或读不到 ⇒ 空（不是错误）
  }
  const teams = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "archive") continue;
    let raw = null;
    try {
      raw = await readFile(join(root, entry.name, "team.json"), "utf8");
    } catch {
      continue;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue; // 非法 JSON ⇒ 跳过（不猜）
    }
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    teams.push({
      id: parsed?.id ?? entry.name,
      name: parsed?.name ?? entry.name,
      phase: parsed?.phase ?? null,
      captainSessionId: parsed?.captainSessionId ?? null,
      memberCount: Array.isArray(parsed?.members) ? parsed.members.length : 0,
      taskCount: tasks.length,
      tasks: tasks.map((task) => ({
        id: task?.id ?? null,
        subject: task?.subject ?? null,
        status: task?.status ?? null,
        assignee: task?.assignee ?? null,
        kind: task?.kind ?? null,
        dependencies: Array.isArray(task?.dependencies) ? task.dependencies : [],
        fields: collectFields(task),
      })),
    });
  }
  return teams;
}

/** 对外回包用的精简形状（**去掉 `fields` 全文**，避免把插件产出整段搬进接口）。 */
export function slimPluginTeam(team) {
  return {
    id: team.id,
    name: team.name,
    phase: team.phase,
    captainSessionId: team.captainSessionId,
    memberCount: team.memberCount,
    taskCount: team.taskCount,
  };
}

/* ───────────────────────── 映射推导 ───────────────────────── */

/**
 * 单卡反查：这张卡在插件侧命中哪几个 `t-id`。
 *
 * @param {string} identifier 看板卡号（如 `scada-vibe-3`）
 * @param {Array} teams `readPluginTeams` 的结果
 */
export function mapCardToTeamTasks(identifier, teams) {
  const target = String(identifier ?? "").trim();
  if (!target) return [];
  const matcher = buildMatcher([target]);
  if (!matcher) return [];
  const rows = [];
  for (const team of teams ?? []) {
    for (const task of team.tasks ?? []) {
      const hits = findHits(task.fields, matcher);
      if (!hits.length) continue;
      rows.push({
        teamId: team.id,
        teamName: team.name,
        teamPhase: team.phase ?? null,
        teamTaskId: task.id,
        teamTaskSubject: task.subject ?? null,
        teamTaskStatus: task.status ?? null,
        teamTaskKind: task.kind ?? null,
        assignee: task.assignee ?? null,
        dependencies: task.dependencies ?? [],
        evidence: hits.map(({ field, snippet }) => ({ field, snippet })),
      });
    }
  }
  return rows;
}

/**
 * 项目级映射表：项目全部卡 × 插件侧团队任务。
 *
 * @param {{cards: Array<{id:string,identifier:string,title?:string,status?:string}>, teams: Array}} input
 */
export function buildCardTaskMap({ cards, teams } = {}) {
  const cardList = (cards ?? []).map((card) => ({
    id: card?.id ?? null,
    identifier: card?.identifier ?? null,
    title: card?.title ?? null,
    status: card?.status ?? null,
  }));
  const matcher = buildMatcher(cardList.map((card) => card.identifier));
  const rows = [];
  const mappedCardIds = new Set();
  if (matcher) {
    for (const team of teams ?? []) {
      for (const task of team.tasks ?? []) {
        const hits = findHits(task.fields, matcher);
        if (!hits.length) continue;
        const byIdentifier = new Map();
        for (const hit of hits) {
          if (!byIdentifier.has(hit.identifier)) byIdentifier.set(hit.identifier, []);
          byIdentifier.get(hit.identifier).push(hit);
        }
        for (const [identifier, evidence] of byIdentifier) {
          const card = cardList.find((c) => c.identifier === identifier);
          if (!card) continue;
          mappedCardIds.add(card.id);
          rows.push({
            cardId: card.id,
            cardIdentifier: card.identifier,
            cardTitle: card.title,
            cardStatus: card.status,
            teamId: team.id,
            teamName: team.name,
            teamPhase: team.phase ?? null,
            teamTaskId: task.id,
            teamTaskSubject: task.subject ?? null,
            teamTaskStatus: task.status ?? null,
            assignee: task.assignee ?? null,
            evidence: evidence.map(({ field, snippet }) => ({ field, snippet })),
          });
        }
      }
    }
  }
  const unmapped = cardList
    .filter((card) => !mappedCardIds.has(card.id))
    .map((card) => ({ id: card.id, identifier: card.identifier, title: card.title, status: card.status }));
  const stats = {
    cards: cardList.length,
    mappedCards: mappedCardIds.size,
    unmappedCards: unmapped.length,
    pluginTeams: (teams ?? []).length,
    pluginTasks: (teams ?? []).reduce((n, team) => n + (team?.tasks?.length ?? 0), 0),
    mappedRows: rows.length,
  };
  return { rows, unmapped, stats };
}

/* ───────────────────────── 内部工具 ───────────────────────── */

/** 递归收集对象里的所有字符串叶子（带字段路径）—— 命中证据要指得出"在哪个字段"。 */
function collectFields(value, path = "", out = [], depth = 0) {
  if (depth > MAX_DEPTH) return out;
  if (typeof value === "string") {
    if (value.length) out.push({ path: path || "(root)", text: value });
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFields(item, `${path}[${index}]`, out, depth + 1));
    return out;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) collectFields(item, path ? `${path}.${key}` : key, out, depth + 1);
  }
  return out;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 卡号全词匹配器。
 *
 * - 长的排前面（`scada-vibe-10` 必须排在 `scada-vibe-1` 前面，否则前者会被后者的否定前瞻挡成"不命中"）；
 * - 两侧用**字符类否定**而不是 `\b`：卡号里含 `-`，`\b` 会把 `scada-vibe-1` 的结尾边界算在 `-` 上 ⇒ 误判。
 */
function buildMatcher(identifiers) {
  const list = [...new Set((identifiers ?? []).map((x) => String(x ?? "").trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length || a.localeCompare(b),
  );
  if (!list.length) return null;
  const pattern = `(?<![A-Za-z0-9_-])(${list.map(escapeRegExp).join("|")})(?![A-Za-z0-9_-])`;
  return { pattern, regex: new RegExp(pattern, "g"), list };
}

/** 在字段集合里找命中（返回命中字段 + 片段）。 */
function findHits(fields, matcher) {
  if (!matcher) return [];
  const hits = [];
  for (const { path, text } of fields ?? []) {
    matcher.regex.lastIndex = 0;
    let match = matcher.regex.exec(text);
    while (match !== null) {
      hits.push({ identifier: match[1], field: path, snippet: snippetAround(text, match.index, match[0].length) });
      if (match.index === matcher.regex.lastIndex) matcher.regex.lastIndex += 1; // 防零宽死循环
      match = matcher.regex.exec(text);
    }
  }
  return hits;
}

function snippetAround(text, index, length) {
  const start = Math.max(0, index - SNIPPET_PAD);
  const end = Math.min(text.length, index + length + SNIPPET_PAD);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}
