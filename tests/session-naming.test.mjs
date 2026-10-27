/**
 * FR-95 会话命名约束（2026-10-23 用户新增）· 口径单测 + 接线断言。
 *
 * 用户原话三条：① 由任务看板下发的会话统一「【任务】+ 任务标题 + 时间」；② 项目主会话统一
 * 「【项目】+ 项目名称」；**重载 / 重绑**的名称后跟备注；③ 其他会话（专属文档 / 修复 / 评审…）
 * 在任务会话约束基础上额外备注。
 *
 * 分两层钉：
 *   A. 领域层（纯函数）—— 字符串形状 / 备注 / 截断 / 时间无效 / 未知 kind **回 null 不臆造**。
 *   B. 接线层 —— 宿主 `create()` 不收 title ⇒ **建完必须 rename**，且**改名失败如实回报**；
 *      api 三个建会话点都带 title，任务执行会话同时补 `cwd`（否则落在进程目录）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  TASK_PREFIX, PROJECT_PREFIX, NOTE_KINDS,
  noteForKind, cleanLabel, formatStamp, taskSessionTitle, projectMainSessionTitle,
} from "../src/core/session-naming.mjs";
import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createHostSessionPort } from "../index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const sp = (qs = "") => new URLSearchParams(qs);
const AT = new Date(2026, 9, 23, 12, 40); // 本地时区 2026-10-23 12:40

// ---------------------------------------------------------------- A. 领域层

test("FR-95-1：任务会话 = 「【任务】+ 标题 + 时间」", () => {
  assert.equal(TASK_PREFIX, "【任务】");
  const title = taskSessionTitle("修复接续会话跨工作区错乱", { at: AT });
  assert.equal(title, "【任务】修复接续会话跨工作区错乱 · 2026-10-23 12:40");
  assert.ok(title.startsWith("【任务】"), "必须以【任务】开头");
  assert.ok(title.includes(" · 2026-10-23 12:40"), "必须带分钟精度时间戳");
});

test("FR-95-2：项目主会话 = 「【项目】+ 项目名称」；重载 / 重绑带备注", () => {
  assert.equal(PROJECT_PREFIX, "【项目】");
  assert.equal(projectMainSessionTitle("Taskboard Workbench · 03（AI 多项目任务工作台）"), "【项目】Taskboard Workbench · 03（AI 多项目任务工作台）");
  assert.equal(projectMainSessionTitle("P1", { note: "重建" }), "【项目】P1（重建）");
  assert.equal(projectMainSessionTitle("P1", { note: "重绑" }), "【项目】P1（重绑）");
  // 无名可依时不得编造名字
  assert.equal(projectMainSessionTitle("   "), "【项目】（未命名项目）");
  assert.equal(taskSessionTitle("", { at: AT }), "【任务】（无标题） · 2026-10-23 12:40");
});

test("FR-95-3：其他会话在任务约束上**额外备注**（口径 3）", () => {
  assert.equal(taskSessionTitle("T", { at: AT, note: "评审" }), "【任务】T · 2026-10-23 12:40（评审）");
  assert.equal(taskSessionTitle("T", { at: AT, note: "专属文档" }), "【任务】T · 2026-10-23 12:40（专属文档）");
  assert.equal(noteForKind("doc"), "专属文档");
  assert.equal(noteForKind("fix"), "修复");
  assert.equal(noteForKind("review"), "评审");
  assert.equal(noteForKind(" REBIND "), "重绑", "kind 大小写 / 空白不应影响命中");
  assert.deepEqual(Object.keys(NOTE_KINDS).sort(), ["design", "doc", "fix", "rebind", "rebuild", "review", "test"]);
});

test("FR-95-4：不臆造 —— 未知 kind / 无效时间 / 空备注一律如实降级", () => {
  assert.equal(noteForKind("unknown-kind"), null);
  assert.equal(noteForKind(42), null);
  assert.equal(noteForKind(null), null);
  assert.equal(formatStamp(new Date("nope")), "", "取不到有效时间回空串");
  const noStamp = taskSessionTitle("T", { at: new Date("nope") });
  assert.equal(noStamp, "【任务】T", "取不到时间就**不拼半个时间戳**");
  assert.equal(taskSessionTitle("T", { at: AT, note: "" }), "【任务】T · 2026-10-23 12:40", "空备注不得渲染成空括号");
  assert.equal(taskSessionTitle("T", { at: AT, note: null }), "【任务】T · 2026-10-23 12:40");
});

test("FR-95-5：会话名是**一行** —— 压空白 + 限长截断", () => {
  assert.equal(cleanLabel("a\n\nb\tc"), "a b c");
  assert.equal(cleanLabel("  x  "), "x");
  const long = cleanLabel("国".repeat(200), { max: 10 });
  assert.equal(long, `${"国".repeat(9)}…`);
  assert.equal(long.length, 10);
  const t = taskSessionTitle("国".repeat(200), { at: AT });
  assert.ok(t.length < 120, `标题必须被截断（实得 ${t.length}）`);
});

// ------------------------------------------------- B. 宿主端口：建完再 rename

/** 假宿主：提供 `sessionController.create/rename`（不依赖真实 dsh 服务）。 */
function fakeHost({ rename = "ok" } = {}) {
  const calls = { create: [], rename: [] };
  const sc = {
    async create(args) { calls.create.push(args ?? null); return { sessionId: "session-fake-1" }; },
    async rename(req) {
      calls.rename.push(req);
      if (rename === "throw") throw Object.assign(new Error("boom"), { code: "RENAME_REJECTED" });
      if (rename === "missing") return undefined;
      return { title: req?.title, seq: 7 };
    },
  };
  return { calls, port: createHostSessionPort({ getService: (n) => (n === "sessionController" ? sc : undefined) }) };
}

test("FR-95-6：createSession({title}) ⇒ 建完调 rename，并回报 titleApplied", async () => {
  const { calls, port } = fakeHost();
  const created = await port.createSession({ cwd: "/w/p1", title: "【项目】P1" });
  assert.equal(created.sessionId, "session-fake-1");
  assert.deepEqual(calls.create[0], { cwd: "/w/p1" }, "cwd 仍须透传（工作区归属门依赖它）");
  assert.equal(calls.rename.length, 1, "必须恰好改一次名");
  assert.deepEqual(calls.rename[0], { sessionId: "session-fake-1", title: "【项目】P1" });
  assert.equal(created.titleApplied, true);
  assert.equal(created.titleReason, null);
});

test("FR-95-7：没给 title ⇒ 不调 rename（不是失败，也不谎报成功）", async () => {
  const { calls, port } = fakeHost();
  const created = await port.createSession({ cwd: "/w/p1" });
  assert.equal(calls.rename.length, 0);
  assert.equal(created.titleApplied, false);
  assert.equal(created.titleReason, "no-title");
});

test("FR-95-8：rename 抛错 / 无返回 ⇒ 如实回 titleApplied:false + 原因，不谎报", async () => {
  const boom = fakeHost({ rename: "throw" });
  const r1 = await boom.port.createSession({ title: "【任务】T" });
  assert.equal(r1.sessionId, "session-fake-1", "改名失败**不得**把会话丢掉");
  assert.equal(r1.titleApplied, false);
  assert.equal(r1.titleReason, "RENAME_REJECTED");
  assert.equal(boom.calls.rename.length, 1);

  const noRename = createHostSessionPort({ getService: (n) => (n === "sessionController" ? { async create() { return { sessionId: "s2" }; } } : undefined) });
  const r2 = await noRename.createSession({ title: "【任务】T" });
  assert.equal(r2.titleApplied, false);
  assert.equal(r2.titleReason, "rename-unavailable");
  assert.equal((await noRename.renameSession("s2", "x")).renamed, false, "宿主无 rename 能力时 renameSession 必须如实拒绝");
});

test("FR-95-9：renameSession 参数不全 ⇒ 明确原因（no-session / no-title）", async () => {
  const { port } = fakeHost();
  assert.deepEqual(await port.renameSession(null, "t"), { renamed: false, reason: "no-session" });
  assert.deepEqual(await port.renameSession("s1", ""), { renamed: false, reason: "no-title" });
  const ok = await port.renameSession("s1", "【项目】P1（重绑）");
  assert.equal(ok.renamed, true);
  assert.equal(ok.title, "【项目】P1（重绑）");
  assert.equal(ok.seq, 7);
});

// ------------------------------------------- C. api 三个建会话点：title 在不在

/** 假宿主端口：记录 createSession / renameSession 的入参。 */
function hostPort({ workspacePath = "/w/p1", renameOk = true } = {}) {
  const calls = { create: [], rename: [] };
  return {
    calls,
    port: {
      available: true,
      async sessionExists(sessionId) { return { sessionId, exists: true, source: "mock" }; },
      async sessionOrigin(sessionId) { return { sessionId, cwd: workspacePath, source: "mock" }; },
      async sendPrompt() { return { sent: false, reason: "mock" }; },
      async openSession() { return { opened: false, reason: "mock" }; },
      async renameSession(sessionId, title) {
        calls.rename.push({ sessionId, title });
        return renameOk ? { renamed: true, title, seq: 1 } : { renamed: false, reason: "mock-rename-failed" };
      },
      async createSession(args) {
        calls.create.push(args ?? null);
        return { sessionId: `session-new-${calls.create.length}`, titleApplied: true, titleReason: null };
      },
    },
  };
}

function projectSetup({ workspacePath = "/w/p1", withMainSession = false } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath });
  if (withMainSession) store.rebindInitialSession("p1", "session-old-main");
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const task = store.createTask({ projectId: "p1", title: "修复按钮不生效", status: "todo" });
  store.associateRequirementTask(item.id, task.id);
  return { store, task };
}

test("FR-95-10：项目「重建并绑定主会话」建会话时带【项目】名（已有指针 ⇒ 备注「重建」）", async () => {
  for (const [withMain, expect] of [[false, "【项目】P1"], [true, "【项目】P1（重建）"]]) {
    const { store } = projectSetup({ withMainSession: withMain });
    const host = hostPort();
    store.hostSessionPort = host.port;
    const res = await createApiRouter({ store }).route({ method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true } });
    assert.equal(res.status, 200);
    assert.equal(host.calls.create[0].title, expect);
    assert.equal(host.calls.create[0].cwd, "/w/p1", "cwd 必须继续透传");
    assert.equal(res.payload.titleApplied, true, "改名结果要如实回流给前端");
  }
});

test("FR-95-11：项目「改绑已有会话」⇒ 该会话改名为【项目】名 + 备注「重绑」", async () => {
  const { store } = projectSetup();
  const host = hostPort();
  store.hostSessionPort = host.port;
  const res = await createApiRouter({ store }).route({
    method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(),
    body: { confirm: true, sessionId: "session-existing" },
  });
  assert.equal(res.status, 200);
  assert.equal(res.payload.mode, "bind-existing");
  assert.deepEqual(host.calls.rename[0], { sessionId: "session-existing", title: "【项目】P1（重绑）" });
  assert.equal(res.payload.titleApplied, true);
  assert.equal(host.calls.create.length, 0, "改绑**不得**新建会话");
});

test("FR-95-12：改名失败如实回报（不谎报成功）", async () => {
  const { store } = projectSetup();
  const host = hostPort({ renameOk: false });
  store.hostSessionPort = host.port;
  const res = await createApiRouter({ store }).route({
    method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(),
    body: { confirm: true, sessionId: "session-existing" },
  });
  assert.equal(res.payload.titleApplied, false);
  assert.equal(res.payload.titleReason, "mock-rename-failed");
  assert.equal(store.requireProject("p1").initialSessionId, "session-existing", "改名失败不影响绑定本身");
});

test("FR-95-13：任务「启动执行」建会话 = 【任务】+ 标题 + 时间，且补上 cwd（修旧缺漏）", async () => {
  const { store, task } = projectSetup();
  const host = hostPort();
  store.hostSessionPort = host.port;
  const res = await createApiRouter({ store }).route({ method: "POST", pathname: `/api/tasks/${task.identifier}/execute`, searchParams: sp(), body: {} });
  assert.equal(res.status, 200);
  const args = host.calls.create[0];
  assert.match(args.title, /^【任务】修复按钮不生效 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(args.cwd, "/w/p1", "旧实现漏传 cwd ⇒ 会话落在 dsh 进程目录（cwd=/）—— 这正是错绑来源，必须补上");
  assert.ok(typeof args.preset === "string" && args.preset.length > 0, "预置内容不能因加 title 而丢");
  assert.equal(res.payload.launch.titleApplied, true);
});

// ------------------------------------------------------------- D. 接线静态证据

test("FR-95-14：宿主端口接线 —— 建完再 rename（不指望 create 收 title）", () => {
  const source = read("index.js");
  assert.match(source, /async createSession\(\{ preset, cwd, title \} = \{\}\)/);
  assert.match(source, /sc\.rename\(\{ sessionId, title \}\)/, "必须调宿主的 rename({sessionId,title})");
  assert.match(source, /async renameSession\(sessionId, title\)/);
  assert.match(source, /return \{ renamed: false, reason: "rename-unavailable" \}/, "无 rename 能力要如实拒绝");
  assert.match(source, /titleApplied: named\.titleApplied, titleReason: named\.titleReason/);
});

test("FR-95-15：api 三处建会话点 + 命名规范文档落盘", () => {
  const source = read("src/server/api.mjs");
  assert.match(source, /import \{ taskSessionTitle, projectMainSessionTitle \} from "\.\.\/core\/session-naming\.mjs";/);
  assert.match(source, /const mainSessionName = projectMainSessionTitle\(project\.name, \{ note: project\.initialSessionId \? "重建" : null \}\);/);
  assert.match(source, /title: mainSessionName,/);
  assert.match(source, /const boundSessionName = projectMainSessionTitle\(project\.name, \{ note: "重绑" \}\);/);
  assert.match(source, /sessionName = taskSessionTitle\(execTask\.title\);/);
  assert.match(source, /title: sessionName,/);
  assert.match(source, /cwd: store\.getProject\(execTask\.projectId\)\?\.workspacePath \?\? undefined/);
  // 命名口径必须有规范文档承接（否则只是代码里的约定）
  const doc = read("docs/规范/01-协作规范.md");
  for (const needle of ["【任务】", "【项目】", "重绑", "评审"]) assert.ok(doc.includes(needle), `规范文档缺「${needle}」`);
});

// ------------------------------------------- E. 回包带名字：UI 才有东西可展示（2026-10-26 补）

test("FR-95-17：rebind（重建）回包带 `sessionName`（口径 2 两种都带）", async () => {
  for (const [withMain, expect] of [[false, "【项目】P1"], [true, "【项目】P1（重建）"]]) {
    const { store } = projectSetup({ withMainSession: withMain });
    const host = hostPort();
    store.hostSessionPort = host.port;
    const res = await createApiRouter({ store }).route({
      method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true },
    });
    assert.equal(res.payload.sessionName, expect, "回包必须带**算出来的**会话名（UI 无权重算备注口径）");
    assert.equal(res.payload.sessionName, host.calls.create[0].title, "回包的名字必须与真正传给宿主的一致");
  }
});

test("FR-95-18：rebind（改绑已有会话）回包带 `sessionName` + 备注「重绑」", async () => {
  const { store } = projectSetup();
  const host = hostPort();
  store.hostSessionPort = host.port;
  const res = await createApiRouter({ store }).route({
    method: "POST", pathname: "/api/projects/p1/sessions/rebind", searchParams: sp(), body: { confirm: true, sessionId: "session-existing" },
  });
  assert.equal(res.payload.sessionName, "【项目】P1（重绑）");
  assert.equal(res.payload.sessionName, host.calls.rename[0].title, "回包的名字必须与真正交给 rename 的一致");
});

test("FR-95-19：任务「启动执行」回包带 `launch.sessionName`", async () => {
  const { store, task } = projectSetup();
  const host = hostPort();
  store.hostSessionPort = host.port;
  const res = await createApiRouter({ store }).route({
    method: "POST", pathname: `/api/tasks/${task.identifier}/execute`, searchParams: sp(), body: {},
  });
  const name = res.payload.launch.sessionName;
  assert.match(name, /^【任务】修复按钮不生效 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(name, host.calls.create[0].title, "回包的名字必须与真正传给宿主的一致（不得各算一次）");
});

test("FR-95-20：前端必须把命名结果**说出来** —— 成功给名字 / 失败给原因 / 未知不臆造", () => {
  const web = read("web/app.js");
  // 1) 行为：把 helper 从源码里切出来真跑（本仓既有「源码切片 + new Function」范式）
  const m = /const sessionNameClause = \(r\) => \{[\s\S]*?\n    \};/.exec(web);
  assert.ok(m, "web/app.js 必须存在 sessionNameClause helper");
  const clause = new Function(`${m[0]}\nreturn sessionNameClause;`)();
  assert.equal(clause({ titleApplied: true, sessionName: "【项目】P1（重建）" }), " · 会话名《【项目】P1（重建）》");
  assert.equal(clause({ titleApplied: false, titleReason: "rename-unavailable" }), " · ⚠ 会话名未生效（rename-unavailable）");
  assert.equal(clause({ titleApplied: false }), " · ⚠ 会话名未生效（原因未知）", "原因缺失也必须说出来，不许静默");
  assert.equal(clause({ titleApplied: null, sessionName: "【项目】P1" }), "", "宿主没回结果 ⇒ 不臆造、不加噪音");
  assert.equal(clause({}), "");
  assert.equal(clause(null), "");
  assert.equal(clause({ titleApplied: true }), "", "名字都没拿到就不硬凑一个");
  // 2) 接线：五处「建会话」出口横幅（改绑 / 配置页重建 / 抽屉重建 / 诊断重建 / 启动执行）都要接上
  const uses = (web.match(/sessionNameClause\(/g) ?? []).length;
  assert.ok(uses >= 5, `五处横幅都要接上（实际 ${uses} 处）`);
  // 3) 命名失败时横幅**不得仍报绿**（否则等于换个方式骗人）
  assert.match(web, /r\.titleApplied === false \? "error" : "info"/, "改绑出口：命名失败要红色");
  assert.match(web, /l\.mode === "session" && l\.titleApplied !== false \? "info" : "error"/, "启动执行出口：要按命名结果定档");
});
