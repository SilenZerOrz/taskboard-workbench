/**
 * 卡 `-258`（需求 `R184`）· `GET /api/tasks/:ref` 回包新增 `executionRecord`。
 *
 * 钉四件事：
 *   1. **形状**：无证据无尝试 ⇒ `{evidence:null, run:null, runsCount:0}`（显式空，不臆造）
 *   2. **接上库**：结构化四节证据原样回传；`run` 取**最近一次**尝试（attempt 最大），不是第一/进行中
 *   3. **只读**：GET 一个字节都不写（version / 事件数 / 证据条数 / 尝试条数全不变）
 *   4. **前端真消费**（源码守卫）—— 且该段排在「概览」之后（真机 `-248` 的缺陷就是这段不存在）
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, t, route };
}

const FULL = { verdict: "判定：完成", deviation: "无", boundary: "未碰 :3080", artifacts: ["src/a.mjs", "npm test 1268/1268/0"] };

test("A 形状：既无证据也无尝试 ⇒ 三个字段显式空，不臆造", async () => {
  const { route, t } = setup();
  const r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.equal(r.status, 200);
  const rec = r.payload.executionRecord;
  assert.ok(rec, "回包必须带 executionRecord");
  assert.equal(rec.evidence, null);
  assert.equal(rec.run, null);
  assert.equal(rec.runsCount, 0);
  // 既有字段一个不少
  assert.ok(r.payload.task && Array.isArray(r.payload.comments) && r.payload.reviewEvidence && r.payload.ticketStage);
});

test("B 接上库：四节证据原样回传 + run 取最近一次（不是第一次）", async () => {
  const { store, route, t } = setup();
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });

  const now = Date.now();
  // 直接开/闭尝试，绕开认领锁（本条只验「取最近一次」的口径，不验认领）
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor", now });
  store.endTaskRun(t.identifier, { outcome: "failed", summary: "失败一次", actor: "system", now: now + 1000 });
  store.startTaskRun(t.identifier, { sessionId: "s2", actor: "cli-executor", now: now + 2000 });
  store.endTaskRun(t.identifier, { outcome: "success", summary: "第二次成功", actor: "system", now: now + 9000 });

  const r = await route("GET", `/api/tasks/${t.identifier}`);
  const rec = r.payload.executionRecord;
  assert.equal(rec.runsCount, 2, "两次尝试都要计入");
  assert.equal(rec.run.attempt, 2, "run 必须是最近一次（attempt 最大），不是第一条");
  assert.equal(rec.run.outcome, "success");
  assert.equal(rec.run.summary, "第二次成功");
  assert.ok(rec.run.startedAt && rec.run.endedAt && rec.run.durationMs != null, "起止与耗时必须回传（首屏要能显示）");
  assert.equal(rec.evidence.verdict, FULL.verdict);
  assert.equal(rec.evidence.deviation, FULL.deviation);
  assert.equal(rec.evidence.boundary, FULL.boundary);
  assert.deepEqual(rec.evidence.artifacts, FULL.artifacts);
  assert.equal(rec.evidence.actor, "codex");
});

test("C 只读：GET 详情前后 version / 事件数 / 证据数 / 尝试数一律不变", async () => {
  const { store, route, t } = setup();
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  store.claimTask(t.identifier, { sessionId: "s1", sourceStatus: "todo" });

  const before = {
    version: store.getTaskRef(t.identifier).version,
    events: store.listTaskEvents(t.identifier).length,
    evidence: store.listTaskEvidence(t.identifier).length,
    runs: store.listTaskRuns(t.identifier).length,
  };
  await route("GET", `/api/tasks/${t.identifier}`);
  await route("GET", `/api/tasks/${t.identifier}`);
  const after = {
    version: store.getTaskRef(t.identifier).version,
    events: store.listTaskEvents(t.identifier).length,
    evidence: store.listTaskEvidence(t.identifier).length,
    runs: store.listTaskRuns(t.identifier).length,
  };
  assert.deepEqual(after, before, "详情 GET 不得有写副作用");
});

test("D 前端真消费（源码守卫）：执行记录段存在，且排在「概览」之后", () => {
  const web = fs.readFileSync(path.resolve("web", "app.js"), "utf8");
  const iOverview = web.indexOf("drawerBody.appendChild(overview);");
  // 卡 `-268` 修订：原先取 `indexOf("executionRecord")` —— 那是「**第一次提到**这个字段」的位置，
  // 不等于「**那一段挂载**的位置」。`-268` 在概览**之前**用同一份 `executionRecord` 画标题栏徽标
  // （首屏锚点），第一处命中随之前移 ⇒ 这条守卫当场假红。判据要盯**挂载点**：
  const iSection = web.indexOf('"drawer-section exec-record"');
  const iRecord = web.indexOf("drawerBody.appendChild(rsec);", iSection);
  assert.ok(iOverview > 0, "找不到概览挂载点（源码结构变了，守卫需要同步）");
  assert.ok(iSection > 0, "找不到执行记录段（源码结构变了，守卫需要同步）");
  assert.ok(iRecord > 0, "web/app.js 必须消费 executionRecord —— 否则后端回传了也没人看");
  assert.ok(iRecord > iOverview, "执行记录段必须排在概览之后（否则又回到首屏看不到）");
  assert.ok(web.includes("本卡尚无执行记录"), "无记录时必须给显式空态，不能什么都不渲染");
  assert.ok(web.includes("本卡尚无结构化交付证据"), "有尝试但无证据时必须分开说清，不能用评论冒充结构化证据");
});
