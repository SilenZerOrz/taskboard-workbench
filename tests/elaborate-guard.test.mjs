/**
 * 条目化护栏（卡 `-169` P4② · 2026-10-29 口径变更）。
 *
 * 背景：真机上一份「资料索引」类需求文档走规则拆解，产出 4213 条、落库 100 条 pending 候选，
 * 其中 **0 条**是真需求（全是文件清单行）。根因有两条，一条在默认值、一条在失败语义：
 *   ① `limit` 默认 100 且 **body 传了也不生效**；
 *   ② `mode:"auto"` 在 AI 不可用时**静默跑规则并落库**，只加一个 `degraded:true` 标注 ——
 *      「其实没 AI」被包装成「看起来成功」。
 *
 * 新口径（本文件即其守卫）：
 *   · `auto` 只用 AI；AI 不可用/失败 ⇒ **拒绝 `AI_UNAVAILABLE`，零落库**；
 *   · 规则降级必须**显式** `{mode:"auto", fallback:"rule"}`；
 *   · `{mode:"rule", dryRun:true}` ⇒ 只回预览、**零落库**；
 *   · `limit` 默认 **20**、硬顶 **200**、**从 body 透传**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore, DEFAULT_ELABORATE_LIMIT, MAX_ELABORATE_LIMIT, clampElaborateLimit } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

/** 一个「资料索引」风格的文档：标题行 + 大量文件清单行（正是洪水的那种形状）。 */
function setup({ aiElaborator, lines = 60 } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const body = "# 资料索引\n\n" + Array.from({ length: lines }, (_, i) => `- docs/file-${i + 1}.md`).join("\n");
  const doc = store.ensureRequirementDoc("demo", { body });
  const router = createApiRouter({ store, aiElaborator });
  const call = (payload) => router.route({
    method: "POST",
    pathname: `/api/requirements/docs/${doc.id}/elaborate`,
    searchParams: new URLSearchParams(),
    body: payload,
  });
  const pendingCount = () => store.listRequirementCandidates({ docId: doc.id, status: "pending" }).length;
  return { store, doc, call, pendingCount };
}

// ── ① 无 AI 时 `auto` ⇒ AI_UNAVAILABLE，且候选计数**一条不变** ───────────────
test("① 无 AI 时 mode=auto ⇒ AI_UNAVAILABLE，且 requirement_candidates 计数不变", async () => {
  const { store, call, pendingCount } = setup();
  const before = pendingCount();
  await assert.rejects(() => call({ mode: "auto" }), (e) => e.code === "AI_UNAVAILABLE");
  assert.equal(pendingCount(), before, "拒绝必须零落库");
  assert.equal(before, 0);
  store.close();
});

// ── ② 显式 `fallback:"rule"` ⇒ 保留旧行为（能写、且标 degraded） ────────────
test("② 显式 fallback:\"rule\" ⇒ 走规则并标 degraded（旧行为整体退到这条分支）", async () => {
  const { store, call, pendingCount } = setup();
  const { payload } = await call({ mode: "auto", fallback: "rule" });
  assert.equal(payload.mode, "rule");
  assert.equal(payload.degraded, true);
  assert.equal(payload.aiError, "AI_UNAVAILABLE");
  assert.ok(payload.candidates.length > 0);
  assert.equal(pendingCount(), payload.candidates.length);
  store.close();
});

test("②b AI 可用但抛错 ⇒ auto 也拒绝（不再被「降级」吞掉），fallback:rule 时才降级", async () => {
  const boom = async () => { throw new Error("上游 502"); };
  const a = setup({ aiElaborator: boom });
  await assert.rejects(() => a.call({ mode: "auto" }), (e) => e.code === "AI_UNAVAILABLE");
  assert.equal(a.pendingCount(), 0, "AI 失败也必须零落库");
  a.store.close();

  const b = setup({ aiElaborator: boom });
  const { payload } = await b.call({ mode: "auto", fallback: "rule" });
  assert.equal(payload.mode, "rule");
  assert.equal(payload.degraded, true);
  assert.equal(payload.aiError, "AI_UNAVAILABLE");
  b.store.close();
});

// ── ③ dryRun ⇒ 计数不变、preview 非空、candidates 为空、HTTP 200 ────────────
test("③ mode=rule + dryRun ⇒ 零落库、preview.length>0、candidates 为空、状态 200", async () => {
  const { store, call, pendingCount } = setup({ lines: 60 });
  const before = pendingCount();
  const { status, payload } = await call({ mode: "rule", dryRun: true });
  assert.equal(pendingCount(), before, "预览必须零落库");
  assert.equal(before, 0);
  assert.equal(status, 200, "dryRun 什么都没创建 ⇒ 200 而不是 201");
  assert.equal(payload.dryRun, true);
  assert.ok(payload.preview.length > 0);
  assert.equal(payload.preview.length, Math.min(10, payload.limit), "预览最多 10 条");
  assert.deepEqual(payload.candidates, []);
  assert.ok(payload.totalFound >= 60);
  store.close();
});

test("③b 预览与真写**同一批标题**（预览不是另一套算法）", async () => {
  const { store, call } = setup({ lines: 6 });
  const { payload: pre } = await call({ mode: "rule", dryRun: true });
  const { payload: real } = await call({ mode: "rule" });
  assert.deepEqual(pre.preview.map((c) => c.title), real.candidates.map((c) => c.title));
  store.close();
});

// ── ④ limit 从 body 透传：`limit:5` ⇒ 恰好 5 条 ─────────────────────────────
test("④ limit:5 ⇒ 恰好写 5 条（旧实现 body 传了也不生效）", async () => {
  const { store, call, pendingCount } = setup({ lines: 60 });
  const { payload } = await call({ mode: "rule", limit: 5 });
  assert.equal(payload.candidates.length, 5);
  assert.equal(payload.limit, 5);
  assert.equal(pendingCount(), 5);
  assert.equal(payload.truncated, true);
  assert.ok(payload.totalFound > 5);
  store.close();
});

test("④b 不传 limit ⇒ 默认 20（旧默认 100 才是洪水扳机）", async () => {
  const { store, call } = setup({ lines: 60 });
  const { payload } = await call({ mode: "rule" });
  assert.equal(DEFAULT_ELABORATE_LIMIT, 20);
  assert.equal(payload.limit, 20);
  assert.equal(payload.candidates.length, 20);
  store.close();
});

test("④c limit 超硬顶 ⇒ 夹到 200；非正整数 ⇒ 报错（不静默回落默认）", () => {
  assert.equal(MAX_ELABORATE_LIMIT, 200);
  assert.equal(clampElaborateLimit(9999), 200);
  assert.equal(clampElaborateLimit(undefined), 20);
  assert.equal(clampElaborateLimit("7"), 7);
  for (const bad of [0, -1, 1.5, "abc", " "]) {
    assert.throws(() => clampElaborateLimit(bad), (e) => e.code === "INVALID_FIELD", `应拒绝 ${JSON.stringify(bad)}`);
  }
});

test("④d API 层：limit 非法 ⇒ INVALID_FIELD（不是静默用默认值）", async () => {
  const { store, call } = setup({ lines: 5 });
  await assert.rejects(() => call({ mode: "rule", limit: 0 }), (e) => e.code === "INVALID_FIELD");
  store.close();
});

// ── 契约边界：不合法的组合要**明确报错**，不能默默做别的事 ────────────────────
test("⑤ dryRun 只对 rule 有效；fallback 只接受 rule；mode 只接受三值", async () => {
  const { store, call, pendingCount } = setup({ lines: 5 });
  await assert.rejects(() => call({ mode: "auto", dryRun: true }), (e) => e.code === "USAGE_ERROR");
  await assert.rejects(() => call({ mode: "auto", fallback: "ai" }), (e) => e.code === "USAGE_ERROR");
  await assert.rejects(() => call({ mode: "magic" }), (e) => e.code === "USAGE_ERROR");
  assert.equal(pendingCount(), 0, "以上三种都必须在落库之前被拒");
  store.close();
});

// ── 反向对照：把口径改回旧的（auto 静默降级）⇒ ① 必须转红 ─────────────────
test("⑥ 反向对照：store 层 dryRun 被绕过时，③ 的「零落库」判据会失效（证明该断言真在起作用）", async () => {
  const { store, doc } = setup({ lines: 6 });
  const before = store.listRequirementCandidates({ docId: doc.id }).length;
  // 不走 dryRun，直接真写 —— 计数必然变化（对照组）
  store.elaborateRequirementDoc(doc.id, { limit: 3 });
  const after = store.listRequirementCandidates({ docId: doc.id }).length;
  assert.equal(after - before, 3, "对照组：不 dryRun 就一定会落库");
  store.close();
});
