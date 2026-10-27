/**
 * FR-50 验收第三条：**模板非法（角色缺失 / 数量为 0 / 目标未归因）⇒ 拒绝建队**。
 *
 * 落点：纯函数 `assertTeamTemplate`（`src/core/team.mjs`）＋ 建队入口 `POST /api/teams`
 * （`src/server/api.mjs`）——**门判定先于一切副作用**（`createTeamRun` / 写成员 / 任务级锁）。
 *
 * 本组用例钉死三件事：
 *   ① 三条非法形态各自被拒，且 `details.reason` 指明**是哪一条**（不是笼统报错）；
 *   ② **被拒的请求零副作用**：库中不新增 team_run、不新增成员、不留任务级锁
 *      （真机 2026-10-22 的「孤儿空团队 run」事故口径，见 `tests/gate-before-side-effects.test.mjs`）；
 *   ③ 合法模板**不受影响**（预判不误伤，回归不破）。
 *
 * 边界（如实）：目标未归因**沿用既有归因门**（`EXECUTION_NOT_ATTRIBUTED`），本组只做一条锁口径的对照用例，
 * 不新造错误码。
 *
 * 另见：FR-50 陈述里的「质量门顺序」落点见 `tests/fr50-quality-gates.test.mjs`
 * （2026-10-26 裁定「选项 A」后实现：`normalizeQualityGates` + `buildTeamDirective` 按配置渲染门链）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { assertTeamTemplate, TEAM_ROLES } from "../src/core/team.mjs";

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const router = createApiRouter({ store });
  return { store, item, router };
}
const mk = (store, item, title, status = "todo") => {
  const t = store.createTask({ projectId: "demo", title, status });
  store.associateRequirementTask(item.id, t.id);
  return t;
};
const post = (router, body) =>
  router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body });

/** 拒绝时**零副作用**的统一断言：无 team_run / 无成员 / 无任务级锁。 */
function assertNoSideEffects(store, refs = []) {
  assert.equal(store.listTeamRuns({}).length, 0, "被拒的建队不得留下任何 team_run（孤儿记录）");
  for (const ref of refs) {
    assert.equal(store.getTaskLock(ref), null, `被拒的建队不得给 ${ref} 留下任务级执行锁`);
  }
}

// ---------------- 纯函数：三条非法形态 + 合法形态 ----------------

test("FR-50 纯函数：roles 缺失 / 空数组 ⇒ INVALID_TEAM_TEMPLATE（reason=roles-missing-or-empty）", () => {
  for (const tpl of [{}, { roles: undefined }, { roles: null }, { roles: [] }]) {
    assert.throws(() => assertTeamTemplate(tpl), (e) => {
      assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
      assert.equal(e.details.reason, "roles-missing-or-empty");
      return true;
    });
  }
  // 非数组（如字符串）同属"角色缺失"这一条，不得漏判成通过
  assert.throws(() => assertTeamTemplate({ roles: "engineer" }), (e) => e.details.reason === "roles-missing-or-empty");
  assert.throws(() => assertTeamTemplate(undefined), (e) => e.details.reason === "roles-missing-or-empty");
});

test("FR-50 纯函数：任一角色 count 不是正整数（0 / 负数 / 小数 / 非数）⇒ 拒绝（reason=role-count-invalid）", () => {
  for (const bad of [0, -1, -5, 1.5, "2", "x", NaN, true]) {
    assert.throws(() => assertTeamTemplate({ roles: [{ role: "engineer", count: bad }] }), (e) => {
      assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
      assert.equal(e.details.reason, "role-count-invalid");
      assert.equal(e.details.role, "engineer");
      return true;
    }, `count=${JSON.stringify(bad)} 必须被拒`);
  }
});

test("FR-50 纯函数：角色名不在契约角色集合内 ⇒ 拒绝（reason=role-unknown，details.allowed 给出合法集）", () => {
  assert.throws(() => assertTeamTemplate({ roles: [{ role: "pm" }] }), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "role-unknown");
    assert.equal(e.details.role, "pm");
    assert.deepEqual(e.details.allowed, [...TEAM_ROLES]);
    return true;
  });
  // 大小写/空白等"看起来像"的名字同样不算合法（严格比集合，不猜）
  assert.throws(() => assertTeamTemplate({ roles: ["Engineer"] }), (e) => e.details.reason === "role-unknown");
});

test("FR-50 纯函数：非法模板**不产生任何副作用**（纯函数只读入参、不建库）", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const tpl = { roles: [{ role: "engineer", count: 0 }] };
  const snapshot = JSON.stringify(tpl);
  assert.throws(() => assertTeamTemplate(tpl), (e) => e.code === "INVALID_TEAM_TEMPLATE");
  assert.equal(store.listTeamRuns({}).length, 0, "纯函数调用不得落任何团队记录");
  assert.equal(JSON.stringify(tpl), snapshot, "校验不得改写入参对象（只返回规范化副本）");
  store.close();
});

test("FR-50 纯函数：合法模板返回规范化角色列表（count 缺省=1；字符串/对象两种写法都认）", () => {
  assert.deepEqual(assertTeamTemplate({ roles: [{ role: "engineer", count: 2 }, { role: "reviewer" }] }), [
    { role: "engineer", count: 2 },
    { role: "reviewer", count: 1 },
  ]);
  assert.deepEqual(assertTeamTemplate({ roles: ["lead", "tester"] }), [
    { role: "lead", count: 1 },
    { role: "tester", count: 1 },
  ]);
});

// ---------------- 建队入口：门判定先于副作用 ----------------

test("FR-50 门：无有效角色来源（roles 缺失）⇒ 拒绝，且不留下孤儿 team_run / 成员 / 锁", async () => {
  const { store, item, router } = fresh();
  const t = mk(store, item, "无模板目标");
  await assert.rejects(() => post(router, { targetTask: t.id, tasks: [t.id] }), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "roles-missing-or-empty");
    return true;
  });
  assertNoSideEffects(store, [t.identifier]);
  store.close();
});

test("FR-50 门：项目模板里某角色 count=0 ⇒ 拒绝，且不留下孤儿 team_run / 成员 / 锁", async () => {
  const { store, item, router } = fresh();
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer", count: 0 }, { role: "reviewer" }] } });
  const t = mk(store, item, "count 为 0 的目标");
  await assert.rejects(() => post(router, { targetTask: t.id, tasks: [t.id] }), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "role-count-invalid");
    assert.equal(e.details.role, "engineer");
    return true;
  });
  assertNoSideEffects(store, [t.identifier]);
  store.close();
});

test("FR-50 门：body.members 里混进非法角色名 ⇒ 拒绝（成员优先于项目模板，二者都走同一门）", async () => {
  const { store, item, router } = fresh();
  const t = mk(store, item, "非法成员目标");
  await assert.rejects(() => post(router, { targetTask: t.id, members: [{ role: "engineer" }, { role: "pm" }], tasks: [t.id] }), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "role-unknown");
    assert.equal(e.details.role, "pm");
    return true;
  });
  assertNoSideEffects(store, [t.identifier]);
  store.close();
});

test("FR-50 门：合法模板正常建队（201 + run 落库 + 成员 + 任务级锁），预判不误伤", async () => {
  const { store, item, router } = fresh();
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer", count: 2 }, { role: "reviewer" }] } });
  const t = mk(store, item, "合法目标");
  const res = await post(router, { targetTask: t.id, tasks: [t.id] });
  assert.equal(res.status, 201);
  const runs = store.listTeamRuns({});
  assert.equal(runs.length, 1, "合法模板必须能建出 run");
  // 成员来自项目模板（body.members 缺省时回落 teamTemplate.roles），且**按 count 展开**：
  // `count:2` ⇒ 同角色 2 名成员（FR-50 验收第一条；2026-10-26 修前被按 role 去重折叠成 1 名）。
  assert.deepEqual(store.listTeamMembers(runs[0].id).map((m) => m.role).sort(), ["engineer", "engineer", "reviewer"]);
  assert.ok(store.getTaskLock(t.identifier), "合法建队应落地任务级执行锁");
  store.close();
});

test("FR-50 门：对照 —— 目标未归因沿用既有归因门（EXECUTION_NOT_ATTRIBUTED），本门不新造错误码", async () => {
  const { store, item, router } = fresh();
  const orphan = store.createTask({ projectId: "demo", title: "游离（无需求归因）", status: "todo" });
  await assert.rejects(() => post(router, { targetTask: orphan.id, members: [{ role: "engineer" }], tasks: [orphan.id] }), (e) => e.code === "EXECUTION_NOT_ATTRIBUTED");
  assertNoSideEffects(store, [orphan.identifier]);
  store.close();
});
