/**
 * 配置页「会话关联」—— **直接跳转**验证台（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-227` / 需求 `R168`）
 * 真机批注（2026-11-05）：「增加会话关联对应主会话以及相关会话的直接跳转能力」。
 * 旧形态：主会话行 / 已批准会话行只有截断标识（`session-70a0bcda…`）+ 存活胶囊，
 * 想看那条会话在聊什么只能复制标识回侧栏翻 —— **面板里没有任何入口能把人送到那条会话**。
 *
 * 这一条有两个只有真跑才看得见的风险，源码断言一个都读不出：
 *   ① **"按钮在"≠"真跳了"**：`openSession(id)` 有没有被调用、id 传得对不对，必须真的点一下；
 *   ② **"跳不动"不能谎称成功**（`-211` 的老毛病）：没有宿主通道时必须如实说"无法直接跳转"。
 *
 * ## 本台断言什么
 *   A. hosted（假宿主通道）：会话关联卡里「打开会话」数量 = 1（主会话）+ 3（2 已批准 + 1 待批准）；
 *   B. hosted：能力齐备 ⇒ **一个都不许置灰**（防"过度置灰 = 静默删功能"，同第 13 台双向口径）；
 *   C. 带客户端通道的 board：点主会话 ⇒ `openSession` 收到**主会话 id**（精确相等）；
 *   D. 同 board：点第 1 条已批准 ⇒ 收到**那条**的 id；
 *   E. 同 board：点**待批准**那条 ⇒ 也能打开（存在不代表不能看历史）；
 *   F. 成功横幅含「已打开会话」+ 该 id 前缀；
 *   G. hosted 但**页面没有客户端通道**（autoMount 的 board）：点主会话 ⇒ 横幅**不得**说"已打开"，
 *      必须是「无法直接跳转」+ 已复制标识（不谎称）；
 *   H. hostless 服务器：所有「打开会话」**置灰**且 title 说明「无宿主会话通道」；
 *   I. hostless：常驻黄条可见（能力门整体在位）；
 *   J. 正常路径（带通道）点完**不出现 error 横幅**。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-config-session-jump.mjs`
 *   旧形态没有任何「打开会话」按钮 ⇒ A/B/C/D/E/F 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写真实看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-config-session-jump.mjs`
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

const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

const IDS = {
  main: "session-bench-main-0001",
  approved: ["session-bench-appr-0002", "session-bench-appr-0003"],
  pending: "session-bench-pend-0004",
};

/** 假宿主通道：形状对齐 `store.hostSessionPort`；`openSession` 记下真实收到的 id。 */
function makeHostStub(calls) {
  return {
    available: true,
    capabilities: () => ({ sessionController: true, prompt: true, create: true, agents: true, sessions: true, sessionQuery: true }),
    createSession: async () => ({ sessionId: "session-stub-created" }),
    sendPrompt: async () => ({ sent: true }),
    openSession: async (id) => { calls.push(String(id)); return { opened: true }; },
    listSessions: async () => ({ sessions: [], source: "sessionQuery.listSessions" }),
    sessionExists: async () => ({ exists: true }),
    sessionOrigin: async () => ({ cwd: null }),
    renameSession: async () => ({ renamed: true }),
    sessionState: () => ({ live: false }),
  };
}

let chrome = null;
let chromeProfile = null;
const servers = [];

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-sessjump-chrome-"));
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
  const { sessionId: cdpSession } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, cdpSession);
  await S("Page.enable");
  await S("Runtime.enable");
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };

  const bootServer = async ({ withHost, calls }) => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), withHost ? "tb-sessjump-on-" : "tb-sessjump-off-"));
    const store = openStore({ dataDir, env: {} });
    store.createProject({ id: "default", name: "默认项目" });
    store.bindInitialSession("default", IDS.main);
    for (const sid of IDS.approved) store.approveSessionAssociation("default", sid);
    store.requestSessionAssociation("default", IDS.pending);
    if (withHost) store.hostSessionPort = makeHostStub(calls);
    const server = createServer({ store, webDir: WEB_DIR });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    servers.push({ server, store, dataDir });
    return `http://127.0.0.1:${port}`;
  };

  const navTo = async (rootSel, label, waitSel) => {
    for (let i = 0; i < 30; i += 1) {
      const r = await evalJs(`(() => {
        const root = document.querySelector(${JSON.stringify(rootSel)});
        if (!root) return "no-root";
        const b = [...root.querySelectorAll("header button")].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
        if (!b) return "no-btn";
        b.click();
        return "clicked";
      })()`);
      if (r === "clicked") break;
      await sleep(200);
    }
    for (let i = 0; i < 40; i += 1) {
      const ok = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(rootSel + " " + waitSel)}); return !!el; })()`);
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };

  /** 读「会话关联」卡：每行的标签、「打开会话」是否存在/置灰/title。 */
  const readCard = (rootSel) => evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    const card = [...root.querySelectorAll('.config-card')]
      .find((c) => (c.textContent || '').includes('会话关联（主会话批准）'));
    if (!card) return { ok: false, note: 'no 会话关联 card' };
    const rows = [...card.querySelectorAll('.config-row')].map((r) => {
      const b = [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开会话');
      return {
        label: (r.querySelector('span')?.textContent ?? '').trim(),
        hasJump: Boolean(b),
        disabled: b ? b.disabled === true : null,
        title: b ? (b.title || '') : '',
      };
    });
    const notice = root.querySelector('.banner.warn');
    return { ok: true, rows, notice: !!notice && !notice.hidden, noticeText: notice?.textContent ?? '' };
  })()`);

  // ⚠ 按**行标签的 title（完整会话标识）**定位，不能按可见文本 —— 标签是 `session-bench-…` 截断，
  //   四条会话的前 14 字符完全一样（本台首版就因此错点了主会话，教训写进 -227 证据评论）。
  const clickJumpInRow = (rootSel, sessionId) => evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    const card = [...root.querySelectorAll('.config-card')]
      .find((c) => (c.textContent || '').includes('会话关联（主会话批准）'));
    if (!card) return { ok: false, note: 'no card' };
    const row = [...card.querySelectorAll('.config-row')].find((r) => (r.querySelector('span[title]')?.title ?? '') === ${JSON.stringify(sessionId)});
    if (!row) return { ok: false, note: 'no row for ' + ${JSON.stringify(sessionId)} };
    const b = [...row.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开会话');
    if (!b) return { ok: false, note: 'no jump button' };
    b.click();
    return { ok: true, disabled: b.disabled === true };
  })()`);

  const bannerIn = (rootSel) => evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    const all = [...root.querySelectorAll('.banner')].filter((b) => !b.hidden);
    const err = all.find((b) => b.classList.contains('error'));
    const info = all.find((b) => b.classList.contains('info'));
    return { error: err ? err.textContent : null, info: info ? info.textContent : null };
  })()`);

  // ================= A–B / G：hosted 服务器 + autoMount（无客户端通道） =================
  const hostedCalls = [];
  const onBase = await bootServer({ withHost: true, calls: hostedCalls });
  await S("Page.navigate", { url: `${onBase}/` });
  await sleep(2400);
  const onNav = await navTo("#tb-app", "配置", ".config-view");
  const cardOn = await readCard("#tb-app");
  check("A hosted：会话关联卡渲染出 1+3 个「打开会话」", cardOn.ok && cardOn.rows.filter((r) => r.hasJump).length === 4,
    cardOn.ok ? `rows=${cardOn.rows.length} jumps=${cardOn.rows.filter((r) => r.hasJump).length}` : cardOn.note);
  // ⚠ 必须**同时**要求数量 = 4：只看 `every()` 时，旧版「一个按钮都没有」会让空数组真空通过（本台首版即如此）。
  const jumpsOn = cardOn.ok ? cardOn.rows.filter((r) => r.hasJump) : [];
  check("B hosted：4 个「打开会话」都不许置灰（防过度置灰）",
    jumpsOn.length === 4 && jumpsOn.every((r) => r.disabled === false),
    cardOn.ok ? `jumps=${jumpsOn.length} ` + cardOn.rows.map((r) => `${r.label.slice(0, 8)}=${r.disabled}`).join(" ") : "");

  const autoClick = await clickJumpInRow("#tb-app", IDS.main);
  await sleep(400);
  const autoBanner = await bannerIn("#tb-app");
  check("G hosted 但页面无客户端通道：点主会话**不得**谎称「已打开」",
    autoClick.ok && autoClick.disabled === false
      && !String(autoBanner.info ?? "").includes("已打开会话")
      && String(autoBanner.error ?? "").includes("无法直接跳转")
      && String(autoBanner.error ?? "").includes(IDS.main.slice(0, 18)),
    `nav=${onNav} clicked=${JSON.stringify(autoClick)} info=${autoBanner.info ?? "-"} error=${autoBanner.error ?? "-"}`);

  // ================= C–F / J：同一服务器，另起一个**带客户端通道**的 board（spy） =================
  const spyReady = await evalJs(`(() => {
    window.__SPY__ = [];
    const div = document.createElement('div');
    div.id = 'spy-root';
    div.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:1000px;background:#fff;z-index:99999;overflow:auto';
    document.body.appendChild(div);
    window.__SPY_BOARD__ = window.__TB_BOARD__.createBoard({
      root: div, apiBase: "",
      openSession: (id) => { window.__SPY__.push(String(id)); return { ok: true }; },
    });
    return true;
  })()`);
  await sleep(2500);
  const spyNav = await navTo("#spy-root", "配置", ".config-view");
  const spyCard = await readCard("#spy-root");
  const clickMain = await clickJumpInRow("#spy-root", IDS.main);
  await sleep(350);
  const spy1 = await evalJs(`window.__SPY__.slice()`);
  const bannerMain = await bannerIn("#spy-root");
  check("C 点主会话 ⇒ openSession 收到**主会话 id**（精确相等）",
    spy1.length === 1 && spy1[0] === IDS.main,
    `calls=${JSON.stringify(spy1)} expect=${IDS.main}`);
  check("F 成功横幅含「已打开会话」+ 该 id 前缀",
    String(bannerMain.info ?? "").includes("已打开会话") && String(bannerMain.info ?? "").includes(IDS.main.slice(0, 18)),
    `info=${bannerMain.info ?? "-"}`);

  const clickAppr = await clickJumpInRow("#spy-root", IDS.approved[0]);
  await sleep(350);
  const spy2 = await evalJs(`window.__SPY__.slice()`);
  check("D 点已批准第 1 条 ⇒ 收到**那条**的 id（不是主会话、不是别的）",
    spy2.length === 2 && spy2[1] === IDS.approved[0],
    `calls=${JSON.stringify(spy2)}`);

  const clickPend = await clickJumpInRow("#spy-root", IDS.pending);
  await sleep(350);
  const spy3 = await evalJs(`window.__SPY__.slice()`);
  check("E 待批准那条也能打开（存在即可看历史）",
    spy3.length === 3 && spy3[2] === IDS.pending,
    `calls=${JSON.stringify(spy3)}`);

  const bannerAfter = await bannerIn("#spy-root");
  check("J 正常路径点完不出现 error 横幅", bannerAfter.error === null, bannerAfter.error ?? "无");

  // ================= H–I：hostless 服务器（无宿主端口） =================
  const offBase = await bootServer({ withHost: false, calls: [] });
  await S("Page.navigate", { url: `${offBase}/` });
  await sleep(2400);
  await navTo("#tb-app", "配置", ".config-view");
  const cardOff = await readCard("#tb-app");
  const jumpOff = cardOff.ok ? cardOff.rows.filter((r) => r.hasJump) : [];
  check("H hostless：「打开会话」全部置灰且 title 说明「无宿主会话通道」",
    jumpOff.length === 4 && jumpOff.every((r) => r.disabled === true && r.title.includes("无宿主会话通道")),
    jumpOff.length ? jumpOff.map((r) => `${r.disabled}/${r.title.slice(0, 16)}`).join(" | ") : `jumps=${jumpOff.length}`);
  check("I hostless：常驻黄条可见（能力门整体在位）", cardOff.ok && cardOff.notice === true && String(cardOff.noticeText).includes("/integrations/taskboard-workbench"),
    `notice=${cardOff.ok ? cardOff.notice : "?"}`);
} finally {
  clearTimeout(watchdog);
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  for (const { server, store, dataDir } of servers) {
    try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { store.close?.(); } catch { /* ignore */ }
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
process.exit(failed.length ? 1 : 0);
