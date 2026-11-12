/**
 * 开局注入 · **核心语义**（P5 档 C · 卡 `-210` · 需求 `R128`）—— 验收 ①③④⑤ 的单测面。
 *
 * 这一组只测 `src/core/flow-inject.mjs`（唯一实现）与 `buildFlowSummary()`（同一生成器剪裁）：
 *   A 策略 × 角色矩阵（含负例：`off` 全不注、`subagent` 永不注、`main-only` 只注主会话）
 *   B 内容同源：投出的完整版**逐字节**等于 `buildFlowBlock().text`，digest = sha256(正文)
 *   C 摘要版：≤ 300 tokens 且含「当前步 + 两道门 + 常见错误码处置」
 *   D 审计：六字段齐（session_id / project_id / policy / contract_version / digest / injected_at）
 *   E 失败不改行为：投递异常 / 没 store / 没 sessionId ⇒ 只回 reason，**不抛错、不落审计**
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { buildFlowBlock, buildFlowSummary } from "../src/mcp/flow-block.mjs";
import { sha256 } from "../src/core/contract.mjs";
import {
  DEFAULT_FLOW_INJECT_POLICY, FLOW_INJECT_AUDIT_VALUES, FLOW_INJECT_POLICIES, FLOW_INJECT_SUMMARY_MAX_TOKENS,
  decideFlowInjection, estimateFlowTokens, injectFlow, normalizeFlowInjectPolicy,
} from "../src/core/flow-inject.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "注入项目", workspacePath: "/tmp/ws-p1" });
  store.ensureRequirementDoc("p1", { body: "# 需求\n\n- R1 开局注入\n" });
  store.bindInitialSession("p1", "sess-main");
  return store;
}

function recorder() {
  const sent = [];
  return {
    sent,
    deliver: async (sid, text) => { sent.push({ sid, text }); return { sent: true }; },
  };
}

test("A 策略 × 角色矩阵：off 全不注 / main-only 只注主会话 / main+exec 多执行会话 / all 多关联会话 / subagent 永不注", () => {
  const table = {
    "off": { main: null, exec: null, related: null, subagent: null },
    "main-only": { main: "full", exec: null, related: null, subagent: null },
    "main+exec": { main: "full", exec: "summary", related: null, subagent: null },
    "all": { main: "full", exec: "summary", related: "summary", subagent: null },
    "manual": { main: "full", exec: "summary", related: "summary", subagent: null },
  };
  for (const [policy, expected] of Object.entries(table)) {
    for (const [role, version] of Object.entries(expected)) {
      const d = decideFlowInjection({ policy, role });
      assert.equal(d.inject, version !== null, `${policy} × ${role} 的 inject 判定不对（${JSON.stringify(d)}）`);
      assert.equal(d.version, version, `${policy} × ${role} 的版本不对（${JSON.stringify(d)}）`);
    }
  }
  // 负例：不知道角色就**不注**（宁可少注，不可把完整版塞进执行会话）
  assert.equal(decideFlowInjection({ policy: "all", role: null }).reason, "role-unknown");
  assert.equal(decideFlowInjection({ policy: "all", role: "captain" }).reason, "role-invalid");
  assert.equal(decideFlowInjection({ policy: "nope", role: "main" }).reason, "policy-invalid");
  // 归一化：大小写 / 下划线都接受；非法值 strict 抛
  assert.equal(normalizeFlowInjectPolicy("MAIN_ONLY"), "main-only");
  assert.equal(normalizeFlowInjectPolicy(""), DEFAULT_FLOW_INJECT_POLICY);
  assert.equal(normalizeFlowInjectPolicy("bogus"), null);
  assert.throws(() => normalizeFlowInjectPolicy("bogus", { strict: true }), /flow_inject_policy/);
  assert.deepEqual([...FLOW_INJECT_POLICIES], ["off", "main-only", "main+exec", "all"]);
  assert.deepEqual([...FLOW_INJECT_AUDIT_VALUES], ["off", "main-only", "main+exec", "all", "manual"]);
});

test("B 内容同源：完整版逐字节等于 buildFlowBlock().text；digest = sha256(正文)", async () => {
  const store = setup();
  const { sent, deliver } = recorder();
  const expected = buildFlowBlock({ store, project: "p1" }).text;
  const r = await injectFlow({ store, deliver, projectId: "p1", sessionId: "sess-main", role: "main", policy: "main-only" });
  assert.equal(r.injected, true, JSON.stringify(r));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].text, expected, "注入正文必须与 tb-flow start / MCP prompts/get 的生成器**逐字节相同**");
  assert.equal(r.digest, sha256(expected));
  assert.equal(r.chars, expected.length);
  assert.equal(r.version, "full");
  store.close();
});

test("C 摘要版：≤ 300 tokens，且含「当前步 + 两道门 + 常见错误码处置」", async () => {
  const store = setup();
  const block = buildFlowBlock({ store, project: "p1" });
  const summary = buildFlowSummary(block);
  const tokens = estimateFlowTokens(summary);
  assert.ok(tokens <= FLOW_INJECT_SUMMARY_MAX_TOKENS, `摘要版 ${tokens} tokens 超上限 ${FLOW_INJECT_SUMMARY_MAX_TOKENS}`);
  assert.match(summary, /当前步：S\d/, "必须带当前步");
  assert.match(summary, /两道门/, "必须带两道门");
  assert.match(summary, /GOVERNANCE_AGENT_DONE/, "完成门必须点名错误码");
  assert.match(summary, /EXECUTION_NOT_AUTHORIZED/, "授权门必须点名错误码（真实码，不是文档里那个不存在的 AUTHORIZATION_REQUIRED）");
  assert.match(summary, /EXECUTION_NOT_ATTRIBUTED/, "常见错误码处置：归因");
  assert.match(summary, /CONTRACT_STALE/, "常见错误码处置：契约过期");
  // 摘要版不得退化成完整版（否则「分层」就没有意义）
  assert.ok(summary.length < block.text.length / 2, "摘要版必须显著短于完整版");
  // 确定性：同一 block 两次剪裁逐字节相同
  assert.equal(buildFlowSummary(block), summary);
  assert.throws(() => buildFlowSummary({}), /buildFlowBlock/);
  store.close();
});

test("D 审计六字段齐：session_id / project_id / policy / contract_version / digest / injected_at", async () => {
  const store = setup();
  const { deliver } = recorder();
  const r = await injectFlow({ store, deliver, projectId: "p1", sessionId: "sess-exec-1", role: "exec", policy: "main+exec" });
  assert.equal(r.injected, true, JSON.stringify(r));
  assert.equal(r.auditRecorded, true);
  const rows = store.listFlowInjections({ projectId: "p1", sessionId: "sess-exec-1" });
  assert.equal(rows.length, 1);
  const row = rows[0];
  for (const key of ["sessionId", "projectId", "policy", "contractVersion", "digest", "injectedAt"]) {
    assert.ok(row[key] !== undefined && row[key] !== null && row[key] !== "", `审计行缺字段：${key}（${JSON.stringify(row)}）`);
  }
  assert.equal(row.sessionId, "sess-exec-1");
  assert.equal(row.projectId, "p1");
  assert.equal(row.policy, "main+exec");
  assert.equal(row.contractVersion, r.contractVersion);
  assert.equal(row.digest, r.digest);
  assert.equal(row.injectedAt, r.injectedAt);
  assert.match(row.injectedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(r.version, "summary", "执行会话拿的是摘要版");
  store.close();
});

test("E 失败不改行为：投递异常 / 无 store / 无 sessionId / 无通道 ⇒ 只回 reason，不抛错、不落行", async () => {
  const store = setup();
  // ① 投递通道抛异常
  const boom = await injectFlow({
    store,
    deliver: async () => { throw new Error("host exploded"); },
    projectId: "p1", sessionId: "s1", role: "main", policy: "manual",
  });
  assert.equal(boom.injected, false);
  assert.equal(boom.delivered, false);
  assert.equal(boom.reason, "host exploded");
  // ② 通道说没投进去
  const refused = await injectFlow({
    store, deliver: async () => ({ sent: false, reason: "prompt-unavailable" }),
    projectId: "p1", sessionId: "s1", role: "main", policy: "manual",
  });
  assert.equal(refused.reason, "prompt-unavailable");
  assert.equal(refused.injected, false);
  // ③ 没有通道 / 没有 store / 没有 sessionId
  assert.equal((await injectFlow({ store, projectId: "p1", sessionId: "s1", role: "main", policy: "manual" })).reason, "no-delivery-channel");
  assert.equal((await injectFlow({ deliver: async () => ({ sent: true }), projectId: "p1", sessionId: "s1", role: "main", policy: "manual" })).reason, "no-store");
  assert.equal((await injectFlow({ store, deliver: async () => ({ sent: true }), projectId: "p1", role: "main", policy: "manual" })).reason, "no-session");
  // ④ 项目不存在也不抛
  const missing = await injectFlow({ store, deliver: async () => ({ sent: true }), projectId: "nope", sessionId: "s1", role: "main", policy: "manual" });
  assert.equal(missing.injected, false);
  assert.match(String(missing.reason), /PROJECT_NOT_FOUND/);
  // 以上任何一条都不得留下审计行
  assert.deepEqual(store.listFlowInjections({ projectId: "p1" }), []);
  store.close();
});

test("E2 差分对照：`off`（缺省）零投递、零审计行 —— 与 `main-only` 同一场景只差一个策略位", async () => {
  const store = setup();
  const { sent, deliver } = recorder();
  // 缺省（没设过 policy）必须是 off
  assert.equal(store.getProjectSettings("p1").flowInjectPolicy, "off");
  const offRun = await injectFlow({ store, deliver, projectId: "p1", sessionId: "sess-main", role: "main", policy: null });
  assert.equal(offRun.injected, false);
  assert.equal(offRun.reason, "policy-off");
  assert.equal(sent.length, 0, "off 档必须零投递");
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 0, "off 档必须零审计行");

  // 打开同一个开关（只改 policy），同一场景就注入 —— 证「差分」来自这一位
  store.saveProjectSettings("p1", { flowInjectPolicy: "main-only" });
  const onRun = await injectFlow({ store, deliver, projectId: "p1", sessionId: "sess-main", role: "main", policy: null });
  assert.equal(onRun.injected, true, JSON.stringify(onRun));
  assert.equal(sent.length, 1);
  assert.equal(store.listFlowInjections({ projectId: "p1" }).length, 1);
  store.close();
});

test("F 迁移：老库的 project_settings 没有该列 ⇒ 打开即幂等补列，老项目读回 `off`（不改变行为）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-flow-migrate-"));
  const dbPath = path.join(dir, "legacy.sqlite");
  // 造一个「P5 之前」的库：project_settings 只有 env_config / team_template / loop_config。
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    create table projects (
      id text primary key, name text not null, workspace_path text, initial_session_id text,
      next_seq integer not null default 1, next_req_seq integer not null default 1,
      created_at text not null, updated_at text not null
    );
    create table project_settings (
      project_id text primary key references projects(id) on delete cascade,
      env_config text not null default '{}',
      team_template text not null default '{}',
      loop_config text not null default '{}',
      updated_at text not null
    );
    insert into projects (id, name, created_at, updated_at) values ('old', '老项目', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z');
    insert into project_settings (project_id, env_config, team_template, loop_config, updated_at) values ('old', '{}', '{}', '{}', '2026-10-01T00:00:00.000Z');
  `);
  legacy.close();
  try {
    const store = openStore({ dbPath });
    try {
      assert.equal(store.migration.addedFlowInjectPolicyColumn, true, "老库必须被补上 flow_inject_policy 列");
      assert.equal(store.stats().schemaVersion, 15);
      assert.equal(store.getProjectSettings("old").flowInjectPolicy, "off", "老项目迁移后默认 off（零行为变化）");
      // 二次打开幂等：不再补列、值保持不变
      store.close();
      const again = openStore({ dbPath });
      try {
        assert.equal(again.migration.addedFlowInjectPolicyColumn, false, "迁移必须幂等");
        assert.equal(again.getProjectSettings("old").flowInjectPolicy, "off");
      } finally { again.close(); }
    } finally { try { store.close(); } catch { /* 已关 */ } }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
