/**
 * FR-85a：human_review 判定与草案构造（纯函数模块）单测。
 * 覆盖：类别表与中文标签一致性 / 四类各自命中 / 证据不足降级 / 优先级 / 草案四段齐全 /
 *       validate 四类缺失各 1 例 / 判定不置信不得造草案 / 红线字段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CANDIDATE_ACTIONS,
  EXECUTION_RED_LINE,
  HUMAN_REVIEW_CATEGORIES,
  HUMAN_REVIEW_CATEGORY_LABELS,
  buildHumanReviewDraft,
  candidateActionsFor,
  categoryLabel,
  classifyHumanReview,
  planHumanReview,
  validateHumanReviewDraft,
} from "../src/core/human-review.mjs";

/* ---------------------------------------------------------------- 1. 类别表与中文标签一致性 */

test("类别表与中文标签：四类齐全、顺序固定、键集完全一致、无空标签", () => {
  assert.deepEqual(HUMAN_REVIEW_CATEGORIES, [
    "real-bug-blocked",
    "requirement-drift",
    "architecture-change",
    "upstream-mismatch",
  ]);
  assert.equal(Object.isFrozen(HUMAN_REVIEW_CATEGORIES), true);
  assert.deepEqual(Object.keys(HUMAN_REVIEW_CATEGORY_LABELS), [...HUMAN_REVIEW_CATEGORIES], "键集与类别表逐项一致（含顺序）");
  for (const c of HUMAN_REVIEW_CATEGORIES) {
    assert.equal(typeof HUMAN_REVIEW_CATEGORY_LABELS[c], "string");
    assert.ok(HUMAN_REVIEW_CATEGORY_LABELS[c].length > 0, `${c} 必须有中文标签`);
    assert.equal(categoryLabel(c), HUMAN_REVIEW_CATEGORY_LABELS[c]);
    assert.ok(CANDIDATE_ACTIONS[c].length >= 1, `${c} 必须有候选处置`);
    assert.ok(candidateActionsFor(c).every((a) => a.needsHuman === true && a.category === c), "候选处置全部需人决策并回填类别");
  }
  assert.equal(categoryLabel(null), null);
  assert.equal(categoryLabel("unknown-x"), "unknown-x", "未知类别回落为原值，不抛错");
  assert.equal(candidateActionsFor("unknown-x").length, 0);
});

/* ---------------------------------------------------------------- 2. ① 真实 bug 阻塞 */

test("真实 bug 阻塞命中：同一 bug 复发 ≥2 次 + 有失败证据（退出码/栈）", () => {
  const r = classifyHumanReview({
    task: { identifier: "tb-1", title: "修复解析崩溃" },
    diagnosis: [{ kind: "block_loop", title: "阻断循环：同因阻断 3 次", count: 3 }],
    blockKind: "capability",
    blockRecurrences: 3,
    evidence: [
      { kind: "failure", summary: "npm test 失败", exitCode: 1 },
      { kind: "failure", summary: "处理空输入时空指针", stack: "TypeError: Cannot read properties of null\n  at parse (x.mjs:12:3)" },
    ],
  });
  assert.equal(r.confident, true);
  assert.equal(r.category, "real-bug-blocked");
  assert.equal(r.categoryLabel, "真实 bug 阻塞");
  assert.ok(r.evidence.length >= 2);
  assert.ok(r.candidateActions.length >= 1);
  assert.match(r.confidenceReason, /重复复发/);
  assert.match(r.confidenceReason, /失败证据/);
  assert.equal(r.missing.length, 0);
});

test("真实 bug 阻塞不命中：只复发一次或只有失败而无复发 → 不臆断", () => {
  const onlyFailure = classifyHumanReview({
    blockKind: "transient",
    evidence: [{ kind: "failure", summary: "单次失败", exitCode: 2 }],
  });
  assert.equal(onlyFailure.category, null);
  assert.equal(onlyFailure.confident, false);

  const onlyRecurrence = classifyHumanReview({
    blockRecurrences: 4,
    signals: ["同一个 bug 又出现了（复发）"],
  });
  assert.equal(onlyRecurrence.category, null, "只有复发没有失败证据 → 降级");
  assert.equal(onlyRecurrence.confident, false);
});

test("诊断 kind 兼容 FR-79 下划线写法：repeated_crash / requirement_drift 等照样命中", () => {
  const crash = classifyHumanReview({
    diagnosis: [{ kind: "repeated_crash", title: "重复崩溃", count: 2 }],
    evidence: [{ kind: "failure", summary: "进程被 SIGKILL，退出码 137", exitCode: 137 }],
  });
  assert.equal(crash.category, "real-bug-blocked");

  const drift = classifyHumanReview({
    diagnosis: { kind: "requirement_drift", title: "任务口径与需求条目矛盾" },
  });
  assert.equal(drift.category, "requirement-drift");

  const arch = classifyHumanReview({ diagnosis: [{ kind: "architecture_change", title: "需改基线架构" }] });
  assert.equal(arch.category, "architecture-change");
});

/* ---------------------------------------------------------------- 3. ② 需求异化 */

test("需求异化命中：任务描述与需求条目/上游条款相互矛盾", () => {
  const r = classifyHumanReview({
    task: { identifier: "tb-2", title: "把看板改成只读" },
    requirementItem: { identifier: "R100", status: "active" },
    evidence: [
      { kind: "contradiction", summary: "任务要求只读，但需求条目 R100 要求可编辑，二者矛盾", contradicts: ["R100"] },
    ],
  });
  assert.equal(r.confident, true);
  assert.equal(r.category, "requirement-drift");
  assert.match(r.confidenceReason, /矛盾/);
  assert.match(r.confidenceReason, /R100/);
});

test("需求异化：只有情绪化抱怨、没有显式矛盾证据 → 降级为证据不足", () => {
  const r = classifyHumanReview({ signals: ["感觉这个任务写得不太对"] });
  assert.equal(r.confident, false);
  assert.equal(r.category, null);
});

/* ---------------------------------------------------------------- 4. ③ 架构变化 */

test("架构变化命中：实现需要改动基线架构或跨模块契约", () => {
  const r = classifyHumanReview({
    task: { identifier: "tb-3", title: "让 store 直连执行器" },
    evidence: [{ kind: "architecture", summary: "需要改动基线架构：store.mjs 与 executor.mjs 直接耦合" }],
  });
  assert.equal(r.confident, true);
  assert.equal(r.category, "architecture-change");
  assert.equal(r.categoryLabel, "技术架构变化");

  const byContracts = classifyHumanReview({ crossModuleContracts: ["src/core/store.mjs", "src/server/api.mjs"] });
  assert.equal(byContracts.category, "architecture-change");
  assert.ok(byContracts.evidence.some((e) => /store\.mjs/.test(e.summary)), "跨模块契约明细要进证据");
});

/* ---------------------------------------------------------------- 5. ④ 与上游需求不符 */

test("与上游需求不符命中：验收口径无法满足", () => {
  const r = classifyHumanReview({
    task: { identifier: "tb-4" },
    evidence: [{ kind: "acceptance-unsatisfiable", summary: "验收口径要求 P95 < 10ms，但当前验收口径无法满足" }],
  });
  assert.equal(r.confident, true);
  assert.equal(r.category, "upstream-mismatch");
});

test("与上游需求不符命中：需求条目状态为 superseded（已被取代）", () => {
  const r = classifyHumanReview({
    task: { identifier: "tb-5" },
    requirementItem: { identifier: "R99", status: "superseded" },
    upstreamClauses: [{ ref: "FR-70", status: "deprecated" }],
  });
  assert.equal(r.confident, true);
  assert.equal(r.category, "upstream-mismatch");
  assert.equal(r.evidence.length, 2);
  assert.match(r.confidenceReason, /已被取代/);
});

/* ---------------------------------------------------------------- 6. 证据不足降级 + 优先级 */

test("证据不足降级：无任何输入 → category=null、confident=false、原因可读、不产出候选处置", () => {
  const r = classifyHumanReview({});
  assert.equal(r.category, null);
  assert.equal(r.categoryLabel, null);
  assert.equal(r.confident, false);
  assert.equal(r.candidateActions.length, 0);
  assert.ok(r.confidenceReason.length > 0);
  assert.match(r.confidenceReason, /证据不足/);
  assert.ok(r.missing.length >= 4, "四类各自「缺什么」都要列出来");
});

test("优先级：多类同时命中时按 HUMAN_REVIEW_CATEGORIES 顺序取首命中并在原因里注明", () => {
  const r = classifyHumanReview({
    blockRecurrences: 3,
    evidence: [
      { kind: "failure", summary: "同一个 bug 复发三次，退出码 1", exitCode: 1 },
      { kind: "architecture", summary: "需要改动跨模块契约" },
      { kind: "contradiction", summary: "与需求条款相互矛盾" },
    ],
  });
  assert.equal(r.category, "real-bug-blocked");
  assert.match(r.confidenceReason, /未取用，按优先级取首命中/);
  assert.match(r.confidenceReason, /技术架构变化/);
});

/* ---------------------------------------------------------------- 7. 草案四段齐全 */

test("草案四段齐全：判定类别 / 证据 / 候选处置 / 阻塞边界 + 标题 + 执行侧红线", () => {
  const task = { identifier: "tb-6", title: "修复导入崩溃" };
  const draft = buildHumanReviewDraft({
    task,
    blockRecurrences: 3,
    downstream: ["tb-7", "tb-8"],
    evidence: [
      { kind: "failure", summary: "导入 csv 时崩溃", exitCode: 1 },
      { kind: "recurrence", summary: "同一 bug 复发 3 次" },
    ],
  });
  assert.match(draft.title, /【人工校验】/);
  assert.match(draft.title, /真实 bug 阻塞/);
  assert.match(draft.title, /tb-6/);
  assert.equal(draft.category, "real-bug-blocked");
  assert.equal(draft.forbiddenForExecution, true);
  assert.ok(Array.isArray(draft.evidence) && draft.evidence.length >= 2);
  assert.ok(Array.isArray(draft.candidateActions) && draft.candidateActions.length >= 1);
  assert.equal(draft.blockBoundary.scope, "self-and-downstream");
  assert.deepEqual(draft.blockBoundary.downstream, ["tb-7", "tb-8"]);
  assert.equal(draft.blockBoundary.autoRetry, false);
  assert.equal(draft.blockBoundary.autoAdvance, false);

  // 四段标题都在
  for (const seg of ["一、判定类别", "二、证据", "三、候选处置", "四、阻塞边界"]) {
    assert.ok(draft.description.includes(seg), `草案正文缺段落：${seg}`);
  }
  assert.ok(draft.description.includes("真实 bug 阻塞"));
  assert.ok(draft.description.includes("导入 csv 时崩溃"));
  assert.ok(draft.description.includes("退出码=1"));
  assert.ok(draft.description.includes("tb-7"));
  assert.ok(draft.description.includes(EXECUTION_RED_LINE));
  assert.match(draft.description, /不得认领/);
  assert.match(draft.description, /不得写 done/);

  // 自包含：不依赖输入外的上下文
  const standalone = buildHumanReviewDraft({
    classification: classifyHumanReview({
      task: { identifier: "tb-9" },
      evidence: [{ kind: "architecture", summary: "需要改动基线架构" }],
    }),
  });
  assert.ok(standalone.description.includes("技术架构变化"));
  assert.equal(validateHumanReviewDraft(standalone).ok, true);
});

test("草案自包含性：字段与正文一致，且校验通过（plan 一次到位）", () => {
  const { classification, draft, validation } = planHumanReview({
    task: { identifier: "tb-10", title: "改契约" },
    evidence: [{ kind: "architecture", summary: "跨模块契约变更" }],
  });
  assert.equal(classification.category, "architecture-change");
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.errors, []);
  assert.equal(validateHumanReviewDraft(draft).ok, true);
});

test("证据不足时构造草案必须抛错（绝不臆断）", () => {
  assert.throws(() => buildHumanReviewDraft({ task: { identifier: "tb-11" } }), /证据不足/);
  assert.throws(() => planHumanReview({ signals: ["说不清"] }), /证据不足/);
});

/* ---------------------------------------------------------------- 8. validate 四类缺失各 1 例 */

function goodDraft(overrides = {}) {
  return {
    title: "【人工校验】需求异化 · tb-12",
    description: "四段正文",
    category: "requirement-drift",
    evidence: [{ kind: "contradiction", summary: "与 R100 矛盾" }],
    candidateActions: [{ id: "follow-requirement", label: "以需求为准改写任务" }],
    blockBoundary: { scope: "self-and-downstream", description: "自身与下游受阻" },
    forbiddenForExecution: true,
    ...overrides,
  };
}

test("validate：完整草案 ok=true、errors 为空", () => {
  assert.deepEqual(validateHumanReviewDraft(goodDraft()), { ok: true, errors: [] });
  assert.equal(validateHumanReviewDraft(goodDraft({ blockBoundary: "自身与下游受阻，不得自动重派" })).ok, true, "阻塞边界允许用字符串");
});

test("validate 缺【判定类别】→ 报错", () => {
  const r = validateHumanReviewDraft(goodDraft({ category: "" }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /判定类别/.test(e)), r.errors.join("|"));
});

test("validate 缺【证据】→ 报错", () => {
  const r = validateHumanReviewDraft(goodDraft({ evidence: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /证据/.test(e)));
});

test("validate 缺【候选处置】→ 报错", () => {
  const r = validateHumanReviewDraft(goodDraft({ candidateActions: [] }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /候选处置/.test(e)));
});

test("validate 缺【阻塞边界】→ 报错", () => {
  const r = validateHumanReviewDraft(goodDraft({ blockBoundary: null }));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /阻塞边界/.test(e)));
  assert.equal(validateHumanReviewDraft(goodDraft({ blockBoundary: { description: "   " } })).ok, false, "空白的 description 不算边界");
});

test("validate 其他边界：非对象 / 非法类别 / 红线被破坏", () => {
  assert.equal(validateHumanReviewDraft(null).ok, false);
  assert.equal(validateHumanReviewDraft([]).ok, false);
  const bad = validateHumanReviewDraft(goodDraft({ category: "whatever" }));
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /非法/.test(e)));
  const red = validateHumanReviewDraft(goodDraft({ forbiddenForExecution: false }));
  assert.equal(red.ok, false);
  assert.ok(red.errors.some((e) => /红线/.test(e)));
});

/* ---------------------------------------------------------------- 9. 纯函数 / 零依赖自证 */
test("纯函数性：不修改入参，且重复调用结果稳定", () => {
  const input = {
    task: { identifier: "tb-13", title: "x" },
    blockRecurrences: 3,
    evidence: [{ kind: "failure", summary: "崩溃", exitCode: 1 }],
    downstream: ["d1"],
  };
  const snapshot = JSON.stringify(input);
  const a = classifyHumanReview(input);
  const b = classifyHumanReview(input);
  assert.equal(JSON.stringify(input), snapshot, "入参不得被修改");
  assert.deepEqual(a, b, "同输入同输出");
  const d1 = buildHumanReviewDraft(input);
  const d2 = buildHumanReviewDraft(input);
  assert.deepEqual(d1, d2);
  assert.equal(JSON.stringify(input), snapshot);
  // 常量不可被调用方污染
  assert.equal(Object.isFrozen(HUMAN_REVIEW_CATEGORY_LABELS), true);
  assert.equal(Object.isFrozen(CANDIDATE_ACTIONS["real-bug-blocked"]), true);
});

/* ---------------------------------------------------------------- 6. -75 返工：失败证据的三处缺陷 */

test("-75 P1：退出码必须看值 —— 「退出码 0」是成功，绝不当作失败证据（防误升级）", () => {
  // 复发照旧 ≥2，唯一差别是退出码的值
  const zero = classifyHumanReview({ blockRecurrences: 2, evidence: ["退出码 0"] });
  assert.equal(zero.confident, false, "退出码 0 = 成功，不得升级");
  assert.equal(zero.category, null);
  const nonzero = classifyHumanReview({ blockRecurrences: 2, evidence: ["退出码 1"] });
  assert.equal(nonzero.confident, true, "退出码 1 = 失败，应当升级");
  assert.equal(nonzero.category, "real-bug-blocked");
  // 结构化字段同口径
  assert.equal(classifyHumanReview({ blockRecurrences: 2, exitCode: 0 }).confident, false);
  assert.equal(classifyHumanReview({ blockRecurrences: 2, exitCode: 1 }).confident, true);
  // 各种写法都要读值（带分隔符 / 全角乘号 / 英文 / -1 被信号杀掉）
  for (const text of ["退出码：0", "exit code 0", "exitCode=0", "退出码 0（超时前正常结束）"]) {
    assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: [text] }).confident, false, `应识别为成功：${text}`);
  }
  for (const text of ["退出码：1", "exit code 137", "退出码 143"]) {
    assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: [text] }).confident, true, `应识别为失败：${text}`);
  }
  // 「退出码 0」与**别的**失败信号同时出现 → 仍算失败（退出码那句不作数，别的作数）
  const mixed = classifyHumanReview({ blockRecurrences: 2, evidence: ["退出码 0 但 npm test 失败"] });
  assert.equal(mixed.confident, true, "别处有失败信号时不能被退出码 0 一票否决");
});

test("-75 P2：结构化退出码字段（上游本来就是数字）必须被识别", () => {
  const single = classifyHumanReview({ blockRecurrences: 2, exitCode: 1 });
  assert.equal(single.confident, true);
  assert.equal(single.category, "real-bug-blocked");
  assert.equal(classifyHumanReview({ blockRecurrences: 2, exitCodes: [1, 2] }).confident, true);
  assert.equal(classifyHumanReview({ blockRecurrences: 2, exitCodes: [{ exitCode: 1 }] }).confident, true, "尝试记录对象数组也要认");
  // 证据条目里的数值字段（FR-82 尝试记录形态）
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: [{ kind: "run", summary: "第 2 次尝试", exitCode: 1 }] }).confident, true);
  // 全是 0 → 仍不升级
  assert.equal(classifyHumanReview({ blockRecurrences: 2, exitCodes: [0, 0] }).confident, false);
});

test("-75 P3：裸栈必须被识别，且不误伤普通标识符", () => {
  const bare = classifyHumanReview({ blockRecurrences: 2, evidence: ["TypeError: x is not a function"] });
  assert.equal(bare.confident, true, "裸 XxxError 就是栈的常见形态");
  assert.equal(bare.category, "real-bug-blocked");
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: ["RangeError: Maximum call stack size exceeded"] }).confident, true);
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: ["at parse (x.mjs:12:3)"] }).confident, true, "栈帧也应识别");
  // 反例：不能把普通标识符/时间当栈
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: ["noError 只是个变量名"] }).confident, false);
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: ["会议在 at 12:30 开始"] }).confident, false);
  // 老写法（带 stack 前缀 / 中文「栈」）不能因为本次改动而失效
  assert.equal(classifyHumanReview({ blockRecurrences: 2, evidence: ["stack: 一段回溯"] }).confident, true);
});

/* ------------------------------- 真机回归（2026-10-18）：升级门对"反复真实失败"失灵 */

test("回归：诊断类型用**下划线**命名（block_loop / repeated_crash）也必须被认作复发/失败证据", () => {
  // 真机现场：任务两次真实执行失败 → 诊断已是 ["block_loop","repeated_crash"]、复发=4，
  // 升级门却报「失败证据 0 条」并拒绝派卡。原因：本模块早期按**连字符**比对诊断 kind，
  // 与 `DIAGNOSTIC_KINDS` 的**下划线**形态对不上 → 诊断类证据分支永不命中。
  const underscore = classifyHumanReview({
    task: { title: "改 upstream 契约", description: "" },
    blockKind: "capability",
    blockRecurrences: 4,
    diagnosis: [{ kind: "repeated_crash", count: 2, title: "重复崩溃", detail: "连续 2 次以失败收场" }],
  });
  assert.equal(underscore.confident, true, "下划线形态必须命中");
  assert.equal(underscore.category, "real-bug-blocked");

  // 归一化：两种写法都要认，不挑写法
  const hyphen = classifyHumanReview({
    task: { title: "改 upstream 契约", description: "" },
    blockKind: "capability",
    blockRecurrences: 4,
    diagnosis: [{ kind: "repeated-crash", count: 2, title: "重复崩溃" }],
  });
  assert.equal(hyphen.confident, true, "连字符形态同样要认");
});

test("回归：结构化失败尝试（kind=failure）必须产出失败证据", () => {
  // 真机现场：`task_runs` 两条 `outcome=timeout`，但证据被折成**纯字符串** → 丢掉 kind →
  // `kindIn(e,["failure",…])` 永不命中，且该摘要不含 FAILURE_TEXT_RE 的任何关键词。
  const withKind = classifyHumanReview({
    task: { title: "x", description: "" },
    blockRecurrences: 2,
    evidence: [{ kind: "failure", summary: "timeout：CLI 执行器超时（2s）", text: "timeout：CLI 执行器超时（2s）" }],
  });
  assert.equal(withKind.confident, true);
  assert.equal(withKind.category, "real-bug-blocked");
});
