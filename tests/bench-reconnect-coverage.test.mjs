/**
 * 守卫（2026-10-26）：`tools/bench-reconnect.mjs` 必须**持续覆盖 FR-20 验收要点原文**。
 *
 * 为什么需要这条：FR-20 的验收要点是「断开一个窗口的网络 → 另一窗口**修改两个任务** → 恢复网络
 * → 断开窗口出现这两个变更」。验证台最初只造**一处**变更（新建一个卡），**不足以**支撑该条款；
 * 2026-10-26 加厚为「改一个 + 新建一个」。本守卫钉住三件事，防后来者把加厚**静默删掉**而台子照旧全绿：
 *   ① 台内基线必须备**两个**任务（改动的目标要在场）；
 *   ② 断连期间必须做**两处**写入（`createTask` + `updateTask`）；
 *   ③ 合并判定必须同时要求两处变更都补齐。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-reconnect.mjs"), "utf8");

test("守卫：FR-20 台必须造「两处变更」（改一个 + 新建一个），不得退回单变更", () => {
  assert.match(src, /title: "待改条目"/, "基线必须备好「可被改动」的目标任务");
  assert.match(src, /store\.updateTask\(edited\.id, \{[^}]*title: "断连期间改过的条目"/, "断连期间必须**修改**已有任务（条款写的是『修改任务』）");
  assert.match(src, /title: "断连期间写入的卡"/, "断连期间必须**新建**任务（第二处变更）");
  // 合并判定：两处都到位才算补齐
  assert.match(src, /c\.titles\.includes\("断连期间写入的卡"\) && c\.titles\.includes\("断连期间改过的条目"\)/, "重连后的判定必须同时要求两处变更");
});
