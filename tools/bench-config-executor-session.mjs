#!/usr/bin/env node
/**
 * 配置页「执行会话（派生）」—— **渲染层**验证台（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-271` / 需求 `R187` 验收④）
 *
 * `R187` 的验收④写的是：「**配置页**「会话关联」能看到派生执行会话并标注来源，
 * **只读不可手工解除**」。上一轮（`-263`）把这条落成了 API（`/api/projects/:id/sessions`
 * 回包多一个 `executors`）+ 前端源码（多一行「⚙ 执行会话（派生）」），
 * 但**没有真浏览器读数** —— 本仓的教训反复是同一句：**源码门 ≠ 渲染门**。
 *
 * 这一条有三种「源码看着对、界面上不对」的坑：
 *   ① 派生行写在了一个**永远不触发**的分支里（`sessList.executors` 拿不到 / 字段名写错）；
 *   ② 「标注来源」只写在服务端，前端把 `executor` 这个生词直接印给人看；
 *   ③ 「只读不可手工解除」被做成了一行**能点解除**的按钮（那就等于给派生绑定开了后门）。
 *
 * ## 本台断言什么
 *   A. **门是开的**（本卡的真正目的）：以执行会话身份挂载面板 ⇒ 不出现「当前会话未绑定该项目的工作台」，
 *      看板可见 —— 也就是「执行会话能打开工作台」在**渲染层**成立；
 *   B. **门没被拆掉**：陌生会话挂载 ⇒ 门页照旧出现（四视图被挡）；
 *   C. 配置页「本会话角色」= 「执行会话（按任务归属派生）· 任务 <编号>」（中文化 + 说得出依据）；
 *   D. 「会话关联」卡里有「执行会话（派生）」行；
 *   E. 该行标注了**任务编号**与**自动收回**（来源与生命周期说得出）；
 *   F. 该行**没有**解除 / 解绑 / 移除类按钮（只读不可手工解除），只有「打开会话」；
 *   G. 正常路径不出现 error 横幅。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=<旧版 web 副本> node tools/bench-config-executor-session.mjs`
 *   旧版前端没有派生行 ⇒ C/D/E/F 转红（**A/B 仍绿** —— 那两条是服务端行为，前端旧不旧都一样）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写真实看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-config-executor-session.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
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
  approved: "session-bench-appr-0002",
  exec: "session-bench-exec-0003",
  stranger: "session-bench-stranger-0004",
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
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-execrow-chrome-"));
  const debugPort = await freePort();
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let t0 = Date.now(); Date.now() - t0 < 30000;) {
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

  // 种子数据：项目 + 主会话 + 已批准会话 + **执行会话**（只写 tasks.session_id，不写批准表）
  const hostCalls = [];
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-execrow-data-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目", workspacePath: "/repo/default" });
  store.bindInitialSession("default", IDS.main);
  store.approveSessionAssociation("default", IDS.approved);
  const reqItem = store.createRequirementItem({ projectId: "default", title: "R-执行会话" });
  const execTask = store.createTask({ projectId: "default", title: "执行会话在干的卡", status: "todo" });
  store.associateRequirementTask(reqItem.id, execTask.id);
  store.startTaskExecution(execTask.identifier, { sessionId: IDS.exec });
  store.hostSessionPort = makeHostStub(hostCalls);
  const server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  servers.push({ server, store, dataDir });
  const base = `http://127.0.0.1:${port}`;

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2500);

  /** 挂一块**带会话身份**的面板（宿主内嵌时就是这么注入 session 的）。 */
  const mountSpy = async (rootId, session) => {
    await evalJs(`(() => {
      const div = document.createElement('div');
      div.id = ${JSON.stringify(rootId)};
      div.style.cssText = 'position:fixed;left:0;top:0;width:1400px;height:1000px;background:#fff;z-index:99999;overflow:auto';
      document.body.appendChild(div);
      window.__SPY__ = [];
      window[${JSON.stringify(`__SPY_BOARD_${rootId}__`)}] = window.__TB_BOARD__.createBoard({
        root: div, apiBase: '',
        session: ${JSON.stringify(session)},
        openSession: (id) => { window.__SPY__.push(String(id)); return { ok: true }; },
      });
      return true;
    })()`);
    await sleep(2600);
  };

  /**
   * 读「会话关联（主会话批准）」卡：kv 行（dl.kv）+ 每行的标签/文案/按钮。
   *
   * ⚠ 必须按 **h3 精确标题**定位 —— 配置页有两张标题都含「会话关联」的卡：
   * 「会话区 / 会话关联」（静态说明：任务归属 / 入口位置）与「会话关联（主会话批准）」（本轮目标）。
   * 首版写成 `textContent.includes('会话关联')` ⇒ 命中的是**同壳兄弟卡**，C/D/E/F 四条假红
   * （读数 `rows=["来源会话"]` 正是那张旧卡的唯一行）。这是本仓已记过的坑：
   * 复用壳的验证台必须排除同壳兄弟（见 AGENTS.md 2026-10-29 那条 `tb-req-drawer` 教训）。
   */
  const CONFIG_CARD_TITLE = "会话关联（主会话批准）";
  const readConfigCard = (rootSel) => evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    if (!root) return { ok: false, note: 'no root' };
    const titles = [...root.querySelectorAll('.config-card h3')].map((h) => (h.textContent || '').trim());
    const want = ${JSON.stringify(CONFIG_CARD_TITLE)};
    const card = [...root.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent ?? '').trim() === want);
    if (!card) return { ok: false, note: 'no card titled ' + want + '; cards=' + JSON.stringify(titles) };
    const kv = {};
    for (const d of card.querySelectorAll('dl.kv')) {
      const dts = [...d.querySelectorAll('dt')];
      const dds = [...d.querySelectorAll('dd')];
      dts.forEach((dt, i) => { if (dds[i]) kv[(dt.textContent || '').trim()] = (dds[i].textContent || '').trim(); });
    }
    const rows = [...card.querySelectorAll('.config-row')].map((r) => ({
      label: (r.querySelector('span')?.textContent ?? '').trim(),
      title: r.querySelector('span[title]')?.getAttribute('title') ?? '',
      text: (r.textContent || '').trim(),
      buttons: [...r.querySelectorAll('button')].map((b) => ({ text: (b.textContent || '').trim(), disabled: b.disabled === true })),
    }));
    return { ok: true, kv, rows, cardTitles: titles };
  })()`);

  /** 门页 / 看板可见性：门文案在不在、看板在不在。 */
  const readViews = (rootSel) => evalJs(`(() => {
    const root = document.querySelector(${JSON.stringify(rootSel)});
    if (!root) return { ok: false, note: 'no root' };
    const mains = [...root.querySelectorAll('main.board-scroll')];
    const visible = mains.filter((m) => m.hidden !== true).map((m) => m.firstElementChild?.className ?? '');
    return {
      ok: true,
      visible,
      gate: (root.textContent || '').includes('当前会话未绑定该项目的工作台'),
      board: Boolean(root.querySelector('.board')),
    };
  })()`);

  const navToConfig = async (rootSel) => {
    for (let i = 0; i < 30; i += 1) {
      const r = await evalJs(`(() => {
        const root = document.querySelector(${JSON.stringify(rootSel)});
        if (!root) return "no-root";
        const b = [...root.querySelectorAll("header button")].find((n) => n.textContent.trim() === "配置");
        if (!b) return "no-btn";
        b.click();
        return "clicked";
      })()`);
      if (r === "clicked") break;
      await sleep(200);
    }
    for (let i = 0; i < 40; i += 1) {
      const ok = await evalJs(`(() => { const root = document.querySelector(${JSON.stringify(rootSel)}); return Boolean(root && root.querySelector(".config-view")); })()`);
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };

  // ================= A · C–F：执行会话身份挂载的面板 =================
  await mountSpy("exec-root", IDS.exec);
  const execViews = await readViews("#exec-root");
  check("A1 执行会话打开工作台**不是**门页（「当前会话未绑定…」不出现）",
    execViews.ok && execViews.gate === false,
    execViews.ok ? `gate=${execViews.gate} visible=${JSON.stringify(execViews.visible)}` : execViews.note);
  check("A2 执行会话下看板可见（不是空壳）",
    execViews.ok && execViews.board === true && execViews.visible.includes("board"),
    execViews.ok ? `board=${execViews.board} visible=${JSON.stringify(execViews.visible)}` : execViews.note);

  await navToConfig("#exec-root");
  const execCard = await readConfigCard("#exec-root");
  const roleText = execCard.ok ? (execCard.kv["本会话角色"] ?? "") : "";
  check("C 配置页「本会话角色」= 执行会话（按任务归属派生）· 任务 <编号>",
    roleText.includes("执行会话") && roleText.includes("派生") && roleText.includes(execTask.identifier),
    `本会话角色=${roleText || "(缺)"}`);

  const derivedRow = execCard.ok ? execCard.rows.find((r) => r.label.includes("执行会话（派生）")) : null;
  check("D 「会话关联」卡里有「执行会话（派生）」行",
    Boolean(derivedRow),
    derivedRow ? `label=${derivedRow.label}` : `rows=${JSON.stringify((execCard.rows ?? []).map((r) => r.label))} cards=${JSON.stringify(execCard.cardTitles ?? [])} note=${execCard.ok ? "located" : execCard.note}`);
  check("E 该行标注了任务编号与「自动收回」（来源与生命周期说得出）",
    Boolean(derivedRow) && derivedRow.text.includes(execTask.identifier) && derivedRow.text.includes("自动收回"),
    derivedRow ? `text=${derivedRow.text.replace(/\s+/g, " ").slice(0, 120)}` : "无该行");
  const revokePattern = /(解除|解绑|移除|撤销|取消关联)/;
  check("F 该行**只读**：没有解除/解绑/移除类按钮（只有「打开会话」）",
    Boolean(derivedRow) && derivedRow.buttons.length > 0
      && derivedRow.buttons.every((b) => !revokePattern.test(b.text))
      && derivedRow.buttons.some((b) => b.text === "打开会话"),
    derivedRow ? `buttons=${JSON.stringify(derivedRow.buttons)}` : "无该行");

  // ================= B：陌生会话 —— 门必须还在 =================
  await mountSpy("stranger-root", IDS.stranger);
  const strangerViews = await readViews("#stranger-root");
  check("B 陌生会话仍然是门页（门没被整体拆掉）",
    strangerViews.ok && strangerViews.gate === true,
    strangerViews.ok ? `gate=${strangerViews.gate} visible=${JSON.stringify(strangerViews.visible)}` : strangerViews.note);

  // ================= G：正常路径无 error 横幅 =================
  const errBanner = await evalJs(`(() => {
    const root = document.querySelector('#exec-root');
    if (!root) return { ok: false };
    const all = [...root.querySelectorAll('.banner')].filter((b) => !b.hidden);
    const err = all.find((b) => b.classList.contains('error'));
    return { ok: true, error: err ? err.textContent : null };
  })()`);
  check("G 正常路径不出现 error 横幅", errBanner.ok && errBanner.error === null, errBanner.error ?? "无");
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
