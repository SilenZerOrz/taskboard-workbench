/**
 * 卡 `-253` / 需求 `R181`：**撤单（canceled）解除依赖阻塞**。
 *
 * 现象（2026-11-12）：`isTaskReady` 写的是 `status !== "done"` ⇒ 前置一撤单，下游 `ready` 永远是
 * `false`，只能人工把下游拖出「受阻」。而仓里其它四处（`concludeHumanReview` 放行循环、
 * `loop.mjs` 派发守卫、`requirementCompletion` 的「已收口」、MCP `TERMINAL`）**早就**按
 * 「`done` = 已交付 / `canceled` = 已终结」的口径走 ⇒ 只有 `isTaskReady` 是异类。
 *
 * 本文件守四层：
 *   ① 口径：canceled 是「前置终结」⇒ `ready: true`，但**不合并进 done**（`basis` / `settledByCancel`
 *      把「撤了单」与「交付了」分开呈现，且 canceled 不计入需求完成度的「已完成」）；
 *   ② 级联：撤单把因依赖受阻的下游放回「可开工」，并落事件 `dependency_released` + 评论 + 审计；
 *   ③ 边界：其余前置未终结 ⇒ 不放行；只放一跳（A→B→C 里 C 仍等 B）；非依赖类受阻（capability 等）
 *      **不**因前置撤单被放行；
 *   ④ 两条撤单入口（看板 PATCH / 团队通道）都要放行。
 *
 * 行为层只写真库，不写浏览器 —— 渲染后的按钮与依赖展示由既有前端台负责。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";

/** 每个用例一套独立临时库（跑完即删）。 */
function withStore(label, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t253-${label}-`));
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "demo", name: "Demo" });
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A → B 的单边依赖（返回两张卡的新鲜快照）。 */
function twoTasks(store) {
  const a = store.createTask({ projectId: "demo", title: "A（确认不执行）" });
  const b = store.createTask({ projectId: "demo", title: "B（等 A）" });
  store.addTaskDependency({ blocker: a.identifier, blocked: b.identifier, reason: "等 A 的产物" });
  return { a, b };
}

const cancel = (store, task, actor = "human") => store.updateTask(task.identifier, {
  expectedVersion: store.requireTaskRef(task.identifier).version,
  status: "canceled",
  actor,
});

test("口径：canceled 是「前置终结」⇒ 下游 ready=true，但**不**等同于 done", () => {
  withStore("basis", (store) => {
    const { a, b } = twoTasks(store);
    assert.equal(store.isTaskReady(b.identifier).ready, false, "撤单前：上游未终结 ⇒ 下游未就绪");

    cancel(store, a);
    const ready = store.isTaskReady(b.identifier);
    assert.equal(ready.ready, true, "撤单后：下游不再被依赖阻塞");
    assert.equal(ready.basis, "settled-with-canceled", "就绪依据必须写明「靠撤单终结」，不能只说就绪");
    assert.deepEqual(ready.settledByCancel.map((x) => x.identifier), [a.identifier], "点名是谁没交付");
    assert.deepEqual(ready.pending, [], "撤单的前置不再计入 pending");
    assert.deepEqual(ready.blockers.map((x) => x.status), ["canceled"], "blockers 保留 status 原文，不折叠成 done");

    // 不把 canceled 当 done：卡本身仍是 canceled，且需求完成度里「已完成」不计它
    assert.equal(store.requireTaskRef(a.identifier).status, "canceled", "撤单 ≠ 完成，不得改写前置状态");
    const item = store.createRequirementItem({ projectId: "demo", title: "R" });
    store.associateRequirementTask(item.id, a.id);
    store.associateRequirementTask(item.id, b.id);
    const completion = store.requirementCompletion(item.identifier);
    assert.equal(completion.counts.done, 0, "canceled 不得计入「已完成」（会掩盖「没做」）");
    assert.equal(completion.counts.canceled, 1, "canceled 单独计数");
  });
});

test("口径：done 前置仍走「已交付」那一档（原行为零回归）", () => {
  withStore("done", (store) => {
    const { a, b } = twoTasks(store);
    store.updateTask(a.identifier, { expectedVersion: a.version, status: "done", actor: "human" });
    const ready = store.isTaskReady(b.identifier);
    assert.equal(ready.ready, true);
    assert.equal(ready.basis, "all-done", "前置真交付 ⇒ basis=all-done（与撤单区分开）");
    assert.deepEqual(ready.settledByCancel, []);
  });
});

test("级联：撤单把「因依赖受阻」的下游放回可开工，事件 + 评论 + 审计都可回读", () => {
  withStore("release", (store) => {
    const { a, b } = twoTasks(store);
    // 真实形态：评审门/上游失败把下游压成「受阻·dependency」（route=hold 才保持 blocked）
    store.blockTask(b.identifier, { kind: "dependency", reason: "上游未过评审", actor: "team", route: "hold" });
    const blocked = store.requireTaskRef(b.identifier);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.blockedAt !== null, true, "受阻起始时间应有值（放行时要清掉）");

    cancel(store, a);
    const after = store.requireTaskRef(b.identifier);
    assert.equal(after.status, "todo", "前置撤单 ⇒ 下游从「受阻」回「可开工」");
    assert.equal(after.blockedAt, null, "离开受阻必须清空 blocked_at");
    assert.equal(store.isTaskReady(b.identifier).ready, true);

    const events = store.listTaskEvents(b.identifier).filter((e) => e.type === "dependency_released");
    assert.equal(events.length, 1, "下游状态变化必须有事件（不能只是静默改库）");
    assert.equal(events[0].from, "blocked");
    assert.equal(events[0].to, "todo");
    assert.match(events[0].detail, /撤单/, "事件说明必须写「前置已撤单」");
    assert.match(events[0].detail, new RegExp(a.identifier), "事件要能指名是哪张前置");

    const comments = store.listComments(b.identifier).map((c) => c.body).join("\n");
    assert.match(comments, /撤单/, "必须落评论写明为什么突然可开工");
    assert.match(comments, /不等于前置已完成|不等于.*完成/, "评论要写清「撤单 ≠ 交付」");

    const audit = store.listGovernanceAudit({ action: "dependency-released" });
    assert.equal(audit.length, 1, "放行动作要进治理审计");
    assert.equal(audit[0].target, b.identifier);
  });
});

test("边界：其余前置仍未终结 ⇒ 保持受阻，不提前放行", () => {
  withStore("multi", (store) => {
    const { a, b } = twoTasks(store);
    const c = store.createTask({ projectId: "demo", title: "C（还在跑）" });
    store.addTaskDependency({ blocker: c.identifier, blocked: b.identifier });
    store.blockTask(b.identifier, { kind: "dependency", reason: "等 A、C", actor: "team", route: "hold" });

    cancel(store, a);
    const ready = store.isTaskReady(b.identifier);
    assert.equal(ready.ready, false, "还有前置没终结 ⇒ 不就绪");
    assert.deepEqual(ready.pending.map((x) => x.identifier), [c.identifier]);
    assert.equal(store.requireTaskRef(b.identifier).status, "blocked", "不得因为撤了一张就把还在等的卡放出来");
  });
});

test("边界：只放一跳 —— A 撤单放 B，C 仍等 B（不连锁放行）", () => {
  withStore("chain", (store) => {
    const a = store.createTask({ projectId: "demo", title: "A" });
    const b = store.createTask({ projectId: "demo", title: "B" });
    const c = store.createTask({ projectId: "demo", title: "C" });
    store.addTaskDependency({ blocker: a.identifier, blocked: b.identifier });
    store.addTaskDependency({ blocker: b.identifier, blocked: c.identifier });
    store.blockTask(b.identifier, { kind: "dependency", reason: "等 A", actor: "team", route: "hold" });
    store.blockTask(c.identifier, { kind: "dependency", reason: "等 B", actor: "team", route: "hold" });

    cancel(store, a);
    assert.equal(store.requireTaskRef(b.identifier).status, "todo", "A 撤单 ⇒ B 放行");
    assert.equal(store.requireTaskRef(c.identifier).status, "blocked", "B 只是回「可开工」，没交付 ⇒ C 继续等");
    assert.equal(store.isTaskReady(c.identifier).ready, false);
    assert.equal(
      store.listTaskEvents(c.identifier).filter((e) => e.type === "dependency_released").length,
      0,
      "C 不应有不属于自己的放行事件",
    );
  });
});

test("边界：非依赖类受阻（capability）不因前置撤单被放行", () => {
  withStore("capability", (store) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "capability", reason: "本机没有目标运行时", actor: "watchdog" });
    assert.equal(store.requireTaskRef(b.identifier).status, "blocked");

    cancel(store, a);
    const after = store.requireTaskRef(b.identifier);
    assert.equal(after.status, "blocked", "「这张卡自己做不了」与「前置撤单」无关 ⇒ 保持受阻");
    assert.equal(store.isTaskReady(b.identifier).ready, true, "就绪（不用再等前置）但受阻（自身能力缺口）是两件事");
    assert.equal(store.listTaskEvents(b.identifier).filter((e) => e.type === "dependency_released").length, 0);
  });
});

test("团队通道撤单同样放行下游（两条入口口径一致）", () => {
  withStore("team", (store) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "dependency", reason: "等 A", actor: "team", route: "hold" });

    store.teamSetTaskStatus(a.identifier, { status: "canceled", actor: "team" });
    assert.equal(store.requireTaskRef(a.identifier).status, "canceled");
    assert.equal(store.requireTaskRef(b.identifier).status, "todo", "团队通道撤单同样放行");
    const event = store.listTaskEvents(b.identifier).find((e) => e.type === "dependency_released");
    assert.ok(event, "同样要落事件");
    assert.equal(event.actor, "team", "事件要记真实入口（团队通道）");
  });
});
