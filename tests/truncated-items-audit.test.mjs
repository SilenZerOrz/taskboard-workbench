/**
 * 截断条目审计（卡 `-215` / 需求 `R159` 验收 ①）
 *
 * 守四件事：
 *  ① **判据有刻度**：前缀关系优先于长度假设（`R16` 只有 1988 字符照样算截断）；
 *  ② **反引号不是句读**：`` ` `` 结尾必须判「未说完」—— 前口径正是在这里少算 3 条（64 → 67）；
 *  ③ **不会见长就红**：`slice(0,2000)` 签名区间之外、且以句号/表格行尾收束的，一律不报；
 *  ④ **它是尺子不是门**：源码必须 `readOnly: true`、且**去注释后**无任何写库语句。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CRITERION, auditItems, bodyOf, classifySource, decideTruncated, endsProperly, sourcePathOf, summarize } from "../tools/audit-truncated-items.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = readFileSync(path.join(ROOT, "tools", "audit-truncated-items.mjs"), "utf8");

test("bodyOf：去掉【归类…】前缀行与 `来源：` 头行，正文逐字保留", () => {
  const mirror = "【归类 2026-10-29 · 资料索引】非需求条目：略。\n\n来源：`docs/交付/x.md`\n\n# 标题\n\n正文";
  assert.equal(bodyOf(mirror), "# 标题\n\n正文");
  const real = "来源：`docs/README.md`\n\n# 标题\n\n正文\n\n";
  assert.equal(bodyOf(real), "# 标题\n\n正文", "尾部空白要 rstrip，否则长度多算几个字符就对不上 2000 签名");
  assert.equal(bodyOf(""), "");
});

test("endsProperly：句号 / 表格行尾 / 块引用算完整；**反引号不算**；空串不算", () => {
  assert.equal(endsProperly("说完了。"), true);
  assert.equal(endsProperly("| 列 | 值 |"), true);
  assert.equal(endsProperly("引用行 >"), true);
  assert.equal(endsProperly("半句话"), false);
  assert.equal(endsProperly("…打印 `Full diagnostics: <path>`"), false, "行内代码闭合不证明句子结束（R41 就是这条）");
  assert.equal(endsProperly("`#codex-taskboard-frame`"), false, "R9 同型");
  assert.equal(endsProperly("| a7 | `sessions.open`"), false, "R51 同型");
  assert.equal(endsProperly(""), false);
});

test("甲判据：源文严格前缀 + 源文更长 + 未说完 ⇒ 截断（不依赖长度签名）", () => {
  const src = "# 标题\n\n第一段。\n\n第二段被切";
  // 1988 字符的短样本也要抓到 —— 前口径的 `>=1990` 阈值会漏掉它
  const body = src.slice(0, 8);
  assert.equal(decideTruncated({ body, sourceText: src }).truncated, true);
  // 反向对照：同一个前缀但以句读收束 ⇒ 不算截断（可能是正当摘录）
  const atPeriod = src.slice(0, src.indexOf("。") + 1);
  assert.equal(decideTruncated({ body: atPeriod, sourceText: src }).truncated, false, "「第一段。」是完整句 ⇒ 前缀相同也不算截断");
  // 反向对照：源文与正文完全相同（没切）⇒ 不算
  assert.equal(decideTruncated({ body: src, sourceText: src }).truncated, false);
});

test("乙判据：源文已改 / 源档缺失 时落在 `slice(0,2000)` 签名区间才判，区间外不判", () => {
  const [lo, hi] = CRITERION.lengthSignature;
  const cut = "x".repeat(hi);
  assert.equal(decideTruncated({ body: cut, sourceText: "改过的源文" }).truncated, true);
  assert.equal(decideTruncated({ body: cut, sourceText: null }).truncated, true);
  // 短描述即使没有句号也不算（长任务是表格行/代码块的正常结尾）
  assert.equal(decideTruncated({ body: "x".repeat(lo - 1), sourceText: null }).truncated, false);
  // 超长且未收束：不属 slice 签名 ⇒ 不猜
  assert.equal(decideTruncated({ body: "x".repeat(hi + 1), sourceText: null }).truncated, false);
});

test("classifySource：exact / evolved（含链接漂移）/ missing 三分类与 firstDiff", () => {
  const src = "# 标题\n\n见 [`规范/进度.md`](../规范/进度.md)。\n\n后续";
  const body = "# 标题\n\n见 [`规范/进度.md`](../规范/进度.md)。\n";
  assert.deepEqual(classifySource({ body, sourceText: src }), { kind: "exact", firstDiff: body.length, linkDrift: false });

  const renamed = src.replace(/规范\/进度\.md/g, "规范/05-事实快照.md");
  const drift = classifySource({ body: src.slice(0, src.length - 1), sourceText: renamed });
  assert.equal(drift.kind, "evolved");
  assert.equal(drift.linkDrift, true, "只有链接改名、正文没变 ⇒ 标 linkDrift");

  const grown = classifySource({ body: src.slice(0, 10), sourceText: "# 标题\n\n另外的内容" + "很长的后来追加" });
  assert.equal(grown.kind, "evolved");
  assert.equal(grown.linkDrift, false);
  assert.deepEqual(classifySource({ body: "x", sourceText: null }), { kind: "missing", firstDiff: null, linkDrift: false });
});

test("sourcePathOf：只认 `来源：` 那行的反引号路径", () => {
  assert.equal(sourcePathOf("来源：`docs/README.md`\n\n# t"), "docs/README.md");
  assert.equal(sourcePathOf("# 没有来源行"), null);
});

test("auditItems：按编号数值排序、分镜像/真条目、算差额、只留截断的", () => {
  const big = (n, tail) => "x".repeat(n - 3) + tail + "xx";
  const source = "x".repeat(2000) + "REST";
  const items = [
    { identifier: "taskboard-workbench-R10", status: "closed", description: "来源：`a.md`\n\n" + source.slice(0, 2000) },
    { identifier: "taskboard-workbench-R2", status: "done", description: "来源：`b.md`\n\n" + "短描述，完整。" },
    { identifier: "taskboard-workbench-R7", status: "closed", description: "【归类 2026-10-29 · 资料索引】略。\n\n来源：`c.md`\n\n" + "y".repeat(1999) },
    { identifier: "taskboard-workbench-R3", status: "closed", description: big(500, "。") },
  ];
  const readSource = (p) => (p === "a.md" ? source : p === "c.md" ? null : null);
  const rows = auditItems({ items, readSource });
  assert.deepEqual(rows.map((r) => r.identifier), ["taskboard-workbench-R7", "taskboard-workbench-R10"], "按数值排序（R7 在 R10 前），且只留截断的");
  const r10 = rows.find((r) => r.identifier === "taskboard-workbench-R10");
  assert.equal(r10.class, "real");
  assert.equal(r10.sourceStatus, "exact");
  assert.equal(r10.delta, 4, "源文 − 正文 = 4（REST）");
  const r7 = rows.find((r) => r.identifier === "taskboard-workbench-R7");
  assert.equal(r7.class, "mirror");
  assert.equal(r7.sourceStatus, "missing");
  assert.equal(r7.rule, "乙·长度签名(源档缺失)");
  assert.equal(rows.some((r) => r.identifier === "taskboard-workbench-R2"), false, "完整句子的短条目不得进清单");

  const s = summarize(rows);
  assert.equal(s.truncated, rows.length);
  assert.equal(s.byClass.mirror, 1);
  assert.equal(s.byClass.real, 1);
  assert.equal(s.exactCount, 1);
  assert.ok(s.byDeltaCap[1000].total >= 1, "分档表要能回答「补多少字还算可读」");
});

test("只读守卫：`readOnly: true` 在位，且**去注释后**无任何写库语句", () => {
  assert.match(SRC, /new DatabaseSync\([^)]*\{\s*readOnly:\s*true\s*\}/, "只读审计必须是真的只读连接");
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const kw of ["INSERT INTO", "UPDATE ", "DELETE FROM"]) {
    assert.equal(code.includes(kw), false, `去注释后不得出现 ${kw.trim()}（只读 lint 不能只是文案）`);
  }
  assert.equal(/\.(run|exec)\(\s*["'`]/.test(code), false, "不得以 SQL 字面量调 run/exec");
});
