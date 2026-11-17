/**
 * 卡 `-269`（需求 `R185`）：**进「待验收」就当场闭合在途尝试 —— 所有入口都要，不只一条**。
 *
 * 本卡与已 `done` 的 `-260` 同题，但 `-260` 只把收口做在**看板 PATCH**（`updateTask`）上；
 * 「提交待验收」还有一条正式入口 —— `teamSetTaskStatus`，它被三处共用：
 *   · 宿主工具 `taskboard_update_status`（`-262` 之后**非** `blocked` 的走法之一）
 *   · MCP 工具（`src/mcp/tools.mjs`，执行侧 agent 提交待验收的正式通道）
 *   · `POST /api/tasks/:ref/team-status`（团队通道）
 * 它**直接写 `tasks.status` 列**，不经过 `updateTask` ⇒ 卡片已「待验收」而 `task_runs` 仍 `running`。
 *
 * 实测（本卡开发时，同一 in-memory 库两条路径正反对照）：修前 `updateTask` 得 `ended/success`、
 * `teamSetTaskStatus` 得 `running/null` —— 真机 `-248` 那 3 分 55 秒「待验收 vs 进行中」并存，
 * 在这条路上**依然存在**。
 *
 * 口径红线与 `-260` 一致：摘要沿用 `-259`（最近证据 verdict / 否则「执行方未回写摘要」）；
 * **无在途尝试不报错、不凭空造一条**；同状态重复写（`in_review → in_review`）不重复收口。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openStore, RUN_SUMMARY_FALLBACK } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const make = (title) => {
    const t = store.createTask({ projectId: "p1", title, status: "todo" });
    store.associateRequirementTask(item.id, t.id);
    return t;
  };
  return { store, make };
}

function lastRun(store, ref) {
  const runs = store.listTaskRuns(ref.identifier ?? ref);
  return runs[runs.length - 1];
}

/** 模拟一次真实执行：认领 → 进行中 → 尝试在途（running）。 */
function startInflight(store, task, { sessionId = "s1" } = {}) {
  store.claimTask(task.identifier, { sessionId, sourceStatus: "todo" });
  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "in_progress", actor: "agent" });
  const run = lastRun(store, task);
  assert.equal(run.status, "running", "前置：认领后尝试确实在途");
  return run;
}

test("A 执行侧 / MCP 入口（teamSetTaskStatus）进待验收 ⇒ 当场闭尝试（本卡修的那条）", () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);

  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

  const after = lastRun(store, task);
  assert.equal(store.getTaskRef(task.identifier).status, "in_review");
  assert.equal(after.status, "ended", "进待验收后不得再有在途尝试");
  assert.equal(after.outcome, "success");
  assert.ok(after.endedAt, "必须写 ended_at");
  assert.equal(store.getCurrentRun(task.identifier), null, "任务指针必须清空");
});

test("B 看板 PATCH 入口（updateTask）不回归：仍然当场闭尝试（-260 的口径）", () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);

  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "in_review", actor: "human" });

  const after = lastRun(store, task);
  assert.equal(after.status, "ended");
  assert.equal(after.outcome, "success");
});

test("C 两条入口的摘要口径一致：取最近一条结构化证据的 verdict", () => {
  for (const route of ["updateTask", "teamSetTaskStatus"]) {
    const { store, make } = setup();
    const task = make(`T-${route}`);
    startInflight(store, task);
    store.addTaskEvidence(task.identifier, {
      verdict: "判定：完成，已提交待验收", deviation: "无", boundary: "未碰 :3080", artifacts: ["a.mjs"], actor: "codex",
    });
    const before = store.getTaskRef(task.identifier).version;
    if (route === "updateTask") store.updateTask(task.identifier, { expectedVersion: before, status: "in_review", actor: "human" });
    else store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

    assert.equal(lastRun(store, task).summary, "判定：完成，已提交待验收", `${route}：摘要必须是执行方结论`);
  }
});

test("D 没有证据时如实写「执行方未回写摘要」，不拿记账文案冒充", () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);

  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

  const run = lastRun(store, task);
  assert.equal(run.summary, RUN_SUMMARY_FALLBACK);
  assert.ok(!/按成功完成记账|失败计数清零/.test(String(run.summary)), "不得写回旧记账文案");
});

test("E 本就没有在途尝试 ⇒ 不报错、不凭空造第二条尝试", () => {
  const { store, make } = setup();
  const task = make("T");
  const beforeRuns = store.listTaskRuns(task.identifier).length;

  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

  assert.equal(store.getTaskRef(task.identifier).status, "in_review");
  assert.equal(store.listTaskRuns(task.identifier).length, beforeRuns, "不得凭空造出尝试记录");
});

test("F 同状态重复写（in_review → in_review）不重复收口、不产生第二条 run_ended", () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);
  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });
  const endedEvents = () => store.listTaskEvents(task.identifier).filter((e) => e.type === "run_ended").length;
  const before = endedEvents();

  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

  assert.equal(endedEvents(), before, "同态迁移不该再收口一次（无在途尝试时不写 run_ended）");
  assert.equal(lastRun(store, task).status, "ended");
});

test("H HTTP POST /api/tasks/:ref/team-status 走真路由同样收口（不止 store 层）", async () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);
  const router = createApiRouter({ store });

  const r = await router.route({
    method: "POST",
    pathname: `/api/tasks/${task.identifier}/team-status`,
    searchParams: new URLSearchParams(),
    body: { status: "in_review", actor: "team" },
  });
  const payload = r.payload ?? r.body ?? r;
  assert.equal(payload.task.status, "in_review", "路由必须真的把状态写进去");
  assert.notEqual(lastRun(store, task).status, "running", "经路由提交待验收后不得再有在途尝试");
  assert.equal(lastRun(store, task).outcome, "success");
});

test("G 反向对照：只看「状态已写」不足以发现缺陷 —— 必须同时读尝试记录", () => {
  const { store, make } = setup();
  const task = make("T");
  startInflight(store, task);
  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });

  // 这正是真机 `-248` 的读数形状：卡片状态对、尝试记录对不上。
  // 断言「两者一致」才算过 —— 只断言 status 会让本卡的缺陷真空通过。
  const status = store.getTaskRef(task.identifier).status;
  const runStatus = lastRun(store, task).status;
  assert.equal(status, "in_review");
  assert.notEqual(runStatus, "running", "卡片已待验收时，尝试不得仍显示进行中");
});
