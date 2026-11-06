/**
 * 需求条目面板「工具区布局」—— **真实浏览器几何验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-225` / 需求 `R166`）
 * 真机批注（2026-11-05，需求页「需求条目」面板）：「条目搜索标题、状态筛选框、搜索输入框等
 * 同类输入框&按钮，都挤在左侧不够美观，请进行优化」。
 *
 * 实证：三段（新建 / 筛选 / 批量）原本都用同一个全局 `.field-inline`（`align-items: flex-end`）：
 *   · 输入框宽度由 UA 默认值决定，按钮紧跟其后 ⇒ 左侧一坨，右侧空一大片；
 *   · 「下一步」长提示被单独塞成一行，与左侧控件没有任何视觉关系；
 *   · 批量行六个元素从左往右平铺，蓝色主按钮夹在中间、危险操作紧挨主按钮。
 *
 * 这类缺陷**不报错、不进日志**，单测只能断言"类名在不在"，证明不了渲染后**对齐/宽度/右边缘**。
 * 所以必须有这台：真渲染后读几何。
 *
 * ## 本台断言什么（读渲染后的 DOM 与几何，不读源码）
 *   A. 三段结构在位：`.req-toolbar` 内两行（新建 / 筛选），`.req-toolbar` 与 `.req-bulk-bar` 都**不再**是 `.field-inline`；
 *   B. 两行首个控件的**左边缘对齐**（|Δx| ≤ 1px）——「同类输入框在同一列起头」；
 *   C. 新建输入宽 **200–420px**，且与「新建条目」按钮的间距 **≤ 12px**；
 *   D. 宽视口下「下一步」提示的**右边缘**与面板内容右边缘对齐（≤ 8px）；
 *   E. 批量动作组整体**右对齐**（≤ 8px），且「批量删除」是 `danger` 档（不与主按钮同色）；
 *   F. 面板**无横向溢出**（`scrollWidth ≤ clientWidth + 1`）；
 *   G. 输入 / 下拉 / 按钮**同高**（高度集合只有一个值，容差 1px）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-req-toolbar.mjs`
 *   —— 拷一份旧 `web/` ⇒ B / C / D / E / F 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`），
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-req-toolbar.mjs`。
 *
 * 运行：`node tools/bench-req-toolbar.mjs`
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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqtoolbar-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-reqtoolbar-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
const doc = store.ensureRequirementDoc("default", { body: "# 需求\n\n## R1 工具区布局\n" });
for (const [i, status] of [["1", "draft"], ["2", "open"], ["3", "done"], ["4", "closed"]]) {
  store.createRequirementItem({ projectId: "default", title: `布局验证条目 ${i}（${status}）`, status, docId: doc.id, acceptance: "台内验收" });
}

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
    "--window-size=1600,1100",
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
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...VIEW, deviceScaleFactor: 1, mobile: false });

  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`JS 异常：${r.exceptionDetails.text ?? ""}`);
    return r.result?.value;
  };

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

  const opened = await waitFor(async () => {
    const r = await evalJs(`(() => {
      const b = [...document.querySelectorAll("header button")].find((n) => n.textContent.trim() === "需求");
      if (!b) return { ok: false, note: "no 需求 button" };
      b.click();
      return { ok: true };
    })()`);
    if (!r.ok) return r;
    await sleep(700);
    const rows = await evalJs(`document.querySelectorAll(".req-list .req-item").length`);
    return { ok: rows >= 4, rows };
  }, 25000, "需求视图出条目");
  check("A0 需求视图渲染出条目（种子 4 条）", opened.ok, `rows=${opened.rows ?? "?"}`);

  const geo = await evalJs(`(() => {
    const px = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;
    const rect = (n) => (n ? n.getBoundingClientRect() : null);
    const toolbar = document.querySelector(".req-toolbar");
    const rows = toolbar ? [...toolbar.querySelectorAll(".req-toolbar-row")] : [];
    const createRow = document.querySelector(".req-toolbar-create");
    const filterRow = document.querySelector(".req-toolbar-filter");
    const input = createRow?.querySelector("input[type=text], input[type=search]") ?? null;
    const createBtn = createRow?.querySelector("button") ?? null;
    const select = filterRow?.querySelector("select") ?? null;
    const search = filterRow?.querySelector("input[type=search], input[type=text]") ?? null;
    const hint = document.querySelector(".req-toolbar-hint");
    const bulk = document.querySelector(".req-bulk-bar");
    const bulkActions = document.querySelector(".req-bulk-actions");
    const bulkBtns = bulkActions ? [...bulkActions.querySelectorAll("button")] : [];
    const deleteBtn = bulkBtns.find((b) => /批量删除/.test(b.textContent ?? "")) ?? null;
    const body = document.querySelector(".req-stack .panel:nth-of-type(2) .panel-body")
      ?? document.querySelectorAll(".req-stack .panel-body")[1]
      ?? null;
    const bodyCs = body ? getComputedStyle(body) : null;
    const bodyRight = body ? px(rect(body).right - (parseFloat(bodyCs.paddingRight) || 0)) : null;
    const heights = [input, select, createBtn, search, bulkBtns[0]].filter(Boolean).map((n) => Math.round(rect(n).height));
    return {
      hasToolbar: !!toolbar,
      rowCount: rows.length,
      toolbarIsFieldInline: !!document.querySelector(".req-toolbar.field-inline"),
      bulkIsFieldInline: !!document.querySelector(".req-bulk-bar.field-inline"),
      createEl: !!createRow, filterEl: !!filterRow,
      leftCreate: createRow ? px(rect(createRow.firstElementChild).left) : null,
      leftFilter: filterRow ? px(rect(filterRow.firstElementChild).left) : null,
      inputW: input ? px(rect(input).width) : null,
      gapInputBtn: (input && createBtn) ? px(rect(createBtn).left - rect(input).right) : null,
      hintRight: hint ? px(rect(hint).right) : null,
      bodyRight,
      bulkRight: bulkActions ? px(rect(bulkActions).right) : null,
      bulkBtnCount: bulkBtns.length,
      deleteDanger: deleteBtn ? deleteBtn.classList.contains("danger") : null,
      hasBulk: !!bulk,
      heights,
      overflow: body ? body.scrollWidth - body.clientWidth : null,
      errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? b.textContent.trim() : null; })(),
    };
  })()`);

  check("A 三段结构在位（.req-toolbar 两行 + .req-bulk-bar），且都不再是 .field-inline",
    !!geo?.hasToolbar && geo?.rowCount === 2 && geo?.createEl && geo?.filterEl && geo?.hasBulk === true
      && geo?.toolbarIsFieldInline === false && geo?.bulkIsFieldInline === false,
    JSON.stringify({ toolbar: geo?.hasToolbar, rows: geo?.rowCount, bulk: geo?.hasBulk, fi: [geo?.toolbarIsFieldInline, geo?.bulkIsFieldInline] }));

  check("B 新建行与筛选行的首控件左边缘对齐（|Δx| ≤ 1px）",
    geo?.leftCreate !== null && geo?.leftFilter !== null && Math.abs(geo.leftCreate - geo.leftFilter) <= 1,
    `create=${geo?.leftCreate} filter=${geo?.leftFilter}`);

  check("C 新建输入宽 200–420，且与「新建条目」按钮间距 ≤ 12px",
    geo?.inputW !== null && geo.inputW >= 200 && geo.inputW <= 420 && geo?.gapInputBtn !== null && geo.gapInputBtn <= 12,
    `w=${geo?.inputW} gap=${geo?.gapInputBtn}`);

  check("D 宽视口下「下一步」提示右边缘与面板内容右边缘对齐（≤ 8px）",
    geo?.hintRight !== null && geo?.bodyRight !== null && Math.abs(geo.hintRight - geo.bodyRight) <= 8,
    `hintRight=${geo?.hintRight} bodyRight=${geo?.bodyRight} Δ=${geo?.hintRight != null && geo?.bodyRight != null ? Math.round((geo.hintRight - geo.bodyRight) * 100) / 100 : "?"}`);

  check("E 批量动作组右对齐（≤ 8px）且「批量删除」为 danger 档",
    geo?.bulkRight !== null && geo?.bodyRight !== null && Math.abs(geo.bulkRight - geo.bodyRight) <= 8
      && geo?.deleteDanger === true && geo?.bulkBtnCount === 5,
    `bulkRight=${geo?.bulkRight} bodyRight=${geo?.bodyRight} danger=${geo?.deleteDanger} n=${geo?.bulkBtnCount}`);

  check("F 面板无横向溢出（scrollWidth ≤ clientWidth + 1）",
    typeof geo?.overflow === "number" && geo.overflow <= 1, `overflow=${geo?.overflow}`);

  const hset = new Set(geo?.heights ?? []);
  const hSpread = (geo?.heights ?? []).length ? Math.max(...geo.heights) - Math.min(...geo.heights) : 99;
  check("G 输入 / 下拉 / 按钮同高（高度差 ≤ 1px）",
    (geo?.heights ?? []).length >= 4 && hSpread <= 1,
    `heights=${JSON.stringify(geo?.heights)} spread=${hSpread} unique=${hset.size}`);

  check("H 全程无 error 横幅", !geo?.errorBanner, geo?.errorBanner ?? "");
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  clearTimeout(watchdog);
  try { await cdp?.send("Browser.close", {}, null); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server?.close?.(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, chromeProfile]) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
process.exit(0);
