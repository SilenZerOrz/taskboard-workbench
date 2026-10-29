/**
 * 「生成看板任务（分拆）」的**自动生成 + 修订回路** —— 真实浏览器 DOM 验证台（真 headless Chrome + CDP）。
 *
 * ## 为什么需要这台（真机批注 2026-10-28）
 * 「需求条目详情内的生成看板任务当前是如何执行的？手工填报生成吗？我希望能引入自动生成按钮，
 * 并可交互提交修改意见变更优化」。
 * 之前：**只有一个人工 textarea** —— 人按 `标题 | 负责人 | kind` 手打，没有建议、没有草稿、没有修订。
 * 现在（人拍 **方案 C：走项目主会话**）：①「自动生成（交主会话）」投一条指令；②「按意见重生成」带
 * 上一版草稿 + 人的意见再投一次；③ 人把回帖里的任务行粘回来 → 「生成任务 + 依赖」才真落库。
 *
 * 单测（`tests/fr-req-split-ask.test.mjs`）证明得了"端点无副作用""指令里有边界"，
 * 证明不了**按钮真的接上线、点了真的有反应、粘回来的依赖真的变成边** —— 所以必须有这台。
 *
 * ## 本台断言什么（读渲染后 DOM + 读隔离库里真实的卡）
 *   A. 抽屉「生成看板任务（分拆）」区里三个按钮 + 意见框都在；
 *   B. 点「自动生成（交主会话）」⇒ **只投递一条**指令给项目主会话，且**一张卡都不建**；
 *   C. 指令正文含「不要建卡」与条目标题（证明投的是这条需求，不是模板空转）；
 *   D. 填意见 → 点「按意见重生成」⇒ 第 2 条指令带**人的原话**与**上一版草稿**；
 *   E. 空意见点「按意见重生成」⇒ 就地报错、**不投递**（防"点了没反应"）；
 *   F. 粘回「序号 | 标题 | owner | kind | 依赖」四行 → 点「生成任务 + 依赖」⇒ 真建 3 张卡；
 *   G. 落库的卡带 `kind/work` `kind/review` 标签（旧实现**静默丢弃 kind**）；
 *   H. 依赖真的成边：`2→1`、`3→1,2` 两条边（旧 UI **永远建不出依赖**）。
 *
 * ## 反向对照（反证本台会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web> node tools/bench-req-split-draft.mjs` ⇒ A/B/C/D 全红（没有这些按钮）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，**假宿主会话通道**（只记录 prompt，不真投）。
 * 不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`。⚠️ 沙箱内起不了 Chrome —— 必须在沙箱外跑。
 *
 * 运行：`node tools/bench-req-split-draft.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（找不到 Chrome）。
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
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-splitdraft-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-splitdraft-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目", workspacePath: ROOT });
  store.bindInitialSession("default", "sess-main");
  const doc = store.ensureRequirementDoc("default", { body: "# 需求\n" });
  const item = store.createRequirementItem({
    projectId: "default",
    title: "示例需求：抽屉宽度可调",
    status: "open",
    docId: doc.id,
    description: "- 详情抽屉宽度死钉 560px\n- 需要可拖拽与一键全屏",
    acceptance: "① 1723 视口下宽度 ≥1200 ② 左缘可拖 ③ 有全屏按钮",
  });

  // 假宿主会话通道：只记录，不真投（本台要验的是"投了几条、内容对不对"）
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, prompt) => { sent.push({ sid, prompt }); return { sent: true }; } };

  server = createServer({ store, webDir: WEB_DIR });
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
  const pending = new Map();
  ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
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

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2000);
  for (let i = 0; i < 40; i += 1) {
    const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (r === "no-btn") { await sleep(300); continue; }
    await sleep(600);
    if (await evalJs(`document.querySelectorAll('.req-list .req-item').length`) > 0) break;
  }
  await evalJs(`(() => { document.querySelector('.req-list .req-item')?.click(); return true; })()`);
  await sleep(1200);

  const btnLabels = () => evalJs(`[...document.querySelectorAll('.tb-req-drawer button')].map((b) => b.textContent.trim())`);

  // ---- A. 三个按钮 + 意见框 ----
  const labels = await btnLabels();
  const has = (n) => labels.includes(n);
  check("A 分区里有「自动生成（交主会话）」「按意见重生成」「生成任务 + 依赖」三个按钮",
    has("自动生成（交主会话）") && has("按意见重生成") && has("生成任务 + 依赖"), JSON.stringify(labels));
  const feedbackBoxes = await evalJs(`(() => {
    const areas = [...document.querySelectorAll('.tb-req-drawer textarea')];
    return areas.map((a) => a.placeholder);
  })()`);
  check("A② 有「修改意见」输入框（与任务行框分开）",
    feedbackBoxes.some((p) => (p ?? "").includes("修改意见")), JSON.stringify(feedbackBoxes));

  // ---- B/C. 自动生成：只投一条，不建卡 ----
  const tasksBefore = store.listTasks({ projectId: "default" }).length;
  await evalJs(`(() => { [...document.querySelectorAll('.tb-req-drawer button')].find((b) => b.textContent.trim() === '自动生成（交主会话）')?.click(); return true; })()`);
  await sleep(900);
  check("B 点「自动生成」只投递 1 条指令给项目主会话", sent.length === 1 && sent[0].sid === "sess-main", `sent=${sent.length} sid=${sent[0]?.sid}`);
  check("B② 投递**不建卡**（副作用为零）", store.listTasks({ projectId: "default" }).length === tasksBefore, `before=${tasksBefore} after=${store.listTasks({ projectId: "default" }).length}`);
  check("C 指令正文含「不要建卡」与条目标题（不是模板空转）",
    Boolean(sent[0]?.prompt?.includes("不要建卡") && sent[0]?.prompt?.includes(item.title)), (sent[0]?.prompt ?? "").slice(0, 60));

  // ---- E. 空意见点「按意见重生成」⇒ 不投递 ----
  await evalJs(`(() => { [...document.querySelectorAll('.tb-req-drawer button')].find((b) => b.textContent.trim() === '按意见重生成')?.click(); return true; })()`);
  await sleep(600);
  check("E 空意见点「按意见重生成」⇒ 不投递（就地报错）", sent.length === 1, `sent=${sent.length}`);

  // ---- D. 带意见重生成 ----
  const paste = [
    "1 | 改 CSS 抽屉宽度 | engineer | work |",
    "2 | 真机复验宽度 | tester | review | 1",
    "3 | 归档说明 | archivist | work | 1,2",
  ];
  await evalJs(`(() => {
    const areas = [...document.querySelectorAll('.tb-req-drawer textarea')];
    const ta = areas.find((a) => !(a.placeholder ?? '').includes('修改意见'));
    const fb = areas.find((a) => (a.placeholder ?? '').includes('修改意见'));
    ta.value = ${JSON.stringify(paste.join("\n"))};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    fb.value = '测试那条再拆细一点';
    fb.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evalJs(`(() => { [...document.querySelectorAll('.tb-req-drawer button')].find((b) => b.textContent.trim() === '按意见重生成')?.click(); return true; })()`);
  await sleep(900);
  check("D 带意见重生成 ⇒ 第 2 条指令含人的原话", sent.length === 2 && Boolean(sent[1]?.prompt?.includes("测试那条再拆细一点")), `sent=${sent.length}`);
  check("D② 第 2 条指令带上一版草稿（只改受影响的行）",
    Boolean(sent[1]?.prompt?.includes("改 CSS 抽屉宽度") && sent[1]?.prompt?.includes("只改受意见影响的行")), "");

  // ---- F/G/H. 生成落库：kind 标签 + 依赖边 ----
  await evalJs(`(() => { [...document.querySelectorAll('.tb-req-drawer button')].find((b) => b.textContent.trim() === '生成任务 + 依赖')?.click(); return true; })()`);
  await sleep(1500);
  const created = store.listTasks({ projectId: "default" });
  check("F 粘回三行 ⇒ 真建 3 张卡", created.length === tasksBefore + 3, `tasks=${created.length}`);
  const review = created.find((t) => t.title === "真机复验宽度");
  const work = created.find((t) => t.title === "改 CSS 抽屉宽度");
  check("G 落库的卡带 kind 标签（旧实现静默丢弃 kind）",
    Boolean(review?.labels?.includes("kind/review") && work?.labels?.includes("kind/work")),
    `${JSON.stringify(work?.labels)} / ${JSON.stringify(review?.labels)}`);
  const graph = store.requirementTaskGraph(item.identifier);
  check("H 依赖真的成边（2→1、3→1 与 3→2）", graph.edges.length === 3, JSON.stringify(graph.edges));
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
