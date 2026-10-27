/**
 * FR-11 缺口补齐：**看板拖拽改状态 + 列内顺序持久化**。
 *
 * 覆盖三条（对应任务卡「要求 5」）：
 *  ① 顺序持久化 —— `board_position` 落库，重开库后列内顺序不变（不是纯前端排序）。
 *  ② 拖拽 → 状态映射 —— 跨列拖拽 = `status` + 落点，**同一次** `updateTask` 提交；卡片出现在新列的正确位置。
 *  ③ 门序不被绕过 —— 拖拽走的是**既有** `PATCH /api/tasks/:ref`，授权 / 治理 / 人工校验门一律照判，
 *     被拒时**一个字段都不写**（状态不动、`board_position` 不动、不涨版本）；纯列内排序**不写生命周期事件**。
 *
 * 数据一律落在 os.tmpdir() 临时目录（绝不写仓库）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

function withStore(label, fn, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `fr11-${label}-`));
  const store = openStore({ dataDir: dir, ...options });
  try {
    return fn(store, dir);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const seed = (store, titles, status = "todo") => titles.map((title) => store.createTask({ projectId: "p1", title, status }));
const titlesIn = (store, status) => store.listTasks({ projectId: "p1", status }).map((t) => t.title);
const patch = (store, task, changes) => store.updateTask(task.identifier, { expectedVersion: store.requireTaskRef(task.identifier).version, ...changes });

// ---------------------------------------------------------------- ① 顺序持久化

test("FR-11①：列内手工顺序落库，重开库后仍保持（不是纯前端排序）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fr11-persist-"));
  try {
    let store = openStore({ dataDir: dir });
    store.createProject({ id: "p1", name: "P1" });
    const [a, b, c] = seed(store, ["A", "B", "C"]);
    assert.deepEqual(titlesIn(store, "todo"), ["A", "B", "C"], "前置：默认按创建顺序");

    // 把 C 拖到列首（before = A）
    const moved = patch(store, c, { boardPosition: { before: a.identifier } });
    assert.equal(moved.boardPosition, 0, "被移动卡的位置应是列的 0 号");
    assert.deepEqual(titlesIn(store, "todo"), ["C", "A", "B"]);
    // 序号是**列内稠密**的 0..n-1
    assert.deepEqual(store.listTasks({ projectId: "p1", status: "todo" }).map((t) => t.boardPosition), [0, 1, 2]);

    store.close();
    store = openStore({ dataDir: dir }); // 重开库（等价于刷新页面）
    try {
      assert.deepEqual(titlesIn(store, "todo"), ["C", "A", "B"], "刷新后列内顺序必须保持");
      // 兄弟卡的内容与版本不受排序影响（排序是版式，不是内容修改）
      assert.equal(store.getTaskRef(a.identifier).version, a.version, "兄弟卡版本不得因别人排序而变化");
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FR-11①：整数下标与 null（列尾）两种落点都可用；越界下标夹取到列尾而非报错", () => {
  withStore("index", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b, c, d] = seed(store, ["A", "B", "C", "D"]);
    patch(store, d, { boardPosition: 1 }); // 整数下标：插到 A 之后
    assert.deepEqual(titlesIn(store, "todo"), ["A", "D", "B", "C"]);
    patch(store, a, { boardPosition: null }); // null = 列尾
    assert.deepEqual(titlesIn(store, "todo"), ["D", "B", "C", "A"]);
    patch(store, d, { boardPosition: 999 }); // 越界 ⇒ 夹取到列尾（渲染与落点之间列可能被别人改了）
    assert.deepEqual(titlesIn(store, "todo"), ["B", "C", "A", "D"]);
    assert.equal(store.getTaskRef(c.identifier).version, c.version, "列内排序不改兄弟卡版本");
  });
});

test("FR-11①：把卡移出列**不会**抹平源列序号（留空洞）—— 但相对顺序必须一字不差", () => {
  withStore("hole", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b, c] = seed(store, ["A", "B", "C"]);
    seed(store, ["X"], "in_progress");
    patch(store, b, { boardPosition: { before: a.identifier } }); // B,A,C → 0,1,2
    assert.deepEqual(titlesIn(store, "todo"), ["B", "A", "C"]);
    // 把列首 B 拖去别的列：源列序号留下空洞 [1,2]（不重编号源列），但相对顺序不变
    patch(store, b, { status: "in_progress" });
    assert.deepEqual(store.listTasks({ projectId: "p1", status: "todo" }).map((t) => t.boardPosition), [1, 2], "源列留空洞是既定行为（见 store.resolveBoardOrder 口径 1）");
    assert.deepEqual(titlesIn(store, "todo"), ["A", "C"], "相对顺序不得因空洞而变化");
    // 下一次对该列的显式落点会把空洞抹平（稠密 0..n-1）
    patch(store, c, { boardPosition: { before: a.identifier } });
    assert.deepEqual(store.listTasks({ projectId: "p1", status: "todo" }).map((t) => t.boardPosition), [0, 1], "显式落点后重编号为稠密");
    assert.deepEqual(titlesIn(store, "todo"), ["C", "A"]);
    assert.equal(store.getTaskRef(a.identifier).version, a.version, "整列重编号只写 board_position —— 兄弟卡版本不动（否则造出假 VERSION_CONFLICT）");
  });
});

// ---------------------------------------------------------------- ② 拖拽 → 状态映射

test("FR-11②：跨列拖拽 = status + 落点同一次提交，卡片出现在新列的正确位置", () => {
  withStore("cross", (store, dir) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b] = seed(store, ["A", "B"], "todo");
    const [x, y] = seed(store, ["X", "Y"], "in_progress");

    // 把 A 从「可开工」拖到「进行中」的 X 之前 —— 与前端 dropTask 发出的 body 逐字一致
    const moved = patch(store, a, { status: "in_progress", boardPosition: { before: x.identifier } });
    assert.equal(moved.status, "in_progress", "状态必须已变更（详情同步）");
    assert.deepEqual(titlesIn(store, "in_progress"), ["A", "X", "Y"], "落在新列的正确位置");
    assert.deepEqual(titlesIn(store, "todo"), ["B"], "旧列不再有它");
    // 事件流：状态变更必须留痕（拖拽不绕过事件口径）
    const types = store.listTaskEvents(a.identifier, { order: "asc" }).map((e) => e.type);
    assert.ok(types.includes("status_changed"), "跨列拖拽必须写 status_changed 事件");
    assert.equal(store.getTaskRef(y.identifier).version, y.version, "目标列兄弟卡版本不动");
  });
});

test("FR-11②：只改状态、不带落点（「上一列 / 下一列」按钮路径）⇒ 清空旧列位置，落进新列的未排序段", () => {
  withStore("button", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b, c] = seed(store, ["A", "B", "C"], "todo");
    const [x] = seed(store, ["X"], "in_progress");
    patch(store, c, { boardPosition: { before: a.identifier } }); // 同列排序：C 排到列首
    assert.deepEqual(titlesIn(store, "todo"), ["C", "A", "B"]);
    assert.equal(store.getTaskRef(c.identifier).boardPosition, 0, "前置：C 已被手工排过（旧列坐标 0）");
    const moved = patch(store, c, { status: "in_progress" }); // 按钮换列：不带落点
    assert.equal(moved.boardPosition, null, "跨列且未给落点 ⇒ 位置清空（不把旧列坐标带进新列）");
    // 未排序段（`board_position` 为空）内部仍按 created_at —— C 是更早创建的卡，故排在 X 之前。
    // 关键口径：它**不在列首**（旧列的坐标 0 没有被带过来），且与 X 同在"未手工排过"段。
    assert.deepEqual(titlesIn(store, "in_progress"), ["C", "X"]);
    assert.deepEqual(store.listTasks({ projectId: "p1", status: "in_progress" }).map((t) => t.boardPosition), [null, null]);
    assert.deepEqual(titlesIn(store, "todo"), ["A", "B"], "同列兄弟顺序不受影响");
  });
});

test("FR-11（与筛选共存口径）：锚点式落点在**整列**里解析 ⇒ 被筛选藏起来的卡不会让落点漂移", () => {
  withStore("filter", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b, c, d] = seed(store, ["A", "B", "C", "D"]);
    // 前端筛选后只看得到 A 与 D（B / C 被藏起）；把 D 落到 A 之前
    const moved = patch(store, d, { boardPosition: { before: a.identifier } });
    assert.equal(moved.boardPosition, 0);
    // 整列顺序：D 在 A 之前，**隐藏的 B / C 相对位置一字未动**（落点没有被"可见集"带偏）
    assert.deepEqual(titlesIn(store, "todo"), ["D", "A", "B", "C"]);
  });
});

// ---------------------------------------------------------------- ③ 门不被绕过

test("FR-11③：拖拽走既有 PATCH 入口，治理门照判 —— 被拒时状态与位置一个都不写", () => {
  withStore("governance", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [t] = seed(store, ["T"], "in_progress");
    const before = store.getTaskRef(t.identifier);

    // ① 智能体不得置 done（enforce 打开时）
    store.policy.enforce = true;
    store.policy.blockAgentClaimFromBacklog = true;
    const agentStore = Object.assign(Object.create(Object.getPrototypeOf(store)), store);
    assert.equal(agentStore.policy.enforce, true, "前置：治理门已打开");
    assert.throws(
      () => agentStore.updateTask(t.identifier, { expectedVersion: before.version, status: "done", actor: "agent", boardPosition: 0 }),
      (error) => error.code === "AGENT_CANNOT_SET_DONE",
    );
    const after = agentStore.getTaskRef(t.identifier);
    assert.equal(after.status, before.status, "被拒后状态不得变更");
    assert.equal(after.boardPosition, before.boardPosition, "被拒后位置不得写入（门先于副作用）");
    assert.equal(after.version, before.version, "被拒后不得涨版本");

    // ② backlog 不得被智能体推进（授权门的核心层口径）
    const backlog = agentStore.createTask({ projectId: "p1", title: "未授权", status: "backlog" });
    assert.throws(
      () => agentStore.updateTask(backlog.identifier, { expectedVersion: backlog.version, status: "in_progress", actor: "agent", boardPosition: null }),
      (error) => error.code === "AGENT_CANNOT_CLAIM_BACKLOG",
    );
    assert.equal(agentStore.getTaskRef(backlog.identifier).status, "backlog", "被拒后仍留在待办池（未授权）");
  });
});

test("FR-11③：人工校验任务拖到「已完成」被拒 —— 拖拽不构成绕过人工校验门的旁路", () => {
  withStore("human-review", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const task = store.createTask({ projectId: "p1", title: "人工校验卡", status: "todo", labels: ["human_review"] });
    assert.throws(
      () => patch(store, task, { status: "done", boardPosition: null }),
      (error) => error.code === "HUMAN_REVIEW_CANNOT_DONE",
    );
    const after = store.getTaskRef(task.identifier);
    assert.equal(after.status, "todo", "被拒后状态不变");
    assert.equal(after.boardPosition, null, "被拒后位置不得写入");
  });
});

test("FR-11③：纯列内排序**不写生命周期事件**（版式调整不是任务事件，不污染事件流 / 通知口径）", () => {
  withStore("no-event", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const [a, b] = seed(store, ["A", "B"]);
    const before = store.listTaskEvents(a.identifier, { order: "asc" }).map((e) => e.type);
    patch(store, b, { boardPosition: { before: a.identifier } });
    const after = store.listTaskEvents(a.identifier, { order: "asc" }).map((e) => e.type);
    assert.deepEqual(after, before, "纯排序不得追加任何事件");
  });
});

test("FR-11③：落点非法（跨列锚点 / 锚点不存在）⇒ 门先于副作用：状态、位置、版本一个都不动", () => {
  withStore("gate-order", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
    const x = store.createTask({ projectId: "p1", title: "X", status: "in_progress" });

    // 跨列拖拽却给了**旧列**的锚点 —— 前端的 dropAnchorFor 不该发这种请求，但服务端必须自己兜住。
    // 曾经的缺陷：锚点校验写在主 UPDATE 之后 ⇒ 请求被拒，状态却已经改了、版本也涨了（门后于副作用）。
    assert.throws(
      () => store.updateTask(a.identifier, { expectedVersion: a.version, status: "in_progress", boardPosition: { before: a.identifier } }),
      (error) => error.code === "INVALID_FIELD",
    );
    const after = store.getTaskRef(a.identifier);
    assert.equal(after.status, "todo", "被拒后状态不得变更（门判定先于副作用）");
    assert.equal(after.boardPosition, null, "被拒后位置不得写入");
    assert.equal(after.version, a.version, "被拒后不得涨版本");

    // 锚点不存在：同样一个字段都不写
    assert.throws(
      () => store.updateTask(a.identifier, { expectedVersion: a.version, status: "todo", boardPosition: { before: "p1-999" } }),
      (error) => error.code === "TASK_NOT_FOUND",
    );
    assert.equal(store.getTaskRef(a.identifier).version, a.version);
    assert.equal(store.getTaskRef(x.identifier).version, x.version, "被拒的拖拽也不得影响目标列兄弟卡");
  });
});

// ---------------------------------------------------------------- API 层

test("FR-11（API）：PATCH /api/tasks/:ref 接受 boardPosition 与 status，且与 GET 列表口径闭环", async () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "p1", name: "P1" });
    const router = createApiRouter({ store, events: createEventHub() });
    const sp = (extra = {}) => new URLSearchParams(extra);
    const route = (method, pathname, options = {}) => router.route({ method, pathname, searchParams: sp(options.query ?? {}), body: options.body ?? {} });

    const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
    store.createTask({ projectId: "p1", title: "B", status: "todo" });
    const x = store.createTask({ projectId: "p1", title: "X", status: "in_progress" });

    // 与前端 dropTask 同形的请求：跨列 + 锚点
    const res = await route("PATCH", `/api/tasks/${a.identifier}`, { body: { version: a.version, status: "in_progress", boardPosition: { before: x.identifier } } });
    assert.equal(res.status, 200);
    assert.equal(res.payload.task.status, "in_progress");
    assert.equal(res.payload.task.boardPosition, 0);

    const listed = await route("GET", "/api/tasks", { query: { project: "p1" } });
    assert.deepEqual(listed.payload.tasks.map((t) => `${t.status}:${t.title}`), ["in_progress:A", "in_progress:X", "todo:B"], "GET 顺序与落点闭环（列内 A 在 X 前）");
  } finally {
    store.close();
  }
});

test("FR-11（API）：落点锚点跨列 / 不存在时如实报错，不静默当成列尾", async () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "p1", name: "P1" });
    const router = createApiRouter({ store, events: createEventHub() });
    const a = store.createTask({ projectId: "p1", title: "A", status: "todo" });
    const x = store.createTask({ projectId: "p1", title: "X", status: "in_progress" });

    await assert.rejects(
      () => router.route({ method: "PATCH", pathname: `/api/tasks/${a.identifier}`, searchParams: new URLSearchParams(), body: { version: a.version, status: "todo", boardPosition: { before: x.identifier } } }),
      (error) => error.code === "INVALID_FIELD",
      "跨列锚点必须如实报错，不得静默降级",
    );
    await assert.rejects(
      () => router.route({ method: "PATCH", pathname: `/api/tasks/${a.identifier}`, searchParams: new URLSearchParams(), body: { version: a.version, status: "todo", boardPosition: { before: "p1-999" } } }),
      (error) => error.code === "TASK_NOT_FOUND",
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------- 呈现层契约（静态断言）

test("FR-11（呈现层）：卡片可拖拽、落点走既有 PATCH、保留「上一列 / 下一列」按钮", () => {
  const source = read("web/app.js");
  const css = read("web/tokens.css");

  // ① 卡片真的可拖拽（此前 `draggable|dragstart|dragover` 在 web/ 下零命中）
  assert.match(source, /node\.draggable = true;/, "卡片必须可拖拽");
  assert.match(source, /addEventListener\("dragstart"/, "必须有 dragstart");
  assert.match(source, /addEventListener\("dragover"/, "列必须接 dragover（否则落不下）");
  assert.match(source, /addEventListener\("drop"/, "必须有 drop 落点处理");
  assert.match(css, /\.board-column\.is-drop-target/, "落点高亮样式");
  assert.match(css, /\.task-card\.is-insert-before::before/, "卡间插入线样式");

  // ② 落点**复用既有状态变更入口**：同一条 PATCH，不新增旁路端点
  const dropAt = source.indexOf("async function dropTask(");
  assert.ok(dropAt > 0, "必须能定位 dropTask");
  const dropFn = source.slice(dropAt, dropAt + 900);
  assert.match(dropFn, /api\("PATCH", `\/api\/tasks\/\$\{encodeURIComponent\(task\.identifier\)\}`/, "落点必须走既有 PATCH /api/tasks/:ref");
  assert.match(dropFn, /if \(status !== task\.status\) body\.status = status;/, "跨列拖拽映射到 status");
  assert.match(dropFn, /body\.boardPosition = anchor;/, "列内落点映射到 boardPosition");
  assert.equal(/api\("POST", `\/api\/tasks\/\$\{encodeURIComponent\(task\.identifier\)\}\/move/.test(source), false, "不得新增绕过门的 /move 旁路端点");

  // ④ 与筛选共存的口径必须在**卡面**写明（要求 3）—— 不能只写在代码注释里
  assert.match(source, /人工顺序只记在列内、与筛选无关/, "卡面 title 必须写明「人工顺序与筛选共存」口径");

  // ③ 键盘 / 无障碍路径保留（不得回退既有行为）
  assert.match(source, /step\(-1, "←", "移到上一列"\)/, "保留「上一列」按钮");
  assert.match(source, /step\(1, "→", "移到下一列"\)/, "保留「下一列」按钮");
  assert.match(source, /btn\("上一列"/, "抽屉里也保留「上一列」");
  assert.match(source, /btn\("下一列"/, "抽屉里也保留「下一列」");
});

test("FR-11（呈现层）：落点折算 dropAnchorFor 的口径（跨列/同列/锚点缺失）", () => {
  const source = read("web/app.js");
  const at = source.indexOf("function dropAnchorFor(");
  assert.ok(at > 0, "必须能定位 dropAnchorFor");
  // 抽出函数体（到下一个顶层 `}` 收尾）在测试里实跑 —— 前端是零依赖浏览器脚本，无法 import。
  const end = source.indexOf("\n    }", at);
  const body = source.slice(at, end + "\n    }".length);
  const dropAnchorFor = new Function(`${body}; return dropAnchorFor;`)();

  const col = [{ identifier: "A" }, { identifier: "B" }, { identifier: "C" }];
  // 同列内：C 拖到 A 之前
  assert.deepEqual(dropAnchorFor(col, "C", "A", false), { before: "A" });
  // 同列内：A 拖到列尾
  assert.deepEqual(dropAnchorFor(col, "A", null, false), { before: null });
  // 同列内原地：A 拖到 B 之前（= 它本来就在 B 前）⇒ null（不提交）
  assert.equal(dropAnchorFor(col, "A", "B", false), null);
  // 同列内原地：本来就是最后一张、又落到列尾 ⇒ null
  assert.equal(dropAnchorFor(col, "C", null, false), null);
  // 跨列：被拖卡不在目标列可见集里，锚点照解析
  assert.deepEqual(dropAnchorFor([{ identifier: "X" }, { identifier: "Y" }], "A", "Y", true), { before: "Y" });
  // 跨列落空列 / 列尾 ⇒ 列尾
  assert.deepEqual(dropAnchorFor([], "A", null, true), { before: null });
  // 锚点已不在可见集（刚被别人移走）⇒ 退回列尾，不臆断
  assert.deepEqual(dropAnchorFor([{ identifier: "X" }], "A", "GONE", true), { before: null });
});
