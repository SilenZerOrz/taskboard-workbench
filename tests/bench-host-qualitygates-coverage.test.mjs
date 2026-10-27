/**
 * FR-50 守卫（真宿主侧）：`tools/bench-host-qualitygates.mjs` 必须**持续**覆盖
 * 「设置校验」与「门链按配置顺序进派发指令」这两条落点。
 *
 * 为什么需要这条：FR-50 的三条落点此前只有**单测**（纯函数 + 调用点）。卡 `-157` 的正题
 * （`loop.mjs#directiveFor` 按项目 `teamTemplate.qualityGates` 渲染、顺序＝声明顺序）在真宿主上
 * **从没验过**「配置进去、指令出来」。本台 2026-10-26 补上后，本测试防止：
 *   ① 有人删掉越界门被拒 / 同序 / 默认链注明来源 三条断言；
 *   ② 有人把门链断言误改成「读会话流」—— `deliverDispatched` 投的是**汇总行**，
 *      门链**不在**会话流里，那样改会得到永远的假红；
 *   ③ 拿掉 `readSessionText` 的 `until` 等待守卫（早收手 ⇒ 假阴性）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = readFileSync(path.join(ROOT, "tools/bench-host-qualitygates.mjs"), "utf8");

test("FR-50-17：真宿主验证台必须覆盖设置校验 + 门链同序 + 默认链来源", () => {
  // 必须是隔离真宿主
  assert.match(BENCH, /DSH_HOME: ISOLATED/, "必须用临时 DSH_HOME");
  assert.match(BENCH, /TB_DATA_DIR: path\.join\(ISOLATED, "tbdata"\)/, "必须用临时数据目录");
  assert.match(BENCH, /mkdtempSync\(path\.join\(os\.tmpdir\(\), "tb-bench-host-qg-"\)\)/, "必须是临时 home");

  // 落点一：保存前校验（越界门 ⇒ 拒绝且设置未变）
  assert.match(BENCH, /quality-gate-unknown/, "必须断言越界门的拒绝理由");
  assert.match(BENCH, /putBad\.code >= 400/, "必须断言越界门被拒（HTTP 层）");
  assert.match(BENCH, /gates1b\.join\(">"\) === "验证>需求"/, "必须断言被拒后设置**未被修改**");

  // 落点二：门链按配置顺序进派发指令，且**从回包断言**（不在会话流里）
  assert.match(BENCH, /loop1\.dispatched\?\.\[0\]\?\.directive/, "门链必须从 dispatched[].directive 断言");
  assert.ok(BENCH.includes("质量门（配置）：验证→需求"), "必须断言配置态门链逐项同序");
  assert.ok(BENCH.includes("质量门（默认）：需求→实现→验证→审查→集成"), "必须断言未配置态回落默认链并注明来源");
  assert.match(BENCH, /\(!includes \|\| text\.includes\(includes\)\)/, "读取助手必须支持条件等待（早收手 ⇒ 假阴性）");
  assert.match(BENCH, /includes: "\[任务工作台下发\]"/, "必须另证派发真落地到主会话（但不得用它断言门链）");
});
