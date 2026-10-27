/**
 * 门与副作用的**顺序**（真机 2026-10-22 续四十一）。
 *
 * 现象：在「可开工」列上点「启动执行」，被归因门 / 授权门拒掉 —— 但服务端**先**建了宿主会话
 * 并把它打开（主视图被切走），**之后**才判门 ⇒ 用户看到"报错 + 视图莫名被切"，库里还多一个空会话。
 * 同一类顺序问题在「派发团队」上也成立：先在 `acquireTeamTask` 里判 backlog，而 `createTeamRun`
 * 已经写库 ⇒ 被拒的派发留下**空团队 run**（团队视图可见的孤儿）。
 *
 * 这组用例钉死口径：**门判定必须先于副作用**；被拒的请求不得新建会话、不得留下 run。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

const sp = () => new URLSearchParams();

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const calls = { created: 0, opened: [] };
  store.hostSessionPort = {
    available: true,
    async createSession() { calls.created += 1; return { sessionId: `session-new-${calls.created}`, presetApplied: true }; },
    async openSession(id) { calls.opened.push(id); return { opened: true }; },
    async sessionState(sessionId) { return { sessionId, live: false, running: false, status: null, pending: 0 }; },
  };
  return { store, item, calls, router: createApiRouter({ store, events: createEventHub() }) };
}

const mk = (store, item, title, status = "todo") => {
  const t = store.createTask({ projectId: "demo", title, status });
  store.associateRequirementTask(item.id, t.id);
  return t;
};
const execute = (router, task) => router.route({ method: "POST", pathname: `/api/tasks/${task.identifier}/execute`, searchParams: sp(), body: {} });

test("执行：未归因的「可开工」卡被拒 —— 不建会话、不打开会话、状态不动", async () => {
  const { store, calls, router } = fresh();
  const orphan = store.createTask({ projectId: "demo", title: "游离", status: "todo" });
  await assert.rejects(() => execute(router, orphan), (e) => e.code === "EXECUTION_NOT_ATTRIBUTED");
  assert.equal(calls.created, 0, "被拒的执行不得新建宿主会话（原先会先建会话再拒绝）");
  assert.deepEqual(calls.opened, [], "也不得打开会话（那会把用户主视图切走）");
  assert.equal(store.getTaskById(orphan.id).status, "todo");
  store.close();
});

test("执行：backlog（未授权）卡被拒 —— 同样不建会话", async () => {
  const { store, item, calls, router } = fresh();
  const backlog = mk(store, item, "未授权", "backlog");
  await assert.rejects(() => execute(router, backlog), (e) => e.code === "EXECUTION_NOT_AUTHORIZED");
  assert.equal(calls.created, 0);
  assert.deepEqual(calls.opened, []);
  assert.equal(store.getTaskById(backlog.id).status, "backlog");
  store.close();
});

test("执行：人工校验卡被拒 —— 报的是升级门（不是归因门），且不建会话", async () => {
  const { store, item, calls, router } = fresh();
  const human = mk(store, item, "【人工校验】与上游不符", "todo");
  // 人工校验任务的判据是 labels 含 human_review（见 src/core/human-review.mjs#isHumanReviewTask）；
  // store 没有 setTaskLabels，标签走 updateTask 的 addLabels（须带 expectedVersion）。
  store.updateTask(human.identifier, { expectedVersion: store.getTaskById(human.id).version, addLabels: ["human_review"] });
  await assert.rejects(() => execute(router, human), (e) => e.code === "HUMAN_REVIEW_NOT_EXECUTABLE");
  assert.equal(calls.created, 0);
  store.close();
});

test("执行：对照 —— 正常路径仍建会话 + 打开 + 转进行中（预判不误伤）", async () => {
  const { store, item, calls, router } = fresh();
  const ok = mk(store, item, "正常卡");
  const r = await execute(router, ok);
  assert.equal(r.status, 200);
  assert.equal(calls.created, 1, "合法执行必须能建会话");
  assert.deepEqual(calls.opened, ["session-new-1"]);
  assert.equal(store.getTaskById(ok.id).status, "in_progress");
  store.close();
});

test("派发：成员里混进 backlog 卡被拒 —— 不留孤儿团队 run", async () => {
  const { store, item, router } = fresh();
  const target = mk(store, item, "目标卡");
  const backlog = mk(store, item, "未授权成员卡", "backlog");
  await assert.rejects(
    () => router.route({ method: "POST", pathname: "/api/teams", searchParams: sp(), body: { targetTask: target.identifier, tasks: [{ task: backlog.identifier }] } }),
    (e) => e.code === "EXECUTION_NOT_AUTHORIZED",
  );
  assert.equal(store.listTeamRuns({}).length, 0, "被拒的派发不得留下空团队 run（原先 createTeamRun 已先写库）");
  assert.equal(store.getTaskLock(target.identifier), null);
  store.close();
});

test("派发：对照 —— 合法成员仍能建 run 并落地任务级锁（预判不误伤）", async () => {
  const { store, item, router } = fresh();
  const target = mk(store, item, "目标卡");
  const member = mk(store, item, "成员卡");
  const r = await router.route({ method: "POST", pathname: "/api/teams", searchParams: sp(), body: { targetTask: target.identifier, members: ["engineer"], tasks: [{ task: member.identifier, member: "engineer" }] } });
  assert.equal(r.status, 201);
  assert.equal(store.listTeamRuns({}).length, 1);
  assert.ok(store.getTaskLock(member.identifier), "任务级执行锁应已落地");
  store.close();
});
