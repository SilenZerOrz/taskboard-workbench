#!/usr/bin/env node
/**
 * 隔离验证台 · **执行会话绑定态**（卡 `-263` / `-271` · 需求 `R187`）。
 *
 * 守的是什么：认领 / 启动执行只写 `tasks.session_id`，不写 `project_sessions`；
 * 而 FR-63 绑定门只读后者 ⇒ 执行会话打开工作台被全视图挡住（2026-11-13 真机）。
 *
 * 本台不起浏览器、不碰 `:3080`、不碰真实 `~/.dsh`：
 *   临时 dataDir + 随机端口 + 独立进程内 HTTP，跑完即删。
 *
 * 判据（双向）：
 *   ① 执行会话 ⇒ bound=true / association=executor / roleDerived=true / 带上任务编号；
 *   ② 陌生会话 ⇒ bound=false（证明门没被整体拆掉）；
 *   ③ 显式批准 ⇒ association=associated（人工口径压过派生）；
 *   ④ 任务 canceled ⇒ 同一会话 bound=false（自动收回，不留永久授权）；
 *   ⑤ 配置页端点列出派生执行会话，且不与已批准/主会话重复；
 *   ⑥ 会话归属优先于 cwd（不被带偏到别的项目）；
 *   ⑦ **现网真实行**（卡 `-271` · 验收⑤）：用真实库里的执行会话行复现
 *      「改前 bound=false → 改后 bound=true·role=executor」，并把「改前口径」做成**负控**
 *      （同一组判据在旧口径下必须转红，否则判据是真空的）。
 *
 * 反证入口：`TB_BENCH_BINDING_REVERSE=old-rule node tools/bench-session-binding.mjs`
 *   把判定换成**改前口径**（只认主会话 / 已批准）⇒ ⑦ 段转红 ⇒ 证明本台真的会红。
 *
 * 退出码：0 = 全 PASS（SKIP 段不计）；1 = 有失败；2 = 环境不具备（本台零依赖，正常不会出现）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** 现网库（只读打开，取一份副本判定；本台一个字节都不写现网库）。 */
const LIVE_DB = process.env.TB_BENCH_LIVE_DB || path.join(ROOT, ".data", "taskboard.sqlite");
/** 反证入口：把判定换成改前口径（只认主会话 / 已批准）。 */
const REVERSE = String(process.env.TB_BENCH_BINDING_REVERSE ?? "").trim();

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail, skipped: false }); };
const skip = (name, detail) => { results.push({ name, ok: true, detail, skipped: true }); };

const tmp = await mkdtemp(path.join(os.tmpdir(), "tb-bench-session-binding-"));
const store = openStore({ dbPath: path.join(tmp, "bench.sqlite") });
const server = createServer({ store, basePath: "" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };

const mkCard = (title) => {
  const item = store.createRequirementItem({ projectId: "p-work", title: `R-${title}` });
  const task = store.createTask({ projectId: "p-work", title, status: "todo" });
  store.associateRequirementTask(item.id, task.id);
  return task;
};

try {
  store.createProject({ id: "p-work", name: "work", workspacePath: "/repo/work" });
  store.createProject({ id: "p-other", name: "other", workspacePath: "/repo/other" });
  store.bindInitialSession("p-work", "sess-main");

  const tExec = mkCard("A");
  store.startTaskExecution(tExec.identifier, { sessionId: "sess-exec" });

  // ① 执行会话：解析到任务所属项目（cwd 故意指向 p-other）
  const ctx = await get("/api/context?session=sess-exec&cwd=/repo/other");
  check("A1 执行会话解析到任务所属项目", ctx.body.project?.id === "p-work", `project=${ctx.body.project?.id}`);
  check("A2 sessionBound=true", ctx.body.sessionBound === true, `sessionBound=${ctx.body.sessionBound}`);
  check("A3 association=executor", ctx.body.association === "executor", `association=${ctx.body.association}`);
  check("A4 roleDerived=true 且带任务编号", ctx.body.roleDerived === true && (ctx.body.executorTasks ?? []).includes(tExec.identifier), `derived=${ctx.body.roleDerived} tasks=${JSON.stringify(ctx.body.executorTasks)}`);

  // ② 陌生会话：仍然是未绑定（门没被拆）
  const stranger = await get("/api/context?session=sess-stranger&project=p-work");
  check("B1 陌生会话仍 bound=false", stranger.body.sessionBound === false, `sessionBound=${stranger.body.sessionBound}`);
  check("B2 陌生会话 role=none", stranger.body.association === "none", `association=${stranger.body.association}`);

  // ③ 显式批准压过派生
  store.approveSessionAssociation("p-work", "sess-exec");
  const approved = await get("/api/context?session=sess-exec&project=p-work");
  check("C1 已批准 ⇒ association=associated", approved.body.association === "associated", `association=${approved.body.association}`);
  check("C2 已批准 ⇒ roleDerived=false", approved.body.roleDerived === false, `derived=${approved.body.roleDerived}`);

  // ④ 终态自收回（用另一个未被批准的会话，避免 C 的批准干扰）
  const tRevoke = mkCard("B");
  store.startTaskExecution(tRevoke.identifier, { sessionId: "sess-revoke" });
  const before = await get("/api/context?session=sess-revoke&project=p-work");
  const cur = store.requireTaskRef(tRevoke.identifier);
  store.updateTask(tRevoke.identifier, { status: "canceled", expectedVersion: cur.version, actor: "agent" });
  const after = await get("/api/context?session=sess-revoke&project=p-work");
  check("D1 卡在途 ⇒ bound=true", before.body.sessionBound === true, `before=${before.body.sessionBound}`);
  check("D2 卡 canceled ⇒ bound=false（自动收回）", after.body.sessionBound === false, `after=${after.body.sessionBound}`);

  // ⑤ 配置页端点：派生执行会话可见且不重复
  const tList = mkCard("C");
  store.startTaskExecution(tList.identifier, { sessionId: "sess-list" });
  const list = await get("/api/projects/p-work/sessions");
  const execs = list.body.executors ?? [];
  check("E1 派生执行会话出现在 executors", execs.some((e) => e.sessionId === "sess-list" && (e.tasks ?? []).includes(tList.identifier)), `executors=${JSON.stringify(execs.map((e) => e.sessionId))}`);
  check("E2 已批准会话不重复列出", !execs.some((e) => e.sessionId === "sess-exec"), `executors=${JSON.stringify(execs.map((e) => e.sessionId))}`);
  check("E3 主会话不重复列出", !execs.some((e) => e.sessionId === "sess-main"), `executors=${JSON.stringify(execs.map((e) => e.sessionId))}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(tmp, { recursive: true, force: true });
}

// =====================================================================================
// ⑦ 现网真实行（卡 `-271` · 需求 `R187` 验收⑤）
//
// 为什么要有这一段：`R187` 的验收口径写的是「**用现网真实行**（`scada-vibe-24` /
// `session-c9755b58…`）在隔离台复现：改前 bound=false，改后 bound=true·role=executor」。
// 上一轮（`-263`）用 `/tmp` 一次性探针做过，**没进仓库** ⇒ 复现不了、下一轮也接不上。
// 这一段把它固化成可复跑的判据：
//   · 现网库**只读**打开 → `VACUUM INTO` 一份临时副本 ⇒ 判定全在副本上做，现网库不写；
//   · 副本上找「执行会话」真实行：持有非终态卡、且既不是项目主会话、也没有任何**已批准**行
//     （这正是报障时的形态：项目已有主会话，但这个执行会话两边都不沾）；
//   · 同一组判据跑两遍：真实口径（须全过）+ **改前口径**（须全红 ⇒ 负控，证明判据非真空）。
// =====================================================================================

/** 改前口径（只认 `projects.initial_session_id` 与 `project_sessions.status='approved'`）。 */
function oldRuleFacts(db, projectId, sessionId) {
  const project = db.prepare("select id, name, initial_session_id from projects where id = ?").get(projectId) ?? null;
  const isMain = Boolean(project?.initial_session_id && project.initial_session_id === sessionId);
  const approved = db.prepare("select status from project_sessions where project_id = ? and session_id = ?").get(projectId, sessionId) ?? null;
  const bound = isMain || approved?.status === "approved";
  const role = isMain ? "main" : approved?.status === "approved" ? "associated" : approved?.status ?? "none";
  return { bound, role, derived: false, tasks: [] };
}

/** 改前口径下的项目反查（主会话 > 已批准 > 其余申请）。 */
function oldRuleFindProject(db, sessionId) {
  const main = db.prepare("select id, name from projects where initial_session_id = ? order by rowid limit 1").get(sessionId);
  if (main) return { project: main, role: "main" };
  const approved = db.prepare("select project_id from project_sessions where session_id = ? and status = 'approved' order by rowid desc limit 1").get(sessionId);
  if (approved) {
    const p = db.prepare("select id, name from projects where id = ?").get(approved.project_id);
    if (p) return { project: p, role: "associated" };
  }
  const row = db.prepare("select project_id, status from project_sessions where session_id = ? order by rowid desc limit 1").get(sessionId);
  if (row) {
    const p = db.prepare("select id, name from projects where id = ?").get(row.project_id);
    if (p) return { project: p, role: row.status };
  }
  return null;
}

const realTmp = await mkdtemp(path.join(os.tmpdir(), "tb-bench-binding-real-"));
try {
  if (!existsSync(LIVE_DB)) {
    skip("R0 现网真实行", `现网库不存在（${LIVE_DB}）——本段不产证据（不影响已跑的判据）`);
  } else {
    const copyPath = path.join(realTmp, "live-copy.sqlite");
    // 只读打开现网库 → VACUUM INTO 一份一致快照（现网库不写、`:3080` 的 WAL 不受影响）
    const src = new DatabaseSync(LIVE_DB, { readOnly: true });
    try { src.exec(`vacuum into '${copyPath.replace(/'/g, "''")}'`); } finally { src.close(); }

    const probe = new DatabaseSync(copyPath, { readOnly: true });
    probe.exec("pragma busy_timeout = 5000");
    let row = null;
    let approvedRows = 0;
    try {
      row = probe.prepare(`
        select t.identifier, t.status, t.project_id, t.session_id
          from tasks t
          join projects p on p.id = t.project_id
         where t.session_id is not null and t.session_id <> ''
           and t.status in ('todo','in_progress','in_review','blocked')
           and p.initial_session_id is not null
           and p.initial_session_id <> t.session_id
           and not exists (select 1 from project_sessions ps where ps.session_id = t.session_id and ps.status = 'approved')
         order by t.updated_at desc, t.rowid desc
         limit 1`).get() ?? null;
      if (row) {
        approvedRows = probe.prepare("select count(*) as n from project_sessions where session_id = ? and status = 'approved'").get(row.session_id).n;
      }
    } finally { probe.close(); }

    if (!row) {
      skip("R0 现网真实行", "现网库里没有「持有非终态卡、且未被批准」的真实行——本段不产证据");
    } else {
      // 在**副本**上开 store：判定跑真代码（openStore 会迁移副本，迁移不碰任务/会话行）
      const realStore = openStore({ dbPath: copyPath, dataDir: realTmp, env: {} });
      const realServer = createServer({ store: realStore, basePath: "" });
      await new Promise((resolve) => realServer.listen(0, "127.0.0.1", resolve));
      const realBase = `http://127.0.0.1:${realServer.address().port}`;
      const realGet = async (p) => { const r = await fetch(realBase + p); return { status: r.status, body: await r.json() }; };

      // 反证模式：把 store 的两处判定换成**改前口径**，让 HTTP 与函数层一起回到旧行为
      const reverseDb = new DatabaseSync(copyPath, { readOnly: true });
      reverseDb.exec("pragma busy_timeout = 5000");
      if (REVERSE === "old-rule") {
        realStore.sessionBinding = (projectId, sessionId) => oldRuleFacts(reverseDb, projectId, sessionId);
        realStore.findProjectBySession = (sessionId) => oldRuleFindProject(reverseDb, sessionId);
      }

      const binding = realStore.sessionBinding(row.project_id, row.session_id);
      const bySession = realStore.findProjectBySession(row.session_id);
      const ctxBody = (await realGet(`/api/context?session=${encodeURIComponent(row.session_id)}`)).body;

      const facts = {
        bound: binding.bound === true,
        role: String(binding.role ?? ""),
        derived: binding.derived === true,
        tasks: Array.isArray(binding.tasks) ? binding.tasks : [],
        byProject: bySession?.project?.id ?? null,
        byRole: bySession?.role ?? null,
        ctxProject: ctxBody?.project?.id ?? null,
        ctxBound: ctxBody?.sessionBound === true,
        ctxRole: String(ctxBody?.association ?? ""),
        ctxDerived: ctxBody?.roleDerived === true,
      };
      const old = oldRuleFacts(reverseDb, row.project_id, row.session_id);
      const oldBy = oldRuleFindProject(reverseDb, row.session_id);
      const oldFacts = {
        bound: old.bound === true,
        role: String(old.role ?? ""),
        derived: old.derived === true,
        tasks: Array.isArray(old.tasks) ? old.tasks : [],
        byProject: oldBy?.project?.id ?? null,
        byRole: oldBy?.role ?? null,
      };

      // 判据函数：真实口径必须**全过**；同一组判据在改前口径下必须**不全过**（负控）。
      const judge = (f) => ({
        bound: f.bound === true,
        role: f.role === "executor",
        derived: f.derived === true,
        tasks: Array.isArray(f.tasks) && f.tasks.includes(row.identifier),
        byProject: f.byProject === row.project_id,
        byRole: f.byRole === "executor",
      });
      const realVerdict = judge(facts);
      const oldVerdict = judge(oldFacts);
      const realAll = Object.values(realVerdict).every(Boolean);
      const oldAll = Object.values(oldVerdict).every(Boolean);

      const label = `${row.identifier}/${row.status}/${row.session_id}`;
      check("R1 现网真实行：持有非终态卡、且无任何已批准行（报障时的形态）",
        approvedRows === 0 && row.session_id !== null,
        `task=${label} approvedRows=${approvedRows}`);
      check("R2 改前口径（只认主会话/已批准）⇒ bound=false（这就是用户当时看到的那扇门）",
        oldFacts.bound === false,
        `oldBound=${oldFacts.bound} oldRole=${oldFacts.role}`);
      check("R3 改后口径 ⇒ bound=true · role=executor · derived=true · 带任务编号",
        realVerdict.bound && realVerdict.role && realVerdict.derived && realVerdict.tasks,
        `binding=${JSON.stringify({ bound: facts.bound, role: facts.role, derived: facts.derived, tasks: facts.tasks })}`);
      check("R4 项目反查 ⇒ 解析到任务所属项目（role=executor）",
        realVerdict.byProject && realVerdict.byRole,
        `byProject=${facts.byProject} byRole=${facts.byRole}（任务所属=${row.project_id}）`);
      check("R5 真 HTTP /api/context?session= ⇒ 项目解析正确且 sessionBound=true（门是开的）",
        facts.ctxProject === row.project_id && facts.ctxBound && facts.ctxRole === "executor" && facts.ctxDerived,
        `ctxProject=${facts.ctxProject} sessionBound=${facts.ctxBound} association=${facts.ctxRole} roleDerived=${facts.ctxDerived}`);
      check("R6 负控：同一组判据在**改前口径**下必须不全过（否则上面几条是真空通过）",
        oldAll === false,
        `oldVerdict=${JSON.stringify(oldVerdict)}`);

      await new Promise((resolve) => realServer.close(resolve));
      realStore.close();
      reverseDb.close();
      console.log(`（真实数据段：${label} · ${REVERSE === "old-rule" ? "反证模式（改前口径）" : "真实口径"}）`);
    }
  }
} catch (error) {
  check("R0 现网真实行", false, `真实数据段异常：${error?.message ?? error}`);
} finally {
  await rm(realTmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.skipped) console.log(`SKIP ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  else console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` —  ${r.detail}` : ""}`);
}
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} PASS${skipped ? ` · ${skipped} SKIP` : ""}`);
process.exit(failed.length ? 1 : 0);
