/**
 * 卡 `-160`「需求条目列表：宽度 / 密度优化 ＋ 完成 / 关闭状态显式化」—— **真实浏览器验证台**
 * （真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么必须上真浏览器
 * 本轮改动**全在呈现层**（`web/app.js` 的行结构 + `web/tokens.css` 的布局）。单测只能读源码文本
 * （`tests/fr160-req-item-list.test.mjs` 断言"规则写没写"），但**证明不了"写出来的规则真的生效"** ——
 * 例如 `minmax(0,1fr)` 少了 `min(0)` 就会横向溢出、`opacity:0` 的隐藏按钮仍占行宽、
 * `min-width` 取小了状态列就不对齐。这些都是**只有渲染后才读得出来的**数。
 *
 * ## 本台断言什么（在**渲染后的 DOM / computed style** 里读）
 *   A. 需求视图真渲染出条目列表（4 态齐）；
 *   B. 面板头四态计数**文本**在（已完成 / 已关闭不再隐形），数字与种子数据一致；
 *   C. 宽视口（1600）`.req-stack` 是**两栏 grid**（轨道数 = 2）；
 *   D. 宽视口**无横向溢出**（`scrollWidth <= innerWidth`）；
 *   E. 状态列**逐行对齐**：四态 `req-status-chip` 宽度全等、左偏移全等；
 *   F. 终态**显式**：done/closed 标题 `line-through`；closed 行 `opacity < 1`；done/closed 有 `inset` 色条；
 *      draft/open 三者皆无（证明只在终态生效，不是"全行都划掉"）；
 *   G. 行内动作**不占行宽**：动作层 `position: absolute`，且"把它 display:none 前后的标题可用宽度"差为 **0**
 *      （同时要求动作层真实宽度 > 100px —— 证明它确实存在、本来是会吃掉宽度的）；
 *   H. 动作**能显形**：禁 transition 后给行加 `is-active` ⇒ 动作层 `opacity = 1`，且**显形前后行宽不变**；
 *   I. 窄视口（900，`Emulation` 改视口）回落**单列**且**仍无横向溢出**；
 *   J. **反向对照**：注入「改动前」口径的覆盖样式后，C / E / F / G 必须**转红**
 *      （证明这些读数真的在区分新旧，不是恒真）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写真实看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * ## 运行
 * `node tools/bench-req-item-list.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（找不到 Chrome）⇒ 跳过、不产证据。
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
const watchdog = setTimeout(() => {
  console.error("FAIL  验证台整体超时（>240s）——已强退，退出码 1");
  process.exit(1);
}, 240000);

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
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

// ---- 台内数据：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqlist-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-reqlist-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
const doc = store.ensureRequirementDoc("default", { body: "# 需求\n\n## R1 需求条目列表\n" });

/** 种子：四态齐 + 一条极长标题（长标题正是「把轨道顶宽 / 把整页撑出横向滚动条」的元凶）。 */
const SEED = [
  ["draft", "待确认", 105, "支持按会话归属筛选需求条目并记住上次筛选（含降级可见提示）"],
  ["open", "在办", 107, "需求条目列表：宽度 / 密度优化 + 完成 / 关闭状态显式化"],
  ["done", "已完成", 110, "FR-91 需求文档关联补齐与需求条目完成度评审（需求层收口闭环）"],
  ["closed", "已关闭", 113, "P0-3 Codex 内嵌部署（放弃）"],
  ["open", "在办", 115, "极长标题用于验证省略号与横向溢出：把这一行写得很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长"],
  ["done", "已完成", 116, "另一条已完成的条目"],
];
for (const [status, , , title] of SEED) {
  store.createRequirementItem({ projectId: "default", title, status, docId: doc.id });
}
const expectCounts = SEED.reduce((acc, [s]) => { acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});

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

/**
 * 页内测量（返回纯数据）：行宽是否被动作层吃掉、状态列是否对齐、终态是否显式、是否横向溢出。
 * 只读，不改产品代码；唯一写操作是临时 `display:none` 再复原（用于测"动作占不占宽"）。
 */
const PROBE = `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const stack = document.querySelector(".req-stack");
  const list = document.querySelector(".req-list");
  if (!stack || !list) return { ok: false, note: "no .req-stack / .req-list" };
  const items = [...list.querySelectorAll(".req-item")];
  if (!items.length) return { ok: false, note: "no .req-item" };
  const acts = items.map((it) => it.querySelector(".req-item-actions"));
  const mains = items.map((it) => it.querySelector(".req-item-main"));
  const chips = items.map((it) => it.querySelector(".req-status-chip"));
  const mainBefore = mains.map((m) => px(m.getBoundingClientRect().width));
  acts.forEach((a) => { if (a) a.style.display = "none"; });
  const mainNoActs = mains.map((m) => px(m.getBoundingClientRect().width));
  acts.forEach((a) => { if (a) a.style.display = ""; });
  const cols = getComputedStyle(stack).gridTemplateColumns;
  return {
    ok: true,
    viewport: { w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth },
    stackDisplay: getComputedStyle(stack).display,
    columnCount: cols === "none" ? 0 : cols.trim().split(/\\s+/).filter(Boolean).length,
    columns: cols,
    listMaxHeight: getComputedStyle(list).maxHeight,
    headText: (document.querySelector(".req-counts")?.textContent ?? "").replace(/\\s+/g, " ").trim(),
    rows: items.map((it, i) => {
      const t = it.querySelector(".req-title");
      const cs = getComputedStyle(it);
      const tcs = t ? getComputedStyle(t) : {};
      const a = acts[i];
      return {
        status: it.dataset.status ?? "",
        rowH: px(it.getBoundingClientRect().height),
        titleDecoration: tcs.textDecorationLine ?? "",
        rowOpacity: parseFloat(cs.opacity),
        insetBar: /inset/.test(cs.boxShadow),
        mainW: mainBefore[i],
        mainDelta: px(mainBefore[i] - mainNoActs[i]),
        actionPos: a ? getComputedStyle(a).position : "",
        actionRealW: a ? px(a.getBoundingClientRect().width) : 0,
        chipW: chips[i] ? px(chips[i].getBoundingClientRect().width) : 0,
        chipLeft: chips[i] ? px(chips[i].getBoundingClientRect().left) : 0,
      };
    }),
  };
})()`;

/** 只读某一行（按状态找第一条）的当前值；`opts.reveal` 时先禁 transition 再加 `is-active`。 */
const probeRow = (status, opts = {}) => `(() => {
  const px = (v) => Math.round(parseFloat(v) * 100) / 100;
  const it = [...document.querySelectorAll(".req-list .req-item")].find((n) => n.dataset.status === ${JSON.stringify(status)});
  if (!it) return { ok: false, note: "row not found: ${status}" };
  const a = it.querySelector(".req-item-actions");
  const m = it.querySelector(".req-item-main");
  const before = px(m.getBoundingClientRect().width);
  ${opts.reveal
    ? `if (a) a.style.transition = "none";   // 隔离：headless 虚拟时间不推进动画时钟，先禁 transition 再读终值
       it.classList.add("is-active");`
    : ""}
  const after = px(m.getBoundingClientRect().width);
  const out = { ok: true, actionOpacity: a ? parseFloat(getComputedStyle(a).opacity) : null,
    actionPointer: a ? getComputedStyle(a).pointerEvents : "",
    mainBefore: before, mainAfter: after, mainDelta: px(after - before) };
  ${opts.reveal ? `it.classList.remove("is-active"); if (a) a.style.transition = "";` : ""}
  return out;
})()`;

let chrome = null;
let cdp = null;
try {
  const debugPort = await freePort();
  // 环境坑（同 bench-next-column / bench-review-evidence-dom）：workspace-write 沙箱里 Chrome 自带沙箱
  // 拉不起渲染进程 ⇒ Page/Runtime 域超时。这里是临时 profile 的隔离浏览器，加 --no-sandbox 系列即可。
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

  // ---- A 前置：宽视口（1600）打开，切到「需求」视图 -----------------------------------------
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(2500);

  const opened = await waitFor(async () => {
    const r = await evalJs(`(() => {
      const b = [...document.querySelectorAll("header button")].find((n) => n.textContent.trim() === "需求");
      if (!b) return { ok: false, note: "no 需求 button" };
      b.click();
      return { ok: true };
    })()`);
    if (!r.ok) return r;
    await sleep(600);
    return evalJs(`({ ok: document.querySelectorAll(".req-list .req-item").length > 0 })`);
  }, 25000, "需求视图出条目");
  if (!opened.ok) throw new Error(`需求视图未渲染出条目：${opened.note ?? ""}`);
  await sleep(400);

  const wide = await evalJs(PROBE);
  check("A 需求视图真渲染出条目列表（种子 6 条）", wide.ok && wide.rows.length === SEED.length,
    wide.ok ? `rows=${wide.rows.length}` : (wide.note ?? ""));

  // ---- B 面板头四态计数（完成 / 关闭不再隐形） ----------------------------------------------
  const headOk = ["待确认", "在办", "已完成", "已关闭"].every((k) => wide.headText.includes(k))
    && wide.headText.includes(`已完成 ${expectCounts.done ?? 0}`)
    && wide.headText.includes(`已关闭 ${expectCounts.closed ?? 0}`);
  check("B 面板头四态计数在且数字与种子一致", headOk, `head="${wide.headText}"`);

  // ---- C 宽视口两栏 -------------------------------------------------------------------------
  check("C 宽视口(1600) `.req-stack` 为两栏 grid",
    wide.stackDisplay === "grid" && wide.columnCount === 2,
    `display=${wide.stackDisplay} columns="${wide.columns}"`);

  // ---- D 宽视口无横向溢出 -------------------------------------------------------------------
  const ovWide = wide.viewport.scrollW - wide.viewport.w;
  check("D 宽视口无横向溢出", ovWide <= 0, `scrollW=${wide.viewport.scrollW} innerW=${wide.viewport.w} 溢出=${ovWide}px`);

  // ---- E 状态列逐行对齐 ---------------------------------------------------------------------
  const chipWs = [...new Set(wide.rows.map((r) => r.chipW))];
  const chipLs = [...new Set(wide.rows.map((r) => r.chipLeft))];
  check("E 状态列逐行对齐（四态胶囊同宽同左偏移）",
    chipWs.length === 1 && chipLs.length === 1 && chipWs[0] > 0,
    `宽度集合=${JSON.stringify(chipWs)} 左偏移集合=${JSON.stringify(chipLs)}`);

  // ---- F 终态显式（且只在终态生效） ---------------------------------------------------------
  const term = wide.rows.filter((r) => r.status === "done" || r.status === "closed");
  const live = wide.rows.filter((r) => r.status === "draft" || r.status === "open");
  const termStruck = term.every((r) => r.titleDecoration === "line-through");
  const termInset = term.every((r) => r.insetBar);
  const closedDim = wide.rows.filter((r) => r.status === "closed").every((r) => r.rowOpacity < 1);
  const livePlain = live.every((r) => r.titleDecoration !== "line-through" && !r.insetBar && r.rowOpacity === 1);
  check("F 终态显式：done/closed 划掉标题 + inset 色条；closed 降透明；draft/open 均无",
    termStruck && termInset && closedDim && livePlain,
    `终态划掉=${termStruck} inset=${termInset} closed降透明=${closedDim} 非终态干净=${livePlain}`);

  // ---- G 行内动作不占行宽 -------------------------------------------------------------------
  const deltas = [...new Set(wide.rows.map((r) => r.mainDelta))];
  const actionWs = wide.rows.map((r) => r.actionRealW);
  const posSet = [...new Set(wide.rows.map((r) => r.actionPos))];
  check("G 行内动作 absolute 且不占行宽（去掉动作层前后标题宽度差=0）",
    posSet.length === 1 && posSet[0] === "absolute"
    && deltas.length === 1 && deltas[0] === 0
    && Math.max(...actionWs) > 100,
    `position=${JSON.stringify(posSet)} 宽度差集合=${JSON.stringify(deltas)} 动作实宽最大=${Math.max(...actionWs)}`);

  // ---- H 动作能显形，且显形不改变行宽 -------------------------------------------------------
  const revealed = await evalJs(probeRow("open", { reveal: true }));
  check("H 选中态动作显形（opacity=1）且显形前后行宽不变",
    revealed.ok && revealed.actionOpacity === 1 && revealed.actionPointer === "auto" && revealed.mainDelta === 0,
    revealed.ok ? `opacity=${revealed.actionOpacity} pointer=${revealed.actionPointer} 行宽差=${revealed.mainDelta}` : (revealed.note ?? ""));

  // ---- J 反向对照：注入「改动前」口径后，C / E / F / G 必须转红 ------------------------------
  await evalJs(`(() => {
    const s = document.createElement("style");
    s.id = "tb-reverse-control";
    s.textContent = [
      ".req-stack{display:flex!important;flex-direction:column!important}",
      ".req-stack .req-item-actions{position:static!important;right:auto!important;top:auto!important;transform:none!important;flex:0 0 auto!important;pointer-events:auto!important;background:none!important;box-shadow:none!important;padding-left:0!important;opacity:0!important}",
      ".req-status-chip{min-width:48px!important}",
      ".req-stack .req-item.is-done .req-title,.req-stack .req-item.is-closed .req-title{text-decoration:none!important}",
      ".req-stack .req-item.is-closed{opacity:1!important}",
      ".req-stack .req-item.is-done,.req-stack .req-item.is-closed{box-shadow:none!important}"
    ].join("\\n");
    document.head.appendChild(s);
    return true;
  })()`);
  await sleep(300);
  const back = await evalJs(PROBE);
  const redC = !(back.stackDisplay === "grid" && back.columnCount === 2);
  const chipWsB = [...new Set(back.rows.map((r) => r.chipW))];
  const redE = !(chipWsB.length === 1);
  const termB = back.rows.filter((r) => r.status === "done" || r.status === "closed");
  const redF = !termB.every((r) => r.titleDecoration === "line-through" && r.insetBar);
  const deltasB = [...new Set(back.rows.map((r) => r.mainDelta))];
  const redG = !(deltasB.length === 1 && deltasB[0] === 0);
  check("J 反向对照：注入旧口径后 C/E/F/G 四条判据转红",
    redC && redE && redF && redG,
    `C红=${redC} E红=${redE} F红=${redF} G红=${redG}`);

  // ---- I 窄视口回落单列且无横向溢出 ---------------------------------------------------------
  await evalJs(`(() => { document.getElementById("tb-reverse-control")?.remove(); return true; })()`);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 1000, deviceScaleFactor: 1, mobile: false });
  await sleep(400);
  const narrow = await evalJs(PROBE);
  const ovNarrow = narrow.ok ? narrow.viewport.scrollW - narrow.viewport.w : 1e9;
  check("I 窄视口(900) 回落单列且无横向溢出",
    narrow.ok && narrow.columnCount === 1 && ovNarrow <= 0,
    narrow.ok ? `columns="${narrow.columns}" scrollW=${narrow.viewport.scrollW} innerW=${narrow.viewport.w} 溢出=${ovNarrow}px` : (narrow.note ?? ""));
} catch (error) {
  check("台内执行", false, `${error?.message ?? error}`);
} finally {
  clearTimeout(watchdog);
  try { if (cdp?.ws) cdp.ws.close(); } catch { /* ignore */ }
  try { if (chrome) chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { await new Promise((resolve) => server.close(resolve)); } catch { /* ignore */ }
  try { store.close(); } catch { /* ignore */ }
  try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项：PASS ${results.length - failed.length} / FAIL ${failed.length}`);
  if (failed.length) {
    console.log("失败项：");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? `  —  ${f.detail}` : ""}`);
  }
  process.exit(failed.length ? 1 : 0);
}
