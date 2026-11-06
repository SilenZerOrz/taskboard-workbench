/**
 * 0-B（卡 `-197` · FR-106 交付物证据结构化 / FR-107 授权快照）。
 *
 * 钉四件事：
 *   1. **门在落库前** —— 四字段缺一个就整笔拒绝，不留半条记录（"证据不足"和"没有证据"必须同一种拒法）
 *   2. **refs 解不开就不能算通过** —— `unresolved` 不得被当成 `resolved`
 *   3. **mandates 是 append-only** —— 二次认领产生第二行，首行不被改写；且 store 上**没有** update/delete
 *   4. **迁移可重入** —— 同一库连开两次不报错、不重复建
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore, SCHEMA_VERSION } from "../src/core/store.mjs";
import { verifyArtifactRefs, makeResolver, normalizeArtifactRefs, evidenceFormatOk } from "../src/core/evidence.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "证据项目" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目" });
  const task = store.createTask({ projectId: "p1", title: "受测卡", status: "in_progress", requirementId: item.id });
  return { store, item, task };
}
const FULL = { verdict: "判定：三件产物齐全", deviation: "无", boundary: "未碰 :3080", artifacts: ["docs/a.md"] };

test("A 四字段齐全即落库；latest 取最新一条", () => {
  const { store, task } = setup();
  const e1 = store.addTaskEvidence(task.identifier, { ...FULL, actor: "codex" });
  assert.equal(e1.taskVersion, store.getTaskRef(task.identifier).version);
  assert.equal(e1.refsState, "unchecked", "没给 resolve 只能是 unchecked，不许假装已校验");

  const e2 = store.addTaskEvidence(task.identifier, { ...FULL, verdict: "第二版" });
  assert.equal(store.listTaskEvidence(task.identifier).length, 2);
  assert.equal(store.latestTaskEvidence(task.identifier).id, e2.id, "最新一条才是有效证据");
  store.close();
});

test("B 门在落库前：缺字段整笔拒绝，零落库", () => {
  const { store, task } = setup();
  const before = store.listTaskEvidence(task.identifier).length;
  for (const missing of ["verdict", "deviation", "boundary"]) {
    const bad = { ...FULL };
    delete bad[missing];
    assert.throws(() => store.addTaskEvidence(task.identifier, bad), (e) => e.code === "EVIDENCE_INCOMPLETE");
  }
  assert.throws(() => store.addTaskEvidence(task.identifier, { ...FULL, artifacts: [] }), (e) => e.code === "EVIDENCE_INCOMPLETE");
  assert.throws(() => store.addTaskEvidence(task.identifier, { ...FULL, artifacts: ["   "] }), (e) => e.code === "EVIDENCE_INCOMPLETE");
  assert.equal(store.listTaskEvidence(task.identifier).length, before, "被拒的请求一条都不许留");
  store.close();
});

test("C artifact_refs：解不开记 unresolved，能解开记 resolved（不搞「部分通过」）", () => {
  const { store, task } = setup();
  const resolver = (r) => r.ref === "package.json";

  const ok = store.addTaskEvidence(task.identifier, { ...FULL, artifactRefs: [{ kind: "file", ref: "package.json" }], resolve: resolver });
  assert.equal(ok.refsState, "resolved");

  const bad = store.addTaskEvidence(task.identifier, { ...FULL, artifactRefs: [{ kind: "file", ref: "不存在.md" }], resolve: resolver });
  assert.equal(bad.refsState, "unresolved");

  const mixed = store.addTaskEvidence(task.identifier, { ...FULL, artifactRefs: [{ kind: "file", ref: "package.json" }, { kind: "commit", ref: "deadbeef" }], resolve: resolver });
  assert.equal(mixed.refsState, "unresolved", "一条解不开即整体 unresolved");

  // 验收②（FR-106 GWT-3）：refs_unresolved **不得**进 format_ok；unchecked 可以进。
  assert.equal(evidenceFormatOk(ok), true, "四字段齐 + resolved ⇒ format_ok");
  assert.equal(evidenceFormatOk(bad), false, "refs_unresolved ⇒ 不是 format_ok");
  assert.equal(evidenceFormatOk(mixed), false, "部分解不开同样不是 format_ok");
  const unchecked = store.addTaskEvidence(task.identifier, { ...FULL });
  assert.equal(unchecked.refsState, "unchecked");
  assert.equal(evidenceFormatOk(unchecked), true, "unchecked 不假装已校验，但格式是合格的");
  store.close();
});

test("D 规则层纯函数：非法 kind 被丢弃；空 refs 为 unchecked", () => {
  assert.deepEqual(normalizeArtifactRefs([{ kind: "url", ref: "http://x" }, { kind: "file", ref: "" }]), []);
  assert.deepEqual(normalizeArtifactRefs([{ kind: "file", ref: " a.md ", note: "证据" }]), [{ kind: "file", ref: "a.md", note: "证据" }]);
  assert.equal(verifyArtifactRefs([], () => true).state, "unchecked");
  const r = makeResolver({ root: process.cwd(), existsSyncImpl: (p) => p.endsWith("package.json"), execFileSyncImpl: () => {} });
  assert.equal(r({ kind: "file", ref: "package.json" }), true);
  assert.equal(r({ kind: "commit", ref: "abc123" }), true);
  store_close_noop();
});

function store_close_noop() { /* 纯函数用例无需 store */ }

test("E mandates append-only：二次认领两行、首行不变；store 上无 update/delete", () => {
  const { store, task } = setup();
  assert.equal(typeof store.updateTaskMandate, "undefined", "不许有 update");
  assert.equal(typeof store.deleteTaskMandate, "undefined", "不许有 delete");

  store.claimTask(task.identifier, { sessionId: "sess-1" });
  const first = store.listTaskMandates(task.identifier);
  assert.equal(first.length, 1, "认领即冻结一条授权快照");
  const snapshot = JSON.stringify(first[0]);

  // 真正释放认领（置回 todo 会清 claim_lock），再认领一次。
  // 注意：只用 teamSetTaskStatus(in_progress) 释放不掉 —— in_progress 不清认领，
  // 第二次 claimTask 会走 already-claimed 短路、根本拿不到新授权（测试自身的坑）。
  const cur = store.getTaskRef(task.identifier);
  store.updateTask(task.identifier, { expectedVersion: cur.version, status: "todo", actor: "human" });
  const again = store.claimTask(task.identifier, { sessionId: "sess-2" });
  assert.equal(again.claimed, true, "释放后重新认领必须真拿到授权（否则本用例证不了 append-only）");
  const all = store.listTaskMandates(task.identifier);
  assert.equal(all.length, 2, "第二次认领 = 新行，不是改旧行");
  assert.equal(JSON.stringify(all[0]), snapshot, "首行内容不得被改写");
  store.close();
});

test("G 三条认领入口都冻结授权：看板 PATCH / 团队通道 / 执行器拿锁", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目" });
  const mk = (title) => store.createTask({ projectId: "p1", title, status: "todo", requirementId: item.id });

  // ① 看板 PATCH（人工通道）
  const t1 = mk("看板认领");
  store.updateTask(t1.identifier, { expectedVersion: t1.version, status: "in_progress", owner: "codex", actor: "human" });
  const m1 = store.listTaskMandates(t1.identifier);
  assert.equal(m1.length, 1, "看板进入进行中必须冻结一条");
  assert.equal(m1[0].scope, "board");
  assert.equal(m1[0].requirement_ref, item.identifier, "授权快照必须带上需求归因");

  // ② 团队通道
  const t2 = mk("团队认领");
  store.teamSetTaskStatus(t2.identifier, { status: "in_progress", actor: "agent" });
  const m2 = store.listTaskMandates(t2.identifier);
  assert.equal(m2.length, 1, "执行侧进入进行中必须冻结一条");
  assert.equal(m2[0].scope, "team");

  // ③ 执行器拿锁
  const t3 = mk("执行器认领");
  store.claimTask(t3.identifier, { sessionId: "sess-1" });
  const m3 = store.listTaskMandates(t3.identifier);
  assert.equal(m3.length, 1);
  assert.equal(m3[0].scope, "claim");
  store.close();
});

test("F 迁移可重入：同一库连开两次不报错，表在、版本 14", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-evidence-"));
  const dbPath = path.join(dir, "t.sqlite");
  const a = openStore({ dbPath });
  a.createProject({ id: "p1", name: "P" });
  a.close();
  const b = openStore({ dbPath });
  assert.equal(SCHEMA_VERSION, 14);
  const tables = b.rawDb ? null : null; // 走公共方法验证
  const item = b.createRequirementItem({ projectId: "p1", title: "R" });
  const t = b.createTask({ projectId: "p1", title: "T", status: "in_progress", requirementId: item.id });
  assert.equal(b.latestTaskEvidence(t.identifier), null);
  assert.deepEqual(b.listTaskMandates(t.identifier), []);
  b.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
