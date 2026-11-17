#!/usr/bin/env node
/**
 * 隔离验证台 · **派发目标选取**（卡 `-264` / 需求 `R188`）。
 *
 * 守的是什么（用户 2026-11-13 原话）：
 *   「默认指派 dsh 或其他 agent 授权执行任务卡片时，应该**优先选取已绑定项目的空闲会话**接手新卡；
 *     没有绑定会话时，**要求第一次授权**，或在卡片点『执行』时**把授权指令一并带进去**。」
 *
 * 本台不起浏览器、不碰 `:3080`、不碰真实 `~/.dsh`：临时 dataDir + 随机端口 + 独立进程内 HTTP，
 * 宿主会话通道用**记录型假端口**（只记录不真投），跑完即删。
 *
 * 判据（三条路径 + 三条反例，**双向**）：
 *   A 复用：主会话空闲 ⇒ mode=reuse-bound，`createSession` 0 次，`sendPrompt` 打到主会话，任务书说「不需要再申请关联」
 *   B 新建授权：全部会话在跑 ⇒ mode=create-and-authorize，`project_sessions` +1 行 approved，审计留痕，任务书含【授权】
 *   C 判不准也新建：主会话 live=false（不知道它空不空闲）⇒ 不猜，走新建
 *   D 跨工作区排除：主会话 cwd 在别的工作区 ⇒ 不派给它，走新建
 *   E 投递失败回落：`sendPrompt` 未送达 ⇒ 回落新建，且 `launch.fallbackReason` 如实带原因（不谎报已复用）
 *   F 预览端点只读：`GET /api/projects/:id/dispatch-target` 不建会话、不投递，结论与 `/execute` 同源
 *   G 任务抽屉预览：`GET /api/tasks/:ref/execution` 带 `dispatchTarget`
 *   H 来源档位（卡 `-272`）：`launch.reusedFrom` ∈ `main`/`approved`/`executor`；新建路径恒 `null`；
 *     新建路径的任务书与复用路径**同等信息**（带验收标准 / 复核动作）
 *   I 任务书真送达（卡 `-272` · `R188` 验收③）：preset 被宿主吞掉 ⇒ 补投一次且回包 `bookDelivery.via="send-prompt-fallback"`；
 *     补投也失败 ⇒ `delivered=false` + 审计 + 卡上评论（**「授权已成」不得冒充「任务书已送达」**）
 *
 * **反证入口** `TB_BENCH_DISPATCH_REVERSE=legacy-create`：把「已绑定会话」全部藏起来
 * （去掉主会话指针 + 已批准关联 + 派生执行会话）⇒ 等价**旧行为**「没给 sessionId 就一律新建」。
 * 期望 A 段（复用路径）转红 —— 证明本台不是「怎么跑都绿」。
 *
 * 退出码：0 = 全 PASS；1 = 有失败；2 = 环境不具备（本台零依赖，正常不会出现）。
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: Boolean(ok), detail }); };

const tmp = await mkdtemp(path.join(os.tmpdir(), "tb-bench-dispatch-"));
const store = openStore({ dbPath: path.join(tmp, "bench.sqlite") });

// ── 记录型假宿主通道 ──────────────────────────────────────────────────────
const REVERSE = String(process.env.TB_BENCH_DISPATCH_REVERSE ?? "").trim();

const calls = { created: [], sent: [], opened: [] };
let liveness = {};        // sessionId -> { exists, live, running, pending }
let origins = {};         // sessionId -> { cwd, mismatch? }（mismatch 由 api 自己按 workspacePath 算）
let sendFails = new Set(); // 这些会话的 sendPrompt 返回未送达
let presetAppliesOnCreate = true; // 卡 `-272`：createSession 自述的 presetApplied（模拟宿主静默吞掉 preset）
let seq = 0;
store.hostSessionPort = {
  available: true,
  capabilities: () => ({ sessionController: true, prompt: true, create: true, agents: true, sessions: true, sessionQuery: true }),
  sessionState: (sid) => liveness[sid] ?? { sessionId: sid, live: false, running: false, status: null, pending: 0 },
  sessionExists: async (sid) => ({ exists: liveness[sid]?.exists ?? null, source: "bench" }),
  sessionOrigin: async (sid) => ({ cwd: origins[sid] ?? null, source: "bench" }),
  sendPrompt: async (sid, prompt) => {
    calls.sent.push({ sid, prompt });
    if (sendFails.has(sid)) return { sent: false, reason: "bench-send-failed" };
    return { sent: true };
  },
  createSession: async (opts) => {
    seq += 1;
    const sessionId = `session-bench-new-${seq}`;
    calls.created.push({ sessionId, opts });
    // 卡 `-272`（`R188` 验收③）：`presetApplied` 可被台子按段拨假 —— 模拟真机
    // 「宿主 scope 解析不到 ⇒ preset binding 被拒 ⇒ 任务书一个字都没进会话」。
    return { sessionId, presetApplied: presetAppliesOnCreate, titleApplied: true };
  },
  openSession: async (sid) => { calls.opened.push(String(sid)); return { opened: true }; },
};

const server = createServer({ store, basePath: "" });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, p, body) => {
  const res = await fetch(base + p, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, payload };
};
const get = (p) => call("GET", p);

const mkCard = (title, projectId = "p-work", extra = {}) => {
  const item = store.createRequirementItem({ projectId, title: `R-${title}` });
  const task = store.createTask({ projectId, title, status: "todo", ...extra });
  store.associateRequirementTask(item.id, task.id);
  return store.requireTaskRef(task.identifier);
};
const approvedRows = (sessionId) => store.listProjectSessions("p-work").filter((r) => r.sessionId === sessionId && r.status === "approved");
const resetCalls = () => { calls.created.length = 0; calls.sent.length = 0; calls.opened.length = 0; };

try {
  if (REVERSE === "legacy-create") {
    // 反证：等价旧口径「没有任何已绑定会话可用」⇒ 一律新建。A 段的复用断言必须全红。
    const origGetProject = store.getProject.bind(store);
    store.getProject = (id) => { const p = origGetProject(id); return p ? { ...p, initialSessionId: null } : p; };
    store.listProjectSessions = () => [];
    store.listExecutorSessions = () => [];
  }
  store.createProject({ id: "p-work", name: "work", workspacePath: "/repo/work" });
  store.createProject({ id: "p-other", name: "other", workspacePath: "/repo/other" });
  store.bindInitialSession("p-work", "sess-main");
  origins = { "sess-main": "/repo/work" };

  // ── A 复用路径：主会话空闲 ─────────────────────────────────────────────
  liveness = { "sess-main": { exists: true, live: true, running: false, pending: 0 } };
  resetCalls();
  const tA = mkCard("A 复用");
  const rA = await call("POST", `/api/tasks/${encodeURIComponent(tA.identifier)}/execute`, {});
  check("A1 200 + mode=reuse-bound", rA.status === 200 && rA.payload?.launch?.mode === "reuse-bound", `status=${rA.status} mode=${rA.payload?.launch?.mode}`);
  check("A2 复用的正是主会话", rA.payload?.launch?.sessionId === "sess-main", `sessionId=${rA.payload?.launch?.sessionId}`);
  check("A3 一次会话都没新建", calls.created.length === 0, `createSession=${calls.created.length}`);
  check("A4 任务书投给了主会话（恰好 1 条）", calls.sent.length === 1 && calls.sent[0].sid === "sess-main", `sent=${JSON.stringify(calls.sent.map((s) => s.sid))}`);
  check("A5 任务书写明「不需要再申请关联」", /不需要再申请关联/.test(calls.sent[0]?.prompt ?? ""), `head=${(calls.sent[0]?.prompt ?? "").slice(0, 40)}`);
  check("A6 复用不写授权行（不冒充「批准过」）", approvedRows("sess-main").length === 0, `approvedRows=${approvedRows("sess-main").length}`);
  check("A7 卡已进入 in_progress 且绑定到该会话", store.requireTaskRef(tA.identifier).status === "in_progress" && store.requireTaskRef(tA.identifier).sessionId === "sess-main", `status=${store.requireTaskRef(tA.identifier).status} sessionId=${store.requireTaskRef(tA.identifier).sessionId}`);
  check("A8 回包含 candidates 逐条原因（可判读）", Array.isArray(rA.payload?.launch?.dispatch?.candidates) && rA.payload.launch.dispatch.candidates[0]?.why === "idle", `candidates=${JSON.stringify(rA.payload?.launch?.dispatch?.candidates?.map((c) => c.why))}`);
  // 卡 `-272`（需求 `R188` 验收①点名的 `reusedFrom`）：复用时必须说明「复用的是哪一类绑定会话」。
  check("A9 launch.reusedFrom=main（说明来源是主会话）", rA.payload?.launch?.reusedFrom === "main", `reusedFrom=${JSON.stringify(rA.payload?.launch?.reusedFrom)}`);

  // ── B 新建 + 首次授权：所有绑定会话都在跑 ──────────────────────────────
  store.approveSessionAssociation("p-work", "sess-appr");
  origins["sess-appr"] = "/repo/work";
  liveness = {
    "sess-main": { exists: true, live: true, running: true, pending: 0 },
    "sess-appr": { exists: true, live: true, running: true, pending: 3 },
  };
  resetCalls();
  const tB = mkCard("B 新建授权", "p-work", { acceptance: "验收：三条判据全绿", verifyCommand: "npm test" });
  const rB = await call("POST", `/api/tasks/${encodeURIComponent(tB.identifier)}/execute`, {});
  const newId = rB.payload?.launch?.sessionId ?? null;
  check("B1 200 + mode=create-and-authorize", rB.status === 200 && rB.payload?.launch?.mode === "create-and-authorize", `status=${rB.status} mode=${rB.payload?.launch?.mode}`);
  check("B2 新会话 project_sessions 落 approved 行", Boolean(newId) && approvedRows(newId).length === 1, `sessionId=${newId} rows=${newId ? approvedRows(newId).length : 0}`);
  check("B3 回带 authorization.mode=execute-click", rB.payload?.launch?.authorization?.mode === "execute-click", `authorization=${JSON.stringify(rB.payload?.launch?.authorization)}`);
  check("B4 createSession 的 preset 含【授权】与「首次绑定」", /【授权】/.test(calls.created[0]?.opts?.preset ?? "") && /首次绑定/.test(calls.created[0]?.opts?.preset ?? ""), `presetHead=${(calls.created[0]?.opts?.preset ?? "").slice(0, 30)}`);
  check("B5 授权段写明「不得置『完成』」", /不得置「完成」/.test(calls.created[0]?.opts?.preset ?? ""), "红线必须随授权一起下发");
  const authAudits = store.listGovernanceAudit({ action: "authorize-exec-session" }).filter((a) => a.target === tB.identifier);
  check("B6 审计留下 authorize-exec-session（reason=execute-click）", authAudits.length === 1 && authAudits[0].allowed === true && authAudits[0].reason === "execute-click", `rows=${authAudits.length} reason=${authAudits[0]?.reason}`);
  // 新建路径**不得**冒充复用：`reusedFrom` 恒为 null（键在、值为空）。
  check("B7 新建路径 launch.reusedFrom=null（不谎报复用）", rB.payload?.launch?.reusedFrom === null, `reusedFrom=${JSON.stringify(rB.payload?.launch?.reusedFrom)}`);
  // 卡 `-272`：新建路径的任务书也要带**验收标准 / 复核动作**（与复用路径同等信息）。
  const presetB = calls.created[0]?.opts?.preset ?? "";
  check("B8 授权段带验收与复核动作（新建会话不空手接单）", /验收：/.test(presetB) && /复核动作：/.test(presetB), `preset=${presetB.slice(0, 160)}`);

  // ── C 判不准也新建（live=false ⇒ 不知道空不空闲）──────────────────────
  liveness = { "sess-main": { exists: true, live: false, running: false, pending: 0 }, "sess-appr": { exists: true, live: false } };
  resetCalls();
  const tC = mkCard("C 判不准");
  const rC = await call("POST", `/api/tasks/${encodeURIComponent(tC.identifier)}/execute`, {});
  check("C1 判不准 ⇒ 不猜，走新建", rC.payload?.launch?.mode === "create-and-authorize", `mode=${rC.payload?.launch?.mode}`);
  check("C2 reason=bound-but-busy-or-unknown", rC.payload?.launch?.dispatch?.reason === "bound-but-busy-or-unknown", `reason=${rC.payload?.launch?.dispatch?.reason}`);
  check("C3 全部候选的 why 如实是 liveness-unknown", (rC.payload?.launch?.dispatch?.candidates ?? []).every((c) => c.why === "liveness-unknown"), `why=${JSON.stringify(rC.payload?.launch?.dispatch?.candidates?.map((c) => `${c.sessionId}:${c.role}:${c.why}`))}`);

  // ── D 跨工作区排除 ────────────────────────────────────────────────────
  // 换一个干净项目，避免前面 approved/executor 候选干扰
  store.createProject({ id: "p-cross", name: "cross", workspacePath: "/repo/cross" });
  store.bindInitialSession("p-cross", "sess-cross-main");
  origins["sess-cross-main"] = "/repo/elsewhere";
  liveness = { "sess-cross-main": { exists: true, live: true, running: false, pending: 0 } };
  resetCalls();
  const tD = mkCard("D 跨工作区", "p-cross");
  const rD = await call("POST", `/api/tasks/${encodeURIComponent(tD.identifier)}/execute`, {});
  const cMain = (rD.payload?.launch?.dispatch?.candidates ?? []).find((c) => c.sessionId === "sess-cross-main");
  check("D1 别的工作区的会话不被选", cMain && cMain.idle === false && cMain.why === "other-workspace", `candidate=${JSON.stringify(cMain && { idle: cMain.idle, why: cMain.why })}`);
  check("D2 因此走新建", rD.payload?.launch?.mode === "create-and-authorize", `mode=${rD.payload?.launch?.mode}`);

  // ── E 投递失败回落（不谎报「已复用」）──────────────────────────────────
  store.createProject({ id: "p-fail", name: "fail", workspacePath: "/repo/fail" });
  store.bindInitialSession("p-fail", "sess-fail-main");
  origins["sess-fail-main"] = "/repo/fail";
  liveness = { "sess-fail-main": { exists: true, live: true, running: false, pending: 0 } };
  sendFails = new Set(["sess-fail-main"]);
  resetCalls();
  const tE = mkCard("E 投递失败", "p-fail");
  const rE = await call("POST", `/api/tasks/${encodeURIComponent(tE.identifier)}/execute`, {});
  check("E1 投递失败 ⇒ 回落新建（mode 不是 reuse-bound）", rE.payload?.launch?.mode === "create-and-authorize", `mode=${rE.payload?.launch?.mode}`);
  check("E2 回包如实带 fallbackReason=reuse-send-failed", String(rE.payload?.launch?.fallbackReason ?? "").startsWith("reuse-send-failed"), `fallbackReason=${rE.payload?.launch?.fallbackReason}`);
  check("E3 卡最终仍落到新建的会话上", rE.payload?.launch?.sessionId && rE.payload.launch.sessionId !== "sess-fail-main", `sessionId=${rE.payload?.launch?.sessionId}`);
  sendFails = new Set();

  // ── F 预览端点只读 ────────────────────────────────────────────────────
  store.createProject({ id: "p-prev", name: "prev", workspacePath: "/repo/prev" });
  store.bindInitialSession("p-prev", "sess-prev-main");
  origins["sess-prev-main"] = "/repo/prev";
  liveness = { "sess-prev-main": { exists: true, live: true, running: false, pending: 0 } };
  resetCalls();
  const f1 = await get("/api/projects/p-prev/dispatch-target");
  const f2 = await get("/api/projects/p-prev/dispatch-target");
  check("F1 200 + decision=reuse + target=主会话", f1.status === 200 && f1.payload?.decision === "reuse" && f1.payload?.target?.sessionId === "sess-prev-main", `status=${f1.status} decision=${f1.payload?.decision} target=${f1.payload?.target?.sessionId}`);
  check("F2 两次预览结论一致（幂等）", JSON.stringify(f1.payload?.target) === JSON.stringify(f2.payload?.target), "同一输入同一结论");
  check("F3 预览无副作用（0 建会话 / 0 投递 / 0 开会话）", calls.created.length === 0 && calls.sent.length === 0 && calls.opened.length === 0, `created=${calls.created.length} sent=${calls.sent.length} opened=${calls.opened.length}`);
  check("F4 自带 hostAvailable + candidates 原因", f1.payload?.hostAvailable === true && Array.isArray(f1.payload?.candidates) && f1.payload.candidates[0]?.why === "idle", `hostAvailable=${f1.payload?.hostAvailable} why=${f1.payload?.candidates?.[0]?.why}`);

  // 反例：无宿主通道 ⇒ degraded（不许假装能派）
  store.hostSessionPort = { ...store.hostSessionPort, available: false };
  const f5 = await get("/api/projects/p-prev/dispatch-target");
  check("F5 无宿主通道 ⇒ decision=degraded", f5.payload?.decision === "degraded" && f5.payload?.hostAvailable === false, `decision=${f5.payload?.decision}`);
  store.hostSessionPort = { ...store.hostSessionPort, available: true };

  // ── G 任务抽屉预览（/execution 带 dispatchTarget）──────────────────────
  const g1 = await get(`/api/tasks/${encodeURIComponent(mkCard("G 抽屉预览", "p-prev").identifier)}/execution`);
  check("G1 /execution 带 dispatchTarget 且与预览端点同源", g1.payload?.dispatchTarget?.decision === "reuse" && g1.payload?.dispatchTarget?.target?.sessionId === "sess-prev-main", `decision=${g1.payload?.dispatchTarget?.decision} target=${g1.payload?.dispatchTarget?.target?.sessionId}`);
  // 反例：已收口的卡不该给派发预览（别让人以为还能派）
  const closed = store.createTask({ projectId: "p-prev", title: "已收口", status: "done" });
  const g2 = await get(`/api/tasks/${encodeURIComponent(closed.identifier)}/execution`);
  check("G2 done 卡 dispatchTarget=null（不误示可派）", g2.payload?.dispatchTarget === null, `dispatchTarget=${JSON.stringify(g2.payload?.dispatchTarget)}`);

  // ── H 来源档位（卡 `-272` · 需求 `R188` 验收①的三档）────────────────────
  // 主会话在跑 ⇒ 落到「已批准关联会话」⇒ `reusedFrom` 必须是 `approved`（不是 `associated`）。
  store.createProject({ id: "p-kind", name: "kind", workspacePath: "/repo/kind" });
  store.bindInitialSession("p-kind", "sess-kind-main");
  store.requestSessionAssociation("p-kind", "sess-kind-appr");
  store.approveSessionAssociation("p-kind", "sess-kind-appr");
  origins["sess-kind-main"] = "/repo/kind";
  origins["sess-kind-appr"] = "/repo/kind";
  liveness = {
    "sess-kind-main": { exists: true, live: true, running: true, pending: 0 },
    "sess-kind-appr": { exists: true, live: true, running: false, pending: 0 },
  };
  resetCalls();
  const tH = mkCard("H 来源档位", "p-kind");
  const rH = await call("POST", `/api/tasks/${encodeURIComponent(tH.identifier)}/execute`, {});
  check("H1 复用的是已批准关联会话", rH.payload?.launch?.sessionId === "sess-kind-appr", `sessionId=${rH.payload?.launch?.sessionId}`);
  check("H2 launch.reusedFrom=approved（对外口径三档）", rH.payload?.launch?.reusedFrom === "approved", `reusedFrom=${JSON.stringify(rH.payload?.launch?.reusedFrom)}`);
  check("H3 dispatch.target.kind=approved（预览与执行同源）", rH.payload?.launch?.dispatch?.target?.kind === "approved", `kind=${JSON.stringify(rH.payload?.launch?.dispatch?.target?.kind)}`);
  const hPrev = await get("/api/projects/p-kind/dispatch-target");
  check("H4 预览端点同样给 kind=approved", hPrev.payload?.target?.kind === "approved", `kind=${JSON.stringify(hPrev.payload?.target?.kind)}`);

  // ── I 任务书真送达（卡 `-272` · 需求 `R188` 验收③）─────────────────────
  // 为什么这条必须单独跑：真机 `createSession({preset})` 在 dsh-scope 解析不到时**静默吞掉 preset**
  // （回 `presetApplied:false`），会话建了、授权写了、回包还报 `create-and-authorize`，
  // 而**任务书一个字都没进会话**。只断言「建了会话 + 写了授权行」的话，这条缺口永远测不出来。
  store.createProject({ id: "p-book", name: "book", workspacePath: "/repo/book" });
  // I1 preset 被吞 + 补投成功 ⇒ 补投一次、正文与 preset 同源
  presetAppliesOnCreate = false;
  resetCalls();
  const tI1 = mkCard("I1 补投", "p-book");
  const rI1 = await call("POST", `/api/tasks/${encodeURIComponent(tI1.identifier)}/execute`, {});
  const bookI1 = rI1.payload?.launch?.bookDelivery ?? null;
  check("I1 preset 被吞 ⇒ bookDelivery.via=send-prompt-fallback（补投）", bookI1?.delivered === true && bookI1?.via === "send-prompt-fallback", `bookDelivery=${JSON.stringify(bookI1)}`);
  check("I2 补投恰好 1 次且投给刚建的会话", calls.sent.length === 1 && calls.sent[0].sid === rI1.payload?.launch?.sessionId, `sent=${JSON.stringify(calls.sent.map((s) => s.sid))} new=${rI1.payload?.launch?.sessionId}`);
  check("I3 补投正文逐字等于 preset 正文（两条路不各写一份）", calls.sent[0]?.prompt === calls.created[0]?.opts?.preset, `same=${calls.sent[0]?.prompt === calls.created[0]?.opts?.preset}`);
  check("I4 补投正文含【授权】与「不得再申请」", /【授权】/.test(calls.sent[0]?.prompt ?? "") && /不得再申请/.test(calls.sent[0]?.prompt ?? ""), "R188 ③ 点名的授权段");
  // preset 正常 ⇒ 不重复投递（补投只用于失败路径）
  presetAppliesOnCreate = true;
  resetCalls();
  const tI2 = mkCard("I2 preset 正常", "p-book");
  const rI2 = await call("POST", `/api/tasks/${encodeURIComponent(tI2.identifier)}/execute`, {});
  check("I5 preset 正常 ⇒ bookDelivery.via=preset 且零补投", rI2.payload?.launch?.bookDelivery?.via === "preset" && calls.sent.length === 0, `via=${rI2.payload?.launch?.bookDelivery?.via} sent=${calls.sent.length}`);
  // 两条路都失败 ⇒ 派发本身不失败，但必须如实说「没送到」并留痕
  presetAppliesOnCreate = false;
  resetCalls();
  const tI3 = mkCard("I3 双失败", "p-book");
  sendFails = new Set([`session-bench-new-${seq + 1}`]); // 预判下一条新建 id
  const rI3 = await call("POST", `/api/tasks/${encodeURIComponent(tI3.identifier)}/execute`, {});
  const bookI3 = rI3.payload?.launch?.bookDelivery ?? null;
  check("I6 双失败 ⇒ 200 + delivered=false + 原因（派发副作用仍有效）", rI3.status === 200 && bookI3?.delivered === false && bookI3?.reason === "bench-send-failed", `status=${rI3.status} bookDelivery=${JSON.stringify(bookI3)}`);
  check("I7 双失败 ⇒ authorization 里同样 delivered=false（授权≠送达）", rI3.payload?.launch?.authorization?.delivered === false, `authorization=${JSON.stringify(rI3.payload?.launch?.authorization)}`);
  check("I8 双失败 ⇒ 审计 authorize-exec-deliver 留痕", store.listGovernanceAudit({ action: "authorize-exec-deliver" }).some((a) => a.target === tI3.identifier && a.allowed === false), `audits=${store.listGovernanceAudit({ action: "authorize-exec-deliver" }).length}`);
  check("I9 双失败 ⇒ 卡上评论写明「任务书未送达」并给出处置", store.listComments(tI3.id).some((c) => /任务书未送达/.test(c.body) && /打开执行会话/.test(c.body)), `comments=${store.listComments(tI3.id).length}`);
  // I4 复用路径不适用（bookDelivery 显式 null，键恒在）
  sendFails = new Set();
  presetAppliesOnCreate = true;
  resetCalls();
  liveness = { "sess-prev-main": { exists: true, live: true, running: false, pending: 0 } };
  const tI4 = mkCard("I4 复用不适用", "p-prev");
  const rI4 = await call("POST", `/api/tasks/${encodeURIComponent(tI4.identifier)}/execute`, {});
  check("I10 复用路径 bookDelivery=null（键恒在，不适用≠失败）", rI4.payload?.launch?.mode === "reuse-bound" && rI4.payload?.launch?.bookDelivery === null, `mode=${rI4.payload?.launch?.mode} bookDelivery=${JSON.stringify(rI4.payload?.launch?.bookDelivery)}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  await rm(tmp, { recursive: true, force: true });
}

const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
console.log(`\n${pass}/${results.length} PASS`);
process.exit(pass === results.length ? 0 : 1);
