/**
 * P1 · 契约快照（2026-10-29 · 方案 §6.4 / §8 / §17.2）
 *
 * `contract_version = f(需求文档 digest, 机器规范 digest×版本, 门配置)` —— 它的价值不是「算个哈希」，
 * 而是让 **拿旧规范干活变成显性失败**（D5：`CONTRACT_STALE` 必须带 `changed[]` + `snapshot`）。
 *
 * 判据：
 *   A 同输入 ⇒ 同版本（可复现）；任一维度变 ⇒ 版本变
 *   B 需求文档变 ⇒ `docChanged` 且 `changedFiles` 含 `requirement-doc`
 *   C 规范版本变 ⇒ `normChanges` **指明文件名**（不能只说「规范变了」）
 *   D 门配置变 ⇒ `gateChanges`
 *   E store：`contractSnapshot` 纯读（不落行）；`refreshProjectContract` 才落基线
 *   F store：落基线后文档变了 ⇒ `stale=true`，且 `changed.docChanged` 为真
 *   G store：注入改过的 norm ⇒ `changed.normChanges[].file` 指向 `spec/norms/flow.md`
 *   H HTTP：GET /contract 不落库、POST /contract/recheck 落库（同一份实现，不复制业务）
 *   I `staleError` 形状：带 `your_version` / `current_version` / `changed` / `snapshot` / `remedy`
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computeContract, diffContract, loadNorms, normalizeGates, staleError } from "../src/core/contract.mjs";
import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMS = loadNorms(path.join(ROOT, "spec", "norms"));
const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `contract-${label}-`));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

/* ---------------- A ---------------- */
test("P1/A 同输入 ⇒ 同版本；任一维度变 ⇒ 版本变（可复现）", () => {
  const a = computeContract({ requirementsText: "# 需求\nA", norms: NORMS });
  const b = computeContract({ requirementsText: "# 需求\nA", norms: NORMS });
  assert.equal(a.contractVersion, b.contractVersion);
  assert.match(a.contractVersion, /^v1-[0-9a-f]{12}$/);

  const docChanged = computeContract({ requirementsText: "# 需求\nB", norms: NORMS });
  assert.notEqual(docChanged.contractVersion, a.contractVersion);

  const normBumped = computeContract({ requirementsText: "# 需求\nA", norms: NORMS.map((n) => (n.id === "flow" ? { ...n, version: n.version + 1 } : n)) });
  assert.notEqual(normBumped.contractVersion, a.contractVersion);

  const gateChanged = computeContract({ requirementsText: "# 需求\nA", norms: NORMS, gates: { attribution: "reject" } });
  assert.notEqual(gateChanged.contractVersion, a.contractVersion, "门配置也是契约的一部分");
});

test("P1/A2 门配置归一化：缺项取 n/a，未知键不进版本", () => {
  assert.deepEqual(normalizeGates({}), { attribution: "n/a", authorization: "n/a", review: "n/a", humanReview: "n/a" });
  const a = computeContract({ requirementsText: "x", norms: NORMS, gates: { attribution: "warn", uiNoise: "abc" } });
  const b = computeContract({ requirementsText: "x", norms: NORMS, gates: { attribution: "warn" } });
  assert.equal(a.contractVersion, b.contractVersion);
});

/* ---------------- B/C/D ---------------- */
test("P1/B 需求文档变 ⇒ docChanged 且 changedFiles 含 requirement-doc", () => {
  const prev = computeContract({ requirementsText: "v1", norms: NORMS });
  const next = computeContract({ requirementsText: "v2", norms: NORMS });
  const d = diffContract(prev, next);
  assert.equal(d.docChanged, true);
  assert.equal(d.versionChanged, true);
  assert.ok(d.changedFiles.includes("requirement-doc"));
});

test("P1/C 规范版本变 ⇒ normChanges 指明文件名（不能只说『规范变了』）", () => {
  const prev = computeContract({ requirementsText: "same", norms: NORMS });
  const next = computeContract({ requirementsText: "same", norms: NORMS.map((n) => (n.id === "card-update" ? { ...n, version: n.version + 1 } : n)) });
  const d = diffContract(prev, next);
  const change = d.normChanges.find((c) => c.norm === "card-update");
  assert.ok(change, JSON.stringify(d.normChanges));
  assert.equal(change.file, "spec/norms/card-update.md");
  assert.ok(d.changedFiles.includes("spec/norms/card-update.md"));
  assert.equal(d.docChanged, false);
});

test("P1/D 门配置变 ⇒ gateChanges", () => {
  const prev = computeContract({ requirementsText: "same", norms: NORMS, gates: { attribution: "warn" } });
  const next = computeContract({ requirementsText: "same", norms: NORMS, gates: { attribution: "reject" } });
  const d = diffContract(prev, next);
  assert.ok(d.gateChanges.some((g) => g.gate === "attribution" && g.from === "warn" && g.to === "reject"), JSON.stringify(d.gateChanges));
});

/* ---------------- E/F/G ---------------- */
function seedProject(store, id = "cp1") {
  store.createProject({ id, name: id.toUpperCase() });
  store.ensureRequirementDoc(id, { body: "# 需求 v1\n" });
  return id;
}

test("P1/E store：contractSnapshot 纯读不落行，refreshProjectContract 才写基线", () => {
  const dir = freshDir("e");
  const store = openStore({ dataDir: dir });
  try {
    const id = seedProject(store);
    const snap = store.contractSnapshot(id);
    assert.match(snap.snapshot.contractVersion, /^v1-/);
    assert.equal(snap.baseline, null);
    assert.equal(snap.stale, false, "没有基线时不算 stale（这是首次计算，不是漂移）");
    assert.equal(store.getProjectContract(id), null, "GET 语义必须零副作用");

    const refreshed = store.refreshProjectContract(id);
    assert.ok(refreshed.baseline);
    const row = store.getProjectContract(id);
    assert.equal(row.contractVersion, snap.snapshot.contractVersion);
    assert.equal(row.norms.length, 5);
    assert.equal(row.gates.attribution, "warn", "默认 warn（TB_STRICT_ATTRIBUTION 未设）");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P1/F store：基线落库后需求文档变了 ⇒ stale=true 且 changed.docChanged", () => {
  const dir = freshDir("f");
  const store = openStore({ dataDir: dir });
  try {
    const id = seedProject(store);
    store.refreshProjectContract(id);
    const before = store.getProjectContract(id).contractVersion;

    const doc = store.getRequirementDoc(id);
    store.updateRequirementDoc(doc.id, { body: "# 需求 v2（加了一条 FR）\n", expectedVersion: doc.version });
    const snap = store.contractSnapshot(id);
    assert.equal(snap.stale, true);
    assert.equal(snap.changed.docChanged, true);
    assert.notEqual(snap.snapshot.contractVersion, before);
    assert.ok(snap.changed.changedFiles.includes("requirement-doc"));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P1/G store：注入改过的规范 ⇒ changed.normChanges[].file 指向 spec/norms/flow.md", () => {
  const dir = freshDir("g");
  const tampered = NORMS.map((n) => (n.id === "flow" ? { ...n, version: n.version + 1, digest: "f".repeat(64) } : n));
  const store = openStore({ dataDir: dir, norms: NORMS });
  try {
    const id = seedProject(store);
    store.refreshProjectContract(id);
    assert.equal(store.contractSnapshot(id).stale, false, "同一批规范重算必须稳定（不能自己跟自己漂）");
    store.close();

    const store2 = openStore({ dataDir: dir, norms: tampered });
    try {
      const snap = store2.contractSnapshot(id);
      assert.equal(snap.stale, true);
      const change = snap.changed.normChanges.find((c) => c.norm === "flow");
      assert.ok(change, JSON.stringify(snap.changed));
      assert.equal(change.file, "spec/norms/flow.md");
    } finally { store2.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- H ---------------- */
test("P1/H HTTP：GET /contract 零副作用，POST /contract/recheck 落库", async () => {
  const dir = freshDir("h");
  const store = openStore({ dataDir: dir });
  try {
    const id = seedProject(store);
    const server = createServer({ store });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;

    const got = await fetch(`${base}/api/projects/${id}/contract`);
    assert.equal(got.status, 200);
    const gotJson = await got.json();
    assert.match(gotJson.snapshot.contractVersion, /^v1-/);
    assert.equal(store.getProjectContract(id), null, "GET 不得落库");

    const posted = await fetch(`${base}/api/projects/${id}/contract/recheck`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "手动重算" }) });
    assert.equal(posted.status, 200);
    const postedJson = await posted.json();
    assert.equal(postedJson.baseline.contractVersion, postedJson.snapshot.contractVersion);
    assert.ok(store.getProjectContract(id), "POST recheck 必须落基线");

    // 错误方法必须明确拒绝（不静默）
    const bad = await fetch(`${base}/api/projects/${id}/contract`, { method: "POST" });
    assert.equal(bad.status, 400);

    await new Promise((r) => server.close(r));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- I ---------------- */
test("P1/I staleError 形状：你/当前/变了什么/快照/remedy 齐全", () => {
  const prev = computeContract({ requirementsText: "v1", norms: NORMS });
  const next = computeContract({ requirementsText: "v2", norms: NORMS });
  const err = staleError({ yours: prev.contractVersion, current: next, changed: diffContract(prev, next) });
  assert.equal(err.code, "CONTRACT_STALE");
  assert.equal(err.details.your_version, prev.contractVersion);
  assert.equal(err.details.current_version, next.contractVersion);
  assert.ok(err.details.changed.changedFiles.includes("requirement-doc"));
  assert.equal(err.details.snapshot.contractVersion, next.contractVersion);
  assert.match(err.details.remedy, /重试/);
});
