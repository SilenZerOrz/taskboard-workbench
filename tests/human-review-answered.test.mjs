/**
 * FR-85 升级门「已结论」水位线（2026-10-19 真机 `taskboard-workbench-90` 场景）。
 *
 * 现象：申报评论（`【人工校验申报】…`）**常驻评论历史** ⇒ 人已给出结论（同类卡 `-91` → `canceled`）之后，
 *       `-90` 仍挂着 high 级「需人工校验」，而且它给的主按钮**还会再造一张同类卡** —— 这扇门永远关不上。
 * 口径：**申报驱动**且申报不晚于结论 ⇒ 视为人已回答；结论之后出现**更新的**申报则门重新成立；
 *       由**运行痕迹**驱动的类别（`real-bug-blocked`）**不适用**水位线（又坏了一次就该重新升级）。
 * 附带：诊断 detail 的「可核验证据」此前把结构化证据渲染成 `· [object Object]`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { DIAGNOSTIC_RULES, evaluateTaskDiagnostics, humanReviewProbe, humanReviewAnsweredBy } from "../src/core/diagnostics.mjs";
import { planHumanReview, HUMAN_REVIEW_LABEL } from "../src/core/human-review.mjs";

const RULE = DIAGNOSTIC_RULES.find((r) => r.kind === "human_review_required");
const DECL = "【人工校验申报】类别=与上游需求不符；证据=R1 的验收口径在当前宿主上无法满足。";

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) =>
    router.route({ method, pathname, searchParams: new URLSearchParams(""), body });
  return { store, route };
}

/** 申报 → 落卡 → 结论（结论时间可控：正/负偏移表示结论晚于/早于那条申报评论）。 */
function declaredAndConcluded({ concludeOffsetMs = 0 } = {}) {
  const { store, route } = setup();
  const t = store.createTask({ projectId: "p1", title: "与上游不符的任务", status: "todo" });
  store.addComment(t.identifier, { body: DECL });
  const probe = humanReviewProbe(store, store.requireTaskRef(t.identifier));
  const card = store.createHumanReviewTask({
    projectId: "p1", draft: planHumanReview(probe.input).draft, relatedTask: t.identifier,
  });
  store.concludeHumanReview(card.identifier, { conclusion: "continue", now: Date.now() + concludeOffsetMs });
  return { store, route, task: store.requireTaskRef(t.identifier), card: store.requireTaskRef(card.identifier) };
}

const gateOf = (store, ref) =>
  evaluateTaskDiagnostics(store, ref).diagnostics.find((d) => d.kind === "human_review_required");

test("真机 -90 场景：申报驱动的人工校验已结论后，不得再产出「需人工校验」", () => {
  const { store, task, card } = declaredAndConcluded({ concludeOffsetMs: 3600_000 });
  assert.equal(card.humanReviewState, "concluded");
  assert.equal(card.humanReviewConclusion, "continue");
  assert.equal(gateOf(store, task.identifier), undefined, "人已就这条申报回答过 → 门必须关掉（修复前恒产出）");
  store.close();
});

test("不是「一律封口」：结论早于申报（结论之后又出现更新的证据）→ 门重新成立", () => {
  const { store, task } = declaredAndConcluded({ concludeOffsetMs: -3600_000 });
  const gate = gateOf(store, task.identifier);
  assert.ok(gate, "更新的申报必须把门重新打开（否则会掩盖真的新证据）");
  assert.equal(gate.severity, "high");
  store.close();
});

test("规则层：answeredSameCategory 抑制；运行痕迹类别不适用水位线", () => {
  const ctx = (humanReview = {}) => ({
    task: { identifier: "p1-9", projectId: "p1" },
    humanReview: {
      classification: { confident: true, category: "upstream-mismatch", confidenceReason: "人工校验显式申报" },
      evidence: ["【人工校验申报】类别=与上游需求不符"], pending: [], pendingSameCategory: null, answeredSameCategory: null,
      ...humanReview,
    },
    isHumanReviewTask: false, dismissed: new Set(),
  });
  assert.ok(RULE.evaluate(ctx()), "没有已结论记录时照常产出");
  assert.equal(RULE.evaluate(ctx({ answeredSameCategory: { identifier: "p1-8" } })), null, "同类已结论 → 不产出");
  // 水位线只认「申报」这一路证据
  const concludedBug = [{ humanReviewCategory: "real-bug-blocked", humanReviewConcludedAt: "2026-10-19T02:00:00.000Z" }];
  assert.equal(
    humanReviewAnsweredBy({ category: "real-bug-blocked" }, [{ kind: "failure", at: "2026-10-18T00:00:00.000Z" }], concludedBug),
    null, "运行痕迹类别不适用水位线（又坏了一次就该重新升级）",
  );
  const concludedDecl = [{ humanReviewCategory: "upstream-mismatch", humanReviewConcludedAt: "2026-10-19T02:00:00.000Z" }];
  assert.ok(
    humanReviewAnsweredBy({ category: "upstream-mismatch" }, [{ kind: "upstream-mismatch", at: "2026-10-18T00:00:00.000Z" }], concludedDecl),
    "申报不晚于结论 → 已回答",
  );
  assert.equal(
    humanReviewAnsweredBy({ category: "upstream-mismatch" }, [{ kind: "upstream-mismatch", at: "2026-10-19T03:00:00.000Z" }], concludedDecl),
    null, "申报晚于结论 → 门重新成立",
  );
  assert.equal(
    humanReviewAnsweredBy({ category: "upstream-mismatch" }, [], concludedDecl),
    null, "没有申报证据时不适用水位线",
  );
});

test("诊断 detail 的证据渲染：不得再出现 [object Object]", () => {
  const { store } = setup();
  const t = store.createTask({ projectId: "p1", title: "申报任务", status: "todo" });
  store.addComment(t.identifier, { body: DECL });
  const gate = gateOf(store, t.identifier);
  assert.ok(gate, "申报必须能升级");
  assert.ok(!gate.detail.includes("[object Object]"), `证据渲染不得是乱码，实际：${gate.detail}`);
  assert.ok(gate.detail.includes("与上游需求不符"), "必须把申报的关键信息渲染出来");
  store.close();
});

test("派发端点：同类已结论（申报不晚于结论）→ 拒绝，且不新建同类卡", async () => {
  const { store, route, task } = declaredAndConcluded({ concludeOffsetMs: 3600_000 });
  const before = store.listTasks({ projectId: "p1" }).length;
  await assert.rejects(
    () => route("POST", `/api/tasks/${task.identifier}/human-review`, { actor: "human" }),
    (e) => e.code === "HUMAN_REVIEW_ALREADY_EXISTS",
  );
  assert.equal(store.listTasks({ projectId: "p1" }).length, before, "被拒时不得留下新卡");
  assert.equal(store.humanReviewPending("p1").length, 0);
  store.close();
});

test("派发端点：结论早于申报（更新的证据）→ 仍然允许重新派发", async () => {
  const { store, route, task } = declaredAndConcluded({ concludeOffsetMs: -3600_000 });
  const r = await route("POST", `/api/tasks/${task.identifier}/human-review`, { actor: "human" });
  assert.equal(r.status, 201, "更新的申报必须能重新升级为人工校验任务");
  assert.ok(r.payload.task.labels.includes(HUMAN_REVIEW_LABEL));
  store.close();
});
