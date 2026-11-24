#!/usr/bin/env node
/**
 * 隔离验证台 · **执行中断自愈：无心跳在途卡自动回收 + 看板显式处置**（卡 `-294` · 需求 `R198`）。
 *
 * 守的是什么（真机事故现场 `-293` · 2026-11-23 16:52 派单 → 17:03 进程中断 → 次日 11:37
 * 那张卡**仍在「进行中」/ 停滞 1148m**；`-290` 返工后无人接手、停滞 1247m）：
 *
 *   ① **没有心跳的在途卡永远回收不掉** —— `exec-cli` 在「已在 `in_progress` 的卡」上再派单时，
 *      `claimForCliExecution` 走 `already-in-progress` 分支 ⇒ `claimed:false`、**既不建认领锁也不建心跳**；
 *      而回收器 `reclaimStaleClaims()` **只扫 `claim_lock is not null` 的卡** ⇒ 这张卡永远停在「进行中」。
 *      人看到的是「运行中」，实际没人跑。
 *   ② 回收判据必须同时满足「心跳超时 + 进程不存在」，**不许把活任务判死**（双向反证是硬要求）。
 *   ③ 认领锁**不续租** ⇒ 跑过 TTL（30 分钟）的**活**任务会被回收器当成「认领过期 + 心跳陈旧」而判死
 *      （`executor.mjs` 里「子进程活着期间必须持续续命认领锁」那句注释写的正是这件事，只是没落成代码）。
 *   ④ 看板必须能判定「没人跑了」，并给出**可点的处置**（立即回收 / 重派 / 释放归属）。
 *
 * 本台**不起浏览器、不碰 `:3080`、不碰真实 `~/.dsh`**：临时 dataDir + 随机端口 + 真 HTTP，跑完即删。
 *
 * 判据（四段 · 共 25 项）：
 *   A 复现与修复：改前 `claimed:false` + 无锁 + 无心跳 ⇒ 改后 `claimed:true` + 有锁 + 有心跳；
 *   B 自愈回收：心跳陈旧 + 进程不在 ⇒ 自动退回「可开工」+ 可读留痕 + **尝试记录保留** + **不删卡**；
 *   C **双向反证**：心跳持续（假活）⇒ 绝不回收 · 会话还在（只是空闲）⇒ 不抢 · 有效租约 ⇒ 绝不回收；
 *   D 看板处置：`inflight.unwatched` 上报 + `POST /reclaim` 真 200 + 诊断动作含「重派 / 释放归属 / 回收」。
 *
 * 反证入口：`TB_BENCH_SELFHEAL_REVERSE=legacy node tools/bench-inflight-selfheal.mjs`
 *   **真源码对调**：把 `HEAD:src/`（= 本轮改动**之前**的实现）抽到临时目录，本台改跑**改前代码**
 *   ⇒ A/B/C/D 多段转红 ⇒ 证明本台真的会红（判据非真空）。
 *   基线自检：若 `HEAD:src/` 里已含本轮的修复（说明修复已被提交），反证读数会全绿 —— 届时本台会**显式告警**。
 *
 * 退出码：0 = 全 PASS；1 = 有失败；2 = 环境不具备（本台零依赖，正常不会出现）。
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO_SRC = path.join(ROOT, "src");
/** 反证入口：把判定换成改前口径（跑 HEAD 的旧实现）。 */
const REVERSE = String(process.env.TB_BENCH_SELFHEAL_REVERSE ?? "").trim();
const LEGACY = REVERSE === "legacy";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail, skipped: false }); };

const tmp = await mkdtemp(path.join(os.tmpdir(), "tb-bench-inflight-selfheal-"));

/**
 * 反证：**把 `HEAD:src/`（改前实现）抽到临时目录**，本台改跑它。
 * `src/` 只依赖 node 内置模块与相对路径 ⇒ 整棵树搬走仍自洽（不用改任何 import）。
 */
let srcDir = REPO_SRC;
let baselineHasFix = null;
if (LEGACY) {
  try {
    const revDir = path.join(tmp, "rev-src");
    const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD", "src"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
    for (const f of files) {
      const out = path.join(revDir, f);
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, execFileSync("git", ["show", `HEAD:${f}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }));
    }
    srcDir = path.join(revDir, "src");
    const base = execFileSync("git", ["show", "HEAD:src/core/executor.mjs"], { cwd: ROOT, encoding: "utf8" });
    baselineHasFix = /ensureClaimLease/.test(base);
  } catch (error) {
    console.error(`【反证】抽取 HEAD:src 失败：${error?.message ?? error}`);
    process.exit(2);
  }
}

const importFrom = (rel) => import(pathToFileURL(path.join(srcDir, rel)).href);
const storeMod = await importFrom("core/store.mjs");
const executorMod = await importFrom("core/executor.mjs");
const serverMod = await importFrom("server/server.mjs");
const { openStore, DEFAULT_CLAIM_TTL_MS, DEFAULT_HEARTBEAT_GAP_MS } = storeMod;
const { claimForCliExecution } = executorMod;
const { createServer } = serverMod;

/**
 * 自愈动作（改前＝只有「有锁的卡」那条路；改后＝两条路都走：既有认领到期 + 无心跳在途）。
 * 改前代码里**没有** `reclaimUnwatchedInflights` ⇒ 反证时自然只剩一条路。
 */
function selfHeal(store, opts) {
  const legacy = store.reclaimStaleClaims(opts) ?? [];
  if (typeof store.reclaimUnwatchedInflights !== "function") return legacy;
  return [...legacy, ...(store.reclaimUnwatchedInflights(opts) ?? [])];
}

const store = openStore({ dbPath: path.join(tmp, "bench.sqlite") });
const server = createServer({ store, basePath: "" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const post = async (p, body = {}) => {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};

/** 宿主会话通道替身：只记录不真投；`live/running` 可切换，用来造「进程还在 / 已不在」。 */
const host = {
  sessions: new Map(), // sessionId → { live, running }
  prompts: [],
  sendPrompt: async (sid, prompt) => { host.prompts.push({ sid, prompt }); return { sent: true }; },
  sessionState: (sid) => {
    const s = host.sessions.get(sid);
    return { sessionId: sid ?? null, live: Boolean(s?.live), running: Boolean(s?.running), status: s?.running ? "running" : (s?.live ? "idle" : null), pending: 0 };
  },
  openSession: async () => ({ opened: true }),
};
store.hostSessionPort = host;

const PROJECT = "p-selfheal";
/** 建一张**已归因**的卡（归因门是执行入口的前置）。 */
const mkCard = (title, status = "todo") => {
  const item = store.createRequirementItem({ projectId: PROJECT, title: `R-${title}` });
  const task = store.createTask({ projectId: PROJECT, title, status });
  store.associateRequirementTask(item.id, task.id);
  return task;
};
/** 造「事故形状」：在途 + **没有认领锁** + 心跳停在那一刻 + 会话已不在。 */
const mkDeadInflight = (title, sessionId = "sess-main") => {
  const t = mkCard(title);
  store.teamSetTaskStatus(t.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(t.identifier, { actor: "cli-executor", sessionId });
  store.heartbeatTaskRun(t.identifier, { now: Date.now() - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  return t;
};

try {
  store.createProject({ id: PROJECT, name: "selfheal", workspacePath: "/repo/selfheal" });
  store.bindInitialSession(PROJECT, "sess-main");
  host.sessions.set("sess-main", { live: true, running: true });

  // ===================================================================================
  // A 段 · 复现与修复：「已在进行中」的卡再派单 ⇒ 必须建锁 + 开心跳
  // ===================================================================================
  // 复现形状：`in_progress` **且没有认领锁**（`teamSetTaskStatus` 推进状态不建锁 —— 这正是
  // `exec-cli` 的 `direct-handoff` 与「上次派单中断」留下的形状）。
  const tA = mkCard("A 无心跳在途卡");
  store.teamSetTaskStatus(tA.identifier, { status: "in_progress", actor: "cli-executor" });
  const beforeA = store.taskClaimState(tA.identifier);
  check("A0 复现前：卡在「进行中」但**没有认领锁**（回收器扫不到 ⇒ 永远停在进行中）",
    beforeA.locked === false, `locked=${beforeA.locked} status=${store.requireTaskRef(tA.identifier).status}`);

  const claimA = claimForCliExecution(store, tA.identifier, { actor: "cli-executor", sessionId: "sess-main" });
  const afterA = store.taskClaimState(tA.identifier);
  const taskA = store.requireTaskRef(tA.identifier);
  const runsA = store.listTaskRuns(tA.identifier);

  check("A1 派单调用的回包 claimed=true（改前是 claimed:false ⇒ 没有心跳）",
    claimA.claimed === true, `claimed=${claimA.claimed} note=${claimA.note} claimState=${claimA.claimState ?? "null"}`);
  check("A2 认领锁已建立（claim_lock 非空）⇒ 回收器扫得到这张卡",
    afterA.locked === true, `locked=${afterA.locked} expiresAt=${afterA.expiresAt}`);
  check("A3 任务级心跳已写（last_heartbeat_at 非空）⇒ 不是「无心跳在途卡」了",
    Boolean(taskA.lastHeartbeatAt), `lastHeartbeatAt=${taskA.lastHeartbeatAt}`);
  check("A4 不重复建尝试记录（只开一条 run）",
    runsA.length === 1, `runs=${runsA.length}`);
  check("A5 认领锁带过期时间（到期即失效，不会永久占位）",
    Boolean(afterA.expiresAt) && new Date(afterA.expiresAt).getTime() > Date.now(), `expiresAt=${afterA.expiresAt}`);

  // ===================================================================================
  // B 段 · 自愈回收：进程中断 ⇒ 自动退回「可开工」+ 留痕 + 尝试记录保留
  // ===================================================================================
  const tB = mkDeadInflight("B 中断在途卡");
  host.sessions.set("sess-main", { live: false, running: false });

  const healed = selfHeal(store, { now: Date.now() });
  const healedIds = healed.map((h) => h.identifier);
  const taskB = store.requireTaskRef(tB.identifier);
  const commentsB = store.listComments(tB.identifier);
  const runsB = store.listTaskRuns(tB.identifier);
  const auditsB = store.listGovernanceAudit().filter((a) => a.action === "reclaim");

  check("B1 进程中断后自动回收：卡退回「可开工(todo)」",
    taskB.status === "todo", `status=${taskB.status} healed=${JSON.stringify(healedIds)}`);
  check("B2 回收有**可读留痕**（评论写明「执行进程已中断，已回收」）",
    commentsB.some((c) => /执行进程已中断，已回收/.test(c.body)),
    `comments=${commentsB.length} last=${commentsB.at(-1)?.body?.slice(0, 60) ?? ""}`);
  check("B3 **尝试记录保留**（不删）：那条 run 仍在，且 outcome=reclaimed",
    runsB.length === 1 && String(runsB[0].outcome) === "reclaimed",
    `runs=${runsB.length} outcome=${runsB[0]?.outcome}`);
  check("B4 **不删卡**（卡仍在库里，状态之外的东西一律不动）",
    store.requireTaskRef(tB.identifier).identifier === tB.identifier, `identifier=${tB.identifier}`);
  check("B5 回收有审计留痕（action=reclaim · reason=inflight-no-heartbeat）",
    auditsB.some((a) => a.reason === "inflight-no-heartbeat"), `audits=${JSON.stringify(auditsB.map((a) => a.reason))}`);

  // B6 改后形状（**有**认领锁）：租约到期后同样自动回收 —— 修复不能制造新的「卡住」类别。
  const afterLease = Date.now() + DEFAULT_CLAIM_TTL_MS + 60_000;
  const healedA = selfHeal(store, { now: afterLease });
  const taskA2 = store.requireTaskRef(tA.identifier);
  const runsA2 = store.listTaskRuns(tA.identifier);
  check("B6 有认领锁的卡：租约到期 + 心跳陈旧 ⇒ 同样自动回收（不留新的卡住类别）",
    taskA2.status === "todo" && healedA.some((h) => h.identifier === tA.identifier),
    `status=${taskA2.status} healed=${JSON.stringify(healedA.map((h) => h.identifier))}`);
  check("B6b 回收后尝试记录仍在（只闭合，不删）",
    runsA2.length === 1 && String(runsA2[0].outcome) === "reclaimed",
    `runs=${runsA2.length} outcome=${runsA2[0]?.outcome}`);

  // ===================================================================================
  // C 段 · **双向反证**（硬要求：不能把活任务判死）
  // ===================================================================================
  // C1 假活进程对照：心跳持续 ⇒ 绝不回收（跑满 45 分钟 > 租约 TTL 30 分钟：
  //    正是「锁不续租 ⇒ 活任务在 30 分钟后被当成死的」那个坑的对照点）。
  //    这张卡从 `todo` 起步 ⇒ **两边都持有认领锁**（改前靠 `startTaskExecution` 建锁），
  //    于是「续租」这件事成了唯一变量。
  const tC1 = mkCard("C1 假活进程");
  claimForCliExecution(store, tC1.identifier, { actor: "cli-executor" });
  const beatUntil = Date.now() + 45 * 60_000;
  for (let t = Date.now(); t < beatUntil; t += 30_000) {
    store.heartbeatTask(tC1.identifier, { now: t, silent: true, renewLease: true });
  }
  const healedC1 = selfHeal(store, { now: beatUntil });
  const taskC1 = store.requireTaskRef(tC1.identifier);
  check("C1 假活进程（心跳持续 45 分钟 > 租约 TTL）⇒ **绝不回收**",
    taskC1.status === "in_progress" && !healedC1.some((h) => h.identifier === tC1.identifier),
    `status=${taskC1.status} healed=${JSON.stringify(healedC1.map((h) => h.identifier))}`);
  const claimC1 = store.taskClaimState(tC1.identifier, { now: beatUntil });
  check("C1b 心跳续租 ⇒ 认领锁**仍持有且没过期**（活任务不会被租约到期误杀）",
    claimC1.locked === true && claimC1.expired === false,
    `claim=${JSON.stringify(claimC1)}`);

  // C2 会话还在（只是空闲，agent 可能正在思考）⇒ **自愈路径不抢**（交给既有的「认领到期」那条路）。
  const tC2 = mkCard("C2 会话空闲");
  store.teamSetTaskStatus(tC2.identifier, { status: "in_progress", actor: "cli-executor" });
  store.startTaskRun(tC2.identifier, { actor: "cli-executor", sessionId: "sess-idle" });
  store.heartbeatTaskRun(tC2.identifier, { now: Date.now() - (DEFAULT_HEARTBEAT_GAP_MS + 60_000), silent: true });
  host.sessions.set("sess-idle", { live: true, running: false });
  const rC2 = typeof store.reclaimUnwatchedInflight === "function"
    ? store.reclaimUnwatchedInflight(tC2.identifier, { now: Date.now() })
    : { reclaimed: false, reason: "pre-fix-no-selfheal-path" };
  check("C2 会话还在（空闲但没死）⇒ 自愈路径**不抢**（进程没死 ⇒ 不判死）",
    rC2.reclaimed === false && store.requireTaskRef(tC2.identifier).status === "in_progress",
    `reclaimed=${rC2.reclaimed} reason=${rC2.reason}`);

  // C3 有效租约（心跳刚续过）⇒ 绝不回收，即便心跳看起来旧。
  const tC3 = mkCard("C3 有效租约");
  store.teamSetTaskStatus(tC3.identifier, { status: "in_progress", actor: "cli-executor" });
  claimForCliExecution(store, tC3.identifier, { actor: "cli-executor" });
  store.heartbeatTask(tC3.identifier, { now: Date.now(), silent: true, renewLease: true });
  const healedC3 = selfHeal(store, { now: Date.now() + 1000 });
  const taskC3 = store.requireTaskRef(tC3.identifier);
  check("C3 有效租约（心跳刚续）⇒ **绝不回收**",
    taskC3.status === "in_progress" && !healedC3.some((h) => h.identifier === tC3.identifier),
    `status=${taskC3.status} healed=${JSON.stringify(healedC3.map((h) => h.identifier))}`);

  // ===================================================================================
  // D 段 · 看板显式处置：能判定「没人跑了」，且处置入口**点得动**
  // ===================================================================================
  const tD = mkDeadInflight("D 看板处置卡");
  host.sessions.set("sess-main", { live: false, running: false });

  // D1 看板列表把「在途事实」带上来（供卡面标记「无心跳」，不谎称「运行中」）。
  const listBody = await get(`/api/tasks?project=${PROJECT}&withWatchdog=1`);
  const rowD = (listBody.body.tasks ?? []).find((t) => t.identifier === tD.identifier);
  check("D1 看板列表带 `inflight` 在途事实（卡面据此判「无心跳」）",
    Boolean(rowD?.inflight) && rowD.inflight.hasRun === true,
    `inflight=${JSON.stringify(rowD?.inflight ?? null)}`);
  check("D1b `inflight.unwatched=true`（= 在途但心跳已陈旧 ⇒ 没人真在跑）",
    rowD?.inflight?.unwatched === true, `unwatched=${rowD?.inflight?.unwatched}`);

  // D2 详情回包同样带在途事实（抽屉要说清「有没有人在跑」）。
  const detail = await get(`/api/tasks/${tD.identifier}`);
  check("D2 任务详情带 `inflight`（抽屉的「在途状态」段据此渲染）",
    Boolean(detail.body.inflight) && detail.body.inflight.attempt >= 1,
    `inflight=${JSON.stringify(detail.body.inflight ?? null)}`);

  // D3 诊断给出**可点的处置**：回收 / 重派 / 释放归属。
  const exec = await get(`/api/tasks/${tD.identifier}/execution`);
  const unclaimed = (exec.body.diagnostics ?? []).find((d) => d.kind === "unclaimed");
  const actionIds = (unclaimed?.actions ?? []).map((a) => a.id);
  check("D3 诊断产出「无人认领」条目（= 没人真在跑）",
    Boolean(unclaimed), `kinds=${JSON.stringify((exec.body.diagnostics ?? []).map((d) => d.kind))}`);
  check("D4 诊断动作含**回收 / 重派 / 释放归属**三个显式处置",
    actionIds.includes("reclaim") && actionIds.includes("retry") && actionIds.includes("release"),
    `actions=${JSON.stringify(actionIds)}`);
  check("D5 诊断正文写明「无心跳」事实（界面不许谎称「运行中」）",
    /心跳/.test(String(unclaimed?.detail ?? "")), `detail=${String(unclaimed?.detail ?? "").slice(0, 90)}`);

  // D6 处置入口**点得动**：`POST /reclaim` 对「没有认领锁」的卡必须 200（改前恒 409 ⇒ 人点不动）。
  const reclaimed = await post(`/api/tasks/${tD.identifier}/reclaim`, {});
  const taskD2 = store.requireTaskRef(tD.identifier);
  check("D6 `POST /reclaim` 对无锁卡**真能回收**（改前恒 409 ⇒ 人点不动）",
    reclaimed.status === 200 && reclaimed.body.reclaimed === true && taskD2.status === "todo",
    `status=${reclaimed.status} reclaimed=${reclaimed.body.reclaimed} taskStatus=${taskD2.status} reason=${reclaimed.body.reason ?? "-"}`);

  // D7 回收后诊断自动消解（`unclaimed` 不再报）。
  const execAfter = await get(`/api/tasks/${tD.identifier}/execution`);
  check("D7 回收后「无人认领」诊断自动消解",
    !(execAfter.body.diagnostics ?? []).some((d) => d.kind === "unclaimed"),
    `kinds=${JSON.stringify((execAfter.body.diagnostics ?? []).map((d) => d.kind))}`);
} catch (error) {
  check("Z0 台子执行", false, `异常：${error?.stack ?? error}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(tmp, { recursive: true, force: true });
}

for (const r of results) {
  if (r.skipped) console.log(`SKIP ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  else console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` —  ${r.detail}` : ""}`);
}
const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
console.log(`\n${results.length - failed.length - skipped}/${results.length - skipped} PASS${skipped ? ` · ${skipped} SKIP` : ""}${LEGACY ? "（反证模式：HEAD 的改前实现）" : ""}`);
if (LEGACY) {
  // 反证自检：基线若已含本轮修复（修复被提交过），反证读数会全绿 ⇒ 显式告警，别让人误读。
  if (baselineHasFix) console.log("⚠【反证基线告警】HEAD:src 里已含本轮修复（ensureClaimLease 存在）⇒ 反证读数不代表「改前行为」，请先确认基线。");
  else if (failed.length < 3) console.log("⚠【反证自检告警】转红不足 3 条 ⇒ 本台在旧基线上没转红，判据可能是真空的。");
  else console.log(`（反证自检：改前实现下 ${failed.length} 条转红 ⇒ 判据非真空）`);
}
process.exit(failed.length ? 1 : 0);
