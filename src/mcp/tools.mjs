/**
 * tools.mjs —— MCP 只读四工具（P2 · 2026-10-29）
 *
 * 方案依据：`docs/设计/技能化与MCP契约-架构变更方案-2026-10-28.md`
 *   §6.1（stdio、同一份 SQLite、零宿主改动）· §6.2（工具清单）· §7.3（workbench_audit 四类漂移）
 *
 * 工具分两批：
 *   · **只读四件**（P2）：`flow_start` / `project_info` / `norm_get` / `workbench_audit`；
 *   · **写四件 + 条目列表**（P3）：`requirement_list` / `requirement_upsert` / `requirement_change`
 *     / `card_create` / `card_progress`。
 *
 * 只读四条的硬约束：
 *   ① **不写库**：这里不调用任何 create/update/delete/record*；`contractSnapshot` 与
 *      `listGovernanceAudit` 都是纯读（P1 已钉住「GET /contract 零副作用」）；
 *   ② **不建目录、不建文档**：`resolveContext()` 会 `ensureRequirementDoc`（写），故这里只用
 *      `matchProjectForCwd()` + `getRequirementDoc()`（读）；
 *   ③ **同一份真源**：数据来自 `openStore({dataDir})` 打开的**同一个** `taskboard.sqlite`，
 *      与 Web/CLI 读写同一库 —— MCP 不是第二份数据。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateSubmittedContract, loadNorms, NORM_IDS, sha256 } from "../core/contract.mjs";
import { TbError } from "../core/errors.mjs";
import { matchProjectForCwd } from "../core/binding.mjs";

/** 包根目录（仓库里 = 仓库根；npm 包里 = package 根）。`spec/norms` 在两处都随包存在。 */
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NORMS_DIR = path.join(PKG_ROOT, "spec", "norms");

const TERMINAL = new Set(["done", "canceled"]);
const countBy = (rows, key = "status") => rows.reduce((acc, row) => {
  const k = row[key] ?? "unknown";
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});

/** 统一错误：MCP 把 `code` 放在返回体里（不是 JSON-RPC error —— 那是协议层错误）。 */
const fail = (code, message, details = null) => new TbError(code, message, details ?? {});

export function resolveProject(store, { project, cwd } = {}) {
  if (typeof project === "string" && project.trim() !== "") return { project: store.requireProject(project.trim()), matchedBy: "explicit" };
  const m = matchProjectForCwd(store, cwd ?? process.cwd());
  if (!m.project) throw fail("PROJECT_NOT_FOUND", "没有任何项目：先建项目，或显式传 project", { cwd: cwd ?? process.cwd() });
  return { project: m.project, matchedBy: m.matched ? "cwd" : "fallback" };
}

export function projectGaps(store, project) {
  const tasks = store.listTasks({ projectId: project.id });
  const live = tasks.filter((t) => !TERMINAL.has(t.status));
  const unattributed = live.filter((t) => !t.requirementId);
  const docs = store.listRequirementDocs({ projectId: project.id });
  const pendingCandidates = docs.reduce((n, doc) => n + store.listRequirementCandidates({ docId: doc.id, status: "pending" }).length, 0);
  const items = store.listRequirementItems({ projectId: project.id });
  const withTasks = new Set(tasks.map((t) => t.requirementId).filter(Boolean));
  return {
    tasks,
    items,
    docs,
    gaps: {
      unattributedTasks: unattributed.length,
      unattributedSamples: unattributed.slice(0, 5).map((t) => t.identifier),
      pendingCandidates,
      unboundSession: !project.initialSessionId,
      requirementsWithoutTasks: items.filter((i) => i.status === "open" && !withTasks.has(i.id)).length,
      tasksInReview: live.filter((t) => t.status === "in_review").length,
      tasksBlocked: live.filter((t) => t.status === "blocked").length,
    },
  };
}

/**
 * 下一步建议（纯推导，不写库）。
 * 顺序对齐 §5.2 的 S1→S7：先把需求说清，再建卡，再由**人**授权，再派发/回填，最后由**人**验收。
 */
export function deriveFlowNext({ tasks, items, gaps }) {
  const by = countBy(tasks);
  if (items.length === 0) return { step: "S1", title: "录需求条目", why: "项目还没有需求条目 —— 没有条目就没有可归因的卡", humanAction: null };
  if (gaps.pendingCandidates > 20) return { step: "S1", title: "先清理待确认候选", why: `待确认候选 ${gaps.pendingCandidates} 条（阈值 20）—— 先确认/丢弃，避免候选洪水`, humanAction: null };
  if (gaps.unattributedTasks > 0) return { step: "S2", title: "补归因（先于派发）", why: `${gaps.unattributedTasks} 张未完成卡没有归属需求条目；派发会被归因门拒绝`, humanAction: null };
  if ((by.backlog ?? 0) > 0) return { step: "S3", title: "授权开工（人）", why: `${by.backlog} 张卡在待办池；backlog → todo 只能由人点`, humanAction: "authorize" };
  if ((by.todo ?? 0) > 0) return { step: "S4", title: "派发 / 执行", why: `${by.todo} 张卡已授权待执行`, humanAction: null };
  if ((by.in_progress ?? 0) > 0) return { step: "S5", title: "回填进度 + 证据", why: `${by.in_progress} 张卡在执行中；每条进展要带可核验证据`, humanAction: null };
  if ((by.in_review ?? 0) > 0) return { step: "S7", title: "验收点完成（人）", why: `${by.in_review} 张卡待验收；done 只能由人确认`, humanAction: "accept" };
  return { step: "S1", title: "补需求 / 收口", why: "当前没有待处理的卡；继续拆下一条需求或收口已完成条目", humanAction: null };
}

/** `norm_get` 里 `project` 这一档：读项目自有补充（AGENTS.md），只读、限长、明确"不得覆盖四道门"。 */
function readProjectNorm(project) {
  const wp = project?.workspacePath;
  if (!wp) return { norm: "project", found: false, file: null, body: "", note: "该项目没有 workspacePath，无法读取项目侧补充规范" };
  const file = path.join(wp, "AGENTS.md");
  if (!existsSync(file)) return { norm: "project", found: false, file, body: "", note: "项目工作区没有 AGENTS.md（无补充约定）" };
  const raw = readFileSync(file, "utf8");
  const MAX = 20000;
  return {
    norm: "project",
    found: true,
    file,
    truncated: raw.length > MAX,
    body: raw.length > MAX ? `${raw.slice(0, MAX)}\n\n…（已截断，原文 ${raw.length} 字符）` : raw,
    note: "项目侧补充：只可「追加 / 参数化」，**不得覆盖**八步顺序与四道门（人工校验 / 归因 / 授权 / 评审）；done 只能人置。",
  };
}

function buildNormNotice(contract) {
  const flow = (contract?.norms ?? []).find((n) => n.id === "flow");
  const short = flow ? `${flow.digest.slice(0, 8)}…` : "（未取到）";
  return [
    `本流程使用的规范：spec/norms/flow.md @ v${flow?.version ?? "?"}（digest ${short}）`,
    "你可以：",
    '  · 查看：norm_get { norm: "flow" }        ← 一屏读完',
    "  · 替换：把自有规范放到 <workspace>/AGENTS.md（由 norm:project 叠加）",
    "  · 只改参数：verifyCommand / workspacePath / notApplicable（3 类白名单）",
    "⚠ 八步顺序与四道门（人工校验/归因/授权/评审）不可覆盖；done 只能人点。",
  ].join("\n");
}

/* ------------------------------------------------------------------ 四个工具 ---- */

export function flowStart({ store }, args = {}) {
  const { project, matchedBy } = resolveProject(store, args);
  const { tasks, items, gaps } = projectGaps(store, project);
  const snap = store.contractSnapshot(project.id);
  return {
    project: { id: project.id, name: project.name, workspacePath: project.workspacePath ?? null, initialSessionId: project.initialSessionId ?? null },
    matchedBy,
    contract: {
      version: snap.snapshot.contractVersion,
      docVersion: snap.snapshot.docVersion,
      docDigest: snap.snapshot.docDigest,
      gates: snap.snapshot.gates,
      norms: snap.snapshot.norms,
      baselineStale: snap.stale,
      changed: snap.changed,
    },
    state: { tasks: tasks.length, tasksByStatus: countBy(tasks), requirements: items.length, requirementsByStatus: countBy(items) },
    gaps,
    nextStep: deriveFlowNext({ tasks, items, gaps }),
    normNotice: buildNormNotice(snap.snapshot),
  };
}

export function projectInfo({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const { tasks, items, docs, gaps } = projectGaps(store, project);
  const snap = store.contractSnapshot(project.id);
  return {
    project,
    contract: { version: snap.snapshot.contractVersion, baseline: snap.baseline?.contractVersion ?? null, stale: snap.stale, changed: snap.changed },
    counts: { tasks: tasks.length, tasksByStatus: countBy(tasks), requirements: items.length, requirementsByStatus: countBy(items), requirementDocs: docs.length },
    gaps,
  };
}

export function normGet({ store }, args = {}) {
  const norm = typeof args.norm === "string" ? args.norm.trim() : "";
  if (norm === "project") {
    const { project } = resolveProject(store, args);
    return readProjectNorm(project);
  }
  const allowed = [...NORM_IDS, "project"];
  if (!allowed.includes(norm)) throw fail("NORM_NOT_FOUND", `未知规范：${norm || "(空)"}`, { allowed });
  let norms;
  try { norms = loadNorms(NORMS_DIR); }
  catch (error) { throw fail("NORM_NOT_FOUND", `机器规范目录不可用：${NORMS_DIR}`, { reason: error?.message ?? String(error) }); }
  const hit = norms.find((n) => n.id === norm);
  if (!hit) throw fail("NORM_NOT_FOUND", `机器规范里没有：${norm}`, { allowed: NORM_IDS });
  return { norm: hit.id, version: hit.version, updated: hit.updated, appliesTo: hit.appliesTo, digest: hit.digest, file: hit.relPath, body: hit.body };
}

export function workbenchAudit({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const sinceHours = Number.isFinite(Number(args.sinceHours)) && Number(args.sinceHours) > 0 ? Number(args.sinceHours) : 168;
  const sinceMs = Date.now() - sinceHours * 3600 * 1000;
  const { tasks, gaps } = projectGaps(store, project);

  // ① contract-stale：内核 warn 档留下的审计（P1.5）——「有 agent 用旧契约写过东西」
  const warns = store.listGovernanceAudit({ action: "contract-warn" })
    .filter((r) => Date.parse(r.at) >= sinceMs)
    .filter((r) => String(r.target ?? "").startsWith(`${project.id}-`) || r.target === project.id);
  // ② unattributed：未完成且无归因的卡
  const unattributed = tasks.filter((t) => !TERMINAL.has(t.status) && !t.requirementId);
  // ③ unbound-session：项目主会话未绑定
  const unbound = project.initialSessionId ? [] : [project.id];
  // ④ candidate-flood：待确认候选超阈值
  const threshold = 20;
  const flood = gaps.pendingCandidates > threshold;

  const items = [
    { type: "contract-stale", count: warns.length, samples: warns.slice(-5).map((r) => ({ at: r.at, actor: r.actor, target: r.target })), remedy: "重取 flow_start，按 changed[] 重读变更部分；新版本随返回体的 contract.version" },
    { type: "unattributed", count: unattributed.length, samples: unattributed.slice(0, 5).map((t) => t.identifier), remedy: "先补归因（requirement / unattributedReason），再派发 —— 否则归因门会拒" },
    { type: "unbound-session", count: unbound.length, samples: unbound, remedy: "在任务工作台里为项目「重建/绑定主会话」，否则投递会落空" },
    { type: "candidate-flood", count: gaps.pendingCandidates, threshold, over: flood, samples: [], remedy: `先确认/丢弃候选再跑条目化（当前 ${gaps.pendingCandidates} 条，阈值 ${threshold}）` },
  ];
  return {
    project: { id: project.id, name: project.name },
    sinceHours,
    items,
    ok: items.every((i) => i.count === 0 || i.type === "candidate-flood" && !i.over),
    summary: items.filter((i) => i.count > 0).map((i) => `${i.type}=${i.count}${i.type === "candidate-flood" ? `/${i.threshold}` : ""}`),
  };
}

/* --------------------------------------------------- P3：写工具 + 条目列表 ---- */

const EVIDENCE_KINDS = Object.freeze(["file", "command", "url", "reading"]);
/** 条目「版本」：`requirement_items` 没有 version 列 ⇒ 用**内容摘要**当乐观锁（纯读、可重算、与行数无关）。 */
const REQ_VERSION_FIELDS = Object.freeze(["title", "description", "acceptance", "priority", "status"]);

function requirementVersion(item) {
  if (!item) return null;
  return sha256(REQ_VERSION_FIELDS.map((k) => String(item[k] ?? "")).join("\u0000")).slice(0, 12);
}

function requirementSnapshot(item) {
  const out = { identifier: item.identifier };
  for (const k of REQ_VERSION_FIELDS) out[k] = item[k] ?? "";
  out.version = requirementVersion(item);
  return out;
}

function readCardUpdateNorm() {
  return loadNorms(NORMS_DIR).find((n) => n.id === "card-update") ?? null;
}

/**
 * 写工具返回体里统一带一份「我这次用的契约 vs 当前契约」的读数。
 *
 * **不阻断**：D2 仍处 `warn` 档（用户拍板 A：先建写工具、契约校验保持 warn，切 `reject` 另行拍板）。
 * 这里只把 verdict 明明白白回给 agent —— 让它自己知道「我拿的是旧规范」；真正的落库留痕在 `store`。
 */
function contractReadout(store, projectId, submitted) {
  if (!submitted || typeof submitted !== "object") return { verdict: "skipped", problems: [] };
  const snap = store.contractSnapshot(projectId);
  const verdict = evaluateSubmittedContract(snap.snapshot, submitted);
  return { verdict: verdict.verdict, problems: verdict.problems, current: snap.snapshot.contractVersion };
}

/** 形状即约束：`evidence[]` 非空 + 每项 `{kind∈4, ref 非空}`。 */
function normalizeEvidence(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw fail(
      "EVIDENCE_REQUIRED",
      "回填进度必须带 evidence[]（非空数组），每项 {kind, ref, note?}；只写「已完成」三个字不算证据",
      { allowedKinds: EVIDENCE_KINDS },
    );
  }
  return list.map((raw, i) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw fail("EVIDENCE_INVALID", `evidence[${i}] 必须是对象 {kind, ref, note?}`, { index: i });
    }
    const kind = String(raw.kind ?? "").trim();
    if (!EVIDENCE_KINDS.includes(kind)) {
      throw fail("EVIDENCE_INVALID", `evidence[${i}].kind 必须是 ${EVIDENCE_KINDS.join(" / ")} 之一`, { index: i, received: kind, allowedKinds: EVIDENCE_KINDS });
    }
    const ref = String(raw.ref ?? "").trim();
    if (ref === "") {
      throw fail("EVIDENCE_INVALID", `evidence[${i}].ref 不能为空（命令原文 / 文件路径 / URL / 读数）`, { index: i });
    }
    return { kind, ref, note: raw.note == null ? "" : String(raw.note).trim() };
  });
}

/** 同一批证据的稳定指纹（顺序敏感；用于「同一次回填重复调用」去重，而不是内容判重）。 */
function evidenceHash(list) {
  return sha256(JSON.stringify(list.map((e) => [e.kind, e.ref, e.note]))).slice(0, 16);
}

/* ---------------- requirement_list（只读） ---------------- */

export function requirementList({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const status = typeof args.status === "string" && args.status.trim() !== "" ? args.status.trim() : undefined;
  const items = store.listRequirementItems({ projectId: project.id, status });
  const byReq = new Map();
  for (const t of store.listTasks({ projectId: project.id })) {
    if (!t.requirementId) continue;
    const arr = byReq.get(t.requirementId) ?? [];
    arr.push(t);
    byReq.set(t.requirementId, arr);
  }
  return {
    project: { id: project.id, name: project.name },
    count: items.length,
    items: items.map((item) => {
      const linked = byReq.get(item.id) ?? [];
      const done = linked.filter((t) => t.status === "done").length;
      return {
        identifier: item.identifier,
        title: item.title,
        status: item.status,
        priority: item.priority,
        version: requirementVersion(item),
        tasks: { total: linked.length, done, open: linked.length - done },
      };
    }),
  };
}

/* ---------------- requirement_upsert（写） ---------------- */

export function requirementUpsert({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const contract = contractReadout(store, project.id, args.contract);
  const refCandidate = [args.id, args.requirement].find((x) => typeof x === "string" && x.trim() !== "");
  const ref = refCandidate ? refCandidate.trim() : "";

  if (ref !== "") {
    const current = store.requireRequirementItemRef(ref);
    if (current.projectId !== project.id) {
      throw fail("DEPENDENCY_CROSS_PROJECT", `条目属于别的项目：${ref}（${current.projectId}）`, { requirement: ref, requirementProject: current.projectId, project: project.id });
    }
    const expected = args.expected_version == null ? "" : String(args.expected_version).trim();
    if (expected === "") {
      throw fail("MISSING_VERSION", "改条目必须带 expected_version（= requirement_list 返回的 version）", { identifier: current.identifier, currentVersion: requirementVersion(current) });
    }
    if (expected !== requirementVersion(current)) {
      throw fail("VERSION_CONFLICT", "条目已被他人修改，请重新 requirement_list 后再提交（不静默覆盖）", { identifier: current.identifier, expectedVersion: expected, currentVersion: requirementVersion(current) });
    }
    const patch = {};
    for (const k of REQ_VERSION_FIELDS) if (args[k] !== undefined) patch[k] = args[k];
    if (Object.keys(patch).length === 0) throw fail("USAGE_ERROR", `没有任何可改字段（${REQ_VERSION_FIELDS.join(" / ")}）`, {});
    const updated = store.updateRequirementItem(current.identifier, { ...patch, contract: args.contract });
    return { created: false, item: requirementSnapshot(updated), changed: Object.keys(patch), contract };
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title === "") throw fail("INVALID_TITLE", "新建条目需要 title（改已有条目请给 id / requirement + expected_version）", {});
  const created = store.createRequirementItem({
    projectId: project.id,
    title,
    description: args.description,
    acceptance: args.acceptance,
    priority: args.priority,
    status: args.status,
    contract: args.contract,
  });
  return { created: true, item: requirementSnapshot(created), contract };
}

/* ---------------- requirement_change（写 · 变更影响面确认门） ---------------- */

export function requirementChange({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const ref = [args.requirement, args.id].find((x) => typeof x === "string" && x.trim() !== "");
  if (!ref) throw fail("USAGE_ERROR", "requirement_change 需要 requirement（条目编号或 id）", {});
  const item = store.requireRequirementItemRef(ref.trim());
  if (item.projectId !== project.id) {
    throw fail("DEPENDENCY_CROSS_PROJECT", `条目属于别的项目：${ref}（${item.projectId}）`, { requirement: ref, requirementProject: item.projectId, project: project.id });
  }
  const reason = String(args.reason ?? "").trim();
  if (reason === "") {
    throw fail("CHANGE_REASON_REQUIRED", "需求变更必须写 reason（为什么改）—— 没有理由的变更事后无法复盘", { identifier: item.identifier });
  }
  const patchRaw = args.patch && typeof args.patch === "object" && !Array.isArray(args.patch) ? args.patch : {};
  const patch = {};
  for (const k of REQ_VERSION_FIELDS) if (patchRaw[k] !== undefined) patch[k] = patchRaw[k];
  if (Object.keys(patch).length === 0) {
    throw fail("USAGE_ERROR", `patch 至少改一个字段（${REQ_VERSION_FIELDS.join(" / ")}）`, {});
  }

  const before = requirementSnapshot(item);
  const after = { ...before };
  for (const [k, v] of Object.entries(patch)) after[k] = v;
  // 影响面：这条需求下**所有未终态**的卡（改需求时它们可能已经按旧口径做了一半）
  const affectedCards = store.listTasksByRequirement(item.identifier)
    .map((t) => ({ identifier: t.identifier, title: t.title, status: t.status, terminal: TERMINAL.has(t.status) }));
  const affected = affectedCards.filter((c) => !c.terminal);

  // `change_id` 覆盖「哪条需求 + 改之前是什么样 + 改成什么」⇒ **条目在预览后被改过，id 自动失效**（无状态、无需存表）
  const changeId = sha256(JSON.stringify([item.identifier, before.version, Object.keys(patch).sort().map((k) => [k, String(patch[k])])])).slice(0, 12);

  if (args.apply !== true) {
    store.recordAudit({ actor: "agent", action: "requirement-change-preview", target: item.identifier, allowed: true, reason: "preview", detail: `${Object.keys(patch).join(",")} change=${changeId}（未落地）` });
    return {
      applied: false,
      needs_approval: true,
      change_id: changeId,
      requirement: item.identifier,
      title: item.title,
      reason,
      changed: Object.keys(patch),
      before,
      after,
      affected_cards: affected,
      affected_total: affectedCards.length,
      how_to_apply: `确认影响面后重发：{ requirement: "${item.identifier}", patch: <同样的 patch>, reason: <同样的 reason>, change_id: "${changeId}", apply: true }`,
    };
  }

  const given = String(args.change_id ?? "").trim();
  if (given === "") {
    throw fail("CHANGE_NEEDS_APPROVAL", "apply=true 需要先预览拿 change_id（这是变更影响面确认门，不是可跳过的表单）", { identifier: item.identifier, computed: changeId });
  }
  if (given !== changeId) {
    throw fail("CHANGE_ID_MISMATCH", "change_id 与当前条目状态 / 补丁不符（条目在预览后被改过，或补丁换了）：请重新预览", { identifier: item.identifier, given, computed: changeId });
  }
  const updated = store.updateRequirementItem(item.identifier, { ...patch, contract: args.contract });
  store.recordAudit({ actor: "agent", action: "requirement-change", target: item.identifier, allowed: true, reason, detail: `${Object.keys(patch).join(",")} change=${changeId}` });
  return {
    applied: true,
    change_id: changeId,
    requirement: item.identifier,
    title: updated.title,
    reason,
    changed: Object.keys(patch),
    before,
    after: requirementSnapshot(updated),
    affected_cards: affected,
    affected_total: affectedCards.length,
    contract: contractReadout(store, project.id, args.contract),
  };
}

/* ---------------- card_create（写 · 归因硬门 D1=A） ---------------- */

export function cardCreate({ store }, args = {}) {
  const { project } = resolveProject(store, args);
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title === "") throw fail("INVALID_TITLE", "card_create 需要 title", {});

  // D1=A：**这个工具的入参形状**就是归因硬门。
  // 注意口径边界：这里只收紧 MCP 这一个新入口；内核全局档（TB_STRICT_ATTRIBUTION）保持默认 warn ——
  // 全局翻档会影响 Web / CLI / seed 全部存量调用方，属另一件事，须单独拍板（只登记不擅改）。
  const requirement = typeof args.requirement === "string" ? args.requirement.trim() : "";
  const unattributedReason = [args.unattributed_reason, args.unattributedReason]
    .find((x) => typeof x === "string" && x.trim() !== "")?.trim() ?? "";
  if (requirement === "" && unattributedReason === "") {
    throw fail(
      "REQUIREMENT_REQUIRED",
      "建卡必须归属需求条目：给 requirement <条目编号>；确实不需要归属时用 unattributed_reason <理由> 显式声明（会落审计，可盘点）",
      { project: project.id, hint: '先 requirement_list { project } 挑一条，或 requirement_upsert 新建' },
    );
  }
  if (requirement !== "" && unattributedReason !== "") {
    throw fail("USAGE_ERROR", "requirement 与 unattributed_reason 只能二选一（要么归属，要么显式不归属）", {});
  }

  // 新卡只能进待办池：`backlog → todo` 是**人工授权**动作（四道门之一），MCP 不得代点。
  const wantedStatus = typeof args.status === "string" && args.status.trim() !== "" ? args.status.trim() : "backlog";
  if (wantedStatus !== "backlog") {
    throw fail(
      "AUTHORIZATION_REQUIRED",
      `新卡只能建在 backlog（待办池）：backlog → todo 是人工授权动作，执行侧不得代点（收到 status=${wantedStatus}）`,
      { received: wantedStatus, allowed: ["backlog"] },
    );
  }

  // 依赖先解析：失败要发生在建卡**之前**，不留半张没边的卡
  const dependsOn = Array.isArray(args.dependsOn) ? args.dependsOn.map((x) => String(x).trim()).filter(Boolean) : [];
  const blockers = dependsOn.map((dep) => {
    const blocker = store.getTaskRef(dep);
    if (!blocker) throw fail("TASK_NOT_FOUND", `依赖的前置任务不存在：${dep}`, { ref: dep });
    if (blocker.projectId !== project.id) {
      throw fail("DEPENDENCY_CROSS_PROJECT", `前置任务属于别的项目：${dep}（${blocker.projectId}）`, { ref: dep, taskProject: blocker.projectId, project: project.id });
    }
    return blocker;
  });

  const created = store.createTask({
    projectId: project.id,
    title,
    description: args.description,
    acceptance: args.acceptance,
    verifyCommand: args.verifyCommand,
    priority: args.priority,
    owner: args.owner,
    labels: args.labels,
    status: "backlog",
    parentId: args.parent ?? args.parentId,
    requirementId: requirement || undefined,
    unattributedReason: unattributedReason || undefined,
    contract: args.contract,
  });

  const edges = blockers.map((b) => {
    store.addTaskDependency({ blocker: b.id, blocked: created.id });
    return { blocker: b.identifier, blocked: created.identifier };
  });

  // 标题去重**只提示不拦截**：「同名但确是另一件事」是合法情形，拦截会逼人改个好名字绕过
  const key = title.toLowerCase();
  const duplicates = store.listTasks({ projectId: project.id })
    .filter((t) => t.id !== created.id && !TERMINAL.has(t.status) && String(t.title).trim().toLowerCase() === key)
    .map((t) => ({ identifier: t.identifier, status: t.status, requirementId: t.requirementId ?? null }));

  return {
    card: {
      identifier: created.identifier,
      title: created.title,
      status: created.status,
      version: created.version,
      requirementId: created.requirementId ?? null,
    },
    attribution: created.requirementId
      ? { kind: "requirement", requirement: requirement }
      : { kind: "explicit-skip", reason: unattributedReason },
    dependsOn: edges,
    duplicates,
    contract: contractReadout(store, project.id, args.contract),
    next: "backlog → todo 需要人工授权；授权后可用 card_progress 回填进度与证据（done 永远只能人点）",
  };
}

/* ---------------- card_progress（写 · 证据必填 + 规范摘要门） ---------------- */

export function cardProgress({ store }, args = {}) {
  const ref = [args.card, args.ref, args.task]
    .find((x) => typeof x === "string" && x.trim() !== "")?.trim() ?? "";
  if (ref === "") throw fail("USAGE_ERROR", "card_progress 需要 card（任务编号或 id）", {});
  const task = store.requireTaskRef(ref);

  const evidence = normalizeEvidence(args.evidence);

  // `norm_digest` 是**这个工具的必填形状**（不是 D2 的全局档）：没读过 card-update 就回填＝拿旧规矩干活。
  // 它只影响 MCP 这个新入口，不改任何存量调用方的行为。
  const norm = readCardUpdateNorm();
  const provided = typeof args.norm_digest === "string" ? args.norm_digest.trim() : "";
  if (provided === "") {
    throw fail("NORM_DIGEST_REQUIRED", '回填必须带 norm_digest（card-update 规范的 sha256）：先 norm_get { norm: "card-update" } 取 digest', { norm: "card-update", current: norm?.digest ?? null });
  }
  if (!norm || provided !== norm.digest) {
    throw fail("NORM_STALE", "你用的 card-update 规范不是当前版本：按返回的 body 重新回填（digest 见下）", {
      norm: "card-update",
      yours: provided,
      current: norm?.digest ?? null,
      version: norm?.version ?? null,
      body: norm?.body ?? "",
    });
  }

  const hash = evidenceHash(evidence);
  const marker = `【MCP 证据】hash=${hash}`;
  const existing = store.listComments(task.id).find((c) => String(c.body ?? "").includes(marker)) ?? null;
  let comment = existing;
  let deduped = Boolean(existing);
  if (!existing) {
    const lines = [marker, ...evidence.map((e) => `- ${e.kind}: ${e.ref}${e.note ? ` — ${e.note}` : ""}`)];
    if (typeof args.comment === "string" && args.comment.trim() !== "") lines.push("", args.comment.trim());
    comment = store.addComment(task.identifier, { body: lines.join("\n"), contract: args.contract });
    deduped = false;
  }

  const statusBefore = task.status;
  let after = task;
  let statusChanged = false;
  const wanted = typeof args.status === "string" && args.status.trim() !== "" ? args.status.trim() : null;
  if (wanted && wanted !== statusBefore) {
    // 走**执行侧状态门**（不是 updateTask）：done 只能人点 / 人工校验任务不得改状态 / backlog→todo 属授权
    after = store.teamSetTaskStatus(task.identifier, { status: wanted, actor: "agent" });
    statusChanged = true;
  }

  return {
    card: {
      identifier: after.identifier,
      statusBefore,
      statusAfter: after.status,
      statusChanged,
      version: after.version,
      requirementId: after.requirementId ?? null,
    },
    evidence: { hash, count: evidence.length, kinds: [...new Set(evidence.map((e) => e.kind))] },
    comment: { id: comment?.id ?? null, deduped },
    norm: { id: "card-update", version: norm.version, digest: norm.digest },
    contract: contractReadout(store, task.projectId, args.contract),
    next: after.status === "in_review" ? "待验收：done 只能由人确认（评审门 + 人工收口）" : null,
  };
}

/* ------------------------------------------------------------------ 注册表 ---- */

const ok = (schema) => schema;

export const TOOLS = Object.freeze([
  {
    name: "flow_start",
    description: "开局第一步（S0，只读）：按 cwd / project 解析项目，返回项目身份、contract_version、缺口（未归因卡 / 未绑定主会话 / 待确认候选）与下一步建议。不写任何数据。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配，未命中回落默认项目）" },
        cwd: { type: "string", description: "工作目录（默认进程 cwd）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: flowStart,
  },
  {
    name: "project_info",
    description: "项目总览（只读）：项目配置 + 任务/需求条目按状态计数 + 契约版本与基线是否漂移。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        cwd: { type: "string", description: "工作目录（默认进程 cwd）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: projectInfo,
  },
  {
    name: "norm_get",
    description: "取机器规范正文（只读）：flow / card-update / doc-editing / acceptance / project-defaults；norm=\"project\" 取项目自有补充（<workspace>/AGENTS.md）。",
    inputSchema: ok({
      type: "object",
      required: ["norm"],
      properties: {
        norm: { type: "string", description: "规范 id，或 project（项目侧补充）" },
        project: { type: "string", description: "norm=project 时的项目 id（省略按 cwd 匹配）" },
        cwd: { type: "string", description: "工作目录（默认进程 cwd）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: normGet,
  },
  {
    name: "workbench_audit",
    description: "漂移盘点（只读）：contract-stale / unattributed / unbound-session / candidate-flood 四类，各带计数、样例与处置建议。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        cwd: { type: "string", description: "工作目录（默认进程 cwd）" },
        sinceHours: { type: "number", description: "contract-stale 的回看窗口（小时，默认 168）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: workbenchAudit,
  },
  {
    name: "requirement_list",
    description: "需求条目列表（只读）：条目 + 内容版本（乐观锁用）+ 每条下的卡数与完成数。建卡前先用它挑 requirement。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        status: { type: "string", description: "按条目状态过滤（open / in_progress / done / canceled 等）" },
        cwd: { type: "string", description: "工作目录（默认进程 cwd）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
    handler: requirementList,
  },
  {
    name: "requirement_upsert",
    description: "新建或修改需求条目（写）。改已有条目必须带 expected_version（= requirement_list 返回的 version），不符 ⇒ VERSION_CONFLICT（不静默覆盖）。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        id: { type: "string", description: "要修改的条目（编号或 id）；不传则新建" },
        requirement: { type: "string", description: "id 的别名" },
        expected_version: { type: "string", description: "改条目时必填：requirement_list 返回的 version" },
        title: { type: "string" },
        description: { type: "string" },
        acceptance: { type: "string" },
        priority: { type: "string", description: "none / low / medium / high / urgent" },
        status: { type: "string", description: "条目状态（新建默认 open）" },
        contract: { type: "object", description: "调用方用的契约 {version, normDigests}（warn 档：只留痕不阻断）" },
      },
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: requirementUpsert,
  },
  {
    name: "requirement_change",
    description: "需求变更（写）：先返回影响面（affected_cards）+ change_id，带 change_id + apply:true 才落地。条目在预览后被改过 ⇒ change_id 自动失效。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        requirement: { type: "string", description: "条目编号或 id" },
        patch: { type: "object", description: "要改的字段：title / description / acceptance / priority / status" },
        reason: { type: "string", description: "为什么改（必填，事后复盘用）" },
        change_id: { type: "string", description: "预览返回的 change_id；apply=true 时必填" },
        apply: { type: "boolean", description: "true 才真正落地（默认 false = 只预览）" },
        contract: { type: "object", description: "调用方用的契约（warn 档）" },
      },
      required: ["requirement", "patch", "reason"],
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: requirementChange,
  },
  {
    name: "card_create",
    description: "建卡（写）。**归因硬门**：必须给 requirement，或显式 unattributed_reason（落审计）。新卡只能进 backlog（backlog→todo 是人工授权）。",
    inputSchema: ok({
      type: "object",
      properties: {
        project: { type: "string", description: "项目 id（省略则按 cwd 匹配）" },
        title: { type: "string" },
        requirement: { type: "string", description: "归属的需求条目（编号或 id）——与 unattributed_reason 二选一" },
        unattributed_reason: { type: "string", description: "显式声明不归因的理由（会落审计，可盘点）" },
        description: { type: "string" },
        acceptance: { type: "string", description: "完成验收标准（建议必填）" },
        verifyCommand: { type: "string", description: "复核动作（如 npm test）" },
        priority: { type: "string" },
        owner: { type: "string" },
        labels: { type: "array", items: { type: "string" } },
        parent: { type: "string", description: "父任务（编号或 id）" },
        dependsOn: { type: "array", items: { type: "string" }, description: "前置任务（编号或 id），建卡后成依赖边" },
        contract: { type: "object", description: "调用方用的契约（warn 档）" },
      },
      required: ["title"],
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    handler: cardCreate,
  },
  {
    name: "card_progress",
    description: "回填进度（写）。**证据必填**（evidence[] 非空，每项 {kind:file|command|url|reading, ref, note?}）+ **norm_digest 必填**（card-update 规范的 sha256）。状态走执行侧门：done 只能人点。",
    inputSchema: ok({
      type: "object",
      properties: {
        card: { type: "string", description: "任务编号或 id" },
        status: { type: "string", description: "可选：in_progress / in_review / blocked / canceled（done 与会触发授权门的状态一律拒）" },
        evidence: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["file", "command", "url", "reading"] },
              ref: { type: "string" },
              note: { type: "string" },
            },
            required: ["kind", "ref"],
            additionalProperties: false,
          },
        },
        norm_digest: { type: "string", description: "card-update 规范的 sha256（先 norm_get { norm: \"card-update\" }）" },
        comment: { type: "string", description: "附加说明（会拼在证据块之后）" },
        contract: { type: "object", description: "调用方用的契约（warn 档）" },
      },
      required: ["card", "evidence", "norm_digest"],
      additionalProperties: false,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    handler: cardProgress,
  },
]);

export const TOOL_NAMES = Object.freeze(TOOLS.map((t) => t.name));
