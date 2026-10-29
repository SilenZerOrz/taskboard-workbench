/**
 * memory.mjs —— 项目记忆条目（2026-10-28 拍板 D-M1/D-M2/D-M5）。
 *
 * 定位：**L2 记忆层不是第二真源**。每条记忆＝一句结论 + 指回事实流的 `provenance`
 * （`event:<cursor>` / `doc:<path>#<anchor>` / `session:<id>` / `run:<taskRunId>`）——
 * 把整张 `memory_entries` 删掉，系统功能一件不少，只是"变笨"。
 *
 * 三条来自本仓实证的红线：
 *   ① 假记忆比空记忆更坏（69 张卡里 56 张挂兜底条目 `R124`）⇒ 写入默认 `proposed`，人 accept 才召回；
 *   ② 不删只取代（`superseded`）⇒ 仍可回查"以前是这么定的，后来改了"；
 *   ③ 先脱敏再入记忆（全局 AGENTS §3）⇒ `sk-*` / `*_token` / 私钥一律拒收。
 */
import { TbError } from "./errors.mjs";

export const MEMORY_SCOPES = Object.freeze(["project", "agent", "org"]);
export const MEMORY_KINDS = Object.freeze(["convention", "decision", "pitfall", "fact", "procedure"]);
export const MEMORY_VISIBILITIES = Object.freeze(["private", "shared", "org"]);

/** 召回默认预算（D-M5：6 条 / 3000 字；`fact` 只在显式请求时给）。 */
export const MEMORY_RECALL_DEFAULT = Object.freeze({
  limit: 6, charBudget: 3000, quotas: Object.freeze({ convention: 3, decision: 2, pitfall: 1 }),
});

export const MEMORY_TITLE_MAX = 80;
export const MEMORY_BODY_MAX = 4000;

/** 记忆会跨项目流动，泄露面比文档更大 ⇒ 入库即拦。 */
const SECRET_RE = /(sk-[A-Za-z0-9_-]{12,})|(\b[A-Za-z0-9_]*_token\s*[:=]\s*\S+)|(-----BEGIN [A-Z ]*PRIVATE KEY-----)|(\bBearer\s+[A-Za-z0-9._-]{20,})/;

const pick = (list, value, field) => {
  const v = String(value ?? "").trim();
  if (!list.includes(v)) throw new TbError("USAGE_ERROR", `${field} 必须是 ${list.join(" / ")} 之一，收到 ${JSON.stringify(value)}`, { field });
  return v;
};

const rowToEntry = (row, nowMs) => {
  if (!row) return null;
  const ttl = row.ttl_days ?? null;
  // ttl_days=0 表示「立刻过期」（>= 而非 >，否则同一毫秒内判不出来）
  const stale = ttl != null && (nowMs - Date.parse(row.updated_at)) >= ttl * 86400000;
  return {
    id: row.id,
    scope: row.scope,
    projectId: row.project_id ?? null,
    agentId: row.agent_id ?? null,
    kind: row.kind,
    title: row.title,
    body: row.body,
    tags: (() => { try { return JSON.parse(row.tags ?? "[]"); } catch { return []; } })(),
    provenance: row.provenance,
    confidence: row.confidence,
    visibility: row.visibility,
    verifiedAt: row.verified_at ?? null,
    ttlDays: ttl,
    stale,
    supersedes: row.supersedes ?? null,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

export function createMemoryApi({ db, nowIso, randomUUID }) {
  const memory = {
    /** 写入/更新一条记忆。**默认 propose**（D-M2：agent 可提议，人 accept 才召回）。 */
    upsertMemoryEntry(input = {}) {
      const scope = pick(MEMORY_SCOPES, input.scope ?? "project", "scope");
      const kind = pick(MEMORY_KINDS, input.kind, "kind");
      const visibility = pick(MEMORY_VISIBILITIES, input.visibility ?? (scope === "project" ? "shared" : "org"), "visibility");
      const title = String(input.title ?? "").trim();
      if (!title) throw new TbError("USAGE_ERROR", "记忆必须有 title", { field: "title" });
      if (title.length > MEMORY_TITLE_MAX) throw new TbError("USAGE_ERROR", `title 超长（>${MEMORY_TITLE_MAX} 字），说明该拆条`, { field: "title" });
      const body = String(input.body ?? "").trim();
      if (!body) throw new TbError("USAGE_ERROR", "记忆必须有 body", { field: "body" });
      if (body.length > MEMORY_BODY_MAX) throw new TbError("USAGE_ERROR", `body 超长（>${MEMORY_BODY_MAX} 字），说明该拆条`, { field: "body" });
      // R-M3：无出处一律 reject —— 记忆必须能回指事实流
      const provenance = String(input.provenance ?? "").trim();
      if (!provenance) throw new TbError("USAGE_ERROR", "记忆必须带 provenance（event:<cursor> / doc:<path>#<anchor> / session:<id> / run:<id>），无出处的记忆一律拒收", { field: "provenance" });
      // R-M5：先脱敏再入记忆
      const hit = SECRET_RE.exec(`${title}\n${body}\n${provenance}`);
      if (hit) throw new TbError("MEMORY_SECRET_REJECTED", "疑似敏感信息（密钥 / token / 私钥），先脱敏再入记忆", { field: "body", pattern: hit[1] ? "sk-*" : (hit[2] ? "*_token" : "private-key") });
      const verifiedAt = input.verifiedAt ? String(input.verifiedAt) : null;
      if (kind === "fact" && !verifiedAt) throw new TbError("USAGE_ERROR", "kind=fact 必须带 verifiedAt（事实一定会过期，过期即降权）", { field: "verifiedAt" });
      if (scope === "project" && !input.projectId) throw new TbError("USAGE_ERROR", "scope=project 必须带 projectId", { field: "projectId" });
      if (scope === "agent" && !input.agentId) throw new TbError("USAGE_ERROR", "scope=agent 必须带 agentId", { field: "agentId" });

      const ts = nowIso();
      const existing = db.prepare("select * from memory_entries where scope = ? and kind = ? and title = ? and provenance = ?")
        .get(scope, kind, title, provenance);
      if (existing) {
        db.prepare("update memory_entries set body = ?, tags = ?, visibility = ?, verified_at = ?, ttl_days = ?, updated_at = ? where id = ?")
          .run(body, JSON.stringify(input.tags ?? []), visibility, verifiedAt, input.ttlDays ?? null, ts, existing.id);
        return { entry: memory.getMemoryEntry(existing.id), created: false };
      }
      const id = `mem-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      db.prepare(
        `insert into memory_entries (id, scope, project_id, agent_id, kind, title, body, tags, provenance, confidence,
           visibility, verified_at, ttl_days, supersedes, created_by, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, null, ?, ?, ?)`,
      ).run(id, scope, input.projectId ?? null, input.agentId ?? null, kind, title, body,
        JSON.stringify(input.tags ?? []), provenance, visibility, verifiedAt, input.ttlDays ?? null,
        String(input.createdBy ?? "agent:unknown"), ts, ts);
      return { entry: memory.getMemoryEntry(id), created: true };
    },

    getMemoryEntry(id) {
      return rowToEntry(db.prepare("select * from memory_entries where id = ?").get(String(id)), Date.now());
    },

    listMemoryEntries({ projectId = null, scope = null, kind = null, includeProposed = false, includeSuperseded = false } = {}) {
      const where = [];
      const params = [];
      if (projectId) { where.push("(project_id = ? or scope = 'org')"); params.push(projectId); }
      if (scope) { where.push("scope = ?"); params.push(pick(MEMORY_SCOPES, scope, "scope")); }
      if (kind) { where.push("kind = ?"); params.push(pick(MEMORY_KINDS, kind, "kind")); }
      if (!includeProposed) where.push("confidence = 'accepted'");
      if (!includeSuperseded) where.push("supersedes is null");
      const sql = `select * from memory_entries ${where.length ? `where ${where.join(" and ")}` : ""} order by updated_at desc, id asc`;
      const nowMs = Date.now();
      return db.prepare(sql).all(...params).map((r) => rowToEntry(r, nowMs));
    },

    /** 人/评审确认 —— 只有 accepted 才会被召回。 */
    acceptMemoryEntry(id, { actor = "human" } = {}) {
      const entry = memory.getMemoryEntry(id);
      if (!entry) throw new TbError("MEMORY_NOT_FOUND", `记忆不存在：${id}`, { id });
      const ts = nowIso();
      db.prepare("update memory_entries set confidence = 'accepted', updated_at = ? where id = ?").run(ts, entry.id);
      return { entry: memory.getMemoryEntry(entry.id), acceptedBy: String(actor) };
    },

    /** 不删只取代（R-M2）。 */
    supersedeMemoryEntry(id, { byId = null, actor = "human" } = {}) {
      const entry = memory.getMemoryEntry(id);
      if (!entry) throw new TbError("MEMORY_NOT_FOUND", `记忆不存在：${id}`, { id });
      const ts = nowIso();
      db.prepare("update memory_entries set supersedes = ?, updated_at = ? where id = ?").run(byId, ts, entry.id);
      return { entry: memory.getMemoryEntry(entry.id), supersededBy: byId ?? null, actor: String(actor) };
    },

    /**
     * 召回（L3）：只取 `accepted` 且未过期的条目，按 kind 配额 + 字数预算。
     * `fact` 默认**不召回**（过期事实比没有记忆更坏，R-M4），除非显式 `includeKinds`。
     */
    recallMemory({ projectId = null, limit = MEMORY_RECALL_DEFAULT.limit, charBudget = MEMORY_RECALL_DEFAULT.charBudget, quotas = MEMORY_RECALL_DEFAULT.quotas, includeFacts = false } = {}) {
      const pool = memory.listMemoryEntries({ projectId, includeProposed: false })
        .filter((e) => !e.stale)
        .filter((e) => includeFacts || e.kind !== "fact");
      const used = Object.fromEntries(MEMORY_KINDS.map((k) => [k, 0]));
      const entries = [];
      let chars = 0;
      for (const entry of pool) {
        if (entries.length >= limit) break;
        const quota = quotas?.[entry.kind];
        if (quota != null && used[entry.kind] >= quota) continue;
        const cost = entry.title.length + entry.body.length;
        if (chars + cost > charBudget) continue;
        entries.push(entry);
        used[entry.kind] += 1;
        chars += cost;
      }
      return { entries, count: entries.length, chars };
    },

    /** 召回审计：能回答"这次为什么这么答"（上游原文的请求日志范式）。 */
    recordMemoryRecalls({ sessionId = null, entries = [], reason = null } = {}) {
      const ts = nowIso();
      const stmt = db.prepare("insert into memory_recalls (session_id, entry_id, reason, injected_chars, created_at) values (?, ?, ?, ?, ?)");
      let n = 0;
      for (const entry of entries) { stmt.run(sessionId, entry.id, reason, entry.title.length + entry.body.length, ts); n += 1; }
      return n;
    },

    listMemoryRecalls({ limit = 50 } = {}) {
      return db.prepare("select * from memory_recalls order by id desc limit ?").all(Math.max(1, Number(limit) || 50));
    },
  };
  return memory;
}

/** L3 装载块：与「推进清单」并列，不新造格式。 */
export function renderMemoryBlock(recall, { projectName = null } = {}) {
  const head = `【项目记忆${projectName ? ` · ${projectName}` : ""}】`;
  if (!recall || recall.count === 0) return `${head}\n（暂无已确认记忆）`;
  const kindLabel = { convention: "约定", decision: "裁定", pitfall: "踩坑", fact: "事实", procedure: "SOP" };
  const lines = recall.entries.map((e) => `- [${kindLabel[e.kind] ?? e.kind}] ${e.title}（${e.id}，出自 ${e.provenance}）`);
  return [
    head,
    `（共 ${recall.count} 条 · 已确认）`,
    ...lines,
    "规则：以上为已确认结论；与本轮事实冲突时**以事实为准**，并在回复中指出该条需要复核。",
  ].join("\n");
}
