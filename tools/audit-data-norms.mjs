#!/usr/bin/env node
/**
 * 数据规范核查（只读）· 需求条目 + 任务卡片。
 *
 * 判据来源：`docs/规范/07-条目详情规范.md`
 *   §2.1 任务卡 8 块（目标/范围/禁止/做法/报告/停下/验收/关联）+ §4 长度预算（卡 ≤800 / 条目 ≤1200 / 验收 3–6 条）
 *   §2.2 需求条目 5 块（目标/范围/约束/验收/关联）
 * 另加「流程可见性」判据（不在 07，但属本仓硬口径）：
 *   - 卡无归因（无 requirementId）⇒ 派发会被归因门拒（EXECUTION_NOT_ATTRIBUTED）
 *   - in_review 无 reviewer ⇒ 评审死锁（review_deadlock）
 *   - in_progress 无 session/claim ⇒ 幽灵在途
 *
 * 用法：node tools/audit-data-norms.mjs [--base-url=...] [--json=/tmp/x.json]
 * 只读：仅 GET，不写库。
 */
import { writeFileSync } from "node:fs";

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}
const BASE = (args.get("base-url") ?? "http://127.0.0.1:3080/integrations/taskboard-workbench").replace(/\/$/, "");

const CARD_BLOCKS = ["目标：", "范围：", "禁止：", "做法：", "报告：", "停下：", "验收：", "关联："];
const ITEM_BLOCKS = [["目标"], ["范围"], ["约束", "禁止"], ["验收"], ["关联"]];
const TERMINAL = new Set(["done", "canceled"]);

const get = async (p) => (await (await fetch(`${BASE}${p}`)).json());

const countAcceptance = (text) => {
  const s = String(text ?? "").trim();
  if (!s) return 0;
  const marks = s.match(/[①②③④⑤⑥⑦⑧⑨⑩]/g);
  if (marks && marks.length > 1) return marks.length;
  const lines = s.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 1) return lines.length;
  const semis = s.split(/[；;]/).map((x) => x.trim()).filter(Boolean);
  return Math.max(1, semis.length);
};

const report = { generatedAt: new Date().toISOString(), base: BASE, projects: [], totals: {} };
const T = {
  items: 0, itemsDescEmpty: 0, itemsAccEmpty: 0, itemsMissingBlocks: 0, itemsTooLong: 0, itemsAccCountBad: 0, itemsDupTitle: 0, itemsClosable: 0,
  tasks: 0, tasksDescEmpty: 0, tasksAccEmpty: 0, tasksMissingBlocks: 0, tasksTooLong: 0, tasksUnattributed: 0, tasksNoOwner: 0,
  tasksReviewDeadlock: 0, tasksGhostInflight: 0, tasksAccCountBad: 0,
};
const issues = [];

for (const p of (await get("/api/projects")).projects) {
  const tasks = (await get(`/api/tasks?project=${encodeURIComponent(p.id)}`)).tasks ?? [];
  const items = (await get(`/api/requirements/items?project=${encodeURIComponent(p.id)}`)).items ?? [];
  const byItemId = new Map();
  for (const t of tasks) {
    if (!t.requirementId) continue;
    if (!byItemId.has(t.requirementId)) byItemId.set(t.requirementId, []);
    byItemId.get(t.requirementId).push(t);
  }

  // ---- 需求条目 ----
  const normTitles = new Map();
  for (const i of items) {
    T.items += 1;
    const desc = String(i.description ?? "");
    const acc = String(i.acceptance ?? "");
    const key = String(i.normTitle ?? i.title ?? "").trim();
    if (key) normTitles.set(key, (normTitles.get(key) ?? 0) + 1);
    if (!desc.trim()) { T.itemsDescEmpty += 1; issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "描述为空", ref: i.identifier }); }
    if (!acc.trim()) { T.itemsAccEmpty += 1; issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "验收为空", ref: i.identifier }); }
    const missing = ITEM_BLOCKS.filter((alts) => !alts.some((a) => new RegExp(`(^|\\n)\\s*[*【>]*${a}\\s*[】]*\\s*[：:]`).test(desc))).map((a) => a[0]);
    if (desc.trim() && missing.length) {
      T.itemsMissingBlocks += 1;
      issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "缺骨架块", ref: i.identifier, detail: missing.join("/") });
    }
    if (desc.length > 1200) { T.itemsTooLong += 1; issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "描述超 1200 字", ref: i.identifier, detail: String(desc.length) }); }
    if (acc.trim()) {
      const n = countAcceptance(acc);
      if (n < 3 || n > 6) { T.itemsAccCountBad += 1; issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "验收条数不在 3–6", ref: i.identifier, detail: String(n) }); }
    }
    if (i.status === "open") {
      const linked = byItemId.get(i.id) ?? [];
      if (linked.length && linked.every((t) => TERMINAL.has(t.status))) {
        T.itemsClosable += 1;
        issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "可收口未收口（关联卡全终态）", ref: i.identifier, detail: `${linked.length} 卡：${linked.map((t) => t.identifier).slice(0, 4).join(",")}` });
      }
    }
  }
  for (const [k, n] of normTitles) {
    if (n > 1) {
      T.itemsDupTitle += n;
      const refs = items.filter((i) => String(i.normTitle ?? i.title ?? "").trim() === k).map((i) => i.identifier);
      issues.push({ project: p.id, kind: "item", status: i.status, createdAt: i.createdAt, type: "标题重复", ref: refs.join(","), detail: k.slice(0, 40) });
    }
  }

  // ---- 任务卡 ----
  for (const t of tasks) {
    T.tasks += 1;
    const desc = String(t.description ?? "");
    const acc = String(t.acceptance ?? "");
    if (!desc.trim()) { T.tasksDescEmpty += 1; issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "描述为空", ref: t.identifier, detail: t.status }); }
    if (!acc.trim()) { T.tasksAccEmpty += 1; issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "验收为空", ref: t.identifier, detail: t.status }); }
    if (desc.trim()) {
      const missing = CARD_BLOCKS.filter((b) => !desc.includes(b));
      if (missing.length) {
        T.tasksMissingBlocks += 1;
        issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "缺骨架块", ref: t.identifier, detail: missing.join("") });
      }
      if (desc.length > 800) { T.tasksTooLong += 1; issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "描述超 800 字", ref: t.identifier, detail: String(desc.length) }); }
    }
    if (!t.requirementId && !TERMINAL.has(t.status)) {
      T.tasksUnattributed += 1;
      issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "无归因（未终态）", ref: t.identifier, detail: t.status });
    }
    if (!t.owner && !TERMINAL.has(t.status)) {
      T.tasksNoOwner += 1;
      issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "无 owner（未终态）", ref: t.identifier, detail: t.status });
    }
    if (t.status === "in_review" && !t.reviewer) {
      T.tasksReviewDeadlock += 1;
      issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "待验收无评审者", ref: t.identifier, detail: `reviewState=${t.reviewState ?? "null"}` });
    }
    if (t.status === "in_progress" && !t.sessionId && !t.claimOwner) {
      T.tasksGhostInflight += 1;
      issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "进行中无会话/无认领", ref: t.identifier });
    }
    if (acc.trim()) {
      const n = countAcceptance(acc);
      if (n > 6) { T.tasksAccCountBad += 1; issues.push({ project: p.id, kind: "task", status: t.status, createdAt: t.createdAt, type: "验收条数 >6", ref: t.identifier, detail: String(n) }); }
    }
  }

  report.projects.push({ id: p.id, name: p.name, tasks: tasks.length, items: items.length });
}
report.totals = T;
report.issues = issues;

const outJson = args.get("json");
if (outJson) writeFileSync(outJson, JSON.stringify(report, null, 1));

const pad = (s, n) => String(s).padEnd(n);
console.log(`项目 ${report.projects.length} · 条目 ${T.items} · 卡片 ${T.tasks}`);
console.log("");
console.log("== 需求条目 ==");
console.log(pad("描述为空", 22) + T.itemsDescEmpty);
console.log(pad("验收为空", 22) + T.itemsAccEmpty);
console.log(pad("缺骨架块", 22) + T.itemsMissingBlocks);
console.log(pad("描述超 1200 字", 22) + T.itemsTooLong);
console.log(pad("验收条数非 3–6", 22) + T.itemsAccCountBad);
console.log(pad("标题重复（条数）", 22) + T.itemsDupTitle);
console.log(pad("可收口未收口", 22) + T.itemsClosable);
console.log("");
console.log("== 任务卡片 ==");
console.log(pad("描述为空", 22) + T.tasksDescEmpty);
console.log(pad("验收为空", 22) + T.tasksAccEmpty);
console.log(pad("缺骨架块", 22) + T.tasksMissingBlocks);
console.log(pad("描述超 800 字", 22) + T.tasksTooLong);
console.log(pad("无归因（未终态）", 22) + T.tasksUnattributed);
console.log(pad("无 owner（未终态）", 22) + T.tasksNoOwner);
console.log(pad("待验收无评审者", 22) + T.tasksReviewDeadlock);
console.log(pad("进行中无会话/认领", 22) + T.tasksGhostInflight);
console.log(pad("验收条数 >6", 22) + T.tasksAccCountBad);
console.log("");
const CUT = "2026-11-04";
const seg = (x) => {
  const terminal = x.kind === "item" ? ["closed", "done"].includes(x.status) : ["done", "canceled"].includes(x.status);
  const legacy = String(x.createdAt ?? "") < CUT;
  return `${terminal ? "终态" : "未终态"}/${legacy ? "存量" : "新数据"}`;
};
const cross = {};
for (const it of issues) { const k = seg(it); cross[k] = (cross[k] ?? 0) + 1; }
console.log("== 按 终态/存量 交叉 ==");
for (const [k, v] of Object.entries(cross)) console.log(pad(k, 24) + v);
console.log("");
const byType = {};
for (const it of issues) byType[`${it.kind}:${it.type}`] = (byType[`${it.kind}:${it.type}`] ?? 0) + 1;
console.log("== 按问题类型（含样本） ==");
for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
  const sample = issues.filter((i) => `${i.kind}:${i.type}` === k).slice(0, 3).map((i) => i.ref + (i.detail ? `(${i.detail})` : "")).join(" · ");
  console.log(`${pad(k, 34)}${pad(v, 5)}${sample}`);
}
