/**
 * 守卫（2026-10-27 · 卡 `-159`）：两台「自动复核证据可读性」验证台必须**持续**钉住可读性的**四段要件**，
 * 且必须保留**两条反证**。防后来者把某条判定**静默删掉**而台子照旧全绿。
 *
 * ## 为什么需要这条守卫
 * 真机报障的原话是「**执行结果只返回一个结果，应该在自动复核证据内自动填入复核总结证据及结论**」——
 * 用户看到的是**界面**。而 `tests/verify.test.mjs` 只钉后端字段（评论正文 / 详情证据包）；
 * 若 `web/app.js` 里渲染「复核总结 / 当时的验收标准 / 输出尾段」的代码被删，**单测仍全绿**。
 * 这正是本卡要防的漏网路径 ⇒ 用两条守卫把「数据面 + 界面面」都钉死：
 *   ① `bench-review-evidence.mjs`（数据面）：证据评论与详情证据包必须含 结论/总结/验收标准/输出尾段；
 *      且必须保留**两条反向对照**（无验收标准 ⇒ 不臆造；老证据 ⇒ 向后兼容不臆造）；
 *   ② `bench-review-evidence-dom.mjs`（界面面）：必须**真浏览器**读**渲染后的 DOM**（不得退化成读源码），
 *      且必须保留**逐字**验收标准断言与**反证入口**（`TB_BENCH_WEB_DIR`）。
 *
 * 本文件只读源码文本（不起进程、不联网、不拉 Chrome），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataBench = readFileSync(join(ROOT, "tools/bench-review-evidence.mjs"), "utf8");
const domBench = readFileSync(join(ROOT, "tools/bench-review-evidence-dom.mjs"), "utf8");

test("守卫：数据面台必须逐项断言证据含 结论 / 验收标准 / 总结 / 输出尾段", () => {
  assert.match(dataBench, /证据评论含「结论=」机器头/, "必须断言机器头结论");
  assert.match(dataBench, /证据评论含「本卡验收标准：」块/, "必须断言验收标准块");
  assert.match(dataBench, /证据评论含「总结：」/, "必须断言总结");
  assert.match(dataBench, /证据评论含「输出尾段：」块/, "必须断言输出尾段");
});

test("守卫：数据面台必须断言详情证据包四字段齐全且验收标准**逐字**相同", () => {
  for (const f of ["verdict", "summary", "acceptance", "tail"]) {
    assert.match(dataBench, new RegExp(`autoReview\\.${f} 非空`), `必须断言 autoReview.${f} 非空`);
  }
  assert.match(dataBench, /acceptance 与任务验收标准逐字相同/, "必须断言验收标准逐字一致（不得为空/串段）");
});

test("守卫：数据面台必须保留两条反向对照（无验收标准不臆造 / 老证据向后兼容）", () => {
  assert.match(dataBench, /无验收标准时\*\*不\*\*臆造/, "必须保留「无验收标准 ⇒ 不臆造」反向对照");
  assert.match(dataBench, /老证据（无总结\/验收标准）仍可解析/, "必须保留老证据向后兼容反向对照");
});

test("守卫：数据面台必须断言「复核不改状态」红线", () => {
  assert.match(dataBench, /复核不改任务状态/, "FR-90 红线：复核只产证据、不改状态");
});

test("守卫：界面面台必须用**真浏览器**读**渲染后的 DOM**，不得退化成只读源码", () => {
  assert.match(domBench, /headless=new/, "必须真拉起 headless Chrome");
  assert.match(domBench, /Runtime\.evaluate/, "必须经 CDP 在页面里求值（读渲染结果）");
  assert.match(domBench, /querySelector\(["'`]\.review-evidence/, "必须在渲染后的 DOM 里查 .review-evidence 块");
  assert.match(domBench, /document\.querySelectorAll\(["'`]article\.task-card/, "必须真的点开卡片抽屉，而不是直接拼字符串");
});

test("守卫：界面面台必须断言验收标准**逐字**可见（防只断言标题在）", () => {
  assert.match(domBench, /验收标准\*\*逐字可见\*\*/, "必须有逐字断言");
  assert.match(domBench, /必须含输出尾段。/, "逐字判据必须落在验收标准原文片段上");
});

test("守卫：界面面台必须保留反证入口（换掉 web/ 就必须转红）", () => {
  assert.match(domBench, /TB_BENCH_WEB_DIR/, "必须支持 TB_BENCH_WEB_DIR 反证入口");
});

test("守卫：界面面台必须如实记录「沙箱里 Chrome 自带沙箱拉不起渲染进程」的环境坑与解法", () => {
  // 2026-10-27 实测：无 --no-sandbox 时 Target/attach 都成功但 Page.enable 全超时 ⇒ 极易误判成产品缺陷。
  assert.match(domBench, /Page\.enable/, "必须在注释里写明症状（Page.enable 超时）");
  assert.match(domBench, /--no-sandbox/, "必须给出可复跑解法");
});
