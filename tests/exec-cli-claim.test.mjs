/**
 * FR-52 / FR-60 保真：`/exec-cli` **执行前认领**的口径（`claimForCliExecution`）。
 *
 * 背景（2026-10-18 真机实测）：`taskboard-workbench-73` 交给 CLI 执行器后跑了 14 分钟，
 * 看板上却一直停在「待办池」——因为此前只有 `todo` 会真的进「进行中」，其它状态只开了一条
 * 尝试记录、状态原地不动。而卡片 UI 明确承诺「执行前会先认领该任务（todo → 进行中）」。
 *
 * 口径：人在卡片上显式点「交给 CLI 执行器执行」**即为授权**（不收紧执行权限），
 * 但状态必须如实——非 `in_progress` 一律先置「进行中」；终态仍由写回决定。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { claimForCliExecution } from "../src/core/executor.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R-CLI" });
  /** 建一条**已归因**的任务（走授权门需要归因）。 */
  const attributed = (title, extra = {}) => {
    const t = store.createTask({ projectId: "p1", title, ...extra });
    store.associateRequirementTask(item.id, t.id);
    return t;
  };
  const status = (t) => store.requireTaskRef(t.identifier).status;
  const runs = (t) => store.listTaskRuns(t.identifier).length;
  return { store, item, attributed, status, runs };
}

test("认领：待办池(backlog) 交给执行器 → 如实进「进行中」并开出尝试记录（不再停在待办池）", () => {
  const { store, attributed, status, runs } = setup();
  const t = attributed("backlog 卡", { status: "backlog" });
  const r = claimForCliExecution(store, t.identifier);
  assert.equal(r.fromStatus, "backlog");
  assert.equal(r.toStatus, "in_progress", "执行期必须如实显示在「进行中」");
  assert.equal(status(t), "in_progress");
  assert.equal(r.runStarted, true);
  assert.equal(runs(t), 1);
  assert.match(r.note, /direct-handoff:backlog->in_progress/);
  store.close();
});

test("认领：todo 走授权门（归因 + 认领锁），同样落到「进行中」", () => {
  const { store, attributed, status, runs } = setup();
  const t = attributed("可开工卡", { status: "todo" });
  const r = claimForCliExecution(store, t.identifier);
  assert.equal(r.note, "authorized");
  assert.equal(status(t), "in_progress");
  assert.equal(runs(t), 1, "认领即开尝试（FR-82）");
  assert.ok(store.taskClaimState(t.identifier).locked, "todo 路径必须带认领锁");
  store.close();
});

test("认领：待验收(in_review) 卡被重跑 → 同样先回到「进行中」", () => {
  const { store, attributed, status, runs } = setup();
  const t = attributed("待验收卡", { status: "in_review" });
  const r = claimForCliExecution(store, t.identifier);
  assert.equal(r.fromStatus, "in_review");
  assert.equal(status(t), "in_progress");
  assert.equal(runs(t), 1);
  store.close();
});

test("认领：已完成(done) 卡被重跑 → 卡片被移出「完成」列（跑完由写回决定终态）", () => {
  const { store, attributed, status } = setup();
  const t = attributed("已完成卡", { status: "done" });
  assert.equal(status(t), "done");
  const r = claimForCliExecution(store, t.identifier);
  assert.equal(r.fromStatus, "done");
  assert.equal(status(t), "in_progress", "重跑必须让看板如实显示「进行中」，不能停在「完成」");
  store.close();
});

test("认领：已在「进行中」→ 不重复开尝试，如实标注 already-in-progress", () => {
  const { store, attributed, runs } = setup();
  const t = attributed("已进行中卡", { status: "todo" });
  const first = claimForCliExecution(store, t.identifier);
  assert.equal(runs(t), 1, "todo 路径由认领（claimTask）开出尝试，runStarted 记 false 属正常");
  assert.equal(first.runStarted, false, "runStarted 只表示「本次调用亲手开出尝试」");
  assert.equal(first.note, "authorized");
  const again = claimForCliExecution(store, t.identifier);
  assert.equal(again.note, "already-in-progress");
  assert.equal(again.runStarted, false);
  assert.equal(runs(t), 1, "不得重复开尝试");
  store.close();
});

test("认领：未归因的 todo 卡 → 授权门拦住，状态不动且不开尝试", () => {
  const { store, status, runs } = setup();
  const t = store.createTask({ projectId: "p1", title: "未归因卡", status: "todo" });
  const r = claimForCliExecution(store, t.identifier);
  assert.match(r.note, /claim-failed/, "必须如实记下认领失败，不得假装成功");
  assert.equal(status(t), "todo", "授权门（归因门）不得被 CLI 执行器绕过");
  assert.equal(runs(t), 0);
  store.close();
});

test("认领：人工校验任务（FR-85b 升级门）→ 无论什么状态都不许被推进", () => {
  const { store, status } = setup();
  const t = store.createTask({ projectId: "p1", title: "人工校验卡", status: "todo", labels: ["human_review"] });
  const r = claimForCliExecution(store, t.identifier);
  assert.match(r.note, /claim-failed/);
  assert.equal(status(t), "todo", "升级门不得被 CLI 执行器推开：只能走人工结论入口");
  store.close();
});
