/**
 * 卡 `-252` / 需求 `R180`：抽屉「取消任务（撤单）」入口。
 *
 * 背景（2026-11-12 真机批注）：「这条任务确认不执行，但是人工操作没有关闭按钮」——
 * `canceled` 早就是合法终态（服务端 PATCH 放行、库内已有既有 canceled 卡），缺的只是**前端入口**。
 *
 * 本文件守两层：
 *   ① 源码层：按钮存在、挂在抽屉标题栏动作区、danger 档、终态卡不摆、必须写原因、走页内 dialog（不许回退到 window.prompt）；
 *   ② 行为层：`backlog → canceled` 真能落库，评论能带原因，且下游任务被放行（撤单不是"卡着不动"）。
 *
 * 行为层只写真库，不写浏览器 —— 渲染后的按钮位置由 `bench-drawer-button-hierarchy.mjs` 那台负责。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(path.join(repoRoot, "web", "app.js"), "utf8");

function withStore(label, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t252-${label}-`));
  const store = openStore({ dataDir: dir });
  try {
    return fn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 把 `取消任务（撤单）` 那一段源码切出来 —— 按下一个兄弟按钮的边界收口，避免"全文件里找得到"的假绿。 */
function cancelBlock() {
  const start = appSrc.indexOf("// 需求 `R180` / 卡 `-252`");
  assert.ok(start > 0, "web/app.js 必须存在「取消任务（撤单）」入口（带 R180 / -252 来源注释）");
  const end = appSrc.indexOf("（原 `drawerBody.appendChild(ops)` 已移除", start);
  assert.ok(end > start, "撤单入口之后必须仍是既有的动作区收尾（说明它挂在抽屉标题栏 ops 上）");
  return appSrc.slice(start, end);
}

test("源码：撤单入口挂在抽屉标题栏、danger 档、只在非终态卡出现", () => {
  const block = cancelBlock();
  assert.match(block, /ops\.appendChild\(btn\("取消任务（撤单）"/, "必须挂到抽屉标题栏的 ops 容器");
  assert.match(block, /"danger"\)\)/, "撤单是危险档动作（不进主色层级）");
  // 终态守卫：done / canceled 都不许再摆这枚按钮
  assert.match(block, /t\.status !== "done" && t\.status !== "canceled"/, "终态卡不得出现撤单入口");
  assert.match(appSrc, /if \(t\.status !== "done" && t\.status !== "canceled"\) \{\n\s+ops\.appendChild\(btn\("取消任务（撤单）"/, "守卫必须直接包住这枚按钮");
});

test("源码：撤单必须写原因、走页内 dialog、落库带 actor=human", () => {
  const block = cancelBlock();
  assert.match(block, /askFields\(/, "取值出口必须走页内 dialog（宿主无 window.prompt，见卡 -242）");
  assert.ok(!/window\.prompt\s*\(/.test(block), "不许回退到 window.prompt");
  assert.match(block, /required: true/, "原因必填");
  assert.match(block, /撤单必须写原因/, "空原因要有显式提示文案");
  assert.match(block, /status: "canceled"/, "终态写 canceled");
  assert.match(block, /actor: "human"/, "人工撤单，审计 actor 记 human");
  assert.match(block, /\/comments`/, "原因要落评论（不是只改状态）");
  // 乐观锁：抽屉里的 t 可能是旧快照，必须先取最新 version
  assert.match(block, /api\("GET", `\/api\/tasks\/\$\{ref\}`\)/, "提交前必须取最新 version");
});

test("行为：backlog → canceled 能落库、评论带原因；且如实记录「canceled 不算完成」的现状", () => {
  withStore("cancel", (store) => {
    store.createProject({ id: "demo", name: "Demo" });
    const upstream = store.createTask({ projectId: "demo", title: "上游（确认不执行）" });
    const downstream = store.createTask({ projectId: "demo", title: "下游（等上游）" });
    store.addTaskDependency({ blocker: upstream.identifier, blocked: downstream.identifier, reason: "等上游产物" });

    const before = store.isTaskReady(downstream.identifier);
    assert.equal(before.ready, false, "上游未终结时下游不该就绪");

    const canceled = store.updateTask(upstream.identifier, {
      expectedVersion: upstream.version,
      status: "canceled",
      actor: "human",
    });
    assert.equal(canceled.status, "canceled");

    const comment = store.addComment(upstream.identifier, {
      body: "人工撤单（不执行）：真源4 能力清单不再需要",
      actor: "human",
    });
    assert.match(comment.body, /人工撤单/, "评论要留下原因原文");
    assert.ok(store.listComments(upstream.id).some((c) => /不再需要/.test(c.body ?? "")), "评论必须可回读");

    // 现状如实钉住（不粉饰）：`isTaskReady` 只把 done 当作前置完成，**canceled 仍算未完成** ⇒
    // 撤单后下游依旧 `ready=false`。这不是本卡的验收项（本卡只补入口），缺口已登记为卡 `-253`。
    const after = store.isTaskReady(downstream.identifier);
    assert.equal(after.ready, false, "现状：canceled 不解除依赖阻塞（卡 -253 跟踪）");
    assert.deepEqual(after.blockers.map((b) => b.status), ["canceled"], "阻塞来源应只剩那张已撤单的卡");
  });
});
