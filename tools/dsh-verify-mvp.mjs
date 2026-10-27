#!/usr/bin/env node
/**
 * dsh-verify-mvp.mjs —— 加载后自检（在【你的终端】运行；需 DSH 已运行）。
 *
 * DSH Web 鉴权：`dsh web` 打印的根 URL 携带进程 **token**（`?token=`）；token 只在根 `/`(GET) 被接受，
 * 服务端据此铸造**签名 cookie**（`dsh-auth-<...>`）并 30x 重定向到 `./`；此后请求靠该 cookie。
 *
 * 用法（任一）：
 *   1) node tools/dsh-verify-mvp.mjs "http://127.0.0.1:3080/?token=<dsh web 打印的token>"
 *   2) DSH_TOKEN=<token> DSH_BASE=http://127.0.0.1:3080 node tools/dsh-verify-mvp.mjs
 *   3) DSH_COOKIE="dsh-auth-xxxx=yyyy" DSH_BASE=http://127.0.0.1:3080 node tools/dsh-verify-mvp.mjs
 *
 * 逐项打印 PASS/FAIL + 证据；退出码 0=全过，1=有 FAIL。幂等、无副作用。
 */
const arg = process.argv[2] || process.env.DSH_BASE || "http://127.0.0.1:3080";
const parsed = new URL(arg);
let token = parsed.searchParams.get("token") || process.env.DSH_TOKEN || "";
parsed.searchParams.delete("token");
parsed.search = "";
const base = parsed.origin + parsed.pathname.replace(/\/+$/, "");
let cookie = process.env.DSH_COOKIE || "";
const API = `${base}/integrations/taskboard-workbench/api`;
let fails = 0;
const tried = [];

function note(url, status) { tried.push(`${url} → ${status}`); }
function authHeaders() { return cookie ? { cookie } : {}; }

/** 用 token 在根 `/` 完成握手，抓取签名 cookie。 */
async function acquireCookie() {
  if (cookie || !token) return;
  try {
    const root = new URL(base + "/");
    root.searchParams.set("token", token);
    const res = await fetch(root, { redirect: "manual" });
    note(root.toString(), res.status);
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie")].filter(Boolean);
    for (const c of setCookies) {
      const m = /(dsh-auth-[^=]+)=([^;]+)/.exec(c ?? "");
      if (m) { cookie = `${m[1]}=${m[2]}`; return; }
    }
  } catch (error) {
    note(`handshake ${base}/?token=…`, `ERR:${error.message}`);
  }
}

async function check(name, fn) {
  try {
    const evidence = await fn();
    console.log(`PASS  ${name}  —  ${evidence}`);
  } catch (error) {
    fails += 1;
    console.log(`FAIL  ${name}  —  ${error.message}`);
  }
}

await acquireCookie();

await check("客户端 bundle 已注册（combo 内含 taskboard-workbench）", async () => {
  // DSH 不按 /plugins/<pkg>/client.js 单独伺服；它把多个插件合成一条 combo URL
  // （plugins/??a/client.js,b/client.js&rev=…）内联进首页。故按首页实际引用的 combo 复核。
  const home = await fetch(`${base}/`, { headers: authHeaders(), redirect: "manual" });
  const html = await home.text();
  const combo = /plugins\/\?\?[^"']*taskboard-workbench\/client\.js[^"']*/.exec(html)?.[0];
  if (!combo) throw new Error("首页 combo 未含 taskboard-workbench/client.js（客户端半未注册）");
  const url = `${base}/${combo.replace(/&amp;/g, "&")}`;
  const res = await fetch(url, { headers: authHeaders(), redirect: "manual" });
  note("首页 combo（含本插件）", res.status);
  if (res.status === 401) throw new Error("401 需鉴权：请用 `dsh web` 打印的带 token URL 重跑（token 只在根 `/` 生效）");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.includes("taskboard-workbench")) throw new Error("combo 未含本插件代码");
  return `combo HTTP ${res.status}，含 taskboard-workbench（bytes=${text.length}）`;
});

await check("首页 GET / 含 taskboard-workbench", async () => {
  const url = `${base}/`;
  const res = await fetch(url, { headers: authHeaders(), redirect: "manual" });
  note(url, res.status);
  if (res.status === 401) throw new Error("401 需鉴权：请用带 token URL 重跑");
  const text = await res.text();
  if (!text.includes("taskboard-workbench")) throw new Error("响应未含包名");
  return "命中包名";
});

await check("宿主 API /api/tasks 返回 JSON", async () => {
  const url = `${API}/tasks`;
  const res = await fetch(url, { headers: authHeaders(), redirect: "manual" });
  note(url, res.status);
  if (res.status === 401) throw new Error("401 需鉴权：请用带 token URL 重跑");
  const json = await res.json();
  return `count=${json.count} schemaVersion=${json.schemaVersion ?? "?"}`;
});

// FR-79：可操作诊断框架（只读检查；GET 会顺带"评估+落库"一次诊断状态，故为幂等）
await check("FR-79 诊断：卡片摘要 / 单任务完整列表 / 项目级汇总", async () => {
  const res = await fetch(`${API}/tasks?withWatchdog=1`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/tasks?withWatchdog=1`, res.status);
  if (res.status === 401) throw new Error("401 需鉴权：请用带 token URL 重跑");
  const json = await res.json();
  const tasks = json.tasks ?? [];
  const summarized = tasks.filter((t) => t.diagnostics);
  for (const t of summarized) {
    const keys = Object.keys(t.diagnostics).sort().join("+");
    if (keys !== "count+highestSeverity+kinds") throw new Error(`卡片摘要字段应只有 {count,kinds,highestSeverity}，实为 ${keys}`);
  }
  const target = tasks.find((t) => t.diagnostics?.count > 0) ?? tasks[0];
  if (!target) throw new Error("库里没有任务，无法检查单任务诊断");
  const detailRes = await fetch(`${API}/tasks/${encodeURIComponent(target.identifier)}/diagnostics`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/tasks/${target.identifier}/diagnostics`, detailRes.status);
  const detail = await detailRes.json();
  if (!Array.isArray(detail.diagnostics)) throw new Error("单任务诊断响应缺 diagnostics 数组");
  if (detail.count !== detail.diagnostics.length) throw new Error("count 与列表长度不一致");
  for (const d of detail.diagnostics) {
    if (!d.kind || !d.severity || !d.title || !d.detail) throw new Error(`诊断缺字段：${JSON.stringify(d).slice(0, 120)}`);
    if (!Array.isArray(d.actions) || d.actions.length < 1) throw new Error(`诊断 ${d.kind} 没有恢复动作`);
    if (!d.actions.some((a) => a.kind === "primary")) throw new Error(`诊断 ${d.kind} 未标注首选动作`);
    if (!d.suggested) throw new Error(`诊断 ${d.kind} 缺 suggested`);
  }
  const projRes = await fetch(`${API}/projects/${encodeURIComponent(target.projectId)}/diagnostics`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/projects/${target.projectId}/diagnostics`, projRes.status);
  const proj = await projRes.json();
  if (!proj.summary || typeof proj.summary.total !== "number") throw new Error("项目级诊断缺 summary.total");
  return `卡片摘要 ${summarized.length}/${tasks.length} 张 · ${target.identifier} 诊断 ${detail.count} 条 · 项目级 total=${proj.summary.total}（high=${proj.summary.bySeverity?.high ?? 0}）`;
});

// FR-82：尝试记录 + 事件流（只读检查）
await check("FR-82 尝试记录与事件流：/runs + /events（任务级与项目级）", async () => {
  const listRes = await fetch(`${API}/tasks`, { headers: authHeaders(), redirect: "manual" });
  if (listRes.status === 401) throw new Error("401 需鉴权：请用带 token URL 重跑");
  const list = await listRes.json();
  const task = (list.tasks ?? [])[0];
  if (!task) throw new Error("库里没有任务，无法检查尝试记录");
  const runsRes = await fetch(`${API}/tasks/${encodeURIComponent(task.identifier)}/runs`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/tasks/${task.identifier}/runs`, runsRes.status);
  const runs = await runsRes.json();
  if (runs.count !== runs.runs.length) throw new Error("runs.count 与列表长度不一致");
  for (const r of runs.runs) {
    if (!r.attempt || !r.startedAt) throw new Error(`尝试记录缺字段：${JSON.stringify(r).slice(0, 120)}`);
    if (r.status === "ended" && !r.outcome) throw new Error(`第 ${r.attempt} 次尝试已结束却没有 outcome`);
    if (r.status === "ended" && !r.endedAt) throw new Error(`第 ${r.attempt} 次尝试缺 ended_at`);
  }
  const evRes = await fetch(`${API}/tasks/${encodeURIComponent(task.identifier)}/events?limit=20`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/tasks/${task.identifier}/events`, evRes.status);
  const ev = await evRes.json();
  if (!Array.isArray(ev.events)) throw new Error("事件流响应缺 events 数组");
  if (typeof ev.cursor !== "number") throw new Error("事件流响应缺 cursor（FR-81 的推送游标）");
  const cursors = ev.events.map((e) => e.cursor);
  if (cursors.join() !== cursors.slice().sort((a, b) => b - a).join()) throw new Error("事件游标应单调（默认倒序）");
  const projEvRes = await fetch(`${API}/projects/${encodeURIComponent(task.projectId)}/events?limit=5`, { headers: authHeaders(), redirect: "manual" });
  note(`${API}/projects/${task.projectId}/events`, projEvRes.status);
  const projEv = await projEvRes.json();
  return `${task.identifier} 尝试 ${runs.count} 条（进行中 ${runs.currentRun ? 1 : 0}） · 事件 ${ev.count} 条（cursor=${ev.cursor}） · 项目事件 ${projEv.count} 条`;
});

// FR-81：通知订阅与唤醒（只建一条**本项目专用、mode=notify（只留痕、不投会话）**的验证订阅；
// 用固定 sessionId `fr81-verify` 隔离，绝不碰用户自己的订阅）
await check("FR-81 通知订阅：订阅 + 游标预览 + flush 推进游标", async () => {
  const listRes = await fetch(`${API}/tasks`, { headers: authHeaders(), redirect: "manual" });
  if (listRes.status === 401) throw new Error("401 需鉴权：请用带 token URL 重跑");
  const list = await listRes.json();
  const task = (list.tasks ?? [])[0];
  if (!task) throw new Error("库里没有任务，无法检查通知订阅");
  const projectId = task.projectId;
  const jsonHeaders = { ...authHeaders(), "content-type": "application/json" };
  const subRes = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/notify`, {
    method: "POST", headers: jsonHeaders, redirect: "manual",
    body: JSON.stringify({ sessionId: "fr81-verify", mode: "notify" }),
  });
  note(`POST ${API}/projects/${projectId}/notify`, subRes.status);
  if (subRes.status !== 201 && subRes.status !== 200) throw new Error(`建订阅失败：HTTP ${subRes.status}`);
  const sub = (await subRes.json()).subscription;
  if (!sub?.id || sub.mode !== "notify") throw new Error(`订阅响应异常：${JSON.stringify(sub).slice(0, 160)}`);
  if (sub.active !== true || typeof sub.lastCursor !== "number") throw new Error("订阅缺 active / lastCursor");
  const listNotifyRes = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/notify`, { headers: authHeaders(), redirect: "manual" });
  note(`GET ${API}/projects/${projectId}/notify`, listNotifyRes.status);
  const subs = await listNotifyRes.json();
  if (!subs.summary || typeof subs.summary.pending !== "number") throw new Error("订阅列表缺 summary.pending");
  const mine = (subs.subscriptions ?? []).find((s) => s.sessionId === "fr81-verify");
  if (!mine) throw new Error("刚建的订阅没出现在列表里");
  if (!mine.pending || !Array.isArray(mine.pending.kinds)) throw new Error("订阅缺 pending.kinds（未推送终态）");
  const prevRes = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/notify/events?limit=20`, { headers: authHeaders(), redirect: "manual" });
  note(`GET ${API}/projects/${projectId}/notify/events`, prevRes.status);
  const preview = await prevRes.json();
  if (!Array.isArray(preview.events)) throw new Error("预览响应缺 events 数组");
  if (typeof preview.cursor !== "number") throw new Error("预览响应缺 cursor");
  const flushRes = await fetch(`${API}/projects/${encodeURIComponent(projectId)}/notify/flush`, {
    method: "POST", headers: jsonHeaders, redirect: "manual", body: JSON.stringify({ subId: sub.id }),
  });
  note(`POST ${API}/projects/${projectId}/notify/flush`, flushRes.status);
  if (flushRes.status !== 200) throw new Error(`flush 失败：HTTP ${flushRes.status}`);
  const flushed = await flushRes.json();
  if (!flushed.summary || typeof flushed.summary.total !== "number") throw new Error("flush 响应缺 summary");
  const item = (flushed.results ?? [])[0];
  if (!item || typeof item.delivered !== "boolean") throw new Error("flush 响应缺 results[].delivered");
  return `订阅 ${subs.count} 条（本项目） · 待推送 ${mine.pending.count} 条 · flush ${item.delivered ? "已推送" : "无待推"}（cursor=${item.cursor}，mode=${item.mode}）`;
});

console.log("----");
if (fails) {
  console.log("提示：若为 401，请用 `dsh web` 启动行打印的**带 token URL** 作为参数重跑（token 只在根 `/` 生效，脚本会自动换取 cookie）。");
  console.log("本次尝试的 URL 与状态码：");
  for (const t of tried) console.log(`  ${t}`);
}
console.log("侧栏入口/面板：本机若无 headless 环境，请人工在 UI 看“任务工作台”图标是否出现（不做自动点击）。");
console.log(fails ? `结果：${fails} 项 FAIL` : "结果：全部 PASS");
process.exit(fails ? 1 : 0);
