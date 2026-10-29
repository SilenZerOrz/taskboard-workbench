/** 修复回归：B-1 降级标注 / B-3 可行性门 / B-4 候选清空。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const routeOf = (router) => (method, pathname, body, params = {}) => router.route({ method, pathname, searchParams: new URLSearchParams(params), body });

// 卡 `-169` P4②（2026-10-29 口径变更）：B-1 的「显式降级标注」被**收紧成拒绝**。
// 现在：无 AI 时 `auto` ⇒ `AI_UNAVAILABLE` + 零落库；要降级必须显式 `fallback:"rule"`（仍带 degraded 标注）。
test("B-1 elaborate auto 无 AI → AI_UNAVAILABLE（零落库）；fallback:rule 才降级", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# R\n\n## R1 登录\n\n## R2 报表\n" });
  const router = createApiRouter({ store });
  await assert.rejects(
    () => routeOf(router)("POST", `/api/requirements/docs/${doc.id}/elaborate`, { mode: "auto" }),
    (e) => e.code === "AI_UNAVAILABLE",
  );
  assert.equal(store.listRequirementCandidates({ docId: doc.id }).length, 0, "拒绝必须零落库");

  const res = await routeOf(router)("POST", `/api/requirements/docs/${doc.id}/elaborate`, { mode: "auto", fallback: "rule" });
  assert.equal(res.payload.mode, "rule");
  assert.equal(res.payload.degraded, true);
  assert.equal(res.payload.aiError, "AI_UNAVAILABLE");
  store.close();
});

test("B-3 分拆拒绝不可行条目（FEASIBILITY_INFEASIBLE）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "X" });
  store.setRequirementFeasibility(item.identifier, { verdict: "infeasible", reason: "no" });
  const router = createApiRouter({ store });
  await assert.rejects(
    () => routeOf(router)("POST", `/api/requirements/items/${item.identifier}/split`, { tasks: [{ title: "t" }] }),
    (e) => e.code === "FEASIBILITY_INFEASIBLE",
  );
  store.close();
});

test("B-4 批量清空候选（?doc=）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# R\n\n## R1 登录\n" });
  store.addRequirementCandidates(doc.id, [{ title: "c1" }, { title: "c2" }]);
  assert.equal(store.listRequirementCandidates({ docId: doc.id }).length, 2);
  const router = createApiRouter({ store });
  const res = await routeOf(router)("DELETE", "/api/requirements/candidates", undefined, { doc: doc.id });
  assert.ok(res.payload.removed >= 2);
  assert.equal(store.listRequirementCandidates({ docId: doc.id }).length, 0);
  store.close();
});

test("B-2 规则条目化限流：默认封顶 20（卡 -169 P4② 从 100 收紧）且标 truncated", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const body = "# 资料\n\n" + Array.from({ length: 150 }, (_, i) => `## R${i + 1} 需求项 ${i + 1}`).join("\n\n");
  const doc = store.ensureRequirementDoc("p1", { body });
  const router = createApiRouter({ store });
  const res = await routeOf(router)("POST", `/api/requirements/docs/${doc.id}/elaborate`, { mode: "rule" });
  // 卡 `-169` P4②：默认上限 100 → 20（硬顶 200）
  assert.equal(res.payload.candidates.length, 20, `默认应封顶 20，实际 ${res.payload.candidates.length}`);
  assert.equal(res.payload.limit, 20);
  assert.equal(res.payload.truncated, true);
  assert.ok(res.payload.totalFound > 20);
  store.close();
});
