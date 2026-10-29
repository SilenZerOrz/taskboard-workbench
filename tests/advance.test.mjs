/**
 * 项目推进清单 + 决定回写（2026-10-28 拍板 E1–E3）
 *
 * 背景：工作台已有三份**按状态切片**的只读视图（`/watchdog` 只扫 `in_progress`、`/diagnostics`、
 * `/reviews`），但**`todo`（可派发）卡不进任何一张**，且都不产出 `action` / `decision_id`
 * ⇒ 人只能逐卡点开才知道"现在该干什么"（用户真机批注原话）。
 *
 * 本测试钉住五条判据：
 *   A 五类合一 + 排序 `decide > blocked > review > accept > dispatch` + 计数
 *   B **纯投影**：同状态两次调用字节级一致（不含 now/minutes）
 *   C `done` / `canceled` 一律不出现；**未归因的 todo 进 blocked**（不给可派发的假信号）
 *   D `decide` **幂等**：同 decisionId 提交两次只产生一个副作用，第二次 `replay:true`
 *   E `accept/complete` **必须 actor=human**（E3 红线：执行侧与评审都不代点「完成」）
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { buildAdvance, renderAdvanceBlock, applyDecision } from "../src/core/advance.mjs";

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `adv-${label}-`));

function seed(store) {
  store.createProject({ id: "p1", name: "推进清单项目" });
  const doc = store.ensureRequirementDoc("p1", { body: "# 需求\n" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目 A", docId: doc.id, status: "open" });
  const req = { requirementId: item.id };
  const mk = (title, status, extra = {}) => store.createTask({ projectId: "p1", title, status, ...extra });
  const todoAttr = mk("可开工的卡", "todo", req);
  const todoUnattr = mk("未归因的卡", "todo");
  // 直接以 blocked 建卡：`blockTask` 走 routeBlock 时 kind=dependency 可能落 `wait`（保持原状态），
  // 本用例要的是**已受阻**的卡，不掺入路由语义。
  const blocked = mk("受阻的卡", "blocked", req);
  const reviewPending = mk("等评审的卡", "in_progress", req);
  store.requestReview(reviewPending.identifier, { reviewer: "codex", comment: "请评审" });
  const reviewApproved = mk("评审已过的卡", "in_progress", req);
  store.requestReview(reviewApproved.identifier, { reviewer: "codex", comment: "请评审" });
  store.approveReview(reviewApproved.identifier, { actor: "codex", comment: "过了" });
  const inProgress = mk("正常在跑的卡", "in_progress", req);
  const done = mk("已完成的卡", "in_progress", req);
  store.requestReview(done.identifier, { reviewer: "codex" });
  store.approveReview(done.identifier, { actor: "codex" });
  store.updateTask(done.identifier, { status: "done", expectedVersion: store.getTaskByIdentifier(done.identifier).version, actor: "human" });
  const canceled = mk("取消的卡", "in_progress", req);
  store.updateTask(canceled.identifier, { status: "canceled", expectedVersion: store.getTaskByIdentifier(canceled.identifier).version, actor: "human" });
  return { item, todoAttr, todoUnattr, blocked, reviewPending, reviewApproved, inProgress, done, canceled };
}

test("advance/A 五类合一：排序 decide>blocked>review>accept>dispatch，且计数正确", () => {
  const dir = freshDir("a");
  const store = openStore({ dataDir: dir });
  try {
    const s = seed(store);
    const list = buildAdvance(store, "p1");
    assert.equal(list.project, "p1");
    assert.deepEqual(list.counts, { decide: 0, blocked: 2, review: 1, accept: 1, dispatch: 1 });
    assert.equal(list.count, 5);
    const rank = { decide: 0, blocked: 1, review: 2, accept: 3, dispatch: 4 };
    const ranks = list.items.map((i) => rank[i.kind]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `排序应单调不减，实得 ${JSON.stringify(list.items.map((i) => [i.kind, i.taskRef]))}`);
    // 未归因的 todo 归 blocked（不是 dispatch）
    const unattrItem = list.items.find((i) => i.taskRef === s.todoUnattr.identifier);
    assert.equal(unattrItem.kind, "blocked");
    assert.match(unattrItem.why, /未归因/);
    // 已完工 / 取消的卡一律不出现
    assert.equal(list.items.some((i) => i.taskRef === s.done.identifier), false);
    assert.equal(list.items.some((i) => i.taskRef === s.canceled.identifier), false);
    // 正常在跑的 in_progress 不应占名录
    assert.equal(list.items.some((i) => i.taskRef === s.inProgress.identifier), false);
    // decide_id 稳定：不含时间戳
    for (const i of list.items) assert.match(i.id, /^adv-[0-9a-f]{12}$/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("advance/B 纯投影：同状态两次调用字节级一致", () => {
  const dir = freshDir("b");
  const store = openStore({ dataDir: dir });
  try {
    seed(store);
    const a = JSON.stringify(buildAdvance(store, "p1"));
    const b = JSON.stringify(buildAdvance(store, "p1"));
    assert.equal(a, b, "清单必须可复算：同状态两次请求字节级一致");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("advance/C 装载块可读：空清单说「无待办」，非空逐项带 decision_id 与规则", () => {
  const dir = freshDir("c");
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "p9", name: "空项目" });
    const empty = buildAdvance(store, "p9");
    assert.equal(empty.count, 0);
    assert.match(renderAdvanceBlock(empty), /当前无待办/);
    seed(store);
    const block = renderAdvanceBlock(buildAdvance(store, "p1"));
    assert.match(block, /todo_write/);
    assert.match(block, /decision_id=adv-/);
    assert.match(block, /「完成」\*\*不是你勾 todo\*\*/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("advance/D decide 幂等：同 decisionId 两次只产生一个副作用，第二次 replay=true", () => {
  const dir = freshDir("d");
  const store = openStore({ dataDir: dir });
  try {
    const s = seed(store);
    const list = buildAdvance(store, "p1");
    const reviewItem = list.items.find((i) => i.kind === "review");
    assert.ok(reviewItem, "应有一条待评审项");

    const first = applyDecision(store, "p1", reviewItem.id, { choice: "approve", note: "代码已复核", actor: "codex" });
    assert.equal(first.replay, false);
    const approved = store.getTaskByIdentifier(s.reviewPending.identifier);
    assert.equal(approved.reviewState, "approved");

    const second = applyDecision(store, "p1", reviewItem.id, { choice: "approve", note: "重复提交", actor: "codex" });
    assert.equal(second.replay, true, "第二次必须走重放，不得再产生副作用");

    const decisionEvents = store.listTaskEvents(approved.id).filter((e) => e.type === "decision");
    assert.equal(decisionEvents.length, 1, `decision 事件应只有 1 条，实得 ${decisionEvents.length}`);
    assert.equal(JSON.parse(decisionEvents[0].detail).decisionId, reviewItem.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("advance/E accept/complete 必须人确认：agent 提交被拒 HUMAN_CONFIRM_REQUIRED，人提交才落 done", () => {
  const dir = freshDir("e");
  const store = openStore({ dataDir: dir });
  try {
    const s = seed(store);
    const list = buildAdvance(store, "p1");
    const acceptItem = list.items.find((i) => i.kind === "accept");
    assert.ok(acceptItem, "应有一条「等人工点完成」项");

    assert.throws(
      () => applyDecision(store, "p1", acceptItem.id, { choice: "complete", actor: "agent:main" }),
      (e) => e.code === "HUMAN_CONFIRM_REQUIRED",
    );
    assert.equal(store.getTaskByIdentifier(s.reviewApproved.identifier).status, "in_review", "被拒时不得改状态");

    const ok = applyDecision(store, "p1", acceptItem.id, { choice: "complete", actor: "human" });
    assert.equal(ok.replay, false);
    assert.equal(store.getTaskByIdentifier(s.reviewApproved.identifier).status, "done");
    // 收口后清单里不再出现该卡
    assert.equal(buildAdvance(store, "p1").items.some((i) => i.id === acceptItem.id), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
