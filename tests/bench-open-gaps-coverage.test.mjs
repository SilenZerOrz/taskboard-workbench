/**
 * 守卫（2026-11-06 · 卡 `-231` / 需求 `R170`）：`tools/bench-open-gaps.mjs` 必须**持续**证明
 * 「开局缺口的 12 项读数取自真实数据，且缺口语真能投进主会话、零缺口真能置灰」。
 *
 * 为什么需要这条：这台验证台的全部价值都在**判别力**上 —— 它守的是四类只有真渲染才看得出的缺陷：
 *   ① 「接口说缺 12 项」与「界面上写着缺几项」对不上（A 四方一致）；
 *   ② 按钮看起来点了，宿主会话通道其实**没收到**、或收到的是另一份正文（B3 恰好 1 条 + 逐字比对）；
 *   ③ 零缺口时按钮仍可点，点了没反应也不报错（D3 置灰 + D4 点它无效）；
 *   ④ 台子自己「只会绿」：删掉断言、去掉反证开关、超时不杀 Chrome —— 它照样打印 PASS。
 * 这些缺陷都不会报错、不进日志、单看代码也看不出来，所以守卫必须钉在**源码文本**上：
 * 后来者若为了跑绿而放宽判别式（把「1 条」改成「≥0 条」、把 D4 退回 0→0 真空通过、删掉反证入口），
 * 本文件立刻转红。与 `-224`/`-225`/`-226`/`-227`/`-228` 五台守卫同一条规矩。
 *
 * 钉住六件事：
 *   ① 12 项检查名与判别式逐字在位（A/B1/B2/B3/B4/C1/C2/D1/D2/D3/D4/E），且 `check(` 不少于 12 处；
 *   ② 沙箱自检**先于** spawn Chrome，失败体现在退出码上；
 *   ③ 反证入口 `TB_BENCH_NO_ANNOUNCE` 真的进入了 B 的点击分支（否则反证只是注释里的传说）；
 *   ④ 看门狗在**超时分支内**就杀 Chrome（不是只在 finally），`finally` 四类清理齐全；
 *   ⑤ **双向判别力自证**：在内存里逐条删掉关键片段，本文件的守卫必须至少红一条（防「断言太宽 ⇒ 删了也绿」）；
 *   ⑥ B3 不得退化成只比长度、D4 不得退回 `sent.length === sentBeforeClick` 的 0→0 真空通过。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools", "bench-open-gaps.mjs"), "utf8");

// ---------------------------------------------------------------------------
// 1) 12 项检查名与判别式齐备（逐条断言，缺一即红）
// ---------------------------------------------------------------------------

test("守卫：`-231` 台必须保留 A 的四方一致判别式（接口 / DOM / 提示语 / announce）", () => {
  assert.ok(
    bench.includes("A 缺口数与清单一致（接口 / DOM 未完成项 / 提示语 / announce 回包）"),
    "A 检查名不得改写或删除",
  );
  assert.ok(
    bench.includes("expect > 0 && expect === domTodo && expect === hintN && expect === annN"),
    "A 必须四方相等且 expect > 0（只比其中两方等于放弃跨层一致）",
  );
});

test("守卫：`-231` 台必须保留 B1 的清单条数下限", () => {
  assert.ok(bench.includes("B1 投出的清单 todo ≥ 5 条"), "B1 检查名不得改写或删除");
  assert.ok(bench.includes("titles.length >= 5"), "B1 必须要求至少 5 条 todo");
});

test("守卫：`-231` 台必须保留 B2 的顺序判别式", () => {
  assert.ok(bench.includes("B2 todo 顺序 = 依赖顺序"), "B2 检查名不得改写或删除");
  assert.ok(bench.includes("offOrder.length === 0"), "B2 必须要求乱序项为 0");
});

test("守卫：`-231` 台必须保留 B3 的「恰好 1 条 + 正文/会话逐字比对」", () => {
  assert.ok(bench.includes("B3 宿主会话通道恰好收到 1 条"), "B3 检查名不得改写或删除");
  assert.ok(
    bench.includes('sent.length === 1 && sent[0].prompt === prompt && sent[0].sid === "sess-opengaps-main"'),
    "B3 必须同时钉「恰好 1 条」「正文逐字相同」「sid = 项目主会话」",
  );
});

test("守卫：`-231` 台必须保留 B4 的 delivered 如实回报", () => {
  assert.ok(bench.includes("B4 announce 如实回报 delivered=true"), "B4 检查名不得改写或删除");
  assert.ok(bench.includes("ann?.delivered === true"), "B4 必须校验 delivered 严格为 true（防静默降级）");
});

test("守卫：`-231` 台必须保留 C1 的 ✅ + 3/3 判据", () => {
  assert.ok(bench.includes("C1 补齐 ① 的 3 条判据"), "C1 检查名不得改写或删除");
  assert.ok(bench.includes('rowC.cls.includes("done")'), "C1 必须校验该行变 done");
  assert.ok(bench.includes('rowC.pill.includes("3/3")'), "C1 必须校验胶囊到 3/3");
});

test("守卫：`-231` 台必须保留 C2 的计数真动判别式", () => {
  assert.ok(bench.includes("C2 计数真的动"), "C2 检查名不得改写或删除");
  assert.ok(
    bench.includes("doneC === doneBefore + 1 && gapAfter === gapBefore - 3"),
    "C2 必须校验 done 行 +1 且未完成判据 -3",
  );
});

test("守卫：`-231` 台必须保留 D1/D2 的零缺口判据", () => {
  assert.ok(bench.includes("D1 零缺口：GET /kickoff ready=true"), "D1 检查名不得改写或删除");
  assert.ok(bench.includes("k3.ready === true"), "D1 必须校验 ready 严格为 true");
  assert.ok(bench.includes("D2 提示语写明「开局已对齐」"), "D2 检查名不得改写或删除");
  assert.ok(bench.includes('full.hint.includes("开局已对齐")'), "D2 必须校验 DOM 提示语文案");
});

test("守卫：`-231` 台必须保留 D3/D4 的置灰与「点它无效」判据", () => {
  assert.ok(bench.includes("D3 零缺口 ⇒「引入主对话」置灰 + title 说明已对齐"), "D3 检查名不得改写或删除");
  assert.ok(
    bench.includes('gapBtn.disabled === true && gapBtn.title.includes("已对齐")'),
    "D3 必须同时校验 disabled 与 title 说明（只 disabled 不说原因 = 用户不知道为何点不动）",
  );
  assert.ok(bench.includes("D4 置灰状态下点它无效（宿主通道不再多收）"), "D4 检查名不得改写或删除");
  assert.ok(
    bench.includes("sentBeforeClick === 1 && sent.length === 1"),
    "D4 必须写成「点前 1 条、点后仍 1 条」",
  );
});

test("守卫：`-231` 台必须保留 E 的「正常路径无 error 横幅」", () => {
  assert.ok(bench.includes("E 正常路径无 error 横幅（含点完置灰按钮之后）"), "E 检查名不得改写或删除");
  assert.ok(bench.includes("final.error === null"), "E 必须校验点完置灰按钮之后仍无 error 横幅");
});

test("守卫：`-231` 台的 check( 调用不得少于 12 处", () => {
  assert.ok((bench.match(/\n\s+check\(/g) ?? []).length >= 12, "12 项检查不得被删");
});

// ---------------------------------------------------------------------------
// 2) 沙箱自检 + 退出码
// ---------------------------------------------------------------------------

test("守卫：`-231` 台沙箱自检必须先于 spawn Chrome，且失败体现在退出码", () => {
  const sandboxIdx = bench.indexOf("process.env.CODEX_SANDBOX");
  assert.notEqual(sandboxIdx, -1, "必须有 CODEX_SANDBOX 自检（AGENTS §3）");
  const sandboxBranch = bench.slice(sandboxIdx, sandboxIdx + 400);
  assert.ok(sandboxBranch.includes("process.exit(2)"), "沙箱分支必须以退出码 2 跳过");
  const spawnIdx = bench.indexOf("spawn(chromeBin");
  assert.notEqual(spawnIdx, -1, "必须真 spawn Chrome（否则这台什么都不测）");
  assert.ok(
    sandboxIdx < spawnIdx,
    "顺序必须「先判沙箱、后 spawn Chrome」—— 反过来会先在沙箱里拉起浏览器并连刷崩溃报告",
  );
  assert.ok(bench.includes("process.exit(failed.length ? 1 : 0)"), "结尾必须按失败数给退出码（失败不能静默为 0）");
});

// ---------------------------------------------------------------------------
// 3) 反证入口（反证开关必须真的接进点击分支）
// ---------------------------------------------------------------------------

test("守卫：`-231` 台必须保留 NO_ANNOUNCE 反证入口并接进 B 的点击分支", () => {
  assert.ok(bench.includes("process.env.TB_BENCH_NO_ANNOUNCE"), "必须能开反证");
  assert.ok(
    bench.includes("const NO_ANNOUNCE = Boolean(process.env.TB_BENCH_NO_ANNOUNCE);"),
    "反证开关必须赋给 NO_ANNOUNCE",
  );
  assert.ok(bench.includes("if (NO_ANNOUNCE) {"), "NO_ANNOUNCE 必须真的进入 B 的点击分支（否则反证只是注释）");
  assert.ok(
    bench.includes("TB_BENCH_NO_ANNOUNCE=1 node tools/bench-open-gaps.mjs"),
    "头注释必须写明反证用法",
  );
});

// ---------------------------------------------------------------------------
// 4) 看门狗与清理（防「只会绿」：超时不收进程 ⇒ 孤儿 Chrome，本仓有过事故）
// ---------------------------------------------------------------------------

test("守卫：`-231` 台看门狗必须在超时分支内就杀 Chrome", () => {
  const watchdogStart = bench.indexOf("const watchdog = setTimeout(");
  assert.notEqual(watchdogStart, -1, "必须有看门狗（否则挂死会一直占着端口与 Chrome）");
  const watchdogBody = bench.slice(watchdogStart, watchdogStart + 400);
  assert.ok(
    watchdogBody.includes('chrome?.kill("SIGKILL")'),
    "超时分支必须自己杀 Chrome（`process.exit` 会跳过 finally）",
  );
  assert.ok(watchdogBody.includes("process.exit(1)"), "超时必须退出码 1（挂死不能算绿）");
});

test("守卫：`-231` 台 finally 必须清理 watchdog / Chrome / 临时 dataDir / 临时 profile", () => {
  const finallyIdx = bench.indexOf("} finally {");
  assert.notEqual(finallyIdx, -1, "必须用 finally 兜底清理");
  const finallyBlock = bench.slice(finallyIdx);
  assert.ok(finallyBlock.includes("clearTimeout(watchdog)"), "finally 必须清看门狗");
  assert.ok(finallyBlock.includes('chrome?.kill("SIGKILL")'), "finally 必须杀 Chrome");
  assert.ok(
    finallyBlock.includes("rm(dataDir") || /for \(const dir of dataDirs\)[\s\S]{0,120}rm\(dir,/.test(finallyBlock),
    "finally 必须真删临时 dataDir（受管清单逐个 rm，或直接 rm(dataDir)）",
  );
  assert.ok(finallyBlock.includes("rm(chromeProfile"), "finally 必须删临时 Chrome profile");
});

// ---------------------------------------------------------------------------
// 5) 双向判别力自证：删掉任一关键片段，本文件的守卫至少红一条
// ---------------------------------------------------------------------------

// 供自证用：本文件用到的守卫模式（每建一条守卫就往这里加一条）
const GUARDS = [
  /expect > 0 && expect === domTodo && expect === hintN && expect === annN/, // A 四方一致
  /titles\.length >= 5/, // B1 条数下限
  /sent\.length === 1 && sent\[0\]\.prompt === prompt && sent\[0\]\.sid === "sess-opengaps-main"/, // B3 恰好 1 条 + 逐字
  /sentBeforeClick === 1 && sent\.length === 1/, // D4 点它无效
  /if \(process\.env\.CODEX_SANDBOX\) \{/, // 沙箱自检
  /const NO_ANNOUNCE = Boolean\(process\.env\.TB_BENCH_NO_ANNOUNCE\);/, // 反证开关
  /const watchdog = setTimeout\(/, // 看门狗
  /try \{ chrome\?\.kill\("SIGKILL"\); \} catch/, // 清理
];

const CRITICAL = [
  ["沙箱自检", "if (process.env.CODEX_SANDBOX) {"],
  ["反证开关", "const NO_ANNOUNCE = Boolean(process.env.TB_BENCH_NO_ANNOUNCE);"],
  ["A 四方一致", "expect > 0 && expect === domTodo && expect === hintN && expect === annN"],
  ["B3 恰好投 1 条", 'sent.length === 1 && sent[0].prompt === prompt && sent[0].sid === "sess-opengaps-main"'],
  ["D4 点击无效", "sentBeforeClick === 1 && sent.length === 1"],
  ["看门狗", "const watchdog = setTimeout("],
];

test("守卫双向：删掉任一关键片段，本文件的守卫至少红一条（不是只会绿）", () => {
  // 自证前提：这些正则在原文件上必须全绿（否则「删了转红」可能只是碰巧）。
  for (const g of GUARDS) assert.ok(g.test(bench), `自证夹具失效：守卫 ${g} 在原文件上就该命中`);
  for (const [name, snippet] of CRITICAL) {
    const broken = bench.replace(snippet, "");
    assert.notEqual(broken, bench, `夹具必须真能删掉「${name}」（否则这条自证是假绿）`);
    assert.ok(GUARDS.some((g) => !g.test(broken)), `删掉「${name}」后必须至少有一条守卫转红`);
  }
});

// ---------------------------------------------------------------------------
// 6) 不许把台子改成「只会绿」的关键反例再钉两条
// ---------------------------------------------------------------------------

test("守卫：B3 不得退化成只比长度（正文与会话标识两句都要在）", () => {
  assert.ok(bench.includes("sent[0].prompt === prompt"), "B3 必须逐字比对投出的正文");
  assert.ok(bench.includes('sent[0].sid === "sess-opengaps-main"'), "B3 必须比对 sid（投给了别的会话不算）");
});

test("守卫：D4 不得退回 0→0 真空通过的写法", () => {
  assert.ok(!/sent\.length === sentBeforeClick/.test(bench), "D4 不得退回 0→0 真空通过的写法");
  assert.ok(bench.includes("sentBeforeClick === 1"), "D4 必须钉住「点前恰好 1 条」这个非零前提");
});
