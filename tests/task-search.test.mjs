/**
 * FR-14 · 任务搜索 + FR-16 · 搜索无命中空态
 *
 * 条款（docs/需求文档.md §FR-14 / §FR-16）：
 *  · 搜索覆盖：**任务编号 / 标题 / 描述 / 标签**（验收要点要求逐项可测）。
 *  · 搜索**可与筛选同时生效**。
 *  · 无命中时给出**明确空态**（FR-16：不留空白）。
 *
 * 口径唯一来源＝服务端 `store.listTasks({ q })`（前端只负责传值，不在本地二次判定 ——
 * 与 FR-26 会话归属筛选同一条纪律）；与状态/优先级/标签/会话归属**取交集（同一条取数路径）**。
 *
 * 红线（用例直接断言，不靠注释）：
 *  · **只读**：搜索不得写任何字段（status / labels / version 逐一比对）。
 *  · **清空即全量**：缺省 / 空串 / 纯空白一律＝不搜索，不得把「全部」当成某种搜索。
 *  · **非法入参如实报错**：非字符串 `q` 必须被拒，不得静默忽略。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { deriveEmptyState, hasActiveFilter } from "../src/core/empty-state.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}

const ids = (rows) => rows.map((t) => t.identifier).sort();

// ── 四类字段：逐项可测（验收要点原文「分别用编号片段、标题片段、描述中的词、标签名搜索」）──
test("listTasks(q)：编号 / 标题 / 描述 / 标签 四类字段各命中一次", () => {
  const { store } = setup();
  const byIdentifier = store.createTask({ projectId: "p1", title: "无关卡一号", description: "无关描述" });
  const byTitle = store.createTask({ projectId: "p1", title: "实现看板归档", description: "无关描述" });
  const byDescription = store.createTask({ projectId: "p1", title: "无关卡三号", description: "本卡负责接入会话心跳与存活探测" });
  const byLabel = store.createTask({ projectId: "p1", title: "无关卡四号", description: "无关描述", labels: ["样式"] });

  // ① 编号（连"片段"也要命中：`p1-2` 的 `p1-2` 与纯数字片段）
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: byIdentifier.identifier })), [byIdentifier.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "p1-2" })), [byTitle.identifier]);

  // ② 标题片段
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "归档" })), [byTitle.identifier]);

  // ③ 描述中的词
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "心跳" })), [byDescription.identifier]);

  // ④ 标签名
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "样式" })), [byLabel.identifier]);
});

test("listTasks(q)：大小写不敏感（编号 / 标题 / 描述 / 标签四类都不区分大小写）", () => {
  const { store } = setup();
  const idTask = store.createTask({ projectId: "p1", title: "无关" });
  const titleTask = store.createTask({ projectId: "p1", title: "Fix the KANBAN renderer" });
  const descTask = store.createTask({ projectId: "p1", title: "无关", description: "Discussion with the UX reviewer" });
  const labelTask = store.createTask({ projectId: "p1", title: "无关", labels: ["Regression"] });

  // 大写关键词命中标题 / 描述 / 标签
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "kanban" })), [titleTask.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "KANBAN" })), [titleTask.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "ux REVIEWER" })), [descTask.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: "regression" })), [labelTask.identifier]);
  // 编号：大写关键词命中
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", q: idTask.identifier.toUpperCase() })), [idTask.identifier]);
});

test("listTasks(q)：缺省 / 空串 / 纯空白一律＝不搜索（清空关键词即恢复全量）", () => {
  const { store } = setup();
  const a = store.createTask({ projectId: "p1", title: "甲" });
  const b = store.createTask({ projectId: "p1", title: "乙" });
  const full = [a.identifier, b.identifier].sort();

  for (const q of [undefined, null, "", "   ", "\t\n"]) {
    assert.deepEqual(ids(store.listTasks({ projectId: "p1", q })), full, `q=${JSON.stringify(q)} 应等于「全量」`);
  }
});

test("listTasks(q)：非法入参如实报错（不得静默忽略）", () => {
  const { store } = setup();
  assert.throws(() => store.listTasks({ projectId: "p1", q: 42 }), /q/);
  assert.throws(() => store.listTasks({ projectId: "p1", q: ["a"] }), /q/);
});

// ── 与筛选取交集（验收要点「搜索可与筛选同时生效」） ─────────────────────
test("listTasks：搜索与状态 / 优先级 / 标签 / 会话归属取交集（同一条取数路径）", () => {
  const { store } = setup();
  const hit = store.createTask({ projectId: "p1", title: "看板搜索命中", status: "todo", priority: "high", labels: ["缺陷"] });
  const wrongStatus = store.createTask({ projectId: "p1", title: "看板搜索·状态不符", status: "done", priority: "high", labels: ["缺陷"] });
  const wrongPriority = store.createTask({ projectId: "p1", title: "看板搜索·优先级不符", status: "todo", priority: "low", labels: ["缺陷"] });
  const wrongLabel = store.createTask({ projectId: "p1", title: "看板搜索·标签不符", status: "todo", priority: "high", labels: ["样式"] });
  const wrongKeyword = store.createTask({ projectId: "p1", title: "题目无关", status: "todo", priority: "high", labels: ["缺陷"] });
  for (const t of [hit, wrongStatus, wrongPriority, wrongLabel, wrongKeyword]) store.claimTask(t.identifier, { sessionId: "session-aaa" });

  const rows = store.listTasks({ projectId: "p1", q: "看板搜索", sessionScope: "linked", status: "todo", priority: "high", labels: ["缺陷"] });
  assert.deepEqual(ids(rows), [hit.identifier], "搜索必须与全部筛选维度取交集");
});

test("listTasks：搜索命中标签时与标签筛选**不冲突也不重复**（交集语义，不是并集）", () => {
  const { store } = setup();
  const both = store.createTask({ projectId: "p1", title: "无关", labels: ["缺陷"] });
  const labelOnly = store.createTask({ projectId: "p1", title: "无关二号", labels: ["缺陷"] });
  const keywordOnly = store.createTask({ projectId: "p1", title: "缺陷处理说明", labels: ["样式"] }); // 关键词在标题、标签不符

  // 关键词「缺陷」命中 3 张；再叠加「标签=缺陷」⇒ 只剩标签确为缺陷的那两张
  const rows = store.listTasks({ projectId: "p1", q: "缺陷", labels: ["缺陷"] });
  assert.deepEqual(ids(rows), [both.identifier, labelOnly.identifier].sort());
  assert.ok(!rows.some((t) => t.identifier === keywordOnly.identifier), "仅标题含词、标签不符的卡不得混入");
});

// ── API 层：前端实际走的那条路 ───────────────────────────────────────────
test("API：GET /api/tasks?q= 命中四类字段，且与筛选组合后结果正确，且不改库", async () => {
  const { store, route } = setup();
  const a = store.createTask({ projectId: "p1", title: "看板搜索·甲", status: "todo", description: "含关键词 归档" });
  const b = store.createTask({ projectId: "p1", title: "看板搜索·乙", status: "done", labels: ["归档"] });
  const c = store.createTask({ projectId: "p1", title: "无关卡", status: "todo", description: "归档相关内容" });

  const snapshot = () => store.listTasks({ projectId: "p1" })
    .map((t) => `${t.identifier}:${t.status}:${t.version}:${(t.labels ?? []).join(",")}`).sort();
  const baseline = snapshot();

  const hit = await route("GET", "/api/tasks?project=p1&q=看板搜索");
  assert.equal(hit.status, 200);
  assert.deepEqual(ids(hit.payload.tasks), [a.identifier, b.identifier].sort());

  // 与状态筛选组合（交集）
  const composed = await route("GET", "/api/tasks?project=p1&q=看板搜索&status=done");
  assert.deepEqual(ids(composed.payload.tasks), [b.identifier]);

  // 与标签筛选组合（交集）
  const byLabel = await route("GET", "/api/tasks?project=p1&q=归档&label=" + encodeURIComponent("归档"));
  assert.deepEqual(ids(byLabel.payload.tasks), [b.identifier]);

  // 编号片段命中
  const byId = await route("GET", `/api/tasks?project=p1&q=${encodeURIComponent(a.identifier)}`);
  assert.deepEqual(ids(byId.payload.tasks), [a.identifier]);

  // 清空关键词 ⇒ 全量恢复
  const cleared = await route("GET", "/api/tasks?project=p1&q=");
  assert.equal(cleared.payload.tasks.length, 3, "空 q 不得当作搜索，必须恢复全量");

  assert.deepEqual(snapshot(), baseline, "搜索是只读路径，不得写库");
});

test("API：无命中 ⇒ 空列表（不报错、不兜底成全量）", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "只有这一张" });
  const miss = await route("GET", "/api/tasks?project=p1&q=绝不存在的关键词xyz");
  assert.equal(miss.status, 200);
  assert.deepEqual(miss.payload.tasks, []);
  assert.equal(miss.payload.count, 0);
});

// ── FR-16 空态：无命中必须有明确文案 ─────────────────────────────────────
test("deriveEmptyState：搜索无命中 ⇒ 明确空态并回显关键词（不得说成「本项目暂无任务」）", () => {
  const r = deriveEmptyState({ allTasks: [], visibleTasks: [], filters: { keyword: "找不到的词" } });
  assert.equal(r.empty, true);
  assert.equal(r.message, "没有匹配「找不到的词」的任务");
  assert.deepEqual(r.hints, ["换个关键词，或清空搜索后重试"]);
  assert.doesNotMatch(r.message, /本项目暂无任务/, "搜索无命中不得混同于「项目真的没卡」");
  assert.equal(r.hiddenTotal, 0, "不编造数量");
});

test("deriveEmptyState：搜索 + 筛选把卡全挡掉 ⇒ 引导里如实回显两个条件", () => {
  const derived = deriveEmptyState({
    allTasks: [{ identifier: "x", status: "todo", labels: [] }],
    visibleTasks: [],
    filters: { priority: "high", keyword: "看板" },
  });
  assert.equal(derived.empty, true);
  assert.match(derived.hints[0], /优先级=high/);
  assert.match(derived.hints[0], /关键词=看板/);
});

test("hasActiveFilter：关键词非空即算筛选中；空串 / 纯空白不算", () => {
  assert.equal(hasActiveFilter({ keyword: "" }), false);
  assert.equal(hasActiveFilter({ keyword: "   " }), false);
  assert.equal(hasActiveFilter({ keyword: "看板" }), true);
});

test("API：empty-state 端点把 q 如实带入取数口径（搜索无命中 ⇒ 空态而非「本项目暂无任务」）", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "看板搜索·甲", status: "todo" });

  const miss = await route("GET", "/api/projects/p1/empty-state?q=" + encodeURIComponent("没有这个词"));
  assert.equal(miss.payload.emptyState.empty, true);
  assert.match(miss.payload.emptyState.message, /没有匹配「没有这个词」的任务/);

  const hit = await route("GET", "/api/projects/p1/empty-state?q=看板搜索");
  assert.equal(hit.payload.emptyState.empty, false, "搜索命中 ⇒ 看板不空，不得误报");
});

// ── 前端接线（源码级断言：零依赖原生脚本无单测环境，与既有做法一致） ──────
test("web/app.js：工具栏有搜索框、输入回服务端取数、清空即恢复全量", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

  assert.match(src, /const keywordInput = mk\("input", "keyword-input"\)/, "必须有搜索输入框");
  assert.match(src, /keywordInput\.setAttribute\("aria-label", "搜索任务（编号 \/ 标题 \/ 描述 \/ 标签）"\)/);
  assert.match(src, /mk\("label", null, "搜索"\), keywordInput/, "搜索框必须挂进工具栏（与既有筛选并排）");
  assert.match(src, /keyword: "",/, "state 里必须有 keyword");

  // 输入即取数（防抖），且清空即不传 q（恢复全量）
  assert.match(src, /keywordInput\.addEventListener\("input", \(\) => \{[\s\S]{0,200}?state\.keyword = keywordInput\.value;[\s\S]{0,200}?void loadTasks\(\);/);
  assert.match(src, /if \(state\.keyword\.trim\(\)\) params\.set\("q", state\.keyword\.trim\(\)\)/, "取数必须带上 q，且空关键词不传（恢复全量）");

  // 服务端路由接收该参数（口径唯一来源；前端不在本地二次判定）
  const api = await readFile(new URL("../src/server/api.mjs", import.meta.url), "utf8");
  assert.match(api, /q: searchParams\.get\("q"\) \|\| undefined/, "服务端路由必须接收 q");

  // 清空筛选出口必须把关键词一起清掉（否则「清空筛选条件」名不副实）
  assert.match(src, /state\.keyword = "";/, "「清空筛选条件」必须一并复位搜索关键词");
  assert.match(src, /keywordInput\.value = "";/, "清空时输入框也要清空");
});

test("web/app.js：前端降级空态与纯函数同口径（搜索无命中分支，防漂移）", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const fn = /function localEmptyState\(visible\)\s*\{[\s\S]*?\n    \}/.exec(src);
  assert.ok(fn, "必须能定位到前端降级实现（web/app.js 的 localEmptyState）");

  // 文案逐字一致：把纯函数渲染出的字符串按数字切开，静态片段必须出现在前端降级里。
  // 关键词是**运行时插值**（前端是 `「${keyword}」`），故按占位符替换后再比对静态骨架。
  const canonical = deriveEmptyState({ allTasks: [], visibleTasks: [], filters: { keyword: "KW" } });
  const skeleton = (s) => s.split(/\d+/).map((f) => f.replace(/「KW」/g, "「${keyword}」")).filter((f) => f.trim() !== "");
  const fragments = [canonical.message, ...canonical.hints].flatMap(skeleton);
  assert.ok(fragments.length >= 2, "至少要切出 message 与 hint 的静态片段");
  for (const f of fragments) assert.ok(fn[0].includes(f), `前端降级文案与纯函数漂移：缺少「${f}」`);
});

test("web/tokens.css：搜索框有工具栏防挤压样式", async () => {
  const css = await readFile(new URL("../web/tokens.css", import.meta.url), "utf8");
  assert.match(css, /\.toolbar > \.keyword-input \{/, "搜索框必须纳入工具栏布局规则（可收缩、有宽度上限）");
});
