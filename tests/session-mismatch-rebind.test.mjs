/**
 * FR-84 补口 · 真机复报「按提示重建完，同一张卡还是说工作区不对」的**一次到位**路径（2026-10-23）。
 *
 * 现场：任务级 `session_id` 指向 `cwd="/"` 的会话；「重建并绑定项目主会话」只改**项目**指针 ⇒ 改不动这张卡。
 * 本组钉两件事：
 *   A. 领域层 —— 项目无主会话时任务级改指**必须先重建**（NO_PROJECT_MAIN_SESSION）；
 *      重建（cwd = 项目工作区）产出的会话**可以**被任务级改指复用 ⇒ 两步串起来才解得开这张卡。
 *   B. 接线层 —— 抽屉在「项目主会话不可用」时给出的按钮与**两次调用顺序**（先项目重建 → 再任务改指）都在位；
 *      「项目主会话可用」时仍只走任务级改指（不新建会话、不碰项目指针）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const sp = (qs = "") => new URLSearchParams(qs);
const APP = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

function setup({ workspacePath = null, taskSession = null } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  if (taskSession) store.startTaskExecution(t.identifier, { sessionId: taskSession });
  return { store, t };
}

/** 宿主端口：按会话给 cwd；`createSession` 把**传下去的 cwd** 登记进同一张表（忽略 cwd ⇒ 记 null ⇒ 归属门会拦）。 */
function hostPort({ origins = {}, createdPrefix = "session-new" } = {}) {
  const map = { ...origins };
  const calls = { createArgs: [], prompt: [] };
  return {
    map,
    calls,
    port: {
      available: true,
      async sessionExists(sessionId) { return { sessionId, exists: sessionId in map, source: "mock" }; },
      async sessionOrigin(sessionId) { return { sessionId, cwd: map[sessionId] ?? null, source: "mock" }; },
      async sendPrompt(sessionId, text) { calls.prompt.push({ sessionId, text }); return { sent: true }; },
      async createSession(args) {
        calls.createArgs.push(args ?? null);
        const id = `${createdPrefix}-${calls.createArgs.length}`;
        map[id] = args?.cwd ?? null;
        return { sessionId: id };
      },
    },
  };
}

const projectRebind = (router, body) => router.route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body });
const taskRebind = (router, ref, body) => router.route({ method: "POST", pathname: `/api/tasks/${ref}/session/rebind`, searchParams: sp(), body });

test("A1：项目无主会话时任务级改指 ⇒ NO_PROJECT_MAIN_SESSION（这就是必须先重建的原因）", async () => {
  const { store, t } = setup({ workspacePath: "/w/p1", taskSession: "session-other" });
  store.hostSessionPort = hostPort({ origins: { "session-other": "/" } }).port;
  await assert.rejects(
    () => taskRebind(createApiRouter({ store }), t.identifier, { confirm: true }),
    (e) => e.code === "NO_PROJECT_MAIN_SESSION",
  );
  assert.equal(store.getTaskById(t.id).sessionId, "session-other", "拒绝时不得改指（旧会话不删）");
  store.close();
});

test("A2：两步串起来解开现场 —— 重建（cwd=项目工作区）→ 任务级改指到新会话", async () => {
  const { store, t } = setup({ workspacePath: "/w/p1", taskSession: "session-other" });
  const { port, calls } = hostPort({ origins: { "session-other": "/" } });
  store.hostSessionPort = port;
  const router = createApiRouter({ store });
  const before = store.getTaskById(t.id);

  const rb = await projectRebind(router, { confirm: true });
  assert.equal(rb.payload.rebound, true);
  assert.equal(calls.createArgs[0]?.cwd, "/w/p1", "重建必须把项目工作区当 cwd 传给宿主");

  const fix = await taskRebind(router, t.identifier, { confirm: true, sessionId: rb.payload.after });
  assert.equal(fix.payload.rebound, true);
  const now = store.getTaskById(t.id);
  assert.equal(now.sessionId, rb.payload.after, "任务级引用必须改指到新主会话");
  assert.equal(now.status, before.status, "改指只动引用，不动状态");
  assert.equal(now.claimOwner ?? null, before.claimOwner ?? null, "不改认领者");
  assert.equal(now.title, before.title, "其余字段不动");
  store.close();
});

test("A3：目标主会话本身落在别的工作区 ⇒ 如实拒绝（不制造第二个错绑）", async () => {
  const { store, t } = setup({ workspacePath: "/w/p1", taskSession: "session-other" });
  store.hostSessionPort = hostPort({ origins: { "session-other": "/", "session-main": "/w/other" } }).port;
  const router = createApiRouter({ store });
  await projectRebind(router, { confirm: true, sessionId: "session-main", force: true });
  await assert.rejects(
    () => taskRebind(router, t.identifier, { confirm: true }),
    (e) => e.code === "SESSION_OTHER_WORKSPACE",
  );
  assert.equal(store.getTaskById(t.id).sessionId, "session-other", "拒绝时不得改指");
  store.close();
});

function mismatchBlock() {
  const start = APP.indexOf('const mismatchBar = mk("div", "btn-row", null);');
  assert.ok(start > -1, "抽屉的错配动作条必须存在");
  const end = APP.indexOf("execSec.appendChild(mismatchBar);", start);
  assert.ok(end > start, "错配动作条必须有收尾");
  return APP.slice(start, end);
}

test("B1：项目主会话不可用时给出「一次到位」按钮，且顺序＝先项目重建 → 再任务改指", () => {
  const block = mismatchBlock();
  assert.match(block, /重建主会话并把本任务改指过去/, "按钮文案必须说清「重建 + 改指」两件事");
  const iProject = block.indexOf("/sessions/rebind");
  assert.ok(iProject > -1, "必须先重建项目主会话");
  const iTask = block.indexOf("/api/tasks/${ref}/session/rebind", iProject);
  assert.ok(iTask > iProject, "顺序：先项目重建，拿到 after 再改指本任务");
  assert.match(block.slice(iTask, iTask + 300), /sessionId: after/, "任务级改指必须复用重建产出的会话，不靠服务端再猜");
});

test("B2：项目主会话可用时只走任务级改指（不新建会话、不碰项目指针）", () => {
  const block = mismatchBlock();
  const usable = block.slice(block.indexOf("if (pmUsable) {"), block.indexOf("} else {"));
  assert.match(usable, /改指到项目主会话（本任务）/);
  assert.ok(!usable.includes("/sessions/rebind"), "可用分支不得顺手再建会话（重建＝写用户数据）");
  assert.match(APP, /属于另一个工作区/, "错配告警必须仍在（不得为了按钮好看而静默）");
});

// ── C 组（2026-10-26 · 真机 `-63` / `-69` 复现）───────────────────────────────────
// 现场：`tasks.session_id` 指向落在 `…/项目-dsh-acp`（**别的工作区**）的会话；用户点「打开执行会话」
// 被拦下的横幅叫他「请用『重建并绑定项目主会话』接续」→ 照做后**同一张卡仍报同一句话**。
// 根因：`resolveSessionRef` 里**任务级引用优先、且不看存活也不看归属** ⇒ 只要 `tasks.session_id` 被写坏，
// 项目级重建（只改 `projects.initial_session_id`）**永远解不开这张卡**；唯一有效动作是**任务级改指**。
// 本组钉：三处提示都必须按「错配/失效的是哪一级引用」（`sessionRef.source` / `verdict.source`）分流，
// 且「本任务自己」这一支必须给得出真能生效的动作。B 组只覆盖了「跨工作区 + 项目主会话可用」的按钮，
// 这三处**漏在同一类判断上**，此前无任何断言。

function staleBlock() {
  const start = APP.indexOf("if (staleRef) {");
  assert.ok(start > -1, "抽屉「引用已失效」分支必须存在");
  const end = APP.indexOf("} else if (!refSessionId) {", start);
  assert.ok(end > start, "该分支必须有收尾");
  return APP.slice(start, end);
}

function bannerBlock(marker) {
  const i = APP.indexOf(marker);
  assert.ok(i > -1, `${marker} 必须存在`);
  const j = APP.indexOf("verdict?.reason ===", i + marker.length);
  return APP.slice(i, j > -1 ? j : i + 1200);
}

test("C1：抽屉「引用已失效」按来源分流 —— 任务自己的引用给「改指（本任务）」，项目级仍指重建", () => {
  const block = staleBlock();
  assert.match(block, /sessionRef\?\.source/, "必须按引用来源分流，不得一律叫用户去重建");
  assert.match(block, /改指到项目主会话（本任务）/, "任务级失效必须给得出真能生效的动作（否则用户无处可去）");
  assert.match(block, /重建并绑定项目主会话/, "项目级分支仍指向重建");
  assert.ok(block.indexOf("if (ownRef) {") > block.indexOf("sessionRef?.source"),
    "任务级按钮必须在分流之后才渲染");
});

test("C2：抽屉错配分支为「项目主会话指针错配」留出重建出口（否则会给一个必然失败的改指按钮）", () => {
  const block = mismatchBlock();
  assert.match(block, /if \(!refIsOwn\) \{/, "必须先判错配的是哪一级引用");
  const notOwn = block.slice(block.indexOf("if (!refIsOwn) {"), block.indexOf("} else if (pmUsable) {"));
  assert.match(notOwn, /重建并绑定项目主会话/, "项目主会话指针错配 ⇒ 重建才有效");
  assert.ok(!/api\/tasks\//.test(notOwn), "项目级错配不得给任务级改指（那会改到别的卡上）");
});

test("C3：「打开执行会话」两条失败横幅都按 verdict.source 分流（不得再一律指「重建并绑定项目主会话」）", () => {
  for (const [name, marker] of [
    ["session-gone", 'if (verdict?.reason === "session-gone") {'],
    ["session-other-workspace", 'if (verdict?.reason === "session-other-workspace") {'],
  ]) {
    const seg = bannerBlock(marker);
    assert.match(seg, /verdict\?\.source/, `${name} 横幅必须按来源分流`);
    assert.match(seg, /改指到项目主会话（本任务）/, `${name} 横幅必须给出任务级出口`);
    assert.match(seg, /重建并绑定项目主会话/, `${name} 横幅的项目级分支必须仍在`);
  }
});
