/**
 * 配置页「文档与规范位置」—— **真 headless Chrome + CDP**，读渲染后 DOM、真点按钮、真读盘。
 *
 * ## 为什么需要这台（卡 `-220` / 需求 `R161`）
 * 用户的要求是「**落地真实启动包的相关配套文档，其默认解压位置 / 后续存放位置要能查能看能改**」。
 * 这三件事没有一件能靠源码守卫证明：
 *   ① 「包内默认位置」显示的是不是**真实安装路径**（不是写死的字符串）；
 *   ② 点「生成默认副本」文件**真的落盘**到显示的目录；
 *   ③ 改路径之后**下一次落点真的跟着变**（否则「可改」只是个输入框）。
 * 所以必须真渲染 + 真点 + 真 `stat`。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区 + 随机端口 + 临时 Chrome profile，跑完即删。**不碰 `:3080` / 仓库 `.data/`。**
 * ⚠️ 沙箱内起不了 Chrome —— 必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-docs-locations.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdtemp, readdir, rm } from "node:fs/promises";
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

let chromeProfile = null;
let chrome = null;
let server = null;
let store = null;
let dataDir = null;
let workspace = null;

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-docsloc-chrome-"));
  workspace = await mkdtemp(path.join(os.tmpdir(), "tb-docsloc-ws-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-docsloc-data-"));
  const defaultDir = path.join(workspace, ".taskboard", "docs");

  // ---- 隔离服务：项目带真实工作区（否则「生成副本」按设计报 WORKSPACE_MISSING） ----
  store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目", workspacePath: workspace });
  store.ensureRequirementDoc("default", { body: "# 需求\n" });
  server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

  // ---- Chrome + CDP ----
  const debugPort = await freePort();
  chrome = spawn(chromeBin, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${chromeProfile}`, "about:blank",
  ], { stdio: "ignore" });
  let wsUrl = null;
  for (const t0 = Date.now(); Date.now() - t0 < 30000;) {
    try {
      const r = await globalThis.fetch(`http://127.0.0.1:${debugPort}/json/version`);
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
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const S = (m, p) => send(m, p, sessionId);
  await S("Page.enable");
  await S("Runtime.enable");
  const evalJs = async (expr) => {
    const r = await S("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "eval failed");
    return r.result.value;
  };

  /** 读「文档与规范位置」卡片：键值（dl.kv）、按钮、文件行、错误横幅。 */
  const readCard = () => evalJs(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('文档与规范位置'));
    if (!card) return { found: false };
    const kv = {};
    for (const dl of card.querySelectorAll('dl.kv')) {
      const kids = [...dl.children];
      for (let i = 0; i + 1 < kids.length; i += 1) {
        if (kids[i].tagName === 'DT' && kids[i + 1].tagName === 'DD') kv[kids[i].textContent.trim()] = kids[i + 1].textContent.trim();
      }
    }
    const rows = [...card.querySelectorAll('li.req-item')].map((li) => [...li.children].map((x) => x.textContent.trim()));
    const buttons = [...card.querySelectorAll('button')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled === true }));
    const input = card.querySelector('input');
    const err = document.querySelector('.banner.error');
    return {
      found: true, kv, rows, buttons,
      inputPlaceholder: input ? (input.placeholder || '') : null,
      inputValue: input ? input.value : null,
      error: err && !err.hidden ? err.textContent : null,
    };
  })()`);

  const clickCardButton = (label) => evalJs(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('文档与规范位置'));
    if (!card) return 'no-card';
    const b = [...card.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
    if (!b) return 'no-btn';
    b.click(); return 'clicked';
  })()`);

  const clickFileRow = (needle) => evalJs(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('文档与规范位置'));
    if (!card) return 'no-card';
    const li = [...card.querySelectorAll('li.req-item')].find((n) => (n.textContent || '').includes(${JSON.stringify(needle)}));
    if (!li) return 'no-row';
    li.click(); return 'clicked';
  })()`);

  const readPreview = () => evalJs(`(() => {
    const pre = document.querySelector('pre.doc-preview');
    const h3 = pre ? [...document.querySelectorAll('.config-card h3')].map((h) => h.textContent.trim()).find((t) => t.includes('·')) : null;
    return { exists: !!pre, title: h3, textLen: pre ? pre.textContent.length : 0, head: pre ? pre.textContent.slice(0, 40) : null };
  })()`);

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2500);
  for (let i = 0; i < 30; i += 1) {
    const nav = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '配置'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (nav === "clicked") break;
    await sleep(200);
  }
  for (let i = 0; i < 40; i += 1) {
    if (await evalJs(`!!document.querySelector('.config-view')`)) break;
    await sleep(150);
  }
  await sleep(1200);

  // ---- A. 卡片在 ----
  const before = await readCard();
  check("A 配置页渲染出「文档与规范位置」卡片", before.found === true, before.found ? "" : "未找到卡片");
  check("B 三路读数：包内默认（…/spec/docs）· 项目存放（…/.taskboard/docs 且标默认）· 生效=包内默认",
    /spec\/docs$/.test((before.kv ?? {})["包内默认（解压后）"] ?? "")
      && String((before.kv ?? {})["项目存放位置"] ?? "").endsWith(`${path.sep}.taskboard${path.sep}docs（默认）`)
      && String((before.kv ?? {})["生效来源"] ?? "").startsWith("包内默认"),
    JSON.stringify(before.kv ?? {}));
  check("C 控件齐全：生成默认副本 / 恢复默认（覆盖副本）/ 保存路径 / 恢复默认路径 + 路径输入框",
    ["生成默认副本", "恢复默认（覆盖副本）", "保存路径", "恢复默认路径"].every((l) => (before.buttons ?? []).some((b) => b.label === l && !b.disabled))
      && typeof before.inputPlaceholder === "string",
    JSON.stringify(before.buttons ?? []));
  check("D 初始工作区里**还没有**副本（不得静默写用户目录）", !existsSync(defaultDir), defaultDir);

  // ---- E. 生成副本 ⇒ 真落盘 + 生效来源变化 ----
  const clicked = await clickCardButton("生成默认副本");
  await sleep(1800);
  const afterGen = await readCard();
  const files = existsSync(defaultDir) ? (await readdir(defaultDir)).sort() : [];
  check("E 点「生成默认副本」文件**真的落盘**（4 份 + assets 子目录）",
    clicked === "clicked" && files.filter((f) => f.endsWith(".md")).length >= 3 && existsSync(path.join(defaultDir, "assets")),
    `clicked=${clicked} files=${files.join(",")}`);
  check("F 卡片刷新：生效来源=项目副本，且文件行标「副本」",
    String((afterGen.kv ?? {})["生效来源"] ?? "").startsWith("项目副本")
      && (afterGen.rows ?? []).some((r) => r.includes("副本")),
    JSON.stringify({ kv: afterGen.kv, rows: afterGen.rows }));

  // ---- G. 改路径 ⇒ 落点跟着变（可改不是摆设） ----
  // 反向对照（旧前端）到这一步时卡片根本不存在 —— 别抛异常把 G–K 的读数吞掉，按「改不了」如实记红。
  const typed = await evalJs(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('文档与规范位置'));
    if (!card) return 'no-card';
    const input = card.querySelector('input');
    if (!input) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'handbook'); input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
  if (typed !== "handbook") console.log(`      注意：路径输入框不可用（${typed}）⇒ G/H 必然转红`);
  await clickCardButton("保存路径");
  await sleep(1500);
  const afterDir = await readCard();
  const handbook = path.join(workspace, "handbook");
  check("G 改路径（handbook）⇒ 卡片标「已改」、落点为工作区下 handbook，且未生成时如实回落包内",
    String((afterDir.kv ?? {})["项目存放位置"] ?? "").includes("handbook")
      && String((afterDir.kv ?? {})["项目存放位置"] ?? "").includes("已改")
      && String((afterDir.kv ?? {})["生效来源"] ?? "").startsWith("包内默认")
      && !existsSync(handbook),
    JSON.stringify(afterDir.kv ?? {}));
  await clickCardButton("生成默认副本");
  await sleep(1800);
  check("H 改路径后再生成 ⇒ 文件真落到新目录", existsSync(path.join(handbook, "README.md")), handbook);

  // ---- I. 恢复默认路径 ----
  await clickCardButton("恢复默认路径");
  await sleep(1500);
  const afterReset = await readCard();
  check("I 「恢复默认路径」⇒ 回 .taskboard/docs（已改标记消失）",
    String((afterReset.kv ?? {})["项目存放位置"] ?? "").endsWith("（默认）")
      && String((afterReset.kv ?? {})["项目存放位置"] ?? "").includes(".taskboard"),
    JSON.stringify(afterReset.kv ?? {}));

  // ---- J. 点开一份文档 ⇒ 预览（能「看」） ----
  const rowClick = await clickFileRow("01-项目开局.md");
  await sleep(1200);
  const preview = await readPreview();
  check("J 点开「01-项目开局.md」⇒ 真渲染预览（标题带来源、正文含「项目开局」）",
    rowClick === "clicked" && preview.exists && /项目开局/.test(preview.head ?? "") && String(preview.title ?? "").length > 0,
    JSON.stringify(preview));
  check("K 全程无 error 横幅", afterReset.error === null && preview.exists, afterReset.error ?? "无");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} PASS${failed.length ? `  ·  失败 ${failed.length} 条` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error("FAIL  验证台异常：", error?.stack ?? error);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  try { if (server) await new Promise((r) => server.close(r)); } catch { /* ignore */ }
  try { store?.close(); } catch { /* ignore */ }
  for (const d of [chromeProfile, dataDir, workspace]) {
    try { if (d) await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
