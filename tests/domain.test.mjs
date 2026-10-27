/**
 * 领域层单元测试：七状态、五优先级、可读编号、标签、父子与治理（FR-04/06/07/08/09/10）。
 * 运行：node --test（cwd = 项目根目录）
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PRIORITIES,
  PRIORITY_RANK,
  STATUSES,
  assertNoCycle,
  assertParentLink,
  assertPriority,
  assertProjectId,
  assertStatus,
  checkGovernance,
  compareByPriority,
  formatIdentifier,
  normalizeLabels,
  parseIdentifier,
  slugify,
} from "../src/core/domain.mjs";

test("七状态与五优先级的集合与顺序固定", () => {
  assert.deepEqual(STATUSES, [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "done",
    "blocked",
    "canceled",
  ]);
  assert.deepEqual(PRIORITIES, ["none", "low", "medium", "high", "urgent"]);
  assert.equal(PRIORITY_RANK.urgent, 0);
  assert.equal(PRIORITY_RANK.none, 4);
});

test("状态/优先级校验给出可区分的错误码", () => {
  assert.equal(assertStatus("in_review"), "in_review");
  assert.throws(() => assertStatus("doing"), (error) => error.code === "INVALID_STATUS");
  assert.equal(assertPriority("urgent"), "urgent");
  assert.throws(() => assertPriority("p0"), (error) => error.code === "INVALID_PRIORITY");
});

test("项目 id 与可读编号：前缀派生、格式与解析", () => {
  assert.equal(slugify("Demo Project"), "demo-project");
  assert.equal(slugify("中文名"), "");
  assert.equal(assertProjectId("demo"), "demo");
  assert.throws(() => assertProjectId("Demo"), (error) => error.code === "INVALID_ID");
  assert.throws(() => assertProjectId("d"), (error) => error.code === "INVALID_ID");
  assert.equal(formatIdentifier("demo", 1), "demo-1");
  assert.deepEqual(parseIdentifier("demo-42"), { prefix: "demo", sequence: 42 });
  assert.equal(parseIdentifier("demo"), null);
  assert.equal(parseIdentifier("demo-0"), null);
  assert.throws(() => formatIdentifier("demo", 0), (error) => error.code === "INVALID_FIELD");
});

test("标签规范化：支持逗号串/数组、去重、拒绝空与超长", () => {
  assert.deepEqual(normalizeLabels("a, b ,a"), ["a", "b"]);
  assert.deepEqual(normalizeLabels(["a,b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(normalizeLabels([]), []);
  assert.deepEqual(normalizeLabels(undefined), []);
  assert.throws(
    () => normalizeLabels(["x".repeat(41)]),
    (error) => error.code === "INVALID_LABEL",
  );
  assert.throws(
    () => normalizeLabels(Array.from({ length: 21 }, (_, i) => `l${i}`)),
    (error) => error.code === "INVALID_LABEL",
  );
});

test("父子校验：自环、已有父、跨项目分别被拒绝", () => {
  const child = { id: "c", projectId: "demo", parentId: null };
  assert.throws(
    () => assertParentLink(child, { id: "c", projectId: "demo", parentId: null }),
    (error) => error.code === "PARENT_CYCLE",
  );
  assert.throws(
    () => assertParentLink({ id: "c", projectId: "demo", parentId: "p1" }, { id: "p2", projectId: "demo", parentId: null }),
    (error) => error.code === "PARENT_ALREADY_SET",
  );
  assert.throws(
    () => assertParentLink(child, { id: "p", projectId: "other", parentId: null }),
    (error) => error.code === "PARENT_CROSS_PROJECT",
  );
  assert.doesNotThrow(() =>
    assertParentLink({ id: "c", projectId: "demo", parentId: "p" }, { id: "p", projectId: "demo", parentId: null }),
  );
});

test("成环检测：a->b->c 时再让 a 的父为 c 会被拒绝", () => {
  const nodes = new Map([
    ["a", { id: "a", parentId: null }],
    ["b", { id: "b", parentId: "a" }],
    ["c", { id: "c", parentId: "b" }],
  ]);
  const getTask = (id) => nodes.get(id);
  assert.doesNotThrow(() => assertNoCycle("d", "c", getTask));
  assert.throws(() => assertNoCycle("a", "c", getTask), (error) => error.code === "PARENT_CYCLE");
  assert.throws(() => assertNoCycle("b", "c", getTask), (error) => error.code === "PARENT_CYCLE");
});

test("治理能力位：默认不拦截；enforce 后才拒绝智能体越权", () => {
  assert.equal(checkGovernance({ actor: "agent", from: "in_review", to: "done" }), null);
  const policy = { enforce: true, blockAgentClaimFromBacklog: true };
  assert.throws(
    () => {
      const error = checkGovernance({ actor: "agent", from: "in_review", to: "done" }, policy);
      if (error) throw error;
    },
    (error) => error.code === "AGENT_CANNOT_SET_DONE",
  );
  assert.throws(
    () => {
      const error = checkGovernance({ actor: "agent", from: "backlog", to: "in_progress" }, policy);
      if (error) throw error;
    },
    (error) => error.code === "AGENT_CANNOT_CLAIM_BACKLOG",
  );
  assert.equal(checkGovernance({ actor: "human", from: "in_review", to: "done" }, policy), null);
});

test("优先级排序：紧急在前，同级保持创建顺序", () => {
  const tasks = [
    { priority: "none", createdAt: "2026-01-01T00:00:00.000Z" },
    { priority: "urgent", createdAt: "2026-01-02T00:00:00.000Z" },
    { priority: "high", createdAt: "2026-01-03T00:00:00.000Z" },
  ];
  assert.deepEqual(
    tasks.slice().sort(compareByPriority).map((task) => task.priority),
    ["urgent", "high", "none"],
  );
});
