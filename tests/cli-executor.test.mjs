/**
 * CLI 执行器（`cli:claude`）：**由看板侧真的调 CLI 干活**并把证据落回看板。
 * 用桩可执行文件替身（`TB_CLI_EXECUTOR_BIN`）跑，不真调 claude —— 真机跑法见轮次记录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import {
  buildTaskPrompt, cliArgsFor, cliCommandOf, collectDiffEvidence, evidenceComment,
  resolveCliExecutor, runCliExecutor, executeTaskWithCli, diffDelta, pathsOfStatusLines,
  snapshotWorkspace, snapshotDelta, argsAllowEdits, isBlindRun,
} from "../src/core/executor.mjs";
import { assessTask, runInFlight } from "../src/core/watchdog.mjs";

const sp = (qs = "") => new URLSearchParams(qs);

/** 造一个桩 CLI：把 stdin 存到文件、打印固定输出、可选写文件/退出码。 */
function stubCli(dir, { exitCode = 0, sleepSec = 0 } = {}) {
  const file = path.join(dir, `cli-stub-${Math.random().toString(36).slice(2)}`);
  writeFileSync(file, [
    "#!/bin/sh",
    `cat > "${dir}/stdin.txt"`,
    `echo "stub: 我完成了任务"`,
    `echo "touch" >> "${dir}/changed.txt"`,
    sleepSec ? `sleep ${sleepSec}` : "",
    `exit ${exitCode}`,
  ].join("\n"), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

// 验证台建的临时目录/文件：跑完（含断言失败）统一清理，别把 OS 临时目录堆满。
const TEMPS = [];
process.on("exit", () => {
  for (const p of TEMPS) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ }
  }
});

function setup({ workspacePath = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-cli-exec-"));
  TEMPS.push(dir);
  const ws = workspacePath ?? path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", roles: [{ role: "engineer", count: 1, executor: "cli:claude" }], forbiddenExecutors: [] } });
  return { store, t, dir, ws };
}

const settingsWithRoles = (roles, extra = {}) => ({ teamTemplate: { roles, forbiddenExecutors: [], ...extra } });

test("cliCommandOf / resolveCliExecutor：角色命中、退一步取任意 cli:*、禁用清单与无非 CLI 时返回 null", () => {
  assert.equal(cliCommandOf("cli:claude"), "claude");
  assert.equal(cliCommandOf("hosted"), null);
  const roles = [{ role: "lead", executor: "hosted" }, { role: "engineer", executor: "cli:claude" }];
  assert.deepEqual(resolveCliExecutor(settingsWithRoles(roles)), { id: "cli:claude", cli: "claude", role: "engineer" });
  // 角色不存在 → 退一步取该角色族里任意 cli:*
  assert.equal(resolveCliExecutor(settingsWithRoles(roles), { role: "reviewer" }).id, "cli:claude");
  // 禁用清单命中 → 不选（保留原会话派发路径）
  assert.equal(resolveCliExecutor(settingsWithRoles(roles, { forbiddenExecutors: ["cli:claude"] })), null);
  // 全 hosted → null
  assert.equal(resolveCliExecutor(settingsWithRoles([{ role: "engineer", executor: "hosted" }])), null);
});

test("cliArgsFor：默认非交互放行工具 + --add-dir 项目目录；设置可覆盖（真机复验时改用更保守组合）", () => {
  const args = cliArgsFor({ executorId: "cli:claude", cwd: "/tmp/ws", settings: null });
  assert.equal(args[0], "-p");
  assert.ok(args.includes("--add-dir") && args.includes("/tmp/ws"));
  assert.ok(args.includes("--allowedTools"));
  const custom = cliArgsFor({ executorId: "cli:claude", cwd: "/tmp/ws", settings: settingsWithRoles([], { engineer: { args: ["-p", "--permission-mode", "plan"] } }) });
  assert.deepEqual(custom, ["-p", "--permission-mode", "plan"]);
});

test("buildTaskPrompt：自包含（任务号 / 目录 / 边界 / 自测 / 纪律）", () => {
  const p = buildTaskPrompt({ identifier: "p1-1", title: "实现 X", description: "描述" }, { project: { workspacePath: "/tmp/ws" }, requirementId: "R1", verifyCommand: "npm test" });
  assert.match(p, /p1-1/);
  assert.match(p, /\/tmp\/ws/);
  assert.match(p, /npm test/);
  assert.match(p, /不 commit、不 push/);
});

test("runCliExecutor：走 stdin 投递指令、捕获 stdout/退出码/耗时；成功 → ok", async () => {
  const { store, t, dir, ws } = setup();
  const bin = stubCli(dir);
  const project = store.getProject("p1");
  const r = await runCliExecutor({ task: t, project, executor: { id: "cli:claude", cli: "claude" }, settings: null, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin } });
  assert.equal(r.started, true);
  assert.equal(r.cwd, ws);
  assert.equal(r.exitCode, 0);
  assert.equal(r.ok, true);
  assert.match(r.stdout, /stub: 我完成了任务/);
  // 2026-10-18 口径更正：非 git 目录**不再**退化成「无改动清单」——那正是真机被误报成
  // 「本次工作区改动：无」的假阴性来源。现在退到**文件快照**对比，并如实记 mode:'fs'。
  assert.equal(r.baseline, "fs", "git 不可用 → 退到文件快照兜底");
  assert.equal(r.diff?.mode, "fs");
  assert.deepEqual(r.diff?.files, [], "本用例的桩只写工作区外，工作区内确实没有改动（如实为空，不是判不出来）");
  assert.match(evidenceComment(t, r), /对比方式：文件快照|本次工作区改动：无/, "快照模式下也要把口径写清楚");
  assert.match(readFileSync(path.join(dir, "stdin.txt"), "utf8"), /p1-1/, "指令必须真的写进 CLI 的 stdin");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("runCliExecutor：非零退码 → ok=false（失败如实上报）", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir, { exitCode: 3 });
  const r = await runCliExecutor({ task: t, project: store.getProject("p1"), executor: { id: "cli:claude", cli: "claude" }, settings: null, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin } });
  assert.equal(r.exitCode, 3);
  assert.equal(r.ok, false);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskWithCli：成功 → 写证据评论 + 尝试记录 success + 提交「待验收」", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const out = await executeTaskWithCli({ store, task: store.requireTaskRef(t.identifier), project: store.getProject("p1"), env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin } });
  assert.equal(out.ran, true);
  assert.equal(out.result.ok, true);
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "in_review", "成功 → 提交待验收（完成仍归人）");
  const comments = store.listComments(after.id).map((c) => c.body);
  assert.ok(comments.some((b) => /CLI 执行器完成/.test(b)), "必须留证据评论");
  assert.ok(comments.some((b) => /退出码：0/.test(b)));
  const runs = store.listTaskRuns(after);
  assert.equal(runs[0].outcome, "success");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskWithCli：失败 → 走统一受阻入口（受阻 + 证据 + 尝试记录 failed）", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir, { exitCode: 2 });
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const out = await executeTaskWithCli({ store, task: store.requireTaskRef(t.identifier), project: store.getProject("p1"), env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin } });
  assert.equal(out.result.ok, false);
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "blocked");
  // 2026-10-26 更正：此处原期望 `capability`，那是**把执行器硬编码的错分类写进了期望**
  // （当时 `kind` 恒为 `capability`，于是连「非 0 退出」和「超时」都被标成「能力类（配额/鉴权）」）。
  // 本用例是普通非 0 退出 ⇒ 现按 `transient` 分类；见 `tests/fr52-cli-failure-accounting.test.mjs`
  // 的正/反向判据（配额原文 ⇒ capability · 超时 ⇒ transient · 参数未允许写文件 ⇒ needs_input）。
  assert.equal(after.blockKind, "transient");
  assert.equal(store.listTaskRuns(after)[0].outcome, "failed");
  assert.ok(store.listComments(after.id).some((c) => /CLI 执行器失败/.test(c.body)));
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("evidenceComment：成功/失败/超时三种措辞 + 无改动时如实写「无」", () => {
  const ok = evidenceComment({ identifier: "p1-1" }, { ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0, durationMs: 12000, stdout: "done", stderr: "", diff: { files: ["a.mjs"], stat: "a.mjs | 2 +" } });
  assert.match(ok, /CLI 执行器完成/);
  assert.match(ok, /a\.mjs/);
  const none = evidenceComment({ identifier: "p1-1" }, { ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0, durationMs: 1, stdout: "", stderr: "", diff: { files: [], stat: "" } });
  assert.match(none, /本次工作区改动：无/);
  const to = evidenceComment({ identifier: "p1-1" }, { ok: false, timedOut: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: null, durationMs: 5, stdout: "", stderr: "", diff: null });
  assert.match(to, /超时/);
});

test("API：POST /api/tasks/:ref/exec-cli —— dryRun 回执行计划；真跑走桩并回写状态", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  const router = createApiRouter({ store });
  const dry = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body: { dryRun: true } });
  assert.equal(dry.status, 200);
  assert.equal(dry.payload.ran, false);
  assert.equal(dry.payload.plan.executor, "cli:claude");
  assert.deepEqual(dry.payload.plan.args.slice(0, 1), ["-p"]);
  assert.match(dry.payload.plan.prompt, /p1-1/);

  process.env.TB_CLI_EXECUTOR_BIN = bin;
  try {
    store.startTaskExecution(t.identifier, { sessionId: "s1" });
    const ran = await router.route({ method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body: {} });
    assert.equal(ran.status, 200);
    assert.equal(ran.payload.ran, true);
    assert.equal(ran.payload.ok, true);
    assert.equal(ran.payload.status, "in_review");
  } finally { delete process.env.TB_CLI_EXECUTOR_BIN; }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("API：项目未配 CLI 执行器 → 明确报 NO_CLI_EXECUTOR（不静默改成别的通道）", async () => {
  const { store, t } = setup();
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", roles: [{ role: "engineer", executor: "hosted" }] } });
  await assert.rejects(
    () => createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body: {} }),
    (e) => e.code === "NO_CLI_EXECUTOR",
  );
  store.close();
});

test("diffDelta：只认本次新增改动（脏仓库下不得把历史改动算成本次产出）", () => {
  const before = { files: [" M docs/README.md", " M index.js"], stat: "" };
  const after = { files: [" M docs/README.md", " M index.js", " M src/core/loop.mjs", "?? tests/new.test.mjs"], stat: "x" };
  const d = diffDelta(before, after);
  assert.deepEqual(d.files, [" M src/core/loop.mjs", "?? tests/new.test.mjs"]);
  assert.equal(d.baselineFiles, 2);
  assert.deepEqual(diffDelta(null, after).files, after.files, "没有基线时如实全列");
  assert.equal(diffDelta(null, after).baselineFiles, null, "没有基线 → baselineFiles 必须是 null（区别于空基线）");
  assert.equal(diffDelta(before, null), null);
  assert.deepEqual(pathsOfStatusLines([" M src/a.mjs", '?? "docs/新 文档.md"', "R  old.mjs -> new.mjs"]), ["src/a.mjs", "docs/新 文档.md", "new.mjs"]);
});

/* ---- 证据基线退化修复（taskboard-workbench-74）---- */

/** 桩 spawn：按调用次序对 git 子命令返回不同结果；`script` 为 (args) => ({code, out}) 或 null。 */
function stubGitSpawn(script, calls = []) {
  return (cmd, args) => {
    calls.push([cmd, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.stdin = { write() {}, end() {} };
    const r = script(args) ?? { code: 0, out: "" };
    setImmediate(() => {
      if (r.out) child.stdout.emit("data", r.out);
      child.emit("close", r.code);
    });
    return child;
  };
}

test("collectDiffEvidence：git 非零退出 → null（不得返回 files:[] 冒充空基线）", async () => {
  const calls = [];
  const r = await collectDiffEvidence("/tmp/ws", { spawnImpl: stubGitSpawn(() => ({ code: 128, out: "" }), calls) });
  assert.equal(r, null, "非零退出必须是 null");
  assert.ok(calls.length >= 2, "首次失败应重试一次");
});

test("collectDiffEvidence：git 正常退出且工作区干净 → files:[]（真空基线）", async () => {
  const r = await collectDiffEvidence("/tmp/ws", { spawnImpl: stubGitSpawn(() => ({ code: 0, out: "" })), retryDelayMs: 0 });
  assert.deepEqual(r, { files: [], stat: "" });
});

test("collectDiffEvidence：首次失败隔 300ms 重试成功 → 返回真实基线", async () => {
  let n = 0;
  const r = await collectDiffEvidence("/tmp/ws", { spawnImpl: stubGitSpawn(() => (n++ === 0 ? { code: 128, out: "" } : { code: 0, out: " M a.mjs\n" })) });
  assert.deepEqual(r.files, ["M a.mjs"]);
});

test("evidenceComment：基线为 0 条也必须显式写「执行前基线已有 0 条改动」", () => {
  const body = evidenceComment({ identifier: "p1-1" }, {
    ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0, durationMs: 1000, stdout: "", stderr: "",
    baseline: "ok", diff: { files: [" M src/a.mjs"], baselineFiles: 0, stat: "" },
  });
  assert.match(body, /执行前基线已有 0 条改动/);
  assert.doesNotMatch(body, /无法取得执行前基线/);
});

test("evidenceComment：基线不可得 → 必须显式告警「无法取得执行前基线」", () => {
  const body = evidenceComment({ identifier: "p1-1" }, {
    ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0, durationMs: 1000, stdout: "", stderr: "",
    baseline: "unavailable", diff: { files: [" M 历史脏改动.mjs"], baselineFiles: null, stat: "" },
  });
  assert.match(body, /无法取得执行前基线/);
  assert.match(body, /人工甄别/);
  assert.doesNotMatch(body, /已剔除/, "基线不可得时不得声称已剔除");
});

test("runCliExecutor：git 非零退出 → 退到文件快照 baseline:'fs'（不再无谓告警）", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  // git 一律非零退出（模拟非 git 目录 / index.lock 抢占 / 超时）
  const spawnImpl = (cmd, args, opts) => (cmd === "git"
    ? stubGitSpawn(() => ({ code: 128, out: "" }))(cmd, args, opts)
    : spawn(cmd, args, opts));
  const r = await runCliExecutor({
    task: t, project: store.getProject("p1"), executor: { id: "cli:claude", cli: "claude" },
    settings: null, spawnImpl, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin }, now: () => 0,
  });
  assert.equal(r.baseline, "fs", "git 拿不到 → 用文件快照兜底，而不是直接认输");
  assert.equal(r.diff?.mode, "fs");
  const body = evidenceComment(t, r);
  assert.doesNotMatch(body, /无法取得执行前基线/, "有快照兜底时不得再喊「拿不到基线」");
  assert.doesNotMatch(body, /无法判定/, "快照对比成功 → 有无改动是能判定的");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ---- 证据假阴性修复（2026-10-18 真机复现：非 git 工作区里写出了文件却报「改动：无」）---- */

/** 桩 CLI：往**工作区内**写文件（复现真机场景），并打印一行输出。 */
function stubCliWritingInto(targetDir, files = { "new-file.mjs": "export const x = 1;\n" }) {
  const file = path.join(os.tmpdir(), `cli-stub-ws-${Math.random().toString(36).slice(2)}`);
  const lines = ["#!/bin/sh", "cat > /dev/null"];
  for (const [rel, content] of Object.entries(files)) lines.push(`printf '%s' '${content.replace(/'/g, "'\\''")}' > "${targetDir}/${rel}"`);
  lines.push(`echo "stub: 已写入工作区"`, "exit 0");
  writeFileSync(file, lines.join("\n"), { mode: 0o755 });
  chmodSync(file, 0o755);
  return file;
}

test("runCliExecutor：非 git 工作区里真写了文件 → 必须如实列出（不得报「改动：无」）", async () => {
  const { store, t, dir, ws } = setup();
  const bin = stubCliWritingInto(ws, { "range.mjs": "export const sumRange = (a, b) => 0;\n", "range.test.mjs": "// t\n" });
  const r = await runCliExecutor({
    task: t, project: store.getProject("p1"), executor: { id: "cli:claude", cli: "claude" },
    settings: null, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.diff?.mode, "fs");
  assert.deepEqual([...r.diff.files].sort(), ["range.mjs", "range.test.mjs"]);
  const body = evidenceComment(t, r);
  assert.match(body, /本次工作区改动（2）/);
  assert.match(body, /range\.mjs/);
  assert.match(body, /对比方式：文件快照/);
  assert.doesNotMatch(body, /本次工作区改动：无/, "有真实产出时绝不能说「无」");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("evidenceComment：算不出改动（diff=null）→ 必须写「无法判定」，不得写「无」", () => {
  const body = evidenceComment({ identifier: "p1-1" }, {
    ok: true, executorId: "cli:claude", cli: "claude", cwd: "/w", exitCode: 0, durationMs: 1000, stdout: "", stderr: "",
    baseline: "unavailable", diff: null,
  });
  assert.match(body, /本次工作区改动：\*\*无法判定\*\*/);
  assert.match(body, /是否落盘改动无法判定/);
  assert.doesNotMatch(body, /本次工作区改动：无/, "判不出来 ≠ 没有改动");
});

test("snapshotWorkspace / snapshotDelta：新增与修改都能识别，且没有基线时不冒充本次产出", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-snap-"));
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  writeFileSync(path.join(dir, "a.mjs"), "a");
  const before = await snapshotWorkspace(dir);
  assert.deepEqual([...before.keys()], ["a.mjs"]);
  writeFileSync(path.join(dir, "sub", "b.mjs"), "b");
  await new Promise((r) => setTimeout(r, 12));
  writeFileSync(path.join(dir, "a.mjs"), "a-changed");
  const after = await snapshotWorkspace(dir);
  assert.deepEqual([...snapshotDelta(before, after).files].sort(), ["a.mjs", "sub/b.mjs"]);
  assert.equal(snapshotDelta(before, after).baselineFiles, 1);
  assert.equal(snapshotDelta(null, after), null, "没有执行前快照 → 必须 null，不许拿全量冒充本次产出");
  rmSync(dir, { recursive: true, force: true });
});

test("API：exec-cli 先认领任务（todo → 进行中 + 开尝试记录），完成后回流「待验收」", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  process.env.TB_CLI_EXECUTOR_BIN = bin;
  try {
    assert.equal(store.requireTaskRef(t.identifier).status, "todo");
    const r = await createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body: {} });
    assert.equal(r.payload.ran, true);
    assert.equal(r.payload.claim?.claimed, true, "同步回包也要带认领语义（与 ?async=1 分支同一字段；验证台据此断言认领）");
    assert.equal(r.payload.claim?.note, "authorized", "todo 卡走授权门认领");
    const after = store.requireTaskRef(t.identifier);
    assert.equal(after.status, "in_review");
    const runs = store.listTaskRuns(after);
    assert.equal(runs.length, 1, "手工执行也必须留下一条尝试记录（真实落盘）");
    assert.equal(runs[0].outcome, "success");
    assert.equal(after.sessionId ?? null, null, "手工 CLI 执行不伪造执行会话");
  } finally { delete process.env.TB_CLI_EXECUTOR_BIN; }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("API（旧）：项目未配 CLI 执行器时的报错保持稳定", async () => {
  const { store, t } = setup();
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", roles: [{ role: "engineer", executor: "hosted" }] } });
  await assert.rejects(
    () => createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body: {} }),
    (e) => e.code === "NO_CLI_EXECUTOR",
  );
  store.close();
});

test("API（FR-40 归因门 · 2026-10-22 补口）：未归因卡交给 CLI 执行器 → 拦下，且**不起子进程、不留痕**", async () => {
  const { store, dir } = setup();
  const orphan = store.createTask({ projectId: "p1", title: "未归因卡", status: "todo" });
  const bin = stubCli(dir);
  process.env.TB_CLI_EXECUTOR_BIN = bin;
  try {
    await assert.rejects(
      () => createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${orphan.identifier}/exec-cli`, searchParams: sp(), body: {} }),
      (e) => e.code === "EXECUTION_NOT_ATTRIBUTED",
      "CLI 执行器是第三条执行入口，归因门必须同样拦住它",
    );
    // 门判定必须**先于副作用**：这条断言就是缺口本身的回归防线
    // （缺口期：路由只判人工校验门 → claimForCliExecution 把失败吞进 outcome.note → 子进程照样真跑）。
    assert.equal(existsSync(path.join(dir, "changed.txt")), false, "被拒时不许起子进程（替身脚本一次都没执行）");
    assert.equal(existsSync(path.join(dir, "stdin.txt")), false, "连 stdin 都不该被喂");
    assert.equal(store.requireTaskRef(orphan.identifier).status, "todo", "被拒后状态原地不动");
    assert.equal(store.listTaskRuns(orphan.identifier).length, 0, "被拒后不留执行痕迹（尝试记录 0）");
  } finally { delete process.env.TB_CLI_EXECUTOR_BIN; }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("API（FR-40）：dryRun 预览不被归因门挡住（只回计划、零副作用）", async () => {
  const { store, dir } = setup();
  const orphan = store.createTask({ projectId: "p1", title: "未归因卡 2", status: "todo" });
  const bin = stubCli(dir);
  process.env.TB_CLI_EXECUTOR_BIN = bin;
  try {
    const r = await createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${orphan.identifier}/exec-cli`, searchParams: sp("dryRun=1"), body: {} });
    assert.equal(r.payload.dryRun, true, "预览只回计划（真值：dryRun 分支在门之前返回）");
    assert.equal(r.payload.plan.executor, "cli:claude");
    assert.equal(existsSync(path.join(dir, "changed.txt")), false, "预览绝不执行");
    assert.equal(store.requireTaskRef(orphan.identifier).status, "todo");
    assert.equal(store.listTaskRuns(orphan.identifier).length, 0);
  } finally { delete process.env.TB_CLI_EXECUTOR_BIN; }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ============================================================================
 * 真机 `-122` 两个缺陷的回归防线（2026-10-22）
 *   A. 证据漏报：脏仓库里「改的正是本来就脏的文件」会被行级差集吃掉。
 *   B. 长跑无心跳：CLI 子进程在跑却被看护判「疑似停滞」，主按钮变「退回待办」。
 * ========================================================================== */

/** 造一个**真实 git 工作区**（已有提交），用于复现"开跑前就脏"的真机前提。 */
function gitWorkspace(dir) {
  const ws = path.join(dir, "gitws");
  mkdirSync(ws, { recursive: true });
  const git = (...args) => spawnSync("git", ["-C", ws, ...args], { encoding: "utf8" });
  git("init");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(ws, "tracked.mjs"), "export const x = 1;\n");
  writeFileSync(path.join(ws, "clean.mjs"), "export const y = 1;\n");
  git("add", ".");
  git("commit", "-m", "init");
  return { ws, git };
}

test("缺陷A：脏仓库里改**本来就脏**的文件 → 证据清单必须列出它（行级差集不得吃掉内容改动）", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-cli-dirty-"));
  const { ws } = gitWorkspace(dir);
  // ① 开跑前先手工把 tracked.mjs 改成「已修改」并**留在工作区**（真机前提：181 项历史脏改动）
  writeFileSync(path.join(ws, "tracked.mjs"), "export const x = 1;\n// 执行前的历史脏改动\n");
  const { store, t } = setup({ workspacePath: ws });
  // ② 桩 CLI 改**同一个**文件（+ 另建一个新文件，验证原有口径没坏）
  const bin = stubCliWritingInto(ws, { "tracked.mjs": "export const x = 1;\n// 执行前的历史脏改动\nexport const toolSurface = 9;\n", "brand-new.mjs": "// 新\n" });

  const r = await runCliExecutor({
    task: t, project: store.getProject("p1"), executor: { id: "cli:claude", cli: "claude" },
    settings: null, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin },
  });
  assert.equal(r.exitCode, 0);
  assert.equal(r.diff?.mode, "git");
  const files = (r.diff?.files ?? []).map((f) => f.replace(/^\s*\S+\s+/, "").replace(/^"|"$/g, ""));
  assert.ok(files.includes("tracked.mjs"), `本来就脏 + 本次被改的文件必须在清单里（实得 ${JSON.stringify(r.diff?.files)}）`);
  assert.ok(files.includes("brand-new.mjs"), "本次新增的文件按原口径照样在清单里");
  const body = evidenceComment(t, r);
  assert.match(body, /tracked\.mjs/, "证据评论必须能看到主产出");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("缺陷A 红线：执行前的历史脏改动**不得**被当成本次产出（FR-74 不回退）", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-cli-dirty2-"));
  const { ws, git } = gitWorkspace(dir);
  // 开跑前弄脏两个文件；执行器**一个都不碰**
  writeFileSync(path.join(ws, "tracked.mjs"), "export const x = 1;\n// 历史脏\n");
  writeFileSync(path.join(ws, "clean.mjs"), "export const y = 1;\n// 历史脏 2\n");
  git("status", "--porcelain"); // 确认确实脏
  const { store, t } = setup({ workspacePath: ws });
  const bin = stubCliWritingInto(ws, { "only-new.mjs": "// 只有这个是本次产出\n" });

  const r = await runCliExecutor({
    task: t, project: store.getProject("p1"), executor: { id: "cli:claude", cli: "claude" },
    settings: null, env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin },
  });
  const files = (r.diff?.files ?? []).map((f) => f.replace(/^\s*\S+\s+/, "").replace(/^"|"$/g, ""));
  assert.ok(files.includes("only-new.mjs"));
  assert.equal(files.includes("tracked.mjs"), false, "没被本次碰过的历史脏改动不得列入");
  assert.equal(files.includes("clean.mjs"), false, "没被本次碰过的历史脏改动不得列入");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("缺陷A（纯函数）：diffDelta 用内容指纹认「本来就脏 + 内容变了」，且不误列未变的脏条目", () => {
  const before = {
    files: [" M tracked.mjs", " M clean.mjs"],
    hashes: new Map([["tracked.mjs", "aaa"], ["clean.mjs", "bbb"]]),
    stat: "",
  };
  const after = {
    files: [" M tracked.mjs", " M clean.mjs", "?? brand-new.mjs"],
    hashes: new Map([["tracked.mjs", "zzz"], ["clean.mjs", "bbb"]]), // tracked 变了、clean 没变
    stat: "x",
  };
  const d = diffDelta(before, after);
  const paths = d.files.map((f) => f.replace(/^\s*\S+\s+/, "")).sort();
  assert.deepEqual(paths, ["brand-new.mjs", "tracked.mjs"], "内容变了的脏条目 + 本次新增，其余不列");
  assert.equal(d.baselineFiles, 2);
  // 没有指纹（旧调用方 / 算不出）→ 完全退回原行级口径（零行为变化）
  const legacy = diffDelta({ files: before.files, stat: "" }, { files: after.files, stat: "x" });
  assert.deepEqual(legacy.files, ["?? brand-new.mjs"], "无指纹时不认内容改动（宁漏不滥）");
});

test("缺陷B：CLI 子进程存活期间 → watchdog 不得判 stalled、claim 不得 stale、「退回待办」不得是主按钮", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-cli-heartbeat-"));
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const item = store.createRequirementItem({ projectId: "p1", title: "R-HB" });
  const t = store.createTask({ projectId: "p1", title: "长跑卡", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.saveProjectSettings("p1", { teamTemplate: { engine: "instruction", roles: [{ role: "engineer", executor: "cli:claude" }] } });
  // 时间轴由测试掌控：`now` 走假钟，便于把"跑过阈值"这件事压到秒级
  let clock = Date.UTC(2026, 9, 22, 0, 0, 0);
  const now = () => clock;
  const bin = stubCli(dir, { sleepSec: 3 }); // 真睡 3s，期间假钟可推进到远超阈值
  const router = createApiRouter({ store });

  store.startTaskExecution(t.identifier, { sessionId: null }); // 如实：CLI 路径 sessionId 恒为 null
  process.env.TB_CLI_EXECUTOR_BIN = bin;
  try {
    const running = executeTaskWithCli({
      store, task: store.requireTaskRef(t.identifier), project: store.getProject("p1"),
      env: { ...process.env }, now, timeoutMs: 60_000,
    });
    // 等子进程真起来 + 头几次心跳落库
    await new Promise((r) => setTimeout(r, 900));
    // 把假钟推进到**远超**停滞阈值（真机现场正是 11.5 分钟无进展）
    clock += 12 * 60 * 1000;

    const exec = await router.route({ method: "GET", pathname: `/api/tasks/${t.identifier}/execution`, searchParams: sp() });
    assert.equal(exec.payload.watchdog.state !== "stalled", true, `在途不得判 stalled（实得 ${exec.payload.watchdog.state}/${exec.payload.watchdog.reason}）`);
    assert.equal(exec.payload.claim.stale, false, "在途认领心跳必须新鲜（claim.stale 不得为 true）");
    const diag = (exec.payload.diagnostics ?? []).find((d) => d.kind === "stalled");
    assert.equal(diag, undefined, "不得产出 stalled 诊断（更不得 high）");
    // 主按钮口径：stalled 诊断的首选动作就是「退回待办（重新派发）」——它不该出现
    assert.equal((exec.payload.diagnostics ?? []).some((d) => /退回待办/.test(JSON.stringify(d.actions ?? []))), false,
      "「退回待办（重新派发）」不得出现在动作集里（否则一点就与在写的子进程并发）");

    const out = await running;
    assert.equal(out.result.ok, true);
    // ③ 子进程结束后：状态如实回落到既有口径（成功 → 待验收），且心跳**停止**（不新增常驻心跳）
    assert.equal(store.requireTaskRef(t.identifier).status, "in_review");
    assert.equal(store.getCurrentRun(store.requireTaskRef(t.identifier)), null, "尝试已闭合：在途信号自然消失");
    assert.equal(store.requireTaskRef(t.identifier).lastHeartbeatAt ?? null, null, "成功收尾后不残留常驻心跳");
  } finally { delete process.env.TB_CLI_EXECUTOR_BIN; }
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("缺陷B（纯函数）：runInFlight 只认「在跑 + 心跳新鲜」；心跳陈旧即失效", () => {
  const now = Date.UTC(2026, 9, 22, 0, 0, 0);
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  assert.equal(runInFlight(null, { now }), false);
  assert.equal(runInFlight({ status: "ended", lastHeartbeatAt: iso(0) }, { now }), false, "已闭合的尝试不算在途");
  assert.equal(runInFlight({ status: "running", lastHeartbeatAt: iso(30_000) }, { now }), true, "心跳新鲜 → 在途");
  assert.equal(runInFlight({ status: "running", lastHeartbeatAt: iso(11 * 60_000) }, { now }), false, "心跳陈旧 → 不再算在途（子进程真死了要照实报停滞）");
  assert.equal(runInFlight({ status: "running", startedAt: iso(11 * 60_000) }, { now }), false, "无心跳字段时用 startedAt 兜底");
});

test("缺陷B（看护）：会话不可判 + 尝试心跳新鲜 → running；会话可判时仍只认会话（不干扰原口径）", () => {
  const now = Date.UTC(2026, 9, 22, 0, 0, 0);
  const comments = [{ body: "进度：跑到一半", createdAt: new Date(now - 30 * 60_000).toISOString() }];
  const base = { status: "in_progress", updatedAt: new Date(now - 30 * 60_000).toISOString() };
  const liveRun = { status: "running", lastHeartbeatAt: new Date(now - 30_000).toISOString() };
  // CLI 路径：sessionState.sessionId 为 null（会话不可判）→ 用尝试心跳兜底
  const cliPath = assessTask({ task: base, comments, sessionState: { sessionId: null, live: false, running: false }, currentRun: liveRun, now });
  assert.equal(cliPath.state, "running", "CLI 在途不得判停滞");
  // 会话路径：有 sessionId 就只看会话（尝试记录没闭合是常态，不能据此报"在跑"）
  const sessPath = assessTask({ task: base, comments, sessionState: { sessionId: "s1", live: true, running: false }, currentRun: liveRun, now });
  assert.equal(sessPath.state, "stalled", "有会话时原口径不变（会话空闲 + 超阈值 = 停滞）");
});

// ---------------------------------------------------------------------------------------
// 2026-10-26 补口：**参数不允许写文件 ⇒ 退出码 0 但零产出**的静默空转
// （真机实测：裸 `claude -p` 不带 `--permission-mode acceptEdits` 即写入被拒、零产出、退出码 0）
// ---------------------------------------------------------------------------------------

test("argsAllowEdits / isBlindRun：判据保守 —— 不猜 CLI 默认值、不拿「判不出来」冒充「没改」", () => {
  // 未覆盖 ⇒ 走默认（默认参数里就有 acceptEdits）⇒ 允许写，不制造噪音
  assert.equal(argsAllowEdits([]), true);
  assert.equal(argsAllowEdits(null), true);
  assert.equal(argsAllowEdits(cliArgsFor({ executorId: "cli:claude", cwd: "/tmp/ws", settings: null })), true, "产品默认参数必须自己就是安全的");
  assert.equal(argsAllowEdits(["-p", "--permission-mode", "acceptEdits"]), true);
  assert.equal(argsAllowEdits(["-p", "--permission-mode=acceptEdits"]), true);
  assert.equal(argsAllowEdits(["-p", "--permission-mode", "bypassPermissions"]), true);
  assert.equal(argsAllowEdits(["-p", "--dangerously-skip-permissions"]), true);
  assert.equal(argsAllowEdits(["-p", "--permission-mode", "plan"]), false, "plan 模式不写文件");
  assert.equal(argsAllowEdits(["-p"]), false);

  const blind = { ok: true, argsAllowsEdits: false, diff: { files: [] } };
  assert.equal(isBlindRun(blind), true);
  assert.equal(isBlindRun({ ...blind, ok: false }), false, "进程失败走既有失败路径，不叠判");
  assert.equal(isBlindRun({ ...blind, argsAllowsEdits: true }), false, "允许写文件时的零改动属正常（可能本就不需要改代码）");
  assert.equal(isBlindRun({ ...blind, argsAllowsEdits: null }), false, "结果未知 ⇒ 不判");
  assert.equal(isBlindRun({ ...blind, diff: null }), false, "算不出改动 ⇒ 不得断言「没改」");
  assert.equal(isBlindRun({ ...blind, diff: { files: ["a.mjs"] } }), false, "有改动就不是空转");
  assert.equal(isBlindRun({ ...blind, diff: {} }), true, "files 缺省视为空（与证据评论同一口径）");
  assert.equal(isBlindRun(null), false);
});

test("executeTaskWithCli：参数不允许写文件 ⇒ 零产出**不得**记成功、**不得**进「待验收」", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const settings = settingsWithRoles([{ role: "engineer", executor: "cli:claude" }], { engineer: { args: ["-p"] } });
  const out = await executeTaskWithCli({
    store, task: store.requireTaskRef(t.identifier), project: store.getProject("p1"), settings,
    env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin },
  });
  assert.equal(out.result.exitCode, 0, "桩以 0 退出（真机实测：写入被拒同样是退出码 0）");
  assert.equal(out.result.argsSource, "override");
  assert.equal(out.result.argsAllowsEdits, false);
  assert.equal(isBlindRun(out.result), true);
  const after = store.requireTaskRef(t.identifier);
  assert.notEqual(after.status, "in_review", "零产出**不得**推进「待验收」");
  assert.equal(after.status, "blocked", "要走统一受阻入口，让人看得见");
  // 2026-10-26 更正：同上 —— 原期望 `capability` 是照抄了硬编码的错分类。语义上「参数未允许写文件」
  // 属于**需要人去改设置**（原样重试必然再失败），故现按 `needs_input` 分类。
  assert.equal(after.blockKind, "needs_input");
  const run = store.listTaskRuns(after)[0];
  assert.equal(run.outcome, "failed", "尝试记录**不得**记 success");
  assert.match(String(run.summary), /未允许写文件/);
  const bodies = store.listComments(after.id).map((c) => c.body);
  assert.ok(bodies.some((b) => /未包含任何「允许写文件」的权限模式/.test(b)), "证据评论必须显式告警");
  assert.ok(bodies.some((b) => /\*\*判定\*\*：停下（参数未允许写文件/.test(b)), "判定节不得写「完成」");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("executeTaskWithCli：默认参数下零改动**仍按成功**（不误伤「本来就不需要改代码」的任务）", async () => {
  const { store, t, dir } = setup();
  const bin = stubCli(dir);
  store.startTaskExecution(t.identifier, { sessionId: "s1" });
  const out = await executeTaskWithCli({
    store, task: store.requireTaskRef(t.identifier), project: store.getProject("p1"),
    env: { ...process.env, TB_CLI_EXECUTOR_BIN: bin },
  });
  assert.equal(out.result.argsSource, "default");
  assert.equal(out.result.argsAllowsEdits, true, "默认参数含 acceptEdits");
  assert.equal(isBlindRun(out.result), false, "允许写文件时的零改动不许判成空转");
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "in_review");
  assert.equal(store.listTaskRuns(after)[0].outcome, "success");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
