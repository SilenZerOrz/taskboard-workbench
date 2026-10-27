/** 切片2：FR-40 启动执行 / FR-41 跟踪与失败（R-WS-58…63）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const task = store.createTask({ projectId: "demo", title: "实现", status: "todo" });
  store.associateRequirementTask(item.id, task.id);
  return { store, item, task };
}

test("R-WS-58 已授权且已归因 → 启动执行 → 进行中（带指令）", () => {
  const { store, task } = setup();
  const r = store.startTaskExecution(task.id, { sessionId: "sess-1" });
  assert.equal(r.task.status, "in_progress");
  assert.equal(r.task.sessionId, "sess-1");
  assert.equal(r.launch.mode, "session");
  assert.ok(r.launch.directive.includes(task.identifier));
  store.close();
});

test("R-WS-59 未授权（backlog）→ 拒绝启动", () => {
  const { store, item } = setup();
  const backlog = store.createTask({ projectId: "demo", title: "未授权" }); // 默认 backlog
  store.associateRequirementTask(item.id, backlog.id);
  assert.throws(() => store.startTaskExecution(backlog.id), (e) => e.code === "EXECUTION_NOT_AUTHORIZED");
  store.close();
});

test("R-WS-60 未归因 → 拦截并引导归因", () => {
  const { store } = setup();
  const orphan = store.createTask({ projectId: "demo", title: "游离任务", status: "todo" });
  assert.throws(() => store.startTaskExecution(orphan.id), (e) => e.code === "EXECUTION_NOT_ATTRIBUTED");
  store.close();
});

test("R-WS-61 无法建立上下文 → 降级为可复制指令", () => {
  const { store, task } = setup();
  const r = store.startTaskExecution(task.id); // 无 sessionId → 降级
  assert.equal(r.launch.mode, "degraded");
  assert.equal(r.task.sessionId, null);
  assert.ok(r.launch.directive.length > 0);
  store.close();
});

test("R-WS-62 进度可见：状态可查 + SSE 失效信号发布", () => {
  const { store, task } = setup();
  const hub = createEventHub();
  const chunks = [];
  const unsubscribe = hub.subscribe({ writeHead() {}, write(c) { chunks.push(c); }, on() {} });
  const router = createApiRouter({ store, events: hub });
  return router.route({ method: "POST", pathname: `/api/tasks/${task.identifier}/execute`, searchParams: new URLSearchParams(), body: { sessionId: "s1" } })
    .then((res) => {
      assert.equal(res.payload.task.status, "in_progress");
      assert.equal(store.getTaskExecution(task.identifier).status, "in_progress");
      assert.ok(chunks.join("").includes("event: task.updated"));
      unsubscribe();
      store.close();
    });
});

test("R-WS-63 失败→受阻+证据；重试→可开工；释放归属→解除绑定", () => {
  const { store, task } = setup();
  store.startTaskExecution(task.id, { sessionId: "s1" });
  const failed = store.recordTaskExecutionFailure(task.id, { evidence: "网络超时" });
  assert.equal(failed.status, "blocked");
  assert.ok(store.listComments(task.id).some((c) => c.body.includes("网络超时")));
  const retried = store.retryTaskExecution(task.id);
  assert.equal(retried.status, "todo");
  // 2026-10-16：重试**保留**执行会话标识（派发前据此判断"原会话是否仍在执行"→ 防重复下发）；
  // 显式解绑用"释放归属"（releaseTaskAssignment）。R-WS-63 只要求"有重试与释放入口"，未约束重试清空归属。
  assert.equal(retried.sessionId, "s1");
  store.startTaskExecution(task.id, { sessionId: "s2" });
  const released = store.releaseTaskAssignment(task.id);
  assert.equal(released.sessionId, null);
  store.close();
});
