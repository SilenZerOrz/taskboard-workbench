/**
 * 卡 `-246`（需求 `R178` ③）：owner 与角色错配诊断（`owner-role-mismatch`）。
 *
 * 口径（三条全部满足才报，见 src/core/diagnostics.mjs 的规则注释）：
 *   ① owner 归一后命中不执行的角色 {planner, reviewer, archivist}；
 *   ② 卡带看板自己的卡类型标记 `kind/work`（`kind/review` 的审查卡不判）；
 *   ③ 卡在途（done / canceled 不再提示）。
 *
 * 本文件同时是**误伤面**的守门人：把每个「看起来像越位、其实不是」的组合逐条钉成 0 条。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import {
  CARD_KIND_WORK_LABEL, DIAGNOSTIC_KINDS, DIAGNOSTIC_RULES, NON_EXECUTING_OWNER_ROLES,
  evaluateTaskDiagnostics, isExecutionClassCard, ownerRole,
} from "../src/core/diagnostics.mjs";

/** 建一张带 owner / labels 的卡；默认就是「owner=reviewer 的执行卡」（验收①的正例）。 */
function setup({ owner = "reviewer", labels = [CARD_KIND_WORK_LABEL], status = "in_progress" } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status, owner, labels });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

/** 只看本 kind 的诊断（别的 kind 与本判据无关：例如 in_progress 无认领会另出 `unclaimed`）。 */
function kindsOf(store, ref) {
  return evaluateTaskDiagnostics(store, ref).diagnostics.filter((d) => d.kind === "owner-role-mismatch");
}

test("kind 已登记：DIAGNOSTIC_KINDS 与规则集都含 owner-role-mismatch", () => {
  assert.ok(DIAGNOSTIC_KINDS.includes("owner-role-mismatch"), "kind 必须登记进 DIAGNOSTIC_KINDS");
  const kinds = new Set(DIAGNOSTIC_RULES.map((r) => r.kind));
  assert.ok(kinds.has("owner-role-mismatch"), "规则集里必须有对应规则");
});

test("验收①：owner=reviewer 的执行卡 ⇒ 出 1 条 owner-role-mismatch（medium、可操作）", () => {
  const { store, t } = setup();
  const list = kindsOf(store, t.identifier);
  assert.equal(list.length, 1, `应恰好 1 条，实际 ${list.length}`);
  const d = list[0];
  assert.equal(d.severity, "medium", "任务书指定 medium");
  assert.ok(d.title && d.detail, "需要标题与说明");
  assert.match(d.detail, /评审 reviewer/, "说明里要写清越位的角色");
  assert.ok(Array.isArray(d.actions) && d.actions.length >= 1, "每条诊断至少一个恢复动作");
  const primary = d.actions.find((a) => a.kind === "primary");
  assert.ok(primary, "需标注首选动作");
  assert.equal(d.suggested, primary.id, "suggested 必须指向真实存在的动作");
  // 首选动作 = 人工改绑负责人（只诊断不拦截：动作是 POST/PATCH 之外的人工作用，不改状态）
  assert.equal(primary.method, "PATCH");
  assert.match(primary.path, /\/api\/tasks\//);
  assert.equal(primary.body.owner, "engineer");
  // 诊断**不改数据**：owner 原样，不阻断任何流程
  assert.equal(store.getTaskById(t.id).owner, "reviewer", "诊断不得改写 owner");
  assert.equal(store.getTaskById(t.id).status, "in_progress", "诊断不得改写状态");
  store.close();
});

test("验收②：owner=engineer 的执行卡 ⇒ 0 条", () => {
  const { store, t } = setup({ owner: "engineer" });
  assert.equal(kindsOf(store, t.identifier).length, 0, "执行岗的执行卡不该报");
  store.close();
});

test("误伤面：owner 归一后是执行岗（含「中文+英文」写法）⇒ 0 条", () => {
  for (const owner of ["engineer", "tester", "开发 engineer", "测试 tester", "lead", "lead@main"]) {
    const { store, t } = setup({ owner });
    assert.equal(kindsOf(store, t.identifier).length, 0, `owner=${owner} 不该报`);
    store.close();
  }
});

test("误伤面：owner 是自由文本（不是角色）⇒ 0 条（判不准就不升级）", () => {
  for (const owner of ["codex", "agent-team:claude-cli", "", null, "张三"]) {
    const { store, t } = setup({ owner });
    assert.equal(kindsOf(store, t.identifier).length, 0, `owner=${owner} 不该报`);
    store.close();
  }
});

test("误伤面：非执行类卡（审查卡 / 没标类型）⇒ 0 条", () => {
  // 审查卡：owner=reviewer 恰恰是对的
  const a = setup({ owner: "reviewer", labels: ["kind/review"] });
  assert.equal(kindsOf(a.store, a.t.identifier).length, 0, "审查卡不该报");
  a.store.close();
  // 没标类型：看板无从区分执行卡与规划卡 ⇒ 不猜（实测宽判据 4/4 误报）
  const b = setup({ owner: "planner", labels: ["P1", "需求条款"] });
  assert.equal(kindsOf(b.store, b.t.identifier).length, 0, "没标类型的卡不该报");
  b.store.close();
  // 又 work 又 review：数据自相矛盾 ⇒ 不判
  const c = setup({ owner: "reviewer", labels: ["kind/work", "kind/review"] });
  assert.equal(kindsOf(c.store, c.t.identifier).length, 0, "类型自相矛盾不该报");
  c.store.close();
});

test("误伤面：收口卡（done / canceled）⇒ 0 条（历史卡不再提示）", () => {
  const a = setup({ owner: "reviewer", status: "done" });
  assert.equal(kindsOf(a.store, a.t.identifier).length, 0, "已收口不该报");
  a.store.close();
  const b = setup({ owner: "reviewer", status: "canceled" });
  assert.equal(kindsOf(b.store, b.t.identifier).length, 0, "已取消不该报");
  b.store.close();
});

test("ownerRole 归一：角色词 / 自由文本 / 词边界", () => {
  assert.equal(ownerRole("reviewer"), "reviewer");
  assert.equal(ownerRole(" 规划 planner "), "planner");
  assert.equal(ownerRole("开发 engineer"), "engineer");
  assert.equal(ownerRole("archivist"), "archivist");
  assert.equal(ownerRole("codex"), null);
  assert.equal(ownerRole(""), null);
  assert.equal(ownerRole(null), null);
  // 词边界：reviewer 不能被 review 命中、codex 不能被 code 命中
  assert.equal(ownerRole("reviewer"), "reviewer");
});

test("isExecutionClassCard：只认 kind/work，kind/review 与无标记都不算执行类", () => {
  assert.equal(isExecutionClassCard({ labels: ["kind/work"] }), true);
  assert.equal(isExecutionClassCard({ labels: ["kind/work", "kind/review"] }), false);
  assert.equal(isExecutionClassCard({ labels: ["kind/review"] }), false);
  assert.equal(isExecutionClassCard({ labels: [] }), false);
  assert.equal(isExecutionClassCard({}), false);
});

test("越位角色集合就是任务书点名的三个（planner / reviewer / archivist）", () => {
  assert.deepEqual([...NON_EXECUTING_OWNER_ROLES].sort(), ["archivist", "planner", "reviewer"]);
});

test("人工忽略：写留痕后不再产出（kind 带连字符 ⇒ 忽略必须真能压住）", () => {
  const { store, t } = setup();
  assert.equal(kindsOf(store, t.identifier).length, 1);
  store.dismissTaskDiagnostic(t.identifier, "owner-role-mismatch", { actor: "human", note: "owner 正确" });
  assert.equal(kindsOf(store, t.identifier).length, 0, "忽略后应消解");
  store.close();
});

test("owner 改回执行岗 ⇒ 诊断自动消解（问题消失即收口）", () => {
  const { store, t } = setup();
  assert.equal(kindsOf(store, t.identifier).length, 1);
  store.updateTask(t.identifier, { expectedVersion: t.version, owner: "engineer" });
  const after = evaluateTaskDiagnostics(store, t.identifier);
  assert.equal(after.diagnostics.some((d) => d.kind === "owner-role-mismatch"), false, "应自动消解");
  assert.ok(after.resolved.some((d) => d.kind === "owner-role-mismatch"), "消解应落库留痕");
  store.close();
});
