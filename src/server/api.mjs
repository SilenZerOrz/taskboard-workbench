/**
 * api.mjs —— 纯路由逻辑（不依赖 node:http）。独立服务与 DSH 宿主插件共用。
 */
import { PRIORITIES, STATUSES } from "../core/domain.mjs";
import { clampElaborateLimit } from "../core/requirements.mjs";
import { EXIT, TbError, invalidField } from "../core/errors.mjs";
import { resolveContext } from "../core/binding.mjs";
import { scanProjectMaterials, buildMaterialIndex, collectExternalFiles } from "../core/intake.mjs";
import { scanAgentTeams, OFFICIAL_TEAM } from "../core/agent-teams.mjs";
import { buildTeamDirective } from "../host/team-engine.mjs";
import { runExecutionLoop, activeEngine } from "../core/loop.mjs";
import { assertTeamTemplate, assertQualityGates, planTeamMembers } from "../core/team.mjs";
import { assessTaskRef, projectWatchdog } from "../core/watchdog.mjs";
import { isHumanReviewTask, planHumanReview } from "../core/human-review.mjs";
import { deriveNextStep } from "../core/next-step.mjs";
/**
 * 能力缺失的统一措辞（真机 2026-10-29 · `:47830`「未能投递：host-unavailable · 检查宿主会话通道后重试」）。
 *
 * 旧文案把**能力缺失**说成了**临时故障** —— 人会一直重试一个永远不会成立的条件。
 * 真实情况：独立进程实例（`node src/server/server.mjs`，没有 DSH 宿主）的 `host.capabilities` 恒为 `null`，
 * 这类动作在该进程上**做不到**，正确出路是"换到 DSH 内的任务工作台"或"把 prompt 粘到会话里手工投递"。
 */
const HOST_UNAVAILABLE_NEXT = "该实例没有宿主会话通道（独立进程，/api/health 的 host.capabilities 为 null）：改到 DSH 内的任务工作台操作，或把返回的 prompt 直接粘到会话里手工投递";

import { buildDebugDispatchPrompt } from "../core/debug-dispatch.mjs";
import { buildSplitAskPrompt } from "../core/split-ask.mjs";
import { buildReviewEvidence, formatVerifyComment, normalizeVerifyCommand, summarizeVerifyOutput, VERIFY_DEFAULT_COMMAND } from "../core/verify.mjs";
import { evaluateKickoff } from "../core/kickoff.mjs";
import { deriveEmptyState } from "../core/empty-state.mjs";
// 2026-10-28 拍板 E1–E3 / D-M1–D-M5：项目推进清单（纯投影 + 幂等回写）与项目记忆（L2 条目 + L3 召回）。
import { buildAdvance, renderAdvanceBlock, applyDecision } from "../core/advance.mjs";
import { renderMemoryBlock } from "../core/memory.mjs";
import { taskSessionTitle, projectMainSessionTitle } from "../core/session-naming.mjs";
import { collectKickoffFacts, hasEngineerExecutor, hasReviewerRole } from "./kickoff.mjs";
import { runVerifyCommand, probeVerifyApplicability } from "./verify.mjs";
import { DIAGNOSTIC_KINDS, evaluateTaskDiagnostics, projectDiagnostics, summarizeDiagnostics, resolveSessionRef, humanReviewProbe, humanReviewAnsweredBy } from "../core/diagnostics.mjs";
import { summarizeNotifyDelivery } from "../core/notify.mjs";
import { resolveCliExecutor, executeTaskWithCli, buildTaskPrompt, cliArgsFor, claimForCliExecution, DEFAULT_TIMEOUT_MS } from "../core/executor.mjs";
import { DEFAULT_FAILURE_LIMIT } from "../core/store.mjs";
// 卡 `-177`（2026-10-29 · 口径 X）：acceptance 缺省口径与 MCP **共用同一份**，不在本文件另写判断。
import { markAcceptance, acceptanceFlag } from "../core/acceptance.mjs";

export const API_SCHEMA_VERSION = 2;

export function httpStatusFor(error) {
  if (error.code === "STORE_UNAVAILABLE") return 503;
  if (error.code === "NOT_FOUND" || error.code.endsWith("_NOT_FOUND")) return 404;
  if (error.exitCode === EXIT.CONFLICT) return 409;
  return 400;
}

export function createApiRouter({ store, aiElaborator, events } = {}) {
  const emit = (type, payload) => { try { events?.publish?.(type, payload); } catch { /* ignore */ } };
  /**
   * 已有执行会话仍在执行（未返回结论）→ 不得再次下发。
   * 判定：任务已记录执行会话，且宿主 agents 注册表显示该会话 running / inbox 仍有待消费消息。
   */
  const inflightOf = (task) => {
    // FR-77：**认领锁 + 心跳优先**——锁未过期且心跳新鲜才算"在途"（会话状态仅作降级信号）。
    const claim = store.taskClaimState(task);
    if (claim.locked && !claim.expired && !claim.stale) return { ...claim, via: "claim" };
    const st = store.taskSessionState(task);
    if (!st?.sessionId) return null;
    if (st.running || (st.live && (st.pending ?? 0) > 0)) return { ...st, via: "session" };
    return null;
  };
  const inflightError = (task, st) =>
    new TbError(
      "EXECUTION_ALREADY_RUNNING",
      `当前已有在途执行（${st.via === "claim" ? `认领锁未过期、心跳 ${st.heartbeatAgeSeconds ?? "?"}s 前` : `会话仍在执行${st.pending ? `，待消费 ${st.pending} 条` : ""}`}）：已停止再次下发。可「打开执行会话」查看进展，或等其回写状态/认领回收后再派发。`,
      {
        identifier: task.identifier, via: st.via,
        sessionId: st.sessionId ?? null, lock: st.lock ?? null,
        heartbeatAgeSeconds: st.heartbeatAgeSeconds ?? null,
        status: st.status ?? null, pending: st.pending ?? 0,
      },
    );
  /** FR-78：熔断原因 → 给用户的说明。 */
  const circuitMessage = (reason, task) => {
    const limit = task.maxRetries ?? DEFAULT_FAILURE_LIMIT;
    if (reason === "quota-blocked") return `上次失败属配额/鉴权类（重试无益）：已停止自动重试。请先解决配额/鉴权，或人工「重置失败计数」后再派发。${task.lastFailureError ? `\n原因：${task.lastFailureError}` : ""}`;
    if (reason === "circuit-open") return `连续失败已达阈值（${task.consecutiveFailures ?? "?"}/${limit}）：已熔断并置「受阻」，不再自动重试。请人工判断后用「重置失败计数」或修改任务后再派发。${task.lastFailureError ? `\n最近原因：${task.lastFailureError}` : ""}`;
    return `窗口内该任务已成功完成且之后无人工重跑：为避免重复产出，已跳过自动派发。如需重跑请用「退回待办（重新派发）」。`;
  };
  /**
   * FR-84：会话存活判定（打开/接续前的统一探活）。
   * `exists` 三态：true 存在 / false 确认失效 / **null 未知**（判不准时不得谎报失效）。
   */
  async function sessionStateOf(sessionId) {
    const port = store.hostSessionPort;
    const live = (() => { try { return port?.sessionState?.(sessionId) ?? null; } catch { return null; } })();
    let exists = null;
    let source = "unavailable";
    if (typeof port?.sessionExists === "function") {
      try { const r = await port.sessionExists(sessionId); exists = r?.exists ?? null; source = r?.source ?? "sessionExists"; }
      catch (error) { exists = null; source = `error:${error?.code ?? error?.message ?? "unknown"}`; }
    } else if (live?.live) { exists = true; source = "agents"; }
    return {
      sessionId: sessionId ?? null, exists, source,
      live: Boolean(live?.live), running: Boolean(live?.running), status: live?.status ?? null, pending: live?.pending ?? 0,
    };
  }

  /**
   * FR-84 补口 · **接续会话的工作区归属**：会话创建时的 cwd → 归属项目。
   *
   * 为什么需要：`resolveSessionRef` 的三级回落只判「存在/存活」，**不判这个会话是不是本项目的**。
   * 真机事故（2026-10-19）：`taskboard-workbench` 的主会话指针被指到**另一个工作区**（项目-dsh-acp）的
   * 6.3 MB 会话上 → 看板每张卡「打开执行会话」都会打开**别人的、巨大的**会话，对话页长时间只显示输入框。
   *
   * 判定口径：`mismatch:true` = 会话 cwd 归属的项目 ≠ 当前项目（或不属于任何项目）；
   * **判不准**（宿主不给 cwd / 项目没有 workspacePath）一律 `mismatch:null` —— 不臆断、不误拦。
   */
  async function sessionOriginOf(sessionId, project = null) {
    const base = { sessionId: sessionId ?? null, cwd: null, projectId: null, projectName: null, mismatch: null, source: "unavailable" };
    if (!sessionId) return base;
    const port = store.hostSessionPort;
    if (!port || typeof port.sessionOrigin !== "function") return base;
    let info = null;
    try { info = await port.sessionOrigin(sessionId); }
    catch (error) { return { ...base, source: `error:${error?.code ?? error?.message ?? "unknown"}` }; }
    const cwd = info?.cwd ?? null;
    if (!cwd) return { ...base, source: info?.source ?? "unknown" };
    // 显式路径比对（**不用 `resolveProjectForCwd`**：它在无匹配时会回落"第一个项目"，会把"谁都不属于"误判成"属于本项目"）。
    const norm = (p) => String(p ?? "").replace(/\/+$/, "");
    const cwdNorm = norm(cwd);
    const under = (base) => {
      const b = norm(base);
      return Boolean(b) && (cwdNorm === b || cwdNorm.startsWith(`${b}/`));
    };
    const owner = store.listProjects().filter((p) => under(p.workspacePath)).sort((a, b) => norm(b.workspacePath).length - norm(a.workspacePath).length)[0] ?? null;
    const hasOwnPath = Boolean(norm(project?.workspacePath));
    const mismatch = hasOwnPath ? !under(project.workspacePath) : null;
    return { sessionId, cwd, projectId: owner?.id ?? null, projectName: owner?.name ?? null, mismatch, source: info?.source ?? "unknown" };
  }
  /**
   * FR-61 开局提示词（重建主会话后投递，确保新会话知道自己是项目主会话）。
   *
   * **格式口径（卡 `-145` · `docs/规范/01-协作规范.md` §一）**：本仓「派发指令」的第二个产出点，
   * 按 §一 模板给齐 **已获授权 / 硬边界 / 停下情形 / 回报格式**。它是**长期坐席**的主会话指令
   * （不像 `buildTaskPrompt` 一次一卡），故不写 Step 0/1/2 的逐卡判据，改为「每接到一张卡时」
   * 的判据与停下情形 —— 保持 §一 的字段齐备，同时不臆造一次性的分步流程。
   */
  function buildOpeningPrompt(project) {
    return [
      `[任务工作台 · 项目主会话] 项目：${project?.name ?? project?.id ?? "?"}（${project?.id ?? "?"}）`,
      "你已成为该项目的**主会话**：工作台的任务派发、状态回流与通知唤醒都会投递到这里。",
      "请在该会话内加载「任务工作台」插件，并在需要时按团队契约创建/承接 agent team（详见随包文档 `spec/团队agent.md` 的『智能体操作规范（随包）』一节）。",
      "",
      "## 已获授权",
      "- 在本项目工作区内认领并执行派发到本会话的任务卡（`todo` 卡不得直接执行，须先经人授权开工）。",
      "- 在本项目工作区内运行只读检查与该卡相关的测试 / 构建命令。",
      "- 代拟派发给子 agent 的任务书时，按 `docs/规范/01-协作规范.md` §一 模板书写。",
      "",
      "## 硬边界",
      "- ❌ 执行侧不得置「完成(done)」—— 完成只能由人确认；你只提交「待验收」。",
      "- ❌ 不 commit / 不 push。",
      "- ❌ 不改范围外文件；不改历史决策文档；不删既有数据。",
      "- ❌ 不自行重载 / 重启 dsh 宿主进程，不动 `~/.dsh/profiles/**`（属须报批范围，见 AGENTS.md §3）。",
      "",
      "## 每接到一张卡时的判据",
      "- 先读该卡的描述、`acceptance`（完成验收标准）与复核动作、以及全部既有评论，再动手。",
      "- 判据 = 该卡 `acceptance` 逐条可核 + 复核动作退出码为 0。",
      "",
      "---",
      "",
      "## 回报格式（严格按这四节，缺节＝不合格）",
      "**判定**：完成 / 部分 / 停下（哪一步）",
      "**偏离说明**：指令假设 X、实测 Y、故改为 Z；**无偏离也显式写「无」**，不得省略本节。",
      "**边界自查**：逐条对齐上方「硬边界」的 ❌ 清单。",
      "**产物路径**：改动文件清单、测试输出、落盘报告或截图的路径。",
      "",
      "## 停下情形（严格，逐条编号；命中即停）",
      "1. 前置不满足（卡片未授权 / `acceptance` 为空且无从判定 / 基线非绿）→ 停下并回报「停下（Step 0）」。",
      "2. 门禁不过（复核动作退出码非 0）→ 停在失败步，贴出失败证据，不修饰。",
      "3. 不可逆动作前（commit / push / 重载宿主 / 插件增删）→ 一律停，等人授权；指令不含此授权。",
      "4. 偏离预期（实测与卡面不符）→ 停，并在「偏离说明」写清「指令假设 X、实测 Y、故改为 Z」。",
      "",
      "## 禁止",
      "- 不得以「报告说完成」当事实：交付前用实际命令自证（`git status`、测试输出）。",
      "- 不得臆断：实测不到的事实写「未取得 / 无法判定」，不编造。",
    ].join("\n");
  }
  async function route({ method, pathname, searchParams, body = {} }) {
    if (pathname === "/api/health" && method === "GET") {
      // 宿主能力可见性（诊断）：投递指令 / 建会话 / 打开会话 各依赖的宿主服务是否已就绪。
      const has = (fn) => { try { return typeof fn === "function"; } catch { return false; } };
      const port = store.hostSessionPort;
      const host = {
        createSession: Boolean(port?.available),
        sendPrompt: has(port?.sendPrompt),
        openSession: has(port?.openSession),
        // 2026-10-29（二轮复核）：**按"真正依赖的能力"报**，不要拿 createSession 当万能代理 ——
        // FR-84 的「改绑已有会话 / 改指本任务」恰恰在**建会话不可用**时是保底出口（`sessionExists`/`listSessions`
        // 在、`createSession` 不在），拿 createSession 去置灰它们会把唯一的出路也焊死。
        listSessions: has(port?.listSessions),
        sessionExists: has(port?.sessionExists),
        sessionOrigin: has(port?.sessionOrigin),
        renameSession: has(port?.renameSession),
        sessionState: has(port?.sessionState),
        capabilities: (() => { try { return port?.capabilities?.() ?? null; } catch { return null; } })(),
      };
      return { status: 200, payload: { status: "ok", host, ...store.stats() } };
    }
    if (pathname === "/api/host/probe" && method === "GET") {
      // 只读探测：宿主「建会话」这条路此刻通不通。**不建会话、不写任何数据**。
      const port = store.hostSessionPort;
      let probe = null;
      try { probe = (await port?.probeHost?.()) ?? null; }
      catch (error) { probe = { verdict: "error:" + (error?.message ?? String(error)) }; }
      return { status: 200, payload: { schemaVersion: 2, probe } };
    }
    if (pathname === "/api/meta" && method === "GET") {
      return {
        status: 200,
        payload: { statuses: STATUSES, priorities: PRIORITIES, dataDir: store.dataDir, dbPath: store.dbPath },
      };
    }
    if (pathname === "/api/context" && method === "GET") {
      // 工作区(cwd) → 项目 → 需求文档 的初始绑定；session= 时绑定/校验"主会话与关联"（FR-60/FR-62/FR-63）
      const cwd = searchParams.get("cwd") ?? undefined;
      const session = searchParams.get("session") ?? undefined;
      const projectParam = searchParams.get("project") ?? undefined;
      // FR-60/63：优先按"会话归属哪个项目"解析（主会话/已关联），避免只按 cwd 误落到别的项目
      const bySession = session ? store.findProjectBySession(session) : null;
      let ctx = projectParam
        ? { project: store.requireProject(projectParam), requirementDoc: store.ensureRequirementDoc(projectParam) }
        : bySession
        ? { project: bySession.project, requirementDoc: store.ensureRequirementDoc(bySession.project.id) }
        : resolveContext(store, cwd);
      // FR-62：全局入口（无会话、无工作区）默认进入"近期执行"项目
      if (!session && !cwd && !projectParam) {
        const dp = store.defaultProject();
        if (dp) ctx = { project: dp, requirementDoc: store.ensureRequirementDoc(dp.id) };
      }
      let sessionBound = null;
      let association = null;
      if (ctx.project && session) {
        // 首个进入该项目的会话成为"主会话"（首次绑定不改写）
        if (!ctx.project.initialSessionId) ctx = { ...ctx, project: store.bindInitialSession(ctx.project.id, session) };
        const binding = store.sessionBinding(ctx.project.id, session);
        sessionBound = binding.bound;
        association = binding.role;
      }
      const mainSessionId = ctx.project ? (store.requireProject(ctx.project.id).initialSessionId ?? null) : null;
      // FR-84 补口（2026-10-23）· **实例工作区预检**：一个 DSH 实例只有一个工作区（宿主不给切换服务，
      // `capabilities.uiWorkspace=false`），所以「在看板里切到别的项目」**不会**让宿主跟着换工作区。
      // 这里把「本会话落哪个工作区」如实交出来（只读探测），前端据此提前告知，不再让用户走
      // 「重建 → 还是说工作区不对」的弯路。
      const sessionOrigin = session ? await sessionOriginOf(session, ctx.project ?? null) : null;
      return { status: 200, payload: { cwd: cwd ?? null, session: session ?? null, project: ctx.project, requirementDoc: ctx.requirementDoc, sessionBound, mainSessionId, association, sessionOrigin } };
    }
    if (pathname === "/api/projects") {
      if (method === "GET") {
        const projects = store.listProjects();
        return { status: 200, payload: { projects, count: projects.length } };
      }
      if (method === "POST") {
        const project = store.createProject({ name: body.name, id: body.id, workspacePath: body.workspacePath ?? null });
        return { status: 201, payload: { project } };
      }
      throw new TbError("USAGE_ERROR", "/api/projects 仅支持 GET 或 POST");
    }
    // FR-03：删除项目（非空守卫）。`confirm` 可走 query（`?confirm=1`）或 body（`{confirm:true}`）。
    // 非空被拒 / 未确认被拒都抛 TbError（`PROJECT_NOT_EMPTY` / `PROJECT_DELETE_UNCONFIRMED`），
    // 由上层统一映射成 HTTP 状态码 + 明确提示，不静默成功。
    const projectDeleteRoute = /^\/api\/projects\/([^/]+)$/.exec(pathname);
    if (projectDeleteRoute) {
      if (method !== "DELETE") throw new TbError("USAGE_ERROR", "/api/projects/:ref 仅支持 DELETE");
      const ref = decodeURIComponent(projectDeleteRoute[1]);
      const confirm = body.confirm === true || searchParams.get("confirm") === "1";
      const deleted = store.deleteProject(ref, { confirm, actor: body.actor ?? "human", reason: body.reason ?? null });
      return { status: 200, payload: { deleted } };
    }
    // 项目资料引入（FR-55）：把本地项目文件夹的 md/doc 资料引入工作台
    const projectIntakeRoute = /^\/api\/projects\/([^/]+)\/intake$/.exec(pathname);
    if (projectIntakeRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "intake 仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectIntakeRoute[1]));
      const root = body.path ?? project.workspacePath;
      if (!root) throw new TbError("USAGE_ERROR", "未指定 path，且项目没有 workspacePath");
      const scan = await scanProjectMaterials(root, {
        maxFiles: body.maxFiles ?? 500, maxDepth: body.maxDepth ?? 8,
        exts: body.exts, include: body.include, exclude: body.exclude,
      });
      // 工作区外的显式文件（extraPaths）：按引用纳入，不拷贝
      const extra = await collectExternalFiles(body.extraPaths ?? []);
      const combined = extra.length ? { ...scan, files: [...scan.files, ...extra], count: scan.files.length + extra.length } : scan;
      const built = await buildMaterialIndex(combined, { maxBytesPerFile: body.maxBytesPerFile ?? 8000, includeContent: body.includeContent !== false });
      if (body.dryRun) {
        return { status: 200, payload: { project: project.id, root: combined.root, scanned: combined.count, truncated: combined.truncated, files: combined.files.map((f) => ({ relPath: f.relPath, bytes: f.bytes, readable: f.readable, external: !!f.external })), dryRun: true } };
      }
      // FR-57（2026-10-29 修订 · A 方案）：**引入只建资料索引，不产生需求条目**。
      // 条目只由三条正路产生：人工新建 / elaborate 候选确认 / MCP requirement_upsert。
      // 旧 `items` / `both` 一律**显式拒绝**（不静默降级成 doc-only）——「那条路根本不存在」要在契约层成立，
      // 而不是「前端不点它就没事」。未知 mode 同样收紧为用法错误（仓内无调用方传未知值，见
      // 进度/2026-10-29-intake口径A-FR条款修订草案.md §8.3）。
      const mode = body.mode ?? "doc";
      if (mode !== "doc") {
        if (mode === "items" || mode === "both") {
          throw new TbError("INTAKE_ITEMS_DISABLED",
            "资料引入只生成索引、不产生需求条目；条目请走人工新建 / elaborate 候选确认 / MCP requirement_upsert。历史 source=intake 条目仍可查询、筛选、关闭、删除。");
        }
        throw new TbError("USAGE_ERROR", `未知 mode：${mode}（intake 仅支持 "doc"）`);
      }
      const ensured = store.ensureRequirementDoc(project.id, { body: "" });
      const doc = store.updateRequirementDoc(ensured.id, { expectedVersion: ensured.version, body: built.index });
      return {
        status: 201,
        payload: {
          project: project.id, root: combined.root, scanned: combined.count, truncated: combined.truncated, mode,
          doc: { id: doc.id, version: doc.version, bytes: built.index.length },
        },
      };
    }
    // FR-92：**项目开局对齐**自检（标准步骤程序）—— 只读，绝不写任何数据。
    // 用户 2026-10-22 要求把《Vibe Coding 团队协作技巧》作为「项目开局对齐事项」引入，
    // 并「作为任务工作台标准步骤程序执行」：这里让工作台能自己回答"这个项目对齐了没有"。
    const projectKickoffRoute = /^\/api\/projects\/([^/]+)\/kickoff$/.exec(pathname);
    if (projectKickoffRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "/api/projects/:id/kickoff 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectKickoffRoute[1]));
      const settings = store.getProjectSettings(project.id);
      const facts = collectKickoffFacts(project.workspacePath ?? null);
      const report = evaluateKickoff({
        files: facts.files,
        settings,
        custom: { reviewerRole: hasReviewerRole(settings?.teamTemplate), engineerExecutor: hasEngineerExecutor(settings?.teamTemplate) },
      });
      return { status: 200, payload: { project: project.id, workspacePath: project.workspacePath ?? null, readable: facts.readable, ...report } };
    }
    // 项目设置（FR-56）：项目环境约束 + agent 执行团队模板
    const projectSettingsRoute = /^\/api\/projects\/([^/]+)\/settings$/.exec(pathname);
    if (projectSettingsRoute) {
      const project = store.requireProject(decodeURIComponent(projectSettingsRoute[1]));
      if (method === "GET") return { status: 200, payload: store.getProjectSettings(project.id) };
      if (method === "PUT" || method === "POST") {
        // FR-50 残留：保存前过**模板质量门**（与建队同口径，均在**写库之前**，被拒则设置保持原样）。
        //   · 已配置 roles ⇒ 走与 `POST /api/teams` 完全同一道门 `assertTeamTemplate({ roles, qualityGates })`；
        //   · 未传 / 空 roles ⇒ **保持既有含义**（允许只改 engine / executionTeam / envConfig 等），
        //     此时仍校验质量门（未配置放行；已配置但越界 ⇒ INVALID_TEAM_TEMPLATE / quality-gate-unknown）。
        if (body.teamTemplate !== undefined && body.teamTemplate !== null) {
          const tpl = body.teamTemplate;
          const roles = Array.isArray(tpl?.roles) ? tpl.roles : [];
          if (roles.length) assertTeamTemplate({ roles, qualityGates: tpl?.qualityGates });
          else assertQualityGates({ qualityGates: tpl?.qualityGates });
        }
        const saved = store.saveProjectSettings(project.id, { envConfig: body.envConfig, teamTemplate: body.teamTemplate, loop: body.loop });
        return { status: 200, payload: saved };
      }
      throw new TbError("USAGE_ERROR", "settings 仅支持 GET 或 PUT");
    }
    // 会话 ↔ 项目关联（FR-63）：列出 / 申请 / 批准
    const projectAgentTeamsRoute = /^\/api\/projects\/([^/]+)\/agent-teams$/.exec(pathname);
    if (projectAgentTeamsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "agent-teams 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectAgentTeamsRoute[1]));
      // 只列"本项目主会话自身"的团队：官方（队长=主会话）+ 第三方（captainSessionId == 主会话）
      const thirdParty = await scanAgentTeams(project.workspacePath, { mainSessionId: project.initialSessionId ?? null });
      return { status: 200, payload: { mainSessionId: project.initialSessionId ?? null, teams: [OFFICIAL_TEAM, ...thirdParty], count: 1 + thirdParty.length } };
    }
    const projectSessionsRoute = /^\/api\/projects\/([^/]+)\/sessions$/.exec(pathname);
    if (projectSessionsRoute) {
      const project = store.requireProject(decodeURIComponent(projectSessionsRoute[1]));
      if (method !== "GET") throw new TbError("USAGE_ERROR", "sessions 仅支持 GET");
      // FR-84：每条绑定附**存活徽标**，并单列主会话（失效时前端可一键重建）。
      const rows = store.listProjectSessions(project.id);
      const sessions = [];
      for (const row of rows) sessions.push({ ...row, liveness: await sessionStateOf(row.sessionId) });
      const mainSessionId = project.initialSessionId ?? null;
      const main = mainSessionId ? { sessionId: mainSessionId, role: "main", liveness: await sessionStateOf(mainSessionId) } : null;
      return { status: 200, payload: { sessions, main, staleMain: Boolean(main && main.liveness.exists === false) } };
    }
    // FR-84 补口（2026-10-22）· **本工作区已有会话**候选列表。
    // 用途：宿主**建会话**能力不可用时（实例未加载宿主 shim → `create()` 抛
    // "Agent preset binding requires a scoped context"），「重建并绑定项目主会话」这条路会**彻底走不通**，
    // 而**改绑一个本工作区已有会话**完全不需要建会话 —— 这是接续流程的保底出口。
    const projectSessionCandidatesRoute = /^\/api\/projects\/([^/]+)\/sessions\/candidates$/.exec(pathname);
    if (projectSessionCandidatesRoute) {
      const project = store.requireProject(decodeURIComponent(projectSessionCandidatesRoute[1]));
      if (method !== "GET") throw new TbError("USAGE_ERROR", "candidates 仅支持 GET");
      const want = project.workspacePath ?? null;
      const port = store.hostSessionPort;
      const base = { projectId: project.id, workspacePath: want, current: project.initialSessionId ?? null, candidates: [] };
      if (!port || typeof port.listSessions !== "function") {
        return { status: 200, payload: { ...base, source: "unavailable", total: 0, reason: "host-cannot-list-sessions" } };
      }
      let res = null;
      try { res = await port.listSessions({ cwd: want ?? undefined }); }
      catch (error) { return { status: 200, payload: { ...base, source: "error", total: 0, reason: error?.code ?? String(error?.message ?? error) } }; }
      const all = Array.isArray(res?.sessions) ? res.sessions : [];
      const candidates = [];
      for (const row of all.slice(0, 50)) {
        candidates.push({
          sessionId: row.sessionId,
          title: row.title ?? null,
          updatedAt: row.updatedAt ?? null,
          cwd: row.cwd ?? null,
          isCurrent: row.sessionId === (project.initialSessionId ?? null),
          liveness: await sessionStateOf(row.sessionId),
        });
      }
      return { status: 200, payload: { ...base, source: res?.source ?? "unknown", reason: res?.reason ?? null, total: all.length, candidates } };
    }
    // FR-84：重建并重绑项目主会话（需 confirm；成功后投递 FR-61 开局提示词并写审计）。
    const projectRebindRoute = /^\/api\/projects\/([^/]+)\/sessions\/rebind$/.exec(pathname);
    if (projectRebindRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "rebind 仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectRebindRoute[1]));
      const confirmed = body.confirm === true || searchParams.get("confirm") === "1";
      if (!confirmed) return { status: 200, payload: { rebound: false, reason: "confirm-required", projectId: project.id, current: project.initialSessionId ?? null } };
      const port = store.hostSessionPort;
      // FR-84 补口（2026-10-22）· **改绑已有会话**（`sessionId` 显式给出时走这条，**不新建会话**）：
      // 真机现场：`:3080` 实例未加载宿主 shim 时 `createSession()` 必抛错 ⇒「重建并绑定项目主会话」点不通，
      // 而项目主会话指针又指着**另一个工作区**的旧会话 ⇒ 用户「从任务台回不到项目主会话」。
      // 改绑路径的前提校验一条都不能省：**必须先探活**（不存在不让绑），**必须校验工作区归属**
      //（指向别的工作区的会话正是本补口要修的病根，默认拒绝，`force:true` 才放行）。
      const explicitSessionId = body.sessionId ?? searchParams.get("session") ?? null;
      if (explicitSessionId) {
        if (!port || typeof port.sessionExists !== "function") throw new TbError("HOST_UNAVAILABLE", "宿主不支持校验会话：无法改绑主会话");
        const existsRes = await port.sessionExists(explicitSessionId);
        if (existsRes?.exists === false) {
          throw new TbError("SESSION_NOT_FOUND", "该会话在本机不存在：不能绑定为项目主会话", { sessionId: explicitSessionId });
        }
        let origin = null;
        if (typeof port.sessionOrigin === "function") { try { origin = await port.sessionOrigin(explicitSessionId); } catch { origin = null; } }
        const want = project.workspacePath ?? null;
        const got = origin?.cwd ?? null;
        const mismatch = Boolean(want && got && got !== want);
        if (mismatch && body.force !== true) {
          throw new TbError("SESSION_OTHER_WORKSPACE", `该会话属于另一个工作区：${got}（本项目工作区 ${want}）→ 默认拒绝改绑；确要改绑请显式 force`, { sessionId: explicitSessionId, cwd: got, workspacePath: want });
        }
        // 2026-10-23 用户命名约束（口径 2 后半）：**重绑**的主会话名后跟备注「重绑」。
        // 只改该会话标题（用户可见），不动它的历史；拿不到确认就如实回报，不谎报。
        // FR-95 补口（2026-10-26）：把**算出来的名字**一并回包（`sessionName`），前端才能如实显示
        // 「已命名《…》」或「⚠ 会话名未生效（原因）」—— 此前 API 回了 titleApplied，但**没有任何界面展示它**，
        // 改名失败时用户看不到半点提示（「如实回报」断在最后一跳）。
        const boundSessionName = projectMainSessionTitle(project.name, { note: "重绑" });
        let titleApplied2 = null; let titleReason2 = null;
        if (typeof port.renameSession === "function") {
          try {
            const named = await port.renameSession(explicitSessionId, boundSessionName);
            titleApplied2 = Boolean(named?.renamed);
            titleReason2 = named?.renamed ? null : (named?.reason ?? "rename-failed");
          } catch (error) { titleApplied2 = false; titleReason2 = error?.code ?? String(error?.message ?? error); }
        }
        const rbExisting = store.rebindInitialSession(project.id, explicitSessionId);
        let openingDelivered2 = false; let deliveryReason2 = null;
        // 该会话通常**已有历史** ⇒ 默认不投递开局提示词（避免往用户的历史会话里塞指令）；要投递须显式 deliverOpening:true。
        if (body.deliverOpening === true && typeof port.sendPrompt === "function") {
          try { const r = await port.sendPrompt(explicitSessionId, buildOpeningPrompt(rbExisting.project)); openingDelivered2 = Boolean(r?.sent); deliveryReason2 = r?.reason ?? null; }
          catch (error) { deliveryReason2 = error?.code ?? String(error?.message ?? error); }
        }
        const auditId2 = store.recordAudit({ actor: "board", action: "rebind-initial-session", target: project.id, allowed: true, reason: "bind-existing", detail: JSON.stringify({ before: rbExisting.before, after: rbExisting.after, mode: "bind-existing", cwd: got, mismatch, openingDelivered: openingDelivered2, deliveryReason: deliveryReason2, titleApplied: titleApplied2, titleReason: titleReason2 }) });
        emit("project.updated", { projectId: project.id, initialSessionId: rbExisting.after });
        return { status: 200, payload: { rebound: true, mode: "bind-existing", projectId: project.id, before: rbExisting.before, after: rbExisting.after, cwd: got, mismatch, openingDelivered: openingDelivered2, deliveryReason: deliveryReason2, titleApplied: titleApplied2, titleReason: titleReason2, sessionName: boundSessionName, auditId: auditId2 } };
      }
      if (!port || typeof port.createSession !== "function") throw new TbError("HOST_UNAVAILABLE", "宿主不支持建会话：无法重建主会话");
      // FR-84 修复（2026-10-19）：把**项目自己的工作区**传给宿主，否则新会话落在 dsh 进程目录上，
      // 「重建并绑定」之后**仍会被归属门拦下**（项目 workspacePath ≠ 进程 cwd 时必现，见轮次记录 §十）。
      // 2026-10-23 用户命名约束（口径 2）：项目主会话统一「【项目】+ 项目名称」；
      // 本次是**重建**（此前已有指针）⇒ 名称后跟备注「重建」（口径 2 后半）。
      // FR-95 补口（2026-10-26）：名字算一次、回包带上（`sessionName`），见下方同名注释。
      const mainSessionName = projectMainSessionTitle(project.name, { note: project.initialSessionId ? "重建" : null });
      const created = await port.createSession({
        cwd: project.workspacePath ?? undefined,
        title: mainSessionName,
      });
      const sessionId = created?.sessionId ?? null;
      if (!sessionId) throw new TbError("SESSION_CREATE_FAILED", "宿主未能创建会话", { reason: created?.reason ?? null });
      // FR-84 补口（2026-10-23）· **建完必须验工作区**：宿主若忽略 `cwd`（或本 DSH 实例的工作区与项目不一致），
      // 新会话会落在**进程目录**上 —— 此时若照旧写回指针，用户会得到「重建了还是说工作区不对」的**静默错绑**。
      // 现在改成**如实失败**：报出两个路径、不改写主会话指针（新会话留在磁盘上，不删除、不引用）。
      const createdOrigin = await sessionOriginOf(sessionId, project);
      if (createdOrigin.mismatch === true) {
        throw new TbError(
          "SESSION_WORKSPACE_MISMATCH",
          `新建的会话落在 ${createdOrigin.cwd}，而本项目工作区是 ${project.workspacePath} → 宿主未按工作区建会话（当前 DSH 实例的工作区与该项目不一致）。**主会话指针未被改写**。请改用「改绑到本工作区已有会话」；或在 ${project.workspacePath} 下另起一个 DSH 实例再来接续。`,
          { sessionId, cwd: createdOrigin.cwd, workspacePath: project.workspacePath, projectId: project.id },
        );
      }
      const rb = store.rebindInitialSession(project.id, sessionId);
      let openingDelivered = false; let deliveryReason = null;
      if (typeof port.sendPrompt === "function") {
        try { const r = await port.sendPrompt(sessionId, buildOpeningPrompt(rb.project)); openingDelivered = Boolean(r?.sent); deliveryReason = r?.reason ?? null; }
        catch (error) { deliveryReason = error?.code ?? String(error?.message ?? error); }
      }
      const auditId = store.recordAudit({ actor: "board", action: "rebind-initial-session", target: project.id, allowed: true, reason: "rebind", detail: JSON.stringify({ before: rb.before, after: rb.after, openingDelivered, deliveryReason, titleApplied: created?.titleApplied ?? null, titleReason: created?.titleReason ?? null }) });
      emit("project.updated", { projectId: project.id, initialSessionId: rb.after });
      return { status: 200, payload: { rebound: true, mode: "create", projectId: project.id, before: rb.before, after: rb.after, openingDelivered, deliveryReason, titleApplied: created?.titleApplied ?? null, titleReason: created?.titleReason ?? null, sessionName: mainSessionName, auditId } };
    }
    // FR-84 补口（2026-10-23）· **任务级接续会话改指**。
    // 病根：任务级 `session_id` 指向别的工作区（实测 `cwd="/"`）时，抽屉会一直报归属门，
    // 而既有动作只有「重建并绑定项目主会话」——它只改**项目**指针，**改不动任务级引用** ⇒ 修不好。
    // 本端点把这张任务的接续会话改指到**项目主会话**（或显式给出的会话），并且**先验工作区**：
    // 目标会话归属不对就如实拒绝（不制造第二个错绑）。只改任务引用，不碰状态/认领锁。
    const taskSessionRebindRoute = /^\/api\/tasks\/([^/]+)\/session\/rebind$/.exec(pathname);
    if (taskSessionRebindRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "session/rebind 仅支持 POST");
      const task = store.requireTaskRef(decodeURIComponent(taskSessionRebindRoute[1]));
      const confirmed = body.confirm === true || searchParams.get("confirm") === "1";
      if (!confirmed) return { status: 200, payload: { rebound: false, reason: "confirm-required", identifier: task.identifier, current: task.sessionId ?? null } };
      const project = store.getProject(task.projectId) ?? null;
      const target = body.sessionId ?? searchParams.get("session") ?? project?.initialSessionId ?? null;
      if (!target) {
        throw new TbError("NO_PROJECT_MAIN_SESSION", "该项目还没有主会话可改指：请先「重建并绑定项目主会话」", { identifier: task.identifier, projectId: task.projectId });
      }
      const port = store.hostSessionPort;
      if (port && typeof port.sessionExists === "function") {
        const existsRes = await port.sessionExists(target);
        if (existsRes?.exists === false) throw new TbError("SESSION_NOT_FOUND", "目标会话在本机不存在：不能改指", { sessionId: target });
      }
      const origin = await sessionOriginOf(target, project);
      if (origin.mismatch === true) {
        throw new TbError(
          "SESSION_OTHER_WORKSPACE",
          `目标会话属于另一个工作区：${origin.cwd}（本项目工作区 ${project?.workspacePath ?? "未知"}）→ 拒绝改指；请先「重建并绑定项目主会话」，或选一个本项目工作区内的会话`,
          { sessionId: target, cwd: origin.cwd, workspacePath: project?.workspacePath ?? null },
        );
      }
      const rb = store.rebindTaskSession(task.identifier, target);
      const auditId = store.recordAudit({
        actor: body.actor ?? "board", action: "rebind-task-session", target: rb.task.identifier, allowed: true,
        reason: "project-main", detail: JSON.stringify({ before: rb.before, after: rb.after, cwd: origin.cwd, changed: rb.changed }),
      });
      store.recordTaskEvent(rb.task.id, { type: "session_rebound", actor: body.actor ?? "board", detail: `${rb.before ?? "（空）"} → ${rb.after}` });
      emit("task.updated", { identifier: rb.task.identifier, sessionId: rb.after });
      return { status: 200, payload: { rebound: true, identifier: rb.task.identifier, before: rb.before, after: rb.after, changed: rb.changed, origin, auditId } };
    }
        const projectSessionActionRoute = /^\/api\/projects\/([^/]+)\/sessions\/(request|approve)$/.exec(pathname);
    if (projectSessionActionRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "sessions 动作仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectSessionActionRoute[1]));
      const sessionId = body.sessionId ?? searchParams.get("session");
      const result = projectSessionActionRoute[2] === "request"
        ? store.requestSessionAssociation(project.id, sessionId)
        : store.approveSessionAssociation(project.id, sessionId);
      return { status: 200, payload: result };
    }
    if (pathname === "/api/tasks") {
      if (method === "GET") {
        const tasks = store.listTasks({
          projectId: searchParams.get("project") ?? undefined,
          status: searchParams.get("status") ?? undefined,
          priority: searchParams.get("priority") ?? undefined,
          owner: searchParams.get("owner") ?? undefined,
          labels: searchParams.get("label") ?? undefined,
          // FR-26：会话归属维度（全部 / linked 已关联 / unlinked 未关联），与上面各维度取交集
          sessionScope: searchParams.get("sessionScope") ?? undefined,
          // FR-14：关键词搜索（编号 / 标题 / 描述 / 标签），与上面各维度取交集。
          // `q` 为空串 ⇒ undefined ⇒ 不搜索（清空关键词即恢复全量）；缺失同理。
          q: searchParams.get("q") || undefined,
          // FR-15：默认档＝「默认顺序」（人工拖拽 / 创建顺序），`sort=priority` 才是优先级档。
          // 此前这里缺省写死 `priority`，导致**看板永远按优先级排**、FR-11 的列内手工顺序再持久化也看不见
          // （前端从不带 `sort`）—— 两档口径与 FR-15 条款相反。缺省改回默认档，与 `cli/tb.mjs` 的
          // `options.sort ?? "created"` 同口径；显式 `sort=priority` 的调用方行为一字不变。
          sort: searchParams.get("sort") ?? "created",
        });
        // FR-75/76：按需附带"执行看护"状态（停滞 / 待决策），供看板卡片标记使用。
        if (searchParams.get("withWatchdog") === "1") {
          // FR-79：卡片只带诊断**摘要**（{count, kinds, highestSeverity}），完整列表走 /diagnostics。
          const decorated = tasks.map((t) => {
            const patch = {};
            if (t.status === "in_progress") patch.watchdog = assessTaskRef(store, t.identifier);
            if (t.status === "in_progress" || t.status === "blocked" || t.status === "in_review" || t.triageAt) {
              patch.diagnostics = evaluateTaskDiagnostics(store, t).summary;
            }
            return Object.keys(patch).length ? { ...t, ...patch } : t;
          });
          return { status: 200, payload: { tasks: decorated, count: decorated.length } };
        }
        return { status: 200, payload: { tasks, count: tasks.length } };
      }
      if (method === "POST") {
        const task = store.createTask({
          projectId: body.projectId,
          title: body.title,
          description: body.description,
          // FR-94：添加任务时即记录「完成验收标准 + 复核动作」（真机反馈：便于快速复核）
          acceptance: body.acceptance,
          verifyCommand: body.verifyCommand,
          status: body.status,
          priority: body.priority,
          labels: body.labels ?? [],
          owner: body.owner,
          // P0：归因在**建卡事务内**完成。旧口径是「先建卡、再 POST /attribution」两步 ——
          // 中间任何失败都留一张无归因卡（2026-10-28 修 69 张，其中 56 张来源已不可考）。
          requirementId: body.requirementId ?? body.requirement,
          unattributedReason: body.unattributedReason,
          // P1.5：契约校验在**内核**（store）里做，门面只负责把调用方的契约原样带下去。
          contract: body.contract,
        });
        // 未归因时必须**可见**：返回体带 `attribution.warning`（CLI 侧走 stderr，Web 侧画黄条）。
        // 不写成错误是因为严格拒绝要等 P3（见 store.mjs 的 strictAttribution 注释）。
        const attribution = task.requirementId
          ? { attributed: true, requirementId: task.requirementId, warning: null }
          : {
              attributed: false,
              requirementId: null,
              warning:
                "该任务未归属需求条目：启动执行/派发团队会被归因门拒绝（EXECUTION_NOT_ATTRIBUTED）。补归因：POST /api/tasks/<ref>/attribution，或建卡时带 requirement；确实不需要归属请带 unattributedReason。",
            };
        return { status: 201, payload: { task, attribution } };
      }
      throw new TbError("USAGE_ERROR", "/api/tasks 仅支持 GET 或 POST");
    }

    // 会话存活（FR-84）：打开会话/接续前的探活；`exists:null` = 判不准（不得当作失效）。
    const sessionStateRoute = /^\/api\/sessions\/([^/]+)\/state$/.exec(pathname);
    if (sessionStateRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "sessions state 仅支持 GET");
      return { status: 200, payload: await sessionStateOf(decodeURIComponent(sessionStateRoute[1])) };
    }

    const taskRoute = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
    if (taskRoute) {
      let ref;
      try {
        ref = decodeURIComponent(taskRoute[1]);
      } catch {
        throw new TbError("INVALID_ID", "任务引用包含非法编码");
      }
      if (method === "GET") {
        const task = store.requireTaskRef(ref);
        // FR-90：详情里直接带上「评审证据包」（自动复核结论 + 最近一条进展评论），
        // 评审人打开抽屉即可看到机器结论，而不是只看到两个按钮。
        const comments = store.listComments(task.id);
        return { status: 200, payload: { task, comments, reviewEvidence: buildReviewEvidence({ comments }) } };
      }
      if (method === "PATCH") {
        const task = store.updateTask(ref, {
          expectedVersion: body.version ?? body.expectedVersion,
          contract: body.contract,
          title: body.title,
          description: body.description,
          acceptance: body.acceptance,
          verifyCommand: body.verifyCommand,
          status: body.status,
          priority: body.priority,
          labels: body.labels,
          owner: body.owner,
          // FR-11：拖拽落点。三形态：`{before: <编号>}` 锚点（前端用，筛选下唯一正确）、整数下标、`null` = 列尾。
          // **走同一条 PATCH**：评审门 / 授权门 / 归因门 / 人工校验门 / 治理门都在 store.updateTask 里，
          // 拖拽因此与「上一列 / 下一列」按钮**完全同门**，不存在任何旁路。
          // 与筛选共存口径：`boardPosition` 只定**持久顺序**，不因筛选改变；筛选只影响此刻可见集，
          // 前端把落点按"可见邻居"折成锚点提交 ⇒ 隐藏卡在整列里的相对位置不受影响（详见 store.resolveBoardOrder）。
          boardPosition: body.boardPosition,
          // FR-83 补口（卡 `-162`）：**显式跳过评审**的逃生口。只有前端在人确认「将跳过评审」时才带 true；
          // 漏带/带字符串一律按"没批准"处理（store 侧严格 `=== true`）⇒ 拖拽/脚本的静默收口必然被拒。
          skipReview: body.skipReview,
        });
        return { status: 200, payload: { task } };
      }
      if (method === "DELETE") {
        const versionParam = searchParams.get("version");
        const expectedVersion = versionParam !== null ? Number(versionParam) : body.version ?? body.expectedVersion;
        const deleted = store.deleteTask(ref, { expectedVersion });
        return { status: 200, payload: { deleted } };
      }
      throw new TbError("USAGE_ERROR", `任务路由不支持 ${method}`);
    }


    // ---- 需求文档（FR-34） ----
    if (pathname === "/api/requirements/docs") {
      if (method === "GET") {
        const docs = store.listRequirementDocs({ projectId: searchParams.get("project") ?? undefined });
        return { status: 200, payload: { docs, count: docs.length } };
      }
      if (method === "POST") {
        const existed = store.getRequirementDoc(body.projectId) ?? null;
        const doc = existed ?? store.ensureRequirementDoc(body.projectId, { body: body.body ?? "" });
        // FR-91 修复（真机已发生的数据损坏）：对**已存在**的文档，只有显式传**非空** body 才覆盖。
        // 此前 UI 的「新建文档」会带 `body: ""`，而 `body.body !== undefined` ⇒ 走 update ⇒ **把已有正文清空**
        // （本项目需求文档正是这样被清成 0 字节、版本却涨到 v7 的）。幂等即可，不拿空串当"编辑"。
        const shouldWrite = typeof body.body === "string" && body.body !== "" && body.body !== doc.body;
        const updated = shouldWrite ? store.updateRequirementDoc(doc.id, { expectedVersion: doc.version, body: body.body }) : doc;
        return { status: 201, payload: { doc: updated, existed: Boolean(existed), wrote: shouldWrite } };
      }
      throw new TbError("USAGE_ERROR", "/api/requirements/docs 仅支持 GET 或 POST");
    }
    const reqDocRoute = /^\/api\/requirements\/docs\/([^/]+)$/.exec(pathname);
    if (reqDocRoute) {
      const ref = decodeURIComponent(reqDocRoute[1]);
      if (method === "GET") {
        const doc = store.getRequirementDocById(ref) ?? store.getRequirementDoc(ref);
        if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${ref}`, { ref });
        return { status: 200, payload: { doc, items: store.listRequirementItems({ docId: doc.id }) } };
      }
      if (method === "PATCH") {
        const doc = store.updateRequirementDoc(ref, { expectedVersion: body.version ?? body.expectedVersion, body: body.body });
        return { status: 200, payload: { doc } };
      }
      throw new TbError("USAGE_ERROR", `需求文档路由不支持 ${method}`);
    }
    const reqElaborateRoute = /^\/api\/requirements\/docs\/([^/]+)\/elaborate$/.exec(pathname);
    if (reqElaborateRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "elaborate 仅支持 POST");
      const ref = decodeURIComponent(reqElaborateRoute[1]);
      const doc = store.getRequirementDocById(ref) ?? store.getRequirementDoc(ref);
      if (!doc) throw new TbError("REQUIREMENT_DOC_NOT_FOUND", `需求文档不存在：${ref}`, { ref });
      // ── 条目化契约（卡 `-169` P4② · 2026-10-29 口径变更） ───────────────────────
      // 旧口径（已废）：`auto` 在 AI 不可用时**静默跑规则并落库**，只加一个 `degraded:true` 标注。
      //   真机后果：一份「资料索引」文档一次落 100 条 pending 候选，其中 0 条真需求。
      // 新口径：
      //   · `mode:"auto"` ≈ **只用 AI**；AI 不可用/失败 ⇒ **拒绝**（`AI_UNAVAILABLE`，**零落库**）；
      //   · 要规则降级必须**显式** `fallback:"rule"`（旧行为整体退到这条分支，语义不变）；
      //   · `mode:"rule"` 支持 `dryRun:true` ⇒ 只回预览、零落库（规则模式不再「一点就写」）；
      //   · `limit` 从 body 透传，默认 20、硬顶 200（旧默认 100 且 body 不生效）。
      const mode = body.mode ?? "auto";
      if (mode !== "auto" && mode !== "ai" && mode !== "rule") {
        throw new TbError("USAGE_ERROR", `elaborate mode 必须是 auto/ai/rule，收到：${mode}`);
      }
      const fallback = body.fallback;
      if (fallback !== undefined && fallback !== "rule") {
        throw new TbError("USAGE_ERROR", `elaborate fallback 只能是 rule（显式规则降级），收到：${fallback}`);
      }
      const dryRun = body.dryRun === true;
      if (dryRun && mode !== "rule") {
        throw new TbError("USAGE_ERROR", `dryRun 仅适用于 mode:"rule"（AI 产出量由模型决定，没有"预演"意义），收到 mode:${mode}`);
      }
      const limit = clampElaborateLimit(body.limit);
      const runRule = () => ({ ...store.elaborateRequirementDoc(doc.id, { limit, dryRun }), mode: "rule" });
      const runAi = async () => {
        if (typeof aiElaborator !== "function") {
          throw new TbError("AI_UNAVAILABLE", `AI 条目化不可用（当前环境未提供 LLM 直连）：改传 mode:"rule" 或 {mode:"auto",fallback:"rule"} 走规则拆解；规则模式 limit 默认 20 条`);
        }
        let candidates;
        try {
          candidates = await aiElaborator(doc);
        } catch (error) {
          // AI 自己的失败也统一成可判定的错误码，不再被"降级"吞掉（除非人显式要 fallback）
          if (error instanceof TbError) throw error;
          // 上游已带机器可读 code（如 `AI_OUTPUT_INVALID`）时**保留它** —— 排障要能区分
          // 「没有 AI」与「AI 回了没法解析的东西」；压成同一个码等于丢掉线索。
          const code = typeof error?.code === "string" && error.code ? error.code : "AI_UNAVAILABLE";
          throw new TbError(code, `AI 条目化失败：${error?.message ?? error}（本次未落库）`);
        }
        return { ...store.addRequirementCandidates(doc.id, candidates, { source: "elaborated-ai" }), mode: "ai" };
      };
      if (mode === "rule") return { status: dryRun ? 200 : 201, payload: runRule() };
      if (mode === "ai") return { status: 201, payload: await runAi() };
      // mode === "auto"
      if (fallback !== "rule") return { status: 201, payload: await runAi() };
      // 显式 fallback:"rule" ⇒ 保留旧行为：先试 AI，失败则规则降级并标注 degraded
      if (typeof aiElaborator === "function") {
        try { return { status: 201, payload: await runAi() }; }
        catch (error) {
          return { status: 201, payload: { ...runRule(), degraded: true, aiError: error?.code ?? String(error?.message ?? error) } };
        }
      }
      return { status: 201, payload: { ...runRule(), degraded: true, aiError: "AI_UNAVAILABLE" } };
    }

    // ---- 需求条目（FR-35） ----
    if (pathname === "/api/requirements/items") {
      if (method === "GET") {
        const items = store.listRequirementItems({
          projectId: searchParams.get("project") ?? undefined,
          docId: searchParams.get("doc") ?? undefined,
          status: searchParams.get("status") ?? undefined,
        });
        return { status: 200, payload: { items, count: items.length } };
      }
      if (method === "POST") {
        const item = store.createRequirementItem({
          projectId: body.projectId, title: body.title, description: body.description,
          acceptance: body.acceptance, priority: body.priority, docId: body.docId,
          contract: body.contract,
        });
        // 卡 `-177`（口径 X）：人工建条目缺省验收 ⇒ **显式缺口**（回包 `acceptanceSet:false` + `governance_audit`）。
        // 此前只回 `{ item }`，「没给验收」与「给了空串」在调用方眼里都是 201 成功 —— 与 MCP 侧同一个沉默。
        const acc = markAcceptance(store, {
          identifier: item.identifier, acceptance: item.acceptance,
          actor: body.actor ?? "human", entry: "http:POST /api/requirements/items",
        });
        return { status: 201, payload: { item, acceptanceSet: acc.acceptanceSet } };
      }
      throw new TbError("USAGE_ERROR", "/api/requirements/items 仅支持 GET 或 POST");
    }
    const reqItemRoute = /^\/api\/requirements\/items\/([^/]+)$/.exec(pathname);
    if (reqItemRoute) {
      const ref = decodeURIComponent(reqItemRoute[1]);
      if (method === "GET") {
        // FR-91：详情必须带上**关联任务的完成情况**（真机反馈「展示关联需求的任务完成列表情况，以供
        // 自动/人工评审需求是否完成」）。`completion` 只读、不改状态；终态仍由人点。
        const item = store.requireRequirementItemRef(ref);
        return { status: 200, payload: { item, completion: store.requirementCompletion(item.id) } };
      }
      if (method === "PATCH") {
        const item = store.updateRequirementItem(ref, {
          status: body.status, title: body.title, description: body.description,
          acceptance: body.acceptance, priority: body.priority, docId: body.docId,
          contract: body.contract,
        });
        // 卡 `-177`：与 MCP 同一边界 —— `acceptanceSet` 永远反映写入后状态；
        // **只有本次 body 真带 `acceptance` 才落审计**（否则 99/129 空验收条目每改一次标题就添一行审计）。
        // 需求终态（done/closed）落审计：谁在什么时候把哪条需求收口的（自动只给建议，终态由人定）。
        if (body.status === "done" || body.status === "closed" || item.status === "done" || item.status === "closed") {
          try { store.recordAudit({ actor: body.actor ?? "human", action: "requirement-status", target: item.identifier, allowed: true, reason: String(body.status ?? item.status), detail: body.reason ?? null }); } catch { /* ignore */ }
        }
        const acc = body.acceptance !== undefined
          ? markAcceptance(store, {
            identifier: item.identifier, acceptance: item.acceptance,
            actor: body.actor ?? "human", entry: "http:PATCH /api/requirements/items/:ref",
            detail: { changed: Object.keys(body).filter((k) => k !== "actor") },
          })
          : acceptanceFlag(item.acceptance);
        return { status: 200, payload: { item, acceptanceSet: acc.acceptanceSet } };
      }
      if (method === "DELETE") {
        return { status: 200, payload: store.deleteRequirementItem(ref) };
      }
      throw new TbError("USAGE_ERROR", `需求条目路由不支持 ${method}`);
    }
    const reqFeasibilityRoute = /^\/api\/requirements\/items\/([^/]+)\/feasibility$/.exec(pathname);
    if (reqFeasibilityRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "feasibility 仅支持 POST");
      const ref = decodeURIComponent(reqFeasibilityRoute[1]);
      const item = store.setRequirementFeasibility(ref, { verdict: body.verdict, reason: body.reason, by: body.by, override: body.override });
      return { status: 200, payload: { item } };
    }
    const reqSplitRoute = /^\/api\/requirements\/items\/([^/]+)\/split$/.exec(pathname);
    if (reqSplitRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "split 仅支持 POST");
      const ref = decodeURIComponent(reqSplitRoute[1]);
      // B-3：可行性门——不可行条目不得分拆
      const item = store.requireRequirementItemRef(ref);
      if (item.feasibility === "infeasible") throw new TbError("FEASIBILITY_INFEASIBLE", "条目标记为不可行，不得分拆技术任务", { ref });
      const result = store.splitRequirement(ref, { tasks: body.tasks });
      return { status: 201, payload: result };
    }
    // 2026-10-28 真机批注：「生成看板任务（分拆）」此前**只有人工 textarea**，没有"自动生成"也没有修订回路。
    // 人拍口径 = **方案 C：走项目主会话** —— 不新增第二条 LLM 通道，把「先出草稿」交给项目主会话里的 agent
    // （它本就有仓库上下文与 `taskboard_*` 工具）。本端点**只投递一条指令**：
    // **不建卡、不改条目状态、不写评论**，唯一落盘是治理审计（`requirement-split-ask`）。
    // 因此它可以安全地反复点（"按意见重生成"＝再投一次，带上上一版草稿与意见）。
    const reqSplitAskRoute = /^\/api\/requirements\/items\/([^/]+)\/split-ask$/.exec(pathname);
    if (reqSplitAskRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "split-ask 仅支持 POST");
      const item = store.requireRequirementItemRef(decodeURIComponent(reqSplitAskRoute[1]));
      // 与 split 同门：不可行条目连草稿都不出（避免"先拆一堆再告诉你不可行"）。
      if (item.feasibility === "infeasible") throw new TbError("FEASIBILITY_INFEASIBLE", "条目标记为不可行，不得分拆技术任务", { ref: item.identifier });
      const project = store.requireProject(item.projectId);
      // 会话解析**复用** diagnostics 的三级回落（任务级 → 项目主会话 → 已绑定会话），
      // 条目没有任务级会话，故传 sessionId:null 走后两级。
      const resolved = resolveSessionRef(store, { projectId: item.projectId, sessionId: null });
      const sid = resolved.sessionId ?? null;
      if (!sid) {
        return { status: 200, payload: { delivered: false, sessionId: null, source: null, reason: "no-session", nextAction: "先在项目里重建并绑定主会话" } };
      }
      const liveness = await sessionStateOf(sid);
      if (liveness.exists === false) {
        return { status: 200, payload: { delivered: false, sessionId: sid, source: resolved.source, reason: "session-gone", stale: true, liveness, nextAction: "重建并绑定项目主会话" } };
      }
      const prompt = buildSplitAskPrompt({
        item, project,
        feedback: body?.feedback ?? null,
        previous: Array.isArray(body?.previous) ? body.previous : null,
        maxTasks: body?.maxTasks,
      });
      // 能力判定放在**构建之后**：`host-unavailable` 不是"这个请求有问题"，而是"这个实例没有宿主"——
      // 此时把 prompt 一并回带，人至少能自己粘到会话里（真机 2026-10-29：`:47830` 独立进程上
      // 只会得到一句「未能投递：host-unavailable · 检查宿主会话通道后重试」，而重试永远不会成立）。
      const port = store.hostSessionPort;
      if (!port || typeof port.sendPrompt !== "function") {
        return { status: 200, payload: { delivered: false, sessionId: sid, source: resolved.source, reason: "host-unavailable", hostCapabilities: null, nextAction: HOST_UNAVAILABLE_NEXT, prompt } };
      }
      let result = null;
      try { result = await port.sendPrompt(sid, prompt); }
      catch (error) {
        const reason = error?.code ?? String(error?.message ?? error);
        try { store.recordAudit({ actor: "board", action: "requirement-split-ask", target: item.identifier, allowed: false, reason, detail: `投递失败 session=${sid}` }); } catch { /* ignore */ }
        return { status: 200, payload: { delivered: false, sessionId: sid, source: resolved.source, reason, nextAction: "查看主会话状态后重试" } };
      }
      const delivered = Boolean(result?.sent ?? result?.delivered ?? false);
      const reason2 = result?.reason ?? null;
      try {
        store.recordAudit({ actor: "board", action: "requirement-split-ask", target: item.identifier, allowed: true, reason: reason2 ?? "delivered", detail: `session=${sid} source=${resolved.source ?? "null"} feedback=${body?.feedback ? "yes" : "no"} previous=${Array.isArray(body?.previous) ? body.previous.length : 0}` });
      } catch { /* ignore */ }
      return { status: 200, payload: { delivered, sessionId: sid, source: resolved.source, reason: reason2, stale: false, liveness, prompt } };
    }

    const reqGraphRoute = /^\/api\/requirements\/items\/([^/]+)\/graph$/.exec(pathname);
    if (reqGraphRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "graph 仅支持 GET");
      return { status: 200, payload: store.requirementTaskGraph(decodeURIComponent(reqGraphRoute[1])) };
    }
    // FR-91：只读的「需求完成度」端点（关联任务清单 + 汇总结论），供自动/人工评审复用。
    const reqCompletionRoute = /^\/api\/requirements\/items\/([^/]+)\/completion$/.exec(pathname);
    if (reqCompletionRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "completion 仅支持 GET");
      return { status: 200, payload: store.requirementCompletion(decodeURIComponent(reqCompletionRoute[1])) };
    }

    // ---- 条目化候选（FR-36） ----
    if (pathname === "/api/requirements/candidates") {
      if (method === "DELETE") {
        const ids = Array.isArray(body.ids) ? body.ids : null;
        const removed = store.deleteRequirementCandidates({ ids, docId: body.docId ?? searchParams.get("doc") ?? undefined, status: body.status ?? searchParams.get("status") ?? undefined });
        return { status: 200, payload: removed };
      }
      if (method !== "GET") throw new TbError("USAGE_ERROR", "candidates 仅支持 GET 或 DELETE");
      const candidates = store.listRequirementCandidates({ docId: searchParams.get("doc") ?? undefined, status: searchParams.get("status") ?? undefined });
      return { status: 200, payload: { candidates, count: candidates.length } };
    }
    if (pathname === "/api/requirements/candidates/confirm") {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "confirm 仅支持 POST");
      return { status: 201, payload: store.confirmRequirementCandidates(body.ids) };
    }
    if (pathname === "/api/requirements/candidates/reject") {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "reject 仅支持 POST");
      return { status: 200, payload: store.rejectRequirementCandidates(body.ids) };
    }

    // ---- 任务依赖（FR-39） ----
    // ---- 执行（FR-40 启动 / FR-41 跟踪与失败） ----
    /* FR-40 补口（2026-10-19 真机）：**归因的写入口**。
       归因门（store.assertAttributed）只拦「启动执行 / 派发团队」，不该拦「把任务归回需求条目」本身 ——
       但此前全链路**没有任何**归因写入口：真机上点「启动执行」只得到「请先关联需求条目（归因门）」，
       而任务编辑对话框没有需求条目字段、也没有对应端点，用户无处可点（真机报障）。
       这里补一个最小写入口：把一条已存在的任务关联到需求条目；跨项目由 store 层拒绝。 */
    const taskAttributionRoute = /^\/api\/tasks\/([^/]+)\/attribution$/.exec(pathname);
    if (taskAttributionRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "attribution 仅支持 POST");
      const ref = decodeURIComponent(taskAttributionRoute[1]);
      const requirement = body.requirement ?? body.requirementId ?? null;
      if (!requirement) throw new TbError("USAGE_ERROR", "attribution 需要 requirement（需求条目 identifier 或 id）");
      const task = store.associateRequirementTask(requirement, ref);
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      return { status: 200, payload: { task, requirement: requirement } };
    }
    const taskExecRoute = /^\/api\/tasks\/([^/]+)\/execute$/.exec(pathname);
    if (taskExecRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "execute 仅支持 POST");
      const ref = decodeURIComponent(taskExecRoute[1]);
      // 防重复下发：已有执行会话仍在执行且未返回结论 → 409 + 明确提醒（不新建/不覆盖）。
      const execTask = store.requireTaskRef(ref);
      const execInflight = inflightOf(execTask);
      if (execInflight) throw inflightError(execTask, execInflight);
      // FR-78：失败熔断 / 配额鉴权 / 近期成功窗口 → 不自动重试（人工可先「重置失败计数」）
      const execGuard = store.dispatchGuard(execTask);
      if (execGuard) {
        throw new TbError("EXECUTION_CIRCUIT_OPEN", circuitMessage(execGuard, execTask), {
          identifier: execTask.identifier, reason: execGuard,
          failures: execTask.consecutiveFailures, limit: execTask.maxRetries ?? DEFAULT_FAILURE_LIMIT,
          lastFailureError: execTask.lastFailureError ?? null,
        });
      }
      const port = store.hostSessionPort;
      let sessionId = body.sessionId ?? null;
      let presetApplied = null;
      let titleApplied = null;
      let titleReason = null;
      let sessionName = null;
      let reason = null;
      // 真机 2026-10-22（续四十一）：**先过门，再建会话**。
      // 原先顺序是「建会话 + 打开会话（切主视图）→ 再在 startTaskExecution 里判门」，
      // 于是被归因门 / 授权门 / 人工校验门拒绝的点击**照样留下副作用**（多一个空会话 + 视图被切走）。
      // 门序列的唯一来源仍是 store.assertExecutable（startTaskExecution 会再复检一次）。
      store.assertExecutable(ref);
      // 宿主路径：可用则建会话（+尝试预置）并打开；不可用则降级（保留 directive 兜底）。
      if (!sessionId && port?.available) {
        try {
          const preset = `任务 ${execTask.identifier}：${execTask.title}\n操作指引：认领 → 执行 → 提交"待验收"；不得置"完成"（人工确认）。`;
          // 2026-10-23 用户命名约束（口径 1）：任务会话统一「【任务】+ 任务标题 + 时间」。
          // 同时补 `cwd`（本仓旧缺漏）：不传 cwd 时宿主把会话落在**进程目录**（真机取证到 `cwd="/"`），
          // 正是「接续会话跨工作区错乱」的一个来源。
          // FR-95 补口（2026-10-26）：名字算一次、回包带上，前端据此如实显示命名结果。
          sessionName = taskSessionTitle(execTask.title);
          const created = await port.createSession({
            preset,
            cwd: store.getProject(execTask.projectId)?.workspacePath ?? undefined,
            title: sessionName,
          });
          if (created?.sessionId) {
            sessionId = created.sessionId;
            presetApplied = Boolean(created.presetApplied);
            titleApplied = created.titleApplied ?? null;
            titleReason = created.titleReason ?? null;
            await port.openSession(sessionId);
          } else {
            reason = "session-create-failed";
          }
        } catch (error) {
          reason = error?.code ?? String(error?.message ?? error);
        }
      } else if (!sessionId) {
        reason = "host-session-unavailable";
      }
      const result = store.startTaskExecution(ref, { sessionId });
      result.launch.presetApplied = presetApplied;
      result.launch.titleApplied = titleApplied;
      if (titleApplied === false) result.launch.titleReason = titleReason;
      result.launch.sessionName = sessionName;
      if (!sessionId) result.launch.reason = reason ?? "host-session-unavailable";
      emit("task.updated", { taskId: result.task.id, identifier: result.task.identifier, status: result.task.status });
      return { status: 200, payload: result };
    }
    const taskExecGetRoute = /^\/api\/tasks\/([^/]+)\/execution$/.exec(pathname);
    if (taskExecGetRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "execution 仅支持 GET");
      const ref = decodeURIComponent(taskExecGetRoute[1]);
      // FR-75/76：附带执行看护评估（停滞 / 待决策 / 执行中）+ 可跟进的"下一步建议"。
      // FR-77：附带认领/心跳状态（在途判定的一等公民）。
      // FR-79：附带完整诊断列表（详情抽屉一次请求取回）。
      const diag = evaluateTaskDiagnostics(store, ref);
      // FR-82：附带尝试记录（按尝试看每次的结论与证据）
      // FR-84：附带**会话引用解析结果**（三级回落 + 存活三态），前端据此渲染接续徽标、
      //        并把「打开执行会话」换成「重建并绑定项目主会话」（无引用时）。
      const proj = store.getProject(diag.task.projectId) ?? null;
      const sref = resolveSessionRef(store, diag.task);
      const sessionRef = {
        ...sref,
        liveness: sref.sessionId ? await sessionStateOf(sref.sessionId) : null,
        origin: sref.sessionId ? await sessionOriginOf(sref.sessionId, proj) : null,
      };
      // FR-84 补口（2026-10-23）：任务级引用**落在别的工作区**时，单说「请用重建并绑定项目主会话」是**无效指引**
      // ——重建只改项目主会话指针，动不到 `tasks.session_id`。故这里把「项目主会话此刻可不可用、工作区对不对」
      // 一并算好交给前端，让抽屉能给出**真正生效**的那一个动作。
      if (sessionRef.origin?.mismatch === true) {
        const mainId = proj?.initialSessionId ?? null;
        sessionRef.projectMain = mainId
          ? { sessionId: mainId, liveness: await sessionStateOf(mainId), origin: await sessionOriginOf(mainId, proj) }
          : null;
      }
      return { status: 200, payload: { ...store.getTaskExecution(ref), claim: store.taskClaimState(ref), watchdog: assessTaskRef(store, ref), diagnostics: diag.diagnostics, diagnosticSummary: diag.summary, runs: store.listTaskRuns(ref), sessionRef } };
    }
    // FR-82：尝试记录（每次认领执行一条：状态/结果/摘要/错误/起止/心跳/运行时上限）
    const taskRunsRoute = /^\/api\/tasks\/([^/]+)\/runs$/.exec(pathname);
    if (taskRunsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "runs 仅支持 GET");
      const task = store.requireTaskRef(decodeURIComponent(taskRunsRoute[1]));
      const runs = store.listTaskRuns(task);
      return { status: 200, payload: { identifier: task.identifier, count: runs.length, currentRun: store.getCurrentRun(task), runs } };
    }
    // FR-82：任务事件流（追加式；`since` = 已见游标，返回增量）
    const taskEventsRoute = /^\/api\/tasks\/([^/]+)\/events$/.exec(pathname);
    if (taskEventsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "events 仅支持 GET");
      const task = store.requireTaskRef(decodeURIComponent(taskEventsRoute[1]));
      const since = Number(searchParams.get("since") ?? 0) || 0;
      const limit = Number(searchParams.get("limit") ?? 200) || 200;
      const order = searchParams.get("order") ?? "desc";
      const events = store.listTaskEvents(task, { since, limit, order });
      return { status: 200, payload: { identifier: task.identifier, since, count: events.length, cursor: events.reduce((acc, e) => Math.max(acc, e.cursor), since), events } };
    }
    // FR-79：单任务诊断（完整列表 + 摘要 + 自动消解记录）
    const taskDiagnosticsRoute = /^\/api\/tasks\/([^/]+)\/diagnostics$/.exec(pathname);
    if (taskDiagnosticsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "diagnostics 仅支持 GET");
      const ref = decodeURIComponent(taskDiagnosticsRoute[1]);
      const task = store.requireTaskRef(ref);
      const r = evaluateTaskDiagnostics(store, task);
      const history = searchParams.get("history") === "1" ? store.listTaskDiagnostics(task, { includeResolved: true }) : undefined;
      return {
        status: 200,
        payload: {
          identifier: task.identifier, title: task.title, status: task.status,
          count: r.diagnostics.length, summary: r.summary, diagnostics: r.diagnostics,
          resolved: r.resolved, ...(history ? { history } : {}),
        },
      };
    }
    // FR-79 / FR-76：人工忽略一条诊断（写忽略留痕 → 规则侧停止产出，直到出现更新的进展）
    const taskDiagnosticDismissRoute = /^\/api\/tasks\/([^/]+)\/diagnostics\/dismiss$/.exec(pathname);
    if (taskDiagnosticDismissRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "diagnostics/dismiss 仅支持 POST");
      const ref = decodeURIComponent(taskDiagnosticDismissRoute[1]);
      const kind = String(body.kind ?? "").trim();
      if (!kind) throw invalidField("kind", "需要提供 kind（诊断类型）");
      if (!DIAGNOSTIC_KINDS.includes(kind)) throw invalidField("kind", `kind 必须是 ${DIAGNOSTIC_KINDS.join(" / ")} 之一`);
      const r = store.dismissTaskDiagnostic(ref, kind, { actor: body.actor ?? "human", note: body.note ?? null });
      const task = store.getTaskById(store.requireTaskRef(ref).id);
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      const after = evaluateTaskDiagnostics(store, task);
      return { status: 200, payload: { ...r, summary: summarizeDiagnostics(after.diagnostics), diagnostics: after.diagnostics } };
    }
    // FR-80：人工兜底队列（同因重复阻断已升级的任务）
    const projectTriageRoute = /^\/api\/projects\/([^/]+)\/triage$/.exec(pathname);
    if (projectTriageRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "triage 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectTriageRoute[1]));
      const tasks = store.listTasks({ projectId: project.id }).filter((t) => t.triageAt || (t.labels || []).includes("triage"));
      return {
        status: 200,
        payload: {
          project: project.id, count: tasks.length,
          tasks: tasks.map((t) => ({ identifier: t.identifier, title: t.title, status: t.status, blockKind: t.blockKind, blockRecurrences: t.blockRecurrences, triageAt: t.triageAt })),
        },
      };
    }
    // FR-78：人工重置失败计数（清熔断）
    const taskResetFailuresRoute = /^\/api\/tasks\/([^/]+)\/reset-failures$/.exec(pathname);
    if (taskResetFailuresRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "reset-failures 仅支持 POST");
      const task = store.resetTaskFailures(decodeURIComponent(taskResetFailuresRoute[1]));
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      return { status: 200, payload: { task, guard: store.dispatchGuard(task) } };
    }
    // FR-77：执行侧心跳（认领续命）
    const taskHeartbeatRoute = /^\/api\/tasks\/([^/]+)\/heartbeat$/.exec(pathname);
    if (taskHeartbeatRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "heartbeat 仅支持 POST");
      const ref = decodeURIComponent(taskHeartbeatRoute[1]);
      const r = store.heartbeatTask(ref, { lock: body.lock ?? null, note: body.note ?? null });
      return { status: r.ok ? 200 : 409, payload: { ...r, claim: store.taskClaimState(ref) } };
    }
    // FR-77：回收失效认领（认领过期 / 心跳陈旧）
    const taskReclaimRoute = /^\/api\/tasks\/([^/]+)\/reclaim$/.exec(pathname);
    if (taskReclaimRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "reclaim 仅支持 POST");
      const ref = decodeURIComponent(taskReclaimRoute[1]);
      const r = store.reclaimStaleClaim(ref);
      if (r.reclaimed) {
        const t = store.getTaskById(store.requireTaskRef(ref).id);
        emit("task.updated", { taskId: t.id, identifier: t.identifier, status: t.status });
      }
      return { status: r.reclaimed ? 200 : 409, payload: r };
    }
    // FR-76：把执行反馈里的"下一步建议"跟进掉（派生为子任务 / 忽略）。
    const taskFollowupRoute = /^\/api\/tasks\/([^/]+)\/followup$/.exec(pathname);
    if (taskFollowupRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "followup 仅支持 POST");
      const ref = decodeURIComponent(taskFollowupRoute[1]);
      const action = String(body.action ?? "derive");
      if (action === "derive") {
        const title = String(body.title ?? "").trim();
        if (!title) throw invalidField("title", "派生为子任务需要提供 title（建议内容）");
        const child = store.deriveSubtask(ref, { title: title.slice(0, 200), actor: body.actor ?? "human" });
        emit("task.updated", { taskId: child.id, identifier: child.identifier, status: child.status });
        return { status: 201, payload: { derived: true, child } };
      }
      if (action === "dismiss") {
        const task = store.requireTaskRef(ref);
        const note = String(body.title ?? "").trim();
        store.addComment(task.id, { body: `已忽略「下一步建议」${note ? `：${note}` : ""}（人工决策：不派生任务）` });
        emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
        return { status: 200, payload: { dismissed: true, identifier: task.identifier } };
      }
      throw invalidField("action", `action 只支持 derive / dismiss（收到 ${action}）`);
    }
    // CLI 执行器（FR-85 前置）：**由看板侧真的调 `cli:*` CLI 干活**（本仓库约定 engineer → cli:claude）。
    // 默认同步等待（人工触发时要拿到证据）；`?async=1` 后台跑；`dryRun` 只回执行计划不真跑。
    const taskExecCliRoute = /^\/api\/tasks\/([^/]+)\/exec-cli$/.exec(pathname);
    if (taskExecCliRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "exec-cli 仅支持 POST");
      const task = store.requireTaskRef(decodeURIComponent(taskExecCliRoute[1]));
      // FR-85b：人工校验任务是升级门，不得交给 CLI 执行器跑掉
      if (isHumanReviewTask(task)) {
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${task.identifier} 是人工校验任务：不得交给 CLI 执行器，请用人工结论入口处置`, { identifier: task.identifier });
      }
      const project = store.getProject(task.projectId);
      const settings = store.getProjectSettings(task.projectId);
      const role = String(body.role ?? "engineer");
      const executor = resolveCliExecutor(settings, { role });
      if (!executor) throw new TbError("NO_CLI_EXECUTOR", `项目 ${task.projectId} 没有可用的 CLI 执行器（teamTemplate.roles[].executor 需为 cli:*，且不在 forbiddenExecutors 中）`);
      const cwd = project?.workspacePath ?? null;
      const plan = {
        executor: executor.id, cli: executor.cli, role: executor.role, cwd,
        args: cliArgsFor({ executorId: executor.id, cwd, settings }),
        prompt: buildTaskPrompt(task, { project, requirementId: task.requirementId ?? null, verifyCommand: settings?.teamTemplate?.engineer?.verifyCommand ?? null }),
      };
      if (body.dryRun === true || searchParams.get("dryRun") === "1") return { status: 200, payload: { ran: false, dryRun: true, plan } };
      const timeoutMs = Number(body.timeoutMs ?? 0) > 0 ? Number(body.timeoutMs) : DEFAULT_TIMEOUT_MS;
      // FR-40 归因门（2026-10-22 · CLI 链路验证台 `tools/bench-cli-chain.mjs` 抓到）：
      // `/exec-cli` 是**第三条真的会干活的执行入口**（另两条＝`/execute` 与 `POST /api/teams` 派发），
      // 此前只判人工校验门 ⇒ 未归因的卡照样被 CLI **真跑**（真 spawn 子进程 + 状态流转到「待验收」），
      // 而归因门只在 `claimForCliExecution` 里被 try/catch 吞成 `outcome.note`（不抛、不阻断）
      // ⇒ 同一类缺口「门判定必须**先于**副作用」在这条路上失效。
      // 口径：只加**归因门**，**不加**完整 `assertExecutable` —— CLI 执行器有意支持非 `todo` 状态
      // （`claimForCliExecution` 的 `direct-handoff`：人工显式点击即授权，backlog/in_review/done 都要如实进
      // 「进行中」），套 `assertExecutable` 会把这条设计挡掉。
      // `dryRun` 保持宽松：只回执行计划、无副作用，预览不该被归因门挡住。
      store.assertAttributed(task.identifier);
      // 真实落盘：先认领并转「进行中」——否则看板只看到 todo / 原状态，且与执行循环之间没有互斥。
      // 口径见 `claimForCliExecution`：todo 走授权门；其它状态（人工显式点击即授权）也**必须如实
      // 进入「进行中」**，否则整个执行期看板显示错误的列（2026-10-18 实测 -73 停在「待办池」14 分钟）。
      const claim = claimForCliExecution(store, task.identifier, { actor: "cli-executor" });
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: store.requireTaskRef(task.identifier).status });
      const fire = () => executeTaskWithCli({ store, task, project, settings, role, timeoutMs }).catch((error) => ({ ran: false, reason: String(error?.message ?? error) }));
      if (body.async === true || searchParams.get("async") === "1") {
        fire();
        emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
        return { status: 202, payload: { ran: true, async: true, executor: executor.id, plan, claim } };
      }
      const r = await fire();
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: store.requireTaskRef(task.identifier).status });
      return {
        status: 200,
        payload: {
          ran: Boolean(r.ran), executor: r.executor?.id ?? executor.id, reason: r.reason ?? null,
          ok: r.result?.ok ?? false, exitCode: r.result?.exitCode ?? null, timedOut: r.result?.timedOut ?? false,
          durationMs: r.result?.durationMs ?? 0, cwd: r.result?.cwd ?? null, files: r.result?.diff?.files ?? [],
          stdout: r.result?.stdout ?? "", stderr: r.result?.stderr ?? "", comment: r.comment ?? null,
          claim,
          status: store.requireTaskRef(task.identifier).status,
        },
      };
    }
    // 打开任务执行会话（人工介入调试/继续）——FR-84：**三级回落 + 打开前探活**。
    // 回落链：任务自身会话 → 项目主会话 → 项目已关联会话（排除 rejected，取最新）。
    // 探活口径：`exists === false`（确认失效）直接失败并标记 stale，**不再尝试打开**；
    //          `exists === null`（判不准）**照旧尝试**，不得当作失效。
    const taskOpenSessionRoute = /^\/api\/tasks\/([^/]+)\/open-session$/.exec(pathname);
    if (taskOpenSessionRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "open-session 仅支持 POST");
      const task = store.requireTaskRef(decodeURIComponent(taskOpenSessionRoute[1]));
      const project = store.getProject(task.projectId) ?? null;
      // FR-97：三级回落（任务会话 → 项目主会话 → 项目已关联会话，排除 rejected）此前**内联**在此，
      // 与 `resolveSessionRef` 同逻辑却各写一份 —— 改口径必然漏改一处。改为**复用共享函数**，
      // `dispatch-main-session` 等新动作因此自动与本路由同口径（不另写第二份解析）。
      const resolved = resolveSessionRef(store, task);
      const sid = resolved.sessionId ?? null;
      const source = resolved.source ?? null;
      if (!sid) return { status: 200, payload: { opened: false, sessionId: null, source: null, reason: "no-session", stale: false } };
      const liveness = await sessionStateOf(sid);
      if (liveness.exists === false) {
        return { status: 200, payload: { opened: false, sessionId: sid, source, reason: "session-gone", stale: true, liveness } };
      }
      // FR-84 补口：**先判归属再打开** —— 该会话属于别的工作区时默认**不静默打开**（打开的是别人的会话）。
      const origin = await sessionOriginOf(sid, project);
      if (origin.mismatch === true && body?.force !== true) {
        return { status: 200, payload: { opened: false, sessionId: sid, source, reason: "session-other-workspace", stale: false, liveness, origin } };
      }
      const port = store.hostSessionPort;
      if (!port || typeof port.openSession !== "function") return { status: 200, payload: { opened: false, sessionId: sid, source, reason: "host-unavailable", hostCapabilities: null, nextAction: HOST_UNAVAILABLE_NEXT, stale: false, liveness, origin } };
      try { const r = await port.openSession(sid); return { status: 200, payload: { opened: Boolean(r?.opened), sessionId: sid, source, reason: r?.reason ?? null, stale: false, liveness, origin } }; }
      catch (error) { return { status: 200, payload: { opened: false, sessionId: sid, source, reason: error?.code ?? String(error?.message ?? error), stale: false, liveness, origin } }; }
    }

    // ── FR-97 · 出口一：交项目主会话执行（调试修复）────────────────────────────────
    // 为「看板内无法规范流转执行」的卡提供一个**能真的往前推**的动作：把带边界红线的调试修复指令
    // 投递给项目主会话。刻意与 `/open-session` 同口径（同一条 resolveSessionRef + 同一套探活），
    // 不另写第二份解析 —— 见上面 open-session 路由里的抽取说明。
    const taskDispatchMainRoute = /^\/api\/tasks\/([^/]+)\/dispatch-main-session$/.exec(pathname);
    if (taskDispatchMainRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "dispatch-main-session 仅支持 POST");
      const task = store.requireTaskRef(decodeURIComponent(taskDispatchMainRoute[1]));
      // 人工校验任务是升级门：结论只能人给，不交给主会话"顺手修掉"。
      if (isHumanReviewTask(task)) {
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${task.identifier} 是人工校验任务：不得派发执行，请用人工结论入口处置`, { identifier: task.identifier });
      }
      const project = store.getProject(task.projectId) ?? null;
      const resolved = resolveSessionRef(store, task);
      const sid = resolved.sessionId ?? null;
      const source = resolved.source ?? null;
      // 三级都解析不到 → 明确告诉人去重建主会话，**不抛 500、不静默、不写空会话标识**。
      if (!sid) {
        return { status: 200, payload: { delivered: false, sessionId: null, source: null, reason: "no-session", nextAction: "重建并绑定项目主会话" } };
      }
      // 探活口径与 open-session 一致：**只有 exists===false 才算失效**（null ＝ 查不到，不当失效）。
      const liveness = await sessionStateOf(sid);
      if (liveness.exists === false) {
        return { status: 200, payload: { delivered: false, sessionId: sid, source, reason: "session-gone", nextAction: "重建并绑定项目主会话", stale: true, liveness } };
      }
      const prompt = buildDebugDispatchPrompt({
        task,
        project,
        note: body?.note ?? null,
        nextStep: body?.nextStep ?? null,
      });
      const port = store.hostSessionPort;
      if (!port || typeof port.sendPrompt !== "function") {
        return { status: 200, payload: { delivered: false, sessionId: sid, source, reason: "host-unavailable", hostCapabilities: null, nextAction: HOST_UNAVAILABLE_NEXT, prompt } };
      }
      let result = null;
      try { result = await port.sendPrompt(sid, prompt); }
      catch (error) {
        const reason = error?.code ?? String(error?.message ?? error);
        try { store.recordAudit({ actor: "board", action: "debug-dispatch-main-session", target: task.identifier, allowed: true, reason, detail: `投递失败：${reason}` }); } catch { /* ignore */ }
        return { status: 200, payload: { delivered: false, sessionId: sid, source, reason, nextAction: "查看主会话状态后重试" } };
      }
      const delivered = Boolean(result?.sent ?? result?.delivered ?? false);
      const reason2 = result?.reason ?? null;
      // 投递成功 ⇒ 卡进「进行中」（执行侧可写 in_progress，红线只禁 done）。
      // 用 `updateTask`（带 expectedVersion 的乐观锁）而不是直接改库：并发下不覆盖他人的改动。
      let updated = store.requireTaskRef(task.identifier);
      if (delivered) {
        updated = store.updateTask(task.identifier, { expectedVersion: updated.version, status: "in_progress", actor: "agent" });
        store.claimTask(task.identifier, { sessionId: sid, sourceStatus: updated.status });
        store.addComment(task.identifier, { body: `已交项目主会话执行（调试修复）\n- 会话：${sid}（来源 ${source ?? "未知"}）\n- 投递：${delivered ? "成功" : "失败"}${reason2 ? `（${reason2}）` : ""}\n- 指令摘要：调试修复 ${task.identifier}「${task.title}」——修复看板卡无法规范流转的问题；边界红线与回报格式见指令正文。` });
        try { store.recordAudit({ actor: "board", action: "debug-dispatch-main-session", target: task.identifier, allowed: true, reason: reason2 ?? "delivered", detail: `session=${sid} source=${source ?? "null"}` }); } catch { /* ignore */ }
        emit("task.updated", { taskId: updated.id, identifier: updated.identifier, status: updated.status });
      }
      return { status: 200, payload: { delivered, sessionId: sid, source, reason: reason2, stale: false, liveness, prompt } };
    }

    // ── FR-97 · 出口二：转为执行调试 ───────────────────────────────────────────────
    // 给人接手的**显式标记**：加 `执行调试` 标签（幂等去重）并回「待办」，便于集中筛出来处理。
    // 不加表、不加列 —— 用 labels / 评论 / 事件承载（本卡口径）。
    const taskToDebugRoute = /^\/api\/tasks\/([^/]+)\/to-debug$/.exec(pathname);
    if (taskToDebugRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "to-debug 仅支持 POST");
      const ref = decodeURIComponent(taskToDebugRoute[1]);
      const task = store.requireTaskRef(ref);
      if (isHumanReviewTask(task)) {
        throw new TbError("HUMAN_REVIEW_NOT_EXECUTABLE", `任务 ${task.identifier} 是人工校验任务：结论请走人工结论入口`, { identifier: task.identifier });
      }
      // 归因门在先：未归因的卡转调试也走不通，先说清。
      store.assertAttributed(task.identifier);
      const DEBUG_LABEL = "执行调试";
      const labels = Array.isArray(task.labels) ? [...task.labels] : [];
      const already = labels.some((l) => String(l ?? "").trim() === DEBUG_LABEL);
      if (!already) labels.push(DEBUG_LABEL);
      // 幂等：已在调试标签则不重复追加；状态一律回 todo（未授权不开工 ⇒ 不直接 in_progress）。
      const updated = store.updateTask(task.identifier, { expectedVersion: task.version, labels, status: "todo", actor: "agent" });
      store.addComment(task.identifier, { body: already
        ? `已标记为「${DEBUG_LABEL}」（此前已标记，未重复追加）并回「待办」——由人接手处理。`
        : `已转为「${DEBUG_LABEL}」并回「待办」——该卡的下一步需要宿主/终端环境介入，由人接手处理。` });
      try { store.recordAudit({ actor: "board", action: "to-debug", target: task.identifier, allowed: true, reason: "host-action-needed", detail: `label=${DEBUG_LABEL} status=todo` }); } catch { /* ignore */ }
      emit("task.updated", { taskId: updated.id, identifier: updated.identifier, status: updated.status });
      return { status: 200, payload: { task: updated, labeled: true, idempotent: already } };
    }
    // 任务 ↔ 执行会话 / 归属团队（FR-42/43 关联呈现）：任务详情右侧的"归属团队"面板数据源。
    const taskTeamRoute = /^\/api\/tasks\/([^/]+)\/team$/.exec(pathname);
    if (taskTeamRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "task team 仅支持 GET");
      const ref = decodeURIComponent(taskTeamRoute[1]);
      const task = store.requireTaskRef(ref);
      // FR-67：与派发同口径 —— 活跃执行者团队优先，回落项目引擎配置。
      const engine = activeEngine(store, task.projectId);
      // FR-50：回显的质量门链与**派发时同口径**（配置顺序 / 未配置回落默认）——避免"派发指令"与"详情回显"两套口径。
      const qualityGates = store.getProjectSettings(task.projectId)?.teamTemplate?.qualityGates ?? null;
      const teams = store.listTeamRuns({ targetTask: ref }).map((run) => {
        const members = store.listTeamMembers(run.id);
        const tasks = store.listTeamTasks(run.id).map((tt) => ({ ...tt, attempts: store.listTeamAttempts(tt.id) }));
        const directive = buildTeamDirective({ teamId: run.id, targetTask: task.identifier, targetRequirement: task.requirementId, members: members.map((m) => m.role), tasks: [{ task: task.identifier, subject: task.title }], qualityGates }, engine);
        return { run, members, tasks, directive };
      }).filter((e) => e.members.length > 0 || e.tasks.length > 0); // 跳过空 run，避免详情显示"空团队"掩盖真实反馈
      return {
        status: 200,
        payload: {
          task: { id: task.id, identifier: task.identifier, title: task.title, status: task.status, sessionId: task.sessionId ?? null },
          engine, teams, count: teams.length, lock: store.getTaskLock(ref),
        },
      };
    }
    const taskExecActionRoute = /^\/api\/tasks\/([^/]+)\/execution\/(fail|review|retry|release)$/.exec(pathname);
    if (taskExecActionRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "execution 动作仅支持 POST");
      const ref = decodeURIComponent(taskExecActionRoute[1]);
      const action = taskExecActionRoute[2];
      const task = action === "fail" ? store.recordTaskExecutionFailure(ref, { evidence: body.evidence, kind: body.kind })
        : action === "review" ? store.submitTaskForReview(ref, { comment: body.comment })
        : action === "retry" ? store.retryTaskExecution(ref)
        : store.releaseTaskAssignment(ref);
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      return { status: 200, payload: { task } };
    }
    // FR-83：评审流程（请求评审 / 请求返工 / 评审通过）——评审是一等流程，不是单向"提交待验收"
    const taskReviewRoute = /^\/api\/tasks\/([^/]+)\/review$/.exec(pathname);
    if (taskReviewRoute) {
      const ref = decodeURIComponent(taskReviewRoute[1]);
      if (method === "GET") {
        const task = store.requireTaskRef(ref);
        const { detectReviewDeadlock } = await import("../core/review.mjs");
        return {
          status: 200,
          payload: {
            identifier: task.identifier, status: task.status, reviewState: task.reviewState ?? null,
            reviewer: task.reviewer ?? null, round: task.reviewRound ?? 0,
            requestedAt: task.reviewRequestedAt ?? null, sourceStatus: task.reviewSourceStatus ?? null,
            dependsOn: task.reviewDependsOn ?? null, deadlock: detectReviewDeadlock(store, task),
          },
        };
      }
      if (method !== "POST") throw new TbError("USAGE_ERROR", "review 仅支持 GET / POST");
      const action = String(body.action ?? "request");
      const result = action === "request" ? store.requestReview(ref, { reviewer: body.reviewer ?? null, dependsOn: body.dependsOn ?? null, comment: body.comment ?? "", actor: body.actor ?? "human" })
        : action === "changes" ? store.requestChanges(ref, { comment: body.comment ?? "", actor: body.actor ?? "reviewer" })
        : action === "approve" ? store.approveReview(ref, { comment: body.comment ?? "", actor: body.actor ?? "reviewer" })
        : null;
      if (!result) throw invalidField("action", "action 只支持 request / changes / approve");
      emit("task.updated", { taskId: result.task.id, identifier: result.task.identifier, status: result.task.status });
      return { status: 200, payload: result };
    }
    // ---- 人工校验任务（FR-85b · 人在环升级门） ----
    const projectHumanReviewsRoute = /^\/api\/projects\/([^/]+)\/human-reviews$/.exec(pathname);
    if (projectHumanReviewsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "human-reviews 仅支持 GET");
      const projectId = decodeURIComponent(projectHumanReviewsRoute[1]);
      const state = searchParams.get("state") ?? null;
      const items = store.listHumanReviews({ projectId, state });
      const pending = store.humanReviewPending(projectId);
      return {
        status: 200,
        payload: {
          projectId, state, items, count: items.length, pendingCount: pending.length,
          pending: pending.map((t) => ({ identifier: t.identifier, title: t.title, category: t.humanReviewCategory ?? null, createdAt: t.createdAt ?? null })),
        },
      };
    }
    const taskHumanReviewConcludeRoute = /^\/api\/tasks\/([^/]+)\/human-review\/conclude$/.exec(pathname);
    if (taskHumanReviewConcludeRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "human-review/conclude 仅支持 POST");
      const ref = decodeURIComponent(taskHumanReviewConcludeRoute[1]);
      const result = store.concludeHumanReview(ref, { conclusion: body.conclusion, comment: body.comment ?? "", actor: body.actor ?? "human" });
      emit("task.updated", { taskId: result.task.id, identifier: result.task.identifier, status: result.task.status });
      return { status: 200, payload: result };
    }
    // 派发人工校验任务（FR-85b：四类情形升级为"人在环门"）。
    // 判定与草案**全部由服务端按可核验痕迹算**（不接受客户端塞分类）；判不准即拒绝（HUMAN_REVIEW_NOT_CONFIDENT）。
    const taskHumanReviewRoute = /^\/api\/tasks\/([^/]+)\/human-review$/.exec(pathname);
    if (taskHumanReviewRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "human-review 仅支持 POST");
      const ref = decodeURIComponent(taskHumanReviewRoute[1]);
      const task = store.requireTaskRef(ref);
      if (isHumanReviewTask(task)) throw new TbError("HUMAN_REVIEW_NOT_KIND", `任务 ${task.identifier} 已是人工校验任务：结论请走 conclude 入口`, { identifier: task.identifier });
      const probe = humanReviewProbe(store, task);
      const classification = probe.classification;
      if (!classification?.confident || !classification.category) {
        throw new TbError("HUMAN_REVIEW_NOT_CONFIDENT", `证据不足，不升级：${classification?.confidenceReason ?? "判不准就不升级"}`, { identifier: task.identifier, missing: classification?.missing ?? [] });
      }
      // FR-85 已结论水位线（2026-10-19 真机补）：同类已给出结论、且本次判定由**更早的**申报驱动 ⇒ 不得再造同类卡。
      // 否则「派发人工校验任务」这个按钮对一条常驻申报评论可以无限造卡（诊断会每轮重新产出该门）。
      const answered = humanReviewAnsweredBy(classification, probe.declarations, store.listHumanReviews({ projectId: task.projectId, state: "concluded" }));
      if (answered) {
        throw new TbError("HUMAN_REVIEW_ALREADY_EXISTS", `项目 ${task.projectId} 的同类人工校验任务 ${answered.identifier} 已给出结论（${answered.humanReviewConclusion}）：如需重新升级，请先补一条**更新的**申报评论`, { identifier: answered.identifier, category: classification.category });
      }
      let plan;
      try { plan = planHumanReview(probe.input); } catch (error) { throw new TbError("HUMAN_REVIEW_DRAFT_INVALID", String(error?.message ?? error), { identifier: task.identifier }); }
      const actor = body.actor ?? "human";
      const humanTask = store.createHumanReviewTask({
        projectId: task.projectId, draft: plan.draft, actor,
        requirementId: task.requirementId ?? null, relatedTask: task.identifier,
        priority: body.priority ?? "high",
      });
      // **停手等人**：原任务移出可开工池，一直停在「受阻」，直到人工结论把它放行（conclude → continue）。
      // 用 holdForHumanReview 而**不是** blockTask：后者的复发/类型会覆盖掉"升级门赖以成立的证据"。
      let blocked = null;
      try {
        blocked = store.holdForHumanReview(task.identifier, {
          reason: `FR-85 人在环升级门：已派发人工校验任务 ${humanTask.identifier}（类别=${classification.category}），结论给出前不自动推进`,
          actor, reviewTask: humanTask.identifier,
        });
      } catch { /* 原任务已是终态等 → 不阻断建卡 */ }
      emit("task.updated", { taskId: humanTask.id, identifier: humanTask.identifier, status: humanTask.status, humanReview: true });
      if (blocked) emit("task.updated", { taskId: blocked.id, identifier: blocked.identifier, status: blocked.status });
      return { status: 201, payload: { task: humanTask, classification, evidence: probe.evidence, original: blocked } };
    }
    const taskDepsRoute = /^\/api\/tasks\/([^/]+)\/dependencies$/.exec(pathname);
    if (taskDepsRoute) {
      const ref = decodeURIComponent(taskDepsRoute[1]);
      if (method === "GET") return { status: 200, payload: store.listTaskDependencies(ref) };
      if (method === "POST") return { status: 201, payload: store.addTaskDependency({ blocker: body.blocker, blocked: ref, reason: body.reason }) };
      if (method === "DELETE") {
        const blocker = searchParams.get("blocker") ?? body.blocker;
        return { status: 200, payload: store.removeTaskDependency({ blocker, blocked: ref }) };
      }
      throw new TbError("USAGE_ERROR", `依赖路由不支持 ${method}`);
    }
    const taskReadyRoute = /^\/api\/tasks\/([^/]+)\/ready$/.exec(pathname);
    if (taskReadyRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "ready 仅支持 GET");
      return { status: 200, payload: store.isTaskReady(decodeURIComponent(taskReadyRoute[1])) };
    }
    // 抽屉「下一步」引导（真机反馈 2026-10-22：抽屉只有按功能分类的按钮，没有任何一处回答
    // "我现在该干嘛"；人工校验门挡住的卡只有一行文字、连跳过去下结论的入口都没有）。
    // 推导口径唯一来源＝src/core/next-step.mjs（纯函数 + 单测覆盖）；本端点只做**只读**装配：
    // 查依赖表找出「待结论的人工校验前置」，并取看护读数，交给纯函数决定引导。
    const taskNextStepRoute = /^\/api\/tasks\/([^/]+)\/next-step$/.exec(pathname);
    if (taskNextStepRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "next-step 仅支持 GET");
      const task = store.requireTaskRef(decodeURIComponent(taskNextStepRoute[1]));
      const deps = store.listTaskDependencies(task.identifier);
      let humanReviewBlocker = null;
      for (const blocker of (deps?.blockers ?? [])) {
        const candidate = store.getTaskRef(blocker.identifier);
        if (!candidate) continue;
        if (!isHumanReviewTask(candidate)) continue;
        if (String(candidate.humanReviewState ?? "pending") === "concluded") continue;
        humanReviewBlocker = {
          identifier: candidate.identifier,
          title: candidate.title ?? null,
          category: candidate.humanReviewCategory ?? null,
        };
        break;
      }
      let stalled = false;
      try { stalled = assessTaskRef(store, task.identifier)?.state === "stalled"; } catch { stalled = false; }
      return { status: 200, payload: { task: task.identifier, humanReviewBlocker, nextStep: deriveNextStep(task, { humanReviewBlocker, stalled }) } };
    }
    // FR-93（缺陷 F-05）：看板空态引导口径。推导唯一来源＝src/core/empty-state.mjs（纯函数 + 单测）。
    // 本端点**只读**：查当前项目口径下的任务列表（含折叠卡），交给纯函数判断"为什么不显示"。
    // 前端是零依赖原生脚本（无法 import ESM），故按 next-step 的既有做法用只读端点传口径。
    const boardEmptyStateRoute = /^\/api\/projects\/([^/]+)\/empty-state$/.exec(pathname);
    if (boardEmptyStateRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "empty-state 仅支持 GET");
      const projectId = decodeURIComponent(boardEmptyStateRoute[1]);
      // 项目必须真实存在：否则「项目不存在」会被误报成「本项目暂无任务」（空态口径最忌讳的事就是臆断）
      store.requireProject(projectId);
      // 2026-10-22（续二十四）修复：取数口径必须与前端一致 —— 前端拿列数据走 `/api/tasks` 且**带筛选参数**，
      // 这里原先只用 `{ projectId }` 取全量，导致「筛选把卡全挡掉」时可见集仍非空 ⇒ 返回 `empty:false`
      // ⇒ 前端 `state.emptyState.empty` 为 false、**整块空态引导不渲染**（七列只剩「暂无任务」），
      // 正是 FR-93 要修的 F-05 场景（前端降级反而算对了 ⇒ 端点一上线行为比降级更差）。
      const emptyStatePriority = (searchParams.get("priority") ?? "").trim();
      const emptyStateLabel = (searchParams.get("label") ?? "").trim();
      // FR-26：会话归属维度也参与取数口径（缺失/空串＝「全部」，不当作筛选条件）
      const emptyStateSessionScope = (searchParams.get("sessionScope") ?? "").trim();
      // FR-14：搜索关键词同样参与取数口径（否则"搜索无命中"会被误判成"本项目暂无任务"）
      const emptyStateKeyword = (searchParams.get("q") ?? "").trim();
      const tasks = store.listTasks({
        projectId,
        priority: emptyStatePriority === "" ? undefined : emptyStatePriority,
        labels: emptyStateLabel === "" ? undefined : emptyStateLabel,
        sessionScope: emptyStateSessionScope === "" ? undefined : emptyStateSessionScope,
        q: emptyStateKeyword === "" ? undefined : emptyStateKeyword,
      }).map((task) => ({
        identifier: task.identifier,
        status: task.status,
        labels: task.labels ?? [],
      }));
      // 可见口径＝前端 FR-88 的折叠过滤；showArchived 由查询参数带入（默认 false = 默认视图）。
      const showArchived = searchParams.get("showArchived") === "1";
      const visible = showArchived ? tasks : tasks.filter((task) => !task.labels.includes("archived"));
      const emptyState = deriveEmptyState({
        allTasks: tasks,
        visibleTasks: visible,
        filters: { priority: emptyStatePriority, label: emptyStateLabel, sessionScope: emptyStateSessionScope, keyword: emptyStateKeyword },
        showArchived,
      });
      return { status: 200, payload: { project: projectId, emptyState } };
    }
    // 任务评论/反馈（执行证据、进展）
    const taskCommentsRoute = /^\/api\/tasks\/([^/]+)\/comments$/.exec(pathname);
    if (taskCommentsRoute) {
      const ref = decodeURIComponent(taskCommentsRoute[1]);
      if (method === "GET") { const task = store.requireTaskRef(ref); return { status: 200, payload: { comments: store.listComments(task.id) } }; }
      if (method === "POST") { const task = store.requireTaskRef(ref); const c = store.addComment(task.id, { body: body.body ?? body.comment ?? "", contract: body.contract }); emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status }); return { status: 201, payload: { comment: c } }; }
      throw new TbError("USAGE_ERROR", "comments 仅支持 GET 或 POST");
    }
    // FR-17：编辑一条评论（PATCH）。口径见 store.updateComment —— 乐观锁（冲突 → VERSION_CONFLICT/409）
    // + **编辑前原正文留痕**（comment_revisions，可回看）+ 机器证据评论只读（不得成为改写评审证据的旁路）。
    const taskCommentRoute = /^\/api\/tasks\/([^/]+)\/comments\/([^/]+)$/.exec(pathname);
    if (taskCommentRoute) {
      const ref = decodeURIComponent(taskCommentRoute[1]);
      const commentId = decodeURIComponent(taskCommentRoute[2]);
      const task = store.requireTaskRef(ref);
      if (method === "GET") {
        const comment = store.getComment(commentId);
        if (!comment || comment.taskId !== task.id) throw new TbError("COMMENT_NOT_FOUND", `评论不存在：${commentId}`, { commentId });
        return { status: 200, payload: { comment, revisions: store.listCommentRevisions(commentId) } };
      }
      if (method === "PATCH") {
        // 归属先校验：别让"编辑别的卡下的评论"绕开本任务路径（也不产生任何留痕副作用）。
        const existing = store.getComment(commentId);
        if (!existing || existing.taskId !== task.id) throw new TbError("COMMENT_NOT_FOUND", `评论不存在于任务 ${task.identifier}：${commentId}`, { commentId, identifier: task.identifier });
        const result = store.updateComment(commentId, {
          expectedVersion: body.version ?? body.expectedVersion,
          body: body.body ?? body.comment,
          actor: body.actor ?? "human",
        });
        if (result.changed) emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
        return { status: 200, payload: { comment: result.comment, changed: result.changed, revision: result.revision ?? null } };
      }
      throw new TbError("USAGE_ERROR", "单条评论仅支持 GET 或 PATCH");
    }
    // 复杂任务自动拆解为关联子任务（FR-69）
    const taskDecomposeRoute = /^\/api\/tasks\/([^/]+)\/decompose$/.exec(pathname);
    if (taskDecomposeRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "decompose 仅支持 POST");
      const parent = store.requireTaskRef(decodeURIComponent(taskDecomposeRoute[1]));
      let specs = Array.isArray(body.tasks) && body.tasks.length ? body.tasks : null;
      if (!specs) {
        const lines = String(parent.description ?? "").split("\n").map((l) => l.trim().replace(/^[-*]\s+|^\d+[).、]\s+/, "").trim()).filter((l) => l && l.length <= 100);
        specs = lines.length >= 2 ? lines.map((title) => ({ title })) : [{ title: `${parent.title} — 实现` }, { title: `${parent.title} — 验证` }];
      }
      const children = [];
      for (const s of specs) {
        const child = store.createTask({ projectId: parent.projectId, title: s.title, description: s.description ?? "", status: "backlog", owner: s.owner ?? null, labels: s.labels ?? [], parentId: parent.id });
        if (parent.requirementId) { try { store.associateRequirementTask(parent.requirementId, child.id); } catch { /* ignore */ } }
        children.push({ identifier: child.identifier, title: child.title });
      }
      emit("task.updated", { taskId: parent.id, identifier: parent.identifier, status: parent.status });
      return { status: 201, payload: { parent: parent.identifier, children } };
    }
    // FR-90：评审前的「自动复核」—— 跑一遍项目配置的验证命令，把**机器结论**落成证据评论。
    // 真机反馈（2026-10-22）：「判断为无法人工校验的任务，理应有自动复核或者已自动跑过测试的返回结论
    // 以供人员评审任务通过使用」。红线：**只旁路产证据，绝不改状态**（评审通过 / 完成仍只能由人点）。
    const autoReviewRoute = /^\/api\/tasks\/([^/]+)\/auto-review$/.exec(pathname);
    if (autoReviewRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "auto-review 仅支持 POST");
      const task = store.requireTaskRef(decodeURIComponent(autoReviewRoute[1]));
      if (task.status === "done" || task.status === "canceled") {
        throw new TbError("USAGE_ERROR", `已收口的卡（${task.status}）不需要复核：要复核请先重新打开这张卡`);
      }
      if (isHumanReviewTask(task)) {
        throw new TbError("USAGE_ERROR", "人工校验卡不走自动复核：它的出口是人工结论（FR-85 人在环升级门）");
      }
      const project = store.getProject(task.projectId);
      const cwd = project?.workspacePath ?? null;
      if (!cwd) {
        throw new TbError("PROJECT_WORKSPACE_MISSING", "本项目未配置工作区目录（workspacePath）——自动复核需要知道在哪个目录跑命令");
      }
      const settings = store.getProjectSettings(task.projectId);
      // FR-94：复核动作的回落链 —— 本次显式指定 → **本卡复核动作** → 项目设置 → 内置默认。
      const configured = body.command ?? task.verifyCommand ?? settings?.envConfig?.verifyCommand ?? null;
      const command = normalizeVerifyCommand(configured ?? VERIFY_DEFAULT_COMMAND);
      const acceptance = String(task.acceptance ?? "");
      // 真机报障（2026-10-28 · hydro-two-ticket 的 T7-B）：**没人配过命令**时回落到内置 `npm test`，
      // 而该工作区是 Java 工程 ⇒ `ENOENT package.json` ⇒ 退出码 254 ⇒ 结论「失败」。
      // 这是「命令不适用」，不是「测试失败」：不跑这条注定报错的命令，落一个**第三态**（不适用）+
      // 一条明路（去填本卡复核动作）。人配过的命令（`configured` 非空）一律照跑，不替他判断。
      const probe = configured ? { applicable: true, reason: null } : await probeVerifyApplicability({ command, cwd });
      const skipReason = probe.applicable ? null : probe.reason;
      const result = skipReason
        ? { exitCode: null, timedOut: false, durationMs: 0, tail: `未执行：${skipReason}。\n请在任务「编辑 → 复核动作」（或项目设置 envConfig.verifyCommand）里填本项目的复核命令后重跑，例如 Java 工程填 \`mvn -q test\`。` }
        : await runVerifyCommand({ command, cwd });
      // FR-90 强化（真机反馈 2026-10-22：「执行结果只返回一个结果，应该在自动复核证据内自动填入
      // 复核总结证据及结论」）：除机器头外，再把**总结 / 失败点**一并落成证据，并回传前端供自动填入。
      // 「不适用」不给测试计数（没跑），也不编造总结：只把原因原样写成一句结论。
      const summary = skipReason
        ? { summary: `未执行命令（${skipReason}）：这不是测试失败，请先配置本项目的复核命令`, failures: [], counts: { tests: null, passed: null, failed: null, durationMs: null } }
        : summarizeVerifyOutput(result);
      const comment = store.addComment(task.id, { body: formatVerifyComment({ command, ...result, ...summary, acceptance, skipReason }) });
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      const verdict = result.timedOut ? "超时未完成" : (skipReason ? `不适用（${skipReason}）` : (result.exitCode === 0 ? "通过" : `失败（退出码 ${result.exitCode}）`));
      return { status: 201, payload: { command, cwd, ...result, applicable: !skipReason, skipReason, verdict, summary: summary.summary, failures: summary.failures, counts: summary.counts, commentId: comment.id } };
    }
    // ---- 团队执行记录（FR-42）/ 治理（FR-43） ----
    if (pathname === "/api/teams") {
      if (method === "GET") {
        const teams = store.listTeamRuns({
          targetTask: searchParams.get("task") ?? undefined,
          status: searchParams.get("status") ?? undefined,
        }).map((run) => ({
          ...run,
          members: store.listTeamMembers(run.id),
          tasks: store.listTeamTasks(run.id),
        }));
        return { status: 200, payload: { teams, count: teams.length } };
      }
      if (method !== "POST") throw new TbError("USAGE_ERROR", "/api/teams 仅支持 POST");
      // 派发级归因门（复用 assertAttributed）：目标须归属需求条目
      const target = body.targetTask ? store.assertAttributed(body.targetTask) : null;
      if (body.targetRequirement) store.requireRequirementItemRef(body.targetRequirement);
      // 防重复下发：目标/成员任务中任一已有执行会话仍在执行且未返回结论 → 停发并提醒。
      const guardRefs = [target?.identifier ?? body.targetTask, ...(body.tasks ?? []).map((it) => (typeof it === "string" ? it : (it.task ?? it.ref)))].filter(Boolean);
      for (const ref of guardRefs) {
        const t = store.requireTaskRef(ref);
        const st = inflightOf(t);
        if (st) throw inflightError(t, st);
        const guard = store.dispatchGuard(t); // FR-78
        if (guard) throw new TbError("EXECUTION_CIRCUIT_OPEN", circuitMessage(guard, t), { identifier: t.identifier, reason: guard, failures: t.consecutiveFailures });
        // 真机 2026-10-22（续四十一）：**认领门也要在建 run 之前判**。
        // 原先只在下面的 acquireTeamTask 里判 backlog ⇒ 被拒的派发仍留下空团队 run（孤儿记录）。
        store.assertTeamClaimable(ref);
      }
      // FR-50 验收第三条：**团队模板校验门**——模板非法（角色缺失 / 数量为 0 / 角色名不在契约集合内）⇒ 拒绝。
      // 必须在 `createTeamRun` **之前**（否则又留下孤儿 run）。校验的"有效模板"＝本次建队实际用于装配成员的来源：
      //   body.members 非空 → 以它为准（UI 派发走这条）；否则取项目设置里的 teamTemplate.roles。
      // 目标未归因沿用上面的归因门（`assertAttributed`），此处不重复。
      let teamQualityGates = null;
      // FR-50 验收第一条：**装配计划**在建 run 之前就用同一份「已校验模板」算好
      // （角色 / 数量 / 模型 / 执行器），避免"门校验一份、装配另一份"的口径分裂。
      let memberPlan = [];
      {
        const pid = target?.projectId
          ?? (body.targetTask ? store.requireTaskRef(body.targetTask).projectId : null)
          ?? (body.targetRequirement ? store.requireRequirementItemRef(body.targetRequirement).projectId : null);
        const tpl = pid ? store.getProjectSettings(pid).teamTemplate : null;
        const effectiveRoles = (body.members ?? []).length ? body.members : (tpl?.roles ?? []);
        assertTeamTemplate({ roles: effectiveRoles, qualityGates: tpl?.qualityGates });
        memberPlan = planTeamMembers(effectiveRoles);
        // FR-50：把**已校验**的原始配置带下去渲染派发指令（顺序 = 配置声明顺序；未配置回落默认链并注明来源）。
        teamQualityGates = tpl?.qualityGates ?? null;
      }
      const run = store.createTeamRun({ targetTask: target?.id ?? null, targetRequirement: body.targetRequirement ?? null });
      // 按装配计划落成员：`count>1` ⇒ 同角色多名；`model` / `executor` 逐字带下去（FR-50 验收第一条）。
      try {
        for (const member of memberPlan) {
          store.addTeamMember({ teamId: run.id, role: member.role, model: member.model, executor: member.executor });
        }
      } catch { /* ignore */ }
      // 任务级执行锁（复用 acquireTeamTask）：同一任务同时只 1 个活跃执行单元
      const locks = [];
      for (const item of body.tasks ?? []) {
        const taskRef = typeof item === "string" ? item : (item.task ?? item.ref);
        locks.push(store.acquireTeamTask({ teamId: run.id, task: taskRef, member: (typeof item === "object" && item.member) || null, kind: (typeof item === "object" && item.kind) || "work" }));
      }
      // 双引擎"下发对接"：按项目配置的引擎分派；默认沿用端口模式
      const port = store.teamEnginePort;
      let engine = port?.mode ?? "instruction";
      try {
        const pid2 = target?.projectId ?? (body.targetTask ? store.requireTaskRef(body.targetTask).projectId : null);
        if (pid2) engine = activeEngine(store, pid2); // FR-67：活跃执行者团队优先
      } catch { /* ignore */ }
      let draft = null;
      let mode = "local-only";
      let sessionId = null;
      let presetApplied = null;
      if (engine === "nanmicoder" && port?.createDraft) {
        try {
          const result = await port.createDraft({
            teamId: run.id,
            targetTask: target?.identifier ?? body.targetTask ?? null,
            targetRequirement: body.targetRequirement ?? null,
            members: body.members ?? [],
            tasks: body.tasks ?? [],
            name: body.name,
            description: body.description,
            // FR-50：端口路径（nanmicoder / 其退路）同样带**已校验**门链，避免该路径派发指令丢门。
            qualityGates: teamQualityGates,
          });
          draft = result?.draft ?? null;
          mode = result?.mode ?? port.mode ?? "instruction";
          sessionId = result?.sessionId ?? null;
          presetApplied = result?.presetApplied ?? null;
        } catch (error) {
          mode = `error:${error?.code ?? error?.message ?? String(error)}`;
        }
      } else {
        // official / instruction：产出面向引擎的派发指令（由 DSH 队长/会话承接）
        draft = { directive: buildTeamDirective({ teamId: run.id, targetTask: target?.identifier ?? body.targetTask ?? null, targetRequirement: body.targetRequirement ?? null, members: body.members ?? [], tasks: body.tasks ?? [], qualityGates: teamQualityGates }, engine) };
        mode = engine;
        // 任务下发：把派发指令投递到项目主会话（否则任务只会"派发成功"但无人执行）
        try {
          const pid3 = target?.projectId ?? (body.targetTask ? store.requireTaskRef(body.targetTask).projectId : null);
          const bound = pid3 ? store.getProject(pid3)?.initialSessionId ?? null : null;
          if (bound && typeof store.hostSessionPort?.sendPrompt === "function") {
            const sent = await store.hostSessionPort.sendPrompt(bound, draft.directive);
            sessionId = sent?.sent ? bound : null;
            presetApplied = Boolean(sent?.sent);
            draft.delivered = Boolean(sent?.sent);
            draft.deliveryReason = sent?.sent ? null : (sent?.reason ?? "unknown");
          } else {
            draft.delivered = false;
            draft.deliveryReason = bound ? "prompt-unavailable" : "no-bound-session";
          }
        } catch (error) {
          draft.delivered = false;
          draft.deliveryReason = error?.message ?? String(error);
        }
      }
      emit("team.updated", { teamId: run.id, status: run.status });
      return { status: 201, payload: { team: store.getTeamRun(run.id), mode, draft, sessionId, presetApplied, locks } };
    }
    // 执行循环（FR-68）：把"人工设为待执行(todo)且已归因"的任务，自动派发给活跃执行者团队
    const projectLoopRoute = /^\/api\/projects\/([^/]+)\/execution-loop$/.exec(pathname);
    if (projectLoopRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "execution-loop 仅支持 POST");
      const limit = Number.isFinite(body.limit) ? body.limit : 20;
      const result = await runExecutionLoop({ store, events, projectId: decodeURIComponent(projectLoopRoute[1]), limit });
      return { status: 200, payload: result };
    }
    // 执行看护（FR-75/76）：列出需要人介入的任务（停滞 / 待决策）
    const projectWatchdogRoute = /^\/api\/projects\/([^/]+)\/watchdog$/.exec(pathname);
    if (projectWatchdogRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "watchdog 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectWatchdogRoute[1]));
      const rows = projectWatchdog(store, project.id);
      return {
        status: 200,
        payload: {
          project: project.id, count: rows.length,
          stalled: rows.filter((r) => r.state === "stalled").length,
          awaitingDecision: rows.filter((r) => r.state === "awaiting-decision").length,
          tasks: rows,
        },
      };
    }
    // FR-79：项目级诊断（进行中 / 受阻 / 待验收三类任务的可操作诊断 + 严重度汇总）
    const projectDiagnosticsRoute = /^\/api\/projects\/([^/]+)\/diagnostics$/.exec(pathname);
    if (projectDiagnosticsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "diagnostics 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectDiagnosticsRoute[1]));
      const { rows, summary } = projectDiagnostics(store, project.id);
      return { status: 200, payload: { project: project.id, count: rows.length, summary, diagnostics: rows } };
    }
    // FR-83：评审队列（待验收任务 + 评审态 + 评审死锁判定）
    const projectReviewsRoute = /^\/api\/projects\/([^/]+)\/reviews$/.exec(pathname);
    if (projectReviewsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "reviews 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectReviewsRoute[1]));
      const state = searchParams.get("state");
      const rows = store.listReviews(project.id, { state });
      return {
        status: 200,
        payload: {
          project: project.id, count: rows.length,
          pending: rows.filter((r) => (r.reviewState ?? "pending") === "pending").length,
          changesRequested: store.listTasks({ projectId: project.id }).filter((t) => t.reviewState === "changes_requested" && t.status !== "done").length,
          approved: rows.filter((r) => r.reviewState === "approved").length,
          deadlocked: rows.filter((r) => r.deadlock?.deadlocked).length,
          tasks: rows.map((t) => ({
            identifier: t.identifier, title: t.title, status: t.status, reviewState: t.reviewState ?? null,
            reviewer: t.reviewer ?? null, round: t.reviewRound ?? 0, requestedAt: t.reviewRequestedAt ?? null,
            deadlock: t.deadlock ?? null,
          })),
        },
      };
    }
    // ---------------- 契约快照（P1 · 方案 §6.4 / §8） ----------------
    // 只读投影：`contractVersion = f(需求文档 digest, spec/norms digest×版本, 门配置)`。
    // GET 不写库（重算即可）；POST …/recheck 才落基线 —— 这样「看一眼契约」永远无副作用。
    const projectContractRoute = /^\/api\/projects\/([^/]+)\/contract(?:\/(recheck))?$/.exec(pathname);
    if (projectContractRoute) {
      const projectId = decodeURIComponent(projectContractRoute[1]);
      const isRecheck = Boolean(projectContractRoute[2]);
      if (isRecheck && method !== "POST") throw new TbError("USAGE_ERROR", "contract/recheck 仅支持 POST");
      if (!isRecheck && method !== "GET") throw new TbError("USAGE_ERROR", "contract 仅支持 GET（重算基线用 POST …/contract/recheck）");
      const result = isRecheck
        ? store.refreshProjectContract(projectId, { reason: body.reason ?? null })
        : store.contractSnapshot(projectId);
      return { status: 200, payload: result };
    }
    // ---------------- 项目推进清单（2026-10-28 · 拍板 E1/E3） ----------------
    // E1：**纯投影**，不落表；同状态重复请求字节级一致（不含 now/minutes）。
    const projectAdvanceRoute = /^\/api\/projects\/([^/]+)\/advance$/.exec(pathname);
    if (projectAdvanceRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "推进清单仅支持 GET（要投给主会话用 POST …/advance/announce）");
      const project = store.requireProject(decodeURIComponent(projectAdvanceRoute[1]));
      const list = buildAdvance(store, project.id);
      const payload = { ...list };
      // P-B：`?format=block` 直接给可投递的指令装载块（含【项目记忆】段）
      if (String(searchParams.get("format") ?? "") === "block") {
        const recall = store.recallMemory({ projectId: project.id });
        payload.block = [renderAdvanceBlock(list), renderMemoryBlock(recall, { projectName: project.name })].join("\n\n");
        payload.memory = { count: recall.count, ids: recall.entries.map((e) => e.id) };
      }
      return { status: 200, payload };
    }
    // P-B：把清单 + 项目记忆拼成**一段**装载块投给主会话（复用既有 sendPrompt，不新增投递通道）
    const projectAdvanceAnnounceRoute = /^\/api\/projects\/([^/]+)\/advance\/announce$/.exec(pathname);
    if (projectAdvanceAnnounceRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "advance/announce 仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectAdvanceAnnounceRoute[1]));
      const sid = body.sessionId ? String(body.sessionId) : (project.initialSessionId ?? null);
      if (!sid) throw new TbError("NO_MAIN_SESSION", "该项目还没有主会话：先在开局流程绑主会话，或用 body.sessionId 指定", { projectId: project.id });
      const hostPort = store.hostSessionPort;
      if (!hostPort || typeof hostPort.sendPrompt !== "function") throw new TbError("HOST_UNAVAILABLE", "宿主会话通道不可用，无法投递装载块", { projectId: project.id });
      const list = buildAdvance(store, project.id);
      const recall = store.recallMemory({ projectId: project.id });
      const blockText = [renderAdvanceBlock(list), renderMemoryBlock(recall, { projectName: project.name })].join("\n\n");
      let sent = null;
      try { sent = await hostPort.sendPrompt(sid, blockText); } catch (e) { sent = { sent: false, reason: e?.message ?? "error" }; }
      store.recordMemoryRecalls({ sessionId: sid, entries: recall.entries, reason: "advance-announce" });
      try {
        store.recordAudit({ actor: body.actor ?? "board", action: "advance-announce", target: project.id, allowed: Boolean(sent?.sent), reason: sent?.reason ?? "delivered", detail: `session=${sid} items=${list.count} memory=${recall.count}` });
      } catch { /* 审计失败不阻断投递结果如实回包 */ }
      return { status: 200, payload: { project: project.id, sessionId: sid, delivered: Boolean(sent?.sent), reason: sent?.reason ?? null, items: list.count, memory: recall.count, block: blockText } };
    }
    // P-C：决定回写（**幂等**：同 decisionId 第二次只返回首次结果；accept/complete 仅人）
    const projectDecideRoute = /^\/api\/projects\/([^/]+)\/advance\/([^/]+)\/decide$/.exec(pathname);
    if (projectDecideRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "decide 仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectDecideRoute[1]));
      const decisionId = decodeURIComponent(projectDecideRoute[2]);
      const result = applyDecision(store, project.id, decisionId, { choice: body.choice, note: body.note ?? null, actor: body.actor ?? "human" });
      try {
        store.recordAudit({ actor: body.actor ?? "human", action: "advance-decide", target: decisionId, allowed: true, reason: result.replay ? "replay" : String(result.choice ?? ""), detail: `kind=${result.kind ?? result.applied?.kind ?? "?"} task=${result.taskRef ?? result.applied?.taskRef ?? "?"}` });
      } catch { /* 同上 */ }
      return { status: 200, payload: result };
    }
    // ---------------- 项目记忆（2026-10-28 · 拍板 D-M1/D-M2/D-M5） ----------------
    const projectMemoryRoute = /^\/api\/projects\/([^/]+)\/memory$/.exec(pathname);
    if (projectMemoryRoute) {
      const project = store.requireProject(decodeURIComponent(projectMemoryRoute[1]));
      if (method === "GET") {
        const entries = store.listMemoryEntries({
          projectId: project.id,
          scope: searchParams.get("scope") ?? null,
          kind: searchParams.get("kind") ?? null,
          includeProposed: String(searchParams.get("includeProposed") ?? "") === "1",
        });
        const recall = store.recallMemory({ projectId: project.id });
        return { status: 200, payload: { project: project.id, count: entries.length, entries, recall: { count: recall.count, ids: recall.entries.map((e) => e.id), chars: recall.chars } } };
      }
      if (method === "POST") {
        // D-M2：写入即 **proposed**，人 accept 后才会被召回
        const { entry, created } = store.upsertMemoryEntry({
          ...body,
          projectId: body?.projectId ?? project.id,
          createdBy: body?.createdBy ?? "agent:board",
        });
        try { store.recordAudit({ actor: body?.createdBy ?? "agent:board", action: "memory-upsert", target: project.id, allowed: true, reason: created ? "created" : "updated", detail: `${entry.id} ${entry.scope}/${entry.kind} ${entry.provenance}` }); } catch { /* ignore */ }
        return { status: created ? 201 : 200, payload: { entry, created, note: entry.confidence === "proposed" ? "已写入待确认（proposed）：人 accept 后才会被召回" : null } };
      }
      throw new TbError("USAGE_ERROR", "memory 仅支持 GET（列表+召回预览）/ POST（propose 一条）");
    }
    const projectMemoryAcceptRoute = /^\/api\/projects\/([^/]+)\/memory\/([^/]+)\/accept$/.exec(pathname);
    if (projectMemoryAcceptRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "memory accept 仅支持 POST");
      store.requireProject(decodeURIComponent(projectMemoryAcceptRoute[1]));
      const result = store.acceptMemoryEntry(decodeURIComponent(projectMemoryAcceptRoute[2]), { actor: body?.actor ?? "human" });
      return { status: 200, payload: result };
    }
    // FR-82：项目事件流（跨任务按全库游标；FR-81 的订阅推送数据源）
    const projectEventsRoute = /^\/api\/projects\/([^/]+)\/events$/.exec(pathname);
    if (projectEventsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "events 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectEventsRoute[1]));
      const since = Number(searchParams.get("since") ?? 0) || 0;
      const limit = Number(searchParams.get("limit") ?? 200) || 200;
      const events = store.listProjectEvents(project.id, { since, limit, order: searchParams.get("order") ?? "desc" });
      return { status: 200, payload: { project: project.id, since, count: events.length, cursor: events.reduce((acc, e) => Math.max(acc, e.cursor), since), events } };
    }
    // ---------------- FR-81 通知订阅与唤醒 ----------------
    // 推送一轮：把订阅游标之后的**终态事件**投递给目标会话（失败保留游标，下轮自动重试）
    const projectNotifyFlushRoute = /^\/api\/projects\/([^/]+)\/notify\/flush$/.exec(pathname);
    if (projectNotifyFlushRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "notify/flush 仅支持 POST");
      const project = store.requireProject(decodeURIComponent(projectNotifyFlushRoute[1]));
      const subId = body.subId ? String(body.subId) : null;
      const r = await store.flushNotifySubscriptions({ projectId: project.id, subId });
      for (const item of r.results) {
        if (item.delivered) emit("notify.delivered", { projectId: project.id, subscriptionId: item.id, sessionId: item.sessionId, mode: item.mode, kinds: item.kinds, count: item.count });
        else if (item.error) emit("notify.failed", { projectId: project.id, subscriptionId: item.id, sessionId: item.sessionId, error: item.error });
      }
      return { status: 200, payload: { project: project.id, count: r.count, summary: summarizeNotifyDelivery(r.results), results: r.results } };
    }
    // 预览：某游标之后"待推送的终态事件"（不推进游标、不落库）
    const projectNotifyEventsRoute = /^\/api\/projects\/([^/]+)\/notify\/events$/.exec(pathname);
    if (projectNotifyEventsRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "notify/events 仅支持 GET");
      const project = store.requireProject(decodeURIComponent(projectNotifyEventsRoute[1]));
      const since = Number(searchParams.get("since") ?? 0) || 0;
      const limit = Number(searchParams.get("limit") ?? 200) || 200;
      const taskRef = searchParams.get("task");
      return { status: 200, payload: store.notifyPreviewEvents({ projectId: project.id, taskRef, since, limit }) };
    }
    // 订阅列表（带每条订阅"待推送"摘要）/ 新建订阅
    const projectNotifyRoute = /^\/api\/projects\/([^/]+)\/notify$/.exec(pathname);
    if (projectNotifyRoute) {
      const project = store.requireProject(decodeURIComponent(projectNotifyRoute[1]));
      if (method === "GET") {
        const includeInactive = searchParams.get("activeOnly") === "0";
        const subs = store.listNotifySubscriptions({ projectId: project.id, activeOnly: !includeInactive });
        const subscriptions = subs.map((sub) => {
          const pending = store.notifySubPending(sub.id);
          return { ...sub, pending: { count: pending.count, cursor: pending.cursor, kinds: pending.kinds, since: pending.since } };
        });
        const summary = subscriptions.reduce((acc, s) => ({
          total: acc.total + 1,
          active: acc.active + (s.active ? 1 : 0),
          pending: acc.pending + s.pending.count,
          failing: acc.failing + (s.lastError ? 1 : 0),
        }), { total: 0, active: 0, pending: 0, failing: 0 });
        return { status: 200, payload: { project: project.id, count: subscriptions.length, summary, subscriptions } };
      }
      if (method === "POST") {
        const subscription = store.createNotifySubscription({
          projectId: project.id,
          taskRef: body.taskRef ?? null,
          sessionId: body.sessionId,
          mode: body.mode ?? "notify+wake",
          since: body.since ?? null,
        });
        emit("notify.subscribed", { projectId: project.id, subscriptionId: subscription.id, mode: subscription.mode, scope: subscription.scope });
        return { status: 201, payload: { subscription } };
      }
      throw new TbError("USAGE_ERROR", "notify 仅支持 GET / POST");
    }
    // 单条订阅：改（模式/会话/启停/游标）或删（默认软停用，?purge=1 才真删）
    const notifySubRoute = /^\/api\/notify\/([^/]+)$/.exec(pathname);
    if (notifySubRoute) {
      const id = decodeURIComponent(notifySubRoute[1]);
      if (method === "GET") {
        const sub = store.requireNotifySubscription(id);
        const pending = store.notifySubPending(id);
        return { status: 200, payload: { subscription: { ...sub, pending: { count: pending.count, cursor: pending.cursor, kinds: pending.kinds, since: pending.since } } } };
      }
      if (method === "PATCH") {
        const subscription = store.updateNotifySubscription(id, { mode: body.mode, active: body.active, sessionId: body.sessionId, since: body.since });
        emit("notify.updated", { subscriptionId: subscription.id, mode: subscription.mode, active: subscription.active });
        return { status: 200, payload: { subscription } };
      }
      if (method === "DELETE") {
        const r = store.deleteNotifySubscription(id, { purge: searchParams.get("purge") === "1" });
        emit("notify.updated", { subscriptionId: r.subscription.id, active: r.subscription.active });
        return { status: 200, payload: r };
      }
      throw new TbError("USAGE_ERROR", "notify/:id 仅支持 GET / PATCH / DELETE");
    }
    const teamRoute = /^\/api\/teams\/([^/]+)$/.exec(pathname);
    if (teamRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "团队路由仅支持 GET");
      const id = decodeURIComponent(teamRoute[1]);
      const run = store.getTeamRun(id);
      if (!run) throw new TbError("TEAM_NOT_FOUND", `团队不存在：${id}`, { teamId: id });
      return { status: 200, payload: { team: run, members: store.listTeamMembers(id), tasks: store.listTeamTasks(id) } };
    }
    const teamMemberRoute = /^\/api\/teams\/([^/]+)\/members$/.exec(pathname);
    if (teamMemberRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "members 仅支持 POST");
      return { status: 201, payload: { member: store.addTeamMember({ teamId: decodeURIComponent(teamMemberRoute[1]), role: body.role, model: body.model, executor: body.executor }) } };
    }
    const teamTaskRoute = /^\/api\/teams\/([^/]+)\/tasks$/.exec(pathname);
    if (teamTaskRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "team tasks 仅支持 POST");
      const tt = store.acquireTeamTask({ teamId: decodeURIComponent(teamTaskRoute[1]), task: body.task, member: body.member, kind: body.kind });
      emit("task.updated", { taskId: tt.taskId, status: "in_progress" });
      return { status: 201, payload: { teamTask: tt } };
    }
    const teamOutcomeRoute = /^\/api\/teams\/([^/]+)\/tasks\/([^/]+)\/outcome$/.exec(pathname);
    if (teamOutcomeRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "outcome 仅支持 POST");
      const task = store.applyTeamTaskOutcome(decodeURIComponent(teamOutcomeRoute[2]), { outcome: body.outcome, reviewPassed: body.reviewPassed, evidence: body.evidence });
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      return { status: 200, payload: { task } };
    }
    const teamProgressRoute = /^\/api\/teams\/([^/]+)\/progress$/.exec(pathname);
    if (teamProgressRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "progress 仅支持 POST");
      const r = store.applyTeamRunProgress(decodeURIComponent(teamProgressRoute[1]), body.outcomes ?? []);
      emit("team.updated", { teamId: r.teamId, status: r.status });
      return { status: 200, payload: r };
    }
    const teamFinishRoute = /^\/api\/teams\/([^/]+)\/finish$/.exec(pathname);
    if (teamFinishRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "finish 仅支持 POST");
      const status = store.finishTeamRun(decodeURIComponent(teamFinishRoute[1]));
      emit("team.updated", { teamId: decodeURIComponent(teamFinishRoute[1]), status });
      return { status: 200, payload: { status } };
    }
    const taskLockRoute = /^\/api\/tasks\/([^/]+)\/lock$/.exec(pathname);
    if (taskLockRoute) {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "lock 仅支持 GET");
      return { status: 200, payload: { lock: store.getTaskLock(decodeURIComponent(taskLockRoute[1])) } };
    }
    const taskTeamStatusRoute = /^\/api\/tasks\/([^/]+)\/team-status$/.exec(pathname);
    if (taskTeamStatusRoute) {
      if (method !== "POST") throw new TbError("USAGE_ERROR", "team-status 仅支持 POST");
      const task = store.teamSetTaskStatus(decodeURIComponent(taskTeamStatusRoute[1]), { status: body.status, actor: body.actor ?? "team" });
      emit("task.updated", { taskId: task.id, identifier: task.identifier, status: task.status });
      return { status: 200, payload: { task } };
    }
    if (pathname === "/api/governance/audit") {
      if (method !== "GET") throw new TbError("USAGE_ERROR", "audit 仅支持 GET");
      const audit = store.listGovernanceAudit({ action: searchParams.get("action") ?? undefined });
      return { status: 200, payload: { audit, count: audit.length } };
    }
    throw new TbError("NOT_FOUND", `未知接口：${pathname}`);
  }

  return { route };
}
