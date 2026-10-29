/**
 * 卡 `-159`「自动复核证据可读性」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，Node 自带 WebSocket，零依赖）。
 *
 * ## 为什么还要第二台（`-159` 的验收第三条要求「⌘R 后上述内容**可见**」）
 * `tools/bench-review-evidence.mjs` 已证明**后端**证据评论与详情证据包字段齐全，但那是**数据面**。
 * 真机报障的原话是「**只显示一行结论**」—— 那是**界面面**。若 `web/app.js` 里渲染四段的代码被误删，
 * 后端台仍全绿 ⇒ 这正是需要真浏览器读数的理由。
 *
 * ## 本台断言什么（在**真实渲染后的 DOM** 里读，不读源码）
 *   A. 拉起隔离服务（临时 dataDir + 随机端口 + 仓库自己的 `createServer`，真 `web/`）→ 真 headless Chrome 打开；
 *   B. 造一张**带验收标准**的卡 ⇒ 调 `POST /api/tasks/:ref/auto-review`（真跑命令）⇒ 落证据评论；
 *   C. 在浏览器里**打开该卡的抽屉**（点卡片）⇒ 在**渲染后的 DOM** 里读「自动复核证据」块：
 *      ① 结论（verdict 行）② 复核总结 ③ 当时的验收标准（**逐字**可见）④ 输出尾段（可展开）；
 *   D. 反向对照：卡**没有**验收标准时 ⇒ DOM 里**不得**出现「该次复核记录的本卡验收标准」块；
 *   E. 反证入口：把**修复前**的 `web/` 放进去（`TB_BENCH_WEB_DIR`）⇒ 本台必须**转红**（证明本台真的在读界面）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-review-evidence-dom.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（找不到 Chrome）⇒ 跳过。
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
// 沙箱内启动 GUI 浏览器必崩（mach 服务被拒）⇒ 提前退出，不刷崩溃报告（见 AGENTS.md §7）
if (process.env.CODEX_SANDBOX) {
  console.log("SKIP  当前在 Codex 沙箱内（CODEX_SANDBOX 已设置）：GUI 浏览器启动必崩，本台不产证据，退出码 2");
  console.log('      正路：以 sandbox_permissions="require_escalated" 重跑本脚本（沙箱外应全绿）');
  process.exit(2);
}
if (!chromeBin) {
  console.log("SKIP  未找到 Chrome（可用 TB_CHROME=<路径> 指定）——本台不产证据，退出码 2");
  process.exit(2);
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

// ---- 台内数据：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reviewevidence-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-reviewevidence-chrome-"));
const store = openStore({ dataDir, env: {} });
// 注意：`ensureDefaultProject` 建的默认项目**没有 workspacePath**，而自动复核必须有工作区
// （否则路由如实拒绝 `PROJECT_WORKSPACE_MISSING` ⇒ 400）。本台自己建带工作区的项目。
const workspaceDir = await mkdtemp(path.join(os.tmpdir(), "tb-reviewevidence-ws-"));
store.createProject({ id: "default", name: "默认项目", workspacePath: workspaceDir });

const ACCEPTANCE = "① 证据必须含结论；② 必须含总结；③ 必须含当时的验收标准；④ 必须含输出尾段。";
const withStd = store.createTask({
  projectId: "default",
  title: "带验收标准的卡",
  acceptance: ACCEPTANCE,
  verifyCommand: "node -e \"console.log('# tests 4');console.log('# pass 4');console.log('# fail 0')\"",
});
const noStd = store.createTask({
  projectId: "default",
  title: "无验收标准的卡",
  acceptance: "",
  verifyCommand: "node -e \"console.log('# tests 2');console.log('# pass 2');console.log('# fail 0')\"",
});

let server = createServer({ store, webDir: WEB_DIR });
const port = await freePort();
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
console.log(`… 台内服务 ${base} · dataDir=${dataDir} · webDir=${WEB_DIR}`);

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
try {
  const debugPort = await freePort();
  // ⚠ 环境坑（2026-10-27 实测）：在 DSH 的 workspace-write 沙箱里，Chrome **自带沙箱**拉不起渲染进程
  //   ⇒ `Target.createTarget`/`attachToTarget` 都成功，但 `Page.enable` / `Runtime.enable` **全部超时**
  //   （表现为「devtools 端点就绪、page 域却无响应」，极易误判成产品缺陷）。
  //   本台用的是**临时 profile + 无用户数据**的隔离浏览器 ⇒ 加 `--no-sandbox` 系列让渲染进程起来即可；
  //   这与 `bench-reconnect` 在窄沙箱里「1 FAIL＝环境限制」是同一个成因，只是这里给了可复跑的解法。
  chrome = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${chromeProfile}`,
    "about:blank",
  ], { stdio: "ignore" });

  let version = null;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
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
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 失败")), { once: true });
  });
  cdp = new Cdp(ws);
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }, null);
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }, null);
  cdp.sessionId = sessionId;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`JS 异常：${r.exceptionDetails.text ?? ""}`);
    return r.result?.value;
  };

  // ---- B. 真跑一次自动复核（走真实 HTTP 路由，不是内部函数） --------------------------------
  const runReview = async (identifier) => {
    const res = await fetch(`${base}/api/tasks/${identifier}/auto-review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const r1 = await runReview(withStd.identifier);
  check("B 真实 auto-review 路由返回 201", r1.status === 201, `status=${r1.status}`);
  const r2 = await runReview(noStd.identifier);
  check("B 反向对照卡也跑通复核", r2.status === 201, `status=${r2.status}`);

  // ---- C. 真浏览器打开看板 → 点开卡 → 读**渲染后**的 DOM -----------------------------------
  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(2500);

  const probeTitles = `(() => [...document.querySelectorAll("article.task-card .card-title")].map((n) => n.textContent.trim()))()`;
  const waitFor = async (fn, timeoutMs, label) => {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      last = await fn();
      if (last?.ok) return last;
      await sleep(300);
    }
    return last ?? { ok: false, note: `等待超时：${label}` };
  };

  const titles = await waitFor(async () => {
    const t = await evalJs(probeTitles);
    return { ok: Array.isArray(t) && t.length >= 2, titles: t };
  }, 20000, "看板出卡");
  check("C 看板首屏出卡（含带/不带验收标准两张）",
    Array.isArray(titles.titles) && titles.titles.includes("带验收标准的卡") && titles.titles.includes("无验收标准的卡"),
    JSON.stringify(titles.titles));

  // 点开「带验收标准的卡」→ 抽屉渲染「自动复核证据」块
  const openDrawer = async (title) => {
    await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(title)});
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await sleep(1500);
    return evalJs(`(() => {
      const body = document.querySelector(".tb-drawer-body");
      if (!body) return null;
      const ev = body.querySelector(".review-evidence");
      if (!ev) return null;
      const verdict = ev.querySelector(".review-evidence-verdict")?.textContent?.trim() ?? "";
      const summary = ev.querySelector(".review-evidence-summary")?.textContent?.trim() ?? "";
      const hintTexts = [...ev.querySelectorAll("p.hint")].map((n) => n.textContent.trim());
      const stdLabel = hintTexts.find((t) => t.includes("该次复核记录的本卡验收标准")) ?? "";
      // 验收标准紧跟在这条 hint 之后的富文本节点里
      let stdText = "";
      const stdHint = [...ev.querySelectorAll("p.hint")].find((n) => n.textContent.includes("该次复核记录的本卡验收标准"));
      if (stdHint) {
        let n = stdHint.nextElementSibling;
        while (n && !stdText) { stdText = (n.textContent ?? "").trim(); n = n.nextElementSibling; }
      }
      const tailDetails = ev.querySelector("details.review-evidence-tail");
      const tailSummary = tailDetails?.querySelector("summary")?.textContent?.trim() ?? "";
      const tailPre = tailDetails?.querySelector("pre")?.textContent ?? "";
      const failures = [...ev.querySelectorAll(".review-evidence-failures li")].map((n) => n.textContent.trim());
      return { verdict, summary, stdLabel, stdText, tailSummary, tailLen: tailPre.length, failures, evText: ev.textContent };
    })()`);
  };

  const ev1 = await openDrawer("带验收标准的卡");
  check("C 抽屉里出现「自动复核证据」块", !!ev1, ev1 ? "" : "未找到 .review-evidence");
  check("C① DOM 里可见**结论**", /最近一次自动复核/.test(ev1?.verdict ?? ""), ev1?.verdict);
  check("C② DOM 里可见**复核总结**", /复核总结/.test(ev1?.summary ?? ""), ev1?.summary);
  check("C③ DOM 里可见**当时的验收标准**标题", /该次复核记录的本卡验收标准/.test(ev1?.stdLabel ?? ""), ev1?.stdLabel);
  check("C③ DOM 里验收标准**逐字可见**", (ev1?.stdText ?? "").includes("④ 必须含输出尾段。"), ev1?.stdText);
  check("C④ DOM 里可见**输出尾段**（折叠块，可展开）", /输出尾段/.test(ev1?.tailSummary ?? "") && (ev1?.tailLen ?? 0) > 0,
    `summary=${ev1?.tailSummary} · tailLen=${ev1?.tailLen}`);

  // ---- D. 反向对照：没有验收标准的卡 ⇒ DOM 里不得出现验收标准块 -----------------------------
  const ev2 = await openDrawer("无验收标准的卡");
  check("D 反向对照：无验收标准时 DOM 里**不**出现验收标准块", !/该次复核记录的本卡验收标准/.test(ev2?.evText ?? ""),
    `evText 含该串=${/该次复核记录的本卡验收标准/.test(ev2?.evText ?? "")}`);
  check("D 反向对照：结论与总结仍在（不是整块缺失）", !!ev2?.verdict && !!ev2?.summary, `verdict=${ev2?.verdict}`);

  // ---- E. 证据评论本身（人也能在评论里读到） -----------------------------------------------
  const detail = await (await fetch(`${base}/api/tasks/${withStd.identifier}`)).json();
  const body = (detail.comments ?? []).map((c) => c.body ?? "").join("\n");
  check("E 证据评论同时含 结论/验收标准/总结/输出尾段",
    body.includes("结论=") && body.includes("本卡验收标准：") && body.includes("总结：") && body.includes("输出尾段："), "");
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  try { await cdp?.send("Browser.close", {}, null); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server?.close?.(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, chromeProfile, workspaceDir]) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
process.exit(0);
