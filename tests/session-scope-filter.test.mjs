/**
 * FR-26 · 按会话归属查看与筛选（缺口补齐：工具栏「会话归属」维度 + 卡片会话标记）
 *
 * 条款（docs/需求文档.md §FR-26）：
 *  · 筛选维度：全部 / 已关联会话 / 未关联会话（与 FR-13 的其它维度可组合）。
 *  · 已关联任务在界面上有可辨识的标记。
 *  · 验收要点：列表可区分；按该维度筛选结果正确；**与状态筛选组合后仍正确**。
 *
 * 口径唯一来源＝`tasks.session_id`（FR-25 认领/启动执行时写入），前端不作二次判定：
 * 筛选一律回服务端取数（与优先级/标签同一条路），卡片标记只读取服务端返回的 `sessionId`。
 *
 * 红线（用例直接断言，不靠注释）：
 *  · **不改数据**：筛选是只读路径，不得写入 status / session_id / version。
 *  · **不臆断**：缺省（不传 / 空串）一律＝「全部」，不得把「全部」当成某种筛选。
 *  · **非法值如实报错**：`sessionScope=bogus` 必须被拒，不得静默当成「全部」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { hasActiveFilter, deriveEmptyState, SESSION_SCOPE_LABELS } from "../src/core/empty-state.mjs";

/** 造一个含「已关联 / 未关联」两类卡的项目：linked 用 claimTask 写 session_id（与真实路径一致）。 */
function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  const router = createApiRouter({ store });
  return { store, route };
}

// ── store 层：筛选口径本身 ────────────────────────────────────────────
test("listTasks：sessionScope=linked / unlinked 如实二分；缺省＝全部（不当作筛选）", () => {
  const { store } = setup();
  const unlinked = store.createTask({ projectId: "p1", title: "没人认领" });
  const linked = store.createTask({ projectId: "p1", title: "有人在做", status: "todo" });
  store.claimTask(linked.identifier, { sessionId: "session-aaa" });

  const ids = (rows) => rows.map((t) => t.identifier).sort();

  assert.deepEqual(ids(store.listTasks({ projectId: "p1", sessionScope: "linked" })), [linked.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", sessionScope: "unlinked" })), [unlinked.identifier]);
  // 「全部」= 不传 / 传空串，两种写法都得给出全量（空串不得被判成非法值）
  for (const scope of [undefined, null, ""]) {
    assert.deepEqual(
      ids(store.listTasks({ projectId: "p1", sessionScope: scope })),
      [linked.identifier, unlinked.identifier].sort(),
      `sessionScope=${JSON.stringify(scope)} 应等于「全部」`,
    );
  }
  // 两个维度互补且不重叠 ⇒ 合起来正好是全量（不丢卡、不重复）
  assert.equal(
    store.listTasks({ projectId: "p1", sessionScope: "linked" }).length
    + store.listTasks({ projectId: "p1", sessionScope: "unlinked" }).length,
    store.listTasks({ projectId: "p1" }).length,
  );
});

test("listTasks：非法 sessionScope 如实报错（不得静默降级成「全部」）", () => {
  const { store } = setup();
  assert.throws(() => store.listTasks({ projectId: "p1", sessionScope: "bogus" }), /sessionScope/);
});

test("listTasks：会话归属与状态 / 优先级 / 标签取交集（FR-13 组合口径）", () => {
  const { store } = setup();
  const hit = store.createTask({ projectId: "p1", title: "命中", status: "todo", priority: "high", labels: ["缺陷"] });
  const wrongStatus = store.createTask({ projectId: "p1", title: "状态不符", status: "done", priority: "high", labels: ["缺陷"] });
  const wrongPriority = store.createTask({ projectId: "p1", title: "优先级不符", status: "todo", priority: "low", labels: ["缺陷"] });
  const wrongLabel = store.createTask({ projectId: "p1", title: "标签不符", status: "todo", priority: "high", labels: ["样式"] });
  const noSession = store.createTask({ projectId: "p1", title: "未关联", status: "todo", priority: "high", labels: ["缺陷"] });
  for (const t of [hit, wrongStatus, wrongPriority, wrongLabel]) store.claimTask(t.identifier, { sessionId: "session-aaa" });

  const rows = store.listTasks({ projectId: "p1", sessionScope: "linked", status: "todo", priority: "high", labels: ["缺陷"] });
  assert.deepEqual(rows.map((t) => t.identifier), [hit.identifier]);
  assert.ok(!rows.some((t) => t.identifier === noSession.identifier), "未关联的卡不得混进「已关联」结果");
});

// ── API 层：前端实际走的那条路 ────────────────────────────────────────
test("API：GET /api/tasks?sessionScope= 与状态组合后结果正确，且不改库", async () => {
  const { store, route } = setup();
  const a = store.createTask({ projectId: "p1", title: "已关联·可开工", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "已关联·已完成", status: "done" });
  const c = store.createTask({ projectId: "p1", title: "未关联·可开工", status: "todo" });
  for (const t of [a, b]) store.claimTask(t.identifier, { sessionId: "session-aaa" });

  const snapshot = () => store.listTasks({ projectId: "p1" })
    .map((t) => `${t.identifier}:${t.status}:${t.version}:${t.sessionId ?? ""}`).sort();
  const baseline = snapshot();

  const linked = await route("GET", "/api/tasks?project=p1&sessionScope=linked");
  assert.equal(linked.status, 200);
  assert.deepEqual(linked.payload.tasks.map((t) => t.identifier).sort(), [a.identifier, b.identifier].sort());

  const unlinked = await route("GET", "/api/tasks?project=p1&sessionScope=unlinked");
  assert.deepEqual(unlinked.payload.tasks.map((t) => t.identifier), [c.identifier]);

  // 与状态筛选组合（验收要点第 3 条）
  const linkedTodo = await route("GET", "/api/tasks?project=p1&sessionScope=linked&status=todo");
  assert.deepEqual(linkedTodo.payload.tasks.map((t) => t.identifier), [a.identifier]);
  const unlinkedDone = await route("GET", "/api/tasks?project=p1&sessionScope=unlinked&status=done");
  assert.deepEqual(unlinkedDone.payload.tasks, [], "未关联 + 已完成 ⇒ 无命中（组合是交集，不是并集）");

  // 与优先级 / 标签组合（完成验收标准第 4 条）
  store.updateTask(c.identifier, { expectedVersion: store.getTaskRef(c.identifier).version, priority: "high", labels: ["缺陷"] });
  const combo = await route("GET", `/api/tasks?project=p1&sessionScope=unlinked&priority=high&label=${encodeURIComponent("缺陷")}`);
  assert.deepEqual(combo.payload.tasks.map((t) => t.identifier), [c.identifier]);

  // 「全部」= 不传参数，与省略时等价
  const all = await route("GET", "/api/tasks?project=p1");
  assert.equal(all.payload.tasks.length, 3);

  assert.deepEqual(snapshot().filter((s) => !s.startsWith(c.identifier)), baseline.filter((s) => !s.startsWith(c.identifier)), "筛选是只读路径，不得写库");
});

test("API：卡片数据本身带 sessionId（前端标记的真值来源）", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "有人在做", status: "todo" });
  store.claimTask(t.identifier, { sessionId: "session-bbb" });
  const r = await route("GET", "/api/tasks?project=p1&withWatchdog=1");
  const card = r.payload.tasks.find((x) => x.identifier === t.identifier);
  assert.equal(card.sessionId, "session-bbb", "前端卡片的「已关联会话」标记必须取自服务端真值");
});

test("API：empty-state 端点把 sessionScope 如实带入取数口径（与前端同一条路）", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "未关联一张", status: "todo" });

  // 前端形态：筛选把卡全挡掉 ⇒ 必须判空并给引导（而非「本项目暂无任务」）
  const miss = await route("GET", "/api/projects/p1/empty-state?sessionScope=linked");
  assert.equal(miss.payload.emptyState.empty, true);
  assert.equal(miss.payload.emptyState.message, "当前筛选下没有任务");

  const hit = await route("GET", "/api/projects/p1/empty-state?sessionScope=unlinked");
  assert.equal(hit.payload.emptyState.empty, false, "未关联筛选命中 ⇒ 看板不空，不得误报");

  // 引导文案要如实回显这一维度（用未关联筛选时不会出现，故用已关联视角反查纯函数口径）
  const derived = deriveEmptyState({
    allTasks: [{ identifier: "x", status: "todo", labels: [] }],
    visibleTasks: [],
    filters: { sessionScope: "unlinked" },
  });
  assert.match(derived.hints[0], /会话归属=未关联会话/, "空态引导必须回显当前会话归属筛选条件");
});

// ── 纯函数口径 ───────────────────────────────────────────────────────
test("hasActiveFilter：sessionScope 非空即算筛选中；空串 / 空白不算", () => {
  assert.equal(hasActiveFilter({}), false);
  assert.equal(hasActiveFilter({ sessionScope: "" }), false);
  assert.equal(hasActiveFilter({ sessionScope: "   " }), false);
  assert.equal(hasActiveFilter({ sessionScope: "linked" }), true);
  assert.equal(hasActiveFilter({ sessionScope: "unlinked" }), true);
  assert.deepEqual({ ...SESSION_SCOPE_LABELS }, { linked: "已关联会话", unlinked: "未关联会话" });
});

// ── 前端接线（源码级断言：零依赖原生脚本无单测环境，与既有做法一致） ──────
test("web/app.js：工具栏有「会话归属」下拉、change 回服务端取数、卡片有会话标记", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

  assert.match(src, /const sessionFilter = mk\("select"\)/, "必须有会话归属下拉");
  assert.match(src, /sessionFilter\.setAttribute\("aria-label", "按会话归属筛选"\)/);
  assert.match(src, /mk\("label", null, "会话归属"\), sessionFilter/, "下拉必须挂进工具栏");
  // FR-28：默认值不再是空串 —— 会话内默认收敛到「仅本会话」（见 FR-28 用例）；这里只钉「与 state.session 分开」。
  assert.match(src, /sessionScope: defaultSessionScope, session: sessionId/, "state 里必须有 sessionScope（且与当前会话上下文 state.session 分开）");

  // 服务端路由接收该参数（口径唯一来源；前端只负责传值，不在本地二次判定）
  const api = await readFile(new URL("../src/server/api.mjs", import.meta.url), "utf8");
  assert.match(api, /sessionScope: searchParams\.get\("sessionScope"\)/, "服务端路由必须接收该参数");

  // 切换即取数（不得只在前端本地过滤：口径唯一来源是服务端）
  const listener = /sessionFilter\.addEventListener\("change", \(\) => \{[\s\S]{0,200}?state\.sessionScope = sessionFilter\.value;[\s\S]{0,120}?void loadTasks\(\);/.exec(src);
  assert.ok(listener, "change 必须写 state.sessionScope 并重新 loadTasks");
  assert.match(src, /if \(state\.sessionScope\) params\.set\("sessionScope", state\.sessionScope\)/, "取数必须带上该维度");

  // 清空筛选出口必须把它一起清掉（否则「清空筛选条件」名不副实）
  assert.match(src, /state\.sessionScope = "";/, "「清空筛选条件」必须一并复位会话归属");

  // 卡片标记：两态可辨识，且真值取 sessionId
  assert.match(src, /session-chip \$\{linked \? "session-linked" : "session-unlinked"\}/);
  assert.match(src, /const session = String\(task\.sessionId \?\? ""\)\.trim\(\);/);
  assert.match(src, /"未关联会话"/);

  // 防漂移：文案与纯函数逐字一致
  for (const label of Object.values(SESSION_SCOPE_LABELS)) {
    assert.ok(src.includes(`"${label}"`), `前端文案与 empty-state.mjs 漂移：缺少「${label}」`);
  }
});

test("web/app.js：卡片会话标记**真跑**两态（提取该区块用最小假 DOM 驱动，非仅正则）", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const block = /\n      \{\n        const session = String\(task\.sessionId \?\? ""\)\.trim\(\);[\s\S]*?\n      \}/.exec(src);
  assert.ok(block, "必须能定位到卡片的会话标记区块");

  // 最小假 DOM（与 tests/dsh-plugin.test.mjs 的既有做法同型）：只够这一段跑起来
  const chipFor = (task) => {
    const created = [];
    const doc = { createElement: () => ({ className: "", textContent: "", title: "", children: [], appendChild(n) { this.children.push(n); } }) };
    const mk = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
    new Function("task", "mk", "topline", block[0])(task, mk, { appendChild: (n) => created.push(n) });
    return created[0];
  };

  const linked = chipFor({ sessionId: "session-smoke-aaaa" });
  const unlinked = chipFor({ sessionId: null });
  const blank = chipFor({ sessionId: "   " });

  // 两态必须**可辨识**（不同类名 + 不同文案）—— 这正是条款要求的「已关联任务在界面上有可辨识的标记」
  assert.equal(linked.className, "session-chip session-linked");
  assert.equal(unlinked.className, "session-chip session-unlinked");
  assert.match(linked.textContent, /^已关联会话 · session-/);
  assert.equal(unlinked.textContent, "未关联会话");
  assert.notEqual(linked.className, unlinked.className);
  assert.notEqual(linked.textContent, unlinked.textContent);

  // 纯空白不得被判成「已关联」（与 store 的 `session_id != ''` 同口径）
  assert.equal(blank.className, "session-chip session-unlinked");

  // 完整标识进 title（卡面截断只为不撑爆窄卡片，真值不丢）
  const long = chipFor({ sessionId: "session-70a0bcda-1234-5678-9abc" });
  assert.ok(long.title.includes("session-70a0bcda-1234-5678-9abc"), "完整会话标识必须在 title 里可读");
  assert.ok(long.textContent.length < long.title.length);
});

test("web/tokens.css：会话标记有样式，且纳入卡片顶行的防挤压规则", async () => {
  const css = await readFile(new URL("../web/tokens.css", import.meta.url), "utf8");
  assert.match(css, /\.session-chip \{/, "必须有 .session-chip 基础样式");
  assert.match(css, /\.session-linked \{/, "已关联态要有可辨识配色");
  assert.match(css, /\.session-unlinked \{/, "未关联态要有可辨识配色");
  const defensive = /\.card-topline > \.attr-chip,\n\.card-topline > \.auth-chip,\n\.card-topline > \.session-chip,/;
  assert.match(css, defensive, "会话标记必须纳入卡片顶行的 flex:0 0 auto 防挤压规则");
});
