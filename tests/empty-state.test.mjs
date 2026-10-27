/**
 * FR-93 · 看板空态引导（缺陷 F-05：次状态议题空态无引导）
 *
 * 覆盖两处：
 *  1. **纯函数** `src/core/empty-state.mjs`（推导唯一来源）
 *  2. **只读端点** `GET /api/projects/:id/empty-state`（前端零依赖原生脚本无法 import ESM，
 *     故按 next-step 的既有做法用端点传口径）
 *
 * 红线（用例直接断言，不靠注释）：
 *  · **不臆断**：真的一个任务都没有时**不编造数量**（`hiddenTotal` 必为 0）。
 *  · **只读**：端点不得改任何任务（status / labels / version 逐一比对）。
 *  · **不误判**：`showArchived=1` 时折叠卡本就会入列，**不得再被算成"被隐藏"**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { deriveEmptyState, formatEmptyState, hasActiveFilter, isArchived, ARCHIVE_LABEL } from "../src/core/empty-state.mjs";

const A = (identifier) => ({ identifier, status: "todo", labels: [ARCHIVE_LABEL] });
const T = (identifier) => ({ identifier, status: "todo", labels: [] });

// ── 折叠判定与筛选判定 ────────────────────────────────────────────────
test("isArchived：只看 archived 标签；无 labels / 非数组都不炸", () => {
  assert.equal(isArchived(A("t1")), true);
  assert.equal(isArchived(T("t1")), false);
  assert.equal(isArchived({}), false);
  assert.equal(isArchived({ labels: null }), false);
});

test("hasActiveFilter：priority/label 任一非空即算筛选中；archived 标签不算筛选", () => {
  assert.equal(hasActiveFilter({}), false);
  assert.equal(hasActiveFilter({ priority: "", label: "" }), false);
  assert.equal(hasActiveFilter({ priority: "  " }), false, "纯空白不算筛选");
  assert.equal(hasActiveFilter({ priority: "high" }), true);
  assert.equal(hasActiveFilter({ label: "缺陷" }), true);
  assert.equal(hasActiveFilter({ label: ARCHIVE_LABEL }), false, "archived 是折叠开关载体，不是筛选条件");
});

// ── 核心：看板非空时不得说谎 ──────────────────────────────────────────
test("deriveEmptyState：visible 非空 ⇒ empty=false 且**不产出任何引导**", () => {
  const all = [T("t1"), A("t2")];
  const r = deriveEmptyState({ allTasks: all, visibleTasks: [all[0]], showArchived: false });
  assert.equal(r.empty, false);
  assert.equal(r.hiddenTotal, 0);
  assert.equal(r.hints.length, 0);
  assert.equal(r.message, "");
});

// ── 红线：真·无任务时不编造 ───────────────────────────────────────────
test("deriveEmptyState：项目真的没有任务 ⇒ 数量为 0、**不编造**「还有 N 个未显示」", () => {
  const r = deriveEmptyState({ allTasks: [], visibleTasks: [] });
  assert.equal(r.empty, true);
  assert.equal(r.kind, "no-tasks");
  assert.equal(r.hiddenTotal, 0, "没有任何卡时 hiddenTotal 必须是 0");
  assert.equal(r.archivedCount, 0);
  assert.equal(r.filteredCount, 0);
  assert.doesNotMatch(r.message, /还有\s*\d+/, "不得凭空造数量");
  assert.equal(r.message, "本项目暂无任务");
});

test("deriveEmptyState：项目无任务但有筛选 ⇒ 提示清筛选，且仍不编造数量", () => {
  const r = deriveEmptyState({ allTasks: [], visibleTasks: [], filters: { priority: "high" } });
  assert.equal(r.message, "当前筛选下没有任务");
  assert.deepEqual(r.hints, ["清空筛选条件后重试"]);
  assert.equal(r.hiddenTotal, 0);
});

// ── F-05 的核心场景：数据在库、只是没显示 ──────────────────────────────
test("deriveEmptyState：全部卡片被折叠 ⇒ 说清在哪 + 指向既有折叠开关（缺陷 F-05 同类缺口）", () => {
  const all = [A("t1"), A("t2")];
  const r = deriveEmptyState({ allTasks: all, visibleTasks: [], showArchived: false });
  assert.equal(r.empty, true);
  assert.equal(r.kind, "archived");
  assert.equal(r.archivedCount, 2);
  assert.equal(r.filteredCount, 0);
  assert.equal(r.hiddenTotal, 2);
  assert.match(r.message, /2 个任务未显示/);
  assert.match(r.hints[0], /已折叠/, "必须指明是折叠而非「真的没有」");
  assert.match(r.hints[0], /显示已折叠/, "必须给出既有控件的出口名");
});

test("deriveEmptyState：筛选挡掉 ⇒ kind=filtered-out 且把筛选条件写进引导", () => {
  const all = [T("t1"), T("t2")];
  const r = deriveEmptyState({ allTasks: all, visibleTasks: [], filters: { priority: "urgent" } });
  assert.equal(r.kind, "filtered-out");
  assert.equal(r.filteredCount, 2);
  assert.equal(r.archivedCount, 0);
  assert.match(r.hints[0], /优先级=urgent/, "要如实回显当前筛选条件");
});

test("deriveEmptyState：折叠 + 筛选同时存在 ⇒ kind=filtered-and-archived 且两类原因分开陈述", () => {
  const all = [A("a1"), T("t1")];
  const r = deriveEmptyState({ allTasks: all, visibleTasks: [], filters: { label: "缺陷" } });
  assert.equal(r.kind, "filtered-and-archived");
  assert.equal(r.archivedCount, 1);
  assert.equal(r.filteredCount, 1);
  assert.equal(r.hiddenTotal, 2, "两类原因不得重复计数");
  assert.equal(r.reasons.length, 2);
  assert.deepEqual(r.reasons.map((x) => x.reason), ["archived", "filtered"]);
  assert.match(r.hints[1], /标签=缺陷/);
});

test("deriveEmptyState：⚠️ showArchived=1 时折叠卡本就会入列，**不得再被算成被隐藏**", () => {
  const all = [A("a1")];
  // showArchived=1 ⇒ 服务端/前端把折叠卡算进 visible ⇒ 看板非空
  const visible = all;
  const r = deriveEmptyState({ allTasks: all, visibleTasks: visible, showArchived: true });
  assert.equal(r.empty, false);
  assert.equal(r.hiddenTotal, 0);
  assert.equal(r.archivedCount, 0, "showArchived 打开时不能再报「有 N 个折叠卡未显示」");
});

// ── 健壮性 ───────────────────────────────────────────────────────────
test("deriveEmptyState：缺参 / 非数组输入不抛，按「无任务」处理", () => {
  for (const args of [undefined, {}, { allTasks: null }, { allTasks: "x" }, { allTasks: [] }]) {
    const r = deriveEmptyState(args);
    assert.equal(r.empty, true);
    assert.equal(r.hiddenTotal, 0);
  }
});

test("formatEmptyState：非空态返回空串；空态把 message 与 hints 拼成一行", () => {
  assert.equal(formatEmptyState({ empty: false }), "");
  assert.equal(formatEmptyState(deriveEmptyState({ allTasks: [], visibleTasks: [] })), "本项目暂无任务");
  const withHints = deriveEmptyState({ allTasks: [A("a1")], visibleTasks: [], showArchived: false });
  assert.match(formatEmptyState(withHints), /^看板为空：.+：.+已折叠/);
});

// ── 只读端点 ─────────────────────────────────────────────────────────
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

test("API：GET /api/projects/:id/empty-state 只读、且如实区分折叠与筛选", async () => {
  const { store, route } = setup();
  const live = store.createTask({ projectId: "p1", title: "进行中的一张", status: "todo" });
  const folded = store.createTask({ projectId: "p1", title: "折叠的一张", status: "todo" });
  store.updateTask(folded.identifier, { expectedVersion: store.getTaskRef(folded.identifier).version, labels: [ARCHIVE_LABEL], actor: "human" });

  // 取证基线：此后端点只读，任何 status/labels/version 变化都应来自本用例自己的 update
  const snapshot = () => store.listTasks({ projectId: "p1" })
    .map((t) => `${t.identifier}:${t.status}:${t.version}:${(t.labels ?? []).join("|")}`).sort();
  const baseline = snapshot();

  // 默认视图：折叠卡不入列 ⇒ 还有 live 在列 ⇒ 看板非空，不应报空态
  const r1 = await route("GET", "/api/projects/p1/empty-state");
  assert.equal(r1.status, 200);
  assert.equal(r1.payload.project, "p1");
  assert.equal(r1.payload.emptyState.empty, false, "还有 1 张在列 ⇒ 看板不空");
  assert.deepEqual(snapshot(), baseline, "端点不得写库");

  // 只留折叠卡 ⇒ 报「还有 2 个未显示」并指明是折叠
  store.updateTask(live.identifier, { expectedVersion: store.getTaskRef(live.identifier).version, labels: [ARCHIVE_LABEL], actor: "human" });
  const afterFold = snapshot();
  const r2 = await route("GET", "/api/projects/p1/empty-state");
  assert.equal(r2.payload.emptyState.empty, true);
  assert.equal(r2.payload.emptyState.archivedCount, 2);
  assert.match(r2.payload.emptyState.hints[0], /显示已折叠/);
  assert.deepEqual(snapshot(), afterFold, "端点不得写库");

  // showArchived=1 ⇒ 两张都入列 ⇒ 不得再报「未显示」
  const r3 = await route("GET", "/api/projects/p1/empty-state?showArchived=1");
  assert.equal(r3.payload.emptyState.empty, false);
  assert.equal(r3.payload.emptyState.hiddenTotal, 0);
  assert.deepEqual(snapshot(), afterFold, "端点不得写库");
});

test("API：empty-state 把 priority / label 查询参数如实带给推导口径", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "低优先级一张", status: "todo", priority: "low" });
  const r = await route("GET", "/api/projects/p1/empty-state?priority=urgent");
  assert.equal(r.status, 200);
  // 2026-10-22（续二十四）改判：本用例原先备注「服务端 listTasks 未按 priority 过滤时，可见集仍是全量 ⇒ 不该凭空报"被筛掉"」
  // —— 那是在为**实现缺陷**背书。端点必须与前端口径一致（`/api/tasks` 带筛选参数取数），
  // 因此这里只保留「不得凭空报『还有 N 个未显示』」这条红线；判空口径由下面新增的用例正面覆盖。
  assert.equal(typeof r.payload.emptyState.empty, "boolean");
  assert.doesNotMatch(r.payload.emptyState.message ?? "", /还有\s*1 个任务未显示/);
});

// ── 修复（2026-10-22 · 续二十四）：筛选后为空必须仍然给引导 ─────────────────
// 缺陷：端点原先只用 `store.listTasks({ projectId })` 取**未筛选**的全量卡当可见集，
// 于是「筛选把卡全挡掉」时可见集非空 ⇒ 返回 `empty:false` ⇒ 前端 `state.emptyState.empty`
// 为 false，**整块空态引导不渲染**（七列只剩「暂无任务」）—— 正是 FR-93 要修的 F-05 场景。
// （前端降级 `web/app.js` 的 `localEmptyState` 因为只持有筛选后的卡，反而算对了；
//  这也是两份实现漂移会造成的后果：端点一上线，行为比降级更差。）
test("API：筛选把卡全挡掉 ⇒ 必须判空并给「清空筛选条件」引导（回归：端点曾返回 empty:false）", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "低优先级一张", status: "todo", priority: "low" });

  // 前端口径：网页端就是这么取数的（`/api/tasks` 带筛选参数）⇒ 此刻列里一张都不会有
  const board = await route("GET", "/api/tasks?project=p1&priority=urgent");
  assert.equal(board.payload.tasks.length, 0, "前端口径下看板为空 —— 这正是需要引导的场景");

  const r = await route("GET", "/api/projects/p1/empty-state?priority=urgent");
  assert.equal(r.status, 200);
  assert.equal(r.payload.emptyState.empty, true, "一张都没显示 ⇒ 必须判空，否则前端不会渲染引导");
  assert.equal(r.payload.emptyState.hiddenTotal, 0, "被筛选挡掉的卡不属于该口径 ⇒ 不编造「未显示」数量");
  assert.equal(r.payload.emptyState.message, "当前筛选下没有任务");
  assert.deepEqual(r.payload.emptyState.hints, ["清空筛选条件后重试"]);
});

test("API：标签筛选同理 —— 筛选后为空必须判空；筛选命中时不得误报空态", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "带标签一张", status: "todo", labels: ["缺陷"] });
  const miss = await route("GET", `/api/projects/p1/empty-state?label=${encodeURIComponent("性能")}`);
  assert.equal(miss.payload.emptyState.empty, true, "标签筛不到 ⇒ 必须判空给引导");
  assert.equal(miss.payload.emptyState.message, "当前筛选下没有任务");
  const hit = await route("GET", `/api/projects/p1/empty-state?label=${encodeURIComponent("缺陷")}`);
  assert.equal(hit.payload.emptyState.empty, false, "筛选命中 ⇒ 看板不空，不得误报");
  assert.equal(hit.payload.emptyState.message, "");
});

test("口径一致性：端点输出必须等于纯函数在同一场景的输出（唯一来源不得漂移）", async () => {
  const { store, route } = setup();
  const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "B", status: "todo" });
  for (const t of [a, b]) {
    store.updateTask(t.identifier, { expectedVersion: store.getTaskRef(t.identifier).version, labels: [ARCHIVE_LABEL], actor: "human" });
  }
  const tasks = store.listTasks({ projectId: "p1" }).map((t) => ({ identifier: t.identifier, status: t.status, labels: t.labels ?? [] }));
  const expected = deriveEmptyState({ allTasks: tasks, visibleTasks: [], filters: { priority: "", label: "" }, showArchived: false });
  const r = await route("GET", "/api/projects/p1/empty-state");
  assert.deepEqual(r.payload.emptyState, expected, "端点必须如实转发纯函数口径，不得自己另算一套");
});

test("口径一致性：web/app.js 的前端降级必须与纯函数同一套文案与字段形状（防漂移）", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const fn = /function localEmptyState\(visible\)\s*\{[\s\S]*?\n    \}/.exec(src);
  assert.ok(fn, "必须能定位到前端降级实现（web/app.js 的 localEmptyState）");
  const body = fn[0];

  // ① 字段形状：纯函数返回的每个键，前端降级都得给（缺键 ⇒ 消费方读到 undefined）
  const keys = Object.keys(deriveEmptyState({ allTasks: [], visibleTasks: [] }));
  for (const key of keys) assert.match(body, new RegExp(`\\b${key}\\b`), `前端降级缺少字段 ${key}`);

  // ② 文案：把纯函数渲染出的字符串按数字切开，静态片段必须逐字出现在前端降级里
  const archived = deriveEmptyState({ allTasks: [A("x"), A("y")], visibleTasks: [] });
  assert.equal(archived.archivedCount, 2);
  const fragments = [archived.message, ...archived.hints].flatMap((s) => s.split(/\d+/)).filter((f) => f.trim() !== "");
  assert.ok(fragments.length >= 3, "至少要切出 message 与 hint 的静态片段");
  for (const f of fragments) assert.ok(body.includes(f), `前端降级文案与纯函数漂移：缺少「${f}」`);
});

test("API：empty-state 仅支持 GET（POST 被拒）", async () => {
  const { route } = setup();
  await assert.rejects(() => route("POST", "/api/projects/p1/empty-state", {}), /仅支持 GET/);
});

test("API：不存在的项目不伪造数据 —— 报 PROJECT_NOT_FOUND，不得冒充「本项目暂无任务」", async () => {
  const { route } = setup();
  // 口径（2026-10-22 对齐）：仓库里所有 project 级端点都先走 store.requireProject
  // （既有断言见 tests/kickoff.test.mjs 的 /api/projects/no-such/kickoff → PROJECT_NOT_FOUND）。
  // 空态口径的红线是「不臆断」：把「项目不存在」渲染成「本项目暂无任务」正是最典型的臆断 ——
  // 使用者会以为项目好好的只是没卡，从而去清筛选、开折叠，怎么都找不到原因。
  // 所以：未知项目必须如实报错；「暂无任务」只留给真实存在的空项目（上一条用例已覆盖）。
  await assert.rejects(
    () => route("GET", "/api/projects/nope/empty-state"),
    (e) => e.code === "PROJECT_NOT_FOUND",
    "未知项目必须如实报「项目不存在」，不得伪造空态",
  );
});
