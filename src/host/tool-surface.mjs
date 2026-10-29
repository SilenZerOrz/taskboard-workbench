/**
 * tool-surface.mjs —— 反向链路：把工作台任务暴露给 Code Agent 认领/更新（FR-25/29 + R-WS-34）。
 *
 * 形态：宿主工具面 `taskboard_*`，经 `ctx.tools.register(...)` 注册。
 * - 归属：`exec.agent?.id`（= SessionId）写入任务 session_id（谁在做）。
 * - 项目绑定：按会话 cwd（`exec.agent` 上下文或参数）用 binding 解析项目 + 需求文档。
 * - 创建（FR-29 `taskboard_create_task`）：cwd→项目匹配（`matchProjectForCwd`），**未匹配即回落默认项目
 *   并在返回值里如实提示**（`fallback`/`hint`）；新建一律 backlog ⇒ 与「backlog 不得执行」同一条红线。
 * - 治理：**执行侧不得写 done**（复用 store.teamSetTaskStatus 的固定红线）；backlog 不得认领。
 *
 * 说明：参数用**纯 JSON-schema 对象**（对齐 defineTool 契约，无需 schemastery）；
 * `defineTool` 可注入（默认恒等），因此本模块**不静态 import 任何 @deepseek-ai/*，可独立测试**。
 */
import { matchProjectForCwd, resolveContext, resolveProjectForCwd } from "../core/binding.mjs";
import { TbError } from "../core/errors.mjs";

const text = (v) => [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }];
// 宿主 tools 服务对 JSON-schema 有**子集校验**（dsh-tools/json-schema）：`type` 只能是
// object/array/string/number/integer/boolean/null。旧值 `{type:"json"}` 非法 →
// `tools register failed: unsupported JSON schema`，导致 taskboard_* 全部注册失败。
// 这里改用合法对象 schema（放开 additionalProperties，允许任意字段）。
const tool = (defineTool, spec) => defineTool({ output: { schema: { type: "object", additionalProperties: true }, render: (_a, v) => text(v) }, ...spec });

export function registerTaskboardTools({ tools, store, events = null, defineTool = (o) => o } = {}) {
  if (!tools || typeof tools.register !== "function") return () => {};
  const disposers = [];
  const reg = (spec) => disposers.push(tools.register(tool(defineTool, spec)));
  const actorOf = (exec) => exec?.agent?.id ?? exec?.agentId ?? null;
  // 反向链路：Agent 通过工具改任务后，把"失效信号"推给工作台（SSE）→ 看板实时刷新。
  const changed = (task) => { try { events?.publish?.("task.updated", { taskId: task?.id, identifier: task?.identifier, status: task?.status }); } catch { /* ignore */ } };

  reg({
    name: "taskboard_context",
    description: "返回当前工作区对应的项目与需求文档（工作区→项目→需求文档的初始绑定）。",
    parameters: { cwd: { type: "string", description: "工作目录；省略则用会话所在目录。" } },
    async execute(args, exec) {
      const cwd = args?.cwd ?? exec?.cwd ?? exec?.agent?.cwd ?? null;
      const ctx = resolveContext(store, cwd);
      return { cwd, project: ctx.project ? { id: ctx.project.id, name: ctx.project.name, workspacePath: ctx.project.workspacePath } : null, requirementDoc: ctx.requirementDoc ? { id: ctx.requirementDoc.id, version: ctx.requirementDoc.version } : null };
    },
  });

  reg({
    name: "taskboard_create_task",
    description: "在会话中顺手指派一条任务（FR-29）：按 cwd 落到匹配项目，**未匹配时回落默认项目并在返回里明确提示**（`fallback`/`hint`）；返回可引用的编号（identifier）。新建任务一律落「待办池(backlog)」⊂ 未授权，执行侧不得自行推进。",
    parameters: {
      title: { type: "string", required: true, description: "任务标题（必填）。" },
      description: { type: "string", description: "任务描述。" },
      acceptance: { type: "string", description: "完成验收标准（FR-94，便于事后快速复核）。" },
      verifyCommand: { type: "string", description: "复核动作 / 验证命令（FR-94）。" },
      project: { type: "string", description: "显式指定目标项目 id；省略则按 cwd 匹配、未匹配回落默认项目。" },
      priority: { type: "string", description: "优先级：none/low/medium/high/urgent（缺省 none）。" },
      owner: { type: "string", description: "负责人 / 角色。" },
      labels: { type: "string", description: "标签（逗号分隔）。" },
      requirement: { type: "string", description: "关联的需求条目编号（归因，便于之后可开工）。" },
      cwd: { type: "string", description: "工作目录；省略则用会话所在目录。" },
    },
    async execute(args, exec) {
      const cwd = args?.cwd ?? exec?.cwd ?? exec?.agent?.cwd ?? null;
      const explicit = typeof args?.project === "string" && args.project.trim() !== "" ? args.project.trim() : null;
      // 目标项目判定：显式指定 > 会话归属项目 > cwd 匹配（含回落）。三档都要能分清"命中"与"回落"。
      let project = null;
      let fallback = false;
      let reason = "explicit";
      if (explicit) {
        project = store.requireProject(explicit);
      } else {
        const bySession = actorOf(exec) ? store.findProjectBySession(actorOf(exec)) : null;
        if (bySession) {
          project = bySession.project;
          reason = "session";
        } else {
          const m = matchProjectForCwd(store, cwd);
          project = m.project;
          fallback = !m.matched;
          reason = m.matched ? "cwd" : "fallback";
        }
      }
      if (!project) throw new TbError("PROJECT_NOT_FOUND", "没有可用项目：请先建项目，或用 project 显式指定目标项目", { cwd });
      // 执行侧不得自建"已授权"卡：一律 backlog（与「backlog 不得执行」同一条红线）。
      const task = store.createTask({
        projectId: project.id,
        title: args?.title,
        description: args?.description,
        acceptance: args?.acceptance,
        verifyCommand: args?.verifyCommand,
        status: "backlog",
        priority: args?.priority,
        owner: args?.owner,
        labels: args?.labels ?? [],
        // P0：归因**随建卡同事务**（旧实现是「先建卡再关联」⇒ 跨项目报错时会留一张孤儿卡，
        // 这正是无归因卡的一个生产源）。现在跨项目直接整笔回滚：**不建卡、不吃编号**。
        requirementId: args?.requirement ?? null,
      });
      const requirement = task.requirementId ?? null;
      changed(task);
      // FR-29 验收要点③：落在默认项目（cwd 未匹配）时**必须有明确提示** —— 由工具返回值如实带出。
      return {
        identifier: task.identifier,
        title: task.title,
        status: task.status,
        project: { id: project.id, name: project.name, workspacePath: project.workspacePath ?? null },
        matchedBy: reason,           // explicit / session / cwd / fallback
        fallback,                    // true = cwd 无法匹配项目，已回落默认项目
        requirementId: requirement,
        hint: fallback
          ? `工作目录 ${cwd ?? "（未知）"} 未匹配任何项目的 workspacePath → **已落到默认项目 ${project.name}（${project.id}）**。若不是你要的项目，请重试并显式传 project=<项目id>。`
          : `已落到项目 ${project.name}（${project.id}），任务编号 ${task.identifier}（新建任务在「待办池」，需人工授权开工）。`,
      };
    },
  });

  reg({
    name: "taskboard_list_tasks",
    description: "列出任务（可按项目/状态/负责人过滤）。",
    parameters: { project: { type: "string" }, status: { type: "string" }, owner: { type: "string" }, cwd: { type: "string" } },
    async execute(args, exec) {
      const project = args?.project ? store.requireProject(args.project) : resolveProjectForCwd(store, args?.cwd ?? exec?.cwd);
      const filter = {};
      if (project) filter.projectId = project.id;
      if (args?.status) filter.status = args.status;
      if (args?.owner) filter.owner = args.owner;
      const tasks = store.listTasks(filter);
      return { count: tasks.length, tasks: tasks.map((t) => ({ identifier: t.identifier, title: t.title, status: t.status, priority: t.priority, owner: t.owner, sessionId: t.sessionId ?? null })) };
    },
  });

  reg({
    name: "taskboard_get_task",
    description: "读取单个任务详情（含评论）。",
    parameters: { ref: { type: "string", required: true } },
    async execute(args) {
      const task = store.requireTaskRef(args.ref);
      return { task, comments: store.listComments(task.id).map((c) => ({ id: c.id, body: c.body, createdAt: c.createdAt })) };
    },
  });

  reg({
    name: "taskboard_claim_task",
    description: "认领任务（todo→进行中），把当前会话写入归属；backlog 未授权不得认领。",
    parameters: { ref: { type: "string", required: true } },
    async execute(args, exec) {
      const actor = actorOf(exec);
      store.assertAttributed(args.ref); // 归因门（共享断言）
      const r = store.startTaskExecution(args.ref, { sessionId: actor }); // backlog→拒绝；todo→in_progress + session
      changed(r.task);
      return { identifier: r.task.identifier, status: r.task.status, sessionId: r.task.sessionId, launch: r.launch };
    },
  });

  reg({
    name: "taskboard_comment",
    description: "在任务下追加评论（执行证据/进展）。",
    parameters: { ref: { type: "string", required: true }, body: { type: "string", required: true } },
    async execute(args) {
      const task = store.requireTaskRef(args.ref);
      const c = store.addComment(task.id, { body: args.body });
      changed(task);
      return { commentId: c.id, taskId: task.identifier };
    },
  });

  reg({
    name: "taskboard_update_status",
    description: "更新任务状态（执行侧可用：进行中/待验收/受阻/取消）；**不得写 done**（人工确认）。置「受阻」时可带 kind（dependency/needs_input/capability/transient）以便分类与循环升级；置「待验收」= **请求评审**（FR-83，欢迎带 comment 说明与触发的疑问）。",
    parameters: { ref: { type: "string", required: true }, status: { type: "string", required: true }, kind: { type: "string" }, reason: { type: "string" }, comment: { type: "string" } },
    async execute(args, exec) {
      const actor = actorOf(exec) ?? "agent";
      // FR-80：置「受阻」走统一分类入口（带类型 + 复发升级）；
      // FR-83：置「待验收」= 请求评审（记来源列，返工才回得去正确的列）；其它状态走原有红线校验
      const task = args.status === "blocked"
        ? store.blockTask(args.ref, { kind: args.kind ?? "transient", reason: args.reason ?? null, actor }).task
        : args.status === "in_review"
          ? store.requestReview(args.ref, { comment: args.comment ?? "", actor }).task
          : store.teamSetTaskStatus(args.ref, { status: args.status, actor }); // 红线：done→GOVERNANCE_AGENT_DONE
      changed(task);
      return { identifier: task.identifier, status: task.status, blockKind: task.blockKind ?? null, blockRecurrences: task.blockRecurrences ?? 0, triageAt: task.triageAt ?? null };
    },
  });

  reg({
    name: "taskboard_heartbeat",
    description: "汇报执行心跳（FR-77）：表示本执行单元仍在推进。心跳缺失不算失败；超过阈值会被回收认领。可带 note 作为进展备注。",
    parameters: { ref: { type: "string", required: true }, note: { type: "string" } },
    async execute(args) {
      const r = store.heartbeatTask(args.ref, { note: args?.note ?? null });
      const claim = store.taskClaimState(args.ref);
      return { ok: r.ok, reason: r.reason ?? null, at: r.at ?? null, claim };
    },
  });

  reg({
    name: "taskboard_list_requirements",
    description: "列出当前项目（或指定项目）的需求条目。",
    parameters: { project: { type: "string" }, cwd: { type: "string" } },
    async execute(args, exec) {
      const project = args?.project ? store.requireProject(args.project) : resolveProjectForCwd(store, args?.cwd ?? exec?.cwd);
      if (!project) return { count: 0, items: [] };
      const items = store.listRequirementItems({ projectId: project.id });
      return { project: project.id, count: items.length, items: items.map((i) => ({ identifier: i.identifier, title: i.title, status: i.status, feasibility: i.feasibility })) };
    },
  });

  return () => { for (const d of disposers) { try { d?.(); } catch { /* ignore */ } } };
}
