/**
 * FR-95 守卫：「重建投递验证台」必须**持续**覆盖会话命名口径。
 *
 * 为什么需要这条：命名口径（【任务】/【项目】/「重建」「重绑」备注）在单测里被钉住，但真机侧
 * 唯一的**真进程**证据是 `tools/bench-rebind-deliver.mjs` —— 而它 2026-10-22 首版**从没断言过标题**，
 * 桩里也**没有 `renameSession`** ⇒ 改绑改名那条路在验证台里等于没被走。2026-10-26 补齐后，
 * 本测试防止这些断言被静默删掉（删了就红，不是「没人跑就没人发现」）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-rebind-deliver.mjs"), "utf8");

test("FR-95-16：验证台必须覆盖命名口径（【项目】/【任务】/「重建」「重绑」/改名失败）", () => {
  // 桩必须真的接收改名（否则「改绑已有会话 ⇒ 改名」这条在验证台里没有落点）
  assert.match(BENCH, /async renameSession\(id, title\)/, "桩必须实现 renameSession");
  assert.match(BENCH, /titleApplied: Boolean\(named\.renamed\)/, "桩必须复刻宿主契约：create 不收 title ⇒ 建完 rename 并回流 titleApplied");
  // 三种口径逐条必须在断言里出现
  assert.match(BENCH, /【项目】重建投递验证台`/, "必须断言项目主会话名（口径 2，无指针时不加备注）");
  assert.match(BENCH, /【项目】重建投递验证台（重建）/, "必须断言「重建」备注");
  assert.match(BENCH, /【项目】重建投递验证台（重绑）/, "必须断言「重绑」备注");
  assert.match(BENCH, /\/\^【任务】更改按钮样式 · \\d\{4\}-\\d\{2\}-\\d\{2\} \\d\{2\}:\\d\{2\}\$\//, "必须断言任务会话名形状（口径 1）");
  // 失败路径也必须被钉（不许只测 happy path）
  assert.match(BENCH, /bindFail\.payload\?\.titleApplied === false && bindFail\.payload\?\.titleReason === "bench-rename-failed"/, "必须断言改名失败时 titleApplied=false 且原因如实（不许只测 happy path）");
});
