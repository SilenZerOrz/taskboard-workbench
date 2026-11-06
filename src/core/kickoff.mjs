/**
 * FR-92「项目开局对齐」—— 标准步骤程序（**纯函数**，不碰文件系统/数据库，可单测）。
 *
 * 来源：用户 2026-10-22 指定引入鱼皮《Vibe Coding 团队协作技巧》
 * （https://github.com/liyupi/ai-guide/blob/main/Vibe%20Coding%20零基础教程/30%20经验技巧/11%20Vibe%20Coding%20团队协作技巧.md），
 * 要求「作为项目任务看板工作台的项目开局对齐事项，建立相关团队&配置约束」，并
 * 「把该对齐作为标准化流程引入，作为任务工作台标准步骤程序执行」。
 *
 * 该文七条要点（统一代码规范 / 文档驱动 / Git 协作流程 / 代码审查 / AI 团队功能 / 协作机制 / 明确分工）
 * 在这里被压成 **6 个可自检的开局步骤**：每一步都有**可核验的判据**（工作区里存在哪些文件、
 * 项目设置里哪些约束已填），而不是"读一读就好"的口号 —— 这样工作台能自己回答"这个项目对齐了没有"。
 *
 * 红线（与 FR-85 同口径）：**自检只给结论，不改任何数据**；缺什么由人（或用既有入口）去补。
 */

import { TbError } from "./errors.mjs";

/** 出处（写进报告，便于追溯；引用不复制原文）。 */
export const KICKOFF_SOURCE = Object.freeze({
  title: "Vibe Coding 团队协作技巧（鱼皮 / ai-guide）",
  url: "https://github.com/liyupi/ai-guide/blob/main/Vibe%20Coding%20%E9%9B%B6%E5%9F%BA%E7%A1%80%E6%95%99%E7%A8%8B/30%20%E7%BB%8F%E9%AA%8C%E6%8A%80%E5%B7%A7/11%20Vibe%20Coding%20%E5%9B%A2%E9%98%9F%E5%8D%8F%E4%BD%9C%E6%8A%80%E5%B7%A7.md",
  note: "本仓只落**可执行的检查单与约束**，不搬运原文；需要原文请点链接。",
});

/**
 * 六个标准步骤。`checks` 每条：`paths`（工作区相对路径，任一存在即通过）或 `setting`
 * （项目设置里的点路径，非空即通过）或 `custom`（由调用方注入的布尔）。
 */
export const KICKOFF_ALIGNMENT_STEPS = Object.freeze([
  {
    id: "code-style",
    title: "① 统一代码规范",
    why: "各人用 AI 生成的风格不一致（React/Vue、camelCase/snake_case 混用）会让项目无法维护。",
    spec: "落一份规范文档 + 用 Linter/Formatter 强制执行 + 一份 AI 规则文件（AGENTS.md / CLAUDE.md / .cursorrules）。",
    checks: [
      { id: "style-doc", label: "规范文档（CODE_STYLE.md / AGENTS.md / CLAUDE.md / .cursorrules 任一）", paths: ["CODE_STYLE.md", "AGENTS.md", "CLAUDE.md", ".cursorrules", ".cursor/rules"] },
      { id: "linter", label: "Linter 配置", paths: [".eslintrc", ".eslintrc.json", ".eslintrc.cjs", ".eslintrc.js", "eslint.config.js", "eslint.config.mjs", "eslint.config.cjs"] },
      { id: "formatter", label: "Formatter 配置", paths: [".prettierrc", ".prettierrc.json", ".prettierrc.cjs", ".prettierrc.js", "prettier.config.js", "prettier.config.cjs"] },
    ],
  },
  {
    id: "docs-first",
    title: "② 文档驱动开发",
    why: "文档是协作基础：新人靠它上手，跨人交接靠它对齐。",
    spec: "README（简介/快速开始/技术栈/目录结构）+ 参与指南 + 变更记录。",
    checks: [
      { id: "readme", label: "README.md", paths: ["README.md", "readme.md"] },
      { id: "contributing", label: "参与指南（CONTRIBUTING.md 或 docs/规范/）", paths: ["CONTRIBUTING.md", "docs/规范", "docs/规范/README.md"] },
      { id: "changelog", label: "变更记录（CHANGELOG.md 或 docs/进度/）", paths: ["CHANGELOG.md", "docs/进度", "docs/进度/README.md"] },
    ],
  },
  {
    id: "git-flow",
    title: "③ Git 协作流程",
    why: "分支与提交不规范 ⇒ 冲突频发、历史不可追溯。",
    spec: "分支策略（main/develop/feature/bugfix）+ Conventional Commits + PR 模板与评审。",
    checks: [
      { id: "pr-template", label: "PR 模板（.github/PULL_REQUEST_TEMPLATE.md）", paths: [".github/PULL_REQUEST_TEMPLATE.md", ".github/pull_request_template.md"] },
      { id: "git-convention", label: "项目设置里写明 Git/提交约定（envConfig.gitFlow）", setting: "envConfig.gitFlow" },
    ],
  },
  {
    id: "review-gate",
    title: "④ 代码审查门",
    why: "审查是质量关键：上线前拦 Bug、统一风格，也是团队学习机会。",
    spec: "至少一人审查 + AI 初审 + 多 AI 交叉验证；审查未过不得合并/解锁下游。",
    checks: [
      { id: "reviewer-role", label: "团队模板里有 reviewer（审计）角色", custom: "reviewerRole" },
      { id: "review-gate", label: "项目设置里定义质量门（envConfig.qualityGates 或 teamTemplate.qualityGates）", setting: ["envConfig.qualityGates", "teamTemplate.qualityGates"] },
    ],
  },
  {
    id: "collaboration",
    title: "⑤ 协作机制与知识沉淀",
    why: "定期同步、知识分享、共享资源能避免重复踩坑。",
    spec: "站会/周会节奏 + 知识库 + 提示词与代码片段等共享资源。",
    checks: [
      { id: "cadence", label: "项目设置里写明同步节奏（envConfig.cadence）", setting: "envConfig.cadence" },
      { id: "knowledge", label: "知识沉淀目录（docs/规范/ 或 个人笔记/踩坑经验/）", paths: ["docs/规范", "docs/规范/README.md", "个人笔记/踩坑经验"] },
    ],
  },
  {
    id: "roles",
    title: "⑥ 明确分工",
    why: "谁负责什么要说清，避免重复工作或遗漏；同时别养成 AI 依赖症。",
    spec: "团队模板定义 lead/planner/engineer/tester/reviewer/archivist 的职责与模型。",
    checks: [
      { id: "roles-defined", label: "团队模板包含角色编制（teamTemplate.roles）", setting: "teamTemplate.roles" },
      { id: "executor", label: "工程师角色的执行器与验证命令已约定（teamTemplate.roles[engineer].executor / teamTemplate.engineer.verifyCommand）", custom: "engineerExecutor" },
    ],
  },
]);

/** 点路径取值（`a.b.c`）；空串/空数组/空对象都算"没填"。 */
export function pickSetting(settings, dotted) {
  let cur = settings;
  for (const key of String(dotted ?? "").split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[key];
  }
  return cur;
}

/** "有没有填"的判定：undefined/null/""/[]/{} 都算没填。 */
export function isFilled(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/**
 * 自检：`files` 是「工作区相对路径 → 是否存在」的映射（由 `../server/kickoff.mjs` 采集），
 * `settings` 是项目设置，`custom` 放调用方算好的布尔（如"团队模板里有 reviewer"）。
 */
export function evaluateKickoff({ files = {}, settings = {}, custom = {} } = {}) {
  const hasFile = (p) => files[p] === true;
  const steps = KICKOFF_ALIGNMENT_STEPS.map((step) => {
    const checks = step.checks.map((c) => {
      let ok;
      if (c.paths) ok = c.paths.some(hasFile);
      // `setting` 允许给一组候选点路径（各仓把同一件事放在不同位置，如 qualityGates 在
      // envConfig 或 teamTemplate 下都有先例）——任一已填即算通过。
      else if (c.setting) ok = (Array.isArray(c.setting) ? c.setting : [c.setting]).some((k) => isFilled(pickSetting(settings, k)));
      else if (c.custom) ok = custom[c.custom] === true;
      else ok = false;
      const settingHit = c.setting ? (Array.isArray(c.setting) ? c.setting : [c.setting]).find((k) => isFilled(pickSetting(settings, k))) : null;
      return { id: c.id, label: c.label, ok, evidence: c.paths ? c.paths.filter(hasFile).join(" / ") || null : settingHit ?? c.custom ?? null };
    });
    const done = checks.filter((c) => c.ok).length;
    const status = done === checks.length ? "done" : done === 0 ? "missing" : "partial";
    return { id: step.id, title: step.title, why: step.why, spec: step.spec, status, done, total: checks.length, checks };
  });
  const doneCount = steps.filter((s) => s.status === "done").length;
  const missing = steps.filter((s) => s.status !== "done");
  return {
    source: KICKOFF_SOURCE,
    steps,
    total: steps.length,
    doneCount,
    // 只有六步全 done 才算"对齐完成"；未对齐不阻断（不替用户做决定），但**必须显式提示**。
    ready: doneCount === steps.length,
    missing: missing.map((s) => ({ id: s.id, title: s.title, status: s.status, todo: s.checks.filter((c) => !c.ok).map((c) => c.label) })),
    verdict: doneCount === steps.length
      ? "开局对齐已完成（6/6）：可以进入拆解与派发。"
      : `开局对齐未完成（${doneCount}/${steps.length}）：未对齐项 ${missing.map((s) => s.title).join("、")}；建议先补齐再派发执行。`,
  };
}

/** 回查：report 的步骤只有 id/title/status/done/total/checks，判据来源（paths/setting/custom）
 *  必须回 `KICKOFF_ALIGNMENT_STEPS` 这**唯一一份**定义里取 —— 不复制第二份步骤定义。 */
const stepDefOf = (stepId) => KICKOFF_ALIGNMENT_STEPS.find((s) => s.id === stepId) ?? null;
const checkDefOf = (stepDef, checkId) => (stepDef?.checks ?? []).find((c) => c.id === checkId) ?? null;
/** 步骤在规范序里的下标（未知 stepId 排最后）。 */
const canonicalStepIndex = (stepId) => {
  const i = KICKOFF_ALIGNMENT_STEPS.findIndex((s) => s.id === stepId);
  return i < 0 ? KICKOFF_ALIGNMENT_STEPS.length : i;
};
/**
 * 判据的「可核验信号」——**结构化**描述（不解析自然语言）：
 *   { kind:"paths", any:[文件候选] } / { kind:"setting", keys:[点路径] } / { kind:"custom", id }
 * todolist 生成器据此拼**可执行命令**（见 buildKickoffTodos）。
 */
function signalOf(def) {
  if (Array.isArray(def?.paths) && def.paths.length) return { kind: "paths", any: def.paths.map(String) };
  if (def?.setting) return { kind: "setting", keys: (Array.isArray(def.setting) ? def.setting : [def.setting]).map(String) };
  if (def?.custom) return { kind: "custom", id: String(def.custom) };
  return { kind: "unknown" };
}
/** 信号 → 人能读的「动作 / 判据」文案（必须点名具体文件或设置项，禁止泛化措辞）。 */
function describeSignal(signal, fallbackId) {
  if (signal.kind === "paths") return { action: `新增/补齐文件（任一即可）：${signal.any.join(" / ")}`, criterion: `工作区存在文件（任一）：${signal.any.join(" / ")}` };
  if (signal.kind === "setting") return { action: `在项目设置里填写 ${signal.keys.join(" 或 ")} 的值`, criterion: `项目设置 ${signal.keys.join(" 或 ")} 非空` };
  if (signal.kind === "custom") return { action: `按团队模板补齐自检项 ${signal.id}`, criterion: `团队模板自检项 ${signal.id} 为真` };
  return { action: `补齐自检项 ${fallbackId}`, criterion: `自检项 ${fallbackId} 为真` };
}

/**
 * 卡 `-229`（需求 `R170`）：把自检结论**投影**成「缺口清单」。
 *
 * 入参就是 `evaluateKickoff()` 的返回值 —— **本函数不重新判定任何判据、不新增完成度真源**，
 * 只是把已经算好的 `steps[].done/total` 与 `checks[].ok` 换个形状摆出来。
 * 形状：`{ step, done, total, items:[{label, action, criterion, step}] }`
 *   · `step`   = 步骤总数（= report.steps.length，本项目 6）
 *   · `done`/`total` = **判据**级计数（逐步骤累加 report.steps[].done/total，不重算）
 *   · `items`  = 未通过的判据（`items.length === 0` ⟺ `done === total` ⟺ `report.ready === true`）
 *   · `items[].step` 是**步骤归属**（渲染表格用），同样直接取自 report，不是第二份完成度。
 */
export function collectGaps(report) {
  // F3（评审）：非法入参**显式抛错**。曾经静默返回全零 ⇒ 前端读成「零缺口＝已对齐」并置灰（假绿）。
  if (!report || typeof report !== "object" || Array.isArray(report) || !Array.isArray(report.steps)) {
    throw new TbError(
      "INVALID_FIELD",
      "collectGaps(report) 只接受 evaluateKickoff() 的返回值（对象且含 steps 数组）；传 projectId 字符串之类是误用 —— 缺口必须来自自检结果，不能凭空算",
      { got: Array.isArray(report) ? "array" : typeof report },
    );
  }
  const steps = report.steps;
  const items = [];
  for (const step of steps) {
    if (step?.status === "done") continue;          // 已完成步骤：整步跳过（只统计未完成）
    const stepDef = stepDefOf(step?.id);
    const title = String(step?.title ?? stepDef?.title ?? "");
    for (const check of step?.checks ?? []) {
      if (check?.ok === true) continue;             // 已通过判据：跳过（只统计未完成）
      const def = checkDefOf(stepDef, check?.id);   // F1：回查唯一一份步骤定义拿来源
      const signal = signalOf(def);
      const { action, criterion } = describeSignal(signal, String(check?.id ?? "?"));
      items.push({
        label: String(check?.label ?? def?.label ?? ""),
        action,
        criterion,
        step: title,
        stepId: String(step?.id ?? ""),
        checkId: String(check?.id ?? ""),
        signal,
      });
    }
  }
  const done = steps.reduce((n, s) => n + (Number(s?.done) || 0), 0);
  const total = steps.reduce((n, s) => n + (Number(s?.total) || 0), 0);
  return { step: steps.length, done, total, items };
}

/** 卡 `-230`（需求 R170）：每条 todo 的「完成后提示」——正文与结构体共用这一份文案。 */
export const KICKOFF_TODO_HINT = "完成后回配置页「项目开局对齐」重跑配置页自检（点「重新自检」；✅ 与计数随真实判据变化）";

/** 六步顺序的**唯一**短文案（注入正文与守卫都用它，别另抄一份）。 */
export const KICKOFF_ORDER_TEXT = "规范 → 文档 → Git → 审查 → 协作 → 分工";

/** 设置类判据的兜底基址：与 `scripts/tb-flow.mjs` 的 `--host` 约定同源，可用 TB_BASE 覆盖。 */
const SETTINGS_BASE = "http://127.0.0.1:3080/integrations/taskboard-workbench";

/** 单引号安全包裹（命令里会拼整段 node 脚本；脚本内只用双引号，不出现单引号）。 */
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

/**
 * `node -e` 脚本壳（Node 18+ 自带 fetch）：基址读 `TB_BASE`，缺省 `SETTINGS_BASE`。
 * 非 2xx / 解析失败 / 任何异常一律 `process.exit(1)` —— 拿不到数据＝判不通过，绝不假绿。
 */
const settingsFetchScript = (pid, body) =>
  `const base=process.env.TB_BASE||"${SETTINGS_BASE}";fetch(base+"/api/projects/${pid}/settings").then((r)=>{if(!r.ok)process.exit(1);return r.json();}).then((j)=>{${body}}).catch(()=>process.exit(1));`;

/** `setting` 判据的判定体：与 `isFilled()` 同口径（undefined/null/""/[]/{} 都算没填）。 */
const settingCheckBody = (keys) =>
  `const pick=(o,p)=>String(p).split(".").reduce((a,k)=>(a==null?a:a[k]),o);const filled=(v)=>v!==undefined&&v!==null&&(typeof v==="string"?v.trim()!=="":Array.isArray(v)?v.length>0:typeof v==="object"?Object.keys(v).length>0:true);process.exit(${JSON.stringify(keys)}.some((k)=>filled(pick(j,k)))?0:1);`;

/** `reviewerRole` 判定体：只在 `teamTemplate.roles` 段内看角色名是否含 `review`（不扫全 JSON）。 */
const REVIEWER_CHECK_BODY =
  `const r=j&&j.teamTemplate&&j.teamTemplate.roles;const names=Array.isArray(r)?r.map((x)=>String((x&&x.role)!==undefined?x.role:x).toLowerCase()):(r&&typeof r==="object"?Object.keys(r).map((k)=>k.toLowerCase()):[]);process.exit(names.some((n)=>n.includes("review"))?0:1);`;

/** `engineerExecutor` 判定体：与 `hasEngineerExecutor()` 同口径（roles[engineer].executor / roles.engineer / teamTemplate.engineer.verifyCommand）。 */
const ENGINEER_CHECK_BODY =
  `const t=j&&j.teamTemplate;const r=t&&t.roles;let ok=false;if(Array.isArray(r))ok=r.some((x)=>String((x&&x.role)!==undefined?x.role:"").toLowerCase()==="engineer"&&String((x&&x.executor)||"").trim()!=="");else if(r&&typeof r==="object"&&r.engineer)ok=true;if(!ok)ok=String((t&&t.engineer&&t.engineer.verifyCommand)||"").trim()!=="";process.exit(ok?0:1);`;

/** 候选路径 → 紧凑形态：无目录且有扩展名的，按「最后一个点之前」归并成 glob
 *  （`.eslintrc.json` / `.eslintrc.cjs` ⇒ `.eslintrc*`）；带目录或无扩展名的原样保留。
 *  只为把命令压短，**不新增判据真源**；语义仍是「任一存在即通过」。 */
const compactPathGlobs = (any) => {
  const groups = new Map();
  const order = [];
  for (const raw of any) {
    const base = String(raw);
    const dot = base.lastIndexOf(".");
    const stem = base.includes("/") || dot <= 0 ? base : base.slice(0, dot);
    if (!groups.has(stem)) { groups.set(stem, []); order.push(stem); }
    groups.get(stem).push(base);
  }
  return order.map((stem) => (groups.get(stem).length > 1 ? `${stem}*` : groups.get(stem)[0]));
};

/**
 * 判据信号 → **可执行命令**（POSIX sh；在项目工作区根目录执行）：
 *   · paths        ⇒ `e=$(ls -d …|head -1); [ -n "$e" ]`（文件存在性，任一即可；紧凑形态）
 *   · setting      ⇒ `node -e '…fetch …/api/projects/<id>/settings…'`，按 `isFilled()` 口径判**值非空**
 *   · custom       ⇒ 同上，但按角色名/执行器判（`reviewerRole` 只看 `teamTemplate.roles`）
 * 旧写法用 `grep '"gitFlow"'` 只匹配**键名**、`grep -i 'reviewer'` 是全 JSON 子串匹配，
 * 与「值非空 / 为该角色」不等价 ⇒ 键在值空、或无关文本里提到 reviewer 都会假绿。
 *
 * paths 分支的紧凑形态（卡 `t22`）：原 `[ -e "A" ] || [ -e "B" ] …` 全展开会随候选数线性变长
 * （code-style 一步 15 个候选），叠加多判据后超过 `VERIFY_MAX_COMMAND`。改为归并 glob + 一次 `ls -d`，
 * 判据语义不变（任一存在 ⇒ `$e` 非空 ⇒ 0）；glob 部分**不能加引号**（加引号就不展开）。
 */
export function gapVerifyCommand(signal, projectId) {
  const kind = signal?.kind ?? "unknown";
  if (kind === "paths") {
    const any = Array.isArray(signal.any) ? signal.any : [];
    if (any.length === 0) return "false";
    const items = compactPathGlobs(any).map((p) => (p.endsWith("*") ? p : shellQuote(p)));
    return `e=$(ls -d ${items.join(" ")} 2>/dev/null|head -1); [ -n "$e" ]`;
  }
  const pid = encodeURIComponent(String(projectId ?? "?"));
  if (kind === "setting") {
    const keys = (Array.isArray(signal.keys) ? signal.keys : []).map(String);
    return `node -e ${shellQuote(settingsFetchScript(pid, settingCheckBody(keys)))}`;
  }
  if (kind === "custom") {
    const id = String(signal.id ?? "");
    if (id === "reviewerRole") return `node -e ${shellQuote(settingsFetchScript(pid, REVIEWER_CHECK_BODY))}`;
    if (id === "engineerExecutor") return `node -e ${shellQuote(settingsFetchScript(pid, ENGINEER_CHECK_BODY))}`;
    // 未知 custom 项：保守不通过（宁可让人手工核，也不假绿）。
    return `echo ${shellQuote(`no machine check for custom:${id}`)} >&2; false`;
  }
  return `echo "no machine check for ${kind}" >&2; false`;
}

/** 卡 `-230`：缺口清单 → **分步 todolist**（一步一条，顺序固定 = 依赖顺序）。
 * **不解析自然语言**：全部字段由 `collectGaps().items[]` 的 `signal`/`action`/`criterion` 机械拼装。
 * 每条的 `hint` 固定为 `KICKOFF_TODO_HINT`（完成后回配置页重跑自检）。
 */
export function buildKickoffTodos({ project, gaps } = {}) {
  if (!gaps || typeof gaps !== "object" || !Array.isArray(gaps.items)) {
    throw new TbError("INVALID_FIELD", "buildKickoffTodos({project, gaps}) 需要 collectGaps() 的输出（含 items 数组）", { got: typeof gaps });
  }
  const pid = project?.id ?? null;
  const order = [];
  const buckets = new Map();
  for (const item of gaps.items) {
    const key = String(item?.stepId ?? item?.step ?? "");
    if (!buckets.has(key)) {
      buckets.set(key, { stepId: key, step: String(item?.step ?? ""), items: [] });
      order.push(key);
    }
    buckets.get(key).items.push(item);
  }
  // 顺序**按规范序**（不是入参出现顺序）：逆序喂进来也要输出 规范 → 文档 → Git → 审查 → 协作 → 分工。
  // 未知 stepId 排最后，相互间保持原顺序（稳定排序；Array#sort 自 ES2019 起保证稳定）。
  order.sort((a, b) => canonicalStepIndex(a) - canonicalStepIndex(b));
  return order.map((key, i) => {
    const bucket = buckets.get(key);
    const items = bucket.items;
    return {
      index: i + 1,
      stepId: bucket.stepId,
      step: bucket.step,
      action: items.map((it) => String(it?.action ?? "")).filter(Boolean).join("；"),
      criterion: items.map((it) => String(it?.criterion ?? "")).filter(Boolean).join("；"),
      verifyCommand: items.map((it) => `( ${gapVerifyCommand(it?.signal, pid)} )`).join(" && "),
      hint: KICKOFF_TODO_HINT,
      labels: items.map((it) => String(it?.label ?? "")).filter(Boolean),
    };
  });
}

/**
 * 卡 `t20`（需求 `R170`）：缺口注入的「建卡要求（关联需求）」段 —— **纯字符串拼接，不解析自然语言**。
 *
 * 为什么必须有这一段：执行侧收到缺口后是照正文建卡的，而 `store.createTask` 认完整 identifier
 * （形如 `taskboard-workbench-R170`）与简写 `R170`（卡 `-234` 起按本项目解析），且没归属的卡执行时
 * 会被归因门拒（`EXECUTION_NOT_ATTRIBUTED`）。正文里一个字不提「关联需求」⇒ 建出来的卡必然无归属 ⇒ 建了也跑不动。
 *
 * 三态（三选一，互斥）：
 *   · 给了 `requirement`（本次指定）⇒ 只写这一条，**不再**列候选（候选是噪音，还会引诱执行侧另选）；
 *   · 没给但有候选 ⇒ 列出来让人/执行侧选一条（完整标识 + 标题，两者都要，否则对不上号）；
 *   · 没给且无候选 ⇒ 明说「本项目暂无未关闭需求」，并给显式逃生口 `unattributedReason`。
 */
function buildRequirementSection(requirement, requirements) {
  const lines = [
    "## 建卡要求（关联需求）",
    "",
    "- 每张卡必须带 `requirement` 字段；写**完整标识**最稳（形如 `taskboard-workbench-R170`），简写 `R170` 也认（按本项目解析）。",
    "- 未归属的卡执行时会被归因门拒绝（`EXECUTION_NOT_ATTRIBUTED`）—— 建出来也跑不动。",
  ];
  const picked = requirement && typeof requirement === "object" ? String(requirement.identifier ?? "").trim() : "";
  if (picked !== "") {
    const title = String(requirement.title ?? "").trim();
    lines.push(`- 本次指定关联需求：\`${picked}\`${title ? `（${title}）` : ""}。`);
  } else {
    const candidates = (Array.isArray(requirements) ? requirements : [])
      .map((it) => ({ identifier: String(it?.identifier ?? "").trim(), title: String(it?.title ?? "").trim() }))
      .filter((it) => it.identifier !== "");
    if (candidates.length > 0) {
      lines.push("- 本次未指定：从下列候选里选一条填进 `requirement`（完整标识 + 标题）：");
      for (const it of candidates) lines.push(`  - \`${it.identifier}\`${it.title ? ` ${it.title}` : ""}`);
    } else {
      lines.push("- 本项目暂无未关闭需求，需先建需求条目或用 `unattributedReason` 显式声明（写明不归属的原因）。");
    }
  }
  lines.push("");
  return lines;
}

/**
 * 卡 `-229`：把缺口清单拼成**可直接投进主会话**的一段正文（纯函数，便于单测/复用）。
 * 表格四列与需求一致：步骤 / 缺什么 / 建议动作 / 判据；并按 report 的步骤顺序（即依赖顺序）排列。
 */
export function buildGapPrompt({ project, gaps, todos, requirement = null, requirements = [] } = {}) {
  const p = project ?? {};
  const g = gaps ?? { step: 0, done: 0, total: 0, items: [] };
  const items = Array.isArray(g.items) ? g.items : [];
  const todoList = Array.isArray(todos) ? todos : buildKickoffTodos({ project, gaps: g });
  const requirementSection = buildRequirementSection(requirement, requirements);
  const name = String(p.name ?? "").trim() || "（未命名项目）";
  const id = String(p.id ?? "").trim() || "?";
  const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const lines = [
    `[任务工作台 · 开局对齐缺口] 项目：${name}（${id}）`,
    "",
    `当前缺口 ${items.length} 项（共 ${Number(g.step) || 0} 步；判据自检 ${Number(g.done) || 0}/${Number(g.total) || 0} 已通过）。`,
    `请把下列缺口建成待办清单（todolist），**按依赖顺序推进**（${KICKOFF_ORDER_TEXT}）。`,
    "",
    "| # | 步骤 | 缺什么 | 建议动作 | 判据 |",
    "|---|---|---|---|---|",
  ];
  if (items.length === 0) {
    lines.push("| — | — | （无缺口：开局已对齐） | — | — |");
  } else {
    items.forEach((item, i) => {
      lines.push(`| ${i + 1} | ${cell(item?.step)} | ${cell(item?.label)} | ${cell(item?.action)} | ${cell(item?.criterion)} |`);
    });
  }
  lines.push("", `## 待办清单（todolist · 按依赖顺序推进 · 共 ${todoList.length} 条）`, "");
  if (todoList.length === 0) {
    lines.push("- （无缺口：开局对齐已完成，不需要待办）");
  } else {
    for (const todo of todoList) {
      lines.push(`${todo.index}. [ ] ${todo.step}`);
      lines.push(`   - 动作：${todo.action}`);
      lines.push(`   - 判据：${todo.criterion}`);
      lines.push(`   - 命令：${todo.verifyCommand}`);
      lines.push(`   - 完成：${todo.hint}`);
    }
  }
  lines.push(
    "",
    // 卡 `t20`：紧跟在待办清单之后 —— 执行侧读到这里正是「准备建卡」的那一刻，要求要摆在手边。
    ...requirementSection,
    "> 本清单与「开工语」（新会话首条 `KICKOFF_PROMPT` ①–⑧ 的第 ① 项）是**同一套六步**，不另立流程。",
    "",
    "## 推进纪律",
    "- 每完成一项，回配置页「项目开局对齐」点「重新自检」：✅ 与计数随真实判据变化（判据只此一份，不另立真源）。",
    "- 缺什么以自检读数为准：本清单由 evaluateKickoff() 的当前结果投影，不缓存、不臆断。",
  );
  return lines.join("\n");
}
