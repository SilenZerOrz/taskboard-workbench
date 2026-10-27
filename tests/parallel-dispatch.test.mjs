/**
 * FR-86：同需求**最大并行** + 关键阻塞**按影响域**叫停（执行循环派发批）。
 *
 * 口径（docs/需求文档.md §四N FR-86）：
 *   · 同需求关联任务同轮尽多派发（受并发上限与任务级锁约束），不再一条一条串；
 *   · 仅**关键阻塞**（评审未过 / 上游未就绪 / 人工校验未结论 / 熔断打开 / 共享文件冲突）才裁剪；
 *   · 共享文件冲突必须**显式串行**（同轮只放行一条，其余标 serialized 并写明哪个文件冲突）；
 *   · 叫停只覆盖影响域（该任务自身 + 依赖它的下游），**不得整批停**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { runExecutionLoop, targetFilesOf, SHARED_FILES, keyBlockOf, downstreamOf } from "../src/core/loop.mjs";
import { planHumanReview } from "../src/core/human-review.mjs";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const item = store.createRequirementItem({ projectId: "p1", title: "R86" });
  const todo = (title, extra = {}) => {
    const t = store.createTask({ projectId: "p1", title, status: "todo", ...extra });
    store.associateRequirementTask(item.id, t.id);
    return t;
  };
  return { store, item, todo };
}

// ------------------------------------------------------------------ ① 最大并行

test("FR-86 最大并行：同一需求下多条任务**同轮**全部派发（不再一条一条串）", async () => {
  const { store, todo } = setup();
  const ts = [todo("任务甲"), todo("任务乙"), todo("任务丙")];

  const r = await runExecutionLoop({ store, projectId: "p1" });

  assert.deepEqual(r.dispatched.map((d) => d.task).sort(), ts.map((t) => t.identifier).sort(), "三条应同轮派发");
  // 结构化并行结果：按需求条目汇总，条数=3，且无裁剪
  const g = r.parallel.find((x) => x.requirementId != null);
  assert.equal(g.count, 3);
  assert.deepEqual(g.dispatched.slice().sort(), ts.map((t) => t.identifier).sort());
  assert.equal(r.stopped.length, 0);
  assert.equal(r.serialized.length, 0);
  // 三条都真的进了「进行中」并各自拿到任务级锁（并行而非串行）
  for (const t of ts) {
    assert.equal(store.requireTaskRef(t.identifier).status, "in_progress");
    assert.ok(store.getTaskLock(t.identifier), "每条都应有独立任务级锁");
  }
  store.close();
});

test("FR-86 自测位：共享文件解析只认路径引用，解析不到即无冲突", () => {
  assert.deepEqual(targetFilesOf({ title: "改 store.mjs", description: "" }), ["store.mjs"]);
  assert.deepEqual(targetFilesOf({ title: "改 src/core/store.mjs 的派发批", description: "顺带动 web/app.js" }), ["store.mjs", "web/app.js"]);
  // 反例：只是词形相近 / 普通正文，不得误判
  assert.deepEqual(targetFilesOf({ title: "写一份 index.json 说明", description: "讲讲 store.mjsx" }), []);
  assert.deepEqual(targetFilesOf({ title: "纯业务任务", description: "只改业务逻辑，不碰共享文件" }), []);
  assert.ok(SHARED_FILES.includes("index.js") && SHARED_FILES.includes("api.mjs"));
});

// ------------------------------------------------------------------ ② 共享文件冲突

test("FR-86 共享文件冲突：同轮只放行一条，其余标 serialized 并写明冲突文件", async () => {
  const { store, todo } = setup();
  const a = todo("给 store.mjs 加索引", { description: "改 src/core/store.mjs 的 listTasks" });
  const b = todo("给 store.mjs 加缓存", { description: "同样要动 src/core/store.mjs" });
  const c = todo("无关任务", { description: "只改业务模块，不碰共享文件" });

  const r = await runExecutionLoop({ store, projectId: "p1" });

  // 三条都是"可派发"（无关键阻塞）：只有共享文件冲突把 b 串行化，a / c 仍同轮并行
  assert.equal(r.dispatched.length, 2);
  assert.ok(r.dispatched.some((d) => d.task === a.identifier));
  assert.ok(r.dispatched.some((d) => d.task === c.identifier), "不冲突的任务必须照常并行（裁剪是定向的）");

  assert.equal(r.serialized.length, 1);
  const s = r.serialized[0];
  assert.equal(s.task, b.identifier);
  assert.equal(s.reason, "shared-file-conflict");
  assert.equal(s.file, "store.mjs");
  assert.equal(s.heldBy, a.identifier, "应写明是让行给哪一条同轮任务");
  assert.ok(s.detail.includes("store.mjs"), "reason 必须写明是哪个文件冲突");
  // 被串行化的任务保持 todo（不认领、不置进行中），等下一轮
  assert.equal(store.requireTaskRef(b.identifier).status, "todo");
  assert.equal(store.getTaskLock(b.identifier), null);
  // 看板显式标注原因（人可读）
  assert.ok(store.listComments(b.identifier).some((x) => x.body.includes("FR-86 串行化") && x.body.includes("store.mjs")));
  store.close();
});

// ------------------------------------------------------------------ ③ 评审未过只停影响域
test("FR-86 共享文件冲突【跨轮】：前一条仍在执行时，后一条不得被放行（真机复现 2026-10-18）", async () => {
  const { store, todo } = setup();
  const a = todo("给 store.mjs 加索引", { description: "改 src/core/store.mjs 的 listTasks" });
  const b = todo("给 store.mjs 加缓存", { description: "同样要动 src/core/store.mjs" });

  const r1 = await runExecutionLoop({ store, projectId: "p1" });
  assert.deepEqual(r1.dispatched.map((d) => d.task), [a.identifier]);
  assert.equal(r1.serialized.length, 1);
  assert.equal(r1.serialized[0].task, b.identifier);
  assert.equal(store.requireTaskRef(a.identifier).status, "in_progress");

  // 关键：前一条**仍在执行**（任务级执行锁仍开着）→ 下一轮同样不得放行 b。
  // 修复前冲突表只统计"本轮放行"，a 已离开 todo，于是 b 在下一跳被放行 →
  // 同一共享文件被两条任务并行修改（真机实测重叠约 105s）。
  const r2 = await runExecutionLoop({ store, projectId: "p1" });
  assert.equal(r2.dispatched.length, 0, "前一条仍在执行时不得放行同文件任务");
  assert.equal(r2.serialized.length, 1);
  assert.equal(r2.serialized[0].task, b.identifier);
  assert.equal(r2.serialized[0].heldBy, a.identifier);
  assert.equal(r2.serialized[0].reason, "shared-file-conflict");
  assert.equal(store.requireTaskRef(b.identifier).status, "todo");

  // 占用方结束 → 下一轮才放行 b（串行是"等它做完"，不是"永久封禁"）
  store.updateTask(a.identifier, { status: "in_review", expectedVersion: store.requireTaskRef(a.identifier).version });
  const r3 = await runExecutionLoop({ store, projectId: "p1" });
  assert.deepEqual(r3.dispatched.map((d) => d.task), [b.identifier], "占用方结束后才放行");
  store.close();
});


test("FR-86 评审未过：只停该任务的影响域（自身 + 下游），同需求其余任务继续并行", async () => {
  const { store, todo } = setup();
  const blockedTask = todo("被退回返工的任务");
  const downstream = todo("依赖被退回任务的下游");
  const sibling = todo("同需求互不相干的任务");

  store.addTaskDependency({ blocker: blockedTask.identifier, blocked: downstream.identifier, reason: "下游要等上游评审通过" });
  // 真实评审门：提交待验收 → 评审未过请求返工（退回来源列）
  store.requestReview(blockedTask.identifier, { reviewer: "human" });
  store.requestChanges(blockedTask.identifier, { comment: "实现不达标，退回返工" });
  assert.equal(store.requireTaskRef(blockedTask.identifier).status, "todo", "前置：返工确实退回来源列（可开工）");
  assert.equal(store.requireTaskRef(blockedTask.identifier).reviewState, "changes_requested");

  const r = await runExecutionLoop({ store, projectId: "p1" });

  const stoppedRefs = r.stopped.map((x) => x.task);
  assert.ok(stoppedRefs.includes(blockedTask.identifier), "评审未过的任务必须被叫停");
  assert.ok(stoppedRefs.includes(downstream.identifier), "依赖它的下游同属影响域，一并叫停");
  const entry = r.stopped.find((x) => x.task === blockedTask.identifier);
  assert.equal(entry.reason, "review-not-passed");
  assert.ok(entry.detail.includes("返工"));
  // 影响域明细可见（下游标识）
  assert.deepEqual((entry.downstream ?? []).map((x) => x.identifier), [downstream.identifier]);

  // **不得整批停**：同需求其余任务照常派发
  assert.deepEqual(r.dispatched.map((d) => d.task), [sibling.identifier]);
  assert.equal(store.requireTaskRef(sibling.identifier).status, "in_progress");
  assert.equal(store.requireTaskRef(blockedTask.identifier).status, "todo", "被叫停的任务状态不动");
  store.close();
});

test("FR-86 上游未就绪：下游被叫停且 reason=upstream-blocked；同需求其余任务继续", async () => {
  const { store, todo } = setup();
  const upstream = todo("上游任务");
  const downstream = todo("下游任务");
  const sibling = todo("平行任务");
  store.addTaskDependency({ blocker: upstream.identifier, blocked: downstream.identifier });
  // 上游被人停手在受阻（不会自行变 done）
  store.blockTask(upstream.identifier, { kind: "needs_input", reason: "等需求澄清" });
  assert.equal(store.requireTaskRef(upstream.identifier).status, "blocked");

  const r = await runExecutionLoop({ store, projectId: "p1" });

  assert.deepEqual(r.dispatched.map((d) => d.task), [sibling.identifier]);
  const entry = r.stopped.find((x) => x.task === downstream.identifier);
  assert.equal(entry.reason, "upstream-blocked");
  assert.ok(entry.detail.includes(upstream.identifier));
  assert.ok(r.blockedByUpstream.some((x) => x.task === downstream.identifier));
  // 影响域工具函数：下游可达域只含下游本身（不含平行任务）
  assert.deepEqual(downstreamOf(store, store.requireTaskRef(upstream.identifier)).map((x) => x.identifier), [downstream.identifier]);
  store.close();
});

// ------------------------------------------------------------------ ④ 人工校验未结论

test("FR-86 人工校验未结论：越过升级门的下游被叫停（reason=human-review-pending）", async () => {
  const { store, item, todo } = setup();
  const original = todo("原任务");
  const downstream = todo("被升级门挡住的下游");
  store.addTaskDependency({ blocker: original.identifier, blocked: downstream.identifier });
  // 人在环升级门：建人工校验任务（结论未给出）+ 挡住原任务
  const plan = planHumanReview({
    task: { identifier: original.identifier, title: original.title },
    blockKind: "transient",
    blockRecurrences: 2,
    evidence: [{ kind: "failure", summary: "退出码 1：TypeError at store.mjs:88" }],
  });
  const human = store.createHumanReviewTask({ projectId: "p1", draft: plan.draft, requirementId: item.id, relatedTask: original.identifier });
  store.updateTask(human.identifier, { expectedVersion: store.getTaskRef(human.identifier).version, status: "todo" });

  const r = await runExecutionLoop({ store, projectId: "p1" });

  // 人工校验任务本身不得被派发（FR-85b）
  assert.ok(!r.dispatched.some((d) => d.task === human.identifier));
  assert.ok(r.blockedByHumanReview.some((x) => x.task === human.identifier));
  // 原任务被这扇门挡着（依赖边由 createHumanReviewTask 建立在 门 → 原任务）→ 不得越过未结论的门推进
  const gated = r.stopped.find((x) => x.task === original.identifier);
  assert.ok(gated, "被升级门挡住的原任务必须被叫停");
  assert.equal(gated.reason, "human-review-pending");
  assert.ok(gated.detail.includes(human.identifier), "detail 应写明是哪扇门");
  assert.equal(keyBlockOf(store, store.requireTaskRef(original.identifier))?.reason, "human-review-pending");

  // 影响域继续外扩：原任务的下游也被叫停（不得整批停，但影响域内必须停）
  const entry = r.stopped.find((x) => x.task === downstream.identifier);
  assert.ok(entry, "影响域内的下游必须被叫停");
  assert.equal(entry.reason, "upstream-blocked");
  for (const ref of [original.identifier, downstream.identifier]) {
    assert.equal(store.requireTaskRef(ref).status, "todo", "被叫停的任务状态不动");
  }
  assert.deepEqual(r.dispatched, [], "本批无任务越过升级门");
  store.close();
});

// ------------------------------------------------------------------ ⑤ 熔断打开

test("FR-86 熔断打开：只停该条，同需求其余任务照常并行", async () => {
  const { store, todo } = setup();
  const fused = todo("熔断任务");
  const other = todo("正常任务");
  // 连续失败达阈值 → 熔断打开（FR-78）
  store.recordTaskFailure(fused.identifier, { error: "编译失败" });
  store.recordTaskFailure(fused.identifier, { error: "编译失败" });
  const cur = store.getTaskRef(fused.identifier);
  store.updateTask(fused.identifier, { expectedVersion: cur.version, status: "todo" }); // 模拟"人工改回可开工但熔断未解除"

  const r = await runExecutionLoop({ store, projectId: "p1" });

  assert.deepEqual(r.dispatched.map((d) => d.task), [other.identifier], "只停熔断那一条");
  assert.ok(r.blockedByGuard.some((x) => x.task === fused.identifier && x.reason === "circuit-open"));
  assert.equal(store.requireTaskRef(fused.identifier).status, "todo");
  assert.equal(store.requireTaskRef(other.identifier).status, "in_progress");
  store.close();
});
