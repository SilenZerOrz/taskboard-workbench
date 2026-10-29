/**
 * contract.mjs —— 契约快照（P1 · 2026-10-29）
 *
 * 方案依据：`docs/设计/技能化与MCP契约-架构变更方案-2026-10-28.md`
 *   §6.4 契约版本与规范摘要校验 · §7.1 frontmatter 契约 · §8 数据模型 · §17.3.1 D4 最终裁定。
 *
 * 一句话：**把「规范读了就算」变成「用旧规范干活会显性失败」**。
 *
 *   contract_version = f(需求文档 digest, 机器规范 digest×版本, 门配置)
 *
 * 三条设计约束（都是被踩出来的）：
 *   ① **本模块不写库、不改状态** —— 纯计算 + 纯读文件，谁都能安全调（HTTP / MCP / CLI 同一份实现，
 *      防「六个入口两种语义」）；
 *   ② **机器规范唯一真源是 `spec/norms/*.md`**（随包分发）；`docs/规范/*.md` 是给人读的开发文档，
 *      永不入 git，**不作为任何运行时真源**（D4 用户二次拍板，不可改变）；
 *   ③ **正文变了但 version 没 bump ⇒ 守卫报红**（`tests/norms-parity.test.mjs`）——
 *      否则「悄悄改规范」就是下一个不可追的漂移源。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { TbError } from "./errors.mjs";

/** 随包分发的五份机器规范（缺一份即 `NORM_NOT_FOUND`）。 */
export const NORM_IDS = Object.freeze(["flow", "card-update", "doc-editing", "acceptance", "project-defaults"]);

/** 参与 contract_version 的门配置项（顺序固定 ⇒ 可复现）。 */
export const GATE_NAMES = Object.freeze(["attribution", "authorization", "review", "humanReview"]);

export const CONTRACT_VERSION_PREFIX = "v1-";

export function sha256(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * 解析带 frontmatter 的规范正文。
 *
 * 只认最小 YAML 子集（`key: value` / `key: [a, b]` / 数字 / 引号串）——本仓规范就是这么写的，
 * 引完整 YAML 解析器会把「机器规范的形状」变成第三方依赖的版本风险。
 *
 * @returns {{meta:{norm_id:string,version:number,updated:string,applies_to:string[]}, body:string, digest:string}}
 */
export function parseNormDoc(text, file = "<norm>") {
  const raw = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!raw.startsWith("---\n")) throw new TbError("NORM_INVALID", `规范缺 frontmatter：${file}`, { file });
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) throw new TbError("NORM_INVALID", `规范 frontmatter 未闭合：${file}`, { file });
  const head = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta = {};
  for (const line of head.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) throw new TbError("NORM_INVALID", `规范 frontmatter 行无法解析：${file} · ${line}`, { file });
    const key = line.slice(0, idx).trim();
    meta[key] = parseScalar(line.slice(idx + 1).trim());
  }
  const normId = String(meta.norm_id ?? "");
  if (!NORM_IDS.includes(normId)) {
    throw new TbError("NORM_INVALID", `规范 norm_id 非法：${file} · ${JSON.stringify(meta.norm_id)}`, { file, allowed: NORM_IDS });
  }
  if (!Number.isInteger(meta.version) || meta.version < 1) {
    throw new TbError("NORM_INVALID", `规范 version 必须是 ≥1 的整数：${file}`, { file });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(meta.updated ?? ""))) {
    throw new TbError("NORM_INVALID", `规范 updated 必须是 YYYY-MM-DD：${file}`, { file });
  }
  const appliesTo = Array.isArray(meta.applies_to) ? meta.applies_to : [String(meta.applies_to ?? "")].filter(Boolean);
  if (appliesTo.length === 0) throw new TbError("NORM_INVALID", `规范 applies_to 不能为空：${file}`, { file });
  return { meta: { norm_id: normId, version: meta.version, updated: String(meta.updated), applies_to: appliesTo }, body, digest: sha256(body) };
}

function parseScalar(value) {
  const v = String(value ?? "").trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    return v.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean).map(stripQuotes);
  }
  if (/^-?\d+$/.test(v)) return Number(v);
  if (v === "true") return true;
  if (v === "false") return false;
  return stripQuotes(v);
}

function stripQuotes(s) {
  const v = String(s).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/**
 * 读一个规范目录（`spec/norms/*.md`）。
 *
 * @param {string} dir
 * @param {{requireAll?: boolean}} [opts] `requireAll`（默认 true）＝五份必须齐；单测造夹具时可关。
 */
export function loadNorms(dir, { requireAll = true } = {}) {
  if (!dir || !existsSync(dir)) throw new TbError("NORM_NOT_FOUND", `机器规范目录不存在：${dir}`, { dir });
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const norms = [];
  const seen = new Map();
  for (const file of files) {
    const abs = path.join(dir, file);
    const parsed = parseNormDoc(readFileSync(abs, "utf8"), abs);
    const prev = seen.get(parsed.meta.norm_id);
    if (prev) throw new TbError("NORM_INVALID", `norm_id 重复：${parsed.meta.norm_id}（${prev} / ${abs}）`, { normId: parsed.meta.norm_id });
    seen.set(parsed.meta.norm_id, abs);
    norms.push({ id: parsed.meta.norm_id, version: parsed.meta.version, updated: parsed.meta.updated, appliesTo: parsed.meta.applies_to, digest: parsed.digest, file: abs, relPath: `spec/norms/${file}`, body: parsed.body });
  }
  if (requireAll) {
    const missing = NORM_IDS.filter((id) => !seen.has(id));
    if (missing.length) throw new TbError("NORM_NOT_FOUND", `机器规范缺文件：${missing.join(" / ")}`, { dir, missing });
  }
  return norms;
}

/** 门配置归一化（缺项取默认值；未知键忽略，避免把 UI 状态算进版本）。 */
export function normalizeGates(gates = {}) {
  const out = {};
  for (const name of GATE_NAMES) out[name] = String(gates?.[name] ?? "n/a");
  return out;
}

/**
 * 计算契约快照（纯函数，可无限重算）。
 *
 * @param {{requirementsText?: string, norms: Array<{id,version,digest,relPath?}>, gates?: object, docVersion?: number|null}} input
 * @returns {{contractVersion:string, docDigest:string, docVersion:number|null, norms:Array, gates:object, material:string}}
 */
export function computeContract({ requirementsText = "", norms = [], gates = {}, docVersion = null } = {}) {
  const docDigest = sha256(requirementsText);
  const normRows = [...norms]
    .map((n) => ({ id: n.id, version: n.version, digest: n.digest, file: n.relPath ?? n.file ?? null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const gateRows = normalizeGates(gates);
  const material = JSON.stringify({ doc: docDigest, norms: normRows.map((n) => [n.id, n.version, n.digest]), gates: GATE_NAMES.map((g) => [g, gateRows[g]]) });
  return {
    contractVersion: `${CONTRACT_VERSION_PREFIX}${sha256(material).slice(0, 12)}`,
    docDigest,
    docVersion,
    norms: normRows,
    gates: gateRows,
    material,
  };
}

/**
 * 两次快照之间「到底哪份文件变了」——`CONTRACT_STALE` 必须能报出来（D5 硬要求 ②）。
 *
 * @returns {{versionChanged:boolean, docChanged:boolean, normChanges:Array<{norm,from,to,file}>, gateChanges:Array<{gate,from,to}>, changedFiles:string[]}}
 */
export function diffContract(prev, next) {
  const before = new Map((prev?.norms ?? []).map((n) => [n.id, n]));
  const normChanges = [];
  for (const n of next?.norms ?? []) {
    const old = before.get(n.id);
    if (!old) {
      normChanges.push({ norm: n.id, from: null, to: n.version, file: n.file });
      continue;
    }
    if (old.version !== n.version || old.digest !== n.digest) {
      normChanges.push({ norm: n.id, from: old.version, to: n.version, file: n.file ?? old.file ?? null });
    }
  }
  const gateChanges = [];
  for (const g of GATE_NAMES) {
    const from = prev?.gates?.[g] ?? null;
    const to = next?.gates?.[g] ?? null;
    if (from !== to) gateChanges.push({ gate: g, from, to });
  }
  const docChanged = Boolean(prev) && prev?.docDigest !== next?.docDigest;
  const changedFiles = [
    ...(docChanged ? ["requirement-doc"] : []),
    ...normChanges.map((c) => c.file).filter(Boolean),
  ];
  return {
    versionChanged: Boolean(prev) && prev?.contractVersion !== next?.contractVersion,
    docChanged,
    normChanges,
    gateChanges,
    changedFiles,
  };
}

/**
 * P1.5 · D2 `warn` 档的**纯判据**：把「调用方用的契约」与「当前契约」比一比。
 *
 * **不抛错、不写库** —— 阻断与否由调用方决定（warn 档：只记审计、照常写入）。
 * 老客户端 / Web 不带 `contract` 字段 ⇒ `skipped`，零打扰（向后兼容）。
 *
 * @param {object} current `computeContract()` 的结果
 * @param {{version?:string, contractVersion?:string, normDigest?:string, normDigests?:Record<string,string>}} submitted
 * @returns {{verdict:"skipped"|"unknown"|"ok"|"warn", problems:Array<object>}}
 */
export function evaluateSubmittedContract(current, submitted) {
  if (!submitted || typeof submitted !== "object") return { verdict: "skipped", problems: [] };
  if (!current || typeof current.contractVersion !== "string") return { verdict: "unknown", problems: [] };
  const problems = [];
  const version = submitted.version ?? submitted.contractVersion ?? null;
  if (version != null && String(version) !== "" && String(version) !== current.contractVersion) {
    problems.push({ kind: "version", yours: String(version), current: current.contractVersion });
  }
  const norms = Array.isArray(current.norms) ? current.norms : [];
  const single = submitted.normDigest ?? null;
  if (single != null && String(single) !== "" && !norms.some((n) => n.digest === String(single))) {
    problems.push({ kind: "norm_digest", norm: null, yours: String(single), current: null });
  }
  const map = submitted.normDigests && typeof submitted.normDigests === "object" ? submitted.normDigests : null;
  if (map) {
    for (const [id, digest] of Object.entries(map)) {
      const hit = norms.find((n) => n.id === id);
      if (!hit) problems.push({ kind: "norm_unknown", norm: id, yours: String(digest), current: null });
      else if (hit.digest !== String(digest)) problems.push({ kind: "norm_digest", norm: id, yours: String(digest), current: hit.digest });
    }
  }
  if (problems.length > 0) return { verdict: "warn", problems };
  const touched = version != null || single != null || map != null;
  return { verdict: touched ? "ok" : "skipped", problems };
}

/** `409 CONTRACT_STALE` 的返回体（形状固定：agent 拿到就能自纠偏重试）。 */
export function staleError({ yours, current, changed }) {
  const files = changed?.changedFiles ?? [];
  return new TbError(
    "CONTRACT_STALE",
    `契约已更新：你用 ${yours ?? "(未提供)"}，当前 ${current.contractVersion}${files.length ? `；变化来自 ${files.join(" / ")}` : ""}`,
    {
      your_version: yours ?? null,
      current_version: current.contractVersion,
      changed: changed ?? null,
      digest: current.docDigest,
      snapshot: current,
      remedy: "用返回体里的 snapshot.contractVersion 重试（无需人确认）",
    },
  );
}

/**
 * 比对「当前规范文件」与「已提交的 manifest」。
 *
 * 这是「**正文变了但 version 没 bump**」的唯一拦截点（§7.1）：
 *  `digest 变了 && version 没变` ⇒ `NORM_VERSION_NOT_BUMPED`（守卫红），
 * 否则「悄悄改规范」会让所有 agent 的 `norm_digest` 校验形同虚设。
 *
 * @param {Array} norms     `loadNorms()` 的结果
 * @param {{norms?: Array}} manifest  `spec/norms/manifest.json` 的内容
 */
export function diffNormsManifest(norms, manifest) {
  const listed = new Map(((manifest?.norms) ?? []).map((n) => [n.norm_id ?? n.id, n]));
  const issues = [];
  const current = new Map();
  for (const n of norms) {
    current.set(n.id, n);
    const old = listed.get(n.id);
    if (!old) {
      issues.push({ code: "NORM_UNLISTED", norm: n.id, file: n.relPath, message: `manifest 里没有 ${n.id}（新规范？跑 build-norms 生成）` });
      continue;
    }
    if (Number(n.version) < Number(old.version)) {
      issues.push({ code: "NORM_DOWNGRADE", norm: n.id, file: n.relPath, from: old.version, to: n.version, message: `${n.id} 版本回退：${old.version} → ${n.version}` });
      continue;
    }
    if (Number(n.version) === Number(old.version) && n.digest !== old.digest) {
      issues.push({ code: "NORM_VERSION_NOT_BUMPED", norm: n.id, file: n.relPath, version: n.version, message: `${n.id} 正文变了但 version 仍是 ${n.version} —— 必须 bump 版本` });
    }
  }
  for (const [id, old] of listed) {
    if (!current.has(id)) issues.push({ code: "NORM_MISSING", norm: id, file: old.file ?? null, message: `manifest 登记了 ${id}，但目录里没有这份文件` });
  }
  const needsWrite = norms.some((n) => {
    const old = listed.get(n.id);
    return !old || Number(old.version) !== Number(n.version) || old.digest !== n.digest;
  });
  return { ok: issues.length === 0, issues, needsWrite };
}

/** 生成 manifest（稳定顺序，不含时间戳 ⇒ 可幂等 `--check`）。 */
export function buildNormsManifest(norms) {
  return {
    schemaVersion: 1,
    note: "由 node tools/build-norms.mjs 生成；正文变了必须 bump version（否则 tests/norms-parity.test.mjs 报红）",
    norms: [...norms]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({ norm_id: n.id, version: n.version, updated: n.updated, digest: n.digest, file: n.relPath })),
  };
}
