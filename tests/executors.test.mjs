/**
 * 卡 `-238`（需求 `R174`）：**执行者注册表 + 按卡选择执行者**。
 *
 * 这一组守的是三件事：
 *   ① 注册表是**唯一真源** —— 5 项齐全、每项 `buildArgs` 是**真机 `--help` 读出来的形状**（不是猜的）；
 *   ② 三种「选不了」**分得开**（未知 / 未安装 / 被项目禁用），且都不绕过既有门；
 *   ③ 不传 `executor` 时**零回归** —— 老路径仍由 `teamTemplate.roles[].executor` 决定。
 *
 * **不真跑 codex / hermes**：只验参数形状与错误码（真跑属真机验证，见轮次记录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { argsAllowEdits } from "../src/core/executor.mjs";
import {
  EXECUTOR_KINDS, EXECUTOR_SPECS, buildExecutorArgs, detectBinary, executorSearchDirs,
  findExecutorSpec, isExecutorForbidden, listExecutors, normalizeExecutorId, resetExecutorDetectCache,
} from "../src/core/executors.mjs";

const sp = (qs = "") => new URLSearchParams(qs);

const TEMPS = [];
process.on("exit", () => {
  for (const p of TEMPS) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
});

function setup({ forbiddenExecutors = [], executionTeam = "official:official", roles = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-executors-"));
  TEMPS.push(dir);
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  store.saveProjectSettings("p1", {
    teamTemplate: {
      engine: "instruction",
      executionTeam,
      roles: roles ?? [{ role: "engineer", count: 1, executor: "cli:claude" }],
      forbiddenExecutors,
    },
  });
  return { store, t, dir, ws };
}

// ── ① 注册表 ────────────────────────────────────────────────────────────────

test("注册表：5 项齐全，id / agent / kind 与「四条通道」一一对应（团队·宿主·三 CLI）", () => {
  assert.deepEqual(EXECUTOR_SPECS.map((s) => s.id), ["team", "host:dsh", "cli:claude", "cli:codex", "cli:hermes"]);
  assert.deepEqual(EXECUTOR_SPECS.map((s) => s.agent), ["team", "dsh", "claude", "codex", "hermes"]);
  assert.deepEqual(EXECUTOR_SPECS.map((s) => s.kind), [
    EXECUTOR_KINDS.TEAM, EXECUTOR_KINDS.HOST_SESSION,
    EXECUTOR_KINDS.CLI, EXECUTOR_KINDS.CLI, EXECUTOR_KINDS.CLI,
  ]);
  // dsh **不是** CLI：它没有 oneshot 入口（`dsh [--profile] <name>` 是启动宿主），只能走宿主会话。
  assert.equal(findExecutorSpec("dsh").kind, EXECUTOR_KINDS.HOST_SESSION);
  assert.equal(buildExecutorArgs(findExecutorSpec("dsh"), { cwd: "/tmp" }), null, "宿主会话不 spawn 子进程 ⇒ 没有 CLI 参数");
  assert.equal(buildExecutorArgs(findExecutorSpec("team"), { cwd: "/tmp" }), null);
});

test("id 归一：全标识与裸 agent 名都认；认不出原样返回（交给路由判「未知」）", () => {
  assert.equal(normalizeExecutorId("codex"), "cli:codex");
  assert.equal(normalizeExecutorId("cli:codex"), "cli:codex");
  assert.equal(normalizeExecutorId("claude"), "cli:claude");
  assert.equal(normalizeExecutorId("dsh"), "host:dsh");
  assert.equal(normalizeExecutorId("team"), "team");
  assert.equal(normalizeExecutorId("  hermes  "), "cli:hermes");
  assert.equal(normalizeExecutorId("nope"), "nope");
  assert.equal(normalizeExecutorId(""), null);
  assert.equal(normalizeExecutorId(null), null);
});

// ── ② 参数形状（真机 `--help` 读出来的，不是猜的）────────────────────────────

test("参数：codex = `exec -s workspace-write -C <cwd> -`（prompt 走 stdin，`-` 显式声明）", () => {
  const spec = findExecutorSpec("cli:codex");
  const args = buildExecutorArgs(spec, { cwd: "/tmp/ws", prompt: "不该出现在 argv 里" });
  assert.deepEqual(args, ["exec", "-s", "workspace-write", "-C", "/tmp/ws", "-"]);
  assert.equal(spec.promptVia, "stdin");
  assert.ok(!args.includes("不该出现在 argv 里"), "codex 的指令走 stdin，不进 argv");
  assert.equal(argsAllowEdits(args), true, "workspace-write 必须被认成「允许写」——否则零改动会被误判成盲跑");
});

test("参数：hermes = `-z <prompt> --in <cwd> --yolo`（该 CLI 单次入口不吃 stdin）", () => {
  const spec = findExecutorSpec("cli:hermes");
  const args = buildExecutorArgs(spec, { cwd: "/tmp/ws", prompt: "完成 p1-1" });
  assert.deepEqual(args, ["-z", "完成 p1-1", "--in", "/tmp/ws", "--yolo"]);
  assert.equal(spec.promptVia, "argv");
  assert.equal(argsAllowEdits(args), true, "--yolo 是显式跳审批，必须被认成「允许写」");
});

test("参数：claude 复用既有 cliArgsFor（含 --permission-mode acceptEdits / --add-dir / engineer.args 覆盖）", () => {
  const spec = findExecutorSpec("claude");
  const args = buildExecutorArgs(spec, { cwd: "/tmp/ws", settings: null });
  assert.equal(args[0], "-p");
  assert.ok(args.includes("acceptEdits"));
  assert.ok(args.includes("--add-dir") && args.includes("/tmp/ws"));
  const overridden = buildExecutorArgs(spec, {
    cwd: "/tmp/ws",
    settings: { teamTemplate: { engineer: { args: ["-p", "--permission-mode", "plan"] } } },
  });
  assert.deepEqual(overridden, ["-p", "--permission-mode", "plan"]);
  assert.equal(argsAllowEdits(overridden), false, "只读覆盖必须被判成「不允许写」——这条判据对三种 CLI 都成立");
});

test("参数：只读写法不得被认成「允许写」（判据不能放宽成恒真）", () => {
  assert.equal(argsAllowEdits(["exec", "-s", "read-only", "-C", "/tmp"]), false);
  assert.equal(argsAllowEdits([]), true, "空 = 未覆盖，走默认（默认含 acceptEdits）");
});

// ── ③ 可用性判定（三处「不可用」必须分开说）─────────────────────────────────

const fakeProbe = (missing = []) => (command) => (
  missing.includes(command)
    ? { installed: false, binPath: null, searched: ["/nonexistent"] }
    : { installed: true, binPath: `/fake/bin/${command}`, searched: ["/fake/bin"] }
);

test("可用性：未安装 ⇒ usable=false 且 reason 点名命令；其余照旧可用", async () => {
  const list = await listExecutors({
    settings: { teamTemplate: { executionTeam: "official:official", forbiddenExecutors: [] } },
    hostSessionAvailable: true, teamAvailable: true,
    detect: fakeProbe(["codex"]), withVersion: false,
  });
  const codex = list.find((e) => e.id === "cli:codex");
  assert.equal(codex.installed, false);
  assert.equal(codex.usable, false);
  assert.match(codex.reason, /未检测到 codex/);
  assert.equal(list.find((e) => e.id === "cli:claude").usable, true);
  // 未安装的是**那一个**，不许顺带把别人也关掉
  assert.equal(list.filter((e) => e.usable).length, 4);
});

test("可用性：项目 forbiddenExecutors 命中 ⇒ blocked 且优先级最高（装了也不可用）", async () => {
  const list = await listExecutors({
    settings: { teamTemplate: { executionTeam: "official:official", forbiddenExecutors: ["cli:claude", "codex"] } },
    hostSessionAvailable: true, teamAvailable: true,
    detect: fakeProbe(), withVersion: false,
  });
  const claude = list.find((e) => e.id === "cli:claude");
  assert.equal(claude.installed, true, "装了");
  assert.equal(claude.blocked, true, "但项目禁了");
  assert.equal(claude.usable, false);
  assert.match(claude.reason, /forbiddenExecutors/);
  // 裸 agent 名命中同一份禁用清单
  assert.equal(list.find((e) => e.id === "cli:codex").usable, false);
  assert.equal(isExecutorForbidden(findExecutorSpec("claude"), { teamTemplate: { forbiddenExecutors: ["claude"] } }), true);
});

test("可用性：通道不成立 ⇒ 团队/宿主各自不可用；判不准（null）时按可用处理，不冒充不可用", async () => {
  const off = await listExecutors({
    settings: { teamTemplate: { executionTeam: "", forbiddenExecutors: [] } },
    hostSessionAvailable: false, teamAvailable: false,
    detect: fakeProbe(), withVersion: false,
  });
  assert.equal(off.find((e) => e.id === "team").usable, false);
  assert.match(off.find((e) => e.id === "team").reason, /executionTeam/);
  assert.equal(off.find((e) => e.id === "host:dsh").usable, false);
  assert.match(off.find((e) => e.id === "host:dsh").reason, /宿主会话通道/);

  const unknown = await listExecutors({
    settings: { teamTemplate: { forbiddenExecutors: [] } },
    hostSessionAvailable: null, teamAvailable: null,
    detect: fakeProbe(), withVersion: false,
  });
  assert.equal(unknown.find((e) => e.id === "team").usable, true, "判不准不得谎报不可用");
  assert.equal(unknown.find((e) => e.id === "host:dsh").usable, true, "判不准不得谎报不可用");
});

test("探测：PATH 之外还要查 ~/.npm-global/bin 等常见目录（launchd 的 PATH 常常不全）", () => {
  const dirs = executorSearchDirs({ env: { PATH: "/usr/bin:/bin", HOME: "/tmp/tb-home" } });
  assert.ok(dirs.includes("/usr/bin"));
  assert.ok(dirs.includes("/tmp/tb-home/.npm-global/bin"));
  assert.ok(dirs.includes("/tmp/tb-home/.local/bin"));
  assert.ok(dirs.includes("/opt/homebrew/bin"));
  // 真机探测：本机 claude 一定装着（装的话拿到的必须是**绝对路径**，供 spawn 直接用）
  resetExecutorDetectCache();
  const found = detectBinary("claude", { fresh: true });
  if (found.installed) assert.match(found.binPath, /^\//, "必须给绝对路径：launchd 的 PATH 问题靠它绕开");
});

// ── ④ HTTP：GET /api/executors ─────────────────────────────────────────────

test("GET /api/executors：返回 5 项 + defaultId（= 不换执行者时本来会走谁）+ 项目禁用态", async () => {
  const { store } = setup();
  const r = await createApiRouter({ store, executorProbe: fakeProbe() }).route({
    method: "GET", pathname: "/api/executors", searchParams: sp("projectId=p1"), body: undefined,
  });
  assert.equal(r.status, 200);
  assert.equal(r.payload.executors.length, 5);
  assert.equal(r.payload.projectId, "p1");
  // 项目 roles[].engineer.executor = cli:claude ⇒ 默认就是它（前端不自己猜配置）
  assert.equal(r.payload.defaultId, "cli:claude");
  for (const item of r.payload.executors) {
    for (const key of ["id", "agent", "kind", "label", "installed", "blocked", "usable"]) {
      assert.ok(key in item, `缺字段 ${key}（${item.id}）`);
    }
  }
  store.close();
});

test("GET /api/executors：项目禁掉的执行者在清单里就是 blocked（前端据此置灰，不靠点了才报错）", async () => {
  const { store } = setup({ forbiddenExecutors: ["cli:codex"] });
  const r = await createApiRouter({ store, executorProbe: fakeProbe() }).route({
    method: "GET", pathname: "/api/executors", searchParams: sp("projectId=p1"), body: undefined,
  });
  const codex = r.payload.executors.find((e) => e.id === "cli:codex");
  assert.equal(codex.blocked, true);
  assert.equal(codex.usable, false);
  // claude 仍可用 ⇒ defaultId 不会被禁令带偏
  assert.equal(r.payload.defaultId, "cli:claude");
  store.close();
});

// ── ⑤ HTTP：exec-cli 的三种拒绝 ────────────────────────────────────────────

const execCli = (router, t, body) => router.route({
  method: "POST", pathname: `/api/tasks/${t.identifier}/exec-cli`, searchParams: sp(), body,
});

test("exec-cli：未知执行者 ⇒ EXECUTOR_UNKNOWN（列出可用 id，不含糊）", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  await assert.rejects(() => execCli(router, t, { executor: "cli:nope", dryRun: true }), (error) => {
    assert.equal(error.code, "EXECUTOR_UNKNOWN");
    assert.match(error.message, /cli:claude/);
    return true;
  });
  store.close();
});

test("exec-cli：未安装 ⇒ EXECUTOR_NOT_INSTALLED（点名命令与已查目录）", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe(["hermes"]) });
  await assert.rejects(() => execCli(router, t, { executor: "cli:hermes", dryRun: true }), (error) => {
    assert.equal(error.code, "EXECUTOR_NOT_INSTALLED");
    assert.match(error.message, /hermes/);
    assert.ok(Array.isArray(error.details?.searched));
    return true;
  });
  store.close();
});

test("exec-cli：项目禁用 ⇒ EXECUTOR_FORBIDDEN（优先于「装没装」）", async () => {
  const { store, t } = setup({ forbiddenExecutors: ["cli:codex"] });
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  await assert.rejects(() => execCli(router, t, { executor: "cli:codex", dryRun: true }), (error) => {
    assert.equal(error.code, "EXECUTOR_FORBIDDEN");
    return true;
  });
  store.close();
});

test("exec-cli：选了非 CLI 形态 ⇒ EXECUTOR_NOT_CLI 并指路正确入口（不静默改成别的通道）", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  await assert.rejects(() => execCli(router, t, { executor: "team", dryRun: true }), (error) => {
    assert.equal(error.code, "EXECUTOR_NOT_CLI");
    assert.match(error.message, /\/api\/teams/);
    return true;
  });
  await assert.rejects(() => execCli(router, t, { executor: "dsh", dryRun: true }), (error) => {
    assert.equal(error.code, "EXECUTOR_NOT_CLI");
    assert.match(error.message, /\/execute/);
    return true;
  });
  store.close();
});

// ── ⑥ dryRun 计划：按卡选执行者真的改变要跑什么 ─────────────────────────────

test("exec-cli dryRun：选 codex ⇒ plan.args 是 codex 的形状（`exec` / `-C <cwd>` / `-s workspace-write`）", async () => {
  const { store, t, ws } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  const r = await execCli(router, t, { executor: "cli:codex", dryRun: true });
  assert.equal(r.status, 200);
  assert.equal(r.payload.dryRun, true);
  assert.equal(r.payload.plan.executor, "cli:codex");
  assert.equal(r.payload.plan.promptVia, "stdin");
  const args = r.payload.plan.args;
  assert.equal(args[0], "exec");
  assert.ok(args.includes("-C") && args.includes(ws), "-C 后面必须是本卡的工作目录");
  assert.ok(args.includes("-s") && args.includes("workspace-write"));
  // dryRun 零副作用：卡状态没动
  assert.equal(store.requireTaskRef(t.identifier).status, "todo");
  store.close();
});

test("exec-cli dryRun：选 hermes ⇒ prompt 进 argv（promptVia=argv），且 plan.prompt 与本卡一致", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  const r = await execCli(router, t, { executor: "cli:hermes", dryRun: true });
  assert.equal(r.payload.plan.promptVia, "argv");
  assert.equal(r.payload.plan.args[0], "-z");
  assert.ok(r.payload.plan.args.includes(r.payload.plan.prompt), "hermes 的指令必须在 argv 里，否则它读不到");
  assert.match(r.payload.plan.prompt, new RegExp(t.identifier));
  store.close();
});

// ── ⑦ 零回归：不传 executor 时仍是项目配置那一个 ────────────────────────────

test("零回归：不传 executor ⇒ 仍走大 teamTemplate.roles[].executor（老路径），并标注 promptVia=stdin", async () => {
  const { store, t } = setup();
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  const r = await execCli(router, t, { dryRun: true });
  assert.equal(r.payload.plan.executor, "cli:claude", "老路径由项目配置决定");
  assert.equal(r.payload.plan.promptVia, "stdin");
  assert.equal(r.payload.plan.args[0], "-p", "老路径仍是 claude 那套参数（一字不动）");
  store.close();
});

test("零回归：项目没配 CLI 执行器 ⇒ 老错误码原样（NO_CLI_EXECUTOR，不静默换成别的通道）", async () => {
  const { store, t } = setup({ roles: [{ role: "engineer", count: 1, executor: "hosted" }] });
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  await assert.rejects(() => execCli(router, t, { dryRun: true }), (error) => {
    assert.equal(error.code, "NO_CLI_EXECUTOR");
    return true;
  });
  store.close();
});

test("零回归：按卡选执行者**不绕过归因门**（未归因 ⇒ 非 dryRun 仍被 EXECUTION_NOT_ATTRIBUTED 拦）", async () => {
  const { store } = setup();
  const loose = store.createTask({ projectId: "p1", title: "未归因", status: "todo" });
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  // dryRun 刻意宽松（只回计划、无副作用）——与老口径一致
  const preview = await execCli(router, loose, { executor: "cli:codex", dryRun: true });
  assert.equal(preview.status, 200);
  await assert.rejects(() => execCli(router, loose, { executor: "cli:codex" }), (error) => {
    assert.equal(error.code, "EXECUTION_NOT_ATTRIBUTED");
    return true;
  });
  // 门在副作用之前：卡状态必须没动、也没有认领
  assert.equal(store.requireTaskRef(loose.identifier).status, "todo");
  store.close();
});

test("零回归：按卡选执行者也**不绕过人工校验门**（human_review 卡连 dryRun 都拒）", async () => {
  const { store } = setup();
  // 人工校验门排在归因门**之前**，所以这张卡不需要关联需求条目（正是要证「先拦哪一道」）。
  const human = store.createTask({ projectId: "p1", title: "人工校验", status: "todo", labels: ["human_review"] });
  const router = createApiRouter({ store, executorProbe: fakeProbe() });
  await assert.rejects(() => execCli(router, human, { executor: "cli:codex", dryRun: true }), (error) => {
    assert.equal(error.code, "HUMAN_REVIEW_NOT_EXECUTABLE");
    return true;
  });
  store.close();
});

// ── ⑧ 前端接线（源码级守卫）：只守「结构在不在 + 谁驱动谁」，不冒充渲染证据 ────────────
// 真渲染要真 Chrome（沙箱内跑不了）⇒ 本组只证明「线接上了」，渲染结果的真机读数见轮次记录。

const readWeb = (name) => readFileSync(new URL(`../web/${name}`, import.meta.url), "utf8");

test("前端：执行者选择器是**一个**组件、接在**两处**（下一步 + CLI 区），不各写一套", () => {
  const app = readWeb("app.js");
  const defs = app.split("function mountExecutorPicker(").length - 1;
  assert.equal(defs, 1, "只能有一份实现（两处各写一套必然漂移）");
  const uses = app.split("mountExecutorPicker(t,").length - 1;
  assert.equal(uses, 2, "「下一步」与「CLI 执行器」两处都要用同一个组件");
  // CLI 区只放 CLI 形态：把「团队 / 宿主会话」摆进去只会点出必然的 400
  assert.match(app, /kinds: \["cli"\]/, "CLI 区必须只列 CLI 形态");
});

test("前端：CLI 区的「预览 / 执行」必须带上所选执行者（否则选了 codex 却在预览 claude）", () => {
  const app = readWeb("app.js");
  const preview = app.indexOf('{ dryRun: true, executor: cliPicker?.selected() ?? undefined }');
  const run = app.indexOf('{ async: true, executor: cliPicker?.selected() ?? undefined }');
  assert.ok(preview > 0, "预览必须带 executor");
  assert.ok(run > 0, "执行必须带 executor");
});

test("前端：不硬编码命令行（只认 /api/executors 的 id），也不引外部图标资源", () => {
  const app = readWeb("app.js");
  assert.match(app, /api\("GET", `\/api\/executors\?projectId=/, "清单必须来自服务端");
  for (const forbidden of ["codex exec ", "claude -p ", "hermes -z "]) {
    assert.ok(!app.includes(forbidden), `前端不得硬编码命令行（命中「${forbidden}」）：参数只该在服务端注册表里`);
  }
  // 图标是内联 SVG（createElementNS），不引图标字体/CDN
  assert.match(app, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg"/, "图标必须内联创建");
  assert.ok(!app.includes("cdn.") && !app.includes("iconfont"), "不得引外部图标资源");
});

test("前端：三态挂点稳定（data-exec-picker / data-executor / data-exec-blocked）且灰因可判", () => {
  const app = readWeb("app.js");
  assert.match(app, /setAttribute\("data-exec-picker", "1"\)/);
  assert.match(app, /button\.dataset\.executor = executor\.id/);
  assert.match(app, /button\.dataset\.execBlocked = /, "灰掉的原因要能机器读（unusable / gate / ok）");
  // 通道判据与既有入口同源：不另写一套状态判断
  assert.match(app, /const channelBlocker = \(executor\) => \{/);
  assert.match(app, /const entry = cliEntry\(task\);/, "CLI 通道判据必须复用 cliEntry");
  assert.match(app, /const entry = executionEntry\(task\);/, "宿主/团队通道判据必须复用 executionEntry");
});

test("样式：图标与选择器样式在位（currentColor 单色、圆角胶囊）", () => {
  const css = readWeb("tokens.css");
  assert.match(css, /\.tb-agent-icon \{[^}]*fill: currentColor/, "图标必须跟随文字色（深色主题不糊）");
  assert.match(css, /\.tb-drawer \.tb-exec-picker button\.tb-exec-choice:not\(\.link\)/, "选择器样式必须压过抽屉的通用按钮规则");
  assert.match(css, /\[aria-pressed="true"\]/, "选中态必须有可见差异（不只改 aria）");
});
