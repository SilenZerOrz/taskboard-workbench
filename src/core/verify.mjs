/**
 * FR-90「评审前的自动复核证据」（纯函数）。
 *
 * 真机反馈（2026-10-22）：「**判断为无法人工校验的任务，理应有自动复核或者已自动跑过测试的
 * 返回结论以供人员评审任务通过使用**」——评审人不能只看到「评审通过 / 请求返工」两个按钮，
 * 必须拿到**机器产出的结论**，否则只能凭感觉点按钮。
 *
 * 本模块只做两件事（都不碰状态、不跑进程）：
 * 1. `formatVerifyComment()` —— 把一次复核结果落成**机器可读**的证据评论（沿用本仓既有的
 *    「【…】字段=值；…」惯例，见 FR-85 的【人工校验申报】）；
 * 2. `latestAutoReview()` / `buildReviewEvidence()` —— 把证据评论解析回来，供抽屉展示。
 *
 * 跑命令的 I/O 在 `../server/verify.mjs`（有超时与输出截断），本模块保持纯函数以便单测。
 */

import { latestProgressComment } from "./watchdog.mjs";

/** 证据评论前缀与默认命令（项目未配置时的兜底）。 */
export const VERIFY_COMMENT_PREFIX = "【自动复核】";
export const VERIFY_DEFAULT_COMMAND = "npm test";
/** 命令长度与输出尾段上限：评论是给人看的证据，不是日志搬运。 */
export const VERIFY_MAX_COMMAND = 300;
export const VERIFY_MAX_TAIL = 4000;
/** FR-94：随证据一起落盘的「本卡验收标准」上限（给人看，长文截断即可）。 */
export const VERIFY_MAX_ACCEPTANCE = 2000;

/** 命令归一：空/非字符串 → 默认命令；超长截断（防把整段脚本塞进评论）。 */
export function normalizeVerifyCommand(raw) {
  const s = String(raw ?? "").trim();
  return s === "" ? VERIFY_DEFAULT_COMMAND : s.slice(0, VERIFY_MAX_COMMAND);
}

/**
 * 人能读的结论（评审人第一眼看的就这一行）。
 *
 * 真机报障（2026-10-28 · hydro-two-ticket 的 T7-B）：默认命令 `npm test` 在一个 **不是 Node 工程**
 * 的工作区里跑，必然 `ENOENT package.json` ⇒ 退出码 254 ⇒ 结论被写成「失败」——**把"这条命令在这里
 * 不适用"谎报成"你的测试挂了"**，评审人据此点「请求返工」是纯误伤。
 * 故补第三态 `skipReason`：**不适用**既不是通过也不是失败，退出码照实落盘，不美化。
 */
export function verdictLabel({ exitCode, timedOut, skipReason } = {}) {
  if (skipReason) return `不适用（${skipReason}）`;
  if (timedOut) return "超时未完成";
  return exitCode === 0 ? "通过" : `失败（退出码 ${exitCode}）`;
}

/**
 * 从输出里读出**可核验的信号**（真机反馈 2026-10-22：「执行结果只返回一个结果，应该在自动复核证据内
 * 自动填入复核总结证据及结论」）。只做**保守解析**：认得 `node --test` 的两种 reporter
 * （TAP/经典 `# tests 12 # pass 12 # fail 0`、spec `ℹ tests 458 ℹ pass 458 ℹ fail 0`）
 * 与常见的 `N passed / M failed` 计数；认不出来就如实说"没有计数，以退出码为准"，绝不编造结论。
 *
 * 真机 2026-10-22（-130 自动复核，第三次报障）：本机 `npm test` 走 node 默认 spec reporter，
 * 计数行是 `ℹ tests 458` / `ℹ pass 458` / `ℹ fail 0` —— 原实现要求关键词必须是行首词
 * （`(?:^|\n)\s*#?\s*tests`），`ℹ` 把词顶掉了，于是 458/458 全绿却回 `counts: null`、
 * 结论只剩「以退出码 0 为准」。修法 = 允许行首出现 reporter 标记符号（ℹ / · / • / * / # / -）。
 */
export function summarizeVerifyOutput({ exitCode, timedOut = false, tail = "" } = {}) {
  const text = String(tail ?? "");
  const pick = (re) => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  // 行首允许出现的 reporter 标记：#（TAP）、ℹ（node spec）、·/•/*/-（各类美化输出）。
  const head = "(?:^|\\n)[\\s\\u2139\\u00b7\\u2022*#-]*";
  const tests = pick(new RegExp(head + "tests\\s+(\\d+)", "i"));
  const passed = pick(new RegExp(head + "pass(?:ed)?\\s+(\\d+)", "i")) ?? pick(/(\d+)\s+passing/i);
  const failed = pick(new RegExp(head + "fail(?:ed|ing)?\\s+(\\d+)", "i")) ?? pick(/(\d+)\s+failing/i);
  const durationMs = pick(/duration_ms\s+([\d.]+)/i);
  const failures = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^✖|^not ok|^FAIL|AssertionError|Error:/.test(line)) failures.push(line.slice(0, 200));
    if (failures.length >= 3) break;
  }
  let summary;
  if (timedOut) summary = "命令未在超时前结束：没有可用结论，先人工看输出尾段。";
  else if (passed !== null || tests !== null || failed !== null) {
    const total = tests !== null ? tests : (passed !== null && failed !== null ? passed + failed : null);
    const parts = [];
    if (total !== null) parts.push(`共 ${total} 项`);
    parts.push(`通过 ${passed ?? "?"}`);
    parts.push(`失败 ${failed ?? 0}`);
    if (durationMs !== null) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    summary = `测试计数：${parts.join(" · ")}`;
  } else if (exitCode === 0) summary = "输出里没有测试计数，以退出码 0 为准（建议人工扫一眼输出尾段）。";
  else summary = `输出里没有测试计数，以退出码 ${exitCode} 为准。`;
  return { summary, failures, counts: { tests, passed, failed, durationMs } };
}

/** 一次复核结果 → 证据评论正文（首行保持机器可读格式；总结与失败点各占一行，避免分隔符歧义）。 */
export function formatVerifyComment({ command, exitCode, durationMs = 0, timedOut = false, tail = "", summary = "", failures = [], acceptance = "", skipReason = null } = {}) {
  const seconds = (Math.round(Number(durationMs) / 100) / 10).toFixed(1);
  // 「未执行」只出现在「不适用」且确实没跑命令时（exitCode 为 null）；跑过但结论不适用时退出码照实写。
  const code = timedOut ? "超时" : (skipReason && exitCode === null ? "未执行" : exitCode);
  const head = `${VERIFY_COMMENT_PREFIX}命令=${command}；退出码=${code}；耗时=${seconds}s；结论=${verdictLabel({ exitCode, timedOut, skipReason })}`;
  const lines = [head];
  if (skipReason) lines.push(`不适用原因：${skipReason}`);
  // FR-94：把**本卡当初写下的验收标准**一并落进证据 —— 评审人一眼看到"按什么判定"，
  // 而不是只看一个退出码（真机反馈：「为了快速复核」）。未记录标准时**不写这一块**，不臆断。
  const standard = String(acceptance ?? "").trim().slice(0, VERIFY_MAX_ACCEPTANCE);
  if (standard) lines.push(`本卡验收标准：\n\`\`\`\n${standard}\n\`\`\``);
  if (summary) lines.push(`总结：${summary}`);
  if (Array.isArray(failures) && failures.length) lines.push(`失败点：\n${failures.map((f) => `- ${f}`).join("\n")}`);
  const body = String(tail ?? "").trim().slice(0, VERIFY_MAX_TAIL);
  if (body) lines.push(`输出尾段：\n\`\`\`\n${body}\n\`\`\``);
  return lines.join("\n");
}

const VERIFY_RE = /【自动复核】命令=(.+?)；退出码=(.+?)；耗时=([\d.]+)s；结论=(.+)/;

/** 证据评论 → 结构化结果（不是本机制写的评论一律回 null，绝不猜）。 */
export function parseVerifyComment(body) {
  const m = VERIFY_RE.exec(String(body ?? ""));
  if (!m) return null;
  const rawCode = m[2].trim();
  const numeric = /^-?\d+$/.test(rawCode);
  const exitCode = numeric ? Number(rawCode) : null;
  const text = String(body ?? "");
  const verdict = m[4].trim();
  // 第三态：结论以「不适用」开头 ⇒ 这条命令在该工作区不适用（不是测试失败）。老评论无此态 ⇒ applicable=true。
  const applicable = !verdict.startsWith("不适用");
  const skipReason = applicable ? null : ((/^不适用原因：(.*)$/m.exec(text)?.[1] ?? "").trim() || null);
  const summary = (/^总结：(.*)$/m.exec(text)?.[1] ?? "").trim() || null;
  const failBlock = /^失败点：\n((?:- .*\n?)+)/m.exec(text)?.[1] ?? "";
  const failures = failBlock.split(/\r?\n/).map((l) => l.replace(/^-\s*/, "").trim()).filter(Boolean);
  const tail = /输出尾段：\n```\n([\s\S]*?)\n```/.exec(text)?.[1] ?? "";
  const acceptance = /本卡验收标准：\n```\n([\s\S]*?)\n```/.exec(text)?.[1] ?? null;
  return {
    command: m[1],
    exitCode,
    timedOut: /超时/.test(rawCode), // 只有「超时」算超时；「未执行」是"不适用"的落盘形态
    applicable,
    skipReason,
    durationMs: Math.round(Number(m[3]) * 1000),
    verdict,
    summary,
    failures,
    tail,
    acceptance,
  };
}

/** 最近一次自动复核（按评论时间取最新；时间缺失时按写入顺序取最后一条）。 */
export function latestAutoReview(comments = []) {
  const rows = [];
  for (const c of comments ?? []) {
    const parsed = parseVerifyComment(c?.body);
    if (parsed) rows.push({ ...parsed, at: c.createdAt ?? c.at ?? null, commentId: c.id ?? null });
  }
  if (rows.length === 0) return null;
  const withAt = rows.filter((r) => r.at);
  if (withAt.length > 0) return withAt.slice().sort((a, b) => (String(a.at) < String(b.at) ? 1 : -1))[0];
  return rows[rows.length - 1];
}

/**
 * 评审证据包：评审人打开抽屉时，除了「评审通过 / 请求返工」还该看到什么。
 *
 * - `autoReview`：最近一次**机器复核**的结论（本机制产出）；
 * - `progress`：最近一条**有进展意义**的评论（执行方/团队的回报，复用 FR-75 的抽取口径）——
 *   「已自动跑过测试的返回结论」通常就落在这种评论里。
 */
export function buildReviewEvidence({ comments = [] } = {}) {
  const autoReview = latestAutoReview(comments);
  const others = (comments ?? []).filter((c) => !parseVerifyComment(c?.body));
  const progress = latestProgressComment(others);
  return {
    autoReview,
    progress: progress ? { at: progress.createdAt ?? progress.at ?? null, body: String(progress.body ?? "") } : null,
  };
}
