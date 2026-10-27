#!/usr/bin/env node
/**
 * 卡 `-145` 验收② · 在途卡评论「§二 四节」格式对照表（**只读产物**）。
 *
 * 用途：把「人肉抽查」变成可复跑命令 —— 每轮收尾跑一次，看在途卡评论是否已按
 * `docs/规范/01-协作规范.md` §二 四节（判定 / 偏离说明 / 边界自查 / 产物路径）书写。
 *
 * 口径（与 §二 / §七.2 一致）：
 *   · **只读**：全程只 `listTasks` / `listComments`，**不写库、不改任何历史评论**。
 *   · **机器自动评论不计入缺口**：`🤖 CLI 执行器…` / `⛔ CLI 执行器…` 开头的评论由代码模板生成，
 *     本轮起该模板本身已四节化，故它**单独统计**，不与人工评论混在一起凑分。
 *   · **判定为缺**：该卡全部人工评论里该节**一次都没出现**。
 *
 * 用法：
 *   node tools/format-comment-audit.mjs                 # 人读表格
 *   node tools/format-comment-audit.mjs --json          # 机读
 *   TB_DATA_DIR=.data node tools/format-comment-audit.mjs   # 指定库
 */
import { openStore } from "../src/core/store.mjs";

const json = process.argv.includes("--json");
const dataDir = process.env.TB_DATA_DIR ?? ".data";

/** §二 四节的识别式（与 tests/collab-format.test.mjs 同一口径，防两处分叉）。 */
const SECTIONS = [
  ["判定", /\*\*判定\*\*|\b判定\s*[:：]|判定：\s*(完成|部分|停下)/],
  ["偏离说明", /\*\*偏离说明\*\*|偏离说明|偏离\s*[:：]/],
  ["边界自查", /\*\*边界自查\*\*|边界自查/],
  ["产物路径", /\*\*产物路径\*\*|产物路径|落盘(报告|路径)|产物\s*[:：]/],
];

const MACHINE_COMMENT = /^[🤖⛔]\s*CLI 执行器/;

/** 只读打开（走项目自身的库，不建临时目录）。 */
function readOnlyStore(dir) {
  return openStore({ dataDir: dir });
}

function auditComments(comments) {
  const manual = comments.filter((c) => !MACHINE_COMMENT.test(String(c.body ?? "")));
  const machine = comments.filter((c) => MACHINE_COMMENT.test(String(c.body ?? "")));
  const hits = {};
  for (const [name, re] of SECTIONS) {
    hits[name] = manual.some((c) => re.test(String(c.body ?? "")));
  }
  return { total: comments.length, manual: manual.length, machine: machine.length, hits };
}

function main() {
  const store = readOnlyStore(dataDir);
  try {
    const inFlight = new Set(["in_progress", "in_review", "todo", "blocked"]);
    const rows = [];
    for (const project of store.listProjects()) {
      for (const t of store.listTasks({ projectId: project.id })) {
        if (!inFlight.has(t.status)) continue;
        const comments = store.listComments(t.identifier);
        rows.push({
          project: project.id,
          task: t.identifier,
          status: t.status,
          ...auditComments(comments),
        });
      }
    }
    rows.sort((a, b) => (a.project + a.task).localeCompare(b.project + b.task));

    const summary = { cards: rows.length, comments: rows.reduce((n, r) => n + r.total, 0) };
    for (const [name] of SECTIONS) {
      summary[name] = { covered: rows.filter((r) => r.hits[name]).length, total: rows.length };
    }

    if (json) { console.log(JSON.stringify({ summary, rows }, null, 2)); return; }

    console.log(`# 在途卡评论 §二 四节格式对照表（只读快照）`);
    console.log(`> 口径：判定/偏离说明/边界自查/产物路径 四节是否出现在该卡的人工评论中；`);
    console.log(`> 🤖/⛔ CLI 执行器自动评论单独计数，不与人工评论混算。**本命令不写库、不改历史评论。**`);
    console.log();
    console.log(`在途卡 ${summary.cards} 张 · 评论 ${summary.comments} 条\n`);
    console.log(`| 项目 | 卡 | 状态 | 评论(人工/机器) | 判定 | 偏离说明 | 边界自查 | 产物路径 |`);
    console.log(`| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |`);
    for (const r of rows) {
      const mark = (k) => (r.hits[k] ? "✅" : "缺");
      console.log(`| ${r.project} | ${r.task} | ${r.status} | ${r.manual}/${r.machine} | ${mark("判定")} | ${mark("偏离说明")} | ${mark("边界自查")} | ${mark("产物路径")} |`);
    }
    console.log();
    console.log(`覆盖汇总：` + SECTIONS.map(([n]) => `${n} ${summary[n].covered}/${summary[n].total}`).join(" · "));
  } finally {
    store.close();
  }
}

main();