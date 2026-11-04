/**
 * 任务抽屉「三处判断收敛」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-199` / 需求 `R151`）
 * 抽屉里原本有**三处各自取数**的判断：「下一步」文案打 `GET …/next-step`、「看护黄条」读
 * `exec.watchdog`、「诊断块」读 `exec.diagnostics` —— 同一张卡、同一屏，三套来源。
 * 卡 `-199` 把它们收敛成消费 `GET /api/tasks/:ref` 回包里的**同一份** `ticketStage`。
 *
 * 源码守卫（`tests/ticket-stage-api.test.mjs` H 条）只能证明「旧调用点字符串消失了」，
 * 证明不了**渲染后**那句话真的来自 `ticketStage`：三元链被改回、或某个区块另走一路，
 * 源码仍可能看起来干净。所以本台做**差分对照**：
 *   · 详情回包里的 `ticketStage` ⇒ 塞入带标记的**真值**（NEW）；
 *   · 三个旧端点（`/next-step`、`/execution` 的 `watchdog` / `diagnostics`）⇒ 塞入**毒值**（POISON）。
 * 渲染后必须读到 NEW、且整屏不得出现 POISON —— 这才是"收敛"的可执行判据。
 *
 * ## 本台断言什么（四态 + 差分）
 *   A `format_ok`：`next.title` = NEW；且看护黄条/诊断块也来自 `ticketStage`（不是毒值）
 *   B `ready`  ·  C `stale` ·  D 流程态（`in_progress`）：各自 `next.title` = NEW，且无 POISON
 *   E 全程无 error 横幅（旁证：漏改会静默走旧源，不会报错）
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-ticket-stage-drawer.mjs`
 *   —— 拷一份 `web/`，把三处换回旧源（`exec?.watchdog` / `exec?.diagnostics` / `await …/next-step`）
 *   ⇒ A/B/C/D 全部读到 POISON ⇒ 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`），
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-ticket-stage-drawer.mjs`。
 *
 * 运行：`node tools/bench-ticket-stage-drawer.mjs`
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

/** 四态：每张卡的 `ticketStage` 由本台**注入**（0-C 建表前 ready/stale 无法从库里造出来）。 */
const CASES = [
  {
    key: "A-format_ok", stage: "format_ok", cardTitle: "台-A 四字段齐",
    nextTitle: "NEW-A · 证据四字段齐",
    watch: { state: "stalled", minutes: 37, followups: [], reason: "session-offline" },
    diagnostics: [{ kind: "stalled", severity: "high", title: "NEW-A 诊断项", detail: "来自 ticketStage 的诊断", count: 1, actions: [] }],
  },
  { key: "B-ready", stage: "ready", cardTitle: "台-B 可收口", nextTitle: "NEW-B · 判定与证据一致", watch: { state: "ok", minutes: 0, followups: [], reason: null }, diagnostics: [] },
  { key: "C-stale", stage: "stale", cardTitle: "台-C 判定过期", nextTitle: "NEW-C · 判定已作废", watch: { state: "ok", minutes: 0, followups: [], reason: null }, diagnostics: [] },
  { key: "D-flow", stage: "in_progress", cardTitle: "台-D 进行中", nextTitle: "NEW-D · 盯执行侧回写", watch: { state: "ok", minutes: 0, followups: [], reason: null }, diagnostics: [] },
];

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;

try {
  // ---- 隔离服务：临时 dataDir + 随机端口，真 `web/` ----
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-tsdrawer-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-tsdrawer-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  const refByTitle = new Map();
  for (const c of CASES) {
    const t = store.createTask({ projectId: "default", title: c.cardTitle, status: "in_progress" });
    refByTitle.set(c.cardTitle, t.identifier);
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

  // ---- 注入：真值走 ticketStage，三个旧端点一律毒化（差分对照的关键） ----
  const inject = new Map();
  for (const c of CASES) {
    inject.set(refByTitle.get(c.cardTitle), {
      stage: c.stage, reason: `台内注入：${c.stage}`,
      delivery: { state: c.stage === "stale" ? "stale" : c.stage === "ready" ? "ready" : "format_ok", reason: "台内注入" },
      next: { code: "bench", title: c.nextTitle, hint: "台内注入的下一步", steps: [], actions: [], focus: [], blocker: null },
      watch: c.watch, verify: null, diagnostics: c.diagnostics,
    });
  }
  const injectScript = `(() => {
    const MAP = ${JSON.stringify(Object.fromEntries(inject))};
    const orig = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const m = /\\/api\\/tasks\\/([^/?#]+)(\\/next-step|\\/execution)?$/.exec(url.replace(/\\?.*$/, ""));
      const res = await orig(input, init);
      if (!m) return res;
      const ref = decodeURIComponent(m[1]);
      const c = MAP[ref];
      if (!c) return res;
      let body; try { body = await res.clone().json(); } catch { return res; }
      const kind = m[2] || "";
      if (kind === "") body.ticketStage = c;
      else if (kind === "/next-step") body = { nextStep: { code: "POISON", title: "POISON-next-step", hint: "", steps: [], actions: [], focus: [], blocker: null } };
      else {
        body.watchdog = { state: "stalled", minutes: 999, followups: ["POISON-followup"], reason: "session-offline" };
        body.diagnostics = [{ kind: "poison", severity: "low", title: "POISON-diag", detail: "旧源", count: 1, firstSeenAt: null, lastSeenAt: null, actions: [] }];
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    };
  })();`;
  await S("Page.addScriptToEvaluateOnNewDocument", { source: injectScript });

  await S("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: `${base}/` });
  await sleep(2500);
  // 等首屏卡片
  for (let i = 0; i < 40; i += 1) {
    const n = await evalJs(`document.querySelectorAll("article.task-card").length`);
    if (n >= CASES.length) break;
    await sleep(300);
  }

  /** 打开某张卡的抽屉，读「下一步 / 看护 / 诊断」三块的真实文本。 */
  const openDrawer = async (cardTitle) => {
    const ok = await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(cardTitle)});
      if (!card) return false;
      card.click();
      return true;
    })()`);
    if (!ok) return null;
    await sleep(1600);
    return evalJs(`(() => {
      const body = document.querySelector(".tb-drawer-body");
      if (!body) return null;
      const secOf = (kw) => [...body.querySelectorAll(".drawer-section")]
        .find((s) => ((s.querySelector(":scope > h3")?.textContent) ?? "").includes(kw)) ?? null;
      const nextSec = body.querySelector(".drawer-section.next-step");
      const watchSec = secOf("执行看护");
      const diagSec = secOf("诊断与恢复动作");
      return {
        nextTitle: (nextSec?.querySelector(".next-step-title")?.textContent ?? "").trim(),
        watchText: watchSec ? watchSec.textContent.replace(/\\s+/g, " ").trim() : "",
        diagText: diagSec ? diagSec.textContent.replace(/\\s+/g, " ").trim() : "",
        bodyText: body.textContent.replace(/\\s+/g, " "),
        banner: (document.querySelector(".banner")?.textContent ?? "").trim(),
      };
    })()`);
  };
  const closeDrawer = async () => {
    await evalJs(`(() => { const b = document.querySelector(".tb-drawer-head button.ghost"); if (b) b.click(); return true; })()`);
    await sleep(400);
  };

  let poisonSeen = [];
  for (const c of CASES) {
    const d = await openDrawer(c.cardTitle);
    if (!d) { check(`${c.key} 抽屉可打开`, false, "没找到卡或抽屉未渲染"); continue; }
    const okTitle = d.nextTitle === c.nextTitle;
    check(`${c.key} 「下一步」来自 ticketStage（NEW 而非旧端点）`, okTitle, `期望=${c.nextTitle} 实得=${d.nextTitle || "(空)"}`);
    if (/\bPOISON/.test(d.bodyText)) poisonSeen.push(c.key);
    await closeDrawer();
  }

  // A 额外做看护 / 诊断的差分（这两个区块只在有读数时渲染）
  const a = await openDrawer(CASES[0].cardTitle);
  if (a) {
    check("A2 看护黄条来自 ticketStage.watch（37 分钟，非毒值 999）",
      a.watchText.includes("37") && !a.watchText.includes("999") && !a.watchText.includes("POISON"),
      a.watchText.slice(0, 90) || "(无「执行看护」区块)");
    check("A3 诊断块来自 ticketStage.diagnostics（NEW-A 诊断项，非 POISON-diag）",
      a.diagText.includes("NEW-A 诊断项") && !a.diagText.includes("POISON"),
      a.diagText.slice(0, 90) || "(无「诊断与恢复动作」区块)");
    check("E 全程无 error 横幅", !/失败|错误/.test(a.banner), a.banner ? a.banner.slice(0, 60) : "(无横幅)");
    await closeDrawer();
  } else check("A2/A3 复开 A 卡", false, "抽屉未渲染");

  check("D0 整屏不得出现任何旧端点毒值（POISON）", poisonSeen.length === 0, poisonSeen.length ? `出现在 ${poisonSeen.join("/")}` : "四态均干净");

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
