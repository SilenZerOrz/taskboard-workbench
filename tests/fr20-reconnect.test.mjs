/**
 * FR-20 断线恢复 · 补口（卡 `taskboard-workbench-156`）。
 *
 * 背景（`docs/进度/2026-10-23-FR20断线恢复真机取证.md`，卡 `-154` 真机取证轮）：
 * FR-20 的**机制**本身可靠（断连期间旧卡原样保留、恢复后整块补齐、SSE 确实自动重连），
 * 但 `web/app.js` 的 `new EventSource(...)` **未挂 `onopen`、未挂 `onerror`**，留了两个缺口：
 *
 *   · **缺口 A（无断线提示）**：`onerror` 未挂 ⇒ 连接中断只体现在 `readyState=0`，
 *     UI 全无感知（真机读数：`.banner` 恒 `hidden`、文案变化轨迹为空数组）。
 *     违反 FR-19「此降级对用户可见（界面上有提示或说明）」的**同一口径**——
 *     FR-20 的验收要点④要求用户能看出界面可能在撒谎。
 *   · **缺口 B（重连不重取）**：`onopen` 未挂 ⇒ 重连成功不回灌 `reload()`，补齐只能靠
 *     「后续事件 / 60s 轮询 / focus·可见性」，真机实测最坏 **≈52s**（等 `watchdogPoll`），
 *     偏离 FR-20「无需用户手动刷新全部页面」。
 *
 * 本组钉四件事（沿用本仓「源码切片 + `new Function` 驱动」范式，见 `tests/fr96-*` / `tests/fr97-*`）：
 *   ① `onopen` / `onerror` **确实存在**，且 `onerror` 用 **`readyState` 判据**分流措辞
 *      （`CLOSED`=浏览器不再重连 vs 其余=重连中），不把两种状态混为一谈。
 *   ② 断线 → 提示**可见**（`connNotice.hidden === false` 且文案非空）；重连 → 提示**消失**。
 *   ③ 重连（含**首次连接**）**确实触发重取**，且走的是**既有 `loadTasks()`**（同一条取数通道）。
 *   ④ **不得把失效信号改成增量合并** —— 该区块不许出现 `state.tasks` 写入 / `push` / `splice`；
 *      四个入口必须是**同一个 `reload` 函数**，不许另开第二条取数路径。
 *
 * 红线：本组只读 `web/app.js` 源码 + 驱动切片，**不改数据、不碰 :3080、不起服务**。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const SOURCE = read("web/app.js");

/** SSE 接线区：从 `// FR-41：进度可见` 到 `// FR-75/76：看护状态会随`（两标记在 app.js 中唯一）。 */
function sseRegion() {
  const start = SOURCE.indexOf("// FR-41：进度可见（SSE 失效信号 → 重取）");
  assert.ok(start > 0, "app.js 里找不到 FR-41 SSE 接线区（被删或被改？）");
  const end = SOURCE.indexOf("// FR-75/76：看护状态会随");
  assert.ok(end > start, "SSE 接线区的结束标记（FR-75/76 注释）缺失");
  return SOURCE.slice(start, end);
}

/**
 * 用假 `EventSource` 驱动切片：
 *   · `onopen` / `onerror` 由切片**自己挂**（这正是被测物 —— 旧代码这两个是 undefined）。
 *   · `setTimeout` 捕获不执行，由 `flush()` 显式推进（`reload()` 有 150ms 防抖）。
 *   · 可用 `destroyed` 造「已销毁」态，验证重取被正确抑制。
 */
function harness({ destroyed = false, view = "board", detailTask = null } = {}) {
  const region = sseRegion();
  const calls = { loadTasks: 0, renderTeamView: 0, openTaskDetail: 0 };
  const pending = [];

  const source = {
    listeners: {},
    readyState: 1, // EventSource.OPEN
    closed: false,
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    close() { this.closed = true; },
  };
  const connNotice = { hidden: true, textContent: "" };

  const api = new Function(
    "EventSource", "connNotice", "apiBase", "view", "loadTasks", "renderTeamView",
    "openTaskDetail", "detailTask", "destroyed", "setTimeout", "clearTimeout",
    `${region}\n return { boardEvents };`,
  )(
    function FakeEventSource() { return source; },
    connNotice,
    "",
    view,
    () => { calls.loadTasks += 1; },
    () => { calls.renderTeamView += 1; },
    () => { calls.openTaskDetail += 1; },
    detailTask,
    destroyed,
    (fn) => { pending.push(fn); return pending.length; },
    () => {},
  );

  const flush = () => { const due = pending.splice(0); for (const fn of due) fn(); };

  return {
    region,
    source,
    connNotice,
    calls,
    flush,
    boardEvents: () => api.boardEvents,
    onopen: () => api.boardEvents && api.boardEvents.onopen,
    onerror: () => api.boardEvents && api.boardEvents.onerror,
  };
}

// ── ① 两个处理器确实挂上了（旧代码这里两个都是 undefined） ─────────────────────

test("FR-20-A：`onopen` / `onerror` 都已挂上（缺口根因就是这两个没挂）", () => {
  const h = harness();
  assert.equal(typeof h.onopen(), "function", "必须挂 `onopen`（否则重连成功不回灌重取）");
  assert.equal(typeof h.onerror(), "function", "必须挂 `onerror`（否则断线 UI 无感）");
  assert.ok(h.boardEvents(), "EventSource 实例必须被建出来");
  assert.equal(h.source.closed, false);
});

// ── ② 断线 → 可见提示；重连 → 提示消失 ────────────────────────────────────────

test("FR-20-A：断线（自动重连中，readyState=CONNECTING）→ 提示可见且文案非空", () => {
  const h = harness();
  h.source.readyState = 0; // EventSource.CONNECTING —— 浏览器正在自动重连
  h.onerror()();

  assert.equal(h.connNotice.hidden, false, "断线必须让提示**可见**（旧代码恒 hidden）");
  assert.ok(String(h.connNotice.textContent).trim().length > 0, "提示必须有文案，不得是空串");
  assert.match(h.connNotice.textContent, /重连中/, "自动重连中须如实说「重连中」");
  assert.match(h.connNotice.textContent, /连接中断/, "须明写「连接中断」（用户看得出断了）");
});

test("FR-20-A：连接彻底关闭（readyState=CLOSED）→ 措辞区分「不再自动重连」并给出路", () => {
  const h = harness();
  h.source.readyState = 2; // EventSource.CLOSED —— 规范上浏览器**不会**再自动重连
  h.onerror()();

  assert.equal(h.connNotice.hidden, false);
  assert.match(h.connNotice.textContent, /已断开/, "终态须说「已断开」，不得谎称「重连中」");
  assert.match(h.connNotice.textContent, /刷新/, "终态须给出路（刷新页面重试），不能只说断了");
  assert.ok(
    !/重连中/.test(h.connNotice.textContent),
    "CLOSED 时不得混入「重连中」措辞（两种状态的处置完全不同）",
  );
});

test("FR-20-A：重连成功 → 提示消失（恢复后不得继续挂着「重连中」）", () => {
  const h = harness();
  h.source.readyState = 0;
  h.onerror()();
  assert.equal(h.connNotice.hidden, false, "先断线 → 提示可见");

  h.source.readyState = 1; // OPEN
  h.onopen()();
  assert.equal(h.connNotice.hidden, true, "重连成功必须收起提示");
});

// ── ③ 重连（含首次连接）确实触发重取 ─────────────────────────────────────────

test("FR-20-B：重连成功 → 立即重取一次（走既有 loadTasks）", () => {
  const h = harness();
  assert.equal(h.calls.loadTasks, 0, "构造时不得立即取数（取数仍由 bootstrap 负责）");

  h.onopen()(); // 重连成功
  h.flush();     // 推进 reload() 的 150ms 防抖
  assert.equal(h.calls.loadTasks, 1, "重连成功必须回灌一次取数（缺口 B：旧代码这里是 0）");
});

test("FR-20-B：**首次**连接同样触发一次重取（onopen 对首连与重连一视同仁）", () => {
  const h = harness();
  h.onopen()(); // 首连也是 onopen
  h.flush();
  assert.equal(h.calls.loadTasks, 1, "首次连接后也必须立即重取一次（口径含首次）");
});

test("FR-20-B：重取随当前视图 / 已开抽屉走（board / team / 详情各自刷新）", () => {
  const board = harness({ view: "board" });
  board.onopen()(); board.flush();
  assert.equal(board.calls.loadTasks, 1);

  const team = harness({ view: "team" });
  team.onopen()(); team.flush();
  assert.equal(team.calls.renderTeamView, 1, "团队视图须刷新团队渲染");
  assert.equal(team.calls.loadTasks, 0, "团队视图不必顺带刷看板（与既有 reload 口径一致）");

  const detail = harness({ detailTask: { identifier: "p1-1" } });
  detail.onopen()(); detail.flush();
  assert.equal(detail.calls.openTaskDetail, 1, "已打开的抽屉须随重连刷新");
});

test("FR-20-B：已销毁（destroyed）→ 重连不回灌取数，不越界写已拆掉的 DOM", () => {
  const h = harness({ destroyed: true });
  h.onopen()();
  h.flush();
  assert.equal(h.calls.loadTasks, 0, "destroyed 后不得再取数（与既有 reload 守卫一致）");
  assert.equal(h.calls.openTaskDetail, 0);
});

test("FR-20-A：已销毁 → 断线不再弹提示", () => {
  const h = harness({ destroyed: true });
  h.source.readyState = 0;
  h.onerror()();
  assert.equal(h.connNotice.hidden, true, "destroyed 后不得再动提示");
});

// ── ④ 不得把失效信号改成增量合并（停下情形②：改动面必须最小） ─────────────────

test("FR-20：四个入口共用**同一个** `reload`，不另开第二条取数通道", () => {
  const h = harness();
  const { listeners } = h.source;
  for (const type of ["message", "task.updated", "team.updated"]) {
    assert.equal(listeners[type]?.length, 1, `${type} 必须恰有一个监听`);
  }
  const [a] = listeners.message;
  assert.equal(listeners["task.updated"][0], a, "三个事件监听必须指向同一个 reload 函数");
  assert.equal(listeners["team.updated"][0], a, "三个事件监听必须指向同一个 reload 函数");

  // 切片里只允许**一处** `const reload =` 定义（不许复制第二份取数逻辑）。
  const defs = h.region.match(/const reload = /g) ?? [];
  assert.equal(defs.length, 1, "只允许一处 reload 定义（不得复制第二份取数路径）");
});

test("FR-20：接线区**不做增量合并** —— 不得直接写 state.tasks / push / splice", () => {
  const region = sseRegion();
  assert.ok(!/state\.tasks\s*=/.test(region), "不得在接线区直接写 `state.tasks`（那是 loadTasks 的职责）");
  assert.ok(!/\bpush\(/.test(region), "不得在接线区 push 事件载荷（增量合并是被禁止的方向）");
  assert.ok(!/\bsplice\(/.test(region), "不得在接线区 splice 事件载荷");
  assert.ok(!/\bmap\(|filter\(/.test(region), "不得在接线区对事件载荷做变换（补齐必须是整块重取）");
  // 断言「重取」而非「合并」：证明它调的确实是既有 loadTasks（唯一取数口）。
  assert.match(region, /void loadTasks\(\)/, "重连后的补齐必须调用既有 `loadTasks()`");
});

test("FR-20：提示条是**独立常驻**元素（不得复用会定时消失的 showBanner）", () => {
  // showBanner 是「一次性提示」（info 5s / error 10s 自动隐藏）；断线提示必须**持续可见到恢复**，
  // 若借道 showBanner，bannerTimer 会把它提前藏掉 —— 用户又看不出界面在撒谎了。
  assert.match(
    SOURCE,
    /const connNotice = mk\("div", "banner error"\);/,
    "必须有独立的常驻提示元素 connNotice",
  );
  assert.match(
    SOURCE,
    /shell\.append\(header, toolbar, banner, connNotice, boardScroll/,
    "connNotice 必须真的挂进页面（否则再怎么写文案都不可见）",
  );
  const region = sseRegion();
  assert.ok(!/showBanner\(/.test(region), "断线/重连提示不得借道 showBanner（会被定时器提前藏掉）");
  assert.ok(!/hideBanner\(/.test(region), "不得用 hideBanner 收起断线提示（恢复只由 onopen 负责）");
});
