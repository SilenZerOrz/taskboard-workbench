/**
 * FR-79 / FR-82 补口：「投递到会话后没交作业」的**判定 + 收口留痕**（真机 2026-10-22 · 续二十二 → 续三十三收口）。
 *
 * 真机现场：看板把派发指令投进项目主会话，会话里的 agent 确实在干活（改了 `web/app.js`、调了
 * `taskboard_*`），但**既没提交「待验收」也没留评论** ⇒ 被看护按心跳陈旧回收，任务静默退回 `todo`；
 * 看板上只剩一句「认领已回收」，**看不出成果可能已经落在工作区** —— 工作成果与看板状态脱钩。
 *
 * 本组用例钉三件：纯函数四条判据（含负例与「系统留痕不得自证」）；回收 / 超时两处收口都留痕且事件可读；
 * 交过作业的会话**不得**被误判（真阳性与假阳性都钉住）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, DEFAULT_CLAIM_TTL_MS } from "../src/core/store.mjs";
import { evaluateTaskDiagnostics } from "../src/core/diagnostics.mjs";
import {
  SYSTEM_TRACE_MARKERS, UNTAKEN_COMMENT_MARKER, UNTAKEN_RUN_OUTCOMES,
  detectUntakenDelivery, findLatestRun, isConclusionComment, untakenReasonLabel,
} from "../src/core/delivery.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "投递出去没人汇报", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, item, t };
}

const mkRun = (over = {}) => ({
  attempt: 1, sessionId: "s1", outcome: "reclaimed",
  startedAt: "2026-10-22T10:00:00.000Z", ...over,
});
const STALE_SESSION_PORT = { sessionState: () => ({ sessionId: "s1", live: false, running: false, status: null, pending: 0 }) };

test("判定四条判据：任一条不成立都不算「未收尾」（逐条负例）", () => {
  const base = { task: { status: "todo" }, runs: [mkRun()], comments: [] };
  assert.ok(detectUntakenDelivery(base), "正例应先成立（否则下面的负例没有意义）");
  // ① 任务已离开可执行侧（已有结论）
  assert.equal(detectUntakenDelivery({ ...base, task: { status: "in_review" } }), null);
  assert.equal(detectUntakenDelivery({ ...base, task: { status: "done" } }), null);
  assert.equal(detectUntakenDelivery({ ...base, task: { status: "blocked" } }), null);
  // ② 不是会话投递（CLI 执行器投递以退出码收口，成败都是结论）
  assert.equal(detectUntakenDelivery({ ...base, runs: [mkRun({ sessionId: null })] }), null);
  // ③ 结局有结论
  for (const outcome of ["success", "failed", "blocked", "cancelled", "released", "interrupted"]) {
    assert.equal(detectUntakenDelivery({ ...base, runs: [mkRun({ outcome })] }), null, `${outcome} 不该被当成未收尾`);
  }
  // ④ 该次开始之后有结论评论（提交待验收 / 进展汇报 / 人工反馈都算）
  assert.equal(detectUntakenDelivery({ ...base, comments: [{ body: "进度：改完两个文件", createdAt: "2026-10-22T10:05:00.000Z" }] }), null);
  // 该次开始**之前**的评论不算回报（那可能是上一次尝试的遗留）
  assert.ok(detectUntakenDelivery({ ...base, comments: [{ body: "上一轮的结论", createdAt: "2026-10-22T09:00:00.000Z" }] }), "本次开始前的评论不得当成这次已回报");
  // 没有尝试记录 / 时间戳不可解析 → 不判定（宁可不报，也不臆断）
  assert.equal(detectUntakenDelivery({ ...base, runs: [] }), null);
  assert.equal(detectUntakenDelivery({ ...base, runs: [mkRun({ startedAt: "not-a-date" })] }), null);
  assert.equal(detectUntakenDelivery({}), null);
});

test("系统留痕不得自证：投递留痕 / CLI 留痕 / 收口留痕 / 回收留痕都不算「交过作业」", () => {
  for (const marker of SYSTEM_TRACE_MARKERS) {
    assert.equal(isConclusionComment(`前情提要：${marker}（系统写的）`), false, `${marker} 必须被当作系统留痕`);
  }
  for (const outcome of UNTAKEN_RUN_OUTCOMES) {
    const runs = [mkRun({ outcome })];
    const comments = SYSTEM_TRACE_MARKERS.map((m, i) => ({ body: `${m} 第 ${i + 1} 条系统留痕`, createdAt: "2026-10-22T10:10:00.000Z" }));
    assert.ok(detectUntakenDelivery({ task: { status: "todo" }, runs, comments }),
      `收口自己写的留痕（${outcome}）不得把自己这次尝试判成「已回报」——否则诊断再也命中不了`);
  }
  assert.equal(isConclusionComment("进度：做了一半"), true, "人的结论/进展仍要被认可");
  assert.equal(isConclusionComment(""), true, "空评论按结论处理（宁可保守，不误报未收尾）");
});

test("最近一次尝试取最大 attempt；结局文案可读", () => {
  const runs = [mkRun({ attempt: 2 }), mkRun({ attempt: 1, sessionId: null }), mkRun({ attempt: 3, outcome: "success" })];
  assert.equal(findLatestRun(runs).attempt, 3);
  assert.equal(findLatestRun([]) ?? null, null);
  assert.match(untakenReasonLabel("reclaimed"), /回收/);
  assert.match(untakenReasonLabel("timeout"), /上限/);
  assert.match(untakenReasonLabel("weird"), /weird/);
});

test("回收收口：留一条【投递未收尾】评论 + 一条事件，且 FR-79 诊断命中并给首选动作「打开执行会话」", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.startTaskExecution(t.identifier, { sessionId: "s-worked-but-silent" }); // 会话投递 + 认领（来源 todo）
  store.hostSessionPort = STALE_SESSION_PORT;
  const r = store.reclaimStaleClaim(t.identifier, { now: now + DEFAULT_CLAIM_TTL_MS + 60_000 });
  assert.equal(r.reclaimed, true);
  assert.equal(r.untaken?.attempt, 1, "回收结果要如实带上「这次未收尾」");
  const untaken = store.listComments(t.identifier).filter((c) => String(c.body).includes(UNTAKEN_COMMENT_MARKER));
  assert.equal(untaken.length, 1, "刚留一条，不许重复刷屏");
  assert.match(untaken[0].body, /工作区可能已有未提交的改动/, "必须点明成果可能已落在工作区");
  assert.match(untaken[0].body, /s-worked-but-silen/, "要点出是哪条会话（截断展示）");
  const events = store.listTaskEvents(t.identifier).filter((e) => e.type === "delivery_untaken");
  assert.equal(events.length, 1);
  assert.equal(events[0].to, "todo", "事件要落在收口后的真实状态上");
  const diag = evaluateTaskDiagnostics(store, t.identifier);
  const d = diag.diagnostics.find((x) => x.kind === "delivery_untaken");
  assert.ok(d, "诊断必须命中（这是「可见」的出口）");
  assert.equal(d.severity, "medium");
  assert.equal(d.actions.find((a) => a.kind === "primary").id, "open_session", "首选动作＝打开执行会话看现场");
  assert.equal(d.count, 1);
  store.close();
});

test("超时收口同样留痕；进程重启的 interrupted 不留（那是另一类事故）", () => {
  const a = setup();
  const now = Date.now();
  a.store.claimTask(a.t.identifier, { sessionId: "s-timeout", now: now - 40 * 60 * 1000 });
  a.store.hostSessionPort = STALE_SESSION_PORT;
  const rec = a.store.reconcileOrphanRuns({ now });
  assert.equal(rec.ended.length, 1);
  assert.equal(rec.ended[0].outcome, "timeout");
  assert.match(String(rec.ended[0].untaken ?? ""), /上限/, "收口清单要能看出这次属「未收尾」");
  assert.ok(a.store.listComments(a.t.identifier).some((c) => String(c.body).includes(UNTAKEN_COMMENT_MARKER)));
  assert.ok(a.store.listTaskEvents(a.t.identifier).some((e) => e.type === "delivery_untaken"));
  a.store.close();

  const b = setup();
  b.store.claimTask(b.t.identifier, { sessionId: "s-boot" });
  const recBoot = b.store.reconcileOrphanRuns({ boot: true });
  assert.equal(recBoot.ended[0].outcome, "interrupted");
  assert.equal(recBoot.ended[0].untaken, null, "boot 的 interrupted 不得被算成「投递未收尾」");
  assert.equal(b.store.listComments(b.t.identifier).some((c) => String(c.body).includes(UNTAKEN_COMMENT_MARKER)), false);
  b.store.close();
});

test("假阳性守卫：会话交了作业（有结论评论）就不得再判未收尾，也不留痕", () => {
  const { store, t } = setup();
  const now = Date.now();
  store.startTaskExecution(t.identifier, { sessionId: "s-diligent" });
  store.addComment(t.id, { body: "进度：已改完 web/app.js，正在跑测试" }); // 会话真的回报了
  store.hostSessionPort = STALE_SESSION_PORT;
  const r = store.reclaimStaleClaim(t.identifier, { now: now + DEFAULT_CLAIM_TTL_MS + 60_000 });
  assert.equal(r.reclaimed, true, "回收本身仍照常（心跳陈旧是事实）");
  assert.equal(r.untaken, null, "交过作业的会话不得被贴「未收尾」");
  assert.equal(store.listComments(t.identifier).some((c) => String(c.body).includes(UNTAKEN_COMMENT_MARKER)), false);
  assert.equal(evaluateTaskDiagnostics(store, t.identifier).diagnostics.some((x) => x.kind === "delivery_untaken"), false);
  store.close();
});

