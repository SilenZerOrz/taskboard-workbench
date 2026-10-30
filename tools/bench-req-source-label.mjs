/**
 * 需求条目「来源标签」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-179` / 需求 `R134`）
 * `REQUIREMENT_SOURCES` 早已含 `mcp`（B-b `c35174e` 补），MCP 建的条目落库 `source="mcp"`；
 * 但前端来源文案只认 `intake / elaborated-ai / elaborated-rule`，**其余一律回落「手工」**
 * ⇒ MCP 建的条目在列表与详情里都显示成「手工」。数据是对的，**只有人读的那一层在撒谎**：
 * 人会以为条目是自己手工建的，于是误判「谁该补验收」。
 *
 * 单测只能断言「源码里有 `mcp` 分支」，证明不了**渲染后**那句话真的是「MCP」——
 * 三元链一旦被改回、或胶囊被另一个 `pill()` 调用顶掉，文本断言仍会绿。所以必须有这台：
 * 在真实渲染后的 DOM 里读**列表胶囊**与**详情字段**的实际文本。
 *
 * ## 本台断言什么
 *   A. 列表：五种来源各一行的来源胶囊文案 ＝ `手工 / 资料索引 / AI / 规则 / MCP`
 *      —— `mcp` 必须是「MCP」（本条验收），其余四档**不回归**（防修一处崩三处）；
 *   B. 详情：点开 `source="mcp"` 那条，`来源` 字段 ＝ `MCP`；
 *   C. 详情：点开 `source="intake"` 那条，`来源` 字段 ＝ `资料索引(引入)`（防回归）；
 *   D. 全程无 error 横幅（漏改会走默认分支而不是报错，故这条只是旁证）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-req-source-label.mjs`
 *   —— 拷一份 `web/`，把两处三元的 `mcp` 分支删掉 ⇒ A / B 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`），
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-req-source-label.mjs`。
 *
 * 运行：`node tools/bench-req-source-label.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = process.env.TB_BENCH_WEB_DIR || path.join(ROOT, "web");
const VIEW = { width: 1600, height: 1100 };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>180s）——已强退，退出码 1"); process.exit(1); }, 180000);

// ---- 浏览器探测（找不到 ⇒ 跳过，不算失败） -------------------------------------------------
const CHROME_CANDIDATES = [
  process.env.TB_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);
const chromeBin = CHROME_CANDIDATES.find((p) => existsSync(p));
if (process.env.CODEX_SANDBOX) {
  console.log("SKIP  当前在 Codex 沙箱内（CODEX_SANDBOX 已设置）：GUI 浏览器启动必崩，本台不产证据，退出码 2");
  console.log('      正路：以 sandbox_permissions="require_escalated" 重跑本脚本（沙箱外应全绿）');
  process.exit(2);
}
if (!chromeBin) {
  console.log("SKIP  未找到 Chrome（可用 TB_CHROME=<路径> 指定）——本台不产证据，退出码 2");
  process.exit(2);
}

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/** 五种来源各一条：A 要把五档文案一次读全（只测 mcp 等于只守一半）。 */
const SEEDS = [
  { source: "manual", title: "来源-手工条目" },
  { source: "intake", title: "来源-资料索引条目" },
  { source: "elaborated-ai", title: "来源-AI拆解条目" },
  { source: "elaborated-rule", title: "来源-规则拆解条目" },
  { source: "mcp", title: "来源-MCP条目" },
];
const EXPECT_LIST = { manual: "手工", intake: "资料索引", "elaborated-ai": "AI", "elaborated-rule": "规则", mcp: "MCP" };

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;

try {
  // ---- 隔离服务：临时 dataDir + 随机端口，真 `web/` ----
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-srclabel-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-srclabel-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  for (const s of SEEDS) {
    store.createRequirementItem({ projectId: "default", title: s.title, status: "open", source: s.source });
  }

  server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  console.log(`… 台内服务 ${base} · dataDir=${dataDir} · webDir=${WEB_DIR}`);

  // ---- 真 headless Chrome + CDP ----
  const debugPort = await freePort();
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = null;
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    try {
      const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!wsUrl) { console.log("SKIP  devtools 端点未就绪 ——本台不产证据，退出码 2"); process.exit(2); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };

  // ---- 切到「需求」视图（页面默认看板视图） ----
  await S("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: `${base}/` });
  await sleep(2000);
  for (let i = 0; i < 40; i += 1) {
    const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (r === "no-btn") { await sleep(300); continue; }
    await sleep(600);
    const n = await evalJs(`document.querySelectorAll('.req-list .req-item').length`);
    if (n > 0) break;
  }

  // ---- A：列表五档来源胶囊文案（标题 → 胶囊文本） ----
  const rows = await evalJs(`(() => [...document.querySelectorAll('.req-list .req-item')].map((li) => ({
    title: (li.querySelector('.req-title')?.textContent ?? '').trim(),
    src: (li.querySelector('.req-item-meta .chip')?.textContent ?? '').trim(),
  })))()`);
  const byTitle = new Map(rows.map((r) => [r.title, r.src]));
  const listGot = SEEDS.map((s) => ({ source: s.source, want: EXPECT_LIST[s.source], got: byTitle.get(s.title) ?? "(缺行)" }));
  const listOk = listGot.every((x) => x.got === x.want);
  check("A 列表来源胶囊五档文案（mcp→MCP，其余不回归）", listOk,
    listGot.map((x) => `${x.source}=${x.got || "(空)"}`).join(" · "));

  /** 点标题开详情 → 读 `来源` 字段（dl 里 dt=来源 后面的 dd）。 */
  const openDetailAndReadSource = async (title) => {
    await evalJs(`(() => { const li = [...document.querySelectorAll('.req-list .req-item')].find((n) => (n.querySelector('.req-title')?.textContent ?? '').trim() === ${JSON.stringify(title)}); if (li) li.click(); return true; })()`);
    await sleep(900);
    return evalJs(`(() => {
      const dts = [...document.querySelectorAll('.req-fields dt')];
      const dt = dts.find((n) => n.textContent.trim() === '来源');
      return dt && dt.nextElementSibling ? dt.nextElementSibling.textContent.trim() : "(无来源字段)";
    })()`);
  };

  const mcpSrc = await openDetailAndReadSource("来源-MCP条目");
  check("B 详情来源字段（mcp→MCP）", mcpSrc === "MCP", `实际=${mcpSrc}`);

  const intakeSrc = await openDetailAndReadSource("来源-资料索引条目");
  check("C 详情来源字段不回归（intake→资料索引(引入)）", intakeSrc === "资料索引(引入)", `实际=${intakeSrc}`);

  const banner = await evalJs(`(() => { const b = document.querySelector('.banner'); return b ? b.textContent.trim() : ''; })()`);
  check("D 全程无 error 横幅", !/失败|错误/.test(banner), banner ? banner.slice(0, 60) : "(无横幅)");

  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAIL 项：" + failed.map((r) => r.name).join(" / "));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { if (chrome) chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { if (server) server.close(); } catch { /* ignore */ }
  for (const d of [dataDir, chromeProfile]) {
    if (!d) continue;
    try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
