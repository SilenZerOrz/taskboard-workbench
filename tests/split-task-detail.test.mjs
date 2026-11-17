/**
 * 卡 `-273`（需求 `R189`）—— 批量/分拆生成的任务卡**不许是空详情卡**。
 *
 * 真机读数（2026-11-17）：需求页勾选 16 条 → 「批量生成任务」→ 16 张卡 description / acceptance 全为空，
 * 而条目本身 desc 4509 / acc 213。内容在条目上，建卡时被两层丢掉：
 *   ① `assertSplitTasks` 只保留 6 个字段（acceptance 不在其中）；
 *   ② `splitRequirement` 没把 acceptance 传给 `createTask`，也没在为空时装配正文。
 * 本文件把这四条口径钉住：透传 / 兜底装配 / 缺口显式标注 / 调用方原文不被覆盖。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import { openStore } from "../src/core/store.mjs";
import { assertSplitTasks, buildSplitTaskDescription, buildSplitTaskAcceptance } from "../src/core/requirements.mjs";

const LABELS = ["目标：", "范围：", "禁止：", "做法：", "报告：", "停下：", "验收：", "关联："];

function fresh() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  return store;
}

test("-273 ① assertSplitTasks 必须让 acceptance 穿过校验层（不再静默丢弃）", () => {
  const [t] = assertSplitTasks([{ title: "X", acceptance: "① 跑通 npm test" }]);
  assert.equal(t.acceptance, "① 跑通 npm test");
});

test("-273 ② 只给标题 ⇒ 兜底正文含规范 07 八块，且验收逐字取自条目", () => {
  const s = fresh();
  const item = s.createRequirementItem({
    projectId: "demo", title: "把登录超时从 30 分钟改成 8 小时",
    description: "范围：src/auth/session.mjs\n禁止：不改 schema",
    acceptance: "① 8 小时后才掉线；② npm test 全绿",
  });
  const r = s.splitRequirement(item.id, { tasks: [{ title: item.title, kind: "work" }] });
  const card = r.tasks[0];
  for (const label of LABELS) assert.ok(card.description.includes(label), `兜底正文缺 ${label}`);
  assert.equal(card.acceptance, item.acceptance); // 逐字一致（证透传，不是重写）
  assert.ok(card.description.includes("src/auth/session.mjs"), "条目「范围」段应被摘进卡正文");
  assert.ok(card.description.includes("不改 schema"), "条目「禁止」段应被摘进卡正文");
  assert.ok(card.description.length <= 1200, `正文超预算：${card.description.length}`);
  s.close();
});

test("-273 ③ 条目没写验收 ⇒ 卡上显式标注缺口，绝不留空", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "只有标题的条目" });
  const r = s.splitRequirement(item.id, { tasks: [{ title: "子任务" }] });
  const card = r.tasks[0];
  assert.equal(card.acceptance, buildSplitTaskAcceptance(item));
  assert.ok(card.acceptance.includes("未写验收"), "验收字段必须写明缺口");
  assert.ok(card.description.includes("未写验收"), "正文的「验收：」行必须写明缺口");
  assert.ok(card.description.includes("未写「范围」段"), "条目没写范围时要如实说，而不是编一个");
  s.close();
});

test("-273 ④ 调用方给了正文/验收 ⇒ 原样保留，不被兜底覆盖", () => {
  const s = fresh();
  const item = s.createRequirementItem({ projectId: "demo", title: "T", acceptance: "条目验收" });
  const r = s.splitRequirement(item.id, {
    tasks: [{ title: "子任务", description: "AI 写的详细正文", acceptance: "AI 写的验收" }],
  });
  assert.equal(r.tasks[0].description, "AI 写的详细正文");
  assert.equal(r.tasks[0].acceptance, "AI 写的验收");
  s.close();
});

test("-273 ⑤ buildSplitTaskDescription 是纯函数：不读库、不臆造范围", () => {
  const text = buildSplitTaskDescription({ identifier: "demo-R1", title: "标题", description: "", acceptance: "" }, "子任务");
  assert.ok(text.startsWith("子任务（来自需求 demo-R1）"));
  for (const label of LABELS) assert.ok(text.includes(label));
});

test("-273 ⑥ 批量按钮必须把「未写验收」说出口（源码守卫，锁文案不锁整行）", () => {
  const src = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  // 只要「统计了 noAcceptance」且「回执里有这句」两件事都在 —— 不锁具体拼接方式，
  // 避免把排版改动误判成回归（`-273` 自纠：detailNote 曾因插错位置把 button-feedback 守卫弄红）。
  assert.ok(/noAcceptance\s*\+=\s*1/.test(src), "批量按钮必须统计未写验收的条数");
  assert.ok(src.includes("条需求未写验收"), "回执必须写明「N 条需求未写验收」");
});
