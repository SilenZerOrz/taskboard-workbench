/**
 * 0-A2（卡 `-198` · FR-108）API 接线：`GET /api/tasks/:ref` 回包带 `ticketStage`。
 *
 * 钉四件事：
 *   1. **只读附加字段** —— 字段有、形状对，且 GET 一个字节都不写（version / 证据条数 / 事件数不变）
 *   2. **交付物漏斗真的接上了库** —— 无证据 ⇒ 流程态；证据四字段齐 ⇒ `format_ok`；refs 解不开 ⇒ `refs_unresolved`
 *   3. **`stale` 在 0-C 建表前不可能被伪造** —— `decision` 显式为 null，不会凭空给出 `ready`
 *   4. **前端确实消费了这个字段**（源码守卫）—— 且 `stale` 有独立警示样式，不是"看起来可以确认"
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openStore, SCHEMA_VERSION } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}
const FULL = { verdict: "判定", deviation: "无", boundary: "未碰 :3080", artifacts: ["docs/a.md"] };

test("A 字段存在且形状正确：无证据的进行中卡 ⇒ in_progress / delivery=none", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  const r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.equal(r.status, 200);
  const stage = r.payload.ticketStage;
  assert.ok(stage, "回包必须带 ticketStage");
  assert.equal(stage.stage, "in_progress");
  assert.equal(stage.delivery.state, "none");
  assert.equal(stage.next.code, "in-progress", "next 仍由 next-step 给，语义未变");
  assert.equal(typeof stage.reason, "string");
  // 既有字段一个不少（附加字段不得替换既有语义）
  assert.ok(r.payload.task && Array.isArray(r.payload.comments) && r.payload.reviewEvidence);
});

test("B 接上库：证据四字段齐 ⇒ format_ok；refs 解不开 ⇒ refs_unresolved", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });

  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  let r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.equal(r.payload.ticketStage.stage, "format_ok");
  assert.equal(r.payload.ticketStage.delivery.state, "format_ok");

  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex", artifactRefs: [{ kind: "commit", ref: "deadbeef" }], resolve: () => false });
  r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.equal(r.payload.ticketStage.stage, "refs_unresolved", "最新一条是解不开的 refs ⇒ 不能是 format_ok");
});

test("C 不会凭空 ready：`decision` 未接线（0-C 建表前）⇒ stage 永远到不了 ready/stale", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  const r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.notEqual(r.payload.ticketStage.stage, "ready");
  assert.notEqual(r.payload.ticketStage.stage, "stale");
});

test("D 待验收未发起评审 ⇒ awaiting_review_request（先于交付物态）", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_review" });
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  const r = await route("GET", `/api/tasks/${t.identifier}`);
  assert.equal(r.payload.ticketStage.stage, "awaiting_review_request");
});

test("E 只读：GET 详情不写库（version / 证据条数 / 事件数 / schema 全不变）", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  const before = {
    version: store.getTaskRef(t.identifier).version,
    evidence: store.listTaskEvidence(t.identifier).length,
    events: store.listTaskEvents(t.identifier, { limit: 500 }).length,
    schema: SCHEMA_VERSION,
  };
  await route("GET", `/api/tasks/${t.identifier}`);
  await route("GET", `/api/tasks/${t.identifier}`);
  const after = {
    version: store.getTaskRef(t.identifier).version,
    evidence: store.listTaskEvidence(t.identifier).length,
    events: store.listTaskEvents(t.identifier, { limit: 500 }).length,
    schema: SCHEMA_VERSION,
  };
  assert.deepEqual(after, before, "详情 GET 不得产生任何写副作用");
});

test("F 源码守卫：前端消费 ticketStage，且 stale 有独立警示样式", () => {
  const root = process.cwd();
  const app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
  const css = fs.readFileSync(path.join(root, "web/tokens.css"), "utf8");

  assert.match(app, /detail\.ticketStage/, "抽屉必须读取服务端的 ticketStage");
  assert.match(app, /renderStageBadge/, "必须有唯一渲染点");
  // stale 必须显式告警（不是和 ready 共用一套样式/文案）
  assert.match(app, /stale:\s*"[^"]*(作废|已变)/, "stale 必须有独立文案");
  assert.match(css, /\.tb-stage-badge\[data-stage="stale"\][^{]*\{[^}]*var\(--danger\)/, "stale 必须用警示色");
  // 反向对照：徽标文案不许出现"可以确认/完成"这类**邀请确认**的措辞
  assert.doesNotMatch(app, /交付物已判可收"[^}]*可以确认/, "徽标不得替人做确认决定");
});
