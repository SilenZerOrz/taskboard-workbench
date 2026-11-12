/**
 * 配置页「复制开局提示词」—— **是否真的带上了当前项目与工作目录**验证台（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（卡 `-243` / 需求 `R177`）
 * 真机（2026-11-12）：新建项目 → 新开会话 → 配置页「复制开局提示词」→ 会话里的 agent 调
 * `taskboard_context`，其 cwd 匹配不到任何项目 ⇒ `src/core/binding.mjs` 的 `matchProjectForCwd`
 * **静默回落默认项目** ⇒ agent 按 `taskboard-workbench` 的目录读 `AGENTS.md`、`scada-docs/`，跨项目误操作风险。
 * 根因：这条提示词是**一条纯静态常量**，工作目录写死尖括号占位符，从**任何**项目复制出来都一字不差。
 *
 * ## 为什么必须真渲染 + 真剪贴板
 * 单测（`tests/kickoff-prompt-project.test.mjs`）只能证明「函数按入参插值」；
 * 它**证明不了**三件只有真渲染才知道的事：
 *   ① 复制按钮**点下去真把现算的文本送进剪贴板**（不是复制了另一份常量、也不是点了没反应）；
 *   ② 从**顶部下拉切到另一个项目**之后，复制的是**新项目**（`info.project` 是全局绑定、不跟着下拉变 ——
 *      拿它插值会得到「界面写着 B、复制出来是 A」，与本次要修的 bug 同型）；
 *   ③ 界面上**人看得见**「这次会带哪个项目/哪个目录」（否则按钮在 = 无从判断，正是 bug 藏身之处）。
 * 故本台用**页内剪贴板 spy**（覆写 `navigator.clipboard.writeText` 记录实参）读**真实投递的文本**。
 *
 * ## 本台断言什么（种子：项目 A 有 workspacePath · 项目 B 另有 workspacePath · 项目 C 未设）
 *   A. 开工语行唯一一个「复制开局提示词」按钮，徽标就是「开工语」；
 *   B. 选中项目 A ⇒ 界面明文写出「开工语已带上：项目 A · 工作目录 <wsA>」（不用点也能看出带的是谁）；
 *   C. 点按钮 ⇒ 剪贴板 spy 真收到文本，且横幅「已复制」；
 *   D. 捕获文本含 `项目：A` 与 `工作目录：<wsA>`（逐字真实绝对路径）；
 *   E. 捕获文本**不含**尖括号占位符，且「工作目录」行排在 ① 之前；
 *   F. 顶部下拉切到项目 B ⇒ 再复制 ⇒ 文本含 B 的 id + B 的路径，且**不含** A 的路径（反向对照：拿错项目 ⇒ 红）；
 *   G. 切到未设 workspacePath 的项目 C ⇒ 文本写「（项目未设 workspacePath → 请先在配置页补）」，
 *      界面 hint 也如实说「未设 workspacePath」，且不出现 `工作目录：undefined/null`；
 *   H. 正常路径无 error 横幅。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=<旧版 web 目录> node tools/bench-kickoff-prompt.mjs`
 *   旧形态（静态常量 + 占位符 + 无 hint 行）⇒ B/D/E/F/G 转红（实测 5 条）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区 + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-kickoff-prompt.mjs`
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

/** 页内剪贴板 spy：**在任何页面脚本之前**注入，记录 writeText 的实参（真投递的文本）。 */
const CLIP_SPY = `(() => {
  try {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (t) => { window.__CLIP__ = String(t); return Promise.resolve(); } },
    });
  } catch (e) { window.__CLIP_SPY_ERR__ = String(e); }
})();`;

let chrome = null;
let chromeProfile = null;
const servers = [];
const tmpDirs = [];

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-kick-prompt-chrome-"));
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
  // 剪贴板 spy 必须在 app.js 之前装好（app.js 一加载就把 copyText 绑到 navigator.clipboard 上）。
  await S("Page.addScriptToEvaluateOnNewDocument", { source: CLIP_SPY });
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };

  // ---- 种子：A 有工作目录 / B 另有工作目录 / C 未设工作目录（三个项目都真建库） ----
  const wsA = await mkdtemp(path.join(os.tmpdir(), "tb-kick-ws-a-"));
  const wsB = await mkdtemp(path.join(os.tmpdir(), "tb-kick-ws-b-"));
  tmpDirs.push(wsA, wsB);
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-kick-prompt-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "proj-a", name: "项目甲", workspacePath: wsA });
  store.createProject({ id: "proj-b", name: "项目乙", workspacePath: wsB });
  store.createProject({ id: "proj-c", name: "项目丙" }); // 故意不设 workspacePath
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

  /** 顶部「项目」下拉切到指定项目，并等配置卡按新项目重渲染。 */
  const selectProject = async (projectId, marker) => {
    const switched = await evalJs(`(() => {
      const sel = document.querySelector('#tb-app select[aria-label="选择项目"]');
      if (!sel) return 'no-select';
      sel.value = ${JSON.stringify(projectId)};
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return sel.value;
    })()`);
    for (let i = 0; i < 60; i += 1) {
      const text = await evalJs(`(() => {
        const card = [...document.querySelectorAll('#tb-app .config-card')]
          .find((c) => (c.querySelector('h3')?.textContent ?? '').includes('开局向导'));
        return card ? (card.textContent ?? '') : '';
      })()`);
      if (text && text.includes(marker)) return { switched, text };
      await sleep(150);
    }
    return { switched, text: null };
  };

  /** 读开局向导卡：开工语行、复制按钮、hint 行、error 横幅。 */
  const readGuide = () => evalJs(`(() => {
    const root = document.querySelector('#tb-app');
    const card = [...root.querySelectorAll('.config-card')]
      .find((c) => (c.querySelector('h3')?.textContent ?? '').includes('开局向导'));
    if (!card) return { ok: false, note: 'no 开局向导 card' };
    const rows = [...card.querySelectorAll('.config-row')].map((r) => ({
      badge: (r.querySelector('.chip')?.textContent ?? '').trim(),
      text: (r.textContent ?? '').trim(),
      buttons: [...r.querySelectorAll('button')].map((b) => b.textContent.trim()),
    }));
    const err = root.querySelector('.banner.error');
    return {
      ok: true, rows,
      hints: [...card.querySelectorAll('p.hint')].map((p) => (p.textContent ?? '').trim()),
      error: err && !err.hidden ? (err.textContent ?? '') : null,
      banner: (root.querySelector('.banner')?.textContent ?? '').trim(),
    };
  })()`);

  /** 点开工语行的「复制开局提示词」，等剪贴板 spy 收到文本（返 { clip, banner, spyErr }）。 */
  const clickCopy = async () => {
    const clicked = await evalJs(`(() => {
      const card = [...document.querySelectorAll('#tb-app .config-card')]
        .find((c) => (c.querySelector('h3')?.textContent ?? '').includes('开局向导'));
      if (!card) return 'no-card';
      const b = [...card.querySelectorAll('button')].find((n) => n.textContent.trim() === '复制开局提示词');
      if (!b) return 'no-btn';
      window.__CLIP__ = null;
      b.click();
      return 'clicked';
    })()`);
    let clip = null;
    for (let i = 0; i < 40; i += 1) {
      clip = await evalJs(`(() => window.__CLIP__ ?? null)()`);
      if (clip) break;
      await sleep(100);
    }
    const banner = await evalJs(`(() => (document.querySelector('#tb-app .banner')?.textContent ?? '').trim())()`);
    const spyErr = await evalJs(`(() => window.__CLIP_SPY_ERR__ ?? null)()`);
    return { clicked, clip, banner, spyErr };
  };

  await navToConfig();
  await sleep(400);

  // ---------- A/B：项目甲默认选中时的开工语行 ----------
  const aSel = await selectProject("proj-a", "项目甲");
  const gA = await readGuide();
  const kickRow = gA.ok ? gA.rows.find((r) => r.badge === "开工语") : null;
  const copyBtns = gA.ok ? gA.rows.flatMap((r) => r.buttons).filter((b) => b === "复制开局提示词") : [];
  check("A 开工语行有唯一的「复制开局提示词」按钮",
    Boolean(kickRow) && copyBtns.length === 1,
    gA.ok ? `selected=${aSel.switched} kickRow=${Boolean(kickRow)} matches=${copyBtns.length}` : gA.note);
  const hintA = gA.ok ? gA.hints.find((h) => h.startsWith("开工语已带上")) ?? null : null;
  check("B 界面明文写出「带哪个项目 / 哪个工作目录」（不必点也能看出）",
    Boolean(hintA) && hintA.includes("proj-a") && hintA.includes(wsA),
    hintA ? `hint=${hintA}` : `hints=${JSON.stringify(gA.hints ?? [])}`);

  // ---------- C/D/E：点一下，读剪贴板里**真投递的文本** ----------
  const copyA = await clickCopy();
  check("C 点按钮 ⇒ 剪贴板真收到文本 + 横幅「已复制」",
    Boolean(copyA.clip) && String(copyA.banner ?? "").includes("已复制"),
    `clicked=${copyA.clicked} clip=${copyA.clip ? `${copyA.clip.length} 字节` : "null"} banner=${copyA.banner}${copyA.spyErr ? ` spyErr=${copyA.spyErr}` : ""}`);
  const textA = String(copyA.clip ?? "");
  check("D 复制文本含 `项目：proj-a` 与 `工作目录：<真实绝对路径>`",
    textA.includes("项目：proj-a") && textA.includes(`工作目录：${wsA}`),
    `项目行=${textA.split("\n")[1] ?? "(空)"} · 工作目录行=${textA.split("\n")[2] ?? "(空)"}`);
  check("E 复制文本不含尖括号占位符，且工作目录行排在 ① 之前",
    !textA.includes("<项目绝对路径>") && !/工作目录：\s*[<‹]/.test(textA)
      && textA.indexOf("工作目录：") >= 0 && textA.indexOf("工作目录：") < textA.indexOf("① ".trim()),
    `placeholder=${textA.includes("<项目绝对路径>")} dirIdx=${textA.indexOf("工作目录：")} stepIdx=${textA.indexOf("①")}`);

  // ---------- F：切到项目乙，复制出来的必须是乙（反向对照的核心） ----------
  const bSel = await selectProject("proj-b", "项目乙");
  const gB = await readGuide();
  const copyB = await clickCopy();
  const textB = String(copyB.clip ?? "");
  check("F 顶部下拉切到项目乙 ⇒ 复制文本跟着换成乙的 id + 乙的路径（不残留甲的路径）",
    textB.includes("项目：proj-b") && textB.includes(`工作目录：${wsB}`) && !textB.includes(wsA),
    `switched=${bSel.switched} · 项目行=${textB.split("\n")[1] ?? "(空)"} · 残留甲路径=${textB.includes(wsA)} · hint=${(gB.hints ?? []).find((h) => h.startsWith("开工语已带上")) ?? "无"}`);

  // ---------- G：未设 workspacePath 的项目丙 ----------
  await selectProject("proj-c", "项目丙");
  const gC = await readGuide();
  const copyC = await clickCopy();
  const textC = String(copyC.clip ?? "");
  const hintC = (gC.hints ?? []).find((h) => h.startsWith("⚠") || h.includes("未设 workspacePath")) ?? null;
  check("G 未设 workspacePath ⇒ 文本写「请先在配置页补」+ 界面如实提示，不写 undefined/null",
    textC.includes("（项目未设 workspacePath → 请先在配置页补）")
      && !/工作目录：\s*(undefined|null)?\s*$/m.test(textC)
      && !textC.includes("undefined") && !textC.includes("null")
      && Boolean(hintC) && hintC.includes("未设 workspacePath"),
    `工作目录行=${textC.split("\n")[2] ?? "(空)"} · hint=${hintC ?? "无"}`);

  check("H 正常路径无 error 横幅", gC.ok && gC.error === null, gC.ok ? (gC.error ?? "无") : gC.note);
} finally {
  clearTimeout(watchdog);
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  for (const { server, store, dataDir } of servers) {
    try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { store.close?.(); } catch { /* ignore */ }
    try { await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of tmpDirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
process.exit(failed.length ? 1 : 0);
