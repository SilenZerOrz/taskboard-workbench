/**
 * 条目详情 lint（卡 `-216` / 需求 `R160` 验收 ⑤「骨架落地选 B」）
 *
 * 守三件事：
 *  ① **尺子有刻度**：预算从规范文件读（改了规范 lint 要跟），读不到才回落默认；
 *  ② **判据真判得出**：空验收 / 超预算 / 缺停下 / 缺「移出」各转红，合规条目保持干净（反向对照）；
 *  ③ **它是尺子不是门**：源码不得出现任何写库语句，且必须 `readOnly: true` ——
 *     否则「只读 lint」四个字就是文案，不是事实。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_BUDGET, countAcceptance, lintEntries, readBudget } from "../tools/lint-items.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NORM = readFileSync(path.join(ROOT, "spec", "norms", "item-detail.md"), "utf8");

test("预算从规范正文读出来（不是硬编码）：1200 / 800", () => {
  const b = readBudget(NORM);
  assert.equal(b.reqDescMax, 1200);
  assert.equal(b.taskDescMax, 800);
  assert.equal(b.source, "norm");
});

test("规范换了数字 lint 跟着换；读不到则回落默认值并标注来源", () => {
  const bumped = readBudget("| 需求条目 `description` | 900 字符 |\n| 任务卡 `description` | 600 字符 |");
  assert.equal(bumped.reqDescMax, 900);
  assert.equal(bumped.taskDescMax, 600);
  const fallback = readBudget("没有任何表格");
  assert.equal(fallback.reqDescMax, DEFAULT_BUDGET.reqDescMax);
  assert.equal(fallback.source, "default");
});

test("验收条数：认 ①②③ / 1. / - 三种写法，空文本记 0", () => {
  assert.equal(countAcceptance("① a\n② b\n③ c"), 3);
  assert.equal(countAcceptance("1. a\n2. b"), 2);
  assert.equal(countAcceptance("- a\n- b\n- c\n- d"), 4);
  assert.equal(countAcceptance("   \n "), 0);
});

const req = (o = {}) => ({ identifier: "taskboard-workbench-R999", description: "taskboard-workbench-R999｜标题\n\n范围：包含 a；移出 b\n\n目标：x", acceptance: "① a\n② b\n③ c", ...o });
const task = (o = {}) => ({ identifier: "taskboard-workbench-999", description: "卡\n\n范围：包含 a；移出 b\n\n停下：报错即停", acceptance: "① a", ...o });

test("合规条目零违规（反向对照：不是见谁都报红）", () => {
  const r = lintEntries({ requirements: [req()], tasks: [task()] });
  assert.equal(r.total, 0, JSON.stringify(r.violations));
});

test("需求：空验收 / 超预算 / 首行缺编号 / 有范围无移出 各转红", () => {
  const r = lintEntries({
    requirements: [
      req({ acceptance: "" }),
      req({ description: "taskboard-workbench-R999｜" + "长".repeat(1300) }),
      req({ description: "没有编号开头" }),
      req({ description: "范围：包含 a\n目标：x" }),
    ],
  });
  const rules = r.violations.map((v) => v.rule);
  assert.ok(rules.includes("REQ_ACCEPTANCE_MISSING"));
  assert.ok(rules.includes("REQ_DESC_TOO_LONG"));
  assert.ok(rules.includes("REQ_HEADER_MISSING"));
  assert.ok(rules.includes("REQ_SCOPE_NO_MOVE"));
  assert.equal(r.byRule.REQ_ACCEPTANCE_MISSING, 1);
});

test("任务卡：空验收 / 超预算 / 缺停下 / 验收超 6 条 各转红", () => {
  const r = lintEntries({
    tasks: [
      task({ acceptance: "" }),
      task({ description: "卡\n" + "长".repeat(900), acceptance: "① a" }),
      task({ description: "卡\n\n范围：包含 a；移出 b", acceptance: "① a" }),
      task({ acceptance: "① a\n② b\n③ c\n④ d\n⑤ e\n⑥ f\n⑦ g" }),
    ],
  });
  const rules = new Set(r.violations.map((v) => v.rule));
  for (const k of ["TASK_ACCEPTANCE_MISSING", "TASK_DESC_TOO_LONG", "TASK_STOP_MISSING", "TASK_ACCEPTANCE_MANY"]) assert.ok(rules.has(k), k);
});

test("level 分级正确：空验收/超预算=error，缺停下/缺移出=warn（尺子不拦人）", () => {
  const r = lintEntries({ requirements: [req({ acceptance: "" })], tasks: [task({ description: "卡" })] });
  assert.equal(r.errors, 1);
  assert.ok(r.warnings >= 1);
});

test("只读守卫（源码）：零写库语句 + 显式 readOnly", () => {
  const src = readFileSync(path.join(ROOT, "tools", "lint-items.mjs"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^.*?\/\/.*$/gm, "");
  for (const bad of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+\w+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bDROP\s+TABLE\b/i]) {
    assert.equal(bad.test(code), false, `只读 lint 里出现了写库语句：${bad}`);
  }
  assert.match(code, /readOnly:\s*true/);
});
