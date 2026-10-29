#!/usr/bin/env node
/**
 * audit-intake.mjs —— 资料引入（intake）口径审计 · **只读 + 可选真跑**。
 *
 * 存在理由：2026-10-29 的「需求条目批量归类」决策里，若干数字（388 份文档 / 290 条会被新建 /
 * H1=898 / H2=2610）此前只有叙述、没有可重跑的产物。本脚本把这些数字变成**一条命令 + 固定 JSON**。
 *
 * 口径纪律（重要）：
 *   - `measured` = 本次跑出来的读数（文件系统 / 数据库 / 真 HTTP）；
 *   - `derived`  = 由读数按某个**假设**算出来的（例如「每个 H1 落一条条目」这个假设本身不是实测）。
 *   每个数字都带 `kind` 字段，避免把「读过的代码」和「测过的数字」混成同等可信。
 *
 * 用法：
 *   node tools/audit-intake.mjs                      # 只读审计（不动任何数据）
 *   node tools/audit-intake.mjs --e2e                # 额外起隔离实例真跑一次 intake（库里是副本）
 *   node tools/audit-intake.mjs --json               # 机器可读（默认就是 JSON）
 *   node tools/audit-intake.mjs --data-dir .data --project taskboard-workbench
 */
import { mkdtempSync, copyFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, relative, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { scanProjectMaterials, buildMaterialIndex } from "../src/core/intake.mjs";
import { resolveDataDir, resolveDbPath } from "../src/core/config.mjs";
import { titleKey } from "../src/core/requirements.mjs";


const listSha = (items) => createHash("sha256").update([...items].sort().join("\n")).digest("hex");
const fileSha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const dataDir = resolveDataDir({ dataDir: argOf("data-dir"), env: process.env });
const dbPath = resolveDbPath(dataDir);
const projectId = argOf("project", "taskboard-workbench");

function openReadonly(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  return {
    all: (sql, ...params) => db.prepare(sql).all(...params),
    get: (sql, ...params) => db.prepare(sql).get(...params),
    close: () => db.close(),
  };
}

/** 标题口径必须与 api.mjs:298-312 一致：`title`，不看内容。 */
function headingStats(docs) {
  let h1 = 0, h2 = 0, docsWithH1 = 0;
  const per = [];
  for (const d of docs) {
    const n1 = (d.content.match(/^#\s+/gm) ?? []).length;
    const n2 = (d.content.match(/^##\s+/gm) ?? []).length;
    h1 += n1; h2 += n2;
    if (n1 > 0) docsWithH1 += 1;
    if (n2 > 0) per.push({ relPath: d.relPath, h2: n2 });
  }
  per.sort((a, b) => b.h2 - a.h2 || a.relPath.localeCompare(b.relPath));
  return { docsWithH1, h1Total: h1, h2Total: h2, topH2: per.slice(0, 5) };
}

async function runE2E({ root }) {
  const dir = mkdtempSync(join(tmpdir(), "tb-intake-audit-"));
  const copy = join(dir, "taskboard.sqlite");
  copyFileSync(dbPath, copy);
  // 让「290」这类实测数字钉在一个**可追溯的快照**上：同一 sha256 的库应复现同一 delta。
  const snapshot = { sourcePath: dbPath, sha256: fileSha(copy), bytes: statSync(copy).size, takenAt: new Date().toISOString() };
  const child = spawn(process.execPath, ["src/server/server.mjs"], {
    cwd: resolve(import.meta.dirname, ".."),
    env: { ...process.env, TB_DATA_DIR: dir, TB_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  // 独立进程的 basePath 是 ""（DEFAULT_BASE_PATH），与 :3080 插件的 /integrations/taskboard-workbench 不同
  // ⇒ 直接取启动日志里打印的 URL，别硬编码前缀。
  const base = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`隔离实例 20s 未就绪；stdout=${out.slice(0, 500)}`)), 20000);
    child.stdout.on("data", (b) => {
      out += b.toString();
      const m = /listening on (http:\/\/[^\s]+)/.exec(out);
      if (m) { clearTimeout(timer); res(m[1].replace(/\/$/, "")); }
    });
    child.stderr.on("data", (b) => { out += b.toString(); });
    child.on("exit", (code) => { clearTimeout(timer); rej(new Error(`隔离实例提前退出 code=${code}；${out.slice(0, 500)}`)); });
  });
  const count = async () => {
    const r = await fetch(`${base}/api/requirements/items?project=${encodeURIComponent(projectId)}`);
    const d = await r.json();
    const by = {};
    for (const it of d.items ?? []) by[it.status] = (by[it.status] ?? 0) + 1;
    return { total: d.count ?? (d.items ?? []).length, byStatus: by };
  };
  const before = await count();
  const res = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/intake`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  const after = await count();

  // ── 拒绝路径（A 的另一半验收）────────────────────────────────────────────
  // 只测 doc 路径等于只测一半：「那条路不存在」要证的是**打这条路会被拦住且零副作用**。
  // 三条各跑一次：items / both ⇒ INTAKE_ITEMS_DISABLED；未知 mode ⇒ USAGE_ERROR；全部 400。
  const rejectCases = [
    { mode: "items", expect: "INTAKE_ITEMS_DISABLED" },
    { mode: "both", expect: "INTAKE_ITEMS_DISABLED" },
    { mode: "bogus", expect: "USAGE_ERROR" },
  ];
  const beforeReject = await count();
  const rejects = [];
  for (const c of rejectCases) {
    const r = await fetch(`${base}/api/projects/${encodeURIComponent(projectId)}/intake`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: c.mode }),
    });
    const j = await r.json().catch(() => ({}));
    const code = j?.error?.code ?? null;
    rejects.push({
      mode: c.mode, status: r.status, code,
      itemsCreatedPresent: Object.prototype.hasOwnProperty.call(j ?? {}, "itemsCreated"),
      expected: c.expect,
      ok: r.status === 400 && code === c.expect,
      message: j?.error?.message ?? null,
    });
  }
  const afterReject = await count();
  const rejectDelta = afterReject.total - beforeReject.total;
  const rejectsOk = rejects.every((x) => x.ok) && rejectDelta === 0;

  child.kill("SIGTERM");
  await new Promise((r) => { child.once("exit", r); setTimeout(r, 4000); });
  return {
    kind: "measured",
    snapshot,
    note: "隔离实例（临时 dataDir = 库副本 · TB_PORT=0 随机端口 · 跑完即杀）；未触碰 :3080 与仓库 .data/",
    httpStatus: res.status,
    scanned: body.scanned ?? null,
    itemsCreatedReported: body.itemsCreated ?? null,   // A 之后恒为 null（响应体已无该字段）
    rejectionCode: body?.error?.code ?? null,          // doc 路径应为 null（201）；拒绝路径见 rejects
    itemsBefore: before,
    itemsAfter: after,
    itemsDelta: after.total - before.total,
    // 拒绝路径（items/both ⇒ INTAKE_ITEMS_DISABLED · 未知 mode ⇒ USAGE_ERROR · 全 400 · 零副作用）
    rejects,
    rejectDelta,
    rejectsOk,
  };
}

const main = async () => {
  const root = argOf("workspace", process.cwd());
  const scan = await scanProjectMaterials(root, {});
  const built = await buildMaterialIndex(scan, { maxBytesPerFile: 8000, includeContent: true });
  const heads = headingStats(built.docs);

  const db = openReadonly(dbPath);
  const byStatus = db.all(
    "select status, count(*) as n from requirement_items where project_id = ? group by status order by status", projectId);
  const totals = {
    items: db.get("select count(*) as n from requirement_items where project_id = ?", projectId)?.n ?? 0,
    itemsFromIntake: db.get("select count(*) as n from requirement_items where project_id = ? and source = 'intake'", projectId)?.n ?? 0,
    itemsWithDoc: db.get("select count(*) as n from requirement_items where project_id = ? and doc_id is not null", projectId)?.n ?? 0,
    cards: db.get("select count(*) as n from tasks where project_id = ?", projectId)?.n ?? 0,
    candidates: db.get("select count(*) as n from requirement_candidates where project_id = ?", projectId)?.n ?? 0,
  };
  const titles = new Set(db.all("select title from requirement_items where project_id = ?", projectId).map((r) => r.title));
  // 非终态条目按来源分组：决定「A 上线后还有多少资料索引型条目混在池里」
  const openBySource = db.all(
    "select source, count(*) as n from requirement_items where project_id = ? and status not in ('done','closed') group by source order by n desc", projectId);
  // 去重键陈旧度：norm_title 是 elaborate/confirm 的去重键，但 updateRequirementItem 改 title 时不更新它
  const allItems = db.all("select identifier, title, norm_title from requirement_items where project_id = ?", projectId);
  const staleNorm = allItems.filter((r) => r.norm_title !== titleKey(r.title));
  db.close();

  const wouldCreate = built.docs.filter((d) => !titles.has(d.title));

  const report = {
    generatedAt: new Date().toISOString(),
    repoRoot: root,
    dataDir,
    dbPath,
    args: { projectId },
    scan: {
      kind: "measured",
      docsTotal: scan.count,
      // 列表指纹：任何人用另一套实现枚举后取同样的 sha256，就能证明「两个独立口径对齐」，
      // 而不必肉眼比对 387 行。stdlib 的 readdir + 扩展名过滤即可复算。
      docsListSha256: listSha(scan.files.map((f) => f.relPath)),
      // 2026-10-29（卡 `-175`）：`scanProjectMaterials` 现已**跟随软链**并自带记账
      // （`followed` / `skipped[{relPath,target,reason}]`）⇒ 直接用它，不再在工具里另写一份朴素遍历。
      // 之前两份实现必然漂移：工具说「被跳过」、模块说「没看见」，谁也说不清谁对。
      symlinksFollowed: scan.symlinks?.followed ?? 0,
      symlinksSkipped: scan.symlinks?.skipped ?? [],
      truncated: scan.truncated,
      byExt: scan.files.reduce((acc, f) => { const e = extname(f.name).toLowerCase(); acc[e] = (acc[e] ?? 0) + 1; return acc; }, {}),
    },
    headings: {
      kind: "measured",
      note: "正则 ^# / ^## 实测计数；**不等于**『B 方案会建多少条条目』——那是假设每个标题落一条才成立（见 bSimulation）",
      ...heads,
    },
    bSimulation: {
      kind: "derived",
      assumption: "按 H1+H2 每标题 1 条条目（B 原方案字面口径）",
      itemsIfSplitByHeading: heads.h1Total + heads.h2Total,
    },
    intakeSimulation: {
      kind: "derived",
      assumption: "复刻 api.mjs:298-312 的判据（去重键 = title），不真写库",
      wouldCreateNow: wouldCreate.length,
      sample: wouldCreate.slice(0, 10).map((d) => ({ title: d.title, relPath: d.relPath })),
    },
    db: { kind: "measured", byStatus, ...totals, openBySource, normTitleMismatch: { count: staleNorm.length, sample: staleNorm.slice(0, 5).map((r) => ({ identifier: r.identifier, title: r.title, normTitle: r.norm_title })) } },
    dedupe: {
      kind: "measured",
      appLayerKey: "title（api.mjs 里的 Set）",
      dbUniqueConstraints: ["identifier"],
      note: "requirement_items 无 (project_id,title) 唯一约束 ⇒ 去重只在应用层，并发/多入口下不成立",
    },
    ...(has("e2e") ? { e2e: await runE2E({ root }) } : {}),
  };
  if (!existsSync(dbPath)) report.error = `数据库不存在：${dbPath}`;
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  // e2e 跑了就守住拒绝路径：任一条不是 400 / 码不对 / 有副作用 ⇒ 退出码 1（可进 CI）
  if (report.e2e) {
    const bad = report.e2e.rejects.filter((x) => !x.ok);
    if (bad.length || report.e2e.rejectDelta !== 0) {
      process.stderr.write(`[audit-intake] ✗ 拒绝路径不符：${JSON.stringify(bad)} rejectDelta=${report.e2e.rejectDelta}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`[audit-intake] ✓ 拒绝路径 3/3 均为 400 且零副作用（rejectDelta=0）· doc 路径 itemsDelta=${report.e2e.itemsDelta}\n`);
    }
  }
};

main().catch((e) => {
  process.stdout.write(JSON.stringify({ error: String(e?.message ?? e), stack: String(e?.stack ?? "") }, null, 2) + "\n");
  process.exit(1);
});
