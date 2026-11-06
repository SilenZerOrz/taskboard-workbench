/**
 * 配置页「引入主对话」（开局缺口清单）—— **真机验收台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（看板卡 `-231` / 需求 `R170`）
 * 本台走的就是人实际会走的那条路：**半完成开局 → 点「引入主对话」→ 主会话真收到 todolist →
 * 补完一条再点「重新自检」→ 配置页把结果回写**（✅ 与计数随真实判据变化）。
 * `-229` / `-230` 已把「配置页自检 → 缺口聚合 → 一条指令投给项目主会话」做完，但前两卡的读数
 * **全部停在「`sendPrompt` 被桩住 + 正文形状对」**（评审 t3 F5 明文要求：真机部分归 `-231`）。
 * 有一类缺陷只有**真渲染 + 真点击 + 真宿主通道**才读得出：
 *   · 缺口数在**四处**（GET 回包 / DOM 未完成项 / 提示语「缺口 N 项」/ announce 回包）各算一遍，
 *     任一处取错源都不会报错，只会安静地不一致；
 *   · 「引入主对话」按钮是**点不动**（无缺口时应当置灰）还是**点了没投**（通道没接上）；
 *   · 补完文件后点「重新自检」，✅ 与计数**是否随真实判据变化**（而不是画了个静态勾）。
 *
 * ## 本台断言什么（种子：**半完成开局** —— 工作区只有 README.md / envConfig ✓ / 团队模板仅 engineer）
 *   A. 缺口数与清单一致：`Σ missing[].todo` === DOM 里 `.kickoff-todo li` 条数 === 提示语「缺口 N 项」的 N
 *      === `POST /kickoff/announce` 回包的 `gaps.count`（**四处同一份真源**，任一走样即红）；
 *   B1. 点击「引入主对话」后，投出去的那条指令里 **todo ≥ 5 条**（六步全缺 ⇒ 6 条）；
 *   B2. todo 顺序 = 依赖顺序（`① 统一代码规范 → ② 文档驱动开发 → ③ Git 协作流程 → ④ 代码审查门
 *       → ⑤ 协作机制与知识沉淀 → ⑥ 明确分工` 的**子序列**，不乱序、不夹生）；
 *   B3. **宿主会话通道恰好收到 1 条**、正文与 announce 回包逐字相同、`sid` = 项目主会话
 *       —— 这是反证会红的断言（不点按钮 ⇒ 收到 0 条）；
 *   B4. `announce.delivered === true`（没有静默降级还谎称已投）；
 *   C1. 把 ① 的三条判据补齐后点「重新自检」：① 行变 `done` 且胶囊 `3/3`；
 *   C2. 计数真的动：`done` 行数 +1，且重新 GET 的未完成判据数 = `gapBefore - 3`（代码规范 3 条由缺转过）；
 *   D1. 补齐剩余判据（文件 + 项目设置）后 `GET /kickoff` 的 `ready === true`；
 *   D2. DOM 提示语真的写「开局已对齐」；
 *   D3. 「引入主对话」置灰且 `title` 说明「已对齐」（不是留一个点了没反应的活按钮）；
 *   D4. **点它无效**：置灰状态下再点，宿主通道收到的条数不变（仍 1 条）；
 *   E.  正常路径无 error 横幅（含点完置灰按钮之后）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_NO_ANNOUNCE=1 node tools/bench-open-gaps.mjs`
 *   ⇒ 跳过「引入主对话」这一击 ⇒ B3 的「恰好 1 条」转红（通道收到 0 条）、D4 随之转红
 *   （D4 要求「点前 1 条 → 点后仍 1 条」，0→0 不成立），退出码 1。
 *   另有 `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本>` 入口：旧前端（按钮恒可点 / 零缺口不置灰 /
 *   缺口语不显示）会让 B3/D2/D3 转红。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区（`wsDir`，种子文件只写在这里）+ 临时 Chrome profile + 随机端口 +
 * 独立 `createServer` 进程内实例，跑完即删（`finally` 里清 watchdog / kill Chrome / 关 server /
 * `store.close()` / `rm(dataDir)` / `rm(wsDir)` / `rm(chromeProfile)`）。
 * **不碰 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围）。
 * 宿主会话通道是**假端口**（只记录 `sid`/正文，不真投），不建真 DSH 会话。
 * ⚠️ 沙箱内起不了 Chrome ⇒ 本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-open-gaps.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（沙箱内 / 找不到 Chrome）⇒ 跳过。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
/** 反证开关：置 1 ⇒ 不点「引入主对话」，B3 应转红。 */
const NO_ANNOUNCE = Boolean(process.env.TB_BENCH_NO_ANNOUNCE);
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 受管资源（清理由下方 finally / 看门狗共用；**声明先于看门狗**，避免 TDZ 依赖"240s 内不会触发"这种假设）。
let chrome = null;
let chromeProfile = null;
let ws = null;
const servers = [];
const workspaces = [];
/** 已建的临时 dataDir —— 独立于 `servers`（后者是**入栈后**才清），保证 openStore/listen 中途抛错也不留库目录。 */
const dataDirs = [];

const watchdog = setTimeout(() => {
  // 超时也要**先收干净再退**：`process.exit` 会跳过 finally，否则 headless Chrome 与临时 profile
  // 会留成孤儿（本仓有过孤儿进程事故）。
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  try { ws?.close(); } catch { /* ignore */ }
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

try {
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-opengaps-chrome-"));
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
    // 直接 `process.exit(2)` 会**跳过 finally**，把刚 spawn 的 headless Chrome 和临时 profile 留在机器上
    // （本仓有过孤儿进程事故的先例）⇒ 这一支自己先清干净。server 此时还没起，只需收 chrome + profile。
    try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
    try { await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log("SKIP  devtools 端点未就绪 ——本台不产证据，退出码 2");
    process.exit(2);
  }

  ws = new WebSocket(wsUrl);
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
  /** 轮询到条件成立（页面重渲染期间的瞬时异常按「未就绪」处理，不当作失败）。 */
  const waitUntil = async (fn, timeoutMs = 6000, intervalMs = 150) => {
    const t0 = Date.now();
    for (;;) {
      try { if (await fn()) return true; } catch { /* 未就绪 */ }
      if (Date.now() - t0 >= timeoutMs) return false;
      await sleep(intervalMs);
    }
  };

  // ---- 种子：**半完成开局**（只满足 ② 的一条判据：工作区有 README.md）----
  // 其余一律缺：① 规范文档/linter/formatter · ② 参与指南/变更记录 · ③ PR 模板/Git 约定 ·
  // ④ reviewer 角色/质量门 · ⑤ 站会节奏/知识沉淀 · ⑥ engineer executor ⇒ 预期缺口 12 项（判据 14 条过 2 条）。
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-opengaps-"));
  dataDirs.push(dataDir);
  const wsDir = await mkdtemp(path.join(os.tmpdir(), "tb-opengaps-ws-"));
  workspaces.push(wsDir);
  await writeFile(path.join(wsDir, "README.md"), "# demo\n");
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "opengaps", name: "半完成开局项目", workspacePath: wsDir });
  store.bindInitialSession("opengaps", "sess-opengaps-main");
  store.saveProjectSettings("opengaps", {
    envConfig: { NODE_ENV: "test" },
    teamTemplate: { engine: "instruction", roles: [{ role: "engineer", count: 1 }] },
  });
  // 假宿主会话通道：只记录不真投（真投要建真 DSH 会话 ⇒ 会碰 ~/.dsh/**，红线）。
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, prompt) => { sent.push({ sid, prompt }); return { sent: true }; } };
  const server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  servers.push({ server, store });
  const base = `http://127.0.0.1:${port}`;

  // ---- Node 侧 API 小工具（直接 fetch 到 base，不经过浏览器）----
  const apiGet = async (p) => (await fetch(`${base}${p}`)).json();
  const apiPost = async (p, body) => (await fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const apiPut = async (p, body) => (await fetch(`${base}${p}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  await S("Page.navigate", { url: `${base}/` });
  await sleep(2400);

  /** 点 header 的「配置」，等配置卡渲染出来（与 `bench-config-guide` 同一套导航）。 */
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

  /**
   * 读「项目开局对齐」盒子的**渲染后**状态：
   *   rows（每步 class/胶囊/标题）· todoCount（未完成判据 li 条数）· bar（按钮三态）· hint · error。
   * 注意 `.kickoff-todo li` 只在步骤 `status !== 'done'` 时渲染 ⇒ 条数 == 缺口判据数。
   */
  const readAlign = () => evalJs(`(() => {
    const root = document.querySelector('#tb-app');
    const box = root ? root.querySelector('.kickoff-box') : null;
    if (!box) return { ok: false, note: 'no kickoff-box' };
    const rows = [...box.querySelectorAll('.kickoff-step')].map((el) => ({
      cls: el.className,
      pill: (el.querySelector('.chip')?.textContent ?? '').trim(),
      title: (el.querySelector('.kickoff-title')?.textContent ?? '').trim(),
    }));
    const todoCount = box.querySelectorAll('.kickoff-todo li').length;
    const bar = [...box.querySelectorAll('.btn-row button')].map((b) => ({
      text: b.textContent.trim(), disabled: b.disabled, title: b.title,
    }));
    const hint = (box.querySelector('.btn-row .hint')?.textContent ?? '').trim();
    // ⚠ 带 .banner.error 的节点**不止一个**（一次性提示 banner / 断线 connNotice）：
    // querySelector 只拿 DOM 里第一个 —— 那恰好是**一次性 banner**，它 hidden 时会盖住后面那个
    // **可见的**断线条，E 于是假绿。这里改成「把可见的 error 条全收上来」。
    const errs = [...root.querySelectorAll('.banner.error')]
      .filter((el) => !el.hidden && (el.textContent ?? '').trim() !== '')
      .map((el) => (el.textContent ?? '').trim());
    return {
      ok: true, rows, todoCount, bar, hint,
      error: errs.length ? errs.join(' ／ ') : null,
    };
  })()`);

  /** 按可见文本点 `.kickoff-box .btn-row` 里的按钮（置灰的也点，由调用方判是否该无效）。 */
  const clickBarByText = (text) => evalJs(`(() => {
    const box = document.querySelector('#tb-app .kickoff-box');
    if (!box) return 'no-box';
    const b = [...box.querySelectorAll('.btn-row button')].find((n) => n.textContent.trim() === ${JSON.stringify(text)});
    if (!b) return 'not-found';
    b.click();
    return 'clicked';
  })()`);

  // ---- A：缺口数**四处一致** ----
  const k = await apiGet("/api/projects/opengaps/kickoff");
  const expect = (k.missing ?? []).reduce((n, s) => n + (s.todo?.length ?? 0), 0);
  const domA = await waitUntil(async () => {
    const r = await readAlign();
    return r.ok && r.rows.length > 0 && r.todoCount === expect;
  });
  const domRead = await readAlign();
  const domTodo = domRead.ok ? domRead.todoCount : -1;
  const hintMatch = /缺口\s*(\d+)\s*项/.exec(domRead.ok ? domRead.hint : "");
  const hintN = Number(hintMatch?.[1] ?? NaN);
  const ann = await apiPost("/api/projects/opengaps/kickoff/announce", {});
  const annN = ann?.gaps?.count ?? -1;
  check(
    "A 缺口数与清单一致（接口 / DOM 未完成项 / 提示语 / announce 回包）",
    expect > 0 && expect === domTodo && expect === hintN && expect === annN,
    `expect=${expect} domTodo=${domTodo} hintN=${hintN} ann=${annN} readable=${k.readable} domWaited=${domA}`,
  );
  const gapBefore = expect;

  // A 的那次 announce 是**接口直投**（用于核对 gaps.count）；B 只量「按按钮」这一击的投递。
  // 这里把假通道清零，是为了让 B3 的「恰好 1 条」读的是**UI 动作**的因果，而不是两次调用的和。
  sent.length = 0;

  // ---- B：点「引入主对话」⇒ 主会话真收到分步清单 ----
  if (NO_ANNOUNCE) {
    await sleep(300);
  } else {
    // 等按钮渲染出来且**可点**（自检回来之前它一直是 disabled 态）。
    await waitUntil(async () => {
      const r = await readAlign();
      const b = r.ok ? r.bar.find((x) => x.text === "引入主对话") : null;
      return Boolean(b) && b.disabled === false;
    }, 6000);
    await clickBarByText("引入主对话");
    await sleep(600);
    await waitUntil(() => sent.length >= 1, 4000);
  }
  const prompt = String(ann?.prompt ?? "");
  // B1/B2 读的是**宿主真收到的那条正文**（`sent[0].prompt`），不是接口回包 —— 否则「界面按钮投了别的东西」
  // 这类缺陷只有 B3 会红，而 B1/B2 照样绿（清单形状对、投出去的却不对）。未点按钮时回落回包，让反证仍可读。
  const deliveredPrompt = String(sent[0]?.prompt ?? prompt);
  // 正文里 todo 行的形状：`1. [ ] ① 统一代码规范`（buildKickoffTodos 的 index + step）。
  const titles = [...deliveredPrompt.matchAll(/^\d+\. \[ \] (.+)$/gm)].map((m) => m[1]);
  check("B1 投出的清单 todo ≥ 5 条（六步全缺 ⇒ 6 条）", titles.length >= 5, `titles=${titles.length} ${JSON.stringify(titles)}`);

  const CANON = ["① 统一代码规范", "② 文档驱动开发", "③ Git 协作流程", "④ 代码审查门", "⑤ 协作机制与知识沉淀", "⑥ 明确分工"];
  let lastIdx = -1;
  const offOrder = [];
  for (const t of titles) {
    const idx = CANON.indexOf(t);
    if (idx === -1 || idx <= lastIdx) offOrder.push(t);
    else lastIdx = idx;
  }
  check(
    "B2 todo 顺序 = 依赖顺序（规范 → 文档 → Git → 审查 → 协作 → 分工 的子序列）",
    titles.length > 0 && offOrder.length === 0,
    `offOrder=${JSON.stringify(offOrder)} titles=${JSON.stringify(titles)}`,
  );

  check(
    "B3 宿主会话通道恰好收到 1 条，且正文/会话标识与 announce 回包一致",
    sent.length === 1 && sent[0].prompt === prompt && sent[0].sid === "sess-opengaps-main",
    `sent=${sent.length} sid=${sent[0]?.sid ?? "—"} promptEqual=${sent[0] ? sent[0].prompt === prompt : false}${NO_ANNOUNCE ? "（TB_BENCH_NO_ANNOUNCE=1：未点按钮）" : ""}`,
  );
  check("B4 announce 如实回报 delivered=true", ann?.delivered === true, `delivered=${ann?.delivered} reason=${ann?.reason ?? "—"}`);

  // ---- C：补齐 ① 的三条判据 ⇒ 该行 ✅ 且计数上升 ----
  const before = await readAlign();
  const doneBefore = before.ok ? before.rows.filter((r) => r.cls.includes("done")).length : -1;
  const pillBefore = before.ok ? (before.rows.find((r) => r.title.includes("统一代码规范"))?.pill ?? "—") : "—";
  // 判据口径提醒：① 的三条是「规范文档 / Linter / Formatter」**各一条**。
  // 卡面原写「写 .eslintrc + .prettierrc ⇒ 3/3」，实测只能到 2/3（规范文档仍缺、步骤仍 partial、缺口 12→10）；
  // 故这里补写一份 `CODE_STYLE.md`，让 ① 真的三条全过（✅ 与缺口 -3 才是卡面要的读数）。
  await writeFile(path.join(wsDir, ".eslintrc.json"), "{}\n");
  await writeFile(path.join(wsDir, ".prettierrc"), "{}\n");
  await writeFile(path.join(wsDir, "CODE_STYLE.md"), "# 代码规范\n\n- 2 空格缩进；提交前跑 eslint + prettier。\n");
  await clickBarByText("重新自检");
  await waitUntil(async () => {
    const r = await readAlign();
    const row = r.ok ? r.rows.find((x) => x.title.includes("统一代码规范")) : null;
    return Boolean(row) && row.cls.includes("done") && row.pill.includes("3/3");
  }, 6000);
  const after = await readAlign();
  const rowC = after.ok ? after.rows.find((r) => r.title.includes("统一代码规范")) : null;
  check(
    "C1 补齐 ① 的 3 条判据后，该行变 done 且胶囊 0/3 → 3/3",
    Boolean(rowC) && rowC.cls.includes("done") && rowC.pill.includes("3/3"),
    `pillBefore=${pillBefore} pillAfter=${rowC?.pill ?? "—"} clsAfter=${rowC?.cls ?? "—"}`,
  );
  const k2 = await apiGet("/api/projects/opengaps/kickoff");
  const gapAfter = (k2.missing ?? []).reduce((n, s) => n + (s.todo?.length ?? 0), 0);
  const doneC = after.ok ? after.rows.filter((r) => r.cls.includes("done")).length : -2;
  check(
    "C2 计数真的动：done 行 +1，未完成判据 = gapBefore - 3",
    doneC === doneBefore + 1 && gapAfter === gapBefore - 3,
    `done ${doneBefore}→${doneC} · gap ${gapBefore}→${gapAfter}（期望 ${gapBefore - 3}）`,
  );

  // ---- D：补齐剩余判据 ⇒ 零缺口、按钮置灰、点它无效 ----
  await mkdir(path.join(wsDir, ".github"), { recursive: true });
  await mkdir(path.join(wsDir, "docs", "规范"), { recursive: true });
  await writeFile(path.join(wsDir, "CLAUDE.md"), "# 项目规则\n");
  await writeFile(path.join(wsDir, "CONTRIBUTING.md"), "# 参与指南\n");
  await writeFile(path.join(wsDir, "CHANGELOG.md"), "# 变更记录\n");
  await writeFile(path.join(wsDir, ".github", "PULL_REQUEST_TEMPLATE.md"), "## 变更说明\n");
  await writeFile(path.join(wsDir, "docs", "规范", "README.md"), "# 规范\n");
  await apiPut("/api/projects/opengaps/settings", {
    envConfig: {
      NODE_ENV: "test",
      gitFlow: "main + feature/xxx + Conventional Commits",
      cadence: "每日站会",
      qualityGates: ["需求", "实现", "验证"],
    },
    teamTemplate: {
      engine: "instruction",
      roles: [
        { role: "lead", count: 1 },
        { role: "reviewer", count: 1 },
        { role: "engineer", count: 1, executor: "claude -p" },
      ],
      qualityGates: ["需求", "实现", "验证", "审查", "集成"],
    },
  });
  await clickBarByText("重新自检");
  await waitUntil(async () => {
    const r = await readAlign();
    return r.ok && r.hint.includes("开局已对齐");
  }, 6000);
  const full = await readAlign();
  const k3 = await apiGet("/api/projects/opengaps/kickoff");
  check("D1 零缺口：GET /kickoff ready=true", k3.ready === true, `ready=${k3.ready} verdict=${k3.verdict ?? "—"}`);
  check("D2 提示语写明「开局已对齐」", full.ok && full.hint.includes("开局已对齐"), `hint=${full.ok ? full.hint : full.note}`);
  const gapBtn = full.ok ? full.bar.find((b) => b.text === "引入主对话") : null;
  check(
    "D3 零缺口 ⇒「引入主对话」置灰 + title 说明已对齐",
    Boolean(gapBtn) && gapBtn.disabled === true && gapBtn.title.includes("已对齐"),
    gapBtn ? `disabled=${gapBtn.disabled} title=${gapBtn.title}` : `no 引入主对话 button（bar=${JSON.stringify(full.ok ? full.bar.map((b) => b.text) : [])}）`,
  );
  const sentBeforeClick = sent.length;
  await clickBarByText("引入主对话");
  await sleep(400);
  // 判据写成「点前恰好 1 条、点后仍是 1 条」，而不是「点前 === 点后」：后者在 0→0 时**真空通过**
  // （`TB_BENCH_NO_ANNOUNCE=1` 全程没投过，`0 === 0` 会假绿），反证就红不了。
  check(
    "D4 置灰状态下点它无效（宿主通道不再多收）",
    sentBeforeClick === 1 && sent.length === 1,
    `sent ${sentBeforeClick}→${sent.length}（期望 1→1）`,
  );

  // ---- E：正常路径无 error 横幅 ----
  const final = await readAlign();
  check(
    "E 正常路径无 error 横幅（含点完置灰按钮之后）",
    full.ok && full.error === null && final.ok && final.error === null,
    `before=${full.ok ? (full.error ?? "无") : full.note} after=${final.ok ? (final.error ?? "无") : final.note}`,
  );
} finally {
  clearTimeout(watchdog);
  try { ws?.close(); } catch { /* ignore */ }
  try { chrome?.kill("SIGKILL"); } catch { /* ignore */ }
  for (const { server, store } of servers) {
    // SSE 长连接会让 server.close 永不回调（同 server.mjs:194 的孤儿事故根因）⇒ 先强断。
    try { server.closeAllConnections?.(); } catch { /* ignore */ }
    try { await new Promise((r) => server.close(r)); } catch { /* ignore */ }
    try { store.close?.(); } catch { /* ignore */ }
  }
  // dataDir 用受管清单（不是 servers 的元素）：openStore/listen 中途抛错时 server 没入栈，
  // 但库目录已经建出来了 —— 只按 servers 清会把它留在 /tmp 里。
  for (const dir of dataDirs) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const dir of workspaces) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
process.exit(failed.length ? 1 : 0);
