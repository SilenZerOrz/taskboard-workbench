/**
 * executor.mjs —— CLI 执行器（FR-85 前置的"真实落盘"执行通道）。
 *
 * 背景：看板项目设置里 `teamTemplate.roles[].executor` 已经写了 `cli:claude`（**角色级**执行器），
 * 但仓库里此前**没有任何代码去执行它** —— 派发只做到"把指令投进项目主会话"，而那条路在当前 DSH
 * 版本上被 preset/scope 机制挡住（见 docs/进度/2026-10-18-*.md §三）。本模块补上缺的执行器本体：
 * 由看板侧**真的**以非交互方式调用 `claude` CLI 干活，并把证据（stdout/stderr/退出码/改动清单/
 * 自测）落回看板（评论 + 尝试记录 + 状态回流）。
 *
 * 设计约束（与 AGENTS.md 一致）：
 *   · 纯 Node 内置模块，零依赖；spawn 可注入（便于单测与桩替身）。
 *   · 一切外部行为都 try/catch 收口，绝不吞错：失败要如实写"受阻 + 证据"。
 *   · 不 commit / 不 push：只让执行器改工作区文件，提交仍归人。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

// 配额/鉴权类错误的正则**只有一份**（`store.mjs` 导出）；本处用于给 CLI 失败**正确分类**，
// 不另抄一份免得漂移。
import { QUOTA_AUTH_ERROR_RE } from "./store.mjs";

/** 支持的 CLI 执行器形态（`cli:<命令>`）。 */
export const CLI_EXECUTOR_PREFIX = "cli:";
/** 默认超时：30 分钟（一次真实开发任务的合理上限）。 */
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** 默认放行工具（非交互下必须显式放行，否则 claude 会因权限被拒而空转）。 */
export const DEFAULT_ALLOWED_TOOLS = "Bash Edit Write Read Glob Grep";
/** stdout/stderr 落盘上限（看板评论不需要 MB 级日志）。 */
export const MAX_OUTPUT_CHARS = 4000;
/**
 * CLI 执行期的**心跳间隔**（2026-10-22 真机 `-122` 补口）。
 *
 * 缺陷现场：子进程真在跑（`durationMs=688222`，11.5 分钟），但执行器**只在开跑时写一次认领**，
 * 整个执行期不打心跳 ⇒ 心跳停在开跑那刻。而本仓库的停滞阈值是 10 分钟
 * （`store.DEFAULT_HEARTBEAT_GAP_MS`）—— 于是：
 *   · `GET /execution` 回 `claim.stale=true`、`heartbeatAgeSeconds=656`；
 *   · 看护因 CLI 路径 `sessionId` 恒为 `null` → 必落 `session-offline` → `watchdog.state="stalled"`；
 *   · 诊断出 `stalled/high`，主按钮变成「退回待办（重新派发）」——人一点就与**仍在写文件**的
 *     子进程并发 ⇒ 同文件双写，违反 FR-86「共享文件串行」。
 * 取 45s：远小于 10 分钟阈值（一个阈值窗口内至少 13 次心跳），也不会因为写库而喧宾夺主。
 */
export const HEARTBEAT_INTERVAL_MS = 45 * 1000;
/** 判定"改动落地"依据：git 工作区是否有变更。 */
export const DISALLOWED_OUTCOME_RE = /(EACCES|ENOENT|command not found|permission denied)/i;

export function cliCommandOf(executorId) {
  return String(executorId ?? "").startsWith(CLI_EXECUTOR_PREFIX) ? String(executorId).slice(CLI_EXECUTOR_PREFIX.length) : null;
}

/**
 * 角色 → CLI 执行器解析。
 * 口径：① 禁用清单（`forbiddenExecutors`）里的执行器一律不选；② 同角色条目优先；
 *      ③ 退一步取该角色族里任意 `cli:*`；④ 再退一步取工程角色。
 * 返回 `{ id, cli, role }` 或 `null`（= 该项目不走 CLI 执行器，保持原会话派发）。
 */
export function resolveCliExecutor(settings, { role = "engineer" } = {}) {
  const tpl = settings?.teamTemplate ?? {};
  const forbidden = new Set((tpl.forbiddenExecutors ?? []).map((x) => String(x)));
  const roles = Array.isArray(tpl.roles) ? tpl.roles : [];
  const usable = (entry) => {
    const id = entry?.executor;
    const cli = cliCommandOf(id);
    if (!cli || forbidden.has(String(id))) return null;
    return { id: String(id), cli, role: entry.role ?? role };
  };
  return usable(roles.find((r) => r.role === role))
    ?? usable(roles.find((r) => cliCommandOf(r?.executor)))
    ?? usable({ role, executor: tpl.engineer?.executor })
    ?? null;
}

/** CLI 参数：非交互 + 显式放行工具 + 允许访问项目目录（可被设置里的 `engineer.args` 覆盖）。 */
export function cliArgsFor({ executorId, cwd, settings }) {
  const override = settings?.teamTemplate?.engineer?.args;
  if (Array.isArray(override) && override.length) return override.map(String);
  return [
    "-p",
    "--permission-mode", "acceptEdits",
    "--allowedTools", String(settings?.teamTemplate?.engineer?.allowedTools ?? DEFAULT_ALLOWED_TOOLS),
    "--add-dir", cwd,
  ];
}

/**
 * 「本次参数是否**允许写文件**」—— 2026-10-26 补口（真机实测过的静默陷阱）。
 *
 * 背景：裸 `claude -p`（**不带** `--permission-mode acceptEdits`）会**拒绝写入、零产出**，
 * 却仍然**退出码 0**（隔离实验原文见 `docs/进度/2026-10-26-验证台真跑claude-HTTP客户端修复.md` §三）。
 * 而 `cliArgsFor` 允许用 `teamTemplate.engineer.args` **整体覆盖**默认参数（含那句 acceptEdits）——
 * 一旦有人这么配，执行器就会「成功」跑完却什么都没改，看板还会把卡推进「待验收」：**闭环静默空转**。
 *
 * 判据只看「有没有显式的写权限模式」，**不猜** CLI 的默认值；**未覆盖**（空 / 非数组）视为走默认
 * （默认参数里就有 acceptEdits）⇒ 返回 true，不制造噪音。
 */
export const EDIT_PERMISSION_HINTS = Object.freeze([
  "acceptEdits", "bypassPermissions", "--dangerously-skip-permissions",
]);

export function argsAllowEdits(args) {
  if (!Array.isArray(args) || args.length === 0) return true; // 未覆盖 ⇒ 用默认（默认含 acceptEdits）
  const tokens = args.map(String);
  return tokens.some((token) => EDIT_PERMISSION_HINTS.some((hint) => token.includes(hint)));
}

/**
 * 给 CLI 的任务指令（自包含：目标 / 边界 / 产出 / 纪律）。
 *
 * **格式口径（卡 `-145` · `docs/规范/01-协作规范.md` §一）**：本函数是本仓「派发任务书」的
 * **唯一代码产出点**（`api.mjs` 的 `/kickoff` 与 `/exec-cli` 都经它），故按 §一 模板分五段：
 * **已获授权 / 硬边界 / 已知前置 / 分步判据 / 停下情形**，外加 **回报格式**。
 * §一 硬规则 #1：模板外层用 **4 反引号**（内含 3 反引号代码块时必须如此，否则提前闭合）——
 * 本函数产出的就是「要嵌进外层 ``` 围栏」的正文，故正文内**任何代码块一律 4 反引号**。
 * §一 硬规则 #2：**每个 Step 必须同时给判据与停下情形**，缺一即为不合格模板。
 */
export function buildTaskPrompt(task, { project, requirementId = null, verifyCommand = null } = {}) {
  const cwd = project?.workspacePath ?? null;
  const steps = [
    `## Step 0 — 预检（只读，不通过就停）`,
    ``,
    "确认工作目录与仓库状态，不通过即按下方「停下情形」处理：",
    ``,
    "````bash",
    `cd ${cwd ?? "<工作目录>"} && pwd && git status --porcelain | head -20`,
    "````",
    ``,
    "判据：能进入工作目录且能读到 git 状态。",
    "停下情形：目录进不去 / git 不可用且任务并非纯读图时，停并回报「停下（Step 0）」，如实贴出实际状态。",
  ];
  const verify = verifyCommand
    ? { cmd: verifyCommand, label: "运行任务书指定的复核动作" }
    : { cmd: "运行本任务相关的自测", label: "运行相关自测" };

  return [
    `# 任务：完成看板任务 ${task.identifier} — ${task.title}`,
    ``,
    `## 已获授权`,
    `- 直接改代码完成「${task.identifier}」，范围限于该任务所需的最小文件集。`,
    `- 允许运行只读检查与本任务相关的测试 / 构建命令。`,
    verifyCommand ? `- 完成后可运行复核动作：\`${verifyCommand}\`。` : `- 完成后可运行相关自测并贴出结果。`,
    ``,
    `## 硬边界`,
    `- ❌ 不 commit、不 push（提交归人或队长）。`,
    `- ❌ 不改历史决策文档（\`docs/历史归档/\`、已定稿的需求与计划条款）。`,
    `- ❌ 不删任何既有数据（任务 / 看板项目 / 需求条目）。`,
    `- ❌ 不改本任务范围外的文件；共享文件（core/store、server/api、web/app.js）改动保持最小。`,
    `- ❌ **不自行置「完成(done)」** —— 完成只能由人确认，你只提交「待验收」。`,
    cwd ? `- ✅ 只允许改 ${cwd} 内的文件。` : "",
    `- ✅ 隔离验证用临时目录 / 临时端口 / 独立进程，跑完即删。`,
    ``,
    `## 已知前置`,
    requirementId ? `- 需求条目：${requirementId}（先读该条目与其验收口径）。` : "",
    task.description ? `- 任务描述（原样）：\n\n${task.description}` : "",
    ``,
    `---`,
    ``,
    ...steps,
    ``,
    `## Step 1 — 改代码（不要只给建议）`,
    `目的：把「${task.identifier}」落到盘上。`,
    `判据：改动只落在本任务所需文件；无范围外改动。`,
    `停下情形：发现需要改共享文件或范围外文件时，停并写进「偏离说明」。`,
    ``,
    `## Step 2 — ${verify.label}`,
    `目的：取得可核验的结果。`,
    "````bash",
    verify.cmd,
    "````",
    `判据：命令退出码为 0（若退出码非 0，如实贴出失败输出，不要修饰）。`,
    `停下情形：测试失败但根因在本任务范围外时，停并写进「偏离说明」，不要顺手改无关代码。`,
    ``,
    `---`,
    ``,
    `## 回报格式（严格按这四节，逐节都写，缺节＝不合格）`,
    ``,
    "**判定**：完成 / 部分 / 停下（哪一步）",
    ``,
    "**偏离说明**：指令假设 X、实测 Y、故改为 Z 的逐条记录；**无偏离也要显式写「无」**，不得省略本节。",
    ``,
    "**边界自查**：逐条对齐上方「硬边界」的 ❌ 清单（未 commit / 未 push / 未删数据 / 未置 done …）。",
    ``,
    "**产物路径**：改动文件清单、测试输出、落盘报告或截图的路径。",
    ``,
    `## 停下情形（严格，逐条编号；命中即停，不要继续往下做）`,
    `1. **前置不满足**：工作目录进不去 / 基线测试非绿 / 依赖缺失 → 停，回报「停下（Step 0）」并如实贴出实际状态。`,
    `2. **门禁不过**：复核动作退出码非 0 → 停；若根因在本任务内，先尝试最小修复；仍不过则停并贴出失败证据。`,
    `3. **需要越权时**：要改范围外文件、要 commit / push、要删数据 → **一律停**，不得自行放行。`,
    `4. **触及宿主级动作**：改 \`~/.dsh/profiles/**\`、plist、插件增删、重启 dsh 宿主进程 → **一律停**（属须报批范围，指令不含此授权）。`,
    `5. **偏离预期**：实测与指令假设不一致 → 停，并在「偏离说明」写清「指令假设 X、实测 Y、故改为 Z」。`,
    ``,
    `## 禁止`,
    `- 与「硬边界」呼应：不得 commit / push、不得删数据、不得自行置「完成(done)」、不得改历史决策文档。`,
    `- 不得把「报告说完成」当事实：交付前用实际命令（\`git status\`、测试输出）自证。`,
    `- 不得臆断：实测不到的事实写「未取得 / 无法判定」，不编造。`,
  ].filter(Boolean).join("\n");
}

const tail = (text, limit = MAX_OUTPUT_CHARS) => {
  const s = String(text ?? "");
  return s.length <= limit ? s : `…（已截断，共 ${s.length} 字符）\n${s.slice(-limit)}`;
};

/**
 * **内容指纹**（2026-10-22 真机 `-122` 补口）：脏工作区里「改的正是本来就脏的文件」时，
 * `git status --porcelain` 的**行串前后完全相同**（都是 ` M src/host/tool-surface.mjs`），
 * 行级差集必然把这次真实产出吃掉 —— 真机实测该卡主产出 `+91 行` 却不在证据清单里。
 *
 * 口径：对基线/收尾两侧**同一份文件清单**各算一次内容 sha1，指纹不同 ⇒ 内容确实被执行器改过。
 *   · 只认「基线里也有、且两侧指纹都能算出、且不相等」的条目 → 本仓库执行前的 181 项历史脏改动
 *     **指纹不变 ⇒ 仍然不进清单**（FR-74 红线不回退）。
 *   · 算不出指纹（目录条目 `?? dir/`、被删、不可读、超过 `maxBytes`）→ **不当本次产出**（宁漏不滥：
 *     宁可退回旧口径的漏报，也不把历史脏改动算成产出）。
 */
export async function hashWorkspaceFiles(cwd, files = [], { maxFiles = 500, maxBytes = 4 * 1024 * 1024 } = {}) {
  const out = new Map();
  for (const path of pathsOfStatusLines(files).slice(0, maxFiles)) {
    if (!path || path.endsWith("/")) continue; // `?? docs/新目录/` 这类目录条目不做内容指纹
    try {
      const abs = join(cwd, path);
      const st = await stat(abs);
      if (!st.isFile() || st.size > maxBytes) continue;
      out.set(path, createHash("sha1").update(await readFile(abs)).digest("hex"));
    } catch { /* 被删 / 读不了 → 不做指纹 */ }
  }
  return out;
}

/** 指纹表是否真的判定出「内容变了」（两侧都算得出且不等）。 */
function contentChanged(prev, next, path) {
  const a = prev?.get?.(path); const b = next?.get?.(path);
  return typeof a === "string" && typeof b === "string" && a !== b;
}

/**
 * 采集工作区改动清单（git 只读命令）。返回值语义**必须**区分开：
 *   · `{ files, stat, hashes? }` —— git 正常退出；`files: []` 表示**基线确实为空**（工作区干净）。
 *   · `null` —— **拿不到基线**：spawn 失败 / 超时 / git 非零退出（非 git 目录、index.lock 抢占等）。
 * 真机事故（2026-10-18）：把"拿不到"退化成 `files: []` 会让差集退化成全量，证据评论于是把
 * 35 条历史脏改动当成本次产出。因此这里绝不允许用空数组冒充空基线。
 * 瞬时失败（超时 / 锁竞争）较常见：首次失败后隔 `retryDelayMs` 重试一次。
 * `hashes`：仅在全量扫描（未限定 `paths`）且算得出指纹时附带 —— 供 `diffDelta` 识别
 * "本来就脏的文件的**内容**改动"（见 `hashWorkspaceFiles`）。
 */
export async function collectDiffEvidence(cwd, { spawnImpl = spawn, timeoutMs = 20000, paths = null, retryDelayMs = 300 } = {}) {
  const attempt = async () => {
    const run = (args) => new Promise((resolve) => {
      let out = ""; let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      let child;
      try { child = spawnImpl("git", ["-C", cwd, ...args], { cwd }); } catch { return finish(null); }
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(null); }, timeoutMs);
      child.on?.("error", () => { clearTimeout(timer); finish(null); });
      child.stdout?.on("data", (b) => { out += String(b); });
      child.on?.("close", (code) => { clearTimeout(timer); finish(code === 0 ? out : null); });
    });
    const status = await run(["status", "--porcelain"]);
    if (status === null) return null; // 非零退出 / 超时 → 明确"拿不到"，不冒充空基线
    // 仓库本来就可能是"脏"的（本仓库就是），所以改动清单必须能和执行前的基线做差集；
    // stat 只在给了具体路径时才有意义（否则会把历史改动也算进来）。
    const stat = await run(paths && paths.length ? ["diff", "--stat", "--", ...paths] : ["diff", "--stat"]);
    const files = status.split("\n").map((l) => l.trim()).filter(Boolean);
    const result = { files, stat: (stat ?? "").trim() };
    // 内容指纹：只在全量扫描时算（`paths` 模式是收尾取 diffstat，不需要）。
    if (!paths) {
      try {
        const hashes = await hashWorkspaceFiles(cwd, files);
        if (hashes.size) result.hashes = hashes;
      } catch { /* 拿不到指纹 → 退回行级差集口径 */ }
    }
    return result;
  };
  const first = await attempt();
  if (first !== null) return first;
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return attempt();
}

/**
 * 前后基线差集：只保留**本次执行新增**的工作区改动条目。
 * 动机：真机事故——任务在脏仓库里跑完，证据评论把 35 条历史改动全列成"本次产出"，不可信。
 *
 * 2026-10-22 真机 `-122` 补口：**行级**差集在脏仓库下有系统性漏报 —— 开跑前已脏的文件
 * （本仓库开跑前 181 项）被再改一次，`status` 行串不变 ⇒ 差集把真实产出吃掉。这里补一层
 * **内容指纹**比较：基线里也有、但两侧指纹不同 ⇒ 确属本次产出，如实列入。
 * 没有指纹（旧调用方 / 算不出 / 非 git 场景）→ 完全退回原行级口径（零行为变化）。
 */
export function diffDelta(before, after) {
  if (!after) return null;
  const prev = new Set(before?.files ?? []);
  const prevHashes = before?.hashes ?? null;
  const nextHashes = after.hashes ?? null;
  const baselinePaths = new Set(pathsOfStatusLines(before?.files ?? []));
  // 内容确实变了的文件：只认「基线里也有（含脏条目）+ 两侧指纹都算得出 + 不相等」。
  const changed = new Set(
    pathsOfStatusLines(after.files ?? []).filter((p) => baselinePaths.has(p) && contentChanged(prevHashes, nextHashes, p)),
  );
  const files = (after.files ?? []).filter((f) => {
    if (!prev.has(f)) return true; // 本次新增的脏条目（原有口径）
    return pathsOfStatusLines([f]).some((p) => changed.has(p)); // 本来就脏 + 内容确实变了
  });
  // baselineFiles：`0` 也必须如实展示（= 执行前工作区干净），只有"拿不到基线"才是 null。
  return { files, baselineFiles: before?.files?.length != null ? before.files.length : null, repoStat: after.stat ?? "", mode: "git" };
}

/**
 * 工作区快照（**git 不可用时的兜底**）：相对路径 → `size:mtimeMs`。返回 Map；拿不到返回 null。
 *
 * 动机（2026-10-18 真机复现）：执行器只在 git 仓库里能算改动清单，**非 git 工作区**（探针项目 `tb-cli-probe`
 * 的 `/private/tmp/…/ws` 就是）会一路退化成 `diff: null`，而证据评论当时仍写死一句
 * 「本次工作区改动：无（执行器未落盘任何文件变更）」——**明明是它自己写出的两个文件**。
 * 这里补一个不依赖 git 的快照对比：能如实说出"新增/被修改了哪些文件"，模式记为 `fs`。
 */
export async function snapshotWorkspace(cwd, { maxFiles = 4000, skipDirs = [".git", "node_modules", ".dsh"] } = {}) {
  if (!cwd) return null;
  const out = new Map();
  try {
    const walk = async (dir) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (out.size >= maxFiles) return;
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (skipDirs.includes(entry.name)) continue;
          await walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const st = await stat(abs);
          out.set(relative(cwd, abs).split(sep).join("/"), `${st.size}:${Math.floor(st.mtimeMs)}`);
        } catch { /* ignore */ }
      }
    };
    await walk(cwd);
  } catch { return null; }
  return out;
}

/**
 * 快照差集：**新增**或**被修改**（size/mtime 变化）的文件。`before` 为 null 时**必须**由调用方
 * 自行判定为"无法归属"，不要拿全量冒充本次产出（同 `diffDelta` 的红线）。
 */
export function snapshotDelta(before, after) {
  if (!before || !after) return null;
  const files = [];
  for (const [p, sig] of after) if (before.get(p) !== sig) files.push(p);
  return { files, baselineFiles: before.size, repoStat: "", mode: "fs" };
}

/**
 * 从 `git status --porcelain` 行里取文件路径（兼容 `R  old -> new`）。
 *
 * **不能用 `slice(3)`**：`collectDiffEvidence` 会对每行 `.trim()`（有意为之，便于行级比较），
 * 于是真机上的 `" M tracked.mjs"` 变成 `"M tracked.mjs"` —— 状态段从 2 字符塌成 1 字符，
 * 固定切 3 位就会把路径首字符吃掉（`tracked.mjs` → `racked.mjs`）。这里改为**按状态段识别**：
 * 前 1–2 个 porcelain 状态字符 + 至少一个空白，才是状态段。
 */
const PORCELAIN_PREFIX = /^[ MADRCU?!]{1,2}\s+/;
export function pathOfStatusLine(line) {
  let p = String(line ?? "").replace(PORCELAIN_PREFIX, "").trim();
  if (p.includes(" -> ")) p = p.split(" -> ").pop(); // 重命名：取新路径
  return p.replace(/^"(.*)"$/, "$1").trim();
}

export function pathsOfStatusLines(lines = []) {
  return lines.map(pathOfStatusLine).filter(Boolean);
}

/**
 * 跑一次 CLI 执行器（**不写库**，只产出结果对象；写库交给 executeTaskWithCli）。
 * @returns {{ started, executorId, cli, cwd, exitCode, signal, timedOut, durationMs, stdout, stderr, diff, ok }}
 */
/**
 * 执行前认领（FR-52 / FR-60 保真）：真正跑 CLI 之前把卡片推进「进行中」。
 *
 * **为什么必须做**：`/exec-cli` 的 UI 明确承诺「执行前会先认领该任务（todo → 进行中）」。
 * 但此前只有 `todo` 会经 `startTaskExecution` 真的进「进行中」；其它状态（backlog / in_review /
 * blocked / done …）只开了一条尝试记录、**状态原地不动**——整个执行期看板显示的是错的列。
 * 2026-10-18 真机实测：`taskboard-workbench-73` 在「待办池」列里跑了 14 分钟。
 *
 * **口径**：人在卡片上显式点「交给 CLI 执行器执行」**即为授权**（沿用既有设计，不收紧执行权限）；
 * 但状态必须如实——非 `in_progress` 一律先置「进行中」（走执行侧状态入口，带治理审计）。
 * 终态仍由写回决定（成功 → 待验收；失败 → 统一受阻入口）。
 *
 * 任何一步失败都不阻断执行——执行结果仍会如实写回看板。
 */
export function claimForCliExecution(store, ref, { actor = "cli-executor" } = {}) {
  const outcome = { claimed: false, runStarted: false, fromStatus: null, toStatus: null, note: null };
  try {
    const fresh = store.requireTaskRef(ref);
    outcome.fromStatus = fresh.status;
    if (fresh.status === "todo") {
      store.startTaskExecution(fresh.identifier, { sessionId: null });
      outcome.claimed = true;
      outcome.note = "authorized";
    } else if (fresh.status !== "in_progress") {
      try {
        store.teamSetTaskStatus(fresh.identifier, { status: "in_progress", actor });
        outcome.claimed = true;
        outcome.note = `direct-handoff:${fresh.status}->in_progress`;
      } catch (error) {
        outcome.note = `status-move-failed:${error?.message ?? error}`;
      }
    } else {
      outcome.note = "already-in-progress";
    }
    const cur = store.requireTaskRef(fresh.identifier);
    if (cur.status === "in_progress" && typeof store.getCurrentRun === "function" && !store.getCurrentRun(cur)) {
      store.startTaskRun(cur.identifier, { actor });
      outcome.runStarted = true;
    }
    outcome.toStatus = store.requireTaskRef(fresh.identifier).status;
  } catch (error) {
    outcome.note = `claim-failed:${error?.message ?? error}`;
  }
  return outcome;
}

export async function runCliExecutor({
  task, project, executor, cwd = null, settings = null,
  timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn, env = process.env, now = () => Date.now(),
  verifyCommand = null, requirementId = null,
  store = null, heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  if (!executor?.cli) return { started: false, reason: "no-cli-executor" };
  const workdir = cwd ?? project?.workspacePath ?? null;
  if (!workdir) return { started: false, reason: "no-workspace", executorId: executor.id };
  // 测试/离线替身：`TB_CLI_EXECUTOR_BIN` 指定可执行文件时优先使用（不改 executor id 语义）。
  const cli = String(env?.TB_CLI_EXECUTOR_BIN ?? "") || executor.cli;
  const prompt = buildTaskPrompt(task, { project, requirementId, verifyCommand });
  const args = cliArgsFor({ executorId: executor.id, cwd: workdir, settings });
  // 参数来源与「能不能写文件」都要如实记进结果（证据与状态都取它，见 isBlindRun）。
  const argsSource = (Array.isArray(settings?.teamTemplate?.engineer?.args) && settings.teamTemplate.engineer.args.length) ? "override" : "default";
  const startedAt = now();
  // 基线快照（脏仓库下用于算"本次真实产出"）。
  // 拿不到基线**不得静默继续**：在结果上打 `baseline: "unavailable"`，证据评论里显式告警，
  // 否则差集退化成全量 → 历史脏改动被当成本次产出（真机事故 2026-10-18）。
  let before = null;
  try { before = await collectDiffEvidence(workdir, { spawnImpl }); } catch { before = null; }
  // git 拿不到基线时退到**文件快照**（非 git 工作区也能算出"本次新增/改了哪些文件"）；
  // 两条都拿不到才是 `unavailable`。`baseline` 如实记下用的是哪种口径：`git` / `fs` / `unavailable`。
  let beforeSnap = null;
  if (!before) { try { beforeSnap = await snapshotWorkspace(workdir); } catch { beforeSnap = null; } }
  const baseline = before ? "git" : beforeSnap ? "fs" : "unavailable";
  const result = { started: true, executorId: executor.id, cli, cwd: workdir, args, argsSource, argsAllowsEdits: argsAllowEdits(args), baseline, exitCode: null, signal: null, timedOut: false, durationMs: 0, stdout: "", stderr: "", diff: null, ok: false };
  // ---- 执行期心跳（2026-10-22 真机 `-122`）----
  // 子进程活着期间必须持续续命认领锁：否则心跳停在开跑那刻，10 分钟后 `claim.stale=true`、
  // 看护按 `session-offline` 判 `stalled/high`，主按钮变「退回待办（重新派发）」——
  // 人一点就与仍在写文件的子进程**并发同文件双写**（违反 FR-86 串行意图）。
  // 收尾必然 `clearInterval`（成功 / 失败 / 超时 / spawn 失败四条路都在 finally 或 finish 里清）：
  // 执行结束心跳即停，**不新增常驻心跳**。
  const beatOnce = () => {
    if (!store) return;
    // `heartbeatTask` 续任务级认领心跳（判 `claim.stale` 的依据），且**内部已顺带**续尝试心跳
    // （`heartbeatTaskRun`）—— 所以只在它没生效时才补一次，避免同一拍把 heartbeats 加两次。
    // 需要补的那条路：`/exec-cli` 的 `direct-handoff`（非 todo 状态人工点执行）**不建认领锁**，
    // `heartbeatTask` 会返回 `ok:false`，此时只能靠尝试心跳表明"在途"。
    let ok = false;
    try { ok = store.heartbeatTask(task.identifier, { note: null })?.ok === true; } catch { /* 心跳失败不阻断执行 */ }
    if (!ok) { try { store.heartbeatTaskRun(task.identifier); } catch { /* 心跳失败不阻断执行 */ } }
  };
  const heartbeat = (store && heartbeatIntervalMs > 0) ? setInterval(beatOnce, heartbeatIntervalMs) : null;
  if (heartbeat && typeof heartbeat.unref === "function") heartbeat.unref();
  const stopHeartbeat = () => { if (heartbeat) { clearInterval(heartbeat); } };
  try {
    await new Promise((resolve) => {
      let child;
      try {
        child = spawnImpl(cli, args, { cwd: workdir, env: { ...env, TB_TASK: String(task.identifier) } });
      } catch (error) {
        result.exitCode = -1; result.stderr = `spawn 失败：${error?.message ?? error}`; return resolve();
      }
      let finished = false;
      const finish = () => { if (!finished) { finished = true; resolve(); } };
      const timer = setTimeout(() => { result.timedOut = true; try { child.kill("SIGTERM"); } catch { /* ignore */ } setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } finish(); }, 5000); }, timeoutMs);
      child.on?.("error", (error) => { clearTimeout(timer); result.exitCode = -1; result.stderr = String(error?.message ?? error); finish(); });
      child.stdout?.on("data", (b) => { result.stdout += String(b); });
      child.stderr?.on("data", (b) => { result.stderr += String(b); });
      child.on?.("close", (code, signal) => { clearTimeout(timer); result.exitCode = code; result.signal = signal ?? null; finish(); });
      // 指令走 stdin（避免超长命令行）+ 立即结束 stdin
      try { child.stdin?.write(prompt); child.stdin?.end(); } catch { /* ignore */ }
    });
  } finally {
    stopHeartbeat();
  }
  result.durationMs = Math.max(0, now() - startedAt);
  try {
    const after = await collectDiffEvidence(workdir, { spawnImpl });
    if (before && after) {
      const delta = diffDelta(before, after);
      if (delta && delta.files.length) {
        const restat = await collectDiffEvidence(workdir, { spawnImpl, paths: pathsOfStatusLines(delta.files) });
        result.diff = { ...delta, stat: restat?.stat ?? delta.repoStat ?? "" };
      } else result.diff = delta;
    } else {
      // git 侧缺任一端 → 用快照对比；**没有执行前快照就只能判 null**（不得拿全量冒充本次产出）。
      const afterSnap = await snapshotWorkspace(workdir);
      result.diff = beforeSnap ? snapshotDelta(beforeSnap, afterSnap) : null;
    }
  } catch { result.diff = null; }
  result.ok = result.exitCode === 0 && !result.timedOut;
  return result;
}

/**
 * 证据正文（回写评论用；纯文本，看板直接展示）。
 *
 * **格式口径（卡 `-145` · `docs/规范/01-协作规范.md` §二）**：按「四节」骨架书写 ——
 * **判定 / 偏离说明 / 边界自查 / 产物路径**，让评审人能按字段扫读而不必通读。
 * §二.3：**偏离报告是强制项** —— 机器执行器拿不到「指令假设」，故本节**如实写明不可由执行器判定**
 * 并指回执行器输出，**不得静默省略、也不得臆断**（「不写偏离 = 隐藏信息，比写错更糟」）。
 * 既有措辞（退出码 / 基线剔除 / 无法判定 …）**逐字保留**，只在其外层加四节骨架。
 */
/**
 * 「跑完了、但**什么都没改**，而且参数**根本不允许写文件**」—— **唯一一处**判定。
 *
 * 为什么收敛成一个函数：这条结论同时决定**证据评论怎么写**与**尝试记录记什么结果**；
 * 两处各判一次必然漂移（一边说「部分」、另一边记 `success`，正是本次要堵的口子）。故证据与状态都取它。
 *
 * 保守边界：`diff == null`（根本算不出改动）**不算** —— 不得拿「判不出来」冒充「没改」；
 * `argsAllowsEdits !== false`（允许写 / 未覆盖走默认）也**不算** —— 那种零改动可能只是任务本身
 * 不需要改代码，属正常，不许硬判失败。
 */
export function isBlindRun(result) {
  if (!result || result.ok !== true) return false;
  if (result.argsAllowsEdits !== false) return false;
  if (result.diff == null) return false;
  return (result.diff.files ?? []).length === 0;
}

export function evidenceComment(task, result, { actor = "cli-executor" } = {}) {
  const head = result.ok
    ? `🤖 CLI 执行器完成：${result.executorId}（${result.cli}）`
    : result.timedOut
      ? `⛔ CLI 执行器超时：${result.executorId}（${result.cli}）`
      : `⛔ CLI 执行器失败：${result.executorId}（${result.cli}）`;
  const files = result.diff?.files ?? [];
  const baselineFiles = result.diff?.baselineFiles ?? null;
  const mode = result.diff?.mode ?? (result.baseline === "fs" ? "fs" : "git");
  // `diff == null` = **根本算不出改动**（既没基线也没快照）。此时绝不能说「无」——
  // 2026-10-18 真机复现：非 git 工作区里 claude 写出了两个文件，评论却写「本次工作区改动：无」。
  const undetermined = result.diff == null;
  const baselineLost = result.baseline === "unavailable" || (result.diff != null && baselineFiles == null);
  const changed = files.length
    ? [
      `本次工作区改动（${files.length}）${mode === "fs"
        ? "｜对比方式：文件快照（该目录不是 git 仓库，仅反映新增 / 被修改的文件）"
        : baselineFiles != null ? `｜执行前基线已有 ${baselineFiles} 条改动，已剔除` : ""}：`,
      ...files.slice(0, 40).map((l) => `  ${l}`),
    ].join("\n")
    : undetermined
      ? "本次工作区改动：**无法判定**（未取得工作区基线：目录不是 git 仓库且文件快照失败）"
      : mode === "fs"
        ? "本次工作区改动：无（文件快照前后一致：未新增 / 未修改任何文件）"
        : "本次工作区改动：无（执行器未落盘任何文件变更）";
  // §二 判定节取值：完成 / 部分 / 停下 —— 机器侧只能判到「本次执行」这一层。
  const verdict = isBlindRun(result)
    ? "停下（参数未允许写文件：退出码 0 但零工作区改动 —— 见下方告警）"
    : result.ok
      ? (undetermined || baselineLost
        ? "完成（附保留：本次改动归属未完全可判定，见下方产物路径节）"
        : files.length ? "完成" : "部分（退出码 0，但未取得任何工作区改动）")
      : result.timedOut
        ? `停下（执行超时：${result.executorId} 超时被终止）`
        : `停下（执行失败：退出码 ${result.exitCode}）`;
  return [
    head,
    ``,
    `**判定**：${verdict}`,
    ``,
    `**偏离说明**：执行器为非交互进程，**无「指令假设 X / 实测 Y」可核**，本节不由机器填写；`,
    `若与任务书不符之处，请人工据下方「执行器输出」与工作区实况补充（缺本节＝不合格，见 docs/规范/01-协作规范.md §二.3）。`,
    ``,
    `**边界自查**：执行侧不 commit / 不 push；不改历史决策文档；不删既有数据；不自行置「完成(done)」（${actor}）。`,
    ``,
    `**产物路径**：`,
    `任务：${task.identifier} · 目录：${result.cwd}`,
    `退出码：${result.exitCode}${result.signal ? ` · 信号：${result.signal}` : ""}${result.timedOut ? " · 已超时终止" : ""} · 耗时：${Math.round(result.durationMs / 1000)}s`,
    undetermined
      ? "⚠️ 本次未取得工作区基线（目录不是 git 仓库且文件快照失败），**本次是否落盘改动无法判定**，请以文件时间戳与目录清单人工甄别。"
      : baselineLost
        ? "⚠️ 本次无法取得执行前基线，下列改动可能包含执行前已有的改动，请以 diffstat 与文件时间戳人工甄别（不得当成本次产出）。"
        : "",
    result.argsAllowsEdits === false
      ? "⚠️ 本次 CLI 参数（来自设置 `teamTemplate.engineer.args`）**未包含任何「允许写文件」的权限模式**：进程可能以退出码 0 结束却**什么都没改**（真机实测：不带 `--permission-mode acceptEdits` 时写入被拒、零产出）。请核对设置后重新派发。"
      : "",
    changed,
    result.diff?.stat ? `本次 diffstat：\n${result.diff.stat}` : "",
    result.stdout ? `执行器输出（尾段）：\n${tail(result.stdout)}` : "",
    result.stderr ? `错误输出（尾段）：\n${tail(result.stderr)}` : "",
  ].filter(Boolean).join("\n");
}

/**
 * 一次完整的"CLI 执行 + 回写看板"：跑执行器 → 落尝试记录 → 写证据评论 → 回流状态。
 * 成功 → 提交"待验收"（= 请求评审，FR-83）；失败/超时 → 走统一受阻入口（FR-80）。
 */
export async function executeTaskWithCli({
  store, task, project, settings = null, role = "engineer", timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnImpl = spawn, env = process.env, now = () => Date.now(), heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
} = {}) {
  const executor = resolveCliExecutor(settings ?? store.getProjectSettings(task.projectId), { role });
  if (!executor) return { ran: false, reason: "no-cli-executor" };
  const verifyCommand = settings?.teamTemplate?.engineer?.verifyCommand ?? null;
  const result = await runCliExecutor({
    task, project, executor, settings, timeoutMs, spawnImpl, env, now,
    verifyCommand, requirementId: task.requirementId ?? null, store, heartbeatIntervalMs,
  });
  const body = evidenceComment(task, result);
  let review = null; let blocked = null;
  try { store.addComment(task.id, { body }); } catch { /* ignore */ }
  // 2026-10-26：参数不允许写文件 ⇒ 退出码 0 但零产出。这种「跑完了却什么都没干」**不得**记 success、
  // 更不能把卡推进「待验收」—— 否则闭环静默空转（看板显示成功，代码一个字没动）。
  const blind = isBlindRun(result);
  if (result.ok && !blind) {
    try { store.endTaskRun(task.identifier, { outcome: "success", summary: `CLI 执行器成功（${executor.id}）`, actor: "cli-executor" }); } catch { /* ignore */ }
    try { review = store.submitTaskForReview(task.identifier, { comment: `CLI 执行器产出，待人工验收（${executor.id}）` }); } catch { /* ignore */ }
  } else {
    const reason = blind
      ? "CLI 参数未允许写文件（teamTemplate.engineer.args 覆盖掉了 --permission-mode acceptEdits）：退出码 0 但零产出，疑似写入被拒 —— 请核对设置后重新派发"
      : result.timedOut ? `CLI 执行器超时（${Math.round(timeoutMs / 1000)}s）` : `CLI 执行器失败（退出码 ${result.exitCode}）`;
    const failureText = tail(result.stderr || result.stdout, 500);
    try { store.endTaskRun(task.identifier, { outcome: (!blind && result.timedOut) ? "timeout" : "failed", summary: reason, error: failureText, actor: "cli-executor" }); } catch { /* ignore */ }
    // 分类修正（2026-10-26 运行期探针）：此处原先把 `kind` **硬编码为 `capability`**，于是「超时 / 退出码非 0」
    // 这类**瞬时**失败也被标成「能力类（配额/鉴权）」—— 语义错标会让「受阻」队列把偶发故障当成配额问题。
    // 现按三类判（都与 `routeBlock` 的阻断口径一致，均为 blocked + 复发计数）：
    //   · 参数未允许写文件 ⇒ `needs_input`（**人得改设置**；原样重试必然再失败，不是偶发）
    //   · 错误原文命中配额/鉴权 ⇒ `capability`（与 FR-78「配额不重试」同源）
    //   · 其余（超时 / 非 0 退出）⇒ `transient`
    // 同时把 stderr 尾段经 `error` 写进 `last_failure_error`，让「受阻原因」「连续失败熔断」「配额不再自动重试」
    // 三条下游都拿得到数（修复前该字段恒空）。
    const quotaFailure = QUOTA_AUTH_ERROR_RE.test(failureText) || QUOTA_AUTH_ERROR_RE.test(String(result.stdout ?? ""));
    const failureKind = blind ? "needs_input" : (quotaFailure ? "capability" : "transient");
    try {
      blocked = store.recordTaskExecutionFailure(task.identifier, {
        evidence: reason,
        kind: failureKind,
        error: failureText ? `${reason}：${failureText}` : reason,
      });
    } catch { /* ignore */ }
  }
  return { ran: true, executor, result, comment: body, review, blocked };
}
