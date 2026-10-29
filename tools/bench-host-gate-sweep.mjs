/**
 * 宿主能力门「全量扫台」—— **真 headless Chrome + CDP**，两种形态**双向对照**。
 *
 * ## 为什么需要这台（2026-10-29 二轮复核）
 * 用户要求「继续检查代码以及实机测试是否还有类似问题」——上一轮只覆盖了 7 个文案（投递/开会话/派发）。
 * 本轮把**同类漏网**（重建主会话、改绑/改指已有会话）补上，但这类修复有**两个方向的风险**：
 *   ① **漏置灰**：能力缺失却还能点 ⇒ 用户又撞一次墙（原报障）；
 *   ② **过度置灰**：能力其实在、或动作本来会降级，却被禁掉 ⇒ 把能用的功能删掉（更糟，而且没人报障，静默损失）。
 * 单测只能读源码文本，读不出"渲染后这个按钮到底能不能点"。所以必须真渲染、真读 `disabled`，并且**两种形态都跑**。
 *
 * ## 两种形态（同一份前端、同一份种子数据）
 *   A. **hostless**（不注入 `hostSessionPort`，等价 `:47830` 独立进程）⇒ 所有命中标签必须 `disabled`，常驻提示可见；
 *   B. **hosted**（注入**全能力 stub**：createSession / sendPrompt / openSession / listSessions / sessionExists / sessionOrigin / renameSession / sessionState）
 *      ⇒ 同一批标签必须**全部可点**，常驻提示隐藏。
 *   ⇒ 这样"漏置灰"与"过度置灰"都能被抓到。
 *
 * ## 扫哪些视图
 *   看板 → 需求（并点开条目详情抽屉）→ 推进 → 配置（并展开「改绑到本工作区已有会话…」）——
 *   四站覆盖当前全部宿主依赖入口。
 *
 * ## ⚠️ 维护约定
 *   本台的 `GATE_LABELS` 是 `web/app.js` 里 `HOST_BUTTON_LABELS` 的**副本**；
 *   `tests/host-gate.test.mjs` 会核对"本台每个标签都在 app 表里"，改一张表就会红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。**不碰 `:3080` / `:47830` / 仓库 `.data/`。**
 * ⚠️ 沙箱内起不了 Chrome —— 必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-host-gate-sweep.mjs`
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

/** 与 `web/app.js` 的 `HOST_BUTTON_LABELS` 保持同步（守卫测试会核对）。 */
const GATE_LABELS = [
  "投给主会话", "自动生成（交主会话）", "按意见重生成",
  "打开执行会话", "打开会话", "派发团队", "再派发一队",
  "重建并绑定主会话", "重建并绑定项目主会话", "重建主会话并把本任务改指过去",
  "改绑为主会话", "用当前会话作为项目主会话", "改指到项目主会话（本任务）",
];

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

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/** 全能力 stub：形状对齐 `store.hostSessionPort`（只读用途，本台不点任何会写数据的动作）。 */
function makeHostStub() {
  return {
    available: true,
    capabilities: () => ({ sessionController: true, prompt: true, create: true, agents: true, sessions: true, sessionQuery: true }),
    createSession: async () => ({ sessionId: "session-stub-main" }),
    sendPrompt: async () => ({ sent: true }),
    openSession: async () => ({ opened: true }),
    listSessions: async () => ({ sessions: [], source: "sessionQuery.listSessions" }),
    sessionExists: async () => ({ exists: true }),
    sessionOrigin: async () => ({ cwd: null }),
    renameSession: async () => ({ renamed: true }),
    sessionState: () => ({ live: false }),
  };
}

let chromeProfile = null;
let chrome = null;
const servers = [];

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-hostgate-chrome-"));
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
  if (!wsUrl) {
    console.log("SKIP  devtools 端点未就绪 ——本台不产证据，退出码 2");
    process.exit(2);
  }
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

  const collect = () => evalJs(`(() => {
    const LABELS = ${JSON.stringify(GATE_LABELS)};
    const hits = [...document.querySelectorAll('button')]
      .filter((b) => LABELS.includes(b.textContent.trim()))
      .map((b) => ({ label: b.textContent.trim(), disabled: b.disabled === true, title: b.title || '' }));
    const notice = document.querySelector('.banner.warn');
    const err = document.querySelector('.banner.error');
    return { hits, noticeShown: !!notice && !notice.hidden, noticeText: notice?.textContent ?? '', error: !!err && !err.hidden ? err.textContent : null };
  })()`);

  const clickNav = async (label, waitSelector) => {
    for (let i = 0; i < 30; i += 1) {
      const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)}); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
      if (r === "clicked") break;
      await sleep(200);
    }
    for (let i = 0; i < 40; i += 1) {
      const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(waitSelector)}); return !!el && !el.closest('[hidden]'); })()`);
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };

  /** 一站一站地扫，返回全部命中的宿主依赖按钮。 */
  const sweep = async (base) => {
    await S("Page.navigate", { url: `${base}/` });
    await sleep(2200);
    const all = [];
    const boards = await evalJs(`!!document.querySelector('.board')`);
    if (!boards) return { ok: false, all, notice: null, reason: "看板未渲染" };

    // 站 1：需求 + 条目详情抽屉（暴露「自动生成（交主会话）/ 按意见重生成」）
    if (await clickNav("需求", ".requirements-view")) {
      const opened = await evalJs(`(() => { const row = document.querySelector('.req-list .req-item'); if (!row) return false; row.click(); return true; })()`);
      if (opened) await sleep(1600);
      all.push(...(await collect()).hits);
      // 关掉需求抽屉，免得盖住后面的导航
      await evalJs(`(() => { const d = document.querySelector('.tb-req-drawer'); const btn = d ? [...d.querySelectorAll('.tb-drawer-head button')].find((b) => b.textContent.trim() === '✕') : null; if (btn) btn.click(); return !!btn; })()`);
      await sleep(400);
    }
    // 站 2：推进（「投给主会话」）
    if (await clickNav("推进", ".advance-view")) {
      await sleep(1200);
      all.push(...(await collect()).hits);
    }
    // 站 3：配置 + 展开「改绑到本工作区已有会话…」（暴露「改绑为主会话」）
    if (await clickNav("配置", ".config-view")) {
      await sleep(1200);
      const expanded = await evalJs(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '改绑到本工作区已有会话…'); if (!b) return false; b.click(); return true; })()`);
      if (expanded) {
        for (let i = 0; i < 20; i += 1) {
          const ready = await evalJs(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '改绑为主会话')`);
          if (ready) break;
          await sleep(200);
        }
      }
      all.push(...(await collect()).hits);
    }
    const last = await collect();
    // 去重（同一标签可能在多处出现，只留一份，disabled 取"任一可点即可点"的保守口径）
    const byLabel = new Map();
    for (const h of all) {
      const prev = byLabel.get(h.label);
      if (!prev) byLabel.set(h.label, h);
      else if (prev.disabled && !h.disabled) byLabel.set(h.label, h);
    }
    return { ok: true, all: [...byLabel.values()], notice: last.noticeShown, noticeText: last.noticeText, error: last.error };
  };

  const bootServer = async ({ withHost }) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), withHost ? "tb-hostgate-on-" : "tb-hostgate-off-"));
    const store = openStore({ dataDir, env: {} });
    store.createProject({ id: "default", name: "默认项目" });
    const doc = store.ensureRequirementDoc("default", { body: "# 需求\n" });
    const item = store.createRequirementItem({
      projectId: "default", title: "需要拆分的需求", status: "open", docId: doc.id,
      description: "用来把条目详情抽屉渲染出来（里面有「自动生成（交主会话）」）。",
    });
    store.createTask({ projectId: "default", title: "示例任务", status: "todo", requirementId: item.identifier });
    if (withHost) store.hostSessionPort = makeHostStub();
    const server = createServer({ store, webDir: WEB_DIR });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    servers.push({ server, store, dataDir });
    return `http://127.0.0.1:${port}`;
  };

  // ---- A. hostless（等价 :47830） ----
  const offBase = await bootServer({ withHost: false });
  const off = await sweep(offBase);
  check("A0 hostless：四站都能渲染并扫到东西（防空跑）", off.ok === true && off.all.length >= 3, `hits=${off.all.length}：${off.all.map((h) => h.label).join(" / ")}`);
  const offEnabled = off.all.filter((h) => !h.disabled);
  check("A1 hostless：**所有**宿主依赖按钮都必须置灰（漏一个就是又一次'点了才失败'）", off.all.length > 0 && offEnabled.length === 0, offEnabled.length ? `仍可点：${offEnabled.map((h) => h.label).join(" / ")}` : `全部 ${off.all.length} 个已置灰`);
  check("A2 hostless：置灰的每个都带「无宿主会话通道」说明", off.all.every((h) => h.disabled && h.title.includes("无宿主会话通道")), off.all.map((h) => h.title.slice(0, 20)).join(" | "));
  check("A3 hostless：常驻提示可见且指路", off.notice === true && String(off.noticeText).includes("/integrations/taskboard-workbench"), `shown=${off.notice}`);
  check("A4 hostless：扫台期间不得弹出错误横幅（能力门应把它挡在点击之前）", off.error === null, off.error ?? "无");

  // ---- B. hosted（全能力 stub） ----
  const onBase = await bootServer({ withHost: true });
  const on = await sweep(onBase);
  check("B0 hosted：四站都能渲染并扫到同一批标签", on.ok === true && on.all.length >= 3, `hits=${on.all.length}：${on.all.map((h) => h.label).join(" / ")}`);
  const onDisabled = on.all.filter((h) => h.disabled);
  check("B1 hosted：**不得过度置灰**（能力都在，按钮必须可点）", on.all.length > 0 && onDisabled.length === 0, onDisabled.length ? `被误禁：${onDisabled.map((h) => h.label).join(" / ")}` : `全部 ${on.all.length} 个可点`);
  check("B2 hosted：常驻提示必须隐藏（能力齐备时不该常驻黄条）", on.notice === false, `shown=${on.notice}`);
  const missing = off.all.map((h) => h.label).filter((l) => !on.all.some((h) => h.label === l));
  check("B3 两形态扫到的是**同一批**标签（否则 A/B 对照不成立）", missing.length === 0, missing.length ? `hosted 缺：${missing.join(" / ")}` : "一致");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `  ·  失败 ${failed.length} 条` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("FAIL  验证台异常：", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  for (const { server, store, dataDir } of servers) {
    try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { store.close(); } catch { /* ignore */ }
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
}
