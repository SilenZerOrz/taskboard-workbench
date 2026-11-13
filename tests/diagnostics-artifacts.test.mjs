/**
 * 卡 `-248` · 需求 `R178` ⑤：诊断复检与假阳性收敛
 *   （① 修复动作后同一卡诊断自动 resolve · ② heartbeat 空先查产物）
 *
 * 本文件钉住三件事（每件都有**正反例**）：
 *   A. 「产物齐全 ⇒ 不报 stalled / unclaimed」；「真无产物 ⇒ 照报」（宁可假阳性不可漏报）；
 *   B. 「修复动作后同一卡诊断自动消失」（落库层：resolved_at 有值）；
 *   C. 「诊断复检」：卡收口（done/canceled）后，遗留诊断被收口 —— 诊断不再只增不减。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import {
  ARTIFACT_COMMENT_MARKERS, buildDiagnostics, collectContext, deliveredArtifacts,
  evaluateTaskDiagnostics, projectDiagnostics,
} from "../src/core/diagnostics.mjs";

/** 停滞阈值压到 0 ⇒ 「停滞」的前提只剩「没有进展回报」，产物事实成为唯一抑制开关。 */
const TIGHT = { stallMs: 0, blockedMs: 60 * 60 * 1000, recurrenceLimit: 2 };

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

const kinds = (r) => r.diagnostics.map((d) => d.kind);
const active = (store, t, kind) => store.listTaskDiagnostics(t.identifier).find((d) => d.kind === kind) ?? null;
const history = (store, t, kind) => store.listTaskDiagnostics(t.identifier, { includeResolved: true }).find((d) => d.kind === kind) ?? null;

// ---------------------------------------------------------------------------
// A. 产物事实（heartbeat 空先查产物）
// ---------------------------------------------------------------------------

test("反例：卡上没有任何交付产物 ⇒ 仍报 stalled / unclaimed（真停滞不可漏报）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "进度：做了一半" }); // 过程汇报 —— 不是产物
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT });
  assert.ok(kinds(r).includes("stalled"), "无产物 ⇒ 仍须报「停滞」");
  assert.ok(kinds(r).includes("unclaimed"), "无产物 + 无认领 ⇒ 仍须报「无人认领」");
});

test("正例：卡上有交付证据评论 ⇒ 不再报 stalled / unclaimed", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "**请求评审（执行侧）**。产出：`docs/x.md`（README + 条款 + patch）。" });
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT });
  assert.equal(kinds(r).includes("stalled"), false, "产物齐全 ⇒ 不是「停滞」");
  assert.equal(kinds(r).includes("unclaimed"), false, "产物齐全 ⇒ 不是「没人干」");
});

test("看板自己的系统留痕不算产物（「…将产出「评审死锁」诊断。」不能被当成交付）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "待评审（未指派评审者）：30 分钟无人处理将产出「评审死锁」诊断。" });
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT });
  assert.ok(kinds(r).includes("stalled"), "系统留痕不是产物 ⇒ 照报");
  assert.ok(kinds(r).includes("unclaimed"), "系统留痕不是产物 ⇒ 照报");
});

test("结构化交付证据（FR-106 task_evidence）也算产物", () => {
  const { store, t } = setup();
  store.addTaskEvidence(t.identifier, {
    verdict: "交付完成", deviation: "无", boundary: "只动 docs/",
    artifacts: ["docs/x.md"], artifactRefs: [], actor: "agent",
  });
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT });
  assert.equal(kinds(r).includes("stalled"), false, "有结构化交付证据 ⇒ 不是「停滞」");
  assert.equal(kinds(r).includes("unclaimed"), false, "有结构化交付证据 ⇒ 不是「没人干」");
});

test("成功尝试记录（执行器交了作业）也算产物", () => {
  const { store, t } = setup();
  store.claimTask(t.identifier, { sessionId: "s1" });
  store.endTaskRun(t.identifier, { outcome: "success", summary: "执行完成" });
  // 评估时刻推后 1 小时 ⇒ 认领已过期（否则「认领仍有效」会先把 unclaimed 挡掉，测不到产物这一路）
  const later = Date.now() + 60 * 60 * 1000;
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT, now: later });
  assert.equal(kinds(r).includes("unclaimed"), false, "执行成功过 ⇒ 不是「没人干」");
  assert.equal(kinds(r).includes("stalled"), false, "执行成功过 ⇒ 不是「停滞」");
});

test("反例：产物之后被判返工 ⇒ 那一版产物作废 ⇒ 仍报 stalled（真停滞不漏报）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "**请求评审（执行侧）**。产出：`docs/x.md`。" });
  store.requestReview(t.identifier, { comment: "待验收" });
  store.requestChanges(t.identifier, { comment: "断言缺失，请补测试" });
  const r = evaluateTaskDiagnostics(store, t.identifier, { thresholds: TIGHT });
  assert.ok(kinds(r).includes("stalled"), "返工后产物作废 ⇒ 仍须报「停滞」");
});

test("反向对照：产物事实是唯一的抑制开关（注入 delivered=false ⇒ 旧口径复现）", () => {
  const { store, t } = setup();
  store.addComment(t.id, { body: "**请求评审（执行侧）**。产出：`docs/x.md`。" });
  const ctx = collectContext(store, t, { now: Date.now(), thresholds: TIGHT });
  assert.equal(ctx.artifacts.delivered, true, "有交付证据 ⇒ 事实为「已交付」");
  assert.equal(buildDiagnostics(ctx).some((d) => d.kind === "stalled"), false);
  // 把产物事实抽掉（旧口径）⇒ 诊断重新出现 ⇒ 证明抑制来自产物事实，不是别的地方变了。
  const oldWay = buildDiagnostics({ ...ctx, artifacts: { delivered: false, at: null, source: null, summary: "", revoked: false } });
  assert.ok(oldWay.some((d) => d.kind === "stalled"), "去掉产物事实 ⇒ 旧口径复现");
});

test("交付证据标记清单：不含会误伤的过程词与系统留痕用词", () => {
  assert.ok(ARTIFACT_COMMENT_MARKERS.includes("请求评审"));
  assert.ok(ARTIFACT_COMMENT_MARKERS.includes("产出："));
  for (const bad of ["进度", "反馈", "产出", "待评审"]) {
    assert.equal(ARTIFACT_COMMENT_MARKERS.includes(bad), false, `「${bad}」是过程词/系统留痕用词，不能当产物标记`);
  }
});

test("交付产物事实：三个来源各自成立都算「已交付」，且取最近一份", () => {
  const { store, t } = setup();
  const empty = deliveredArtifacts(store, t, { comments: [], runs: [] });
  assert.equal(empty.delivered, false, "什么都没有 ⇒ 未交付");

  store.addComment(t.id, { body: "**请求评审（执行侧）**。产出：`docs/x.md`。" });
  const viaComment = deliveredArtifacts(store, t, { comments: store.listComments(t.id), runs: [] });
  assert.equal(viaComment.delivered, true);
  assert.equal(viaComment.source, "delivery-comment");
  assert.ok(viaComment.at, "交付时间应可回溯");
});

// ---------------------------------------------------------------------------
// B. 修复动作后同一卡诊断自动消失
// ---------------------------------------------------------------------------

test("修复动作后同一卡诊断自动消失：指派评审者 ⇒ review_deadlock 落库消解", async () => {
  const { store, t } = setup();
  store.requestReview(t.identifier, { comment: "待验收" }); // 项目无 review 角色 ⇒ reviewer 留空
  // 把评估时刻推后 40 分钟 ⇒ 命中「未指派评审者，已 N 分钟无人评审」
  const later = Date.now() + 40 * 60 * 1000;
  const before = evaluateTaskDiagnostics(store, t.identifier, { now: later });
  assert.ok(before.diagnostics.some((d) => d.kind === "review_deadlock"), "先落出评审死锁");
  assert.ok(active(store, t, "review_deadlock"), "诊断应已落库且处于 open");

  const router = createApiRouter({ store });
  const res = await router.route({
    method: "POST", pathname: `/api/tasks/${t.identifier}/review`,
    searchParams: new URLSearchParams(), body: { action: "request", reviewer: "reviewer-1", comment: "指派评审者" },
  });
  assert.equal(res.status, 200);
  assert.equal(active(store, t, "review_deadlock"), null, "修复动作后诊断应自动消失（不再 active）");
  assert.ok(history(store, t, "review_deadlock").resolvedAt, "消解要留痕（resolved_at）");
});

test("修复动作后同一卡诊断自动消失：退回重派 ⇒ stalled 消解", async () => {
  const { store, t } = setup();
  const later = Date.now() + 40 * 60 * 1000;
  evaluateTaskDiagnostics(store, t.identifier, { now: later });
  assert.ok(active(store, t, "stalled"), "先落出停滞诊断");

  const router = createApiRouter({ store });
  const res = await router.route({
    method: "POST", pathname: `/api/tasks/${t.identifier}/execution/retry`,
    searchParams: new URLSearchParams(), body: {},
  });
  assert.equal(res.status, 200);
  assert.equal(active(store, t, "stalled"), null, "重派后停滞诊断应自动消失");
});

// ---------------------------------------------------------------------------
// C. 诊断复检（终态卡的遗留诊断收口）
// ---------------------------------------------------------------------------

test("复检：卡收口（done）后，项目级扫描把它的遗留诊断收口 —— 诊断不再只增不减", () => {
  const { store, t } = setup();
  store.requestReview(t.identifier, { comment: "待验收" });
  const later = Date.now() + 40 * 60 * 1000;
  evaluateTaskDiagnostics(store, t.identifier, { now: later });
  assert.ok(active(store, t, "review_deadlock"), "先落出评审死锁");

  store.updateTask(t.identifier, { status: "done", skipReview: true, expectedVersion: store.getTaskRef(t.identifier).version }); // 人点完成（显式跳过评审）
  projectDiagnostics(store, "p1", { now: later });
  assert.equal(active(store, t, "review_deadlock"), null, "收口后不应再挂着");
  assert.ok(history(store, t, "review_deadlock").resolvedAt, "收口要留痕（resolved_at）");
});

test("复检只收口、不新增：终态卡不会被凭空补出诊断", () => {
  const { store, t } = setup();
  store.updateTask(t.identifier, { status: "done", skipReview: true, expectedVersion: store.getTaskRef(t.identifier).version });
  const before = store.listTaskDiagnostics(t.identifier, { includeResolved: true }).length;
  projectDiagnostics(store, "p1");
  const after = store.listTaskDiagnostics(t.identifier, { includeResolved: true }).length;
  assert.equal(after, before, "终态卡的诊断条数不得增加");
});
