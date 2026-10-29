/**
 * P3 · MCP 写四工具 + 条目列表（stdio · 2026-10-29）
 *
 * 口径（对齐方案 §6.2「形状即约束」/ §6.4 / D1=A）：
 *   A `requirement_list`：条目 + 内容版本 + 每条下的卡数（只读，不改计数）
 *   B `requirement_upsert`：新建；改条目缺 `expected_version` ⇒ MISSING_VERSION；错 ⇒ VERSION_CONFLICT；对 ⇒ 真改
 *   C `requirement_change`：预览给 change_id + affected_cards；apply 缺 id ⇒ CHANGE_NEEDS_APPROVAL；
 *     id 不符 ⇒ CHANGE_ID_MISMATCH；对 ⇒ 落地且 `requirement-change` 审计可查
 *   D `card_create`：**归因硬门**（无 requirement / 无 unattributed_reason ⇒ REQUIREMENT_REQUIRED）；
 *     `status=todo` ⇒ AUTHORIZATION_REQUIRED（backlog→todo 是人工授权）；dependsOn 真成边；跨项目 ⇒ 零建卡
 *   E `card_progress`：evidence 空 ⇒ EVIDENCE_REQUIRED；kind 非法 ⇒ EVIDENCE_INVALID；
 *     norm_digest 缺 ⇒ NORM_DIGEST_REQUIRED；错 ⇒ NORM_STALE（回带最新正文）；对 ⇒ 落证据评论 + 状态流转；
 *     同批证据再来一次 ⇒ `deduped:true` 且**不新增评论**；`status=done` ⇒ GOVERNANCE_AGENT_DONE（红线）
 *   F **契约仍是 warn 档**（用户拍板 A）：带旧 contract 写成功 + `contract-warn` 审计可查，**不 4xx**
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { loadNorms } from "../src/core/contract.mjs";
import { openStore } from "../src/core/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "mcp", "server.mjs");
const CARD_UPDATE = loadNorms(path.join(ROOT, "spec", "norms")).find((n) => n.id === "card-update");

function seed(dir) {
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "AGENTS.md"), "# 项目补充\n\n- 构建：mvn -q test\n");
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1 演示", workspacePath: ws });
  store.ensureRequirementDoc("p1", { body: "# 需求 v1\n" });
  const item = store.createRequirementItem({ projectId: "p1", title: "需求一" });
  // 另一个项目，用来验证「跨项目」两条路的错误码一致
  store.createProject({ id: "p2", name: "P2 演示" });
  store.ensureRequirementDoc("p2", { body: "# 需求 v1\n" });
  const other = store.createRequirementItem({ projectId: "p2", title: "别的项目的需求" });
  store.close();
  return { ws, item, other };
}

function startServer(dataDir, env = {}) {
  const child = spawn(process.execPath, [SERVER, "--data-dir", dataDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (line.trim() === "") return;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) { pending.delete(msg.id); resolve(msg); }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`rpc timeout: ${method}`)); }, 15000);
  });
  const tool = async (name, args) => {
    const msg = await rpc("tools/call", { name, arguments: args });
    const text = msg.result?.content?.[0]?.text ?? "";
    let value = null;
    try { value = JSON.parse(text); } catch { value = null; }
    return { isError: Boolean(msg.result?.isError), value, msg };
  };
  return { child, rpc, tool };
}

async function withServer(t, fn, { env = {} } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-mcpw-"));
  const seeded = seed(dir);
  const harness = startServer(dir, env);
  try {
    await harness.rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });
    harness.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    await fn({ dir, ...seeded, ...harness });
  } finally {
    try { harness.child.stdin.end(); } catch { /* 已关 */ }
    try { harness.child.kill("SIGKILL"); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ---------------- A ---------------- */
test("P3/A requirement_list：条目 + 内容版本 + 卡数，且只读", async () => {
  await withServer({}, async ({ dir, tool, item }) => {
    const store = openStore({ dataDir: dir });
    store.createTask({ projectId: "p1", title: "已挂在需求一上", requirementId: item.identifier, actor: "human" });
    const statsBefore = store.stats();
    store.close();

    const list = await tool("requirement_list", { project: "p1" });
    assert.equal(list.isError, false);
    assert.equal(list.value.count, 1);
    const row = list.value.items.find((i) => i.identifier === item.identifier);
    assert.ok(row, `列表里应有条目 ${item.identifier}`);
    assert.match(row.version, /^[0-9a-f]{12}$/, "条目内容版本");
    assert.equal(row.tasks.total, 1, "应数到刚建的那张卡");
    assert.equal(row.tasks.done, 0);

    const after = openStore({ dataDir: dir });
    assert.equal(after.stats().tasks, statsBefore.tasks, "只读工具不得改计数");
    after.close();
  });
});

/* ---------------- B ---------------- */
test("P3/B requirement_upsert：新建 / 缺版本 / 版本冲突 / 真改", async () => {
  await withServer({}, async ({ dir, tool, item }) => {
    const created = await tool("requirement_upsert", { project: "p1", title: "MCP 新建的条目" });
    assert.equal(created.isError, false);
    assert.equal(created.value.created, true);
    assert.equal(created.value.item.title, "MCP 新建的条目");
    assert.match(created.value.item.version, /^[0-9a-f]{12}$/);

    const ref = item.identifier;
    const missing = await tool("requirement_upsert", { project: "p1", id: ref, title: "改了没带版本" });
    assert.equal(missing.isError, true);
    assert.equal(missing.value.error.code, "MISSING_VERSION");
    assert.match(missing.value.error.details.currentVersion, /^[0-9a-f]{12}$/);

    const conflict = await tool("requirement_upsert", { project: "p1", id: ref, title: "改了带错版本", expected_version: "000000000000" });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.value.error.code, "VERSION_CONFLICT");

    const listed = await tool("requirement_list", { project: "p1" });
    const version = listed.value.items.find((i) => i.identifier === ref).version;
    const ok = await tool("requirement_upsert", { project: "p1", id: ref, title: "需求一（已改名）", expected_version: version });
    assert.equal(ok.isError, false);
    assert.equal(ok.value.created, false);
    assert.equal(ok.value.item.title, "需求一（已改名）");
    assert.notEqual(ok.value.item.version, version, "改了内容 ⇒ 版本必须变");

    const store = openStore({ dataDir: dir });
    assert.equal(store.listRequirementItems({ projectId: "p1" }).find((i) => i.identifier === ref).title, "需求一（已改名）");
    store.close();
  });
});

/* ---------------- C ---------------- */
test("P3/C requirement_change：先预览拿 change_id，再 apply（id 不符即失效）", async () => {
  await withServer({}, async ({ dir, tool, item }) => {
    const store = openStore({ dataDir: dir });
    const card = store.createTask({ projectId: "p1", title: "挂在需求一下的卡", requirementId: item.identifier, actor: "human" });
    store.close();

    const preview = await tool("requirement_change", {
      project: "p1", requirement: item.identifier, patch: { acceptance: "验收改成：npm test 全绿" }, reason: "接受口径变更",
    });
    assert.equal(preview.isError, false);
    assert.equal(preview.value.applied, false);
    assert.equal(preview.value.needs_approval, true);
    assert.match(preview.value.change_id, /^[0-9a-f]{12}$/);
    assert.deepEqual(preview.value.affected_cards.map((c) => c.identifier), [card.identifier], "影响面要列出这条需求下的未终态卡");
    assert.equal(preview.value.before.acceptance, "");
    assert.equal(preview.value.after.acceptance, "验收改成：npm test 全绿");

    const noId = await tool("requirement_change", {
      project: "p1", requirement: item.identifier, patch: { acceptance: "X" }, reason: "跳过预览", apply: true,
    });
    assert.equal(noId.isError, true);
    assert.equal(noId.value.error.code, "CHANGE_NEEDS_APPROVAL");

    const wrongId = await tool("requirement_change", {
      project: "p1", requirement: item.identifier, patch: { acceptance: "改成另一个样子" }, reason: "换了补丁", change_id: preview.value.change_id, apply: true,
    });
    assert.equal(wrongId.isError, true);
    assert.equal(wrongId.value.error.code, "CHANGE_ID_MISMATCH", "补丁变了 ⇒ 预览的 change_id 必须失效");

    const applied = await tool("requirement_change", {
      project: "p1", requirement: item.identifier, patch: { acceptance: "验收改成：npm test 全绿" }, reason: "接受口径变更",
      change_id: preview.value.change_id, apply: true,
    });
    assert.equal(applied.isError, false);
    assert.equal(applied.value.applied, true);

    const store2 = openStore({ dataDir: dir });
    const after = store2.listRequirementItems({ projectId: "p1" }).find((i) => i.identifier === item.identifier);
    assert.equal(after.acceptance, "验收改成：npm test 全绿");
    const audits = store2.listGovernanceAudit({ action: "requirement-change" });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].target, item.identifier);
    assert.equal(audits[0].reason, "接受口径变更", "reason 必须落进审计（否则事后不知为何改）");
    store2.close();
  });
});

/* ---------------- D ---------------- */
test("P3/D card_create：归因硬门 / 授权门 / 依赖真成边 / 跨项目零建卡", async () => {
  await withServer({}, async ({ dir, tool, item, other }) => {
    const noAttr = await tool("card_create", { project: "p1", title: "忘了归因" });
    assert.equal(noAttr.isError, true);
    assert.equal(noAttr.value.error.code, "REQUIREMENT_REQUIRED");

    const both = await tool("card_create", { project: "p1", title: "两个都给", requirement: item.identifier, unattributed_reason: "也想留理由" });
    assert.equal(both.isError, true);
    assert.equal(both.value.error.code, "USAGE_ERROR");

    const authorize = await tool("card_create", { project: "p1", title: "直接进 todo", requirement: item.identifier, status: "todo" });
    assert.equal(authorize.isError, true);
    assert.equal(authorize.value.error.code, "AUTHORIZATION_REQUIRED", "backlog→todo 是人工授权，MCP 不得代点");

    const ok = await tool("card_create", {
      project: "p1", title: "带归因的卡", requirement: item.identifier,
      acceptance: "npm test 全绿", verifyCommand: "npm test", dependsOn: [],
    });
    assert.equal(ok.isError, false);
    assert.equal(ok.value.card.status, "backlog", "新卡只能进待办池");
    assert.equal(ok.value.attribution.kind, "requirement");

    const skipped = await tool("card_create", { project: "p1", title: "显式不归因的卡", unattributed_reason: "一次性排查，不需要条目" });
    assert.equal(skipped.isError, false);
    assert.equal(skipped.value.attribution.kind, "explicit-skip");
    assert.equal(skipped.value.card.requirementId, null);

    const dup = await tool("card_create", { project: "p1", title: "带归因的卡", requirement: item.identifier });
    assert.equal(dup.isError, false);
    assert.equal(dup.value.duplicates.length, 1, "同名只在非终态卡里提示，不拦截");

    const withDep = await tool("card_create", { project: "p1", title: "有前置的卡", requirement: item.identifier, dependsOn: [ok.value.card.identifier] });
    assert.equal(withDep.isError, false);
    assert.deepEqual(withDep.value.dependsOn, [{ blocker: ok.value.card.identifier, blocked: withDep.value.card.identifier }]);

    const before = openStore({ dataDir: dir });
    const countBefore = before.stats().tasks;
    before.close();
    const cross = await tool("card_create", { project: "p1", title: "跨项目归因", requirement: other.identifier });
    assert.equal(cross.isError, true);
    assert.equal(cross.value.error.code, "DEPENDENCY_CROSS_PROJECT");
    const after = openStore({ dataDir: dir });
    assert.equal(after.stats().tasks, countBefore, "被拒的建卡不得留下半张卡");
    // 逃生口必须可盘点（attribution_skipped 事件）
    const events = after.listTaskEvents(after.listTasks({ projectId: "p1" }).find((t) => t.title === "显式不归因的卡").id);
    assert.ok(events.some((e) => e.type === "attribution_skipped"), `逃生口要留事件：${JSON.stringify(events.map((e) => e.type))}`);
    after.close();
  });
});

/* ---------------- E ---------------- */
test("P3/E card_progress：证据必填 + norm_digest 门 + 去重 + done 红线", async () => {
  await withServer({}, async ({ dir, tool, item }) => {
    const created = await tool("card_create", { project: "p1", title: "要回填的卡", requirement: item.identifier });
    const ref = created.value.card.identifier;

    const empty = await tool("card_progress", { card: ref, evidence: [], norm_digest: CARD_UPDATE.digest });
    assert.equal(empty.isError, true);
    assert.equal(empty.value.error.code, "EVIDENCE_REQUIRED");

    const badKind = await tool("card_progress", { card: ref, evidence: [{ kind: "vibes", ref: "感觉不错" }], norm_digest: CARD_UPDATE.digest });
    assert.equal(badKind.isError, true);
    assert.equal(badKind.value.error.code, "EVIDENCE_INVALID");

    const noDigest = await tool("card_progress", { card: ref, evidence: [{ kind: "command", ref: "npm test" }] });
    assert.equal(noDigest.isError, true);
    assert.equal(noDigest.value.error.code, "NORM_DIGEST_REQUIRED");
    assert.equal(noDigest.value.error.details.current, CARD_UPDATE.digest, "要回带当前 digest，agent 才能自纠偏");

    const stale = await tool("card_progress", { card: ref, evidence: [{ kind: "command", ref: "npm test" }], norm_digest: "deadbeef" });
    assert.equal(stale.isError, true);
    assert.equal(stale.value.error.code, "NORM_STALE");
    assert.ok(String(stale.value.error.details.body ?? "").length > 100, "NORM_STALE 必须回带最新正文");

    const evidence = [{ kind: "command", ref: "npm test", note: "890/890 pass" }];
    const first = await tool("card_progress", { card: ref, evidence, norm_digest: CARD_UPDATE.digest, status: "in_progress" });
    assert.equal(first.isError, false);
    assert.equal(first.value.card.statusBefore, "backlog");
    assert.equal(first.value.card.statusAfter, "in_progress");
    assert.equal(first.value.comment.deduped, false);
    assert.match(first.value.evidence.hash, /^[0-9a-f]{16}$/);

    const second = await tool("card_progress", { card: ref, evidence, norm_digest: CARD_UPDATE.digest });
    assert.equal(second.isError, false);
    assert.equal(second.value.comment.deduped, true, "同批证据重复回填必须去重");
    assert.equal(second.value.comment.id, first.value.comment.id);

    const done = await tool("card_progress", { card: ref, evidence, norm_digest: CARD_UPDATE.digest, status: "done" });
    assert.equal(done.isError, true);
    assert.equal(done.value.error.code, "GOVERNANCE_AGENT_DONE", "红线：done 只能人点");

    const store = openStore({ dataDir: dir });
    const task = store.listTasks({ projectId: "p1" }).find((t) => t.identifier === ref);
    assert.equal(task.status, "in_progress");
    const comments = store.listComments(task.id);
    assert.equal(comments.filter((c) => String(c.body).includes("【MCP 证据】")).length, 1, "去重后只应有一条证据评论");
    assert.match(comments.find((c) => String(c.body).includes("【MCP 证据】")).body, /- command: npm test/);
    store.close();
  });
});

/* ---------------- F ---------------- */
test("P3/F 契约仍是 warn 档：带旧 contract 写入成功，只留 contract-warn 审计", async () => {
  await withServer({}, async ({ dir, tool, item }) => {
    const res = await tool("card_create", {
      project: "p1", title: "带旧契约建的卡", requirement: item.identifier,
      contract: { version: "v1-000000000000", actor: "agent" },
    });
    assert.equal(res.isError, false, "warn 档不得把写变成失败（D2 观察期内）");
    assert.equal(res.value.contract.verdict, "warn", "返回体要告诉 agent 它用的是旧契约");
    assert.equal(res.value.contract.problems[0].kind, "version");

    const store = openStore({ dataDir: dir });
    const warns = store.listGovernanceAudit({ action: "contract-warn" });
    assert.equal(warns.length, 1);
    assert.equal(warns[0].target, res.value.card.identifier);
    store.close();
  });
});
