/**
 * 卡 `-264` / 需求 `R188`：**派发目标选取**（优先复用已绑定本项目的空闲会话；没有才新建 + 首次授权）。
 *
 * 用户原话（2026-11-13）：默认指派 dsh 或其他 agent 授权执行任务卡片时，应该**优先选取已绑定项目的空闲会话**
 * 接手新卡；**没有绑定会话时，要求第一次授权**，或在卡片点「执行」时**把授权指令一并带进去**。
 *
 * 本文件守四件事：
 *   ① `isIdleLiveness` 的**保守口径** —— 判不准一律不算空闲（不猜、不臆断）；
 *   ② `listBoundCandidates` 的**顺序与去重** —— 主会话 > 已批准关联(updated desc) > 派生执行会话，同会话只一行；
 *   ③ `pickDispatchTarget` 的**三条路径** —— 复用 / 全忙或判不准 ⇒ 新建授权 / 跨工作区被排除；
 *   ④ 两份指令正文的**硬边界** —— 必须写明「不需要再申请关联」与「不得置完成」。
 *
 * 全部是纯函数 + 注入探活，不碰宿主、不写库（除建种子项目/卡那几行）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import {
  isIdleLiveness, listBoundCandidates, pickDispatchTarget,
  buildReuseDirective, buildAuthorizationDirective, reusedFromKind,
} from "../src/core/dispatch-target.mjs";

// ---------- ① isIdleLiveness ----------

test("isIdleLiveness：六种输入 —— 只有「在线 + 非运行 + 零待消费」才算空闲", () => {
  const cases = [
    { name: "空/非对象", input: null, want: false },
    { name: "存在性未知（exists=null, live=true）", input: { exists: null, live: true }, want: true },
    { name: "确认失效（exists=false）", input: { exists: false, live: true }, want: false },
    { name: "进程内无 Agent（live=false）⇒ 判不准", input: { exists: true, live: false }, want: false },
    { name: "正在运行（running=true）", input: { exists: true, live: true, running: true }, want: false },
    { name: "仍有未消费指令（pending=2）", input: { exists: true, live: true, pending: 2 }, want: false },
    { name: "完全空闲", input: { exists: true, live: true, running: false, pending: 0 }, want: true },
  ];
  for (const c of cases) assert.equal(isIdleLiveness(c.input), c.want, `${c.name}：期望 ${c.want}`);
});

test("isIdleLiveness：`live=true` 但 running/pending 缺省 ⇒ 视为空闲（宿主给了结论就别再要求它给全字段）", () => {
  assert.equal(isIdleLiveness({ live: true }), true);
});

// ---------- 种子 ----------

function seed({ projectId = "p1", workspacePath = "/repo/p1" } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: projectId, name: projectId, workspacePath });
  return store;
}

// ---------- ② listBoundCandidates ----------

test("listBoundCandidates：顺序 = 主会话 > 已批准关联(最近更新先) > 派生执行会话；同会话只出现一次", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  // 已批准关联两条（updated_at 由插入顺序决定，后写的更近）
  store.requestSessionAssociation("p1", "sess-appr-old");
  store.approveSessionAssociation("p1", "sess-appr-old");
  // updated_at 是毫秒级 ISO 串：同毫秒的两行排序只能靠插入顺序，这里显式拉开时间再断言「最近更新先」。
  await new Promise((r) => setTimeout(r, 8));
  store.requestSessionAssociation("p1", "sess-appr-new");
  store.approveSessionAssociation("p1", "sess-appr-new");
  // 派生执行会话：一张 in_progress 卡 + 一张已撤销的待批申请（不应作为候选）
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const task = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, task.id);
  store.startTaskExecution(task.identifier, { sessionId: "sess-exec" });
  // 让它处于「干完待验收」⇒ 该会话是可复用候选（in_progress 的那一档由下一条测试单独守）。
  store.updateTask(task.identifier, { status: "in_review", expectedVersion: store.requireTaskRef(task.identifier).version, actor: "human" });

  const list = listBoundCandidates(store, "p1");
  const ids = list.map((c) => c.sessionId);
  assert.deepEqual(ids, ["sess-main", "sess-appr-new", "sess-appr-old", "sess-exec"], `实际顺序：${ids.join(" > ")}`);
  assert.deepEqual(list.map((c) => c.role), ["main", "associated", "associated", "executor"]);
  // 卡 `-272`（`R188` 验收①点名的 `reusedFrom` 三档）：对外口径是 main / approved / executor，
  // 不是内部 role（`associated`）—— 两套名字并存会让回包与界面对不上。
  assert.deepEqual(list.map((c) => c.kind), ["main", "approved", "approved", "executor"]);
  assert.equal(new Set(ids).size, ids.length, "同一会话只能出现一次（高优先级那条胜出）");
  store.close();
});

test("listBoundCandidates：主会话同时也在已批准表里 ⇒ 只留 main 这一条（不重复列）", () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  store.requestSessionAssociation("p1", "sess-main");
  store.approveSessionAssociation("p1", "sess-main");
  const list = listBoundCandidates(store, "p1");
  assert.equal(list.length, 1);
  assert.equal(list[0].role, "main");
  assert.equal(list[0].sessionId, "sess-main");
  store.close();
});

test("listBoundCandidates：执行会话名下还有 in_progress 卡 ⇒ 不列入空闲候选（正干着别的活）", () => {
  const store = seed();
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t1 = store.createTask({ projectId: "p1", title: "T1", status: "todo" });
  store.associateRequirementTask(item.id, t1.id);
  store.startTaskExecution(t1.identifier, { sessionId: "sess-exec" });
  // 先把卡推到 in_progress（startTaskExecution 已置 in_progress）
  assert.equal(store.requireTaskRef(t1.identifier).status, "in_progress");
  const withBusy = listBoundCandidates(store, "p1");
  assert.ok(!withBusy.some((c) => c.sessionId === "sess-exec"), "正干着 in_progress 的会话不得进候选");

  // 干完提交待验收（in_review）⇒ 允许回来当「空闲候选」（它已经不再推进）
  store.updateTask(t1.identifier, { status: "in_review", expectedVersion: store.requireTaskRef(t1.identifier).version, actor: "human" });
  const after = listBoundCandidates(store, "p1");
  assert.ok(after.some((c) => c.sessionId === "sess-exec"), "in_review 的执行会话应可复用");
  store.close();
});

test("listBoundCandidates：只认 approved；pending 申请不算绑定", () => {
  const store = seed();
  store.requestSessionAssociation("p1", "sess-pending");
  const list = listBoundCandidates(store, "p1");
  assert.deepEqual(list, []);
  store.close();
});

// ---------- ③ pickDispatchTarget ----------

const fakeLiveness = (map) => async (sid) => map[sid] ?? { exists: null, live: false, running: false, pending: 0 };
const fakeOrigin = (map) => async (sid) => map[sid] ?? { sessionId: sid, cwd: "/repo/p1", mismatch: false };

test("pickDispatchTarget：主会话空闲 ⇒ reuse（选主会话，不选已批准）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  store.requestSessionAssociation("p1", "sess-appr");
  store.approveSessionAssociation("p1", "sess-appr");
  const r = await pickDispatchTarget(store, "p1", {
    sessionStateOf: fakeLiveness({ "sess-main": { exists: true, live: true, running: false, pending: 0 }, "sess-appr": { exists: true, live: true } }),
    sessionOriginOf: fakeOrigin({}),
  });
  assert.equal(r.decision, "reuse");
  assert.equal(r.target.sessionId, "sess-main");
  assert.equal(r.target.role, "main");
  assert.equal(r.target.kind, "main", "验收①的三档口径：主会话 ⇒ main");
  assert.equal(r.reason, "bound-idle");
  store.close();
});

test("pickDispatchTarget：主会话在跑 ⇒ 跳到已批准关联会话（顺序就是优先级）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  store.requestSessionAssociation("p1", "sess-appr");
  store.approveSessionAssociation("p1", "sess-appr");
  const r = await pickDispatchTarget(store, "p1", {
    sessionStateOf: fakeLiveness({
      "sess-main": { exists: true, live: true, running: true },
      "sess-appr": { exists: true, live: true, running: false, pending: 0 },
    }),
    sessionOriginOf: fakeOrigin({}),
  });
  assert.equal(r.decision, "reuse");
  assert.equal(r.target.sessionId, "sess-appr");
  const main = r.candidates.find((c) => c.sessionId === "sess-main");
  assert.equal(main.idle, false);
  assert.equal(main.why, "running", "必须如实说明没选它的原因");
  store.close();
});

test("pickDispatchTarget：全部在跑/判不准 ⇒ create-and-authorize（不猜空闲）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  const r = await pickDispatchTarget(store, "p1", {
    sessionStateOf: fakeLiveness({
      "sess-main": { exists: true, live: true, running: true },
      "sess-unknown": { exists: true, live: false },
    }),
    sessionOriginOf: fakeOrigin({}),
  });
  assert.equal(r.decision, "create-and-authorize");
  assert.equal(r.target, null);
  assert.equal(r.reason, "bound-but-busy-or-unknown");
  store.close();
});

test("pickDispatchTarget：本项目一条绑定会话都没有 ⇒ create-and-authorize + reason=no-bound-session", async () => {
  const store = seed();
  const r = await pickDispatchTarget(store, "p1", { sessionStateOf: fakeLiveness({}), sessionOriginOf: fakeOrigin({}) });
  assert.equal(r.decision, "create-and-authorize");
  assert.deepEqual(r.candidates, []);
  assert.equal(r.reason, "no-bound-session");
  store.close();
});

test("pickDispatchTarget：工作在别的工作区的会话 ⇒ 排除（不派给别人的工作区）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  const r = await pickDispatchTarget(store, "p1", {
    sessionStateOf: fakeLiveness({ "sess-main": { exists: true, live: true, running: false, pending: 0 } }),
    sessionOriginOf: fakeOrigin({ "sess-main": { sessionId: "sess-main", cwd: "/repo/OTHER", mismatch: true } }),
  });
  assert.equal(r.decision, "create-and-authorize");
  assert.equal(r.candidates[0].why, "other-workspace");
  store.close();
});

test("pickDispatchTarget：探活抛错 ⇒ 该候选不当空闲（异常不当作空）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  const r = await pickDispatchTarget(store, "p1", {
    sessionStateOf: async () => { throw new Error("host boom"); },
    sessionOriginOf: fakeOrigin({}),
  });
  assert.equal(r.decision, "create-and-authorize");
  assert.equal(r.candidates[0].why, "no-liveness");
  store.close();
});

test("pickDispatchTarget：未注入探活 ⇒ 一个都不选（宁可新建，也不派给不知道状态的会话）", async () => {
  const store = seed();
  store.bindInitialSession("p1", "sess-main");
  const r = await pickDispatchTarget(store, "p1", {});
  assert.equal(r.decision, "create-and-authorize");
  assert.equal(r.candidates[0].why, "no-liveness");
  store.close();
});

// ---------- ④ 指令正文 ----------

test("buildReuseDirective：写明已授权（不需要再申请关联）+ 回写四节 + 不得置完成", () => {
  const text = buildReuseDirective({
    task: { identifier: "p1-1", title: "做点事", acceptance: "A", verifyCommand: "npm test" },
    project: { id: "p1", name: "项目一" },
    target: { role: "main" },
  });
  assert.match(text, /p1-1/);
  assert.match(text, /项目一/);
  assert.match(text, /不需要再申请关联/);
  assert.match(text, /四节证据/);
  assert.match(text, /不得置「完成」/);
  assert.match(text, /验收：A/);
  assert.match(text, /复核动作：npm test/);
});

test("buildAuthorizationDirective：写明「首次授权」+ 不写死子任务明细也必须有「不得置完成」", () => {
  const text = buildAuthorizationDirective({ task: { identifier: "p1-2", title: "另一件" }, project: { id: "p1", name: "项目一" } });
  assert.match(text, /【授权】/);
  assert.match(text, /首次绑定/);
  assert.match(text, /p1-2/);
  assert.match(text, /不得置「完成」/);
  assert.match(text, /不得再申请/, "验收③点名的「不得再申请」必须写在任务书里");
});

test("buildAuthorizationDirective：新建会话的任务书与复用路径**同等信息**（验收 / 复核动作也要带）", () => {
  // 为什么守这条：新建出来的会话是「空手接单」—— 不告诉它验收标准与复核动作，
  // 它只能凭标题猜「做成什么样算做完」。复用路径早就带了（`buildReuseDirective`）。
  const text = buildAuthorizationDirective({
    task: { identifier: "p1-3", title: "带验收", acceptance: "A 条", verifyCommand: "npm test" },
    project: { id: "p1", name: "项目一" },
  });
  assert.match(text, /验收：A 条/);
  assert.match(text, /复核动作：npm test/);
});

test("reusedFromKind：内部 role → 验收口径三档（认不出来就是 null，不臆断）", () => {
  assert.equal(reusedFromKind("main"), "main");
  assert.equal(reusedFromKind("associated"), "approved");
  assert.equal(reusedFromKind("executor"), "executor");
  assert.equal(reusedFromKind("unknown-role"), null);
  assert.equal(reusedFromKind(undefined), null);
});
