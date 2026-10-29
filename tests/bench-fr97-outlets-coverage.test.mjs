/**
 * FR-97 守卫：「两个调试出口」必须**持续**有一台隔离真宿主验证台。
 *
 * 为什么需要这条（卡 `-164`）：FR-97 曾只有进程内 API 测试（`tests/fr97-debug-outlets.test.mjs`）
 * 与 stub 宿主的 `bench-rebind-deliver.mjs`。两者都证明不了「真 `sendPrompt` 真把调试指令投进了
 * 项目主会话、真会话流里读得到」。`tools/bench-fr97-outlets.mjs` 补的正是这一跳。
 * 本测试钉住：① 隔离真宿主形态（临时 `DSH_HOME` + 最小 profile）；② 两个出口都走真 HTTP；
 * ③ 会话流原文判定（`session.v4.jsonl.zstd`，不是只看回包）；④ **归因门差分对照**；
 * ⑤ 人工校验任务的升级门不许被绕过。任一条被静默删掉 ⇒ 本测试变红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-fr97-outlets.mjs"), "utf8");

test("FR-97-台1：必须是**隔离真宿主**（临时 DSH_HOME + 最小 profile + 独立数据目录）", () => {
  assert.match(BENCH, /mkdtempSync\(path\.join\(os\.tmpdir\(\), "tb-bench-fr97-"\)\)/, "必须用临时 home");
  assert.match(BENCH, /DSH_HOME: ISOLATED/, "必须把 DSH_HOME 指到临时目录");
  assert.match(BENCH, /TB_DATA_DIR: path\.join\(ISOLATED, "tbdata"\)/, "必须用临时数据目录");
  assert.match(BENCH, /symlinkSync\(ROOT, path\.join\(PROFILE, "node_modules", "taskboard-workbench"\), "dir"\)/, "必须以软链装本插件（与全新 profile 同形）");
});

test("FR-97-台2：两个出口都要在真宿主上打真 HTTP", () => {
  assert.match(BENCH, /\/dispatch-main-session`/, "必须打 `dispatch-main-session`");
  assert.match(BENCH, /\/to-debug`/, "必须打 `to-debug`");
  assert.match(BENCH, /integrations\/taskboard-workbench\/api/, "必须经真宿主的插件前缀访问");
});

test("FR-97-台3：真落地判定要读**会话流原文**（不能只看回包说成功）", () => {
  assert.match(BENCH, /session\.v4\.jsonl\.zstd/, "必须解 zstd 读会话流");
  assert.ok(BENCH.includes("无法规范流转的问题（调试修复）"), "必须按调试指令标题做原文命中判定");
});

test("FR-97-台4：归因门做**差分对照**，人工校验门不许被绕过", () => {
  assert.match(BENCH, /EXECUTION_NOT_ATTRIBUTED/, "必须断言未归因被拒");
  assert.ok(BENCH.includes("before=") && BENCH.includes("after="), "必须同时报归因前/后两个读数（差分对照）");
  assert.match(BENCH, /HUMAN_REVIEW_NOT_EXECUTABLE/, "必须断言人工校验任务两个出口都拒");
  assert.match(BENCH, /human_review/, "必须真的造一张 `human_review` 卡来打这个门");
});

test("FR-97-台5：退出码契约（环境不具备 ⇒ 2，不算失败）", () => {
  assert.match(BENCH, /SKIP  环境不具备：找不到 dsh（退出码 2）/, "找不到 dsh 必须 SKIP + 2");
});
