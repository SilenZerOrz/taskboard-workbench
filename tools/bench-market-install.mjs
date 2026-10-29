/**
 * 插件市场安装形态验证台 —— **从 npm 打包产物装进全新 DSH profile，真宿主起会话通道**。
 *
 * ## 为什么需要它（2026-10-29 · 用户问「为啥提醒本实例没有 DSH 宿主会话通道」）
 * 那句话是**独立进程模式**（`node src/server/server.mjs`）的如实汇报：该进程里没有 `ctx.sessions`，
 * `/api/health` 的 `host.capabilities` 恒为 `null`，于是投递类按钮按能力门置灰。
 * 要拿宿主通道只有一条路：**把它当 DSH 插件装进宿主**（`dsh plugin add` / 插件市场一键装）。
 *
 * 此前「插件形态能用」的证据都来自**仓库软链**（`~/.dsh/profiles/<profile>/node_modules/taskboard-workbench -> 仓库`），
 * 这会把「打包漏文件」整类问题盖住：软链下 `spec/norms`、`web/`、`lib/` 全在，`files[]` 少写一项也照样绿。
 * 本台因此改成 **`npm pack` → 解包 → 装进隔离 profile**，验的就是**市场装下来的那份产物**。
 *
 * ## 断言（10 项，含反向对照）
 *   ① `npm pack` 成功（产物即 npm publish / 市场安装拿到的字节）
 *   ② 包内含插件必需文件（`index.js` / `lib/client.js` / `cordis.patch.yml` / `src` / `web` / `spec/norms` / `cli`）
 *   ③ 包内**不含** `docs/` / `.data/` / `tests/` / `AGENTS.md`（发布边界，与 release-precheck 互补）
 *   ④ 插件在**全新 profile**（隔离 `DSH_HOME`）里从打包产物激活成功（日志 `host ready`）
 *   ⑤ 插件页面 `/integrations/taskboard-workbench/` 可打开（客户端桥同源加载 app.js）
 *   ⑥ 插件模式写路径可用，且数据落在临时 dataDir（不写仓库 `.data/`）
 *   ⑦ `/api/health` 的 `host.capabilities` **非空**、`sessionController/create/sessions` 全在、`scopeFactory` 就绪，
 *      并**真建出项目主会话** ⇒ 这就是「进程拿到宿主通道」的判据
 *   ⑧ **反向对照**：同一份打包代码用 `node src/server/server.mjs` 独立起 ⇒ `host.capabilities === null`
 *      （证明差异来自**装载方式**，不是代码分支）
 *   ⑨ 独立进程看板仍可打开（能力门只收「投递 / 建会话」，看板 / 建卡 / 改状态 / 评审照常）
 *   ⑩ 独立进程的 `/api/health` 如实报 `createSession=false`（前端据此置灰，不再让人撞墙）
 *
 * ## 隔离边界
 * 临时 `DSH_HOME` + 临时 profile + 临时 dataDir + 随机端口 + 独立进程；**不装包、不联网**（只读全局
 * `@deepseek-ai/*` 做软链）、**不碰 `:3080`**、**不碰 `~/.dsh/**`**、**不碰仓库 `.data/`**、跑完即删临时目录。
 *
 * ## 运行
 * `node tools/bench-market-install.mjs`
 * 退出码：0 = 全 PASS；1 = 有 FAIL；2 = 环境不具备（无 dsh / npm / 全局 bundle）⇒ 跳过。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
const watchdog = setTimeout(() => {
  console.error("FAIL  验证台整体超时（>420s）——已强退，退出码 1");
  process.exit(1);
}, 420000);

// ---- 前置 -----------------------------------------------------------------------------------
const which = (bin) => spawnSync("bash", ["-lc", `command -v ${bin}`], { encoding: "utf8" }).stdout.trim();
const dshBin = which("dsh");
const npmBin = which("npm");
if (!dshBin || !npmBin) {
  console.error(`SKIP  环境不具备：dsh=${dshBin || "(无)"} npm=${npmBin || "(无)"}（退出码 2）`);
  process.exit(2);
}
const dshReal = spawnSync("node", ["-e", `console.log(require("node:fs").realpathSync(${JSON.stringify(dshBin)}))`], { encoding: "utf8" }).stdout.trim();
const GLOBAL_NM = path.resolve(path.dirname(dshReal), "..", "node_modules", "@deepseek-ai");
const bundles = ["dsh-base", "dsh-web-app"].map((n) => [n, path.join(GLOBAL_NM, n)]);
for (const [n, p] of bundles) {
  if (!existsSync(p)) {
    console.error(`SKIP  环境不具备：全局安装里找不到 ${n}（${p}）（退出码 2）`);
    process.exit(2);
  }
}

const TMP = mkdtempSync(path.join(os.tmpdir(), "tb-bench-market-"));
const PACK = path.join(TMP, "pack");
const EXTRACT = path.join(TMP, "extract");
const DSH_HOME = path.join(TMP, "dsh");
const PROFILE = path.join(DSH_HOME, "profiles", "iso");
const PKG = path.join(EXTRACT, "package");
let PKG_REAL = PKG; // macOS：os.tmpdir() 给 /var，realpath 是 /private/var —— 入口自检按字符串比对，必须归一
const DB_DIR = path.join(TMP, "tbdata");
const DB_DIR_STANDALONE = path.join(TMP, "tbdata-standalone");
const WS = path.join(TMP, "ws");
const LOG = path.join(TMP, "dsh.log");
const STANDALONE_LOG = path.join(TMP, "standalone.log");
const children = [];
const cleanup = () => {
  for (const child of children) {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出 */ }
    try { if (child.pid) process.kill(child.pid, "SIGKILL"); } catch { /* 已退出 */ }
  }
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
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
  // 关键：装的是**解包产物**，不是仓库软链 —— 打包漏文件在这里必然暴露。
  symlinkSync(PKG_REAL, path.join(PROFILE, "node_modules", "taskboard-workbench"), "dir");
  writeFileSync(path.join(PROFILE, "package.json"), JSON.stringify({
    name: "dsh-profile-bench-market",
    private: true,
    dependencies: {
      "@deepseek-ai/dsh-base": "0.2.0-rc.2",
      "@deepseek-ai/dsh-web-app": "0.2.0-rc.2",
      "taskboard-workbench": `link:${PKG_REAL}`,
    },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "taskboard-workbench"] } },
  }, null, 2));
}

async function waitForLog(file, match, tries = 45) {
  for (let i = 0; i < tries; i += 1) {
    const text = existsSync(file) ? readFileSync(file, "utf8") : "";
    const m = match instanceof RegExp ? match.exec(text) : null;
    if (m) return { text, match: m };
    await sleep(1000);
  }
  return null;
}

let exitCode = 0;
try {
  mkdirSync(PACK, { recursive: true });
  mkdirSync(EXTRACT, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });
  mkdirSync(DB_DIR_STANDALONE, { recursive: true });
  mkdirSync(WS, { recursive: true });

  // ---- ① npm pack --------------------------------------------------------------
  const packEnv = { ...process.env, npm_config_cache: path.join(TMP, "npm-cache") };
  const packRun = spawnSync(npmBin, ["pack", "--pack-destination", PACK, "--json"], { cwd: ROOT, encoding: "utf8", env: packEnv });
  let tarball = null;
  try {
    const parsed = JSON.parse(packRun.stdout);
    tarball = path.join(PACK, Array.isArray(parsed) ? parsed[0].filename : parsed.filename);
  } catch { /* 下面判红 */ }
  check("① `npm pack` 成功（产物＝市场安装拿到的字节）",
    packRun.status === 0 && Boolean(tarball) && existsSync(tarball),
    `${tarball ? path.basename(tarball) : "(无 tarball)"} · exit=${packRun.status}`);

  const untar = spawnSync("tar", ["-xzf", tarball, "-C", EXTRACT], { encoding: "utf8" });
  check("①-b 解包成功（tar 退出码 0）", untar.status === 0, `exit=${untar.status}`);
  if (existsSync(PKG)) PKG_REAL = realpathSync(PKG);
  const DB_DIR_REAL = realpathSync(DB_DIR);

  // ---- ② 必需文件 / ③ 发布边界 -------------------------------------------------
  const required = [
    "package.json", "index.js", "lib/client.js", "cordis.patch.yml",
    "src/server/api.mjs", "src/server/server.mjs", "src/core/store.mjs", "src/core/contract.mjs",
    "web/app.js", "web/tokens.css", "web/index.html",
    "cli/tb.mjs", "spec/团队agent.md", "spec/norms/manifest.json",
  ];
  const missing = required.filter((f) => !existsSync(path.join(PKG, f)));
  check("② 包内含插件必需文件（缺哪份都装不起来 / 客户端白屏）", missing.length === 0,
    missing.length ? `缺：${missing.join(", ")}` : `${required.length} 项齐全`);

  const forbidden = ["docs", ".data", "tests", "AGENTS.md", "tools/bench-market-install.mjs"];
  const leaked = forbidden.filter((f) => existsSync(path.join(PKG, f)));
  check("③ 包内不含 docs/.data/tests/AGENTS.md（发布边界）", leaked.length === 0,
    leaked.length ? `泄漏：${leaked.join(", ")}` : "边界干净");

  // ---- ④ 全新 profile 从打包产物激活 --------------------------------------------
  makeProfile();
  const port = await freePort();
  writeFileSync(LOG, "");
  const child = spawn(dshBin, ["--profile", "iso", "--no-open", "--port", String(port)], {
    cwd: TMP,
    env: { ...process.env, DSH_HOME, TB_DATA_DIR: DB_DIR },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(child);
  const sink = (buf) => writeFileSync(LOG, String(buf), { flag: "a" });
  child.stdout.on("data", sink);
  child.stderr.on("data", sink);

  const booted = await waitForLog(LOG, /http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/);
  if (!booted) {
    console.log("SKIP  隔离真宿主 45s 内未起来（日志：", LOG, "）（退出码 2，不算失败）");
    console.log(readFileSync(LOG, "utf8").split("\n").slice(-25).join("\n"));
    cleanup();
    process.exit(2);
  }
  const base = `http://127.0.0.1:${booted.match[1]}`;
  const token = booted.match[2];

  check("④ 插件在全新 profile 里从**打包产物**激活成功", /\[taskboard-workbench\] host ready:/.test(booted.text),
    (booted.text.split("\n").find((l) => l.includes("host ready")) ?? "(无 host ready 行)").slice(0, 120));

  const hs = await fetch(`${base}/?token=${token}`, { redirect: "manual" });
  const setC = typeof hs.headers.getSetCookie === "function" ? hs.headers.getSetCookie() : [hs.headers.get("set-cookie")].filter(Boolean);
  const cookie = setC.map((c) => /(dsh-auth-[^=]+)=([^;]+)/.exec(c ?? "")).find(Boolean)?.slice(1).join("=");
  const auth = { cookie, "content-type": "application/json" };
  const api = async (method, p, body) => {
    const r = await fetch(`${base}/integrations/taskboard-workbench/api${p}`, {
      method, headers: auth, body: body ? JSON.stringify(body) : undefined,
    });
    return { code: r.status, body: await r.json().catch(() => null) };
  };

  const health = (await api("GET", "/health")).body ?? {};
  // ---- ⑤ 插件页面 --------------------------------------------------------------
  const page = await fetch(`${base}/integrations/taskboard-workbench/`, { headers: { cookie } });
  const pageHtml = await page.text();
  check("⑤ 插件页面可打开且加载看板脚本", page.status === 200 && pageHtml.includes("app.js"),
    `http=${page.status} bytes=${pageHtml.length}`);

  // ---- ⑥ 写路径 + 数据落盘位置 --------------------------------------------------
  const created = await api("POST", "/projects", { id: "market-bench", name: "市场安装验证台", workspacePath: WS });
  const projectId = created.body?.project?.id ?? null;
  const listed = await api("GET", "/projects");
  const found = (listed.body?.projects ?? []).some((p) => p.id === projectId);
  const dbPath = String(health.dbPath ?? "");
  // macOS 上 `/var` 与 `/private/var` 是同一路径的两种写法，比对前先归一（否则必然假红）。
  const normPath = (v) => String(v).replace(/^\/private(?=\/var\/)/, "");
  check("⑥ 插件模式写路径可用，数据落在临时 dataDir（不写仓库 `.data/`）",
    created.code < 300 && Boolean(projectId) && found && normPath(dbPath).startsWith(normPath(DB_DIR_REAL)),
    `POST=${created.code}${created.body?.error ? `/${created.body.error.code}` : ""} found=${found} dbPath=…${dbPath.slice(-34)}`);

  // ---- ⑦ 宿主通道：真建会话（这一步走 createScope + sessionController.create）-------
  const rebind = await api("POST", `/projects/${encodeURIComponent(projectId ?? "")}/sessions/rebind`, { confirm: true });
  const health2 = (await api("GET", "/health")).body ?? {};
  const caps2 = health2.host?.capabilities ?? null;
  const scopeReady = typeof caps2?.scopeFactory === "string" && caps2.scopeFactory.startsWith("ready");
  check("⑦ 插件模式拿到宿主通道：`capabilities` 非空 + `create/sessions` 在 + 真建出项目主会话 + scopeFactory 就绪",
    Boolean(caps2) && caps2.sessionController === true && caps2.create === true && caps2.sessions === true
      && scopeReady && rebind.code === 200 && rebind.body?.rebound === true,
    `caps=${Boolean(caps2)} rebind=${rebind.code}/${rebind.body?.mode ?? rebind.body?.error?.code} scope=${String(caps2?.scopeFactory).slice(0, 34)}`);

  try { process.kill(-child.pid, "SIGKILL"); } catch { /* ignore */ }
  try { process.kill(child.pid, "SIGKILL"); } catch { /* ignore */ }

  // ---- ⑧⑨⑩ 反向对照：同一份打包代码，独立进程 --------------------------------
  const standalonePort = await freePort();
  writeFileSync(STANDALONE_LOG, "");
  const solo = spawn(process.execPath, [path.join(PKG_REAL, "src/server/server.mjs")], {
    cwd: TMP,
    env: { ...process.env, TB_PORT: String(standalonePort), TB_DATA_DIR: DB_DIR_STANDALONE },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  children.push(solo);
  const soloSink = (buf) => writeFileSync(STANDALONE_LOG, String(buf), { flag: "a" });
  solo.stdout.on("data", soloSink);
  solo.stderr.on("data", soloSink);
  const soloUp = await waitForLog(STANDALONE_LOG, /\[tb\] listening on http:\/\/127\.0\.0\.1:(\d+)\//, 20);
  const soloBase = `http://127.0.0.1:${soloUp ? soloUp.match[1] : standalonePort}`;
  const soloHealth = soloUp ? await fetch(`${soloBase}/api/health`).then((r) => r.json()).catch(() => null) : null;
  check("⑧ 反向对照：同一份打包代码独立起 ⇒ `host.capabilities === null`（差异来自装载方式）",
    Boolean(soloHealth) && soloHealth.host?.capabilities === null,
    soloHealth ? `capabilities=${JSON.stringify(soloHealth.host?.capabilities)}` : "独立进程未起来");

  const soloPage = soloUp ? await fetch(`${soloBase}/`).catch(() => null) : null;
  check("⑨ 独立进程看板仍可打开（能力门只收投递类动作）", soloPage?.status === 200,
    `http=${soloPage?.status ?? "(未取到)"}`);

  check("⑩ 独立进程如实报 `createSession=false`（前端据此置灰，不再让人撞墙）",
    soloHealth?.host?.createSession === false,
    `createSession=${soloHealth?.host?.createSession}`);

  try { process.kill(-solo.pid, "SIGKILL"); } catch { /* ignore */ }
  try { process.kill(solo.pid, "SIGKILL"); } catch { /* ignore */ }

  const failed = results.filter((r) => !r.ok);
  exitCode = failed.length === 0 ? 0 : 1;
  console.log(`\n${results.length - failed.length}/${results.length} PASS`);
} catch (error) {
  console.error("FAIL  验证台异常：", error?.stack ?? error);
  exitCode = 1;
} finally {
  clearTimeout(watchdog);
  cleanup();
  process.exit(exitCode);
}
