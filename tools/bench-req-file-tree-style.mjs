/**
 * 「引入的文件」树 —— **侧栏文件列表形态**验证台（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-226` / 需求 `R167`）
 * 真机批注（2026-11-05）：「引入文件的样式我希望引用 dsh 侧边栏的文件列表样式」。
 * 旧形态是**每层一个卡片盒**（`border` + `radius` + `--surface-muted` 底）+ 叶子「名字 + 弹簧 + 体积胶囊」；
 * DSH 侧栏是**扁平树 + 折叠三角 + 逐层缩进 + 类型图标 + 22px 整行悬停**。
 *
 * 这类差异**全部只在渲染后成立**：类名在不在、CSS 文本写没写，都证明不了
 * 「缩进步长是不是真的一级 13px」「箭头展开时是不是真的转了 90°」「三个类型图标是不是真的三种颜色」。
 * 而且它**不报错、不进日志**，只能靠真几何读数。
 *
 * ## 本台断言什么（读渲染后的 DOM 与几何，不读源码）
 *   A. 段落能展开，树画出来，叶子数与种子一致（7 条）；
 *   B. 文件夹**不再是卡片盒**：`details.req-folder` 四条边框宽度全 0、背景透明；
 *   C. **折叠箭头**：`summary::before` 有三角（borderLeft ≥ 4px），展开时 `transform` 不是 `none`，
 *      未展开的同类节点 `transform` 必须是 `none`（证箭头随状态变化，而不是静态装饰）；
 *   D. **缩进步长**：每个 `.req-folder-body` = `padding-left 13 + margin-left 7`，且有 0.5px 发丝引导线；
 *      深一层文件的行左边缘比浅一层右移 ≥ 13px（实测 20px）；
 *   E. **类型徽标**：每行都有 14×14 图标且带字母；`js / md / json` 三种底色**互不相同**；
 *   F. **体积列定宽右对齐**：所有 `.req-file-size` 宽 68px（±0.5）、右边缘 spread ≤ 1px、`text-align: right`；
 *   G. **行高统一**：所有文件行 22px、所有文件夹行 22px（±1）；
 *   H. **无横向溢出**：树与整段都不出横向滚动；
 *   I. **FR-96 语义零回归**：第一层目录顺序 / 目录在前 / 叶子 title 一项不丢 / `docs/` 胶囊含子树计数；
 *   J. `:hover` 真换底色（`CSS.forcePseudoState` 强制，确定性可复跑）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-req-file-tree-style.mjs`
 *   旧形态 ⇒ B（卡片盒）/ C（无箭头）/ E（无图标）/ F（无定宽列）/ G（行高 18–24 不齐）转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-req-file-tree-style.mjs`
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
const watchdog = setTimeout(() => {
  console.error("FAIL  验证台整体超时（>240s）——已强退，退出码 1");
  process.exit(1);
}, 240000);

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

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

// ---- 种子：目录树 + 三种类型（js / md / json）+ 两层缩进 + 单链合并 ------------------------
const FILES = [
  { p: "AGENTS.md", b: 120 },
  { p: "manifest.json", b: 512 },
  { p: "docs/a.md", b: 10 },
  { p: "docs/z.md", b: 200 },
  { p: "docs/交付/x.md", b: 300 },
  { p: "src/core/store.mjs", b: 4200 },
  { p: "src/core/requirements.mjs", b: 3100 },
];
const BODY = [
  "# 需求文档",
  "",
  "## 资料清单",
  "",
  ...FILES.map((f) => `- \`${f.p}\` — ${f.b} B 说明`),
  "",
  "## 其它段落",
  "",
  "这一段不属于资料清单（解析必须在此收边）。",
  "",
].join("\n");

const EXPECT = {
  total: FILES.length,
  folderCount: 3,                          // docs + docs/交付 + src/core（单链已合并）
  rootFiles: 2,
  faceFolders: ["docs/", "src/core/"],
  docsPill: "3 个文件",
  leafTitles: FILES.map((f) => f.p).sort(),
  kinds: { "store.mjs": "js", "a.md": "md", "manifest.json": "json" },
};

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-filetree-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-filetree-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
store.ensureRequirementDoc("default", { body: BODY });

let server = createServer({ store, webDir: WEB_DIR });
const port = await freePort();
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
console.log(`… 台内服务 ${base} · dataDir=${dataDir} · webDir=${WEB_DIR}`);

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

/** 页内只读测量：树形状 + 每行的几何 + 每个文件夹的样式。 */
const PROBE = `(() => {
  const secs = [...document.querySelectorAll("details.req-section")];
  const sec = secs.find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"));
  if (!sec) return { ok: false, note: "no 引入的文件 section" };
  const head = (sec.querySelector("summary")?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const tree = sec.querySelector(".req-tree");
  if (!tree) return { ok: false, note: "no .req-tree", head, sectionOpen: sec.open === true };
  const nameOf = (d) => (d.querySelector(":scope > summary .req-folder-name")?.textContent ?? "").trim();
  const kids = [...tree.children];
  const faceFolders = kids.filter((n) => n.tagName === "DETAILS").map(nameOf);
  const lastFolderAt = kids.reduce((acc, n, i) => (n.tagName === "DETAILS" ? i : acc), -1);
  const firstUlAt = kids.findIndex((n) => n.tagName === "UL");
  const folders = [...tree.querySelectorAll("details.req-folder")].map((d) => {
    const s = d.querySelector(":scope > summary");
    const cs = getComputedStyle(d);
    const before = getComputedStyle(s, "::before");
    return {
      name: nameOf(d),
      open: d.open,
      height: s.getBoundingClientRect().height,
      borderTop: parseFloat(cs.borderTopWidth) || 0,
      borderLeft: parseFloat(cs.borderLeftWidth) || 0,
      bg: cs.backgroundColor,
      chevron: parseFloat(before.borderLeftWidth) || 0,
      chevronTransform: before.transform,
      chips: [...d.querySelectorAll(":scope > summary span.chip")].map((c) => c.textContent.trim()),
    };
  });
  const leaves = [...tree.querySelectorAll("li.req-file")].map((li) => {
    const icon = li.querySelector(".req-file-icon");
    const size = li.querySelector(".req-file-size");
    const name = li.querySelector(".req-file-name");
    const r = li.getBoundingClientRect();
    const ir = icon ? icon.getBoundingClientRect() : null;
    const sr = size ? size.getBoundingClientRect() : null;
    return {
      title: li.title,
      name: (name?.textContent ?? "").trim(),
      height: r.height,
      left: r.left,
      iconKind: icon ? icon.dataset.kind ?? null : null,
      iconText: (icon?.textContent ?? "").trim(),
      iconW: ir ? ir.width : null,
      iconH: ir ? ir.height : null,
      iconBg: icon ? getComputedStyle(icon).backgroundColor : null,
      sizeW: sr ? sr.width : null,
      sizeRight: sr ? sr.right : null,
      sizeAlign: size ? getComputedStyle(size).textAlign : null,
    };
  });
  const bodies = [...tree.querySelectorAll(".req-folder-body")].map((b) => {
    const cs = getComputedStyle(b);
    return { paddingLeft: parseFloat(cs.paddingLeft) || 0, marginLeft: parseFloat(cs.marginLeft) || 0, borderLeft: parseFloat(cs.borderLeftWidth) || 0 };
  });
  return {
    ok: true,
    sectionOpen: sec.open === true,
    head,
    treeExists: true,
    faceFolders,
    foldersBeforeFiles: lastFolderAt >= 0 && (firstUlAt === -1 || lastFolderAt < firstUlAt),
    folders,
    leaves,
    bodies,
    treeOverflow: tree.scrollWidth - tree.clientWidth,
    panelOverflow: sec.scrollWidth - sec.clientWidth,
  };
})()`;

let chrome = null;
let cdp = null;
try {
  const debugPort = await freePort();
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
      await sleep(250);
    }
    return last ?? { ok: false, note: `等待超时：${label}` };
  };

  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(2500);

  const opened = await waitFor(async () => {
    const clicked = await evalJs(`(() => {
      const b = [...document.querySelectorAll("header button")].find((n) => n.textContent.trim() === "需求");
      if (!b) return { ok: false, note: "no 需求 button" };
      b.click();
      return { ok: true };
    })()`);
    if (!clicked.ok) return clicked;
    await sleep(600);
    const secBtn = await evalJs(`(() => {
      const sec = [...document.querySelectorAll("details.req-section")]
        .find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"));
      if (!sec) return { ok: false };
      if (!sec.open) sec.querySelector("summary").click();
      return { ok: true };
    })()`);
    if (!secBtn.ok) return secBtn;
    await sleep(400);
    return evalJs(PROBE);
  }, 25000, "需求视图 + 引入的文件树");
  if (!opened.ok) throw new Error(`需求视图未渲染出树：${opened.note ?? ""}`);

  // ---- A --------------------------------------------------------------------------
  check("A 树画出来了，叶子数＝种子（7 条）", opened.leaves.length === EXPECT.total,
    `leaves=${opened.leaves.length}`);
  check("A 段标题带了文件夹数与根级文件数",
    /3 个文件夹/.test(opened.head) && new RegExp(`根级文件 ${EXPECT.rootFiles}`).test(opened.head),
    opened.head.slice(0, 90));

  // ---- B 不再有卡片盒 ----------------------------------------------------------------
  const boxy = opened.folders.filter((f) => f.borderTop > 0 || f.borderLeft > 0 || !/rgba\(0, 0, 0, 0\)|transparent/.test(f.bg));
  check("B 文件夹不再是卡片盒（无边框、背景透明）", opened.folders.length > 0 && boxy.length === 0,
    `folders=${opened.folders.length} boxy=${JSON.stringify(boxy.map((f) => f.name))}`);

  // ---- C 折叠箭头（展开有三角且转 90°；未展开的同类节点不转） --------------------------
  const closedTransform = await evalJs(`(() => {
    const tree = document.querySelector('.req-tree');
    if (!tree) return null;
    const d = document.createElement('details');
    d.className = 'req-folder';
    const s = document.createElement('summary');
    s.textContent = 'tmp-probe';
    d.appendChild(s);
    tree.appendChild(d);
    const cs = getComputedStyle(s, '::before');
    const out = { chevron: parseFloat(cs.borderLeftWidth) || 0, transform: cs.transform };
    d.remove();
    return out;
  })()`);
  const chevronOk = opened.folders.every((f) => f.chevron >= 4);
  const rotatedOk = opened.folders.filter((f) => f.open).every((f) => f.chevronTransform && f.chevronTransform !== "none");
  const closedOk = closedTransform?.chevron >= 4 && closedTransform.transform === "none";
  check("C 折叠箭头：有三角 + 展开 rotate(90°) + 未展开不转", chevronOk && rotatedOk && closedOk,
    `chevron=${opened.folders.map((f) => f.chevron).join("/")} open=${opened.folders.filter((f) => f.open).map((f) => f.chevronTransform)[0] ?? "-"} closed=${closedTransform?.transform}`);

  // ---- D 缩进步长 + 引导线 ------------------------------------------------------------
  const bodyOk = opened.bodies.length > 0 && opened.bodies.every((b) => b.paddingLeft === 13 && b.marginLeft === 7 && b.borderLeft > 0 && b.borderLeft <= 1);
  const leftOf = (n) => opened.leaves.find((l) => l.name === n)?.left ?? null;
  const shallow = leftOf("a.md");
  const deep = leftOf("x.md");
  const stepOk = shallow !== null && deep !== null && (deep - shallow) >= 13;
  check("D 缩进步长：body 左内边距 13 + 外边距 7 + 0.5px 引导线；深一层右移 ≥13px", bodyOk && stepOk,
    `bodies=${JSON.stringify(opened.bodies)} shallow=${shallow} deep=${deep} Δ=${deep !== null && shallow !== null ? (deep - shallow).toFixed(1) : "?"}`);

  // ---- E 类型徽标 --------------------------------------------------------------------
  const kindsOk = opened.leaves.length > 0 && opened.leaves.every((l) => l.iconKind && l.iconText && Math.abs(l.iconW - 14) <= 0.6 && Math.abs(l.iconH - 14) <= 0.6);
  const kindMapOk = Object.entries(EXPECT.kinds).every(([name, kind]) => opened.leaves.find((l) => l.name === name)?.iconKind === kind);
  const js = opened.leaves.find((l) => l.name === "store.mjs");
  const md = opened.leaves.find((l) => l.name === "a.md");
  const json = opened.leaves.find((l) => l.name === "manifest.json");
  const colorOk = Boolean(js && md && json) && new Set([js.iconBg, md.iconBg, json.iconBg]).size === 3;
  check("E 类型徽标：14×14 + 有字母 + kind 正确 + js/md/json 三色互不相同", kindsOk && kindMapOk && colorOk,
    `14x14=${kindsOk} kindMap=${kindMapOk} colors=${[js?.iconBg, md?.iconBg, json?.iconBg].join(" | ")}`);

  // ---- F 体积列定宽右对齐 ------------------------------------------------------------
  const sizeW = opened.leaves.map((l) => l.sizeW ?? -1);
  const rightEdges = opened.leaves.map((l) => l.sizeRight ?? -1);
  const spread = Math.max(...rightEdges) - Math.min(...rightEdges);
  const widthsEqual = sizeW.every((w) => Math.abs(w - 68) <= 0.5);
  const alignOk = opened.leaves.every((l) => l.sizeAlign === "right");
  check("F 体积列定宽 68px、右边缘齐平（spread ≤1）、右对齐", widthsEqual && alignOk && spread <= 1,
    `w=${JSON.stringify(sizeW)} spread=${spread.toFixed(2)} align=${opened.leaves[0]?.sizeAlign}`);

  // ---- G 行高统一 --------------------------------------------------------------------
  const leafHeights = [...new Set(opened.leaves.map((l) => Math.round(l.height)))];
  const folderHeights = [...new Set(opened.folders.map((f) => Math.round(f.height)))];
  check("G 行高统一：文件行 22、文件夹行 22（±1）",
    leafHeights.every((h) => Math.abs(h - 22) <= 1) && folderHeights.every((h) => Math.abs(h - 22) <= 1),
    `leaf=${JSON.stringify(leafHeights)} folder=${JSON.stringify(folderHeights)}`);

  // ---- H 无横向溢出 ------------------------------------------------------------------
  check("H 树与整段都无横向溢出", opened.treeOverflow <= 1 && opened.panelOverflow <= 1,
    `tree=${opened.treeOverflow} panel=${opened.panelOverflow}`);

  // ---- I FR-96 语义零回归 ------------------------------------------------------------
  const titles = opened.leaves.map((l) => l.title).sort();
  const docsChips = opened.folders.find((f) => f.name === "docs/")?.chips ?? [];
  check("I FR-96 语义零回归：目录顺序 / 目录在前 / 叶子 title 一项不丢 / docs 胶囊含子树",
    JSON.stringify(opened.faceFolders) === JSON.stringify(EXPECT.faceFolders)
    && opened.foldersBeforeFiles === true
    && JSON.stringify(titles) === JSON.stringify(EXPECT.leafTitles)
    && docsChips.includes(EXPECT.docsPill),
    `face=${JSON.stringify(opened.faceFolders)} before=${opened.foldersBeforeFiles} leaves=${titles.length} docs=${JSON.stringify(docsChips)}`);

  // ---- J :hover 真换底色（forcePseudoState，确定性） ---------------------------------
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  let hoverOk = false;
  let hoverDetail = "";
  try {
    const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "li.req-file" });
    if (nodeIds?.length) {
      const idle = await evalJs(`getComputedStyle(document.querySelectorAll('li.req-file')[0]).backgroundColor`);
      await cdp.send("CSS.forcePseudoState", { nodeId: nodeIds[0], forcedPseudoClasses: ["hover"] });
      await sleep(150);
      const hovered = await evalJs(`getComputedStyle(document.querySelectorAll('li.req-file')[0]).backgroundColor`);
      hoverOk = hovered !== idle;
      hoverDetail = `idle=${idle} hover=${hovered}`;
      await cdp.send("CSS.forcePseudoState", { nodeId: nodeIds[0], forcedPseudoClasses: [] });
    } else hoverDetail = "querySelectorAll 空";
  } catch (e) { hoverDetail = `forcePseudoState 失败：${e.message}`; }
  check("J :hover 真换底色（整行可点感）", hoverOk, hoverDetail);
} finally {
  try { if (cdp) cdp.ws.close(); } catch { /* ignore */ }
  try { if (chrome) chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { await new Promise((resolve) => server.close(resolve)); } catch { /* ignore */ }
  try { store.close?.(); } catch { /* ignore */ }
  try { await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  clearTimeout(watchdog);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
process.exit(failed.length ? 1 : 0);
