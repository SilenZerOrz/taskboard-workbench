/**
 * 任务卡抽屉「常用按钮位置与样式」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-224` / 需求 `R164`）
 * 真机批注（2026-11-05）：「任务卡片的按钮设置常用按钮位置和按钮样式不统一」。
 * 实证：未归因卡的抽屉里同时出现 3 个蓝按钮（头部「去归因」/「下一步」区「去归因」/
 * 「归因」区「关联需求条目」），各处置区又各配一个 primary ⇒ 一屏 5–7 个同权重蓝块；
 * 头部还把高频动作（编辑 / 上一列 / 下一列）与低频工具（全部收起 / 全屏 / ✕）挤在同一排，
 * 位置由 `append` 顺序决定；正文三类按钮容器（`.btn-row` / `.review-actions` / `.next-actions`）
 * 各有一套 min-height（30px）而头部是 28px ⇒ 同一屏两种高度。
 *
 * 单测只能断言「源码里有 `.tb-drawer-utils`」，证明不了**渲染后**的位置、层级与几何。
 * 这类缺陷（错位、多主色、高度不齐）**不报错、不进日志**，只能靠真渲染读数发现。
 *
 * ## 本台断言什么（读渲染后的 DOM / 几何，不读源码）
 *   A. 头部**两段**：存在 `.tb-drawer-actions` 与 `.tb-drawer-utils`，且二者之间有 `.tb-drawer-sep`
 *      （DOM 顺序：actions → sep → utils）；
 *   B. 工具组顺序固定：`全部收起 → 全屏 → ✕`（位置不再由动作数量决定）；
 *   C. 全抽屉可见 `button.primary` **≤ 1**，且那一个落在「下一步」区；
 *   D. 头部的「去归因」是 `link`（指针），不是抢主色的 primary —— 同一动作不摆两个同等权重的入口；
 *   E. 头部动作 / 工具 / 正文动作三处按钮 **offsetHeight 相等**（尺寸统一）；
 *   F. 全程无 error 横幅。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-drawer-button-hierarchy.mjs`
 *   —— 拷一份 `web/`（旧 app.js / tokens.css）⇒ C / D / E 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`），
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-drawer-button-hierarchy.mjs`。
 *
 * 运行：`node tools/bench-drawer-button-hierarchy.mjs`
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

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on("error", reject);
  srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
});

// ---- 台内数据：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-btnhier-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-btnhier-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
store.createRequirementItem({ projectId: "default", title: "台内需求", acceptance: "台内验收", priority: "medium" });
const req = store.listRequirementItems({ projectId: "default" })[0];

// 报障场景：**可开工 + 未归因** ⇒ 「下一步」区给 `goto-attribution`（primary），
// 头部同时也有一个「去归因」入口 —— 旧实现里两处都是蓝的。
const unattributed = store.createTask({ projectId: "default", title: "未归因的可开工卡", status: "todo" });
// 对照卡：已归因 + 进行中（「下一步」区给的是执行/评审类动作，不是归因）。
const inProgress = store.createTask({ projectId: "default", title: "进行中的卡", status: "in_progress", requirementId: req.id });

const TITLES = { main: "未归因的可开工卡", control: "进行中的卡" };

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

  const titles = await waitFor(async () => {
    const t = await evalJs(`(() => [...document.querySelectorAll("article.task-card .card-title")].map((n) => n.textContent.trim()))()`);
    return { ok: Array.isArray(t) && t.length >= 2, titles: t };
  }, 20000, "看板出卡");
  check("A0 看板首屏出两张卡（未归因 / 进行中）",
    titles.ok, JSON.stringify(titles.titles));

  /** 打开某张卡的抽屉，并读头部两段 / 工具组 / 全部按钮的层级与几何。 */
  const openDrawer = async (title) => {
    await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(title)});
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await sleep(1800);
    return evalJs(`(() => {
      const drawer = document.querySelector(".tb-drawer");
      const head = document.querySelector(".tb-drawer-head");
      const body = document.querySelector(".tb-drawer-body");
      if (!drawer || !head || !body) return null;
      const actions = head.querySelector(".tb-drawer-actions");
      const utils = head.querySelector(".tb-drawer-utils");
      const sep = head.querySelector(".tb-drawer-sep");
      const kids = [...head.children];
      const idx = (n) => (n ? kids.indexOf(n) : -1);
      const label = (b) => (b.textContent ?? "").trim();
      const btnInfo = (b) => ({
        label: label(b),
        tier: b.classList.contains("primary") ? "primary"
          : b.classList.contains("secondary") ? "secondary"
          : b.classList.contains("link") ? "link"
          : b.classList.contains("ghost") ? "ghost" : "base",
        h: Math.round(b.getBoundingClientRect().height),
      });
      const all = [...drawer.querySelectorAll("button")];
      const primaries = all.filter((b) => b.classList.contains("primary"));
      const nextSec = body.querySelector(".drawer-section.next-step");
      return {
        hasActions: !!actions,
        hasUtils: !!utils,
        hasSep: !!sep,
        order: { actions: idx(actions), sep: idx(sep), utils: idx(utils) },
        actionButtons: actions ? [...actions.querySelectorAll("button")].map(btnInfo) : [],
        utilButtons: utils ? [...utils.querySelectorAll("button")].map(btnInfo) : [],
        nextButtons: nextSec ? [...nextSec.querySelectorAll("button")].map(btnInfo) : [],
        primaryCount: primaries.length,
        primaryLabels: primaries.map(label),
        primaryInNextStep: primaries.length > 0
          ? primaries.every((b) => !!b.closest(".drawer-section.next-step"))
          : null,
        errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? label(b) : null; })(),
      };
    })()`);
  };
  const closeDrawer = async () => {
    await evalJs(`(() => {
      const btn = [...document.querySelectorAll(".tb-drawer-utils button")].find((b) => (b.textContent ?? "").trim() === "✕");
      if (btn) { btn.click(); return true; }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    })()`);
    await sleep(800);
  };

  // ---- A/B/C/D/E：主场景（未归因的可开工卡） -------------------------------------------------
  const d1 = await openDrawer(TITLES.main);
  check("A 抽屉打开，头部有动作段与工具段两段", !!d1?.hasActions && !!d1?.hasUtils,
    JSON.stringify({ actions: d1?.hasActions, utils: d1?.hasUtils }));

  check("A① 两段之间有分隔线，且 DOM 顺序为 actions → sep → utils",
    d1?.hasSep === true && d1.order.actions < d1.order.sep && d1.order.sep < d1.order.utils,
    JSON.stringify(d1?.order));

  check("B 工具组顺序固定为 全部收起 → 全屏 → ✕",
    JSON.stringify((d1?.utilButtons ?? []).map((b) => b.label)) === JSON.stringify(["全部收起", "全屏", "✕"]),
    JSON.stringify((d1?.utilButtons ?? []).map((b) => b.label)));

  check("C 全抽屉可见 primary ≤ 1（一屏只有一个主按钮）",
    (d1?.primaryCount ?? 99) <= 1, `primary=${d1?.primaryCount} ${JSON.stringify(d1?.primaryLabels)}`);

  check("C① 唯一的主按钮落在「下一步」区（那里才是回答「该干嘛」的地方）",
    d1?.primaryCount === 0 ? true : d1?.primaryInNextStep === true,
    `primary=${d1?.primaryCount} inNextStep=${d1?.primaryInNextStep}`);

  const headerAttr = (d1?.actionButtons ?? []).find((b) => /去归因/.test(b.label)) ?? null;
  check("D 头部的「去归因」是 link 指针（不是抢主色的 primary）",
    !!headerAttr && headerAttr.tier === "link",
    JSON.stringify(headerAttr));

  const heights = [
    d1?.actionButtons?.[0]?.h,
    d1?.utilButtons?.[0]?.h,
    d1?.nextButtons?.[0]?.h,
  ].filter((h) => typeof h === "number");
  check("E 头部动作 / 工具 / 正文动作三处按钮同高（尺寸统一）",
    heights.length === 3 && new Set(heights).size === 1,
    `heights=${JSON.stringify(heights)}`);

  check("F 全程无 error 横幅", !d1?.errorBanner, d1?.errorBanner ?? "");
  await closeDrawer();

  // ---- G：对照卡（已归因 + 进行中）同样收敛 ------------------------------------------------
  const d2 = await openDrawer(TITLES.control);
  check("G 对照卡（进行中）：primary ≤ 1 且头部仍是两段",
    (d2?.primaryCount ?? 99) <= 1 && d2?.hasUtils === true,
    `primary=${d2?.primaryCount} ${JSON.stringify(d2?.primaryLabels)}`);
  check("G① 对照卡：工具组顺序不变（证明分区与动作数量无关）",
    JSON.stringify((d2?.utilButtons ?? []).map((b) => b.label)) === JSON.stringify(["全部收起", "全屏", "✕"]),
    JSON.stringify((d2?.utilButtons ?? []).map((b) => b.label)));
  await closeDrawer();
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
