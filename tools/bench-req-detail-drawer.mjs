/**
 * 需求条目详情抽屉「宽度 / 拖拽 / 全屏 / 记忆」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（真机批注 2026-10-28）
 * 「需求条目详情点击后，太过靠右，如内容详情过长 不便查看，请优化」。
 * 根因是**呈现层**的一条 CSS：`.tb-req-drawer { width: min(560px, calc(100vw - 12px)) }` ——
 * 把宽度**死钉在 560px**，还**盖掉**了 `.tb-drawer` 的按视口分级（`var(--drawer-width, …)` + 三条 `@media`）。
 * 更早的 FR-87 只给**任务**抽屉补过「左缘拖拽 + 一键全屏」，需求抽屉从没享受过这套能力。
 *
 * 单测（`tests/fr-req-detail-drawer.test.mjs`）只能读源码文本，证明不了"规则真的生效"：
 * 一条被别处覆盖的 `max-width`、一个拼错的选择器，源码断言都可能照样全绿。所以必须有这台。
 *
 * ## 本台断言什么（在**真实渲染后的 DOM** 里读，不读源码）
 *   A. 1723 视口：默认宽度 = 分级值 1440（**不是** 560），左边界 283；
 *   B. 900 窄视口：宽度 = `min(920px, 100vw - 12px)` = 888 ⇒ 证明是**按视口分级**而非任何固定值；
 *   C. 左缘有拖拽手柄，且手柄落在抽屉左缘（不是挂在抽屉外面，那样根本拖不到）；
 *   D. 长描述 / 正文**无横向溢出**（`scrollWidth <= clientWidth`）；
 *   E. 拖拽真能改宽（1440 → 1240），且**松手才落盘**：`localStorage["tb.reqDrawer.width"] === "1240"`；
 *   F. 记忆键**独立**：本操作**不得**写入任务抽屉的 `tb.drawer.width`；
 *   G. 刷新页面后宽度被记住（1240）；
 *   H. 「全屏」⇒ 宽度 = `100vw - 8px`（1715）、左边界 8、按钮变「还原」；再点 ⇒ 回默认 1440；
 *   I. 双击手柄 ⇒ 还原默认宽度，且记忆键被删。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-req-detail-drawer.mjs`
 *   —— 把 `web/` 拷一份、只把 `.tb-req-drawer` 那条换回 `width: min(560px, …)`、删掉 `web/app.js` 里的
 *   拖拽/全屏段，本台应转红（A/B/C/E/H/I）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-req-detail-drawer.mjs`
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
const VIEW_WIDE = 1723;
const VIEW_NARROW = 900;
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

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;
let cdp = null;

try {
  // ---- 隔离服务：临时 dataDir + 随机端口，真 `web/` ----
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqdrawer-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-reqdrawer-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  const doc = store.ensureRequirementDoc("default", { body: "# 需求\n" });
  // 超长描述：把详情顶出好几屏，模拟真机「内容详情过长」的场景。
  const LONG = "这是一段很长的需求描述，用来把详情内容顶得很长，并检验长文本不会横向溢出。".repeat(120);
  store.createRequirementItem({
    projectId: "default",
    title: "长内容需求（用于验证详情抽屉宽度）",
    status: "open",
    docId: doc.id,
    description: LONG,
    acceptance: LONG,
  });

  server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

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
  if (!wsUrl) {
    console.log("SKIP  devtools 端点未就绪 ——本台不产证据，退出码 2");
    process.exit(2);
  }
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
  cdp = { send: (m, p) => send(m, p, null) };
  await S("Page.enable");
  await S("Runtime.enable");
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };

  /** 打开需求视图 → 点第一条 → 等抽屉展开。页面默认是看板视图，必须先切。 */
  const openReqDetail = async () => {
    await S("Page.navigate", { url: `${base}/` });
    await sleep(2000);
    for (let i = 0; i < 40; i += 1) {
      const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
      if (r === "no-btn") { await sleep(300); continue; }
      await sleep(600);
      const n = await evalJs(`document.querySelectorAll('.req-list .req-item').length`);
      if (n > 0) break;
    }
    const opened = await evalJs(`(() => { const row = document.querySelector('.req-list .req-item'); if (!row) return 'no-row'; row.click(); return 'clicked'; })()`);
    await sleep(1000);
    return opened;
  };

  const readDrawer = () => evalJs(`(() => {
    const d = document.querySelector('.tb-req-drawer');
    if (!d) return { ok: false };
    const rect = d.getBoundingClientRect();
    const body = d.querySelector('.tb-drawer-body');
    return {
      ok: true,
      shown: d.classList.contains('show'),
      width: Math.round(rect.width),
      left: Math.round(rect.left),
      viewport: innerWidth,
      hasHandle: !!d.querySelector('.tb-drawer-resize'),
      handleLeft: d.querySelector('.tb-drawer-resize')?.getBoundingClientRect().left ?? null,
      fullLabel: [...d.querySelectorAll('.tb-drawer-head button')].map((b) => b.textContent.trim()),
      bodyOverflow: body ? { scrollW: body.scrollWidth, clientW: body.clientWidth } : null,
      stored: (() => { try { return localStorage.getItem('tb.reqDrawer.width'); } catch (_) { return 'ERR'; } })(),
      taskKey: (() => { try { return localStorage.getItem('tb.drawer.width'); } catch (_) { return 'ERR'; } })(),
    };
  })()`);

  // ---- A. 宽视口（1723）：默认宽度按视口分级，不是 560 ----
  await S("Emulation.setDeviceMetricsOverride", { width: VIEW_WIDE, height: 1249, deviceScaleFactor: 1, mobile: false });
  const opened = await openReqDetail();
  const wide = await readDrawer();
  check("A0 能打开需求条目详情抽屉（先切「需求」视图再点列表行）", opened === "clicked" && wide?.ok === true && wide?.shown === true, `opened=${opened} shown=${wide?.shown}`);
  const expectWide = Math.min(1440, Math.round(VIEW_WIDE * 0.86)); // @media(min-width:1600) → min(1440px, 86vw)
  check("A 宽视口 1723：抽屉宽度 = 分级值 1440（旧口径是死钉 560）",
    wide?.width === expectWide, `width=${wide?.width} 期望=${expectWide}`);
  check("A② 抽屉左边界 283（不再贴着最右侧一条窄柱）",
    Math.abs((wide?.left ?? 0) - (VIEW_WIDE - expectWide)) <= 1, `left=${wide?.left} 期望=${VIEW_WIDE - expectWide}`);

  // ---- C. 左缘拖拽手柄真在抽屉左缘 ----
  check("C 左缘有拖拽手柄，且落在抽屉左缘 10px 内（挂在外面就拖不到）",
    wide?.hasHandle === true && Math.abs((wide?.handleLeft ?? -99) - (wide?.left ?? 0)) <= 1,
    `handleLeft=${wide?.handleLeft} drawerLeft=${wide?.left}`);

  // ---- D. 长描述 / 正文无横向溢出 ----
  const descOverflow = await evalJs(`(() => {
    const d = document.querySelector('.tb-req-drawer .req-desc');
    if (!d) return null;
    return { scrollW: d.scrollWidth, clientW: d.clientWidth, h: Math.round(d.getBoundingClientRect().height) };
  })()`);
  check("D 长描述无横向溢出（scrollWidth <= clientWidth）",
    descOverflow === null ? false : descOverflow.scrollW <= descOverflow.clientW + 1,
    JSON.stringify(descOverflow));
  check("D② 抽屉正文无横向溢出",
    (wide?.bodyOverflow?.scrollW ?? 1) <= (wide?.bodyOverflow?.clientW ?? 0) + 1,
    JSON.stringify(wide?.bodyOverflow));

  // ---- E/F. 拖拽改宽 1440 → 1240，松手才落盘；且不污染任务抽屉的记忆键 ----
  const DRAG_DELTA = 200;
  const dragResult = await evalJs(`(() => {
    const d = document.querySelector('.tb-req-drawer');
    const h = d.querySelector('.tb-drawer-resize');
    if (!h) return { ok: false, why: 'no-handle' };
    const startX = Math.round(d.getBoundingClientRect().left) + 4;
    const pd = (type, x) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: 400, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
    pd('pointerdown', startX);
    pd('pointermove', startX + ${DRAG_DELTA / 2});
    const midWidth = Math.round(d.getBoundingClientRect().width);
    const midStored = localStorage.getItem('tb.reqDrawer.width');
    pd('pointermove', startX + ${DRAG_DELTA});
    pd('pointerup', startX + ${DRAG_DELTA});
    return { ok: true, midWidth, midStored, width: Math.round(d.getBoundingClientRect().width), stored: localStorage.getItem('tb.reqDrawer.width') };
  })()`);
  check("E 拖拽真能改宽（左缘往右拖 200px ⇒ 1440 → 1240）",
    dragResult?.ok === true && Math.abs((dragResult?.width ?? 0) - (expectWide - DRAG_DELTA)) <= 2,
    JSON.stringify(dragResult));
  check("E② 拖动中**不落盘**（松手才写记忆）",
    dragResult?.midStored === null && dragResult?.stored === String(expectWide - DRAG_DELTA),
    `拖动中=${dragResult?.midStored} 松手后=${dragResult?.stored}`);
  const afterDrag = await readDrawer();
  check("F 需求抽屉记忆键独立：只写 tb.reqDrawer.width，不碰任务抽屉的 tb.drawer.width",
    afterDrag?.stored === String(expectWide - DRAG_DELTA) && afterDrag?.taskKey === null,
    `reqKey=${afterDrag?.stored} taskKey=${afterDrag?.taskKey}`);

  // ---- G. 刷新后记住宽度 ----
  await S("Page.reload", {});
  await sleep(2200);
  await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); b?.click(); return true; })()`);
  await sleep(900);
  await evalJs(`(() => { document.querySelector('.req-list .req-item')?.click(); return true; })()`);
  await sleep(900);
  const reloaded = await readDrawer();
  check("G 刷新页面后宽度被记住（1240，不是回落到默认）",
    reloaded?.shown === true && Math.abs((reloaded?.width ?? 0) - (expectWide - DRAG_DELTA)) <= 2,
    `width=${reloaded?.width}`);

  // ---- H. 全屏 / 还原 ----
  await evalJs(`(() => { const d = document.querySelector('.tb-req-drawer'); [...d.querySelectorAll('.tb-drawer-head button')].find((b) => b.textContent.trim() === '全屏')?.click(); return true; })()`);
  await sleep(350);
  const full = await readDrawer();
  const expectFull = VIEW_WIDE - 8; // drawerMaxWidth() = 100vw - 8
  check("H 点「全屏」⇒ 宽度 = 100vw - 8（1715）且左边界 8",
    Math.abs((full?.width ?? 0) - expectFull) <= 2 && (full?.left ?? -1) <= 9,
    `width=${full?.width} left=${full?.left} 期望=${expectFull}`);
  check("H② 全屏后按钮变「还原」", full?.fullLabel?.includes("还原") === true, JSON.stringify(full?.fullLabel));
  await evalJs(`(() => { const d = document.querySelector('.tb-req-drawer'); [...d.querySelectorAll('.tb-drawer-head button')].find((b) => b.textContent.trim() === '还原')?.click(); return true; })()`);
  await sleep(350);
  const backDefault = await readDrawer();
  check("H③ 再点「还原」⇒ 回默认分级宽度 1440，按钮回「全屏」",
    Math.abs((backDefault?.width ?? 0) - expectWide) <= 2 && backDefault?.fullLabel?.includes("全屏") === true,
    `width=${backDefault?.width} labels=${JSON.stringify(backDefault?.fullLabel)}`);

  // ---- I. 双击手柄还原 + 清记忆 ----
  await evalJs(`(() => { const h = document.querySelector('.tb-req-drawer .tb-drawer-resize'); h?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
  await sleep(350);
  const afterDbl = await readDrawer();
  check("I 双击手柄 ⇒ 还原默认宽度，且记忆键被删（回到纯分级状态）",
    Math.abs((afterDbl?.width ?? 0) - expectWide) <= 2 && afterDbl?.stored === null,
    `width=${afterDbl?.width} stored=${afterDbl?.stored}`);

  // ---- B. 反向：窄视口 900 ⇒ 宽度 = min(920, 100vw-12) = 888（证明按视口分级，非任何固定值）----
  await S("Emulation.setDeviceMetricsOverride", { width: VIEW_NARROW, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  const narrow = await readDrawer();
  const expectNarrow = Math.min(920, VIEW_NARROW - 12);
  check("B 窄视口 900：宽度 = min(920px, 100vw-12) = 888（旧口径会停在 560）",
    Math.abs((narrow?.width ?? 0) - expectNarrow) <= 2, `width=${narrow?.width} 期望=${expectNarrow}`);
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  clearTimeout(watchdog);
  try { await cdp?.send("Browser.close", {}); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server?.close?.(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, chromeProfile]) { if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
process.exit(0);
