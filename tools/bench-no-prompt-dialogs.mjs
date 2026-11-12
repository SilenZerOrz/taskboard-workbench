/**
 * 「宿主不支持 window.prompt」四处取值出口 —— **真实浏览器验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-242` / 需求 `R176`）
 * 真机 2026-11-12：DSH 内嵌宿主（Electron / 受限 webview）**不实现浏览器原生 `prompt()`**，
 * 调用即抛 `prompt() is not supported`。于是四个「要向人取值」的出口从可用变成**直接报错**：
 *   ① 新建项目（工具栏 / 会话绑定门）② 推进清单「返工」的返工说明
 *   ③ 推进清单「给结论」的人工结论 ④ 配置页「新建需求条目」的标题
 *
 * `-240` 已把取值统一改走页面内 `<dialog>`（`askFields()` / `askNewProject()`），但**只交了源码门**：
 * `tests/no-prompt.test.mjs` 读的是源码字符串，它能证明「web/ 里不再有 `window.prompt(` 调用」，
 * 证明不了**渲染后点下去真的弹出对话框、真的能建、取消真的不发请求** —— 而「改完仍然报错」的
 * 常见形态正是：源码看着对、对话框在真实宿主里出不来（`showModal()` 抛错 / 被别的层盖住 /
 * 表单 submit 没派发导致点「确定」毫无反应）。本台补的正是这一段。
 *
 * ## 本台断言什么（把「直接报错」反过来钉住）
 *   A. 工具栏「新建项目」⇒ 弹出页面内 `<dialog>`（标题/字段/按钮对得上）；**空名称被本地拦下**
 *      （对话框不关闭、提示改写成必填原因）；填名称提交 ⇒ 项目真建出来。
 *   A2. 取消路径**零副作用**：点「取消」⇒ 不建项目（项目数不变、无「已新建」横幅）。
 *   B. 推进清单「返工」⇒ 弹出带**多行说明框**的对话框；填说明提交 ⇒ 该卡真收到 `changes` 决定。
 *   C. 推进清单「给结论」⇒ 弹出结论对话框；**空结论被本地拦下**；填结论提交 ⇒ 决定真落库。
 *   D. 配置页「新建需求条目」⇒ 弹出标题对话框；**空标题被拦下**；填标题提交 ⇒ 条目真落库。
 *   E. **运行时哨兵**：本台在页面脚本里把 `window.prompt` 换成「计数 + 抛错」的替身 ——
 *      四处走完 `__PROMPT_CALLS__ === 0` 才算过。这条比源码门强：它读的是**真的没调用**，
 *      而不是「源码里没有那个字符串」（源码门挡不住 `window["prompt"]` 之类的写法）。
 *   F. 全程无未捕获脚本错误、无 error 横幅（「直接报错」的字面判据）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=<旧版 web 副本> node tools/bench-no-prompt-dialogs.mjs`
 *   —— 拷一份 `web/`，把四处换回 `window.prompt(...)`（或直接取 `git show HEAD~:web/app.js`）⇒
 *   对话框不出现、哨兵计数 > 0、`prompt() is not supported` 进 `__PAGE_ERRORS__` ⇒ A/B/C/D/E/F 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑；`CODEX_SANDBOX` 有值时自检跳过。
 *
 * 运行：`node tools/bench-no-prompt-dialogs.mjs`
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

/**
 * 页面脚本里先于 `app.js` 安装的哨兵 —— **等价复刻宿主环境**：
 * 原生 `prompt` 被换成「计数一次 + 抛 `prompt() is not supported`」的替身。
 * 只要任一处还在用 prompt，本台就能同时拿到「调用次数 > 0」与一条未捕获错误。
 */
const SENTINEL = `(() => {
  window.__PROMPT_CALLS__ = 0;
  window.__PAGE_ERRORS__ = [];
  const record = (msg) => { try { window.__PAGE_ERRORS__.push(String(msg)); } catch (e) { /* ignore */ } };
  window.addEventListener("error", (e) => record((e && (e.message || (e.error && e.error.message))) || "error"));
  window.addEventListener("unhandledrejection", (e) => record((e && e.reason && (e.reason.message || e.reason)) || "unhandledrejection"));
  try {
    Object.defineProperty(window, "prompt", {
      configurable: true,
      writable: true,
      value: function prompt() { window.__PROMPT_CALLS__ += 1; throw new Error("prompt() is not supported"); },
    });
  } catch (e) { record("sentinel-install-failed: " + e.message); }
})();`;

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;

try {
  // ---- 隔离服务：临时 dataDir + 随机端口，真 `web/` ----
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-noprompt-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-noprompt-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目", workspacePath: dataDir });
  const req = store.createRequirementItem({ projectId: "default", title: "验证台需求（四处取值出口）" });
  // ① 待评审卡 ⇒ 推进清单里给「返工」（changes）
  const reviewTask = store.createTask({ projectId: "default", title: "验证台-待评审卡（返工入口）", description: "bench", status: "todo" });
  store.updateTask(reviewTask.identifier, { status: "in_review", actor: "agent", expectedVersion: reviewTask.version });
  // ② 人工校验待结论卡 ⇒ 推进清单里给「给结论」（choose）
  const hrTask = store.createHumanReviewTask({
    projectId: "default",
    requirementId: req.identifier,
    draft: {
      category: "requirement-drift",
      title: "【人工校验】需求异化 · 验证台人工结论入口",
      description: "bench：只为驱动「给结论」取值出口",
      evidence: [{ summary: "bench evidence" }],
      candidateActions: [{ id: "continue", label: "按当前需求继续" }],
      blockBoundary: "仅本卡，不影响其它任务",
    },
    actor: "agent",
  });

  server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;
  console.log(`… 台内服务 ${base} · dataDir=${dataDir} · webDir=${WEB_DIR}`);
  console.log(`… 种子：待评审卡 #${reviewTask.identifier}（返工）· 人工校验卡 #${hrTask.identifier}（给结论）· 条目 ${req.identifier}`);

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
  const waitFor = async (expr, { timeout = 8000, interval = 120 } = {}) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evalJs(expr);
      if (v) return v;
      if (Date.now() - t0 > timeout) return null;
      await sleep(interval);
    }
  };

  // ---- 就绪：哨兵先装（必须早于 app.js 执行），再导航 ----
  await S("Page.addScriptToEvaluateOnNewDocument", { source: SENTINEL });
  await S("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: `${base}/` });
  const booted = await waitFor(`document.querySelectorAll(".board-col, .toolbar").length > 0`, { timeout: 20000 });
  if (!booted) { console.log("SKIP  页面未 boot 起来（首屏没有 toolbar/看板）——本台不产证据，退出码 2"); process.exit(2); }
  await sleep(600);

  // ---- 页面侧小工具（都按**渲染后的 DOM** 读，不读源码） ----
  /** 当前打开的那个 askFields 对话框（用 `form .dialog-actions` 与「新建任务」对话框区分）。 */
  const askDialogExpr = `(() => {
    const d = [...document.querySelectorAll("dialog")].find((x) => x.open && x.querySelector("form .dialog-actions"));
    if (!d) return null;
    const controls = [...d.querySelectorAll("input, textarea")];
    return {
      title: (d.querySelector("h2")?.textContent ?? "").trim(),
      hint: (d.querySelector("p.hint")?.textContent ?? "").trim(),
      fields: controls.map((c) => ({ tag: c.tagName.toLowerCase(), placeholder: c.placeholder ?? "", rows: c.rows ?? null })),
      buttons: [...d.querySelectorAll(".dialog-actions button")].map((b) => b.textContent.trim()),
      modal: typeof d.matches === "function" ? d.matches(":modal") : null,
    };
  })()`;
  const openAsk = () => evalJs(askDialogExpr);
  const waitAsk = (ms = 6000) => waitFor(askDialogExpr, { timeout: ms });
  const waitAskGone = (ms = 8000) => waitFor(`!(${askDialogExpr})`, { timeout: ms });
  const fillAsk = (index, value) => evalJs(`(() => {
    const d = [...document.querySelectorAll("dialog")].find((x) => x.open && x.querySelector("form .dialog-actions"));
    if (!d) return "no-dialog";
    const c = [...d.querySelectorAll("input, textarea")][${index}];
    if (!c) return "no-field";
    c.value = ${JSON.stringify(value)};
    c.dispatchEvent(new Event("input", { bubbles: true }));
    return c.value;
  })()`);
  const clickAskButton = (variant) => evalJs(`(() => {
    const d = [...document.querySelectorAll("dialog")].find((x) => x.open && x.querySelector("form .dialog-actions"));
    if (!d) return "no-dialog";
    const b = d.querySelector(".dialog-actions .${variant}");
    if (!b) return "no-button";
    b.click();
    return "clicked";
  })()`);
  const banner = () => evalJs(`(() => { const b = document.querySelector(".banner"); return b && !b.hidden ? b.textContent.trim() : ""; })()`);
  const clickHeader = (text) => evalJs(`(() => {
    const b = [...document.querySelectorAll("header button")].find((n) => n.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return "no-btn";
    b.click();
    return "clicked";
  })()`);
  const projectCount = () => evalJs(`fetch("/api/projects").then((r) => r.json()).then((j) => (j.projects ?? []).length)`);
  const requirementCount = () => evalJs(`fetch("/api/requirements/items?project=default").then((r) => r.json()).then((j) => (j.items ?? j.count ?? j).length ?? 0)`);
  const promptCalls = () => evalJs(`window.__PROMPT_CALLS__ ?? -1`);
  const pageErrors = () => evalJs(`window.__PAGE_ERRORS__ ?? []`);

  // ================================================================ A 新建项目（工具栏）
  const projectsBefore = await projectCount();
  const clickedNewProject = await evalJs(`(() => {
    const b = [...document.querySelectorAll(".toolbar button")].find((n) => n.textContent.trim() === "新建项目");
    if (!b) return "no-btn";
    b.click();
    return "clicked";
  })()`);
  const dlgA = await waitAsk();
  check("A0 工具栏「新建项目」可点", clickedNewProject === "clicked", clickedNewProject);
  check("A1 点「新建项目」弹出**页面内** dialog（标题/两字段/两按钮/真模态）",
    Boolean(dlgA)
      && dlgA.title === "新建项目"
      && dlgA.fields.length === 2
      && dlgA.modal === true
      && dlgA.buttons.join("/") === "取消/创建",
    dlgA ? `title=${dlgA.title} · fields=${dlgA.fields.map((f) => f.tag).join(",")} · buttons=${dlgA.buttons.join("/")} · modal=${dlgA.modal}` : "没有弹出 dialog（旧实现此时抛 prompt() is not supported）");

  // A2 必填本地校验：空名称提交 ⇒ 对话框**不关闭**且提示改写成必填原因
  await clickAskButton("primary");
  await sleep(300);
  const dlgA2 = await openAsk();
  check("A2 空名称提交被**本地**拦下（对话框不关闭、提示改写为必填原因）",
    Boolean(dlgA2) && /不能为空/.test(dlgA2.hint),
    dlgA2 ? `hint=${dlgA2.hint}` : "对话框被关掉了（应留在原地等人补名称）");

  // A3 填名称 ⇒ 真建项目
  const NEW_PROJECT_NAME = "验证台-新建项目（dialog）";
  await fillAsk(0, NEW_PROJECT_NAME);
  await clickAskButton("primary");
  const goneA3 = await waitAskGone();
  const createdProject = await waitFor(`fetch("/api/projects").then((r) => r.json()).then((j) => (j.projects ?? []).find((p) => String(p.name ?? "") === ${JSON.stringify(NEW_PROJECT_NAME)})?.id ?? null)`, { timeout: 8000 });
  const projectsAfter = await projectCount();
  check("A3 填名称提交 ⇒ 项目**真落库**（dialog 关闭 + 库里按名称查得到 + 项目数 +1）",
    Boolean(goneA3) && Boolean(createdProject) && projectsAfter === projectsBefore + 1,
    `新建 id=${createdProject ?? "(没建出来)"} · 项目数 ${projectsBefore}→${projectsAfter}`);

  // A4 取消路径零副作用（判据用**库里的真值**，不看横幅 —— 横幅 5s 自动收起，读数会被时序污染）
  const CANCEL_NAME = "验证台-不该被创建的项目";
  await evalJs(`(() => {
    const b = [...document.querySelectorAll(".toolbar button")].find((n) => n.textContent.trim() === "新建项目");
    if (b) b.click();
    return true;
  })()`);
  const dlgA4 = await waitAsk();
  await fillAsk(0, CANCEL_NAME);
  await clickAskButton("ghost");
  const goneA4 = await waitAskGone();
  await sleep(500);
  const projectsAfterCancel = await projectCount();
  const cancelNameLanded = await evalJs(`fetch("/api/projects").then((r) => r.json()).then((j) => (j.projects ?? []).some((p) => String(p.name ?? "") === ${JSON.stringify(CANCEL_NAME)}))`);
  check("A4 取消 = 零副作用（dialog 关闭、项目数不变、取消掉的名称没有落库）",
    Boolean(dlgA4) && Boolean(goneA4) && projectsAfterCancel === projectsAfter && cancelNameLanded === false,
    `dialog关闭=${Boolean(goneA4)} · 项目数 ${projectsAfter}→${projectsAfterCancel} · 「${CANCEL_NAME}」落库=${cancelNameLanded}`);

  // 回到种子项目（A3 建项目会切走当前项目，后面三处种子都在 default 上）
  const switchedBack = await evalJs(`(() => {
    const sel = [...document.querySelectorAll(".toolbar select")].find((s) => s.getAttribute("aria-label") === "选择项目");
    if (!sel) return "no-select";
    if (![...sel.options].some((o) => o.value === "default")) return "no-option";
    sel.value = "default";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return sel.value;
  })()`);
  if (switchedBack !== "default") throw new Error(`切回种子项目失败：${switchedBack}`);
  await sleep(1200);

  // ================================================================ B 返工说明（推进清单）
  await clickHeader("推进");
  const advanceReady = await waitFor(`document.querySelectorAll(".advance-row[data-task-ref]").length > 0`, { timeout: 12000 });
  const waitAdvanceRow = (ref, label) => waitFor(`(() => {
    const row = [...document.querySelectorAll(".advance-row[data-task-ref]")].find((r) => r.dataset.taskRef === ${JSON.stringify(ref)});
    if (!row) return null;
    return [...row.querySelectorAll("button")].some((x) => x.textContent.trim() === ${JSON.stringify(label)}) ? true : null;
  })()`, { timeout: 10000 });
  const clickAdvanceAction = (ref, label) => evalJs(`(() => {
    const row = [...document.querySelectorAll(".advance-row[data-task-ref]")].find((r) => r.dataset.taskRef === ${JSON.stringify(ref)});
    if (!row) return "no-row";
    const b = [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return "no-btn";
    b.click();
    return "clicked";
  })()`);
  check("B0 推进清单渲染出待办行（返工 / 给结论两条入口在内）", Boolean(advanceReady), `rows=${advanceReady ?? 0}`);

  const clickedRework = await clickAdvanceAction(reviewTask.identifier, "返工");
  const dlgB = await waitAsk();
  check("B1 「返工」弹出带**多行**说明框的 dialog（可留空 ≠ 必填）",
    clickedRework === "clicked"
      && Boolean(dlgB)
      && dlgB.title.includes("返工说明")
      && dlgB.fields.length === 1
      && dlgB.fields[0].tag === "textarea"
      && dlgB.buttons.join("/") === "取消/提交返工",
    dlgB ? `title=${dlgB.title} · fields=${dlgB.fields.map((f) => `${f.tag}(rows=${f.rows})`).join(",")} · buttons=${dlgB.buttons.join("/")}` : `没有弹出 dialog（click=${clickedRework}）`);

  await fillAsk(0, "验证台：把验收第 2 条拆成可复核命令");
  await clickAskButton("primary");
  const goneB = await waitAskGone();
  // 等**这一条**的横幅（上一条的「已处理」可能还在 5s 生命期内，按 ref 精确匹配才不会被旧文案骗过）
  const bannerB = await waitFor(`(() => { const b = document.querySelector(".banner"); const t = b && !b.hidden ? b.textContent.trim() : ""; return t.includes(${JSON.stringify(reviewTask.identifier)}) ? t : null; })()`, { timeout: 8000 });
  check("B2 返工说明提交 ⇒ 决定真落库（dialog 关闭 + 「已处理 #卡（changes）」）",
    Boolean(goneB) && Boolean(bannerB) && String(bannerB).includes(reviewTask.identifier),
    `banner=${bannerB || "(无)"}`);

  // ================================================================ C 人工结论（推进清单）
  // 决定回写会重画整张清单（异步），先等这一行连同「给结论」按钮一起回来再点。
  const chooseRowReady = await waitAdvanceRow(hrTask.identifier, "给结论");
  const clickedChoose = chooseRowReady ? await clickAdvanceAction(hrTask.identifier, "给结论") : "no-row";
  const dlgC = await waitAsk();
  check("C1 「给结论」弹出结论 dialog（单行、必填、按钮对得上）",
    clickedChoose === "clicked"
      && Boolean(dlgC)
      && dlgC.title.includes("的结论")
      && dlgC.fields.length === 1
      && dlgC.fields[0].tag === "input"
      && dlgC.buttons.join("/") === "取消/提交结论",
    dlgC ? `title=${dlgC.title} · fields=${dlgC.fields.map((f) => f.tag).join(",")} · buttons=${dlgC.buttons.join("/")}` : `没有弹出 dialog（click=${clickedChoose}）`);

  await clickAskButton("primary");
  await sleep(300);
  const dlgC2 = await openAsk();
  check("C2 空结论提交被**本地**拦下（对话框不关闭、提示「结论不能为空」）",
    Boolean(dlgC2) && /不能为空/.test(dlgC2.hint),
    dlgC2 ? `hint=${dlgC2.hint}` : "对话框被关掉了（应留在原地等人写结论）");

  const CONCLUSION = "同意按子任务 B 执行，上游不变更";
  await fillAsk(0, CONCLUSION);
  await clickAskButton("primary");
  const goneC = await waitAskGone();
  const bannerC = await waitFor(`(() => { const b = document.querySelector(".banner"); const t = b && !b.hidden ? b.textContent.trim() : ""; return t.includes(${JSON.stringify(hrTask.identifier)}) ? t : null; })()`, { timeout: 8000 });
  check("C3 人工结论提交 ⇒ 决定真落库（dialog 关闭 + 「已处理 #卡」+ 结论原文可见）",
    Boolean(goneC) && Boolean(bannerC) && String(bannerC).includes(hrTask.identifier) && String(bannerC).includes(CONCLUSION),
    `banner=${bannerC || "(无)"}`);

  // ================================================================ D 需求条目标题（配置页）
  const reqBefore = await requirementCount();
  await clickHeader("配置");
  const configReady = await waitFor(`document.querySelectorAll(".config-row").length > 0`, { timeout: 12000 });
  const clickedNewReq = await evalJs(`(() => {
    const row = [...document.querySelectorAll(".config-row")].find((r) => r.textContent.includes("新建需求条目"));
    if (!row) return "no-row";
    const b = [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === "新建");
    if (!b) return "no-btn";
    b.click();
    return "clicked";
  })()`);
  const dlgD = await waitAsk();
  check("D1 配置页「新建需求条目」弹出标题 dialog（必填、按钮对得上）",
    Boolean(configReady)
      && clickedNewReq === "clicked"
      && Boolean(dlgD)
      && dlgD.title === "新建需求条目"
      && dlgD.fields.length === 1
      && dlgD.buttons.join("/") === "取消/创建",
    `configRows=${Boolean(configReady)} · click=${clickedNewReq} · ` + (dlgD ? `title=${dlgD.title} · buttons=${dlgD.buttons.join("/")}` : "没有弹出 dialog"));

  await clickAskButton("primary");
  await sleep(300);
  const dlgD2 = await openAsk();
  check("D2 空标题提交被**本地**拦下（对话框不关闭、提示不能为空）",
    Boolean(dlgD2) && /不能为空/.test(dlgD2.hint),
    dlgD2 ? `hint=${dlgD2.hint}` : "对话框被关掉了（应留在原地等人填标题）");

  await fillAsk(0, "验证台-由 dialog 建出的需求条目");
  await clickAskButton("primary");
  const goneD = await waitAskGone();
  await sleep(600);
  const reqAfter = await requirementCount();
  check("D3 填标题提交 ⇒ 需求条目**真落库**（dialog 关闭 + 条目数 +1）",
    Boolean(goneD) && reqAfter === reqBefore + 1,
    `条目数 ${reqBefore}→${reqAfter}`);

  // ================================================================ E/F 运行时哨兵 + 无报错
  const calls = await promptCalls();
  check("E 全程 `window.prompt` **零调用**（哨兵计数；宿主里它就是抛错的那个）", calls === 0, `__PROMPT_CALLS__=${calls}`);

  const errors = await pageErrors();
  const bannerNow = await banner();
  check("F 全程无未捕获脚本错误、无 error 横幅（「直接报错」的字面判据）",
    Array.isArray(errors) && errors.length === 0 && !/失败|错误/.test(bannerNow),
    `errors=${JSON.stringify(errors)} · banner=${bannerNow || "(无)"}`);

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
