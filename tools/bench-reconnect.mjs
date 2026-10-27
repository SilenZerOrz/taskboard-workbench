/**
 * 断线提示 + 重连即重取 —— **真实浏览器验证台**（FR-20 · 卡 `-156` / 取证 `-154`）。
 *
 * 为什么需要它：`-154` 的取证用的是一次性 `/private/tmp` 探针，跑完即删（不可复跑、无法防回归）；
 * 而 `-156` 的实现只由 `tests/fr20-reconnect.test.mjs` 的「源码切片 + 假 EventSource」守着 ——
 * 全仓**没有第二处**能证明「真浏览器里断线确实出提示、重连确实整块补齐」。
 * 本台把那次探针固化成可复跑证据，并直接驱动**真 headless Chrome**（CDP，Node 自带 WebSocket，零依赖）。
 *
 * 四段断言（对应 FR-20 验收 ③④⑤ 与 `-156` 登记的两个缺口）：
 *   A. 基线：页面加载出卡、**无**断线提示、SSE 已连上；
 *   B. 真断 TCP（`server.close()` + `closeAllConnections()`）+ 断连期间直接写库：
 *      ① 不把未恢复画成空数据（旧卡原样在）② 出现**常驻**「连接中断 · 重连中」提示（缺口 A）；
 *   C. 同端口恢复服务：
 *      ③ 提示**自动收起** ④ **无需任何人工刷新**就补齐断连期间写入的新卡（缺口 B）。
 *
 * 隔离边界：临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程；跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围：隔离验证台）。
 *
 * 运行：
 *   node tools/bench-reconnect.mjs
 *   TB_CHROME="/path/to/Google Chrome" node tools/bench-reconnect.mjs
 *
 * ⚠ 环境前提（2026-10-26 实测）：必须**能真正拉起 headless Chrome**。在受限沙箱里跑会得到
 *   「1 项 · PASS 0 · FAIL 1 — devtools 端点未就绪」，那是**环境**问题（Chrome 没起来），**不是产品缺陷**；
 *   在普通终端或提权会话里跑即为 9/9 PASS（约 4.3s）。
 *
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（没找到 Chrome）⇒ 跳过，不算失败。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer, ensureDefaultProject } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// 可指向另一份 `web/`（用于**反证**：把修复前的 app.js 放进去，本台必须转红）。
const WEB_DIR = process.env.TB_BENCH_WEB_DIR || path.join(ROOT, "web");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 整台看门狗：任何一步意外挂死都要有结论地退出，而不是静默吊住调用方（首跑真踩到）。
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
if (!chromeBin) {
  console.log("SKIP  未找到 Chrome（可用 TB_CHROME=<路径> 指定）——本台不产证据，退出码 2");
  process.exit(2);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const p = srv.address().port;
    srv.close(() => resolve(p));
  });
});

// ---- 台内项目：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-fr20-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-fr20-chrome-"));
const store = openStore({ dataDir, env: {} });
ensureDefaultProject(store);
store.createTask({ projectId: "default", title: "基线条目", status: "todo" });
// FR-20 验收要点写的是「另一窗口**修改两个任务**」⇒ 台上备**两处变更**：改一个 + 新建一个。
const edited = store.createTask({ projectId: "default", title: "待改条目", status: "todo" });

let server = createServer({ store, webDir: WEB_DIR });
const port = await freePort();
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
console.log(`… 台内服务 ${base} · dataDir=${dataDir}`);

// ---- CDP 客户端（Node 自带 WebSocket，零依赖） ----------------------------------------------
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.sessionId = null;
    ws.addEventListener("message", (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message ?? "cdp-error"}`));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId = this.sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时：${method}`)); }
      }, 30000);
    });
  }
}

let chrome = null;
let cdp = null;
let failed = false;
try {
  const debugPort = await freePort();
  chrome = spawn(chromeBin, [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--disable-extensions", "--disable-background-networking", "--window-size=1440,900",
    "about:blank",
  ], { stdio: "ignore" });

  // 等 devtools 端点起来
  let version = null;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (res.ok) { version = await res.json(); break; }
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!version?.webSocketDebuggerUrl) throw new Error("devtools 端点未就绪");

  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 连接失败")), { once: true });
  });
  cdp = new Cdp(ws);

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, null);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, null);
  cdp.sessionId = sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  // 在 app.js 之前包一层 EventSource，记录 readyState 轨迹（证明「浏览器确实自动重连过」）
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const Native = window.EventSource;
      window.__tbES = { opens: 0, errors: 0 };
      window.EventSource = function (...args) {
        const es = new Native(...args);
        es.addEventListener("open", () => { window.__tbES.opens += 1; });
        es.addEventListener("error", () => { window.__tbES.errors += 1; });
        return es;
      };
      window.EventSource.prototype = Native.prototype;
    })();`,
  });

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate 抛错");
    return r.result?.value;
  };
  const probe = `(() => {
    const notice = document.querySelector(".banner.error");
    return {
      titles: [...document.querySelectorAll("article.task-card .card-title")].map((n) => n.textContent.trim()),
      noticeHidden: notice ? notice.hidden === true : null,
      noticeText: notice ? notice.textContent.trim() : null,
      esOpens: window.__tbES?.opens ?? -1,
      esErrors: window.__tbES?.errors ?? -1,
    };
  })()`;
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evalJs(probe);
      if (predicate(last)) return last;
      await sleep(250);
    }
    return last ?? { note: `等待超时：${label}` };
  };

  await cdp.send("Page.navigate", { url: `${base}/` });

  // ---- A 基线 ------------------------------------------------------------------------------
  const a = await waitFor((s) => s.titles.length >= 1, 15000, "首屏出卡");
  check("A 基线：首屏加载出卡片", a.titles.includes("基线条目"), `titles=${JSON.stringify(a.titles)}`);
  check("A 基线：两处变更的目标都在（基线态）", a.titles.includes("待改条目"), `titles=${JSON.stringify(a.titles)}`);
  check("A 基线：SSE 已连上（EventSource open ≥ 1）", (a.esOpens ?? -1) >= 1, `opens=${a.esOpens}`);
  check("A 基线：无断线提示（connNotice 隐藏）", a.noticeHidden === true, `hidden=${a.noticeHidden} text=${a.noticeText}`);

  // ---- B 真断 TCP + 断连期间写库 -------------------------------------------------------------
  // 坑（首跑真踩到，整台挂死）：`server.close(cb)` 要等所有连接断完才回调，而 SSE 是长连接 =>
  // 必须先主动断连再等回调；顺序反了就永远不返回。
  const closed = new Promise((resolve) => server.close(resolve));
  try { server.closeAllConnections?.(); } catch { /* 老 node 无此 API */ }
  await closed;
  store.createTask({ projectId: "default", title: "断连期间写入的卡", status: "todo" });
  // 第二处变更：**修改**已有任务（FR-20 验收要点：另一窗口改两个任务）——断连期间直接写库。
  store.updateTask(edited.id, { expectedVersion: edited.version, title: "断连期间改过的条目" });

  const b = await waitFor((s) => s.noticeHidden === false, 20000, "断线提示出现");
  check("B 缺口A：断连后出现常驻提示（不再是无感的 readyState）", b.noticeHidden === false, `hidden=${b.noticeHidden}`);
  check("B 缺口A：提示文案如实（「连接中断 · 重连中」或「已断开·请刷新」）",
    typeof b.noticeText === "string" && /连接中断|实时连接已断开/.test(b.noticeText), `text=${b.noticeText}`);
  check("B 不把未恢复画成空数据：基线原样保留、且断连期间的两处变更都没提前出现",
    b.titles.includes("基线条目") && b.titles.includes("待改条目")
      && !b.titles.includes("断连期间写入的卡") && !b.titles.includes("断连期间改过的条目"),
    `titles=${JSON.stringify(b.titles)}`);

  // ---- C 同端口恢复 --------------------------------------------------------------------------
  server = createServer({ store, webDir: WEB_DIR });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));

  const c = await waitFor(
    (s) => s.noticeHidden === true && s.titles.includes("断连期间写入的卡") && s.titles.includes("断连期间改过的条目"),
    30000,
    "重连后自动补齐",
  );
  check("C 缺口B：重连后**无需人工刷新**即补齐断连期间的变更",
    c.titles.includes("断连期间写入的卡") && c.titles.includes("断连期间改过的条目"),
    `titles=${JSON.stringify(c.titles)}`);
  check("C FR-20 验收要点：断连期间的**两处变更**（改一个 + 新建一个）恢复后都在，且旧标题已被新值取代",
    c.titles.includes("断连期间改过的条目") && !c.titles.includes("待改条目") && c.titles.filter((t) => t === "断连期间改过的条目").length === 1,
    `titles=${JSON.stringify(c.titles)}`);
  check("C 缺口A：恢复后提示自动收起", c.noticeHidden === true, `hidden=${c.noticeHidden}`);
  check("C 证据：浏览器确实自动重连过（EventSource open ≥ 2，且期间报过 error）",
    (c.esOpens ?? -1) >= 2 && (c.esErrors ?? -1) >= 1, `opens=${c.esOpens} errors=${c.esErrors}`);
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  try { await cdp?.send("Browser.close", {}, null); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server.closeAllConnections?.(); } catch { /* 忽略 */ }
  try { server.close(); } catch { /* 忽略 */ }
  try { store.close(); } catch { /* 忽略 */ }
  await sleep(300);
  for (const dir of [dataDir, chromeProfile]) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failedCount} · FAIL ${failedCount} ----`);
clearTimeout(watchdog);
process.exit(failedCount === 0 ? 0 : 1);
