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

test("E 只读：GET 详情不写库（version / 证据条数 / 事件数 / **诊断行数** / schema 全不变）", async () => {
  const { store, route } = setup();
  // 这张卡会**命中诊断规则**（in_progress + 无认领锁 + 会话不在运行 ⇒ `unclaimed`）——
  // 卡 `-199` 起详情 GET 真的会把诊断算出来交给 `ticketStage`，所以这条快照才真正有分量：
  // 算出来可以，「顺手落库」不行（`persist:false`）。
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  store.addTaskEvidence(t.identifier, { ...FULL, actor: "codex" });
  const snapshot = () => ({
    version: store.getTaskRef(t.identifier).version,
    evidence: store.listTaskEvidence(t.identifier).length,
    events: store.listTaskEvents(t.identifier, { limit: 500 }).length,
    diagnostics: store.listTaskDiagnostics(t.identifier, { includeResolved: true }).length,
    schema: SCHEMA_VERSION,
  });
  const before = snapshot();
  await route("GET", `/api/tasks/${t.identifier}`);
  await route("GET", `/api/tasks/${t.identifier}`);
  const after = snapshot();
  assert.deepEqual(after, before, "详情 GET 不得产生任何写副作用（诊断不得 persist）");
});

test("G 载荷完整（卡 `-199`）：`next` 不只是 {code,title}、`watch` 带 followups/reason、`diagnostics` 真实求值", async () => {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "T", status: "in_progress" });
  const r = await route("GET", `/api/tasks/${t.identifier}`);
  const stage = r.payload.ticketStage;

  // ① next：抽屉的「下一步」区块靠这五项生成步骤/按钮/默认折叠/前置卡跳转 —— 少一项就是静默删功能
  for (const k of ["code", "title", "hint", "steps", "focus", "actions", "blocker"]) {
    assert.ok(k in stage.next, `next 必须带 ${k}（削成摘要会让「下一步」区块少一半能力）`);
  }
  assert.ok(Array.isArray(stage.next.steps) && Array.isArray(stage.next.actions), "steps / actions 必须是数组");
  assert.ok(stage.next.actions.length > 0, "进行中卡必须有可执行动作（不是只有一句标题）");

  // ② watch：`followups` 驱动「派生为子任务 / 忽略」，`reason` 驱动「执行会话未在线/空闲」文案
  for (const k of ["state", "minutes", "followups", "reason"]) {
    assert.ok(k in stage.watch, `watch 必须带 ${k}`);
  }
  assert.ok(Array.isArray(stage.watch.followups), "followups 必须是数组");

  // ③ diagnostics：真的算了（不是恒空数组）。这张卡 in_progress 无认领无会话 ⇒ unclaimed
  assert.ok(Array.isArray(stage.diagnostics) && stage.diagnostics.length > 0, "诊断必须真实求值，不能恒为空");
  assert.ok(stage.diagnostics.some((d) => d.kind === "unclaimed"), `期望命中 unclaimed，实得 ${stage.diagnostics.map((d) => d.kind)}`);
  const d0 = stage.diagnostics[0];
  assert.ok(d0.title && d0.detail && Array.isArray(d0.actions), "诊断项必须带给人看的标题/说明/恢复动作");
});

test("H 源码守卫（卡 `-199`）：三处判断收敛到 ticketStage，旧调用点必须为 0", () => {
  const root = process.cwd();
  const app = fs.readFileSync(path.join(root, "web/app.js"), "utf8");

  // ① 旧调用点一个都不能留 —— 留着就是"同一张卡同一屏两套判断"的复发口
  assert.doesNotMatch(app, /exec\?\.watchdog/, "看护读数不得再读 `exec.watchdog`（应读 ticketStage.watch）");
  assert.doesNotMatch(app, /exec\?\.diagnostics/, "诊断不得再读 `exec.diagnostics`（应读 ticketStage.diagnostics）");
  assert.doesNotMatch(app, /api\/tasks\/\$\{ref\}\/next-step/, "「下一步」不得再单独请求 /next-step（应读 ticketStage.next）");

  // ② 新读点必须在位，且都指向**同一份**回包
  assert.match(app, /detail\?\.ticketStage\?\.next/, "「下一步」必须读 detail.ticketStage.next");
  assert.match(app, /detail\?\.ticketStage\?\.watch/, "看护必须读 detail.ticketStage.watch");
  assert.match(app, /detail\?\.ticketStage\?\.diagnostics/, "诊断必须读 detail.ticketStage.diagnostics");
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
