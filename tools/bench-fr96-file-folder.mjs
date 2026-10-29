/**
 * FR-96「需求文档『引入的文件』按文件夹呈现」—— **真实浏览器验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么必须上真浏览器（卡 `-163` 立卡理由）
 * FR-96 此前只有**域层单测**（`tests/fr96-req-file-folder.test.mjs` 7 例：分层 / 排序 / 单链合并 /
 * 路径归一 / 空输入 / 叶子 path 保留 / **接线存在** / **样式独立**）。单测读的是源码文本，
 * 证明不了「写出来的树真的画进了抽屉」—— 尤其 2026-10-27 起这一块被改成**默认折叠**的
 * `<details class="req-section">`，「有没有画出来」与「点了才看得见」是两件事（本仓纪律：
 * **「结论存在」≠「结论可见」**）。
 *
 * ## 本台断言什么（全部读**渲染后的 DOM**）
 *   A. 段落存在（`引入的文件（N）`），且**默认折叠**（`details.open === false`）；
 *   B. 点 summary 能展开（`open === true`）—— 折叠改版后的必经交互；
 *   C. 标题里的计数与体积：`N` ＝ 种子条数，hint 里 `M 个文件夹 · 根级文件 K` 与树一致；
 *   D. **目录在前、文件在后**：树的第一层 `details` 全在根级 `ul.req-list-files` 之前；
 *   E. **单链合并**：`a/b/` 只出现一个节点，且**不存在**独立的 `a/`（点一层就见到文件）；
 *   F. 目录名顺序按中文排序（`a/b/` 在 `docs/` 前）；
 *   G. **一项不丢**：叶子 `li.req-file` 的 `title`（完整 path）集合 ＝ 种子 5 条；
 *   H. 子树计数：`docs/` 节点的胶囊是 **`3 个文件`**（含 `docs/交付/x.md`；不是只数直属 2 个）；
 *   I. **反向对照**（本台自证能区分新旧）：把 `.req-tree` 就地替换成**平铺 ul** 后重跑 D/E 的读数，
 *      必须**转红** —— 否则说明这两条判据恒真、抓不住回归。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写真实看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * ## 运行
 * `node tools/bench-fr96-file-folder.mjs`
 * 反证入口：`TB_BENCH_WEB_DIR=<改动前的 web 目录> node tools/bench-fr96-file-folder.mjs`
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

// ---- 种子：一份含「资料清单」的需求文档（嵌套路径 + 单链 + 根级文件 + 子树计数）---------------
const FILES = [
  { p: "AGENTS.md", b: 120 },          // 根级文件
  { p: "docs/z.md", b: 200 },          // 与 a.md 同级 ⇒ 排序要生效（a 在 z 前）
  { p: "docs/a.md", b: 10 },
  { p: "docs/交付/x.md", b: 300 },     // 子树 ⇒ docs/ 的「3 个文件」要靠递归计数
  { p: "a/b/c.md", b: 40 },            // 单链 ⇒ 必须并成 `a/b/`
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
  "这一段不属于资料清单（解析必须在此收边，不能把下面的内容也算成文件）。",
  "- `不该出现.md` — 1 B 反例",
  "",
].join("\n");

const EXPECT = {
  total: FILES.length,
  folderCount: 3,                       // a/b + docs + docs/交付
  rootFiles: 1,                         // AGENTS.md
  faceFolders: ["a/b/", "docs/"],       // 第一层：单链已合并、按中文排序
  docsPill: "3 个文件",                  // 含子树
  leafTitles: FILES.map((f) => f.p).sort(),
};

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-fr96-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-fr96-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
store.ensureRequirementDoc("default", { body: BODY });

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

/** 页内只读测量：把「引入的文件」区块的形状读成纯数据。 */
const PROBE = `(() => {
  const secs = [...document.querySelectorAll("details.req-section")];
  const sec = secs.find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"));
  if (!sec) return { ok: false, note: "no 引入的文件 section" };
  const head = (sec.querySelector("summary")?.textContent ?? "").replace(/\\s+/g, " ").trim();
  const tree = sec.querySelector(".req-tree");
  const kids = tree ? [...tree.children] : [];
  const folderNodes = tree ? [...tree.querySelectorAll("details.req-folder")] : [];
  const nameOf = (d) => (d.querySelector(":scope > summary .req-folder-name")?.textContent ?? "").trim();
  const faceFolders = kids.filter((n) => n.tagName === "DETAILS").map(nameOf);
  const lastFolderAt = kids.reduce((acc, n, i) => (n.tagName === "DETAILS" ? i : acc), -1);
  const firstUlAt = kids.findIndex((n) => n.tagName === "UL");
  const leaves = tree ? [...tree.querySelectorAll("li.req-file")] : [];
  const pillOf = (name) => {
    const node = folderNodes.find((d) => nameOf(d) === name);
    return node ? [...node.querySelectorAll(":scope > summary span.chip")].map((c) => c.textContent.trim()) : [];
  };
  return {
    ok: true,
    sectionOpen: sec.open === true,
    head,
    treeExists: Boolean(tree),
    faceFolders,
    folderTotal: folderNodes.length,
    foldersBeforeFiles: lastFolderAt >= 0 && (firstUlAt === -1 || lastFolderAt < firstUlAt),
    leafTitles: leaves.map((li) => li.title).sort(),
    leafNames: leaves.map((li) => (li.querySelector(".req-file-name")?.textContent ?? "").trim()),
    docsPill: pillOf("docs/"),
    abPill: pillOf("a/b/"),
    innerFoldersOpen: folderNodes.map((d) => ({ name: nameOf(d), open: d.open })),
  };
})()`;

/** 反向对照：把文件夹树**就地打平**成旧的「一列平铺」，模拟改动前的口径。 */
const FLATTEN = `(() => {
  const secs = [...document.querySelectorAll("details.req-section")];
  const sec = secs.find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"));
  const tree = sec?.querySelector(".req-tree");
  if (!tree) return { ok: false, note: "no tree" };
  const leaves = [...tree.querySelectorAll("li.req-file")];
  const ul = document.createElement("ul");
  ul.className = "req-list-files";
  for (const li of leaves) {
    const clone = document.createElement("li");
    clone.className = "req-file";
    clone.title = li.title;
    clone.textContent = li.title;
    ul.appendChild(clone);
  }
  tree.replaceChildren(ul);
  return { ok: true, leaves: leaves.length };
})()`;

let chrome = null;
let cdp = null;
try {
  const debugPort = await freePort();
  // 环境坑（同 bench-req-item-list / bench-next-column）：workspace-write 沙箱里 Chrome 自带沙箱
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
    return evalJs(`({ ok: Boolean([...document.querySelectorAll("details.req-section")]
      .find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"))) })`);
  }, 25000, "需求视图出现「引入的文件」段");
  if (!opened.ok) throw new Error(`需求视图未渲染出「引入的文件」段：${opened.note ?? ""}`);

  // ---- A 段落存在 + 默认折叠 ---------------------------------------------------------------
  const collapsed = await evalJs(PROBE);
  check(`A 「引入的文件（${EXPECT.total}）」段存在`, collapsed.ok && collapsed.head.includes(`引入的文件（${EXPECT.total}）`),
    collapsed.ok ? collapsed.head.slice(0, 80) : (collapsed.note ?? ""));
  check("A 默认折叠（`details.open === false`）—— 2026-10-27 折叠改版后的口径", collapsed.ok && collapsed.sectionOpen === false,
    collapsed.ok ? `open=${collapsed.sectionOpen}` : "");

  // ---- B 点 summary 能展开 ------------------------------------------------------------------
  const expanded = await waitFor(async () => {
    await evalJs(`(() => {
      const sec = [...document.querySelectorAll("details.req-section")]
        .find((d) => (d.querySelector("summary")?.textContent ?? "").includes("引入的文件"));
      if (!sec) return false;
      sec.querySelector("summary").click();
      return true;
    })()`);
    await sleep(400);
    return evalJs(PROBE);
  }, 15000, "点开「引入的文件」");
  check("B 点 summary 真能展开（`open === true`）", expanded.ok && expanded.sectionOpen === true,
    expanded.ok ? `open=${expanded.sectionOpen}` : (expanded.note ?? ""));
  check("B 展开后树真的画出来了（`.req-tree` 存在、叶子 5 条）",
    expanded.ok && expanded.treeExists && expanded.leafTitles.length === EXPECT.total,
    expanded.ok ? `tree=${expanded.treeExists} leaves=${expanded.leafTitles.length}` : "");

  // ---- C 标题计数与体积 --------------------------------------------------------------------
  const hintOk = expanded.ok && /个文件夹/.test(expanded.head) && /根级文件/.test(expanded.head)
    && expanded.head.includes(`${EXPECT.folderCount} 个文件夹`) && expanded.head.includes(`根级文件 ${EXPECT.rootFiles}`);
  check(`C 标题 hint 与树一致（${EXPECT.folderCount} 个文件夹 · 根级文件 ${EXPECT.rootFiles}）`, hintOk,
    expanded.ok ? expanded.head.slice(0, 120) : "");

  // ---- D/E/F 目录在前、单链合并、排序 ------------------------------------------------------
  const faceFolders = expanded.ok ? expanded.faceFolders : [];
  check(`D 第一层目录顺序＝${JSON.stringify(EXPECT.faceFolders)}（单链已合并、按中文排序）`,
    JSON.stringify(faceFolders) === JSON.stringify(EXPECT.faceFolders), JSON.stringify(faceFolders));
  check("E 单链合并：不存在独立的 `a/`（点一层就见到 `c.md`）",
    faceFolders.includes("a/b/") && !faceFolders.includes("a/"), JSON.stringify(faceFolders));
  check("F 目录排在根级文件之前（DOM 顺序）", expanded.ok && expanded.foldersBeforeFiles === true,
    expanded.ok ? `foldersBeforeFiles=${expanded.foldersBeforeFiles}` : "");

  // ---- G 一项不丢 + H 子树计数 -------------------------------------------------------------
  const gotTitles = expanded.ok ? expanded.leafTitles : [];
  check("G 叶子 title（完整 path）集合 ＝ 种子 5 条（一项不丢、不多）",
    JSON.stringify(gotTitles) === JSON.stringify(EXPECT.leafTitles),
    `got=${JSON.stringify(gotTitles)}`);
  check(`H \`docs/\` 节点胶囊 ＝ 「${EXPECT.docsPill}」（含子树，不是只数直属 2 个）`,
    expanded.ok && (expanded.docsPill ?? []).includes(EXPECT.docsPill), JSON.stringify(expanded.docsPill ?? []));

  // ---- I 反向对照：打平后 D/E 必须转红 ------------------------------------------------------
  const flat = await evalJs(FLATTEN);
  const afterFlat = await evalJs(PROBE);
  const dRed = JSON.stringify(afterFlat?.faceFolders ?? null) !== JSON.stringify(EXPECT.faceFolders);
  const eRed = !(afterFlat?.faceFolders ?? []).includes("a/b/");
  check("I 反向对照：把树打平成旧口径后，D（目录顺序）与 E（单链合并）都转红",
    flat?.ok === true && dRed && eRed,
    flat?.ok ? `打平后 faceFolders=${JSON.stringify(afterFlat?.faceFolders)} · D红=${dRed} E红=${eRed}` : (flat?.note ?? ""));
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
