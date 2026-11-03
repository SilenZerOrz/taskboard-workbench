#!/usr/bin/env node
/**
 * P0③ 基线度量（卡 `-193` / 需求 `R146` / FR-113）
 *
 * 为什么要有这个脚本：v2 稿要求「对快照复评」，但 `.data/` 里没有 2026-11-03 的基线快照
 * （最新是 10-29 pre-classify）⇒ M1–M4 的改善量没有可比分母。而直接拿**活库**当基线更糟：
 * 每开一张卡读数就变一次（本稿写作期间 210→212）—— 那不是「数据更新」，是**测尺在长**。
 *
 * 三条纪律：
 * 1. **快照 + sha256 一次落盘、不许悄悄改**：目标文件已存在时默认拒绝（换日期或 `--force`）。
 * 2. **之后所有复评对快照跑，不对活库**：`--db` 指向活库 = 只用于**产快照**，度量永远读快照。
 * 3. **偏差要写在报告里**：M1 依赖 `task_events`，而事件流本身有已知漏报 ⇒ 报告里必须带样本量与覆盖率，
 *    否则「改善了 30%」可能只是「样本从 129 掉到 90」。
 *
 * 用法：
 *   node tools/baseline-metrics.mjs                       # 产快照 + 产报告
 *   node tools/baseline-metrics.mjs --db .data/taskboard.sqlite --snapshot .data/backup-20261103.sqlite
 *   node tools/baseline-metrics.mjs --snapshot .data/backup-20261103.sqlite --report /dev/stdout
 *   node tools/baseline-metrics.mjs --snapshot … --verify   # 同快照跑两遍，断言读数一致（验收判据④）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
const has = (name) => process.argv.includes(`--${name}`);
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const DB = path.resolve(ROOT, arg("db", ".data/taskboard.sqlite"));
const SNAPSHOT = path.resolve(ROOT, arg("snapshot", `.data/backup-${today}.sqlite`));
const REPORT = arg("report", `docs/进度/${new Date().toISOString().slice(0, 10)}-基线度量报告.md`);

/* ---------------------------------------------------------------- 快照 ---- */
async function makeSnapshot() {
  if (!fs.existsSync(DB)) throw new Error(`活库不存在：${DB}`);
  if (fs.existsSync(SNAPSHOT) && !has("force")) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(SNAPSHOT)).digest("hex");
    throw new Error(`快照已存在，拒绝覆盖（基线一旦落盘不许悄悄改）：${SNAPSHOT}\n  现有 sha256=${sha}\n  要重产请换 --snapshot 路径或加 --force`);
  }
  fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
  const src = new DatabaseSync(DB, { readOnly: true });
  try {
    // 与 `sqlite3 <db> ".backup '<out>'"` 等价；WAL 下也保证一致（不用 cp，cp 会拷到半写状态）
    await backup(src, SNAPSHOT);
  } finally {
    src.close();
  }
  return crypto.createHash("sha256").update(fs.readFileSync(SNAPSHOT)).digest("hex");
}
const sha256Of = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

/* ---------------------------------------------------------------- 度量 ---- */
const pct = (sorted, p) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
};
const hours = (a, b) => (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

function measure(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const one = (sql, ...p) => db.prepare(sql).get(...p);
  try {
    const out = { snapshot: { path: dbPath, sha256: sha256Of(dbPath) } };

    /* 时间锚点：用快照里最大的 updated_at，而不是 new Date() —— 否则 --verify 永远不一致 */
    const anchor = one("select max(updated_at) as t from tasks")?.t ?? null;

    /* M1a —— 当前滞留（还没走的那些卡，v2 稿「中位 145.1h」量的就是这个） */
    const openReview = db.prepare("select id, identifier, review_requested_at, updated_at from tasks where status = 'in_review'").all();
    const openAges = [];
    let openNoEvent = 0;
    for (const r of openReview) {
      const e = one("select min(at) as t from task_events where task_id = ? and type = 'status_changed' and to_value = 'in_review'", r.id);
      const since = e?.t ?? r.review_requested_at ?? null;
      if (!since || !anchor) { openNoEvent += 1; continue; }
      openAges.push(hours(since, anchor));
    }
    openAges.sort((a, b) => a - b);

    /* M1b —— in_review 停留（唯一有历史数据的度量） */
    const enters = db.prepare(`
      select task_id, min(at) as t_enter from task_events
       where type = 'status_changed' and to_value = 'in_review' group by task_id`).all();
    // 口径与 v2 稿一致：**首次进入待验收 → 首次 done**（不拿「打回」当离开，否则量到的是往返耗时）
    const stay = [];
    const rework = [];
    const enterCount = new Map();
    for (const e of db.prepare(`select task_id, count(*) as n from task_events where type='status_changed' and to_value='in_review' group by task_id`).all()) enterCount.set(e.task_id, e.n);
    for (const e of enters) {
      const done = one(
        `select min(at) as t from task_events where task_id = ? and type = 'status_changed' and to_value = 'done' and at > ?`,
        e.task_id, e.t_enter);
      if (!done?.t) continue;
      const h = hours(e.t_enter, done.t);
      stay.push(h);
      if ((enterCount.get(e.task_id) ?? 1) > 1) rework.push(h); // 返工卡单列
    }
    stay.sort((a, b) => a - b);
    rework.sort((a, b) => a - b);
    const doneCards = one("select count(*) as n from tasks where status = 'done'").n;
    const doneWithEvent = one(`
      select count(distinct t.id) as n from tasks t
        join task_events e on e.task_id = t.id and e.type = 'status_changed' and e.to_value = 'done'
       where t.status = 'done'`).n;
    const inReview = one("select count(*) as n from tasks where status = 'in_review'").n;
    const inReviewNoReq = one("select count(*) as n from tasks where status = 'in_review' and (review_requested_at is null or review_requested_at = '')").n;
    out.M1 = {
      anchorAt: anchor,
      openInReview: openReview.length,
      openAgeMedianHours: round1(pct(openAges, 50)),
      openAgeP90Hours: round1(pct(openAges, 90)),
      openAgeMissingSeries: openNoEvent,
      completedCycles: stay.length,
      medianHours: round1(pct(stay, 50)),
      p90Hours: round1(pct(stay, 90)),
      reworkCycles: rework.length,
      reworkMedianHours: round1(pct(rework, 50)),
      doneCards,
      doneCardsWithEvent: doneWithEvent,
      eventCoveragePct: doneCards ? round1((doneWithEvent / doneCards) * 100) : null,
      leakProxyPct: doneCards ? round1(((doneCards - doneWithEvent) / doneCards) * 100) : null,
      inReviewNow: inReview,
      inReviewWithoutReviewRequest: inReviewNoReq,
    };

    /* M2 —— 每交付物确认次数（改造前 = 逐卡 1:1，故基线＝卡/需求 比） */
    const doneAttr = one(`select count(*) as cards, count(distinct requirement_id) as reqs from tasks where status = 'done' and requirement_id is not null`) ?? { cards: 0, reqs: 0 };
    out.M2 = {
      confirmationsPerRequirement: doneAttr.reqs ? round1(doneAttr.cards / doneAttr.reqs) : null,
      doneCardsAttributed: doneAttr.cards,
      distinctRequirements: doneAttr.reqs,
      note: "改造前口径＝每张卡一次人工确认（1:1）；故此比值＝「一个需求平均被确认几次」的基线",
    };

    /* M3 / M4 —— 字段不存在 ⇒ 必须报「不可测」，不能报 0 */
    const hasAccState = db.prepare("select count(*) as n from pragma_table_info('tasks') where name = 'acceptance_state'").get().n > 0;
    out.M3 = { measurable: hasAccState, baseline: null, note: hasAccState ? "字段已存在" : "acceptance_state 不存在（0.4.0 阶段 1 才加）⇒ 从 0.4.0 起算" };
    out.M4 = { measurable: false, baseline: null, note: "Router 未上线（0.5.0 observe 期才产生）⇒ 无基线" };

    /* 偏差与现场（报告里必须有的那几行） */
    out.context = {
      // 代码里的 SCHEMA_VERSION 是常量（不落库）；这里记库自身的 user_version，别把两者混为一谈
      dbUserVersion: (() => { try { return db.prepare("pragma user_version").get().user_version; } catch { return null; } })(),
      tasks: one("select count(*) as n from tasks").n,
      tasksNonTerminal: one("select count(*) as n from tasks where status not in ('done','canceled')").n,
      activeWithoutAcceptance: one("select count(*) as n from tasks where status not in ('done','canceled') and trim(acceptance) = ''").n,
      requirementItems: one("select count(*) as n from requirement_items").n,
      requirementsOpen: one("select count(*) as n from requirement_items where status = 'open'").n,
      requirementItemsWithoutAcceptance: one("select count(*) as n from requirement_items where trim(acceptance) = ''").n,
      comments: one("select count(*) as n from comments").n,
      taskEvents: one("select count(*) as n from task_events").n,
      statusChangedEvents: one("select count(*) as n from task_events where type = 'status_changed'").n,
      taskRuns: one("select count(*) as n from task_runs").n,
    };
    return out;
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------- 报告 ---- */
function render(m) {
  const c = m.context;
  const f = (v) => (v == null ? "—" : String(v));
  return `# 基线度量报告（P0③ 产物）

> 卡 \`-193\` · 需求 \`R146\`（FR-113）· 生成脚本 \`tools/baseline-metrics.mjs\`
> **本报告的所有读数都取自快照，不取活库**；活库每开一张卡就变一次，不能当基线。

## 一、快照

| 项 | 值 |
|---|---|
| 快照文件 | \`${m.snapshot.path.replace(ROOT + "/", "")}\` |
| sha256 | \`${m.snapshot.sha256}\` |
| 生成方式 | \`node:sqlite\` 的 \`backup()\`（等价 \`sqlite3 <db> ".backup '<out>'"\`；**不是 \`cp\`**，WAL 下 \`cp\` 会拷到半写状态） |

复跑同口径：\`node tools/baseline-metrics.mjs --snapshot <上面的路径> --report /tmp/rerun.md\`

## 二、M1 · \`in_review\` 停留

### M1a 当前滞留（**还没走的那批**；v2 稿的「中位 145.1h」量的就是这个）

| 读数 | 值 |
|---|---|
| 时间锚点（快照内最大 \`updated_at\`） | ${f(m.M1.anchorAt)} |
| 当前 \`in_review\` 卡数 | ${f(m.M1.openInReview)} |
| 其中无任何 \`in_review\` 事件也无 \`review_requested_at\`（**滞留时长不可测**） | ${f(m.M1.openAgeMissingSeries)} |
| **滞留中位** | **${f(m.M1.openAgeMedianHours)} h** |
| 滞留 P90 | ${f(m.M1.openAgeP90Hours)} h |

### M1b 已完成周期（**曾经走过的那批**：首次进入 → 首次 done）

| 读数 | 值 |
|---|---|
| 完整「进入待验收 → 离开」周期数 | **${f(m.M1.completedCycles)}** |
| 中位停留 | **${f(m.M1.medianHours)} h** |
| P90 停留 | **${f(m.M1.p90Hours)} h** |
| 其中返工卡（\`in_review\` 进入 >1 次） | ${f(m.M1.reworkCycles)} 张，中位 ${f(m.M1.reworkMedianHours)} h |
| 当前 \`in_review\` 卡数 | ${f(m.M1.inReviewNow)} |
| 其中 \`review_requested_at\` 为空 | ${f(m.M1.inReviewWithoutReviewRequest)} |
| \`done\` 卡总数 | ${f(m.M1.doneCards)} |
| 有 \`status_changed → done\` 事件的 done 卡 | ${f(m.M1.doneCardsWithEvent)}（覆盖率 **${f(m.M1.eventCoveragePct)}%**） |
| **事件漏报（代理）** | **${f(m.M1.leakProxyPct)}%** |

> **偏差（必须一起引用）**：M1 完全依赖 \`task_events\`。团队通道（\`teamSetTaskStatus\` / \`applyTeamTaskOutcome\`）历史上不发 \`status_changed\`，故样本天然偏小（v2 稿实测 129/175 ≈ 74% 覆盖）。**P0②（\`-194\`）修完之前，M1 的任何"改善"都可能只是样本变小。** 这也是 P0② 排在 0-A 之前的原因。

## 三、M2 · 每交付物确认次数

| 读数 | 值 |
|---|---|
| 已归因的 done 卡 | ${f(m.M2.doneCardsAttributed)} |
| 覆盖的需求条目数 | ${f(m.M2.distinctRequirements)} |
| **确认次数 / 需求** | **${f(m.M2.confirmationsPerRequirement)}** |

> ${m.M2.note}。观察期闸门要的是这个比值**降到 ≤ 1:3**（一个需求一次确认覆盖多张卡）。

## 四、M3 · 打回率 / M4 · Router 一致率

| 度量 | 可测 | 基线 | 说明 |
|---|---|---|---|
| M3 打回率 | ${m.M3.measurable ? "是" : "**否**"} | ${f(m.M3.baseline)} | ${m.M3.note} |
| M4 Router—人一致率 | 否 | — | ${m.M4.note} |

> **不可测就写"不可测"，不写 0** —— 写 0 会被下一轮当成"已测量且为零"，是标准的双源失真。

## 五、现场读数（判定上下文）

| 项 | 值 |
|---|---|
| DB 的 user_version（**≠** 代码里的 SCHEMA_VERSION） | ${f(c.dbUserVersion)} |
| 任务总数 | ${f(c.tasks)} |
| 非终态任务 | ${f(c.tasksNonTerminal)} |
| **非终态且无验收标准** | **${f(c.activeWithoutAcceptance)}** |
| 需求条目总数 / open | ${f(c.requirementItems)} / ${f(c.requirementsOpen)} |
| **需求条目无验收标准** | **${f(c.requirementItemsWithoutAcceptance)}** |
| 评论总数 | ${f(c.comments)} |
| 事件总数 / \`status_changed\` | ${f(c.taskEvents)} / ${f(c.statusChangedEvents)} |
| 尝试记录 | ${f(c.taskRuns)} |

## 六、这份基线能回答什么、不能回答什么

- **能**：0.4.0 上线后 M1 是否下降、M2 是否从逐卡收敛到按需求 —— 只要**同一快照 + 同一脚本**再跑一次。
- **不能**：跨版本比较活库读数（活库在长）；也不能在 P0② 修完前断言 M1 的真实分布（漏报偏小样本）。
`;
}

/* ---------------------------------------------------------------- main ---- */
const verify = has("verify");
const snapshotGiven = process.argv.includes("--snapshot");
// 指向**已存在**的快照且没加 --force ⇒ 只度量、不重产（基线一旦落盘不许悄悄改）
const needSnapshot = !has("no-snapshot") && !(snapshotGiven && fs.existsSync(SNAPSHOT) && !has("force"));
if (needSnapshot) {
  const sha = await makeSnapshot();
  console.log(`快照: ${SNAPSHOT.replace(ROOT + "/", "")}\nsha256: ${sha}`);
} else if (fs.existsSync(SNAPSHOT)) {
  console.log(`复用已有快照（不重产）: ${SNAPSHOT.replace(ROOT + "/", "")}\nsha256: ${sha256Of(SNAPSHOT)}`);
}
const target = SNAPSHOT;
if (!fs.existsSync(target)) throw new Error(`快照不存在：${target}`);

const m1 = measure(target);
if (verify) {
  const m2 = measure(target);
  const a = JSON.stringify(m1), b = JSON.stringify(m2);
  if (a !== b) {
    console.error("❌ --verify 失败：同一快照两次读数不一致");
    process.exit(1);
  }
  console.log("✅ --verify：同一快照两次读数完全一致");
}

const body = render(m1);
if (REPORT === "/dev/stdout" || REPORT === "-") {
  process.stdout.write(body);
} else {
  const abs = path.resolve(ROOT, REPORT);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  console.log(`报告: ${abs.replace(ROOT + "/", "")}（${body.split("\n").length} 行）`);
}
console.log("\nM1 中位/ P90 =", m1.M1.medianHours, "/", m1.M1.p90Hours, "h | 样本", m1.M1.completedCycles, "| 事件覆盖", m1.M1.eventCoveragePct + "%");
console.log("M2 确认次数/需求 =", m1.M2.confirmationsPerRequirement);
