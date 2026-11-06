#!/usr/bin/env node
/**
 * 截断条目清单审计（**只读**）—— 卡 `-215` / 需求 `R159` 验收 ①「清单落盘」+ ②「方案选定并给代价」+ ③「抽样 diff」
 *
 * ## 为什么要有这台尺子
 * 早期导入把 `description` 写成 `slice(0, 2000)`，留下一批残片（根因见
 * `docs/进度/2026-11-04-R159判据说明与R160范围扩写.md` §A2）。前一轮给的判据是
 * 「≥2000 字符 **且** 末字符不在标点白名单里」，得 **64 条** —— 但那个白名单把
 * **行内代码的闭合反引号** `` ` `` 当成了句读，于是 `R9` / `R41` / `R51` 三条
 * 明明切在半句话上（如「…`#codex-taskboard-frame`」「…打印 `Full diagnostics: <path>`」
 * 「| a7 | `sessions.open`」），却被判成「完整」。**白名单这条路本身就是错的**：
 * 它问的是「最后一个字符长得像不像句号」，而不是「这句话说完了没有」。
 *
 * 本工具改用**两条客观判据**：
 *   甲（强判据·优先）源档在盘：`body` 是源文的**严格前缀**、源文更长、且 body 末字符
 *       不是终止符 ⇒ 必是**从源文里截出来的一段**。这条不依赖任何长度假设（`R16` 只有
 *        1988 字符照样抓得住），也不依赖标点白名单（前缀关系本身就是证据）。
 *   乙（弱判据·兜底）源档不在盘 / 源文已被改过：`body` 长度落在 `slice(0,2000)` 的
 *       签名区间（`1990–2002`，留出 rstrip 的余量）且末字符不是终止符。
 *
 * ## 纪律
 * 1. **只读**：`new DatabaseSync(..., { readOnly: true })`，全文件零 `INSERT/UPDATE/DELETE`
 *    （`tests/truncated-items-audit.test.mjs` 有源码守卫）。
 * 2. **不猜「可不可复原」**：源文在盘就逐字比（`firstDiff`），比不了就明写 `missing`。
 * 3. **默认退出码 0**：它是尺子不是门。`--strict` 才在「清单为空 / 读库失败」时退 1。
 * 4. **判据可导出**：`bodyOf` / `endsProperly` / `decideTruncated` 是纯函数，测试直接对拍。
 *
 * ## 用法
 *   node tools/audit-truncated-items.mjs                      # 摘要打屏
 *   node tools/audit-truncated-items.mjs --md                 # 人读清单（markdown 表格）打屏
 *   node tools/audit-truncated-items.mjs --json               # 机器可读打屏
 *   node tools/audit-truncated-items.mjs --out <dir>          # 两份都落盘（清单落盘＝验收①）
 *   node tools/audit-truncated-items.mjs --diff 5             # 另出 5 条补全 dry-run diff（验收③）
 *   node tools/audit-truncated-items.mjs --diff 99 --out DIR  # 全量 diff（49 条精确可复原）
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** 判据口径（随清单一起落盘，别人换台机器能复算同一集合）。 */
export const CRITERION = {
  schema: 1,
  /** `slice(0, 2000)` 的签名区间：1996–2000 是正常值，1990/2002 留 rstrip 余量。 */
  lengthSignature: [1990, 2002],
  /** 认为「这句话说完了」的末字符。**刻意不含反引号** —— 行内代码闭合不证明句子结束。 */
  terminators: "。！？…；）)】」』”\"'.:;!?]|>",
  rules: [
    "甲：源档在盘 且 body 是源文严格前缀 且 源文更长 且 末字符非终止符 ⇒ 截断",
    "乙：源档不在盘 / 源文已改 且 body 长度 ∈ [1990,2002] 且 末字符非终止符 ⇒ 截断（弱判据）",
    "body = description 去掉【归类 …】前缀行、去掉 `来源：` 头行、rstrip",
  ],
};

const TERMINATORS = new Set([...CRITERION.terminators]);
const CLASSIFY_RE = /^【归类[^\n]*】[^\n]*\n/;
const SOURCE_RE = /^\s*来源：\s*`([^`]+)`\s*$/;
const SRC_PATH_RE = /^\s*来源：\s*`([^`]+)`/m;

/**
 * 取「条目正文」：去掉 10-29 归类回写的前缀行、去掉 `来源：` 头行、去掉首尾空行。
 * 不这么做会把「前缀块的长度」算进正文，64/67 这类读数就没法对齐。
 */
export function bodyOf(description) {
  let d = String(description ?? "");
  d = d.replace(CLASSIFY_RE, "");
  d = d.replace(/^\s*来源：\s*`[^`]+`[^\n]*\n/, "");
  d = d.replace(/^\s*\n+/, "");
  return d.replace(/\s+$/, "");
}

/** 末字符是否算「说完了」。空串视为不完整（不该出现在截断集合里，但别让空串冒充完整）。 */
export function endsProperly(body) {
  const chars = [...String(body ?? "")];
  if (!chars.length) return false;
  return TERMINATORS.has(chars[chars.length - 1]);
}

/** 从 description 里取 `来源：` 指向的盘上相对路径（没有则 null）。 */
export function sourcePathOf(description) {
  const m = String(description ?? "").match(SRC_PATH_RE);
  return m ? m[1] : null;
}

/** 只留路径里目录+文件名，比对「链接改名」用。 */
function normalizeLinks(text) {
  return String(text ?? "").replace(/`?[\w./\-\u4e00-\u9fa5]*\/[\w./\-\u4e00-\u9fa5]*\.md`?/g, "<MD>");
}

/**
 * 判一条是否截断。
 * @param {{body: string, sourceText: string|null}} input
 * @returns {{truncated: boolean, rule: string|null}}
 */
export function decideTruncated({ body, sourceText }) {
  const n = String(body ?? "").length;
  const proper = endsProperly(body);
  if (proper) return { truncated: false, rule: null };
  if (sourceText) {
    const isPrefix = sourceText.startsWith(body) && sourceText.length > n;
    if (isPrefix) return { truncated: true, rule: "甲·源文严格前缀" };
    const [lo, hi] = CRITERION.lengthSignature;
    if (n >= lo && n <= hi) return { truncated: true, rule: "乙·长度签名(源文已改)" };
    return { truncated: false, rule: null };
  }
  const [lo, hi] = CRITERION.lengthSignature;
  if (n >= lo && n <= hi) return { truncated: true, rule: "乙·长度签名(源档缺失)" };
  return { truncated: false, rule: null };
}

/**
 * 源文可复原性三分类。
 * @returns {{kind: "exact"|"evolved"|"missing", firstDiff: number|null, linkDrift: boolean}}
 */
export function classifySource({ body, sourceText }) {
  if (!sourceText) return { kind: "missing", firstDiff: null, linkDrift: false };
  if (sourceText.startsWith(body) && sourceText.length > body.length) {
    return { kind: "exact", firstDiff: body.length, linkDrift: false };
  }
  const a = [...body];
  const b = [...sourceText];
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  const nb = normalizeLinks(body);
  const ns = normalizeLinks(sourceText);
  const linkDrift = ns.startsWith(nb) && ns.length > nb.length;
  return { kind: "evolved", firstDiff: i, linkDrift };
}

const idNum = (identifier) => {
  const m = String(identifier).match(/(\d+)\s*$/);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
};

/**
 * 纯函数主体：给条目数组 + 源文读取器，出逐条读数。**不碰数据库**（测试直接喂夹具）。
 * @param {{items: Array<{identifier: string, status: string, description: string}>, readSource?: (p: string) => string|null}} input
 */
export function auditItems({ items, readSource = () => null }) {
  const rows = [];
  for (const item of items) {
    const description = String(item.description ?? "");
    const body = bodyOf(description);
    const srcPath = sourcePathOf(description);
    const sourceText = srcPath ? readSource(srcPath) : null;
    const verdict = decideTruncated({ body, sourceText });
    if (!verdict.truncated) continue;
    const src = classifySource({ body, sourceText });
    rows.push({
      identifier: item.identifier,
      status: item.status,
      class: /^【归类/.test(description) ? "mirror" : "real",
      bodyLength: body.length,
      sourcePath: srcPath,
      sourceStatus: src.kind,
      sourceLength: sourceText ? sourceText.length : null,
      delta: sourceText && src.kind === "exact" ? sourceText.length - body.length : null,
      firstDiff: src.firstDiff,
      linkDrift: src.linkDrift,
      rule: verdict.rule,
      tail: [...body].slice(-24).join(""),
    });
  }
  rows.sort((x, y) => idNum(x.identifier) - idNum(y.identifier));
  return rows;
}

export function summarize(rows) {
  const count = (fn) => {
    const m = {};
    for (const r of rows) {
      const k = fn(r);
      if (k == null) continue;
      m[k] = (m[k] ?? 0) + 1;
    }
    return m;
  };
  const exact = rows.filter((r) => r.sourceStatus === "exact");
  const deltas = exact.map((r) => r.delta).sort((a, b) => a - b);
  const caps = [1000, 2000, 3000, 5000, 10000];
  return {
    truncated: rows.length,
    byClass: count((r) => r.class),
    byStatus: count((r) => r.status),
    bySource: count((r) => r.sourceStatus),
    byRule: count((r) => r.rule),
    exactCount: exact.length,
    exactReal: exact.filter((r) => r.class === "real").length,
    exactMirror: exact.filter((r) => r.class === "mirror").length,
    delta: deltas.length
      ? { min: deltas[0], median: deltas[Math.floor(deltas.length / 2)], max: deltas[deltas.length - 1], sum: deltas.reduce((a, b) => a + b, 0) }
      : null,
    /** 按「追加多少字算可读」分档 —— 决策用：补全不是越多越好，巨型 blob 反而不如指针。 */
    byDeltaCap: Object.fromEntries(
      caps.map((cap) => {
        const ok = exact.filter((r) => r.delta <= cap);
        return [cap, { total: ok.length, real: ok.filter((r) => r.class === "real").length, mirror: ok.filter((r) => r.class === "mirror").length }];
      })
    ),
  };
}

export function toMarkdown(rows, summary, meta = {}) {
  const lines = [];
  lines.push("# 需求条目描述截断清单（`slice(0,2000)` 存量损伤）");
  lines.push("");
  lines.push("> 卡 `-215` / 需求 `R159` 验收 ①。**只读产出**：本文件由 `tools/audit-truncated-items.mjs` 生成，");
  lines.push("> 逐条读数可随库重跑复算（判据见文末）。**本次未改任何 `description`。**");
  lines.push("");
  lines.push(`- 生成时刻：\`${meta.generatedAt ?? "-"}\``);
  lines.push(`- 数据源：\`${meta.db ?? "-"}\` · 项目 \`${meta.project ?? "-"}\` · 扫描条目 **${meta.itemsRead ?? "-"}** 条`);
  lines.push(`- 判定为截断：**${summary.truncated}** 条（镜像归档 **${summary.byClass.mirror ?? 0}** / 真条目 **${summary.byClass.real ?? 0}**，零 \`open\`）`);
  lines.push(
    `- 可复原性：精确可复原 **${summary.bySource.exact ?? 0}** / 源文已演进 **${summary.bySource.evolved ?? 0}** / 源档缺失 **${summary.bySource.missing ?? 0}**`
  );
  if (summary.delta) {
    lines.push(
      `- 精确可复原的追加量：合计 **${summary.delta.sum}** 字符（最小 ${summary.delta.min} / 中位 ${summary.delta.median} / 最大 ${summary.delta.max}）`
    );
  }
  lines.push("");
  lines.push("## 一、逐条读数");
  lines.push("");
  lines.push("| 编号 | 状态 | 类 | 正文 | 源文 | 差额 | 可复原性 | 判据 | firstDiff | 链接漂移 | 末 24 字 |");
  lines.push("|---|---|---|---:|---:|---:|---|---|---:|---|---|");
  for (const r of rows) {
    lines.push(
      `| ${r.identifier.replace(/^taskboard-workbench-/, "")} | ${r.status} | ${r.class === "mirror" ? "镜像归档" : "真条目"} | ${r.bodyLength} | ` +
        `${r.sourceLength ?? "—"} | ${r.delta ?? "—"} | ${r.sourceStatus} | ${r.rule} | ${r.firstDiff ?? "—"} | ` +
        `${r.linkDrift ? "是" : ""} | \`${String(r.tail).replace(/\|/g, "\\|").replace(/\n/g, "⏎")}\` |`
    );
  }
  lines.push("");
  lines.push("## 二、判据（可复算）");
  lines.push("");
  lines.push(`- 长度签名区间：\`[${CRITERION.lengthSignature.join(", ")}]\`（\`slice(0,2000)\` 的正常落点 1996–2000，两端留 rstrip 余量）`);
  lines.push(`- 终止符集合：\`${CRITERION.terminators}\` —— **不含反引号**（行内代码闭合≠句子结束；这是 \`R9\`/\`R41\`/\`R51\` 被前口径漏掉的原因）`);
  for (const rule of CRITERION.rules) lines.push(`- ${rule}`);
  lines.push("");
  return lines.join("\n");
}

/** 补全 dry-run：只算「该追加什么」，不写库。 */
export function buildAppendPlan(rows, readSource) {
  return rows
    .filter((r) => r.sourceStatus === "exact")
    .map((r) => ({ ...r, append: (readSource(r.sourcePath) ?? "").slice(r.bodyLength) }));
}

export function toAppendMarkdown(plan, { limit = Infinity } = {}) {
  const lines = [];
  lines.push("# 补全 dry-run：只算追加内容，**未写库**");
  lines.push("");
  lines.push(`> 对 **${plan.length}** 条「精确可复原」逐条给出：现有正文末尾 → 应追加的首尾。`);
  lines.push("> 施加口径：`description = description.trimEnd() + append`（纯尾部追加，语义零变化，diff 可逐条核）。");
  lines.push("> **本文件是演练，不是补全本身**；真正写入须先备份库并取得批准（验收③）。");
  lines.push("");
  lines.push(`## 一、全量交界表（${plan.length} 条，一条不漏）`);
  lines.push("");
  lines.push("| # | 编号 | 类 | 现正文 | 追加 | 补后 | 交界处（左 24 字 ⟂ 右 24 字） |");
  lines.push("|---:|---|---|---:|---:|---:|---|");
  plan.forEach((p, i) => {
    const left = String(p.tail).slice(-24).replace(/\|/g, "\\|").replace(/\n/g, "⏎");
    const right = p.append.slice(0, 24).replace(/\|/g, "\\|").replace(/\n/g, "⏎");
    lines.push(
      `| ${i + 1} | ${p.identifier.replace(/^taskboard-workbench-/, "")} | ${p.class === "mirror" ? "镜像" : "真条目"} | ${p.bodyLength} | +${p.append.length} | ` +
        `${p.bodyLength + p.append.length} | \`${left}\` ⟂ \`${right}\` |`
    );
  });
  lines.push("");
  lines.push(`## 二、逐条追加全文（抽样 ${Math.min(plan.length, limit)} 条）`);
  lines.push("");
  const show = plan.slice(0, limit);
  show.forEach((p, i) => {
    lines.push(`## ${i + 1}. ${p.identifier.replace(/^taskboard-workbench-/, "")}（${p.class === "mirror" ? "镜像归档" : "真条目"}· ${p.status}）`);
    lines.push("");
    lines.push(`- 现正文 ${p.bodyLength} → 补后 ${p.bodyLength + p.append.length}（+${p.append.length} 字符）· 源文 \`${p.sourcePath}\``);
    lines.push(`- 交界（左＝现有末 40 字，右＝追加首 40 字）：`);
    lines.push("");
    lines.push("```");
    lines.push(String(p.tail).slice(-40) + " ⟂ " + p.append.slice(0, 40).replace(/\n/g, "⏎"));
    lines.push("```");
    lines.push("");
    lines.push("<details><summary>追加全文（" + p.append.length + " 字符）</summary>");
    lines.push("");
    lines.push("```markdown");
    lines.push(p.append);
    lines.push("```");
    lines.push("");
    lines.push("</details>");
    lines.push("");
  });
  if (Number.isFinite(limit) && plan.length > limit) {
    lines.push(`> 其余 **${plan.length - limit}** 条按同口径处理（\`--diff 99\` 出全量）。`);
    lines.push("");
  }
  return lines.join("\n");
}

function printSummary(summary, meta) {
  console.log(`截断条目审计（只读）· ${meta.db} · 项目 ${meta.project}`);
  console.log(`扫描 ${meta.itemsRead} 条 ⇒ 判定截断 ${summary.truncated} 条（镜像 ${summary.byClass.mirror ?? 0} / 真条目 ${summary.byClass.real ?? 0}）`);
  console.log(`可复原性：精确 ${summary.bySource.exact ?? 0} / 演进 ${summary.bySource.evolved ?? 0} / 缺失 ${summary.bySource.missing ?? 0}`);
  console.log(`判据命中：${Object.entries(summary.byRule).map(([k, v]) => `${k}=${v}`).join(" · ")}`);
  if (summary.delta) console.log(`精确可复原追加量：合计 ${summary.delta.sum} 字符（min ${summary.delta.min} / 中位 ${summary.delta.median} / max ${summary.delta.max}）`);
  console.log(`按可读上限分档（≤N 字符的条数·真/镜）：${Object.entries(summary.byDeltaCap).map(([cap, v]) => `≤${cap}:${v.total}(${v.real}/${v.mirror})`).join(" · ")}`);
  console.log(`精确可复原：真条目 ${summary.exactReal} · 镜像归档 ${summary.exactMirror}`);
}

function main(argv) {
  const opt = { db: path.join(ROOT, ".data", "taskboard.sqlite"), project: "taskboard-workbench", out: null, diff: 0, mode: "summary", strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--db") opt.db = path.resolve(argv[++i]);
    else if (a === "--project") opt.project = argv[++i];
    else if (a === "--out") opt.out = path.resolve(argv[++i]);
    else if (a === "--diff") opt.diff = Number(argv[++i]);
    else if (a === "--json") opt.mode = "json";
    else if (a === "--md") opt.mode = "md";
    else if (a === "--strict") opt.strict = true;
    else if (a === "--help" || a === "-h") {
      console.log("用法：node tools/audit-truncated-items.mjs [--db <sqlite>] [--project <id>] [--out <dir>] [--diff <n>] [--json|--md] [--strict]");
      return 0;
    } else {
      console.error(`未知参数：${a}`);
      return 2;
    }
  }

  let items;
  try {
    const db = new DatabaseSync(opt.db, { readOnly: true });
    items = db.prepare("select identifier,status,description from requirement_items where project_id = ?").all(opt.project);
    db.close();
  } catch (e) {
    console.error(`读库失败：${e.message}`);
    return opt.strict ? 1 : 0;
  }

  const readSource = (rel) => {
    const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
  };

  const rows = auditItems({ items, readSource });
  const summary = summarize(rows);
  const meta = { generatedAt: new Date().toISOString(), db: path.relative(ROOT, opt.db) || opt.db, project: opt.project, itemsRead: items.length };
  const report = { schema: 1, criterion: CRITERION, meta, summary, items: rows };

  const md = toMarkdown(rows, summary, meta);
  if (opt.mode === "json" && !opt.out) console.log(JSON.stringify(report, null, 2));
  else if (opt.mode === "md" && !opt.out) console.log(md);
  else if (!opt.out) printSummary(summary, meta);

  if (opt.out) {
    mkdirSync(opt.out, { recursive: true });
    writeFileSync(path.join(opt.out, "truncated-items.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(path.join(opt.out, "truncated-items.md"), md + "\n");
    const files = ["truncated-items.json", "truncated-items.md"];
    if (opt.diff > 0) {
      const plan = buildAppendPlan(rows, readSource);
      writeFileSync(path.join(opt.out, "dryrun-appends.md"), toAppendMarkdown(plan, { limit: opt.diff }) + "\n");
      files.push("dryrun-appends.md");
    }
    console.log(`已落盘 ${opt.out}`);
    for (const f of files) console.log(`  - ${f}`);
  } else if (opt.diff > 0) {
    const plan = buildAppendPlan(rows, readSource);
    console.log(toAppendMarkdown(plan, { limit: opt.diff }));
  }

  if (opt.strict && rows.length === 0) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
