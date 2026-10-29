/**
 * 卡 `-158`「评审通过后处置入口收敛」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么必须有第二台
 * 本轮的改动**全在呈现层**（`web/app.js` 的「下一列」判定与接线）。单测只能读源码文本，
 * 证明不了「人真的只看到一处处置」。若 `nextColumnTarget` 被误接线，源码断言仍可能全绿 ⇒
 * 这正是需要真浏览器读数的理由。
 *
 * ## 本台断言什么（在**真实渲染后的 DOM** 里读，不读源码）
 *   A. 拉起隔离服务（临时 dataDir + 随机端口 + 仓库自己的 `createServer`，真 `web/`）→ 真 headless Chrome 打开；
 *   B. 造两张「待验收」卡：一张评审**已通过**、一张评审**待处理**；
 *   C. 在浏览器里打开**已通过**那张的抽屉 ⇒
 *      ① 「下一步」区出现「完成（仅人工可确认）」（唯一处置入口）；
 *      ② 操作区**不再**给出「下一列」位移按钮，而是**指回「下一步」区**的按钮；
 *      ③ 点那个指回按钮 ⇒ 「下一步」区被展开/滚到可见（证明它是可用的引导，不是死按钮）；
 *   D. 打开**待处理**那张 ⇒ 同样是「指回下一步」，「下一步」区给的是评审类动作（不是「完成」）；
 *   E. 反向对照：**非待验收**列（例如「进行中」）的卡 ⇒ 操作区**必须仍有**普通「下一列」按钮
 *      （证明收敛只作用在待验收，没有把能力整体删掉）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-next-column.mjs`
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

// ---- 台内数据：真实 SQLite + 仓库自己的 createServer（随机端口） -----------------------------
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-nextcol-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-nextcol-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });

/** 造一张「待验收」卡（走真实评审流程进入 in_review）。 */
const seedReview = (title) => {
  const t = store.createTask({ projectId: "default", title, status: "todo", requirementId: "4-abc" });
  store.requestReview(t.identifier, { actor: "agent", reviewer: "r1", comment: "请评审" });
  return store.getTaskRef(t.identifier);
};

const approved = seedReview("已评审通过的卡");
store.approveReview(approved.identifier, { actor: "reviewer" });
const pending = seedReview("评审待处理的卡");
// 反向对照：非待验收列
const inProgress = store.createTask({ projectId: "default", title: "进行中的卡", status: "in_progress", requirementId: "4-abc" });

const TITLES = { approved: "已评审通过的卡", pending: "评审待处理的卡", inProgress: "进行中的卡" };

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
  // 环境坑（2026-10-27 实测，同 bench-review-evidence-dom）：workspace-write 沙箱里 Chrome 自带沙箱
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

  // ---- C 前置：真浏览器打开看板 --------------------------------------------------------------
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
    return { ok: Array.isArray(t) && t.length >= 3, titles: t };
  }, 20000, "看板出卡");
  check("C 看板首屏出三张卡（已验证 / 待处理 / 进行中）",
    Object.values(TITLES).every((x) => (titles.titles ?? []).includes(x)),
    JSON.stringify(titles.titles));

  /** 打开某张卡的抽屉，并读「操作区（标题栏）+ 下一步区」的真实 DOM。 */
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
      const head = document.querySelector(".tb-drawer-head");
      const body = document.querySelector(".tb-drawer-body");
      if (!head || !body) return null;
      // 操作区 = 标题栏里的 drawer-actions 容器
      const ops = head.querySelector(".tb-drawer-actions");
      const opButtons = ops ? [...ops.querySelectorAll("button")].map((b) => ({ label: (b.textContent ?? "").trim(), disabled: !!b.disabled })) : [];
      // 下一步区
      const sec = body.querySelector(".drawer-section.next-step");
      const nextTitle = sec?.querySelector(".next-step-title")?.textContent?.trim() ?? "";
      const nextActions = sec ? [...sec.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim()) : [];
      const nextCollapsed = sec ? sec.classList.contains("collapsed") : null;
      // 卡片区的「→」按钮（看板列里）—— 反向对照用
      return { opButtons, nextTitle, nextActions, nextCollapsed, hasNextSection: !!sec };
    })()`);
  };

  const closeDrawer = async () => {
    await evalJs(`(() => {
      const btn = document.querySelector(".tb-drawer-close") || [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "✕");
      if (btn) { btn.click(); return true; }
      // 兜底：按 ESC
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      return false;
    })()`);
    await sleep(900);
  };

  // 找「指回下一步」的那个按钮
  const findByLabel = (buttons, re) => buttons.filter((b) => re.test(b.label));

  // ---- C. 评审**已通过**的待验收卡 ----------------------------------------------------------
  const d1 = await openDrawer(TITLES.approved);
  check("C 抽屉打开且「下一步」区存在", !!d1?.hasNextSection, d1 ? `nextTitle=${d1.nextTitle}` : "未找到抽屉");

  // ① 「下一步」区给的唯一处置是「完成（仅人工可确认）」
  check("C① 已通过卡：「下一步」区给「完成（仅人工可确认）」",
    (d1?.nextActions ?? []).some((t) => t.includes("完成（仅人工可确认）")),
    JSON.stringify(d1?.nextActions));

  // ② 操作区**不再**有裸「下一列」位移按钮；取而代之是指回「下一步」的按钮
  const bareNext = findByLabel(d1?.opButtons ?? [], /^下一列$/);
  check("C② 已通过卡：操作区**没有**裸「下一列」位移按钮（消除与「完成」的重复）",
    bareNext.length === 0, JSON.stringify(d1?.opButtons));
  const viaNext = findByLabel(d1?.opButtons ?? [], /处置见「下一步」/);
  check("C② 已通过卡：操作区给出**指回「下一步」区**的按钮", viaNext.length === 1,
    JSON.stringify((d1?.opButtons ?? []).map((b) => b.label)));

  // ③ 点它 ⇒ 「下一步」区被展开（不是死按钮）
  if (viaNext.length === 1) {
    await evalJs(`(() => {
      const ops = document.querySelector(".tb-drawer-head .tb-drawer-actions");
      const btn = [...(ops?.querySelectorAll("button") ?? [])].find((b) => (b.textContent ?? "").includes("处置见「下一步」"));
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(700);
    const afterClick = await evalJs(`(() => {
      const sec = document.querySelector(".tb-drawer-body .drawer-section.next-step");
      return { collapsed: sec ? sec.classList.contains("collapsed") : null };
    })()`);
    check("C③ 点「指回下一步」⇒ 该区块被展开（可用的引导，不是死按钮）", afterClick?.collapsed === false,
      `collapsed=${afterClick?.collapsed}`);
  } else {
    check("C③ 点「指回下一步」⇒ 该区块被展开（可用的引导，不是死按钮）", false, "找不到指回按钮");
  }
  await closeDrawer();

  // ---- D. 评审**待处理**的待验收卡 ----------------------------------------------------------
  const d2 = await openDrawer(TITLES.pending);
  check("D 待处理卡：操作区同样收敛为「指回下一步」",
    findByLabel(d2?.opButtons ?? [], /处置见「下一步」/).length === 1 && findByLabel(d2?.opButtons ?? [], /^下一列$/).length === 0,
    JSON.stringify((d2?.opButtons ?? []).map((b) => b.label)));
  check("D 待处理卡：「下一步」区给的是评审类动作（不是「完成」）",
    (d2?.nextActions ?? []).length > 0 && !(d2?.nextActions ?? []).some((t) => t.includes("完成（仅人工可确认）")),
    JSON.stringify(d2?.nextActions));
  await closeDrawer();

  // ---- E. 反向对照：非待验收列仍保留普通「下一列」 -------------------------------------------
  const d3 = await openDrawer(TITLES.inProgress);
  check("E 反向对照：进行中卡的操作区**仍有**普通「下一列」按钮（收敛只作用于待验收）",
    findByLabel(d3?.opButtons ?? [], /^下一列$/).length === 1,
    JSON.stringify((d3?.opButtons ?? []).map((b) => b.label)));
  await closeDrawer();

  // ---- E2. 反向对照：卡片区的「→」在待验收列不得位移 -----------------------------------------
  const cardArrows = await evalJs(`(() => {
    const out = {};
    for (const card of document.querySelectorAll("article.task-card")) {
      const title = (card.querySelector(".card-title")?.textContent ?? "").trim();
      const arrows = [...card.querySelectorAll(".move-group button")].map((b) => ({ tip: b.title, disabled: !!b.disabled }));
      out[title] = arrows;
    }
    return out;
  })()`);
  const approvedArrows = cardArrows?.[TITLES.approved] ?? [];
  const rightArrow = approvedArrows[approvedArrows.length - 1] ?? null;
  check("E② 待验收卡的卡片「→」被禁用并写明理由（不再盲移「完成」）",
    rightArrow?.disabled === true && /下一步/.test(rightArrow?.tip ?? ""),
    JSON.stringify(approvedArrows));
  const progArrows = cardArrows?.[TITLES.inProgress] ?? [];
  const progRight = progArrows[progArrows.length - 1] ?? null;
  check("E② 反向对照：进行中卡的卡片「→」仍可用",
    progRight?.disabled === false, JSON.stringify(progArrows));
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
