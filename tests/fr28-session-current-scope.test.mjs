/**
 * FR-28 · 会话中查看与该会话相关的任务（缺口补齐：**仅本会话**档 + 会话内默认收敛 + 降级可见）
 *
 * 正式口径（`docs/需求文档.md` FR-28；裁决见 `docs/进度/2026-10-23-FR28会话区呈现口径裁决.md`）：
 *  ① 会话内**默认按本会话收敛**（不是「有没有关联会话」，而是「关联的是不是**这一个**」）；
 *  ② 提供「全部 / 仅本会话 / 已关联 / 未关联」四档，可一键放开（防「任务好像不见了」）；
 *  ③ 保留 FR-26 的 `session-chip` 两态标记；
 *  ④ **降级可见**：拿不到 `sessionId` 时明写「未检测到当前会话 · 显示全部」，**不得静默全显**。
 *
 * 与 FR-26 的语义区别（不可互相顶替）：
 *  · `linked` / `unlinked` 问「**有没有**关联会话」——二分全部卡；
 *  · `session:<id>` 问「关联的是**不是这一个**」——是 `linked` 的一个**子集**（可空）。
 *
 * 红线（用例直接断言，不靠注释）：
 *  · 不改数据：筛选是只读路径，不得写 status / session_id / version。
 *  · 不臆断：空 id 的 `session:` **如实报错**，不得静默降级成「全部」。
 *  · 不与既有维度互斥：与状态/优先级/标签一律**取交集**（不是并集）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { deriveEmptyState, formatSessionScope } from "../src/core/empty-state.mjs";

/** 造一个三类卡的项目：本会话关联 / 别的会话关联 / 未关联。 */
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

// ── store 层：`session:<id>` 的语义本身 ──────────────────────────────
test("listTasks：sessionScope=session:<id> 只出**这一个**会话的卡；是 linked 的真子集", () => {
  const { store } = setup();
  const mine = store.createTask({ projectId: "p1", title: "本会话在做", status: "todo" });
  const other = store.createTask({ projectId: "p1", title: "别的会话在做", status: "todo" });
  const none = store.createTask({ projectId: "p1", title: "没人认领", status: "todo" });
  store.claimTask(mine.identifier, { sessionId: "session-mine" });
  store.claimTask(other.identifier, { sessionId: "session-other" });

  const scoped = store.listTasks({ projectId: "p1", sessionScope: "session:session-mine" });
  assert.deepEqual(ids(scoped), [mine.identifier], "「仅本会话」必须只出本会话的卡（别的会话不得混进）");
  assert.ok(!scoped.some((t) => t.identifier === other.identifier), "别的会话的卡不得混进「仅本会话」");
  assert.ok(!scoped.some((t) => t.identifier === none.identifier), "未关联的卡不得混进「仅本会话」");

  // 语义关系：session:<id> ⊆ linked（同一批卡口径不冲突）
  const linked = store.listTasks({ projectId: "p1", sessionScope: "linked" });
  assert.equal(scoped.length, 1);
  assert.equal(linked.length, 2);
  assert.ok(scoped.every((t) => linked.some((l) => l.identifier === t.identifier)), "「仅本会话」必须是「已关联」的子集");

  // 没有任何卡关联到该会话 ⇒ 空集（不是「全部」）
  assert.deepEqual(store.listTasks({ projectId: "p1", sessionScope: "session:session-nobody" }), []);
});

test("listTasks：sessionScope=session:（空 id / 纯空白）如实报错，不得静默降级成「全部」", () => {
  const { store } = setup();
  store.createTask({ projectId: "p1", title: "一张卡" });
  assert.throws(() => store.listTasks({ projectId: "p1", sessionScope: "session:" }), /sessionScope/);
  assert.throws(() => store.listTasks({ projectId: "p1", sessionScope: "session:   " }), /sessionScope/);
});

test("listTasks：既有语义与非法值报错**未被改坏**（FR-26 回归）", () => {
  const { store } = setup();
  const linked = store.createTask({ projectId: "p1", title: "已关联", status: "todo" });
  const unlinked = store.createTask({ projectId: "p1", title: "未关联" });
  store.claimTask(linked.identifier, { sessionId: "session-aaa" });

  assert.deepEqual(ids(store.listTasks({ projectId: "p1", sessionScope: "linked" })), [linked.identifier]);
  assert.deepEqual(ids(store.listTasks({ projectId: "p1", sessionScope: "unlinked" })), [unlinked.identifier]);
  for (const scope of [undefined, null, ""]) {
    assert.equal(store.listTasks({ projectId: "p1", sessionScope: scope }).length, 2, `sessionScope=${JSON.stringify(scope)} 仍是「全部」`);
  }
  assert.throws(() => store.listTasks({ projectId: "p1", sessionScope: "bogus" }), /sessionScope/, "非法值仍如实报错");
});

test("listTasks：仅本会话与状态 / 优先级 / 标签取交集（不是并集）", () => {
  const { store } = setup();
  const hit = store.createTask({ projectId: "p1", title: "命中", status: "todo", priority: "high", labels: ["缺陷"] });
  const wrongStatus = store.createTask({ projectId: "p1", title: "状态不符", status: "done", priority: "high", labels: ["缺陷"] });
  const wrongPriority = store.createTask({ projectId: "p1", title: "优先级不符", status: "todo", priority: "low", labels: ["缺陷"] });
  const otherSession = store.createTask({ projectId: "p1", title: "别的会话", status: "todo", priority: "high", labels: ["缺陷"] });
  for (const t of [hit, wrongStatus, wrongPriority]) store.claimTask(t.identifier, { sessionId: "session-mine" });
  store.claimTask(otherSession.identifier, { sessionId: "session-other" });

  const rows = store.listTasks({ projectId: "p1", sessionScope: "session:session-mine", status: "todo", priority: "high", labels: ["缺陷"] });
  assert.deepEqual(rows.map((t) => t.identifier), [hit.identifier]);
});

// ── API 层：前端实际走的那条路 ───────────────────────────────────────
test("API：GET /api/tasks?sessionScope=session:<id> 生效、可组合、且不改库", async () => {
  const { store, route } = setup();
  const a = store.createTask({ projectId: "p1", title: "本会话·可开工", status: "todo" });
  const b = store.createTask({ projectId: "p1", title: "本会话·已完成", status: "done" });
  const c = store.createTask({ projectId: "p1", title: "别会话·可开工", status: "todo" });
  const d = store.createTask({ projectId: "p1", title: "未关联", status: "todo" });
  for (const t of [a, b]) store.claimTask(t.identifier, { sessionId: "session-mine" });
  store.claimTask(c.identifier, { sessionId: "session-other" });

  const snapshot = () => store.listTasks({ projectId: "p1" })
    .map((t) => `${t.identifier}:${t.status}:${t.version}:${t.sessionId ?? ""}`).sort();
  const baseline = snapshot();

  const scoped = await route("GET", "/api/tasks?project=p1&sessionScope=session%3Asession-mine");
  assert.equal(scoped.status, 200);
  assert.deepEqual(ids(scoped.payload.tasks), [a.identifier, b.identifier].sort());

  const scopedTodo = await route("GET", "/api/tasks?project=p1&sessionScope=session%3Asession-mine&status=todo");
  assert.deepEqual(scopedTodo.payload.tasks.map((t) => t.identifier), [a.identifier]);

  // 四档切换：全部 / 仅本会话 / 已关联 / 未关联 —— 结果互不相同且各如其分
  const all = await route("GET", "/api/tasks?project=p1");
  const linked = await route("GET", "/api/tasks?project=p1&sessionScope=linked");
  const unlinked = await route("GET", "/api/tasks?project=p1&sessionScope=unlinked");
  assert.equal(all.payload.tasks.length, 4);
  assert.equal(linked.payload.tasks.length, 3);
  assert.equal(unlinked.payload.tasks.length, 1);
  assert.equal(scoped.payload.tasks.length, 2);

  assert.deepEqual(snapshot(), baseline, "筛选是只读路径，不得写库");
});

test("API：empty-state 端点把「仅本会话」如实带入取数口径（与前端同一条路）", async () => {
  const { store, route } = setup();
  store.createTask({ projectId: "p1", title: "未关联一张", status: "todo" });

  const miss = await route("GET", "/api/projects/p1/empty-state?sessionScope=session%3Asession-mine");
  assert.equal(miss.payload.emptyState.empty, true, "「仅本会话」下无卡 ⇒ 必须判空");
  assert.equal(miss.payload.emptyState.message, "当前筛选下没有任务");

  // 引导文案必须如实回显「仅本会话（<短标识>…）」这一档
  const derived = deriveEmptyState({
    allTasks: [{ identifier: "x", status: "todo", labels: [] }],
    visibleTasks: [],
    filters: { sessionScope: "session:session-mine-1234567890" },
  });
  assert.match(derived.hints[0], /会话归属=仅本会话（session-mine-1…）/, "空态引导必须回显当前会话归属档位");
});

// ── 纯函数口径（前端文案防漂移的锚点） ────────────────────────────────
test("formatSessionScope：四档文案逐字；空值＝空串；短标识截断但真值不丢", () => {
  assert.equal(formatSessionScope(""), "");
  assert.equal(formatSessionScope("   "), "");
  assert.equal(formatSessionScope(undefined), "");
  assert.equal(formatSessionScope("linked"), "已关联会话");
  assert.equal(formatSessionScope("unlinked"), "未关联会话");
  assert.equal(formatSessionScope("session:abc"), "仅本会话（abc）");
  assert.equal(formatSessionScope("session:"), "仅本会话");
  const long = formatSessionScope("session:session-70a0bcda-1234");
  assert.match(long, /^仅本会话（session-70a0bc…）$/, "长标识只截短到固定前缀，其余以省略号表示");
});

// ── 前端接线（源码级断言：零依赖原生脚本无单测环境，与既有做法一致） ──────
test("web/app.js：会话内默认收敛「仅本会话」+ 四档选项 + 降级可见文案 + 保留 session-chip", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

  // ① 会话内默认收敛：默认档位由 sessionId 推导，不是空串（旧口径）
  assert.match(src, /const defaultSessionScope = sessionId \? `\$\{SESSION_SCOPE_CURRENT_PREFIX\}\$\{sessionId\}` : "";/, "会话内必须默认收敛到「仅本会话」");
  assert.match(src, /sessionScope: defaultSessionScope, session: sessionId/, "state.sessionScope 默认取 defaultSessionScope");

  // ② 四档：仅本会话（会话内才有）+ 已关联 + 未关联 + 「全部」占位项
  assert.match(src, /function sessionScopeOptions\(\)/, "必须有档位选项函数");
  assert.match(src, /options\.push\(\[`\$\{SESSION_SCOPE_CURRENT_PREFIX\}\$\{sessionId\}`, `仅本会话（\$\{shortSessionId\(sessionId\)\}）`\]\)/, "必须提供「仅本会话（<短标识>）」档");
  assert.match(src, /options\.push\(\["linked", SESSION_SCOPE_LABELS\.linked\], \["unlinked", SESSION_SCOPE_LABELS\.unlinked\]\)/, "FR-26 两档必须保留");
  assert.match(src, /fillSelect\(sessionFilter, sessionScopeOptions\(\), state\.sessionScope/, "下拉必须按当前档位选中显示");
  assert.match(src, /"全部（不限会话归属）"/, "「全部」档必须可一键切回");

  // ③ 降级可见：拿不到 sessionId 时明写，不得静默全显
  assert.match(src, /const NO_SESSION_NOTICE = "未检测到当前会话 · 显示全部";/, "降级文案必须逐字存在");
  assert.match(src, /sessionId \? "" : NO_SESSION_NOTICE/, "降级文案必须挂在工具栏（无会话时才显示）");
  assert.match(src, /sessionScopeNote,/, "降级文案节点必须真正挂进工具栏");

  // ④ 保留 FR-26 的 session-chip 两态标记（FR-28 不动它）
  assert.match(src, /session-chip \$\{linked \? "session-linked" : "session-unlinked"\}/, "FR-26 两态标记必须保留");
  assert.match(src, /const session = String\(task\.sessionId \?\? ""\)\.trim\(\);/);

  // ⑤ 降级文案与纯函数文案防漂移（前端逐字包含）
  assert.ok(src.includes('"已关联会话"') && src.includes('"未关联会话"'), "FR-26 文案不得漂移");
});

test("web/tokens.css：降级提示有条目级样式（区别于普通 hint）", async () => {
  const css = await readFile(new URL("../web/tokens.css", import.meta.url), "utf8");
  assert.match(css, /\.session-scope-note \{/, "降级提示必须有独立样式类");
});

test("web/app.js：前后端版本不同步时降级「可见且不空白」（新档被旧服务端拒 ⇒ 退回全部并明写原因）", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");

  // 前端随宿主实时读盘更新、服务端须重载 ⇒ 新旧并存期必须安全降级（否则整块看板空白，比降级更糟）
  assert.match(src, /if \(!\(error\?\.code === "INVALID_FIELD" && wantsCurrentScope\)\) throw error;/, "只对该档被拒的情形降级，其它错误照抛");
  const retry = /retry\.delete\("sessionScope"\);[\s\S]{0,120}?payload = await api\("GET"/.exec(src);
  assert.ok(retry, "降级后必须退回「全部」重取（不得让看板空白）");
  assert.match(src, /state\.sessionScopeUnsupported = true;/, "降级状态必须被记录");
  assert.match(src, /state\.sessionScopeUnsupported = false;[\s\S]{0,200}?服务端已认本档|if \(wantsCurrentScope && !degraded\) state\.sessionScopeUnsupported = false;/, "服务端认了本档后须能自动恢复（无需刷新页面）");

  // 降级文案同样**明写**，沿用同一 `.session-scope-note`（不静默）
  assert.match(src, /服务端未加载「仅本会话」档 · 显示全部（需重载插件）/, "降级原因必须明写在工具栏");
  assert.match(src, /function renderSessionScopeNote\(\)/, "降级提示必须有统一渲染函数");
});

test("web/app.js：renderSessionScopeNote 真跑两态（提取该函数用最小假 DOM 驱动，非仅正则）", async () => {
  const src = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
  const block = /\n    function renderSessionScopeNote\(\) \{[\s\S]*?\n    \}/.exec(src);
  assert.ok(block, "必须能定位到降级提示渲染函数");

  const note = { textContent: "", title: "" };
  const run = (sessionId, unsupported) =>
    new Function("sessionId", "sessionScopeNote", "state", "NO_SESSION_NOTICE",
      `${block[0]}\nrenderSessionScopeNote();\nreturn sessionScopeNote;`)(
      sessionId, { ...note }, { sessionScopeUnsupported: unsupported }, "未检测到当前会话 · 显示全部",
    );

  // ① 无会话 ⇒ 降级文案（不得静默空着）
  assert.equal(run(null, false).textContent, "未检测到当前会话 · 显示全部");
  // ② 有会话且服务端未加载本档 ⇒ 明写原因（不静默）
  const unsupported = run("session-x", true);
  assert.match(unsupported.textContent, /服务端未加载「仅本会话」档 · 显示全部（需重载插件）/);
  assert.ok(unsupported.title.length > 0, "降级要有 title 说明可核验的成因");
  // ③ 有会话且服务端已认 ⇒ 不显示任何降级文案
  assert.equal(run("session-x", false).textContent, "");
});
