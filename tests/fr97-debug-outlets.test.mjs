/**
 * FR-97：无法规范流转的卡的出口 ——「交项目主会话执行（调试修复）」/「转为执行调试」。
 *
 * 现象：这类卡的卡点是「**卡住了、需要人或环境介入**」（要动 ~/.dsh、装插件、重启宿主），
 *       而看板此前只给「重试 / 看诊断」两个出口 —— 重试既不解决，团队内部也闭环不了，
 *       于是长期停在受阻，既没人看见也推不动。
 * 口径：`blocked` 且**已归因**的卡给两个新出口；「下一步本身是宿主/终端类动作」的卡同样给；
 *       **`done` / `canceled` 一律不给**（收口卡不该再摆处置按钮）。
 *       投递路径必须与 `/open-session` 同口径（同一套三级回落 + 同一套探活）——
 *       `open-session` 路由里的回落链此前是内联的，本轮已抽到 `resolveSessionRef` 复用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { deriveNextStep, NEXT_STEP_CODES } from "../src/core/next-step.mjs";
import { buildDebugDispatchPrompt, DEBUG_DISPATCH_BOUNDARIES, DEBUG_DISPATCH_REPORT_FORMAT } from "../src/core/debug-dispatch.mjs";

const ids = (r) => r.actions.map((a) => a.id);

function setup(port) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: "/tmp/ws-p1" });
  // 注意：`createApiRouter` 只接 { store, aiElaborator, events } —— 宿主端口挂在 store 上。
  if (port) store.hostSessionPort = port;
  const router = createApiRouter({ store });
  const route = (method, pathname, body) =>
    router.route({ method, pathname, searchParams: new URLSearchParams(""), body });
  return { store, route };
}

/** 一张已归因的受阻卡（归因走 `associateRequirementTask` —— createTask 不接 requirementId）。 */
function blockedTask(store, overrides = {}) {
  const item = store.createRequirementItem({ projectId: "p1", title: "R1" });
  const t = store.createTask({ projectId: "p1", title: "受阻的卡", status: "todo", ...overrides });
  store.associateRequirementTask(item.id, t.identifier);
  store.updateTask(t.identifier, { expectedVersion: store.requireTaskRef(t.identifier).version, status: "blocked" });
  return store.requireTaskRef(t.identifier);
}

// ── 1) next-step 新规则 ────────────────────────────────────────────────────────

test("FR-97 受阻且已归因：给「交主会话执行」与「转为执行调试」", () => {
  const r = deriveNextStep({ status: "blocked", requirementId: "r-1" });
  assert.ok(NEXT_STEP_CODES.includes(r.code));
  assert.equal(r.code, "blocked");
  assert.ok(ids(r).includes("dispatch-main-session"));
  assert.ok(ids(r).includes("to-debug"));
  assert.ok(r.steps.length >= 2, "必须给按顺序的出路");
});

test("FR-97 受阻但未归因：不给两个调试出口（交出去也走不通）", () => {
  const r = deriveNextStep({ status: "blocked" });
  assert.equal(r.code, "blocked-no-attribution");
  assert.ok(!ids(r).includes("dispatch-main-session"));
  assert.ok(!ids(r).includes("to-debug"));
});

test("FR-97 done / canceled 一律不给这两个动作", () => {
  for (const status of ["done", "canceled"]) {
    const r = deriveNextStep({ status, requirementId: "r-1", description: "需要重启宿主" });
    assert.equal(r.code, status);
    assert.deepEqual(ids(r), [], `${status} 不应有动作`);
  }
});

test("FR-97 下一步是宿主/终端类动作 → 给两个出口；普通卡不给", () => {
  const host = deriveNextStep({ status: "todo", requirementId: "r-1", description: "需要改 ~/.dsh/profiles 并重启宿主" });
  assert.equal(host.code, "needs-host-action");
  assert.ok(ids(host).includes("dispatch-main-session"));
  assert.ok(ids(host).includes("to-debug"));

  const plain = deriveNextStep({ status: "todo", requirementId: "r-1", description: "写一个纯函数并补单测" });
  assert.equal(plain.code, "todo", "普通卡不得被误判成宿主动作");
  assert.ok(!ids(plain).includes("dispatch-main-session"));
});

// ── 2) buildDebugDispatchPrompt 形状 ──────────────────────────────────────────

test("FR-97 指令含卡号/标题/现象/边界红线/回报格式", () => {
  const prompt = buildDebugDispatchPrompt({
    task: { identifier: "p1-7", title: "修 bug", status: "blocked", description: "点了没反应", labels: ["执行调试"] },
    project: { id: "p1", name: "P1", workspacePath: "/tmp/ws-p1" },
  });
  assert.match(prompt, /p1-7/, "必须带卡号");
  assert.match(prompt, /修 bug/, "必须带标题");
  assert.match(prompt, /点了没反应/, "必须带现象（卡面原文）");
  assert.match(prompt, /\/tmp\/ws-p1/, "必须带工作区");

  // 边界红线逐条在场 —— 收方 agent 看不到本仓 AGENTS.md，这是唯一通道。
  for (const b of DEBUG_DISPATCH_BOUNDARIES) {
    assert.ok(prompt.includes(b), `指令缺少边界红线：${b}`);
  }
  assert.match(prompt, /不 commit、不 push/);
  assert.match(prompt, /\.dsh\/profiles/);
  assert.match(prompt, /不把任务置「完成\(done\)」/);

  // 回报格式四节。
  for (const r of DEBUG_DISPATCH_REPORT_FORMAT) assert.ok(prompt.includes(r), `指令缺少回报格式：${r}`);
  assert.match(prompt, /判定/);
  assert.match(prompt, /偏离说明/);
  assert.match(prompt, /边界自查/);
  assert.match(prompt, /产物路径/);
});

test("FR-97 指令缺字段时用占位符，不产出 undefined/null 文本", () => {
  const prompt = buildDebugDispatchPrompt({});
  assert.ok(!/undefined/.test(prompt), "不得出现 undefined");
  assert.ok(!/\[object Object\]/.test(prompt));
  assert.match(prompt, /（无编号）/);
});

// ── 3) 两条路由 ───────────────────────────────────────────────────────────────

test("FR-97 dispatch-main-session：主会话失效 → 明确 reason，不写空会话标识、不抛 500", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: "/tmp/ws-p1" });
  // 探活：exists === false 才算失效（null ＝ 查不到，不当失效）。
  store.hostSessionPort = {
    sendPrompt: async () => ({ sent: true }),
    openSession: async () => ({ opened: true }),
    sessionExists: async () => ({ exists: false }),
  };
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(""), body });
  const task = blockedTask(store);
  // 绑一个主会话但让它「已失效」：解析得到 sid，探活 exists=false ⇒ session-gone。
  store.bindInitialSession("p1", "session-dead-1");

  const res = await route("POST", `/api/tasks/${task.identifier}/dispatch-main-session`, {});
  assert.equal(res.status, 200, "不得抛 500");
  assert.equal(res.payload.delivered, false);
  assert.equal(res.payload.reason, "session-gone");
  assert.ok(res.payload.nextAction, "必须给出下一步口径");
  assert.notEqual(res.payload.sessionId, undefined);
  // 状态未被误改（投递失败不推进）。
  assert.notEqual(store.requireTaskRef(task.identifier).status, "in_progress");
});

test("FR-97 dispatch-main-session：三级都解析不到 → no-session + 重建指引", async () => {
  const { store, route } = setup({ sendPrompt: async () => ({ sent: true }) });
  const task = blockedTask(store);
  const res = await route("POST", `/api/tasks/${task.identifier}/dispatch-main-session`, {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.delivered, false);
  assert.equal(res.payload.reason, "no-session");
  assert.equal(res.payload.sessionId, null, "不得写空会话标识（不得是 \"\" 或 \"-\"）");
  assert.match(res.payload.nextAction, /重建/);
});

test("FR-97 dispatch-main-session：投递成功 → 进 in_progress + 有评论凭据", async () => {
  const sent = [];
  const { store, route } = setup({
    sendPrompt: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; },
    sessionExists: async () => ({ exists: true, live: true, status: "idle" }),
  });
  const task = blockedTask(store);
  // 给项目绑一个主会话，让三级回落能命中。
  store.bindInitialSession("p1", "session-main-1");

  const res = await route("POST", `/api/tasks/${task.identifier}/dispatch-main-session`, {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.delivered, true);
  assert.equal(res.payload.sessionId, "session-main-1");
  assert.equal(sent.length, 1, "必须真的投递一次");
  assert.match(sent[0].text, /边界红线/, "投递的必须是带红线的指令");

  const after = store.requireTaskRef(task.identifier);
  assert.equal(after.status, "in_progress", "投递成功必须进「进行中」");
  assert.notEqual(after.status, "done", "红线：执行侧不得置 done");

  const comments = store.listComments(task.identifier);
  const cred = comments.find((c) => /交项目主会话执行/.test(String(c.body ?? c.text ?? "")));
  assert.ok(cred, "必须有派发凭据评论");
  assert.match(String(cred.body ?? cred.text ?? ""), /session-main-1/, "评论要带会话凭据");
});

test("FR-97 dispatch-main-session：人工校验任务 → 被拒", async () => {
  const { store, route } = setup({ sendPrompt: async () => ({ sent: true }) });
  const item = store.createRequirementItem({ projectId: "p1", title: "R1" });
  const t = store.createTask({ projectId: "p1", title: "人工校验卡", status: "backlog" });
  store.associateRequirementTask(item.id, t.identifier);
  store.updateTask(t.identifier, { expectedVersion: store.requireTaskRef(t.identifier).version, labels: ["human_review"] });

  await assert.rejects(
    () => route("POST", `/api/tasks/${t.identifier}/dispatch-main-session`, {}),
    (e) => e?.code === "HUMAN_REVIEW_NOT_EXECUTABLE",
    "人工校验任务必须被拒（结论只能人给）",
  );
});

test("FR-97 to-debug：加标签 + 回待办 + 幂等 + 归因门", async () => {
  const { store, route } = setup({ sendPrompt: async () => ({ sent: true }) });
  const task = blockedTask(store);

  const first = await route("POST", `/api/tasks/${task.identifier}/to-debug`, {});
  assert.equal(first.status, 200);
  let after = store.requireTaskRef(task.identifier);
  assert.ok(after.labels.includes("执行调试"), "必须加「执行调试」标签");
  assert.equal(after.status, "todo", "必须回「待办」");
  assert.equal(after.labels.filter((l) => l === "执行调试").length, 1);

  // 幂等：重复调用不重复追加标签。
  const second = await route("POST", `/api/tasks/${task.identifier}/to-debug`, {});
  assert.equal(second.status, 200);
  after = store.requireTaskRef(task.identifier);
  assert.equal(after.labels.filter((l) => l === "执行调试").length, 1, "不得重复追加标签");
  assert.equal(second.payload.idempotent, true);

  // 归因门：未归因的卡必须先归因。
  const noAttr = store.createTask({ projectId: "p1", title: "未归因卡", status: "todo" });
  await assert.rejects(
    () => route("POST", `/api/tasks/${noAttr.identifier}/to-debug`, {}),
    (e) => e?.code === "EXECUTION_NOT_ATTRIBUTED",
    "未归因必须被归因门拦下",
  );
});

test("FR-97 to-debug：人工校验任务 → 被拒", async () => {
  const { store, route } = setup({ sendPrompt: async () => ({ sent: true }) });
  const item = store.createRequirementItem({ projectId: "p1", title: "R1" });
  const t = store.createTask({ projectId: "p1", title: "人工校验卡", status: "backlog" });
  store.associateRequirementTask(item.id, t.identifier);
  store.updateTask(t.identifier, { expectedVersion: store.requireTaskRef(t.identifier).version, labels: ["human_review"] });
  await assert.rejects(
    () => route("POST", `/api/tasks/${t.identifier}/to-debug`, {}),
    (e) => e?.code === "HUMAN_REVIEW_NOT_EXECUTABLE",
  );
});

// ── 4) 复用口径（停下情形①：不得复制第二份解析） ───────────────────────────────

test("FR-97 open-session 与 dispatch-main-session 共用同一套三级回落", async () => {
  const { store, route } = setup({
    openSession: async () => ({ opened: true }),
    sendPrompt: async () => ({ sent: true }),
    sessionExists: async () => ({ exists: true, live: true }),
  });
  const task = blockedTask(store);
  store.bindInitialSession("p1", "session-shared");

  const openRes = await route("POST", `/api/tasks/${task.identifier}/open-session`, {});
  const dispatchRes = await route("POST", `/api/tasks/${task.identifier}/dispatch-main-session`, {});
  assert.equal(openRes.payload.sessionId, dispatchRes.payload.sessionId, "两条路由必须解析到同一会话");
  assert.equal(openRes.payload.source, dispatchRes.payload.source, "来源口径必须一致");
});