/**
 * FR-50 验收第一条 + 第二条：**按模板装配成员（角色 / 模型 / 执行器）** 与
 * **模板改动只对新团队生效、不动历史团队**。
 *
 * 背景（2026-10-26 实测发现的真实缺口，本组用例即其回归钉）：
 *   · `POST /api/teams` 建队时**只把 `role` 传下去**，模板声明的 `count` / `model` / `executor` 全丢；
 *   · `addTeamMember` **按 role 去重**，于是 `count:2` 被折叠成 1 名成员；
 *   · `team_members` 表**根本没有 `executor` 列**；
 *   · 验收第二条（模板被修改 ⇒ 新模板生效且不改动历史团队）**全仓零测试**。
 *
 * 修法：`team_members` 加 `executor` 列（`SCHEMA_VERSION` 9→10 + 幂等补列迁移）·
 * `addTeamMember` 不再按 role 去重 · 新增纯函数 `planTeamMembers` 把已校验模板展开成
 * 「一个成员一行」的装配计划，建队路径按计划落库。
 *
 * 边界（如实）：本组证的是**本仓库这一侧**（门 → 装配计划 → 落库 → 读回的字段与数量）；
 * 「真机 DSH 会话里按角色/模型/执行器真的拉起对应执行器」属 FR-51/FR-52，不在本组范围。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { planTeamMembers, MAX_ROLE_COUNT } from "../src/core/team.mjs";

/** 临时目录登记表：断言失败也必须清理（否则每跑一次泄漏一个 `tb-*` 目录）。 */
const TEMPS = [];
process.on("exit", () => {
  for (const dir of TEMPS) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const router = createApiRouter({ store });
  return { store, item, router };
}
const mk = (store, item, title) => {
  const t = store.createTask({ projectId: "demo", title, status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return t;
};
const post = (router, body) =>
  router.route({ method: "POST", pathname: "/api/teams", searchParams: new URLSearchParams(), body });

// ---------------- 纯函数：装配计划 ----------------

test("FR-50 装配计划（纯函数）：count 展开 + model/executor 带出 + 顺序＝声明顺序", () => {
  assert.deepEqual(
    planTeamMembers([
      { role: "engineer", count: 2, model: "claude-sonnet", executor: "cli:claude" },
      { role: "reviewer", count: 1, model: "gpt-x", executor: "cli:codex" },
    ]),
    [
      { role: "engineer", model: "claude-sonnet", executor: "cli:claude" },
      { role: "engineer", model: "claude-sonnet", executor: "cli:claude" },
      { role: "reviewer", model: "gpt-x", executor: "cli:codex" },
    ],
  );
});

test("FR-50 装配计划（纯函数）：字符串条目 ⇒ 1 名、model/executor 为 null；count 缺省 ⇒ 1", () => {
  assert.deepEqual(planTeamMembers(["lead", { role: "tester" }]), [
    { role: "lead", model: null, executor: null },
    { role: "tester", model: null, executor: null },
  ]);
});

test("FR-50 装配计划（纯函数）：不改动入参对象（无副作用）", () => {
  const input = [{ role: "engineer", count: 2, model: "m", executor: "e" }];
  const snapshot = JSON.parse(JSON.stringify(input));
  planTeamMembers(input);
  assert.deepEqual(input, snapshot);
});

// ---------------- 建队入口：按模板装配 ----------------

test("FR-50 验收第一条：建队按模板生成成员（角色/模型/执行器），count:2 ⇒ 同角色 2 名", async () => {
  const { store, item, router } = fresh();
  store.saveProjectSettings("demo", {
    teamTemplate: {
      roles: [
        { role: "engineer", count: 2, model: "claude-sonnet", executor: "cli:claude" },
        { role: "reviewer", count: 1, model: "gpt-x", executor: "cli:codex" },
      ],
    },
  });
  const t = mk(store, item, "装配目标");
  const res = await post(router, { targetTask: t.id, tasks: [t.id] });
  assert.equal(res.status, 201);
  const runId = store.listTeamRuns({})[0].id;
  const members = store.listTeamMembers(runId);
  assert.equal(members.length, 3, "count 合计为 3 ⇒ 必须落 3 名成员（修前只有 2 名）");
  assert.deepEqual(
    members.map((m) => [m.role, m.model, m.executor]),
    [
      ["engineer", "claude-sonnet", "cli:claude"],
      ["engineer", "claude-sonnet", "cli:claude"],
      ["reviewer", "gpt-x", "cli:codex"],
    ],
    "字段必须逐字带出，且顺序＝模板声明顺序",
  );
  store.close();
});

test("FR-50 验收第一条（UI 派发路径）：body.members 的对象数组同样按 count 装配并带出字段", async () => {
  const { store, item, router } = fresh();
  const t = mk(store, item, "UI 派发目标");
  const res = await post(router, {
    targetTask: t.id,
    tasks: [{ task: t.id, kind: "work" }],
    members: [{ role: "engineer", count: 2, model: "m1", executor: "cli:claude" }, { role: "tester", model: "m2", executor: "cli:codex" }],
  });
  assert.equal(res.status, 201);
  const members = store.listTeamMembers(store.listTeamRuns({})[0].id);
  assert.equal(members.length, 3);
  assert.deepEqual(members.map((m) => [m.role, m.model, m.executor]), [
    ["engineer", "m1", "cli:claude"],
    ["engineer", "m1", "cli:claude"],
    ["tester", "m2", "cli:codex"],
  ]);
  store.close();
});

test("FR-50 验收第二条：模板被修改 ⇒ 再次创建用新模板，且**历史团队逐字未变**", async () => {
  const { store, item, router } = fresh();
  // 第一次：engineer 1 名（model=m1 / executor=e1）
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer", count: 1, model: "m1", executor: "e1" }] } });
  const t1 = mk(store, item, "第一轮目标");
  assert.equal((await post(router, { targetTask: t1.id, tasks: [t1.id] })).status, 201);
  const run1 = store.listTeamRuns({})[0].id;
  const before = JSON.parse(JSON.stringify(store.listTeamMembers(run1)));

  // 第二次：换模板（tester 2 名 / model=m2 / executor=e2）
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "tester", count: 2, model: "m2", executor: "e2" }] } });
  const t2 = mk(store, item, "第二轮目标");
  assert.equal((await post(router, { targetTask: t2.id, tasks: [t2.id] })).status, 201);

  const runs = store.listTeamRuns({});
  assert.equal(runs.length, 2, "两次建队应是两个独立 run");
  const run2 = runs.map((r) => r.id).find((id) => id !== run1);
  assert.deepEqual(
    store.listTeamMembers(run2).map((m) => [m.role, m.model, m.executor]),
    [["tester", "m2", "e2"], ["tester", "m2", "e2"]],
    "新团队必须用**新模板**（旧的是 engineer/m1/e1）",
  );
  assert.deepEqual(store.listTeamMembers(run1), before, "历史团队的成员必须逐字未变（不得被新模板回溯改写）");
  assert.equal(store.listTeamMembers(run1).length, before.length);
  store.close();
});

test("FR-50 上限：单角色 count 超过上限 ⇒ 拒绝（role-count-too-large）且零副作用", async () => {
  const { store, item, router } = fresh();
  store.saveProjectSettings("demo", { teamTemplate: { roles: [{ role: "engineer", count: MAX_ROLE_COUNT + 1 }] } });
  const t = mk(store, item, "超限目标");
  await assert.rejects(() => post(router, { targetTask: t.id, tasks: [t.id] }), (e) => {
    assert.equal(e.code, "INVALID_TEAM_TEMPLATE");
    assert.equal(e.details.reason, "role-count-too-large");
    assert.equal(e.details.max, MAX_ROLE_COUNT);
    return true;
  });
  assert.equal(store.listTeamRuns({}).length, 0, "被拒的建队不得留下孤儿 run");
  assert.equal(store.getTaskLock(t.identifier), null, "被拒的建队不得留下任务级锁");
  store.close();
});

// ---------------- 迁移：老库补列 ----------------

test("FR-50 迁移：老库（team_members 无 executor 列）打开即幂等补列，老成员行读回 executor=null", () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-fr50-migrate-"));
  TEMPS.push(dir);
  const dbPath = join(dir, "taskboard.sqlite");
  // 造一个"v9 时代"的老库：team_members 是补列前的形状
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`create table team_members (
    id text primary key, team_id text not null, role text not null, model text,
    status text not null default 'ready', created_at text not null
  );`);
  legacy.close();

  const store = openStore({ dbPath });
  assert.equal(store.migration.addedTeamMemberExecutorColumn, true, "老库必须被补上 executor 列");
  assert.equal(store.schemaVersion, 12); // 12：+ 契约快照两张表（P1）
  store.createProject({ id: "demo", name: "Demo" });
  const item = store.createRequirementItem({ projectId: "demo", title: "需求A" });
  const t = store.createTask({ projectId: "demo", title: "T", status: "todo" });
  const run = store.createTeamRun({ targetTask: t.id, targetRequirement: item.id });
  const member = store.addTeamMember({ teamId: run.id, role: "engineer", model: "m" });
  assert.equal(member.executor, null);
  assert.deepEqual(store.listTeamMembers(run.id).map((m) => [m.role, m.model, m.executor]), [["engineer", "m", null]]);
  // 幂等：再开一次同一个库不得重复补列、不得报错
  const store2 = openStore({ dbPath });
  assert.equal(store2.migration.addedTeamMemberExecutorColumn, false);
  store2.close();
  store.close();
});
