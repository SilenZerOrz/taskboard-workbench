/** P8·S1：任务下发 + 状态更新最小闭环（FR-49）——状态回流经 SSE 失效信号。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "s1", name: "S1" });
  const item = store.createRequirementItem({ projectId: "s1", title: "S1 需求" });
  const attr = (title, status = "todo") => {
    const t = store.createTask({ projectId: "s1", title, status });
    store.associateRequirementTask(item.id, t.id);
    return t;
  };
  return { store, item, attr };
}

function captureEvents() {
  const events = createEventHub();
  const frames = [];
  const res = { writeHead() { return this; }, write(chunk) { frames.push(String(chunk)); return true; }, on() {} };
  const close = events.subscribe(res);
  return { events, frames, close };
}

test("S1 下发闭环：/execute → 进行中；状态变化经 SSE 回流", async () => {
  const { store, attr } = setup();
  const { events, frames, close } = captureEvents();
  const router = createApiRouter({ store, events });
  const route = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  const t = attr("下发目标任务", "todo");

  const res = await route("POST", `/api/tasks/${t.identifier}/execute`, {});
  assert.equal(res.status, 200);
  assert.equal(res.payload.task.status, "in_progress");
  assert.equal(res.payload.launch.mode, "degraded"); // 无宿主会话端口 → 降级可见
  assert.ok(frames.some((f) => f.includes("event: task.updated")), "下发应发布 task.updated");

  // 状态更新：提交待验收 → in_review
  const before = frames.length;
  const review = await route("POST", `/api/tasks/${t.identifier}/execution/review`, { comment: "完成" });
  assert.equal(review.status, 200);
  assert.equal(review.payload.task.status, "in_review");
  assert.ok(frames.length > before, "状态变化应发布失效信号");

  // 仅人工可置 done：执行侧写 done 被拒
  assert.throws(() => store.teamSetTaskStatus(t.identifier, { status: "done" }), (e) => e.code === "GOVERNANCE_AGENT_DONE");
  close();
  store.close();
});

test("S1 失败路径：进行中 → 标记失败 → 受阻 + 证据；可重试", async () => {
  const { store, attr } = setup();
  const { events, frames, close } = captureEvents();
  const router = createApiRouter({ store, events });
  const route = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  const t = attr("失败目标任务", "todo");

  await route("POST", `/api/tasks/${t.identifier}/execute`, {});
  const fail = await route("POST", `/api/tasks/${t.identifier}/execution/fail`, { evidence: "编译失败：x.ts:12" });
  assert.equal(fail.status, 200);
  assert.equal(fail.payload.task.status, "blocked");
  const exec = await route("GET", `/api/tasks/${t.identifier}/execution`, {});
  assert.equal(exec.payload.status, "blocked");
  assert.ok(frames.some((f) => f.includes("event: task.updated")), "失败应发布失效信号");

  const retry = await route("POST", `/api/tasks/${t.identifier}/execution/retry`, {});
  assert.equal(retry.status, 200);
  assert.equal(retry.payload.task.status, "todo");
  close();
  store.close();
});

test("S1 归因门：未归因任务不得下发", async () => {
  const { store } = setup();
  const { events, close } = captureEvents();
  const router = createApiRouter({ store, events });
  const router2 = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  const orphan = store.createTask({ projectId: "s1", title: "游离", status: "todo" });
  await assert.rejects(() => router2("POST", `/api/tasks/${orphan.identifier}/execute`, {}), (e) => e.code === "EXECUTION_NOT_ATTRIBUTED");
  close();
  store.close();
});
