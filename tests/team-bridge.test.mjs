/**
 * 团队任务 ↔ 看板卡映射（卡 `-247` · 需求 `R178` ④）——只读同步器。
 *
 * 覆盖三条线：
 *   ① **推导正确**：卡号在插件任务文本里全词命中 ⇒ 反查出 t-id；命中不到 ⇒ 明文声明。
 *   ② **全词命中**：`p1-1` 不得被 `p1-10` / `p1-12` 误命中（反证：前缀误判）。
 *   ③ **只读纪律**：跑完全部映射入口后，`team_tasks` 行数不变、`.agent-teams/**` 字节不变。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { BRIDGE_MODE, BRIDGE_POLICY, buildCardTaskMap, mapCardToTeamTasks, readPluginTeams } from "../src/core/team-bridge.mjs";
import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function tempDir(label) {
  return mkdtempSync(path.join(os.tmpdir(), `tb-bridge-${label}-`));
}

/** 在工作区里造一个插件团队（.agent-teams/<team>/team.json）。 */
function writePluginTeam(workspace, teamId, tasks, extra = {}) {
  const dir = path.join(workspace, ".agent-teams", teamId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "team.json");
  const payload = { name: teamId, id: teamId, captainSessionId: "session-x", members: [{ name: "engineer" }], tasks, ...extra };
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

test("只读扫描：读工作区 .agent-teams/<team>/team.json（团队 + 任务）", async () => {
  const ws = tempDir("scan");
  try {
    writePluginTeam(ws, "squad-a", [
      { id: "t1", subject: "做一件事", status: "completed", assignee: "engineer", description: "关联看板：demo-1" },
      { id: "t2", subject: "做另一件事", status: "failed", assignee: "reviewer", description: "无关联" },
    ]);
    const teams = await readPluginTeams(ws);
    assert.equal(teams.length, 1);
    assert.equal(teams[0].id, "squad-a");
    assert.equal(teams[0].taskCount, 2);
    assert.equal(teams[0].tasks[0].id, "t1");
    assert.equal(teams[0].tasks[0].status, "completed");
    assert.equal(teams[0].tasks[0].assignee, "engineer");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("只读扫描：工作区没有 .agent-teams/ ⇒ 空数组（不是错误）", async () => {
  const ws = tempDir("empty");
  try {
    assert.deepEqual(await readPluginTeams(ws), []);
    assert.deepEqual(await readPluginTeams(null), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("推导：卡号命中 ⇒ 反查出团队侧 t-id（带证据字段）", async () => {
  const ws = tempDir("hit");
  try {
    writePluginTeam(ws, "squad-a", [
      { id: "t1", subject: "需求条款化", status: "completed", assignee: "planner", description: "关联看板：demo-3、demo-4（归因 R2）" },
      { id: "t2", subject: "别的活", status: "open", assignee: "engineer", description: "与看板无关" },
    ]);
    const teams = await readPluginTeams(ws);
    const rows = mapCardToTeamTasks("demo-3", teams);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].teamTaskId, "t1");
    assert.equal(rows[0].teamId, "squad-a");
    assert.equal(rows[0].teamTaskStatus, "completed");
    assert.equal(rows[0].assignee, "planner");
    assert.ok(rows[0].evidence.length > 0, "必须给命中证据");
    assert.equal(rows[0].evidence[0].field, "description");
    assert.match(rows[0].evidence[0].snippet, /demo-3/);
    // 未命中的卡 ⇒ 零行（前端据此显示明文声明）
    assert.deepEqual(mapCardToTeamTasks("demo-99", teams), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("全词命中：demo-1 不得被 demo-10 / demo-12 误命中（反证：前缀误判）", async () => {
  const ws = tempDir("prefix");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "只提到 demo-10 与 demo-12", status: "completed", description: "demo-10 demo-12" }]);
    const teams = await readPluginTeams(ws);
    assert.deepEqual(mapCardToTeamTasks("demo-1", teams), [], "demo-1 不该被 demo-10/demo-12 带偏");
    assert.equal(mapCardToTeamTasks("demo-10", teams).length, 1, "demo-10 自己要能命中");
    assert.equal(mapCardToTeamTasks("demo-12", teams).length, 1, "demo-12 自己要能命中");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("全词命中：卡号被更长标识符包住时不命中（xdemo-1 / demo-1x）", async () => {
  const ws = tempDir("boundary");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "无关", status: "open", description: "xdemo-1 与 demo-1x" }]);
    const teams = await readPluginTeams(ws);
    assert.deepEqual(mapCardToTeamTasks("demo-1", teams), []);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("项目级映射：已映射 / 未映射分区 + 统计", async () => {
  const ws = tempDir("map");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "活儿", status: "completed", assignee: "engineer", description: "关联看板：demo-1" }]);
    const teams = await readPluginTeams(ws);
    const cards = [
      { id: "c1", identifier: "demo-1", title: "卡一", status: "in_review" },
      { id: "c2", identifier: "demo-2", title: "卡二", status: "todo" },
    ];
    const { rows, unmapped, stats } = buildCardTaskMap({ cards, teams });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].cardIdentifier, "demo-1");
    assert.equal(rows[0].teamTaskId, "t1");
    assert.deepEqual(unmapped.map((c) => c.identifier), ["demo-2"]);
    assert.equal(stats.cards, 2);
    assert.equal(stats.mappedCards, 1);
    assert.equal(stats.unmappedCards, 1);
    assert.equal(stats.pluginTeams, 1);
    assert.equal(stats.pluginTasks, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("API：GET /api/projects/:id/team-bridge 出映射表 + 口径 + 统计", async () => {
  const ws = tempDir("api-project");
  const dir = tempDir("api-db");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "活儿", status: "completed", assignee: "engineer", description: "关联看板：demo-1" }]);
    const store = openStore({ dataDir: dir });
    store.createProject({ id: "demo", name: "Demo", workspacePath: ws });
    store.createTask({ projectId: "demo", title: "卡一", status: "todo" });
    store.createTask({ projectId: "demo", title: "卡二", status: "todo" });
    const router = createApiRouter({ store });
    const res = await router.route({ method: "GET", pathname: "/api/projects/demo/team-bridge", searchParams: new URLSearchParams() });
    assert.equal(res.status, 200);
    assert.equal(res.payload.mode, BRIDGE_MODE);
    assert.equal(res.payload.policy, BRIDGE_POLICY);
    assert.equal(res.payload.mappings.length, 1);
    assert.equal(res.payload.mappings[0].cardIdentifier, "demo-1");
    assert.equal(res.payload.mappings[0].teamTaskId, "t1");
    assert.equal(res.payload.unmapped.length, 1);
    assert.equal(res.payload.stats.mappedCards, 1);
    assert.equal(res.payload.stats.unmappedCards, 1);
    // 非 GET 一律拒（只读端点）
    await assert.rejects(
      () => router.route({ method: "POST", pathname: "/api/projects/demo/team-bridge", searchParams: new URLSearchParams(), body: {} }),
      (error) => error.code === "USAGE_ERROR",
    );
    store.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：GET /api/tasks/:ref/team 带 bridge（单卡反查）", async () => {
  const ws = tempDir("api-card");
  const dir = tempDir("api-db2");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t7", subject: "活儿", status: "completed", assignee: "engineer", description: "关联看板：demo-1" }]);
    const store = openStore({ dataDir: dir });
    store.createProject({ id: "demo", name: "Demo", workspacePath: ws });
    const task = store.createTask({ projectId: "demo", title: "卡一", status: "todo" });
    const router = createApiRouter({ store });
    const res = await router.route({ method: "GET", pathname: `/api/tasks/${task.identifier}/team`, searchParams: new URLSearchParams() });
    assert.equal(res.status, 200);
    assert.ok(res.payload.bridge, "必须带 bridge 段");
    assert.equal(res.payload.bridge.mapped, true);
    assert.equal(res.payload.bridge.rows.length, 1);
    assert.equal(res.payload.bridge.rows[0].teamTaskId, "t7");
    store.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：未登记的卡 ⇒ bridge.mapped=false 且带明文声明", async () => {
  const ws = tempDir("api-unmapped");
  const dir = tempDir("api-db3");
  try {
    writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "别的活", status: "open", description: "与看板无关" }]);
    const store = openStore({ dataDir: dir });
    store.createProject({ id: "demo", name: "Demo", workspacePath: ws });
    const task = store.createTask({ projectId: "demo", title: "卡一", status: "todo" });
    const router = createApiRouter({ store });
    const res = await router.route({ method: "GET", pathname: `/api/tasks/${task.identifier}/team`, searchParams: new URLSearchParams() });
    assert.equal(res.payload.bridge.mapped, false);
    assert.deepEqual(res.payload.bridge.rows, []);
    assert.match(res.payload.bridge.policy, /看板只展示、不参与团队状态/);
    store.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("只读纪律：跑完映射入口后 team_tasks 不增行、插件产物字节不变", async () => {
  const ws = tempDir("readonly");
  const dir = tempDir("api-db4");
  try {
    const file = writePluginTeam(ws, "squad-a", [{ id: "t1", subject: "活儿", status: "completed", description: "关联看板：demo-1" }]);
    const before = readFileSync(file);
    const store = openStore({ dataDir: dir });
    store.createProject({ id: "demo", name: "Demo", workspacePath: ws });
    const task = store.createTask({ projectId: "demo", title: "卡一", status: "todo" });
    const router = createApiRouter({ store });
    const teamTasksBefore = countTeamTasks(store);
    await router.route({ method: "GET", pathname: "/api/projects/demo/team-bridge", searchParams: new URLSearchParams() });
    await router.route({ method: "GET", pathname: `/api/tasks/${task.identifier}/team`, searchParams: new URLSearchParams() });
    assert.equal(countTeamTasks(store), teamTasksBefore, "映射入口不得写 team_tasks");
    assert.deepEqual(readFileSync(file), before, "不得改 .agent-teams/** 插件产物");
    store.close();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

/** team_tasks 行数（只走公开 store API，不碰未公开的 db 句柄）。 */
function countTeamTasks(store) {
  let n = 0;
  for (const run of store.listTeamRuns({})) n += store.listTeamTasks(run.id).length;
  return n;
}
