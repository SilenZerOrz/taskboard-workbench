/**
 * 交付物证据的**规则层**（FR-106 / 卡 `-197` · 0-B）。
 *
 * 这一层只做「判」，不碰库：四字段齐不齐、`artifact_refs` 解不解得开。
 * 为什么单独成模块：核验规则要被单测逐条钉住，也要能被将来的 Router / 看护复用，
 * 塞进 store 里就只能靠"跑一遍看板"验证。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const EVIDENCE_FIELDS = Object.freeze(["verdict", "deviation", "boundary", "artifacts"]);
export const EVIDENCE_REF_KINDS = Object.freeze(["commit", "file"]);

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** 四字段缺什么就报什么（**门在事务前**：调用方拿到非空数组就不许落库）。 */
export function evidenceProblems(input = {}) {
  const problems = [];
  for (const f of ["verdict", "deviation", "boundary"]) {
    if (text(input[f]) === "") problems.push({ field: f, reason: "empty" });
  }
  const arts = Array.isArray(input.artifacts) ? input.artifacts.filter((a) => text(a) !== "") : [];
  if (arts.length === 0) problems.push({ field: "artifacts", reason: "empty" });
  return problems;
}

/** 统一形状：`[{kind, ref, note?}]`；非法 kind 直接丢弃（不猜）。 */
export function normalizeArtifactRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const out = [];
  for (const r of refs) {
    const kind = text(r?.kind);
    const ref = text(r?.ref);
    if (!ref || !EVIDENCE_REF_KINDS.includes(kind)) continue;
    const note = text(r?.note);
    out.push(note ? { kind, ref, note } : { kind, ref });
  }
  return out;
}

/**
 * 核验 `artifact_refs`：任一解不开即整体 `unresolved`（不"部分通过"）。
 * `resolve({kind, ref})` 由调用方注入 —— 默认实现见 `makeResolver`。
 */
export function verifyArtifactRefs(refs = [], resolve) {
  const list = normalizeArtifactRefs(refs);
  if (list.length === 0) return { state: "unchecked", unresolved: [] };
  if (typeof resolve !== "function") return { state: "unchecked", unresolved: [] };
  const unresolved = [];
  for (const r of list) {
    let ok = false;
    try { ok = resolve(r) === true; } catch { ok = false; }
    if (!ok) unresolved.push(r);
  }
  return { state: unresolved.length ? "unresolved" : "resolved", unresolved };
}

/**
 * `format_ok` 的**唯一**判据（0-A 的 `ticketStage()` 直接调用这里，别在别处再写一份）：
 * 四字段齐 **且** refs 不是 `unresolved`。
 * `unchecked` 可以进 format_ok —— 没给 refs 就不假装校验过；"格式合格" ≠ "内容已判"（那是 ready 的事）。
 */
export function evidenceFormatOk(evidence) {
  if (!evidence) return false;
  if (evidenceProblems(evidence).length) return false;
  return evidence.refsState !== "unresolved";
}

/**
 * 默认解析器：`file` 走 `fs.existsSync`（相对仓库根），`commit` 走 `git cat-file -e <sha>^{commit}`。
 * 刻意**不抛**：核验失败是数据问题，不是程序异常。
 */
export function makeResolver({ root, execFileSyncImpl = execFileSync, existsSyncImpl = fs.existsSync } = {}) {
  const base = root ?? process.cwd();
  return (r) => {
    if (r.kind === "file") return existsSyncImpl(path.resolve(base, r.ref));
    if (r.kind === "commit") {
      try {
        execFileSyncImpl("git", ["-C", base, "cat-file", "-e", `${r.ref}^{commit}`], { stdio: "ignore" });
        return true;
      } catch { return false; }
    }
    return false;
  };
}
