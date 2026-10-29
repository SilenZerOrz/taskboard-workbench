/**
 * FR-97「无法规范流转的卡的两个出口」—— **隔离真宿主验证台**（真 `dsh` 进程 + 真 HTTP + 真会话投递）。
 *
 * ## 为什么需要它（卡 `-164` 立卡理由）
 * FR-97 此前只有**进程内 API 测试**（`tests/fr97-debug-outlets.test.mjs` 13 例）与 **stub 宿主**
 * 的 `bench-rebind-deliver.mjs`（30/30，验的是同源的会话三级回落）。两条都没能证明
 * 「真 `sendPrompt` 真的把调试指令投进了项目主会话、真会话流里读得到」—— 这一跳只有真宿主能给证据
 *（FR-95 的 `bench-host-naming` 走的就是这套形态）。
 *
 * ## 本台断言什么
 *   ① 插件在**全新 profile**（隔离 `DSH_HOME`）里激活成功；
 *   ② 项目主会话真建出来（`rebind confirm`，`mode=create`，落在项目工作区）；
 *   ③ **归因门差分对照**（不用改代码）：同一张卡、同一端点 `to-debug`，**归因前**必拒
 *      （`EXECUTION_NOT_ATTRIBUTED`）、**归因后**必放行 —— 唯一变量是归因，证明这条判据真在区分；
 *   ④ `dispatch-main-session` ⇒ `delivered=true`、`sessionId`＝项目主会话、卡 **进「进行中」**；
 *   ⑤ **真落地**：会话流（`session.v4.jsonl.zstd`）原文出现调试指令标题
 *      `# 任务：修复看板卡 <identifier> 无法规范流转的问题（调试修复）`；
 *   ⑥ 派发留痕：卡上新增评论含「已交项目主会话执行」；
 *   ⑦ `to-debug` 两次 ⇒ 加标签「执行调试」＋ 回「待办」，第二次 `idempotent=true` 且**标签不重复**；
 *   ⑧ 人工校验任务（`human_review` 标签）⇒ **两个出口都拒** `HUMAN_REVIEW_NOT_EXECUTABLE`（升级门不交出去）。
 *
 * ## 隔离边界
 * 临时 `DSH_HOME` + 最小 profile + 临时数据目录 + 随机端口 + 独立进程；**不装包、不联网、不删文件**，
 * **不碰用户的 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围：隔离验证台）。
 *
 * ## 运行
 * `node tools/bench-fr97-outlets.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（找不到 dsh / 起不来）⇒ 跳过，不算失败。
 */
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  —  ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>300s）——已强退，退出码 1"); process.exit(1); }, 300000);

// ---- 前置：dsh 可执行 + 全局安装里的两个 bundle --------------------------------------------
const dshBin = spawnSync("bash", ["-lc", "command -v dsh"], { encoding: "utf8" }).stdout.trim();
if (!dshBin) { console.error("SKIP  环境不具备：找不到 dsh（退出码 2）"); process.exit(2); }
const dshReal = spawnSync("node", ["-e", `console.log(require("node:fs").realpathSync(${JSON.stringify(dshBin)}))`], { encoding: "utf8" }).stdout.trim();
const GLOBAL_NM = path.resolve(path.dirname(dshReal), "..", "node_modules", "@deepseek-ai");
const bundles = ["dsh-base", "dsh-web-app"].map((n) => [n, path.join(GLOBAL_NM, n)]);
for (const [n, p] of bundles) {
  if (!existsSync(p)) { console.error(`SKIP  环境不具备：全局安装里找不到 ${n}（${p}）（退出码 2）`); process.exit(2); }
}

const ISOLATED = mkdtempSync(path.join(os.tmpdir(), "tb-bench-fr97-"));
const PROFILE = path.join(ISOLATED, "profiles", "iso");
const WS = path.join(ISOLATED, "tbws");
const LOG = path.join(ISOLATED, "dsh.log");
let child = null;
const cleanup = () => {
  try { if (child && child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
  try { if (child && child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已退出 */ }
  rmSync(ISOLATED, { recursive: true, force: true });
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

function makeProfile() {
  mkdirSync(path.join(PROFILE, "node_modules", "@deepseek-ai"), { recursive: true });
  for (const [n, p] of bundles) symlinkSync(p, path.join(PROFILE, "node_modules", "@deepseek-ai", n), "dir");
  symlinkSync(ROOT, path.join(PROFILE, "node_modules", "taskboard-workbench"), "dir");
  writeFileSync(path.join(PROFILE, "package.json"), JSON.stringify({
    name: "dsh-profile-bench-fr97",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
      "taskboard-workbench": `link:${ROOT}`,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "taskboard-workbench"] } },
  }, null, 2));
  mkdirSync(path.join(ISOLATED, "tbdata"), { recursive: true });
  mkdirSync(WS, { recursive: true });
}

async function boot(port) {
  writeFileSync(LOG, "");
  child = spawn(dshBin, ["--profile", "iso", "--no-open", "--port", String(port)], {
    cwd: ISOLATED,
    env: { ...process.env, DSH_HOME: ISOLATED, TB_DATA_DIR: path.join(ISOLATED, "tbdata") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const sink = (buf) => writeFileSync(LOG, String(buf), { flag: "a" });
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);
  for (let i = 0; i < 45; i += 1) {
    const txt = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(txt);
    if (m) return { port: Number(m[1]), token: m[2], log: txt };
    await sleep(1000);
  }
  return null;
}

/** 读会话流原文（宿主异步 append + zstd 落盘 ⇒ 轮询等待，直到出现 `until` 或超时）。 */
async function readSessionText(sessionId, { tries = 25, until = null } = {}) {
  const found = spawnSync("find", [path.join(ISOLATED, "sessions"), "-maxdepth", "2", "-name", sessionId], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)[0];
  let text = "";
  for (let i = 0; i < tries && found; i += 1) {
    text = spawnSync("zstd", ["-dc", path.join(found, "session.v4.jsonl.zstd")], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "";
    if (until ? until(text) : text.length) break;
    await sleep(1000);
  }
  return { text, dir: found ?? null };
}

makeProfile();
const port = await freePort();
const booted = await boot(port);
if (!booted) {
  console.log("SKIP  隔离真宿主 45s 内未起来（看日志：", LOG, "）（退出码 2，不算失败）");
  cleanup();
  process.exit(2);
}
const base = `http://127.0.0.1:${booted.port}`;
let exitCode = 0;
try {
  const hs = await fetch(`${base}/?token=${booted.token}`, { redirect: "manual" });
  const setC = typeof hs.headers.getSetCookie === "function" ? hs.headers.getSetCookie() : [hs.headers.get("set-cookie")].filter(Boolean);
  const cookie = setC.map((c) => /(dsh-auth-[^=]+)=([^;]+)/.exec(c ?? "")).find(Boolean)?.slice(1).join("=");
  const B = `${base}/integrations/taskboard-workbench/api`;
  const call = async (method, p, body) => {
    const r = await fetch(B + p, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    return { code: r.status, body: await r.json().catch(() => null) };
  };

  check("① 插件在**全新 profile**里激活成功（隔离 `DSH_HOME`）",
    /\[taskboard-workbench\] host ready:/.test(booted.log),
    (booted.log.split("\n").find((l) => l.includes("host ready")) ?? "(无 host ready 行)").slice(0, 110));

  // ---- 种子：项目 + 需求条目 + 一张受阻未归因的卡 + 一张人工校验卡 -------------------------
  const proj = (await call("POST", "/projects", { name: "FR97 隔离出口验证台", workspacePath: WS })).body?.project;
  const req = (await call("POST", "/requirements/items", { projectId: proj.id, title: "FR-97 隔离验证需求" })).body?.item;
  const mk = async (title, labels = []) => (await call("POST", "/tasks", { projectId: proj.id, title, status: "blocked", labels })).body?.task;
  const t = await mk("看板卡卡在受阻、需要交主会话调一次");
  const human = await mk("人工校验卡（升级门）", ["human_review"]);

  // ---- ③ 归因门**差分对照**：同一张卡、同一端点，只改「归因」这一个变量 -------------------
  const beforeAttr = await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/to-debug`, {});
  await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/attribution`, { requirement: req.id });
  const afterAttr = await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/to-debug`, {});
  check("③ 归因门差分对照：归因前 `to-debug` 拒（EXECUTION_NOT_ATTRIBUTED）／归因后放行",
    beforeAttr.code >= 400 && beforeAttr.body?.error?.code === "EXECUTION_NOT_ATTRIBUTED" && afterAttr.code === 200,
    `before=${beforeAttr.code}/${beforeAttr.body?.error?.code} after=${afterAttr.code}`);

  // ---- ⑦ to-debug 幂等：第二次不再重复加标签 ----------------------------------------------
  const dbg1 = await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/to-debug`, {});
  const dbg2 = await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/to-debug`, {});
  const dbgLabels = dbg2.body?.task?.labels ?? [];
  check("⑦ `to-debug` 加标签「执行调试」+ 回「待办」，且**两次不重复加标签**（`idempotent=true`）",
    dbg1.body?.labeled === true && dbg2.body?.idempotent === true
      && dbgLabels.filter((l) => l === "执行调试").length === 1 && dbg2.body?.task?.status === "todo",
    `labels=${JSON.stringify(dbgLabels)} status=${dbg2.body?.task?.status} idempotent=${dbg2.body?.idempotent}`);

  // ---- ② 项目主会话真建出来 ----------------------------------------------------------------
  const rb = await call("POST", `/projects/${encodeURIComponent(proj.id)}/sessions/rebind`, { confirm: true });
  const mainSid = rb.body?.after ?? rb.body?.sessionId ?? null;
  check("② 项目主会话真建出来（`mode=create`，落在项目工作区）",
    rb.code === 200 && rb.body?.rebound === true && rb.body?.mode === "create" && typeof mainSid === "string",
    `code=${rb.code} mode=${rb.body?.mode} after=${String(mainSid).slice(0, 24)}`);

  // ---- ④ 出口一：交项目主会话执行 ----------------------------------------------------------
  const disp = await call("POST", `/tasks/${encodeURIComponent(t.identifier)}/dispatch-main-session`, { note: "隔离台自动派发" });
  const dl = disp.body ?? {};
  const afterDisp = (await call("GET", `/tasks/${encodeURIComponent(t.identifier)}`)).body?.task ?? {};
  check("④ `dispatch-main-session` ⇒ delivered=true、sessionId＝项目主会话、卡进「进行中」",
    dl.delivered === true && dl.sessionId === mainSid && afterDisp.status === "in_progress",
    `delivered=${dl.delivered} sid=${String(dl.sessionId ?? "").slice(0, 20)} same=${dl.sessionId === mainSid} status=${afterDisp.status}`);

  // ---- ⑤ 真落地：会话流原文里读得到调试指令标题 --------------------------------------------
  const marker = `# 任务：修复看板卡 ${t.identifier} 无法规范流转的问题（调试修复）`;
  const sess = await readSessionText(mainSid, { until: (txt) => txt.includes(marker) });
  check("⑤ 指令**真投进**项目主会话（会话流原文命中调试指令标题）",
    Boolean(sess.dir) && sess.text.includes(marker),
    `${sess.dir ? "session 目录已找到" : "未找到 session 目录"} · 命中=${sess.text.includes(marker)}`);

  // ---- ⑥ 派发留痕 -------------------------------------------------------------------------
  const comments = (await call("GET", `/tasks/${encodeURIComponent(t.identifier)}/comments`)).body?.comments ?? [];
  check("⑥ 派发留痕：卡上新增评论含「已交项目主会话执行」",
    comments.some((c) => String(c.body ?? "").includes("已交项目主会话执行")),
    `comments=${comments.length}`);

  // ---- ⑧ 人工校验任务：两个出口都拒 --------------------------------------------------------
  const hHuman = await call("POST", `/tasks/${encodeURIComponent(human.identifier)}/dispatch-main-session`, {});
  const dHuman = await call("POST", `/tasks/${encodeURIComponent(human.identifier)}/to-debug`, {});
  check("⑧ 人工校验任务（`human_review`）⇒ 两个出口都拒 `HUMAN_REVIEW_NOT_EXECUTABLE`（升级门不交出去）",
    hHuman.body?.error?.code === "HUMAN_REVIEW_NOT_EXECUTABLE" && dHuman.body?.error?.code === "HUMAN_REVIEW_NOT_EXECUTABLE",
    `dispatch=${hHuman.code}/${hHuman.body?.error?.code} to-debug=${dHuman.code}/${dHuman.body?.error?.code}`);
} finally {
  cleanup();
  clearTimeout(watchdog);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n---- 合计 ${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length} ----`);
console.log("（隔离实例与临时 home 已删除）");
process.exit(failed.length ? 1 : exitCode);
