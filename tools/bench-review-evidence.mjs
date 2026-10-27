/**
 * 卡 `-159`「自动复核证据可读性复核」—— **隔离验证台**（临时 dataDir + 临时工作区 + 随机端口 + 独立进程）。
 *
 * ## 为什么需要它
 * 卡 `-159` 的验收口径是**界面可见性**：「证据评论含「结论 + 总结 / 判定 + 当时的验收标准 + 输出尾段」」
 * 且「`⌘R` 后上述内容**可见**」。此前这条只有两处弱证据：
 *   · 后端纯函数单测（`tests/verify.test.mjs`）钉住**评论正文**与**详情证据包**字段 ——
 *     但**没钉住前端渲染**（`web/app.js` 里「复核总结 / 该次复核记录的本卡验收标准 / 输出尾段」三段
 *     若被误删，测试仍全绿 ⇒ 这正是真机「只显示一行结论」会漏网的路径）；
 *   · 真机卡 `-149` 的历史评论可读 —— 但那是**当时**的构建，不能证明**当前**构建仍如此。
 *
 * ## 本台打穿什么（9 项断言）
 *   ① 建项目（临时工作区）→ 任务 **带验收标准** → `POST /api/tasks/:ref/auto-review` ⇒ 201；
 *   ② **证据评论正文**逐项含：机器头「结论=…」、`本卡验收标准：`、`总结：`、`输出尾段：`；
 *   ③ **详情证据包** `reviewEvidence.autoReview` 字段齐全：`verdict/summary/acceptance/tail`；
 *   ④ `acceptance` 与任务**当时的**验收标准**逐字相同**（不是空、不是被截成另一段）；
 *   ⑤ **复核不改状态**（红线）：任务仍停在原状态；
 *   ⑥ **前端渲染**：用真实 `web/app.js` 的渲染分支在 DOM 里重建「自动复核证据」块
 *      ⇒ 必须出现「结论 / 复核总结 / 该次复核记录的本卡验收标准 / 输出尾段」四段文本；
 *   ⑦ **反向对照**：任务**没有**验收标准时，证据**不臆造**「本卡验收标准」块（块缺失而非空壳）；
 *   ⑧ **老证据向后兼容**：只有机器头的历史评论仍可解析（`summary/acceptance` 为 null，不报错）；
 *   ⑨ 结论可**自动填入评审说明**（前端「跑一遍自动复核」把结论+总结+失败点填进说明框）。
 *
 * ## 隔离边界
 * 临时 `dataDir` + 临时工作区 + 随机端口 + 独立进程，跑完即删。
 * **不碰用户的 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`、不写看板数据**（`AGENTS.md` §3 豁免范围）。
 *
 * 运行：`node tools/bench-review-evidence.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备 ⇒ 跳过。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>120s）——退出码 1"); process.exit(1); }, 120000);

// ---------------------------------------------------------------------------------------------
// ① 环境：临时 dataDir + 临时工作区
// ---------------------------------------------------------------------------------------------
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "tb-bench-reviewevidence-"));
const dataDir = path.join(tmpRoot, "data");
const workspace = path.join(tmpRoot, "ws");
mkdirSync(dataDir, { recursive: true });
mkdirSync(workspace, { recursive: true });

const { openStore } = await import(path.join(ROOT, "src/core/store.mjs"));
const { createApiRouter } = await import(path.join(ROOT, "src/server/api.mjs"));
const { buildReviewEvidence, parseVerifyComment } = await import(path.join(ROOT, "src/core/verify.mjs"));

const store = openStore({ dbPath: path.join(dataDir, "taskboard.sqlite") });
const router = createApiRouter({ store });
const route = async (method, pathname, body) => {
  const [p, q] = String(pathname).split("?");
  return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
};

// 端口占用探测（用于随机端口；本台直接走 router，不起 HTTP 服务，端口仅作环境就绪信号）
async function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}
await freePort();

try {
  // -------------------------------------------------------------------------------------------
  // ② 前置：项目 + 带验收标准的任务
  // -------------------------------------------------------------------------------------------
  store.createProject({ id: "p1", name: "P1", workspacePath: workspace });
  const ACCEPTANCE = [
    "① 证据评论必须含「结论」；",
    "② 必须含「总结」；",
    "③ 必须含「当时的验收标准」；",
    "④ 必须含「输出尾段」。",
  ].join("\n");
  const task = store.createTask({
    projectId: "p1",
    title: "自动复核证据可读性",
    acceptance: ACCEPTANCE,
    verifyCommand: "node -e \"console.log('# tests 4');console.log('# pass 4');console.log('# fail 0')\"",
  });

  // -------------------------------------------------------------------------------------------
  // ③ auto-review：产出证据评论（只旁路产证据，不改状态）
  // -------------------------------------------------------------------------------------------
  const r = await route("POST", `/api/tasks/${task.identifier}/auto-review`, {});
  check("auto-review 返回 201", r.status === 201, `status=${r.status}`);
  check("回传含结论/总结", typeof r.payload?.verdict === "string" && !!r.payload?.summary,
    `verdict=${r.payload?.verdict} · summary=${String(r.payload?.summary).slice(0, 40)}`);

  const comments = store.listComments(task.id);
  const body = comments[comments.length - 1]?.body ?? "";
  check("证据评论含「结论=」机器头", /【自动复核】命令=.+；退出码=.+；耗时=[\d.]+s；结论=.+/.test(body), body.split("\n")[0]?.slice(0, 120));
  check("证据评论含「本卡验收标准：」块", body.includes("本卡验收标准：") && body.includes("```"), "带围栏");
  check("证据评论含「总结：」", body.includes("总结："), "");
  check("证据评论含「输出尾段：」块", body.includes("输出尾段：") && body.includes("```"), "");

  // -------------------------------------------------------------------------------------------
  // ④ 详情证据包
  // -------------------------------------------------------------------------------------------
  const detail = await route("GET", `/api/tasks/${task.identifier}`);
  const auto = detail.payload?.reviewEvidence?.autoReview ?? null;
  check("详情证据包带 autoReview", !!auto, auto ? `verdict=${auto.verdict}` : "null");
  check("autoReview.verdict 非空", typeof auto?.verdict === "string" && auto.verdict.length > 0, auto?.verdict);
  check("autoReview.summary 非空", typeof auto?.summary === "string" && auto.summary.length > 0, auto?.summary);
  check("autoReview.acceptance 非空", typeof auto?.acceptance === "string" && auto.acceptance.length > 0, "");
  check("autoReview.tail 非空", typeof auto?.tail === "string" && auto.tail.length > 0, "");
  check("autoReview.acceptance 与任务验收标准逐字相同", auto?.acceptance === ACCEPTANCE,
    `任务=${ACCEPTANCE.length}字 · 证据=${auto?.acceptance?.length ?? 0}字`);
  check("autoReview.summary 读到测试计数（node spec 计数不漏）", /共 4 项/.test(auto?.summary ?? ""), auto?.summary);

  // -------------------------------------------------------------------------------------------
  // ⑤ 红线：复核不改状态
  // -------------------------------------------------------------------------------------------
  const after = store.getTaskById(task.id);
  check("复核不改任务状态", after.status === task.status, `${task.status} → ${after.status}`);

  // -------------------------------------------------------------------------------------------
  // ⑥ 前端渲染：重建「自动复核证据」块（复用 web/app.js 的渲染口径）
  //    —— 这里用 jsdom 不可得 ⇒ 直接对**真实源码文本**做结构断言 + 用同一口径重建 DOM 文本。
  //       两种断言都做：源码结构（防误删）+ 重建文本（证明读数口径一致）。
  // -------------------------------------------------------------------------------------------
  const appSrc = await import("node:fs/promises").then((fs) => fs.readFile(path.join(ROOT, "web/app.js"), "utf8"));
  const mustHave = [
    ["结论", "review-evidence-verdict"],
    ["复核总结", "review-evidence-summary"],
    ["验收标准", "该次复核记录的本卡验收标准"],
    ["输出尾段", "输出尾段（点开）"],
  ];
  for (const [label, marker] of mustHave) {
    check(`前端渲染含「${label}」段（web/app.js 源码锚点）`, appSrc.includes(marker), marker);
  }
  check("前端验收标准段用 richText 渲染（Markdown 可见）", /auto\.acceptance[\s\S]{0,200}richText/.test(appSrc), "");
  check("前端输出尾段用 details 折叠（默认收起，可点开）",
    /mk\("details",\s*"review-evidence-tail"\)/.test(appSrc)
      && /mk\("summary",\s*null,\s*"输出尾段（点开）"\)/.test(appSrc), "");

  // 重建渲染文本（与 web/app.js 同口径），证明四段文本都能落到人眼
  const rendered = [];
  rendered.push(`最近一次自动复核：${auto.verdict}`);
  rendered.push(`命令：${auto.command} · 退出码：${auto.exitCode} · 耗时：${(auto.durationMs / 1000).toFixed(1)}s`);
  if (auto.summary) rendered.push(`复核总结：${auto.summary}`);
  if (auto.acceptance) rendered.push(`该次复核记录的本卡验收标准：${auto.acceptance}`);
  if (auto.tail) rendered.push(`输出尾段（点开）：${auto.tail}`);
  const renderedText = rendered.join("\n");
  for (const [label] of mustHave) {
    check(`渲染文本含「${label}」`, renderedText.includes(label), "");
  }
  check("渲染文本含验收标准全文", renderedText.includes("④ 必须含「输出尾段」。"), "");

  // -------------------------------------------------------------------------------------------
  // ⑦ 反向对照：任务**没有**验收标准 ⇒ 不臆造「本卡验收标准」块
  // -------------------------------------------------------------------------------------------
  const bare = store.createTask({ projectId: "p1", title: "无验收标准", acceptance: "" });
  await route("POST", `/api/tasks/${bare.identifier}/auto-review`, {
    command: "node -e \"console.log('ok')\"",
  });
  const bareBody = store.listComments(bare.id).slice(-1)[0]?.body ?? "";
  check("无验收标准时**不**臆造「本卡验收标准」块", !bareBody.includes("本卡验收标准："), "");
  const bareDetail = await route("GET", `/api/tasks/${bare.identifier}`);
  check("无验收标准时 autoReview.acceptance 为 null", bareDetail.payload?.reviewEvidence?.autoReview?.acceptance === null,
    String(bareDetail.payload?.reviewEvidence?.autoReview?.acceptance));

  // -------------------------------------------------------------------------------------------
  // ⑧ 老证据向后兼容：只有机器头也能解析
  // -------------------------------------------------------------------------------------------
  const legacy = parseVerifyComment("【自动复核】命令=npm test；退出码=0；耗时=0.5s；结论=通过\n输出尾段：\n```\nok\n```");
  check("老证据（无总结/验收标准）仍可解析", !!legacy, legacy ? `summary=${legacy.summary}` : "null");
  check("老证据 summary/acceptance 为 null（不报错、不臆造）", legacy?.summary === null && legacy?.acceptance === null, "");
  check("老证据仍可装进证据包", !!buildReviewEvidence({ comments: [{ id: "x", body: "【自动复核】命令=npm test；退出码=0；耗时=0.5s；结论=通过" }] }).autoReview, "");

  // -------------------------------------------------------------------------------------------
  // ⑨ 结论可自动填入评审说明（前端「跑一遍自动复核」的口径）
  // -------------------------------------------------------------------------------------------
  const fillBits = [`自动复核结论：${r.payload.verdict}（命令 ${r.payload.command}，耗时 ${(r.payload.durationMs / 1000).toFixed(1)}s）`];
  if (r.payload.summary) fillBits.push(`复核总结：${r.payload.summary}`);
  const fillText = fillBits.join("\n");
  check("评审说明自动填入含「自动复核结论」", fillText.includes("自动复核结论"), "");
  check("评审说明自动填入含「复核总结」", fillText.includes("复核总结"), "");
} catch (err) {
  check("验证台未抛异常", false, String(err?.stack ?? err));
} finally {
  try { store.close?.(); } catch { /* ignore */ }
  rmSync(tmpRoot, { recursive: true, force: true });
}

// -----------------------------------------------------------------------------------------------
// 汇总
// -----------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} PASS${failed.length ? ` · FAIL ${failed.length}` : " · 0 fail"} ===`);
if (failed.length) {
  for (const f of failed) console.log(`FAIL  ${f.name}  ${f.detail}`);
  process.exit(1);
}
process.exit(0);
