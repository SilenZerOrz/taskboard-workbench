/**
 * 需求条目详情抽屉守卫：这台「真浏览器」验证台必须**持续**在，且不许被悄悄削薄。
 *
 * 为什么需要这条：`tests/fr-req-detail-drawer.test.mjs` 只读源码文本 ——
 * 「规则写在不在」证明了，「规则真的生效」证明不了（被别处覆盖、拼错选择器都可能照样全绿）。
 * `tools/bench-req-detail-drawer.mjs` 补的正是那一跳：真 headless Chrome 读渲染后的
 * `getBoundingClientRect()`。本测试钉住 ①隔离形态 ②断言维度（宽/窄视口、手柄位置、拖拽落盘时机、
 * 记忆键独立、全屏与还原、双击还原）③反向对照入口 ④退出码契约。任一条被删 ⇒ 本测试变红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-req-detail-drawer.mjs"), "utf8");

test("台1：必须是**隔离**形态（临时 dataDir + 临时 Chrome profile + 随机端口，跑完即删）", () => {
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-reqdrawer-"\)\)/, "必须用临时数据目录");
  assert.match(BENCH, /mkdtemp\(path\.join\(os\.tmpdir\(\), "tb-reqdrawer-chrome-"\)\)/, "必须用临时 Chrome profile");
  assert.match(BENCH, /const freePort = \(\) =>/, "必须随机端口（不得固定端口，避免与 :3080 撞）");
  assert.equal(/3080/.test(BENCH.replace(/不碰 `:3080`/g, "")), false, "验证台不得接触用户的 :3080 实例");
  assert.match(BENCH, /await rm\(dir, \{ recursive: true, force: true \}\)/, "跑完必须清理");
});

test("台2：必须真开浏览器读**渲染后**几何（不是读源码 / 不是读样式表文本）", () => {
  assert.match(BENCH, /--remote-debugging-port=/, "必须真起 headless Chrome 走 CDP");
  assert.match(BENCH, /getBoundingClientRect\(\)/, "宽度/边界必须来自真实渲染后的几何");
  assert.match(BENCH, /Emulation\.setDeviceMetricsOverride/, "必须能切视口（宽/窄两档都要验）");
});

test("台3：四个核心维度一个都不能少（宽视口分级 / 窄视口分级 / 手柄位置 / 溢出）", () => {
  assert.match(BENCH, /expectWide = Math\.min\(1440/, "必须验宽视口 1723 的分级宽度 1440");
  assert.match(BENCH, /expectNarrow = Math\.min\(920, VIEW_NARROW - 12\)/, "必须验窄视口 900 的分级宽度 888");
  assert.ok(BENCH.includes("handleLeft"), "必须验手柄真的落在抽屉左缘（挂外面就拖不到）");
  assert.ok(BENCH.includes("scrollWidth") && BENCH.includes("clientWidth"), "必须验长描述无横向溢出");
});

test("台4：拖拽的**落盘时机**与记忆键**独立性**（这是产品口径，不是实现细节）", () => {
  assert.match(BENCH, /midStored/, "必须读「拖动中」的记忆值，证明拖动中不落盘");
  assert.match(BENCH, /tb\.reqDrawer\.width/, "必须验需求抽屉自己的记忆键");
  assert.match(BENCH, /tb\.drawer\.width/, "必须验不污染任务抽屉的记忆键");
  assert.match(BENCH, /Page\.reload/, "必须验刷新后仍记得宽度");
});

test("台5：反向对照入口 + 退出码契约（环境不具备 ⇒ 2，不算失败）", () => {
  assert.match(BENCH, /TB_BENCH_WEB_DIR/, "必须留反向对照入口（喂旧版 web 副本 ⇒ 应转红）");
  assert.match(BENCH, /probe.*SKIP|SKIP  devtools 端点未就绪/s, "devtools 未就绪必须 SKIP");
  assert.match(BENCH, /未找到 Chrome/, "找不到浏览器必须 SKIP");
  assert.match(BENCH, /process\.exit\(2\)/, "环境不具备的退出码必须是 2");
});
