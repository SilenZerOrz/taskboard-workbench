/** P0-7：自动拆解收紧 —— 仅「显式可拆解」才判为复杂任务（isComplexTask）。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { isComplexTask } from "../src/core/loop.mjs";

test("带 complex/复杂 标签的任务仍判为复杂（不受列表行约束）", () => {
  assert.equal(isComplexTask({ labels: ["complex"], description: "" }), true);
  assert.equal(isComplexTask({ labels: ["复杂"], description: "一段没有列表的散文正文。" }), true);
  assert.equal(isComplexTask({ labels: ["Complex"], description: "" }), true);
});

test("散文正文里夹 2 条长 bullet 且含句末标点 → 不拆", () => {
  const description = [
    "这是一段 markdown 正文说明，先讲背景。",
    "- 这里第一条列表行其实是很长的叙述性句子，远远超过了单行正文长度上限，读起来就是普通段落文字。",
    "- 第二条同样是很长的散文描述，并不是可执行的清单条目，因为它在讲一件事的来龙去脉而不仅仅是一个动作。",
    "结尾再补一句总结。",
  ].join("\n");
  assert.equal(isComplexTask({ labels: [], description }), false);

  // 长度未超限但含句末标点 → 同样视为散文正文，不拆。
  const punctuated = ["- 第一件事做完。", "- 第二件事也做完。"].join("\n");
  assert.equal(isComplexTask({ labels: [], description: punctuated }), false);
});

test("3 条短列表行 → 拆", () => {
  const description = ["- 拆分 store 层", "- 补单测覆盖", "- 更新进度文档"].join("\n");
  assert.equal(isComplexTask({ labels: [], description }), true);
  // 编号列表同样识别。
  assert.equal(isComplexTask({ labels: [], description: "1. 甲\n2. 乙\n3. 丙" }), true);
});

test("7 条短列表行 → 不拆（超上限 6）", () => {
  const description = Array.from({ length: 7 }, (_, i) => `- 条目 ${i + 1}`).join("\n");
  assert.equal(isComplexTask({ labels: [], description }), false);
  // 边界：恰好 6 条仍在范围内。
  const six = Array.from({ length: 6 }, (_, i) => `- 条目 ${i + 1}`).join("\n");
  assert.equal(isComplexTask({ labels: [], description: six }), true);
});

test("恰好 2 条短列表行 → 拆（下限边界）；1 条 → 不拆", () => {
  assert.equal(isComplexTask({ labels: [], description: "- 甲\n- 乙" }), true);
  assert.equal(isComplexTask({ labels: [], description: "- 只有一条" }), false);
});

test("空描述或纯散文（无列表行）→ 不拆", () => {
  assert.equal(isComplexTask({ labels: [], description: "" }), false);
  assert.equal(isComplexTask({ labels: [], description: "只有一段话，没有任何列表。" }), false);
});
