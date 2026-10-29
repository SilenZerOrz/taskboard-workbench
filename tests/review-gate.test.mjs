/**
 * FR-83 补口（2026-10-27 · 卡 `-162`）：**评审门的服务端落地** —— 口径 **C：门 + 显式逃生口**。
 *
 * 裁定前的缺口（-158 执行时发现、当时按纪律只登记不擅改）：
 * `PATCH /api/tasks/:ref` → `store.updateTask` 对 `in_review → done` **没有任何评审态校验**，
 * 于是「拖拽落到完成列」就能把评审还没做的卡静默收口 —— 「评审是一等流程」（FR-83）在入口层可被完全跳过。
 *
 * 人拍板的口径（本文件逐条钉住）：
 *   ① 默认**拒**：`review_state !== 'approved'` 一律 `REVIEW_NOT_APPROVED`（退出码 5 冲突类），且**零副作用**；
 *   ② 逃生口**显式**：`skipReview === true`（严格布尔）才放行，且必须落 `review_skipped` 事件 + 审计；
 *   ③ **只约束「从待验收收口」**：从未请求评审的卡、以及 `in_review → 其它列`（取消/受阻/退回）不受影响；
 *   ④ 前端把「未评审就收口」变成**明示的一次确认**（`needsReviewSkip` 是唯一判据，两条入口共用）。
 *
 * 为什么不是「硬门」（评审通过前人也不能完成）：FR-83 的验收原文只约束「评审通过**不自动**置完成」
 * （红线是不得自动化），「完成只能人确认」是产品红线 —— 剥夺人跳过评审的权利会与后者冲突，
 * 但让人**误拖一下**就静默跳过评审，等于把评审不是一等流程。显式逃生口是这两条的交点。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter, httpStatusFor } from "../src/server/api.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  return store;
}

/** 造一张「已进待验收」的卡（来源列 in_progress，评审态 pending）。 */
function inReview(store, title = "待验收卡") {
  const t = store.createTask({ projectId: "p1", title, status: "in_progress" });
  store.requestReview(t.identifier, { reviewer: "reviewer-1" });
  return store.getTaskById(t.id);
}

const codeOf = (fn) => {
  try { fn(); return null; } catch (error) { return error.code; }
};

test("① 评审门：待验收卡未评审通过就想收口 ⇒ REVIEW_NOT_APPROVED（退出码 5）且零副作用", () => {
  const store = setup();
  const t = inReview(store);
  assert.equal(t.status, "in_review");
  assert.equal(t.reviewState, "pending");

  const before = store.getTaskById(t.id);
  const eventsBefore = store.listTaskEvents(t.id).length;
  let error = null;
  try {
    store.updateTask(t.identifier, { status: "done", expectedVersion: before.version, actor: "human" });
  } catch (e) { error = e; }

  assert.ok(error, "必须被拒，不得静默收口");
  assert.equal(error.code, "REVIEW_NOT_APPROVED");
  assert.equal(error.exitCode, 5, "冲突类（EXIT.CONFLICT）—— 与 HUMAN_REVIEW_CANNOT_DONE 的语义区分开");
  assert.match(error.message, /评审通过/);
  assert.match(error.message, /skipReview=true/, "拒绝文案必须写出唯一逃生口，否则人只看到「不许」");

  const after = store.getTaskById(t.id);
  assert.equal(after.status, "in_review", "状态不得变");
  assert.equal(after.reviewState, "pending", "评审态不得被顺手改成 approved");
  assert.equal(after.version, before.version, "版本不得涨（门在 begin 之前 ⇒ 连事务都不开）");
  assert.equal(store.listTaskEvents(t.id).length, eventsBefore, "不得留 status_changed 事件");
  const audit = store.listGovernanceAudit({ action: "set-status" });
  assert.ok(audit.some((a) => a.target === t.identifier && a.allowed === false && a.reason === "review-not-approved"), "被拒必须留审计（否则事后无法回看这次绕过尝试）");
  store.close();
});

test("② 逃生口：只有 skipReview === true 才放行，且必须留 review_skipped 事件 + 审计", () => {
  const store = setup();
  const t = inReview(store);

  // 严格布尔：字符串/数字都不算「人的显式决定」（fail-closed）
  for (const bogus of ["true", 1, {}, []]) {
    assert.equal(
      codeOf(() => store.updateTask(t.identifier, { status: "done", expectedVersion: store.getTaskById(t.id).version, skipReview: bogus })),
      "REVIEW_NOT_APPROVED",
      `skipReview=${JSON.stringify(bogus)} 不是严格 true ⇒ 必须拒（不猜 intent）`,
    );
  }

  const done = store.updateTask(t.identifier, { status: "done", expectedVersion: store.getTaskById(t.id).version, skipReview: true });
  assert.equal(done.status, "done");
  const types = store.listTaskEvents(t.id).map((e) => e.type);
  assert.ok(types.includes("review_skipped"), "跳过评审必须可回看（事件流）");
  const skipped = store.listTaskEvents(t.id).find((e) => e.type === "review_skipped");
  assert.equal(skipped.from, "in_review");
  assert.equal(skipped.to, "done");
  assert.match(String(skipped.detail), /review_state=pending/, "留痕要写明当时是什么评审态");
  const audit = store.listGovernanceAudit({ action: "set-status" });
  assert.ok(audit.some((a) => a.target === t.identifier && a.allowed === true && a.reason === "review-skipped"), "放行也要落审计（成败两头都可查）");
  store.close();
});

test("③ 评审通过后收口：放行，且**不**记 review_skipped（两种收口方式事后分得清）", () => {
  const store = setup();
  const t = inReview(store);
  store.approveReview(t.identifier, { comment: "通过" });
  const approved = store.getTaskById(t.id);
  assert.equal(approved.status, "in_review", "评审通过 ≠ 完成（红线）");
  assert.equal(approved.reviewState, "approved");

  const done = store.updateTask(t.identifier, { status: "done", expectedVersion: approved.version });
  assert.equal(done.status, "done");
  const types = store.listTaskEvents(t.id).map((e) => e.type);
  assert.ok(types.includes("review_approved"));
  assert.ok(!types.includes("review_skipped"), "正常评审通过的收口不得被标成「跳过评审」");
  store.close();
});

test("④ 门只约束「从待验收收口」：从未评审的卡 / 非收口的目标列都不受影响", () => {
  const store = setup();

  // 从未请求评审的卡（todo → done）：产品一贯允许，门不得误伤
  const plain = store.createTask({ projectId: "p1", title: "从未评审", status: "todo" });
  assert.equal(store.updateTask(plain.identifier, { status: "done", expectedVersion: plain.version }).status, "done");

  // 待验收 → 取消 / 受阻 / 退回：不是收口，一律放行
  for (const target of ["canceled", "blocked", "todo"]) {
    const t = inReview(store, `待验收→${target}`);
    const r = store.updateTask(t.identifier, { status: target, expectedVersion: t.version, skipReview: false });
    assert.equal(r.status, target, `in_review → ${target} 不是收口，不得被评审门拦住`);
  }

  // 纯列内排序（status 不变）：与评审态无关，不得被拦
  const sortable = store.createTask({ projectId: "p1", title: "排序", status: "done", boardPosition: 0 });
  const r = store.updateTask(sortable.identifier, { expectedVersion: sortable.version, boardPosition: 0 });
  assert.equal(r.boardPosition, 0);
  store.close();
});

test("⑤ API 层：PATCH 透传 skipReview —— 默认 409 零副作用，带 true 才 200", async () => {
  const store = setup();
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  const t = inReview(store);
  const url = `/api/tasks/${t.identifier}`;
  // 路由层抛 TbError（HTTP 状态由 `httpStatusFor` 映射，server.mjs 用它写回包）⇒ 这里两件事都要断言
  const attempt = async (body) => {
    try { return { ok: true, result: await route("PATCH", url, body) }; } catch (error) { return { ok: false, error }; }
  };

  const blocked = await attempt({ status: "done", version: t.version });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "REVIEW_NOT_APPROVED");
  assert.equal(httpStatusFor(blocked.error), 409, "冲突类错误必须映射 409（不是 400）");
  const untouched = store.getTaskById(t.id);
  assert.equal(untouched.status, "in_review");
  assert.equal(untouched.version, t.version, "被拒的 PATCH 不得涨版本（门序：门判定先于副作用）");

  // 字符串 "true" 走 HTTP 也必须被拒（不能靠 JSON 宽松取值）
  const sneaky = await attempt({ status: "done", version: t.version, skipReview: "true" });
  assert.equal(sneaky.ok, false, "字符串不是显式同意");

  const ok = await attempt({ status: "done", version: t.version, skipReview: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.result.status, 200);
  assert.equal(ok.result.payload?.task?.status, "done");
  assert.ok(store.listTaskEvents(t.identifier).some((e) => e.type === "review_skipped"), "HTTP 路径的跳过也必须留痕");
  store.close();
});

test("⑥ 前端：needsReviewSkip 是唯一判据，拖拽与「下一步」的「完成」都必须先问一次人", () => {
  const source = readFileSync(join(ROOT, "web/app.js"), "utf8");
  // 谓词必须落在常量区（`const HR_LABEL =` → `function createBoard(`），才能被独立驱动
  const region = source.slice(source.indexOf("const HR_LABEL ="), source.indexOf("function createBoard("));
  assert.ok(region.includes("const needsReviewSkip"), "判据必须在常量区，三处入口才能共用同一份");
  const { needsReviewSkip } = new Function(`${region}; return { needsReviewSkip };`)();

  assert.equal(needsReviewSkip({ status: "in_review", reviewState: "pending" }, "done"), true, "待验收 + 评审未做 ⇒ 需显式确认");
  assert.equal(needsReviewSkip({ status: "in_review", reviewState: "changes_requested" }, "done"), true, "返工中 ⇒ 需显式确认");
  assert.equal(needsReviewSkip({ status: "in_review", reviewState: "approved" }, "done"), false, "评审已通过 ⇒ 正常收口");
  assert.equal(needsReviewSkip({ status: "todo", reviewState: null }, "done"), false, "从未评审的卡不受门影响");
  assert.equal(needsReviewSkip({ status: "in_review", reviewState: "pending" }, "canceled"), false, "只有收口才问");

  // 三处必须都走它，且确认后才带 skipReview（否则又是一条静默旁路）
  assert.match(source, /async function dropTask\([\s\S]{0,900}?needsReviewSkip\(task, status\)/, "拖拽落「完成」必须先判评审态");
  assert.match(source, /async function moveTask\([\s\S]{0,600}?needsReviewSkip\(task, status\)/, "moveTask 必须先判评审态（所有位移入口的汇合点）");
  assert.match(source, /"complete": async \(\) => \{[\s\S]{0,600}?needsReviewSkip\(t, "done"\)/, "「下一步」区的「完成」必须按评审态换口径");
  assert.equal((source.match(/confirmReviewSkip\(/g) ?? []).length >= 2, true, "确认框必须真的被调用（不只是定义了）");
  assert.match(source, /skipReview: true/, "确认后才带 skipReview=true");
  // -158 的入口收敛不得回退：待验收卡的「下一列」仍然不给位移
  assert.match(source, /if \(task\.status === "in_review"\) \{\s*\n\s*return \{ blocked: true, reason: "待验收卡的处置在「下一步」区/, "待验收卡不得再有平行位移入口（-158 不回退）");
});
