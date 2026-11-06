/**
 * flow-inject.mjs —— 开局注入的**唯一实现**（P5 档 C · 卡 `-210` · 需求 `R128`）
 *
 * 方案依据：`skills/taskboard-flow/references/injection.md`（三档装载 + 分层注入策略）。
 * 接线前的事实：`flow_inject_policy` 是**全仓无 reader 的静默缺口**（卡 `-186` 用守卫钉住），
 * 本文件就是那个 reader —— 从此改它**真的会改变行为**。
 *
 * 三档里的位置：
 *   · 档 A（人贴 `tb-flow start`）/ 档 B（项目 `AGENTS.md` 约定）＝ 已可用，与本文件无关；
 *   · **档 C（宿主自动注入）＝ 本文件 + `index.js` 的 `createSession()` 出口**；
 *   · 人工一次性投递（`tb-flow inject --session`）也走本文件 ⇒ **只有一条注入实现**。
 *
 * 四条硬约束（对应验收 ①③④⑤）：
 *   ① **内容只有一个生成器**：完整版 = `buildFlowBlock().text`（与 `tb-flow start` / MCP `prompts/get`
 *      **逐字节相同**）；摘要版 = `buildFlowSummary(block)`（由同一个 block 剪裁，不另写规则）；
 *   ② **失败不阻断调用方**：本模块**从不抛错**，一律返回 `{ injected, delivered, reason, ... }`，
 *      宿主/HTTP/CLI 自行决定怎么报（会话创建流程不得被注入异常打断）；
 *   ③ **每次投递留审计**：成功即写 `flow_injections`（六字段：session_id / project_id / policy /
 *      contract_version / digest / injected_at）；`digest = sha256(实际投出的正文)`，可事后核「投的是哪一版」；
 *   ④ **默认零行为变化**：`flow_inject_policy` 缺省 `off` ⇒ 不构建、不投递、不写行。
 *
 * 依赖方向：本模块在 `src/core/`，但只 import `flow-block.mjs` 这个**纯文本生成器**（不 import 任何 MCP
 * 协议 / stdio 代码）；这样宿主、HTTP、CLI 三处能共用同一段判定，不会出现「六个入口两种语义」。
 */
import { sha256 } from "./contract.mjs";
import { TbError } from "./errors.mjs";
import { buildFlowBlock, buildFlowSummary } from "../mcp/flow-block.mjs";
import { resolveProject } from "../mcp/tools.mjs";

/** 自动注入策略（`project_settings.flow_inject_policy` 的合法取值）。默认 `off`。 */
export const DEFAULT_FLOW_INJECT_POLICY = "off";
export const FLOW_INJECT_POLICIES = Object.freeze(["off", "main-only", "main+exec", "all"]);
/** 人工一次性投递的审计标签（`tb-flow inject --session`）：它显式绕过 `off`，所以必须能被区分出来。 */
export const FLOW_INJECT_MANUAL = "manual";
/** 会话角色：主会话（完整版）/ 执行会话（摘要版）/ 关联会话（摘要版）/ 子 agent（**永不注入**）。 */
export const FLOW_INJECT_ROLES = Object.freeze(["main", "exec", "related", "subagent"]);
/** 摘要版 token 上限（验收 ④）。用 `estimateFlowTokens()` 度量，口径见该函数。 */
export const FLOW_INJECT_SUMMARY_MAX_TOKENS = 300;
/** 审计表 `policy` 列的合法取值（四个策略 + 人工）。 */
export const FLOW_INJECT_AUDIT_VALUES = Object.freeze([...FLOW_INJECT_POLICIES, FLOW_INJECT_MANUAL]);

/**
 * 归一化策略值。空值 ⇒ 默认 `off`；非法值 ⇒ `null`（`strict` 时抛 `INVALID_FLOW_INJECT_POLICY`）。
 * 只做形状归一（大小写 / 下划线与连字符），**不猜语义**。
 */
export function normalizeFlowInjectPolicy(value, { strict = false } = {}) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (raw === "") return DEFAULT_FLOW_INJECT_POLICY;
  const canon = raw === "main-exec" ? "main+exec" : raw;
  if (FLOW_INJECT_AUDIT_VALUES.includes(canon)) return canon;
  if (strict) {
    throw new TbError(
      "INVALID_FLOW_INJECT_POLICY",
      `flow_inject_policy 只能是 ${FLOW_INJECT_POLICIES.join(" / ")}（收到 ${JSON.stringify(value)}）`,
      { value: value ?? null, allowed: FLOW_INJECT_POLICIES },
    );
  }
  return null;
}

/**
 * 纯判定：这条会话该不该注入、注入哪一版。**不读库、不投递、不写审计** —— 所以能单测、能被任何入口复用。
 *
 * 角色 × 策略矩阵（`✓` = 注入）：
 *
 * | 角色 \ 策略 | off | main-only | main+exec | all | manual |
 * |---|---|---|---|---|---|
 * | main    | — | ✓ 完整版 | ✓ 完整版 | ✓ 完整版 | ✓ 完整版 |
 * | exec    | — | — | ✓ 摘要版 | ✓ 摘要版 | ✓ 摘要版 |
 * | related | — | — | — | ✓ 摘要版 | ✓ 摘要版 |
 * | subagent| — | — | — | —（**硬规则：子 agent 永不注入**） | — |
 *
 * `manual` 只给 `tb-flow inject --session` 用：人显式要求时不受 `off` 约束，但**子 agent 仍不注入**
 * （子 agent 由父会话派活，塞流程只会稀释它自己的任务上下文 —— 这条不因"人工"而放开）。
 *
 * @returns {{inject:boolean, version:"full"|"summary"|null, reason:string}}
 */
export function decideFlowInjection({ policy = DEFAULT_FLOW_INJECT_POLICY, role = null } = {}) {
  const p = normalizeFlowInjectPolicy(policy);
  if (!p) return { inject: false, version: null, reason: "policy-invalid" };
  const r = String(role ?? "").trim() || null;
  if (!r) return { inject: false, version: null, reason: "role-unknown" };
  if (!FLOW_INJECT_ROLES.includes(r)) return { inject: false, version: null, reason: "role-invalid" };
  if (r === "subagent") return { inject: false, version: null, reason: "subagent-never" };
  if (p === "off") return { inject: false, version: null, reason: "policy-off" };
  if (p === "main-only" && r !== "main") return { inject: false, version: null, reason: "policy-main-only" };
  if (p === "main+exec" && r === "related") return { inject: false, version: null, reason: "policy-main+exec" };
  return { inject: true, version: r === "main" ? "full" : "summary", reason: "ok" };
}

/**
 * 估算 tokens（**保守上界**：CJK 一字算 1、其余 4 字符算 1 —— 宁可高估）。
 * 用于验收 ④「摘要版 ≤ 300 tokens」，不追求与某个具体 tokenizer 对齐。
 */
export function estimateFlowTokens(text) {
  const s = String(text ?? "");
  const cjk = (s.match(/[\u2e80-\u9fff\uff00-\uffef\u3000-\u303f]/g) ?? []).length;
  const rest = Math.max(0, s.length - cjk);
  return Math.ceil(cjk + rest / 4);
}

/**
 * 注入一次（唯一入口）。**不抛错**：任何异常都收成 `{ injected:false, reason }`。
 *
 * @param {object}   opts
 * @param {object}   opts.store       已打开的 store（缺 ⇒ `no-store`）
 * @param {Function} opts.deliver     `(sessionId, text) => Promise<{sent|delivered, reason?}>`
 * @param {string}   [opts.projectId] 项目 id（优先；宿主建会话时调用方已知）
 * @param {object}   [opts.project]   项目对象（给了就不再查库）
 * @param {string}   opts.sessionId   目标会话
 * @param {string}   [opts.role]      `main` / `exec` / `related` / `subagent`
 * @param {string}   [opts.cwd]       未给 projectId 时按工作区匹配项目
 * @param {string}   [opts.policy]    显式策略（缺省读项目设置；`manual` = 人工一次性投递）
 * @param {string}   [opts.source]    审计来源标记（`createSession` / `tb-flow-cli` / `api`），只回带不落库
 * @returns {Promise<{injected:boolean, delivered:boolean, reason:string, sessionId:string|null,
 *   projectId:string|null, policy:string|null, role:string|null, version:string|null,
 *   contractVersion:string|null, digest:string|null, chars:number, injectedAt:string|null,
 *   injectionId:number|null, auditRecorded:boolean, text:string|null, source:string}>}
 */
export async function injectFlow({
  store = null,
  deliver = null,
  projectId = null,
  project = null,
  sessionId = null,
  role = null,
  cwd = null,
  policy = null,
  source = "manual",
} = {}) {
  const out = {
    injected: false, delivered: false, reason: "inject-error",
    sessionId: sessionId ?? null, projectId: projectId ?? null, policy: null, role: role ?? null,
    version: null, contractVersion: null, digest: null, chars: 0,
    injectedAt: null, injectionId: null, auditRecorded: false, text: null, source,
  };
  try {
    if (!store) return { ...out, reason: "no-store" };
    if (!sessionId) return { ...out, reason: "no-session" };

    let proj = project && typeof project === "object" ? project : null;
    if (!proj) {
      proj = projectId
        ? store.requireProject(String(projectId))
        : resolveProject(store, { cwd: cwd ?? process.cwd() }).project;
    }
    out.projectId = proj.id;

    const configured = policy === null || policy === undefined
      ? (normalizeFlowInjectPolicy(store.getProjectSettings(proj.id)?.flowInjectPolicy) ?? DEFAULT_FLOW_INJECT_POLICY)
      : (normalizeFlowInjectPolicy(policy) ?? String(policy));
    const decision = decideFlowInjection({ policy: configured, role });
    // 审计里记**实际生效的**那个值；非法值原样记下来（便于追「谁写坏了配置」）。
    out.policy = normalizeFlowInjectPolicy(configured) ?? String(configured);
    if (!decision.inject) return { ...out, reason: decision.reason };

    const block = buildFlowBlock({ store, project: proj, matchedBy: "explicit" });
    const text = decision.version === "full" ? block.text : buildFlowSummary(block);
    out.version = decision.version;
    out.contractVersion = block.contract?.version ?? null;
    out.digest = sha256(text);
    out.chars = text.length;
    out.text = text;

    if (typeof deliver !== "function") return { ...out, reason: "no-delivery-channel" };
    const sent = await deliver(sessionId, text);
    out.delivered = Boolean(sent?.sent ?? sent?.delivered ?? false);
    if (!out.delivered) return { ...out, reason: sent?.reason ?? "delivery-failed" };
    out.injected = true;
    out.reason = "ok";

    // 审计写失败**不回退投递结论**：内容确实进了会话，谎报"没注入"会让调用方重复注入。
    try {
      const row = store.recordFlowInjection({
        projectId: proj.id, sessionId, policy: out.policy,
        contractVersion: out.contractVersion, digest: out.digest,
      });
      out.injectionId = row.id;
      out.injectedAt = row.injectedAt;
      out.auditRecorded = true;
    } catch (error) {
      out.auditRecorded = false;
      out.reason = "injected-audit-failed";
      out.auditError = error?.code ?? String(error?.message ?? error ?? "audit-failed");
    }
    return out;
  } catch (error) {
    return { ...out, reason: error?.code ?? String(error?.message ?? error ?? "inject-error") };
  }
}
