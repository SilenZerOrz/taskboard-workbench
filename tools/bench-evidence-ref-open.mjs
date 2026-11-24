/**
 * 卡 `-293`（需求 `R197`）· 证据引用「点开即读」—— **真实浏览器 + 真 HTTP** 验证台
 * （真 headless Chrome + CDP，Node 自带 WebSocket，零依赖）。
 *
 * ## 为什么还要这一台（`R197` 的真机批注）
 * 真机 2026-11-23：抽屉里「可核验引用」是一行 `file · docs/...`，**点击无反应** ——
 * 引用可核对却不可读，人还得自己去编辑器里找。
 * 这类缺陷**不报错、不进日志、单测读不出**：
 *   · 单测能证明「源码里有 `button`」，证明不了「点下去真的渲染出了内容」；
 *   · 单测能证明「端点对 `../` 抛了错」，证明不了「真 HTTP 上那三条各返回什么码」；
 *   · 更证明不了「宿主能力探不到时，界面**如实**说降级，而不是假装打开成功」。
 *
 * ## 本台断言什么
 *   A（真 HTTP · 逐条拒绝码）：
 *     A1 正常相对路径 ⇒ 200 + 文件原文；
 *     A2 `../` 穿越 ⇒ 非 200 + `FILE_PATH_TRAVERSAL`；
 *     A3 workspace 外绝对路径 ⇒ 非 200 + `FILE_OUTSIDE_WORKSPACE`；
 *     A4 不存在的文件 ⇒ 404 + `FILE_NOT_FOUND`；
 *     A5 符号链接逃逸 ⇒ 非 200 + `FILE_OUTSIDE_WORKSPACE`；
 *     A6 >512KB ⇒ 非 200 + `FILE_TOO_LARGE`（带体积与上限）；
 *     A7 二进制 ⇒ 非 200 + `FILE_NOT_TEXT`（带原因）；
 *     A8 项目无工作区 ⇒ 非 200 + `PROJECT_WORKSPACE_MISSING`；
 *     A9 POST ⇒ 非 200（端点**只读**）；且读路径**不写库**（评论/事件行数不变）。
 *   B（真浏览器 · 渲染后 DOM）：
 *     B1 引用渲染成 `BUTTON` 且 `type=button`；
 *     B2 点引用 ⇒ 抽屉内只读查看器**渲染出文件真内容**；
 *     B3 按钮上**如实标注**走了哪条路（`data-open-via`）；
 *     B4 宿主能力**探不到**时 ⇒ 降级到查看器（不是假装打开成功）；
 *     B5 宿主能力**探得到**时 ⇒ 真去调宿主（调用实参是**绝对路径**），且**不**渲染查看器；
 *     B6 查看器：等宽字体 + 行号可开关 + 超长**显式**写明已截断；
 *     B7 `commit` 类引用**不是**按钮（git 对象不是文件，点击无意义）；
 *     B8 全程无 error 横幅；
 *     **B9 主路＝DSH 侧边栏**：桩 betterSidebar ⇒ `openTab` 真的被调（`path===服务端 absPath`、
 *       `type==="editor"`、`scope.sessionId` 在），且界面**如实**写「已在 DSH 侧边栏打开 <文件名>」；
 *     **B10 兜底**：没有 betterSidebar ⇒ 落抽屉内只读查看器，且**如实标注走了兜底**（不谎称已侧边栏打开）。
 *
 *   S（**真产品源码** · 纯 Node · 第 2 轮返工口径）：
 *     直接从 `lib/client.js` 的 `#region host-open-file` 里**原样取出** `createHostOpenFile` 执行 ——
 *     台内自造替身只能证明「前端会调它」，证明不了「真客户端侧边栏那套（软取 / openTab / scope）是对的」。
 *     S1 桩 betterSidebar ⇒ `openTab` 调 **1 次**，`path===absPath` / `type==="editor"` / scope 有 sessionId；
 *     S2 `line` 是 **1-based**（给了就原样带上去）；
 *     S3 **无 betterSidebar** ⇒ 明确降级、`openTab` **0 次**；
 *     S4 `ctx.get` **抛错**（cordis 坑）⇒ 同样明确降级、不把异常抛给调用方；
 *     S5 `openTab` 抛错 ⇒ 明确降级 + 带上原消息；
 *     S6 探测读数带**真实 key 列表**（不只报 true/false）。
 *
 * ## C 段（**可选** · `TB_BENCH_REAL_HOST=1`）：隔离**真 dsh 宿主**里的能力探测读数
 *   验收①要的是「宿主能力探测**打印真实 key 列表**」。台内用替身只能证明「逻辑对」，
 *   证明不了「真宿主的这三个服务上到底有没有打开文件的方法」——
 *   这一段用隔离真 dsh（临时 `DSH_HOME` + 随机端口 + 独立进程 + 真 headless Chrome）取**真读数**：
 *   服务端（`/api/host/probe`）与客户端（`window.__TB_PLUGIN__.openFileProbe`）各一份。
 *   环境不具备（找不到 dsh / 起不来）⇒ 该段 SKIP，**不计入退出码**。
 *
 * ## 反向对照（反证本台真的会红）
 *   ```
 *   TB_BENCH_REVERSE=1 node tools/bench-evidence-ref-open.mjs
 *   ```
 *   ＝把 `HEAD:web/`（**本卡落地前**的前端）取到临时目录当 WEB_DIR 跑一遍 ⇒ **必须转红 ≥3 条**。
 *   也可手工指定：`TB_BENCH_WEB_DIR=/tmp/tb-oldweb node tools/bench-evidence-ref-open.mjs`。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区 + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-evidence-ref-open.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 *
 * ⚠ **不要与其它真浏览器验证台并发跑**（资源争抢 ⇒ 看板首屏取数可能超时，表现为「首屏没卡」）。
 *   本台把「看板出卡」的等待放宽到 45s 作为兜底，但并发跑仍可能互相拖慢 —— 一次只跑一台。
 */
import { mkdtemp, rm, mkdir, writeFile, symlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REVERSE = process.env.TB_BENCH_REVERSE === "1";
/** 反证模式下用 `HEAD:web/`（本卡落地前的前端）；正跑用工作树的 `web/`。 */
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

// ---- CDP 客户端（Node 自带 WebSocket，零依赖） ----------------------------------------------
class Cdp {
  constructor(socket) {
    this.ws = socket;
    this.seq = 0;
    this.pending = new Map();
    this.sessionId = null;
    socket.addEventListener("message", (event) => {
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

/** 起一个真 headless Chrome 并连上 CDP。返回 { chrome, cdp, evalJs, close }。 */
async function launchChrome(profileDir) {
  const debugPort = await freePort();
  // ⚠ 环境坑（2026-10-27 实测）：Chrome **自带沙箱**在窄沙箱里拉不起渲染进程
  //   ⇒ `Page.enable` / `Runtime.enable` 全部超时（表现为「devtools 就绪、page 域无响应」）。
  //   本台用临时 profile + 无用户数据 ⇒ 加 `--no-sandbox` 系列让渲染进程起来。
  const proc = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
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
  if (!version?.webSocketDebuggerUrl) { try { proc.kill("SIGKILL"); } catch { /* ignore */ } throw new Error("devtools 端点未就绪"); }
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP WebSocket 失败")), { once: true });
  });
  const cdp = new Cdp(ws);
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
  const close = async () => {
    try { await cdp.send("Browser.close", {}, null); } catch { /* ignore */ }
    try { proc.kill("SIGKILL"); } catch { /* ignore */ }
  };
  return { chrome: proc, cdp, evalJs, close };
}

// ---- 台内数据：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-data-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-ws-"));
const outsideDir = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-out-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-chrome-"));

const REF_PATH = "docs/进度/README.md";
const REF_CONTENT = "# 只读查看器自检\n第二行：这是种子内容\n第三行：点引用就该看到我\n";
const LONG_PATH = "docs/进度/LONG.md";
const LONG_LINES = 1200;

await mkdir(path.join(workspace, "docs", "进度"), { recursive: true });
await writeFile(path.join(workspace, REF_PATH), REF_CONTENT, "utf8");
await writeFile(path.join(workspace, LONG_PATH), Array.from({ length: LONG_LINES }, (_, i) => `第 ${i + 1} 行`).join("\n"), "utf8");
await writeFile(path.join(workspace, "docs", "big.txt"), "x".repeat(512 * 1024 + 1024), "utf8");
await writeFile(path.join(workspace, "docs", "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
await writeFile(path.join(outsideDir, "secret.txt"), "不该被读到\n", "utf8");
try { await symlink(path.join(outsideDir, "secret.txt"), path.join(workspace, "docs", "escape.txt")); }
catch { /* 平台不支持符号链接 ⇒ A5 用例改判「该平台不支持」 */ }

const store = openStore({ dataDir, env: {} });
// ⚠ 建项目**顺序**有讲究（实测踩到的坑）：服务端 `defaultProject()` 按
//   `coalesce(该项目的最近任务时间, 项目 updated_at) desc, rowid desc` 选「默认进入的项目」。
//   若两个项目**落在同一毫秒** ⇒ 时间并列 ⇒ 退回 `rowid desc` ⇒ **后建的那个赢** ——
//   而看板首屏只显示默认项目下的卡 ⇒ 台内就会「一张卡都没有」。
//   所以：**先建没有工作区的项目，再建目标项目，最后建卡** ⇒ 目标项目的
//   `coalesce(任务时间, updated_at)` 必然最大 ⇒ 默认项目**恒**是目标项目（与时钟抖动无关）。
store.createProject({ id: "p-nows", name: "无工作区项目", workspacePath: null });
store.createProject({ id: "p1", name: "P1", workspacePath: workspace });
const CARD_TITLE = "证据引用可点的卡";
const card = store.createTask({ projectId: "p1", title: CARD_TITLE, status: "todo" });
store.addTaskEvidence(card.identifier, {
  verdict: "判定：完成，已提交待验收",
  deviation: "偏离说明：无",
  boundary: "边界自查：未碰 :3080、未删数据",
  artifacts: [REF_PATH],
  artifactRefs: [{ kind: "file", ref: REF_PATH }, { kind: "file", ref: LONG_PATH }, { kind: "commit", ref: "deadbeef" }],
  actor: "codex",
});

const server = createServer({ store, webDir: WEB_DIR });
const port = await freePort();
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
console.log(`… 台内服务 ${base} · dataDir=${dataDir} · workspace=${workspace} · webDir=${WEB_DIR}${REVERSE ? " · 【反证模式】" : ""}`);

/** 真 HTTP 取一个端点：返回 { status, body }（不抛，失败也拿得到 status）。 */
const httpGet = async (url) => {
  const res = await fetch(`${base}${url}`);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

// ════════════════════════════════════════════════════════════════════════════
// A 段：只读端点的逐条拒绝码（真 HTTP）
// ════════════════════════════════════════════════════════════════════════════
const a1 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent(REF_PATH)}`);
check("A1 正常相对路径 ⇒ 200 + 文件原文",
  a1.status === 200 && String(a1.body?.text ?? "").includes("这是种子内容"),
  `status=${a1.status} · body=${JSON.stringify(a1.body)?.slice(0, 160)}`);

const a2 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent("../../etc/passwd")}`);
check("A2 `../` 穿越 ⇒ 非 200 + FILE_PATH_TRAVERSAL",
  a2.status !== 200 && a2.body?.error?.code === "FILE_PATH_TRAVERSAL",
  `status=${a2.status} · code=${a2.body?.error?.code}`);

const a3 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent(path.join(outsideDir, "secret.txt"))}`);
check("A3 workspace 外的绝对路径 ⇒ 非 200 + FILE_OUTSIDE_WORKSPACE",
  a3.status !== 200 && a3.body?.error?.code === "FILE_OUTSIDE_WORKSPACE",
  `status=${a3.status} · code=${a3.body?.error?.code}`);

const a4 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent("docs/进度/不存在.md")}`);
check("A4 不存在的文件 ⇒ 404 + FILE_NOT_FOUND",
  a4.status === 404 && a4.body?.error?.code === "FILE_NOT_FOUND",
  `status=${a4.status} · code=${a4.body?.error?.code}`);

const a5 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent("docs/escape.txt")}`);
check("A5 符号链接逃逸 ⇒ 非 200 + FILE_OUTSIDE_WORKSPACE",
  a5.status !== 200 && a5.body?.error?.code === "FILE_OUTSIDE_WORKSPACE",
  `status=${a5.status} · code=${a5.body?.error?.code}`);

const a6 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent("docs/big.txt")}`);
check("A6 >512KB ⇒ 非 200 + FILE_TOO_LARGE（带体积与上限）",
  a6.status !== 200 && a6.body?.error?.code === "FILE_TOO_LARGE"
    && a6.body?.error?.details?.maxBytes === 512 * 1024 && a6.body?.error?.details?.size > 512 * 1024,
  `status=${a6.status} · code=${a6.body?.error?.code} · details=${JSON.stringify(a6.body?.error?.details)}`);

const a7 = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent("docs/bin.dat")}`);
check("A7 二进制 ⇒ 非 200 + FILE_NOT_TEXT（带原因）",
  a7.status !== 200 && a7.body?.error?.code === "FILE_NOT_TEXT" && /二进制/.test(a7.body?.error?.message ?? ""),
  `status=${a7.status} · code=${a7.body?.error?.code} · msg=${a7.body?.error?.message}`);

const a8 = await httpGet(`/api/projects/p-nows/file?path=${encodeURIComponent(REF_PATH)}`);
check("A8 项目没登记工作区 ⇒ 非 200 + PROJECT_WORKSPACE_MISSING",
  a8.status !== 200 && a8.body?.error?.code === "PROJECT_WORKSPACE_MISSING",
  `status=${a8.status} · code=${a8.body?.error?.code}`);

const beforeStats = store.stats();
const a9post = await fetch(`${base}/api/projects/p1/file?path=${encodeURIComponent(REF_PATH)}`, { method: "POST" });
const a9get = await httpGet(`/api/projects/p1/file?path=${encodeURIComponent(REF_PATH)}`);
const afterStats = store.stats();
check("A9 端点只读：POST 被拒；且读路径**不写库**（评论/事件行数不变）",
  a9post.status !== 200 && a9get.status === 200
    && afterStats.comments === beforeStats.comments && afterStats.tasks === beforeStats.tasks,
  `POST=${a9post.status} · GET=${a9get.status} · comments ${beforeStats.comments}→${afterStats.comments} · tasks ${beforeStats.tasks}→${afterStats.tasks}`);

// ════════════════════════════════════════════════════════════════════════════
// S 段：**真产品源码**的侧边栏能力（纯 Node · 第 2 轮返工口径）
//
// 为什么单独一段、且**从源码里原样取**：`lib/client.js` 是 DSH 客户端 bundle（IIFE，浏览器里跑），
// 台内自造一个 `openFile` 替身只能证明「前端会调它」——
// 证明不了「真客户端那套（软取 betterSidebar / openTab 实参 / scope）是对的」。
// 这里把 `#region host-open-file` 原样切出来执行 ⇒ 守的是**产品代码**本身。
// ════════════════════════════════════════════════════════════════════════════
const clientRegion = (() => {
  const src = readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
  const start = src.indexOf("// #region host-open-file");
  const end = src.indexOf("// #endregion", start);
  if (start < 0 || end < 0) throw new Error("lib/client.js 里找不到 #region host-open-file 区块");
  // 去掉 `#region` 注释行本身（`#region` 在函数体外是私有字段语法，切出来直接 eval 会炸）。
  return src.slice(start, end).replace(/^\s*\/\/ #region[^\n]*\n/, "");
})();
const createHostOpenFile = new Function(`${clientRegion}; return createHostOpenFile;`)();
const SIDEBAR_ABS = "/tmp/tb-bench-ws/docs/进度/README.md";

const s1calls = [];
const s1 = createHostOpenFile({
  getService: (name) => (name === "betterSidebar" ? {
    openTab: (seed, scope) => { s1calls.push({ seed, scope }); },
    getTab: (id) => ({ id }),
    isTabEnabled: () => true,
    features: ["badge", "targetedOpen", "openFile"],
  } : null),
});
const s1r = await s1(SIDEBAR_ABS, undefined, "bench-session-1");
check("S1 桩 betterSidebar ⇒ openTab 被调 1 次，且 path===absPath / type===\"editor\" / scope 有 sessionId",
  s1r?.ok === true && s1r?.via === "betterSidebar.openTab" && s1calls.length === 1
    && s1calls[0]?.seed?.path === SIDEBAR_ABS && s1calls[0]?.seed?.type === "editor"
    && typeof s1calls[0]?.scope?.sessionId === "string" && s1calls[0].scope.sessionId.length > 0
    && !("line" in (s1calls[0]?.seed ?? {})),
  `ok=${s1r?.ok} · via=${s1r?.via} · calls=${JSON.stringify(s1calls)}`);

const s2calls = [];
const s2 = createHostOpenFile({
  getService: () => ({ openTab: (seed, scope) => { s2calls.push({ seed, scope }); }, isTabEnabled: () => true }),
});
await s2(SIDEBAR_ABS, 12, "bench-session-2");
check("S2 `line` 是 1-based：给了就原样带进 seed（没给就不带这个键）",
  s2calls.length === 1 && s2calls[0]?.seed?.line === 12 && s2calls[0]?.scope?.sessionId === "bench-session-2",
  `seed=${JSON.stringify(s2calls[0]?.seed)} · scope=${JSON.stringify(s2calls[0]?.scope)}`);

const s3calls = [];
const s3 = createHostOpenFile({ getService: () => null });
const s3r = await s3(SIDEBAR_ABS, undefined, "bench-session-3");
check("S3 **无 betterSidebar** ⇒ 明确降级（ok=false + 原因含 better-sidebar），openTab 0 次",
  s3r?.ok === false && /better-sidebar/.test(String(s3r?.reason ?? "")) && s3calls.length === 0,
  `ok=${s3r?.ok} · reason=${s3r?.reason}`);

const s4calls = [];
const s4 = createHostOpenFile({
  // cordis 的坑：对**未声明 inject** 的服务取值会抛 ⇒ 出口必须自己吞掉这个异常。
  getService: () => { throw new Error('cannot get property "betterSidebar" without inject'); },
});
let s4r = null;
let s4threw = null;
try { s4r = await s4(SIDEBAR_ABS, undefined, "bench-session-4"); } catch (error) { s4threw = error; }
check("S4 `ctx.get` 抛错 ⇒ 仍然明确降级、**不把异常抛给调用方**、openTab 0 次",
  s4threw === null && s4r?.ok === false && /better-sidebar/.test(String(s4r?.reason ?? "")) && s4calls.length === 0,
  `threw=${s4threw?.message ?? "无"} · ok=${s4r?.ok} · reason=${s4r?.reason}`);

const s5calls = [];
const s5 = createHostOpenFile({
  getService: () => ({ openTab: () => { s5calls.push(1); throw new Error("侧边栏炸了"); }, isTabEnabled: () => true }),
});
const s5r = await s5(SIDEBAR_ABS, undefined, "bench-session-5");
check("S5 `openTab` 抛错 ⇒ 明确降级 + 带上原消息（不吞掉、不谎报成功）",
  s5r?.ok === false && /侧边栏炸了/.test(String(s5r?.reason ?? "")) && s5calls.length === 1,
  `ok=${s5r?.ok} · reason=${s5r?.reason}`);

check("S6 探测读数带**真实 key 列表**（不只报 true/false —— 否则分不清「宿主没这能力」还是「我们找错方法名」）",
  Array.isArray(s1r?.probed?.betterSidebar?.keys) && s1r.probed.betterSidebar.keys.includes("openTab")
    && s1r.probed.betterSidebar.present === true && s1r.probed.betterSidebar.hasOpenTab === true
    && Array.isArray(s1r?.probed?.hostServices) && s1r.probed.hostServices.length === 3,
  `真实 key 列表=${JSON.stringify(s1r?.probed?.betterSidebar?.keys)} · 次路候选=${JSON.stringify((s1r?.probed?.hostServices ?? []).map((p) => ({ service: p.service, present: p.present, keyCount: p.keys?.length ?? -1 })))}`);

// ════════════════════════════════════════════════════════════════════════════
// B 段：真浏览器渲染（headless Chrome + CDP）
// ════════════════════════════════════════════════════════════════════════════
let chrome = null;
let cdp = null;
try {
  const browser = await launchChrome(chromeProfile);
  chrome = browser.chrome;
  cdp = browser.cdp;
  const evalJs = browser.evalJs;
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp.send("Page.navigate", { url: `${base}/` });
  await sleep(2500);

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

  // 重挂看板：**注入真产品源码**（`lib/client.js` 的 `#region host-open-file`）+ 可切换的 betterSidebar 桩。
  //
  // 为什么注入真源码而不是自造替身：自造替身只能证明「前端会调它」，
  // 证明不了「真客户端侧边栏那套（软取 / `openTab` 实参 / `scope`）是对的」——
  // 由**真源码**去调桩 betterSidebar，才守得住第 2 轮返工的口径。
  // 全局开关：`__TB_HOST_MODE__`＝`"sidebar"` 时有 betterSidebar（走主路）；`"fallback"` 时**没有**（走兜底）。
  const mounted = await evalJs(`(() => {
    try { window.__TB_BOARD__.__controller?.destroy?.(); } catch (_) {}
    window.__TB_OPEN_CALLS__ = [];   // 每次「打开文件」尝试传进去的绝对路径
    window.__TB_OPEN_SEEDS__ = [];   // 真正落到 openTab 的 {seed, scope}
    window.__TB_HOST_MODE__ = "fallback";
    const factory = new Function(${JSON.stringify(clientRegion)} + "; return createHostOpenFile;")();
    const realOpenFile = factory({
      getService: (name) => {
        if (name !== "betterSidebar") return null;
        if (window.__TB_HOST_MODE__ !== "sidebar") return null;
        return {
          openTab: (seed, scope) => { window.__TB_OPEN_SEEDS__.push({ seed, scope }); },
          getTab: (id) => ({ id }),
          isTabEnabled: () => true,
          features: ["badge", "targetedOpen", "openFile"],
        };
      },
    });
    window.__TB_OPEN_FILE__ = async (absPath, line) => {
      window.__TB_OPEN_CALLS__.push(absPath);
      return realOpenFile(absPath, line, "bench-session-1");
    };
    window.__TB_BOARD__.__controller = window.__TB_BOARD__.createBoard({
      root: document.getElementById("tb-app"),
      apiBase: "",
      openFile: window.__TB_OPEN_FILE__,
    });
    return Boolean(window.__TB_BOARD__.__controller);
  })()`);
  check("B0 看板挂载成功（注入真客户端侧边栏源码 + 宿主打开替身）", mounted === true, `mounted=${mounted}`);

  // 兜底：把项目选择器**显式**拨到目标项目（首屏默认项目由服务端 `defaultProject()` 决定，
  // 那是另一条口径 —— 台内不该把「默认落在哪个项目」当既定事实）。
  await evalJs(`(() => {
    const sel = document.querySelector('select[aria-label="选择项目"]');
    if (!sel) return false;
    if (![...sel.options].some((o) => o.value === "p1")) return false;
    sel.value = "p1";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

  const cardFound = await waitFor(async () => {
    const t = await evalJs(`(() => [...document.querySelectorAll("article.task-card .card-title")].map((n) => n.textContent.trim()))()`);
    return { ok: Array.isArray(t) && t.includes(CARD_TITLE), titles: t };
  }, 45000, "看板出卡");
  // 失败时把**现场**带出来（横幅 / 外壳在不在 / 当前落在哪个项目）—— 只报「空数组」时，
  // 人无从判断是「看板没渲染」「渲染了但没数据」还是「落在了别的项目」。
  const cardDiag = cardFound.ok ? "" : await evalJs(`(() => ({
    shell: Boolean(document.querySelector(".app-shell")),
    banner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? (b.textContent ?? "").trim() : null; })(),
    boot: (document.querySelector(".tb-boot-strip")?.textContent ?? "").trim().slice(0, 120),
    project: document.querySelector('select[aria-label="选择项目"]')?.value ?? null,
  }))()`).then((d) => JSON.stringify(d));
  check("B0① 看板首屏出目标卡", cardFound.ok, cardFound.ok ? JSON.stringify(cardFound.titles) : `titles=${JSON.stringify(cardFound.titles)} · 现场=${cardDiag}`);

  const projectNow = await evalJs(`(() => document.querySelector('select[aria-label="选择项目"]')?.value ?? null)()`);
  check("B0② 看板落在目标项目 p1（默认项目口径由服务端定，台内显式对齐）",
    projectNow === "p1", `project=${projectNow}`);

  // 打开抽屉 → 读「可核验引用」段的**渲染后**结构。
  const openDrawer = async () => {
    await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(CARD_TITLE)});
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await sleep(1800);
    return evalJs(`(() => {
      const body = document.querySelector(".tb-drawer-body");
      const sec = body?.querySelector(".exec-record");
      if (!sec) return { found: false, bodyText: (body?.textContent ?? "").slice(0, 300) };
      const ul = sec.querySelector(".exec-record-refs");
      const items = [...(ul?.querySelectorAll("li") ?? [])];
      const btns = [...(ul?.querySelectorAll("button") ?? [])];
      const btn = btns[0] ?? null;
      return {
        found: true,
        itemCount: items.length,
        liTags: items.map((li) => [...li.children].map((n) => n.tagName + "." + (n.className || "")).join("+")),
        btnCount: btns.length,
        btnTag: btn?.tagName ?? null,
        btnType: btn?.getAttribute("type") ?? null,
        btnClass: btn?.className ?? null,
        btnText: (btn?.textContent ?? "").trim(),
        btnTitle: btn?.getAttribute("title") ?? "",
        btnRef: btn?.dataset?.ref ?? null,
        commitBtnCount: [...ul.querySelectorAll("button")].filter((b) => (b.dataset?.kind ?? "") === "commit").length,
        commitText: items.map((li) => (li.textContent ?? "").trim()),
        errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? (b.textContent ?? "").trim() : null; })(),
      };
    })()`);
  };

  const d = await openDrawer();
  check("B1 引用渲染成 BUTTON 且 type=button（不再是死文本）",
    d?.found === true && d?.btnTag === "BUTTON" && d?.btnType === "button" && d?.btnClass?.includes("exec-ref-open"),
    `btnTag=${d?.btnTag} · btnType=${d?.btnType} · btnClass=${d?.btnClass} · liTags=${JSON.stringify(d?.liTags)}`);
  check("B1① 三条引用都在（2 个 file + 1 个 commit）", d?.itemCount === 3, `itemCount=${d?.itemCount}`);

  // B4：宿主能力**探不到** ⇒ 降级到抽屉内只读查看器（如实说降级，不假装打开成功）。
  const clicked = await evalJs(`(() => {
    const btn = document.querySelector(".exec-record-refs button.exec-ref-open");
    if (!btn) return null;
    btn.click();
    return true;
  })()`);
  check("B2 点引用 ⇒ 真的点了（不是只断言按钮在）", clicked === true, `clicked=${clicked}`);
  await sleep(1500);

  const afterClick = await evalJs(`(() => {
    const btn = document.querySelector(".exec-record-refs button.exec-ref-open");
    const li = btn?.closest("li");
    const box = li?.querySelector(".exec-ref-viewer");
    const body = box?.querySelector(".exec-ref-viewer-body");
    const lnBtn = [...(box?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim() === "行号");
    const cs = body ? getComputedStyle(body) : null;
    return {
      openVia: btn?.dataset?.openVia ?? null,
      note: (li?.querySelector(".exec-ref-open-note")?.textContent ?? "").trim(),
      hasViewer: Boolean(box),
      viewerText: (box?.querySelector(".exec-ref-viewer-head")?.textContent ?? "").trim(),
      contentHasSeed: (body?.textContent ?? "").includes("这是种子内容"),
      lineCount: body?.querySelectorAll(".exec-ref-viewer-line").length ?? 0,
      fontFamily: cs?.fontFamily ?? "",
      lnBtnExists: Boolean(lnBtn),
      lnPressedBefore: lnBtn?.getAttribute("aria-pressed") ?? null,
      lnDisplay: (() => {
        const ln = box?.querySelector(".exec-ref-viewer-ln");
        return ln ? getComputedStyle(ln).display : null;
      })(),
      errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? (b.textContent ?? "").trim() : null; })(),
      hostCalls: Array.isArray(window.__TB_OPEN_CALLS__) ? window.__TB_OPEN_CALLS__.length : -1,
    };
  })()`);
  check("B2① 点引用 ⇒ 抽屉内只读查看器**渲染出文件真内容**",
    afterClick?.hasViewer === true && afterClick?.contentHasSeed === true,
    `hasViewer=${afterClick?.hasViewer} · contentHasSeed=${afterClick?.contentHasSeed} · head=${afterClick?.viewerText}`);
  check("B3 按钮上**如实标注**走了哪条路（data-open-via=viewer）",
    afterClick?.openVia === "viewer", `openVia=${afterClick?.openVia} · note=${afterClick?.note}`);
  check("B4 宿主能力探不到 ⇒ 如实降级（调了宿主但没成功，且**不谎报**已打开）",
    afterClick?.hostCalls === 1 && !/已在 DSH (内|侧边栏)打开/.test(afterClick?.note ?? ""),
    `hostCalls=${afterClick?.hostCalls} · note=${afterClick?.note}`);
  check("B6 查看器等宽字体 + 行号默认关且可开关",
    /mono/i.test(afterClick?.fontFamily ?? "") && afterClick?.lnBtnExists === true
      && afterClick?.lnDisplay === "none" && afterClick?.lnPressedBefore === "false",
    `font=${afterClick?.fontFamily} · lnDisplay=${afterClick?.lnDisplay} · pressed=${afterClick?.lnPressedBefore}`);
  check("B8 无 error 横幅", !afterClick?.errorBanner, afterClick?.errorBanner ?? "");

  // 行号开关：点一次 ⇒ 行号出现（两态对照，防「静态装饰」冒充）。
  const lnToggled = await evalJs(`(() => {
    const box = document.querySelector(".exec-ref-viewer");
    const lnBtn = [...(box?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").trim() === "行号");
    if (!lnBtn) return null;
    lnBtn.click();
    const ln = box.querySelector(".exec-ref-viewer-ln");
    return { pressed: lnBtn.getAttribute("aria-pressed"), display: ln ? getComputedStyle(ln).display : null };
  })()`);
  check("B6① 点「行号」⇒ 行号真出现（两态对照）",
    lnToggled?.pressed === "true" && lnToggled?.display !== "none",
    JSON.stringify(lnToggled));

  // B6② 超长文件 ⇒ 显式写明已截断（不是静默 slice）。
  await evalJs(`(() => {
    const btns = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")];
    const btn = btns.find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(LONG_PATH)});
    if (!btn) return null;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  const longView = await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(LONG_PATH)});
    const li = btn?.closest("li");
    const box = li?.querySelector(".exec-ref-viewer");
    return {
      clicked: Boolean(btn),
      hasViewer: Boolean(box),
      truncNote: (box?.querySelector(".exec-ref-viewer-trunc")?.textContent ?? "").trim(),
      lineCount: box?.querySelectorAll(".exec-ref-viewer-line").length ?? 0,
    };
  })()`);
  check("B6② 超长文件 ⇒ 显式写明「已截断」，且行数封顶（不是静默 slice）",
    longView?.hasViewer === true && /已截断/.test(longView?.truncNote ?? "") && longView?.lineCount === 1000,
    `truncNote=${longView?.truncNote} · lineCount=${longView?.lineCount}`);

  // B5：宿主能力**探得到** ⇒ 真去调宿主（实参是绝对路径），且**不**渲染查看器。
  await evalJs(`(() => { window.__TB_HOST_MODE__ = "sidebar"; return true; })()`);
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(REF_PATH)});
    if (!btn) return null;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  const hostResult = await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(REF_PATH)});
    const li = btn?.closest("li");
    return {
      openVia: btn?.dataset?.openVia ?? null,
      note: (li?.querySelector(".exec-ref-open-note")?.textContent ?? "").trim(),
      hasViewer: Boolean(li?.querySelector(".exec-ref-viewer")),
      calls: Array.isArray(window.__TB_OPEN_CALLS__) ? window.__TB_OPEN_CALLS__.slice() : [],
    };
  })()`);
  check("B5 宿主能力探得到 ⇒ 真去调宿主（实参是**绝对路径**），且**不**渲染查看器",
    hostResult?.openVia?.startsWith("host:") && hostResult?.hasViewer === false
      && hostResult?.calls?.length >= 2 && String(hostResult?.calls?.at(-1) ?? "").startsWith("/")
      && String(hostResult?.calls?.at(-1) ?? "").endsWith(REF_PATH),
    `openVia=${hostResult?.openVia} · calls=${JSON.stringify(hostResult?.calls)} · note=${hostResult?.note}`);

  // B9（第 2 轮返工 · 主路）：桩 betterSidebar ⇒ `openTab` 真被调，且**实参就是服务端回包的 absPath**。
  const sidebarResult = await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(REF_PATH)});
    const li = btn?.closest("li");
    return {
      openVia: btn?.dataset?.openVia ?? null,
      note: (li?.querySelector(".exec-ref-open-note")?.textContent ?? "").trim(),
      hasViewer: Boolean(li?.querySelector(".exec-ref-viewer")),
      seeds: Array.isArray(window.__TB_OPEN_SEEDS__) ? window.__TB_OPEN_SEEDS__ : [],
    };
  })()`);
  check("B9 主路＝DSH 侧边栏：openTab 真被调（path===服务端 absPath / type===\"editor\" / scope 有 sessionId）",
    sidebarResult?.seeds?.length === 1
      && sidebarResult.seeds[0]?.seed?.path === a1.body?.absPath
      && sidebarResult.seeds[0]?.seed?.type === "editor"
      && typeof sidebarResult.seeds[0]?.scope?.sessionId === "string"
      && sidebarResult.seeds[0].scope.sessionId.length > 0,
    `seeds=${JSON.stringify(sidebarResult?.seeds)} · 服务端 absPath=${a1.body?.absPath}`);
  check("B9① 界面**如实**写「已在 DSH 侧边栏打开 <文件名>」，且**不**渲染抽屉内查看器",
    /已在 DSH 侧边栏打开/.test(sidebarResult?.note ?? "") && /README\.md/.test(sidebarResult?.note ?? "")
      && sidebarResult?.hasViewer === false && String(sidebarResult?.openVia ?? "").startsWith("host:"),
    `note=${sidebarResult?.note} · openVia=${sidebarResult?.openVia} · hasViewer=${sidebarResult?.hasViewer}`);

  // B10（第 2 轮返工 · 兜底）：**没有** betterSidebar ⇒ 落抽屉内只读查看器，并**如实标注走了兜底**。
  await evalJs(`(() => { window.__TB_HOST_MODE__ = "fallback"; return true; })()`);
  const seedsBefore = await evalJs(`(() => (window.__TB_OPEN_SEEDS__ ?? []).length)()`);
  await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(REF_PATH)});
    if (!btn) return null;
    btn.click();
    return true;
  })()`);
  await sleep(1200);
  const fbResult = await evalJs(`(() => {
    const btn = [...document.querySelectorAll(".exec-record-refs button.exec-ref-open")]
      .find((b) => (b.dataset?.ref ?? "") === ${JSON.stringify(REF_PATH)});
    const li = btn?.closest("li");
    const box = li?.querySelector(".exec-ref-viewer");
    return {
      openVia: btn?.dataset?.openVia ?? null,
      note: (li?.querySelector(".exec-ref-open-note")?.textContent ?? "").trim(),
      hasViewer: Boolean(box),
      contentHasSeed: (box?.querySelector(".exec-ref-viewer-body")?.textContent ?? "").includes("这是种子内容"),
      seeds: (window.__TB_OPEN_SEEDS__ ?? []).length,
      errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? (b.textContent ?? "").trim() : null; })(),
    };
  })()`);
  check("B10 无 betterSidebar ⇒ 落抽屉内只读查看器，且**如实标注走了兜底**（不谎称已侧边栏打开）",
    fbResult?.hasViewer === true && fbResult?.contentHasSeed === true && fbResult?.openVia === "viewer"
      && /兜底/.test(fbResult?.note ?? "") && !/已在 DSH 侧边栏打开/.test(fbResult?.note ?? "")
      && fbResult?.seeds === seedsBefore && !fbResult?.errorBanner,
    `note=${fbResult?.note} · openVia=${fbResult?.openVia} · hasViewer=${fbResult?.hasViewer} · seeds ${seedsBefore}→${fbResult?.seeds}`);

  check("B7 `commit` 类引用**不是**按钮（git 对象不是文件，点击无意义）",
    d?.commitBtnCount === 0 && (d?.commitText ?? []).some((t) => /commit · deadbeef/.test(t)),
    `commitBtnCount=${d?.commitBtnCount} · texts=${JSON.stringify(d?.commitText)}`);
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  try { await cdp?.send("Browser.close", {}, null); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server?.close?.(); } catch { /* 忽略 */ }
  try { store.close(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, workspace, outsideDir, chromeProfile]) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);

// ---- 反证模式：把「本卡落地前的前端」当 WEB_DIR 跑一遍，必须转红 ≥3 条 -----------------
if (REVERSE) {
  console.log("\n=== 反证模式自检 ===");
  let oldWeb = null;
  try {
    oldWeb = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-oldweb-"));
    for (const file of ["app.js", "tokens.css", "index.html"]) {
      const content = execFileSync("git", ["show", `HEAD:web/${file}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
      await writeFile(path.join(oldWeb, file), content);
    }
    console.log(`… 反证 web 目录：${oldWeb}（HEAD:web/）`);
    const child = spawn(process.execPath, [path.join(ROOT, "tools", "bench-evidence-ref-open.mjs")], {
      cwd: ROOT,
      env: { ...process.env, TB_BENCH_WEB_DIR: oldWeb, TB_BENCH_REVERSE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    const code = await new Promise((resolve) => child.on("close", resolve));
    const m = /=== 结果：(\d+)\/(\d+) PASS/.exec(out);
    const pass = m ? Number(m[1]) : -1;
    const total = m ? Number(m[2]) : -1;
    const red = total - pass;
    console.log(`反证读数：旧 web ⇒ ${pass}/${total} PASS · ${red} 条转红 · 子进程退出码 ${code}`);
    console.log(red >= 3 ? "PASS  反证成立（≥3 条转红）" : `FAIL  反证不成立：只红了 ${red} 条（应 ≥3）`);
    if (red < 3) process.exit(1);
  } catch (error) {
    console.log(`FAIL  反证模式自检未跑通：${error?.message ?? error}`);
    process.exit(1);
  } finally {
    if (oldWeb) { try { await rm(oldWeb, { recursive: true, force: true }); } catch { /* 忽略 */ } }
  }
}

clearTimeout(watchdog);
// ════════════════════════════════════════════════════════════════════════════
// C 段（**可选** · `TB_BENCH_REAL_HOST=1`）：隔离**真 dsh 宿主**里的能力探测读数
// ════════════════════════════════════════════════════════════════════════════
// 验收①要的是「宿主能力探测**打印真实 key 列表**」。台内用替身只能证明「逻辑对」，
// 证明不了「真宿主的这三个服务上到底有没有打开文件的方法」。
// 这一段用**隔离真 dsh**（临时 `DSH_HOME` + 临时 profile + 随机端口 + 独立进程）取真读数：
//   · **服务端**（`index.js` 的 `hostSessionPort`）：`/api/health` 的 `host.capabilities.openFile`
//     ＋ `/api/host/probe` 的 `probe.openFile.probed`（**真实 key 列表**）；
//   · **客户端**（`lib/client.js`）：真 headless Chrome 打开 DSH web 页面，读
//     `window.__TB_PLUGIN__.openFileProbe`（**真实 key 列表**）。
// **不碰用户的 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（AGENTS.md §3 豁免范围）。
if (process.env.TB_BENCH_REAL_HOST === "1") {
  console.log("\n=== C 段：隔离真 dsh 宿主的能力探测读数（TB_BENCH_REAL_HOST=1）===");
  const dshBin = spawnSync("bash", ["-lc", "command -v dsh"], { encoding: "utf8" }).stdout.trim();
  const dshVersion = dshBin ? spawnSync("dsh", ["--version"], { encoding: "utf8" }).stdout.trim() : "";
  const dshReal = dshBin ? spawnSync("node", ["-e", `console.log(require("node:fs").realpathSync(${JSON.stringify(dshBin)}))`], { encoding: "utf8" }).stdout.trim() : "";
  const globalNm = dshReal ? path.resolve(path.dirname(dshReal), "..", "node_modules", "@deepseek-ai") : "";
  const missing = ["dsh-base", "dsh-web-app"].filter((n) => !dshReal || !existsSync(path.join(globalNm, n)));
  if (!dshBin || missing.length) {
    console.log(`SKIP  环境不具备（找不到 dsh 或全局 bundle ${missing.join("/")}）—— 本段不产证据，不计入退出码`);
  } else {
    const iso = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-real-"));
    const isoProfile = path.join(iso, "profiles", "iso");
    const isoLog = path.join(iso, "dsh.log");
    const isoChromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-refopen-realchrome-"));
    let isoChild = null;
    let isoBrowser = null;
    try {
      await mkdir(path.join(isoProfile, "node_modules", "@deepseek-ai"), { recursive: true });
      for (const n of ["dsh-base", "dsh-web-app"]) await symlink(path.join(globalNm, n), path.join(isoProfile, "node_modules", "@deepseek-ai", n), "dir");
      await symlink(ROOT, path.join(isoProfile, "node_modules", "taskboard-workbench"), "dir");
      await writeFile(path.join(isoProfile, "package.json"), JSON.stringify({
        name: "dsh-profile-bench-refopen",
        private: true,
        dependencies: {
          "@deepseek-ai/dsh-base": "0.2.0-rc.2",
          "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
          "taskboard-workbench": `link:${ROOT}`,
        },
        dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "taskboard-workbench"] } },
      }, null, 2));
      await mkdir(path.join(iso, "tbdata"), { recursive: true });
      await mkdir(path.join(iso, "tbws"), { recursive: true });
      const isoPort = await freePort();
      await writeFile(isoLog, "");
      isoChild = spawn(dshBin, ["--profile", "iso", "--no-open", "--port", String(isoPort)], {
        cwd: iso,
        env: { ...process.env, DSH_HOME: iso, TB_DATA_DIR: path.join(iso, "tbdata") },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      const sink = (buf) => writeFile(isoLog, String(buf), { flag: "a" });
      isoChild.stdout.on("data", sink);
      isoChild.stderr.on("data", sink);
      let booted = null;
      for (let i = 0; i < 60; i += 1) {
        const txt = existsSync(isoLog) ? readFileSync(isoLog, "utf8") : "";
        const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(txt);
        if (m) { booted = { port: Number(m[1]), token: m[2], log: txt }; break; }
        await sleep(1000);
      }
      if (!booted) {
        console.log("SKIP  隔离真 dsh 60s 内未起来 —— 本段不产证据，不计入退出码");
      } else {
        const isoBase = `http://127.0.0.1:${booted.port}`;
        const hs = await fetch(`${isoBase}/?token=${booted.token}`, { redirect: "manual" });
        const setC = typeof hs.headers.getSetCookie === "function" ? hs.headers.getSetCookie() : [hs.headers.get("set-cookie")].filter(Boolean);
        const cookie = setC.map((c) => /(dsh-auth-[^=]+)=([^;]+)/.exec(c ?? "")).find(Boolean)?.slice(1).join("=");
        const apiBase = `${isoBase}/integrations/taskboard-workbench/api`;
        const get = async (p) => {
          const r = await fetch(apiBase + p, { headers: { cookie } });
          return { code: r.status, body: await r.json().catch(() => null) };
        };
        check("C1 隔离真 dsh 起来且插件激活（临时 DSH_HOME，不碰用户实例）",
          /\[taskboard-workbench\] host ready:/.test(booted.log),
          `dsh=${dshVersion} · ${(booted.log.split("\n").find((l) => l.includes("host ready")) ?? "(无 host ready 行)").slice(0, 90)}`);

        const health = await get("/health");
        const probe = await get("/host/probe");
        const probed = probe.body?.probe?.openFile?.probed ?? null;
        const verdict = probe.body?.probe?.openFile?.verdict ?? null;
        check("C2 服务端探测**打印了真实 key 列表**（三个候选服务逐个列出）",
          Array.isArray(probed) && probed.length === 3
            && probed.every((p) => Array.isArray(p.keys) && typeof p.present === "boolean"),
          JSON.stringify(probed));
        const serverFound = Array.isArray(probed) && probed.some((p) => p.openFileMethod);
        check("C3 服务端能力位与探测结论**一致**（探到就是 true，没探到就是 false —— 不臆造成功）",
          health.body?.host?.capabilities?.openFile === serverFound
          && (serverFound ? verdict === "open-file-available" : verdict === "open-file-unavailable"),
          `capabilities.openFile=${health.body?.host?.capabilities?.openFile} · verdict=${verdict} · 探到方法=${serverFound}`);
        // 「列 key」这件事本身也要被验：**present=true 却 keys=[]** ⇒ 枚举器坏了（不是「服务没方法」）。
        const presentButEmpty = (Array.isArray(probed) ? probed : []).filter((p) => p.present && (!Array.isArray(p.keys) || p.keys.length === 0));
        check("C4 枚举器真的枚举了：**present 的服务必有非空 key 列表**（否则说明 key 列表是假的）",
          presentButEmpty.length === 0,
          `presentButEmpty=${JSON.stringify(presentButEmpty.map((p) => p.service))} · 真实 key 列表=${JSON.stringify((probed ?? []).map((p) => ({ service: p.service, present: p.present, keyCount: p.keys?.length ?? -1, openFileMethod: p.openFileMethod })))}`);

        // 客户端侧：真 headless Chrome 打开 DSH web 页面 → 读 `window.__TB_PLUGIN__.openFileProbe`。
        let clientProbe = null;
        try {
          isoBrowser = await launchChrome(isoChromeProfile);
          await isoBrowser.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
          await isoBrowser.cdp.send("Page.navigate", { url: `${isoBase}/?token=${booted.token}` });
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            clientProbe = await isoBrowser.evalJs(`(() => window.__TB_PLUGIN__?.openFileProbe ?? null)()`).catch(() => null);
            if (clientProbe) break;
            await sleep(1000);
          }
        } catch (error) {
          clientProbe = null;
          console.log(`      （客户端侧没取到：${error?.message ?? error}）`);
        }
        check("C5 客户端探测**打印了真实 key 列表**（`window.__TB_PLUGIN__.openFileProbe`）",
          Boolean(clientProbe?.betterSidebar) && Array.isArray(clientProbe?.betterSidebar?.keys)
            && typeof clientProbe?.betterSidebar?.present === "boolean"
            && Array.isArray(clientProbe?.hostServices) && clientProbe.hostServices.length === 3
            && clientProbe.hostServices.every((p) => Array.isArray(p.keys) && typeof p.present === "boolean"),
          JSON.stringify(clientProbe));
        const clientFound = Boolean(clientProbe?.betterSidebar?.present) && clientProbe?.betterSidebar?.hasOpenTab === true;
        const clientPresentButEmpty = [
          ...(clientProbe?.hostServices ?? []),
          ...(clientProbe?.betterSidebar?.present ? [{ service: "betterSidebar", keys: clientProbe?.betterSidebar?.keys ?? [] }] : []),
        ].filter((p) => p.present && (!Array.isArray(p.keys) || p.keys.length === 0));
        check("C6 客户端探测同样**如实**（present 的服务必有非空 key 列表）",
          Boolean(clientProbe?.betterSidebar) && Array.isArray(clientProbe?.hostServices)
            && clientProbe.hostServices.length === 3 && clientPresentButEmpty.length === 0,
          `真实 key 列表=${JSON.stringify({ betterSidebar: { present: clientProbe?.betterSidebar?.present, keyCount: clientProbe?.betterSidebar?.keys?.length ?? -1, hasOpenTab: clientProbe?.betterSidebar?.hasOpenTab }, hostServices: (clientProbe?.hostServices ?? []).map((p) => ({ service: p.service, present: p.present, keyCount: p.keys?.length ?? -1, openFileMethod: p.openFileMethod })) })}`);
        console.log(`      真机实际走向：${clientFound ? "DSH 侧边栏插件（betterSidebar.openTab）" : serverFound ? "服务端宿主打开（探到方法）" : "抽屉内只读查看器（兜底）—— 侧边栏与宿主服务都没探到打开文件能力"}`);
      }
    } catch (error) {
      console.log(`SKIP  C 段未跑通（${error?.message ?? error}）—— 不计入退出码`);
    } finally {
      try { await isoBrowser?.close?.(); } catch { /* ignore */ }
      try { if (isoChild?.pid) process.kill(-isoChild.pid, "SIGKILL"); } catch { /* ignore */ }
      try { if (isoChild?.pid) process.kill(isoChild.pid, "SIGKILL"); } catch { /* ignore */ }
      for (const dir of [iso, isoChromeProfile]) { try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
    }
  }
}

process.exit(failed.length ? 1 : 0);
