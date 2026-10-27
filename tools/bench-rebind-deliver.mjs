/**
 * FR-84 条②/条③：「重建并绑定项目主会话 → 投递开局提示词 → 打开会话三级回落」—— **真进程验证台**。
 *
 * 为什么需要它：卡 `taskboard-workbench-90` 的原结论是「宿主会话创建失败 ⇒『重建后投递开局提示词』**不可达**」，
 * 于是 FR-84 条款 3 一度被记为「受上游阻塞 / 接受降级」。2026-10-22 只读探测显示宿主的**建会话能力已恢复**
 * （`verdict=create-available`）⇒ **该结论的前提已变**，而这条路径此前**没有任何可复跑验证器**
 * （只在隔离台里证过「渲染与动作选择」，宿主是受控桩夹具，且没验到投递）。
 *
 * 本台用一个**功能性宿主端口桩**（记录型 + 真返回会话标识）把整条路走完：
 *   ① 无任何会话引用时，诊断**产 `bind_session`「重建并绑定项目主会话」**（而不是产一个空标识的「打开执行会话」）；
 *   ② `rebind` **不带 confirm ⇒ 只回 `confirm-required`、零副作用**（绝不偷偷建会话）；
 *   ③ 带 confirm ⇒ `createSession({ cwd: 项目工作区 })` → 绑定主会话 → **`sendPrompt` 真的投递开局提示词**；
 *   ④ 绑定后「打开执行会话」**三级回落**到项目主会话并真的打开；
 *   ⑤ 诊断动作**随真值切换**：绑定后不再产 `bind_session`，改产 `open_session`。
 *   ⑥ **FR-95 会话命名口径**（2026-10-23 用户约束）在真进程里成立：重建 ⇒ `【项目】<项目名>`
 *      （**此前无指针时不得凭空加备注**、已有指针才带「（重建）」）；改绑已有会话 ⇒ 该会话被改名
 *      `【项目】<项目名>（重绑）`；任务执行会话 ⇒ `【任务】<标题> · <时间>`；**改名失败如实回
 *      `titleApplied:false` + 原因**（不谎报成功）。
 *
 * ⚠ 边界：桩**不证明真实宿主能建会话**（那一点由真机只读探测 `verdict=create-available` 佐证）；
 * 它证明的是**本仓库这一侧**的整条路（动作选择 / 确认门 / 传对工作区 / 投递 / 回落）成立且可复跑。
 *
 * 运行：`node tools/bench-rebind-deliver.mjs`（秒级；不联网、不碰 `:3080`、不碰用户数据）
 * 退出码：0 = 全 PASS；1 = 有 FAIL。
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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-rebind-bench-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "tb-rebind-ws-"));
const store = openStore({ dataDir, env: {} });
ensureDefaultProject(store);

// 功能性宿主端口桩：**记录**每一次建会话 / 开会话 / 投递 / 改名，并**真返回**可用的会话标识。
// 桩**刻意复刻真实宿主的契约**（`index.js#createSession` 实测）：`create()` **不收 title** ⇒
// 建完再 `rename()`，并把 `titleApplied / titleReason` 如实回流（失败也要说得出原因）。
const calls = { create: [], open: [], prompts: [], renames: [] };
let renameFails = 0; // >0 ⇒ 接下来这么多次改名**失败**（负例用）
async function applyTitle(sessionId, title) {
  calls.renames.push({ sessionId, title });
  if (renameFails > 0) { renameFails -= 1; return { renamed: false, reason: "bench-rename-failed" }; }
  return { renamed: true, title, seq: calls.renames.length };
}
store.hostSessionPort = {
  available: true,
  async createSession(opts = {}) {
    calls.create.push(opts);
    const sessionId = `session-bench-${calls.create.length}`;
    const named = opts.title ? await applyTitle(sessionId, opts.title) : { renamed: false, reason: "no-title" };
    return { sessionId, presetApplied: true, titleApplied: Boolean(named.renamed), titleReason: named.renamed ? null : (named.reason ?? "rename-failed") };
  },
  async renameSession(id, title) { return applyTitle(id, title); },
  async openSession(id) { calls.open.push(id); return { opened: true }; },
  async sessionExists(id) { return { exists: true, source: "bench" }; },
  async sessionOrigin(id) { return { cwd: workspace, sessionId: id, source: "bench" }; },
  async sessionState(id) { return { sessionId: id, live: true, running: false, status: "idle", pending: 0 }; },
  async listSessions() { return { sessions: [] }; },
  async sendPrompt(id, text) { calls.prompts.push({ id, text }); return { sent: true }; },
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
  try { payload = JSON.parse(text); } catch { /* 非 JSON */ }
  return { status: res.status, payload };
};
/** 把所有诊断里的动作摊平，便于断言「产了哪个动作、指向哪条接口、带什么 body」。 */
const actionsOf = (payload) => (payload?.diagnostics ?? []).flatMap((d) => d?.actions ?? []);

const projectId = "bench-rebind";
const created = await call("POST", "/api/projects", { id: projectId, name: "重建投递验证台", workspacePath: workspace });
check("建台内项目（workspacePath=临时目录）", created.status === 200 || created.status === 201, `status=${created.status}`);

const mk = await call("POST", "/api/tasks", { projectId, title: "在途但无会话的卡", status: "todo" });
const task = mk.payload?.task;
const moved = await call("PATCH", `/api/tasks/${task?.identifier}`, { status: "in_progress", version: task?.version });
check("造出「在途(in_progress) 且无任何会话引用」的卡（FR-84 的触发态）",
  moved.status === 200 && moved.payload?.task?.status === "in_progress" && !moved.payload?.task?.sessionId,
  `status=${moved.payload?.task?.status} sessionId=${moved.payload?.task?.sessionId ?? null}`);

// ---- ① 无任何会话引用 ⇒ 诊断必须产 bind_session（不是产空标识的 open_session） -------------------
const diagBefore = await call("GET", `/api/tasks/${task.identifier}/diagnostics`);
const actsBefore = actionsOf(diagBefore.payload);
const bindAct = actsBefore.find((a) => a.id === "bind_session") ?? null;
check("重建前诊断：产 `bind_session`「重建并绑定项目主会话」", Boolean(bindAct), `actions=${JSON.stringify(actsBefore.map((a) => a.id))}`);
check("重建前诊断：**不产** `open_session`（避免空会话标识的打开动作 ⇒「已复制会话标识：-」）",
  !actsBefore.some((a) => a.id === "open_session"), `actions=${JSON.stringify(actsBefore.map((a) => a.id))}`);
check("重建前诊断：动作自带可执行信息（path + body.confirm=true）",
  bindAct?.path === `/api/projects/${projectId}/sessions/rebind` && bindAct?.body?.confirm === true,
  `path=${bindAct?.path} body=${JSON.stringify(bindAct?.body ?? null)}`);

// ---- ② 无主会话时打开会话：如实说「无会话」，不编造标识 ------------------------------------------
const openBefore = await call("POST", `/api/tasks/${task.identifier}/open-session`, {});
check("重建前打开会话：如实回 no-session（sessionId 为 null，绝不用「-」占位）",
  openBefore.status === 200 && openBefore.payload?.opened === false && openBefore.payload?.sessionId === null && openBefore.payload?.reason === "no-session",
  JSON.stringify(openBefore.payload));

// ---- ③ 确认门：不带 confirm ⇒ 零副作用 -----------------------------------------------------------
const noConfirm = await call("POST", `/api/projects/${projectId}/sessions/rebind`, {});
check("rebind 不带 confirm ⇒ 只回 confirm-required", noConfirm.status === 200 && noConfirm.payload?.rebound === false && noConfirm.payload?.reason === "confirm-required",
  JSON.stringify(noConfirm.payload));
check("rebind 不带 confirm ⇒ **一次会话都没建**（零副作用）", calls.create.length === 0, `createCalls=${calls.create.length}`);

// ---- ④ 带 confirm ⇒ 真建会话 → 绑定 → 投递开局提示词 ---------------------------------------------
const rebind = await call("POST", `/api/projects/${projectId}/sessions/rebind`, { confirm: true });
check("rebind 带 confirm ⇒ rebound=true / mode=create / after=session-bench-1",
  rebind.status === 200 && rebind.payload?.rebound === true && rebind.payload?.mode === "create" && rebind.payload?.after === "session-bench-1",
  JSON.stringify({ rebound: rebind.payload?.rebound, mode: rebind.payload?.mode, before: rebind.payload?.before, after: rebind.payload?.after }));
check("建会话时**传的是项目自己的工作区**（否则新会话会被归属门拦下——FR-84 修复点）",
  calls.create[0]?.cwd === workspace, `cwd=${calls.create[0]?.cwd}`);
check("**真的投递了开局提示词**（`sendPrompt` 被调用且投到新会话）",
  calls.prompts.length === 1 && calls.prompts[0].id === "session-bench-1",
  `prompts=${JSON.stringify(calls.prompts.map((p) => p.id))}`);
check("开局提示词内容正确（含 `[任务工作台 · 项目主会话]` 与本项目）",
  String(calls.prompts[0]?.text ?? "").includes("[任务工作台 · 项目主会话]") && String(calls.prompts[0]?.text ?? "").includes(projectId),
  `len=${calls.prompts[0]?.text?.length ?? 0}`);
check("投递结果如实回包（openingDelivered=true / deliveryReason=null）",
  rebind.payload?.openingDelivered === true && rebind.payload?.deliveryReason === null,
  `openingDelivered=${rebind.payload?.openingDelivered} deliveryReason=${rebind.payload?.deliveryReason ?? null}`);
check("项目主会话指针已更新为新建会话",
  store.getProject(projectId)?.initialSessionId === "session-bench-1",
  `initialSessionId=${store.getProject(projectId)?.initialSessionId ?? null}`);
// ---- ④b FR-95 命名口径：重建的会话名 = 【项目】<项目名>（**此前无指针 ⇒ 不带备注**） --------------
check("重建时**传了**会话名：`【项目】重建投递验证台`（此前无指针 ⇒ **不得**凭空加「（重建）」）",
  calls.create[0]?.title === "【项目】重建投递验证台",
  `title=${JSON.stringify(calls.create[0]?.title ?? null)}`);
check("会话名**建完真改**（宿主 `create()` 不收 title ⇒ 必须走 rename）",
  calls.renames[0]?.sessionId === "session-bench-1" && calls.renames[0]?.title === "【项目】重建投递验证台",
  `renames=${JSON.stringify(calls.renames)}`);
check("改名结果如实回流（titleApplied=true / titleReason=null）",
  rebind.payload?.titleApplied === true && rebind.payload?.titleReason === null,
  `titleApplied=${rebind.payload?.titleApplied} titleReason=${rebind.payload?.titleReason ?? null}`);

// ---- ⑤ 绑定后：打开会话三级回落到项目主会话，并真的打开 ------------------------------------------
const openAfter = await call("POST", `/api/tasks/${task.identifier}/open-session`, {});
check("重建后打开会话：回落到项目主会话（source=project-main）",
  openAfter.status === 200 && openAfter.payload?.opened === true && openAfter.payload?.sessionId === "session-bench-1" && openAfter.payload?.source === "project-main",
  JSON.stringify(openAfter.payload));
check("打开动作**真的被宿主收到**（openSession 收到该会话标识）", calls.open.includes("session-bench-1"), `openCalls=${JSON.stringify(calls.open)}`);

// ---- ⑥ 诊断动作随真值切换：不再产 bind_session，改产 open_session ---------------------------------
const diagAfter = await call("GET", `/api/tasks/${task.identifier}/diagnostics`);
const actsAfter = actionsOf(diagAfter.payload);
check("重建后诊断：改产 `open_session`（动作选择随真值切换）",
  actsAfter.some((a) => a.id === "open_session") && !actsAfter.some((a) => a.id === "bind_session"),
  `actions=${JSON.stringify(actsAfter.map((a) => a.id))}`);

// ---- ⑦ 已有指针时再重建 ⇒ 名称必须带备注「重建」（FR-95 口径 2 后半） ----------------------------
const rebind2 = await call("POST", `/api/projects/${projectId}/sessions/rebind`, { confirm: true });
check("再次重建（已有指针）⇒ 会话名带备注「（重建）」",
  calls.create[1]?.title === "【项目】重建投递验证台（重建）",
  `title=${JSON.stringify(calls.create[1]?.title ?? null)}`);
check("再次重建 ⇒ 新会话被改名、指针换了新会话、改名结果如实回流",
  calls.renames.at(-1)?.sessionId === "session-bench-2" &&
    rebind2.payload?.after === "session-bench-2" && rebind2.payload?.titleApplied === true,
  `renames=${JSON.stringify(calls.renames.at(-1))} after=${rebind2.payload?.after} titleApplied=${rebind2.payload?.titleApplied}`);

// ---- ⑧ 改绑已有会话 ⇒ 该会话改名 `【项目】<项目名>（重绑）`，且**不新建会话** -------------------
const renamesBefore = calls.renames.length;
const createsBefore = calls.create.length;
const bindExisting = await call("POST", `/api/projects/${projectId}/sessions/rebind`, { confirm: true, sessionId: "session-bench-1" });
check("改绑已有会话 ⇒ `mode=bind-existing`、**一次会话都没新建**",
  bindExisting.payload?.mode === "bind-existing" && calls.create.length === createsBefore,
  `mode=${bindExisting.payload?.mode} createCalls+${calls.create.length - createsBefore}`);
check("改绑 ⇒ **被绑的那个会话**改名为 `【项目】重建投递验证台（重绑）`",
  calls.renames.length === renamesBefore + 1 &&
    calls.renames.at(-1)?.sessionId === "session-bench-1" &&
    calls.renames.at(-1)?.title === "【项目】重建投递验证台（重绑）",
  `rename=${JSON.stringify(calls.renames.at(-1) ?? null)}`);
check("改绑：改名结果如实回流（titleApplied=true）",
  bindExisting.payload?.titleApplied === true && bindExisting.payload?.titleReason === null,
  `titleApplied=${bindExisting.payload?.titleApplied} titleReason=${bindExisting.payload?.titleReason ?? null}`);

// ---- ⑨ 改名失败 ⇒ 如实回报 `titleApplied:false` + 原因，且**不影响绑定本身** -------------------
renameFails = 1;
const bindFail = await call("POST", `/api/projects/${projectId}/sessions/rebind`, { confirm: true, sessionId: "session-bench-2" });
check("改名失败 ⇒ titleApplied=false + 原因如实（不谎报成功）",
  bindFail.payload?.titleApplied === false && bindFail.payload?.titleReason === "bench-rename-failed",
  `titleApplied=${bindFail.payload?.titleApplied} titleReason=${bindFail.payload?.titleReason ?? null}`);
check("改名失败**不影响绑定本身**（rebound=true 且指针已更新）",
  bindFail.payload?.rebound === true && store.getProject(projectId)?.initialSessionId === "session-bench-2",
  `rebound=${bindFail.payload?.rebound} initialSessionId=${store.getProject(projectId)?.initialSessionId ?? null}`);

// ---- ⑩ 任务执行会话名 = 【任务】+ 标题 + 时间（FR-95 口径 1）＋ 仍须带 cwd ----------------------
const namingItem = store.createRequirementItem({ projectId, title: "验证台需求条目（命名）" });
const namingTask = store.createTask({ projectId, title: "更改按钮样式", status: "todo" });
store.associateRequirementTask(namingItem.id, namingTask.id);
const exec = await call("POST", `/api/tasks/${namingTask.identifier}/execute`, {});
const execArgs = calls.create.at(-1);
check("任务「启动执行」的会话名 = `【任务】<标题> · <时间>`（口径 1）",
  /^【任务】更改按钮样式 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(execArgs?.title ?? "")),
  `title=${JSON.stringify(execArgs?.title ?? null)}`);
check("任务执行会话**仍须带 cwd**（不传 ⇒ 会话落在 dsh 进程目录，正是跨工作区错绑的来源）",
  execArgs?.cwd === workspace,
  `cwd=${execArgs?.cwd ?? null}`);
check("任务执行会话的改名结果也如实回流（launch.titleApplied）",
  exec.payload?.launch?.titleApplied === true,
  `titleApplied=${exec.payload?.launch?.titleApplied ?? null}`);

console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
try { server.closeAllConnections?.(); } catch { /* ignore */ }
await new Promise((resolve) => server.close(resolve));
for (const dir of [dataDir, workspace]) await rm(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
