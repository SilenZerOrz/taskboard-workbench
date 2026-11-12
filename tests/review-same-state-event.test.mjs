/**
 * 卡 `-245` / 需求 `R178`：已处于「待验收」的卡再次请求评审，不写 `in_review→in_review` 空转事件。
 *
 * 真机读数：8 张卡共 16 条同态 `status_changed`（纯日志噪音，读事件流的人会被误导成
 * 「状态来回跳了 16 次」）。要守的边界是：**只吞同态迁移，不吞动作本身** ——
 * `review_requested` 必须照写两条，否则等于把「又点了一次评审」这件事藏起来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const t = store.createTask({ projectId: "p1", title: "实现", status: "in_progress" });
  return { store, t };
}

test("连点两次请求评审：无同态 status_changed，review_requested 仍写两条", () => {
  const { store, t } = setup();
  store.requestReview(t.identifier);
  store.requestReview(t.identifier);
  const ev = store.listTaskEvents(t.identifier, { order: "asc" });
  const same = ev.filter((e) => e.type === "status_changed" && e.from === "in_review" && e.to === "in_review");
  assert.equal(same.length, 0, "同态迁移不许落事件");
  assert.equal(ev.filter((e) => e.type === "review_requested").length, 2, "动作本身必须留痕两次");
  // 正向对照：第一次是真迁移，必须留下 1 条 in_progress→in_review
  const real = ev.filter((e) => e.type === "status_changed" && e.from === "in_progress" && e.to === "in_review");
  assert.equal(real.length, 1, "真迁移不能被一起吞掉");
  store.close();
});

test("返工后再提交：每次真迁移都留痕（不能把正常流程也一并吞掉）", () => {
  const { store, t } = setup();
  store.requestReview(t.identifier);
  store.requestChanges(t.identifier, { comment: "改了再来" });
  store.requestReview(t.identifier);
  const ev = store.listTaskEvents(t.identifier, { order: "asc" });
  const real = ev.filter((e) => e.type === "status_changed" && e.to === "in_review" && e.from !== "in_review");
  assert.equal(real.length, 2, "两轮真提交 = 两条迁移事件");
  assert.equal(ev.filter((e) => e.type === "status_changed" && e.from === "in_review" && e.to === "in_review").length, 0);
  store.close();
});
