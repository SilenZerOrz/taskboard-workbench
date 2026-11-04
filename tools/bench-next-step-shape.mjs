/**
 * 「下一步」判据必须按**形状**、不能按**存在性** —— 真 headless Chrome + CDP 验证台。
 *
 * ## 为什么需要这台（卡 `-211` / 需求 `R155`）
 * 2026-11-04 真机：卡 `-185` 已 `in_review + approved`，「下一步」标题正确写着「只差你点『完成』」，
 * 但动作区是「**本卡无待办动作。**」、没有「完成」按钮 —— 人无法从界面收口。
 *
 * 根因不在服务端也不在数据：宿主进程没重载，服务端仍回旧形状
 * `ticketStage.next = {code, title}`；而前端兜底只判 `next` 是否为 `null`
 * ⇒ 半残回包绕过「旧版服务端」提示，掉进 else 分支，把一个**错误的结论**摆到人脸上。
 *
 * 单测能证明「源码里有形状判据」，证明不了**渲染后**那句话不再出现 —— 判据一旦被改回
 * `if (!step)`，源码里仍然「有下一步逻辑」。所以必须有这台：读渲染后的真实 DOM。
 *
 * ## 本台断言什么（四组）
 *   A. 半残回包（`{code,title}`）⇒ 文案含「旧版服务端」+「不完整」，**不得**含「本卡无待办动作」，且无「完成」按钮；
 *   B. 完整回包 ⇒ 无「旧版服务端」提示、有「完成（仅人工可确认）」按钮、步骤列表真渲染（`.next-steps li ≥ 1`）；
 *   C. 已收口卡（`done`，`actions: []`）⇒ 仍显示「本卡已收口」，**不能**被误判成半残（防误伤）；
 *   D. 全程无 error 横幅（旁证：漏改是「静默说错话」，不会报错）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-next-step-shape.mjs`
 *   —— 拷一份 `web/`，把形状判据改回 `if (!step)` ⇒ A 转红（文案变成「本卡无待办动作。」）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**。
 * ⚠️ 沙箱内起不了 Chrome（SIGABRT）—— 本台必须在**沙箱外**跑，
 *    或用 `bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-next-step-shape.mjs`。
 *
 * 运行：`node tools/bench-next-step-shape.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = process.env.TB_BENCH_WEB_DIR || path.join(ROOT, "web");
const VIEW = { width: 1500, height: 1000 };
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

const T = { pending: "形状-等人工点完成", closed: "形状-已收口" };

/** 前置代理：把详情回包降级成「旧版服务端」的形状（只改 GET /api/tasks/<ref>，其余原样穿透）。 */
let degradeNext = false;
function makeProxy(innerPort) {
  return http.createServer((req, res) => {
    const isDetail = /^\/api\/tasks\/[^/?]+$/.test(req.url ?? "");
    if (!isDetail || req.method !== "GET" || !degradeNext) {
      const up = http.request({ port: innerPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
        res.writeHead(r.statusCode ?? 500, r.headers);
        r.pipe(res);
      });
      up.on("error", () => { res.writeHead(502); res.end(); });
      req.pipe(up);
      return;
    }
    const up = http.request({ port: innerPort, path: req.url, method: req.method, headers: req.headers }, (r) => {
      const chunks = [];
      r.on("data", (c) => chunks.push(c));
      r.on("end", () => {
        let body = Buffer.concat(chunks).toString("utf8");
        try {
          const payload = JSON.parse(body);
          const next = payload?.ticketStage?.next;
          if (next) {
            // 这就是旧服务端的形状：只有 code + title，没有 hint/steps/focus/actions/blocker
            payload.ticketStage.next = { code: next.code, title: next.title };
            body = JSON.stringify(payload);
          }
        } catch { /* 非 JSON 原样返回 */ }
        res.writeHead(r.statusCode ?? 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(body);
      });
    });
    up.on("error", () => { res.writeHead(502); res.end(); });
    up.end();
  });
}

let dataDir = null;
let chromeProfile = null;
let inner = null;
let proxy = null;
let chrome = null;

try {
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-nsshape-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-nsshape-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  const req = store.createRequirementItem({ projectId: "default", title: "形状判据", status: "open", priority: "medium" });
  const mkCard = (title) => {
    const made = store.createTask({
      projectId: "default", title, status: "todo", priority: "medium", requirement: req.identifier, actor: "agent",
    });
    return made.task ?? made; // createTask 直接返回行；兼容将来包一层 { task }
  };
  const unwrap = (x) => x?.task ?? x;
  // 乐观锁：每次写都要带上「我读到的版本」，所以逐跳传递最新行
  const patch = (task, data) => unwrap(store.updateTask(task.identifier, { expectedVersion: task.version, ...data }));

  // 待人工完成：先推进到 in_review 并批准（这条路径就是 `-185` 当时的真实状态）
  let pend = mkCard(T.pending);
  pend = patch(pend, { status: "in_progress", actor: "agent" });
  pend = unwrap(store.requestReview(pend.identifier, { actor: "agent" }));
  pend = unwrap(store.approveReview(pend.identifier, { actor: "human" }));
  // 已收口：done（`actions: []` 是合法形态，用来防「把好形态误判成半残」）
  let closed = mkCard(T.closed);
  closed = patch(closed, { status: "in_progress", actor: "agent" });
  closed = patch(closed, { status: "done", actor: "human" });
  const statuses = (store.listTasks?.({ projectId: "default" }) ?? []).map((t) => `${t.identifier}:${t.status}/${t.reviewState}`);
  console.log(`… 种子 ${statuses.join(" · ")}`);

  const innerPort = await freePort();
  inner = createServer({ store, webDir: WEB_DIR });
  await new Promise((r) => inner.listen(innerPort, "127.0.0.1", r));
  const proxyPort = await freePort();
  proxy = makeProxy(innerPort);
  await new Promise((r) => proxy.listen(proxyPort, "127.0.0.1", r));
  const base = `http://127.0.0.1:${proxyPort}`;
  console.log(`… 台内代理 ${base} · webDir=${WEB_DIR}`);

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
  const pendingReq = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pendingReq.has(m.id)) { pendingReq.get(m.id)(m); pendingReq.delete(m.id); }
  });
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const id = ++seq;
    pendingReq.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
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

  /** 重新载入页面（视图/模式切换后必须重载，避免内存态干扰）。 */
  const loadBoard = async () => {
    await S("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
    await S("Page.navigate", { url: `${base}/` });
    for (let i = 0; i < 40; i += 1) {
      await sleep(300);
      const n = await evalJs(`document.querySelectorAll("article.task-card").length`);
      if (n >= 2) return n;
    }
    return 0;
  };

  /** 打开某张卡，读「下一步」区的真实渲染结果。 */
  const openCard = async (title) => {
    await evalJs(`(() => {
      const card = [...document.querySelectorAll("article.task-card")]
        .find((c) => (c.querySelector(".card-title")?.textContent ?? "").trim() === ${JSON.stringify(title)});
      if (card) card.click();
      return !!card;
    })()`);
    await sleep(1600);
    return evalJs(`(() => {
      const sec = document.querySelector(".tb-drawer-body .drawer-section.next-step");
      if (!sec) return { hasSec: false };
      const buttons = [...sec.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
      const notes = [...sec.querySelectorAll(".empty-note")].map((n) => (n.textContent ?? "").trim());
      return {
        hasSec: true,
        title: (sec.querySelector(".next-step-title")?.textContent ?? "").trim(),
        notes,
        buttons,
        steps: sec.querySelectorAll(".next-steps li").length,
        text: (sec.textContent ?? "").trim(),
      };
    })()`);
  };
  const closeDrawer = async () => {
    await evalJs(`(() => {
      const b = document.querySelector(".tb-drawer-close") || [...document.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === "✕");
      if (b) b.click();
      return true;
    })()`);
    await sleep(500);
  };

  // ---- A：半残回包（模拟「宿主没重载」的旧服务端） ----
  degradeNext = true;
  const cards = await loadBoard();
  check("A0 看板出卡（两张种子卡）", cards >= 2, `卡片数=${cards}`);
  const a = await openCard(T.pending);
  const aText = a.hasSec ? a.text : "(无下一步区)";
  check("A1 半残回包 ⇒ 提示「旧版服务端」且点明「不完整」",
    a.hasSec && /旧版服务端/.test(aText) && /不完整/.test(aText), aText.slice(0, 90));
  check("A2 半残回包 ⇒ 不再输出「本卡无待办动作」", !/本卡无待办动作/.test(aText), aText.slice(0, 90));
  check("A3 半残回包 ⇒ 没有「完成」按钮（无动作可点，就不能假装有）",
    !(a.buttons ?? []).some((b) => /完成/.test(b)), JSON.stringify(a.buttons ?? []));
  const bannerA = await evalJs(`(() => { const b = document.querySelector(".banner"); return b ? b.textContent.trim() : ""; })()`);
  check("D1 半残形态下无 error 横幅", !/失败|错误/.test(bannerA), bannerA ? bannerA.slice(0, 60) : "(无横幅)");
  await closeDrawer();

  // ---- B：完整回包（真服务端） ----
  degradeNext = false;
  await loadBoard();
  const b = await openCard(T.pending);
  const bText = b.hasSec ? b.text : "(无下一步区)";
  check("B1 完整回包 ⇒ 不出现「旧版服务端」提示", b.hasSec && !/旧版服务端/.test(bText), bText.slice(0, 90));
  check("B2 完整回包 ⇒ 「完成（仅人工可确认）」按钮在", (b.buttons ?? []).some((x) => /完成/.test(x)), JSON.stringify(b.buttons ?? []));
  check("B3 完整回包 ⇒ 步骤列表真渲染", (b.steps ?? 0) >= 1, `li=${b.steps}`);
  check("B4 完整回包 ⇒ 标题仍是「只差你点「完成」」", /只差你点/.test(b.title ?? ""), b.title ?? "(空)");
  await closeDrawer();

  // ---- C：已收口卡不得被误判成半残（防误伤） ----
  const c = await openCard(T.closed);
  const cText = c.hasSec ? c.text : "(无下一步区)";
  check("C1 已收口卡（actions:[]）⇒ 仍显示「本卡已收口」", /本卡已收口/.test(cText), cText.slice(0, 90));
  check("C2 已收口卡 ⇒ 不被误报为「旧版服务端」", !/旧版服务端/.test(cText), cText.slice(0, 90));

  clearTimeout(watchdog);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) console.log("FAIL 项：" + failed.map((r) => r.name).join(" / "));
  process.exitCode = failed.length ? 1 : 0;
} finally {
  try { if (chrome) chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { if (proxy) proxy.close(); } catch { /* ignore */ }
  try { if (inner) inner.close(); } catch { /* ignore */ }
  for (const d of [dataDir, chromeProfile]) {
    if (!d) continue;
    try { await rm(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
