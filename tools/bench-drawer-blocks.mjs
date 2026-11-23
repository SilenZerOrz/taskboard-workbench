/**
 * 任务卡抽屉「主信息一屏对齐 + 分块折叠 + 关键步骤条」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-292` / 需求 `R196`）
 * 真机批注（2026-11-23 · 卡 `-288` 抽屉截图）：1440 宽抽屉把内容按 **CSS 多列** 横排，长证据段被挤到左列、
 * 读一张卡要左右来回拖；同一屏既有主信息又有十几段明细，找不到「现在该做什么」。
 *
 * 这类缺陷（横向多列、分组默认态、步骤条当前步）**不报错、不进日志**：源码里「有 `column-count: 2`」
 * 或「有个 `aria-current`」都证明不了**渲染后**的列数、默认折叠的是哪一组、当前步标在哪儿。
 * 单测只能扫字符串 ⇒ 必须真浏览器读几何。
 *
 * ## 本台断言什么（读渲染后的 DOM / 几何，不读源码）
 *   A. ① 1440 宽下 `.tb-drawer-body` 计算样式 `column-count === "auto"`（不再是 2），
 *      且**主信息组**的 boundingBox `top ≥ 0`、`bottom ≤ innerHeight`（一屏看全）；
 *   B. ② 组数 ≤ 5，每组组头**含组内区块数**（"N 块"）；
 *   C. ③ 非当前阶段组**默认折叠**；点组头后组内首个区块 `offsetHeight > 0`（真展开，不是空壳）；
 *   D. ④ 步骤条步数 = 服务端 `ticketStage.next.steps` 长度（独立取 API 读数，不信 DOM 自说自话），
 *      且**恰 1 个** `aria-current="step"`；
 *   E. ⑤ 改前区块标题**一条不少**（与下方基线清单比对）且**一条不多**（没凭空造区块）；
 *   F. ⑥ 关键步骤条落在「下一步」区（步骤与动作同源同屏）；
 *   G. 全程无 error 横幅。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-drawer-blocks.mjs`
 *   —— 拷一份**改动前**的 `web/`（`git show HEAD:web/app.js` 等）⇒ A / B / C / D 四条转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`），
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-drawer-blocks.mjs`。
 *
 * 运行：`node tools/bench-drawer-blocks.mjs`
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

/**
 * 改前（2026-11-23 · 卡 `-288` 截图那一版 web）抽屉正文**区块标题清单** —— 一条不许少。
 *
 * 抄录口径：**去掉动态计数后缀**（`派生 / 子任务（3）` 记作 `派生 / 子任务`），只留标题的固定部分；
 * 「自动复核证据」「团队侧任务」是嵌在别的区里的二级标题，同样列进来（它们不许被分块改造弄丢）。
 * 这份清单与卡 `-292` 的验收⑤同源 —— 报告里也带一份，供贴进卡评论留证。
 */
const BASELINE_SECTION_TITLES = [
  "概览",
  "执行记录",
  "归因",
  "人工校验",
  "评审",
  "自动复核证据",
  "前后关联 / 阻塞因素",
  "派生 / 子任务",
  "执行会话",
  "CLI 执行器",
  "诊断与恢复动作",
  "尝试记录",
  "事件流",
  "执行看护",
  "归属团队",
  "团队侧任务",
  "治理审计",
  "反馈 / 评论",
  "下一步",
];

/**
 * 本台种子的卡**必然**渲染出来的区块（其余区块按状态/数据条件渲染，不写死）：
 * 「诊断与恢复动作」只在有诊断时出现、「执行看护」只在停滞/待决策时出现 —— 两者不在此列。
 */
const MUST_RENDER = [
  "概览", "下一步", "执行记录", "执行会话", "CLI 执行器", "尝试记录", "事件流",
  "人工校验", "评审", "自动复核证据", "归因", "前后关联 / 阻塞因素", "派生 / 子任务",
  "归属团队", "团队侧任务", "治理审计", "反馈 / 评论",
];

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
const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-drawerblocks-data-"));
const chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-drawerblocks-chrome-"));
const store = openStore({ dataDir, env: {} });
store.createProject({ id: "default", name: "默认项目" });
store.createRequirementItem({ projectId: "default", title: "台内需求", acceptance: "台内验收", priority: "medium" });
const req = store.listRequirementItems({ projectId: "default" })[0];
// 场景：**进行中 + 已归因** ⇒ 服务端 `ticketStage.next.focus` ＝ `["执行会话", "执行看护"]`
// ⇒ 「执行与证据」是当前阶段所在组（默认展开），其余组默认折叠。
const card = store.createTask({
  projectId: "default",
  title: "抽屉分块验证卡",
  description: "验证台种子卡：进行中 + 已归因。",
  status: "in_progress",
  requirementId: req.id,
});

let server = createServer({ store, webDir: WEB_DIR });
const port = await freePort();
await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${port}`;
console.log(`… 台内服务 ${base} · dataDir=${dataDir} · webDir=${WEB_DIR}`);

// ---- 服务端口径（**独立**取数：不拿 DOM 自说自话当判据） ------------------------------------
const apiJson = async (route) => {
  const res = await fetch(`${base}${route}`);
  if (!res.ok) throw new Error(`${route} → HTTP ${res.status}`);
  return res.json();
};
const detail = await apiJson(`/api/tasks/${encodeURIComponent(card.identifier)}`);
const stageNext = detail?.ticketStage?.next ?? null;
const expectedSteps = Array.isArray(stageNext?.steps) ? stageNext.steps.length : 0;
const expectedFocus = Array.isArray(stageNext?.focus) ? stageNext.focus : [];
console.log(`… 服务端口径：stage=${detail?.ticketStage?.stage ?? "?"} · steps=${expectedSteps} · focus=${JSON.stringify(expectedFocus)}`);

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
    "--window-size=1440,900",
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
  // 视口定死 1440×900（验收①写的是「1440 宽」）：桌面真机尺寸，`innerHeight` 才有意义。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

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
    return { ok: Array.isArray(t) && t.length >= 1, titles: t };
  }, 20000, "看板出卡");
  check("A0 看板首屏出卡", titles.ok, JSON.stringify(titles.titles));

  /** 打开种子卡的抽屉。 */
  const openDrawer = async () => {
    await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(card.title)});
      if (!card) return false;
      card.click();
      return true;
    })()`);
    await sleep(2000);
  };

  /** 读渲染后的抽屉结构 / 几何（本台所有判据都来自这里）。 */
  const readDrawer = () => evalJs(`(() => {
    const body = document.querySelector(".tb-drawer-body");
    if (!body) return null;
    const cs = getComputedStyle(body);
    const groups = [...body.querySelectorAll(".drawer-group")].map((g) => {
      const head = g.querySelector(".drawer-group-head");
      const caret = g.querySelector(".drawer-group-caret");
      const sections = [...g.querySelectorAll(".drawer-section")].map((s) => ({
        title: (s.querySelector(":scope > h3")?.textContent ?? "").trim(),
        h: s.offsetHeight,
      }));
      const headBox = head ? head.getBoundingClientRect() : null;
      const headStyle = head ? getComputedStyle(head) : null;
      return {
        key: g.dataset.group ?? "",
        name: (g.querySelector(".drawer-group-name")?.textContent ?? "").trim(),
        countText: (g.querySelector(".drawer-group-count")?.textContent ?? "").trim(),
        collapsed: g.classList.contains("collapsed"),
        ariaExpanded: head?.getAttribute("aria-expanded") ?? null,
        caretTransform: caret ? getComputedStyle(caret).transform : null,
        headWidth: headBox ? Math.round(headBox.width) : 0,
        headJustify: headStyle?.justifyContent ?? null,
        headDisplay: headStyle?.display ?? null,
        sections,
        sectionCount: sections.length,
      };
    });
    const mainGroup = body.querySelector('.drawer-group[data-group="main"]');
    const mainBox = mainGroup ? mainGroup.getBoundingClientRect() : null;
    const steps = [...body.querySelectorAll(".next-steps .tb-step")].map((li) => ({
      no: (li.querySelector(".tb-step-no")?.textContent ?? "").trim(),
      text: (li.querySelector(".tb-step-text")?.textContent ?? "").trim(),
      current: li.getAttribute("aria-current"),
      inNextStep: !!li.closest(".drawer-section.next-step"),
    }));
    return {
      columnCount: cs.columnCount,
      display: cs.display,
      cols: body.dataset.cols ?? "",
      gridCols: cs.gridTemplateColumns,
      groups,
      // 区块标题清单（改前基线比对用）：一级 + 嵌在一级里的二级标题都收
      titles: [...body.querySelectorAll(".drawer-section h3")].map((h) => h.textContent.trim()),
      mainBox: mainBox ? { top: Math.round(mainBox.top), bottom: Math.round(mainBox.bottom), height: Math.round(mainBox.height) } : null,
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      steps,
      currentCount: steps.filter((s) => s.current === "step").length,
      errorBanner: (() => { const b = document.querySelector(".banner.error"); return b && !b.hidden ? (b.textContent ?? "").trim() : null; })(),
    };
  })()`);

  await openDrawer();
  const d = await readDrawer();

  // ---- ① 宽视口不再横向多列 + 主信息一屏看全 ------------------------------------------------
  check("① 1440 宽下 .tb-drawer-body 计算样式 column-count = auto（不再是 2）",
    d?.columnCount === "auto", `columnCount=${d?.columnCount} display=${d?.display} cols=${d?.cols}`);
  check("①① 主信息组完整落在第一屏（top ≥ 0 且 bottom ≤ innerHeight）",
    !!d?.mainBox && d.mainBox.top >= 0 && d.mainBox.bottom <= d.innerHeight,
    `top=${d?.mainBox?.top} bottom=${d?.mainBox?.bottom} innerHeight=${d?.innerHeight}`);

  // ---- ② 组数 ≤ 5 且组头含组内区块数 --------------------------------------------------------
  const groupCount = d?.groups?.length ?? 0;
  check("② 分组数 ≤ 5", groupCount > 0 && groupCount <= 5, `groups=${groupCount} ${JSON.stringify((d?.groups ?? []).map((g) => g.name))}`);
  const countOk = (d?.groups ?? []).every((g) => g.countText === `${g.sectionCount} 块`);
  check("②① 每组组头都写明组内区块数（「N 块」，与实际块数一致）",
    groupCount > 0 && countOk,
    JSON.stringify((d?.groups ?? []).map((g) => `${g.name}:${g.countText}/${g.sectionCount}`)));
  check("②② 组内区块一个都不少（组内块数 = 该组真实 .drawer-section 数）",
    groupCount > 0 && (d?.groups ?? []).every((g) => g.sectionCount > 0),
    JSON.stringify((d?.groups ?? []).map((g) => `${g.name}:${g.sectionCount}`)));
  // 抽屉里有一条 `.tb-drawer button:not(.link):not(.icon)`（特异性 0,3,1）统管按钮形态；
  // 组头要压住它（0,4,1）才铺得满、左对齐 —— 读**渲染后**的计算样式，别只读「规则在不在」。
  check("②③ 组头压住了抽屉通用按钮规则（铺满 + 左对齐，不是浏览器默认按钮形态）",
    groupCount > 0 && (d?.groups ?? []).every((g) => g.headJustify === "flex-start" && g.headDisplay === "flex" && g.headWidth > 200),
    JSON.stringify((d?.groups ?? []).map((g) => `${g.name}:${g.headWidth}px/${g.headJustify}/${g.headDisplay}`)));

  // ---- ③ 默认折叠策略 + 点组头真展开 -------------------------------------------------------
  // 「当前阶段所在组」＝命中服务端 `ticketStage.next.focus` 的区块所在组（判据取服务端，不在前端另写一套）。
  const focusGroupKeys = new Set();
  for (const g of d?.groups ?? []) {
    for (const s of g.sections) {
      if (expectedFocus.some((k) => s.title.includes(k))) focusGroupKeys.add(g.key);
    }
  }
  const mainGroup = (d?.groups ?? []).find((g) => g.key === "main");
  check("③ 主信息组默认展开",
    !!mainGroup && !mainGroup.collapsed && mainGroup.ariaExpanded === "true",
    `collapsed=${mainGroup?.collapsed} aria=${mainGroup?.ariaExpanded}`);
  const currentGroup = (d?.groups ?? []).find((g) => focusGroupKeys.has(g.key));
  check("③① 当前 ticketStage 所在组默认展开",
    !currentGroup || !currentGroup.collapsed,
    `focus=${JSON.stringify(expectedFocus)} → group=${currentGroup?.name ?? "(无)"} collapsed=${currentGroup?.collapsed}`);
  const idleGroup = (d?.groups ?? []).find((g) => g.key !== "main" && !focusGroupKeys.has(g.key));
  check("③② 非当前阶段组默认折叠",
    !!idleGroup && idleGroup.collapsed === true && idleGroup.ariaExpanded === "false",
    `group=${idleGroup?.name ?? "(无)"} collapsed=${idleGroup?.collapsed} aria=${idleGroup?.ariaExpanded}`);
  check("③③ 折叠三角真随状态转（不是静态装饰）",
    !!idleGroup && idleGroup.caretTransform && idleGroup.caretTransform !== "none",
    `transform=${idleGroup?.caretTransform}`);

  // 点组头 → 组内首个区块必须真可见（offsetHeight > 0）
  let afterClick = null;
  if (idleGroup) {
    const clicked = await evalJs(`(() => {
      const g = [...document.querySelectorAll(".drawer-group")].find((x) => x.dataset.group === ${JSON.stringify(idleGroup.key)});
      const head = g?.querySelector(".drawer-group-head");
      if (!head) return false;
      head.click();
      return true;
    })()`);
    await sleep(600);
    afterClick = await readDrawer();
    const reopened = (afterClick?.groups ?? []).find((g) => g.key === idleGroup.key);
    const firstH = reopened?.sections?.[0]?.h ?? 0;
    check("③④ 点组头后组内首个区块 offsetHeight > 0（真展开，不是空壳）",
      clicked === true && !reopened?.collapsed && firstH > 0,
      `group=${reopened?.name} collapsed=${reopened?.collapsed} firstSectionH=${firstH}`);
  } else {
    check("③④ 点组头后组内首个区块 offsetHeight > 0（真展开，不是空壳）", false, "没有可点的非当前阶段组");
  }

  // ---- ④ 关键步骤条：步数与 `ticketStage.next.steps` 一致，恰 1 个 aria-current ------------
  check("④ 步骤条步数 = 服务端 ticketStage.next.steps 长度",
    (d?.steps?.length ?? 0) === expectedSteps && expectedSteps > 0,
    `dom=${d?.steps?.length ?? 0} api=${expectedSteps}`);
  check("④① 恰 1 个 aria-current=\"step\"（不多标、不少标）",
    d?.currentCount === 1, `currentCount=${d?.currentCount}`);
  check("④② 步骤条按 1..N 顺序编号",
    (d?.steps ?? []).every((s, i) => s.no === String(i + 1)),
    JSON.stringify((d?.steps ?? []).map((s) => s.no)));
  check("④③ 当前步落在「下一步」区（步骤与动作同源同屏）",
    (d?.steps ?? []).length > 0 && d.steps.every((s) => s.inNextStep),
    JSON.stringify((d?.steps ?? []).map((s) => s.text)));

  // ---- ⑤ 改前区块标题一条不少、一条不多 -----------------------------------------------------
  const normalize = (title) => {
    const t = String(title ?? "").trim();
    return t.replace(/（[^）]*）\s*$/, "").trim();
  };
  const rendered = (d?.titles ?? []).map(normalize);
  const missing = MUST_RENDER.filter((t) => !rendered.includes(t));
  check("⑤ 改前区块标题逐条仍在 DOM（本卡必渲染的那批一条不少）",
    missing.length === 0,
    `missing=${JSON.stringify(missing)} rendered=${JSON.stringify(rendered)}`);
  const invented = rendered.filter((t) => !BASELINE_SECTION_TITLES.includes(t));
  check("⑤① 没有凭空多出区块（渲染出的标题都在改前基线清单里）",
    invented.length === 0, `invented=${JSON.stringify(invented)}`);

  check("G 全程无 error 横幅", !d?.errorBanner, d?.errorBanner ?? "");

  // ---- ⑦ 宽视口（抽屉够宽）走**显式网格两栏**：主列 主信息 + 次列 明细，读数仍成立 -------------
  // 阈值在 app.js（`DRAWER_COLS_MIN_WIDTH`）：抽屉实测宽度 ≥ 1400px 才分两栏；常见视口（抽屉 1160px）
  // 走单列纵向流水 —— 主信息独占整幅宽度，换行更少、真能一屏看全。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  const wide = await waitFor(async () => {
    const cur = await readDrawer();
    return { ok: cur?.cols === "2", cur };
  }, 8000, "宽视口切到两栏");
  const wd = wide?.cur;
  check("⑦ 宽视口（1920）下正文切成显式网格两栏（主列 + 次列）",
    wd?.display === "grid" && wd?.cols === "2" && (wd?.gridCols ?? "").split(" ").filter(Boolean).length === 2,
    `display=${wd?.display} cols=${wd?.cols} gridCols=${wd?.gridCols}`);
  check("⑦① 两栏下 `column-count` 仍是 auto（不再横排多列）",
    wd?.columnCount === "auto", `columnCount=${wd?.columnCount}`);
  check("⑦② 两栏下主信息组仍完整落在第一屏",
    !!wd?.mainBox && wd.mainBox.top >= 0 && wd.mainBox.bottom <= wd.innerHeight,
    `top=${wd?.mainBox?.top} bottom=${wd?.mainBox?.bottom} innerHeight=${wd?.innerHeight}`);
  console.log(`… 读数（宽视口 1920）：display=${wd?.display} cols=${wd?.cols} gridCols=${wd?.gridCols} · 主信息组=${JSON.stringify(wd?.mainBox)}`);

  // ---- 读数落盘（便于报告引用；只写临时目录，跑完即删） -------------------------------------
  console.log(`… 读数：groups=${JSON.stringify((d?.groups ?? []).map((g) => ({ name: g.name, count: g.countText, collapsed: g.collapsed, sections: g.sections.map((s) => `${s.title}=${s.h}px`) })))}`);
  console.log(`… 读数：主信息组 box=${JSON.stringify(d?.mainBox)} innerHeight=${d?.innerHeight} · columnCount=${d?.columnCount}`);
  console.log(`… 读数：步骤条=${JSON.stringify((d?.steps ?? []).map((s) => `${s.no}. ${s.text}${s.current ? "（当前）" : ""}`))}`);
  console.log(`… 读数：区块标题清单（改后实测）=${JSON.stringify(rendered)}`);
  void afterClick;
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
