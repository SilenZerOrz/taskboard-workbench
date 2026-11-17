#!/usr/bin/env node
/**
 * 存量「空详情卡」回填（卡 `-273` / 需求 `R189` 的存量配套）。
 *
 * 背景（2026-11-17 用户报障）：
 *   界面「批量生成任务」→ `POST /api/requirements/items/:ref/split` 只传 `{title}`，
 *   旧实现把 `description` / `acceptance` 建成空串 ⇒ 卡片只有标题。
 *   卡 `-273` 已修**新写入路径**（store.splitRequirement 兜底装配）；本脚本只处理**存量卡**。
 *
 * 判据（三条，全部满足才动）：
 *   1. 卡处于**非终态**（backlog / in_progress / in_review / …；done / canceled 一律跳过 —— 那是历史过程证据）
 *   2. 卡**有归因需求条目**（`requirementId` 非空）
 *   3. 目标字段**当前为空**（只填空，绝不覆盖已有正文）
 * 默认 `--only=both`：只补「正文与验收都为空」的卡（= 用户说的「只有标题」）。
 * `--only=missing` 才会额外补「有正文缺验收」的卡。
 *
 * 用法：
 *   node tools/backfill-split-detail.mjs                     # dry-run（默认，只读，不写库）
 *   node tools/backfill-split-detail.mjs --project=scada-vibe
 *   node tools/backfill-split-detail.mjs --apply             # 真写：PATCH + 每卡一条留痕评论
 *   node tools/backfill-split-detail.mjs --apply --include-terminal   # 连终态卡一起（需单独授权）
 *
 * 写入口：`PATCH /api/tasks/:ref`（带 `expectedVersion`），只写 description / acceptance，
 * 不碰 status / labels / owner / 看板顺序；失败即停该卡并打印错误码，**不重试**。
 */
import { buildSplitTaskAcceptance, buildSplitTaskDescription } from "../src/core/requirements.mjs";

const args = new Map();
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  if (m) args.set(m[1], m[2] ?? "true");
}
const APPLY = args.has("apply");
const INCLUDE_TERMINAL = args.has("include-terminal");
const ONLY = args.get("only") ?? "both";
const BASE = (args.get("base-url") ?? "http://127.0.0.1:3080/integrations/taskboard-workbench").replace(/\/$/, "");
const ONLY_PROJECT = args.get("project") ?? null;
const TERMINAL = new Set(["done", "canceled"]);

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${init?.method ?? "GET"} ${path} → ${res.status} ${json?.error?.code ?? ""} ${json?.error?.message ?? ""}`.trim());
    err.status = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

const rows = [];
const skipped = [];

const projects = (await api("/api/projects")).projects ?? [];
for (const project of projects) {
  if (ONLY_PROJECT && project.id !== ONLY_PROJECT) continue;
  const tasks = (await api(`/api/tasks?project=${encodeURIComponent(project.id)}`)).tasks ?? [];
  const items = (await api(`/api/requirements/items?project=${encodeURIComponent(project.id)}`)).items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const t of tasks) {
    const desc = String(t.description ?? "");
    const acc = String(t.acceptance ?? "");
    const bothEmpty = desc.trim() === "" && acc.trim() === "";
    const missingAcc = desc.trim() !== "" && acc.trim() === "";
    const hit = bothEmpty || (ONLY === "missing" && missingAcc);
    if (!hit) continue;
    if (!INCLUDE_TERMINAL && TERMINAL.has(t.status)) { skipped.push({ ...t, why: "terminal" }); continue; }
    if (!t.requirementId) { skipped.push({ ...t, why: "no-requirement" }); continue; }
    const item = byId.get(t.requirementId);
    if (!item) { skipped.push({ ...t, why: "requirement-not-found" }); continue; }
    const newDesc = desc.trim() === "" ? buildSplitTaskDescription(item, t.title) : desc;
    const newAcc = acc.trim() === "" ? buildSplitTaskAcceptance(item) : acc;
    rows.push({
      ref: t.identifier, status: t.status, version: t.version,
      title: t.title,
      descBefore: desc.length, descAfter: newDesc.length,
      accBefore: acc.length, accAfter: newAcc.length,
      requirement: item.identifier,
      requirementDesc: String(item.description ?? "").length,
      requirementAcc: String(item.acceptance ?? "").length,
      description: newDesc, acceptance: newAcc,
    });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`模式: ${APPLY ? "APPLY（真写）" : "DRY-RUN（只读）"}  目标: ${ONLY}  含终态: ${INCLUDE_TERMINAL ? "是" : "否"}`);
console.log(`命中 ${rows.length} 张 · 跳过 ${skipped.length} 张（终态 ${skipped.filter((s) => s.why === "terminal").length} / 无归因 ${skipped.filter((s) => s.why === "no-requirement").length} / 条目缺失 ${skipped.filter((s) => s.why === "requirement-not-found").length}）`);
console.log("");
console.log(`${pad("卡号", 30)}${pad("状态", 12)}${pad("正文 前→后", 18)}${pad("验收 前→后", 16)}需求`);
for (const r of rows) {
  console.log(`${pad(r.ref, 30)}${pad(r.status, 12)}${pad(`${r.descBefore}→${r.descAfter}`, 18)}${pad(`${r.accBefore}→${r.accAfter}`, 16)}${r.requirement}`);
}

const bad = rows.filter((r) => r.accAfter === 0 || r.descAfter === 0);
if (bad.length) console.log(`\n⚠ 仍有 ${bad.length} 张会后仍为空：${bad.map((b) => b.ref).join(", ")}`);

if (!APPLY) {
  if (rows.length) {
    const sample = rows[0];
    console.log(`\n=== 样本（${sample.ref}）将写入的正文 ===\n${sample.description}\n\n=== 验收 ===\n${sample.acceptance}`);
    console.log("\n未写库。加 --apply 才执行（需先经用户批准）。");
  }
  process.exit(0);
}

let ok = 0;
const failed = [];
for (const r of rows) {
  try {
    await api(`/api/tasks/${encodeURIComponent(r.ref)}`, {
      method: "PATCH",
      body: JSON.stringify({ expectedVersion: r.version, description: r.description, acceptance: r.acceptance }),
    });
    await api(`/api/tasks/${encodeURIComponent(r.ref)}/comments`, {
      method: "POST",
      body: JSON.stringify({
        body: [
          `【存量空详情回填】卡 \`-274\` / 需求 \`R190\`（上游 -273 / R189）· 执行者 codex`,
          ``,
          `判定：本卡由「批量生成任务」旧口径建出（正文 ${r.descBefore} 字 / 验收 ${r.accBefore} 字），条目 \`${r.requirement}\` 正文 ${r.requirementDesc} 字、验收 ${r.requirementAcc} 字——内容齐备，是入口丢了。`,
          `做法：PATCH 只写 description / acceptance（带 expectedVersion=${r.version}）；正文 ${r.descBefore}→${r.descAfter} 字，验收 ${r.accBefore}→${r.accAfter} 字；未动 status / labels / owner / 看板顺序。`,
          `依据：装配函数 buildSplitTaskDescription / buildSplitTaskAcceptance（-273 修复同源）。`,
          `边界：未触发执行/派发；未重跑评审；未改条目。`,
        ].join("\n"),
      }),
    });
    ok += 1;
    console.log(`✓ ${r.ref}  正文 ${r.descBefore}→${r.descAfter} · 验收 ${r.accBefore}→${r.accAfter}`);
  } catch (error) {
    failed.push({ ref: r.ref, error: error.message });
    console.log(`✗ ${r.ref}  ${error.message}（不重试）`);
  }
}
console.log(`\n结果：成功 ${ok} / 失败 ${failed.length} / 合计 ${rows.length}`);
process.exit(failed.length ? 1 : 0);
