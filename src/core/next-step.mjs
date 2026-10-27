/**
 * 「下一步」引导（纯函数）——抽屉里那张卡**现在该做什么**的唯一口径。
 *
 * 为什么单独成一个模块：真机反馈（2026-10-22）「任务详情界面没有下一步该做啥的提示，
 * 也没有操作按钮」——按钮此前按**功能分类**散落在「评审 / 操作 / 人工校验」各区，
 * 没有任何一处回答"我现在该干嘛"；尤其"被人工校验门挡住"的卡只有一行文字说明，
 * 连跳过去下结论的入口都没有。引导口径是**状态推导**，与渲染无关，因此放核心层做纯函数、
 * 由单测覆盖每个分支，前端只负责把 action id 映射成按钮与埋点。
 *
 * 设计约束：
 * - **只读推导**，不改任何状态；不产生副作用。
 * - action 用稳定 id 表达意图，文案与处理留在前端（本模块不碰 DOM / 不发请求）。
 * - 优先级即数组顺序：人工校验门 > 评审 > 其它状态。人环门是**上游阻塞**，
 *   它挡住时"去下结论"永远比"这张卡自己该怎么走"更该先说。
 */

/** 全部可能的引导码（测试与前端兜底用）。 */
export const NEXT_STEP_CODES = Object.freeze([
  "human-review-pending",
  "blocked-by-human-review",
  "awaiting-human-done",
  "review-pending",
  "rework",
  "blocked",
  "blocked-no-attribution",
  "needs-host-action",
  "backlog",
  "backlog-no-attribution",
  "todo-no-attribution",
  "todo",
  "in-progress",
  "in-progress-stalled",
  "done",
  "canceled",
  "unknown",
]);

const ACTION_KINDS = Object.freeze(["primary", "default", "danger"]);

function action(id, label, kind = "default") {
  if (!ACTION_KINDS.includes(kind)) throw new Error(`未知按钮语义：${kind}`);
  return { id, label, kind };
}

function isHumanReview(task) {
  const labels = Array.isArray(task?.labels) ? task.labels : [];
  return labels.some((l) => String(l ?? "").trim() === "human_review");
}

function blockedBy(task) {
  const blocker = task?.humanReviewBlocker ?? null;
  if (!blocker || !blocker.identifier) return null;
  return { identifier: String(blocker.identifier), title: blocker.title ?? null, category: blocker.category ?? null };
}

/**
 * 「下一步是宿主 / 终端类动作」的特征词（FR-97）。
 *
 * 口径要窄：命中即断言"看板执行循环做不了"，误判会把普通卡错误地推给主会话。
 * 只收**明确的宿主/环境动作**说法，不收"重启服务"之外含义模糊的词。
 */
const HOST_ACTION_RE = /(\.dsh\/profiles|~\/\.dsh|LaunchAgent|plist|dsh plugin (add|remove)|pnpm install|重启\s*(dsh|宿主|服务)|重载插件|安装插件|杀进程|\bkill\b)/i;

/** 卡是否需要宿主/终端环境才能推进（已归因才有意义：未归因交出去也走不通）。 */
function needsHostAction(task, ctx = {}) {
  if (!task?.requirementId) return false;                 // 未归因：先归因，别推给主会话
  if (ctx.hostAction === true) return true;               // 调用方可显式给判据（如人工标注）
  if (ctx.hostAction === false) return false;
  const haystack = [task.title, task.description, task.nextStepHint].filter(Boolean).join("\n");
  return HOST_ACTION_RE.test(haystack);
}

/**
 * 推导「下一步」。
 *
 * @param {object} task 任务行（含 status / labels / reviewState / requirementId / humanReview* 字段）
 * @param {object} [ctx]
 * @param {{identifier:string,title?:string,category?:string}|null} [ctx.humanReviewBlocker]
 *        当本卡的**前置**里有一张「待结论」的人工校验卡时传它（前端从依赖表映射得到）
 * @returns {{code:string,title:string,hint:string,actions:Array<{id:string,label:string,kind:string}>,
 *            blocker:{identifier:string,title:string|null,category:string|null}|null}}
 */
function derive(task, ctx = {}) {
  const t = task ?? {};
  const status = String(t.status ?? "");
  const review = t.reviewState === null || t.reviewState === undefined || t.reviewState === "" ? null : String(t.reviewState);
  const closed = status === "done" || status === "canceled";
  const blocker = closed ? null : blockedBy(ctx);

  // 1) 本卡自己就是人工校验卡且尚未结论 —— 唯一出口是下结论（执行侧不得认领、不得 done）。
  if (isHumanReview(t) && String(t.humanReviewState ?? "pending") !== "concluded") {
    return {
      code: "human-review-pending",
      title: "这一步归你：给人工校验结论",
      hint: "本卡是人工校验卡（人在环升级门）——结论给出前它挡住的下游一律不推进；执行侧不得认领、不得置「完成」。",
      actions: [action("conclude-human-review", "去下结论（本页「人工校验」区块）", "primary")],
      blocker: null,
    };
  }

  // 2) 本卡被一张「待结论」的人工校验卡挡住 —— 先说清"被谁挡、去哪解"，并给直达入口。
  if (blocker) {
    return {
      code: "blocked-by-human-review",
      title: `被人工校验门挡住：${blocker.identifier}`,
      hint: `前置 ${blocker.identifier} 是人工校验卡（待结论）${blocker.category ? `·类别 ${blocker.category}` : ""}：结论给出前本卡不推进、不自动重派。先去那张卡下结论。`,
      actions: [
        action("open-blocker", `打开 ${blocker.identifier} 下结论`, "primary"),
        action("goto-deps", "查看阻塞因素"),
      ],
      blocker,
    };
  }

  // 3) 待验收：按评审态分流。
  if (status === "in_review") {
    if (review === "approved") {
      return {
        code: "awaiting-human-done",
        title: "只差你点「完成」",
        hint: "实现与评审都过了。红线：完成只能由人确认，执行侧与评审都不会代点。",
        actions: [action("complete", "完成（仅人工可确认）", "primary")],
        blocker: null,
      };
    }
    if (review === "changes_requested") {
      return {
        code: "rework",
        title: "返工中：按评审说明改完再提交评审",
        hint: `返工第 ${t.reviewRound ?? 0} 轮${t.reviewSourceStatus ? `·完成后先回「${t.reviewSourceStatus}」再提交` : ""}；返工只回来源列，下游继续受阻直到解锁。`,
        actions: [action("goto-review", "去「评审」区块填说明", "primary")],
        blocker: null,
      };
    }
    return {
      code: "review-pending",
      title: "等你评审",
      hint: t.reviewer ? `评审者：${t.reviewer}` : "未指派评审者：超时会产出「评审死锁」诊断。",
      actions: [
        action("review-approve", "评审通过", "primary"),
        action("goto-review", "请求返工（需填说明）"),
      ],
      blocker: null,
    };
  }

  // 4) 受阻。
  if (status === "blocked") {
    // FR-97：受阻且已归因的卡此前只有「重试 / 看诊断」两个出口 —— 但**大量受阻卡的真实卡点
    // 是「卡住了、需要人或环境介入」**（要动 ~/.dsh、要重启宿主），反复「重试」既不解决也不该由
    // 团队自己扛。给两个可点出口：交项目主会话执行（调试修复）/ 转为执行调试。
    // 归因门在先：未归因的卡交出去也走不通，先说清该去归因。
    if (!t.requirementId) {
      return {
        code: "blocked-no-attribution",
        title: "先归因，再决定怎么救",
        hint: "本卡受阻且**未归属需求条目** —— 交主会话执行 / 转为执行调试都需要先归因，否则下游一律推不动。",
        actions: [
          action("goto-attribution", "去归因（关联需求条目）", "primary"),
          action("goto-diagnostics", "查看诊断"),
        ],
        blocker: null,
      };
    }
    return {
      code: "blocked",
      title: "受阻：先看原因，再决定重试还是交人",
      hint: `${t.blockKind ? `类型 ${t.blockKind}·` : ""}同因复发 ${t.blockRecurrences ?? 0} 次${t.triageAt ? "·已转人工兜底" : ""}。`,
      actions: [
        action("retry", "重试（退回待办）", "primary"),
        action("dispatch-main-session", "交项目主会话执行（调试修复）"),
        action("to-debug", "转为执行调试"),
        action("goto-diagnostics", "查看诊断"),
      ],
      blocker: null,
    };
  }

  // 4·5) FR-97：**下一步本身是宿主/终端类动作**的卡（要动 ~/.dsh、装/卸插件、重启宿主等）。
  // 这类动作看板自己的执行循环做不了 —— 既不是"重试"能解决的，也不是团队内部能闭环的；
  // 必须交给人 / 项目主会话。
  // 位置很关键：放在「受阻」之后（受阻卡已在上面按 blocked 口径给全了动作）、
  // 「待办池/可开工/进行中」之前 —— 这样**任何还没收口的卡**，只要下一步要动宿主环境，
  // 都会被识别出来，而不是只有 blocked 一类卡才有这个出口。
  if (!closed && needsHostAction(t, ctx)) {
    return {
      code: "needs-host-action",
      title: "这一步要动宿主环境：交主会话或转调试",
      hint: "本卡的下一步涉及宿主 / 终端环境（装插件、重启服务、改 ~/.dsh 等）——看板执行循环做不了。可交项目主会话执行（调试修复），或标记为「执行调试」后由人接手。",
      actions: [
        action("dispatch-main-session", "交项目主会话执行（调试修复）", "primary"),
        action("to-debug", "转为执行调试"),
      ],
      blocker: null,
    };
  }

  // 5) 待办池：未授权开工，团队不会认领。
  if (status === "backlog") {
    // 门序列与服务端 `store.assertExecutable` 一致：**归因门先于授权门** ⇒ 未归因的待办池卡
    // 先归因。否则「先授权 → 再点启动执行」仍会被归因门拒（同一句报错换个入口再来一次，
    // 真机 2026-10-22 用户第十次投递的正是这句）。
    if (!t.requirementId) {
      return {
        code: "backlog-no-attribution",
        title: "先归因，再授权开工",
        hint: "本卡在「待办池」且未归属需求条目 —— 归因门在授权门之前：「启动执行 / 派发团队」都会被拒（EXECUTION_NOT_ATTRIBUTED）。",
        actions: [action("goto-attribution", "去归因（关联需求条目）", "primary")],
        blocker: null,
      };
    }
    return {
      code: "backlog",
      title: "未授权开工",
      hint: "在「待办池」= 未授权开工，团队不得认领。",
      actions: [action("authorize", "授权开工", "primary")],
      blocker: null,
    };
  }

  // 6) 可开工：先过分归因门，再派发。
  if (status === "todo") {
    if (!t.requirementId) {
      return {
        code: "todo-no-attribution",
        title: "先归因，否则会被归因门拦下",
        hint: "本卡未归属需求条目 —— 「启动执行 / 派发团队」都会被归因门拒绝（EXECUTION_NOT_ATTRIBUTED）。",
        actions: [action("goto-attribution", "去归因（关联需求条目）", "primary")],
        blocker: null,
      };
    }
    return {
      code: "todo",
      title: "可开工：派人或启动执行",
      hint: "归因已就绪；可「启动执行」（会话 + 开局提示词），或交给团队执行器。",
      actions: [action("start-execution", "启动执行", "primary")],
      blocker: null,
    };
  }

  // 7) 进行中：看护读数（FR-75/76）。
  if (status === "in_progress") {
    // 看护读数：只有 `stalled` 才算停滞；`idle`（空闲但未超阈值）/`running`/`awaiting-decision`
    // 都是正常读数，不得被引导文案说成停滞。
    const stalled = ctx.stalled === true || task?.watchdog?.state === "stalled";
    return {
      code: stalled ? "in-progress-stalled" : "in-progress",
      title: stalled ? "疑似停滞：看进展，或退回待办重派" : "执行中：盯着回写",
      hint: stalled ? "已超阈值无进展回报——可打开执行会话看现场，或退回待办重新派发。" : "执行侧回写后状态会回流；异常可退回待办。",
      actions: [
        action("open-session", "打开执行会话", "primary"),
        action("retry", "退回待办（重新派发）"),
      ],
      blocker: null,
    };
  }

  if (status === "done") {
    return { code: "done", title: "已收口", hint: "本卡已完成，无待办动作。", actions: [], blocker: null };
  }
  if (status === "canceled") {
    return { code: "canceled", title: "已取消", hint: "本卡已取消，不参与派发与看护。", actions: [], blocker: null };
  }
  return { code: "unknown", title: "状态未知", hint: `未识别的状态：${status || "（空）"}。`, actions: [], blocker: null };
}

/**
 * 引导码 → **呈现口径**：`focus` 该展开哪个区块、`steps` 按什么顺序做。
 *
 * 真机反馈（2026-10-22）「既然任务收口了，为何该页面还有这么多人工检验、评审、执行会话按钮动作…
 * 任务异常时又可评审又可检验、无从下手」——所以引导不能只有一句话和几个按钮，还得回答
 * 「现在只该动哪一处」以及「按 1-2-3 怎么走」。这张表是**纯数据**，前端拿它决定默认折叠与步骤展示：
 * - `focus` 为字符串数组 ＝ 只默认展开标题命中这些关键字的区块；`[]` ＝ 只留只读区；
 * - `focus` 为 `null` ＝ **不干预**（状态未识别时不要把界面按猜测重排）。
 */
const GUIDANCE = Object.freeze({
  "human-review-pending": {
    focus: ["人工校验"],
    steps: [
      "先读本卡的证据与判定类别（真 bug / 需求异化 / 技术方案变化 / 与上游需求不符）",
      "在「人工校验」区块填结论说明",
      "三选一给结论：继续（continue）/ 改需求（change-requirement）/ 关单（close）",
    ],
  },
  "blocked-by-human-review": {
    focus: ["人工校验"],
    steps: [
      "打开前置的人工校验卡，把结论定下来（三选一）",
      "结论给出后，本卡的前置门即消耗，回到本卡继续推进",
      "结论若是「与上游需求不符」，先改需求或关单，再决定本卡去向",
    ],
  },
  "awaiting-human-done": {
    focus: [],
    steps: ["核对证据链（评审已通过、改动与验证都在卡上）", "点「完成」收口 —— 完成只有人能点，且不会自动回退"],
  },
  "review-pending": {
    focus: ["评审"],
    steps: [
      "读证据评论与改动摘要",
      "需要时先指派评审者（留空＝未指派，超时会产出「评审死锁」诊断）",
      "填说明后「评审通过」，或「请求返工」（返工必填说明）",
    ],
  },
  rework: {
    focus: ["评审"],
    steps: ["在「评审」区块读返工说明", "按说明改完，先回来源列再重新提交评审", "等新结论 —— 可点「评审通过」，或再次返工"],
  },
  blocked: {
    focus: ["诊断与恢复动作"],
    steps: [
      "先看「诊断与恢复动作」里的失败点 / 退出码 / 命令",
      "属环境或瞬时问题 → 「重试（退回待办）」让它重新派发",
      "反复重试无效、且卡点需要人或环境介入 → 「交项目主会话执行（调试修复）」",
      "想由人接手 → 「转为执行调试」（加标记、回待办，便于集中处理）",
    ],
  },
  "blocked-no-attribution": {
    focus: ["归因", "诊断与恢复动作"],
    steps: [
      "在「归因」区块选一个需求条目 —— 未归因时交主会话也走不通",
      "点「关联需求条目」后回到本卡",
      "再选「交项目主会话执行」或「转为执行调试」",
    ],
  },
  "needs-host-action": {
    focus: ["执行会话", "操作"],
    steps: [
      "确认这一步确实要动宿主环境（改 ~/.dsh、装/卸插件、重启服务等）",
      "「交项目主会话执行（调试修复）」：指令含边界红线，投递到项目主会话",
      "或「转为执行调试」标记后由人接手 —— 注意此类动作常需先报批",
    ],
  },
  backlog: { focus: [], steps: ["确认这张卡确实要开工 → 「授权开工」（转「可开工」）", "未授权前团队不会认领它"] },
  "backlog-no-attribution": {
    focus: ["归因"],
    steps: ["在「归因」区块选一个需求条目（归因门在授权门之前）", "点「关联需求条目」——不归因时「启动执行 / 派发团队」都会被拒绝", "回本卡「授权开工」→ 再「启动执行」"],
  },
  "todo-no-attribution": {
    focus: ["归因"],
    steps: ["在「归因」区块选一个需求条目", "点「关联需求条目」——不归因时「启动执行 / 派发团队」都会被归因门拒绝", "回到本卡再「启动执行」"],
  },
  todo: {
    focus: ["执行会话", "归属团队"],
    steps: ["确认归因已就绪", "「启动执行」：建/切执行会话 + 投开局提示词", "或交给团队执行器按并行策略派发"],
  },
  "in-progress": {
    focus: ["执行会话", "执行看护"],
    steps: ["盯执行侧回写（状态会回流到看板）", "需要现场 → 「打开执行会话」", "异常 → 「退回待办（重新派发）」"],
  },
  "in-progress-stalled": {
    focus: ["执行会话", "执行看护"],
    steps: ["「打开执行会话」看现场（历史在会话里）", "确认确实没进展 → 「退回待办」释放锁、重新派发", "反复停滞 → 申报人工校验，交人兜底"],
  },
  done: { focus: ["操作"], steps: [] },
  canceled: { focus: ["操作"], steps: [] },
  unknown: { focus: null, steps: [] },
});

/**
 * 推导「下一步」引导（对外的唯一入口）。
 *
 * @param {object} task 任务行（含 status / labels / reviewState / requirementId / humanReview* 字段）
 * @param {object} [ctx]
 * @param {{identifier:string,title?:string,category?:string}|null} [ctx.humanReviewBlocker]
 *        当本卡的**前置**里有一张「待结论」的人工校验卡时传它（前端从依赖表映射得到）
 * @param {boolean} [ctx.stalled] 看护读数（FR-75）：仅 `true` 视为停滞
 * @returns {{code:string,title:string,hint:string,steps:string[],
 *            focus:string[]|null,actions:Array<{id:string,label:string,kind:string}>,
 *            blocker:{identifier:string,title:string|null,category:string|null}|null}}
 *          `focus` 供前端做默认折叠（见 GUIDANCE），`steps` 是给人看的 1-2-3 操作顺序。
 */
export function deriveNextStep(task, ctx = {}) {
  const result = derive(task, ctx);
  const guide = GUIDANCE[result.code] ?? GUIDANCE.unknown;
  return { ...result, focus: guide.focus, steps: [...guide.steps] };
}
