/**
 * 「人工验收 → 自动推进下一条」—— **真进程验证台**（依赖门 + 共享文件串行 + CLI 执行器 + 回流）。
 *
 * 为什么需要它：`G-ALL` 的链路尾段（… → 证据回流看板 → **人工验收** → **自动推进下一条**）此前
 * **没有可复跑的验证器** —— `tools/bench-gate-order.mjs` 只验「门是否先于副作用」，
 * `tools/bench-cli-chain.mjs` 只验**单卡**的 CLI 链；尾段只能靠一次性 `/private/tmp` 探针，跑完即删，
 * 不可复跑、无法防回归。本台把尾段做成可复跑证据。
 *
 * 台内拓扑（同一项目、同一需求条目）：
 *   A → B → C       依赖链（键 = task_dependencies）：A 未 done ⇒ B 停 `upstream-blocked`，C 同理
 *   D / E           两张都改同一个共享文件（`src/core/store.mjs`）⇒ FR-86 同轮只放行一条
 *
 * 断言的要害是**语义**而不是实现：
 *   ① 依赖未就绪**不得**越级派发；② 同轮的共享文件对**只放行一条**（另一条如实进 `serialized`）；
 *   ③ CLI 执行器跑完后卡**停在「待验收」**、留下证据评论与 `success` 尝试记录；
 *   ④ **没有人判 done，就不自动推进**（这条正是 FR-85「done 只能人置」在循环里的体现）；
 *   ⑤ 人判 done 之后，下一跳**自动**被派发（直到链尾）。
 *
 * 运行：`node tools/bench-auto-advance.mjs`（离线替身，秒级；不联网、不调真实 claude）
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-adv-bench-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "tb-adv-ws-"));
const binDir = await mkdtemp(path.join(os.tmpdir(), "tb-adv-bin-"));
// 离线替身：**不联网、不调真实 claude**；只在工作区写一个文件（让「真的产出了东西」成立）并吐三段式摘要。
const stub = path.join(binDir, "fake-claude");
await writeFile(stub, `#!/bin/sh\nmkdir -p .bench-out && echo ok > .bench-out/ran.txt\necho 'bench-stub: 改动摘要 / 验证结果 / 遗留风险 三段齐备'\nexit 0\n`, "utf8");
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
const ids = (rows) => (rows ?? []).map((x) => x?.task);
// 错误码在回包的 `error.code`（FR-21 契约）；无错误时返回空串，便于断言里直接拼接。
const codeOf = (r) => String(r?.payload?.error?.code ?? "");

const projectId = "bench-advance";
const created = await call("POST", "/api/projects", { id: projectId, name: "自动推进验证台", workspacePath: workspace });
check("建台内项目（workspacePath=临时目录）", created.status === 200 || created.status === 201, `status=${created.status}`);
const settings = await call("PUT", `/api/projects/${projectId}/settings`, {
  teamTemplate: {
    engine: "instruction",
    roles: [{ role: "engineer", executor: "cli:claude", count: 1 }],
    forbiddenExecutors: [],
    engineer: { executor: "cli:claude", verifyCommand: "echo bench-verify-ok" },
  },
});
check("项目设置：engineer.executor = cli:claude", settings.status === 200 || settings.status === 201, `status=${settings.status}`);

const item = store.createRequirementItem({ projectId, title: "验证台需求（自动推进）" });
const mkTask = async (title, description) => {
  const r = await call("POST", "/api/tasks", { projectId, title, description, status: "todo" });
  if (r.status !== 201) throw new Error(`建卡失败：${r.status} ${JSON.stringify(r.payload)}`);
  const t = r.payload.task;
  const a = await call("POST", `/api/tasks/${t.identifier}/attribution`, { requirement: item.identifier });
  if (a.status !== 200) throw new Error(`归因失败：${a.status} ${JSON.stringify(a.payload)}`);
  return t;
};

const A = await mkTask("链头 A", "新建 a.txt 写入链头产出。");
const B = await mkTask("链中 B", "新建 b.txt 写入链中产出。");
const C = await mkTask("链尾 C", "新建 c.txt 写入链尾产出。");
const D = await mkTask("共享文件 D", "修改 src/core/store.mjs 的一行注释。");
const E = await mkTask("共享文件 E", "修改 src/core/store.mjs 的另一行注释。");
check("建 5 张已归因的 todo 卡（A/B/C 依赖链 + D/E 共享文件对）", [A, B, C, D, E].every((t) => t?.identifier), `ids=${[A, B, C, D, E].map((t) => t.identifier).join(",")}`);
const dep1 = await call("POST", `/api/tasks/${B.identifier}/dependencies`, { blocker: A.identifier, reason: "A 未完成" });
const dep2 = await call("POST", `/api/tasks/${C.identifier}/dependencies`, { blocker: B.identifier, reason: "B 未完成" });
check("依赖链 B←A、C←B 建好", [dep1, dep2].every((r) => r.status === 201), `status=${dep1.status}/${dep2.status}`);

// ---- 第一轮：A 放行；B/C 必须停；D/E 只放行一条 ------------------------------------------
const loop1 = await call("POST", `/api/projects/${projectId}/execution-loop`, {});
const d1 = ids(loop1.payload?.dispatched);
const up1 = loop1.payload?.blockedByUpstream ?? [];
const ser1 = loop1.payload?.serialized ?? [];
check("第一轮：链头 A 被派发", d1.includes(A.identifier), `dispatched=${JSON.stringify(d1)}`);
check("第一轮：链中 B 停在 upstream-blocked（依赖未就绪不得越级）", up1.some((x) => x.task === B.identifier && x.reason === "upstream-blocked"), JSON.stringify(up1));
check("第一轮：链尾 C 停在 upstream-blocked", up1.some((x) => x.task === C.identifier), JSON.stringify(up1));
const shared = d1.filter((x) => x === D.identifier || x === E.identifier);
check("第一轮：同一共享文件的两张只放行一条（FR-86 显式串行）", shared.length === 1, `sharedDispatched=${JSON.stringify(shared)}`);
check("第一轮：被让行的那张如实进 serialized（带冲突文件与让行对象）",
  ser1.length === 1 && ser1[0].file === "store.mjs" && ser1[0].heldBy === shared[0],
  JSON.stringify(ser1));

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
const aAfter = await waitFor(A.identifier, (t) => t.status === "in_review");
check("链头 A 的 CLI 执行器跑完 → 停在「待验收」（执行侧不得写 done）", aAfter?.status === "in_review", `status=${aAfter?.status}`);
const runsA = store.listTaskRuns(A.identifier);
check("链头 A 留下 success 尝试记录", runsA.length >= 1 && runsA.some((r) => r.outcome === "success"), JSON.stringify(runsA.map((r) => r.outcome)));
const commentsA = await call("GET", `/api/tasks/${A.identifier}/comments`);
check("链头 A 留下证据评论（含执行器 stdout）",
  (commentsA.payload?.comments ?? []).some((c) => String(c.body ?? "").includes("bench-stub")),
  `comments=${(commentsA.payload?.comments ?? []).length}`);

// ---- 没有人判 done ⇒ 不得自动推进（FR-85「done 只能人置」在循环里的体现） --------------------
const loop1b = await call("POST", `/api/projects/${projectId}/execution-loop`, {});
const up1b = loop1b.payload?.blockedByUpstream ?? [];
check("未人工判定：B 仍不得推进（A 只是「待验收」，不算完成）", up1b.some((x) => x.task === B.identifier), JSON.stringify(ids(loop1b.payload?.dispatched)));
check("未人工判定：A 不被重复派发（已离开 todo）", !ids(loop1b.payload?.dispatched).includes(A.identifier), `dispatched=${JSON.stringify(ids(loop1b.payload?.dispatched))}`);

// ---- 人工判定 A 完成 ⇒ 下一跳自动放行 ----------------------------------------------------
// FR-83 补口（卡 `-162`）：`in_review → done` 现在有服务端评审门。
// 先钉**负向**：评审未通过就直接收口 ⇒ 必须被拒且零副作用（这正是"拖拽静默收口"那条旁路）。
const vA0 = store.requireTaskRef(A.identifier).version;
const closedBlind = await call("PATCH", `/api/tasks/${A.identifier}`, { status: "done", version: vA0 });
const aUntouched = store.requireTaskRef(A.identifier);
check("评审门：未评审直接 PATCH done ⇒ 拒（REVIEW_NOT_APPROVED / 409）",
  closedBlind.status === 409 && codeOf(closedBlind) === "REVIEW_NOT_APPROVED", `status=${closedBlind.status} code=${codeOf(closedBlind)}`);
check("评审门：被拒后**零副作用**（状态仍是待验收、版本未涨）",
  aUntouched.status === "in_review" && aUntouched.version === vA0, `status=${aUntouched.status} version=${aUntouched.version}/${vA0}`);

// 正向链路一：评审通过 → 人确认完成
const approveA = await call("POST", `/api/tasks/${A.identifier}/review`, { action: "approve", comment: "bench：评审通过" });
check("评审门：评审通过 200 且仍停在「待验收」（通过不自动完成）",
  approveA.status === 200 && approveA.payload?.task?.status === "in_review", `status=${approveA.status} task=${approveA.payload?.task?.status}`);
const vA = store.requireTaskRef(A.identifier).version;
const doneA = await call("PATCH", `/api/tasks/${A.identifier}`, { status: "done", version: vA });
check("人工把 A 判 done（评审通过后收口）", doneA.status === 200 && doneA.payload?.task?.status === "done", `status=${doneA.status} task=${doneA.payload?.task?.status}`);
const loop2 = await call("POST", `/api/projects/${projectId}/execution-loop`, {});
const d2 = ids(loop2.payload?.dispatched);
check("人工判 done 后：链中 B 被自动派发（自动推进下一条）", d2.includes(B.identifier), `dispatched=${JSON.stringify(d2)}`);
check("人工判 done 后：链尾 C 仍在 B 之后受阻", (loop2.payload?.blockedByUpstream ?? []).some((x) => x.task === C.identifier), JSON.stringify(loop2.payload?.blockedByUpstream));

const bAfter = await waitFor(B.identifier, (t) => t.status === "in_review");
check("链中 B 跑完 → 停在「待验收」", bAfter?.status === "in_review", `status=${bAfter?.status}`);
// 正向链路二：**显式跳过评审**（逃生口）——`skipReview: true` 才放行，且必须留痕
const vB = store.requireTaskRef(B.identifier).version;
const doneB = await call("PATCH", `/api/tasks/${B.identifier}`, { status: "done", version: vB, skipReview: true });
check("人工把 B 判 done（显式 skipReview 跳过评审）", doneB.status === 200 && doneB.payload?.task?.status === "done", `status=${doneB.status}`);
check("逃生口留痕：B 的事件流里有 review_skipped",
  store.listTaskEvents(B.identifier).some((e) => e.type === "review_skipped"), JSON.stringify(store.listTaskEvents(B.identifier).map((e) => e.type)));
const loop3 = await call("POST", `/api/projects/${projectId}/execution-loop`, {});
const d3 = ids(loop3.payload?.dispatched);
check("再判一次 done 后：链尾 C 被自动派发（链条推进到底）", d3.includes(C.identifier), `dispatched=${JSON.stringify(d3)}`);

// ---- 红线复核：循环自己从不写 done --------------------------------------------------------
const allNow = store.listTasks({ projectId }).map((t) => `${t.identifier}:${t.status}`);
check("红线：本轮里只有人置的两张是 done（循环不得自动置 done）",
  store.listTasks({ projectId }).filter((t) => t.status === "done").map((t) => t.identifier).sort().join(",") === [A.identifier, B.identifier].sort().join(","),
  allNow.join(" "));

// ---- 收尾 -------------------------------------------------------------------------------
console.log("");
const failed = results.filter((r) => !r.ok);
console.log(`---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
try { server.closeAllConnections?.(); } catch { /* ignore */ }
await new Promise((resolve) => server.close(resolve));
for (const dir of [dataDir, workspace, binDir]) await rm(dir, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
