/**
 * 卡 `-272`（需求 `R188` 验收③）：**新建会话的任务书必须真的送到那条会话** ——
 * 「授权已成」≠「任务书已送达」，界面不得拿前者冒充后者。
 *
 * 为什么单列一条守卫（本卡实测缺口，修前必现）：
 *   宿主 `createSession({ preset })` 的 preset 投递**会静默失败** —— `index.js` 的
 *   `deliver()` 在 scope 解析不到时（`loadScopeFactory()` → `dsc-scope` 不可得）
 *   `sessionController.prompt` 抛 "Agent preset binding requires a scoped context"，
 *   被 try/catch 吞成 `presetApplied:false`；`sessions.sendMessage` 也不可用时直接 `prompt-unavailable`。
 *   于是：会话建出来了、`project_sessions` 授权行写了、回包 `mode="create-and-authorize"`，
 *   而**授权指令与任务书一个字都没进那条会话** —— 界面照报「已新建执行会话并首次授权…无需再申请关联」。
 *   这正是 `R188` ③ 原文「投递给该会话的任务书里含【授权】/ 不得再申请 / 回写四节」**没有兑现**。
 *
 * 口径（本守卫钉死的四条）：
 *   ① preset 送达 ⇒ `bookDelivery.delivered=true`、`via="preset"`，**不重复投递**（sendPrompt 0 次）；
 *   ② preset 被吞 ⇒ **补投一次**同一份任务书（`via="send-prompt-fallback"`）——不是重复投递，preset 那条本就没成；
 *   ③ 两条都失败 ⇒ `delivered=false` + 原因，且**必须留痕**（审计 `authorize-exec-deliver` + 卡上评论）——
 *      这句话得让人看得见，否则「派了但会话不知道要做什么」是静默的；
 *   ④ 复用路径**不适用**（`bookDelivery=null`）——复用会话本来就在跑，任务书由 `sendPrompt` 单独投递。
 *
 * 全部走真 HTTP 路由（`createApiRouter`），假宿主通道只记录不真投。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

const sp = () => new URLSearchParams();

/**
 * `presetApplied`：宿主自述 preset 有没有生效（模拟真机 `createSession` 的返回值）。
 * `sendOk`：`sendPrompt` 是否送达（模拟 `deliver()` 的两条路都失败）。
 */
function setup({ presetApplied = true, sendOk = true } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: "/repo/p1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const calls = { created: [], sent: [], opened: [] };
  store.hostSessionPort = {
    available: true,
    capabilities: () => ({ sessionController: true, prompt: true, create: true }),
    // 没有任何已绑定会话 ⇒ 必然走「新建 + 首次授权」这条路（本守卫只关心那一条）
    sessionState: () => ({ live: false, running: false, pending: 0 }),
    sessionExists: async () => ({ exists: false, source: "stub" }),
    sessionOrigin: async () => ({ cwd: null, source: "stub" }),
    sendPrompt: async (sessionId, text) => {
      calls.sent.push({ sessionId, text });
      return sendOk ? { sent: true } : { sent: false, reason: "stub-send-failed" };
    },
    createSession: async (opts) => {
      const sessionId = `sess-new-${calls.created.length + 1}`;
      calls.created.push({ sessionId, opts });
      return { sessionId, presetApplied, titleApplied: true };
    },
    openSession: async (sessionId) => { calls.opened.push(String(sessionId)); return { opened: true }; },
  };
  const task = (() => {
    const t = store.createTask({ projectId: "p1", title: "派发", status: "todo", acceptance: "A 条", verifyCommand: "npm test" });
    store.associateRequirementTask(item.id, t.id);
    return t;
  })();
  const router = createApiRouter({ store, events: createEventHub() });
  const execute = () => router.route({ method: "POST", pathname: `/api/tasks/${task.identifier}/execute`, searchParams: sp(), body: {} });
  return { store, calls, task, execute };
}

test("preset 送达 ⇒ bookDelivery.delivered=true / via=preset，且**不重复投递**", async () => {
  const { store, calls, execute } = setup({ presetApplied: true, sendOk: true });
  const r = await execute();
  assert.equal(r.status, 200);
  assert.equal(r.payload?.launch?.mode, "create-and-authorize");
  assert.deepEqual(r.payload?.launch?.bookDelivery, { delivered: true, via: "preset", reason: null });
  assert.equal(calls.sent.length, 0, "preset 已经送达就不该再补投（补投是给失败路径用的）");
  // 授权留痕同样要如实：授权生效、任务书送达，两件事都在
  assert.equal(r.payload?.launch?.authorization?.delivered, true);
  assert.equal(r.payload?.launch?.authorization?.deliveryVia, "preset");
  store.close();
});

test("preset 被宿主吞掉 ⇒ **补投一次**同一份任务书，并如实标 via=send-prompt-fallback", async () => {
  const { store, calls, task, execute } = setup({ presetApplied: false, sendOk: true });
  const r = await execute();
  assert.equal(r.status, 200);
  assert.equal(r.payload?.launch?.bookDelivery?.delivered, true, "补投成功 ⇒ 任务书确实到了会话，不许报未送达");
  assert.equal(r.payload?.launch?.bookDelivery?.via, "send-prompt-fallback");
  assert.equal(calls.sent.length, 1, "只补投一次（preset 本就没成，这不是重复投递）");
  assert.equal(calls.sent[0].sessionId, r.payload.launch.sessionId, "必须投给**刚新建的那条会话**");
  // 补投的内容必须就是授权任务书本身 —— 含【授权】/「不得再申请」/回写四节这些验收③点名的段
  const text = calls.sent[0].text;
  assert.match(text, /【授权】/);
  assert.match(text, /不得再申请/);
  assert.match(text, /待验收/);
  // 补投成功后不留「未送达」的告警评论（否则人会去追一个已经解决了的问题）
  const comments = store.listComments(task.id).map((c) => c.body);
  assert.ok(!comments.some((b) => /任务书未送达/.test(b)), `不该留未送达告警：${comments.join(" | ")}`);
  store.close();
});

test("preset 与补投**双双失败** ⇒ delivered=false + 原因，且审计与卡上评论都留痕", async () => {
  const { store, calls, task, execute } = setup({ presetApplied: false, sendOk: false });
  const r = await execute();
  assert.equal(r.status, 200, "派发本身不因任务书没送到而失败：会话与授权都是有效副作用，如实回执即可");
  assert.equal(r.payload?.launch?.bookDelivery?.delivered, false);
  assert.equal(r.payload?.launch?.bookDelivery?.reason, "stub-send-failed", "原因要原样带回来（不吞成「未知」）");
  assert.equal(r.payload?.launch?.authorization?.delivered, false, "授权对象里也必须如实说没送到");
  assert.equal(calls.sent.length, 1, "无论如何都尝试过一次补投");
  // ① 审计：这是「派了但没送成」，属于治理动作，必须可回查
  const audits = store.listGovernanceAudit({ action: "authorize-exec-deliver" });
  assert.equal(audits.length, 1, `审计行数：${audits.length}`);
  assert.equal(audits[0].allowed, false);
  assert.equal(audits[0].reason, "stub-send-failed");
  // ② 卡上评论：界面之外也要留痕（关掉浏览器也还能看到）
  const bodies = store.listComments(task.id).map((c) => c.body);
  const warn = bodies.find((b) => /任务书未送达/.test(b));
  assert.ok(warn, `卡片上必须留下未送达告警：${bodies.join(" | ")}`);
  assert.match(warn, /打开执行会话/, "要给出可执行替代（手工贴任务书）");
  store.close();
});

test("复用路径不适用：bookDelivery=null（复用会话的任务书由 sendPrompt 单独投递，不走「新建授权」这条）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p2", name: "P2", workspacePath: "/repo/p2" });
  store.bindInitialSession("p2", "sess-main");
  const item = store.createRequirementItem({ projectId: "p2", title: "R" });
  const t = store.createTask({ projectId: "p2", title: "复用", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const sent = [];
  store.hostSessionPort = {
    available: true,
    capabilities: () => ({ sessionController: true, prompt: true, create: true }),
    sessionState: () => ({ exists: true, live: true, running: false, pending: 0 }),
    sessionExists: async () => ({ exists: true, source: "stub" }),
    sessionOrigin: async () => ({ cwd: "/repo/p2", source: "stub" }),
    sendPrompt: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; },
    createSession: async () => { throw new Error("复用路径不该建会话"); },
    openSession: async () => ({ opened: true }),
  };
  const router = createApiRouter({ store, events: createEventHub() });
  const r = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/execute`, searchParams: sp(), body: {} });
  assert.equal(r.payload?.launch?.mode, "reuse-bound");
  assert.equal(r.payload?.launch?.bookDelivery, null, "复用路径没有「新建授权」这一环 ⇒ 这个字段必须显式 null（键恒在）");
  assert.equal(r.payload?.launch?.authorization, undefined, "复用路径不得写授权回执（会冒充「批准过」）");
  assert.equal(sent.length, 1, "复用路径的任务书本就由 sendPrompt 投递");
  assert.equal(sent[0].sid, "sess-main");
  store.close();
});

test("送达补投的正文与 preset 正文**同源**（不许两条路各写一份口径）", async () => {
  // preset 路径与补投路径必须投同一份 `buildAuthorizationDirective()` 产出 ——
  // 否则「同样一张卡，preset 通了和 preset 没通，执行方读到的任务书不一样」。
  const { store, calls, execute } = setup({ presetApplied: false, sendOk: true });
  await execute();
  const presetText = calls.created[0]?.opts?.preset ?? "";
  const resentText = calls.sent[0]?.text ?? "";
  assert.ok(presetText.length > 0, "建会话时必须带上 preset（这是既有一等行为）");
  assert.equal(resentText, presetText, "补投正文必须与 preset 逐字相同");
  store.close();
});
