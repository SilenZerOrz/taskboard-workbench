/**
 * FR-93 · 看板空态引导（缺陷 F-05：次状态议题空态无引导）。
 *
 * ## 要解决的问题（缺陷 F-05）
 *
 * 缺陷原文（`docs/测试/缺陷清单-2026-10-10.md` F-05，讲的是旧 `web/src/App.tsx` 实现）：
 * 单项目视图下若议题全部处于次要状态（`backlog`/`done`/`canceled`），主看板三列均显示
 * 「暂无议题」，**空状态不引导**到「其他任务」面板，使用者会误判"这个项目没有议题"。
 *
 * ## 本仓的对应形态（口径对齐，2026-10-22）
 *
 * 本仓已把 7 个状态全部提升为主列（`domain.mjs` 的 `STATUSES` 含 `backlog`），没有「其他任务」
 * 面板，因此 F-05 的**同一类**可发现性缺口换了个位置出现：
 *
 * 1. **折叠隐藏**（FR-88）：全部卡片被打 `archived` 标签 ⇒ `visible` 为空 ⇒ 七列全是「暂无任务」，
 *    而折叠计数只在工具栏（`已折叠 N`）与摘要行出现，**列内零解释**。
 * 2. **筛选命中不到**（FR-63 优先级/标签筛选）：筛选后为空 ⇒ 同样是七列「暂无任务」，
 *    用户分不清是"真没有任务"还是"被筛掉了"。
 *
 * 两种情形的共同点是：**数据在库里，只是没显示，而界面不解释为什么**。
 * 本模块只负责**如实说明**"还有多少张卡不在默认视图里、为什么"，不代替人做判断，
 * 也**不自动改筛选条件**（避免"自动帮你清掉筛选"这种惊喜行为）。
 *
 * ## 设计约束（红线）
 *
 * - **纯函数、无 I/O**：不读库、不写库、不发请求，便于单测穷举。
 * - **不臆断**：只有真的存在被隐藏的卡片时才给引导；真的一个任务都没有时，如实说"暂无任务"，
 *   **绝不编造数量**（与 `verify.mjs`「认不出就如实写，绝不编造」同一条纪律）。
 * - **区分两类隐藏原因**：`archived`（折叠，需用户主动开）与筛选（需用户主动清），
 *    引导文案与出口分别指向对应的既有控件，不新增状态、不新增面板。
 */

/** 折叠标签（与 `web/app.js` 的 `ARCHIVE_LABEL` 保持一致）。 */
export const ARCHIVE_LABEL = "archived";

/**
 * 判定一张卡是否处于折叠（软归档）状态。
 *
 * @param {{labels?: string[]}} task
 * @returns {boolean}
 */
export function isArchived(task) {
  return Array.isArray(task?.labels) && task.labels.includes(ARCHIVE_LABEL);
}

/**
 * 当前是否处于"筛选生效"状态。
 *
 * 口径与 `web/app.js` 的 `state` 对齐：`priority` / `label` / `sessionScope` / `keyword` 任一非空即为筛选中。
 * `label` 需排除折叠开关载体 `archived`（它由 `showArchived` 表达，不算筛选条件）；
 * `sessionScope`（FR-26 会话归属：`linked` / `unlinked`）空串＝「全部」，不算筛选。
 * `keyword`（FR-14 搜索）空串 / 纯空白＝没在搜索，不算筛选。
 *
 * @param {{priority?: string, label?: string, sessionScope?: string, keyword?: string}} filters
 * @returns {boolean}
 */
export function hasActiveFilter(filters) {
  const priority = typeof filters?.priority === "string" ? filters.priority.trim() : "";
  const label = typeof filters?.label === "string" ? filters.label.trim() : "";
  const sessionScope = typeof filters?.sessionScope === "string" ? filters.sessionScope.trim() : "";
  const keyword = typeof filters?.keyword === "string" ? filters.keyword.trim() : "";
  return priority !== "" || (label !== "" && label !== ARCHIVE_LABEL) || sessionScope !== "" || keyword !== "";
}

/** FR-26：会话归属筛选值的可读文案（与 `web/app.js` 的下拉标签逐字一致）。 */
export const SESSION_SCOPE_LABELS = Object.freeze({ linked: "已关联会话", unlinked: "未关联会话" });

/**
 * FR-28：会话归属的第三/四档「仅本会话」——取值为 `session:<会话标识>`。
 * 与 FR-26 的 `linked` / `unlinked` 并列（语义不同：那两档问"有没有关联会话"，
 * 本档问"关联的是不是**这一个**会话"）。
 */
export const SESSION_SCOPE_CURRENT_PREFIX = "session:";

/** 会话标识在文案里只显示短前缀（与卡面 `session-chip` 同口径，真值不丢：完整标识在 title / 配置页可读）。 */
export const SESSION_SCOPE_ID_SHORT = 14;

/**
 * FR-28：把会话归属档位值格式化成可读文案。
 * `linked` / `unlinked` → 各自标签；`session:<id>` → `仅本会话（<短标识>…）`；空 → 空串。
 *
 * @param {string} scope
 * @returns {string}
 */
export function formatSessionScope(scope) {
  const value = typeof scope === "string" ? scope.trim() : "";
  if (value === "") return "";
  if (value.startsWith(SESSION_SCOPE_CURRENT_PREFIX)) {
    const id = value.slice(SESSION_SCOPE_CURRENT_PREFIX.length).trim();
    if (id === "") return "仅本会话";
    const short = id.length > SESSION_SCOPE_ID_SHORT ? `${id.slice(0, SESSION_SCOPE_ID_SHORT)}…` : id;
    return `仅本会话（${short}）`;
  }
  return SESSION_SCOPE_LABELS[value] ?? value;
}

/**
 * 推导看板空态的引导口径。
 *
 * **只在 `visibleTasks` 为空时被使用**（即整个看板空）。此时把 `allTasks` 按"为什么不显示"
 * 分桶，给出可核验的引导文案。
 *
 * @param {object} params
 * @param {Array<{status?: string, labels?: string[]}>} params.allTasks   当前项目 / 当前筛选口径下的全部卡（服务端已按筛选返回）
 * @param {Array<object>} [params.visibleTasks]                          折叠过滤后的实际入列卡
 * @param {{priority?: string, label?: string, sessionScope?: string, keyword?: string}} [params.filters] 当前生效的筛选/搜索条件
 * @param {boolean} [params.showArchived]                                是否打开了「显示已折叠」
 * @returns {{
 *   empty: boolean,
 *   kind: "no-tasks" | "filtered-out" | "archived" | "filtered-and-archived",
 *   hiddenTotal: number,
 *   archivedCount: number,
 *   filteredCount: number,
 *   message: string,
 *   hints: string[],
 *   reasons: Array<{ reason: "archived" | "filtered", count: number, hint: string }>,
 * }}
 */
export function deriveEmptyState({ allTasks, visibleTasks, filters = {}, showArchived = false } = {}) {
  const all = Array.isArray(allTasks) ? allTasks : [];
  const visible = Array.isArray(visibleTasks) ? visibleTasks : all;
  const filtering = hasActiveFilter(filters);
  // FR-14：搜索关键词（已 trim；空串＝没在搜索）。**原样**用于文案回显，不在此大小写化。
  const keyword = typeof filters?.keyword === "string" ? filters.keyword.trim() : "";

  // 看板整体是否真的空 —— 只有"一列都没卡"才算空态。
  const empty = visible.length === 0;

  // 分桶：折叠隐藏 vs 其它原因（筛选命中不到 / 状态不在可见口径内）。
  // 注意 showArchived=true 时折叠卡本来就会入列，此时不该再把它算成"被隐藏"。
  const archivedHidden = showArchived ? [] : all.filter(isArchived);
  const archivedIds = new Set(archivedHidden.map((task) => task?.identifier ?? task?.id));
  const filteredHidden = all.filter((task) => {
    if (archivedIds.has(task?.identifier ?? task?.id)) return false;
    return !visible.includes(task);
  });

  const archivedCount = archivedHidden.length;
  const filteredCount = filteredHidden.length;
  const hiddenTotal = archivedCount + filteredCount;

  if (!empty) {
    return {
      empty: false,
      kind: "no-tasks",
      hiddenTotal: 0,
      archivedCount: 0,
      filteredCount: 0,
      message: "",
      hints: [],
      reasons: [],
    };
  }

  // 真的一个任务都没有：如实说"暂无任务"，**不编造数量、不给无的放矢的引导**。
  if (all.length === 0) {
    // FR-14 / FR-16：搜索无命中必须给出**明确指出关键词**的空态，不能与「本项目暂无任务」混为一谈
    // （前者是"词没对上"，后者是"真的没卡" —— 引导动作也不同：换词 vs 新建任务）。
    if (keyword !== "") {
      return {
        empty: true,
        kind: "no-tasks",
        hiddenTotal: 0,
        archivedCount: 0,
        filteredCount: 0,
        message: `没有匹配「${keyword}」的任务`,
        hints: ["换个关键词，或清空搜索后重试"],
        reasons: [],
      };
    }
    return {
      empty: true,
      kind: "no-tasks",
      hiddenTotal: 0,
      archivedCount: 0,
      filteredCount: 0,
      message: filtering ? "当前筛选下没有任务" : "本项目暂无任务",
      hints: filtering ? ["清空筛选条件后重试"] : [],
      reasons: [],
    };
  }

  // 有任务但一列都没卡 —— 这就是 F-05 的场景，必须解释「它们在哪」。
  const reasons = [];
  if (archivedCount > 0) {
    reasons.push({
      reason: "archived",
      count: archivedCount,
      hint: `${archivedCount} 个已折叠（软归档）· 点工具栏「显示已折叠（${archivedCount}）」展开；数据与历史都在，可随时取消`,
    });
  }
  if (filteredCount > 0) {
    const parts = [];
    if (typeof filters?.priority === "string" && filters.priority.trim()) parts.push(`优先级=${filters.priority.trim()}`);
    if (typeof filters?.label === "string" && filters.label.trim() && filters.label.trim() !== ARCHIVE_LABEL) {
      parts.push(`标签=${filters.label.trim()}`);
    }
    if (typeof filters?.sessionScope === "string" && filters.sessionScope.trim()) {
      parts.push(`会话归属=${formatSessionScope(filters.sessionScope)}`);
    }
    // FR-14：搜索关键词也如实回显（否则用户只看到"筛掉了 N 个"却不知道是哪一个条件所致）
    if (keyword !== "") parts.push(`关键词=${keyword}`);
    const cond = parts.length > 0 ? parts.join(" · ") : "当前筛选";
    reasons.push({
      reason: "filtered",
      count: filteredCount,
      hint: `${filteredCount} 个不在当前筛选/口径内（${cond}）· 清空筛选条件即可看到`,
    });
  }

  const kind =
    archivedCount > 0 && filteredCount > 0
      ? "filtered-and-archived"
      : archivedCount > 0
        ? "archived"
        : "filtered-out";

  return {
    empty: true,
    kind,
    hiddenTotal,
    archivedCount,
    filteredCount,
    message: `看板为空：本项目还有 ${hiddenTotal} 个任务未显示在此`,
    hints: reasons.map((item) => item.hint),
    reasons,
  };
}

/**
 * 把空态口径渲染成**纯文本**一行（用于摘要行 / 无障碍标签 / 单测断言）。
 *
 * @param {ReturnType<typeof deriveEmptyState>} state
 * @returns {string}
 */
export function formatEmptyState(state) {
  if (!state?.empty) return "";
  if (state.hiddenTotal === 0) return state.message;
  return `${state.message}：${state.hints.join("；")}`;
}