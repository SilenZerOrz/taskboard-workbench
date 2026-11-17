/**
 * 卡 `-268`（需求 `R184`）· 任务抽屉「执行记录」统一入口 —— **真实浏览器 DOM 验证台**
 * （真 headless Chrome + CDP，Node 自带 WebSocket，零依赖）。
 *
 * ## 为什么还要这一台（`-258` 的遗留项 2）
 * `tests/execution-record-api.test.mjs` 已证明**后端**回包带 `executionRecord`（证据四节 + 最近一次尝试），
 * `tests/run-summary.test.mjs` 已证明**写路径**不再落记账文案 —— 但两处都读不出**界面面**：
 *   · 「执行记录」段到底**排在第几段**、**首屏看不看得到**（`-258` 当时只有「源码顺序断言」）；
 *   · 四节字段在**渲染后**是不是真的非空（后端有值 ≠ 界面上有字）；
 *   · **老卡**（库里 22 行记账文案 + 7 行空摘要）打开时，界面上还会不会露出
 *     「按成功完成记账（失败计数清零）」—— 写路径修得再干净，**历史行**照样躺在库里。
 * 这类缺陷**不报错、不进日志、单测读不出**，只能靠真渲染读数发现。
 *
 * ## 本台断言什么（读**渲染后的 DOM / 几何**，不读源码）
 *   A. 有证据有尝试的卡：抽屉里有「执行记录」段，且**紧跟概览**（DOM 顺序 index 1）；
 *   B. 该段**首屏可见**（打开抽屉时抽屉体 `scrollTop === 0`，段的上边缘落在视口内）——「不必滚到底」；
 *   C. 四节（判定 / 偏离 / 边界 / 产物）**字段非空**，产物清单逐项可见；
 *   D. 最近一次尝试那行含**起止 + 耗时 + 结果**（成功 / 失败分得清）；
 *   E. 执行摘要显示**执行方真的写了什么**（不是记账文案）；
 *   F. 无证据无尝试的卡：**显式空态**，且**不渲染**四节标题（不臆造）；
 *   G. 有尝试无证据的卡：分开说清「尚无结构化交付证据」，四节标题仍不渲染；
 *   H. **老卡**（摘要＝记账文案）：DOM 里**不得**出现「按成功完成记账（失败计数清零）」，
 *      必须出现「执行方未回写摘要」；
 *   I. 全程无 error 横幅；
 *   J. **首屏锚点**（卡 `-268` 的根因③）：标题栏有一颗**恒在**的「执行记录」徽标，
 *      文案是结果档（成功 / 失败 / 跑着 / 尚无），点它**真的**滚到 `.exec-record` 段
 *      （判据含 `scrollTop > 0` —— 只断言「按钮在」证明不了它真的跳得过去）。
 *
 * ## 反向对照（反证本台真的会红）
 *   ```
 *   mkdir -p /tmp/tb-oldweb && git show ded38e9^:web/app.js > /tmp/tb-oldweb/app.js
 *   cp web/tokens.css web/index.html /tmp/tb-oldweb/
 *   TB_BENCH_WEB_DIR=/tmp/tb-oldweb node tools/bench-exec-record.mjs   # ⇒ 必须转红
 *   ```
 *   （`ded38e9^`＝「执行记录聚合段」落地之前的前端 ⇒ A/B/C/D/E/F/G/H 全部落空。）
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-exec-record.mjs`
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-execrec-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-execrec-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });

/** 开一条已闭合的尝试（绕开认领锁 —— 本台只验「展示口径」，不验认领流程）。 */
const seedRun = (task, { outcome, summary, durationMs = 1_370_000, actor = "cli-executor" }) => {
  const start = Date.now() - durationMs;
  store.startTaskRun(task.identifier, { sessionId: "s-execrec", actor, now: start });
  store.endTaskRun(task.identifier, { outcome, summary, actor, now: start + durationMs });
};

// A：有结构化四节证据 + 一条 22 分 51 秒的成功尝试（复刻真机 `-248` 的形状）。
const withEvidence = store.createTask({ projectId: "default", title: "A 有证据有尝试的卡", status: "todo" });
store.addTaskEvidence(withEvidence.identifier, {
  verdict: "判定：完成，已提交待验收",
  deviation: "偏离说明：原计划的复选框改成单选",
  boundary: "边界自查：未碰 :3080、未改历史文档",
  artifacts: ["src/core/store.mjs", "npm test 1328/1328/0"],
  actor: "codex",
});
seedRun(withEvidence, { outcome: "success", summary: "改了 store.mjs 与 api.mjs，npm test 1328/1328/0" });

// B：什么都没发生（无证据、无尝试）⇒ 必须是显式空态，不能臆造四节。
const emptyCard = store.createTask({ projectId: "default", title: "B 什么都没发生的卡", status: "todo" });

// C：有尝试、无证据 ⇒ 分开说清「尚无结构化交付证据」（评论里的自述不算结构化证据）。
const runOnly = store.createTask({ projectId: "default", title: "C 有尝试没证据的卡", status: "todo" });
seedRun(runOnly, { outcome: "failed", summary: "编译不过：src/x.mjs 报 3 个错", durationMs: 90_000 });

// D：老卡 —— 摘要就是老口径写死的记账文案（真机库里 22 行）⇒ 界面不得再露这句话。
const legacyCard = store.createTask({ projectId: "default", title: "D 记账文案的卡", status: "todo" });
seedRun(legacyCard, { outcome: "success", summary: "按成功完成记账（失败计数清零）", durationMs: 1_370_000 });

const TITLES = {
  withEvidence: "A 有证据有尝试的卡",
  empty: "B 什么都没发生的卡",
  runOnly: "C 有尝试没证据的卡",
  legacy: "D 记账文案的卡",
};

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
  // ⚠ 环境坑（2026-10-27 实测）：Chrome **自带沙箱**在窄沙箱里拉不起渲染进程
  //   ⇒ `Page.enable` / `Runtime.enable` 全部超时（表现为「devtools 就绪、page 域无响应」）。
  //   本台用临时 profile + 无用户数据 ⇒ 加 `--no-sandbox` 系列让渲染进程起来。
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
  // 固定视口（1280×900）：抽屉宽 1126px ⇒ 单栏；高度够放下「概览 + 执行记录」⇒
  // 「首屏可见」这条判据才有意义（默认 800×600 会被视口高度本身压掉）。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

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
    return { ok: Array.isArray(t) && t.length >= 4, titles: t };
  }, 20000, "看板出卡");
  check("A0 看板首屏出四张卡（有证据 / 空 / 有尝试无证据 / 老口径记账文案）",
    titles.ok, JSON.stringify(titles.titles));

  /** 打开某张卡的抽屉，并读「执行记录」段的**渲染后**内容与几何。 */
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
      const body = document.querySelector(".tb-drawer-body");
      if (!body) return null;
      const sec = body.querySelector(".exec-record");
      const text = (n) => (n?.textContent ?? "").trim();
      if (!sec) {
        return {
          found: false,
          bodyChildTags: [...body.children].map((n) => n.tagName + "." + (n.className || "")),
          bodyText: text(body).slice(0, 400),
          scrollTop: body.scrollTop,
          errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? text(b) : null; })(),
        };
      }
      const rect = sec.getBoundingClientRect();
      const h4s = [...sec.querySelectorAll("h4")].map((n) => text(n));
      const artifacts = [...sec.querySelectorAll(".exec-record-artifacts li")].map((n) => text(n));
      const hintTexts = [...sec.querySelectorAll("p.hint")].map((n) => text(n));
      const attemptLine = hintTexts.find((t) => t.includes("最近一次尝试")) ?? "";
      const summaryLine = text(sec.querySelector(".exec-record-summary"));
      // 卡 -268 ③：标题栏首屏徽标（与本段同源：都来自同一次 GET /api/tasks/:ref）
      const badge = document.querySelector(".tb-drawer-head .tb-exec-badge");
      return {
        found: true,
        index: [...body.children].indexOf(sec),
        bodyChildCount: body.children.length,
        firstChildText: text(body.children[0]).slice(0, 60),
        prevSectionTitle: (() => {
          const i = [...body.children].indexOf(sec);
          const prev = i > 0 ? body.children[i - 1] : null;
          return prev ? text(prev.querySelector(":scope > h3") ?? prev).slice(0, 40) : null;
        })(),
        scrollTop: body.scrollTop,
        rectTop: Math.round(rect.top),
        rectBottom: Math.round(rect.bottom),
        innerHeight: window.innerHeight,
        fullyVisible: rect.top >= 0 && rect.bottom <= window.innerHeight,
        h4s,
        artifacts,
        attemptLine,
        summaryLine,
        secText: text(sec),
        badge: badge ? {
          label: text(badge),
          tone: badge.getAttribute("data-tone") ?? "",
          evidence: badge.getAttribute("data-evidence") ?? "",
          runs: badge.getAttribute("data-runs") ?? "",
          hidden: badge.hidden === true || getComputedStyle(badge).display === "none",
          title: badge.getAttribute("title") ?? "",
          rectTop: Math.round(badge.getBoundingClientRect().top),
          h: Math.round(badge.getBoundingClientRect().height),
        } : null,
        errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? text(b) : null; })(),
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
    await sleep(700);
  };

  // ---- A：有证据有尝试的卡 ---------------------------------------------------------------
  const a = await openDrawer(TITLES.withEvidence);
  check("A 抽屉里有「执行记录」段（.exec-record）", a?.found === true, a?.found ? "" : `bodyChildTags=${JSON.stringify(a?.bodyChildTags)}`);
  // ⚠ 判据修正（2026-11-13 · 本卡）：原先写死 `index === 1`（假定概览恒为第 0 段），实测**恒红** ——
  // 「下一步」区是 `insertBefore(sec, drawerBody.firstChild)` **插到最前**的（FR-89 口径：先回答"该干嘛"），
  // 所以概览的 index 至少是 1，执行记录只能是 2。真正要守的口径是「**紧跟概览**」——
  // 改为断言「它的前一段就是概览」，与首段是谁无关（首段由别的口径决定，不归本卡管）。
  check("A① 该段**紧跟概览**（它的前一段就是「概览」）",
    a?.prevSectionTitle === "概览",
    `index=${a?.index} · 前一段=「${a?.prevSectionTitle}」 · 首段=「${a?.firstChildText}」`);
  check("B 首屏可见：打开时抽屉体未滚动，且段的上边缘落在视口内",
    a?.scrollTop === 0 && a?.rectTop >= 0 && a?.rectTop < a?.innerHeight,
    `scrollTop=${a?.scrollTop} · rectTop=${a?.rectTop} / innerHeight=${a?.innerHeight} · 完全可见=${a?.fullyVisible}`);
  check("C① 四节标题齐全（判定 / 偏离 / 边界 / 产物）",
    ["判定（verdict）", "偏离说明（deviation）", "边界自查（boundary）"].every((l) => (a?.h4s ?? []).includes(l))
      && (a?.h4s ?? []).some((l) => l.startsWith("产物")),
    JSON.stringify(a?.h4s));
  check("C② 四节**字段非空**（判定 / 偏离 / 边界 三段都有正文）",
    ["判定：完成，已提交待验收", "偏离说明：原计划的复选框改成单选", "边界自查：未碰 :3080、未改历史文档"]
      .every((v) => (a?.secText ?? "").includes(v)),
    `secText 含三节=${["判定：完成，已提交待验收", "偏离说明：原计划的复选框改成单选", "边界自查：未碰 :3080、未改历史文档"].map((v) => (a?.secText ?? "").includes(v)).join("/")}`);
  check("C③ 产物清单逐项可见（2 项）",
    (a?.artifacts ?? []).length === 2 && (a?.artifacts ?? []).includes("src/core/store.mjs"),
    JSON.stringify(a?.artifacts));
  check("D 最近一次尝试那行含**起止 + 耗时 + 结果**",
    /最近一次尝试/.test(a?.attemptLine ?? "")
      && /→/.test(a?.attemptLine ?? "")
      && /耗时/.test(a?.attemptLine ?? "")
      && /成功/.test(a?.attemptLine ?? ""),
    a?.attemptLine);
  check("E 执行摘要显示执行方真写的内容（不是记账文案）",
    /改了 store\.mjs 与 api\.mjs/.test(a?.summaryLine ?? "") && !/记账/.test(a?.summaryLine ?? ""),
    a?.summaryLine);
  check("I 无 error 横幅", !a?.errorBanner, a?.errorBanner ?? "");

  // ---- J：首屏「执行记录」锚点（卡 `-268` 根因③） ------------------------------------------
  check("J 标题栏有**执行记录**徽标且可见（首屏锚点存在）",
    !!a?.badge && a.badge.hidden === false, JSON.stringify(a?.badge));
  check("J① 徽标文案是**结果档**（成功）且与正文同源（data-runs / data-evidence 有读数）",
    /执行记录：成功/.test(a?.badge?.label ?? "") && a?.badge?.runs === "1" && a?.badge?.evidence === "1",
    `label=${a?.badge?.label} runs=${a?.badge?.runs} evidence=${a?.badge?.evidence} tone=${a?.badge?.tone}`);
  check("J② 徽标在**首屏**（标题栏里，不在要滚才看得到的地方）",
    typeof a?.badge?.rectTop === "number" && a.badge.rectTop >= 0 && a.badge.rectTop < 120,
    `rectTop=${a?.badge?.rectTop} · h=${a?.badge?.h}`);
  check("J③ 徽标尺寸与抽屉按钮同档（28px，不抢主色变成大按钮）",
    a?.badge?.h === 28, `h=${a?.badge?.h}`);
  // 点它必须**真的**滚过去：只断言「按钮在」证明不了它跳得动（本仓已有同类教训）
  const jumped = await evalJs(`(() => {
    const body = document.querySelector(".tb-drawer-body");
    const badge = document.querySelector(".tb-drawer-head .tb-exec-badge");
    if (!body || !badge) return null;
    const sec = body.querySelector(".exec-record");
    const before = { scrollTop: body.scrollTop, secTop: sec ? Math.round(sec.getBoundingClientRect().top) : null };
    badge.click();
    return new Promise((r) => setTimeout(() => {
      const sec2 = body.querySelector(".exec-record");
      r({
        before,
        after: { scrollTop: body.scrollTop, secTop: sec2 ? Math.round(sec2.getBoundingClientRect().top) : null },
        collapsed: sec2 ? sec2.classList.contains("collapsed") : null,
      });
    }, 900));
  })()`);
  check("J④ 点徽标**真的**滚到「执行记录」段（scrollTop 变化 + 段顶进入视口）",
    jumped?.after?.scrollTop > jumped?.before?.scrollTop && jumped?.after?.secTop >= 0 && jumped.after.secTop < 200,
    JSON.stringify(jumped));
  await closeDrawer();

  // ---- F：什么都没发生的卡（无证据、无尝试） ----------------------------------------------
  const b = await openDrawer(TITLES.empty);
  check("F 空卡：给出**显式空态**（本卡尚无执行记录）",
    /本卡尚无执行记录/.test(b?.secText ?? ""), (b?.secText ?? "").slice(0, 120));
  check("F① 空卡：**不渲染**四节标题（不臆造）", (b?.h4s ?? []).length === 0, JSON.stringify(b?.h4s));
  check("F② 空卡：**不渲染**产物清单", (b?.artifacts ?? []).length === 0, JSON.stringify(b?.artifacts));
  check("F③ 空卡：首屏徽标**恒在**且如实写「尚无」（空态也是读数，不藏起来）",
    !!b?.badge && b.badge.hidden === false && /尚无/.test(b.badge.label) && b.badge.runs === "0",
    JSON.stringify(b?.badge));
  await closeDrawer();

  // ---- G：有尝试无证据的卡 ---------------------------------------------------------------
  const c = await openDrawer(TITLES.runOnly);
  check("G 有尝试无证据：分开说清「尚无结构化交付证据」",
    /本卡尚无结构化交付证据/.test(c?.secText ?? ""), (c?.secText ?? "").slice(0, 160));
  check("G① 有尝试无证据：仍**不渲染**四节标题", (c?.h4s ?? []).length === 0, JSON.stringify(c?.h4s));
  check("G② 有尝试无证据：尝试那行分得清**失败**结果",
    /最近一次尝试/.test(c?.attemptLine ?? "") && /失败/.test(c?.attemptLine ?? ""), c?.attemptLine);
  await closeDrawer();

  // ---- H：老卡（摘要＝记账文案）-----------------------------------------------------------
  const d = await openDrawer(TITLES.legacy);
  check("H 老卡：DOM 里**不得**出现「按成功完成记账（失败计数清零）」",
    !/按成功完成记账/.test(d?.secText ?? ""), (d?.secText ?? "").slice(0, 160));
  check("H① 老卡：必须显示「执行方未回写摘要」（如实说没写，不拿记账文案冒充）",
    /执行方未回写摘要/.test(d?.summaryLine ?? ""), d?.summaryLine);
  check("H② 老卡：首屏徽标也不许带记账文案（成功档但仍说真话）",
    /执行记录：成功/.test(d?.badge?.label ?? "") && !/记账/.test(`${d?.badge?.label}${d?.badge?.title}`),
    JSON.stringify(d?.badge));
  await closeDrawer();

  // ---- I：全程无 error 横幅（复看一次最后一张卡）------------------------------------------
  check("I② 全程无 error 横幅", !d?.errorBanner && !c?.errorBanner && !b?.errorBanner,
    [b?.errorBanner, c?.errorBanner, d?.errorBanner].filter(Boolean).join(" | "));
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
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
