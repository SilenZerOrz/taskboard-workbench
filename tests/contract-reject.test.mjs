/**
 * D2 · 契约门切 `reject`（口径 **R-A** · 2026-11-04 人拍）
 *
 * R-A 的语义只有一条：**「带了契约且与当前不符」⇒ 409 `CONTRACT_STALE`**；
 * `skipped`（调用方根本没带，如 Web / CLI）**照旧放行**。
 * 它不是 R-B（「所有写必须带契约」）—— 那会把 Web 全站与 CLI 一起打红。
 *
 * 判据：
 *   A 默认档：旧契约建卡 ⇒ `CONTRACT_STALE`，且**卡数不变**（门必须在写库之前）
 *   B 默认档：旧契约评论 ⇒ 抛错，且**评论数不变**
 *   C **反向对照（R-A 的核心）**：不带契约 ⇒ 正常写入（Web/CLI 零影响）
 *   D 新契约 ⇒ 正常写入（门不是「一律拒」）
 *   E 回滚开关 `TB_CONTRACT_MODE=warn` ⇒ 旧契约照写 + `contract-warn` 审计（一行降级）
 *   F 被拒时落 `contract-reject` 审计（`allowed:false`），可事后盘点「谁拿旧模板干活」
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";

const dir = () => mkdtempSync(path.join(os.tmpdir(), "contract-reject-"));
const seed = (store, id = "cr1") => {
  store.createProject({ id, name: "CR1" });
  store.ensureRequirementDoc(id, { body: "# 需求 v1\n" });
  return id;
};
const stale = { version: "v1-000000000000", actor: "agent" };
const auditOf = (store, action) => store.listGovernanceAudit({ action });

test("D2/A 旧契约建卡 ⇒ CONTRACT_STALE，且一张卡都没建（门在写之前）", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d });
  const p = seed(store);
  const before = store.listTasks({ projectId: p }).length;

  assert.throws(
    () => store.createTask({ projectId: p, title: "拿旧契约建卡", unattributedReason: "夹具", contract: { ...stale } }),
    (e) => e.code === "CONTRACT_STALE",
  );
  assert.equal(store.listTasks({ projectId: p }).length, before, "被拒时不得留下卡（否则就是「先写再 409」）");
  store.close();
});

test("D2/B 旧契约评论 ⇒ 抛错且评论数不变", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d });
  const p = seed(store);
  const task = store.createTask({ projectId: p, title: "卡", unattributedReason: "夹具" });
  const before = store.listComments(task.identifier).length;

  assert.throws(() => store.addComment(task.identifier, { body: "证据", contract: { ...stale } }), (e) => e.code === "CONTRACT_STALE");
  assert.equal(store.listComments(task.identifier).length, before, "被拒时不得写入评论");
  store.close();
});

test("D2/C 反向对照：不带契约 ⇒ 正常写入（R-A 不是 R-B）", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d });
  const p = seed(store);
  const task = store.createTask({ projectId: p, title: "Web/CLI 形态：不带契约", unattributedReason: "夹具" });
  assert.ok(task.identifier, "不带契约必须照常建卡");
  assert.equal(auditOf(store, "contract-warn").length, 0, "不带契约不得制造审计噪声");
  store.close();
});

test("D2/D 新契约 ⇒ 正常写入（门不是一律拒）", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d });
  const p = seed(store);
  const current = store.contractSnapshot(p).snapshot.contractVersion;
  const task = store.createTask({ projectId: p, title: "新契约", unattributedReason: "夹具", contract: { version: current, actor: "agent" } });
  assert.ok(task.identifier);
  assert.equal(auditOf(store, "contract-warn").length, 0);
  store.close();
});

test("D2/E 回滚开关：TB_CONTRACT_MODE=warn ⇒ 旧契约照写 + 落 contract-warn", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d, env: { TB_CONTRACT_MODE: "warn" } });
  const p = seed(store);
  const task = store.createTask({ projectId: p, title: "旧契约（warn 档）", unattributedReason: "夹具", contract: { ...stale } });
  assert.ok(task.identifier, "warn 档不得阻断写入（这是回滚开关的意义）");
  assert.equal(auditOf(store, "contract-warn").length, 1);
  assert.equal(auditOf(store, "contract-reject").length, 0, "warn 档不得落 reject 审计");
  store.close();
});

test("D2/F 被拒时落 contract-reject 审计（allowed:false）", (t) => {
  const d = dir(); t.after(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ dataDir: d });
  const p = seed(store);
  assert.throws(() => store.createTask({ projectId: p, title: "x", unattributedReason: "夹具", contract: { ...stale } }), /CONTRACT_STALE|契约已过期/);
  const rejects = auditOf(store, "contract-reject");
  assert.equal(rejects.length, 1, "必须留一行可盘点的拒绝记录");
  assert.equal(rejects[0].allowed, false);
  assert.match(String(rejects[0].detail ?? ""), /"mode":"reject"/);
  store.close();
});
