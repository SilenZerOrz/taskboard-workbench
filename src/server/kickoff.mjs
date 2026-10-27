/**
 * FR-92 开局对齐自检的 **I/O 半**（黑盒：只读工作区，不写任何东西）。
 *
 * 与 `../core/kickoff.mjs`（纯函数）配对，沿用本仓 verify.mjs 的分层习惯：
 * 纯函数负责判据口径，本模块只负责"把工作区的事实采集出来"。
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { KICKOFF_ALIGNMENT_STEPS } from "../core/kickoff.mjs";

/** 采集工作区事实：把每个步骤里提到的候选路径都查一遍存在性。 */
export function collectKickoffFacts(root) {
  const files = {};
  if (typeof root !== "string" || root === "" || !existsSync(root)) return { root: root ?? null, readable: false, files };
  for (const step of KICKOFF_ALIGNMENT_STEPS) {
    for (const check of step.checks) {
      for (const rel of check.paths ?? []) {
        if (rel in files) continue;
        files[rel] = existsSync(path.join(root, rel));
      }
    }
  }
  return { root, readable: true, files };
}

/** 团队模板里有没有 reviewer（审计）角色 —— 各仓模板写法不一，这里做**宽松但明确**的判定。 */
export function hasReviewerRole(teamTemplate) {
  const roles = teamTemplate?.roles;
  if (Array.isArray(roles)) return roles.some((r) => String(r?.role ?? r ?? "").toLowerCase().includes("review"));
  if (roles && typeof roles === "object") return Object.keys(roles).some((k) => k.toLowerCase().includes("review"));
  return false;
}

/** 工程师角色的执行器/验证命令有没有约定（roles 数组里找 engineer；或模板里单开 engineer 段）。 */
export function hasEngineerExecutor(teamTemplate) {
  const roles = teamTemplate?.roles;
  if (Array.isArray(roles) && roles.some((r) => String(r?.role ?? "").toLowerCase() === "engineer" && String(r?.executor ?? "").trim() !== "")) return true;
  if (roles && typeof roles === "object" && roles.engineer) return true;
  return String(teamTemplate?.engineer?.verifyCommand ?? "").trim() !== "";
}

/** 目录是否是可读目录（避免把文件当工作区）。 */
export function isDirectory(p) {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
