#!/usr/bin/env node
/**
 * tb —— 命令行接口（零依赖）。成功=stdout JSON（含 schemaVersion），退出码 0；
 * 失败=stderr JSON `{schemaVersion,error:{code,message,details?}}`，退出码 2/3/4/5。
 * 数据目录：--data-dir > TB_DATA_DIR > 系统临时目录。
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { EXIT, TbError, toErrorPayload, usageError } from "../src/core/errors.mjs";
import { openStore } from "../src/core/store.mjs";

export const CLI_SCHEMA_VERSION = 2;

const GLOBAL_OPTIONS = new Set(["data-dir", "json", "help", "enforce-governance"]);
const BOOLEAN_OPTIONS = new Set(["json", "help", "enforce-governance", "clear-parent", "clear-labels", "clear-owner", "top-level"]);

const COMMAND_OPTIONS = new Map([
  ["project create", new Set(["name", "id", "workspace-path"])],
  ["project list", new Set()],
  ["project get", new Set()],
  ["task create", new Set(["project", "title", "description", "description-file", "status", "priority", "labels", "owner", "parent", "actor", "requirement", "unattributed-reason"])],
  ["task get", new Set()],
  ["task list", new Set(["project", "status", "priority", "label", "labels", "owner", "parent", "top-level", "sort"])],
  ["task update", new Set(["if-version", "title", "description", "description-file", "status", "priority", "labels", "add-labels", "remove-labels", "clear-labels", "owner", "clear-owner", "parent", "clear-parent", "actor"])],
  ["task delete", new Set(["if-version"])],
  // P0：CLI 原先**完全没有**归因子命令（全文件 0 处 attribution）⇒ 出问题只能手打 HTTP。
  ["task attribution", new Set(["requirement"])],
  ["comment add", new Set(["body", "body-file"])],
  ["comment list", new Set()],
  ["comment edit", new Set(["if-version", "body", "body-file", "actor"])],
  ["comment history", new Set()],
]);

export const USAGE = `tb —— 多项目任务工作台 CLI

用法：tb <资源> <动作> [参数...] [--data-dir <path>]

项目
  tb project create --name <名称> [--id <id>] [--workspace-path <路径>]
  tb project list
  tb project get <项目id>

任务
  tb task create --project <项目id> --title <标题> [--requirement <条目>|--unattributed-reason <理由>]
                 [--description <md>|--description-file <文件>]
                 [--status backlog|todo|in_progress|in_review|done|blocked|canceled]
                 [--priority none|low|medium|high|urgent]
                 [--labels a,b] [--owner <负责人>] [--parent <编号|id>] [--actor human|agent]
  tb task get <编号|id>
  tb task list [--project <id>] [--status <s>] [--priority <p>] [--label <l>]... [--owner <负责人>]
               [--parent <编号|id>] [--top-level] [--sort created|priority]
  tb task update <编号|id> --if-version <N> [--title ...] [--description ...|--description-file ...]
                 [--status ...] [--priority ...] [--labels a,b|--add-labels a|--remove-labels b|--clear-labels]
                 [--owner <负责人>|--clear-owner] [--parent <编号|id>|--clear-parent] [--actor human|agent]
  tb task delete <编号|id> --if-version <N>

评论
  tb comment add <编号|id> --body <md>|--body-file <文件>
  tb comment list <编号|id>
  tb comment edit <编号|id> <评论id> --if-version <N> --body <md>|--body-file <文件> [--actor human|agent]
                  （乐观锁：版本不符退出码 5，不静默覆盖；编辑前原正文自动留痕）
  tb comment history <编号|id> <评论id>

全局
  --data-dir <path>        数据目录（默认 $TB_DATA_DIR 或系统临时目录）
  --enforce-governance     启用治理约束（禁止智能体置 done / 推进 backlog）
  --json                   兼容开关（输出始终为 JSON）
  --help                   显示本帮助
`;

export function parseArgv(argv) {
  const operands = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token === "string" && token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (name === "") throw usageError("空选项名不合法");
      if (BOOLEAN_OPTIONS.has(name)) {
        options[name] = eq === -1 ? true : body.slice(eq + 1) !== "false";
        continue;
      }
      if (eq !== -1) {
        options[name] = body.slice(eq + 1);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) throw usageError(`选项 --${name} 需要一个值`);
      options[name] = next;
      index += 1;
      continue;
    }
    operands.push(token);
  }
  return { operands, options };
}

function assertKnownOptions(command, options) {
  const allowed = COMMAND_OPTIONS.get(command);
  if (!allowed) throw new TbError("UNKNOWN_COMMAND", `未知命令：${command}`);
  for (const name of Object.keys(options)) {
    if (GLOBAL_OPTIONS.has(name)) continue;
    if (!allowed.has(name)) {
      throw new TbError("UNKNOWN_OPTION", `命令 ${command} 不支持选项 --${name}`, { command, allowed: [...allowed] });
    }
  }
}

function readTextOption(options, name, fileField) {
  const inline = options[name];
  const file = options[fileField];
  if (inline !== undefined && file !== undefined) throw usageError(`--${name} 与 --${fileField} 只能二选一`);
  if (file !== undefined) {
    try {
      return readFileSync(file, "utf8");
    } catch (error) {
      throw new TbError("INVALID_FIELD", `无法读取文件 ${file}：${error.message}`, { file });
    }
  }
  return inline;
}

function parseIfVersion(options) {
  const raw = options["if-version"];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new TbError("MISSING_VERSION", "--if-version 必须是 ≥1 的整数", { value: raw });
  return value;
}

function collectLabels(options) {
  const values = [];
  for (const key of ["label", "labels"]) {
    if (options[key] !== undefined) values.push(options[key]);
  }
  return values;
}

export async function execute(command, operands, options, context) {
  const { store } = context;
  const stderr = context.stderr ?? process.stderr;
  switch (command) {
    case "project create": {
      if (operands.length !== 0) throw usageError("project create 不接受位置参数");
      if (!options.name) throw usageError("缺少必需参数 --name");
      return { project: store.createProject({ name: options.name, id: options.id, workspacePath: options["workspace-path"] }) };
    }
    case "project list": {
      const projects = store.listProjects();
      return { projects, count: projects.length };
    }
    case "project get": {
      if (operands.length !== 1) throw usageError("project get 需要 1 个参数：<项目id>");
      return { project: store.requireProject(operands[0]) };
    }
    case "task create": {
      if (operands.length !== 0) throw usageError("task create 不接受位置参数");
      if (!options.project) throw usageError("缺少必需参数 --project <项目id>");
      if (!options.title) throw usageError("缺少必需参数 --title <标题>");
      const task = store.createTask({
        projectId: options.project,
        title: options.title,
        description: readTextOption(options, "description", "description-file"),
        status: options.status,
        priority: options.priority,
        labels: collectLabels(options),
        owner: options.owner,
        parent: options.parent,
        actor: options.actor,
        // P0：建卡即归因（同一事务）。缺省不报错但**必须可见**——否则又是"建完才发现没归因"。
        requirementId: options.requirement,
        unattributedReason: options["unattributed-reason"],
      });
      if (!task.requirementId && !options["unattributed-reason"]) {
        // 走 stderr ⇒ 不污染 stdout 的 JSON（脚本可继续 `| jq .task.identifier`）
        stderr.write(
          `⚠ 任务 ${task.identifier} 未归属需求条目：启动执行/派发团队会被归因门拒绝（EXECUTION_NOT_ATTRIBUTED）。\n` +
            `  补归因：tb task attribution ${task.identifier} --requirement <条目>\n` +
            `  或下次建卡直接带 --requirement <条目>（确实不需要归属时用 --unattributed-reason <理由>）\n`,
        );
      }
      return { task };
    }
    case "task get": {
      if (operands.length !== 1) throw usageError("task get 需要 1 个参数：<编号|id>");
      const task = store.requireTaskRef(operands[0]);
      return { task, comments: store.listComments(task.id) };
    }
    case "task list": {
      const filter = {
        projectId: options.project,
        status: options.status,
        priority: options.priority,
        owner: options.owner,
        labels: collectLabels(options),
        sort: options.sort ?? "created",
      };
      if (options["top-level"] === true) filter.parentId = null;
      else if (options.parent !== undefined) filter.parentId = store.requireTaskRef(options.parent).id;
      const tasks = store.listTasks(filter);
      return { tasks, count: tasks.length };
    }
    case "task update": {
      if (operands.length !== 1) throw usageError("task update 需要 1 个参数：<编号|id>");
      const changes = { expectedVersion: parseIfVersion(options), actor: options.actor ?? "human" };
      if (options.title !== undefined) changes.title = options.title;
      const description = readTextOption(options, "description", "description-file");
      if (description !== undefined) changes.description = description;
      if (options.status !== undefined) changes.status = options.status;
      if (options.priority !== undefined) changes.priority = options.priority;
      if (options.labels !== undefined) changes.labels = options.labels;
      if (options["add-labels"] !== undefined) changes.addLabels = options["add-labels"];
      if (options["remove-labels"] !== undefined) changes.removeLabels = options["remove-labels"];
      if (options["clear-labels"] === true) changes.labels = [];
      if (options.owner !== undefined) changes.owner = options.owner;
      if (options["clear-owner"] === true) changes.owner = null;
      if (options.parent !== undefined) changes.parentId = options.parent;
      if (options["clear-parent"] === true) changes.clearParent = true;
      return { task: store.updateTask(operands[0], changes) };
    }
    case "task attribution": {
      if (operands.length !== 1) throw usageError("task attribution 需要 1 个参数：<编号|id>");
      if (!options.requirement) throw usageError("缺少必需参数 --requirement <需求条目标识>");
      const task = store.associateRequirementTask(options.requirement, operands[0]);
      return { task };
    }
    case "task delete": {
      if (operands.length !== 1) throw usageError("task delete 需要 1 个参数：<编号|id>");
      return { deleted: store.deleteTask(operands[0], { expectedVersion: parseIfVersion(options) }) };
    }
    case "comment add": {
      if (operands.length !== 1) throw usageError("comment add 需要 1 个参数：<编号|id>");
      const body = readTextOption(options, "body", "body-file");
      if (body === undefined) throw usageError("缺少 --body 或 --body-file");
      return { comment: store.addComment(operands[0], { body }) };
    }
    case "comment list": {
      if (operands.length !== 1) throw usageError("comment list 需要 1 个参数：<编号|id>");
      const comments = store.listComments(operands[0]);
      return { comments, count: comments.length };
    }
    // FR-17：编辑评论（任务引用 + 评论 id 都要给，防误编辑）。`--if-version` 是**必填**的乐观锁。
    case "comment edit": {
      if (operands.length !== 2) throw usageError("comment edit 需要 2 个参数：<编号|id> <评论id>");
      const body = readTextOption(options, "body", "body-file");
      if (body === undefined) throw usageError("缺少 --body 或 --body-file");
      const task = store.requireTaskRef(operands[0]);
      const existing = store.getComment(operands[1]);
      if (!existing || existing.taskId !== task.id) throw new TbError("COMMENT_NOT_FOUND", `评论不存在于任务 ${task.identifier}：${operands[1]}`, { commentId: operands[1], identifier: task.identifier });
      const result = store.updateComment(operands[1], {
        expectedVersion: parseIfVersion(options),
        body,
        actor: options.actor === "agent" ? "agent" : "human",
      });
      return { comment: result.comment, changed: result.changed, revision: result.revision ?? null };
    }
    case "comment history": {
      if (operands.length !== 2) throw usageError("comment history 需要 2 个参数：<编号|id> <评论id>");
      const task = store.requireTaskRef(operands[0]);
      const existing = store.getComment(operands[1]);
      if (!existing || existing.taskId !== task.id) throw new TbError("COMMENT_NOT_FOUND", `评论不存在于任务 ${task.identifier}：${operands[1]}`, { commentId: operands[1], identifier: task.identifier });
      const revisions = store.listCommentRevisions(operands[1]);
      return { comment: existing, revisions, count: revisions.length };
    }
    default:
      throw new TbError("UNKNOWN_COMMAND", `未知命令：${command}`);
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  let store = null;
  try {
    const { operands, options } = parseArgv(argv);
    if (options.help === true || operands.length === 0) {
      stderr.write(USAGE);
      return EXIT.USAGE;
    }
    const command = `${operands[0]} ${operands[1] ?? ""}`.trim();
    if (!COMMAND_OPTIONS.has(command)) {
      throw new TbError("UNKNOWN_COMMAND", `未知命令：${command || "(空)"}`, { known: [...COMMAND_OPTIONS.keys()] });
    }
    assertKnownOptions(command, options);
    store = openStore({
      dataDir: options["data-dir"],
      env,
      policy: { enforce: options["enforce-governance"] === true },
    });
    const payload = await execute(command, operands.slice(2), options, { store, env, stderr });
    stdout.write(`${JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, ...payload }, null, 2)}\n`);
    return EXIT.OK;
  } catch (error) {
    const { error: errorPayload, exitCode } = toErrorPayload(error);
    stderr.write(`${JSON.stringify({ schemaVersion: CLI_SCHEMA_VERSION, error: errorPayload }, null, 2)}\n`);
    return exitCode;
  } finally {
    try {
      store?.close();
    } catch {
      /* ignore */
    }
  }
}

const entryHref = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entryHref === import.meta.url) {
  const code = await main();
  process.exitCode = code;
}
