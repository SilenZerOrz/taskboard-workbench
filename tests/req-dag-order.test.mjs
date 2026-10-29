/**
 * 守卫（FR-91 补口 · 2026-10-29 二轮）：需求条目「任务 DAG」的**可读性**三件事 ——
 * 前置在上（稳定拓扑序）、每个节点知道"被谁卡住"、每条边留得住"为什么卡"。
 *
 * 为什么需要：真机批注只看到「⛔ 受阻」四个字，得自己去别的页面找前置；而 `task_dependencies.reason`
 * （如「停写窗口未确认」）在库里躺了很久，**投影时被丢掉了**。这不是新功能，是把已有的信息还给人。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

import { openStore } from "../src/core/store.mjs";

function seed() {
  const dir = mkdtempSync(join(os.tmpdir(), "tb-dagorder-"));
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "生产切换" });
  // **故意反过来建**：先建"被卡"的卡、后建"卡人"的卡 —— 只按 created_at 排就会把前置排到后面。
  const blocked = store.createTask({ projectId: "p1", title: "C4 切流", status: "blocked", requirementId: item.identifier });
  const blocker = store.createTask({ projectId: "p1", title: "C0 停写窗口", status: "todo", requirementId: item.identifier });
  store.addTaskDependency({ blocker: blocker.identifier, blocked: blocked.identifier, reason: "停写窗口未确认" });
  return { dir, store, item, blocked, blocker };
}

test("前置在上：即使被卡卡先建，DAG 也按依赖排序（稳定拓扑序）", () => {
  const { dir, store, item, blocked, blocker } = seed();
  try {
    const graph = store.requirementTaskGraph(item.identifier);
    assert.deepEqual(graph.nodes.map((n) => n.identifier), [blocker.identifier, blocked.identifier],
      `前置必须排在前面（实际 ${graph.nodes.map((n) => n.identifier).join(" → ")}）`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("每个节点带 blockedBy（谁卡我），并保留边的 reason（为什么卡）", () => {
  const { dir, store, item, blocked, blocker } = seed();
  try {
    const graph = store.requirementTaskGraph(item.identifier);
    const head = graph.nodes.find((n) => n.identifier === blocker.identifier);
    const tail = graph.nodes.find((n) => n.identifier === blocked.identifier);
    assert.deepEqual(head.blockedBy, [], "没有前置的节点必须是空数组（不是 undefined，前端就不用判三态）");
    assert.equal(tail.blockedBy.length, 1, "被卡的节点必须列出前置");
    assert.equal(tail.blockedBy[0].identifier, blocker.identifier);
    assert.equal(tail.blockedBy[0].reason, "停写窗口未确认", "原因必须跟着前置走（人要知道为什么卡）");
    assert.equal(graph.edges[0].reason, "停写窗口未确认", "边上也要带 reason（明细视图直接可用）");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("三节点链 A→B→C 也必须前置在上（Kahn 不只处理两节点）", () => {
  const { dir, store, item } = seed();
  try {
    const c = store.createTask({ projectId: "p1", title: "C", status: "blocked", requirementId: item.identifier });
    const graph0 = store.requirementTaskGraph(item.identifier);
    const b = graph0.nodes.find((n) => n.status === "blocked" && n.blockedBy.length === 1);
    store.addTaskDependency({ blocker: b.identifier, blocked: c.identifier });
    const graph = store.requirementTaskGraph(item.identifier);
    const order = graph.nodes.map((n) => n.title);
    assert.deepEqual(order, ["C0 停写窗口", "C4 切流", "C"], `链序必须是 C0 → C4 → C（实际 ${order.join(" → ")}）`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
