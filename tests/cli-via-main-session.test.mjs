/**
 * 卡 `-257`（需求 `R183`）：**CLI 执行器默认经项目主会话下发并跟踪**。
 *
 * 用户拍板的口径：除「DSH 宿主会话」直接执行外，其他非绑定会话的 agent 执行者一律交
 * **项目主会话**下发并跟踪，卡片的执行反馈也由主会话回写。
 *
 * 这一组守的是五件事（都是"错了也不报错"的那一类）：
 *   ① 默认**不 spawn** —— 命令投给主会话，服务端一个子进程都不起；
 *   ② **会话真绑上** —— `tasks.session_id` 与 `task_runs.session_id` 都是主会话（否则「打开执行会话」指不到记录）；
 *   ③ **投递失败不回落直跑** —— 回落会让"记录在哪里"悄悄变掉；
 *   ④ **归因门在前** —— 未归因的卡连"投递"都不该发生；
 *   ⑤ `direct:true` 仍是显式出口（隔离验证台 / 无宿主实例），无宿主时回落也必须**在卡上留痕**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const sp = (qs = "") => new URLSearchParams(qs);

const TEMPS = [];
process.on("exit", () => {
  for (const p of TEMPS) { try { rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ } }
});

/** 桩 CLI：只在**真的被 spawn** 时写 marker —— 「没起子进程」因此是可判的读数，不是推断。 */
function stubCli(dir) {
  const marker = path.join(dir, "spawned.txt");
  const file = path.join(dir, "cli-stub");
  writeFileSync(file, [
    "#!/bin/sh",
    `echo "spawned $(date +%s)" >> "${marker}"`,
    `cat > "${path.join(dir, "stdin.txt")}"`,
    `echo "stub: done"`,
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  chmodSync(file, 0o755);
  return { file, marker };
}

function setup({ withHost = true, attribute = true, bindMain = true, sendResult = null } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-cli-via-main-"));
  TEMPS.push(dir);
  const ws = path.join(dir, "ws");
  mkdirSync(ws, { recursive: true });
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  if (attribute) store.associateRequirementTask(item.id, t.id);
  store.saveProjectSettings("p1", {
    teamTemplate: { engine: "instruction", roles: [{ role: "engineer", count: 1, executor: "cli:claude" }], forbiddenExecutors: [] },
  });
  if (bindMain) store.bindInitialSession("p1", "session-main-1");
  const { file, marker } = stubCli(dir);
  const sent = [];
  if (withHost) {
    store.hostSessionPort = {
      sendPrompt: async (sid, text) => {
        sent.push({ sid, text });
        return sendResult ?? { sent: true };
      },
    };
  }
  // 探测桩：把 `claude` 指到桩可执行文件 —— 若真 spawn，marker 一定会出现。
  const probe = (command) => ({ installed: true, binPath: file, searched: [dir] });
  const router = createApiRouter({ store, executorProbe: probe });
  const route = (method, pathname, body = null, query = "") =>
    router.route({ method, pathname, searchParams: sp(query), body });
  return { store, t, dir, marker, sent, route, ws };
}

const execCli = (route, t, body = {}, query = "") =>
  route("POST", `/api/tasks/${t.identifier}/exec-cli`, { executor: "cli:claude", ...body }, query);

test("默认：命令投给项目主会话，服务端**不 spawn**；会话绑到卡上（tasks + task_runs）", async () => {
  const { store, t, marker, sent, route } = setup();
  const r = await execCli(route, t, { async: true });
  assert.equal(r.status, 202);
  const p = r.payload;
  assert.equal(p.via, "main-session");
  assert.equal(p.delivered, true);
  assert.equal(p.sessionId, "session-main-1");
  assert.equal(p.source, "project-main");
  // ① 真投递：正文里三样都在（是派单指令，不是"自己去猜任务书"）
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sid, "session-main-1");
  assert.match(sent[0].text, /派单/, "必须是给主会话的派单指令");
  assert.ok(sent[0].text.includes(t.identifier), "正文必须点明是哪张卡");
  assert.match(sent[0].text, /不得置 done/, "红线必须写进正文");
  assert.match(sent[0].text, /evidence/, "回写要求必须写进正文");
  // ② 没起子进程（marker 不存在）
  assert.equal(existsSync(marker), false, "默认路径不得 spawn CLI（执行要留在会话里）");
  // ③ 会话真绑上：打开执行会话才指得到记录
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.sessionId, "session-main-1");
  assert.equal(after.status, "in_progress");
  const runs = store.listTaskRuns(t.identifier);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, "session-main-1", "尝试记录也要能反查到会话");
  // ④ 卡上留痕（人打开卡就知道记录在哪）
  const comments = store.listComments(t.identifier).map((c) => String(c.body ?? ""));
  assert.ok(comments.some((b) => b.includes("已交项目主会话下发执行")), "必须写一条派发留痕");
  store.close();
});

test("「打开执行会话」跟着会话走：open-session 解析到的正是主会话（同一份 resolveSessionRef）", async () => {
  const { store, t, route } = setup();
  await execCli(route, t, { async: true });
  const r = await route("POST", `/api/tasks/${t.identifier}/open-session`, {});
  assert.equal(r.payload.sessionId, "session-main-1");
  assert.equal(r.payload.source, "task", "任务级引用已绑 ⇒ 打开直达，不再靠回落");
  assert.notEqual(r.payload.reason, "no-session");
  store.close();
});

test("投递失败 ⇒ 如实回 delivered:false，**不回落直跑**（不 spawn、不动状态、不绑会话）", async () => {
  const { store, t, marker, route } = setup({ sendResult: { sent: false, reason: "session-busy" } });
  const r = await execCli(route, t, { async: true });
  assert.equal(r.status, 200);
  assert.equal(r.payload.via, "main-session");
  assert.equal(r.payload.delivered, false);
  assert.equal(r.payload.reason, "session-busy");
  assert.match(String(r.payload.nextAction ?? ""), /主会话/);
  assert.equal(existsSync(marker), false, "投递失败不得改走直跑");
  const after = store.requireTaskRef(t.identifier);
  assert.equal(after.status, "todo", "没投递成功就不该认领");
  assert.equal(after.sessionId ?? null, null, "没投递成功也不该绑会话");
  store.close();
});

test("归因门在前：未归因的卡连**投递**都不发生（不 spawn、不投递、不写评论）", async () => {
  const { store, t, marker, sent, route } = setup({ attribute: false });
  await assert.rejects(() => execCli(route, t, { async: true }), (error) => error.code === "EXECUTION_NOT_ATTRIBUTED");
  assert.equal(sent.length, 0, "未归因不得投递到主会话");
  assert.equal(existsSync(marker), false);
  assert.deepEqual(store.listComments(t.identifier), [], "被门拦下不得留任何「已派发」痕迹");
  store.close();
});

test("显式 direct:true ⇒ 服务端直跑（隔离验证台/无宿主的路），回包也写明通道", async () => {
  const { store, t, marker, sent, route } = setup();
  const r = await execCli(route, t, { direct: true });
  assert.equal(sent.length, 0, "显式直跑不得投递到会话");
  assert.equal(r.payload.via, "direct");
  assert.equal(r.payload.explicitDirect, true);
  assert.equal(existsSync(marker), true, "直跑必须真的调 CLI（marker 是唯一硬证）");
  assert.match(readFileSync(marker, "utf8"), /spawned/);
  store.close();
});

test("无宿主通道 ⇒ 回落直跑，但**卡片上必须留痕**「执行记录不在任何会话里」", async () => {
  const { store, t, marker, route } = setup({ withHost: false });
  const r = await execCli(route, t, { async: true });
  assert.equal(r.payload.via, "direct");
  assert.equal(r.payload.delivered, false);
  assert.equal(r.payload.fallbackReason, "host-unavailable");
  const comments = store.listComments(t.identifier).map((c) => String(c.body ?? ""));
  assert.ok(comments.some((b) => b.includes("不在任何会话里")), "回落必须在卡上留痕（不能只存在于这次响应里）");
  // async 直跑：稍等桩写完 marker
  for (let i = 0; i < 50 && !existsSync(marker); i += 1) await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(existsSync(marker), true, "回落路径确实直跑了");
  store.close();
});

test("dryRun：零副作用 —— 不投递、不 spawn、不动状态；但**如实说清会怎么下发**", async () => {
  const { store, t, marker, sent, route } = setup();
  const r = await execCli(route, t, { dryRun: true });
  assert.equal(r.payload.ran, false);
  assert.equal(r.payload.dryRun, true);
  assert.equal(r.payload.via, "main-session");
  assert.equal(r.payload.mainSession.sessionId, "session-main-1");
  assert.equal(r.payload.mainSession.deliverable, true);
  assert.ok(String(r.payload.promptToMainSession ?? "").includes(t.identifier), "预览要能看到投给主会话的正文");
  assert.equal(sent.length, 0);
  assert.equal(existsSync(marker), false);
  assert.equal(store.requireTaskRef(t.identifier).status, "todo");
  store.close();
});

test("源码口径：via-main 分支必须写在 `assertAttributed` **之后**（门序不得被改动挪位）", () => {
  const src = readFileSync(new URL("../src/server/api.mjs", import.meta.url), "utf8");
  const gate = src.indexOf("store.assertAttributed(task.identifier);");
  const branch = src.indexOf("const viaMain = wantMain;");
  assert.ok(gate > 0 && branch > 0, "两处都必须存在");
  assert.ok(gate < branch, "归因门必须在 via-main 分支之前");
});
