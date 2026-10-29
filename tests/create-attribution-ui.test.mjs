/**
 * 守卫（2026-10-28 真机批注「很多卡片未关联项目需求」）：**建卡入口必须能当场归因**。
 *
 * 根因（本轮查实）：`POST /api/tasks` 早就接受 `requirementId`，CLI `tb task create` 也有
 * `--requirement/--unattributed-reason`，但 **Web「新建任务」对话框没有条目字段、提交体也不带它**
 * ⇒ 从界面建的卡必然无归因（服务端只回 warning），归因只能事后进抽屉补 —— 漏一次就留一张裸卡，
 * 这就是「无归因卡清零后还会再长出来」的那条缺口。
 *
 * 本守卫锁三件事：
 *   ① 对话框里有「需求条目」下拉，且明确标注留空后果；
 *   ② 提交体在建卡时带上 `requirementId`（编辑态不带 —— 改绑走专门入口）；
 *   ③ **不改门**：服务端建卡仍是「未归因 ⇒ warning」而不是硬拒（硬拒属口径变更，得另行拍板）。
 *
 * 只读源码文本，不起浏览器、不连网，毫秒级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const api = readFileSync(join(ROOT, "src", "server", "api.mjs"), "utf8");
const cli = readFileSync(join(ROOT, "cli", "tb.mjs"), "utf8");

test("对话框有「需求条目」下拉，并挂进表单", () => {
  assert.match(app, /const fRequirement = mk\("select"\)/, "必须新增需求条目下拉");
  assert.match(app, /fRequirement\.id = "tb-f-requirement"/, "下拉必须有稳定 id");
  assert.match(app, /field\("需求条目（归因；留空＝不归因，执行\/派发会被归因门拦下）", fRequirement, fRequirement\.id\)/,
    "下拉必须挂进表单，且标签写明留空后果");
});

test("下拉按本项目条目填充，取不到时只留「不归因」一项（不假装已归因）", () => {
  assert.match(app, /async function fillRequirementOptions\(task\)/);
  assert.match(app, /\/api\/requirements\/items\?project=\$\{encodeURIComponent\(state\.projectId\)\}/,
    "必须按当前项目拉条目");
  assert.match(app, /（不归因 —— 执行\/派发会被归因门拦下）/, "必须有不归因选项与明确后果");
});

test("编辑态只回显、不改绑（禁用下拉）", () => {
  assert.match(app, /if \(task\) \{\s*\n\s*fRequirement\.disabled = true;/,
    "编辑态必须禁用下拉，改绑走抽屉专门入口");
});

test("建卡提交体带 requirementId；编辑态不带", () => {
  assert.match(app, /requirementId: editing \? undefined : \(fRequirement\.value \|\| undefined\)/,
    "建卡必须把所选条目随 POST 一起提交");
});

test("不改门：服务端建卡仍是「未归因 ⇒ warning」，CLI 仍支持两参数", () => {
  assert.match(api, /该任务未归属需求条目：启动执行\/派发团队会被归因门拒绝/, "服务端 warning 必须在（硬拒属口径变更）");
  assert.match(cli, /"unattributed-reason"/, "CLI 必须仍支持 --unattributed-reason");
  assert.match(cli, /"requirement"/, "CLI 必须仍支持 --requirement");
});
