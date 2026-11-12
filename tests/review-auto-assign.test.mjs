/**
 * 卡 `-244` / 需求 `R178`：`requestReview` 缺省自动指派评审者。
 *
 * 守的是「必然产生的评审死锁」：`requestReview` 不传 reviewer 时原来一律留空，
 * 而 `detectReviewDeadlock` 对「reviewer 为空且超阈值」必然判 `unassigned` ——
 * 也就是说「待验收」只要没人手填评审者，就注定变成高危诊断（真机 8 卡全空）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { detectReviewDeadlock } from "../src/core/review.mjs";

function setup(withRoles) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  if (withRoles) {
    store.saveProjectSettings("p1", { teamTemplate: { roles: [{ role: "lead" }, { role: "engineer" }, { role: "reviewer" }] } });
  }
  const t = store.createTask({ projectId: "p1", title: "实现", status: "in_progress" });
  return { store, t };
}

test("模板含 review 角色 ⇒ 不传 reviewer 也自动指派，且不再产生 unassigned 死锁", () => {
  const { store, t } = setup(true);
  const r = store.requestReview(t.identifier);
  assert.equal(r.task.reviewer, "reviewer", "缺省指派到模板里的 review 角色");
  const dead = detectReviewDeadlock(store, store.getTaskRef(t.identifier), { idleMs: 0 });
  assert.equal(dead, null, "已指派评审者 ⇒ 即便阈值归零也不该判死锁");
  const ev = store.listTaskEvents(t.identifier, { order: "asc" }).find((e) => e.type === "review_requested");
  assert.match(String(ev?.detail ?? ""), /指派评审者 reviewer/);
  store.close();
});

test("模板没配 ⇒ 旧行为一字不变（reviewer 仍为空，阈值后仍判 unassigned）", () => {
  const { store, t } = setup(false);
  store.requestReview(t.identifier);
  const task = store.getTaskRef(t.identifier);
  assert.equal(task.reviewer, null, "没有 review 角色就不许凭空指派");
  const dead = detectReviewDeadlock(store, task, { idleMs: 0 });
  assert.equal(dead?.kind, "unassigned");
  store.close();
});

test("显式传 reviewer 时以显式值为准（不被模板覆盖）", () => {
  const { store, t } = setup(true);
  store.requestReview(t.identifier, { reviewer: "zhang" });
  assert.equal(store.getTaskRef(t.identifier).reviewer, "zhang");
  store.close();
});

test("roles 写成对象形态也能认出 review 角色", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p2", name: "P2" });
  store.saveProjectSettings("p2", { teamTemplate: { roles: { Lead: { count: 1 }, Reviewer: { count: 1 } } } });
  const t = store.createTask({ projectId: "p2", title: "实现", status: "in_progress" });
  store.requestReview(t.identifier);
  assert.equal(store.getTaskRef(t.identifier).reviewer, "reviewer");
  store.close();
});
