/**
 * flow-block.mjs —— 「装载块」的唯一生成器（P4 · 2026-10-29）
 *
 * 三档开局（档 A 人贴 / 档 B 外部 agent 约定 / 将来的档 C 宿主注入）**必须产出同一份文本**，
 * 否则会出现三份不同的说明书 —— 这正是本仓过去栽过的坑（同名两条 SOP，谁都不知道信哪个）。
 *
 * 所以这里只有一处实现：
 *   · `node scripts/tb-flow.mjs start`        → `buildFlowBlock()`
 *   · MCP prompt `taskboard.flow`             → `buildFlowBlock()`
 *   · 将来的宿主注入（档 C）                  → 也调 `buildFlowBlock()`
 *
 * **不复制 SKILL.md 的正文**：八步表格与五条硬规则都从 `skills/taskboard-flow/SKILL.md`
 * 的标记区间里**原样抽取**（`<!-- flow-block:steps -->` / `<!-- flow-block:rules -->`）。
 * 这样 skill 改了，装载块跟着改；本文件永远不会"自己长出一份规则"。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { PKG_ROOT, deriveFlowNext, projectGaps, resolveProject } from "./tools.mjs";

export const SKILL_DIR = path.join(PKG_ROOT, "skills", "taskboard-flow");
export const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");

const STEPS_OPEN = "<!-- flow-block:steps -->";
const STEPS_CLOSE = "<!-- /flow-block:steps -->";
const RULES_OPEN = "<!-- flow-block:rules -->";
const RULES_CLOSE = "<!-- /flow-block:rules -->";

function sliceBetween(text, open, close) {
  const i = text.indexOf(open);
  const j = text.indexOf(close);
  if (i < 0 || j < 0 || j <= i) return "";
  return text.slice(i + open.length, j).trim();
}

/** 读 SKILL.md 的 frontmatter（只支持本项目用到的 `key: value` 平铺形状）。 */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    } else {
      value = value.replace(/^["']|["']$/g, "");
      if (/^\d+$/.test(value)) value = Number(value);
    }
    out[kv[1]] = value;
  }
  return out;
}

/** 只读：把 skill 的三段（meta / 八步 / 五条硬规则）取出来。 */
export function readSkill() {
  if (!existsSync(SKILL_PATH)) {
    throw new Error(`skill 缺失：${SKILL_PATH}（打包时请确认 package.json#files 含 "skills"）`);
  }
  const text = readFileSync(SKILL_PATH, "utf8");
  const meta = parseFrontmatter(text);
  const steps = sliceBetween(text, STEPS_OPEN, STEPS_CLOSE);
  const rules = sliceBetween(text, RULES_OPEN, RULES_CLOSE);
  if (!steps) throw new Error(`SKILL.md 缺少八步标记区间（${STEPS_OPEN} … ${STEPS_CLOSE}）`);
  if (!rules) throw new Error(`SKILL.md 缺少硬规则标记区间（${RULES_OPEN} … ${RULES_CLOSE}）`);
  return { meta, steps, rules, path: SKILL_PATH, relPath: "skills/taskboard-flow/SKILL.md" };
}

const shortDigest = (d) => (typeof d === "string" && d.length >= 8 ? `${d.slice(0, 8)}…` : "（未取到）");

/**
 * 生成装载块（纯读：不写库、不建目录）。
 *
 * @returns {{text:string, project:object, contract:object, gaps:object, nextStep:object, skill:object}}
 */
export function buildFlowBlock({ store, project, cwd, matchedBy } = {}) {
  const skill = readSkill();
  const resolved = project && typeof project === "object"
    ? { project, matchedBy: matchedBy ?? "explicit" }
    : resolveProject(store, { project, cwd });
  const { tasks, items, gaps } = projectGaps(store, resolved.project);
  const nextStep = deriveFlowNext({ tasks, items, gaps });
  const snap = store.contractSnapshot(resolved.project.id);
  const snapVersion = snap.snapshot.contractVersion;
  const normOf = (id) => (snap.snapshot.norms ?? []).find((n) => n.id === id);
  const changed = Array.isArray(snap.changed?.changedFiles) ? snap.changed.changedFiles : [];

  const lines = [
    "# 任务看板主流程 · 装载块",
    "",
    `> 由 taskboard-workbench 生成（skill \`taskboard-flow@v${skill.meta.version ?? "?"}\` · 契约 \`${snapVersion}\`）。`,
    "> 把这一整块当本轮上下文即可开工；**下面第 4 节的八步是全文，不要只看摘要**。",
    "",
    "## 1. 项目",
    "",
    `- id：\`${resolved.project.id}\``,
    `- 名称：${resolved.project.name}`,
    `- 工作区：${resolved.project.workspacePath ? `\`${resolved.project.workspacePath}\`` : "（未设置）"}`,
    `- 主会话：${resolved.project.initialSessionId ? `\`${resolved.project.initialSessionId}\`` : "**未绑定**（投递会落空）"}`,
    `- 匹配方式：${resolved.matchedBy}`,
    "",
    "## 2. 契约",
    "",
    `- contract_version：\`${snapVersion}\``,
    `- 规范：${(snap.snapshot.norms ?? []).map((n) => `${n.id}@v${n.version}(${shortDigest(n.digest)})`).join(" · ")}`,
    `- 与基线比对：${snap.stale ? `**已漂移**（${changed.join(" / ") || "未报出文件"}）—— 先读变更部分再动手` : "一致"}`,
    `- 门档：${Object.entries(snap.snapshot.gates ?? {}).map(([k, v]) => `${k}=${v}`).join(" · ")}`,
    "",
    "## 3. 现在缺什么（gaps）",
    "",
    `- 未归因卡：**${gaps.unattributedTasks}**${gaps.unattributedTasks ? `（先补归因再派发，否则 \`EXECUTION_NOT_ATTRIBUTED\`）` : "（干净）"}`,
    `- 未绑定主会话：${gaps.unboundSession ? "**是** ⇒ 回看板「重建/绑定主会话」" : "否"}`,
    `- 待确认候选：**${gaps.pendingCandidates}**${gaps.pendingCandidates > 20 ? "（超阈值 20 ⇒ 先确认/丢弃，别急着条目化）" : ""}`,
    `- 无任务的条目：${gaps.requirementsWithoutTasks} · 评审中卡：${gaps.tasksInReview} · 受阻卡：${gaps.tasksBlocked}`,
    `- 看板：任务 ${tasks.length} · 需求条目 ${items.length}`,
    "",
    "## 4. 本轮该先做",
    "",
    `**${nextStep.step} · ${nextStep.title}** —— ${nextStep.why}`,
    nextStep.humanAction === "authorize" ? "\n> ⚠ 这一步要**人**做（`backlog → todo` 是人工授权），执行侧不得代点。" : "",
    nextStep.humanAction === "accept" ? "\n> ⚠ 这一步要**人**做（`done` 只能人点；评审门 + 人工收口）。" : "",
    "",
    "## 5. 八步（完整定义，取自 `skills/taskboard-flow/SKILL.md`）",
    "",
    skill.steps,
    "",
    "## 6. 五条硬规则（都由门守，不靠自觉）",
    "",
    skill.rules,
    "",
    "## 7. 取规范正文（别凭记忆）",
    "",
    "- 主流程：`norm_get { norm: \"flow\" }`",
    "- 卡片更新（回填要它的 digest）：`norm_get { norm: \"card-update\" }`",
    "- 项目自有补充：`norm_get { norm: \"project\", project: \"" + resolved.project.id + "\" }`（读 `<workspace>/AGENTS.md`）",
    "",
    "## 8. 开工前的自检（一条命令）",
    "",
    "```bash",
    `node scripts/tb-flow.mjs start --project ${resolved.project.id}   # 与本块同源`,
    "```",
  ];

  return {
    text: lines.filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n",
    project: { id: resolved.project.id, name: resolved.project.name, workspacePath: resolved.project.workspacePath ?? null, matchedBy: resolved.matchedBy },
    contract: { version: snapVersion, stale: Boolean(snap.stale), changed, gates: snap.snapshot.gates ?? {} },
    gaps,
    nextStep,
    skill: { name: skill.meta.name ?? "taskboard-flow", version: skill.meta.version ?? null, requiresContract: skill.meta.requires_contract ?? null, path: skill.relPath },
  };
}

/** 档 B：给项目 `AGENTS.md` 用的片段（只指路，不复制正文）。 */
export function buildAgentsSnippet({ project, pkgPath } = {}) {
  const pkg = pkgPath ?? PKG_ROOT;
  const proj = project ? ` --project ${project}` : " --project <项目id>";
  return [
    "## 开工（任务看板主流程）",
    "",
    "本项目用 taskboard-workbench 管任务。**动代码之前**先跑：",
    "",
    "```bash",
    `node ${pkg}/scripts/tb-flow.mjs start${proj}`,
    "```",
    "",
    "把输出的「装载块」当本轮上下文：`nextStep` 就是本轮该先做的事，`gaps` 告诉你哪里还欠账。",
    `流程细节见 \`${pkg}/skills/taskboard-flow/SKILL.md\`。`,
    "",
    "> 这段只指路，不替代本文件其余约定。",
  ].join("\n");
}
