/**
 * 配置页「规范来源」—— **真 headless Chrome + CDP**，读渲染后 DOM 并真点两个按钮。
 *
 * ## 为什么需要这台（卡 `-216` / 需求 `R160`）
 * `R160` 的核心不是"再造一套规范"，而是**让规则在界面上可见可改**：改之前 `web/app.js` 里
 * `contract` / `norms` **一次都没出现** —— 规范在包内、契约会变、`NORM_STALE` 会拦写，
 * 而界面上一个字都没有，人只能靠报错反推规则在哪。
 *
 * 源码守卫只能证明"代码里写了这个卡片"，证明不了：
 *   ① 卡片真的渲染出来；② 显示的是**当前生效**的来源与份数；③ 点「生成默认副本」**文件真的落盘**；
 *   ④ 改过之后「与内置不同 N 份」这个读数真的跟着变。所以必须真渲染 + 真点 + 真读盘。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区 + 随机端口 + 临时 Chrome profile，跑完即删。**不碰 `:3080` / 仓库 `.data/`。**
 * ⚠️ 沙箱内起不了 Chrome —— 必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-norms-config.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-normscfg-chrome-"));
  workspace = await mkdtemp(path.join(os.tmpdir(), "tb-normscfg-ws-"));
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-normscfg-data-"));
  const normsDir = path.join(workspace, ".taskboard", "norms");

  // ---- 起一个隔离服务：项目带真实工作区（否则「生成默认副本」会按设计报 WORKSPACE_MISSING） ----
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

  /** 读「规范来源」卡片：标题、四个键值、每份的 id@v/来源/是否已改、按钮是否在、错误横幅。 */
  const readCard = () => evalJs(`(() => {
    const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('规范来源'));
    if (!card) return { found: false };
    // 键值走 kvList() 渲染的 <dl class="kv">（dt/dd 成对）；
    // 早先误读 .config-row（那是按钮行）⇒ B/F/H 三条假红，别再用它当读数源。
    const kv = {};
    for (const dl of card.querySelectorAll('dl.kv')) {
      const kids = [...dl.children];
      for (let i = 0; i + 1 < kids.length; i += 1) {
        if (kids[i].tagName === 'DT' && kids[i + 1].tagName === 'DD') kv[kids[i].textContent.trim()] = kids[i + 1].textContent.trim();
      }
    }
    const rows = [...card.querySelectorAll('li.req-item')].map((li) => [...li.children].map((x) => x.textContent.trim()));
    const buttons = [...card.querySelectorAll('button')].map((b) => ({ label: b.textContent.trim(), disabled: b.disabled === true }));
    const err = document.querySelector('.banner.error');
    const warn = document.querySelector('.banner.warn');
    return {
      found: true, kv, rows, buttons,
      error: err && !err.hidden ? err.textContent : null,
      warn: warn && !warn.hidden ? warn.textContent : null,
      hint: card.textContent.includes('version'),
    };
  })()`);

  const clickCardButton = async (label) => {
    const r = await evalJs(`(() => {
      const card = [...document.querySelectorAll('.config-card')].find((c) => (c.querySelector('h3')?.textContent || '').startsWith('规范来源'));
      if (!card) return 'no-card';
      const b = [...card.querySelectorAll('button')].find((n) => n.textContent.trim() === ${JSON.stringify(label)});
      if (!b) return 'no-btn';
      b.click(); return 'clicked';
    })()`);
    return r;
  };

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2500);
  // 进配置视图
  let nav = "no-btn";
  for (let i = 0; i < 30; i += 1) {
    nav = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '配置'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
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
  check("A 配置页渲染出「规范来源（机器规范）」卡片", before.found === true, before.found ? "" : "未找到卡片");
  check("B 初始来源＝随包默认，份数 6，目录指向包内 spec/norms",
    before.kv?.["来源"]?.startsWith("随包默认") === true
      && /6 份/.test(before.kv?.["份数"] ?? "")
      && /spec\/norms$/.test((before.kv?.["目录"] ?? "").replace(/\s+$/, "")),
    JSON.stringify(before.kv ?? {}));
  check("C 两个按钮都在且可点（生成默认副本 / 恢复默认）",
    ["生成默认副本", "恢复默认（覆盖副本）"].every((l) => (before.buttons ?? []).some((b) => b.label === l && !b.disabled)),
    JSON.stringify(before.buttons ?? []));
  check("D 初始状态工作区里**还没有**副本（不得静默写用户目录）", !existsSync(normsDir), normsDir);

  // ---- E. 点「生成默认副本」⇒ 文件真落盘 + 卡片刷新成「项目副本」 ----
  const clicked = await clickCardButton("生成默认副本");
  await sleep(1500);
  const afterMaterialize = await readCard();
  const files = existsSync(normsDir) ? (await readdir(normsDir)).sort() : [];
  check("E 点「生成默认副本」后文件**真的落盘**（6 份 + README + manifest）",
    clicked === "clicked" && files.filter((f) => f.endsWith(".md")).length >= 7 && files.includes("manifest.json") && files.includes("README.md"),
    `clicked=${clicked} files=${files.join(",")}`);
  check("F 卡片刷新为「项目副本」，且仍报 6 份 / 与内置不同 0 份",
    (afterMaterialize.kv?.["来源"] ?? "").startsWith("项目副本")
      && /6 份/.test(afterMaterialize.kv?.["份数"] ?? "")
      && /^0 份/.test(afterMaterialize.kv?.["与内置不同"] ?? ""),
    JSON.stringify(afterMaterialize.kv ?? {}));
  check("G 提示了「请重算契约基线」（规范变了不自动重算，但必须指路）",
    String(afterMaterialize.warn ?? "").includes("重算契约基线"), afterMaterialize.warn ?? "无提示");

  // ---- H. 改一份副本正文 + bump ⇒ 「与内置不同 1 份」+ 该行「已改」 ----
  const flowPath = path.join(normsDir, "flow.md");
  // 反向对照（旧 web）到这一步时副本根本不存在 —— 别抛栈把 H–K 的读数吞掉，按「改不了」如实记红。
  let baseFlow = "";
  try { baseFlow = await readFile(flowPath, "utf8"); } catch { baseFlow = ""; }
  if (!baseFlow) console.log("      注意：副本 flow.md 不存在（多见于反向对照的旧前端）⇒ H–J 必然转红");
  const edited = baseFlow
    .replace("version: 1", "version: 2")
    .replace("# flow · 主流程八步（机器版）", "# flow · 主流程八步（本项目口径）");
  try { await writeFile(flowPath, edited, "utf8"); } catch { /* 反向对照下写不进去，交给 H–J 记红 */ }
  await clickCardButton("生成默认副本"); // 幂等：已存在的不覆盖（kept），顺带刷新卡片
  await sleep(1500);
  const afterEdit = await readCard();
  const flowRow = (afterEdit.rows ?? []).find((r) => (r[0] ?? "").startsWith("flow@v"));
  check("H 改正文 + bump 后，卡片读数变成「与内置不同 1 份」",
    /^1 份/.test(afterEdit.kv?.["与内置不同"] ?? ""), JSON.stringify(afterEdit.kv ?? {}));
  check("I 该行显示副本里的新版本号与「已改」标记（本行口子真的生效）",
    (flowRow?.[0] ?? "") === "flow@v2" && (flowRow ?? []).includes("已改") && (flowRow ?? []).includes("副本"),
    JSON.stringify(flowRow ?? []));
  let flowAfter = "";
  try { flowAfter = await readFile(flowPath, "utf8"); } catch { flowAfter = ""; }
  const flowKept = flowAfter.includes("本项目口径");
  check("J 再来一次「生成默认副本」不覆盖已改的那份（kept，不是无声回滚）", flowKept,
    flowKept ? "已改正文仍在（kept）" : "副本内容被覆盖了 ⇒ 无声回滚");

  // ---- K. 全程不得弹错误横幅 ----
  check("K 全程无 error 横幅", afterEdit.error === null, afterEdit.error ?? "无");

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
  for (const d of [dataDir, workspace, chromeProfile]) {
    try { if (d) await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
