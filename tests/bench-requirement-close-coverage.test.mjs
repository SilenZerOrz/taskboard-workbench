/**
 * 守卫（2026-10-26）：`tools/bench-requirement-close.mjs` 必须**持续覆盖「需求条目 → 完成」这一跳的语义**。
 *
 * 为什么需要这条：真机上需求条目 122 条**全停在 `open`** —— 「需求 → 完成」是目标链路里**唯一从未被现实走过**
 * 的一跳。本守卫钉住台子的**要害断言**，防后来者把某条判定**静默删掉**而台子照旧全绿：
 *   ① 完成度必须随关联任务状态**四态推进**（`no-tasks` → `in-progress` → `in-review` → `all-closed`）；
 *   ② 前三态**必须**断言 `ready === false`（不得谎报完成）；
 *   ③ 需求终态必须由**人 PATCH** 落地并落审计 `requirement-status`；
 *   ④ 必须保留两条**负向对照**（归因门拦截 / 收口≠任务收口）；
 *   ⑤ 任务 `done` 必须走**带 `version` 的乐观并发**（否则台子自己会 400 `MISSING_VERSION`）。
 *
 * 本文件只读源码文本（不起进程、不联网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-requirement-close.mjs"), "utf8");

test("守卫：需求收口台必须覆盖完成度四态推进（no-tasks → in-progress → in-review → all-closed）", () => {
  for (const v of ["no-tasks", "in-progress", "in-review", "all-closed"]) {
    assert.match(src, new RegExp(`verdict === "${v}"`), `完成度判定必须显式断言 ${v}`);
  }
});

test("守卫：未到 all-closed 之前，必须断言 ready===false（不谎报完成）", () => {
  const falses = src.match(/ready === false/g) ?? [];
  assert.ok(falses.length >= 3, `至少三处（no-tasks / in-progress / in-review）要断言 ready===false，实际 ${falses.length}`);
  assert.match(src, /verdict === "all-closed" && comp\.payload\?\.ready === true/, "all-closed 必须同时要求 ready===true");
});

test("守卫：需求终态必须由人 PATCH 落地并落审计 requirement-status", () => {
  assert.match(src, /status: "done", actor: "human"/, "必须由人 PATCH 置 done");
  assert.match(src, /listGovernanceAudit\(\{ action: "requirement-status" \}\)/, "必须核审计 requirement-status");
});

test("守卫：必须保留两条负向对照（归因门拦截 / 收口≠任务收口）", () => {
  assert.match(src, /EXECUTION_NOT_ATTRIBUTED/, "必须保留「未归因卡不得被 CLI 真跑」的负向对照");
  assert.match(src, /收口≠任务收口/, "必须保留「需求收口不等于任务收口」的负向对照");
});

test("守卫：任务 done 必须带 expectedVersion（乐观并发）且非法状态被拒", () => {
  assert.match(src, /version: liveVersion/, "人点 done 必须带 version");
  assert.match(src, /INVALID_FIELD/, "必须断言非法状态被拒");
});

test("守卫：必须复证「看板派发」（execution-loop）路径，而不是只有人工 exec-cli", () => {
  assert.match(src, /\/api\/projects\/\$\{projectId\}\/execution-loop/, "必须真的调执行循环 tick（目标路径写的是「看板派发」）");
  assert.match(src, /dispatched \?\? \[\]\)\.map\(\(x\) => x\?\.task\)/, "`dispatched` 是对象数组 ⇒ 必须取 `.task` 再断言");
  assert.match(src, /waitFor\(task3\.identifier/, "看板派发是异步的（tick 后任务仍 in_progress）⇒ 必须轮询等 in_review");
  assert.match(src, /派发路径/, "必须有「派发路径」这一组断言");
});
