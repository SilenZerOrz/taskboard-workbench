/**
 * FR-111（卡 `-195`）：**转入待验收即视为已发起评审**。
 *
 * 背景：`requestReview` 会写 `review_requested_at`，但「看板点下一列」(PATCH) / 团队回流 /
 * 执行侧置待验收 这三条路径只改 `status` ⇒ `-193` 快照实测 16 张 `in_review` 里 **10 张**该字段为空
 * （即「卡进了待验收列，却没有任何人被请求评审」），中位滞留 148.4h。
 *
 * 钉三件事：三路径都补 · 幂等（不覆盖首次值）· **评审门语义不变**。
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "评审发起项目" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目" });
  const task = store.createTask({ projectId: "p1", title: "受测卡", status: "in_progress", requirementId: item.id });
  return { store, item, task };
}

/* --------------------------------------------------------------- 路径 A ---- */
test("A updateTask（看板「下一列」）：进待验收即补 review_requested_at", () => {
  const { store, task } = setup();
  assert.equal(store.getTaskRef(task.identifier).reviewRequestedAt, null, "前置：初始为空");

  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "in_review", actor: "human" });

  const after = store.getTaskRef(task.identifier);
  assert.equal(after.status, "in_review");
  assert.ok(after.reviewRequestedAt, "必须补上评审发起时间");
  assert.match(after.reviewRequestedAt, /^\d{4}-\d{2}-\d{2}T/, "应是 ISO 时间");
  store.close();
});

/* --------------------------------------------------------------- 路径 B ---- */
test("B HTTP PATCH /api/tasks/:ref：同样补（前端拖列 / 抽屉都走这条）", async () => {
  const { store, task } = setup();
  const router = createApiRouter({ store });
  const cur = store.getTaskRef(task.identifier);
  await router.route({ method: "PATCH", pathname: `/api/tasks/${task.identifier}`, searchParams: new URLSearchParams(), body: { version: cur.version, status: "in_review" } });
  assert.ok(store.getTaskRef(task.identifier).reviewRequestedAt, "HTTP 路径也必须补");
  store.close();
});

/* --------------------------------------------------------------- 路径 C ---- */
test("C teamSetTaskStatus（执行侧 / 团队通道）：同样补", () => {
  const { store, task } = setup();
  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });
  const after = store.getTaskRef(task.identifier);
  assert.equal(after.status, "in_review");
  assert.ok(after.reviewRequestedAt);
  store.close();
});

/* --------------------------------------------------------------- 路径 D ---- */
test("D applyTeamTaskOutcome completed（团队回流）：同样补", () => {
  const { store, task } = setup();
  const run = store.createTeamRun({ targetTask: task.id });
  const tt = store.acquireTeamTask({ teamId: run.id, task: task.id, kind: "work" });
  store.applyTeamTaskOutcome(tt.id, { outcome: "completed" });
  const after = store.getTaskRef(task.identifier);
  assert.equal(after.status, "in_review");
  assert.ok(after.reviewRequestedAt);
  store.close();
});

/* ------------------------------------------------------------ 幂等 ---- */
test("E 幂等：已有的评审发起时间不被覆盖（首次值才是度量口径）", () => {
  const { store, task } = setup();
  const first = store.requestReview(task.identifier, { actor: "agent", now: "2026-11-01T00:00:00.000Z" }).task;
  assert.equal(first.reviewRequestedAt, "2026-11-01T00:00:00.000Z");

  // 退回实现列（不清 review_requested_at，只有 requestChanges 会清），再进一次待验收
  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "in_progress", actor: "human" });
  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "in_review", actor: "human" });

  assert.equal(store.getTaskRef(task.identifier).reviewRequestedAt, "2026-11-01T00:00:00.000Z", "不得覆盖首次值");
  store.close();
});

/* -------------------------------------------------------- 反向对照 ---- */
test("F 反向对照：进「进行中 / 待执行」不写该字段", () => {
  const { store, task } = setup();
  store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "todo", actor: "human" });
  assert.equal(store.getTaskRef(task.identifier).reviewRequestedAt, null, "非待验收不得写");
  store.teamSetTaskStatus(task.identifier, { status: "in_progress", actor: "agent" });
  assert.equal(store.getTaskRef(task.identifier).reviewRequestedAt, null);
  store.close();
});

/* -------------------------------------------------- 评审门语义不变 ---- */
test("G 评审门语义不变：补了评审发起时间 ≠ 评审已通过（done 仍被拒，除非显式 skipReview）", () => {
  const { store, task } = setup();
  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "agent" });
  const cur = store.getTaskRef(task.identifier);
  assert.ok(cur.reviewRequestedAt);
  assert.notEqual(cur.reviewState, "approved", "不得因为补了时间就变成已通过");

  assert.throws(
    () => store.updateTask(task.identifier, { expectedVersion: cur.version, status: "done", actor: "human" }),
    (e) => e.code === "REVIEW_NOT_APPROVED",
    "评审未通过仍不得置 done",
  );
  const ok = store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "done", actor: "human", skipReview: true });
  assert.equal(ok.status, "done", "显式 skipReview 仍是逃生口");
  store.close();
});
