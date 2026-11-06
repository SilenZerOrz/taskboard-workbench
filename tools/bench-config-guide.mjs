/**
 * 配置页「开局向导」—— **步骤语义与真实判据**验证台（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-228` / 需求 `R169`）
 * 真机批注（2026-11-05）：「**为什么开局提示词在第八步**，任务工作台的配置请重新审核是否正确，并按真实代码优化」。
 *
 * 审核出的两个「假判据」都只有真渲染才看得见（源码里它们长得和别的步骤一模一样）：
 *   ① 「开局提示词」被写成**第 8 步**且 `ok` 恒 `false` ⇒ 永久 ○，读起来像「还剩一件没做完」；
 *      而它其实是**新会话的第一条消息**（`KICKOFF_PROMPT` 的 ①–⑧ 就是整套流程），根本没有完成态；
 *   ② 「创建执行团队」也是 `ok` 恒 `false` ⇒ 永久 ○；且与第 3 步发的是**同一个** `teamPrompt`（重复按钮）。
 * 另有一处**计数口径偏**：「已确认」只数 `status==='open'` ⇒ 已交付（done/closed）的条目不算，
 * 本项目 164 条全确认却显示「已确认 3」。
 *
 * ## 本台断言什么（种子：envConfig ✓ / 团队模板 ✓ / 资料清单 ✓ / 条目 2 done + 1 open + 1 draft / 1 张卡）
 *   A. 卡标题写明「7 步」（不再含糊）；
 *   B. 全卡**没有**「第 8 步」（开工语不再伪装成步骤）；
 *   C. 步骤徽标 `第 1…第 7 步` 各出现一次且按 DOM 顺序递增；
 *   D. 「开工语」行排在「第 1 步」**之前**（它是第一条消息，不是收尾）；
 *   E. 开工语行有「复制开局提示词」按钮，且徽标文案就是「开工语」（不编号、不参与 ✅/○）；
 *   F. 第 4 步徽标是 `◐`（待核验）而**不是** `○`（谎报未做）—— 本机无第三方团队产物；
 *   G. 第 6 步 hint = 「待确认 1 · 已确认 3」（done/closed 计入已确认）；
 *   H. 「复制团队创建指令」全卡**唯一**（第 3/4 步不再各发一个）；
 *   I. 其余步骤（1/2/3/5/6/7）为 ✅（种子全满足 ⇒ 防「一刀切改灰」）；
 *   J. 正常路径无 error 横幅。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-config-guide.mjs`
 *   旧形态：有「第 8 步」· 第 4 步 ○ · 已确认 1 · 两个创建指令按钮 ⇒ A/B/C/D/F/G/H 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 Chrome ⇒ 本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-config-guide.mjs`
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

let chrome = null;
let chromeProfile = null;
const servers = [];

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-guide-chrome-"));
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

  // ---- 种子：把 7 步的判据全部满足，再把「条目」做成 2 done + 1 open + 1 draft ----
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-guide-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  store.saveProjectSettings("default", {
    envConfig: { NODE_ENV: "test" },
    teamTemplate: { engine: "instruction", roles: [{ role: "engineer", count: 1 }] },
  });
  store.ensureRequirementDoc("default", { body: "# 需求\n\n## 资料清单\n\n- a.md\n- b.md\n" });
  store.createRequirementItem({ projectId: "default", title: "已交付 1", status: "done" });
  store.createRequirementItem({ projectId: "default", title: "已交付 2", status: "closed" });
  store.createRequirementItem({ projectId: "default", title: "已确认待做", status: "open" });
  store.createRequirementItem({ projectId: "default", title: "尚未确认", status: "draft" });
  store.createTask({ projectId: "default", title: "看板任务 1", status: "backlog" });
  const server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  servers.push({ server, store, dataDir });
  const base = `http://127.0.0.1:${port}`;

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2400);

  const navToConfig = async () => {
    for (let i = 0; i < 30; i += 1) {
      const r = await evalJs(`(() => {
        const root = document.querySelector('#tb-app');
        if (!root) return 'no-root';
        const b = [...root.querySelectorAll('header button')].find((n) => n.textContent.trim() === '配置');
        if (!b) return 'no-btn';
        b.click(); return 'clicked';
      })()`);
      if (r === "clicked") break;
      await sleep(200);
    }
    for (let i = 0; i < 40; i += 1) {
      const ok = await evalJs(`(() => !!document.querySelector('#tb-app .config-view .config-card'))()`);
      if (ok) return true;
      await sleep(150);
    }
    return false;
  };
  await navToConfig();
  await sleep(400);

  /** 读「开局向导」卡：标题 / 每行徽标 / 行文本 / 行内按钮 / 全卡按钮。 */
  const readGuide = () => evalJs(`(() => {
    const root = document.querySelector('#tb-app');
    const card = [...root.querySelectorAll('.config-card')]
      .find((c) => (c.querySelector('h3')?.textContent ?? '').includes('开局向导'));
    if (!card) return { ok: false, note: 'no 开局向导 card' };
    const rows = [...card.querySelectorAll('.config-row')].map((r) => ({
      badge: (r.querySelector('.chip')?.textContent ?? '').trim(),
      text: (r.textContent ?? '').trim().slice(0, 90),
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()),
    }));
    const notice = root.querySelector('.banner.error');
    return {
      ok: true, title: (card.querySelector('h3')?.textContent ?? '').trim(),
      text: (card.textContent ?? ''), rows,
      allButtons: [...card.querySelectorAll('button')].map((b) => b.textContent.trim()),
      error: notice && !notice.hidden ? (notice.textContent ?? '') : null,
    };
  })()`);

  const g = await readGuide();

  const badgeNums = g.ok ? g.rows.map((r) => {
    const m = /第\s*(\d+)\s*步/.exec(r.badge);
    return m ? Number(m[1]) : null;
  }).filter((n) => n != null) : [];

  check("A 卡标题写明「7 步」", g.ok && g.title.includes("7 步"), g.ok ? `title=${g.title}` : g.note);
  check("B 全卡没有「第 8 步」（开工语不再伪装成步骤）",
    g.ok && !/第\s*8\s*步/.test(g.text) && !badgeNums.includes(8),
    g.ok ? `badges=${JSON.stringify(g.rows.map((r) => r.badge))}` : g.note);
  check("C 步骤徽标 1–7 各一次且按 DOM 顺序递增",
    g.ok && JSON.stringify(badgeNums) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
    g.ok ? `nums=${JSON.stringify(badgeNums)}` : g.note);

  const kickIdx = g.ok ? g.rows.findIndex((r) => r.badge === "开工语") : -1;
  const step1Idx = g.ok ? g.rows.findIndex((r) => /第\s*1\s*步/.test(r.badge)) : -1;
  check("D 「开工语」行排在「第 1 步」之前",
    kickIdx >= 0 && step1Idx > kickIdx,
    `kickIdx=${kickIdx} step1Idx=${step1Idx}`);
  check("E 开工语行有「复制开局提示词」且徽标不编号",
    kickIdx >= 0 && g.rows[kickIdx].buttons.includes("复制开局提示词"),
    kickIdx >= 0 ? `badge=${g.rows[kickIdx].badge} buttons=${JSON.stringify(g.rows[kickIdx].buttons)}` : "no 开工语 row");

  const step4 = g.ok ? g.rows.find((r) => /第\s*4\s*步/.test(r.badge)) : null;
  check("F 第 4 步是 ◐ 待核验（不谎报成 ○ 未做）",
    Boolean(step4) && step4.badge.startsWith("◐"),
    step4 ? `badge=${step4.badge} text=${step4.text}` : "no step4");

  const step6 = g.ok ? g.rows.find((r) => /第\s*6\s*步/.test(r.badge)) : null;
  check("G 第 6 步「已确认」计入 done/closed（待确认 1 · 已确认 3）",
    Boolean(step6) && step6.text.includes("待确认 1") && step6.text.includes("已确认 3"),
    step6 ? `text=${step6.text}` : "no step6");

  const createCmds = g.ok ? g.allButtons.filter((b) => b === "复制团队创建指令" || b === "复制创建指令" || b.startsWith("复制创建指令")) : [];
  check("H 「复制团队创建指令」全卡唯一", g.ok && createCmds.length === 1, `matches=${JSON.stringify(createCmds)}`);

  const okSteps = g.ok ? [1, 2, 3, 5, 6, 7].map((n) => {
    const row = g.rows.find((r) => new RegExp(`第\\s*${n}\\s*步`).test(r.badge));
    return row ? row.badge.startsWith("✅") : false;
  }) : [];
  check("I 其余 6 步为 ✅（种子全满足 ⇒ 防一刀切改灰）",
    okSteps.length === 6 && okSteps.every(Boolean),
    g.ok ? `badges=${JSON.stringify(g.rows.map((r) => r.badge))}` : g.note);

  check("J 正常路径无 error 横幅", g.ok && g.error === null, g.ok ? (g.error ?? "无") : g.note);
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
