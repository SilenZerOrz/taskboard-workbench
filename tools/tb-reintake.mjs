#!/usr/bin/env node
/**
 * tb-reintake.mjs —— 重新引入项目资料（清理旧引入 + 按白名单/范围重灌），用于"重新开局"。
 *
 * 用法：
 *   node tools/tb-reintake.mjs --url "http://127.0.0.1:3080/?token=XXX" --project <项目id> \
 *     [--include "docs/需求文档.md,docs/计划文档.md,spec/团队agent.md"] \
 *     [--exclude "docs/历史归档"] [--exts ".md,.txt"] [--depth 4] [--mode doc|items|both] [--yes]
 *
 * 默认 **dry-run**（只扫描 + 打印计划：将删除多少旧条目、将引入多少文档）；加 `--yes` 才真正执行。
 * 只删 `source=intake` 的条目（手工/规则/AI 产出的条目不动）。
 */
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const val = (name, fallback = undefined) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const list = (name) => { const v = val(name); return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined; };

const url = val("--url") ?? process.env.DSH_URL ?? "";
const project = val("--project");
const include = list("--include");
const exclude = list("--exclude") ?? ["docs/历史归档"];
const exts = list("--exts");
const depth = val("--depth") ? Number(val("--depth")) : 4;
const mode = val("--mode") ?? "doc";           // 默认只建"资料索引"（写入需求文档），不刷条目
const cleanAll = has("--clean-all");            // 连非引入条目一起清（谨慎；需 --yes）
const yes = has("--yes");

if (!url) { console.error("缺少 --url（带 token 的 URL，或设 DSH_URL）"); process.exit(2); }
if (!project) { console.error("缺少 --project <项目id>"); process.exit(2); }

const m = url.match(/^https?:\/\/[^/]+/);
if (!m) { console.error(`--url 不是合法 URL：${url}`); process.exit(2); }
const base = m[0];
const token = (url.match(/[?&]token=([^&]+)/) ?? [])[1] ?? process.env.DSH_TOKEN ?? "";
const PREFIX = "/integrations/taskboard-workbench";
const q = (params) => { const u = new URLSearchParams(params); if (token) u.set("token", token); return u.toString(); };
const api = async (method, path, body) => {
  const res = await fetch(`${base}${PREFIX}${path}${path.includes("?") ? "&" : "?"}${q({})}`, {
    method, headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error?.message ?? text.slice(0, 200)}`);
  return json;
};

console.log(`[reintake] base=${base} project=${project} mode=${mode} depth=${depth} dryRun=${!yes}`);
console.log(`[reintake] include=${include ? include.join(" ") : "（全部）"}  exclude=${exclude.join(" ")}  exts=${exts ? exts.join(" ") : "（默认）"}`);

// 1) 计划：扫描（dryRun）+ 统计将清理的旧引入条目
const scan = await api("POST", `/api/projects/${encodeURIComponent(project)}/intake`, {
  dryRun: true, include, exclude, exts, maxDepth: depth, maxFiles: 500,
});
const existing = await api("GET", `/api/requirements/items?project=${encodeURIComponent(project)}`);
// 兼容老版本引入：旧条目 source=manual，但 description 以「来源：`」开头。
const isIntakeish = (i) => cleanAll || i.source === "intake" || String(i.description ?? "").startsWith("来源：`");
const stale = (existing.items ?? []).filter(isIntakeish);
console.log(`[reintake] 将扫描到 ${scan.scanned} 个文档${scan.truncated ? "（截断）" : ""}`);
for (const f of (scan.files ?? []).slice(0, 30)) console.log(`    - ${f.relPath} (${f.bytes}B${f.readable ? "" : " 二进制"})`);
if ((scan.files ?? []).length > 30) console.log(`    … 其余 ${scan.files.length - 30} 个`);
console.log(`[reintake] 现有条目 ${(existing.items ?? []).length} 条，将清理 ${stale.length} 条${cleanAll ? "（--clean-all：全部）" : "（引入产生的；source=intake 或描述以「来源：`」开头）"}`);

if (!yes) { console.log("[reintake] dry-run：未做任何改动。确认后加 --yes 执行。"); process.exit(0); }

// 2) 清理旧引入条目
let removed = 0;
for (const it of stale) {
  try { await api("DELETE", `/api/requirements/items/${encodeURIComponent(it.identifier)}`); removed += 1; }
  catch (e) { console.error(`  删除 ${it.identifier} 失败：${e.message}`); }
}
console.log(`[reintake] 已清理 ${removed}/${stale.length} 条旧引入条目`);

// 3) 重新引入
const result = await api("POST", `/api/projects/${encodeURIComponent(project)}/intake`, {
  include, exclude, exts, maxDepth: depth, maxFiles: 500, mode, status: "draft",
});
console.log(`[reintake] 重新引入完成：扫描 ${result.scanned}，生成条目 ${result.itemsCreated}，需求文档 v${result.doc?.version ?? "?"}（${result.doc?.bytes ?? 0}B）`);
console.log("[reintake] 生成条目均为 draft（待确认）；请在需求视图用筛选/确认/删除收敛。");
