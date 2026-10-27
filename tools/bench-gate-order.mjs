/**
 * 门判定先于副作用 —— **真 HTTP 验证台**（2026-10-22 续四十一配套）。
 *
 * 为什么需要它：`tests/gate-before-side-effects.test.mjs` 是**内存级**（直接调 `router.route`），
 * 而真机 `:3080` 跑的仍是 17:05 的旧构建 ⇒ 修复后的服务端**从未在任何真实进程里被 HTTP 打通过**。
 * 本脚本用仓库自己的独立验证台（`src/server/server.mjs#createServer`）起一个**真实 http 服务**，
 * 走完整链路（HTTP → 请求体解析 → basePath → router → store → 真实 SQLite 文件），
 * 并注入**记录型** `hostSessionPort` ⇒「被拒的执行到底有没有建会话」成为可观测事实。
 *
 * 运行（无需重载 DSH、不碰 `:3080`、不碰 `~/.dsh`、不碰仓库 `.data/`）：
 *   node tools/bench-gate-order.mjs
 *
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL（明细逐条打印）。
 */
import { mkdtemp, rm } from "node:fs/promises";
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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-gate-bench-"));
const store = openStore({ dataDir, env: {} });
ensureDefaultProject(store);

// 记录型宿主端口：任何一次建会话 / 开会话都会被记下来（这就是「副作用」的可观测面）
const port = { created: 0, opened: [] };
store.hostSessionPort = {
  available: true,
  async createSession() { port.created += 1; return { sessionId: `session-bench-${port.created}`, presetApplied: true }; },
  async openSession(id) { port.opened.push(id); return { opened: true }; },
  async sessionState(sessionId) { return { sessionId, live: false, running: false, status: null, pending: 0 }; },
};

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
  try { payload = JSON.parse(text); } catch { /* 非 JSON（如静态资源） */ }
  return { status: res.status, payload };
};

const mkTask = async (title, status) => {
  const r = await call("POST", "/api/tasks", { projectId: "default", title, status });
  if (r.status !== 201) throw new Error(`建卡失败 ${title}: ${r.status} ${JSON.stringify(r.payload)}`);
  return r.payload.task;
};

const item = store.createRequirementItem({ projectId: "default", title: "需求A（本台自建）" });

// ---- ① 未归因的「可开工」卡：归因门拒绝，且**不建会话**（旧代码会先建会话再拒绝）--------
const orphan = await mkTask("游离卡（未归因）", "todo");
const r1 = await call("POST", `/api/tasks/${orphan.identifier}/execute`, {});
check("未归因的可开工卡 → 400 EXECUTION_NOT_ATTRIBUTED", r1.status === 400 && r1.payload?.error?.code === "EXECUTION_NOT_ATTRIBUTED", `status=${r1.status} code=${r1.payload?.error?.code}`);
check("未归因被拒 ⇒ 一次会话都没建", port.created === 0 && port.opened.length === 0, `created=${port.created} opened=${port.opened.length}`);
check("未归因被拒 ⇒ 卡状态不变", store.getTaskRef(orphan.identifier).status === "todo");

// ---- ② 已归因但在「待办池」：授权门拒绝，同样不建会话 ------------------------------
const backlog = await mkTask("待办池卡（已归因）", "backlog");
await call("POST", `/api/tasks/${backlog.identifier}/attribution`, { requirement: item.identifier });
const r2 = await call("POST", `/api/tasks/${backlog.identifier}/execute`, {});
check("待办池卡 → 400 EXECUTION_NOT_AUTHORIZED", r2.status === 400 && r2.payload?.error?.code === "EXECUTION_NOT_AUTHORIZED", `status=${r2.status} code=${r2.payload?.error?.code}`);
check("待办池被拒 ⇒ 一次会话都没建", port.created === 0 && port.opened.length === 0, `created=${port.created}`);

// ---- ③ 人工校验卡：报的是**升级门**（不是归因门），且不建会话 ------------------------
const human = await mkTask("【人工校验】与上游不符", "todo");
// 注意：HTTP 层只透传 `labels`（整体替换），**不透传** store 支持的 `addLabels`/`removeLabels`
// ⇒ 从 API 侧给卡追加标签只能「读当前标签 + 整体重写」。这条口径差已记入轮次文档（未修）。
const patch = await call("PATCH", `/api/tasks/${human.identifier}`, { expectedVersion: store.getTaskRef(human.identifier).version, labels: ["human_review"] });
check("前置：PATCH 成功给卡打上 human_review 标签（API 只收整体 labels）", patch.status === 200 && (patch.payload?.task?.labels ?? []).includes("human_review"), `status=${patch.status} labels=${JSON.stringify(patch.payload?.task?.labels)}`);
const r3 = await call("POST", `/api/tasks/${human.identifier}/execute`, {});
// 人工校验门在 `src/core/errors.mjs` 里映射到 EXIT.CONFLICT ⇒ `httpStatusFor` 给 **409**
// （归因门 / 授权门是 400）。这条「三种门给两种 HTTP 语义」一并记录。
check("人工校验卡 → 409 HUMAN_REVIEW_NOT_EXECUTABLE（不是归因门）", r3.status === 409 && r3.payload?.error?.code === "HUMAN_REVIEW_NOT_EXECUTABLE", `status=${r3.status} code=${r3.payload?.error?.code}`);
check("人工校验被拒 ⇒ 一次会话都没建", port.created === 0 && port.opened.length === 0, `created=${port.created}`);

// ---- ④ 对照：合法路径必须仍能建会话 + 打开 + 转进行中（预判不误伤）------------------
const ok = await mkTask("正常卡（已归因）", "todo");
await call("POST", `/api/tasks/${ok.identifier}/attribution`, { requirement: item.identifier });
const r4 = await call("POST", `/api/tasks/${ok.identifier}/execute`, {});
check("合法执行 → 200 且真的建了 1 个会话并打开", r4.status === 200 && port.created === 1 && port.opened.length === 1, `status=${r4.status} created=${port.created} opened=${port.opened.join(",")}`);
check("合法执行 ⇒ 卡转「进行中」", store.getTaskRef(ok.identifier).status === "in_progress", `status=${store.getTaskRef(ok.identifier).status}`);

// ---- ⑤ 派发：成员里混进待办池卡 ⇒ 拒绝且**不留孤儿团队 run** -----------------------
const target = await mkTask("派发目标卡", "todo");
const before = store.listTeamRuns({}).length;
const r5 = await call("POST", "/api/teams", { targetTask: target.identifier, tasks: [{ task: backlog.identifier }] });
const after = store.listTeamRuns({}).length;
check("派发混进待办池卡 → 拒绝", r5.status >= 400, `status=${r5.status} code=${r5.payload?.error?.code}`);
check("被拒的派发 ⇒ 团队 run 数不变（无孤儿）", after === before, `before=${before} after=${after}`);

// ---- ⑥ 顺带取证：重载一次能买到什么（新构建已有、线上 17:05 构建没有）--------------
const es = await call("GET", "/api/projects/default/empty-state");
check("新构建已有 FR-93 `empty-state` 端点（线上旧构建 404）", es.status === 200, `status=${es.status}`);
const acc = await call("POST", "/api/tasks", { projectId: "default", title: "带验收标准的卡", status: "todo", acceptance: "npm test 全绿", verifyCommand: "node --test tests/domain.test.mjs" });
check("新构建已收 FR-94 `acceptance`/`verifyCommand` 两字段", acc.status === 201 && String(acc.payload?.task?.acceptance ?? "") === "npm test 全绿", `acceptance=${JSON.stringify(acc.payload?.task?.acceptance)}`);

// ---- ⑦ 门序列对齐（真机第十报）：归因门在授权门**之前** ⇒ 引导码随真值切换 ------------
// 服务端 `store.assertExecutable` 的顺序是「人工校验门 → 归因门 → 授权门」，而 `next-step.mjs`
// 此前把 `backlog` **一律**判成 `authorize` ⇒ 若某张待办池卡未归因，「先授权 → 再点启动执行」
// 仍会撞归因门（同一句报错换个入口再来一次）。这里把三条真值钉在同一台服务上：
const nsTodo = await call("GET", `/api/tasks/${orphan.identifier}/next-step`);
check("未归因的可开工卡 → `todo-no-attribution`（先去归因）", nsTodo.payload?.nextStep?.code === "todo-no-attribution", `code=${nsTodo.payload?.nextStep?.code}`);
const nsBacklog = await call("GET", `/api/tasks/${backlog.identifier}/next-step`);
check("已归因的待办池卡 → `backlog`（授权开工）", nsBacklog.payload?.nextStep?.code === "backlog", `code=${nsBacklog.payload?.nextStep?.code}`);
const backlogOrphan = await mkTask("待办池卡（未归因）", "backlog");
const nsBacklogNoAttr = await call("GET", `/api/tasks/${backlogOrphan.identifier}/next-step`);
check("未归因的待办池卡 → `backlog-no-attribution`（先归因，再授权）", nsBacklogNoAttr.payload?.nextStep?.code === "backlog-no-attribution", `code=${nsBacklogNoAttr.payload?.nextStep?.code}`);
const nsIds = (nsBacklogNoAttr.payload?.nextStep?.actions ?? []).map((a) => a.id);
check("该分支的动作是 `goto-attribution`（不是 `authorize`）", nsIds.join(",") === "goto-attribution", `actions=${nsIds.join(",")}`);

await new Promise((resolve) => server.close(resolve));
store.close();
await rm(dataDir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
console.log(`临时 dataDir 已清理：${dataDir}`);
process.exit(failed.length === 0 ? 0 : 1);
