/**
 * FR-91「需求文档关联补齐 + 需求条目完成态 + 关联任务完成度评审」回归。
 *
 * 真机反馈（2026-10-22，需求页）：
 * 1)「agent team 任务工作台需求文档未关联，请帮我补齐」——本项目需求文档正文被旧版「新建文档」
 *    （带 `body:""` 走 update）清成 0 字节、版本却涨到 v7；
 * 2)「需求条目列表还是太宽了，优化样式，并新增需求是否完成&关闭等状态更新」；
 * 3)「点击需求条目打开需求详情，展示需求内容情况同时，展示关联需求的任务完成列表情况，
 *    以供自动/人工评审需求是否完成」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { REQUIREMENT_STATUSES, REQUIREMENT_DONE_STATUSES, assertRequirementStatus, summarizeRequirementCompletion } from "../src/core/requirements.mjs";

const routeOf = (router) => (method, pathname, body, params = {}) => router.route({ method, pathname, searchParams: new URLSearchParams(params), body });
const root = path.resolve(import.meta.dirname, "..");

test("需求状态机：新增 done 终态，未知状态仍被拒", () => {
  assert.ok(REQUIREMENT_STATUSES.includes("done"), "done 必须在白名单里");
  assert.deepEqual(REQUIREMENT_DONE_STATUSES.slice().sort(), ["closed", "done"]);
  assert.equal(assertRequirementStatus("done"), "done");
  assert.throws(() => assertRequirementStatus("finished"), /draft \/ open \/ done \/ closed/);
});

test("完成度口径（纯函数）：无任务 / 全收口 / 受阻 / 待验收 / 进行中", () => {
  const none = summarizeRequirementCompletion([]);
  assert.equal(none.verdict, "no-tasks");
  assert.equal(none.ready, false);

  const allClosed = summarizeRequirementCompletion([{ status: "done" }, { status: "done" }, { status: "canceled" }]);
  assert.equal(allClosed.verdict, "all-closed");
  assert.equal(allClosed.ready, true, "全部 done/canceled ⇒ 自动判定可完成");
  assert.equal(allClosed.closed, 3);
  assert.equal(allClosed.active, 0);

  const blocked = summarizeRequirementCompletion([{ status: "done" }, { status: "blocked" }]);
  assert.equal(blocked.verdict, "blocked");
  assert.equal(blocked.ready, false);
  assert.equal(blocked.active, 1);

  const inReview = summarizeRequirementCompletion([{ status: "in_review" }]);
  assert.equal(inReview.verdict, "in-review");

  const wip = summarizeRequirementCompletion([{ status: "backlog" }, { status: "in_progress" }]);
  assert.equal(wip.verdict, "in-progress");
  assert.equal(wip.counts.in_progress, 1);
});

test("store：条目可挂回需求文档（docId 可改），并可置 done；完成度带关联任务清单", () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# 需求" });
  const item = store.createRequirementItem({ projectId: "p1", title: "孤立条目" });
  assert.equal(item.docId, null, "建条目不传 docId 就是未关联");

  const linked = store.updateRequirementItem(item.identifier, { docId: doc.id });
  assert.equal(linked.docId, doc.id, "FR-91：关联可以补齐");
  assert.throws(() => store.updateRequirementItem(item.identifier, { docId: "no-such-doc" }), /需求文档不存在/);
  assert.equal(store.updateRequirementItem(item.identifier, { docId: null }).docId, null, "置 null 即解除关联");

  const done = store.updateRequirementItem(item.identifier, { status: "done" });
  assert.equal(done.status, "done");

  const t1 = store.createTask({ projectId: "p1", title: "T1" });
  const t2 = store.createTask({ projectId: "p1", title: "T2" });
  store.associateRequirementTask(item.identifier, t1.identifier);
  store.associateRequirementTask(item.identifier, t2.identifier);
  store.updateTask(t1.identifier, { expectedVersion: store.getTaskRef(t1.identifier).version, status: "done" });
  const comp = store.requirementCompletion(item.identifier);
  assert.equal(comp.total, 2);
  assert.equal(comp.counts.done, 1);
  assert.equal(comp.ready, false, "还有一个没做完 ⇒ 不该自动判定完成");
  assert.deepEqual(comp.tasks.map((t) => t.identifier).sort(), [t1.identifier, t2.identifier].sort());
  store.close();
});

test("API 回归：POST /requirements/docs 不再清空已有正文（原「新建文档」清库 bug）", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# 真实需求\n\nFR-01 ..." });
  const router = createApiRouter({ store });
  const route = routeOf(router);

  // 旧 UI 就是这样调的：带空 body「新建文档」
  const r = await route("POST", "/api/requirements/docs", { projectId: "p1", body: "" });
  assert.equal(r.payload.existed, true);
  assert.equal(r.payload.wrote, false);
  assert.equal(r.payload.doc.body, "# 真实需求\n\nFR-01 ...", "已有正文必须原样保留");
  assert.equal(r.payload.doc.version, doc.version, "没写就不该涨版本");

  const r2 = await route("POST", "/api/requirements/docs", { projectId: "p1", body: "# 改写后的需求" });
  assert.equal(r2.payload.wrote, true);
  assert.equal(r2.payload.doc.body, "# 改写后的需求");
  assert.equal(r2.payload.doc.version, doc.version + 1);

  const r3 = await route("POST", "/api/requirements/docs", { projectId: "p1" });
  assert.equal(r3.payload.wrote, false, "不传 body 同样不动正文");
  store.close();
});

test("API：详情带完成度、completion 端点只读、置终态落审计、可补关联", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const doc = store.ensureRequirementDoc("p1", { body: "# R" });
  const router = createApiRouter({ store });
  const route = routeOf(router);
  const item = store.createRequirementItem({ projectId: "p1", title: "无任务的需求" });

  const detail = await route("GET", `/api/requirements/items/${item.identifier}`);
  assert.equal(detail.payload.item.identifier, item.identifier);
  assert.equal(detail.payload.completion.verdict, "no-tasks", "FR-91 ③：详情必须带关联任务完成情况");

  const comp = await route("GET", `/api/requirements/items/${item.identifier}/completion`);
  assert.equal(comp.status, 200);
  assert.equal(comp.payload.total, 0);

  const linked = await route("PATCH", `/api/requirements/items/${item.identifier}`, { docId: doc.id });
  assert.equal(linked.payload.item.docId, doc.id, "补齐关联：条目 → 需求文档");

  const closed = await route("PATCH", `/api/requirements/items/${item.identifier}`, { status: "closed", actor: "human", reason: "no-tasks" });
  assert.equal(closed.payload.item.status, "closed");
  const audits = store.listGovernanceAudit({ action: "requirement-status" });
  assert.ok(audits.some((a) => a.target === item.identifier && a.reason === "closed"), "终态要有审计留痕");

  await assert.rejects(() => route("PATCH", `/api/requirements/items/${item.identifier}`, { status: "nope" }), /draft \/ open \/ done \/ closed/);
  store.close();
});

test("前端接线：条目列表按状态分层（含已完成/已关闭）且详情渲染完成度区块", () => {
  const src = readFileSync(path.join(root, "web/app.js"), "utf8");
  for (const t of ['["done", "已完成"]', '["closed", "已关闭"]', '["open", "在办"]']) assert.ok(src.includes(t), `筛选缺失：${t}`);
  assert.ok(src.includes("function reqStatusLabel("), "状态中文口径要收敛到一个函数");
  assert.ok(src.includes("req-completion-verdict"), "详情要渲染自动结论");
  assert.ok(src.includes("人工确认：标记需求完成"), "终态必须由人点");
  assert.ok(src.includes("req-warn"), "空正文要有告警");
  const css = readFileSync(path.join(root, "web/tokens.css"), "utf8");
  // 2026-10-27 真机批注：条目方块（多列网格）改为**单列列表**，点击用右侧抽屉看详情
  assert.ok(/\.req-stack \.req-list\s*\{[^}]*flex-direction: column/.test(css), "条目要改成单列列表");
  assert.ok(!/\.req-stack \.req-list\s*\{[^}]*grid-template-columns/.test(css), "不应再是多列网格方块");
  assert.ok(/\.req-stack \.req-item\s*\{[^}]*flex-direction: row/.test(css), "列表行要横向排布");
  assert.ok(src.includes("tb-req-drawer"), "条目详情要放进抽屉");
  assert.ok(!src.includes('detailPanel = mk("section", "panel")'), "详情不能再是列表下方常驻面板");
});
