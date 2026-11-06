/**
 * 守卫（2026-11-05 · 卡 `-227` / 需求 `R168`）：`tools/bench-config-session-jump.mjs` 必须**持续**证明
 * 「配置页会话关联能真的跳过去，跳不动时不撒谎」。
 *
 * 为什么需要这条：本轮的断言对象是**跨进程副作用**（`openSession(id)` 到底有没有被调用、id 对不对），
 * 源码里 grep 得出"有个按钮"完全不够。后来者若为了让台子变绿而删掉「id 精确相等」或「不得谎称已打开」，
 * 台子会永久全绿却什么都没证明 —— 与 `-224` / `-225` / `-226` 三台守卫同一条规矩。
 *
 * 钉住九件事：
 *   ① 台必须要求「打开会话」数量 = 4（只看 `every()` 时 0 个按钮会**真空通过**，本台首版真踩过）；
 *   ② 台必须断言 `openSession` 收到**精确 id**（主会话 / 已批准 / 待批准各一条）；
 *   ③ 台必须断言"无客户端通道时**不得**谎称已打开"（且要出现「无法直接跳转」）；
 *   ④ 台必须断言 hostless 下**置灰 + title 说明**（能力门），且数量仍为 4；
 *   ⑤ 台必须保留 `TB_BENCH_WEB_DIR` 反证入口、沙箱自检与退出码；
 *   ⑥ `web/app.js` 必须有 `openSessionJump`，且**先**调 `openHostSession`、成功后才 `bringConversationToFront`；
 *   ⑦ 失败/无通道分支必须复制标识（`copyText`），不能静默；
 *   ⑧ 主会话行与每条会话行都必须有 `hostBtn("打开会话", …)`（文案命中 `HOST_BUTTON_LABELS` ⇒ 自动置灰）；
 *   ⑨ 会话行标签必须挂 `title`（完整标识；截断文本不再丢信息）。
 *
 * 本文件只读源码文本（不起浏览器、不连网），毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const bench = readFileSync(join(ROOT, "tools/bench-config-session-jump.mjs"), "utf8");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");

test("守卫：`-227` 台必须要求「打开会话」数量 = 4（防空数组真空通过）", () => {
  assert.match(bench, /jumpsOn\.length === 4/, "必须同时要求数量 = 4");
  assert.match(bench, /jumpsOn\.every\(\(r\) => r\.disabled === false\)/, "必须断言一个都不许置灰");
  assert.match(bench, /真空通过/, "必须在注释里写明为什么不能只看 every()");
});

test("守卫：`-227` 台必须断言 openSession 收到精确 id", () => {
  assert.match(bench, /spy1\[0\] === IDS\.main/, "主会话必须精确相等");
  assert.match(bench, /spy2\[1\] === IDS\.approved\[0\]/, "已批准那条必须精确相等");
  assert.match(bench, /spy3\[2\] === IDS\.pending/, "待批准那条必须精确相等");
  assert.match(bench, /openSession: \(id\) => \{ window\.__SPY__\.push\(String\(id\)\)/, "必须在页内装 spy 通道");
});

test("守卫：`-227` 台必须断言「无客户端通道时不得谎称已打开」", () => {
  assert.match(bench, /!String\(autoBanner\.info \?\? ""\)\.includes\("已打开会话"\)/, "不得出现「已打开会话」");
  assert.match(bench, /String\(autoBanner\.error \?\? ""\)\.includes\("无法直接跳转"\)/, "必须如实说明无法直接跳转");
});

test("守卫：`-227` 台必须断言 hostless 置灰 + title 说明，且数量仍为 4", () => {
  assert.match(bench, /jumpOff\.length === 4/, "hostless 下仍需 4 个入口（只是置灰）");
  assert.match(bench, /r\.disabled === true && r\.title\.includes\("无宿主会话通道"\)/, "必须断言置灰且带说明");
});

test("守卫：`-227` 台必须保留反证入口、沙箱自检与退出码", () => {
  assert.match(bench, /process\.env\.TB_BENCH_WEB_DIR/, "必须能换 web/ 做反证");
  assert.match(bench, /process\.env\.CODEX_SANDBOX/, "沙箱内必须自检退出（AGENTS §7）");
  assert.match(bench, /process\.exit\(2\)/, "环境不具备必须退出码 2");
  assert.match(bench, /process\.exit\(1\)/, "失败必须体现在退出码上");
});

test("守卫：`openSessionJump` 必须先走客户端导航、成功后才把「对话」视图带到前台", () => {
  assert.match(app, /const openSessionJump = \(sid\) => \{/, "必须有跳转入口");
  assert.match(app, /if \(!openHostSession\) \{/, "必须先判客户端通道存在");
  assert.match(app, /result = openHostSession\(target\)/, "必须真的调用客户端导航");
  assert.match(app, /if \(result\?\.ok\) \{\s*bringConversationToFront\(doc, target\);/, "成功后才 bringConversationToFront");
});

test("守卫：失败/无通道分支必须复制标识，不能静默", () => {
  const noChannel = app.slice(app.indexOf("if (!openHostSession) {"), app.indexOf("let result = null;"));
  assert.match(noChannel, /copyText\(target\)/, "无通道时必须复制标识");
  assert.ok(!noChannel.includes("已打开会话"), "无通道分支**不得**出现「已打开会话」");
  const failBranch = app.slice(app.indexOf("void copyText(target);\n      showBanner(`打开会话失败"), app.indexOf("const mainRow = sessList.main"));
  assert.match(failBranch, /已复制会话标识/, "失败分支必须说明已复制");
});

test("守卫：主会话行与会话行都必须有 hostBtn(\"打开会话\")", () => {
  const mainBlock = app.slice(app.indexOf("const mainLabel = mk(\"span\", null, `主会话 ·"), app.indexOf("const bindBar = mk(\"div\", \"tb-bind-bar\")"));
  assert.match(mainBlock, /hostBtn\("打开会话", \(\) => openSessionJump\(mainRow\.sessionId\)\)/, "主会话行必须有入口");
  const sessBlock = app.slice(app.indexOf("const sessLabel = mk(\"span\", null,"), app.indexOf("} else links.appendChild(mk(\"p\", \"hint\", \"暂无其它会话申请\"))"));
  assert.match(sessBlock, /hostBtn\("打开会话", \(\) => openSessionJump\(s\.sessionId\)\)/, "每条会话行必须有入口");
  assert.match(mainBlock, /mainLabel\.title = String\(mainRow\.sessionId\)/, "主会话标签必须挂完整标识");
  assert.match(sessBlock, /sessLabel\.title = String\(s\.sessionId\)/, "会话标签必须挂完整标识");
});

test("守卫：`row()` 支持节点 label（否则 title 挂不上去）", () => {
  assert.match(app, /r\.appendChild\(label && label\.nodeType \? label : mk\("span", null, label\)\)/, "row 必须兼容节点 label");
});
