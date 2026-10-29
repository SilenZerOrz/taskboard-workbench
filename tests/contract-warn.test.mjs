/**
 * P1.5 · D2 `warn` 档 —— 写路径上的契约校验（内核层、不阻断、只记审计）。
 *
 * 为什么是「warn 而不是 reject」：规范换版的第一周，谁在拿旧模板干活这件事**还没被观测过**；
 * 直接 reject 会把所有存量调用方一起打断（包括 Web 自己）。先记审计、观察一周再切 reject。
 *
 * 判据：
 *   A `evaluateSubmittedContract` 纯判据：不带 ⇒ skipped；版本/摘要不符 ⇒ warn；全符 ⇒ ok
 *   B store：**warn 不阻断** —— 卡照样建出来（这是本档与 reject 的唯一区别）
 *   C store：warn 落一条 `contract-warn` 审计（`GET /api/governance/audit?action=contract-warn` 可查）
 *   D 反向对照：版本对得上 / 不带 contract ⇒ **不落** warn 审计（不制造噪声）
 *   E 更新与评论两条写路径同样受检（不是只堵建卡）
 *   F HTTP：body.contract 透传到内核（门面层不复制校验逻辑）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateSubmittedContract, loadNorms } from "../src/core/contract.mjs";
import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORMS = loadNorms(path.join(ROOT, "spec", "norms"));
const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `contract-warn-${label}-`));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

const CURRENT = { contractVersion: "v1-aaaaaaaaaaaa", norms: [{ id: "flow", version: 1, digest: "d-flow" }] };

function seedProject(store, id = "cw1") {
  store.createProject({ id, name: "CW1" });
  store.ensureRequirementDoc(id, { body: "# 需求 v1\n" });
  return id;
}
const createTask = (store, projectId, extra = {}) => store.createTask({
  projectId, title: "验证契约 warn 档", requirementId: null, unattributedReason: "单测夹具", ...extra,
});
const warnings = (store) => store.listGovernanceAudit({ action: "contract-warn" });

/* ---------------- A ---------------- */
test("P1.5/A 纯判据：不带 ⇒ skipped；版本不符 ⇒ warn(version)；摘要不符 ⇒ warn(norm_digest)；全符 ⇒ ok", () => {
  assert.equal(evaluateSubmittedContract(CURRENT, undefined).verdict, "skipped");
  assert.equal(evaluateSubmittedContract(CURRENT, {}).verdict, "skipped");
  assert.equal(evaluateSubmittedContract(null, { version: "v1-x" }).verdict, "unknown");

  const okVersion = evaluateSubmittedContract(CURRENT, { version: "v1-aaaaaaaaaaaa" });
  assert.equal(okVersion.verdict, "ok");

  const stale = evaluateSubmittedContract(CURRENT, { version: "v1-bbbbbbbbbbbb" });
  assert.equal(stale.verdict, "warn");
  assert.deepEqual(stale.problems.map((p) => p.kind), ["version"]);

  const badDigest = evaluateSubmittedContract(CURRENT, { normDigests: { flow: "d-old" } });
  assert.equal(badDigest.verdict, "warn");
  assert.equal(badDigest.problems[0].norm, "flow");

  const unknownNorm = evaluateSubmittedContract(CURRENT, { normDigests: { nope: "x" } });
  assert.equal(unknownNorm.verdict, "warn");
  assert.equal(unknownNorm.problems[0].kind, "norm_unknown");
});

/* ---------------- B/C/D ---------------- */
test("P1.5/B+C+D store：warn 不阻断、落一条审计；版本对得上 / 不带 ⇒ 不落审计", () => {
  const dir = freshDir("b");
  const store = openStore({ dataDir: dir });
  try {
    const id = seedProject(store);
    const current = store.contractSnapshot(id).snapshot;

    // 不带 contract ⇒ 兼容老客户端，零审计
    const plain = createTask(store, id, { title: "不带契约" });
    assert.ok(plain.identifier);
    assert.equal(warnings(store).length, 0, "不带 contract 不得产生审计噪声");

    // 版本对得上 ⇒ ok，零审计
    createTask(store, id, { title: "契约正确", contract: { version: current.contractVersion, actor: "agent" } });
    assert.equal(warnings(store).length, 0);

    // 版本不符 ⇒ **照常建卡**（warn 不阻断）+ 一条审计
    const stale = createTask(store, id, { title: "拿旧契约建卡", contract: { version: "v1-000000000000", actor: "agent" } });
    assert.ok(stale.identifier, "warn 档不得阻断写入");
    const rows = warnings(store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, "contract-warn");
    assert.equal(rows[0].reason, "stale");
    const detail = JSON.parse(rows[0].detail);
    assert.equal(detail.problems[0].kind, "version");
    assert.equal(detail.current_version, current.contractVersion);

    // 再核一次：卡真的在库里（不是只返回了对象）
    assert.equal(store.requireTaskRef(stale.identifier).title, "拿旧契约建卡");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- E ---------------- */
test("P1.5/E store：更新与评论两条写路径同样受检（不是只堵建卡）", () => {
  const dir = freshDir("e");
  const store = openStore({ dataDir: dir });
  try {
    const id = seedProject(store);
    const task = createTask(store, id, { title: "两条写路径" });
    const stale = { version: "v1-ffffffffffff", actor: "agent" };

    store.updateTask(task.identifier, { expectedVersion: task.version, owner: "agent-a", contract: stale });
    store.addComment(task.identifier, { body: "证据：契约校验覆盖评论", contract: stale });

    const rows = warnings(store);
    assert.equal(rows.length, 2, "update + comment 各一条");
    assert.deepEqual(rows.map((r) => r.target), [task.identifier, task.identifier]);
    // 反向对照：写入真的发生了（warn 不阻断）
    assert.equal(store.requireTaskRef(task.identifier).owner, "agent-a");
    assert.equal(store.listComments(task.identifier).length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- F ---------------- */
test("P1.5/F HTTP：body.contract 透传到内核（门面层不复制校验逻辑）", async () => {
  const dir = freshDir("f");
  const store = openStore({ dataDir: dir });
  const server = createServer({ store });
  try {
    const id = seedProject(store);
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;

    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: id, title: "HTTP 带旧契约", unattributedReason: "单测夹具",
        contract: { version: "v1-111111111111", actor: "agent" },
      }),
    });
    assert.equal(res.status, 201, "warn 档不得把写变成 4xx");
    const json = await res.json();
    assert.ok(json.task?.identifier, `返回体应带 task：${JSON.stringify(json).slice(0, 200)}`);

    const audit = await fetch(`${base}/api/governance/audit?action=contract-warn`);
    assert.equal(audit.status, 200);
    const body = await audit.json();
    assert.equal(body.count, 1);
    assert.equal(body.audit[0].target, json.task.identifier);
  } finally {
    // 关服务必须在 finally 里：断言失败时若只关 store，端口仍监听 ⇒ `node --test` 永不退出（首版就这么被假挂住）
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
