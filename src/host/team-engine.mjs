/**
 * team-engine.mjs —— TeamEnginePort 真实 adapter（切片3 宿主集成）。
 *
 * 对齐 HostSessionPort 的**懒取**模式：每次调用经 getService(name) 现取服务，不 eager 注入。
 * 双实现共用同一接口，差异只在 createDraft 的引擎调用：
 *   - instruction（P2，默认）：建会话 + 把"派发指令"作为预置内容发给会话；approve 为 no-op。
 *   - agent-teams（P1，占位）：经 tools.call('agent_teams_create', {approval:'required',...})；
 *     不可用时**自动降级**为 instruction 路径（mode="agent-teams-fallback"）。T-5 通过后一键切换。
 *
 * 接口：createDraft({teamId,targetTask,targetRequirement,members,tasks}) → {teamId,draft,mode,sessionId?,presetApplied?}
 *       approve(teamId) · readTeamStatus(teamId) · subscribeTeamEvents(cb) · mode(getter)
 */
import { normalizeQualityGates } from "../core/team.mjs";

export const TEAM_ENGINE_MODES = Object.freeze(["instruction", "agent-teams", "official"]);

/**
 * 双引擎"下发对接"：按引擎生成派发指令（供 P2 会话/工作台回显）。
 *   official    = DSH 官方自带（spawn_teammate / team_task_*）
 *   nanmicoder  = @nanmicoder/dsh-agent-teams（agent_teams_create）
 *   instruction = 指令降级
 */
export function buildTeamDirective({ teamId, targetTask, targetRequirement, members = [], tasks = [], qualityGates = null }, engine = "instruction") {
  // FR-50：质量门链**按项目配置渲染**（顺序 = 配置数组声明顺序）；未配置回落契约默认链并注明来源。
  const { gates, source } = normalizeQualityGates({ qualityGates });
  const gateLine = `质量门（${source === "configured" ? "配置" : "默认"}）：${gates.join("→")}`;
  const head = engine === "official"
    ? `[派发团队 · DSH官方自带] teamId=${teamId}\n请作为 Lead 用 spawn_teammate 召集成员、用 team_task_create 建任务看板。`
    : engine === "nanmicoder"
      ? `[派发团队 · @nanmicoder/dsh-agent-teams] teamId=${teamId}\n（引擎：agent_teams_create，approval=required）`
      : `[派发团队] teamId=${teamId}`;
  const lines = [head];
  if (targetTask) lines.push(`目标：${targetTask}`);
  if (targetRequirement) lines.push(`需求：${targetRequirement}`);
  if (members.length) lines.push(`成员：${members.map((m) => (typeof m === "string" ? m : m.role ?? m.name ?? "member")).join("、")}`);
  if (tasks.length) lines.push(`任务：${tasks.map((t) => (typeof t === "string" ? t : t.subject ?? t.title ?? t.task ?? t.id ?? "task")).join("；")}`);
  lines.push(gateLine);
  lines.push("操作指引：按依赖就绪逐个认领 → 执行 → 提交\"待验收\"；审查未过不得解锁下游；不得置\"完成\"（人工确认）。");
  return lines.join("\n");
}

function buildDirective({ teamId, targetTask, targetRequirement, members = [], tasks = [], qualityGates = null }) {
  const lines = [`[派发团队] teamId=${teamId}`];
  if (targetTask) lines.push(`目标：${targetTask}`);
  if (targetRequirement) lines.push(`需求：${targetRequirement}`);
  if (members.length) lines.push(`成员：${members.map((m) => (typeof m === "string" ? m : m.role ?? m.name ?? "member")).join("、")}`);
  if (tasks.length) lines.push(`任务：${tasks.map((t) => (typeof t === "string" ? t : t.subject ?? t.title ?? t.id ?? "task")).join("；")}`);
  // FR-50：P2 指令路径与 `buildTeamDirective` 同口径 —— 质量门链按项目配置渲染，未配置回落默认并注明来源。
  // （2026-10-27 补口：此前只有建队 / 执行循环两条指令带门链，nanmicoder 走 `createDraft` 时丢链 ⇒ 三处口径不一。）
  const { gates, source } = normalizeQualityGates({ qualityGates });
  lines.push(`质量门（${source === "configured" ? "配置" : "默认"}）：${gates.join("→")}`);
  lines.push("操作指引：按依赖就绪逐个认领 → 执行 → 提交\"待验收\"；审查未过不得解锁下游；不得置\"完成\"（人工确认）。");
  return lines.join("\n");
}

export function createTeamEnginePort({ getService, mode = "instruction" } = {}) {
  const sessions = () => getService?.("sessions");
  const tools = () => getService?.("tools");

  /** P2：建会话 + 预置"派发指令"（预置失败不抛错）。 */
  async function instructionDraft(input) {
    const directive = buildDirective(input);
    let sessionId = null;
    let presetApplied = false;
    const api = sessions();
    if (typeof api?.create === "function") {
      try {
        const created = await api.create({});
        sessionId = typeof created === "string" ? created : (created?.sessionId ?? created?.id ?? null);
      } catch {
        sessionId = null;
      }
      if (sessionId && typeof api.sendMessage === "function") {
        try {
          await api.sendMessage(sessionId, directive);
          presetApplied = true;
        } catch {
          presetApplied = false;
        }
      }
    }
    return { teamId: input.teamId, mode: "instruction", draft: { directive }, sessionId, presetApplied };
  }

  /** P1（占位）：经 tools.call('agent_teams_create', {approval:'required'})；不可用则降级 P2。 */
  async function agentTeamsDraft(input) {
    const t = tools();
    if (typeof t?.call === "function") {
      try {
        const created = await t.call("agent_teams_create", {
          approval: "required",
          name: input.name ?? `team-${input.teamId}`,
          description: input.description ?? "",
          plan: { members: input.members ?? [], tasks: input.tasks ?? [] },
        });
        return { teamId: input.teamId, mode: "agent-teams", draft: created ?? null };
      } catch {
        /* 降级 */
      }
    }
    const fallback = await instructionDraft(input);
    return { ...fallback, mode: "agent-teams-fallback", fallbackReason: "agent-teams-unavailable" };
  }

  const implemented = mode === "agent-teams" ? agentTeamsDraft : instructionDraft;

  return {
    get mode() {
      return mode;
    },
    createDraft: implemented,
    /** P2：指令已发出，approve 为 no-op；P1 占位（T-5 通过后接 agent_teams_approve）。 */
    async approve() {
      return { approved: true, mode };
    },
    /** 团队状态以本项目 team_runs/team_tasks 为准（api 层读取）；此处占位。 */
    async readTeamStatus() {
      return null;
    },
    /** 事件回流：本项目 SSE（api 层已 publish）；此处占位。 */
    subscribeTeamEvents() {
      return () => {};
    },
  };
}
