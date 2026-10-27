/**
 * 看板 → CLI 执行器（claude）→ 证据回流 → 待验收 —— **真进程验证台**。
 *
 * 为什么需要它：G-ALL 的核心机制是「看板派发 → DSH 侧用 `claude` CLI 真实开发 → 证据回流 → 人工验收」，
 * 而仓库里至今只有一个**门序**验证台（`tools/bench-gate-order.mjs`）。缺这一台，
 * 「CLI 执行器整条链」只能靠一次性的 `/private/tmp` 探针脚本取证，跑完即删 ⇒ 不可复跑、无法防回归。
 *
 * 本台用仓库自己的独立验证台（`src/server/server.mjs#createServer`）起**真实 http 服务**
 * （随机端口 + 临时 dataDir + 真实 SQLite 文件），走完整链路：
 *   HTTP → router → store → `claimForCliExecution` → `runCliExecutor`（**真的 spawn 子进程**）→ 证据评论 → 状态回流。
 *
 * 两个部分：
 *   A. **离线替身**（默认跑）：`TB_CLI_EXECUTOR_BIN` 指向临时脚本 ⇒ 断言全链路（认领/证据/尝试/评审请求/失败会计/done 红线）。
 *   B. **真实 claude**（`TB_BENCH_REAL=1` 才跑）：在**临时工作区**里真跑一次 `claude -p`（只读工具），
 *      断言退出码 0 + 证据回流 + 停在「待验收」。**不碰你的仓库、不碰 `.data/`、不碰 `:3080`**。
 *
 * 运行：
 *   node tools/bench-cli-chain.mjs                 # 只跑 A（秒级）
 *   TB_BENCH_REAL=1 node tools/bench-cli-chain.mjs # A + B（B 会真调 claude，约 1 分钟）
 *
 * 退出码：0 = 全 PASS；1 = 有 FAIL。
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import http from "node:http";
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

const dataDir = await mkdtemp(path.join(os.tmpdir(), "tb-cli-bench-"));
const workspace = await mkdtemp(path.join(os.tmpdir(), "tb-cli-ws-"));
const binDir = await mkdtemp(path.join(os.tmpdir(), "tb-cli-bin-"));
await writeFile(path.join(workspace, "README.md"), "# bench workspace\n（本目录为验证台自建，跑完即删）\n", "utf8");

const okBin = path.join(binDir, "fake-claude-ok");
const failBin = path.join(binDir, "fake-claude-fail");
// 每次真起子进程都留一行标记 —— 让「门是否先于副作用」成为**可观测事实**（不起进程＝文件不存在）。
const markFile = path.join(binDir, "spawned.mark");
await writeFile(okBin, `#!/bin/sh\necho spawn >> "${markFile}"\necho 'bench-fake-cli: 改动摘要/验证结果/遗留风险 三段齐备'\nexit 0\n`, "utf8");
await writeFile(failBin, `#!/bin/sh\necho spawn >> "${markFile}"\necho 'bench-fake-cli: boom' >&2\nexit 3\n`, "utf8");
await chmod(okBin, 0o755);
await chmod(failBin, 0o755);

const store = openStore({ dataDir, env: {} });
ensureDefaultProject(store);
const server = createServer({ store, webDir: path.join(ROOT, "web") });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// HTTP 客户端**不用裸 `fetch`**（2026-10-26 真跑发现）：本台 B 部分会同步等一次真跑 claude，
// 而 `TB_BENCH_REAL_TIMEOUT_MS` 默认为 600000（文档还写着真实任务可达 14 分钟），裸 `fetch` 走
// undici，其 `headersTimeout` 默认 **300s** ⇒ 只要那次真跑超过 5 分钟，**台子自己先断**
// （`HeadersTimeoutError`，无判定、无清理，还会被误读成产品故障）。改用 `node:http` 并关闭请求空闲超时，
// 让等待时长只由产品自己的 `timeoutMs` 决定。
const call = (method, urlPath, body) => new Promise((resolve, reject) => {
  const text = body === undefined ? null : JSON.stringify(body);
  const req = http.request({
    host: "127.0.0.1",
    port: server.address().port,
    path: urlPath,
    method,
    headers: text === null ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(text) },
  }, (res) => {
    let raw = "";
    res.setEncoding("utf8");
    res.on("data", (chunk) => { raw += chunk; });
    res.on("end", () => {
      let payload = null;
      try { payload = JSON.parse(raw); } catch { /* 非 JSON */ }
      resolve({ status: res.statusCode, payload });
    });
  });
  req.on("error", reject);
  req.setTimeout(0); // 关掉空闲超时：真跑 claude 可长达十几分钟，只认产品的 timeoutMs
  if (text !== null) req.write(text);
  req.end();
});

// ---- 台内项目：workspacePath 指向**临时目录**（真实 claude 只在里面跑，绝不碰用户仓库） ----
const projectId = "bench-cli";
const created = await call("POST", "/api/projects", { id: projectId, name: "CLI 链路验证台", workspacePath: workspace });
check("建台内项目（workspacePath=临时目录）", created.status === 201 || created.status === 200, `status=${created.status}`);

const settings = await call("PUT", `/api/projects/${projectId}/settings`, {
  teamTemplate: {
    engine: "instruction",
    roles: [{ role: "engineer", executor: "cli:claude", count: 1 }],
    forbiddenExecutors: [],
    engineer: {
      executor: "cli:claude",
      // **不覆盖 `args`**：让 B 部分（真实 claude）跑**产品默认参数**
      // （`-p --permission-mode acceptEdits --allowedTools "<默认放行集>" --add-dir <cwd>`）。
      // 校准来由（2026-10-22 首跑真发现）：原先覆盖成 `["-p","--allowedTools","Read"]`（只读），
      // 而 `buildTaskPrompt()` 的指令是「直接改代码完成该任务…完成后运行自测」——
      // **指令不可完成** ⇒ 真实 claude 空转、触顶被 SIGTERM（exit=143 / outcome=timeout）⇒ 台给出**假 FAIL**。
      // 工作目录是 `mkdtemp` 临时目录、跑完即删，允许写入是安全的。
      verifyCommand: "echo bench-verify-ok",
    },
  },
});
check("项目设置：engineer.executor = cli:claude", settings.status === 200 || settings.status === 201, `status=${settings.status}`);

const item = store.createRequirementItem({ projectId, title: "验证台需求（自建）" });
const mkTask = async (title, extra = {}) => {
  const r = await call("POST", "/api/tasks", { projectId, title, status: "todo", ...extra });
  if (r.status !== 201) throw new Error(`建卡失败：${r.status} ${JSON.stringify(r.payload)}`);
  return r.payload.task;
};

// ---- A① 归因门：未归因的卡不得交给 CLI 执行器 -----------------------------------------
const orphan = await mkTask("游离卡（未归因）");
const a1 = await call("POST", `/api/tasks/${orphan.identifier}/exec-cli`, {});
check("未归因卡 → 400 EXECUTION_NOT_ATTRIBUTED（不跑 CLI）",
  a1.status === 400 && a1.payload?.error?.code === "EXECUTION_NOT_ATTRIBUTED",
  `status=${a1.status} code=${a1.payload?.error?.code}`);
check("被拒的卡不得留执行痕迹（尝试记录仍 0）", store.listTaskRuns(orphan.identifier).length === 0,
  `runs=${store.listTaskRuns(orphan.identifier).length}`);
check("门先于副作用：被拒时**子进程一个都没起**", existsSync(markFile) === false,
  `spawned.mark exists=${existsSync(markFile)}`);
check("被拒后状态原地不动（仍 todo）", store.requireTaskRef(orphan.identifier).status === "todo",
  `status=${store.requireTaskRef(orphan.identifier).status}`);

// ---- A② dryRun：只回执行计划，不真跑 ----------------------------------------------------
const card = await mkTask("验证台卡 A：跑通 CLI 链路");
const attr = await call("POST", `/api/tasks/${card.identifier}/attribution`, { requirement: item.identifier });
check("归因写入（为后续执行门放行）", attr.status === 200, `status=${attr.status}`);
const dry = await call("POST", `/api/tasks/${card.identifier}/exec-cli?dryRun=1`, {});
check("dryRun → 200 plan（executor/cwd/args/prompt 齐备）",
  dry.status === 200 && dry.payload?.plan?.executor === "cli:claude" && dry.payload?.plan?.cwd === workspace,
  `executor=${dry.payload?.plan?.executor} cwd=${dry.payload?.plan?.cwd}`);
check("dryRun 的 prompt 自包含（含任务号 + 自测命令）",
  String(dry.payload?.plan?.prompt ?? "").includes(card.identifier) && String(dry.payload?.plan?.prompt ?? "").includes("echo bench-verify-ok"),
  `promptLen=${String(dry.payload?.plan?.prompt ?? "").length}`);
check("dryRun 不落痕迹（仍 0 尝试、状态未动）",
  store.listTaskRuns(card.identifier).length === 0 && store.requireTaskRef(card.identifier).status === "todo",
  `runs=${store.listTaskRuns(card.identifier).length} status=${store.requireTaskRef(card.identifier).status}`);

// ---- A③ 真跑（替身进程）：认领 → 证据评论 → 尝试记录 → 待验收 + 评审请求 --------------------
process.env.TB_CLI_EXECUTOR_BIN = okBin;
const runA = await call("POST", `/api/tasks/${card.identifier}/exec-cli`, { timeoutMs: 30000 });
const cardAfter = store.requireTaskRef(card.identifier);
const runs = store.listTaskRuns(card.identifier);
const comments = store.listComments(card.id).map((c) => String(c.body ?? ""));
check("真跑（替身）→ 200 且退出码 0", runA.status === 200 && runA.payload?.ok === true && runA.payload?.exitCode === 0,
  `status=${runA.status} ok=${runA.payload?.ok} exit=${runA.payload?.exitCode}`);
check("认领语义：todo 卡走授权门并转「进行中」", runA.payload?.claim?.claimed === true && runA.payload?.claim?.note === "authorized",
  `claim=${JSON.stringify(runA.payload?.claim ?? null)}`);
check("真跑时子进程确实起过（spawned.mark 存在 ⇒ 上面的「没起」不是空转）", existsSync(markFile) === true,
  `spawned.mark exists=${existsSync(markFile)}`);
check("状态回流：成功 → 待验收", cardAfter.status === "in_review", `status=${cardAfter.status}`);
check("评审请求：reviewState=pending", cardAfter.reviewState === "pending", `reviewState=${cardAfter.reviewState}`);
check("尝试记录：1 条 success", runs.length === 1 && runs[0].outcome === "success", JSON.stringify(runs.map((r) => r.outcome)));
check("证据评论：含执行器/退出码/改动清单", comments.some((b) => b.includes("CLI 执行器")),
  `comments=${comments.length}`);
check("评审留言：明确「待人工验收」", comments.some((b) => b.includes("待人工验收")), `comments=${comments.length}`);
check("红线：执行侧不得写 done", cardAfter.status !== "done", `status=${cardAfter.status}`);
let doneRedline = false;
try { store.teamSetTaskStatus(card.identifier, { status: "done", actor: "bench" }); } catch (e) { doneRedline = /完成只能由人确认/.test(String(e?.message ?? e)); }
check("红线：teamSetTaskStatus(done) 被拒（完成只能人置）", doneRedline, doneRedline ? "已抛错" : "未抛错");

// ---- A④ 失败路径：退出码非 0 → 失败会计 + 受阻 ------------------------------------------
const card2 = await mkTask("验证台卡 B：失败路径");
await call("POST", `/api/tasks/${card2.identifier}/attribution`, { requirement: item.identifier });
process.env.TB_CLI_EXECUTOR_BIN = failBin;
const runB = await call("POST", `/api/tasks/${card2.identifier}/exec-cli`, { timeoutMs: 30000 });
const runsB = store.listTaskRuns(card2.identifier);
check("失败路径 → 退出码 3 且如实回包", runB.status === 200 && runB.payload?.ok === false && runB.payload?.exitCode === 3,
  `ok=${runB.payload?.ok} exit=${runB.payload?.exitCode}`);
check("失败会计：尝试记录 failed", runsB.length === 1 && runsB[0].outcome === "failed", JSON.stringify(runsB.map((r) => r.outcome)));
check("失败后状态如实（受阻或待验收之外的失败态）", ["blocked", "in_progress", "todo"].includes(store.requireTaskRef(card2.identifier).status),
  `status=${store.requireTaskRef(card2.identifier).status}`);

/* ============================================================================
 * A⑤/A⑥ 真机 `-122` 两个缺陷的**端到端**证据（2026-10-22）
 *   前提与真机一致：① 工作区是真实 git 仓库且**开跑前就脏**；② CLI 子进程**长跑**。
 *   为了秒级可复跑，这里把心跳间隔压到 250ms（`runCliExecutor({heartbeatIntervalMs})`，
 *   复用生产同一条代码路径）；阈值仍是生产的 10 分钟 —— 断言的是"在途时不得判停滞"，
 *   与心跳间隔无关。
 * ========================================================================== */
{
  const { execFileSync } = await import("node:child_process");
  const { executeTaskWithCli, evidenceComment, pathOfStatusLine } = await import("../src/core/executor.mjs");
  const dirtyWs = await mkdtemp(path.join(os.tmpdir(), "tb-cli-dirty-ws-"));
  const git = (...a) => execFileSync("git", ["-C", dirtyWs, ...a], { encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "bench@bench");
  git("config", "user.name", "bench");
  await writeFile(path.join(dirtyWs, "tool-surface.mjs"), "export const TOOLS = [1, 2, 3];\n", "utf8");
  await writeFile(path.join(dirtyWs, "untouched.mjs"), "export const OTHER = 1;\n", "utf8");
  git("add", ".");
  git("commit", "-qm", "init");
  // 真机前提：开跑前先手工弄脏**两个**文件并留在工作区（本仓库开跑前 181 项脏改动）——
  // 其中 `tool-surface.mjs` 是本次主产出（会被桩 CLI 改），`untouched.mjs` 执行器一个指头都不碰。
  await writeFile(path.join(dirtyWs, "tool-surface.mjs"), "export const TOOLS = [1, 2, 3];\n// 执行前的历史脏改动\n", "utf8");
  await writeFile(path.join(dirtyWs, "untouched.mjs"), "export const OTHER = 1;\n// 与本次执行无关的历史脏改动\n", "utf8");
  const dirtyStatus = git("status", "--porcelain").trim();

  const projectD = await call("POST", "/api/projects", { id: "bench-cli-dirty", name: "脏仓库验证台", workspacePath: dirtyWs });
  check("建脏仓库台内项目（真实 git 仓库 + 开跑前已脏）", (projectD.status === 201 || projectD.status === 200) && dirtyStatus.includes("tool-surface.mjs"),
    `status=${projectD.status} porcelain=${JSON.stringify(dirtyStatus)}`);
  await call("PUT", "/api/projects/bench-cli-dirty/settings", {
    teamTemplate: { engine: "instruction", roles: [{ role: "engineer", executor: "cli:claude", count: 1 }], forbiddenExecutors: [] },
  });
  const cardDRes = await call("POST", "/api/tasks", { projectId: "bench-cli-dirty", title: "验证台卡 D：脏仓库 + 长跑", status: "todo" });
  const cardD = cardDRes.payload?.task;
  check("脏仓库台建卡", cardDRes.status === 201 && Boolean(cardD?.identifier), `status=${cardDRes.status}`);
  // 归因必须指**同项目**的需求条目（跨项目会被 DEPENDENCY_CROSS_PROJECT 拒）
  const itemD = store.createRequirementItem({ projectId: "bench-cli-dirty", title: "脏仓库验证台需求" });
  const attrD = await call("POST", `/api/tasks/${cardD.identifier}/attribution`, { requirement: itemD.identifier });
  check("脏仓库卡归因写入", attrD.status === 200, `status=${attrD.status} body=${JSON.stringify(attrD.payload)?.slice(0, 200)}`);

  // 桩 CLI：改**同一个**（本来就脏的）文件 + 长跑 6s（够打出多次心跳）
  const longBin = path.join(binDir, "fake-claude-long");
  await writeFile(longBin, [
    "#!/bin/sh",
    `cat > /dev/null`,
    `printf '%s\\n' 'export const TOOLS = [1, 2, 3];' '// 执行前的历史脏改动' 'export const TOOLS_2 = 9;' > "${dirtyWs}/tool-surface.mjs"`,
    `sleep 6`,
    `echo 'bench: 脏仓库长跑完成'`,
    `exit 0`,
  ].join("\n"), "utf8");
  await chmod(longBin, 0o755);

  const taskD = store.requireTaskRef(cardD.identifier);
  // 先按产品口径认领（todo → 进行中 + 认领锁 + 尝试记录），与 `/exec-cli` 同步分支同源
  store.startTaskExecution(taskD.identifier, { sessionId: null });
  process.env.TB_CLI_EXECUTOR_BIN = longBin;
  // 走**产品同一条写回路径**（`executeTaskWithCli`）；只把心跳间隔压到 250ms 让台秒级可跑。
  const inFlight = executeTaskWithCli({
    store, task: store.requireTaskRef(taskD.identifier), project: store.requireProject("bench-cli-dirty"),
    settings: store.getProjectSettings("bench-cli-dirty"),
    env: { ...process.env }, timeoutMs: 60000, heartbeatIntervalMs: 250,
  });
  await new Promise((r) => setTimeout(r, 1200)); // 让子进程起 + 若干次心跳落库

  // ---- 缺陷B：在途时 HTTP 口径不得误判 ------------------------------------------------
  const mid = await call("GET", `/api/tasks/${taskD.identifier}/execution`);
  check("缺陷B：在途 → watchdog 不得判 stalled", mid.payload?.watchdog?.state !== "stalled",
    `state=${mid.payload?.watchdog?.state} reason=${mid.payload?.watchdog?.reason}`);
  check("缺陷B：在途 → claim.stale 不得为 true", mid.payload?.claim?.stale === false,
    `stale=${mid.payload?.claim?.stale} hbAge=${mid.payload?.claim?.heartbeatAgeSeconds}s`);
  check("缺陷B：在途 → 不得产出 stalled 诊断", !(mid.payload?.diagnostics ?? []).some((d) => d.kind === "stalled"),
    `kinds=${JSON.stringify((mid.payload?.diagnostics ?? []).map((d) => d.kind))}`);
  check("缺陷B：在途 → 「退回待办（重新派发）」不得出现（一点就与在写的子进程并发）",
    !(mid.payload?.diagnostics ?? []).some((d) => /退回待办/.test(JSON.stringify(d.actions ?? []))),
    `actions=${JSON.stringify((mid.payload?.diagnostics ?? []).flatMap((d) => (d.actions ?? []).map((a) => a.label)))}`);
  check("缺陷B：执行期心跳确实在续（heartbeats > 1，不再只写一次认领）",
    Number(mid.payload?.currentRun?.heartbeats ?? 0) > 1, `heartbeats=${mid.payload?.currentRun?.heartbeats}`);

  await inFlight;
  const afterD = store.requireTaskRef(taskD.identifier);
  // ---- 缺陷A：脏仓库里改「本来就脏」的文件必须进证据清单 ------------------------------
  const evidence = store.listComments(afterD.id).map((c) => String(c.body ?? "")).find((b) => b.includes("本次工作区改动")) ?? "";
  check("缺陷A：证据评论的改动清单必须列出『开跑前已脏 + 本次被改』的主产出",
    evidence.includes("tool-surface.mjs") && /本次工作区改动（\d+）/.test(evidence),
    `evidence=${JSON.stringify(evidence.slice(0, 400))}`);
  check("缺陷A 红线：执行前的历史脏改动不得被当成本次产出（未被碰过的脏文件不列）",
    !evidence.includes("untouched.mjs"), `untouched 不应出现在清单里；evidence=${JSON.stringify(evidence.slice(0, 300))}`);
  // ---- 缺陷B：子进程结束后心跳停、状态如实回落 ----------------------------------------
  check("缺陷B：结束后状态如实回落到既有口径（成功 → 待验收）", afterD.status === "in_review", `status=${afterD.status}`);
  check("缺陷B：结束后尝试已闭合（在途信号自然消失，无常驻心跳）",
    store.getCurrentRun(afterD) === null && (afterD.lastHeartbeatAt ?? null) === null,
    `currentRun=${store.getCurrentRun(afterD)} lastHeartbeatAt=${afterD.lastHeartbeatAt ?? null}`);
  delete process.env.TB_CLI_EXECUTOR_BIN;
  await rm(dirtyWs, { recursive: true, force: true });
}

// ---- B 真实 claude（可选）：临时工作区里真跑一次 ------------------------------------------
if (String(process.env.TB_BENCH_REAL ?? "") === "1") {
  delete process.env.TB_CLI_EXECUTOR_BIN;
  // 超时可调：真实开发任务动辄数分钟（真机实测 -70 ≈ 79s、-107 ≈ 111s、-73 ≈ 14min）。
  const realTimeoutMs = Number(process.env.TB_BENCH_REAL_TIMEOUT_MS ?? 600000);
  // 任务描述必须**具体且最小**：标题越空泛，claude 越容易在临时目录里空转（首跑真发现）。
  const card3 = await mkTask("验证台卡 C：真实 claude", {
    description: [
      "在工作目录下新建 `hello.mjs`：导出 `add(a, b)` 返回两数之和。",
      "再新建 `hello.test.mjs`：用 `node:test` + `node:assert` 断言 `add(2,3) === 5`。",
      "最后运行 `node --test` 并把输出贴出来。只碰这两个文件，不做其它改动。",
    ].join("\n"),
  });
  await call("POST", `/api/tasks/${card3.identifier}/attribution`, { requirement: item.identifier });
  console.log(`… 正在真跑 claude（产品默认参数，工作目录=临时目录），上限 ${Math.round(realTimeoutMs / 1000)}s`);
  const runC = await call("POST", `/api/tasks/${card3.identifier}/exec-cli`, { timeoutMs: realTimeoutMs });
  const after3 = store.requireTaskRef(card3.identifier);
  const runsC = store.listTaskRuns(card3.identifier);
  check("真实 claude → 退出码 0", runC.status === 200 && runC.payload?.exitCode === 0 && runC.payload?.ok === true,
    `ok=${runC.payload?.ok} exit=${runC.payload?.exitCode} reason=${runC.payload?.reason ?? ""}`);
  check("真实 claude → 工作目录就是临时工作区（未碰用户仓库）", runC.payload?.cwd === workspace, `cwd=${runC.payload?.cwd}`);
  // 强证据：**真的产出了文件**（只看退出码 0 会把「什么都没干」也算通过）
  check("真实 claude → 工作区真的产出改动（files 非空）", Array.isArray(runC.payload?.files) && runC.payload.files.length > 0,
    `files=${JSON.stringify(runC.payload?.files ?? null)}`);
  check("真实 claude → 证据回流并停在「待验收」", after3.status === "in_review" && after3.reviewState === "pending",
    `status=${after3.status} reviewState=${after3.reviewState}`);
  check("真实 claude → 尝试记录 success", runsC.length === 1 && runsC[0].outcome === "success", JSON.stringify(runsC.map((r) => r.outcome)));
} else {
  console.log("SKIP  B 部分（真实 claude）：设置 TB_BENCH_REAL=1 才跑");
}

// 收尾：node 的 fetch 会留 keep-alive 连接，只调 close() 可能一直等下去（反证轮实测卡住）
// ⇒ 先断开所有连接再关；最后仍显式 process.exit（见文件尾），不给残留句柄留机会。
try { server.closeAllConnections?.(); } catch { /* 老 node 无此 API 时忽略 */ }
server.close();
store.close();
for (const dir of [dataDir, workspace, binDir]) await rm(dir, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
process.exit(failed.length === 0 ? 0 : 1);
