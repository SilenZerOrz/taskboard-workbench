/**
 * executors.mjs —— **执行者注册表（唯一真源）**。
 *
 * 背景（卡 `-238` / 需求 `R174`，2026-11-10 真机批注）：「用哪个执行者跑这一张卡」当时只能靠
 * **项目级** `teamTemplate.roles[].executor` 决定 —— 人在卡片上看到的只有一句「交给 CLI 执行器执行」，
 * 想换执行者得先去配置页改项目设置、再回来重新点，且换不了「这一次」。本模块把执行者做成**一张表**：
 * 前端只渲染这张表给的 `id`，服务端只在收到 `id` 时按表解析 —— **两边都不再散落执行者知识**。
 *
 * 四条通道的真实能力（2026-11-10 逐条读 `--help` 实测，**不猜**）：
 *   · `team`         —— 团队派发（`POST /api/teams`），执行者由项目 `executionTeam` 与 roles 决定
 *   · `host:dsh`     —— 宿主会话执行（`POST /api/tasks/:ref/execute`）。**`dsh` 没有 oneshot 入口**
 *                       （`dsh [--profile] <name>` 是启动宿主、`dsh plugin` 是管插件），
 *                       故它**只能**映射到既有的宿主会话通道，**不伪造一个 `dsh -p` 出来**
 *   · `cli:claude`   —— `claude -p --permission-mode acceptEdits --allowedTools … --add-dir <cwd>`（既有通道）
 *   · `cli:codex`    —— `codex exec -s workspace-write -C <cwd> -`（prompt 走 stdin，`-` 显式声明）
 *   · `cli:hermes`   —— `hermes -z <prompt> --in <cwd> --yolo`（`-z` 一次一答、`--yolo` 跳审批；
 *                       **prompt 走 argv**——该 CLI 的单次入口不吃 stdin）
 *
 * 纪律：
 *   · 纯 Node 内置模块，零依赖；探测可注入（`detect` / `now`），便于单测造「未安装」。
 *   · **不自己 spawn 干活**：参数只负责**描述**怎么调用，真正 spawn 仍在 `executor.mjs`（一处执行）。
 *   · `forbiddenExecutors` **优先级最高**：项目禁掉的执行者，按卡选也一律不可用。
 */
import { execFile } from "node:child_process";
import { accessSync, constants as FS, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// 参数真源复用既有 claude 通道（含 `teamTemplate.engineer.args` 整体覆盖语义）——**不抄第二份**。
import { cliArgsFor } from "./executor.mjs";

/** 执行者形态：团队派发 / 宿主会话 / CLI 子进程。 */
export const EXECUTOR_KINDS = Object.freeze({
  TEAM: "team",
  HOST_SESSION: "host-session",
  CLI: "cli",
});

/** 探测缓存 TTL：60s（同一台机器上「装没装」不会秒级变化，但人装完不该等重启）。 */
export const DETECT_TTL_MS = 60 * 1000;
/**
 * `--version` 探测超时：2s。
 *
 * 为什么只有 2s 且**并行**：真机实测 `hermes --version` **不退出**（超过 10s 仍在跑，只能杀掉）——
 * 串行 + 长超时会让「打开抽屉」卡住好几秒去等一个**只用于 tooltip** 的字段。
 * 版本拿不到就是 `null`，绝不为它拖慢接口。
 */
export const VERSION_TIMEOUT_MS = 2000;

/**
 * 探测路径（**只用于探测与取绝对路径，不改 `process.env.PATH`**）。
 *
 * 为什么不能只按 `PATH`：宿主（`dsh web`）常由 launchd 拉起，`PATH` 往往只有
 * `/usr/bin:/bin:/usr/sbin:/sbin` —— 用户在终端里跑得好好的 `claude` / `codex` / `hermes`
 * 一个都不在。只按 PATH 判会把「装了」误报成「没装」，界面上就是**一排全灰的图标**
 * （人只会以为功能坏了，不会想到是 PATH 不全）。
 */
export function executorSearchDirs({ env = process.env } = {}) {
  const dirs = new Set();
  const push = (value) => {
    const dir = String(value ?? "").trim();
    if (dir) dirs.add(dir);
  };
  for (const dir of String(env?.PATH ?? "").split(delimiter)) push(dir);
  const home = String(env?.HOME ?? "") || homedir();
  push(join(home, ".npm-global", "bin"));
  push(join(home, ".local", "bin"));
  push(join(home, ".bun", "bin"));
  push(join(home, ".cargo", "bin"));
  push("/opt/homebrew/bin");
  push("/usr/local/bin");
  push("/usr/bin");
  return [...dirs];
}

const detectCache = new Map();

/**
 * 探测某个命令是否可执行，并给出**绝对路径**（拿到就优先用它 spawn：launchd 的 PATH 问题就绕开了）。
 * @returns {{ installed: boolean, binPath: string|null, searched: string[] }}
 */
export function detectBinary(command, { env = process.env, now = () => Date.now(), ttlMs = DETECT_TTL_MS, fresh = false, searchDirs = null } = {}) {
  const name = String(command ?? "").trim();
  if (!name) return { installed: false, binPath: null, searched: [] };
  const dirs = searchDirs ?? executorSearchDirs({ env });
  const key = `${name}\u0000${dirs.join("\u0000")}`;
  const hit = detectCache.get(key);
  if (!fresh && hit && now() - hit.at < ttlMs) return hit.value;
  let binPath = null;
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      // 仅 `access(X_OK)` 不够：同名**目录**也过。必须确认是常规文件（符号链接跟随）。
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, FS.X_OK);
      binPath = candidate;
      break;
    } catch { /* 换下一个目录 */ }
  }
  const value = { installed: Boolean(binPath), binPath, searched: dirs };
  detectCache.set(key, { at: now(), value });
  return value;
}

/** 清探测缓存（测试与「刚装完想立刻看到」用）。 */
export function resetExecutorDetectCache() { detectCache.clear(); }

/** 读版本号（拿不到就是 `null`，**不抛**：版本只用于 tooltip，不应让接口失败）。 */
export function readBinaryVersion(binPath, { timeoutMs = VERSION_TIMEOUT_MS, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    if (!binPath) { resolve(null); return; }
    try {
      execFileImpl(binPath, ["--version"], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 256 * 1024 }, (error, stdout, stderr) => {
        if (error) { resolve(null); return; }
        const line = String(stdout ?? "").trim().split("\n")[0] || String(stderr ?? "").trim().split("\n")[0] || "";
        resolve(line ? line.slice(0, 80) : null);
      });
    } catch { resolve(null); }
  });
}

/**
 * 注册表本体。**顺序即界面顺序**（团队 → dsh → claude → codex → hermes）。
 * `buildArgs` 只在 `kind === "cli"` 上有意义；`promptVia` 说明这条 CLI 的指令怎么给（`stdin` / `argv`）。
 */
export const EXECUTOR_SPECS = Object.freeze([
  Object.freeze({
    id: "team",
    agent: "team",
    kind: EXECUTOR_KINDS.TEAM,
    label: "团队",
    hint: "派发给项目执行团队（角色与成员由项目 executionTeam / teamTemplate 决定）",
    command: null,
    promptVia: null,
  }),
  Object.freeze({
    id: "host:dsh",
    agent: "dsh",
    kind: EXECUTOR_KINDS.HOST_SESSION,
    label: "DSH 宿主会话",
    hint: "投给项目主会话执行（dsh 没有 oneshot 入口，故走宿主会话通道，不伪造 CLI）",
    command: "dsh",
    promptVia: null,
  }),
  Object.freeze({
    id: "cli:claude",
    agent: "claude",
    kind: EXECUTOR_KINDS.CLI,
    label: "Claude Code",
    hint: "claude -p（非交互；参数可被 teamTemplate.engineer.args 整体覆盖）",
    command: "claude",
    promptVia: "stdin",
    buildArgs: ({ cwd, settings }) => cliArgsFor({ executorId: "cli:claude", cwd, settings }),
  }),
  Object.freeze({
    id: "cli:codex",
    agent: "codex",
    kind: EXECUTOR_KINDS.CLI,
    label: "Codex",
    hint: "codex exec（workspace-write 沙箱；prompt 走 stdin）",
    command: "codex",
    promptVia: "stdin",
    buildArgs: ({ cwd }) => ["exec", "-s", "workspace-write", "-C", cwd, "-"],
  }),
  Object.freeze({
    id: "cli:hermes",
    agent: "hermes",
    kind: EXECUTOR_KINDS.CLI,
    label: "Hermes",
    hint: "hermes -z（一次一答、跳审批；prompt 走 argv）",
    command: "hermes",
    promptVia: "argv",
    buildArgs: ({ cwd, prompt }) => ["-z", String(prompt ?? ""), "--in", cwd, "--yolo"],
  }),
]);

/**
 * 执行者 id 归一：既接受全标识（`cli:codex` / `host:dsh`），也接受裸的 agent 名（`codex` / `dsh` / `team`）。
 * 裸名只在**唯一命中**时归一；命中不了原样返回（交给上层判「未知执行者」）。
 */
export function normalizeExecutorId(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  if (text.includes(":")) return text;
  const hits = EXECUTOR_SPECS.filter((spec) => spec.agent === text || spec.id === text);
  return hits.length === 1 ? hits[0].id : text;
}

/** 按 id / 裸名找注册项（找不到回 `null`，**不抛** —— 抛什么错误归路由层定）。 */
export function findExecutorSpec(raw) {
  const id = normalizeExecutorId(raw);
  if (!id) return null;
  return EXECUTOR_SPECS.find((spec) => spec.id === id) ?? null;
}

/** 项目的禁用清单（`teamTemplate.forbiddenExecutors`）——全标识与裸 agent 名都算命中。 */
export function forbiddenSetOf(settings) {
  return new Set((settings?.teamTemplate?.forbiddenExecutors ?? []).map((x) => String(x)));
}

export function isExecutorForbidden(spec, settings) {
  if (!spec) return false;
  const forbidden = forbiddenSetOf(settings);
  return forbidden.has(spec.id) || forbidden.has(spec.agent);
}

/**
 * CLI 参数（传 `prompt` 是因为 hermes 走 argv）。
 * 非 CLI 形态回 `null`（团队 / 宿主会话不 spawn 子进程）。
 */
export function buildExecutorArgs(spec, { cwd = null, settings = null, prompt = "" } = {}) {
  if (!spec || spec.kind !== EXECUTOR_KINDS.CLI || typeof spec.buildArgs !== "function") return null;
  const args = spec.buildArgs({ cwd, settings, prompt });
  return Array.isArray(args) ? args.map(String) : null;
}

/**
 * 列出全部执行者及**当下能不能用**。
 *
 * 三处「不可用」要分开说清，别混成一句「不可用」：
 *   · 未安装（CLI 找不到可执行文件）—— 人能自己装
 *   · 被项目禁用（`forbiddenExecutors`）—— 要改项目设置，**优先级最高**
 *   · 通道不成立（宿主实例没有会话通道 / 项目没配执行团队）—— 换环境或先配团队
 *
 * `hostSessionAvailable` / `teamAvailable` 传 `null` 表示「**判不准**」——按可用处理，
 * 不把「不知道」冒充成「不可用」（本仓既有纪律：判不准时不得谎报失效）。
 */
export async function listExecutors({
  settings = null, hostSessionAvailable = null, teamAvailable = null,
  env = process.env, withVersion = true, now = () => Date.now(), fresh = false,
  detect = null, readVersion = readBinaryVersion, versionTimeoutMs = VERSION_TIMEOUT_MS,
} = {}) {
  const forbidden = forbiddenSetOf(settings);
  const probeOf = detect ?? ((command, opts) => detectBinary(command, opts));
  // 第一遍：形态与安装态（同步、无子进程）。
  const rows = EXECUTOR_SPECS.map((spec) => {
    let installed = true;
    let binPath = null;
    let reason = null;
    if (spec.kind === EXECUTOR_KINDS.CLI) {
      const probe = probeOf(spec.command, { env, now, fresh });
      installed = Boolean(probe?.installed);
      binPath = probe?.binPath ?? null;
      if (!installed) reason = `未检测到 ${spec.command}（已查 PATH · ~/.npm-global/bin · ~/.local/bin · /opt/homebrew/bin）`;
    } else if (spec.kind === EXECUTOR_KINDS.HOST_SESSION) {
      // `null` = 判不准 ⇒ 按可用处理（不把「不知道」冒充成「不可用」）。
      installed = hostSessionAvailable !== false;
      if (installed === false) reason = "宿主会话通道不可用（该实例没有 sessionController / prompt：独立进程实例做不到）";
    } else if (spec.kind === EXECUTOR_KINDS.TEAM) {
      installed = teamAvailable !== false;
      if (installed === false) reason = "项目未配置执行团队（teamTemplate.executionTeam 为空）：先建团队或去配置页选择";
    }
    const blocked = forbidden.has(spec.id) || forbidden.has(spec.agent);
    if (blocked) reason = `项目 forbiddenExecutors 已禁 ${spec.id}：项目禁用的执行者不得按卡选择`;
    return { spec, installed, binPath, version: null, blocked, reason };
  });
  // 第二遍：版本号**并行**探测（拿不到就 null；不参与 usable 判定）。
  if (withVersion) {
    const targets = rows.filter((row) => row.spec.kind === EXECUTOR_KINDS.CLI && row.binPath);
    const versions = await Promise.all(targets.map((row) => Promise.resolve()
      .then(() => readVersion(row.binPath, { timeoutMs: versionTimeoutMs }))
      .catch(() => null)));
    targets.forEach((row, index) => { row.version = versions[index] ?? null; });
  }
  return rows.map(({ spec, installed, binPath, version, blocked, reason }) => ({
    id: spec.id,
    agent: spec.agent,
    kind: spec.kind,
    label: spec.label,
    hint: spec.hint,
    command: spec.command,
    installed,
    binPath,
    version,
    blocked,
    usable: installed && !blocked,
    reason,
  }));
}
