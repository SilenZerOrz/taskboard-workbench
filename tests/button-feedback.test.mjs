/**
 * 守卫（2026-10-28 真机批注「需求条目新建点击无效，请检查整个工作台的所有失效按钮」）。
 *
 * 抓到的两类「失效」都不是按钮没绑事件，而是**点了不说话**：
 *   ① 需求条目「新建条目」标题为空时 `if (!title) return;` —— 静默返回，界面零反馈；
 *   ② 批量确认 / 批量删除 / 批量生成任务 把每条的错误 `.catch(() => {})` 吞掉，却照报总数
 *      ⇒ 一条都没成功也显示「已删除 N 条」，比报错更坏。
 *
 * 本守卫锁：空输入必须有打字回显 + 焦点回送；批量动作必须**真实计数并区分成功/失败**。
 * 只读源码文本，毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");

test("新建条目：空标题不许静默返回，必须提示 + 聚焦", () => {
  assert.match(app, /if \(!title\) \{ showBanner\("请先输入条目标题，再点「新建条目」", "error"\); newTitle\.focus\(\); return; \}/,
    "空标题必须当场给出错误提示并把焦点送回输入框");
  assert.doesNotMatch(app, /const title = newTitle\.value\.trim\(\);\s*\n\s*if \(!title\) return;/,
    "禁止回到「空标题静默 return」的旧写法");
});

test("新建条目：回车即提交", () => {
  assert.match(app, /newTitle\.addEventListener\("keydown", \(event\) => \{[\s\S]{0,160}event\.key !== "Enter"[\s\S]{0,120}void createItem\(\);[\s\S]{0,40}\}\);/,
    "填完标题敲回车应当提交");
});

test("批量确认：真实计数，失败要显形", () => {
  assert.match(app, /const failed = \[\];\s*\n\s*for \(const id of ids\) \{ try \{ await api\("PATCH", `\/api\/requirements\/items\/\$\{encodeURIComponent\(id\)\}`/,
    "批量确认必须逐条计成功/失败");
  assert.match(app, /已确认 \$\{ok\} 条，失败 \$\{failed\.length\} 条/, "必须报出失败条数");
});

test("批量删除：真实计数，失败要显形（不许再「已删除 N 条」蒙人）", () => {
  assert.match(app, /已删除 \$\{ok\} 条，失败 \$\{failed\.length\} 条/, "删除失败必须显形");
  assert.doesNotMatch(app, /\.catch\(\(\) => \{\}\);\s*\n\s*reqState\.selected\.clear\(\); showBanner\(`已删除 \$\{ids\.length\} 条`/,
    "禁止恢复「吞错 + 照报总数」的旧写法");
});

test("批量生成任务：失败原因带出来（不再是 catch(_) 直接丢）", () => {
  assert.match(app, /已生成 \$\{n\} 个任务，失败 \$\{failed\.length\} 条/, "生成失败必须显形");
  assert.doesNotMatch(app, /catch \(_\) \{ \/\* 跳过 \*\/ \}/, "禁止恢复静默跳过");
});
