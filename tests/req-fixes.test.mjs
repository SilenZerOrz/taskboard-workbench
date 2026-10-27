/** 修复回归：B-1 降级标注 / B-3 可行性门 / B-4 候选清空。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const routeOf = (router) => (method, pathname, body, params = {}) => router.route({ method, pathname, searchParams: new URLSearchParams(params), body });

test("B-1 elaborate auto 无 AI → 显式降级(degraded=true / aiError=AI_UNAVAILABLE)", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# R\n\n## R1 登录\n\n## R2 报表\n" });
  const router = createApiRouter({ store });
  const res = await routeOf(router)("POST", `/api/requirements/docs/${doc.id}/elaborate`, { mode: "auto" });
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

test("B-2 规则条目化限流：候选封顶 100 且标 truncated", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const body = "# 资料\n\n" + Array.from({ length: 150 }, (_, i) => `## R${i + 1} 需求项 ${i + 1}`).join("\n\n");
  const doc = store.ensureRequirementDoc("p1", { body });
  const router = createApiRouter({ store });
  const res = await routeOf(router)("POST", `/api/requirements/docs/${doc.id}/elaborate`, { mode: "rule" });
  assert.ok(res.payload.candidates.length <= 100, `候选应封顶 100，实际 ${res.payload.candidates.length}`);
  assert.equal(res.payload.truncated, true);
  assert.ok(res.payload.totalFound > 100);
  store.close();
});
