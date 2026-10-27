/**
 * FR-50「质量门顺序」—— **真宿主验证台**（真 `dsh` 进程 + 真 store + 真 HTTP + 真会话投递）。
 *
 * 为什么需要它：FR-50 的三条落点此前只有**单测**（`tests/fr50-quality-gates.test.mjs` 钉纯函数与
 * 调用点）与**静态断言**，缺「真宿主那一层」：
 *   · `PUT /api/projects/:id/settings` 的**保存前校验**（越界门 ⇒ 拒绝且设置不变）；
 *   · `src/core/loop.mjs#directiveFor` 的**门链按配置顺序渲染** —— 这一条是卡 `-157` 的正题，
 *     而它的既有证据只到「纯函数 + 指令字符串」，**从没在真宿主上验过"配置进去、指令出来"**。
 *
 * 本台把这条链打穿（隔离真宿主，跑完即删）：
 *   ① 建项目 P1 → 需求条目 → 任务(todo) → 归因；
 *   ② `PUT /settings` 写 `qualityGates=["验证","需求"]`（**顺序刻意与默认链不同**）⇒ 200；`GET` 回读同序；
 *   ③ `PUT /settings` 写越界门 `["需求","上线"]` ⇒ 拒绝（`quality-gate-unknown`）且**设置未被修改**；
 *   ④ `POST /projects/P1/sessions/rebind` 建项目主会话 ⇒ 执行循环 `POST /projects/P1/execution-loop`；
 *   ⑤ 从 `dispatched[].directive`（HTTP 回包里的派发指令）断言门链**逐项同序＝配置顺序**，
 *      即「配置进去、指令出来」；并从**会话流原文****另证**「派发真落地」（`[任务工作台下发]`）。
 *      ⚠ `deliverDispatched` 往会话投的是**汇总行**（`本轮派发 N 条任务…`），**门链不在会话流里** ——
 *      门链只能从回包断言。本台第一版把它写成「读会话流找门链」，得到**假红**（已改）。
 *   ⑥ 另一项目 P2 **不配** `qualityGates` ⇒ 指令回落默认链并**注明来源「默认」**。
 *
 * 隔离边界：临时 `DSH_HOME` + 临时 `TB_DATA_DIR` + 随机端口 + 独立进程，跑完即删（含被建会话）。
 * **不碰用户的 `:3080`、不碰 `~/.dsh/**`、不碰仓库 `.data/`**（`AGENTS.md` §3 豁免范围：隔离验证台）。
 *
 * 运行：`node tools/bench-host-qualitygates.mjs`
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

const ISOLATED = mkdtempSync(path.join(os.tmpdir(), "tb-bench-host-qg-"));
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
    name: "dsh-profile-bench-qg",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
      "taskboard-workbench": `link:${ROOT}`,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "taskboard-workbench"] } },
  }, null, 2));
  mkdirSync(path.join(ISOLATED, "tbdata"), { recursive: true });
  mkdirSync(path.join(ISOLATED, "ws1"), { recursive: true });
  mkdirSync(path.join(ISOLATED, "ws2"), { recursive: true });
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
 * 读某会话落盘原文（宿主异步 append + zstd 落盘 ⇒ 轮询等待）。
 * `includes`：等到「原文里出现该串」才收手 —— 不要用「有内容就 break」：
 * 派发指令是**后来才 append** 进去的，早收手会得到「指令里没有门链」的**假阴性**。
 */
async function readSessionText(sessionId, { tries = 20, includes = null } = {}) {
  const dir = sessionId
    ? spawnSync("find", [path.join(ISOLATED, "sessions"), "-maxdepth", "2", "-name", sessionId], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean)[0]
    : null;
  let text = "";
  for (let i = 0; i < tries && dir; i += 1) {
    text = spawnSync("zstd", ["-dc", path.join(dir, "session.v4.jsonl.zstd")], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout ?? "";
    if (text && (!includes || text.includes(includes))) break;
    await sleep(1000);
  }
  return text;
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
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
  return { code: r.status, body: json, text };
};
const raw = (r) => JSON.stringify(r.body ?? r.text ?? "");

/** 建「项目 + 需求条目 + todo 任务 + 归因」并返回三件套（真宿主上走真 HTTP）。 */
async function scaffold(name, ws, title) {
  const pRes = await call("POST", "/projects", { name, workspacePath: ws });
  const proj = pRes.body?.project;
  if (!proj) throw new Error(`建项目失败：code=${pRes.code} body=${pRes.text?.slice(0, 300)}`);
  const rRes = await call("POST", "/requirements/items", { projectId: proj.id, title: `${name} 需求` });
  const req = rRes.body?.item;
  if (!req) throw new Error(`建需求条目失败：code=${rRes.code} body=${rRes.text?.slice(0, 300)}`);
  const tRes = await call("POST", "/tasks", { projectId: proj.id, title, status: "todo" });
  const task = tRes.body?.task;
  if (!task) throw new Error(`建任务失败：code=${tRes.code} body=${tRes.text?.slice(0, 300)}`);
  await call("POST", `/tasks/${encodeURIComponent(task.identifier)}/attribution`, { requirement: req.id });
  return { proj, req, task };
}

// ---- P1：配置了自定义顺序的门链 --------------------------------------------------------------
const P1 = await scaffold("FR50 门链验证台", path.join(ISOLATED, "ws1"), "FR50 P1：门链必须按配置顺序进指令");
const put1 = await call("PUT", `/projects/${encodeURIComponent(P1.proj.id)}/settings`, {
  teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["验证", "需求"] },
});
const get1 = (await call("GET", `/projects/${encodeURIComponent(P1.proj.id)}/settings`)).body ?? {};
const gates1 = get1.teamTemplate?.qualityGates ?? null;
check("① 设置 PUT（含**自定义顺序**的门链）⇒ 200，且 GET 回读**逐项同序**（真宿主 + 真 store）",
  put1.code === 200 && Array.isArray(gates1) && gates1.join(">") === "验证>需求",
  `PUT=${put1.code} GET.qualityGates=${JSON.stringify(gates1)}`);

const putBad = await call("PUT", `/projects/${encodeURIComponent(P1.proj.id)}/settings`, {
  teamTemplate: { roles: [{ role: "engineer" }], qualityGates: ["需求", "上线"] },
});
const get1b = (await call("GET", `/projects/${encodeURIComponent(P1.proj.id)}/settings`)).body ?? {};
const gates1b = get1b.teamTemplate?.qualityGates ?? null;
check("② 设置 PUT 传**越界门** ⇒ 拒绝（`quality-gate-unknown`）且**设置未被修改**",
  putBad.code >= 400 && raw(putBad).includes("quality-gate-unknown") && Array.isArray(gates1b) && gates1b.join(">") === "验证>需求",
  `PUT=${putBad.code} reason命中=${raw(putBad).includes("quality-gate-unknown")} 事后 gates=${JSON.stringify(gates1b)}`);

const rb1 = (await call("POST", `/projects/${encodeURIComponent(P1.proj.id)}/sessions/rebind`, { confirm: true })).body ?? {};
const main1 = rb1.after ?? null;
check("③ 项目主会话建出来（派发要有落地目标）",
  typeof main1 === "string" && main1.startsWith("session-"), `after=${main1} mode=${rb1.mode}`);

const loop1 = (await call("POST", `/projects/${encodeURIComponent(P1.proj.id)}/execution-loop`, { limit: 5 })).body ?? {};
check("④ 执行循环真派发（未配置 CLI 执行器 ⇒ 走会话投递，不是 CLI 后台）",
  Array.isArray(loop1.dispatched) && loop1.dispatched.length >= 1 && loop1.delivered >= 1 && loop1.boundSessionId === main1,
  `dispatched=${JSON.stringify((loop1.dispatched ?? []).map((d) => d.task))} deliveryVia=${loop1.deliveryVia} boundSessionId=${loop1.boundSessionId}`);

// 注：`deliverDispatched` 往会话投的是**汇总行**（`[任务工作台下发] 本轮派发 N 条…`），**门链不在其中**；
// 因此门链一律从 `dispatched[].directive`（HTTP 回包里的派发指令）断言，会话流只验「派发真落地」。
const directive1 = loop1.dispatched?.[0]?.directive ?? "";
const MARK1 = "质量门（配置）：验证→需求";
check("⑤ 派发指令的门链**逐项同序＝配置顺序**（真宿主上「配置进去、指令出来」）",
  directive1.includes(MARK1),
  `directive 命中=${directive1.includes(MARK1)}｜门链行=${(directive1.split("\n").find((l) => l.includes("质量门")) ?? "(无)")}`);
const txt1 = await readSessionText(main1, { includes: "[任务工作台下发]" });
check("⑥ 派发**真落地**到项目主会话（会话流原文出现 `[任务工作台下发]` 汇总指令）",
  txt1.includes("[任务工作台下发]"), `命中=${txt1.includes("[任务工作台下发]")} sessionId=${main1}`);

// ---- P2：未配置门链 ⇒ 回落默认链并注明来源 -----------------------------------------------------
const P2 = await scaffold("QG 默认链验证台", path.join(ISOLATED, "ws2"), "FR50 P2：未配置必须回落默认链并注明来源");
const rb2 = (await call("POST", `/projects/${encodeURIComponent(P2.proj.id)}/sessions/rebind`, { confirm: true })).body ?? {};
const main2 = rb2.after ?? null;
const loop2 = (await call("POST", `/projects/${encodeURIComponent(P2.proj.id)}/execution-loop`, { limit: 5 })).body ?? {};
const directive2 = loop2.dispatched?.[0]?.directive ?? "";
const MARK2 = "质量门（默认）：需求→实现→验证→审查→集成";
check("⑦ 未配置 `qualityGates` ⇒ 指令回落**默认链**并注明来源「默认」（与配置态可区分）",
  Array.isArray(loop2.dispatched) && loop2.dispatched.length >= 1 && directive2.includes(MARK2),
  `dispatched=${JSON.stringify((loop2.dispatched ?? []).map((d) => d.task))} 命中=${directive2.includes(MARK2)}`);

clearTimeout(watchdog);
const failed = results.filter((r) => !r.ok);
console.log(`\n----\n${results.length} 项 · PASS ${results.length - failed.length} · FAIL ${failed.length}`);
cleanup();
console.log("（隔离实例与临时 home 已删除）");
process.exit(failed.length ? 1 : 0);
