/**
 * 卡 `-259`（需求 `R184`）：尝试记录的摘要承载**执行方结论**，不再是记账文案。
 *
 * 真机 `-248`：一条 22 分 51 秒的成功尝试，`run.summary` 只有「按成功完成记账（失败计数清零）」——
 * 人打开卡片看到的就是这句，等于没有执行记录。钉四件事：
 *   1. 显式给摘要 ⇒ 原样落库（压成单行、500 字符封顶）
 *   2. 没给摘要 ⇒ 如实写「执行方未回写摘要」，**绝不回落到记账文案**
 *   3. `requestReview` 的推导链：显式 > 评论首行 > 最近证据 verdict
 *   4. 记账语义没丢：成功仍清零 `consecutive_failures`
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { openStore, RUN_SUMMARY_FALLBACK, normalizeRunSummary } from "../src/core/store.mjs";

const LEGACY = "按成功完成记账（失败计数清零）";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R" });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.associateRequirementTask(item.id, t.id);
  return { store, t };
}

function lastRun(store, t) {
  const runs = store.listTaskRuns(t.identifier);
  return runs[runs.length - 1];
}

test("A normalizeRunSummary：压单行 / 空值回落 / 500 封顶", () => {
  assert.equal(normalizeRunSummary("  a\n\nb  "), "a b");
  assert.equal(normalizeRunSummary(""), RUN_SUMMARY_FALLBACK);
  assert.equal(normalizeRunSummary(null), RUN_SUMMARY_FALLBACK);
  assert.equal(normalizeRunSummary(undefined), RUN_SUMMARY_FALLBACK);
  assert.equal(normalizeRunSummary("x".repeat(900)).length, 500);
});

test("B 显式摘要原样落库；不传摘要时绝不再写记账文案", () => {
  const { store, t } = setup();
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
  store.markTaskSucceeded(t.identifier, { summary: "改了 diagnostics.mjs + api.mjs，npm test 1268/1268/0" });
  assert.equal(lastRun(store, t).summary, "改了 diagnostics.mjs + api.mjs，npm test 1268/1268/0");
  assert.notEqual(lastRun(store, t).summary, LEGACY);

  const { store: s2, t: t2 } = setup();
  s2.startTaskRun(t2.identifier, { sessionId: "s1", actor: "cli-executor" });
  s2.markTaskSucceeded(t2.identifier);
  assert.equal(lastRun(s2, t2).summary, RUN_SUMMARY_FALLBACK);
  assert.notEqual(lastRun(s2, t2).summary, LEGACY, "缺省必须如实标「未回写」，不能拿记账文案顶替");
});

test("C requestReview 推导链：显式 > 评论首行 > 最近证据 verdict", () => {
  // C1 显式优先
  {
    const { store, t } = setup();
    store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
    store.requestReview(t.identifier, { summary: "显式摘要", comment: "评论首行\n第二行" });
    assert.equal(lastRun(store, t).summary, "显式摘要");
  }
  // C2 无显式 ⇒ 评论首行
  {
    const { store, t } = setup();
    store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
    store.requestReview(t.identifier, { comment: "\n\n## 证据（四节）\n判定：完成" });
    assert.equal(lastRun(store, t).summary, "## 证据（四节）");
  }
  // C3 无显式、无评论 ⇒ 最近一条结构化证据的 verdict
  {
    const { store, t } = setup();
    store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
    store.addTaskEvidence(t.identifier, { verdict: "判定：完成，已提交待验收", deviation: "无", boundary: "未碰 :3080", artifacts: ["a.mjs"], actor: "codex" });
    store.requestReview(t.identifier, {});
    assert.equal(lastRun(store, t).summary, "判定：完成，已提交待验收");
  }
});

test("D 记账语义未丢：成功仍清零 consecutive_failures 与 last_failure_error", () => {
  const { store, t } = setup();
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
  store.recordTaskExecutionFailure(t.identifier, { evidence: "第一次失败" });
  assert.ok(store.getTaskRef(t.identifier).consecutiveFailures > 0, "前置：失败计数应 > 0");
  store.startTaskRun(t.identifier, { sessionId: "s1", actor: "cli-executor" });
  store.markTaskSucceeded(t.identifier, { summary: "第二次成了" });
  const after = store.getTaskRef(t.identifier);
  assert.equal(after.consecutiveFailures, 0);
  assert.equal(after.lastFailureError, null);
});

test("E 源码守卫：记账文案不再出现在 endTaskRun 的 summary 实参里", () => {
  const src = fs.readFileSync(path.resolve("src", "core", "store.mjs"), "utf8");
  const calls = src.split("\n").filter((line) => line.includes("endTaskRun(") && line.includes("summary:"));
  assert.ok(calls.length > 0, "找不到 endTaskRun 调用点（结构变了，守卫需同步）");
  for (const line of calls) assert.ok(!line.includes(LEGACY), `仍有调用点写死记账文案：${line.trim()}`);
});
