/**
 * FR-52 / FR-78 回归：**CLI 执行器失败必须进入失败记账**，且 `kind` 必须按错误原文分类。
 *
 * 背景（2026-10-26 · 运行期探针发现，非静态读码）：
 * `executor.mjs#executeTaskWithCli` 的失败分支走的是 `store.recordTaskExecutionFailure`，
 * 而该入口当时**不写** `consecutive_failures` / `last_failure_error` —— 于是同时瞎掉三个下游：
 *   ① 熔断诊断（`diagnostics.mjs` 的「连续失败 / 配额类」）；
 *   ② `dispatchGuard` 的 `quota-blocked` 分支（`last_failure_error` 恒空 ⇒ 永不触发）；
 *   ③ 用户可见的「受阻原因」（`api.mjs` 读 `task.lastFailureError`）。
 * 同处还把 `kind` **硬编码为 `capability`** ⇒ 「超时 / 退出码非 0」这类**瞬时**失败被错标成「能力类（配额/鉴权）」。
 *
 * 本测试把这三条下游钉住，并给出**超时 ⇒ `transient`** 的反向判据（防再退回硬编码）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { executeTaskWithCli } from "../src/core/executor.mjs";

// 验证台自建临时目录：**无论断言成败**都要清（`node --test` 每文件独立进程 ⇒ exit 钩子够用）。
const TEMPS = [];
process.on("exit", () => {
  for (const p of TEMPS) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
});
const tmpDir = (prefix) => { const d = mkdtempSync(path.join(os.tmpdir(), prefix)); TEMPS.push(d); return d; };

/** 桩 CLI：把 stderr 写死、按给定退出码退出（可 sleep 以触发超时）。 */
function stubCli(dir, { stderr = "", exitCode = 1, sleepSec = 0, stdout = "stub" } = {}) {
  const file = path.join(dir, `stub-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, [
    "#!/bin/sh",
    `echo "${stdout}"`,
    stderr ? `echo "${stderr}" >&2` : "",
    sleepSec ? `sleep ${sleepSec}` : "",
    `exit ${exitCode}`,
  ].filter(Boolean).join("\n"), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

/** 桩 git：避免真 git 影响基线判定（`collectDiffEvidence` 走它）。 */
const stubGitSpawn = () => (cmd, args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = { write() {}, end() {} };
  setImmediate(() => child.emit("close", 0));
  return child;
};

function setup(workspace = null) {
  const dir = tmpDir("tb-fr52-acc-");
  const ws = workspace ?? path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  writeFileSync(path.join(ws, "README.md"), "# ws\n", "utf8");
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const settings = {
    teamTemplate: {
      engine: "instruction",
      roles: [{ role: "engineer", executor: "cli:claude", count: 1 }],
      forbiddenExecutors: [],
      engineer: { executor: "cli:claude", verifyCommand: "echo ok" },
    },
  };
  return { store, settings, ws, dir };
}

const reqItem = (store) => store.createRequirementItem({ projectId: "p1", title: "回归需求" });
const mkTask = (store, item) => store.createTask({ projectId: "p1", title: "CLI 失败记账", status: "todo", requirementId: item.id });

/* ---- A. store 层：`recordTaskExecutionFailure` 必须记账 --------------------------------- */

test("A1 执行失败必须写 consecutive_failures + last_failure_error（此前恒 0 / 恒空）", () => {
  const { store } = setup();
  const t = mkTask(store, reqItem(store));
  store.recordTaskExecutionFailure(t.identifier, { evidence: "CLI 执行器失败（退出码 1）", error: "退出码 1：TypeError", kind: "transient" });
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "blocked", "失败 ⇒ 受阻（FR-49 不回退）");
  assert.equal(after.consecutiveFailures, 1, "失败计数必须 +1");
  assert.equal(after.lastFailureError, "退出码 1：TypeError", "结构字段必须留下原因");
  assert.equal(after.blockKind, "transient");
  assert.ok(store.listTaskEvents(t.identifier).some((e) => e.type === "failure_recorded"), "事件流必须留痕（FR-82）");
  store.close();
});

test("A2 配额类原文 ⇒ dispatchGuard 必须给出 quota-blocked（修复前恒 null）", () => {
  const { store } = setup();
  const t = mkTask(store, reqItem(store));
  store.recordTaskExecutionFailure(t.identifier, { evidence: "CLI 执行器失败（退出码 1）", error: "API Error: 429 rate limit exceeded (quota)", kind: "capability" });
  assert.equal(store.dispatchGuard(t.identifier), "quota-blocked", "配额失败 ⇒ 停止自动重试");
  store.close();
});

test("A3 count:false 时不记账（保底开关，人工只想置受阻时用）", () => {
  const { store } = setup();
  const t = mkTask(store, reqItem(store));
  store.recordTaskExecutionFailure(t.identifier, { evidence: "人工标记失败", kind: "transient", count: false });
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "blocked");
  assert.equal(after.consecutiveFailures, 0, "显式关闭记账 ⇒ 不动计数");
  assert.equal(after.lastFailureError, null);
  store.close();
});

/* ---- B. 执行器端到端：分类与原因必须到「受阻原因」层 -------------------------------- */

test("B1 配额类 CLI 失败 ⇒ kind=capability + last_failure_error 带原文", async () => {
  const { store, settings, ws, dir } = setup();
  const item = reqItem(store);
  const t = mkTask(store, item);
  const bin = stubCli(dir, { stderr: "API Error: 429 rate limit exceeded", exitCode: 1, stdout: "starting" });
  const spawnImpl = (cmd, args, opts) => (cmd === "git" ? stubGitSpawn()(cmd, args, opts) : spawn(cmd, args, opts));
  const out = await executeTaskWithCli({
    store, task: store.requireTaskRef(t.identifier), project: store.requireProject("p1"), settings,
    spawnImpl, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin }, timeoutMs: 20000, now: () => 0,
  });
  assert.equal(out.ran, true);
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "blocked");
  assert.equal(after.blockKind, "capability", "配额类必须标 capability");
  assert.equal(after.consecutiveFailures, 1);
  assert.match(String(after.lastFailureError), /429|rate limit/i, "受阻原因必须带原文（用户可见）");
  assert.equal(store.dispatchGuard(t.identifier), "quota-blocked");
  store.close();
});

test("B2 超时（非配额）⇒ kind 必须是 transient（修复前被硬编码成 capability）", async () => {
  const { store, settings, ws, dir } = setup();
  const item = reqItem(store);
  const t = mkTask(store, item);
  const bin = stubCli(dir, { exitCode: 0, stdout: "slow", sleepSec: 5 });
  const out = await executeTaskWithCli({
    store, task: store.requireTaskRef(t.identifier), project: store.requireProject("p1"), settings,
    spawnImpl: (cmd, args, opts) => (cmd === "git" ? stubGitSpawn()(cmd, args, opts) : spawn(cmd, args, opts)),
    env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin }, timeoutMs: 400, now: () => 0,
  });
  assert.equal(out.ran, true);
  assert.equal(out.result.timedOut, true, "本用例必须真的走到超时分支");
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.blockKind, "transient", "超时是瞬时失败，不得标成能力类");
  assert.equal(after.consecutiveFailures, 1, "超时同样要记账（熔断看得到）");
  store.close();
});
