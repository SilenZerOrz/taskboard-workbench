/**
 * index.js —— DSH 宿主侧 Cordis 插件（零依赖，无静态 @deepseek-ai/* import）。
 *
 * 职责：把已实现的 HTTP API（src/server/api.mjs，与独立验证台共用同一路由逻辑）
 * 挂到独立命名空间 /integrations/taskboard-workbench 下，并同时托管 web/ 静态资源
 * （客户端面板通过同源脚本加载复用 web/app.js 的看板渲染）。
 *
 * 数据目录：插件配置 dataDir > 宿主 `ctx.get("config").dataDir` > TB_DATA_DIR > 系统临时目录
 * （默认不写代码仓库）。**不得直接读 `ctx.config`**：本插件 `inject` 只声明了 `webServer`，
 * cordis 会对未声明属性抛「cannot get property "config" without inject」⇒ 装载期整条 entry
 * 不激活（2026-10-26 用隔离真宿主 `--from-default-profile` 复现；真实 profile 因为用户层
 * patch 显式给了 `config.dataDir`，把 `??` 右边短路掉，才一直没暴露）。
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { resolveDataDir } from "./src/core/config.mjs";
import { openStore } from "./src/core/store.mjs";
import { createRequestHandler, ensureDefaultProject, WEB_DIR } from "./src/server/server.mjs";
import { createEventHub } from "./src/server/events.mjs";
import { runExecutionLoop, listLoopProjects } from "./src/core/loop.mjs";
import { createLlmElaborator } from "./src/host/ai-elaborator.mjs";
import { createTeamEnginePort } from "./src/host/team-engine.mjs";

export const name = "taskboard-workbench";
export const inject = ["webServer"];

export const PREFIX = "/integrations/taskboard-workbench";

/**
 * HostSessionPort —— 宿主会话能力真实 adapter（切片2 收口）。
 *
 * 对齐 agent-teams 的**懒取**模式：不在 apply 时 eager 取服务，而是每次调用时经 `getService(name)` 现取，
 * 因此服务在插件之后出现/被替换时自然生效（无需 eager 注入）。
 * - createSession({preset,cwd,title})：`sessionController.create()`（退回 `sessions.create`）；`cwd` 透传工作区；
 *   宿主 `create()` **不收 title** ⇒ `title` 走**建完再 `rename()`**（改名失败如实回 `titleApplied:false` + 原因，不谎报）；
 *   **尝试**预置内容，失败不抛错。
 * - renameSession(id, title)：会话改名（2026-10-23 命名约束的宿主出口）。
 * - sendPrompt(id, text)：**任务下发**。经 `sessionController.prompt({mode:"queue"})` 把指令投递给该会话的 Agent。
 * - openSession(id)：宿主侧无此能力（返回 ui-workspace-unavailable）；会话切换由**客户端** uiWorkspace 完成（见 lib/client.js）。
 * - getCurrentSessionId()：宿主工具面才有 `exec.agent?.id`，此处恒返回 null（接口占位）。
 */
export function createHostSessionPort({ getService, getCtx } = {}) {
  const sessions = () => getService?.("sessions");
  const sessionController = () => getService?.("sessionController");
  const agents = () => getService?.("agents");
  const uiWorkspace = () => getService?.("uiWorkspace");
  const mkRequestId = () =>
    (globalThis.crypto?.randomUUID?.() ?? `tb-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // ---- 作用域取服务（FR-71 投递修复）------------------------------------------
  // DSH 的 agent preset 绑定要求 ctx 带作用域（`scopeOf(ctx) = ctx[kScope]`）；插件激活时拿到的是
  // **根作用域** ctx，其内部 ctx 无 kScope → `sessionController.create/prompt` 恒抛
  // "Agent preset binding requires a scoped context"。这里用 dsh-scope 的公开导出 `createScope`
  // 自铸一个作用域再取服务；**取不到就回落旧路径并如实降级**（不静默、不谎报成功）。
  let scopeFactoryState = "unresolved";
  // ---- 会话工作区归属缓存（FR-84 补口）----------------------------------------
  // `sessionQuery.listSessions()` 一次性返回全部会话头（含 cwd）；按请求反复调用没必要，故加短 TTL 缓存。
  const SESSION_ORIGIN_TTL_MS = 15000;
  // map: sessionId -> { cwd, title, updatedAt }（FR-84 补口 2026-10-22 起带标题，供「绑定已有会话」列表展示）
  const originCache = { at: 0, map: null };
  /**
   * 构建会话索引并**如实返回失败原因**（FR-84 补口 2026-10-22；真机教训：原实现把 `listSessions()` 的异常
   * 静默 catch 成 `unavailable`，于是「改绑已有会话」在真机上只剩一句「不可用」，无从排障）。
   * ⚠️ 必须以**闭包函数**形式存在（而非对象方法）：`sessionIndex()`/`listSessions()` 等对象方法是**裸标识符**调用，
   * 对象方法之间不共享作用域，写成对象方法会 ReferenceError（真机 2026-10-22 复现：index-threw:buildSessionIndex is not defined）。
   * 返回 `{ map, source, reason }`：成功 `map` 为 Map；失败 `map=null` 且 `reason` 说明原因。
   */
  const buildSessionIndex = async () => {
    const q = getService?.("sessionQuery");
    if (!q) return { map: null, source: "unavailable", reason: "sessionQuery-service-unavailable" };
    const method = typeof q.listSessions === "function" ? "listSessions" : (typeof q.list === "function" ? "list" : null);
    if (!method) return { map: null, source: "unavailable", reason: "sessionQuery-has-no-list-method" };
    const now = Date.now();
    if (now - originCache.at > SESSION_ORIGIN_TTL_MS) { originCache.at = now; originCache.map = null; }
    if (!originCache.map) {
      let records = null;
      try { records = await q[method](); }
      catch (error) {
        const reason = `list-failed:${error?.code ?? error?.message ?? String(error)}`;
        console.error(`[taskboard-workbench] sessionQuery.${method}() 失败：${reason}`);
        return { map: null, source: "error", reason };
      }
      const map = new Map();
      for (const rec of records ?? []) {
        const header = rec?.header ?? rec;
        const id = header?.id ?? rec?.sessionId ?? null;
        if (!id) continue;
        map.set(id, {
          cwd: header?.cwd ?? rec?.cwd ?? null,
          title: header?.title ?? rec?.title ?? null,
          updatedAt: header?.updatedAt ?? rec?.updatedAt ?? null,
        });
      }
      originCache.map = map;
    }
    return { map: originCache.map, source: `sessionQuery.${method}`, reason: null };
  };
  let scopeFactoryPromise = null;
  const scopedCtxs = new Map();
  /**
   * 解析 `@deepseek-ai/dsh-scope`。本插件是**软链**安装（`~/.dsh/profiles/<p>/node_modules/<name>` →
   * 本仓库），ESM 裸导入会从**仓库真实路径**向上找 node_modules，因此**必然找不到**（仓库零依赖）。
   * 故按"多策略"解析，全部失败则如实降级（不谎报）：
   *   ① 裸导入（上游若把 dsh-scope 提升到 profile 可见处，这条会先中）；
   *   ② 从 **DSH 自身入口**（`process.argv[1]`，即 `dsh` bin，require 会跟随软链）解析；
   *   ③ 从已解析出的 dsh 包目录解析（兜底）。
   * 说明：②③ 与 DSH 的安装布局耦合，故一律 try/catch；拿不到就回落旧路径并在日志里写明原因。
   */
  function scopeCandidates() {
    const out = ["@deepseek-ai/dsh-scope"];
    const bases = [];
    for (const raw of [process.argv?.[1], process.env?.DSH_BIN]) {
      if (!raw) continue;
      // 关键：`dsh` 是**符号链接**（bin/dsh → lib/bin.js），而 createRequire **不跟随软链**，
      // 直接拿 argv[1] 解析会 MODULE_NOT_FOUND。这里先 realpath 再解析。
      try { bases.push(existsSync(raw) ? realpathSync(raw) : raw); } catch { bases.push(raw); }
    }
    for (const base of bases) {
      try {
        const resolved = createRequire(base).resolve("@deepseek-ai/dsh-scope");
        if (resolved && !out.includes(resolved)) out.push(resolved);
      } catch { /* 继续尝试下一个 */ }
    }
    return out;
  }
  function loadScopeFactory() {
    if (scopeFactoryPromise) return scopeFactoryPromise;
    scopeFactoryPromise = (async () => {
      const candidates = scopeCandidates();
      const errors = [];
      for (const candidate of candidates) {
        try {
          const spec = candidate.startsWith("/") ? pathToFileURL(candidate).href : candidate;
          const mod = await import(spec);
          if (typeof mod?.createScope === "function") {
            scopeFactoryState = candidate.startsWith("/") ? `ready:${path.dirname(path.dirname(candidate))}` : "ready:bare";
            console.log(`[taskboard-workbench] dsh-scope 已解析：${candidate}（作用域投递可用）`);
            return mod.createScope;
          }
          errors.push(`${candidate}: 无 createScope 导出`);
        } catch (error) {
          errors.push(`${candidate}: ${error?.code ?? error?.message ?? "import-failed"}`);
        }
      }
      scopeFactoryState = `unavailable:${errors.join(" | ")}`;
      console.error(`[taskboard-workbench] dsh-scope 解析失败 → 投递回落根作用域（会因 preset binding 被拒）：${scopeFactoryState}`);
      return null;
    })();
    return scopeFactoryPromise;
  }
  /** 自铸（并缓存）一个作用域 ctx；宿主/模块不可得时返回 null。 */
  async function scopedCtx(key) {
    const root = typeof getCtx === "function" ? getCtx() : null;
    if (!root || typeof root.get !== "function" || typeof root.plugin !== "function") return null;
    if (scopedCtxs.has(key)) return scopedCtxs.get(key);
    const createScope = await loadScopeFactory();
    if (typeof createScope !== "function") return null;
    try {
      const scoped = createScope(root, key)?.ctx ?? null;
      if (scoped) scopedCtxs.set(key, scoped);
      return scoped;
    } catch (error) {
      console.error(`[taskboard-workbench] createScope failed: ${error?.message ?? error}`);
      return null;
    }
  }
  async function scopedSessionController(key) {
    const scoped = await scopedCtx(key);
    if (!scoped) return null;
    try { return scoped.get?.("sessionController") ?? null; } catch { return null; }
  }
  /**
   * 往目标会话投递一条"用户指令"（任务下发/继续调试）。
   * 首选宿主 `sessionController.prompt`（真实把消息送入会话 Agent inbox）；退回 `sessions.sendMessage`。
   */
  async function deliver(sessionId, text) {
    if (!sessionId || !text) return { sent: false, reason: "no-target" };
    const scoped = await scopedSessionController(`tb-session:${sessionId}`);
    const sc = scoped ?? sessionController();
    if (typeof sc?.prompt === "function") {
      try {
        await sc.prompt(
          { requestId: mkRequestId(), sessionId, mode: "queue", content: [{ type: "text", text }] },
          new AbortController().signal,
        );
        return { sent: true, via: scoped ? "scoped.sessionController.prompt" : "sessionController.prompt" };
      } catch (error) {
        console.error(`[taskboard-workbench] sessionController.prompt failed: ${error?.message ?? error}`);
      }
    }
    const api = sessions();
    if (typeof api?.sendMessage === "function") {
      try {
        await api.sendMessage(sessionId, text);
        return { sent: true, via: "sessions.sendMessage" };
      } catch (error) {
        return { sent: false, reason: error?.message ?? String(error) };
      }
    }
    return { sent: false, reason: "prompt-unavailable" };
  }
  /**
   * 会话改名（2026-10-23 用户命名约束）。
   * 宿主契约实测：`sessionController.create()` **不接受 title**（`SessionCreateRequest` 只有
   * workspaceId/cwd/sessionId/agentPreset），只有 `rename({ sessionId, title })`
   * （jsDoc「Rename one Session after explicitly resuming it」）⇒ 一律**建完再改名**。
   * **得不到确认就如实回失败原因**，绝不谎报改名成功。
   */
  async function renameSession(sessionId, title) {
    if (!sessionId) return { renamed: false, reason: "no-session" };
    if (!title) return { renamed: false, reason: "no-title" };
    const sc = (await scopedSessionController(`tb-session:rename:${sessionId}`)) ?? sessionController();
    if (typeof sc?.rename !== "function") return { renamed: false, reason: "rename-unavailable" };
    try {
      const res = await sc.rename({ sessionId, title });
      return { renamed: true, title: res?.title ?? title, seq: res?.seq ?? null };
    } catch (error) {
      console.error(`[taskboard-workbench] sessionController.rename failed: ${error?.message ?? error}`);
      return { renamed: false, reason: error?.code ?? String(error?.message ?? error) };
    }
  }
  /** 建完补标题：未给 title / 未建出会话 / 改名失败 ⇒ 一律**如实**回报，供上层决定是否提示用户。 */
  async function applyTitle(sessionId, title) {
    if (!title) return { titleApplied: false, titleReason: "no-title" };
    const r = await renameSession(sessionId, title);
    return { titleApplied: Boolean(r.renamed), titleReason: r.renamed ? null : (r.reason ?? "rename-failed") };
  }
  return {
    /** 动态可用性：能否建会话 / 投递指令。 */
    get available() {
      return typeof sessionController()?.create === "function" || typeof sessions()?.create === "function";
    },
    async createSession({ preset, cwd, title } = {}) {
      const sc = (await scopedSessionController("tb-session:new")) ?? sessionController();
      if (typeof sc?.create === "function") {
        try {
          // 2026-10-19 修复：宿主 `session.create({cwd})`（`dsh-api-session-controller`）**支持指定工作目录**，
          // 不传则落在 `defaultCwd`（＝dsh 进程的工作目录）。真机复现的后果：项目 workspacePath ≠ 进程目录时，
          // 「重建并绑定项目主会话」建出来的会话 cwd 是进程目录 → 会被 FR-84 的**工作区归属门**继续拦下
          // （`session-other-workspace`），形成「重建了还是打不开」的锁死。故这里把项目工作区透传给宿主。
          const created = await sc.create(cwd ? { cwd } : {});
          const sessionId = typeof created === "string" ? created : (created?.sessionId ?? created?.id ?? null);
          const named = await applyTitle(sessionId, title);
          const presetApplied = sessionId && preset ? (await deliver(sessionId, preset)).sent : false;
          return { sessionId, presetApplied, titleApplied: named.titleApplied, titleReason: named.titleReason };
        } catch (error) {
          console.error(`[taskboard-workbench] sessionController.create failed: ${error?.message ?? error}`);
        }
      }
      const api = sessions();
      if (typeof api?.create !== "function") return { sessionId: null, presetApplied: false, titleApplied: false, titleReason: title ? "session-create-failed" : "no-title" };
      let sessionId = null;
      try {
        // DSH `sessions.create(id, options)`：**第一个参数是 id**，缺省才由 store 自铸 `session-<n>`。
        // 传 `create({})` 会把对象当成 id → `session header id "[object Object]" does not match session id`。
        const created = await api.create();
        sessionId = typeof created === "string" ? created : (created?.id ?? created?.sessionId ?? null);
      } catch (error) {
        console.error(`[taskboard-workbench] sessions.create failed: ${error?.message ?? error}`);
        return { sessionId: null, presetApplied: false, titleApplied: false, titleReason: title ? "session-create-failed" : "no-title" };
      }
      const namedFallback = await applyTitle(sessionId, title);
      const presetApplied = sessionId && preset ? (await deliver(sessionId, preset)).sent : false;
      return { sessionId, presetApplied, titleApplied: namedFallback.titleApplied, titleReason: namedFallback.titleReason };
    },
    /**
     * 会话改名（2026-10-23 用户命名约束「【任务】/【项目】+ 时间/备注」的宿主出口）。
     * 宿主契约（实测）：`SessionRenameRequest = { sessionId, title }` → `SessionRenameValue = { title, seq }`。
     * **失败如实回 `renamed:false` + 原因**，让上层能如实提示（不谎报成功）。
     */
    async renameSession(sessionId, title) {
      return renameSession(sessionId, title);
    },
    /** 任务下发：把指令投递到会话（供执行循环/团队派发复用）。 */
    async sendPrompt(sessionId, text) {
      return deliver(sessionId, text);
    },
    /**
     * 跟踪执行会话是否仍在执行（宿主 `agents` 注册表）：
     * - live：该会话当前有活跃 Agent（进程内注册表命中）
     * - running：`agent.status === "running"`（驱动中，未回到 idle）
     * - pending：inbox 里尚未消费的消息数（nextTurn + nextStep）
     * 用途：派发前判定"已有执行会话在执行且未返回结论"→ 停止再次下发。
     */
    sessionState(sessionId) {
      const empty = { sessionId: sessionId ?? null, live: false, running: false, status: null, pending: 0 };
      if (!sessionId) return empty;
      let agent = null;
      try { agent = agents()?.get?.(sessionId) ?? null; } catch { agent = null; }
      if (!agent) return empty;
      const inbox = agent.inbox ?? {};
      const pending = (inbox.nextTurn?.length ?? 0) + (inbox.nextStep?.length ?? 0);
      return { sessionId, live: true, running: agent.status === "running", status: agent.status ?? null, pending };
    },
    /**
     * 会话存在性判定（FR-84）：优先查**持久化**会话（`sessionQuery.observeSession`），
     * 其次看进程内 `agents` 注册表。**判不准时返回 `exists:null`（未知）——不得把"查不到"谎报成"已失效"**。
     */
    async sessionExists(sessionId) {
      if (!sessionId) return { sessionId: null, exists: false, source: "none" };
      const q = getService?.("sessionQuery");
      if (typeof q?.observeSession === "function") {
        try {
          const observed = await q.observeSession(sessionId);
          if (typeof observed?.[Symbol.dispose] === "function") { try { observed[Symbol.dispose](); } catch { /* ignore */ } }
          return { sessionId, exists: observed !== undefined && observed !== null, source: "sessionQuery.observeSession" };
        } catch (error) {
          if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return { sessionId, exists: false, source: "sessionQuery.observeSession" };
          return { sessionId, exists: null, source: `sessionQuery-error:${error?.code ?? error?.message ?? "unknown"}` };
        }
      }
      const agent = (() => { try { return agents()?.get?.(sessionId) ?? null; } catch { return null; } })();
      if (agent) return { sessionId, exists: true, source: "agents" };
      return { sessionId, exists: null, source: "unavailable" };
    },
    /**
     * 宿主**已持久化会话索引**（FR-84 补口 2026-10-22）：`sessionId → { cwd, title, updatedAt }`。
     * 数据源 `sessionQuery.listSessions()`（返回带 `header.cwd` 的记录）+ 短 TTL 缓存；
     * **取不到一律回 `null`**（不臆断、不谎报「没有会话」）。
     */
    async sessionIndex() {
      const built = await buildSessionIndex();
      return built.map;
    },
    /**
     * 列出宿主会话（可按工作区过滤）。用途：任务台「把**本工作区已有会话**绑定为项目主会话」——
     * 当宿主**建会话**能力不可用时（实例未加载宿主 shim → `create()` 抛 scoped context 错），
     * 这是把「从任务台接续回项目主会话」走通的唯一出口。
     */
    async listSessions({ cwd } = {}) {
      let built = null;
      try { built = await buildSessionIndex(); }
      catch (error) { built = { map: null, source: "error", reason: `index-threw:${error?.message ?? error}` }; }
      if (!built?.map) return { sessions: [], source: built?.source ?? "unavailable", reason: built?.reason ?? "unknown" };
      const all = [...built.map.entries()].map(([sessionId, v]) => ({ sessionId, cwd: v?.cwd ?? null, title: v?.title ?? null, updatedAt: v?.updatedAt ?? null }));
      const sessions = cwd ? all.filter((s) => s.cwd === cwd) : all;
      return { sessions, source: built.source, reason: null };
    },
    /**
     * 会话**工作区归属**（FR-84 补口）：给出该会话创建时的 cwd，用于判定「这个接续会话到底是不是本项目的」。
     * 真机背景：`taskboard-workbench` 项目的主会话指针曾被指到**另一个项目工作区**的 6.3 MB 会话上，
     * 于是每张卡「打开执行会话」都会打开一个**别人的、巨大的**会话 → 页面长时间只显示输入框。
     *
     * 数据源：优先 `sessionQuery.listSessions()`（返回带 `header.cwd` 的记录；一次调用 + 短 TTL 缓存），
     * 退化到 `readSession(id).session.cwd`。**取不到一律回 `cwd:null`，不臆断归属**（判不准 ≠ 判定不属于）。
     */
    async sessionOrigin(sessionId) {
      if (!sessionId) return { sessionId: null, cwd: null, source: "none" };
      const q = getService?.("sessionQuery");
      if (!q) return { sessionId, cwd: null, source: "unavailable" };
      try {
        const index = await sessionIndex();
        if (index?.has(sessionId)) {
          return { sessionId, cwd: index.get(sessionId)?.cwd ?? null, source: "sessionQuery.listSessions" };
        }
      } catch { /* 列不出就退回单会话读取 */ }
      if (typeof q.readSession === "function") {
        try {
          const read = await q.readSession(sessionId);
          return { sessionId, cwd: read?.session?.cwd ?? null, source: "sessionQuery.readSession" };
        } catch (error) {
          if (error?.code === "SESSION_QUERY_SESSION_NOT_FOUND") return { sessionId, cwd: null, exists: false, source: "sessionQuery.readSession" };
          return { sessionId, cwd: null, source: `error:${error?.code ?? error?.message ?? "unknown"}` };
        }
      }
      return { sessionId, cwd: null, source: "unavailable" };
    },
    async openSession(id) {
      const ui = uiWorkspace();
      if (!id) return { opened: false, reason: "no-session" };
      if (typeof ui?.openSession !== "function") return { opened: false, reason: "ui-workspace-unavailable" };
      try {
        await ui.openSession(id);
        return { opened: true };
      } catch (error) {
        return { opened: false, reason: error?.message ?? String(error) };
      }
    },
    getCurrentSessionId() {
      return null;
    },
    /** 诊断：各宿主服务在**调用时刻**是否已就绪（懒取模式下的真实可见性）。 */
    /**
     * 只读探测（FR-84 补口 · 2026-10-22 续二）：判断「宿主建会话」这条路**此刻通不通**，
     * **绝不去真的建会话**（建会话＝写用户数据，需用户授权）。
     * 背景：宿主 dsh 的 `agent preset binding` 只接受**带作用域**的 ctx；本插件是软链安装、
     * 仓库零依赖，裸导入 `@deepseek-ai/dsh-scope` 必然失败，故 `loadScopeFactory()` 会按
     * 「裸导入 → 从 dsh 入口 realpath 反查 → 从已解析 dsh 包反查」依次尝试。
     * 该探测就是把这套解析**跑一遍并如实报结果**，供真机排障与前端「先探测再动作」使用。
     */
    async probeHost() {
      const root = typeof getCtx === "function" ? getCtx() : null;
      const out = {
        requested: { getCtx: typeof getCtx === "function", getService: typeof getService === "function" },
        rootCtx: {
          present: Boolean(root),
          get: typeof root?.get === "function",
          plugin: typeof root?.plugin === "function",
        },
        rootCreate: typeof sessionController()?.create === "function",
        rootPrompt: typeof sessionController()?.prompt === "function",
        // FR-95 命名那一跳要用的方法：此前探针只探 create/prompt ⇒「改名能不能成」从未被真机探过。
        rootRename: typeof sessionController()?.rename === "function",
        scopeFactory: scopeFactoryState,
        scopedCtx: false,
        scopedCreate: false,
        scopedPrompt: false,
        scopedRename: false,
        sameControllerAsRoot: null,
        verdict: "unknown",
      };
      try {
        const createScope = await loadScopeFactory();
        out.scopeFactory = scopeFactoryState;
        if (typeof createScope !== "function") { out.verdict = "scope-factory-unavailable"; return out; }
        const scoped = await scopedCtx("tb-probe");
        out.scopedCtx = Boolean(scoped);
        if (!scoped) { out.verdict = "scoped-ctx-unavailable"; return out; }
        let sc = null;
        try { sc = scoped.get?.("sessionController") ?? null; } catch { sc = null; }
        out.scopedCreate = typeof sc?.create === "function";
        out.scopedPrompt = typeof sc?.prompt === "function";
        out.scopedRename = typeof sc?.rename === "function";
        const rootSc = sessionController();
        out.sameControllerAsRoot = sc && rootSc ? sc === rootSc : null;
        // 命名（FR-95）可用性单独成键：**不改变既有 verdict 语义**（老 verdict 只讲建会话），
        // 免得既有调用方（前端「先探测再动作」）按新语义误判。
        out.rename = {
          root: out.rootRename,
          scoped: out.scopedRename,
          verdict: out.scopedRename || out.rootRename ? "rename-available" : "rename-unavailable",
        };
        out.verdict = out.scopedCreate ? "create-available" : (out.rootCreate ? "create-root-only" : "create-unavailable");
      } catch (error) {
        out.verdict = "probe-threw:" + (error?.message ?? String(error));
        out.rename = {
          root: out.rootRename,
          scoped: out.scopedRename,
          verdict: out.rootRename ? "rename-available" : "rename-unavailable",
        };
      }
      return out;
    },
    capabilities() {
      const sc = sessionController();
      return {
        sessionController: Boolean(sc),
        prompt: typeof sc?.prompt === "function",
        create: typeof sc?.create === "function",
        agents: Boolean(agents()),
        sessions: Boolean(sessions()),
        uiWorkspace: Boolean(uiWorkspace()),
        sessionQuery: Boolean(getService?.("sessionQuery")),
        scopeFactory: scopeFactoryState,
      };
    },
  };
}

export function createPluginRuntime(options = {}) {
  const dataDir = resolveDataDir({ dataDir: options.dataDir, env: options.env ?? process.env });
  const store = openStore({ dataDir });
  const ensured = ensureDefaultProject(store);
  // SSE 事件中心（FR-41/FR-49：状态变化实时回流工作台，无需手动刷新）。
  // 之前插件路径未接事件中心 → `/api/events` 失效、状态不会自动回流；此处补齐。
  const events = options.events ?? createEventHub();
  const handler = createRequestHandler({
    store,
    webDir: options.webDir ?? WEB_DIR,
    basePath: PREFIX,
    aiElaborator: options.aiElaborator,
    events,
  });
  const migration = store.stats().migration;
  return {
    dataDir,
    store,
    handler,
    events,
    ensured,
    migration,
    prefix: PREFIX,
    webDir: options.webDir ?? WEB_DIR,
    close: () => store.close(),
  };
}

export function apply(ctx, config) {
  const llm = typeof ctx?.get === "function" ? ctx.get("llm") : undefined;
  const aiElaborator = createLlmElaborator({
    llm,
    provider: config?.elaborateProvider,
    model: config?.elaborateModel,
  });
  // 宿主数据目录三级：插件 config.dataDir > 宿主 config（服务 / 上下文两种取法）> 环境变量 / TEMP 兜底。
  // ⚠ 不得**裸读** `ctx.config`：本插件 `inject` 只声明 `webServer`，cordis 对未声明属性直接抛
  // 「cannot get property "config" without inject」⇒ 装载期整条 entry 不激活（2026-10-26 用隔离真宿主
  // `--from-default-profile` 复现）。故先走**不触发守卫**的 `ctx.get("config")`，历史写法只保留在 try 里。
  const hostDataDir = (() => {
    try {
      const viaService = ctx?.get?.("config")?.dataDir;
      if (viaService) return viaService;
    } catch {
      /* 服务不可解析 ⇒ 继续走下一级 */
    }
    try {
      return ctx?.config?.dataDir;
    } catch {
      return undefined;
    }
  })();
  const runtime = createPluginRuntime({ dataDir: config?.dataDir ?? hostDataDir, aiElaborator });
  // 挂载宿主会话能力（懒取服务）；api 层经 store.hostSessionPort 使用。
  runtime.store.hostSessionPort = createHostSessionPort({ getService: (name) => ctx?.get?.(name), getCtx: () => ctx });
  // 团队引擎端口（默认 P2 指令降级；TEAM_ENGINE=agent-teams 切 P1）。
  const teamEngineMode = config?.teamEngine ?? process.env.TEAM_ENGINE ?? "instruction";
  runtime.store.teamEnginePort = createTeamEnginePort({ getService: (name) => ctx?.get?.(name), mode: teamEngineMode });
  // 宿主会话能力探测（懒取，仅用于日志；真正调用仍在 hostSessionPort 内现取）。
  const probeService = (name) => { try { return Boolean(ctx?.get?.(name)); } catch { return false; } };
  console.log(
    `[taskboard-workbench] host ready: prefix=${PREFIX} dataDir=${runtime.dataDir} projects=${runtime.ensured.projects.length} migration=${JSON.stringify(runtime.migration)} aiElaborate=${Boolean(aiElaborator)} teamEngine=${teamEngineMode} services=${JSON.stringify({ sessionController: probeService("sessionController"), sessions: probeService("sessions"), uiWorkspace: probeService("uiWorkspace"), tools: probeService("tools") })}`,
  );

  const registered = [];
  let disposed = false;
  let toolDisposer = null;
  const unregisterAll = () => {
    for (const dispose of registered.splice(0)) {
      try {
        dispose?.();
      } catch (_) {}
    }
  };
  // 懒取宿主服务（对齐 agent-teams：ctx.get('webServer') ?? ctx.get('httpServer') ?? ctx.webServer）。
  const getWebServer = () => ctx?.get?.("webServer") ?? ctx.get?.("httpServer") ?? ctx?.webServer;
  const registerRoutes = (webServer) => {
    if (!webServer || disposed) return;
    unregisterAll(); // 先注销旧注册：避免 HMR/服务替换导致的“重复注册→前缀路由缺失”
    for (const spec of [
      { kind: "prefix", path: PREFIX, handler: runtime.handler },
      { kind: "exact", path: PREFIX, handler: runtime.handler },
    ]) {
      try {
        registered.push(webServer.register(spec));
        console.log(`[taskboard-workbench] route registered: ${spec.kind} ${spec.path}`);
      } catch (error) {
        console.error(`[taskboard-workbench] route ${spec.kind} ${spec.path} failed: ${error?.message ?? error}`);
      }
    }
  };
  // 反向链路：把 taskboard_* 工具注册给宿主（懒取 tools 服务；动态 import 以便脱离 DSH 时静默跳过）。
  const registerTools = (toolsService) => {
    if (!toolsService || typeof toolsService.register !== "function" || toolDisposer) return;
    import("./src/host/tool-surface.mjs")
      .then((m) => {
        toolDisposer = m.registerTaskboardTools({ tools: toolsService, store: runtime.store, events: runtime.events });
        console.log("[taskboard-workbench] tools registered: taskboard_*");
      })
      .catch((error) => console.error(`[taskboard-workbench] tools register failed: ${error?.message ?? error}`));
  };

  try {
    ctx.effect(() => {
      disposed = false;
      registerRoutes(getWebServer());
      registerTools(ctx?.get?.("tools") ?? ctx?.tools);
      // FR-82 收口（启动口径）：上一进程留下的「进行中」尝试不会有人闭合 —— 启动时一次结清（**不看时长**）。
      try {
        const rec = runtime.store.reconcileOrphanRuns({ boot: true });
        if (rec.ended.length || rec.ghostClaims.length) {
          console.log(`[taskboard-workbench] boot reconcile: 收口孤儿尝试 ${rec.ended.length} 条（${rec.ended.map((r) => `${r.identifier}#${r.attempt}→${r.outcome}`).join(", ")}）；清幽灵认领 ${rec.ghostClaims.length} 条`);
        }
      } catch (error) {
        console.error(`[taskboard-workbench] boot reconcile failed: ${error?.message ?? error}`);
      }
      // 看板执行循环定时器（FR-70）：仅对"已开启循环"的项目按活跃引擎自动派发待执行任务
      const loopTimer = setInterval(() => {
        // FR-77：回收失效认领（认领过期 / 心跳陈旧）——执行侧仍存活则延后，避免重复派发。
        try {
          const reclaimed = runtime.store.reclaimStaleClaims();
          for (const r of reclaimed) {
            console.log(`[taskboard-workbench] reclaim ${r.identifier} → ${r.status}`);
            try { runtime.events?.publish?.("task.updated", { identifier: r.identifier, status: r.status }); } catch (_) { /* ignore */ }
          }
        } catch (error) {
          console.error(`[taskboard-workbench] reclaim error: ${error?.message ?? error}`);
        }
        // FR-82 收口（定时器口径）：只收**超过运行时上限**的尝试（尊重该次自己的 max_ms），绝不误杀正在跑的。
        try {
          const rec = runtime.store.reconcileOrphanRuns();
          for (const r of rec.ended) console.log(`[taskboard-workbench] run reconcile ${r.identifier}#${r.attempt} → ${r.outcome}`);
        } catch (error) {
          console.error(`[taskboard-workbench] run reconcile error: ${error?.message ?? error}`);
        }
        for (const project of listLoopProjects(runtime.store)) {
          runExecutionLoop({ store: runtime.store, events: runtime.events, projectId: project.id })
            .then((r) => {
              if (r.dispatched.length) console.log(`[taskboard-workbench] loop ${project.id}: dispatched ${r.dispatched.length} delivered=${r.delivered} (engine=${r.engine})`);
            })
            .catch((error) => console.error(`[taskboard-workbench] loop error: ${error?.message ?? error}`));
        }
      }, 30000);
      loopTimer.unref?.();
      // 服务在插件 apply 之后才出现/被替换时，重新注册（agent-teams 同款做法）。
      const onService = (name) => {
        if (name === "webServer" || name === "httpServer") registerRoutes(getWebServer());
        if (name === "tools") registerTools(ctx?.get?.("tools") ?? ctx?.tools);
      };
      const off = ctx?.on?.("internal/service", onService);
      return () => {
        disposed = true;
        try { clearInterval(loopTimer); } catch (_) {}
        try {
          off?.();
        } catch (_) {}
        unregisterAll();
        try { toolDisposer?.(); } catch (_) {}
        toolDisposer = null;
        runtime.close();
        console.log("[taskboard-workbench] host disposed");
      };
    }, "taskboard-workbench: routes");
  } catch (error) {
    console.error(`[taskboard-workbench] ctx.effect failed: ${error?.message ?? error}`);
    throw error;
  }

  return runtime;
}

export const manifestPath = fileURLToPath(new URL("./cordis.patch.yml", import.meta.url));
