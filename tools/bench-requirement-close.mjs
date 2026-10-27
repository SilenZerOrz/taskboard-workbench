/**
 * 「需求条目 → 完成」—— **真进程验证台**（目标路径里**唯一从未被现实走过**的一跳）。
 *
 * 为什么需要它：目标链路写的是「需求条目 → 看板派发 → `cli:claude` 真跑 → 证据回流 → 人工验收」，
 * 而真机上**需求条目 122 条全部停在 `open`** —— 即「需求 → 完成」这一跳**从来没有被现实走过一次**。
 * FR-91 已实现该能力（状态白名单 `draft/open/done/closed` · `summarizeRequirementCompletion` ·
 * `GET …/completion` · PATCH 落审计 `requirement-status`），但**没有一条可复跑证据**证明它端到端成立。
 * 本台把这一跳做成可复跑证据：临时 `dataDir` + 临时工作区 + 随机端口 + 独立进程 + 离线替身 CLI，
 * 跑完即删，**不碰用户的 `:3080` 与用户看板数据**（`AGENTS.md` §3 豁免面）。
 *
 * 断言的要害是**语义**而不是实现：
 *   ① 归因门仍然生效（未归因的卡**不得**被 CLI 真跑）；
 *   ② 完成度随关联任务状态**如实**变化（`no-tasks` → `in-progress` → `in-review` → `all-closed`），
 *      **没到 `all-closed` 就绝不 `ready`**（不谎报完成）；
 *   ③ 需求终态**由人 PATCH** 才落地，并落审计 `requirement-status`；
 *   ④ 需求收口**不等于**任务收口（任务没做完时，收口需求后完成度依然如实报 `in-progress`）；
 *   ⑤ 终态可「重新打开」，与 FR-91 口径一致。
 *
 * 运行：`node tools/bench-requirement-close.mjs`（秒级；不联网、不调真实 claude）
 * 退出码：0 = 全 PASS；1 = 有 FAIL。
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer, ensureDefaultProject } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqclose-data-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "tb-reqclose-ws-"));
const binDir = await mkdtemp(path.join(os.tmpdir(), "tb-reqclose-bin-"));
const stub = path.join(binDir, "fake-claude");
await writeFile(stub, "#!/bin/sh\nmkdir -p .bench-out && echo ok > .bench-out/ran.txt\necho 'bench-stub: 改动摘要 / 验证结果 / 遗留风险 三段齐备'\nexit 0\n", "utf8");
await chmod(stub, 0o755);
process.env.TB_CLI_EXECUTOR_BIN = stub;

const store = openStore({ dataDir, env: {} });
ensureDefaultProject(store);
const server = createServer({ store, webDir: path.join(ROOT, "web") });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const call = async (method, urlPath, body) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let payload = null;
  try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, payload };
};
const codeOf = (r) => r?.payload?.error?.code ?? null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// **看板派发是异步的**：`/execution-loop` 的 tick 返回时任务已被置「进行中」，CLI 跑完才转「待验收」
// ⇒ 必须轮询等状态，不能 tick 完立刻断言（`bench-auto-advance` 同此口径）。
const waitFor = async (ref, predicate, timeoutMs = 25000) => {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const r = await call("GET", `/api/tasks/${ref}`);
    last = r.payload?.task ?? null;
    if (last && predicate(last)) return last;
    await sleep(120);
  }
  return last;
};

const projectId = "reqclose";
try {
  // ---- 0. 建台内项目 + CLI 执行器 --------------------------------------------------------
  const created = await call("POST", "/api/projects", { id: projectId, name: "需求收口验证台", workspacePath: workspace });
  check("建台内项目（workspacePath=临时目录）", created.status === 201 || created.status === 200, `status=${created.status}`);
  const settings = await call("PUT", `/api/projects/${projectId}/settings`, {
    teamTemplate: {
      engine: "instruction",
      roles: [{ role: "engineer", executor: "cli:claude", count: 1 }],
      forbiddenExecutors: [],
      engineer: { executor: "cli:claude", verifyCommand: "echo bench-verify-ok" },
    },
  });
  check("项目设置：engineer.executor = cli:claude", settings.status === 200, `status=${settings.status}`);

  // ---- 1. 需求文档 + 需求条目（终态起点 = open） -----------------------------------------
  const doc = await call("POST", "/api/requirements/docs", { projectId, body: "# 验证台需求\n\n用于「需求 → 完成」一跳的端到端取证。\n" });
  check("建需求文档 201（新建，existed=false）", doc.status === 201 && doc.payload?.doc?.id && doc.payload?.existed === false, `status=${doc.status} existed=${doc.payload?.existed}`);
  const docId = doc.payload.doc.id;

  const made = await call("POST", "/api/requirements/items", { projectId, title: "验证台需求条目 R1", docId });
  const item = made.payload?.item;
  check("建需求条目 201（初始状态 open）", made.status === 201 && item?.identifier && item.status === "open", `status=${made.status} item=${item?.identifier} status=${item?.status}`);

  let comp = await call("GET", `/api/requirements/items/${item.identifier}/completion`);
  check("无关联任务 ⇒ 完成度 no-tasks / ready=false（不谎报）", comp.payload?.verdict === "no-tasks" && comp.payload?.ready === false, `verdict=${comp.payload?.verdict} ready=${comp.payload?.ready}`);

  // ---- 2. 归因门：未归因的卡不得被 CLI 真跑 ---------------------------------------------
  const t1 = await call("POST", "/api/tasks", { projectId, title: "验证台任务 T1", status: "todo" });
  const task = t1.payload?.task;
  check("建任务 201（todo）", t1.status === 201 && task?.identifier && task.status === "todo", `status=${t1.status} task=${task?.identifier}`);
  const gate = await call("POST", `/api/tasks/${task.identifier}/exec-cli`, { timeoutMs: 60000 });
  check("归因门前置：未归因卡 exec-cli 被拒（EXECUTION_NOT_ATTRIBUTED）", gate.status >= 400 && codeOf(gate) === "EXECUTION_NOT_ATTRIBUTED", `status=${gate.status} code=${codeOf(gate)}`);

  const att = await call("POST", `/api/tasks/${task.identifier}/attribution`, { requirement: item.identifier });
  check("归因成功（写入 requirementId）", att.status === 200 && att.payload?.task?.requirementId === item.id, `status=${att.status} requirementId=${att.payload?.task?.requirementId}`);

  comp = await call("GET", `/api/requirements/items/${item.identifier}/completion`);
  check("任务仍 todo ⇒ 完成度 in-progress / ready=false", comp.payload?.verdict === "in-progress" && comp.payload?.ready === false, `verdict=${comp.payload?.verdict} ready=${comp.payload?.ready}`);

  // ---- 3. 派发：CLI 真跑 → 任务停「待验收」；完成度随动 in-review（仍不 ready） -----------
  const ran = await call("POST", `/api/tasks/${task.identifier}/exec-cli`, { timeoutMs: 60000 });
  const afterRun = await call("GET", `/api/tasks/${task.identifier}`);
  check("CLI 执行器跑通（ran=true）", ran.status === 200 && ran.payload?.ran === true, `status=${ran.status} ran=${ran.payload?.ran}`);
  check("执行后任务停「待验收」in_review", afterRun.payload?.task?.status === "in_review", `status=${afterRun.payload?.task?.status}`);
  const { existsSync } = await import("node:fs");
  const produced = existsSync(path.join(workspace, ".bench-out", "ran.txt"));
  check("替身 CLI 真在工作区落盘（.bench-out/ran.txt）", produced, `path=${path.join(workspace, ".bench-out", "ran.txt")}`);

  comp = await call("GET", `/api/requirements/items/${item.identifier}/completion`);
  check("任务 in_review ⇒ 完成度 in-review / ready=false（不谎报）", comp.payload?.verdict === "in-review" && comp.payload?.ready === false, `verdict=${comp.payload?.verdict} ready=${comp.payload?.ready}`);

  // ---- 4. 人工验收：把任务点 done ⇒ 完成度置 all-closed / ready=true ---------------------
  // 产品口径：任务更新走**乐观并发**（`MISSING_VERSION` 拒绝无版本的写入）—— 人点 done 也必须带 version。
  const liveVersion = afterRun.payload?.task?.version;
  const done = await call("PATCH", `/api/tasks/${task.identifier}`, { status: "done", version: liveVersion });
  check("人点任务 done（PATCH 200 · 带 expectedVersion）", done.status === 200 && done.payload?.task?.status === "done", `status=${done.status} code=${codeOf(done)} version=${liveVersion}`);
  comp = await call("GET", `/api/requirements/items/${item.identifier}/completion`);
  check("关联任务全收口 ⇒ 完成度 all-closed / ready=true（可判定需求完成）", comp.payload?.verdict === "all-closed" && comp.payload?.ready === true, `verdict=${comp.payload?.verdict} ready=${comp.payload?.ready}`);

  // ---- 5. 需求终态由人 PATCH 落地 + 落审计 ----------------------------------------------
  const close = await call("PATCH", `/api/requirements/items/${item.identifier}`, { status: "done", actor: "human", reason: "关联任务已全部收口" });
  check("人把需求条目置 done（PATCH 200）", close.status === 200 && close.payload?.item?.status === "done", `status=${close.status} item.status=${close.payload?.item?.status}`);
  const audit = store.listGovernanceAudit({ action: "requirement-status" });
  check("需求终态落审计 requirement-status（命中本条 identifier）", audit.some((a) => a.target === item.identifier && a.reason === "done"), `audits=${audit.length}`);

  const bad = await call("PATCH", `/api/requirements/items/${item.identifier}`, { status: "bogus" });
  check("负向：非法状态被拒（INVALID_FIELD）", bad.status >= 400 && codeOf(bad) === "INVALID_FIELD", `status=${bad.status} code=${codeOf(bad)}`);

  // ---- 6. 需求收口 ≠ 任务收口（另一条：任务未做完也允许收口，但完成度不谎报） -------------
  const made2 = await call("POST", "/api/requirements/items", { projectId, title: "验证台需求条目 R2", docId });
  const item2 = made2.payload?.item;
  // 用 `backlog`（而非 `todo`）：第 8 段要用执行循环 tick，`todo` 会被顺带派发 ⇒ 保持台子确定性。
  const t2 = await call("POST", "/api/tasks", { projectId, title: "验证台任务 T2", status: "backlog" });
  await call("POST", `/api/tasks/${t2.payload.task.identifier}/attribution`, { requirement: item2.identifier });
  const forced = await call("PATCH", `/api/requirements/items/${item2.identifier}`, { status: "closed", actor: "human", reason: "强制收口（关联任务未做完）" });
  const comp2 = await call("GET", `/api/requirements/items/${item2.identifier}/completion`);
  check("强制收口允许（closed）但完成度仍如实 in-progress（收口≠任务收口）", forced.status === 200 && forced.payload?.item?.status === "closed" && comp2.payload?.verdict === "in-progress", `item.status=${forced.payload?.item?.status} verdict=${comp2.payload?.verdict}`);

  // ---- 7. 终态可重新打开 ----------------------------------------------------------------
  const reopen = await call("PATCH", `/api/requirements/items/${item.identifier}`, { status: "open", actor: "human" });
  check("终态「重新打开」→ open 200", reopen.status === 200 && reopen.payload?.item?.status === "open", `status=${reopen.status} item.status=${reopen.payload?.item?.status}`);

  // ---- 8. 完整路径复证：改走「**看板派发**」（执行循环自动 tick）跑同一条链 -----------------
  // 上面几段用的是「人工 exec-cli」；而目标路径写的是「**看板派发**」⇒ 这一段用执行循环的自动 tick 复证同一条链，
  // 让「需求条目 → 看板派发 → CLI 真跑 → 证据回流 → 人工 done → 需求 all-closed」整条路径**可复跑**。
  const made3 = await call("POST", "/api/requirements/items", { projectId, title: "验证台需求条目 R3（派发路径）", docId });
  const item3 = made3.payload?.item;
  const t3 = await call("POST", "/api/tasks", { projectId, title: "验证台任务 T3（派发路径）", status: "todo" });
  const task3 = t3.payload?.task;
  await call("POST", `/api/tasks/${task3.identifier}/attribution`, { requirement: item3.identifier });
  const tick = await call("POST", `/api/projects/${projectId}/execution-loop`, {});
  const d3ids = (tick.payload?.dispatched ?? []).map((x) => x?.task);
  check("看板派发：执行循环自动派发 T3（不是人工 exec-cli）", d3ids.includes(task3.identifier), `dispatched=${JSON.stringify(d3ids)}`);
  const t3after = await waitFor(task3.identifier, (t) => t.status === "in_review");
  check("派发路径：T3 停「待验收」（CLI 真跑完）", t3after?.status === "in_review", `status=${t3after?.status}`);
  const c3a = await call("GET", `/api/requirements/items/${item3.identifier}/completion`);
  check("派发路径：in_review ⇒ 完成度 in-review / ready=false", c3a.payload?.verdict === "in-review" && c3a.payload?.ready === false, `verdict=${c3a.payload?.verdict}`);
  const done3 = await call("PATCH", `/api/tasks/${task3.identifier}`, { status: "done", version: t3after?.version });
  const c3b = await call("GET", `/api/requirements/items/${item3.identifier}/completion`);
  check("派发路径：人点 T3 done ⇒ 完成度 all-closed / ready=true", done3.status === 200 && c3b.payload?.verdict === "all-closed" && c3b.payload?.ready === true, `done=${done3.status} verdict=${c3b.payload?.verdict}`);
  const close3 = await call("PATCH", `/api/requirements/items/${item3.identifier}`, { status: "done", actor: "human", reason: "派发路径复证：关联任务已收口" });
  check("派发路径：需求条目置 done 200", close3.status === 200 && close3.payload?.item?.status === "done", `status=${close3.status}`);
} catch (error) {
  check("验证台无未捕获异常", false, String(error?.stack ?? error));
} finally {
  await new Promise((resolve) => server.close(resolve));
  try { store.close?.(); } catch { /* noop */ }
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
  await rm(binDir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed} · FAIL ${failed} ----`);
process.exit(failed ? 1 : 0);
