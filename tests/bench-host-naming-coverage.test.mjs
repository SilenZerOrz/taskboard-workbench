/**
 * FR-95 守卫（真宿主侧）：「真宿主命名验证台」必须**持续**覆盖两条命名口径。
 *
 * 为什么需要这条：`tools/bench-host-naming.mjs` 是本仓**唯一**走「真 `dsh` 进程 + 真
 * `sessionController.rename` + 真会话流」的命名证据。它的第一版只覆盖**任务级**（口径 1）
 * ⇒「项目级 `【项目】` / 重建 / 重绑备注」（口径 2）在真宿主侧**等于没被走过**，
 * 只有桩宿主（`bench-rebind-deliver.mjs`）的证据。
 *
 * 2026-10-26 补齐 ⑧–⑫ 后，本测试防止这些断言被静默删掉；同时钉住取证助手的等待语义
 * —— 第一版助手「文件里有事件就 break」，对**已有历史**的会话会在改名落盘前收手，
 * 得到「没改名」的**假阴性**（用例 ⑫ 曾因此假红）。删掉 `until` 守卫 ⇒ 本测试变红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-host-naming.mjs"), "utf8");

test("FR-95-17：真宿主验证台必须覆盖项目级命名（口径 2）与任务级命名（口径 1）", () => {
  // 必须是**隔离真宿主**：临时 DSH_HOME + 独立数据目录（不许拿用户 :3080 / ~/.dsh 当靶子）
  assert.match(BENCH, /DSH_HOME: ISOLATED/, "必须用临时 DSH_HOME");
  assert.match(BENCH, /TB_DATA_DIR: path\.join\(ISOLATED, "tbdata"\)/, "必须用临时数据目录");
  assert.match(BENCH, /mkdtempSync\(path\.join\(os\.tmpdir\(\), "tb-bench-host-naming-"\)\)/, "必须是临时 home");

  // 口径 1（任务级）：名字形状 + 真落盘 + 无覆盖
  assert.match(BENCH, /\/\^【任务】\.\+ · \\d\{4\}-\\d\{2\}-\\d\{2\} \\d\{2\}:\\d\{2\}\$\//, "必须断言任务会话名形状");
  assert.match(BENCH, /e\.source\?\.kind === "user"/, "必须按会话流里的 user 落名事件判定");

  // 口径 2（项目级）：无指针不加备注 / 重建 / 重绑，三条都要在断言里
  assert.ok(BENCH.includes("`【项目】${PNAME}`"), "必须断言项目主会话名（无指针时不得凭空加备注）");
  assert.ok(BENCH.includes("`【项目】${PNAME}（重建）`"), "必须断言「重建」备注");
  assert.ok(BENCH.includes("`【项目】${PNAME}（重绑）`"), "必须断言「重绑」备注");
  assert.match(BENCH, /mode === "bind-existing"/, "改绑必须走 bind-existing 分支（不新建会话）");
  assert.match(BENCH, /r3\.after === s1/, "改绑后指针必须回到被绑会话本身");

  // 取证助手：不许「有事件就收手」（否则已有历史会话会得到假阴性）
  assert.ok(BENCH.includes("until"), "读取助手必须支持 until 条件等待");
  assert.match(BENCH, /if \(titleEvents\.length && \(!until \|\| until\(/, "必须等到条件满足才收手，不得「有事件就 break」");
});
