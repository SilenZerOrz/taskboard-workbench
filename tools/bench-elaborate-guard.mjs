/**
 * 条目化护栏 —— 真实浏览器 DOM 验证台（真 headless Chrome + CDP）。卡 `-169` P4②。
 *
 * ## 为什么需要这台
 * 真机上一次规则拆解落库 **100 条 pending 候选**，其中 **0 条**是真需求（全是文件清单行）。
 * 根因两条：① `limit` 默认 100 且 body 传了不生效；② `auto` 在 AI 不可用时**静默跑规则并落库**，
 * 只加一个 `degraded:true` ——「其实没 AI」被包装成「看起来成功」。
 *
 * 单测（`tests/elaborate-guard.test.mjs`）证明得了「契约对不对」，证明不了
 * **按钮真的接上线、AI 不可用真的有人看得见、预览真的先出再写** —— 所以必须有这台。
 *
 * ## 断言
 *   A. 「需求文档」面板里有「AI 拆解（auto）」与「规则拆解（先预览）」两个按钮；
 *   B. 无 AI 时点「AI 拆解」⇒ 出现含「AI 拆解不可用」的红色 banner，且**候选表一条不增**；
 *   C. 点「规则拆解（先预览）」⇒ 渲染预览块（含「未落库」「文件清单行」警示），候选表**仍一条不增**；
 *   D. 预览块真列出前 10 条标题；
 *   E. 预览块给「确认写入 20 条」（默认上限 20 已在页面上说清）；
 *   F. 点「确认写入」⇒ 落库 **20 条**（默认口径），页面上候选数同步为 20。
 *
 * ## 反向对照
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web> node tools/bench-elaborate-guard.mjs` ⇒ A 转红（旧 UI 没有预览按钮）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程；**不配 aiElaborator**（本台要验的正是"没有 AI"）。
 * 不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`。⚠️ 沙箱内起不了 Chrome —— 必须在沙箱外跑。
 *
 * 运行：`node tools/bench-elaborate-guard.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）。
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

const CHROME_CANDIDATES = [
  process.env.TB_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
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
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;
let cdp = null;

try {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-elab-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-elab-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目", workspacePath: ROOT });
  store.bindInitialSession("default", "sess-main");
  // 「资料索引」形状的文档：1 个标题 + 50 条文件清单行（正是洪水的那种形状）
  const doc = store.ensureRequirementDoc("default", {
    body: "# 资料索引\n\n" + Array.from({ length: 50 }, (_, i) => `- docs/file-${i + 1}.md`).join("\n"),
  });
  const pending = () => store.listRequirementCandidates({ docId: doc.id, status: "pending" }).length;

  server = createServer({ store, webDir: WEB_DIR });   // 刻意不传 aiElaborator
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

  const debugPort = await freePort();
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = null;
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    try { const r = await fetch(`http://127.0.0.1:${debugPort}/json/version`); if (r.ok) { wsUrl = (await r.json()).webSocketDebuggerUrl; break; } } catch { /* 等 */ }
    await sleep(250);
  }
  if (!wsUrl) { console.log("SKIP  devtools 端点未就绪 ——退出码 2"); process.exit(2); }
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });
  let seq = 0;
  const pend = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pend.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  cdp = { send: (m, p) => send(m, p, null) };
  await S("Page.enable");
  await S("Runtime.enable");
  await S("Emulation.setDeviceMetricsOverride", { width: 1723, height: 1249, deviceScaleFactor: 1, mobile: false });
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };
  /** 在「需求文档」面板（section.panel 的 h2 = 需求文档）里按文本找按钮并点。 */
  const clickDocBtn = (label) => evalJs(`(() => {
    const panel = [...document.querySelectorAll('.requirements-view section.panel')]
      .find((p) => (p.querySelector('h2')?.textContent ?? '').trim() === '需求文档');
    if (!panel) return 'no-panel';
    const b = [...panel.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return 'no-btn';
    b.click();
    return 'clicked';
  })()`);

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2000);
  // 切到「需求」页签
  for (let i = 0; i < 40; i += 1) {
    const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (r === "no-btn") { await sleep(300); continue; }
    await sleep(700);
    const has = await evalJs(`[...document.querySelectorAll('.requirements-view section.panel h2')].some((h) => (h.textContent ?? '').trim() === '需求文档')`);
    if (has) break;
  }

  // ---- A. 两个按钮都在 ----
  const docBtnLabels = await evalJs(`(() => {
    const panel = [...document.querySelectorAll('.requirements-view section.panel')]
      .find((p) => (p.querySelector('h2')?.textContent ?? '').trim() === '需求文档');
    return panel ? [...panel.querySelectorAll('button')].map((b) => b.textContent.trim()) : null;
  })()`);
  const has = (l) => (docBtnLabels ?? []).includes(l);
  check("A 需求文档面板有「AI 拆解（auto）」与「规则拆解（先预览）」两个按钮",
    has("AI 拆解（auto）") && has("规则拆解（先预览）"), JSON.stringify(docBtnLabels));

  // ---- B. 无 AI 点 AI 拆解 ⇒ 明确报错 + 零落库 ----
  const beforeAi = pending();
  const clickAi = await clickDocBtn("AI 拆解（auto）");
  await sleep(900);
  const bannerText = await evalJs(`(() => { const b = document.querySelector('.banner'); return b ? { text: b.textContent, cls: b.className, hidden: b.hidden } : null; })()`);
  check("B 无 AI 时点「AI 拆解」⇒ 明确报「AI 拆解不可用」（不再假装成功）",
    Boolean(bannerText && !bannerText.hidden && String(bannerText.text).includes("AI 拆解不可用")),
    `${clickAi} · ${JSON.stringify(bannerText)}`);
  check("B② 这次**零落库**（候选表一条不增）", pending() === beforeAi, `before=${beforeAi} after=${pending()}`);

  // ---- C/D/E. 规则拆解先出预览 ----
  const clickRule = await clickDocBtn("规则拆解（先预览）");
  await sleep(1000);
  const preview = await evalJs(`(() => {
    const box = [...document.querySelectorAll('.requirements-view .req-warn')]
      .find((n) => (n.textContent ?? '').includes('规则拆解预览'));
    if (!box) return null;
    return {
      text: box.textContent,
      items: [...box.querySelectorAll('ol.req-rule-preview li')].map((li) => li.textContent.trim()),
      buttons: [...box.querySelectorAll('button')].map((b) => b.textContent.trim()),
    };
  })()`);
  check("C 点「规则拆解（先预览）」⇒ 出现预览块，且写明「未落库」与「文件清单行」风险",
    Boolean(preview && preview.text.includes("未落库") && preview.text.includes("文件清单行")), `${clickRule}`);
  check("C② 预览阶段**零落库**", pending() === beforeAi, `pending=${pending()}`);
  check("D 预览真列出前 10 条标题", Boolean(preview && preview.items.length === 10), `items=${preview ? preview.items.length : 0}`);
  check("E 预览块给「确认写入 20 条」（默认上限已摆在页面上）",
    Boolean(preview && preview.buttons.some((b) => b.includes("确认写入") && b.includes("20"))), JSON.stringify(preview?.buttons));

  // ---- F. 确认后才真写，且只写默认 20 条 ----
  await evalJs(`(() => {
    const box = [...document.querySelectorAll('.requirements-view .req-warn')]
      .find((n) => (n.textContent ?? '').includes('规则拆解预览'));
    const b = [...(box?.querySelectorAll('button') ?? [])].find((n) => n.textContent.includes('确认写入'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1500);
  check("F 点「确认写入」⇒ 落库 20 条（旧默认 100 才是洪水扳机）", pending() === 20, `pending=${pending()}`);
  const afterBanner = await evalJs(`(() => { const b = document.querySelector('.banner'); return b ? b.textContent : ''; })()`);
  check("F② 页面回报候选数 20（不只是库里对）", String(afterBanner).includes("候选=20"), afterBanner.slice(0, 120));
  const previewGone = await evalJs(`!document.querySelector('.requirements-view .req-warn')`);
  check("F③ 确认后预览块消失（不会留着让人再点一次）", previewGone === true, String(previewGone));
} catch (error) {
  check("验证台运行未抛错", false, String(error?.message ?? error));
} finally {
  clearTimeout(watchdog);
  try { await cdp?.send("Browser.close", {}); } catch { /* 忽略 */ }
  try { chrome?.kill("SIGKILL"); } catch { /* 忽略 */ }
  try { server?.close?.(); } catch { /* 忽略 */ }
  for (const dir of [dataDir, chromeProfile]) { if (dir) { try { await rm(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
process.exit(0);
