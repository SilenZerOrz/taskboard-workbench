/**
 * FR-112（卡 `-194`）：**状态事件完整性**。
 *
 * 背景：全仓原本只有 3 处 `emit status_changed`（`updateTask` / `requestReview` / 评审收口）。
 * `teamSetTaskStatus` 与 `applyTeamTaskOutcome` 直接写 `tasks.status` 不发事件 ⇒ 实测
 * 175 次完成类状态变更里 46 次（26%）**没有事件**；而诊断 / 看护 / 通知 / M1 度量
 * 全部建在事件流上 —— 漏 26% 等于度量基础不可信。
 *
 * 本文件只做**接线级**证明（四条真实调用路径各一条），外加两条反向对照：
 *   - 同状态重复写**不产生假事件**（否则事件流会被"擦写"污染）
 *   - 红线被拒时**不落事件**（拒绝不该看起来像发生了一次变更）
 */
import test from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "状态事件项目" });
  const item = store.createRequirementItem({ projectId: "p1", title: "状态事件条目" });
  const task = store.createTask({ projectId: "p1", title: "受测卡", status: "todo", requirementId: item.id });
  return { store, item, task };
}

const statusEvents = (store, ref) => store.listTaskEvents(ref).filter((e) => e.type === "status_changed");

/* --------------------------------------------------------------- 路径 A ---- */
test("A store.teamSetTaskStatus：状态变化落 status_changed（from/to/actor 正确）", () => {
  const { store, task } = setup();
  const before = statusEvents(store, task.identifier).length;

  store.teamSetTaskStatus(task.identifier, { status: "in_progress", actor: "agent" });

  const events = statusEvents(store, task.identifier);
  assert.equal(events.length, before + 1, "应新增 1 条 status_changed");
  const last = events.at(-1);
  assert.equal(last.from, "todo");
  assert.equal(last.to, "in_progress");
  assert.equal(last.actor, "agent");
  store.close();
});

/* --------------------------------------------------------------- 路径 B ---- */
test("B HTTP POST /api/tasks/:ref/team-status：同样落事件（团队通道不再静默）", async () => {
  const { store, task } = setup();
  const router = createApiRouter({ store });
  const before = statusEvents(store, task.identifier).length;

  const r = await router.route({ method: "POST", pathname: `/api/tasks/${task.identifier}/team-status`, searchParams: new URLSearchParams(), body: { status: "in_progress", actor: "team" } });
  assert.equal((r.payload ?? r.body ?? r).task.status, "in_progress");

  const events = statusEvents(store, task.identifier);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).to, "in_progress");
  assert.equal(events.at(-1).actor, "team");
  store.close();
});

/* --------------------------------------------------------------- 路径 C ---- */
test("C 执行侧工具 taskboard_update_status：同样落事件（MCP / 插件面同源）", async () => {
  const { store, task } = setup();
  const defs = new Map();
  registerTaskboardTools({ store, tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  store.startTaskExecution(task.identifier, { sessionId: "s1" });
  const before = statusEvents(store, task.identifier).length;

  // in_progress 以外走 teamSetTaskStatus：用 canceled（TEAM_WRITABLE_STATUSES 内，且不触发评审门）
  const r = await defs.get("taskboard_update_status").execute({ ref: task.identifier, status: "canceled" }, { agent: { id: "s1" } });
  assert.equal(r.status, "canceled");

  const events = statusEvents(store, task.identifier);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1).to, "canceled");
  store.close();
});

/* --------------------------------------------------------------- 路径 D ---- */
test("D applyTeamTaskOutcome：completed→in_review、failed→blocked 各落 1 条事件", () => {
  const { store, item } = setup();

  const a = store.createTask({ projectId: "p1", title: "团队完成", status: "in_progress", requirementId: item.id });
  const runA = store.createTeamRun({ targetTask: a.id });
  const ttA = store.acquireTeamTask({ teamId: runA.id, task: a.id, kind: "work" });
  const beforeA = statusEvents(store, a.identifier).length;
  store.applyTeamTaskOutcome(ttA.id, { outcome: "completed" });
  const evA = statusEvents(store, a.identifier);
  assert.equal(evA.length, beforeA + 1, "completed 应落 1 条");
  assert.equal(evA.at(-1).to, "in_review");
  assert.equal(evA.at(-1).from, "in_progress");

  const b = store.createTask({ projectId: "p1", title: "团队失败", status: "in_progress", requirementId: item.id });
  const runB = store.createTeamRun({ targetTask: b.id });
  const ttB = store.acquireTeamTask({ teamId: runB.id, task: b.id, kind: "work" });
  const beforeB = statusEvents(store, b.identifier).length;
  store.applyTeamTaskOutcome(ttB.id, { outcome: "failed", evidence: "编译失败" });
  const evB = statusEvents(store, b.identifier);
  assert.equal(evB.length, beforeB + 1, "failed 应落 1 条");
  assert.equal(evB.at(-1).to, "blocked");
  store.close();
});

/* ---------------------------------------------------------- 反向对照 ---- */
test("E 反向对照：同状态重复写不产生假事件；红线被拒不落事件", () => {
  const { store, task } = setup();
  store.teamSetTaskStatus(task.identifier, { status: "in_progress", actor: "agent" });
  const after1 = statusEvents(store, task.identifier).length;

  // 再写一次同状态：版本仍 +1（既有语义），但**不多一条事件**
  store.teamSetTaskStatus(task.identifier, { status: "in_progress", actor: "agent" });
  assert.equal(statusEvents(store, task.identifier).length, after1, "同状态重复写不该产生第二条 status_changed");

  // done 红线被拒：不许看起来像发生了一次变更
  assert.throws(() => store.teamSetTaskStatus(task.identifier, { status: "done", actor: "agent" }), (e) => e.code === "GOVERNANCE_AGENT_DONE");
  assert.equal(statusEvents(store, task.identifier).length, after1, "被拒的写不落 status_changed");
  store.close();
});

test("F 源码守卫：两个团队写入口都带 FR-112 注释（防止将来加写点又忘了发事件）", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../src/core/store.mjs", import.meta.url), "utf8");
  const count = (src.match(/FR-112/g) ?? []).length;
  assert.ok(count >= 3, `store.mjs 里 FR-112 标记应 ≥3 处（teamSetTaskStatus + completed + failed），实际 ${count}`);
});
