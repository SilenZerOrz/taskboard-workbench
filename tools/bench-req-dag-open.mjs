/**
 * 需求条目详情「任务 DAG 节点可点开任务」—— **真实浏览器 DOM 验证台**（真 headless Chrome + CDP，零依赖）。
 *
 * ## 为什么需要这台（真机批注 2026-10-29）
 * 「从需求条目点击查看，看到受阻的任务 DAG 提醒，支持点击跳转任务查看」。
 * 现象：抽屉下方「任务 DAG」里的节点是**纯展示 `<div>`**，点了没反应；而同一抽屉里
 * 「关联任务完成情况」那一行早就配了「打开任务」按钮 —— **同一张卡，两种可达性**。
 *
 * 单测（`tests/req-dag-open.test.mjs`）只能读源码文本："是 button" 证明不了"点得开"，
 * 也证明不了 `div → button` 之后没留下 UA 默认样式（灰底 / 居中 / 默认字号 / 按内容收缩）。
 * 所以必须有这台：**在真实渲染后的 DOM 里读元素类型、几何与计算样式，并真的点一下。**
 *
 * ## 本台断言什么
 *   A. DAG 段存在，节点数 = 2；每个节点都是 `BUTTON` 且 `type=button`；
 *   B. `title` 提示齐（`打开任务 <编号>`）—— 人不用先点才知道能点；
 *   C. 样式复位：`text-align:left` / `cursor:pointer` / 字体与正文一致；
 *   D. 宽度真的撑满 DAG 容器（按钮默认按内容收缩 ⇒ 不撑满就是回归成"千层饼"）；
 *   E. `:hover` 真的换边框色（用 `CSS.forcePseudoState` 强制 hover，确定性可复跑）；
 *   F. **点击受阻节点 ⇒ 任务详情抽屉打开，且标题编号正是那张卡**（这才是本条验收）；
 *   G. 点击后**不得**出现错误横幅（旧口径"该任务不在当前列表（可能已归档）"会走 `showBanner(..., "error")`）；
 *   H. 兜底路径的依赖可用：真 HTTP `GET /api/tasks/:ref` ⇒ 200 且编号匹配（`openTaskByRef` 现取那张卡就靠它）。
 *
 * ## 反向对照（反证本台真的会红）
 *   `TB_BENCH_WEB_DIR=/tmp/<旧版 web 副本> node tools/bench-req-dag-open.mjs`
 *   —— 把 `web/` 拷一份，把 `mk("button", "req-node")` 改回 `mk("div", "req-node")` 并摘掉 click，
 *   本台应转红（A/B/C/D/F）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时 Chrome profile + 随机端口 + 独立进程，跑完即删。
 * **不碰 `:3080`、不碰 `:47830`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 * ⚠️ 沙箱内起不了 GUI/Chrome（SIGABRT）——本台必须在**沙箱外**跑（`sandbox_permissions: require_escalated`）。
 *
 * 运行：`node tools/bench-req-dag-open.mjs`
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
const VIEW = { width: 1723, height: 1249 };
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>180s）——已强退，退出码 1"); process.exit(1); }, 180000);

// ---- 浏览器探测（找不到 ⇒ 跳过，不算失败） -------------------------------------------------
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

let dataDir = null;
let chromeProfile = null;
let server = null;
let chrome = null;

try {
  // ---- 隔离服务：临时 dataDir + 随机端口，真 `web/` ----
  dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqdag-"));
  chromeProfile = await mkdtemp(path.join(os.tmpdir(), "tb-reqdag-chrome-"));
  const store = openStore({ dataDir, env: {} });
  store.createProject({ id: "default", name: "默认项目" });
  const doc = store.ensureRequirementDoc("default", { body: "# 需求\n" });
  const item = store.createRequirementItem({
    projectId: "default",
    title: "B1 生产切换（含回滚预案）",
    status: "open",
    docId: doc.id,
    description: "按 C0→C6 手册执行；需停写窗口。",
  });
  // 前置卡 + 受阻卡：DAG 才有「⛔ 受阻」节点可点（正是真机截图里那一行）。
  // **故意先建"被卡"的那张**：只按 created_at 排会把前置排到后面，这样 I 才是真判据。
  const blocked = store.createTask({ projectId: "default", title: "C4 生产切换（8091 → 8096）", status: "blocked", requirementId: item.identifier });
  const blocker = store.createTask({ projectId: "default", title: "C0 停写窗口对齐", status: "todo", requirementId: item.identifier });
  store.addTaskDependency({ blocker: blocker.identifier, blocked: blocked.identifier, reason: "停写窗口未确认" });

  server = createServer({ store, webDir: WEB_DIR });
  const port = await freePort();
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const base = `http://127.0.0.1:${port}`;

  // ---- 真 headless Chrome + CDP ----
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
    console.log("SKIP  devtools 端点未就绪 ——本台不产证据，退出码 2");
    process.exit(2);
  }
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

  // ---- 打开需求条目详情（页面默认看板视图，必须先切「需求」） ----
  await S("Emulation.setDeviceMetricsOverride", { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false });
  await S("Page.navigate", { url: `${base}/` });
  await sleep(2000);
  for (let i = 0; i < 40; i += 1) {
    const r = await evalJs(`(() => { const b = [...document.querySelectorAll('header button')].find((n) => n.textContent.trim() === '需求'); if (!b) return 'no-btn'; b.click(); return 'clicked'; })()`);
    if (r === "no-btn") { await sleep(300); continue; }
    await sleep(600);
    const n = await evalJs(`document.querySelectorAll('.req-list .req-item').length`);
    if (n > 0) break;
  }
  const opened = await evalJs(`(() => { const row = document.querySelector('.req-list .req-item'); if (!row) return 'no-row'; row.click(); return 'clicked'; })()`);
  await sleep(1200);

  // ---- A/B：节点形态 ----
  const nodes = await evalJs(`(() => {
    const list = [...document.querySelectorAll('.req-node')];
    return list.map((n) => ({
      tag: n.tagName,
      type: n.type ?? null,
      title: n.title ?? '',
      text: n.textContent.trim(),
      rect: (() => { const r = n.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), x: r.x, y: r.y }; })(),
      style: (() => { const s = getComputedStyle(n); return { textAlign: s.textAlign, cursor: s.cursor, fontFamily: s.fontFamily, borderColor: s.borderTopColor }; })(),
    }));
  })()`);
  check("A1 能打开需求条目详情，DAG 段渲染出 2 个节点", opened === "clicked" && nodes.length === 2, `opened=${opened} nodes=${nodes.length}`);
  const tags = [...new Set(nodes.map((n) => n.tag))].join(",");
  check("A2 DAG 节点是 button（div 点不动）且 type=button", nodes.length > 0 && nodes.every((n) => n.tag === "BUTTON" && n.type === "button"), `tags=${tags}`);
  const ids = [blocker.identifier, blocked.identifier];
  check(
    "B 每个节点都带 title=「打开任务 <编号>」",
    nodes.length === 2 && ids.every((id) => nodes.some((n) => n.title === `打开任务 ${id}`)),
    `titles=${nodes.map((n) => n.title).join(" | ")}`,
  );
  check("B2 受阻节点带着「受阻」字样（真机截图那一行）", nodes.some((n) => n.text.includes("受阻")), nodes.map((n) => n.text).join(" | "));

  // ---- C/D：样式复位 + 撑满 ----
  const bodyFont = await evalJs(`getComputedStyle(document.body).fontFamily`);
  check("C1 字体继承正文（不留 UA 默认按钮字体）", nodes.length > 0 && nodes.every((n) => n.style.fontFamily === bodyFont), `body=${bodyFont} node=${nodes[0]?.style.fontFamily}`);
  check("C2 左对齐 + 指针反馈", nodes.length > 0 && nodes.every((n) => n.style.textAlign === "left" && n.style.cursor === "pointer"), `align=${nodes[0]?.style.textAlign} cursor=${nodes[0]?.style.cursor}`);
  const dagW = await evalJs(`(() => { const d = document.querySelector('.req-dag'); return d ? Math.round(d.getBoundingClientRect().width) : null; })()`);
  check("D 节点宽度撑满 DAG 容器（按钮默认按内容收缩 ⇒ 会成「千层饼」）", dagW != null && nodes.length > 0 && nodes.every((n) => Math.abs(n.rect.w - dagW) <= 2), `dag=${dagW} nodes=${nodes.map((n) => n.rect.w).join(",")}`);

  // ---- E：:hover 真换边框色（forcePseudoState，确定性） ----
  await S("DOM.enable");
  await S("CSS.enable");
  const hoverIdx = nodes.findIndex((n) => n.text.includes("受阻"));
  let hoverOk = false;
  let hoverDetail = "";
  try {
    const { root } = await S("DOM.getDocument", { depth: -1 });
    const { nodeIds } = await S("DOM.querySelectorAll", { nodeId: root.nodeId, selector: ".req-node" });
    if (nodeIds?.length) {
      await S("CSS.forcePseudoState", { nodeId: nodeIds[hoverIdx], forcedPseudoClasses: ["hover"] });
      await sleep(120);
      const hovered = await evalJs(`(() => { const n = document.querySelectorAll('.req-node')[${hoverIdx}]; return getComputedStyle(n).borderTopColor; })()`);
      hoverOk = hovered !== nodes[hoverIdx].style.borderColor;
      hoverDetail = `idle=${nodes[hoverIdx].style.borderColor} hover=${hovered}`;
      await S("CSS.forcePseudoState", { nodeId: nodeIds[hoverIdx], forcedPseudoClasses: [] });
    } else hoverDetail = "querySelectorAll 空";
  } catch (e) { hoverDetail = `forcePseudoState 失败：${e.message}`; }
  check("E :hover 换边框色（可点性要看得见）", hoverOk, hoverDetail);

  // ---- F/G：点一下受阻节点 ⇒ 打开那张卡 ----
  const clickRes = await evalJs(`(() => {
    const n = [...document.querySelectorAll('.req-node')].find((x) => x.textContent.includes('受阻'));
    if (!n) return { clicked: false };
    n.click();
    return { clicked: true };
  })()`);
  await sleep(1500);
  // 注意：需求条目抽屉自己的类名是 `tb-drawer tb-req-drawer`（复用抽屉壳），
  // 且在 DOM 里排在任务抽屉之前 ⇒ 必须排除它，否则查到的是「条目详情」那一张。
  const after = await evalJs(`(() => {
    const d = document.querySelector('.tb-drawer:not(.tb-req-drawer)');
    const bannerEl = document.querySelector('.banner.error');
    return {
      drawerShown: !!d && d.classList.contains('show'),
      id: d?.querySelector('.tb-drawer-id')?.textContent.trim() ?? '',
      title: d?.querySelector('.tb-drawer-head h2')?.textContent.trim() ?? '',
      errorBanner: !!bannerEl && !bannerEl.hidden ? bannerEl.textContent.trim() : null,
    };
  })()`);
  check(
    "F 点受阻 DAG 节点 ⇒ 任务详情抽屉打开，且正是那张卡",
    clickRes.clicked === true && after.drawerShown === true && after.id === blocked.identifier,
    `clicked=${clickRes.clicked} shown=${after.drawerShown} id=${after.id} title=${after.title}`,
  );
  check("G 点击后无错误横幅（旧口径会提示「可能已归档」）", after.errorBanner === null, after.errorBanner ?? "无 error 横幅");

  // ---- H：兜底路径依赖的端点真的可用 ----
  const rH = await fetch(`${base}/api/tasks/${encodeURIComponent(blocked.identifier)}`);
  const hBody = rH.ok ? await rH.json() : null;
  check("H GET /api/tasks/:ref 可用（列表查不到时按编号现取就靠它）", rH.status === 200 && hBody?.task?.identifier === blocked.identifier, `status=${rH.status} id=${hBody?.task?.identifier}`);

  // ---- I/J/K：DAG 可读性三件事（拓扑序 / 前置胶囊 / 明细默认收起） ----
  const dagInfo = await evalJs(`(() => {
    const nodes = [...document.querySelectorAll('.req-node')];
    const tail = nodes.find((n) => n.textContent.includes('受阻'));
    const details = document.querySelector('.req-dag-edges');
    return {
      order: nodes.map((n) => n.textContent.trim()),
      chip: tail?.querySelector('.req-node-blocked-by')?.textContent.trim() ?? null,
      chipTitle: tail?.querySelector('.req-node-blocked-by')?.title ?? null,
      hasDetails: !!details,
      detailsOpen: details ? details.open === true : null,
      detailsText: details ? details.textContent.trim() : null,
    };
  })()`);
  check(
    "I 前置在上（稳定拓扑序）：被卡的那张先建，也排在后面",
    dagInfo.order.length === 2 && dagInfo.order[0].includes(blocker.identifier),
    `order=${dagInfo.order.map((t) => t.slice(0, 18)).join(" | ")}`,
  );
  check(
    "J 受阻节点自带「⬅ 前置 <编号>」胶囊，title 带原因",
    dagInfo.chip === `⬅ 前置 ${blocker.identifier}` && String(dagInfo.chipTitle ?? "").includes("停写窗口未确认"),
    `chip=${dagInfo.chip} title=${dagInfo.chipTitle}`,
  );
  check(
    "K 依赖明细默认收起；点开后边上有原始 reason",
    dagInfo.hasDetails === true && dagInfo.detailsOpen === false && dagInfo.detailsText.includes(`${blocker.identifier} → ${blocked.identifier}`) && dagInfo.detailsText.includes("停写窗口未确认"),
    `open=${dagInfo.detailsOpen} text=${String(dagInfo.detailsText).slice(0, 60)}`,
  );

  // ---- L/M：能力门（本台跑在**无宿主**实例上，等价于 :47830） ----
  const hostGate = await evalJs(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '自动生成（交主会话）');
    const notice = document.querySelector('.banner.warn');
    return {
      found: !!btn,
      disabled: btn?.disabled === true,
      title: btn?.title ?? '',
      noticeShown: !!notice && !notice.hidden,
      noticeText: notice?.textContent ?? '',
    };
  })()`);
  check(
    "L 无宿主实例上，「自动生成（交主会话）」必须置灰并说明原因",
    hostGate.found === true && hostGate.disabled === true && hostGate.title.includes("无宿主会话通道"),
    `found=${hostGate.found} disabled=${hostGate.disabled} title=${hostGate.title.slice(0, 40)}`,
  );
  check(
    "M 常驻提示可见且指路到 DSH 内的任务工作台",
    hostGate.noticeShown === true && hostGate.noticeText.includes("/integrations/taskboard-workbench"),
    `shown=${hostGate.noticeShown}`,
  );

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
  try { if (chromeProfile) await rm(chromeProfile, { recursive: true, force: true }); } catch { /* ignore */ }
  try { if (dataDir) await rm(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
