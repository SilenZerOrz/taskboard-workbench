/**
 * MVP 分析链路测试（FR-34…FR-39）—— 对应 R-WS-41…R-WS-57 自验证据。
 * 不使用任何会话/执行侧能力（MVP 红线）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { elaborateDocument } from "../src/core/requirements.mjs";

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  return store;
}
const doc = (store, body) => store.ensureRequirementDoc("demo", { body });

test("R-WS-41 需求文档保存后重开一致", () => {
  const s = fresh();
  const d = doc(s, "# A\n");
  const saved = s.updateRequirementDoc(d.id, { expectedVersion: d.version, body: "# A\n- x\n" });
  assert.equal(saved.version, d.version + 1);
  assert.equal(s.getRequirementDoc("demo").body, "# A\n- x\n"); // 重开一致
  s.close();
});

test("R-WS-42 文档并发冲突：不静默覆盖", () => {
  const s = fresh();
  const d = doc(s, "v1");
  s.updateRequirementDoc(d.id, { expectedVersion: d.version, body: "v2" });
  assert.throws(() => s.updateRequirementDoc(d.id, { expectedVersion: d.version, body: "v3" }), (e) => e.code === "VERSION_CONFLICT");
  assert.equal(s.getRequirementDoc("demo").body, "v2"); // 先保存内容保持
  s.close();
});

test("R-WS-43 需求条目获得唯一可读编号且可按编号定位", () => {
  const s = fresh();
  const a = s.createRequirementItem({ projectId: "demo", title: "A" });
  const b = s.createRequirementItem({ projectId: "demo", title: "B" });
  assert.equal(a.identifier, "demo-R1");
  assert.equal(b.identifier, "demo-R2");
  assert.equal(s.getRequirementItemByIdentifier("demo-R2").title, "B");
  s.close();
});

test("R-WS-44 条目与任务关联可见", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  const task = s.createTask({ projectId: "demo", title: "T" });
  const linked = s.associateRequirementTask(item.id, task.id);
  assert.equal(linked.requirementId, item.id);
  assert.equal(s.listTasksByRequirement(item.id).length, 1);
  s.close();
});

test("R-WS-45 条目化：确认前不落库", () => {
  const s = fresh();
  const d = doc(s, "# H1\n- L1\n");
  const r = s.elaborateRequirementDoc(d.id);
  assert.equal(r.candidates.length, 2);
  assert.equal(s.listRequirementItems({ projectId: "demo" }).length, 0);
  assert.equal(s.listRequirementCandidates({ docId: d.id, status: "pending" }).length, 2);
  s.close();
});

test("R-WS-46 部分确认 = 部分落库", () => {
  const s = fresh();
  const d = doc(s, "# H1\n- L1\n- L2\n");
  const r = s.elaborateRequirementDoc(d.id);
  const created = s.confirmRequirementCandidates([r.candidates[0].id, r.candidates[1].id]).created;
  assert.equal(created.length, 2);
  assert.equal(s.listRequirementItems({ projectId: "demo" }).length, 2);
  assert.equal(s.listRequirementCandidates({ docId: d.id, status: "pending" }).length, 1);
  s.close();
});

test("R-WS-47 重复条目化不新增重复条目", () => {
  const s = fresh();
  const d = doc(s, "# H1\n- L1\n");
  const r1 = s.elaborateRequirementDoc(d.id);
  s.confirmRequirementCandidates(r1.candidates.map((c) => c.id));
  const before = s.listRequirementItems({ projectId: "demo" }).length;
  const r2 = s.elaborateRequirementDoc(d.id);
  assert.equal(r2.candidates.length, 0);
  assert.equal(s.listRequirementItems({ projectId: "demo" }).length, before);
  s.close();
});

test("R-WS-48 产出非法/失败：不写入任何条目", () => {
  const s = fresh();
  const d = doc(s, "# H1\n");
  assert.throws(() => elaborateDocument(null), (e) => e.code === "INVALID_FIELD");
  assert.throws(() => s.elaborateRequirementDoc("no-such-doc"), (e) => e.code === "REQUIREMENT_DOC_NOT_FOUND");
  assert.equal(s.listRequirementItems({ projectId: "demo" }).length, 0);
  s.close();
});

test("R-WS-49 可行性结论=追加字段，正文不变", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A", description: "正文X", acceptance: "要点Y" });
  const r = s.setRequirementFeasibility(item.id, { verdict: "feasible", reason: "可做" });
  assert.equal(r.feasibility, "feasible");
  assert.equal(r.feasibilityReason, "可做");
  assert.equal(r.description, "正文X"); // 正文不动
  assert.equal(r.acceptance, "要点Y");
  s.close();
});

test("R-WS-50 人可否决机器结论并留痕", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  s.setRequirementFeasibility(item.id, { verdict: "feasible", by: "machine", reason: "机器判可行" });
  const r = s.setRequirementFeasibility(item.id, { verdict: "infeasible", by: "human", reason: "人判不可行", override: "human@2026-10-13" });
  assert.equal(r.feasibility, "infeasible");
  assert.equal(r.feasibilityBy, "human");
  assert.equal(r.feasibilityOverride, "human@2026-10-13");
  s.close();
});

test("R-WS-51 不可行：不产生任务、条目不删除", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  s.setRequirementFeasibility(item.id, { verdict: "infeasible", reason: "无解" });
  assert.ok(s.getRequirementItemById(item.id)); // 条目仍在
  assert.equal(s.listTasksByRequirement(item.id).length, 0); // 无任务
  s.close();
});

test("R-WS-52 分拆：产出未授权任务+依赖", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  s.setRequirementFeasibility(item.id, { verdict: "feasible" });
  const r = s.splitRequirement(item.id, { tasks: [{ title: "建表", owner: "engineer" }, { title: "接API", dependsOn: ["建表"] }] });
  assert.equal(r.tasks.length, 2);
  assert.ok(r.tasks.every((t) => t.status === "backlog")); // 未授权
  assert.ok(r.tasks.every((t) => t.requirementId === item.id));
  const deps = s.listTaskDependencies(r.tasks[1].id);
  assert.equal(deps.blockers.length, 1); // 依赖可见
  s.close();
});

test("R-WS-53 分拆产出为空：不产生任务并提示", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  assert.throws(() => s.splitRequirement(item.id, { tasks: [] }), (e) => e.code === "SPLIT_EMPTY");
  assert.equal(s.listTasksByRequirement(item.id).length, 0);
  s.close();
});

test("R-WS-54 分拆产出依赖成环：拒绝", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  assert.throws(
    () => s.splitRequirement(item.id, { tasks: [{ title: "X", dependsOn: ["Y"] }, { title: "Y", dependsOn: ["X"] }] }),
    (e) => e.code === "DEPENDENCY_CYCLE",
  );
  s.close();
});

test("R-WS-55 依赖可见且前置未完成不可开工", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "A" });
  const r = s.splitRequirement(item.id, { tasks: [{ title: "前置" }, { title: "后继", dependsOn: ["前置"] }] });
  const [blocker, blocked] = r.tasks;
  assert.equal(s.isTaskReady(blocked.id).ready, false); // 前置未完成 → 未就绪
  s.updateTask(blocker.id, { expectedVersion: blocker.version, status: "done" });
  assert.equal(s.isTaskReady(blocked.id).ready, true); // 前置完成 → 就绪
  s.close();
});

test("R-WS-56 依赖成环：拒绝", () => {
  const s = fresh();
  const a = s.createTask({ projectId: "demo", title: "A" });
  const b = s.createTask({ projectId: "demo", title: "B" });
  const c = s.createTask({ projectId: "demo", title: "C" });
  s.addTaskDependency({ blocker: a.id, blocked: b.id });
  s.addTaskDependency({ blocker: b.id, blocked: c.id });
  assert.throws(() => s.addTaskDependency({ blocker: c.id, blocked: a.id }), (e) => e.code === "DEPENDENCY_CYCLE");
  s.close();
});

test("R-WS-57 跨项目依赖：拒绝", () => {
  const s = fresh();
  s.createProject({ id: "other", name: "Other" });
  const a = s.createTask({ projectId: "demo", title: "A" });
  const b = s.createTask({ projectId: "other", title: "B" });
  assert.throws(() => s.addTaskDependency({ blocker: a.id, blocked: b.id }), (e) => e.code === "DEPENDENCY_CROSS_PROJECT");
  s.close();
});
