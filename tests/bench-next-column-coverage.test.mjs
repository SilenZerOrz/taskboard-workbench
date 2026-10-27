/**
 * 守卫（2026-10-27 · 卡 `-158`）：`tools/bench-next-column.mjs` 必须**持续**验证入口收敛的三面，
 * 且必须保留**反向对照**。
 *
 * 为什么需要这条：本轮的改动**全在呈现层**，而呈现层的证据只有那台真浏览器验证台。
 * 如果后来者为了「让台子变绿」把反向对照删掉，台子会永久全绿却什么都没证明。
 * 本守卫钉住四件事：
 *   ① 台内必须造**两种**待验收卡（评审已通过 / 评审待处理）—— 报障场景是「已通过」，
 *      但「待处理」同样收敛，两条都得在场；
 *   ② 必须断言「操作区**没有**裸『下一列』」与「有**指回下一步**按钮」两件相反的事
 *      （只证其一都能被「两个按钮都留着」这种半吊子实现蒙过去）；
 *   ③ 必须有**非待验收列**的反向对照（证明收敛不是把能力整体删掉）；
 *   ④ 必须有卡片「→」的正反两面对照（禁用 + 仍可用）。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "tools/bench-next-column.mjs"), "utf8");

test("守卫：`-158` 台必须造「已通过 / 待处理」两种待验收卡", () => {
  assert.match(src, /store\.requestReview\(/, "必须走真实评审流程进入「待验收」");
  assert.match(src, /store\.approveReview\(approved\.identifier/, "必须有一张**评审已通过**的卡（报障场景）");
  assert.match(src, /评审待处理的卡/, "必须有一张**评审待处理**的卡（另一分支）");
});

test("守卫：`-158` 台必须同时断言「没有裸下一列」与「有指回下一步」（缺一则可被半吊子实现蒙过）", () => {
  assert.match(src, /没有\*\*裸「下一列」位移按钮/, "必须断言裸「下一列」已消失");
  assert.match(src, /指回「下一步」区\*\*的按钮/, "必须断言指回按钮存在");
  assert.match(src, /处置见「下一步」/, "指回按钮的文案必须与前端一致");
});

test("守卫：`-158` 台必须保留反向对照（非待验收列仍有普通「下一列」）", () => {
  assert.match(src, /进行中的卡/, "必须有非待验收列的对照卡");
  assert.match(src, /仍有\*\*普通「下一列」按钮/, "必须断言对照卡仍有普通「下一列」（证明不是把能力删掉）");
});

test("守卫：`-158` 台必须保留卡片「→」的正反两面对照", () => {
  assert.match(src, /待验收卡的卡片「→」被禁用/, "必须断言待验收卡「→」被禁用");
  assert.match(src, /反向对照：进行中卡的卡片「→」仍可用/, "必须断言对照卡「→」仍可用");
});

test("守卫：`-158` 台必须提供 TB_BENCH_WEB_DIR 反证入口（能红才有意义）", () => {
  assert.match(src, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 `web/` 目录做反证");
  assert.match(src, /const failed = results\.filter\(\(r\) => !r\.ok\)/, "必须有汇总判定");
  assert.match(src, /process\.exit\(1\)/, "失败必须体现在退出码上");
});
