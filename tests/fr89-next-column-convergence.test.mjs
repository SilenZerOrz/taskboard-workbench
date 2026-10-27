/**
 * FR-89 处置分层 · **「下一列」与「下一步」的入口收敛**（卡 `taskboard-workbench-158`）。
 *
 * 触发（真机报障）：「评审通过后处置入口收敛 —— 「下一步」的「完成（仅人工可确认）」
 * 与操作区「下一列」**语义重复**」。
 *
 * 成因（读码 + 实测确认）：看板列序是
 *   `待办池 → 可开工 → 进行中 → 待验收 → 完成 → 受阻 → 已取消`
 * 而「下一列」此前是**纯列序位移**（`statuses[index + 1]`），不看任何门 ⇒ 「待验收」卡的
 * 「下一列」**恒等于「完成」**。于是同一张评审已通过的卡有两个入口做同一件事：
 *   · 「下一步」区的「完成（仅人工可确认）」→ `moveTask(t, "done")`
 *   · 操作区的「下一列」        → `moveTask(t, state.statuses[index + 1])` ≡ `"done"`
 * 两处措辞不同、效果完全一样 ⇒ 人不知道该点哪个，也让「一处处置」（FR-89）失效。
 *
 * 口径（本轮收敛）：**「待验收」的处置只有一处** ——「下一步」区（评审通过 / 请求返工 / 完成）。
 * 操作区与卡片「→」的「下一列」对该状态**不再给平行位移入口**，改为指回「下一步」区。
 * 其余状态行为**一字未动**（不改变既有能力）。
 *
 * 注意（范围边界）：本卡**只收敛入口**，**不动服务端**。
 * 「`in_review → done` 缺一道评审门」是**另一个**问题（`PATCH` 对评审态无校验），
 * 但它属**口径选择**（FR-83 只约束「评审通过**不自动**置完成」，未要求「完成必须先评审通过」；
 * 且 `tools/bench-auto-advance.mjs` 把「人工直接把待验收卡判 done」当作**合法人工动作**）⇒
 * 按本仓纪律**只登记不擅改**，登记为 `taskboard-workbench-162`。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STATUSES } from "../src/core/domain.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** 把前端那段纯函数原样取出在测试里实跑（前端是零依赖浏览器脚本，无法 import）。 */
function loadNextColumnTarget() {
  const source = read("web/app.js");
  const at = source.indexOf("const nextColumnTarget = (task, statuses)");
  assert.ok(at > 0, "必须能定位 nextColumnTarget（前端共用的「下一列」判定）");
  const end = source.indexOf("\n  };", at);
  assert.ok(end > at, "必须能截出函数体");
  const body = source.slice(at, end + "\n  };".length);
  return new Function(`${body}; return nextColumnTarget;`)();
}

// ---------------------------------------------------------------- 口径：前置事实

test("前置：「待验收」在列序里的下一列**恒等于「完成」**（这正是重复的根源）", () => {
  const index = STATUSES.indexOf("in_review");
  assert.ok(index >= 0, "「待验收」必须是一个列");
  assert.equal(STATUSES[index + 1], "done", "列序：待验收 → 完成（故「下一列」≡「完成」）");
});

// ---------------------------------------------------------------- ① 判定口径

test("FR-89①：「待验收」卡不给平行位移入口，改为指回「下一步」区", () => {
  const nextColumnTarget = loadNextColumnTarget();

  // 评审**已通过**（正是报障场景）⇒ 收敛到「下一步」区，避免与「完成（仅人工可确认）」重复
  const approved = nextColumnTarget({ status: "in_review", reviewState: "approved" }, STATUSES);
  assert.equal(approved.blocked, true, "评审已通过也不给平行位移入口（否则与「下一步」的「完成」重复）");
  assert.equal(approved.viaNextStep, true, "应指回「下一步」区（一处处置）");
  assert.equal(approved.status, undefined, "不得给出目标列");

  // 评审**待处理**（有改变）⇒ 同上（处置仍是那一处：评审通过 / 请求返工）
  const pending = nextColumnTarget({ status: "in_review", reviewState: "pending" }, STATUSES);
  assert.equal(pending.blocked, true);
  assert.equal(pending.viaNextStep, true);
  assert.equal(pending.status, undefined);

  // 两条路径给的理由一致（不因评审态漂移出两套说法）
  assert.equal(approved.reason, pending.reason, "「待验收」的收敛理由不随评审态变化");
  assert.match(pending.reason, /下一步/, "理由必须指向「下一步」区");
});

test("FR-89①：其余状态**一字未动**（不改变既有能力）", () => {
  const nextColumnTarget = loadNextColumnTarget();

  // 前四列的线性位移照旧
  assert.equal(nextColumnTarget({ status: "backlog" }, STATUSES).status, "todo");
  assert.equal(nextColumnTarget({ status: "todo" }, STATUSES).status, "in_progress");
  assert.equal(nextColumnTarget({ status: "in_progress" }, STATUSES).status, "in_review");
  // 末列无下一列
  assert.equal(nextColumnTarget({ status: "canceled" }, STATUSES).blocked, true);
  assert.equal(nextColumnTarget({ status: "canceled" }, STATUSES).viaNextStep, undefined, "末列不是「待验收」那回事");
  // 未知 / 空输入 ⇒ 如实说判不准（不臆断、不抛）
  assert.equal(nextColumnTarget({ status: "nope" }, STATUSES).blocked, true);
  assert.equal(nextColumnTarget(null, STATUSES).blocked, true);
  assert.equal(nextColumnTarget({ status: "todo" }, null).blocked, true, "状态表缺失时不得臆断");
});

// ---------------------------------------------------------------- ② 接线：两处入口共用一份判定

test("FR-89②：卡片「→」与抽屉「下一列」**共用同一份**判定（不各写一套）", () => {
  const source = read("web/app.js");

  // 判定函数存在，且明确点名「待验收」
  assert.match(source, /const nextColumnTarget = \(task, statuses\)/, "必须有共用的「下一列」判定");
  assert.match(source, /if \(task\.status === "in_review"\)/, "「待验收」必须被单列判据点名");

  // 卡片「→」走这份判定
  const cardAt = source.indexOf('step(1, "→", "移到下一列")');
  assert.ok(cardAt > 0, "必须能定位卡片的「→」按钮");
  const cardZone = source.slice(Math.max(0, cardAt - 1600), cardAt);
  assert.match(cardZone, /nextColumnTarget\(task, state\.statuses\)/, "卡片「→」必须走 nextColumnTarget");

  // 抽屉「下一列」走同一份判定
  assert.ok(
    source.indexOf("const drawerNext = nextColumnTarget(t, state.statuses)") > 0,
    "抽屉「下一列」必须走 nextColumnTarget",
  );

  // 「待验收」时给的是**指回「下一步」区**的可点按钮（不是静默禁用，也不是平行位移）
  assert.match(source, /下一列 → 处置见「下一步」/, "待验收卡要给出指回「下一步」区的按钮");
  assert.match(source, /drawerBody\.querySelector\("\.drawer-section\.next-step"\)/, "指回动作要定位「下一步」区");

  // 旧写法（盲位移 ⇒ 恒等于「完成」）必须已消失
  assert.equal(
    /moveTask\(t, state\.statuses\[Math\.min\(state\.statuses\.length - 1, state\.statuses\.indexOf\(t\.status\) \+ 1\)\]\)/.test(source),
    false,
    "抽屉「下一列」不得再是无条件位移（它恒等于「完成」，与「下一步」的「完成」重复）",
  );
});

test("FR-89②：「下一步」区自身的「完成」入口保持不变（收敛后它是唯一入口）", () => {
  const source = read("web/app.js");
  const nextStep = read("src/core/next-step.mjs");

  // 服务端引导仍按评审态分流：approved ⇒ 唯一动作是「完成」（仅人工可确认）
  assert.match(nextStep, /action\("complete", "完成（仅人工可确认）", "primary"\)/, "下一步区保留「完成」入口");
  assert.match(nextStep, /code: "awaiting-human-done"/, "评审通过后的引导码不变");

  // 前端「完成」处理器仍在且仍走 moveTask + 关抽屉（FR-89：写入成功要有可见反馈并关抽屉）
  const at = source.indexOf('"complete": async () => {');
  assert.ok(at > 0, "前端必须接「完成」动作");
  const zone = source.slice(at, at + 700);
  assert.match(zone, /moveTask\(t, "done"\)/, "「完成」仍走 moveTask(done)");
  assert.match(zone, /closeDrawer\(\)/, "「完成」写入成功后仍关抽屉");
});
