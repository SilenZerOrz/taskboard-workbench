#!/usr/bin/env node
/**
 * 条目详情 lint（**只读**）—— 卡 `-216` / 需求 `R160` 验收 ⑤「骨架落地选 B」
 *
 * ## 为什么是「只读 lint」而不是预填 / 收口门
 * `07` 规范定了骨架与预算（需求 ≤1200 / 卡 ≤800 / 验收 3–6 条），但**没有任何一处会告诉人
 * 「你现在这条超了」** —— 全靠人记。三个选项里：
 *   A 前端预填：新建时塞模板 ⇒ 会改新建流程的默认行为（口径变更，且模板与存量字段同源问题）；
 *   C 收口门：没有验收就拦 `done` ⇒ 直接改治理红线（须单独批）；
 *   **B 只读 lint：只报不改、退出码可控** ⇒ 零行为变更，可随时跑，适合先摸清存量。
 * 所以本卡选 B，本文件即那台尺子。
 *
 * ## 纪律
 * 1. **只读**：`new DatabaseSync(..., { readOnly: true })`，全文件零 `INSERT/UPDATE/DELETE`。
 * 2. **默认不拦人**：默认退出码 0（它是尺子不是门）；`--strict` 才在有 `error` 级违规时退 1。
 * 3. **口径来自规范文件而不是硬编码**：预算从 `spec/norms/item-detail.md`（或项目副本）里读；
 *    读不到才回落本文件里的 `DEFAULT_BUDGET`，并在报告里写明来源 —— 否则改了规范 lint 不跟。
 * 4. **范围默认「正在用的条目」**：`open` 需求 + 非终态卡（与 `07` §7 存量处置一致）；
 *    `--all` 才扫全量（含历史 156 条），只用于看存量，不当验收依据。
 *
 * 用法：
 *   node tools/lint-items.mjs                                  # 本项目 open 需求 + 非终态卡
 *   node tools/lint-items.mjs --all --json                     # 全量、机器可读
 *   node tools/lint-items.mjs --strict                         # error 级违规 ⇒ 退出码 1
 *   node tools/lint-items.mjs --db .data/taskboard.sqlite --project taskboard-workbench
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 规范读不到时的兜底（与 `spec/norms/item-detail.md` §长度预算 一致）。 */
export const DEFAULT_BUDGET = { reqDescMax: 1200, taskDescMax: 800, acceptanceMin: 3, acceptanceMax: 6 };

/**
 * 从规范正文里读预算（`需求条目 \`description\` | 1200 字符` 这种表格行）。
 * 正则宽松到「同一行有 1200/800 就认」，读不到的那项回落默认值 —— 少读一项不该让整台尺子失效。
 */
export function readBudget(normsText) {
  const budget = { ...DEFAULT_BUDGET };
  const source = [];
  if (typeof normsText === "string" && normsText) {
    const req = normsText.match(/需求条目[^\n]*?(\d{3,5})\s*字符/);
    const task = normsText.match(/任务卡[^\n]*?(\d{3,5})\s*字符/);
    if (req) { budget.reqDescMax = Number(req[1]); source.push("reqDescMax"); }
    if (task) { budget.taskDescMax = Number(task[1]); source.push("taskDescMax"); }
  }
  budget.source = source.length ? "norm" : "default";
  return budget;
}

const strip = (v) => String(v ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
const len = (v) => [...strip(v)].length;

/** 验收条目数：按行首 `①②③…` / `1.` / `-` 计数；没有就按空行块计。 */
export function countAcceptance(text) {
  const t = strip(text);
  if (!t) return 0;
  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const marked = lines.filter((l) => /^([①-⑳]|\d+[.、)]|[-*·])\s*/.test(l));
  if (marked.length) return marked.length;
  return t.split(/\n\s*\n/).filter(Boolean).length;
}

const RULES = {
  REQ_ACCEPTANCE_MISSING: { level: "error", label: "需求：`acceptance` 为空（正文写了不算）" },
  REQ_ACCEPTANCE_FEW: { level: "warn", label: "需求：验收少于 3 条" },
  REQ_ACCEPTANCE_MANY: { level: "warn", label: "需求：验收超过 6 条（该拆了）" },
  REQ_DESC_TOO_LONG: { level: "error", label: "需求：描述超预算" },
  REQ_HEADER_MISSING: { level: "warn", label: "需求：首行不是 `<编号>｜一句话`" },
  REQ_SCOPE_NO_MOVE: { level: "warn", label: "需求：写了「范围」但没有「移出」" },
  TASK_ACCEPTANCE_MISSING: { level: "error", label: "任务卡：`acceptance` 为空" },
  TASK_ACCEPTANCE_MANY: { level: "warn", label: "任务卡：验收超过 6 条（该拆了）" },
  TASK_DESC_TOO_LONG: { level: "error", label: "任务卡：描述超预算" },
  TASK_STOP_MISSING: { level: "warn", label: "任务卡：没有「停下」段" },
  TASK_SCOPE_NO_MOVE: { level: "warn", label: "任务卡：写了「范围」但没有「移出」" },
};

/**
 * 纯函数：给条目数组出违规清单（不碰库、不做 IO）。
 * @param {{requirements?:Array, tasks?:Array, budget?:object, scope?:string}} input
 */
export function lintEntries({ requirements = [], tasks = [], budget = DEFAULT_BUDGET, scope = "open" } = {}) {
  const out = [];
  const push = (rule, kind, identifier, detail) => out.push({ rule, level: RULES[rule].level, label: RULES[rule].label, kind, identifier, detail });

  for (const r of requirements) {
    const desc = strip(r.description);
    const acc = countAcceptance(r.acceptance);
    if (!strip(r.acceptance)) push("REQ_ACCEPTANCE_MISSING", "requirement", r.identifier, "");
    else if (acc < DEFAULT_BUDGET.acceptanceMin) push("REQ_ACCEPTANCE_FEW", "requirement", r.identifier, `${acc} 条`);
    else if (acc > budget.acceptanceMax) push("REQ_ACCEPTANCE_MANY", "requirement", r.identifier, `${acc} 条`);
    if (len(desc) > budget.reqDescMax) push("REQ_DESC_TOO_LONG", "requirement", r.identifier, `${len(desc)} > ${budget.reqDescMax}`);
    if (desc && !desc.startsWith(`${r.identifier}｜`)) push("REQ_HEADER_MISSING", "requirement", r.identifier, desc.slice(0, 24));
    if (desc.includes("范围") && !desc.includes("移出")) push("REQ_SCOPE_NO_MOVE", "requirement", r.identifier, "");
  }
  for (const t of tasks) {
    const desc = strip(t.description);
    const acc = countAcceptance(t.acceptance);
    if (!strip(t.acceptance)) push("TASK_ACCEPTANCE_MISSING", "task", t.identifier, "");
    else if (acc > budget.acceptanceMax) push("TASK_ACCEPTANCE_MANY", "task", t.identifier, `${acc} 条`);
    if (len(desc) > budget.taskDescMax) push("TASK_DESC_TOO_LONG", "task", t.identifier, `${len(desc)} > ${budget.taskDescMax}`);
    if (desc && !desc.includes("停下")) push("TASK_STOP_MISSING", "task", t.identifier, "");
    if (desc.includes("范围") && !desc.includes("移出")) push("TASK_SCOPE_NO_MOVE", "task", t.identifier, "");
  }
  const byRule = {};
  for (const v of out) byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
  return {
    scope, budget, total: out.length,
    errors: out.filter((v) => v.level === "error").length,
    warnings: out.filter((v) => v.level === "warn").length,
    byRule, violations: out,
  };
}

/** 读库（只读）并跑 lint。 */
export function lintDb({ dbPath, projectId, all = false, normsText = null }) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // 默认只扫「正在用」：需求 `open`（未交付）+ 卡非终态。
    // 不把 `done` 需求算进来 —— 那 34 条是「已交付未关闭」，拿它们算违规等于把历史账记到当前头上。
    const reqWhere = all ? "1=1" : "status = 'open'";
    const taskWhere = all ? "1=1" : "status not in ('done','canceled')";
    const requirements = db.prepare(
      `select identifier, description, acceptance, status from requirement_items where project_id=? and ${reqWhere} order by identifier`
    ).all(projectId);
    const tasks = db.prepare(
      `select identifier, description, acceptance, status from tasks where project_id=? and ${taskWhere} order by identifier`
    ).all(projectId);
    const budget = readBudget(normsText ?? readNormText());
    return { ...lintEntries({ requirements, tasks, budget, scope: all ? "all" : "open" }), projectId, sampled: { requirements: requirements.length, tasks: tasks.length } };
  } finally { db.close(); }
}

function readNormText() {
  for (const p of [path.join(ROOT, "spec", "norms", "item-detail.md")]) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}

function main() {
  const dbPath = path.resolve(ROOT, arg("db", ".data/taskboard.sqlite"));
  const projectId = arg("project", "taskboard-workbench");
  const all = process.argv.includes("--all");
  const json = process.argv.includes("--json");
  if (!existsSync(dbPath)) {
    console.error(`✗ 库不存在：${dbPath}（lint 只读，不会自建）`);
    process.exit(2);
  }
  const r = lintDb({ dbPath, projectId, all });
  if (json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    console.log(`条目详情 lint · project=${projectId} · scope=${r.scope} · 预算来源=${r.budget.source}`);
    console.log(`  抽样：需求 ${r.sampled.requirements} 条 · 卡 ${r.sampled.tasks} 张`);
    console.log(`  违规：共 ${r.total}（error ${r.errors} · warn ${r.warnings}）`);
    for (const [rule, n] of Object.entries(r.byRule).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(n).padStart(4)}  ${rule}  ${RULES[rule].label}`);
    }
    const show = r.violations.filter((v) => v.level === "error").slice(0, 12);
    if (show.length) {
      console.log("  前 12 条 error：");
      for (const v of show) console.log(`    · ${v.identifier}  ${v.rule}${v.detail ? `  (${v.detail})` : ""}`);
    }
    if (r.errors === 0 && r.total > 0) console.log("  提示：无 error 级违规；上面都是 warn（建议，不拦）。");
  }
  if (process.argv.includes("--strict") && r.errors > 0) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
