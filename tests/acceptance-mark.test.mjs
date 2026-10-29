/**
 * 卡 `-176` / `-177`（2026-10-29）· 口径 **X：显式缺口标记**（不改 schema、不做必填）。
 *
 * 判据三组：
 *   A 纯函数：`isAcceptanceMissing` 的四种「空」形态；
 *   B helper：缺省 ⇒ `acceptanceSet:false` + 一条 `governance_audit`（action/reason/target 可查）；
 *             有值 ⇒ `acceptanceSet:true` 且**不造审计噪音**；写审计失败不得影响回包（旁证不是阻断）；
 *   C 真写路径：MCP `requirementUpsert` 新建真落 `source:"mcp"`、缺省真落审计；
 *             改条目**只在 patch 带 `acceptance` 时**落审计，但 `acceptanceSet` 永远反映写入后状态。
 *
 * 为什么这三组要一起钉：`-176`/`-177` 是同一个缺口的两半（MCP / HTTP 两条写入口），
 * 只测 helper 会漏「入口没接上」，只测入口会漏「口径分叉」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { ACCEPTANCE_MISSING_ACTION, acceptanceFlag, isAcceptanceMissing, markAcceptance } from "../src/core/acceptance.mjs";
import { requirementUpsert } from "../src/mcp/tools.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const tmpStore = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-acceptance-"));
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1" });
  return { store, dir, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
};

test("-176/-177 ① isAcceptanceMissing：null / undefined / 空串 / 纯空白都算缺省", () => {
  for (const v of [null, undefined, "", "   ", "\n\t "]) assert.equal(isAcceptanceMissing(v), true, JSON.stringify(v));
  for (const v of ["可复跑判据", "0", "false"]) assert.equal(isAcceptanceMissing(v), false, JSON.stringify(v));
});

test("-176/-177 ② 缺省 ⇒ acceptanceSet:false + 一条 governance_audit（entry 进 reason）", () => {
  const { store, done } = tmpStore();
  try {
    const r = markAcceptance(store, { identifier: "R1", acceptance: "", actor: "mcp", entry: "test:entry", detail: { k: 1 } });
    assert.equal(r.acceptanceSet, false);
    assert.ok(r.auditId, "必须返回审计 id（可回查）");
    const rows = store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].target, "R1");
    assert.equal(rows[0].reason, "test:entry", "入口名要进 reason，才能按入口统计缺口");
    assert.equal(rows[0].actor, "mcp");
    assert.deepEqual(JSON.parse(rows[0].detail), { entry: "test:entry", identifier: "R1", k: 1 });
  } finally { done(); }
});

test("-176/-177 ③ 有验收 ⇒ acceptanceSet:true 且不落审计（不造噪音）", () => {
  const { store, done } = tmpStore();
  try {
    const r = markAcceptance(store, { identifier: "R1", acceptance: "可复跑判据" });
    assert.equal(r.acceptanceSet, true);
    assert.equal(r.auditId, null);
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 0);
    assert.equal(acceptanceFlag("可复跑判据").acceptanceSet, true);
    assert.equal(acceptanceFlag("").acceptanceSet, false);
  } finally { done(); }
});

test("-176/-177 ④ 审计写失败不得让业务写入失败（旁证不是阻断）", () => {
  const broken = { recordAudit() { throw new Error("audit table is gone"); } };
  const r = markAcceptance(broken, { identifier: "R1", acceptance: "" });
  assert.equal(r.acceptanceSet, false, "仍要如实报告缺口");
  assert.equal(r.auditId, null, "审计失败要如实回 null，不谎报");
});

test("-176 ⑤ MCP 新建：真落 source=mcp；缺省验收 ⇒ acceptanceSet:false + 审计可查", () => {
  const { store, done } = tmpStore();
  try {
    const r = requirementUpsert({ store }, { project: "p1", title: "MCP 建的条目" });
    assert.equal(r.created, true);
    assert.equal(r.acceptanceSet, false);
    const stored = store.requireRequirementItemRef(r.item.identifier);
    assert.equal(stored.source, "mcp", "MCP 建的条目必须与「手工」可辨（-176 的核心判据）");
    const rows = store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "mcp:requirement_upsert");
    assert.equal(rows[0].target, r.item.identifier);
  } finally { done(); }
});

test("-176 ⑥ MCP 新建带验收 ⇒ acceptanceSet:true 且零审计", () => {
  const { store, done } = tmpStore();
  try {
    const r = requirementUpsert({ store }, { project: "p1", title: "带验收", acceptance: "npm test 全绿" });
    assert.equal(r.acceptanceSet, true);
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 0);
    assert.equal(store.requireRequirementItemRef(r.item.identifier).source, "mcp");
  } finally { done(); }
});

test("-176 ⑦ 改条目：只在 patch 带 acceptance 时落审计；acceptanceSet 永远反映写入后状态", () => {
  const { store, done } = tmpStore();
  try {
    const created = requirementUpsert({ store }, { project: "p1", title: "缺验收", });
    const id = created.item.identifier;
    const version = created.item.version;
    // ① 改标题（不碰 acceptance）⇒ 无新审计，但如实报 false
    const t = requirementUpsert({ store }, { project: "p1", id, expected_version: version, title: "缺验收（改名）" });
    assert.equal(t.created, false);
    assert.equal(t.acceptanceSet, false, "改标题也要如实告诉调用方「这条仍没有验收」");
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 1, "只应有新建那一条");
    // ② patch 带空 acceptance ⇒ 新增一条 update 审计
    const u = requirementUpsert({ store }, { project: "p1", id, expected_version: t.item.version, acceptance: "  " });
    assert.equal(u.acceptanceSet, false);
    const rows = store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].reason, "mcp:requirement_upsert:update");
    // ③ patch 带真验收 ⇒ true，且不再新增审计
    const v = requirementUpsert({ store }, { project: "p1", id, expected_version: u.item.version, acceptance: "npm test 918 全绿" });
    assert.equal(v.acceptanceSet, true);
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 2);
  } finally { done(); }
});

// ---------------- 卡 `-177`：HTTP 两条写路径接同一份口径 ----------------

test("-177 ⑧ POST /api/requirements/items 缺省验收 ⇒ acceptanceSet:false + 审计（reason 带入口名）", async () => {
  const { store, done } = tmpStore();
  try {
    const router = createApiRouter({ store });
    const res = await router.route({ method: "POST", pathname: "/api/requirements/items", searchParams: new URLSearchParams(), body: { projectId: "p1", title: "人手建的条目" } });
    assert.equal(res.status, 201);
    assert.equal(res.payload.acceptanceSet, false, "回包必须显式告诉调用方「这条没有验收口径」");
    assert.equal(res.payload.item.source, "manual", "HTTP 建条目仍应是 manual（-176 的 mcp 只属于 MCP 入口）");
    const rows = store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reason, "http:POST /api/requirements/items");
    assert.equal(rows[0].target, res.payload.item.identifier);
  } finally { done(); }
});

test("-177 ⑨ POST 带验收 ⇒ acceptanceSet:true 且零审计", async () => {
  const { store, done } = tmpStore();
  try {
    const router = createApiRouter({ store });
    const res = await router.route({ method: "POST", pathname: "/api/requirements/items", searchParams: new URLSearchParams(), body: { projectId: "p1", title: "带验收", acceptance: "npm test 全绿" } });
    assert.equal(res.status, 201);
    assert.equal(res.payload.acceptanceSet, true);
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 0);
  } finally { done(); }
});

test("-177 ⑩ PATCH：只改标题⇒如实报 false 但不落审计；带空 acceptance⇒落审计（与 MCP 同一边界）", async () => {
  const { store, done } = tmpStore();
  try {
    const router = createApiRouter({ store });
    const created = await router.route({ method: "POST", pathname: "/api/requirements/items", searchParams: new URLSearchParams(), body: { projectId: "p1", title: "缺验收" } });
    const ref = created.payload.item.identifier;
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 1, "新建那一条");

    const t = await router.route({ method: "PATCH", pathname: `/api/requirements/items/${ref}`, searchParams: new URLSearchParams(), body: { title: "缺验收（改名）" } });
    assert.equal(t.status, 200);
    assert.equal(t.payload.acceptanceSet, false, "改标题也要如实告诉调用方「这条仍没有验收」");
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 1, "不碰 acceptance ⇒ 不添审计");

    const u = await router.route({ method: "PATCH", pathname: `/api/requirements/items/${ref}`, searchParams: new URLSearchParams(), body: { acceptance: "" } });
    assert.equal(u.payload.acceptanceSet, false);
    const rows = store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION });
    assert.equal(rows.length, 2);
    assert.equal(rows[1].reason, "http:PATCH /api/requirements/items/:ref");

    const v = await router.route({ method: "PATCH", pathname: `/api/requirements/items/${ref}`, searchParams: new URLSearchParams(), body: { acceptance: "可复跑判据" } });
    assert.equal(v.payload.acceptanceSet, true);
    assert.equal(store.listGovernanceAudit({ action: ACCEPTANCE_MISSING_ACTION }).length, 2, "补上验收后不再新增");
  } finally { done(); }
});
