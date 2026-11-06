/**
 * FR-92「项目开局对齐（标准步骤程序）」回归。
 *
 * 用户 2026-10-22 指定引入《Vibe Coding 团队协作技巧》作为项目开局对齐事项，并要求
 * 「作为任务工作台标准步骤程序执行」⇒ 六步要有**可核验判据**，工作台能自己回答"对齐了没有"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERIFY_MAX_COMMAND } from "../src/core/verify.mjs";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createServer as createHttpServer } from "../src/server/server.mjs";
import { KICKOFF_ALIGNMENT_STEPS, KICKOFF_ORDER_TEXT, KICKOFF_SOURCE, KICKOFF_TODO_HINT, buildGapPrompt, buildKickoffTodos, collectGaps, evaluateKickoff, isFilled, pickSetting } from "../src/core/kickoff.mjs";
import { ERROR_CATEGORY, EXIT, TbError } from "../src/core/errors.mjs";
import { collectKickoffFacts, hasEngineerExecutor, hasReviewerRole } from "../src/server/kickoff.mjs";

const routeOf = (router) => (method, pathname, body, params = {}) => router.route({ method, pathname, searchParams: new URLSearchParams(params), body });
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

test("步骤清单是数据驱动的：6 步、每步都有判据与说明", () => {
  assert.equal(KICKOFF_ALIGNMENT_STEPS.length, 6);
  assert.match(KICKOFF_SOURCE.url, /liyupi\/ai-guide/);
  for (const s of KICKOFF_ALIGNMENT_STEPS) {
    assert.ok(s.id && s.title && s.why && s.spec, `${s.id} 缺说明字段`);
    assert.ok(s.checks.length >= 2, `${s.id} 判据太少（对齐必须是可核验的）`);
    for (const c of s.checks) assert.ok(c.paths || c.setting || c.custom, `${s.id}.${c.id} 没有判据来源`);
  }
});

test("pickSetting / isFilled：点路径取值 + 空值判定", () => {
  const settings = { envConfig: { gitFlow: "main/develop/feature", qualityGates: [] }, teamTemplate: { roles: ["lead"] } };
  assert.equal(pickSetting(settings, "envConfig.gitFlow"), "main/develop/feature");
  assert.equal(pickSetting(settings, "envConfig.nope.deep"), undefined);
  assert.equal(isFilled("  "), false);
  assert.equal(isFilled([]), false);
  assert.equal(isFilled({}), false);
  assert.equal(isFilled(0), true);
  assert.equal(isFilled(["a"]), true);
});

test("evaluateKickoff：全缺 → ready=false；全满足 → ready=true；半满足 → partial", () => {
  const empty = evaluateKickoff({});
  assert.equal(empty.ready, false);
  assert.equal(empty.doneCount, 0);
  assert.equal(empty.missing.length, 6);
  assert.match(empty.verdict, /未完成（0\/6）/);

  const full = evaluateKickoff({
    files: Object.fromEntries(KICKOFF_ALIGNMENT_STEPS.flatMap((s) => s.checks).flatMap((c) => (c.paths ?? []).map((p) => [p, true]))),
    settings: { envConfig: { gitFlow: "x", qualityGates: "y", cadence: "z" }, teamTemplate: { roles: ["lead", "reviewer"], engineer: { verifyCommand: "npm test" } } },
    custom: { reviewerRole: true, engineerExecutor: true },
  });
  assert.equal(full.ready, true, "六步全满足才 ready");
  assert.equal(full.doneCount, 6);
  assert.deepEqual(full.missing, []);

  const partial = evaluateKickoff({ files: { "README.md": true } });
  const docs = partial.steps.find((s) => s.id === "docs-first");
  assert.equal(docs.status, "partial", "三步判据中只中一条 ⇒ partial");
  assert.equal(docs.done, 1);
  assert.equal(partial.ready, false);
});

test("hasReviewerRole：数组/对象写法都认，没有就不认", () => {
  assert.equal(hasReviewerRole({ roles: ["lead", "reviewer"] }), true);
  assert.equal(hasReviewerRole({ roles: { lead: {}, Reviewer: {} } }), true);
  assert.equal(hasReviewerRole({ roles: ["lead", "engineer"] }), false);
  assert.equal(hasReviewerRole({}), false);
  assert.equal(hasReviewerRole(null), false);
});

test("hasEngineerExecutor：roles 里的 engineer.executor 或 engineer.verifyCommand 任一即认", () => {
  assert.equal(hasEngineerExecutor({ roles: [{ role: "engineer", executor: "cli:claude" }] }), true);
  assert.equal(hasEngineerExecutor({ roles: [{ role: "engineer", executor: "" }] }), false);
  assert.equal(hasEngineerExecutor({ engineer: { verifyCommand: "npm test" } }), true);
  assert.equal(hasEngineerExecutor({ roles: ["lead"] }), false);
  assert.equal(hasEngineerExecutor(null), false);
});

test("collectKickoffFacts：只读目录，存在性如实回报；目录不可读不炸", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-kickoff-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "# hi");
    mkdirSync(path.join(dir, "docs", "规范"), { recursive: true });
    const facts = collectKickoffFacts(dir);
    assert.equal(facts.readable, true);
    assert.equal(facts.files["README.md"], true);
    assert.equal(facts.files["docs/规范"], true);
    assert.equal(facts.files["CONTRIBUTING.md"], false);
    assert.equal(collectKickoffFacts(null).readable, false);
    assert.equal(collectKickoffFacts(path.join(dir, "nope")).readable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：/api/projects/:id/kickoff 只读自检，且不改设置", async () => {
  const store = openStore({ dbPath: ":memory:" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-kickoff-api-"));
  writeFileSync(path.join(dir, "README.md"), "# x");
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const before = store.getProjectSettings("p1");
  const router = createApiRouter({ store });
  const route = routeOf(router);

  const r = await route("GET", "/api/projects/p1/kickoff");
  assert.equal(r.status, 200);
  assert.equal(r.payload.project, "p1");
  assert.equal(r.payload.readable, true);
  assert.equal(r.payload.steps.length, 6);
  assert.equal(r.payload.ready, false);
  assert.ok(r.payload.missing.length > 0);
  assert.match(r.payload.source.url, /liyupi/);

  assert.deepEqual(store.getProjectSettings("p1"), before, "自检不得改项目设置");
  await assert.rejects(() => route("POST", "/api/projects/p1/kickoff", {}), /仅支持 GET/);
  await assert.rejects(() => route("GET", "/api/projects/no-such/kickoff"), (e) => e.code === "PROJECT_NOT_FOUND");

  rmSync(dir, { recursive: true, force: true });
  store.close();
});

test("collectGaps：真实 evaluateKickoff 输出下动作/判据必须具体（卡 -229 F1）", () => {
  // 关键：**必须**用真实 evaluateKickoff() 的返回值驱动 —— 手写 synthetic report 会掩盖
  // 「checks 只有 id/label/ok/evidence」这个事实（上轮评审就是因此漏掉了死代码缺陷）。
  const report = evaluateKickoff({ files: {}, settings: {} });
  const gaps = collectGaps(report);
  assert.equal(gaps.step, 6);
  assert.equal(gaps.items.length, gaps.total, "全缺时条目数 = 判据总数");
  const actions = new Set(gaps.items.map((i) => i.action));
  assert.ok(actions.size >= 2, `action 必须按判据来源分化（实际 ${actions.size} 种；全相同＝回查没生效）`);
  for (const item of gaps.items) {
    assert.match(item.criterion, /\.(md|json|js|mjs|cjs|ya?ml)|qualityGates|cadence|gitFlow|roles|executor|reviewerRole|engineerExecutor/, `判据必须点名具体文件或设置项，实际：${item.criterion}`);
    assert.doesNotMatch(`${item.action} ${item.criterion}`, /见该步骤的要求说明|补齐该项/, "禁止泛化文案");
  }
  assert.ok(gaps.items.some((i) => /\.md/.test(i.criterion)), "文件类判据必须现身（README/CONTRIBUTING 等）");
  assert.ok(gaps.items.some((i) => /qualityGates|gitFlow|cadence/.test(i.criterion)), "设置类判据必须现身");
});

test("collectGaps：非法入参必须显式抛错，不得静默全零（卡 -229 F3）", () => {
  // 静默返回全零会被前端读成「零缺口＝已对齐」并置灰（假绿），所以必须抛。
  for (const bad of ["taskboard-workbench", 42, null, undefined, [], { steps: "nope" }]) {
    assert.throws(() => collectGaps(bad), (error) => error.code === "INVALID_FIELD", `入参 ${JSON.stringify(bad)} 必须抛 INVALID_FIELD`);
  }
});

test("NO_MAIN_SESSION 必须是冲突类 exitCode 5（卡 -229 F4）", () => {
  assert.equal(ERROR_CATEGORY.NO_MAIN_SESSION, EXIT.CONFLICT);
  assert.equal(new TbError("NO_MAIN_SESSION", "x").exitCode, EXIT.CONFLICT);
  assert.equal(new TbError("NO_MAIN_SESSION", "x").exitCode, 5);
});

test("buildKickoffTodos：六步固定映射、顺序即依赖顺序（卡 -230）", () => {
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const todos = buildKickoffTodos({ project: { id: "p1", name: "样例项目" }, gaps });
  assert.equal(todos.length, 6, "全缺时六步各一条");
  assert.deepEqual(todos.map((t) => t.index), [1, 2, 3, 4, 5, 6], "编号连续");
  assert.deepEqual(todos.map((t) => t.stepId), ["code-style", "docs-first", "git-flow", "review-gate", "collaboration", "roles"], "顺序固定：规范 → 文档 → Git → 审查 → 协作 → 分工");
  for (const todo of todos) {
    assert.ok(todo.action && todo.action.length > 10, `${todo.step} 缺动作`);
    assert.match(todo.criterion, /\.(md|json|js|mjs|cjs)|qualityGates|gitFlow|cadence|roles|reviewerRole|engineerExecutor/, `${todo.step} 判据必须点名具体文件/设置项`);
    // t22：paths 分支改为紧凑形态（`ls -d … | head -1`），不再全展开 `[ -e … ]`。
    assert.ok(todo.verifyCommand.includes("ls -d") || todo.verifyCommand.includes("node -e"), `${todo.step} 判据必须可执行：${todo.verifyCommand}`);
    assert.equal(todo.hint, KICKOFF_TODO_HINT);
    assert.match(todo.hint, /重新自检/, "完成后提示必须指向配置页自检");
    assert.match(todo.hint, /重跑配置页自检/, "完成后提示必须字面含「重跑配置页自检」（卡 -230 交付 2）");
    assert.ok(todo.labels.length >= 1);
  }
});

test("buildKickoffTodos：零缺口 → 空数组（不给空 todo）", () => {
  const full = evaluateKickoff({
    files: Object.fromEntries(KICKOFF_ALIGNMENT_STEPS.flatMap((s) => s.checks).flatMap((c) => (c.paths ?? []).map((p) => [p, true]))),
    settings: { envConfig: { gitFlow: "x", qualityGates: ["y"], cadence: "z" }, teamTemplate: { roles: ["lead", "reviewer"], engineer: { verifyCommand: "npm test" } } },
    custom: { reviewerRole: true, engineerExecutor: true },
  });
  assert.deepEqual(buildKickoffTodos({ project: { id: "p1" }, gaps: collectGaps(full) }), []);
  assert.throws(() => buildKickoffTodos({ project: { id: "p1" }, gaps: "p1" }), (e) => e.code === "INVALID_FIELD");
});

test("buildGapPrompt：注入正文含 ≥5 条 todo、三要素齐、顺序与依赖一致（卡 -230）", () => {
  const project = { id: "p1", name: "样例项目" };
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const text = buildGapPrompt({ project, gaps });
  assert.match(text, /项目：样例项目（p1）/);
  assert.match(text, /按依赖顺序推进/);
  const lines = text.split("\n");
  const todoLines = lines.filter((l) => /^\d+\. \[ \] /.test(l));
  assert.ok(todoLines.length >= 5, `正文里的 todo 必须 ≥5 条（实际 ${todoLines.length}）`);
  assert.deepEqual(todoLines.map((l) => l.replace(/^\d+\. \[ \] /, "")), ["① 统一代码规范", "② 文档驱动开发", "③ Git 协作流程", "④ 代码审查门", "⑤ 协作机制与知识沉淀", "⑥ 明确分工"]);
  for (const key of ["- 动作：", "- 判据：", "- 命令：", "- 完成："]) {
    assert.equal(lines.filter((l) => l.trim().startsWith(key)).length, todoLines.length, `每条 todo 都要有「${key}」`);
  }
  assert.ok((text.match(/重新自检/g) ?? []).length >= todoLines.length, "每条 todo 都提示重跑自检");
  assert.ok((text.match(/重跑配置页自检/g) ?? []).length >= todoLines.length, "正文每条 todo 都字面含「重跑配置页自检」");
  // 零缺口：正文写「无缺口」，且不渲染任何 todo 行
  const emptyGaps = { step: 6, done: 14, total: 14, items: [] };
  const emptyText = buildGapPrompt({ project, gaps: emptyGaps });
  assert.match(emptyText, /无缺口/);
  assert.equal(emptyText.split("\n").filter((l) => /^\d+\. \[ \] /.test(l)).length, 0);
});

test("API：POST kickoff/announce 回包带结构化 todos（不解析自然语言）（卡 -230）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "样例项目", workspacePath: "/tmp/tb230-nope" });
  store.bindInitialSession("p1", "sess-main");
  const sent = [];
  store.hostSessionPort = { sendPrompt: async (sid, body) => { sent.push({ sid, body }); return { sent: true }; } };
  const router = createApiRouter({ store });
  const route = routeOf(router);
  const r = await route("POST", "/api/projects/p1/kickoff/announce", {});
  assert.equal(r.status, 200);
  assert.equal(r.payload.delivered, true);
  assert.ok(Array.isArray(r.payload.todos) && r.payload.todos.length >= 5, "回包必须带 todos 数组（字段可读，不靠解析正文）");
  for (const todo of r.payload.todos) {
    for (const key of ["index", "stepId", "step", "action", "criterion", "verifyCommand", "hint"]) {
      assert.ok(key in todo, `todo 缺字段 ${key}`);
    }
  }
  assert.deepEqual(r.payload.todos.map((t) => t.stepId), ["code-style", "docs-first", "git-flow", "review-gate", "collaboration", "roles"]);
  assert.match(sent[0].body, /## 待办清单（todolist/);
  assert.match(sent[0].body, /1\. \[ \] ① 统一代码规范/);
  store.close();
});

test("判据命令真跑：setting/custom 反例不得假绿、真值必须通过（t16）", async () => {
  // 命令**来自产品**（真实 collectGaps → buildKickoffTodos），这里只负责喂 JSON 与看退出码。
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const todos = buildKickoffTodos({ project: { id: "p1", name: "样例项目" }, gaps });
  // 一条 verifyCommand 里可能拼了多个判据（`A && B`）；按要素挑出含指定判据的那一段。
  const cmdOfCheck = (needle) => todos.flatMap((t) => t.verifyCommand.split(" && ")).find((c) => c.includes(needle)) ?? "";
  const gitFlowCmd = cmdOfCheck("envConfig.gitFlow");
  const qualityGatesCmd = cmdOfCheck("qualityGates");
  const reviewerCmd = cmdOfCheck("const names=");
  const engineerCmd = cmdOfCheck("executor");
  for (const [name, cmd] of [["gitFlow", gitFlowCmd], ["qualityGates", qualityGatesCmd], ["reviewerRole", reviewerCmd], ["engineerExecutor", engineerCmd]]) {
    assert.ok(cmd, `${name} 判据命令必须能从 todos 里取到（不许换一份等价命令）`);
    assert.match(cmd, /node -e/, `${name} 判据必须走 node -e（值判定），实际：${cmd}`);
  }

  let payload = {};
  let realStatus = 200;
  const server = createServer((req, res) => {
    res.writeHead(realStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    // 注意：必须用**异步** spawn。spawnSync 会阻塞父进程事件循环，本进程里的 HTTP 服务
    // 就永远回不了响应，子进程的 fetch 挂死在原地（实测：整份测试 60s 无输出、被 timeout 杀）。
    const run = (cmd, base) => new Promise((resolve) => {
      const child = spawn("sh", ["-c", cmd], { env: { ...process.env, TB_BASE: base }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);   // 卡死不许无限等
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, stderr: String(e?.message ?? e) }); });
    });
    const check = async (label, cmd, settings, wantZero) => {
      payload = settings;
      const r = await run(cmd, `http://127.0.0.1:${port}`);
      if (wantZero) assert.equal(r.status, 0, `${label}：真值必须通过（status=${r.status}, stderr=${r.stderr}）`);
      else assert.notEqual(r.status, 0, `${label}：反例不得假绿（status=${r.status}）`);
    };

    // ① setting：键在、值为空串 ⇒ 不通过（旧 grep 键名写法会假绿）
    await check("envConfig.gitFlow 空串", gitFlowCmd, { envConfig: { gitFlow: "" } }, false);
    // ② setting 双向性：值非空 ⇒ 通过
    await check("envConfig.gitFlow 有值", gitFlowCmd, { envConfig: { gitFlow: "main + feature" } }, true);
    // ③ 数组非空也算填（与 isFilled 同口径）
    await check("teamTemplate.qualityGates 非空数组", qualityGatesCmd, { teamTemplate: { qualityGates: ["需求"] } }, true);
    // ④ custom：无关文本提到 reviewer，但 roles 段里没有 ⇒ 不通过（旧全 JSON grep 会假绿）
    await check("无关文本含 reviewer", reviewerCmd, { teamTemplate: { roles: [{ role: "engineer", count: 1 }] }, note: "reviewer 会来做审查" }, false);
    // ⑤ custom：真为 reviewer 角色 ⇒ 通过
    await check("roles 含 reviewer", reviewerCmd, { teamTemplate: { roles: [{ role: "reviewer", count: 1 }] } }, true);
    // ⑥ custom：engineer 带 executor ⇒ 通过；去掉 ⇒ 不通过
    await check("engineer 带 executor", engineerCmd, { teamTemplate: { roles: [{ role: "engineer", count: 1, executor: "claude -p" }] } }, true);
    await check("engineer 无 executor", engineerCmd, { teamTemplate: { roles: [{ role: "engineer", count: 1 }] } }, false);

    // ⑦ 拿不到数据（端口不通）⇒ 一律不通过，绝不假绿
    payload = { envConfig: { gitFlow: "main" } };
    const dead = await run(gitFlowCmd, "http://127.0.0.1:1");
    assert.notEqual(dead.status, 0, "基址不通时必须判不通过（拿不到数据≠已对齐）");
    // ⑧ 服务 500 ⇒ 同样不通过（status 非 0 也要 exit 1）
    realStatus = 500;
    const boom = await run(gitFlowCmd, `http://127.0.0.1:${port}`);
    assert.notEqual(boom.status, 0, "服务报错时必须判不通过（拿不到数据≠已对齐）");
  } finally {
    server.close();
    server.closeAllConnections?.();
  }
});

test("逆序输入 ⇒ 输出仍为规范序（t16：固定映射真的固定）", () => {
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const reversed = { ...gaps, items: [...gaps.items].reverse() };
  const todos = buildKickoffTodos({ project: { id: "p1", name: "样例项目" }, gaps: reversed });
  assert.deepEqual(todos.map((t) => t.stepId), ["code-style", "docs-first", "git-flow", "review-gate", "collaboration", "roles"], "逆序喂进来也必须按规范序输出");
  assert.deepEqual(todos.map((t) => t.index), [1, 2, 3, 4, 5, 6], "编号连续");
});

test("六步文案防漂移（三处一致：常量 / 注入正文 / web 开局语）（t16）", () => {
  // ① 常量本身：6 段，且第 i 段是步骤 title 去前缀后的子串（顺序必须对上）
  const bare = (title) => String(title).replace(/^[①②③④⑤⑥⑦⑧]\s*/, "");
  const segments = KICKOFF_ORDER_TEXT.split(" → ");
  assert.equal(segments.length, 6, `顺序文案必须 6 段，实际 ${segments.length}：${KICKOFF_ORDER_TEXT}`);
  segments.forEach((seg, i) => {
    const title = bare(KICKOFF_ALIGNMENT_STEPS[i].title);
    assert.ok(title.includes(seg), `第 ${i + 1} 段「${seg}」必须落在步骤「${title}」里（顺序对不上）`);
  });

  // ② 注入正文用的是同一个常量
  const project = { id: "p1", name: "样例项目" };
  const text = buildGapPrompt({ project, gaps: collectGaps(evaluateKickoff({ files: {}, settings: {} })) });
  assert.ok(text.includes(`（${KICKOFF_ORDER_TEXT}）`), `buildGapPrompt 正文必须含「（${KICKOFF_ORDER_TEXT}）」（别另抄一份）`);

  // ③ web/app.js 的 KICKOFF_PROMPT ① 与步骤定义一致（**只读不写** web）
  const appSrc = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  const start = appSrc.indexOf("① 先做「项目开局对齐」");
  assert.ok(start > 0, "web/app.js 里找不到 KICKOFF_PROMPT 的「① 先做「项目开局对齐」」段");
  const end = appSrc.indexOf("；缺哪步补哪步", start);
  assert.ok(end > start, "web/app.js 里找不到「；缺哪步补哪步」收尾");
  const tail = appSrc.indexOf("）：", start);
  assert.ok(tail > start && tail < end, "web/app.js 里找不到「）：」分隔（六步列表起点漂了）");
  const listed = appSrc.slice(tail + "）：".length, end).split(" / ").map((s) => s.trim());
  assert.equal(listed.length, 6, `web 开局语必须列 6 步，实际 ${listed.length}：${listed.join(" / ")}`);
  listed.forEach((item, i) => {
    const title = bare(KICKOFF_ALIGNMENT_STEPS[i].title);
    assert.ok(title.startsWith(item), `web/app.js:KICKOFF_PROMPT ① 与步骤定义漂移：第 ${i + 1} 项「${item}」不是「${title}」的前缀（不要改 web 来将就）`);
  });
});

/* ---------------- 卡 t20（需求 R170）：缺口注入必须带「关联需求」 ---------------- */

const T20_PROJECT = { id: "p1", name: "样例项目" };
const T20_REQ = { identifier: "p1-R170", title: "开局缺口闭环" };
const T20_CANDIDATES = [{ identifier: "p1-R170", title: "开局缺口闭环" }, { identifier: "p1-R171", title: "另一条" }];
const T20_GAPS = collectGaps(evaluateKickoff({ files: {}, settings: {} }));

test("buildGapPrompt 三态：指定 requirement ⇒ 只写这一条，不列候选（t20）", () => {
  const text = buildGapPrompt({ project: T20_PROJECT, gaps: T20_GAPS, requirement: T20_REQ, requirements: T20_CANDIDATES });
  assert.ok(text.includes("## 建卡要求（关联需求）"), "必须有「建卡要求（关联需求）」段");
  assert.ok(text.includes("EXECUTION_NOT_ATTRIBUTED"), "必须点明未归属会被归因门拒");
  assert.ok(text.includes("p1-R170"), "必须写出本次指定的 identifier");
  assert.ok(text.includes("本次指定关联需求"), "指定态必须明说「本次指定关联需求」");
  assert.ok(!text.includes("从下列候选里选一条"), "指定态不得再列候选（候选是噪音，还会引诱执行侧另选）");
  assert.ok(!text.includes("p1-R171"), "指定态不得出现别的候选");
  // 位置：段落在「## 待办清单」之后、「> 本清单与「开工语」」之前
  const at = (needle) => text.indexOf(needle);
  assert.ok(at("## 建卡要求（关联需求）") > at("## 待办清单"), "段落必须排在待办清单之后");
  assert.ok(at("> 本清单与「开工语」") > at("## 建卡要求（关联需求）"), "段落必须排在收尾引用之前");
});

test("buildGapPrompt 三态：未指定但有候选 ⇒ 列出候选（identifier + title 都要）（t20）", () => {
  const text = buildGapPrompt({ project: T20_PROJECT, gaps: T20_GAPS, requirements: T20_CANDIDATES });
  assert.ok(text.includes("## 建卡要求（关联需求）"));
  assert.ok(text.includes("EXECUTION_NOT_ATTRIBUTED"));
  assert.ok(text.includes("从下列候选里选一条"), "候选态必须给出选择指引");
  for (const c of T20_CANDIDATES) {
    assert.ok(text.includes(c.identifier), `候选 identifier 不能漏：${c.identifier}`);
    assert.ok(text.includes(c.title), `候选 title 不能漏：${c.title}`);
  }
  assert.ok(!text.includes("本次指定关联需求"), "候选态不得谎称「本次指定」");
  assert.ok(!text.includes("本项目暂无未关闭需求"), "有候选时不得说「暂无未关闭需求」");
});

test("buildGapPrompt 三态：无候选 ⇒ 明说暂无未关闭需求 + 给 unattributedReason 逃生口（t20）", () => {
  const text = buildGapPrompt({ project: T20_PROJECT, gaps: T20_GAPS });
  assert.ok(text.includes("## 建卡要求（关联需求）"));
  assert.ok(text.includes("EXECUTION_NOT_ATTRIBUTED"));
  assert.ok(
    text.includes("本项目暂无未关闭需求，需先建需求条目或用 `unattributedReason` 显式声明"),
    "空候选态必须逐字给出「暂无未关闭需求 / unattributedReason」这句",
  );
  assert.ok(!text.includes("从下列候选里选一条"), "空候选时不得给出空的候选指引");
});

test("buildGapPrompt：老调用方（不传 requirement/requirements）零影响（t20）", () => {
  // 兼容性护栏：既有调用点只传 {project,gaps} / {project,gaps,todos}，不得因新增参数而报错或变形。
  const a = buildGapPrompt({ project: T20_PROJECT, gaps: T20_GAPS });
  const b = buildGapPrompt({ project: T20_PROJECT, gaps: T20_GAPS, todos: buildKickoffTodos({ project: T20_PROJECT, gaps: T20_GAPS }) });
  assert.equal(a, b, "传不传 todos 结果一致（内部本就同源）");
  assert.ok(a.includes("## 待办清单（todolist"), "既有待办清单行为不变");
  assert.equal(a.split("\n").filter((l) => /^\d+\. \[ \] /.test(l)).length, 6, "六步 todo 一字不少");
});

test("API：POST kickoff/announce 回包带 requirement/requirements，非法引用不静默成功（t20）", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "tb-t20-announce-"));
  const store = openStore({ dataDir, env: {} });
  const server = createHttpServer({ store });
  try {
    store.createProject({ id: "p1", name: "样例项目", workspacePath: path.join(dataDir, "ws-nope") });
    store.bindInitialSession("p1", "sess-main");
    const sent = [];
    store.hostSessionPort = { sendPrompt: async (sid, prompt) => { sent.push({ sid, prompt }); return { sent: true }; } };
    const item = store.createRequirementItem({ projectId: "p1", title: "开局缺口闭环" });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}/api/projects/p1/kickoff/announce`;
    const post = async (payload) => {
      const res = await fetch(base, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      return { status: res.status, json: await res.json() };
    };

    // ① 不带 body.requirement ⇒ 未指定，但候选里有本条 ⇒ 正文让执行侧从候选里选（且点名 identifier）
    const r1 = await post({});
    assert.equal(r1.status, 200);
    assert.equal(r1.json.requirement, null, "未指定时 requirement 必须是 null（不得猜一条替人做主）");
    assert.ok(Array.isArray(r1.json.requirements), "回包必须带 requirements 数组");
    assert.ok(
      r1.json.requirements.some((x) => x.identifier === item.identifier && x.title === "开局缺口闭环"),
      `requirements 必须含本项目未关闭条目：${JSON.stringify(r1.json.requirements)}`,
    );
    assert.ok(r1.json.prompt.includes("从下列候选里选一条"), "未指定的正文必须给出候选指引");
    assert.ok(r1.json.prompt.includes(item.identifier), "未指定的正文必须点名候选 identifier");
    assert.ok(sent[0].prompt.includes("## 建卡要求（关联需求）"), "真投出去的正文必须带这一段");

    // ② 带 { requirement: identifier } ⇒ 指定态（并且正文改口为「本次指定关联需求」）
    const r2 = await post({ requirement: item.identifier });
    assert.equal(r2.status, 200);
    assert.deepEqual(r2.json.requirement, { identifier: item.identifier, title: "开局缺口闭环" });
    assert.ok(r2.json.prompt.includes("本次指定关联需求"));
    assert.ok(!r2.json.prompt.includes("从下列候选里选一条"));

    // ③ 不存在的引用 ⇒ 4xx + REQUIREMENT_NOT_FOUND（不得静默降级成「未指定」建出一堆无归属卡）
    const r3 = await post({ requirement: "不存在的-R999" });
    assert.ok(r3.status >= 400, `非法 requirement 不得成功（实际 ${r3.status}）`);
    assert.equal(r3.json.error?.code, "REQUIREMENT_NOT_FOUND", `错误码必须是 REQUIREMENT_NOT_FOUND：${JSON.stringify(r3.json)}`);

    // ④ 条目关闭后 ⇒ 候选为空（已关闭的建出来的卡同样过不了归因门），正文改说「暂无未关闭需求」
    store.updateRequirementItem(item.identifier, { status: "closed" });
    const r4 = await post({});
    assert.equal(r4.status, 200);
    assert.deepEqual(r4.json.requirements, [], "已关闭条目不得再当候选");
    assert.ok(r4.json.prompt.includes("本项目暂无未关闭需求"), "空候选态正文必须明说");
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    store.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("判据命令：paths 类紧凑化，且不超 VERIFY_MAX_COMMAND（旧 [ -e … ] 全展开为反例）", () => {
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const todos = buildKickoffTodos({ project: { id: "p1", name: "样例项目" }, gaps });
  const code = todos.find((t) => t.stepId === "code-style");
  assert.ok(code.verifyCommand.length <= VERIFY_MAX_COMMAND, `① 判据命令必须 ≤ ${VERIFY_MAX_COMMAND}（实际 ${code.verifyCommand.length}）`);
  assert.match(code.verifyCommand, /ls -d .*head -1/);
  assert.match(code.verifyCommand, /\[ -n "\$e" \]/);
  assert.ok(!code.verifyCommand.includes("[ -e "), "paths 分支不得退回全展开形态");
  const oldForm = gaps.items.filter((i) => i.stepId === "code-style").map((i) => `( ${(i.signal.any ?? []).map((p) => `[ -e "${p}" ]`).join(" || ")} )`).join(" && ");
  assert.ok(oldForm.length > code.verifyCommand.length, `紧凑形态必须更短（旧 ${oldForm.length} → 新 ${code.verifyCommand.length}）`);
});

test("判据命令：六步逐条实测（正例本仓 0 / 反例空目录非 0）（t22）", async () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const gaps = collectGaps(evaluateKickoff({ files: {}, settings: {} }));
  const todos = buildKickoffTodos({ project: { id: "p1", name: "样例项目" }, gaps });
  assert.equal(todos.length, 6, "六步都要有 todo（本用例的前提）");

  const FULL = {
    envConfig: { gitFlow: "main + feature", cadence: "每日站会", qualityGates: ["需求"] },
    teamTemplate: { roles: [{ role: "reviewer", count: 1 }, { role: "engineer", count: 1, executor: "claude -p" }], qualityGates: ["需求"] },
  };
  const EMPTY = {};
  let payload = EMPTY;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  const emptyDir = mkdtempSync(path.join(os.tmpdir(), "tb-kickoff-empty-"));
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const port = server.address().port;
    // **异步** spawn：同进程假服务 + spawnSync 会死锁（本仓已踩过，见上方 t16 用例注释）。
    const run = (cmd, cwd, base) => new Promise((resolve) => {
      const child = spawn("sh", ["-c", cmd], { cwd, env: { ...process.env, TB_BASE: base }, stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
      child.on("close", (status) => { clearTimeout(timer); resolve({ status, stderr }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ status: null, stderr: String(e?.message ?? e) }); });
    });
    const base = `http://127.0.0.1:${port}`;
    const rows = [];
    for (const todo of todos) {
      payload = FULL;
      const pos = await run(todo.verifyCommand, ROOT, base);
      payload = EMPTY;
      const neg = await run(todo.verifyCommand, emptyDir, base);
      rows.push(`${todo.index}.${todo.stepId}: 正例=${pos.status} 反例=${neg.status}`);
      assert.equal(pos.status, 0, `${todo.step}：满配 + 本仓必须通过（实际 ${pos.status}，stderr=${pos.stderr.slice(0, 300)}）\n命令：${todo.verifyCommand}`);
      assert.notEqual(neg.status, 0, `${todo.step}：空配 + 空目录不得假绿（实际 ${neg.status}，stderr=${neg.stderr.slice(0, 300)}）\n命令：${todo.verifyCommand}`);
    }
    console.log(`六步实测：\n${rows.join("\n")}`);
  } finally {
    server.close();
    server.closeAllConnections?.();
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
