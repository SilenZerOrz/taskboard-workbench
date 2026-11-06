/**
 * 卡 `-222` / 需求 `R163` ④：面板 bootstrap **分步容错** —— 真 headless Chrome + CDP **读渲染后 DOM**。
 *
 * ## 为什么必须真渲染才成立
 * 这条缺陷的证据形态是「**空白**」：`.board` 0 个子元素、8 个 select 的 options 全空、三条 banner 全 hidden。
 * 源码守卫只能证明 `try/catch` 在不在，**证明不了渲染后到底有没有东西可读** —— 而人看到的就是渲染结果。
 * 所以本台用 CDP `Network.setBlockedURLs` 在**浏览器网络层**掐断指定端点（与真机那次
 * `TypeError: Failed to fetch` 同一层），再读**渲染后的 DOM**。
 *
 * ## 注入的是「网络层失败」，不是桩
 * `Network.setBlockedURLs` 让请求在浏览器侧失败（`net::ERR_BLOCKED_BY_CLIENT`），页面里 `fetch` 收到的是
 * **真的 `TypeError`** —— 和 2026-11-04 现场同一个错误类型，不是把 `api()` 换成假函数那种自证。
 *
 * ## 七站（对应需求验收 ①–③）
 *   A. 基线：不注入 ⇒ 看板真渲染（防空跑，也是"注入后才红"的反向对照）
 *   B. `/api/meta` 掐断（**必要步**）⇒ 面板可见 + 失败步 `meta` 带原因 + 面板内「重试」按钮 +
 *      **不画假空看板** + 失败横幅 **sticky 且 11s 后仍在**（守卫 ③「不被 hideBanner 清掉」）
 *   C. `/api/projects` 掐断（**必要步**）⇒ 另一条必要路径同样给面板 + 重试
 *   D. `/api/health` 掐断（**可降级**）⇒ 看板照常 + 常驻条列出 `health` + 条内重试，
 *      **且后续步骤没被中断**（项目下拉已填充、卡片已渲染）
 *   E. `/api/context` 掐断（**可降级**）⇒ 常驻条 `context` + 看板照常 + 项目仍按 `/api/projects` 选定
 *   F. `/api/projects/:id/settings` 掐断（**可降级**）⇒ 常驻条 `settings` + 看板照常
 *   G. **重试即恢复**（验收 ②）：掐断 `meta` → 面板 → 解除拦截 → 点面板内「重试」⇒
 *      面板消失、看板真渲染、横幅清掉；**且没有刷新整页**（页面标记与 `navigation` 条目数都不变）
 *
 * ## 维护约定
 *   · 面板/常驻条的选择器与 `web/app.js` 的 `.tb-boot-panel` / `.tb-boot-strip` / `#tb-boot-retry`
 *     一一对应；`tests/bench-bootstrap-resilience-coverage.test.mjs` 会核对两边没有走样。
 *   · 本台必须保留**反向对照**（A 基线 + G 恢复 + 每条失败路径的"正反两读"）：
 *     只断言"失败时有个面板"会被「把所有情况都画面板」这种半吊子实现蒙过去。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。**不碰 `:3080` / `:47830` / 仓库 `.data/`。**
 * ⚠️ 沙箱内起不了 Chrome —— 必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-bootstrap-resilience.mjs`
 * 反证：`TB_BENCH_WEB_DIR=<旧 web 目录> node tools/bench-bootstrap-resilience.mjs`（旧前端应大量转红）
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

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>180s）——已强退，退出码 1"); process.exit(1); }, 180000);

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

let chromeProfile = null;
let chrome = null;
const servers = [];

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-bootres-chrome-"));
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
  await S("Page.enable");
  await S("Runtime.enable");
  await S("Network.enable");
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };
  const waitFor = async (expr, timeout = 8000) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout;) {
      if (await evalJs(`(() => { try { return !!(${expr}); } catch { return false; } })()`)) return true;
      await sleep(120);
    }
    return false;
  };

  /** 读**渲染后**的 DOM：面板 / 常驻条 / 失败行 / 重试按钮 / 横幅 / 看板 / 下拉 / 页面标记。 */
  const read = () => evalJs(`(() => {
    const shown = (el) => !!el && !el.hidden && el.offsetParent !== null;
    const panel = document.querySelector('.tb-boot-panel');
    const strip = document.querySelector('.tb-boot-strip');
    const banner = document.querySelector('.banner.error');
    const retryOf = (scope) => {
      const b = document.querySelector(scope + ' #tb-boot-retry');
      return b ? { tag: b.tagName, visible: shown(b), disabled: b.disabled === true, text: (b.textContent || '').trim() } : null;
    };
    const projectSel = document.querySelector('select[aria-label="选择项目"]');
    const cardTitles = [...document.querySelectorAll('.task-card')].map((n) => (n.getAttribute('aria-label') || '').trim());
    // 几何读数（卡 -222 补：.board 是 7 列网格，grid-column: 1/-1 的盒子容易横跨整张网格 ⇒
    // 面板 / 常驻条不收敛就会画到视口外。这条**只有真渲染读得出**，源码守卫看不见。）
    const rectOf = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) }; };
    const inside = (outer, inner) => !!outer && !!inner
      && inner.x >= outer.x - 1 && inner.x + inner.w <= outer.x + outer.w + 1
      && inner.y >= outer.y - 1 && inner.y + inner.h <= outer.y + outer.h + 1;
    return {
      vw: window.innerWidth,
      scrollW: document.documentElement.scrollWidth,
      rectPanel: rectOf(panel),
      rectStrip: rectOf(strip),
      rectRetryPanel: rectOf(document.querySelector('.tb-boot-panel #tb-boot-retry')),
      rectRetryStrip: rectOf(document.querySelector('.tb-boot-strip #tb-boot-retry')),
      retryInsidePanel: inside(rectOf(panel), rectOf(document.querySelector('.tb-boot-panel #tb-boot-retry'))),
      retryInsideStrip: inside(rectOf(strip), rectOf(document.querySelector('.tb-boot-strip #tb-boot-retry'))),
      panel: shown(panel),
      panelTitle: ((panel || {}).querySelector ? (panel.querySelector('.empty-guide-title') || {}).textContent || '' : '').trim(),
      panelText: ((panel || {}).textContent || '').trim(),
      strip: shown(strip),
      stripText: ((strip || {}).textContent || '').trim(),
      failures: [...document.querySelectorAll('.tb-boot-failure')].map((n) => ({
        step: n.dataset.bootStep || '', essential: n.dataset.bootEssential || '',
        text: (n.textContent || '').trim(),
        inPanel: !!n.closest('.tb-boot-panel'), inStrip: !!n.closest('.tb-boot-strip'),
        visible: shown(n),
      })),
      retryPanel: retryOf('.tb-boot-panel'),
      retryStrip: retryOf('.tb-boot-strip'),
      banner: banner && !banner.hidden ? {
        text: (banner.textContent || '').trim(),
        className: banner.className,
        sticky: banner.classList.contains('tb-banner-sticky'),
        visible: shown(banner),
      } : null,
      columns: document.querySelectorAll('.board-column').length,
      emptyColumns: document.querySelectorAll('.empty-column').length,
      cardTitles,
      boardText: ((document.querySelector('.board') || {}).textContent || '').trim().slice(0, 240),
      projectValue: projectSel ? projectSel.value : '',
      projectOptions: projectSel ? [...projectSel.options].map((o) => o.value) : [],
      mark: window.__tbBenchMark ?? null,
      navs: performance.getEntriesByType('navigation').length,
      href: location.origin + location.pathname,
    };
  })()`);

  const setBlock = async (urls) => { await S("Network.setBlockedURLs", { urls }); };

  /** 打开面板：先设拦截再导航（拦截必须在首屏 fetch 之前生效）。 */
  const openApp = async (base, blockUrls) => {
    await setBlock(blockUrls);
    await S("Page.navigate", { url: `${base}/` });
    return waitFor(`document.querySelector('.app-shell')`, 10000);
  };

  const bootServer = async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-bootres-data-"));
    const store = openStore({ dataDir, env: {} });
    store.createProject({ id: "default", name: "默认项目" });
    store.createTask({ projectId: "default", title: "基线任务甲", status: "todo" });
    store.createTask({ projectId: "default", title: "基线任务乙", status: "in_progress" });
    const server = createServer({ store, webDir: WEB_DIR });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    servers.push({ server, store, dataDir, port });
    return `http://127.0.0.1:${port}`;
  };

  const base = await bootServer();
  console.log(`… 台内服务 ${base} · webDir=${WEB_DIR}`);

  // ---------------- A. 基线：不注入失败（防空跑，也是后面各项的反向对照）
  await openApp(base, []);
  const baseOk = await waitFor(`document.querySelectorAll('.board-column').length >= 5`, 12000);
  const a = await read();
  check("A0 基线：看板真渲染（防空跑——注入失败后转红才有意义）",
    baseOk && a.columns >= 5 && a.cardTitles.length >= 2,
    `columns=${a.columns} cards=${a.cardTitles.length}`);
  check("A1 基线：不得出现初始化面板/常驻条（无失败就不该有失败态 UI）",
    a.panel === false && a.strip === false && a.failures.length === 0,
    `panel=${a.panel} strip=${a.strip} failures=${a.failures.length}`);
  check("A2 基线：项目下拉已按 /api/projects 选定",
    a.projectValue === "default" && a.projectOptions.includes("default"),
    `value=${a.projectValue} options=${a.projectOptions.join(",")}`);

  // ---------------- B. 必要步 /api/meta 掐断
  await openApp(base, ["*/api/meta*"]);
  const metaOk = await waitFor(`document.querySelector('.tb-boot-panel')`, 12000);
  const b = await read();
  const metaRow = b.failures.find((f) => f.step === "meta");
  check("B0 必要步 /api/meta 失败 ⇒ 面板真渲染出来（不是空白）",
    metaOk && b.panel === true && b.panelTitle.includes("初始化没完成"),
    `panel=${b.panel} title=${b.panelTitle}`);
  check("B1 面板里点名失败步与**原因**（哪一步 + 为什么）",
    !!metaRow && metaRow.inPanel === true && metaRow.essential === "1" && metaRow.text.includes("读取失败"),
    metaRow ? metaRow.text : "无 meta 行");
  check("B2 网络层失败的原因被如实带出（页面里真的收到了 fetch 失败）",
    !!metaRow && /Failed to fetch|Failed to load|NetworkError|net::/i.test(metaRow.text),
    metaRow ? metaRow.text : "无 meta 行");
  check("B3 面板内「重试」是可见可点的 BUTTON（不是占位文案）",
    !!b.retryPanel && b.retryPanel.tag === "BUTTON" && b.retryPanel.visible && !b.retryPanel.disabled,
    b.retryPanel ? `${b.retryPanel.tag} visible=${b.retryPanel.visible} text=${b.retryPanel.text}` : "无重试按钮");
  check("B4 不画「假空看板」：失败时既没有列、也没有「暂无任务」空列文案",
    b.columns === 0 && b.emptyColumns === 0 && b.boardText.includes("初始化没完成"),
    `columns=${b.columns} empty=${b.emptyColumns} boardText=${b.boardText.slice(0, 60)}`);
  check("B5 失败横幅在，且带 sticky 标记（不许被 hideBanner 清掉）",
    !!b.banner && b.banner.visible === true && b.banner.sticky === true && b.banner.text.includes("初始化未完成"),
    b.banner ? `sticky=${b.banner.sticky} text=${b.banner.text.slice(0, 60)}` : "无横幅");
  // 几何（只有真渲染读得出）：`.board` 是 7 列网格，`grid-column: 1/-1` 不收敛就会横跨整张网格
  // ⇒ 面板画到视口外（实测未收敛时 2172px / 视口 1440）。这条必须真读 rect，源码守卫看不见。
  check("B8 面板几何可读：不超出视口、页面无横向溢出、重试按钮在面板矩形内",
    !!b.rectPanel && b.rectPanel.w > 0 && b.rectPanel.w <= b.vw && b.scrollW <= b.vw + 1 && b.retryInsidePanel === true,
    `panel=${b.rectPanel ? `${b.rectPanel.w}x${b.rectPanel.h}` : "无"} vw=${b.vw} scrollW=${b.scrollW} retryInside=${b.retryInsidePanel}`);
  // 验收 ③ 的**时间证据**：error 横幅的既有自动消失是 10s，11s 后仍在才算"留得住"
  await sleep(11200);
  const bLater = await read();
  check("B6 11s 后失败横幅仍在（明确守卫「不被后续 hideBanner / 定时器清掉」）",
    !!bLater.banner && bLater.banner.visible === true && bLater.banner.sticky === true,
    bLater.banner ? `仍在：${bLater.banner.text.slice(0, 40)}` : "已消失 ⇒ 人回来看到的就是「全空且没有理由」");
  // 复发路径：面板画出来只是第一步。**后台刷新**（窗口焦点回流 / SSE 回流 / 60s 看护轮询都走 loadTasks）
  // 若照常重取，会把面板顶成一块空看板 ⇒ 人过一会儿回来又是空白。这里真派发一次 focus 事件驱动它。
  const focusDispatched = await evalJs(`(() => { window.dispatchEvent(new Event('focus')); return true; })()`);
  await sleep(1200);
  const bAfterFocus = await read();
  check("B7 后台刷新路径（focus 回流 → loadTasks）不得把失败面板顶成空看板",
    focusDispatched && bAfterFocus.panel === true && bAfterFocus.boardText.includes("初始化没完成") && bAfterFocus.columns === 0,
    `panel=${bAfterFocus.panel} columns=${bAfterFocus.columns} boardText=${bAfterFocus.boardText.slice(0, 40)}`);

  // ---------------- C. 必要步 /api/projects 掐断（第二条必要路径）
  await openApp(base, ["*/api/projects"]);
  const projOk = await waitFor(`document.querySelector('.tb-boot-panel')`, 12000);
  const c = await read();
  const projRow = c.failures.find((f) => f.step === "projects");
  check("C0 必要步 /api/projects 失败 ⇒ 同样给面板 + 点名 projects",
    projOk && c.panel === true && !!projRow && projRow.inPanel === true && projRow.essential === "1",
    `panel=${c.panel} row=${projRow ? projRow.text : "无"}`);
  check("C1 该路径下同样有可见「重试」按钮（两条必要路径都要能自愈）",
    !!c.retryPanel && c.retryPanel.visible === true && !c.retryPanel.disabled,
    c.retryPanel ? `text=${c.retryPanel.text}` : "无");

  // ---------------- D. 可降级步 /api/health 掐断
  await openApp(base, ["*/api/health"]);
  const healthOk = await waitFor(`document.querySelectorAll('.board-column').length >= 5`, 12000);
  const d = await read();
  const healthRow = d.failures.find((f) => f.step === "health");
  check("D0 可降级步 /api/health 失败 ⇒ 看板**照常渲染**（不因一步降级就整块空白）",
    healthOk && d.columns >= 5 && d.panel === false,
    `columns=${d.columns} panel=${d.panel}`);
  check("D1 常驻条列出失败步 health（可降级 ≠ 静默降级）",
    d.strip === true && !!healthRow && healthRow.inStrip === true && healthRow.essential === "0" && healthRow.text.includes("读取失败"),
    healthRow ? healthRow.text : "无 health 行");
  check("D2 后续步骤没被中断：项目下拉已填充 + 卡片已渲染",
    d.projectValue === "default" && d.cardTitles.length >= 2,
    `project=${d.projectValue} cards=${d.cardTitles.length}`);
  check("D3 常驻条内也有「重试」按钮（降级项同样给自愈入口）",
    !!d.retryStrip && d.retryStrip.tag === "BUTTON" && d.retryStrip.visible && !d.retryStrip.disabled,
    d.retryStrip ? `text=${d.retryStrip.text}` : "无");
  check("D4 常驻条几何可读：不超出视口、页面无横向溢出、重试按钮在条内",
    !!d.rectStrip && d.rectStrip.w > 0 && d.rectStrip.w <= d.vw && d.scrollW <= d.vw + 1 && d.retryInsideStrip === true,
    `strip=${d.rectStrip ? `${d.rectStrip.w}x${d.rectStrip.h}` : "无"} vw=${d.vw} scrollW=${d.scrollW} retryInside=${d.retryInsideStrip}`);

  // ---------------- E. 可降级步 /api/context 掐断
  await openApp(base, ["*/api/context*"]);
  const ctxOk = await waitFor(`document.querySelectorAll('.board-column').length >= 5`, 12000);
  const e = await read();
  const ctxRow = e.failures.find((f) => f.step === "context");
  check("E0 可降级步 /api/context 失败 ⇒ 看板照常 + 常驻条点名 context",
    ctxOk && e.columns >= 5 && e.strip === true && !!ctxRow && ctxRow.inStrip === true,
    `columns=${e.columns} strip=${e.strip} row=${ctxRow ? ctxRow.text : "无"}`);
  check("E1 context 失败不拖累项目选定：仍按 /api/projects 的第一项工作",
    e.projectValue === "default" && e.cardTitles.length >= 2,
    `project=${e.projectValue} cards=${e.cardTitles.length}`);

  // ---------------- F. 可降级步 /api/projects/:id/settings 掐断
  await openApp(base, ["*/api/projects/*/settings*"]);
  const setOk = await waitFor(`document.querySelectorAll('.board-column').length >= 5`, 12000);
  const f = await read();
  const setRow = f.failures.find((x) => x.step === "settings");
  check("F0 可降级步 /api/projects/:id/settings 失败 ⇒ 看板照常 + 常驻条点名 settings",
    setOk && f.columns >= 5 && f.strip === true && !!setRow && setRow.inStrip === true,
    `columns=${f.columns} row=${setRow ? setRow.text : "无"}`);

  // ---------------- G. 「重试」即恢复（且**不刷新整页**）
  await openApp(base, ["*/api/meta*"]);
  await waitFor(`document.querySelector('.tb-boot-panel')`, 12000);
  await evalJs(`(() => { window.__tbBenchMark = 1; return true; })()`);
  const before = await read();
  await setBlock([]); // 解除网络层拦截：模拟"连接恢复"
  const clicked = await evalJs(`(() => {
    const b = document.querySelector('.tb-boot-panel #tb-boot-retry');
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  })()`);
  const recovered = await waitFor(`document.querySelectorAll('.board-column').length >= 5`, 12000);
  const g = await read();
  check("G0 面板内「重试」真的能点（解除拦截后不需要刷新整页）",
    clicked === "clicked" && before.panel === true,
    `clicked=${clicked}`);
  check("G1 点「重试」后看板真渲染：面板消失、列与卡片都在",
    recovered && g.panel === false && g.columns >= 5 && g.cardTitles.length >= 2,
    `panel=${g.panel} columns=${g.columns} cards=${g.cardTitles.length}`);
  check("G2 恢复路径**没有刷新整页**（页面标记还在、navigation 条目仍为 1）",
    g.mark === 1 && g.navs === 1,
    `mark=${g.mark} navs=${g.navs}`);
  check("G3 恢复后失败横幅被清掉（有失败才 sticky，成功就该收起）",
    g.banner === null && g.strip === false,
    `banner=${g.banner ? g.banner.text.slice(0, 40) : "无"} strip=${g.strip}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `  ·  失败 ${failed.length} 条` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("FAIL  验证台异常：", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  for (const { server, store, dataDir } of servers) {
    try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
}
