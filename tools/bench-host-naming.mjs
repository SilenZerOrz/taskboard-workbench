/**
 * FR-95「会话命名」—— **真宿主验证台**（真 `dsh` 进程 + 真 `sessionController.rename`）。
 *
 * 为什么需要它：FR-95 的命名链（看板算名 → 建会话 → 宿主 rename → 用户可见）此前只有**桩宿主**
 * 的证据（`tools/bench-rebind-deliver.mjs` 用复刻契约的假 port）与**单测**（钉字符串形状）。
 * 真机那一段长期只能靠「人工点一次启动执行 + 肉眼与会话流」判断，于是 2026-10-26 之前
 * 一直**查不出**它到底有没有落地（旧会话流里根本没有 `rename` 接线，样本不可判）。
 *
 * 本台用**隔离真宿主**把这一段做成可复跑证据：
 *   ① 临时 `DSH_HOME` + 最小 profile（`dsh-base` / `dsh-web-app` / 本仓库三个软链，
 *      **不装包、不碰 `~/.dsh/**`**）⇒ 这正是「全新 profile 装插件」的形态；
 *   ② 起真 `dsh`（随机端口）→ 打真 HTTP：建项目 → 建需求条目 → 建任务 → 归因 → `POST /execute`；
 *   ③ 判定三条：回包 `titleApplied === true`、`sessionName` 形如 `【任务】… · 时间`、
 *      会话流里出现 `source.kind=user` 的同名 `session/title` 事件且**其后没有** provider/fallback 覆盖。
 *
 * 隔离边界：临时 `DSH_HOME` + 临时 `TB_DATA_DIR` + 随机端口 + 独立进程，跑完即删（含被建的会话）。
 * **不碰用户的 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围：隔离验证台）。
 *
 * 运行：`node tools/bench-host-naming.mjs`
 * 退出码：0 = 全 PASS；1 = 有用例 FAIL；2 = 环境不具备（找不到 dsh / 起不来）⇒ 跳过，不算失败。
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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
const watchdog = setTimeout(() => { console.error("FAIL  验证台整体超时（>240s）——已强退，退出码 1"); process.exit(1); }, 240000);

// ---- 前置：dsh 可执行 + 全局安装里的两个 bundle --------------------------------------------
const dshBin = spawnSync("bash", ["-lc", "command -v dsh"], { encoding: "utf8" }).stdout.trim();
if (!dshBin) { console.error("SKIP  环境不具备：找不到 dsh（退出码 2）"); process.exit(2); }
const dshReal = spawnSync("node", ["-e", `console.log(require("node:fs").realpathSync(${JSON.stringify(dshBin)}))`], { encoding: "utf8" }).stdout.trim();
const GLOBAL_NM = path.resolve(path.dirname(dshReal), "..", "node_modules", "@deepseek-ai");
const bundles = ["dsh-base", "dsh-web-app"].map((n) => [n, path.join(GLOBAL_NM, n)]);
for (const [n, p] of bundles) {
  if (!existsSync(p)) { console.error(`SKIP  环境不具备：全局安装里找不到 ${n}（${p}）（退出码 2）`); process.exit(2); }
}

const ISOLATED = mkdtempSync(path.join(os.tmpdir(), "tb-bench-host-naming-"));
const PROFILE = path.join(ISOLATED, "profiles", "iso");
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

/** 建最小 profile：三个软链 + 一份 package.json（与「全新 profile 装本插件」同形）。 */
function makeProfile() {
  mkdirSync(path.join(PROFILE, "node_modules", "@deepseek-ai"), { recursive: true });
  for (const [n, p] of bundles) symlinkSync(p, path.join(PROFILE, "node_modules", "@deepseek-ai", n), "dir");
  symlinkSync(ROOT, path.join(PROFILE, "node_modules", "taskboard-workbench"), "dir");
  writeFileSync(path.join(PROFILE, "package.json"), JSON.stringify({
    name: "dsh-profile-bench-iso",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
      "taskboard-workbench": `link:${ROOT}`,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "taskboard-workbench"] } },
  }, null, 2));
  mkdirSync(path.join(ISOLATED, "tbdata"), { recursive: true });
  mkdirSync(path.join(ISOLATED, "tbws"), { recursive: true });
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
  for (let i = 0; i < 40; i += 1) {
    const txt = existsSync(LOG) ? readFileSync(LOG, "utf8") : "";
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/.exec(txt);
    if (m) return { port: Number(m[1]), token: m[2], log: txt };
    await sleep(1000);
  }
  return null;
}

/**
 * 读某会话的 title 事件与落盘 cwd（宿主异步 append + zstd 落盘 ⇒ 轮询等待）。
 * `until`：等到「已落盘事件满足条件」才收手 —— **不要**用「有事件就 break」：对一个**已有历史**的会话，
 * 那样会在改名落盘之前就收手，得到「没改名」的**假阴性**（本台第一版就踩了这个坑，用例 ⑫ 假红）。
 */
async function readSessionEvidence(sessionId, { tries = 20, until = null } = {}) {
  const dir = sessionId
    ? spawnSync("find", [path.join(ISOLATED, "sessions"), "-maxdepth", "2", "-name", sessionId], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)[0]
    : null;
  let cwd = null; let titleEvents = [];
  for (let i = 0; i < tries && dir; i += 1) {
    const out = spawnSync("zstd", ["-dc", path.join(dir, "session.v4.jsonl.zstd")], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "";
    const lines = out.split("\n").filter(Boolean);
    if (lines.length) cwd = JSON.parse(lines[0]).cwd ?? cwd;
    titleEvents = lines.filter((l) => l.includes('"type":"session/title"')).map((l) => JSON.parse(l).data);
    if (titleEvents.length && (!until || until({ cwd, titleEvents }))) break;
    await sleep(1000);
  }
  return { cwd, titleEvents };
}

// ---- 主流程 ---------------------------------------------------------------------------------
makeProfile();
const port = await freePort();
const booted = await boot(port);
if (!booted) {
  console.log("SKIP  隔离真宿主 40s 内未起来（看日志：", LOG, "）（退出码 2，不算失败）");
  cleanup();
  process.exit(2);
}
const base = `http://127.0.0.1:${booted.port}`;
const hs = await fetch(`${base}/?token=${booted.token}`, { redirect: "manual" });
const setC = typeof hs.headers.getSetCookie === "function" ? hs.headers.getSetCookie() : [hs.headers.get("set-cookie")].filter(Boolean);
const cookie = setC.map((c) => /(dsh-auth-[^=]+)=([^;]+)/.exec(c ?? "")).find(Boolean)?.slice(1).join("=");
const B = `${base}/integrations/taskboard-workbench/api`;
const call = async (method, p, body) => {
  const r = await fetch(B + p, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { code: r.status, body: await r.json().catch(() => null) };
};

check("① 插件在**全新 profile**里激活成功（`inject` 未声明 config 也不得装载失败）",
  /\[taskboard-workbench\] host ready:/.test(booted.log),
  (booted.log.split("\n").find((l) => l.includes("host ready")) ?? "(无 host ready 行)").slice(0, 120));
check("①b 装载期无插件激活失败（`did not activate` 不含本插件）",
  !/taskboard-workbench.*did not activate/i.test(booted.log),
  (booted.log.split("\n").find((l) => l.includes("did not activate")) ?? "无激活失败提示").slice(0, 120));

const probe = (await call("GET", "/host/probe")).body?.probe ?? {};
check("② 真宿主探针：建会话与**改名**两条能力都在",
  probe.verdict === "create-available" && probe.rename?.verdict === "rename-available",
  `verdict=${probe.verdict} rename=${JSON.stringify(probe.rename ?? null)}`);

const proj = (await call("POST", "/projects", { name: "FR95 隔离命名验证台", workspacePath: path.join(ISOLATED, "tbws") })).body?.project;
const req = (await call("POST", "/requirements/items", { projectId: proj.id, title: "FR-95 隔离验证需求" })).body?.item;
const task = (await call("POST", "/tasks", { projectId: proj.id, title: "隔离验证：看板建会话必须落到【任务】命名", status: "todo" })).body?.task;
await call("POST", `/tasks/${encodeURIComponent(task.identifier)}/attribution`, { requirement: req.id });
const ex = await call("POST", `/tasks/${encodeURIComponent(task.identifier)}/execute`, {});
const launch = ex.body?.launch ?? {};
check("③ `POST /execute` 真的建出了会话（非降级）",
  launch.mode === "session" && typeof launch.sessionId === "string" && launch.sessionId.startsWith("session-"),
  `mode=${launch.mode} sessionId=${launch.sessionId}`);
check("④ 回包如实报「改名成功」且名字就是 FR-95 口径",
  launch.titleApplied === true && /^【任务】.+ · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(launch.sessionName ?? ""),
  `titleApplied=${launch.titleApplied} titleReason=${launch.titleReason ?? "-"} sessionName=${launch.sessionName}`);

// 会话流判定：放宽等待（宿主异步 append + zstd 落盘）。
let titleEvents = [];
let cwd = null;
const dir = launch.sessionId
  ? spawnSync("find", [path.join(ISOLATED, "sessions"), "-maxdepth", "2", "-name", launch.sessionId], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)[0]
  : null;
for (let i = 0; i < 20 && dir; i += 1) {
  const out = spawnSync("zstd", ["-dc", path.join(dir, "session.v4.jsonl.zstd")], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "";
  const lines = out.split("\n").filter(Boolean);
  if (lines.length) cwd = JSON.parse(lines[0]).cwd ?? cwd;
  titleEvents = lines.filter((l) => l.includes('"type":"session/title"')).map((l) => JSON.parse(l).data);
  if (titleEvents.length) break;
  await sleep(1000);
}
check("⑤ 会话**落盘目录**按看板项目工作区（不落进程目录 /）",
  cwd === path.join(ISOLATED, "tbws"), `cwd=${cwd}`);
const userTitle = titleEvents.filter((e) => e.source?.kind === "user");
check("⑥ 会话流里出现 `source.kind=user` 的 `【任务】…` 落名事件（真落地，不只是回包说成功）",
  userTitle.length === 1 && /^【任务】/.test(userTitle[0].title),
  `title 事件 ${titleEvents.length} 条：${JSON.stringify(userTitle.map((e) => e.title))}`);
check("⑦ 落名之后**没有** provider / fallback 标题覆盖（rename 会 pin 住标题）",
  titleEvents.length === userTitle.length && titleEvents[titleEvents.length - 1]?.source?.kind === "user",
  `顺序：${JSON.stringify(titleEvents.map((e) => e.source?.kind))}`);


// ---- FR-95 口径 2：**项目级**命名（此前只有桩宿主证据，这里补真宿主） --------------------------
const PNAME = "FR95 隔离命名验证台";
const pRebind = (extra = {}) => call("POST", `/projects/${encodeURIComponent(proj.id)}/sessions/rebind`, { confirm: true, ...extra });
const r1 = (await pRebind()).body ?? {};
check("⑧ 首次重建（此前无指针）⇒ 名 `【项目】<项目名>`，**不得凭空加备注**",
  r1.rebound === true && r1.mode === "create" && r1.sessionName === `【项目】${PNAME}` && r1.before === null && r1.titleApplied === true,
  `mode=${r1.mode} before=${r1.before} after=${r1.after} titleApplied=${r1.titleApplied} sessionName=${r1.sessionName}`);
const s1 = r1.after;
const e1 = await readSessionEvidence(s1);
const u1 = e1.titleEvents.filter((e) => e.source?.kind === "user");
check("⑨ 该会话流真出现 `source.kind=user` 的 `【项目】…` 落名事件（不只是回包说成功）",
  u1.length === 1 && u1[0].title === `【项目】${PNAME}` && e1.titleEvents[e1.titleEvents.length - 1]?.source?.kind === "user",
  `cwd=${e1.cwd} titles=${JSON.stringify(e1.titleEvents.map((e) => `${e.source?.kind}:${e.title}`))}`);
const r2 = (await pRebind()).body ?? {};
check("⑩ 再次重建（已有指针）⇒ 名带备注「（重建）」，且确实新建了另一个会话",
  r2.mode === "create" && r2.before === s1 && r2.after !== s1 && r2.sessionName === `【项目】${PNAME}（重建）`,
  `before=${r2.before} after=${r2.after} sessionName=${r2.sessionName}`);
const r3 = (await pRebind({ sessionId: s1 })).body ?? {};
check("⑪ 改绑已有会话 ⇒ `mode=bind-existing`、指针回到该会话、名带备注「（重绑）」且**不新建**",
  r3.rebound === true && r3.mode === "bind-existing" && r3.after === s1 && r3.sessionName === `【项目】${PNAME}（重绑）`,
  `mode=${r3.mode} before=${r3.before} after=${r3.after} sessionName=${r3.sessionName} titleApplied=${r3.titleApplied}`);
const e2 = await readSessionEvidence(s1, { tries: 15, until: (ev) => ev.titleEvents.filter((e) => e.source?.kind === "user").length >= 2 });
const u2 = e2.titleEvents.filter((e) => e.source?.kind === "user");
check("⑫ 被改绑会话的**末条**标题事件是真落地的「（重绑）」user 改名（历史未被覆盖）",
  u2.length === 2 && u2[u2.length - 1].title === `【项目】${PNAME}（重绑）` && e2.titleEvents[e2.titleEvents.length - 1]?.source?.kind === "user",
  `user 标题序列=${JSON.stringify(u2.map((e) => e.title))}`)
clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
console.log(`\n----\n${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length}`);
cleanup();
console.log("（隔离实例与临时 home 已删除）");
process.exit(failed.length ? 1 : 0);
