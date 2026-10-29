/**
 * app.js —— 看板渲染（零依赖，原生 DOM）。
 * 既用于独立验证台（index.html 自动挂载到 #tb-app），也用于 DSH 插件面板
 * （client bundle 通过 window.__TB_BOARD__.createBoard({ root, apiBase }) 挂载）。
 * 工厂会构建全部 chrome（顶栏/工具栏/看板/对话框），因此调用方只需给一个容器。
 * owner 为任务正式字段（t24）。
 */
(function () {
  const STATUS_LABELS = {
    backlog: "待办池", todo: "可开工", in_progress: "进行中", in_review: "待验收",
    blocked: "受阻", done: "已完成", canceled: "已取消",
  };
  const PRIORITY_LABELS = { none: "无", low: "低", medium: "中", high: "高", urgent: "紧急" };
  // FR-26 / FR-28：会话归属筛选值 → 文案（口径与 src/core/empty-state.mjs 的 SESSION_SCOPE_LABELS / formatSessionScope 一致）。
  const SESSION_SCOPE_LABELS = { linked: "已关联会话", unlinked: "未关联会话" };
  // FR-28：「仅本会话」档取值前缀 `session:<会话标识>`（与 store.listTasks 同口径）。
  const SESSION_SCOPE_CURRENT_PREFIX = "session:";
  const SESSION_SCOPE_ID_SHORT = 14;
  /** FR-28：拿不到当前会话时的**可见降级文案**（不得静默全显）。 */
  const NO_SESSION_NOTICE = "未检测到当前会话 · 显示全部";
  /** FR-28：会话归属档位值 → 可读文案（与 src/core/empty-state.mjs 的 formatSessionScope 逐字一致）。 */
  function formatSessionScope(scope) {
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
  /** FR-28：会话标识短形式（卡面 / 下拉共用）。 */
  function shortSessionId(id) {
    const s = String(id ?? "");
    return s.length > SESSION_SCOPE_ID_SHORT ? `${s.slice(0, SESSION_SCOPE_ID_SHORT)}…` : s;
  }
  const OWNER_LABELS = {
    planner: "规划 planner", engineer: "开发 engineer", tester: "测试 tester",
    reviewer: "评审 reviewer", archivist: "归档 archivist",
  };
  // FR-85：人工校验任务（人在环升级门）——看板呈现与结论入口。
  // 口径与 src/core/human-review.mjs 对齐：任务类型靠 labels 带 `human_review` 判定；
  // 类别四值、结论三出口（continue / change-requirement / close）。
  const HR_LABEL = "human_review";
  const HR_CATEGORY_LABELS = {
    "real-bug-blocked": "真实 bug 阻塞", "requirement-drift": "需求异化",
    "architecture-change": "技术架构变化", "upstream-mismatch": "与上游需求不符",
  };
  const HR_CONCLUSION_LABELS = {
    continue: "继续（按原口径放行下游）",
    "change-requirement": "变更需求（按新口径重开原任务）",
    close: "关闭（不再推进该任务）",
  };
  // FR-88：卡片「折叠（软归档）」—— 不删任何数据，只用一个标签把已失效 / 无用的卡片从
  // 看板默认视图里收起来，保住「项目 → 需求 → 主任务（子任务串）」的层次。
  // 用标签而不是新状态：状态是流程语义（backlog / todo / …），折叠只是呈现开关；
  // 现有 `PATCH /api/tasks/:ref` 已支持整体替换 labels，无需改后端与库结构，随时可取消。
  const ARCHIVE_LABEL = "archived";
  const isArchived = (task) => (task?.labels ?? []).some((label) => String(label ?? "").trim() === ARCHIVE_LABEL);
  const hrCategoryLabel = (category) => HR_CATEGORY_LABELS[String(category ?? "")] ?? (String(category ?? "") === "" ? "未分类" : String(category));
  const isHumanReviewTask = (task) => (task?.labels ?? []).some((label) => String(label ?? "").trim() === HR_LABEL);
  const isHumanReviewPending = (task) => isHumanReviewTask(task) && (task.humanReviewState ?? "pending") === "pending";
  /**
   * 「执行入口」判定（**卡片 / 抽屉 / 下一步面板共用同一口径**）。
   *
   * 真机 2026-10-22（用户第八次投递同一句报障）：未归因的可开工卡照样渲染「启动执行」，
   * 点下去**必然**被归因门拒 ⇒ 人只看到「任务未归属需求条目：请先关联需求条目（归因门）」，
   * 还得再被教一次去点归因入口。`src/core/next-step.mjs` 早已按 `todo-no-attribution` 给
   * 「去归因」，但卡片与抽屉两条入口没跟上 ⇒ 同一状态三处呈现不一致。
   *
   * 处置：把判定收成这一个谓词 —— 已归因 → `start`；未归因 → `attribute`（直接打开归因入口，
   * 不再用一次注定失败的点击换一句报错）；待办池 → `authorize`（真实的门是**授权门**，
   * 见 `store.assertExecutable`：`backlog` 一律 `EXECUTION_NOT_AUTHORIZED`）；其他状态 → `null`。
   *
   * 真机 2026-10-22（用户**第九次**投递同一句报障「当前可开工三个看板均报…归因门」）：
   * 只读取证 = 全库非终态卡里**只有 `-80`（in_review）未归因**、5 张待办池卡与唯一 todo 卡
   * 均已归因；用户真正够得到的那三张（`-121`/`-122`/`-123`）在**待办池**，卡面当时只给一个
   * 小箭头「→」——「该干嘛」看不出来，于是又被当成「点了没用」。这里把待办池的入口显式化。
   * 服务端的门（`store.assertExecutable`）仍是**唯一裁决者**；这里只负责不把注定被拒的路摆到人面前。
   */
  /**
   * 「归因门可达面」（**与所在列无关**）：未归因且非终态的卡 ——「启动执行 / 派发团队 / CLI 执行器」
   * 都会被服务端的归因门（`store.assertAttributed`）拒。卡面标记、团队区块、失败引导共用这一份判据。
   *
   * 真机 2026-10-22（用户**第十次**投递同一句报障）：此前只按「可开工 + 未归因」给标记与「去归因」，
   * 而**待验收**的未归因卡（全库唯一一张 `-80`）在卡面上看不出任何问题，抽屉「归属团队」里却摆着
   * 一个「派发团队」——点下去必然被归因门拒。判据与列无关，入口才好按同一份口径收口。
   */
  const needsAttribution = (task) => Boolean(task) && !task.requirementId
    && task.status !== "done" && task.status !== "canceled";
  const executionEntry = (task) => {
    if (!task) return null;
    if (task.status !== "todo" && task.status !== "backlog") return null;
    // 门序列与服务端 `store.assertExecutable` 对齐：**归因门先于授权门** ⇒ 待办池 + 未归因
    // 先给「去归因」；否则「先授权、再启动执行」仍会被归因门拒 —— 同一句报错换个入口再来一次。
    if (needsAttribution(task)) return "attribute";
    return task.status === "backlog" ? "authorize" : "start";
  };

  /**
   * 「下一列」的**目标列**判定（卡片「→」按钮与抽屉「下一列」共用同一份口径）。
   *
   * 缺口（真机报障 `-158`）：「下一列」此前是**纯列序位移**（`statuses[index + 1]`），不看任何门。
   * 而看板列序是 `待办池 → 可开工 → 进行中 → 待验收 → 完成 → 受阻 → 已取消` ⇒
   * 「待验收」卡的「下一列」**恒等于**「完成」，于是与「下一步」区的「完成（仅人工可确认）」
   * **效果完全一样**（都调 `moveTask(t, "done")`）—— 两个入口做同一件事，措辞却不同，
   * 人不知道该点哪个，也让 FR-89「一处处置」失效。
   *
   * 处置（**收敛到一处**，与 `executionEntry` 同一手法）：
   *   · 「待验收」卡 ⇒ 「下一列」**不再给位移目标**，而是把该卡交给「下一步」区（FR-89：处置按状态分层，
   *     待验收卡的处置**只有那一处**：评审通过 / 请求返工 / 完成）。
   *   · 其余状态 ⇒ 维持原有列序位移（不改变既有行为）。
   *
   * 范围边界（**刻意不做的事**）：这里只收敛**入口**，不给服务端加「收口必须先评审通过」的门。
   * 那个缺口（`PATCH /api/tasks/:ref` 对评审态无校验）确实存在，但属**口径选择**：
   * FR-83 的验收只约束「评审通过**不自动**置完成」（红线是不得自动化），并未要求「完成必须先评审通过」；
   * 且 `tools/bench-auto-advance.mjs` 把「人工直接把待验收卡判 done」当作**合法人工动作**
   * （完成只能人确认，人有权跳过评审）。加门会打断那条既有链路 ⇒ 按本仓纪律**只登记不擅改**，
   * 已登记为待裁定项 `taskboard-workbench-162`。
   *
   * 返回 `{ status }`（可位移）或 `{ blocked: true, reason, viaNextStep? }`（不可位移 ⇒ 按钮禁用并写明原因；
   * `viaNextStep` 为真时给「指回下一步区」的可点按钮，而不是静默禁用）。
   */
  const nextColumnTarget = (task, statuses) => {
    if (!task) return { blocked: true, reason: "未知状态" };
    const list = Array.isArray(statuses) ? statuses : [];
    const index = list.indexOf(task.status);
    if (index < 0) return { blocked: true, reason: "未知状态" };
    if (index + 1 >= list.length) return { blocked: true, reason: "已在最后一列" };
    // 「待验收」是评审一等流程的中枢（FR-83）：它的下一列就是「完成」⇒ 与「下一步」区重复。
    // 处置**统一交给「下一步」区**，不在处置区再摆一条平行的位移入口。
    if (task.status === "in_review") {
      return { blocked: true, reason: "待验收卡的处置在「下一步」区（评审通过 / 请求返工 / 完成）", viaNextStep: true };
    }
    return { status: list[index + 1] };
  };

  /**
   * CLI 执行器入口判定（**与 `executionEntry` 分开**，因为 CLI 路径有意支持非 `todo` 状态：
   * 见 `claimForCliExecution` 的 `direct-handoff` —— 人工显式点击即授权，backlog/in_review/done 都要如实进
   * 「进行中」）。这里只收敛两种**注定被服务端拒**的情形：
   *   ① 未归因 → 服务端新增的归因门（`/exec-cli` 非 dryRun 分支 `store.assertAttributed`）；
   *   ② 人工校验任务 → FR-85b 升级门（`/exec-cli` 一直有此门）。
   * 纪律同 `executionEntry`：不把注定被拒的路摆到人面前（否则又是一次「点了才报错」）。
   * 「预览执行计划」(dryRun) **不收敛**：只回计划、无副作用，服务端也刻意不放归因门。
   */
  const cliEntry = (task) => {
    if (!task) return null;
    if (isHumanReviewTask(task)) return "human-review";
    return task.requirementId ? "start" : "attribute";
  };

  /**
   * FR-83 补口（卡 `-162`，口径 C：门 + 显式逃生口）：把「未评审就收口」从**静默旁路**变成**明示决定**。
   *
   * 服务端 `in_review → done` 现在默认拒（`REVIEW_NOT_APPROVED`，退出码 5，零副作用），
   * 只有显式 `skipReview === true` 才放行。`skipReview: true` 的**唯一出处**就是这里：
   * 人点了一个说明白「将跳过评审」的确认框，调用方才会把它带进 PATCH。
   * 本谓词是判据的唯一来源（拖拽落「完成」列、抽屉「下一步」区的「完成」都调它），
   * 保证两条入口对"什么算未评审收口"给出**同一个答案**。
   */
  const needsReviewSkip = (task, status) =>
    status === "done" && task?.status === "in_review" && task?.reviewState !== "approved";

  /** 跳过评审的确认框（**唯一实现**）。返回 true 才允许带 `skipReview: true` 提交。 */
  const confirmReviewSkip = (task) => window.confirm(
    `本卡（${task.identifier}）还在「待验收」且评审未通过（${task.reviewState ?? "pending"}）。\n\n`
    + "继续会跳过评审直接置「完成」——服务端会记一条 review_skipped 事件与审计，事后可查。\n\n"
    + "建议先点「评审通过」（评审通过后仍需你确认才完成）。确认跳过评审直接完成？",
  );

  // FR-86 / FR-70：执行循环的**裁剪原因**文案（让行 / 关键阻塞 / 上限 / 守卫）。
  const LOOP_STOP_LABELS = {
    "shared-file-conflict": "共享文件冲突（让行）",
    "review-not-passed": "评审未过（返工未通过）",
    "upstream-blocked": "上游依赖未就绪",
    "human-review-pending": "上游人工校验门未结论",
    "duplicate-of-existing": "历史重复副本（防重复派发）",
    "batch-limit": "同轮并发上限已用满",
  };

  // —— 「打开执行会话」之后把「对话」视图带到前台（2026-10-19 · 真机取证）
  // 用户报障：「从需求打开执行任务会话，只能看到对话框，看不到历史对话信息」。
  // 真机复现（用户真实页面 + 真实数据 `session-4dc56efa-…` / `session-45d9ed98-…`）：
  //   ① 会话**确实切过去了**（`document.title` 变成「任务 obsidian-dsh-acp-15：…」）；
  //   ② 该会话的历史**确实完整**（手动点「对话」标签页即完整渲染）；
  //   ③ 但**视图仍停在「任务工作台」标签页** → 用户看到的是看板（未绑定时还会退回「未绑定」空态），
  //      画面里只剩底部输入框 → 就是那句「只看到对话框、看不到历史对话」。
  // 成因：宿主按「每会话持久化的视图偏好」恢复标签页 —— 用户上次在该会话看的是看板，打开后就还看板。
  // 处置：打开成功后，把会话视图 tablist（宿主稳定属性 `[data-conversation-tabs]`）里
  //       **非本插件**的第一个标签页激活（宿主内置「对话」order=0 永远排第一；本插件 order=40）。
  // 纪律：只在「当前选中的是本插件看板页」时才动手；任何异常一律吞掉（切不动就维持原状，不误伤宿主）。
  const BOARD_TAB_LABEL = "任务工作台";
  // 宿主内置「对话」视图 id（真机实测：`localStorage['dsh.conversation.<sessionId>'].view === "chat"`）。
  // 打开执行会话时先把该会话的视图偏好改写成它 —— 宿主的 `restoreView(sessionId)` 自己就会落在「对话」页，
  // 从根上消除「我们切了、宿主又按旧偏好弹回看板」的竞态（只靠点标签页是竞速，大会话加载慢必输）。
  // 万一将来宿主改了 id：`resolveActiveView` 找不到会回落到内置对话页 —— 仍是我们要的结果。
  const CONVERSATION_VIEW_ID = "chat";
  const conversationTakeover = new WeakSet(); // 用户主动碰过标签栏 → 立即停止重申，绝不与用户抢方向盘

  /** 把宿主「每会话视图偏好」改写成对话页（只动 view / 补齐 draft，保留其它字段）。任何异常静默跳过。 */
  function preferConversationView(sessionId, storage) {
    try {
      if (!sessionId) return false;
      const store = storage ?? (typeof window !== "undefined" ? window.localStorage : null);
      if (!store || typeof store.getItem !== "function" || typeof store.setItem !== "function") return false;
      const key = `dsh.conversation.${sessionId}`;
      let value = {};
      const raw = store.getItem(key);
      if (raw) {
        // 坏 JSON（历史遗留/被别的脚本写坏）不该让我们放弃 —— 直接按空值重写一条合法记录。
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") value = parsed;
        } catch (_) { value = {}; }
      }
      if (value.view === CONVERSATION_VIEW_ID && typeof value.draft === "string") return false; // 已经是对话页
      value.view = CONVERSATION_VIEW_ID;
      if (typeof value.draft !== "string") value.draft = "";
      if (!("viewRequest" in value)) value.viewRequest = null;
      store.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 一次性监听：用户一旦自己点了标签栏（pointerdown / keydown），本轮重申全部作废。 */
  function watchTabStripTakeover(doc) {
    try {
      if (!doc || conversationTakeover.has(doc)) return;
      const strip = doc.querySelector?.("[data-conversation-tabs]");
      if (!strip || typeof strip.addEventListener !== "function") return;
      const mark = () => { try { conversationTakeover.add(doc); } catch (_) { /* 静默 */ } };
      strip.addEventListener("pointerdown", mark, { once: true, capture: true });
      strip.addEventListener("keydown", mark, { once: true, capture: true });
    } catch (_) { /* 静默 */ }
  }

  function activateDefaultConversationTab(doc) {
    try {
      if (doc && conversationTakeover.has(doc)) return false; // 用户已接管 → 不抢
      const strip = doc?.querySelector?.("[data-conversation-tabs]");
      if (!strip || typeof strip.querySelectorAll !== "function") return false;
      const tabs = Array.from(strip.querySelectorAll('[role="tab"]'));
      if (tabs.length === 0) return false;
      const isBoardTab = (el) => String(el.textContent ?? "").trim() === BOARD_TAB_LABEL;
      const boardSelected = tabs.some((el) => isBoardTab(el) && el.getAttribute("aria-selected") === "true");
      if (!boardSelected) return false; // 用户已经不在看板页 → 不动宿主
      const target = tabs.find((el) => !isBoardTab(el) && typeof el.click === "function");
      if (!target) return false;
      target.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  // 立即试一次 + **无论如何都重申五轮**（最远 6s）。
  // 为什么「成功也要重申」（真机踩坑 2026-10-19）：宿主在新会话**绑定/渲染完成后**会执行
  // `restoreView(sessionId)` —— 按该会话**持久化的视图偏好**重新激活标签页。用户上次在该会话看的是看板，
  // 于是打开会话后宿主**又把标签页切回看板**，把我们的即时那一次覆盖掉（实测：切了又弹回，界面仍是看板页）。
  // 所以必须错峰重申几次，每一次都带守卫（只在「当前仍停在看板页」时才点），幂等、无副作用。
  // 2026-10-19 加固（用户二次报障后）：① 先把该会话的视图偏好改写成「对话」（见 preferConversationView），
  // 宿主的 restoreView 自己就落在对话页 —— 竞态从根上消失；② 重申窗口 3s → 6s（大会话历史加载慢，restoreView 更晚）；
  // ③ 用户自己点标签栏即停止重申（见 watchTabStripTakeover）。
  function bringConversationToFront(doc, sessionId) {
    try { preferConversationView(sessionId); } catch (_) { /* 静默 */ }
    watchTabStripTakeover(doc);
    const first = activateDefaultConversationTab(doc);
    const view = doc?.defaultView ?? (typeof window !== "undefined" ? window : null);
    const later = () => {
      try { watchTabStripTakeover(doc); activateDefaultConversationTab(doc); } catch (_) { /* 静默 */ }
    };
    for (const ms of [320, 960, 1800, 3000, 6000]) {
      try { view?.setTimeout?.(later, ms); } catch (_) { /* 没有定时器就算了：至少已经试过一次 */ }
    }
    return first;
  }

  // == FR-24-MD-BEGIN ==
  /**
   * FR-24（Markdown 呈现与内容安全）· **任务描述与评论共用**这一份渲染器。
   *
   * 支持：标题 / 无序列表 / 有序列表 / 任务清单 / 表格 / 代码块 / 链接 / 引用（外加既有的 `**加粗**`、行内 `` `代码` ``）。
   *
   * 内容安全（本文件的硬约束，不许绕过）：
   *   ① 全程**纯 DOM 构建**（`createElement` / `createTextNode` / `setAttribute`），**零 `innerHTML`**
   *      ⇒ 用户内容永远不成为 HTML 节点；`<script>`、`<img onerror=…>` 之类只有**字面文本**形态，
   *      既不执行、也不呈现为可交互元素。
   *   ② HTML 注释（`<!-- … -->`，含**跨行 / 未闭合**）在解析**之前**整段剔除 ⇒ 页面不可见（FR-24 ②）。
   *   ③ 链接只放行 `http:` / `https:` / `mailto:` 与相对路径；`javascript:` / `data:` 等协议
   *      **不生成 `<a>`**，退化为原样文本 —— 危险内容不得渲染执行（FR-24 ③）。
   */
  const MD_LINK_SCHEME = /^(?:https?:|mailto:)/i;
  const MD_TASK_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/;
  const MD_BULLET = /^\s*[-*+]\s+(.*)$/;
  const MD_ORDERED = /^(\s*)\d+[.)]\s+(.*)$/;

  /** FR-24 ②：剔除 HTML 注释 —— 含跨行（`[\s\S]`）与**未闭合**（`-->` 缺失时吃到文末）。 */
  function stripHtmlComments(text) {
    return String(text ?? "").replace(/<!--[\s\S]*?(?:-->|$)/g, "");
  }

  /** FR-24 ③：链接目标消毒 —— 只放行 http/https/mailto 与相对路径，其余协议返回 null（退化为纯文本）。 */
  function safeHref(raw) {
    const url = String(raw ?? "").trim();
    if (!url) return null;
    if (MD_LINK_SCHEME.test(url)) return url;
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null; // javascript: / data: / vbscript: 一律拒
    if (url.startsWith("//")) return null; // 协议相对外链：不认
    return url; // 相对路径 / 锚点
  }

  /** 纯 DOM 元素工厂（与 createBoard 内的 `mk` 同型，模块级以便测试单独提取本区段）。 */
  function mdEl(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * 行内标记：`**加粗**`（既有行为，不回退）/ `` `代码` `` / `[文本](链接)`。
   * 未匹配的片段一律落为**文本节点** —— 用户内容永不成为 HTML。
   */
  function renderInline(doc, parent, text) {
    const raw = String(text ?? "");
    const re = /\*\*([\s\S]+?)\*\*|`([^`]+)`|\[([^\]\n]*)\]\(([^()\s]*)\)/g;
    let last = 0;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m.index > last) parent.appendChild(doc.createTextNode(raw.slice(last, m.index)));
      if (m[1] !== undefined) {
        parent.appendChild(mdEl(doc, "strong", null, m[1]));
      } else if (m[2] !== undefined) {
        parent.appendChild(mdEl(doc, "code", null, m[2]));
      } else {
        const href = safeHref(m[4]);
        if (href) {
          const a = doc.createElement("a");
          a.setAttribute("href", href);
          a.setAttribute("target", "_blank");
          a.setAttribute("rel", "noopener noreferrer");
          a.textContent = m[3] || href;
          parent.appendChild(a);
        } else {
          // 危险协议 ⇒ 不产生可点击元素，原样文本（既不可执行，也不呈现为可交互内容）
          parent.appendChild(doc.createTextNode(m[0]));
        }
      }
      last = m.index + m[0].length;
    }
    if (last < raw.length) parent.appendChild(doc.createTextNode(raw.slice(last)));
    return parent;
  }

  /** 表格行切分（去掉首尾空边框单元）。 */
  function mdSplitRow(line) {
    let s = String(line).trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  /** 表格分隔行判定：每个单元都是 `---` / `:--` / `--:` 形态（即 `| --- | --- |`）。 */
  function mdIsSeparator(line) {
    const cells = mdSplitRow(line);
    return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c));
  }

  function mdTable(doc, header, rows) {
    const table = mdEl(doc, "table", "md-table");
    const thead = doc.createElement("thead");
    const htr = doc.createElement("tr");
    for (const cell of header) {
      const th = doc.createElement("th");
      renderInline(doc, th, cell);
      htr.appendChild(th);
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = doc.createElement("tbody");
    for (const row of rows) {
      const tr = doc.createElement("tr");
      for (let c = 0; c < header.length; c += 1) {
        const td = doc.createElement("td");
        renderInline(doc, td, row[c] ?? "");
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    return table;
  }

  /**
   * FR-24 块级解析 · 返回 `.rich-body` 容器。
   * 口径保持：段落仍按**空行分段**、段内保留换行（由 CSS `white-space: pre-wrap` 负责）。
   */
  function renderMarkdown(doc, text) {
    const wrap = mdEl(doc, "div", "rich-body md-body");
    const lines = stripHtmlComments(text).replace(/\r\n?/g, "\n").split("\n");
    const para = [];
    const flushParagraph = () => {
      const body = para.join("\n").replace(/\s+$/, "");
      para.length = 0;
      if (!body.trim()) return;
      const p = doc.createElement("p");
      renderInline(doc, p, body);
      wrap.appendChild(p);
    };
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      // 代码块：``` 围栏（内容**原样**，不做任何行内解析 —— 里面的 `**` 不得变成加粗）
      if (/^\s*```/.test(line)) {
        flushParagraph();
        const codeLines = [];
        i += 1;
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          codeLines.push(lines[i]);
          i += 1;
        }
        i += 1; // 跳过收尾围栏（缺失则到文末）
        const pre = mdEl(doc, "pre", "md-pre");
        pre.appendChild(mdEl(doc, "code", null, codeLines.join("\n")));
        wrap.appendChild(pre);
        continue;
      }
      // 表格：当前行含 `|` 且下一行是分隔行
      if (line.includes("|") && i + 1 < lines.length && mdIsSeparator(lines[i + 1])) {
        flushParagraph();
        const header = mdSplitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
          rows.push(mdSplitRow(lines[i]));
          i += 1;
        }
        wrap.appendChild(mdTable(doc, header, rows));
        continue;
      }
      // 标题：# ~ ######（降两级落 h3~h6 —— 页面已有 h1/h2，正文不抢标题层级）
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        const level = Math.min(heading[1].length + 2, 6);
        const h = mdEl(doc, `h${level}`, `md-h md-h${heading[1].length}`);
        renderInline(doc, h, heading[2]);
        wrap.appendChild(h);
        i += 1;
        continue;
      }
      // 引用：> 开头（连续行合并）
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoted = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        const bq = mdEl(doc, "blockquote", "md-quote");
        renderInline(doc, bq, quoted.join("\n"));
        wrap.appendChild(bq);
        continue;
      }
      // 任务清单：- [ ] / - [x]（**只读** checkbox 字形，不是可点的 input）
      if (MD_TASK_ITEM.test(line)) {
        flushParagraph();
        const ul = mdEl(doc, "ul", "md-tasks");
        while (i < lines.length && MD_TASK_ITEM.test(lines[i])) {
          const t = MD_TASK_ITEM.exec(lines[i]);
          const checked = /x/i.test(t[1]);
          const li = mdEl(doc, "li", `md-task${checked ? " checked" : ""}`);
          const box = mdEl(doc, "span", "md-check", checked ? "☑" : "☐");
          box.setAttribute("aria-hidden", "true");
          li.appendChild(box);
          const label = mdEl(doc, "span", "md-task-text");
          renderInline(doc, label, t[2]);
          li.appendChild(label);
          ul.appendChild(li);
          i += 1;
        }
        wrap.appendChild(ul);
        continue;
      }
      // 无序列表
      if (MD_BULLET.test(line)) {
        flushParagraph();
        const ul = mdEl(doc, "ul", "md-list");
        while (i < lines.length && !MD_TASK_ITEM.test(lines[i]) && MD_BULLET.test(lines[i])) {
          const li = doc.createElement("li");
          renderInline(doc, li, MD_BULLET.exec(lines[i])[1]);
          ul.appendChild(li);
          i += 1;
        }
        wrap.appendChild(ul);
        continue;
      }
      // 有序列表
      if (MD_ORDERED.test(line)) {
        flushParagraph();
        const ol = mdEl(doc, "ol", "md-list");
        while (i < lines.length && MD_ORDERED.test(lines[i])) {
          const li = doc.createElement("li");
          renderInline(doc, li, MD_ORDERED.exec(lines[i])[2]);
          ol.appendChild(li);
          i += 1;
        }
        wrap.appendChild(ol);
        continue;
      }
      // 空行 ⇒ 段落边界（沿用「按空行分段」口径）
      if (line.trim() === "") {
        flushParagraph();
        i += 1;
        continue;
      }
      para.push(line);
      i += 1;
    }
    flushParagraph();
    return wrap;
  }
  // == FR-24-MD-END ==

  function createBoard(options = {}) {
    const root = options.root;
    if (!root) throw new Error("createBoard 需要 root 容器");
    const apiBase = (options.apiBase ?? "").replace(/\/$/, "");
    const sessionId = options.session ?? null; // FR-60：会话上下文（由 conversation.view 注入传入）
    const cwd = options.cwd ?? null;
    const openHostSession = typeof options.openSession === "function" ? options.openSession : null; // FR-48：客户端会话切换
    const doc = root.ownerDocument ?? document;
    // FR-28：会话内**默认按本会话收敛**（档位＝`session:<本会话标识>`，可用「全部」一键切回）；
    // 拿不到 sessionId（非会话作用域入口）时保持「全部」，并由工具栏明写降级文案（见 NO_SESSION_NOTICE）。
    const defaultSessionScope = sessionId ? `${SESSION_SCOPE_CURRENT_PREFIX}${sessionId}` : "";
    const state = { statuses: [], priorities: [], projects: [], tasks: [], projectId: "", priority: "", label: "", sessionScope: defaultSessionScope, session: sessionId, keyword: "", loop: {}, host: null, binding: { projectId: null, bound: true, mainSessionId: null, association: null }, showArchived: false, collapsedSections: [], touchedSections: [], emptyState: null, dragTask: null, dragEl: null };
    let editing = null;
    let destroyed = false;

    const mk = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    /**
     * `**加粗**` 的轻量渲染：多段提示文案里本来就写了 markdown 加粗，但落到 `textContent` 就成了**字面量 `**`**
     * （真机可见：`⚠ 接续会话 … **属于另一个工作区**…`）。只处理加粗这一种标记，不引入 markdown 解析器。
     */
    const mkRich = (tag, className, text) => {
      const node = mk(tag, className);
      const parts = String(text ?? "").split("**");
      parts.forEach((part, i) => {
        if (!part) return;
        node.appendChild(i % 2 === 1 ? mk("strong", null, part) : doc.createTextNode(part));
      });
      return node;
    };
    const option = (value, label) => {
      const node = mk("option");
      node.value = value;
      node.textContent = label;
      return node;
    };

    // ---------------------------------------------------------------- chrome
    const shell = mk("div", "app-shell");
    const header = mk("header", "workspace-header");
    const titleBox = mk("div", "workspace-title");
    titleBox.append(mk("h1", null, "Agent Team 任务工作台"), mk("span", "workspace-kicker", "DSH 内嵌工作台"));
    const spacer = mk("div", "header-spacer");
    const themeToggle = mk("button", "ghost", "切换主题");
    themeToggle.type = "button";
    const boardToggle = mk("button", "ghost", "看板");
    boardToggle.type = "button";
    const reqToggle = mk("button", "ghost", "需求");
    reqToggle.type = "button";
    const teamToggle = mk("button", "ghost", "团队");
    teamToggle.type = "button";
    // FR-99：推进清单（五类待办 + 待确认记忆）；放在「团队」「配置」之间，因为它才是"今天该干什么"
    const advanceToggle = mk("button", "ghost", "推进");
    advanceToggle.type = "button";
    advanceToggle.title = "推进清单：五类待办（待人定 / 受阻 / 待评审 / 待收口 / 可开工）+ 待确认记忆";
    const configToggle = mk("button", "ghost", "配置");
    configToggle.type = "button";
    const refreshButton = mk("button", "ghost", "刷新");
    refreshButton.type = "button";
    const navButtons = { board: boardToggle, req: reqToggle, team: teamToggle, advance: advanceToggle, config: configToggle };
    header.append(titleBox, spacer, boardToggle, reqToggle, teamToggle, advanceToggle, configToggle, themeToggle, refreshButton);

    const toolbar = mk("div", "toolbar");
    const projectSelect = mk("select");
    projectSelect.setAttribute("aria-label", "选择项目");
    const priorityFilter = mk("select");
    priorityFilter.setAttribute("aria-label", "按优先级筛选");
    const labelFilter = mk("select");
    labelFilter.setAttribute("aria-label", "按标签筛选");
    // FR-26 / FR-28：会话归属维度（全部 / 仅本会话 / 已关联会话 / 未关联会话）—— 与 FR-13 的其它维度取交集
    const sessionFilter = mk("select");
    sessionFilter.setAttribute("aria-label", "按会话归属筛选");
    // FR-14：关键词搜索输入 —— 与既有筛选并排，覆盖「编号 / 标题 / 描述 / 标签」，可与筛选同时生效。
    // 口径唯一来源仍是服务端（`/api/tasks?q=`）：前端只负责传值，不在本地二次判定（与其它维度同一条路）。
    const keywordInput = mk("input", "keyword-input");
    keywordInput.type = "search";
    keywordInput.placeholder = "搜索任务：编号 / 标题 / 描述 / 标签";
    keywordInput.setAttribute("aria-label", "搜索任务（编号 / 标题 / 描述 / 标签）");
    keywordInput.value = state.keyword;
    // FR-28：降级**可见** —— 拿不到当前会话标识时，工具栏明写「未检测到当前会话 · 显示全部」，不得静默全显。
    const sessionScopeNote = mk("span", "hint session-scope-note", sessionId ? "" : NO_SESSION_NOTICE);
    if (!sessionId) sessionScopeNote.title = "本面板不在会话作用域内（拿不到 sessionId）：无从按本会话收敛，故如实显示本项目全部任务。";
    /** FR-28：渲染降级提示（两种成因都**明写**，绝不静默 —— 见 NO_SESSION_NOTICE 与 loadTasks 的降级分支）。 */
    function renderSessionScopeNote() {
      if (!sessionId) { sessionScopeNote.textContent = NO_SESSION_NOTICE; return; }
      if (state.sessionScopeUnsupported) {
        sessionScopeNote.textContent = "服务端未加载「仅本会话」档 · 显示全部（需重载插件）";
        sessionScopeNote.title = "当前页面的 app.js 已是新版，但服务端仍是旧版、不认 `sessionScope=session:<id>`（会如实报 INVALID_FIELD）；为不把看板弄空，已退回「全部」并如实告知。重载插件后本档即可用。";
        return;
      }
      sessionScopeNote.textContent = "";
    }
    toolbar.append(
      mk("label", null, "项目"), projectSelect,
      mk("label", null, "优先级"), priorityFilter,
      mk("label", null, "标签"), labelFilter,
      mk("label", null, "会话归属"), sessionFilter, sessionScopeNote,
      mk("label", null, "搜索"), keywordInput,
      mk("div", "header-spacer"),
    );
    const summary = mk("span", "hint");
    // FR-75/76：执行看护提示条（停滞 / 待决策计数，点击看清单）
    const wdNotice = mk("button", "ghost");
    wdNotice.type = "button";
    wdNotice.hidden = true;
    wdNotice.title = "执行看护：需要你介入的任务（停滞 / 待决策）";
    wdNotice.addEventListener("click", () => {
      const rows = state.tasks.filter((t) => t.watchdog && (t.watchdog.state === "stalled" || t.watchdog.state === "awaiting-decision"));
      if (!rows.length) { showBanner("执行看护：暂无需要介入的任务", "info"); return; }
      showBanner(`执行看护（${rows.length}）：${rows.map((t) => `${t.identifier} ${t.watchdog.state === "stalled" ? `停滞${t.watchdog.minutes}m` : "待决策"}`).join("；")}`, "error");
    });
    const newTask = mk("button", "primary", "新建任务");
    newTask.type = "button";
    // 真机 2026-10-23（用户报障「从侧栏进工作台想新建项目找不到入口；『新建任务』在非看板视图也无意义」）：
    // 工具栏是唯一在所有视图都可见的操作区 ⇒「新建项目」放这里；「新建任务」只在看板视图显示。
    const newProject = mk("button", "ghost", "新建项目");
    newProject.type = "button";
    newProject.title = "新建项目并切换过去（工作目录可留空；建完本会话即成为它的主会话）";
    const loopToggle = mk("button", "ghost", "定时执行：关");
    loopToggle.type = "button";
    loopToggle.title = "看板执行循环：定时把「待执行(todo)且已归因」的任务自动派发给活跃执行者";
    // FR-88：折叠卡片的显隐开关（默认收起 —— 看板默认只剩「主干」层次）
    const archivedToggle = mk("button", "ghost", "显示已折叠");
    archivedToggle.type = "button";
    archivedToggle.title = "折叠 = 给卡片打 archived 标签并默认隐藏（不删数据）：随时可展开查看，或对单张卡「取消折叠」";
    // FR-93：切换折叠开关后重新取服务端口径（会先清空 → 降级渲染，不闪烁旧引导）
    archivedToggle.addEventListener("click", () => {
      state.showArchived = !state.showArchived;
      state.emptyState = null;
      void loadEmptyState().then(() => { renderBoard(); renderControls(); });
      renderBoard();
      renderControls();
    });
    toolbar.append(summary, wdNotice, archivedToggle, loopToggle, newProject, newTask);

    const banner = mk("div", "banner info");
    banner.hidden = true;
    /**
     * FR-20 补口（2026-10-23 真机取证缺口 A）· 实时通道状态条。
     *
     * 与 `banner` **刻意分开**：`showBanner` 是「一次性提示」（info 5s / error 10s 自动消失），
     * 而「断线 / 重连中」必须**持续可见到恢复为止** —— 用 banner 会被定时器提前藏掉，
     * 用户于是看不出界面正在撒谎。此条只在 SSE `onerror` 时显示，`onopen` 时隐藏。
     * 复用既有 `.banner error` 样式（不新增 CSS、不新增取数通道）。
     */
    const connNotice = mk("div", "banner error");
    connNotice.hidden = true;
    connNotice.setAttribute("role", "status");
    // 能力边界提示（真机 2026-10-29 · `:47830`）：**常驻**（不是 5s 就消失的一次性 banner）——
    // 它描述的是"这个实例能做什么"，不是某一次操作的结果。
    const hostNotice = mk("div", "banner warn");
    hostNotice.hidden = true;
    hostNotice.setAttribute("role", "status");
    const boardScroll = mk("main", "board-scroll");
    const board = mk("div", "board");
    board.setAttribute("aria-label", "任务看板（按状态分列）");
    boardScroll.appendChild(board);
    const reqScroll = mk("main", "board-scroll");
    reqScroll.hidden = true;
    const reqRoot = mk("div", "requirements-view");
    reqScroll.appendChild(reqRoot);
    const configScroll = mk("main", "board-scroll");
    configScroll.hidden = true;
    const configRoot = mk("div", "requirements-view");
    configScroll.appendChild(configRoot);
    const teamScroll = mk("main", "board-scroll");
    teamScroll.hidden = true;
    const teamRoot = mk("div", "team-view");
    teamScroll.appendChild(teamRoot);
    const gateScroll = mk("main", "board-scroll");
    gateScroll.hidden = true;
    const gateRoot = mk("div", "requirements-view");
    gateScroll.appendChild(gateRoot);
    // FR-99 / FR-100：推进清单 + 待确认记忆（与看板/需求/团队/配置并列的一个视图，不抢它们的布局）
    const advanceScroll = mk("main", "board-scroll");
    advanceScroll.hidden = true;
    const advanceRoot = mk("div", "advance-view");
    advanceScroll.appendChild(advanceRoot);
    shell.append(header, toolbar, banner, connNotice, hostNotice, boardScroll, reqScroll, teamScroll, configScroll, gateScroll, advanceScroll);

    // 任务详情抽屉（含"归属团队 / 执行会话"关联）
    const drawerBackdrop = mk("div", "tb-drawer-backdrop");
    const drawer = mk("aside", "tb-drawer");
    const drawerHead = mk("div", "tb-drawer-head");
    const drawerHeadMain = mk("div");
    const drawerTitle = mk("h2", null, "");
    const drawerId = mk("div", "tb-drawer-id", "");
    drawerHeadMain.append(drawerId, drawerTitle);
    const drawerClose = mk("button", "ghost", "✕");
    drawerClose.type = "button";
    drawerClose.title = "关闭";
    // FR-87 修订（2026-10-19）：抽屉头加「全部收起 / 全部展开」与「全屏 / 还原」两个动作。
    const drawerExpandAll = mk("button", "ghost", "全部收起");
    drawerExpandAll.type = "button";
    drawerExpandAll.title = "一键收起 / 展开抽屉里的全部区块（内容不动，只是隐藏）";
    const drawerFull = mk("button", "ghost", "全屏");
    drawerFull.type = "button";
    drawerFull.title = "抽屉铺满窗口（再点一下还原为按视口分级的默认宽度）";
    // 2026-10-23（用户真机批注）：整卡动作区上移到标题栏 —— 与「全部收起 / 还原 / ✕」同一排；
    // 卡片级操作（编辑 / 移动列 / 启动执行 / 拆解…）不再沉在正文最底部的「操作」区块里。
    const drawerActions = mk("div", "tb-drawer-actions");
    drawerHead.append(drawerHeadMain, mk("div", "spacer"), drawerActions, drawerExpandAll, drawerFull, drawerClose);
    const drawerResize = mk("div", "tb-drawer-resize");
    drawerResize.title = "拖动调整抽屉宽度（双击还原）";
    const drawerBody = mk("div", "tb-drawer-body");
    drawer.append(drawerResize, drawerHead, drawerBody);
    const closeDrawer = () => { drawer.classList.remove("show"); drawerBackdrop.classList.remove("show"); detailTask = null; };
    drawerClose.addEventListener("click", closeDrawer);
    drawerBackdrop.addEventListener("click", closeDrawer);
    // FR-87：ESC 关抽屉（长详情滚到底后不必回头找右上角 ✕）
    doc.addEventListener("keydown", (event) => {
      if (event && event.key === "Escape" && drawer.classList.contains("show")) closeDrawer();
    });

    /* FR-87 修订：抽屉宽度与栏数（纯呈现，不写任何任务数据）。
       · 宽度：没自定过 → 跟随 CSS 的按视口分级；拖左缘或点「全屏」→ 写行内 `--drawer-width` 并记住
         （`0` = 全屏，随窗口重算；双击手柄 = 忘掉自定值，回到分级默认）。
       · 栏数：按**实测抽屉宽度**决定正文一栏还是两栏 —— 拖宽 / 全屏 / 改窗口都即时重算。 */
    const DRAWER_WIDTH_KEY = "tb.drawer.width";
    const DRAWER_WIDTH_FULL = 0;
    const DRAWER_MIN_WIDTH = 460;
    const DRAWER_COLS_MIN_WIDTH = 1150;
    const drawerWin = doc.defaultView ?? (typeof window !== "undefined" ? window : null);
    const drawerMaxWidth = () => Math.max(DRAWER_MIN_WIDTH, Math.round((drawerWin?.innerWidth ?? 1440) - 8));
    const clampDrawerWidth = (px) => Math.min(Math.max(Math.round(px), DRAWER_MIN_WIDTH), drawerMaxWidth());
    const readDrawerWidth = () => {
      try {
        const raw = drawerWin?.localStorage?.getItem(DRAWER_WIDTH_KEY);
        if (raw === null || raw === undefined || raw === "") return null;
        const value = Number(raw);
        return Number.isFinite(value) && value >= DRAWER_WIDTH_FULL ? value : null;
      } catch (_) { return null; }
    };
    const writeDrawerWidth = (value) => {
      try {
        if (value === null) drawerWin?.localStorage?.removeItem(DRAWER_WIDTH_KEY);
        else drawerWin?.localStorage?.setItem(DRAWER_WIDTH_KEY, String(value));
      } catch (_) { /* 存储不可用只丢记忆，不影响布局 */ }
    };
    const syncDrawerCols = () => {
      const width = drawer.getBoundingClientRect?.().width ?? 0;
      drawerBody.dataset.cols = width >= DRAWER_COLS_MIN_WIDTH ? "2" : "1";
    };
    const syncDrawerWidth = () => {
      const stored = readDrawerWidth();
      if (stored === null) drawer.style.removeProperty("--drawer-width");
      else if (stored === DRAWER_WIDTH_FULL) drawer.style.setProperty("--drawer-width", `${drawerMaxWidth()}px`);
      else drawer.style.setProperty("--drawer-width", `${clampDrawerWidth(stored)}px`);
      drawerFull.textContent = stored === DRAWER_WIDTH_FULL ? "还原" : "全屏";
      syncDrawerCols();
    };
    syncDrawerWidth();
    const onDrawerViewportResize = () => syncDrawerWidth();
    drawerWin?.addEventListener?.("resize", onDrawerViewportResize);
    try {
      if (typeof ResizeObserver === "function") new ResizeObserver(() => syncDrawerCols()).observe(drawer);
    } catch (_) { /* 老环境退回 resize 事件 */ }
    // 左缘拖拽：拖动中只改行内宽度，松手才落盘记忆。
    drawerResize.addEventListener("pointerdown", (event) => {
      if (!event || event.button !== 0) return;
      const startX = event.clientX;
      const startWidth = drawer.getBoundingClientRect?.().width ?? 0;
      drawer.classList.add("dragging");
      try { drawerResize.setPointerCapture?.(event.pointerId); } catch (_) { /* 捕获失败也能靠层内事件继续 */ }
      const onMove = (moveEvent) => {
        drawer.style.setProperty("--drawer-width", `${clampDrawerWidth(startWidth + (startX - moveEvent.clientX))}px`);
        syncDrawerCols();
      };
      const onUp = () => {
        drawerResize.removeEventListener("pointermove", onMove);
        drawerResize.removeEventListener("pointerup", onUp);
        drawerResize.removeEventListener("pointercancel", onUp);
        drawer.classList.remove("dragging");
        const finalWidth = Math.round(drawer.getBoundingClientRect?.().width ?? 0);
        writeDrawerWidth(finalWidth >= drawerMaxWidth() - 1 ? DRAWER_WIDTH_FULL : clampDrawerWidth(finalWidth));
        syncDrawerWidth();
      };
      drawerResize.addEventListener("pointermove", onMove);
      drawerResize.addEventListener("pointerup", onUp);
      drawerResize.addEventListener("pointercancel", onUp);
      event.preventDefault?.();
    });
    // 双击手柄 = 忘掉自定宽度，回到「按视口分级」的默认口径。
    drawerResize.addEventListener("dblclick", () => { writeDrawerWidth(null); syncDrawerWidth(); });
    drawerFull.addEventListener("click", () => {
      writeDrawerWidth(readDrawerWidth() === DRAWER_WIDTH_FULL ? null : DRAWER_WIDTH_FULL);
      syncDrawerWidth();
    });

    // FR-87：抽屉分区可折叠 —— 内容不动，只把长详情按区块收起；折叠状态按分区标题记忆。
    const drawerSections = () => Array.from(drawerBody.querySelectorAll(".drawer-section"));
    const syncExpandAllLabel = () => {
      const sections = drawerSections();
      const allCollapsed = sections.length > 0 && sections.every((section) => section.classList.contains("collapsed"));
      drawerExpandAll.textContent = allCollapsed ? "全部展开" : "全部收起";
    };
    const setSectionCollapsed = (section, collapsed) => {
      const key = String(section.querySelector(":scope > h3")?.textContent ?? "");
      section.classList.toggle("collapsed", collapsed);
      const known = state.collapsedSections.includes(key);
      if (collapsed && !known) state.collapsedSections.push(key);
      if (!collapsed && known) state.collapsedSections = state.collapsedSections.filter((k) => k !== key);
      if (!state.touchedSections.includes(key)) state.touchedSections.push(key); // 人手动开过/关过的不再由默认策略摆布
    };

    /**
     * FR-89：按「下一步」给的 `focus` 决定哪些区块**默认展开**。
     *
     * 真机反馈（2026-10-22）：「既然任务收口了，为何该页面还有这么多人工检验、评审、执行会话按钮动作」
     * 「任务异常时既可评审又可检验、无从下手」。根因不是内容多，而是**没有主次** —— 收口卡把处置按钮
     * 原样摆着、异常卡把所有出口并列摆着。这里只做**呈现层的默认折叠**：内容一个不删、按钮一个不删，
     * 点区块标题即可展开；人手动开过的区块（`state.touchedSections`）不再被默认策略收回去。
     *
     * @returns {string[]} 实际被收起的区块标题（供「下一步」块给出可点的展开入口）
     */
    const ACTION_SECTION_KEYS = ["评审", "人工校验", "归因", "操作", "执行会话", "CLI 执行器", "执行看护", "归属团队", "诊断与恢复动作"];
    const applyFocusPolicy = (focus) => {
      if (!Array.isArray(focus)) return []; // null ＝ 状态未识别，不按猜测重排界面
      const folded = [];
      for (const section of drawerSections()) {
        const title = String(section.querySelector(":scope > h3")?.textContent ?? "");
        if (!ACTION_SECTION_KEYS.some((k) => title.includes(k))) continue;
        if (state.touchedSections.includes(title)) continue;
        const keepOpen = focus.some((k) => title.includes(k));
        section.classList.toggle("collapsed", !keepOpen);
        if (!keepOpen) folded.push(title);
      }
      return folded;
    };
    drawerBody.addEventListener("click", (event) => {
      const target = event && event.target;
      if (!target || typeof target.closest !== "function") return;
      const head = target.closest(".drawer-section > h3");
      if (!head || !drawerBody.contains(head)) return;
      const section = head.parentElement;
      if (!section) return;
      setSectionCollapsed(section, !section.classList.contains("collapsed"));
      syncExpandAllLabel();
    });
    // FR-87 修订：一键收起 / 展开全部区块（复用同一套折叠状态记忆）。
    drawerExpandAll.addEventListener("click", () => {
      const sections = drawerSections();
      if (!sections.length) return;
      const collapseAll = !sections.every((section) => section.classList.contains("collapsed"));
      for (const section of sections) setSectionCollapsed(section, collapseAll);
      syncExpandAllLabel();
    });
    shell.append(drawerBackdrop, drawer);

    // 对话框
    const dialog = mk("dialog");
    const dialogTitle = mk("h2", null, "新建任务");
    const form = mk("form");
    form.method = "dialog";
    const field = (labelText, control, id) => {
      const wrap = mk("div", "field");
      const label = mk("label", null, labelText);
      label.htmlFor = id;
      wrap.append(label, control);
      return wrap;
    };
    const fTitle = mk("input");
    fTitle.type = "text";
    fTitle.id = "tb-f-title";
    fTitle.required = true;
    fTitle.maxLength = 200;
    const fDescription = mk("textarea");
    fDescription.id = "tb-f-description";
    // FR-94（真机反馈 2026-10-22）：「为方便任务执行情况确认，应该在概览内任务添加时即记录
    // 完成验收及复核动作标准，以便快速复核」—— 所以这两个字段放在**新建/编辑**对话框里，
    // 而不是等卡到「待验收」才让人补。
    const fAcceptance = mk("textarea");
    fAcceptance.id = "tb-f-acceptance";
    fAcceptance.rows = 3;
    fAcceptance.placeholder = "例如：/api/tasks 返回 200 且 done 只由人置；npm test 全绿";
    const fVerifyCommand = mk("input");
    fVerifyCommand.type = "text";
    fVerifyCommand.id = "tb-f-verify";
    fVerifyCommand.placeholder = "留空＝回落项目设置（配置页 envConfig.verifyCommand，默认 npm test）";
    // 归因（真机批注 2026-10-28「很多卡片未关联项目需求」）：新建/编辑对话框此前**没有**条目字段，
    // 从界面建的卡必然无归因（服务端只回 warning）⇒ 归因只能事后进抽屉补，漏一次就留一张裸卡。
    // 口径：**补入口，不改门** —— 不选仍然放行（服务端 warning + 卡面「未归因」标记照旧）；
    // 编辑态**只回显、不改绑**（改绑走抽屉的「改绑需求条目」，避免顺手改掉归属）。
    const fRequirement = mk("select");
    fRequirement.id = "tb-f-requirement";
    const fStatus = mk("select");
    fStatus.id = "tb-f-status";
    const fPriority = mk("select");
    fPriority.id = "tb-f-priority";
    const fOwner = mk("select");
    fOwner.id = "tb-f-owner";
    const fLabels = mk("input");
    fLabels.type = "text";
    fLabels.id = "tb-f-labels";
    fLabels.placeholder = "逗号分隔，例如：看板, 优化";
    const formHint = mk("p", "hint");
    const actions = mk("div", "dialog-actions");
    const cancelButton = mk("button", "ghost", "取消");
    cancelButton.type = "button";
    const saveButton = mk("button", "primary", "保存");
    saveButton.type = "submit";
    actions.append(cancelButton, saveButton);
    form.append(
      field("标题 *", fTitle, fTitle.id),
      field("描述（Markdown，可留空）", fDescription, fDescription.id),
      field("完成验收标准（怎么算做完，可留空）", fAcceptance, fAcceptance.id),
      field("复核动作（本卡复核命令，可留空）", fVerifyCommand, fVerifyCommand.id),
      field("需求条目（归因；留空＝不归因，执行/派发会被归因门拦下）", fRequirement, fRequirement.id),
      field("状态", fStatus, fStatus.id),
      field("优先级", fPriority, fPriority.id),
      field("负责人 / 角色", fOwner, fOwner.id),
      field("标签", fLabels, fLabels.id),
      formHint, actions,
    );
    dialog.append(dialogTitle, form);
    shell.appendChild(dialog);
    root.replaceChildren(shell);

    // ---------------------------------------------------------------- helpers
    /**
     * FR-95（2026-10-26 补）：会话**命名结果**的如实呈现片段 —— 供各「建会话」出口的横幅复用。
     *
     * 为什么要有：命名口径（口径 1「【任务】+ 标题 + 时间」/ 口径 2「【项目】+ 项目名（重建|重绑）」）
     * 是**用户可见**的约束；而宿主 `create()` 不收 title ⇒ 一律「建完再改名」，**改名可能失败**。
     * 服务端一直如实回 `titleApplied / titleReason`，但此前**没有任何界面展示它** ⇒ 用户既看不到名字、
     * 也不知道没改上。「如实回报」断在最后一跳，这里补上。
     *
     * 规则（不臆造）：① `titleApplied == null`（宿主没回，例如降级未建会话）⇒ 空串，**不加噪音**；
     * ② `true` ⇒ ` · 会话名《…》`（无名可展示时也不硬凑）；③ `false` ⇒ **明确说出未生效 + 原因**。
     */
    const sessionNameClause = (r) => {
      if (!r || r.titleApplied == null) return "";
      if (r.titleApplied === true) return r.sessionName ? ` · 会话名《${r.sessionName}》` : "";
      return ` · ⚠ 会话名未生效（${r.titleReason ?? "原因未知"}）`;
    };
    const showBanner = (message, kind = "info") => {
      banner.textContent = message;
      banner.className = `banner ${kind}`;
      banner.hidden = false;
      try { banner.scrollIntoView({ block: "nearest" }); } catch { /* ignore */ }
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => { banner.hidden = true; }, kind === "error" ? 10000 : 5000);
    };
    const hideBanner = () => { banner.hidden = true; clearTimeout(bannerTimer); };
    let bannerTimer = null;

    /**
     * 能力边界（真机 2026-10-29 · `:47830`「未能投递：host-unavailable」+「无法自动打开…」连撞两次）。
     *
     * 那个实例是**独立进程**（`node src/server/server.mjs`，没有 DSH 宿主），`/api/health` 里
     * `host.capabilities = null`、`createSession/sendPrompt/openSession` 全 `false` ——
     * 「投给主会话 / 打开会话 / 派发团队」这类动作在那里**注定失败**，服务端也如实回了 `host-unavailable`。
     * 但前端从来没读过这个能力位 ⇒ 按钮照常亮着可点，人只会一遍遍撞同一堵墙。
     *
     * 口径：**「按钮在」≠「功能可用」**。能力位缺失时**置灰 + 指路**，比让人反复失败更诚实；
     * 能力位**未知**（health 还没回来 / 老宿主不报）时**不擅自禁用** —— 那时交给服务端如实拒绝。
     */
    const hostCaps = () => state.host ?? null;
    const needsHost = (el, cap) => { if (el) el.dataset.needsHost = cap; return el; };
    const HOST_CAP_LABEL = {
      sendPrompt: "投给主会话",
      openSession: "打开会话",
      createSession: "新建会话",
      sessionExists: "改绑/改指会话",
      listSessions: "列出会话",
    };
    /** 兜底表：经诊断动作等"按 label 现造"的按钮无法逐个加标记时，按文案认回来（守卫测试会核对文案仍在）。 */
    const HOST_BUTTON_LABELS = new Map([
      ["投给主会话", "sendPrompt"],
      ["自动生成（交主会话）", "sendPrompt"],
      ["按意见重生成", "sendPrompt"],
      ["打开执行会话", "openSession"],
      ["打开会话", "openSession"],
      ["派发团队", "createSession"],
      ["再派发一队", "createSession"],
      // 会话重建/改绑（2026-10-29 二轮复核补齐）：这两族依赖**不同的**宿主能力，不能混为一谈 ——
      // 「重建」要建会话（`createSession`）；「改绑/改指到已有会话」只要查得到会话（`sessionExists`），
      // 而后者的保底价值恰恰在"建会话不可用"时（FR-84），故不跟着 createSession 一起置灰。
      ["重建并绑定主会话", "createSession"],
      ["重建并绑定项目主会话", "createSession"],
      ["重建主会话并把本任务改指过去", "createSession"],
      ["改绑为主会话", "sessionExists"],
      ["用当前会话作为项目主会话", "sessionExists"],
      ["改指到项目主会话（本任务）", "sessionExists"],
    ]);
    function applyHostGate() {
      const caps = hostCaps();
      if (!caps) return;
      const mark = (el, cap) => {
        const missing = !caps[cap];
        if (el.disabled !== missing) el.disabled = missing;
        const hint = `当前实例无宿主会话通道（独立进程）：${HOST_CAP_LABEL[cap] ?? "该动作"}不可用 —— 请到 DSH 内的任务工作台操作`;
        if (missing) { if (el.title !== hint) el.title = hint; } else if (el.title === hint) el.title = "";
      };
      for (const el of doc.querySelectorAll("[data-needs-host]")) mark(el, el.dataset.needsHost);
      for (const el of doc.querySelectorAll("button:not([data-needs-host])")) {
        const cap = HOST_BUTTON_LABELS.get((el.textContent ?? "").trim());
        if (cap) { el.dataset.needsHost = cap; mark(el, cap); }
      }
    }
    function renderHostNotice() {
      const caps = hostCaps();
      const need = ["sendPrompt", "openSession", "createSession", "sessionExists", "listSessions"];
      if (!caps || need.every((cap) => caps[cap])) { hostNotice.hidden = true; return; }
      hostNotice.textContent = "本实例是独立进程，没有 DSH 宿主会话通道：「投给主会话 / 打开会话 / 派发团队」这类动作在这里不可用（相关按钮已置灰）。看板、建卡、改状态、评审、人工收口都照常可用；要投递或派发，请到 DSH 内的任务工作台（地址以 /integrations/taskboard-workbench 结尾的那个页面）操作。";
      hostNotice.hidden = false;
    }
    /**
     * FR-84 补口（2026-10-18 真机）：`navigator.clipboard.writeText()` 返回 **Promise**，
     * 权限被拒或非安全上下文时是 **rejection** —— 老写法 `try { writeText(x) } catch {}` **抓不到**，
     * 会被下面的 unhandledrejection 兜成「脚本错误：…」横幅，**把真正的降级提示语顶掉**
     * （真机现场：点「打开执行会话」→ 期望看到「已复制会话标识：session-…」，实际被脚本错误覆盖）。
     * 统一走这里：resolve→true / reject→false，由调用方**如实**告知复制成功还是失败。
     */
    const copyText = (text) => {
      let p;
      try { p = navigator.clipboard?.writeText(String(text)); } catch (error) { p = Promise.reject(error); }
      return (p && typeof p.then === "function" ? p : Promise.resolve()).then(() => true, () => false);
    };
    // 兜底：把未处理的异步错误也显示出来（避免"点了没反应"）
    try {
      window.addEventListener("unhandledrejection", (event) => {
        const msg = event?.reason?.message ?? event?.reason ?? "未知错误";
        showBanner(`脚本错误：${msg}`, "error");
      });
    } catch { /* ignore */ }

    async function api(method, apiPath, body) {
      const response = await fetch(`${apiBase}${apiPath}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        throw new Error(`响应不是 JSON（HTTP ${response.status}）`);
      }
      if (!response.ok) {
        const error = new Error(payload?.error?.message ?? `HTTP ${response.status}`);
        error.code = payload?.error?.code;
        error.details = payload?.error?.details;
        throw error;
      }
      return payload;
    }

    const ownerOf = (task) => task.owner ?? "";

    function fillSelect(select, entries, current, placeholder) {
      select.replaceChildren();
      if (placeholder) select.appendChild(option("", placeholder));
      for (const [value, label] of entries) select.appendChild(option(value, label));
      select.value = current;
    }

    function card(task) {
      const node = mk("article", "task-card");
      node.tabIndex = 0;
      // FR-11：可拖拽（原生 HTML5 DnD，零依赖）。门不在前端 —— 落点最终走 `PATCH /api/tasks/:ref`
      // 的 `status` + `boardPosition`，与「上一列 / 下一列」**同一条入口、同一套门**。
      node.draggable = true;
      node.setAttribute("aria-roledescription", "可拖拽的任务卡");
      node.title = `${task.title} —— 可拖到其它列改状态，或在列内拖到目标位置调顺序；键盘路径用「← / →」按钮。`
        + `人工顺序只记在列内、与筛选无关：筛选只决定此刻看得见哪些卡，落点按可见邻居记，被筛掉的卡相对位置不变。`;
      node.addEventListener("dragstart", (event) => {
        state.dragTask = task;
        state.dragEl = node;
        node.classList.add("is-dragging");
        try {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", task.identifier);
        } catch { /* 老浏览器 / 无 dataTransfer：不影响下面按 state 走的落点 */ }
      });
      node.addEventListener("dragend", () => {
        state.dragTask = null;
        state.dragEl = null;
        node.classList.remove("is-dragging");
        clearDropMarkers();
      });
      node.setAttribute("aria-label", `${task.identifier} ${task.title}`);
      const topline = mk("div", "card-topline");
      topline.append(mk("span", "card-identifier", task.identifier));
      const priority = mk("span", `priority-chip priority-${task.priority}`, PRIORITY_LABELS[task.priority] ?? task.priority);
      topline.appendChild(priority);
      // 2026-10-22：未归因的卡 —— 卡面直接标出来，别再等人点下去才被归因门拒。
      // 判据与卡片主按钮同口径（`needsAttribution`），且**与所在列无关**（第十报：待验收的未归因卡
      // 此前卡面毫无提示，抽屉里却给「派发团队」）。服务端的门仍是唯一裁决者，这里只不做无用功。
      if (needsAttribution(task)) {
        const chip = mk("span", "attr-chip", "未归因");
        chip.title = "本卡未归属需求条目：归因门会拦下「启动执行 / 派发团队 / CLI 执行器」。先归因（卡上的「去归因（关联需求条目）」或详情抽屉的「归因」区块），再派发或执行。";
        topline.appendChild(chip);
      }
      // 2026-10-22（第九报）：待办池 = 未授权开工，团队与执行循环**都不会认领**它。
      // 卡面此前只有一个「→」小箭头，人看不出"该点哪"，于是被当成"点了没反应"。
      // 未归因的待办池卡会同时带「未归因」+「未授权」两个标记 —— 先归因、再授权，顺序就是门序列。
      if (task.status === "backlog") {
        const chip = mk("span", "auth-chip", "未授权");
        chip.title = "本卡在「待办池」= 未授权开工：执行循环与团队都不会认领。点卡片上的「授权开工（移出待办池）」即可放行。";
        topline.appendChild(chip);
      }
      // FR-79：诊断摘要徽标（卡片只带 {count, kinds, highestSeverity}，完整列表在详情里）
      const diag = task.diagnostics;
      if (diag && diag.count > 0) {
        const chip = mk("span", `diag-chip diag-chip-${diag.highestSeverity}`,
          `诊断 ${diag.count}${diag.highestSeverity === "high" ? " · 高危" : ""}`);
        chip.title = `${diag.count} 条诊断（最高严重度 ${diag.highestSeverity}）：${diag.kinds.join(" / ")}——打开任务详情看原因与恢复动作`;
        topline.appendChild(chip);
      }
      // FR-75/76：执行看护标记（停滞 / 待决策）——看板上一眼可见，不必点进详情。
      const wd = task.watchdog;
      if (wd && (wd.state === "stalled" || wd.state === "awaiting-decision")) {
        const stalled = wd.state === "stalled";
        const chip = mk("span", `watchdog-chip ${stalled ? "watchdog-stalled" : "watchdog-decision"}`,
          stalled ? `停滞 ${wd.minutes}m` : "待决策");
        chip.title = stalled
          ? `疑似停滞：已 ${wd.minutes} 分钟无进展回报（会话${wd.reason === "session-offline" ? "未在线" : "空闲"}）——可退回待办重新派发`
          : `执行方给出「下一步建议」（${wd.followups.length} 条），等待你决策：派生为子任务 或 忽略`;
        topline.appendChild(chip);
      }
      // FR-80：受阻分类 / 人工兜底标记
      if (task.status === "blocked") {
        const KIND_LABELS = { dependency: "依赖", needs_input: "需人给料", capability: "能力缺失", transient: "瞬时故障" };
        const triage = Boolean(task.triageAt) || (task.labels || []).includes("triage");
        const chip = mk("span", `block-chip ${triage ? "block-triage" : "block-kind"}`,
          triage ? "人工兜底" : `受阻·${KIND_LABELS[task.blockKind] ?? "未分类"}`);
        chip.title = triage
          ? `同因重复阻断 ${task.blockRecurrences ?? 0} 次 → 已转人工兜底（不再自动重派）`
          : `受阻类型：${KIND_LABELS[task.blockKind] ?? "未分类"}${task.blockRecurrences > 1 ? `（同因第 ${task.blockRecurrences} 次）` : ""}`;
        topline.appendChild(chip);
      }
      // FR-83：评审态标记（待评审 / 返工第 N 轮 / 评审通过待人确认）
      if (task.status === "in_review" || task.reviewState === "changes_requested") {
        const state = task.reviewState ?? "pending";
        const round = Number(task.reviewRound ?? 0);
        const label = state === "approved" ? "评审通过·待人确认" : state === "changes_requested" ? `返工第 ${round} 轮` : (round > 0 ? `待评审·返工第 ${round} 轮` : "待评审");
        const chip = mk("span", `review-chip review-${state}`, label);
        chip.title = `评审：${label}${task.reviewer ? ` · 评审者 ${task.reviewer}` : " · 未指派评审者"}`;
        topline.appendChild(chip);
      }
      // FR-85：人工校验任务必须「在看板显著位置可见」（类别 + 待结论/已结论）
      if (isHumanReviewTask(task)) {
        const hrPending = isHumanReviewPending(task);
        const category = hrCategoryLabel(task.humanReviewCategory);
        const chip = mk("span", `hr-chip ${hrPending ? "hr-pending" : "hr-concluded"}`,
          `人工校验·${category}·${hrPending ? "待结论" : "已结论"}`);
        chip.title = hrPending
          ? `人工校验（${category}）待人工结论：结论给出前原任务保持受阻、不自动重派；执行侧不得认领、不得置完成。`
          : `人工校验（${category}）已结论：${HR_CONCLUSION_LABELS[task.humanReviewConclusion] ?? task.humanReviewConclusion ?? "-"}${task.humanReviewConcludedAt ? ` · ${fmtTime(task.humanReviewConcludedAt)}` : ""}`;
        topline.appendChild(chip);
      }
      // FR-88：折叠标记（默认视图里看不到，除非打开「显示已折叠」）
      if (isArchived(task)) {
        const chip = mk("span", "archive-chip", "已折叠");
        chip.title = "该卡已折叠（软归档）：不占默认视图，但数据、评论与历史都在；可在卡片操作区「取消折叠」";
        topline.appendChild(chip);
      }
      // FR-26：会话归属标记 —— 「有人在处理」与「无人认领」一眼可辨（与筛选下拉同口径）。
      // 归属真值＝`task.sessionId`（FR-25，认领/启动执行时写入），此处只呈现，不改任何字段。
      {
        const session = String(task.sessionId ?? "").trim();
        const linked = session !== "";
        const chip = mk("span", `session-chip ${linked ? "session-linked" : "session-unlinked"}`,
          linked ? `已关联会话 · ${session.slice(0, 14)}${session.length > 14 ? "…" : ""}` : "未关联会话");
        chip.title = linked
          ? `已关联会话：${session}（本卡被该会话认领/执行过；用工具栏「会话归属」可按此维度筛选）`
          : "未关联会话：尚无会话认领或执行过本卡（用工具栏「会话归属」可按此维度筛选）";
        topline.appendChild(chip);
      }
      // FR-94：本卡写没写「完成验收标准」—— 卡片上给个可点的标记，评审/复核前一眼可辨
      if (String(task.acceptance ?? "").trim()) {
        const text = String(task.acceptance);
        const chip = mk("span", "accept-chip", "已记验收标准");
        chip.title = `本卡验收标准：${text.slice(0, 200)}${text.length > 200 ? " …（点开详情看全文）" : ""}`;
        topline.appendChild(chip);
      }
      node.append(topline, mk("div", "card-title", task.title));

      const owner = ownerOf(task);
      if (owner || task.labels.length > 0) {
        const row = mk("div", "card-labels");
        if (owner) row.appendChild(mk("span", `owner-chip owner-${owner}`, OWNER_LABELS[owner] ?? owner));
        for (const label of task.labels) row.appendChild(mk("span", "label-chip", label));
        node.appendChild(row);
      }

      const footer = mk("div", "card-actions");
      const moveGroup = mk("div", "move-group");
      const index = state.statuses.indexOf(task.status);
      const step = (delta, glyph, tip) => {
        const button = mk("button", "icon ghost", glyph);
        button.type = "button";
        button.title = tip;
        if (delta > 0) {
          // 「→」＝**下一列**：走与抽屉「下一列」同一份判定（`nextColumnTarget`）——
          // 「待验收」卡的处置归「下一步」区（评审通过 / 请求返工 / 完成），不再摆一条平行的位移入口
          // （此前它恒等于「完成」，既与「下一步」的「完成」语义重复，又绕过评审门）。
          const target = nextColumnTarget(task, state.statuses);
          if (target.blocked) {
            button.disabled = true;
            button.title = target.reason;
          } else {
            button.addEventListener("click", (event) => {
              event.stopPropagation();
              void moveTask(task, target.status);
            });
          }
        } else {
          button.disabled = index < 0 || index + delta < 0;
          button.addEventListener("click", (event) => {
            event.stopPropagation();
            void moveTask(task, state.statuses[index + delta]);
          });
        }
        return button;
      };
      moveGroup.append(step(-1, "←", "移到上一列"), step(1, "→", "移到下一列"));
      const edit = mk("button", "ghost", "编辑");
      edit.type = "button";
      edit.addEventListener("click", (event) => {
        event.stopPropagation();
        openDialog(task);
      });
      footer.append(moveGroup, edit, foldAction(task), execActions(task));
      node.appendChild(footer);
      node.addEventListener("click", () => void openTaskDetail(task));
      return node;
    }

    // FR-88：折叠 / 取消折叠（只改 labels：不改状态、不删数据、不碰依赖边）
    function foldAction(task) {
      const archived = isArchived(task);
      const button = mk("button", "ghost", archived ? "取消折叠" : "折叠");
      button.type = "button";
      button.title = archived
        ? "取消折叠：把卡片放回默认视图（移除 archived 标签）"
        : "折叠（软归档）：打 archived 标签并默认隐藏；数据与历史保留，随时可取消";
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        const labels = (task.labels ?? []).filter((label) => label !== ARCHIVE_LABEL);
        if (!archived) labels.push(ARCHIVE_LABEL);
        try {
          await api("PATCH", `/api/tasks/${encodeURIComponent(task.identifier)}`, { version: task.version, labels });
          showBanner(archived ? `${task.identifier} 已取消折叠` : `${task.identifier} 已折叠（数据保留，可随时取消）`, "info");
          await loadTasks();
        } catch (error) {
          showBanner(`${archived ? "取消折叠" : "折叠"}失败：${error.message}${error.code ? `（${error.code}）` : ""}`, "error");
        }
      });
      return button;
    }

    /** 未归因的可开工卡：卡片上的主按钮是「去归因」而不是「启动执行」（后者必被归因门拒）。 */
    function attributeAction(task) {
      const button = mk("button", "primary", "去归因（关联需求条目）");
      button.type = "button";
      button.title = "本卡未归属需求条目：归因门会拦下「启动执行 / 派发团队」。点这里直接打开归因入口。";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        void openAttributionEntry(task);
      });
      return button;
    }

    /**
     * 待办池卡：主按钮是「授权开工（移出待办池）」，不是「启动执行」。
     * 口径来源＝`store.assertExecutable`：`backlog` 的任务一律 `EXECUTION_NOT_AUTHORIZED`
     * （「任务未授权开工：请先移出待办池」）—— 真实的门是**授权门**。此前卡面只有「→」箭头，
     * 真机第九报里用户据此以为"点了没反应"。授权后仍需人点「启动执行」或由团队/执行循环认领
     * （不自动开工：`backlog → todo` 只是放行，不是下发）。
     */
    function authorizeAction(task) {
      const button = mk("button", "primary", "授权开工（移出待办池）");
      button.type = "button";
      button.title = "本卡在「待办池」= 未授权开工，团队与执行循环都不会认领它。点这里移入「可开工」放行（不会自动下发）。";
      button.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (typeof window !== "undefined" && typeof window.confirm === "function"
          && !window.confirm(`把 ${task.identifier} 移出「待办池」→「可开工」？授权只是放行，仍需人点「启动执行」或由团队/执行循环认领。`)) return;
        const ok = await moveTask(task, "todo");
        if (ok) showBanner(`${task.identifier} 已授权开工（待办池 → 可开工）。下一步：点「启动执行」，或让它被团队/执行循环认领。`, "info");
      });
      return button;
    }

    function execActions(task) {
      const group = mk("div", "exec-group");
      const act = (label, suffix, body, confirmMessage) => {
        const button = mk("button", "ghost", label);
        button.type = "button";
        button.addEventListener("click", async (event) => {
          event.stopPropagation();
          // D2：客户端二次确认（启动执行会尝试新建/切换会话，可能切换主视图）
          if (confirmMessage && typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(confirmMessage)) return;
          try {
            const result = await api("POST", `/api/tasks/${encodeURIComponent(task.identifier)}${suffix}`, body);
            // FR-49：下发结果可见（会话绑定 / 降级原因）
            if (suffix === "/execute" && result?.launch) {
              const l = result.launch;
              showBanner(
                `已下发 ${task.identifier}：mode=${l.mode}${l.sessionId ? ` · 会话 ${String(l.sessionId).slice(0, 12)}` : ""}${l.reason ? ` · 降级原因 ${l.reason}` : ""}${sessionNameClause(l)}`,
                l.mode === "session" && l.titleApplied !== false ? "info" : "error",
              );
            }
            await loadTasks();
          } catch (error) {
            // 执行类失败走统一处置（见 handleExecutionFailure）；本 `act` 也承载其它动作（标记失败 / 提交待验收 …），
            // 那些仍用通用文案，不套执行门的措辞。
            if (suffix === "/execute") { await handleExecutionFailure(error, task.identifier, task); return; }
            showBanner(`${label}失败（${task.identifier}）：${error.message}${error.code ? `（${error.code}）` : ""}`, "error");
          }
        });
        return button;
      };
      // 2026-10-22：入口由 executionEntry 决定 —— 未归因的可开工卡不给「启动执行」（点了必被归因门拒）。
      const entry = executionEntry(task);
      if (entry === "start") group.appendChild(act("启动执行", "/execute", undefined, "启动执行会尝试新建/切换会话（可能切换主视图）。确认继续？"));
      else if (entry === "attribute") group.appendChild(attributeAction(task));
      else if (entry === "authorize") group.appendChild(authorizeAction(task));
      if (task.status === "in_progress") {
        group.append(act("标记失败", "/execution/fail", { evidence: "手动标记失败" }), act("提交待验收", "/execution/review"), act("释放归属", "/execution/release"));
      }
      if (task.status === "blocked") group.appendChild(act("重试", "/execution/retry"));
      return group;
    }

    function renderBoard() {
      board.replaceChildren();
      // FR-88：折叠卡默认不进列（数据仍在库里，只是不进默认视图）
      const visible = state.showArchived ? state.tasks : state.tasks.filter((task) => !isArchived(task));
      // FR-93（缺陷 F-05）：看板整体为空时，把"为什么不显示"讲清楚 ——
      // 全是折叠卡 / 被筛选挡掉，都不该只留一句「暂无任务」让人误判"这个项目没有任务"。
      // 口径优先用服务端 `GET /api/projects/:id/empty-state`（与 next-step 同一做法：
      // 前端是零依赖原生脚本、无法 import ESM，故由服务端把纯函数结果送下来）；
      // 未重载插件时该端点 404 → 用前端同口径降级算，绝不因此不渲染看板。
      const emptyState = state.emptyState ?? localEmptyState(visible);
      if (emptyState.empty) board.appendChild(emptyStateBanner(emptyState));
      const byStatus = new Map(state.statuses.map((status) => [status, []]));
      for (const task of visible) {
        if (!byStatus.has(task.status)) byStatus.set(task.status, []);
        byStatus.get(task.status).push(task);
      }
      for (const status of state.statuses) {
        const tasks = byStatus.get(status) ?? [];
        const column = mk("section", `board-column status-${status}`);
        const columnHeader = mk("div", "column-header");
        columnHeader.append(mk("span", "status-dot"), mk("h2", null, STATUS_LABELS[status] ?? status), mk("span", "column-count", String(tasks.length)));
        column.appendChild(columnHeader);
        const list = mk("div", "column-list");
        // FR-11：整列即落区。列内**空处**落下 = 追加到列尾（`before: null`）；落在某张卡上 = 插到它之前。
        wireColumnDrop(column, list, status);
        if (tasks.length === 0) {
          // FR-93：空列在"看板整体为空且有被隐藏的任务"时说真话，不再一律「暂无任务」。
          const hasHiddenElsewhere = emptyState.empty && emptyState.hiddenTotal > 0;
          list.appendChild(mk("div", "empty-column", hasHiddenElsewhere ? "— 任务在别处 —" : "暂无任务"));
        }
        else for (const task of tasks) list.appendChild(card(task));
        column.appendChild(list);
        board.appendChild(column);
      }
      const archivedCount = state.tasks.filter(isArchived).length;
      // FR-93：摘要行在"看板空但确有被隐藏的任务"时点明去向，避免与工具栏计数一样被忽略。
      const hiddenNote =
        emptyState.empty && emptyState.hiddenTotal > 0 ? ` · ⚠ ${emptyState.hiddenTotal} 个未显示（${emptyState.hints.map((h) => h.split("·")[0].trim()).join(" + ")}）` : "";
      summary.textContent = `共 ${state.tasks.length} 个任务 · 显示 ${visible.length}${archivedCount > 0 ? `（已折叠 ${archivedCount}）` : ""}${hiddenNote} · 项目 ${state.projectId || "-"}`;
    }

    // FR-93（缺陷 F-05）：看板空态引导横幅 —— 置顶、在列之上，一眼说清「任务还在、只是没显示」。
    // 只给出口（点既有控件），**不自动改用户的筛选/折叠开关**。
    function emptyStateBanner(es) {
      const box = mk("div", "empty-guide");
      box.setAttribute("role", "status");
      box.appendChild(mk("div", "empty-guide-title", es.message));
      if (es.hints.length === 0) {
        box.appendChild(mk("div", "empty-guide-hint", "用工具栏「新建任务」或从需求条目生成任务。"));
      } else {
        for (const hint of es.hints) box.appendChild(mk("div", "empty-guide-hint", `· ${hint}`));
      }
      const actions = mk("div", "empty-guide-actions");
      // 折叠出口：复用工具栏那个开关，避免出现第二个语义相同的按钮
      if (es.archivedCount > 0) {
        const expand = mk("button", "ghost", `显示已折叠（${es.archivedCount}）`);
        expand.type = "button";
        expand.title = "折叠（软归档）的卡片默认不入列；展开后数据与历史都在";
        expand.addEventListener("click", async () => {
          state.showArchived = true;
          // 用产品自己的 loadTasks 重载：顺带刷新服务端空态口径与工具栏计数
          await loadTasks();
          showBanner(`已展开 ${es.archivedCount} 个折叠卡片`, "info");
        });
        actions.appendChild(expand);
      }
      // 筛选出口：清空优先级/标签/会话归属下拉 + 搜索框（不清 archived —— 那是折叠开关，不是筛选）
      if (es.filteredCount > 0) {
        const clear = mk("button", "ghost", "清空筛选条件");
        clear.type = "button";
        clear.title = "清掉优先级 / 标签 / 会话归属筛选与搜索关键词，恢复显示本项目全部任务";
        clear.addEventListener("click", async () => {
          state.priority = "";
          state.label = "";
          state.sessionScope = "";
          state.keyword = "";
          keywordInput.value = "";
          fillSelect(priorityFilter, state.priorities.map((v) => [v, PRIORITY_LABELS[v] ?? v]), "", "全部优先级");
          fillSelect(labelFilter, labelOptions(), "", "全部标签");
          fillSelect(sessionFilter, sessionScopeOptions(), "", "全部（不限会话归属）");
          await loadTasks();
          showBanner("已清空筛选条件", "info");
        });
        actions.appendChild(clear);
      }
      if (actions.childElementCount > 0) box.appendChild(actions);
      return box;
    }

    function renderControls() {
      try { loopToggle.textContent = state.loop?.enabled ? "定时执行：开" : "定时执行：关"; } catch (_) { /* ignore */ }
      // FR-88：折叠计数与开关（0 张时按钮不占地方）
      try {
        const archivedCount = state.tasks.filter(isArchived).length;
        archivedToggle.textContent = state.showArchived ? `隐藏已折叠（${archivedCount}）` : `显示已折叠（${archivedCount}）`;
        archivedToggle.hidden = archivedCount === 0;
      } catch (_) { /* ignore */ }
      // FR-75/76：执行看护计数
      try {
        const stalled = state.tasks.filter((t) => t.watchdog?.state === "stalled").length;
        const pending = state.tasks.filter((t) => t.watchdog?.state === "awaiting-decision").length;
        const triage = state.tasks.filter((t) => t.status === "blocked" && (t.triageAt || (t.labels || []).includes("triage"))).length;
        // FR-79：诊断计数（八类规则命中数；高危单独列出）
        const diagnosed = state.tasks.filter((t) => t.diagnostics?.count > 0);
        const highDiag = diagnosed.filter((t) => t.diagnostics.highestSeverity === "high").length;
        // FR-83：评审队列（待验收）
        const reviewing = state.tasks.filter((t) => t.status === "in_review").length;
        const rework = state.tasks.filter((t) => t.reviewState === "changes_requested" && t.status !== "done").length;
        // FR-85：人工校验队列（待结论 —— 结论给出前被它挡住的下游一律不推进）
        const hrPending = state.tasks.filter(isHumanReviewPending).length;
        wdNotice.hidden = stalled + pending + triage + diagnosed.length + reviewing + rework + hrPending === 0;
        wdNotice.textContent = `⚠ 执行看护：停滞 ${stalled} · 待决策 ${pending}${triage ? ` · 人工兜底 ${triage}` : ""}${diagnosed.length ? ` · 诊断 ${diagnosed.length} 项${highDiag ? `（高危 ${highDiag}）` : ""}` : ""}${reviewing ? ` · 待评审 ${reviewing}` : ""}${rework ? ` · 返工中 ${rework}` : ""}${hrPending ? ` · 待人工校验 ${hrPending}` : ""}`;
        wdNotice.className = stalled + triage + highDiag + hrPending > 0 ? "ghost watchdog-note" : "ghost";
      } catch (_) { /* ignore */ }
      const projectEntries = state.projects.map((project) => [project.id, `${project.name}（${project.id}）`]);
      if (projectEntries.length === 0) projectEntries.push(["", "（暂无项目）"]);
      fillSelect(projectSelect, projectEntries, state.projectId);
      fillSelect(priorityFilter, state.priorities.map((v) => [v, PRIORITY_LABELS[v] ?? v]), state.priority, "全部优先级");
      fillSelect(labelFilter, labelOptions(), state.label, "全部标签");
      fillSelect(sessionFilter, sessionScopeOptions(), state.sessionScope, "全部（不限会话归属）");
      // FR-14：搜索框与 state 同步（「清空筛选条件」等外部复位后，输入框不得停在旧词上）
      if (keywordInput.value !== state.keyword) keywordInput.value = state.keyword;
      renderSessionScopeNote(); // FR-28：降级提示随每次渲染刷新（无会话 / 服务端未加载本档）
    }

    // FR-26 / FR-28：会话归属下拉项（与 store 的 sessionScope 取值同口径）。
    // 四档：全部（占位项）/ 仅本会话（会话内有，FR-28）/ 已关联 / 未关联（FR-26）。
    function sessionScopeOptions() {
      const options = [];
      // FR-28：「仅本会话」只在拿得到当前会话标识时提供 —— 否则无从收敛，给一个点了也没用的档位。
      if (sessionId) options.push([`${SESSION_SCOPE_CURRENT_PREFIX}${sessionId}`, `仅本会话（${shortSessionId(sessionId)}）`]);
      options.push(["linked", SESSION_SCOPE_LABELS.linked], ["unlinked", SESSION_SCOPE_LABELS.unlinked]);
      return options;
    }

    // FR-93：前端同口径降级（服务端端点未加载时用）。
    // 与 src/core/empty-state.mjs 的 deriveEmptyState 保持同一口径 —— **字段形状与文案逐字一致**，
    // 由 tests/empty-state.test.mjs 的「防漂移」用例钉住（形状键 + 按数字切开的静态文案片段）。
    // 两份实现漂移过一次的代价已经见过：端点漏按筛选取数 ⇒ 引导整块消失（2026-10-22 续二十四修复）。
    function localEmptyState(visible) {
      const priority = (state.priority ?? "").trim();
      const label = (state.label ?? "").trim();
      // FR-26：会话归属维度（linked / unlinked）非空即算筛选中
      const sessionScope = (state.sessionScope ?? "").trim();
      // FR-14：搜索关键词同样算"筛选中"（与 src/core/empty-state.mjs 的 hasActiveFilter 同口径）
      const keyword = (state.keyword ?? "").trim();
      const filtering = Boolean(priority || (label && label !== ARCHIVE_LABEL) || sessionScope || keyword);
      if (visible.length > 0) return { empty: false, kind: "no-tasks", hiddenTotal: 0, archivedCount: 0, filteredCount: 0, message: "", hints: [], reasons: [] };
      const archivedHidden = state.showArchived ? [] : state.tasks.filter(isArchived);
      const hiddenArchived = new Set(archivedHidden);
      const filteredHidden = state.tasks.filter((task) => !hiddenArchived.has(task));
      const archivedCount = archivedHidden.length;
      const filteredCount = filteredHidden.length;
      const hiddenTotal = archivedCount + filteredCount;
      if (state.tasks.length === 0) {
        if (keyword) return { empty: true, kind: "no-tasks", hiddenTotal: 0, archivedCount: 0, filteredCount: 0, message: `没有匹配「${keyword}」的任务`, hints: ["换个关键词，或清空搜索后重试"], reasons: [] };
        return { empty: true, kind: "no-tasks", hiddenTotal: 0, archivedCount: 0, filteredCount: 0, message: filtering ? "当前筛选下没有任务" : "本项目暂无任务", hints: filtering ? ["清空筛选条件后重试"] : [], reasons: [] };
      }
      const reasons = [];
      if (archivedCount > 0) reasons.push({ reason: "archived", count: archivedCount, hint: `${archivedCount} 个已折叠（软归档）· 点工具栏「显示已折叠（${archivedCount}）」展开；数据与历史都在，可随时取消` });
      if (filteredCount > 0) {
        const parts = [];
        if (priority) parts.push(`优先级=${priority}`);
        if (label && label !== ARCHIVE_LABEL) parts.push(`标签=${label}`);
        if (sessionScope) parts.push(`会话归属=${formatSessionScope(sessionScope)}`);
        if (keyword) parts.push(`关键词=${keyword}`);
        const cond = parts.length > 0 ? parts.join(" · ") : "当前筛选";
        reasons.push({ reason: "filtered", count: filteredCount, hint: `${filteredCount} 个不在当前筛选/口径内（${cond}）· 清空筛选条件即可看到` });
      }
      const kind = archivedCount > 0 && filteredCount > 0 ? "filtered-and-archived" : archivedCount > 0 ? "archived" : "filtered-out";
      return { empty: true, kind, hiddenTotal, archivedCount, filteredCount, message: `看板为空：本项目还有 ${hiddenTotal} 个任务未显示在此`, hints: reasons.map((item) => item.hint), reasons };
    }

    // FR-88：`archived` 是折叠开关的载体，不作为用户标签出现在筛选下拉里。
    // FR-93：抽成函数，让「清空筛选」出口与工具栏下拉用同一份口径，不会各算各的。
    function labelOptions() {
      const labels = [...new Set(state.tasks.flatMap((task) => task.labels ?? []))].filter((label) => label !== ARCHIVE_LABEL).sort();
      return labels.map((v) => [v, v]);
    }

    function fillDialogSelects(task) {
      fillSelect(fStatus, state.statuses.map((v) => [v, STATUS_LABELS[v] ?? v]), task?.status ?? state.statuses[0] ?? "");
      fillSelect(fPriority, state.priorities.map((v) => [v, PRIORITY_LABELS[v] ?? v]), task?.priority ?? "none");
      const owners = [...new Set([...Object.keys(OWNER_LABELS), ...state.tasks.map(ownerOf).filter(Boolean)])].sort();
      fillSelect(fOwner, owners.map((v) => [v, OWNER_LABELS[v] ?? v]), task ? ownerOf(task) : "", "（未指派）");
    }

    /**
     * 需求条目下拉：新建时按本项目条目补齐（值＝条目 uuid，服务端建卡事务内直接归因）；
     * 编辑时只回显当前绑定并禁用（改绑走抽屉，口径见 `POST /api/tasks/:ref/attribution`）。
     * 条目取不到就只留「不归因」一项 —— 不阻断建卡，也不假装已归因。
     */
    async function fillRequirementOptions(task) {
      const SKIP = ["", "（不归因 —— 执行/派发会被归因门拦下）"];
      if (task) {
        fRequirement.disabled = true;
        fillSelect(fRequirement, [[task.requirementId ?? "", task.requirementId ? "（保持现有归因；改绑请用抽屉）" : "（未归因）"]], task.requirementId ?? "");
        return;
      }
      fRequirement.disabled = false;
      fillSelect(fRequirement, [SKIP], "");
      try {
        const payload = await api("GET", `/api/requirements/items?project=${encodeURIComponent(state.projectId)}`);
        if (editing) return; // 取数期间已改成编辑态 ⇒ 本次填充作废
        const items = payload?.items ?? [];
        fillSelect(fRequirement, [SKIP, ...items.map((it) => [it.id, `${it.identifier} · ${it.title ?? ""}`.trim()])], "");
      } catch { /* 条目取不到：保持「不归因」一项，不阻断建卡 */ }
    }

    async function loadTasks() {
      const params = new URLSearchParams();
      if (state.projectId) params.set("project", state.projectId);
      if (state.priority) params.set("priority", state.priority);
      if (state.label) params.set("label", state.label);
      if (state.sessionScope) params.set("sessionScope", state.sessionScope); // FR-26 / FR-28 会话归属
      if (state.keyword.trim()) params.set("q", state.keyword.trim()); // FR-14 搜索（清空即不传 ⇒ 全量）
      params.set("withWatchdog", "1"); // FR-75/76 看护标记 + FR-79 诊断摘要
      const query = params.toString();
      let payload;
      // FR-28：前端由宿主**实时读盘托管**（⌘R 即生效），服务端却要重载才认新档 —— 两者会短暂不同步。
      // 旧服务端遇到 `session:<id>` 会如实 `INVALID_FIELD`；若照抛，**整块看板会空白**（比降级更糟）。
      // 处置＝降级**但不静默**：退回「全部」重取，并让工具栏明写「服务端未加载本档（需重载插件）」。
      const wantsCurrentScope = String(state.sessionScope ?? "").startsWith(SESSION_SCOPE_CURRENT_PREFIX);
      let degraded = false;
      try {
        payload = await api("GET", `/api/tasks${query ? `?${query}` : ""}`);
      } catch (error) {
        if (!(error?.code === "INVALID_FIELD" && wantsCurrentScope)) throw error;
        degraded = true;
        state.sessionScope = "";
        const retry = new URLSearchParams(params);
        retry.delete("sessionScope");
        payload = await api("GET", `/api/tasks${retry.toString() ? `?${retry}` : ""}`);
      }
      if (destroyed) return;
      // 只有「本次是新档取数且没走降级」才算服务端已认本档（重载后无需刷新页面即可自动恢复）
      if (wantsCurrentScope && !degraded) state.sessionScopeUnsupported = false;
      else if (degraded) state.sessionScopeUnsupported = true;
      state.tasks = payload.tasks;
      // FR-93：取服务端空态口径（只读；端点未加载时为 null → 前端用同口径降级，不影响看板渲染）
      await loadEmptyState();
      if (destroyed) return;
      renderBoard();
      renderControls();
    }

    /**
     * 「先同步、再措辞」（真机 2026-10-22 续二十四）：执行类失败的提示必须基于**服务端真值**。
     * 服务端的门（归因门 / 授权门）只按真值拒绝，而常驻面板可能停在数小时前的看板快照 ——
     * 真机取证：页面上「可开工」的三张卡其实早已归因，点「启动执行」仍弹「请先关联需求条目（归因门）」，
     * 而抽屉按**新鲜**数据渲染成「已归因 … 改绑需求条目」⇒ 提示与事实自相矛盾，用户判定「点了也没用」。
     * 处置：失败后先 `loadTasks()` 取回真值，再决定措辞与是否给归因入口；任务不在当前列表
     * （被筛选 / 折叠藏起）时如实返回 null，调用方按旧路径兜底。
     * 真机 2026-10-22（续三十二）：同步**本身失败**（取数报错）与「同步成功但卡不在当前视图」是两回事 ——
     * 前者若沿用上一轮快照去措辞，就会拿过期数据指路（正是「归因门」误报的复现路径），故返回值带上
     * `synced` 标志：调用方在同步失败时**不得**给出任何基于旧快照的动作引导，只如实说「同步失败 + 点刷新」。
     */
    async function resyncTasks(identifier) {
      let synced = true;
      try { await loadTasks(); } catch { synced = false; /* 同步失败不阻断报错提示，但必须如实上报 */ }
      const task = (state.tasks ?? []).find((x) => x.identifier === identifier) ?? null;
      return { synced, task };
    }

    /**
     * 打开某张卡的「归因（关联需求条目）」入口并高亮（**唯一实现**）。
     * 两条调用路径：① 卡片/抽屉上的「去归因」主按钮（未归因的可开工卡）；② 执行被门拦下后的兜底引导。
     * 任何一步失败都不抛 —— 归因入口打不开不该把面板弄崩。
     */
    async function openAttributionEntry(task) {
      try { await openTaskDetail(task); } catch { /* 打开失败不阻断（下面按现有抽屉找区块） */ }
      try {
        const attrBox = drawerBody?.querySelector?.(".attr-box");
        attrBox?.classList.add("attention");
        attrBox?.scrollIntoView({ block: "start" });
      } catch { /* ignore */ }
    }

    /**
     * 「启动执行」失败的**统一处置**（三条入口共用：卡片 / 抽屉操作区 / 下一步面板）。
     * 缺口来源（真机 2026-10-22 三报同一现象）：卡片与抽屉两条入口早已「先同步真值、再措辞」，
     * 而下一步面板的动作 `start-execution` 仍是裸 `catch` —— 同一次失败换条路进来，提示就退回
     * 「请先关联需求条目（归因门）」而没有归因入口的旧说法（用户的原话引用正是这条卡片级文案）。
     * 处置：把「同步真值 → 按真值分档措辞 → 需要时打开并高亮归因入口」收成一处，三处调用同一份，
     * 免得下次再修一处漏两处（口径见 resyncTasks 的注释）。
     */
    async function handleExecutionFailure(error, ref, task, label = "启动执行") {
      // 真机 2026-10-22（第九报）：横幅此前**不带任务编号**，用户说「三张卡都报」时无从定位是哪几张，
      // 一轮取证要先猜卡再核对（第九报就是这么烧掉的）。编号 + 服务端真值一起报，下次一眼可查。
      const who = task?.identifier ?? ref ?? "该任务";
      const { synced, task: fresh } = await resyncTasks(task?.identifier ?? ref);
      // 已有执行会话在执行中：不是失败，是"已停止再次下发"的提醒。
      if (error.code === "EXECUTION_ALREADY_RUNNING") { showBanner(`已停止再次下发（${who}）：${error.message}`, "error"); return; }
      if (error.code === "EXECUTION_NOT_ATTRIBUTED") {
        // 同步失败：手里的还是旧快照，**不能**照它给任何动作引导（否则就是拿过期数据显示「未归因」，
        // 把人指去一个真值里根本不存在的动作）。如实说清并给出唯一可靠动作：工具栏「刷新」。
        if (!synced) { showBanner(`${label}失败（${who}）：${error.message} —— 重新同步看板失败，本条提示基于页面旧快照、可能已过期；请先点工具栏「刷新」再试。`, "error"); return; }
        // 同步本身没拿到真值（取数失败 / 本卡被当前筛选或折叠藏起）⇒ **不能**指人去"再归因一次"，
        // 如实说清「同步没成功」并给出可执行的下一步（工具栏「刷新」）。
        if (!fresh) { showBanner(`${label}失败（${who}）：${error.message} —— 已尝试同步最新状态，但本卡不在当前视图（可能被筛选或折叠藏起）；请先点工具栏「刷新」再试。`, "error"); return; }
        // 真机 2026-10-22（**第十四报**，用户复投第九报同一句）：门序列是**归因门先于状态门**
        // （`store.assertExecutable`），所以一张**早已收口/取消**的旧卡被拒时，吐出来的也是「未归属需求条目」。
        // 旧页签里它还在「可开工」列上 —— 照提示去归因，那条路**永远启动不了**（状态门接着拒）。
        // 只有「真值仍未归因」**且**「真值状态本身可启动」时才把归因入口摆到人面前；
        // 否则先说实话：卡已经不在可开工，本次失败来自页面旧快照（看板随后自动同步）。
        if (label === "启动执行" && fresh.status !== "todo" && fresh.status !== "backlog") {
          showBanner(`${label}失败（${who}）：本卡当前为「${STATUS_LABELS[fresh.status] ?? fresh.status}」，不是「可开工」，不可启动执行（本次失败来自页面旧快照，已同步最新状态）。请刷新页面（⌘R）后再操作。`, "error");
          return;
        }
        // FR-40 补口：真值确实未归因 → 不只报错，直接把抽屉开到「归因」入口并高亮。
        if (!fresh.requirementId) {
          showBanner(`${label}失败（${who}）：${error.message} —— 已打开该任务的「归因（关联需求条目）」入口，选一条关联后即可启动。`, "error");
          await openAttributionEntry(fresh);
          return;
        }
        // 真值已归因 ⇒ 本次失败源自页面旧快照，不能再把人指去"再归因一次"。
        showBanner(`${label}失败（${who}）：${error.message} —— 已同步最新状态：本卡现在已归因，可直接再点「${label}」（本次失败来自页面旧快照）。`, "error");
        return;
      }
      if (error.code === "EXECUTION_NOT_AUTHORIZED") {
        // 授权门：按同步后的**真值状态**说明，不让人对着旧状态的卡片猜；同步失败/拿不到真值就如实说清并指路
        // （同步失败时**不得**拿旧快照的状态去措辞，否则真值可能早已是别的列）。
        showBanner(synced && fresh
          ? `${label}失败（${who}）：${error.message} —— 已同步最新状态：本卡当前为「${STATUS_LABELS[fresh.status] ?? fresh.status}」。`
          : `${label}失败（${who}）：${error.message} —— ${synced ? "已尝试同步最新状态但未取回本卡（可能被筛选或折叠藏起）" : "重新同步看板失败，本条提示基于页面旧快照、可能已过期"}；请先点工具栏「刷新」再试。`, "error");
        return;
      }
      showBanner(`${label}失败（${who}）：${error.message}${error.code ? `（${error.code}）` : ""}`, "error");
    }

    // FR-93：只读取空态引导口径。失败一律降级（不阻塞看板）。
    async function loadEmptyState() {
      if (!state.projectId) { state.emptyState = null; return; }
      const params = new URLSearchParams();
      if (state.showArchived) params.set("showArchived", "1");
      if (state.priority) params.set("priority", state.priority);
      if (state.label) params.set("label", state.label);
      if (state.sessionScope) params.set("sessionScope", state.sessionScope); // FR-26 会话归属
      if (state.keyword.trim()) params.set("q", state.keyword.trim()); // FR-14 搜索：空态口径必须与列表取数同源
      const qs = params.toString();
      try {
        const payload = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/empty-state${qs ? `?${qs}` : ""}`);
        state.emptyState = payload?.emptyState ?? null;
      } catch (_) {
        state.emptyState = null; // 端点未加载（重载插件后生效）→ 前端降级口径
      }
    }

    async function bootstrap() {
      // 先读能力位再渲染：否则首屏会先画出"能点"的按钮、几百毫秒后再置灰（闪一下更困惑）。
      try { const h = await api("GET", "/api/health"); state.host = h?.host ?? null; } catch { state.host = null; }
      renderHostNotice();
      const meta = await api("GET", "/api/meta");
      state.statuses = meta.statuses;
      state.priorities = meta.priorities;
      // FR-60：会话/工作区 → 项目（并把项目绑定到"初始会话"）
      const ctxParams = new URLSearchParams();
      if (cwd) ctxParams.set("cwd", cwd);
      if (sessionId) ctxParams.set("session", sessionId);
      const ctx = await api("GET", `/api/context${ctxParams.toString() ? `?${ctxParams}` : ""}`).catch(() => null);
      const projects = await api("GET", "/api/projects");
      if (destroyed) return;
      state.projects = projects.projects;
      state.projectId = ctx?.project?.id ?? projects.projects[0]?.id ?? "";
      state.context = ctx;
      try { const st = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/settings`); state.loop = st.loop ?? {}; } catch { state.loop = {}; }
      // FR-63（扩展到所有视图）：解析"本会话×本项目"绑定态，未绑定则全视图显示关联门
      await resolveBinding(state.projectId);
      renderCurrentView();
      hideBanner();
    }
    // 会话×项目 绑定态解析（FR-63 → 全视图生效）
    async function resolveBinding(projectId) {
      if (!sessionId) { state.binding = { projectId, bound: true, mainSessionId: null, association: null }; return; }
      try {
        const c = await api("GET", `/api/context?session=${encodeURIComponent(sessionId)}&project=${encodeURIComponent(projectId)}`);
        state.binding = { projectId, bound: c.sessionBound !== false, mainSessionId: c.mainSessionId ?? null, association: c.association ?? null, sessionOrigin: c.sessionOrigin ?? null };
      } catch { state.binding = { projectId, bound: true, mainSessionId: null, association: null }; }
    }
    const isBlocked = () => Boolean(sessionId) && state.binding.projectId === state.projectId && state.binding.bound === false;
    function hideGate() { gateScroll.hidden = true; }
    async function showBlockedGate() {
      boardScroll.hidden = true; reqScroll.hidden = true; teamScroll.hidden = true; configScroll.hidden = true; gateScroll.hidden = false;
      gateRoot.replaceChildren(mk("p", "hint", "加载…"));
      let projects = state.projects;
      try { projects = (await api("GET", "/api/projects")).projects; state.projects = projects; } catch { /* ignore */ }
      const wrap = mk("div", "drawer-section");
      wrap.style.maxWidth = "640px";
      wrap.style.margin = "32px auto";
      wrap.appendChild(mk("h2", null, "当前会话未绑定该项目的工作台"));
      // 门内可切换项目
      const sel = mk("select");
      for (const p of projects) { const o = mk("option"); o.value = p.id; o.textContent = `${p.name}（${p.id}）`; sel.appendChild(o); }
      if (projects.some((p) => p.id === state.projectId)) sel.value = state.projectId;
      sel.addEventListener("change", () => { state.projectId = sel.value; state.loop = {}; void (async () => { await resolveBinding(state.projectId); renderCurrentView(); })(); });
      const selRow = mk("div", "config-row");
      selRow.appendChild(mk("span", null, "项目"));
      const selRight = mk("span", "config-actions");
      selRight.appendChild(sel);
      selRow.appendChild(selRight);
      wrap.appendChild(selRow);
      const proj = projects.find((p) => p.id === state.projectId);
      wrap.appendChild(mk("p", "hint", `项目「${proj?.name ?? state.projectId}」${state.binding.mainSessionId ? `已有主会话（${String(state.binding.mainSessionId).slice(0, 12)}…）` : "尚无主会话"}。本会话${state.binding.association === "pending" ? "已提交申请，等待批准" : "尚未与之关联"}，默认不显示数据。`));
      // 2026-10-19（续三十七·FR-63 门页死胡同修复）：批准入口只在「配置」页，而门把四个视图**全挡了**
      // （见 showBlockedGate 顶部的 hidden 赋值），association=pending 的会话因此既进不去配置页、
      // 门页又不告诉它「谁去批准、在哪批准」—— 用户唯一能做的就是反复点「重新申请」。
      // 这里把出路**讲清楚并给出可复制的标识**；不放开配置视图（那等于让待批准会话自助批准，违背 FR-63）。
      const gateMainId = state.binding.mainSessionId ? String(state.binding.mainSessionId) : null;
      wrap.appendChild(mk("p", "hint", gateMainId
        ? `批准只能在主会话侧完成：打开主会话 ${gateMainId.slice(0, 18)}… → 本面板「配置」→「会话关联（主会话批准）」→ 点「批准」。在侧栏认不出它时，用下面的按钮复制标识去逐一核对。`
        : "本项目尚无主会话：先点「申请关联」，或点「新建项目（绑定本会话）」把本会话设为主会话；之后本会话即可直接加载本工作台。"));
      const bar = mk("div", "btn-row");
      bar.append(
        btn(state.binding.association === "pending" ? "重新申请关联" : "申请关联", async () => { try { await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/sessions/request`, { sessionId }); showBanner("已提交关联申请，等待主会话批准", "info"); await resolveBinding(state.projectId); renderCurrentView(); } catch (e) { showBanner(`申请失败：${e.message}`, "error"); } }, "primary"),
        btn("新建项目（绑定本会话）", async () => {
          const name = window.prompt("新项目名称（将据此生成项目 id）"); if (!name) return;
          const ws = window.prompt("项目工作目录（绝对路径，可留空）");
          try {
            const r = await api("POST", "/api/projects", { name, workspacePath: ws && ws.trim() ? ws.trim() : null });
            state.projectId = r.project.id;
            state.projects = [r.project, ...projects.filter((p) => p.id !== r.project.id)];
            await resolveBinding(state.projectId); // 新项目无主会话 → 本会话成为主会话
            showBanner(`已新建项目 ${r.project.id}，并绑定本会话为主会话`, "info");
            renderCurrentView();
          } catch (e) { showBanner(`新建失败：${e.message}`, "error"); }
        }),
        btn("刷新", () => { void (async () => { await resolveBinding(state.projectId); renderCurrentView(); })(); }),
      );
      if (gateMainId) bar.appendChild(btn("复制主会话标识", () => { void copyText(gateMainId).then((ok) => showBanner(ok ? `已复制主会话标识：${gateMainId}` : `复制失败：浏览器拒绝了剪贴板写入 —— 请手动复制（主会话 ${gateMainId}）`, ok ? "info" : "error")); }));
      if (sessionId) bar.appendChild(btn("复制本会话标识", () => { void copyText(sessionId).then((ok) => showBanner(ok ? `已复制本会话标识：${sessionId}` : `复制失败：浏览器拒绝了剪贴板写入 —— 请手动复制（本会话 ${sessionId}）`, ok ? "info" : "error")); }));
      wrap.appendChild(bar);
      gateRoot.replaceChildren(wrap);
      summary.textContent = "未绑定 · 可申请关联 / 新建项目";
    }
    // ------------------------------------------- 推进清单 / 待确认记忆（FR-99 / FR-100 · 2026-10-28 实装）
    // 口径：清单是**纯投影**（服务端每次现算，同状态字节级一致），本视图只负责「给人看见 + 点一下」。
    // 红线：`accept` 类的「完成」**只能人点** —— 这里提交时 `actor` 固定 `"human"`（确实是人在点），
    //       服务端仍二次校验（机器调用一律 409 `HUMAN_CONFIRM_REQUIRED`）。
    const ADVANCE_KIND_LABEL = { decide: "待人定", blocked: "受阻", review: "待评审", accept: "待收口", dispatch: "可开工" };
    const ADVANCE_ACTION_LABEL = { complete: "完成（人工确认）", approve: "评审通过", changes: "返工", retry: "重试", attribute: "去补归因", choose: "给结论", dispatch: "去派发" };

    async function renderAdvance() {
      if (!state.projectId) { advanceRoot.replaceChildren(mk("p", "hint", "先在上方选择一个项目")); return; }
      advanceRoot.replaceChildren(mk("p", "hint", "加载推进清单…"));
      const q = encodeURIComponent(state.projectId);
      let list = null;
      let mem = null;
      try {
        list = await api("GET", `/api/projects/${q}/advance?format=block`);
        mem = await api("GET", `/api/projects/${q}/memory?includeProposed=1`).catch(() => ({ entries: [], recall: { count: 0 } }));
      } catch (e) {
        advanceRoot.replaceChildren(mk("p", "hint", `推进清单加载失败：${e.message}${e.code ? `（${e.code}）` : ""}`));
        return;
      }
      const wrap = mk("div", "advance-view");

      /** 一条决定回写（幂等由服务端保证：重复点只会重放，不会二次副作用）。 */
      const decide = async (item, choice, note = null) => {
        try {
          const r = await api("POST", `/api/projects/${q}/advance/${encodeURIComponent(item.id)}/decide`, { choice, note, actor: "human" });
          showBanner(`已处理 #${item.taskRef}（${choice}）${r?.replay ? " · 幂等重放（此前已生效）" : ""} · 剩余 ${r?.remaining ?? "?"} 项`, "info");
          void loadTasks();
          await renderAdvance();
        } catch (e) {
          showBanner(`处理失败：${e.message}${e.code ? `（${e.code}）` : ""}`, "error");
        }
      };

      const rowActions = (item) => {
        const box = mk("div", "advance-actions");
        for (const action of (item.actions ?? [])) {
          box.appendChild(btn(ADVANCE_ACTION_LABEL[action.code] ?? action.code, () => {
            if (action.code === "complete") { void decide(item, "complete"); return; }
            if (action.code === "approve") { void decide(item, "approve"); return; }
            if (action.code === "retry") { void decide(item, "retry"); return; }
            if (action.code === "changes") {
              const note = window.prompt(`#${item.taskRef} 返工说明（会写进事件流）`, "") ?? null;
              if (note === null) return;
              void decide(item, "changes", note);
              return;
            }
            if (action.code === "choose") {
              const conclusion = window.prompt(`#${item.taskRef} 的结论（一句话）`, "") ?? null;
              if (conclusion === null || !conclusion.trim()) return;
              void decide(item, conclusion.trim(), item.why);
              return;
            }
            // attribute / dispatch：不在本页代做，指回既有入口（不造第二条写路径）
            setView(action.code === "attribute" ? "req" : "board");
            showBanner(action.code === "attribute"
              ? `#${item.taskRef} 需补需求条目：在需求页挂上条目后，清单会把它从「受阻」移到「可开工」`
              : `#${item.taskRef} 请在看板上点「启动执行 / 派发团队」`, "info");
          }, action.code === "complete" ? "primary" : "ghost"));
        }
        return box;
      };

      const p1 = panelEl(`推进清单 · ${list.count} 项`,
        btn("刷新", () => void renderAdvance()),
        hostBtn("投给主会话", async () => {
          try {
            const r = await api("POST", `/api/projects/${q}/advance/announce`, {});
            showBanner(r?.delivered
              ? `已投给主会话（${r.sessionId}）：${r.items} 项待办 + ${r.memory} 条记忆，一段装载块`
              : `投递失败：${r?.reason ?? "宿主会话通道不可用"}（清单仍可在此页直接处理）`, r?.delivered ? "info" : "error");
          } catch (e) { showBanner(`投递失败：${e.message}${e.code ? `（${e.code}）` : ""}`, "error"); }
        }, "primary"));
      if (list.count === 0) {
        p1.body.appendChild(mk("p", "hint empty-hint", "当前无待办：没有可派发的卡，也没有等人决定的卡。"));
      } else {
        const tally = Object.entries(list.counts ?? {}).filter(([, n]) => n > 0).map(([k, n]) => `${ADVANCE_KIND_LABEL[k] ?? k} ${n}`).join(" · ");
        p1.body.appendChild(mk("p", "hint", `${tally}（排序：先解锁再推进）`));
        const rows = mk("div", "advance-rows");
        for (const item of list.items) {
          const row = mk("div", "advance-row");
          row.dataset.kind = item.kind;
          row.dataset.taskRef = item.taskRef;
          row.appendChild(mk("span", `advance-kind k-${item.kind}`, ADVANCE_KIND_LABEL[item.kind] ?? item.kind));
          const mid = mk("div", "advance-mid");
          const titleLine = mk("div", "advance-title");
          titleLine.append(mk("span", "advance-ref mono", `#${item.taskRef}`), mk("span", null, item.title));
          mid.append(titleLine, mk("div", "advance-why", item.why));
          row.appendChild(mid);
          row.appendChild(rowActions(item));
          rows.appendChild(row);
        }
        p1.body.appendChild(rows);
      }
      wrap.appendChild(p1.panel);

      // 面板 2：待确认记忆（D-M2：agent 只能 propose，人 accept 后才进召回）
      const entries = mem?.entries ?? [];
      const proposed = entries.filter((e) => e.confidence === "proposed");
      const accepted = entries.filter((e) => e.confidence === "accepted");
      const p2 = panelEl(`待确认记忆 · ${proposed.length} 条`,
        btn("刷新", () => void renderAdvance()));
      p2.body.appendChild(mk("p", "hint", `已确认可召回 ${mem?.recall?.count ?? 0} 条 · 待确认 ${proposed.length} 条 · 召回预算 6 条 / 3000 字（超出的不会进装载块）`));
      if (!proposed.length) {
        p2.body.appendChild(mk("p", "hint empty-hint", "没有待确认记忆。agent 提议的结论会出现在这里，确认后才会被下一轮装载块召回。"));
      } else {
        const rows = mk("div", "advance-rows");
        for (const entry of proposed) {
          const row = mk("div", "advance-row");
          row.dataset.kind = "memory";
          row.dataset.memoryId = entry.id;
          row.appendChild(mk("span", `advance-kind k-mem`, entry.kind));
          const mid = mk("div", "advance-mid");
          mid.append(mk("div", "advance-title", entry.title), mk("div", "advance-why mono", `${entry.provenance} · ${entry.id}`));
          row.appendChild(mid);
          const actions = mk("div", "advance-actions");
          actions.appendChild(btn("确认入库", async () => {
            try {
              await api("POST", `/api/projects/${q}/memory/${encodeURIComponent(entry.id)}/accept`, { actor: "human" });
              showBanner(`已确认记忆：${entry.title}`, "info");
              await renderAdvance();
            } catch (e) { showBanner(`确认失败：${e.message}`, "error"); }
          }, "primary"));
          row.appendChild(actions);
          rows.appendChild(row);
        }
        p2.body.appendChild(rows);
      }
      if (accepted.length) {
        const det = mk("details", "advance-accepted");
        det.appendChild(mk("summary", null, `已确认（可召回）${accepted.length} 条`));
        const ul = mk("ul", "advance-mem-list");
        for (const entry of accepted) ul.appendChild(mk("li", "mono", `[${entry.kind}] ${entry.title} — ${entry.provenance}`));
        det.appendChild(ul);
        p2.body.appendChild(det);
      }
      wrap.appendChild(p2.panel);

      if (list.block) {
        const det = mk("details", "advance-block");
        det.appendChild(mk("summary", null, "装载块原文（点「投给主会话」时投的就是这一段）"));
        const pre = mk("pre", "advance-block-pre", list.block);
        det.appendChild(pre);
        wrap.appendChild(det);
      }
      advanceRoot.replaceChildren(wrap);
      summary.textContent = `推进清单 ${list.count} 项 · 待确认记忆 ${proposed.length} 条 · 项目 ${state.projectId || "-"}`;
    }

    function renderCurrentView() {
      if (isBlocked()) { void showBlockedGate(); return; }
      hideGate();
      if (view === "req") void renderRequirements();
      else if (view === "team") void renderTeamView();
      else if (view === "config") void renderConfig();
      else if (view === "advance") void renderAdvance();
      else void loadTasks();
    }

    function openDialog(task = null) {
      editing = task;
      dialogTitle.textContent = task ? `编辑 ${task.identifier}` : "新建任务";
      formHint.textContent = task ? `当前版本 v${task.version}（保存时会校验，冲突会提示）` : "会使用当前选中的项目";
      fTitle.value = task?.title ?? "";
      fDescription.value = task?.description ?? "";
      // FR-94：验收标准与复核动作随卡保存，编辑时回填真值
      fAcceptance.value = task?.acceptance ?? "";
      fVerifyCommand.value = task?.verifyCommand ?? "";
      fLabels.value = task ? task.labels.join(", ") : "";
      fillDialogSelects(task);
      void fillRequirementOptions(task);
      dialog.showModal();
      fTitle.focus();
    }

    const labelsFromForm = () => fLabels.value.split(",").map((item) => item.trim()).filter(Boolean);

    /**
     * 改状态（看板拖拽、抽屉里的动作等共用）。**回传是否成功** —— 调用方据此决定要不要再报一次结果。
     * 真机反馈 2026-10-22：抽屉里点「完成」其实写成功了（事件流有 `status_changed human`），但成功路径只
     * `hideBanner()`、不刷新抽屉 ⇒ 界面看不出任何变化，被读成"点击后无反应"。故改为回传成功与否。
     */
    async function moveTask(task, status, { skipReview = false } = {}) {
      if (!status) return false;
      // FR-83 补口（卡 `-162`）：服务端对 `in_review → done` 有评审门。没显式带 `skipReview`
      // 就是**注定的 409** —— 与其让人点下去才看错误，不如在这里先把话说清楚并交出唯一出口。
      if (!skipReview && needsReviewSkip(task, status)) {
        if (!confirmReviewSkip(task)) {
          showBanner(`已取消：本卡（${task.identifier}）评审未通过，未收口。请先「评审通过」，或再次操作并确认「跳过评审」。`, "info");
          await loadTasks();
          return false;
        }
        skipReview = true;
      }
      let ok = true;
      try {
        await api("PATCH", `/api/tasks/${encodeURIComponent(task.identifier)}`, { version: task.version, status, ...(skipReview ? { skipReview: true } : {}) });
        hideBanner();
      } catch (error) {
        ok = false;
        if (error.code === "VERSION_CONFLICT") {
          showBanner(`任务已被他人修改（你读到 v${error.details?.expectedVersion}，当前 v${error.details?.currentVersion}），已刷新。`, "error");
        } else if (error.code === "REVIEW_NOT_APPROVED") {
          showBanner(`本卡还在「待验收」且评审未通过：请先在「下一步」区点「评审通过」，再确认完成；确需跳过评审，请在确认框里选「确认」。`, "error");
        } else {
          showBanner(`改状态失败：${error.message}`, "error");
        }
      }
      await loadTasks();
      return ok;
    }

    // ------------------------------------------------------------------ FR-11 拖拽
    /** 清掉所有落点高亮 / 插入线（拖拽结束与每次 dragover 重算前都调）。 */
    function clearDropMarkers() {
      try {
        for (const el of board.querySelectorAll(".is-drop-target")) el.classList.remove("is-drop-target");
        for (const el of board.querySelectorAll(".is-insert-before")) el.classList.remove("is-insert-before");
      } catch { /* ignore */ }
    }

    /**
     * 落点 → `boardPosition` 提交值的**折算**（纯函数，便于单测钉住口径）。
     *
     * 关键：前端只看得到**当前可见**的卡（筛选/折叠会藏卡），所以落点必须折成**锚点**而不是下标 ——
     * 锚点由服务端在**整列**里解析真实下标（见 `store.resolveBoardOrder`），隐藏卡因此不会让落点漂移。
     * 参数 `beforeRef` = 落点那张卡（插到它之前）；落在列尾 / 空列时为 `null`。
     * 返回三种：`{before: <编号>}` / `{before: null}`（列尾）/ `null`（＝原地没动，调用方跳过提交）。
     * 口径：
     *   · **跨列**（`changingColumn`）永远不算"没动"，且被拖卡不在目标列的可见序列里 ⇒ 只需解析锚点：
     *     锚点在目标列可见集里 → 插到它之前；否则（含落空列）→ 列尾。
     *   · **同列内**：把被拖卡从可见序列抽走后，锚点在剩余序列里的下标 == 被拖卡原下标 ⇒ 就是原位
     *     （拖回自己前后），返回 `null`；落列尾且本来就是最后一张 ⇒ 同样 `null`。
     *   · 锚点不在可见集里（刚被别人移走/删除）⇒ 退回列尾，不臆断。
     */
    function dropAnchorFor(order, draggedRef, beforeRef, changingColumn = false) {
      const seq = order.map((t) => t.identifier);
      const from = seq.indexOf(draggedRef);
      const rest = seq.filter((id) => id !== draggedRef);
      const hasBefore = beforeRef !== null && beforeRef !== undefined && beforeRef !== draggedRef;
      if (changingColumn) {
        return hasBefore && rest.includes(beforeRef) ? { before: beforeRef } : { before: null };
      }
      if (hasBefore) {
        const beforeIdx = rest.indexOf(beforeRef);
        if (beforeIdx < 0) return { before: null }; // 锚点不在可见集里 ⇒ 列尾，不臆断
        if (from >= 0 && beforeIdx === from) return null; // 插回原位 ⇒ 没动
        return { before: beforeRef };
      }
      if (from >= 0 && from === seq.length - 1) return null; // 同列、本就最后 ⇒ 没动
      return { before: null };
    }

    /**
     * 拖拽落点提交：**走既有 PATCH 入口**（`status` + `boardPosition`），不新增任何旁路 ——
     * 评审门 / 授权门 / 归因门 / 人工校验门 / 治理门全在 `store.updateTask` 里，与「上一列 / 下一列」完全同门。
     *
     * FR-83 补口（卡 `-162`）：拖拽是把未评审卡**静默收口**的最后一条路（卡片「→」/ 抽屉「下一列」已由 -158
     * 收敛）。这里在**发请求之前**用同一份谓词 `needsReviewSkip` 问一次人 —— 不确认就**一个字段都不提交**
     * （卡留在「待验收」），确认才带 `skipReview: true`。服务端仍是唯一裁决者，前端只是不制造静默旁路。
     */
    async function dropTask(task, status, anchor) {
      const body = { version: task.version };
      const crossingDone = status !== task.status && needsReviewSkip(task, status);
      if (crossingDone) {
        if (!confirmReviewSkip(task)) {
          showBanner(`已取消拖拽：本卡（${task.identifier}）评审未通过，未收口。请先「评审通过」，或再次拖动并确认「跳过评审」。`, "info");
          return false;
        }
        body.skipReview = true;
      }
      if (status !== task.status) body.status = status;
      if (anchor !== null) body.boardPosition = anchor;
      if (body.status === undefined && body.boardPosition === undefined) return true; // 原地放下：什么都不用做
      try {
        await api("PATCH", `/api/tasks/${encodeURIComponent(task.identifier)}`, body);
        hideBanner();
      } catch (error) {
        showBanner(error.code === "VERSION_CONFLICT"
          ? `任务已被他人修改（你读到 v${error.details?.expectedVersion}，当前 v${error.details?.currentVersion}），已刷新。`
          : error.code === "REVIEW_NOT_APPROVED"
            ? `拖拽被拒：本卡还在「待验收」且评审未通过。请先「评审通过」，或重新拖动并在确认框里选「确认」以跳过评审。`
            : `拖拽失败：${error.message}${error.code ? `（${error.code}）` : ""}`, "error");
        await loadTasks();
        return false;
      }
      await loadTasks();
      return true;
    }

    /** 把一列接成落区：落在卡上 = 插到该卡之前；落在列内空处 = 追加到列尾。 */
    function wireColumnDrop(column, list, status) {
      const stop = (event) => { event.preventDefault(); try { event.dataTransfer.dropEffect = "move"; } catch { /* ignore */ } };
      list.addEventListener("dragover", (event) => {
        if (!state.dragTask) return; // 只接自家看板的卡（外部拖入的文本一律不管）
        stop(event);
        const marked = event.target?.closest?.(".task-card") ?? null;
        clearDropMarkers();
        column.classList.add("is-drop-target");
        // 拖到自己身上不画插入线（避免误以为会插到自己前面）
        if (marked && marked !== state.dragEl) marked.classList.add("is-insert-before");
      });
      list.addEventListener("dragleave", (event) => {
        // 只在真正离开这一列时才清（列内子元素间移动也会冒 dragleave）
        if (column.contains(event.relatedTarget)) return;
        clearDropMarkers();
      });
      list.addEventListener("drop", (event) => {
        const dragged = state.dragTask;
        if (!dragged) return;
        stop(event);
        const marked = event.target?.closest?.(".task-card") ?? null;
        const beforeRef = marked && marked !== state.dragEl ? (marked.querySelector(".card-identifier")?.textContent ?? null) : null;
        // 可见顺序 = 该列当前在 DOM 里的卡（含被拖卡自己），锚点在这个序列里算
        const order = [...list.querySelectorAll(".task-card .card-identifier")].map((el) => ({ identifier: el.textContent }));
        const anchor = dropAnchorFor(order, dragged.identifier, beforeRef, status !== dragged.status);
        clearDropMarkers();
        // 同列内判成"原地"、且状态也没变 ⇒ 直接不提交（不制造无谓的版本冲突）
        if (status === dragged.status && anchor === null) return;
        void dropTask(dragged, status, anchor);
      });
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = {
        title: fTitle.value,
        description: fDescription.value,
        acceptance: fAcceptance.value,
        verifyCommand: fVerifyCommand.value,
        status: fStatus.value,
        priority: fPriority.value,
        owner: fOwner.value === "" ? null : fOwner.value,
        labels: labelsFromForm(),
        // 归因随建卡事务一次写入（服务端 `POST /api/tasks` 读 `requirementId`）；
        // 编辑态不在这里带 —— 改绑有专门入口，避免「改标题顺手把归属改了」。
        requirementId: editing ? undefined : (fRequirement.value || undefined),
      };
      try {
        if (editing) await api("PATCH", `/api/tasks/${encodeURIComponent(editing.identifier)}`, { ...body, version: editing.version });
        else await api("POST", "/api/tasks", { ...body, projectId: state.projectId });
        editing = null;
        dialog.close();
        hideBanner();
        await loadTasks();
      } catch (error) {
        formHint.textContent = error.code === "VERSION_CONFLICT"
          ? "保存失败：任务已被他人修改，已刷新最新内容。"
          : `保存失败：${error.message}`;
        if (error.code === "VERSION_CONFLICT") {
          editing = null;
          dialog.close();
          showBanner("保存冲突：已刷新最新内容，请重新编辑。", "error");
          await loadTasks();
        }
      }
    });

    cancelButton.addEventListener("click", () => {
      editing = null;
      dialog.close();
    });
    newTask.addEventListener("click", () => openDialog(null));

    // 「新建项目」统一入口（工具栏 / 配置页共用）—— 建完即切换，并让本会话成为该项目主会话
    // （与「会话绑定门」里的建项目同口径：POST /api/projects → resolveBinding）。
    async function createProjectFlow() {
      const name = window.prompt("新项目名称（将据此生成项目 id）");
      if (!name || !name.trim()) return;
      const ws = window.prompt("项目工作目录（绝对路径，可留空）");
      try {
        const r = await api("POST", "/api/projects", { name: name.trim(), workspacePath: ws && ws.trim() ? ws.trim() : null });
        state.projectId = r.project.id;
        state.projects = [r.project, ...(state.projects ?? []).filter((p) => p.id !== r.project.id)];
        await resolveBinding(state.projectId);
        showBanner(`已新建项目 ${r.project.id}，并切换为当前项目`, "info");
        setView("board");
        renderCurrentView();
      } catch (e) { showBanner(`新建失败：${e.message}`, "error"); }
    }
    newProject.addEventListener("click", () => void createProjectFlow());
    loopToggle.addEventListener("click", async () => {
      const enabled = !(state.loop?.enabled);
      const next = { ...(state.loop || {}), enabled, intervalMs: state.loop?.intervalMs ?? 30000 };
      try { await api("PUT", `/api/projects/${encodeURIComponent(state.projectId)}/settings`, { loop: next }); state.loop = next; renderControls(); showBanner(`看板执行循环已${enabled ? "开启：每 ~30s 把「待执行(todo)且已归因」任务自动派发给活跃执行者" : "关闭"}`, "info"); }
      catch (e) { showBanner(`切换失败：${e.message}`, "error"); }
    });
    refreshButton.addEventListener("click", () => {
      if (view === "req") void renderRequirements();
      else if (view === "team") void renderTeamView();
      else if (view === "config") void renderConfig();
      else void loadTasks();
    });
    projectSelect.addEventListener("change", () => {
      state.projectId = projectSelect.value;
      state.loop = {};
      void (async () => { await resolveBinding(state.projectId); renderCurrentView(); })();
    });
    priorityFilter.addEventListener("change", () => {
      state.priority = priorityFilter.value;
      void loadTasks();
    });
    labelFilter.addEventListener("change", () => {
      state.label = labelFilter.value;
      void loadTasks();
    });
    // FR-26：切换会话归属维度（全部 / 已关联 / 未关联）同样回到服务端取数（与其它维度一致，保证口径唯一）
    sessionFilter.addEventListener("change", () => {
      state.sessionScope = sessionFilter.value;
      void loadTasks();
    });
    // FR-14：搜索框 —— 输入即取数（防抖 250ms，避免每个字符打一次请求）；清空即恢复全量。
    // 与筛选走同一个 loadTasks（同一条取数路径），故"搜索 + 筛选"天然取交集。
    let keywordTimer = null;
    keywordInput.addEventListener("input", () => {
      state.keyword = keywordInput.value;
      if (keywordTimer) clearTimeout(keywordTimer);
      keywordTimer = setTimeout(() => { void loadTasks(); }, 250);
    });
    // 回车立即触发（不等防抖），并保留浏览器 search 输入框的原生"清除"按钮行为
    keywordInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        state.keyword = keywordInput.value;
        if (keywordTimer) { clearTimeout(keywordTimer); keywordTimer = null; }
        void loadTasks();
      }
    });
    keywordInput.addEventListener("search", () => {
      // 原生 ✕ 清除按钮触发 search 事件：立即按清空后的值取数（恢复全量）
      state.keyword = keywordInput.value;
      if (keywordTimer) { clearTimeout(keywordTimer); keywordTimer = null; }
      void loadTasks();
    });
    themeToggle.addEventListener("click", () => {
      const current = doc.documentElement.dataset.theme;
      if (current === "dark") delete doc.documentElement.dataset.theme;
      else doc.documentElement.dataset.theme = "dark";
      try {
        localStorage.setItem("tb-theme", current === "dark" ? "" : "dark");
      } catch {
        /* ignore */
      }
    });

    // 能力门是**渲染后**才知道要不要置灰的（区块/抽屉随时新建）⇒ 观察 DOM 变化，把新出现的宿主依赖按钮一并置灰。
    // 只观察 childList（不观察 attributes），故 `disabled/title` 的写入不会再触发自己。
    try { new MutationObserver(() => { try { applyHostGate(); } catch { /* ignore */ } }).observe(doc.body, { childList: true, subtree: true }); } catch { /* ignore */ }
    bootstrap().catch((error) => showBanner(`初始化失败：${error.message}`, "error"));

    // FR-41：进度可见（SSE 失效信号 → 重取）
    let boardEvents = null;
    try {
      boardEvents = new EventSource(`${apiBase}/api/events`);
      let reloadTimer = null;
      const reload = () => {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          if (destroyed) return;
          if (view === "board") void loadTasks();
          if (view === "team") void renderTeamView();
          if (detailTask) void openTaskDetail(detailTask); // FR-49：详情/团队/会话随状态回流刷新
        }, 150);
      };
      boardEvents.addEventListener("message", reload);
      boardEvents.addEventListener("task.updated", reload);
      boardEvents.addEventListener("team.updated", reload);
      /**
       * FR-20 补口（2026-10-23 真机取证缺口 A）· 断线 / 重连**必须可见**。
       *
       * 此前这里没挂 `onerror` ⇒ 连接中断只体现在 `readyState=0`，UI 全无感知（真机读数：
       * `banner` 恒 `hidden`、文案变化轨迹为空数组）。用户于是看不出界面可能已停在旧快照。
       * 判据用 `readyState`（规范常量：0 CONNECTING / 1 OPEN / 2 CLOSED）：
       *   - `CLOSED` ⇒ 浏览器**不再自动重连**（服务端 4xx/5xx 等终态），措辞要如实说「已断开」并给出路；
       *   - 其余（`CONNECTING`）⇒ 正在自动重连，说「重连中…」。
       * 只**如实报告连接状态**，不改任何数据语义、不新增取数通道。
       */
      boardEvents.onerror = () => {
        if (destroyed) return;
        if (boardEvents && boardEvents.readyState === 2 /* CLOSED */) {
          connNotice.textContent = "实时连接已断开（浏览器不再自动重连）· 界面可能停在旧数据，请刷新页面重试";
        } else {
          connNotice.textContent = "连接中断 · 重连中…（界面可能停在旧数据，恢复后自动补齐）";
        }
        connNotice.hidden = false;
      };
      /**
       * FR-20 补口（同轮取证缺口 B）· 重连成功 ⇒ **立即重取一次**。
       *
       * 此前没挂 `onopen` ⇒ 重连成功不回灌 `reload()`，补齐只能靠「后续事件 / 60s 轮询 / focus·可见性」，
       * 真机实测最坏 ≈52s（等 `watchdogPoll`），偏离 FR-20「无需用户手动刷新」。
       * 复用**同一条** `reload()`（不新增取数通道、不改事件语义）；首次连接同样走这里（幂等，无害）。
       */
      boardEvents.onopen = () => {
        if (destroyed) return;
        connNotice.hidden = true;
        reload();
      };
    } catch { boardEvents = null; }
    // FR-75/76：看护状态会随"阈值到达"自行变化（不产生 SSE），用轻量轮询兜底刷新看板/详情。
    const watchdogPoll = window.setInterval(() => {
      if (destroyed) return;
      if (view === "board") void loadTasks();
      else if (detailTask) void openTaskDetail(detailTask);
    }, 60000);

    // 真机 2026-10-22：面板常驻数小时后再回来，看板可能仍停在旧快照 —— 这正是「已归因的卡仍报
    // 归因门」的直接来源。回到页签 / 窗口即同步一次；只碰看板与已打开的抽屉，**不动**「需求 / 团队 /
    // 配置」视图（避免打断那里的编辑态）。
    const refreshOnReturn = () => {
      if (destroyed) return;
      if (view === "board") void loadTasks();
      if (detailTask) void openTaskDetail(detailTask);
    };
    const onVisibility = () => { if (typeof document !== "undefined" && document.visibilityState === "visible") refreshOnReturn(); };
    try { document.addEventListener("visibilitychange", onVisibility); window.addEventListener("focus", refreshOnReturn); } catch { /* ignore */ }

    // ---------------------------------------------------------------- 需求视图（只读 + 唯一写操作=可行性否决）
    let view = "board";
    let detailTask = null;
    // 真机 2026-10-23（用户报障「评审通过点击后…有两个完成按钮」）：抽屉渲染会被**并发**触发 ——
    // 评审/授权成功后处理器里的 `reopen()`、SSE `task.updated` 回流、60s 看护轮询、回到页签自愈，
    // 任两条撞在一起就有两代渲染同时在跑。而「下一步」区块是**唯一在 await（`GET …/next-step`）之后
    // 才追加**的区块 ⇒ 先完成的那一代把自己的 `<section>` 插进了后一代的 body，该区块于是出现两次
    // （按钮自然也就成了两个）。处置＝渲染代次：每代自增序号，await 回来发现已被更新的一代取代即退出。
    let detailRenderSeq = 0;
    const setView = (next) => {
      view = next;
      boardScroll.hidden = next !== "board";
      reqScroll.hidden = next !== "req";
      teamScroll.hidden = next !== "team";
      configScroll.hidden = next !== "config";
      advanceScroll.hidden = next !== "advance";
      toolbar.hidden = false; // 项目选择器在所有视图可见：明确"当前配置/操作的是哪个项目"
      newTask.hidden = next !== "board"; // 真机 2026-10-23：「新建任务」只在看板视图有意义
      for (const [name, button] of Object.entries(navButtons)) button.classList.toggle("is-active", name === next);
      renderCurrentView();
    };
    boardToggle.addEventListener("click", () => setView("board"));
    reqToggle.addEventListener("click", () => setView("req"));
    teamToggle.addEventListener("click", () => setView("team"));
    configToggle.addEventListener("click", () => setView("config"));
    advanceToggle.addEventListener("click", () => setView("advance"));

    // ------------------------------------------------------------ 通用小组件
    function fmtTime(value) {
      if (!value) return "—";
      return String(value).replace("T", " ").replace(/\.\d+Z?$/, "").replace(/Z$/, "");
    }
    function pill(text, cls = "") {
      return mk("span", `chip ${cls}`.trim(), text);
    }
    function statusPill(status) {
      return mk("span", `chip dot status-chip status-${status}`, STATUS_LABELS[status] ?? status);
    }
    /** FR-91：需求条目状态中文口径（draft/open/done/closed 四处共用，避免各写一份走样）。 */
    function reqStatusLabel(status) {
      return status === "draft" ? "待确认" : status === "open" ? "在办" : status === "done" ? "已完成" : status === "closed" ? "已关闭" : String(status ?? "");
    }
    function btn(label, onClick, cls = "ghost") {
      const node = mk("button", cls, label);
      node.type = "button";
      node.addEventListener("click", onClick);
      return node;
    }
    /** 依赖宿主会话通道的按钮：创建时就打上能力标记（`applyHostGate` 据此置灰）。 */
    function hostBtn(label, onClick, cls = "ghost", cap) {
      // 能力位缺省时按文案查兜底表（`打开执行会话` ⇒ openSession），查不到才落到 sendPrompt。
      return needsHost(btn(label, onClick, cls), cap ?? HOST_BUTTON_LABELS.get(label) ?? "sendPrompt");
    }
    function panelEl(title, ...actions) {
      const panel = mk("section", "panel");
      const head = mk("div", "panel-head");
      head.appendChild(mk("h2", null, title));
      if (actions.length) {
        head.appendChild(mk("div", "spacer"));
        for (const action of actions) head.appendChild(action);
      }
      const body = mk("div", "panel-body");
      panel.append(head, body);
      return { panel, head, body };
    }
    function kvList(pairs, cls = "kv") {
      const dl = mk("dl", cls);
      for (const [key, value] of pairs) {
        dl.appendChild(mk("dt", null, key));
        const dd = mk("dd", null, value === null || value === undefined || value === "" ? "—" : String(value));
        if (cls === "kv") dd.classList.add("mono");
        dl.appendChild(dd);
      }
      return dl;
    }
    function kvRow(head, pairs) {
      const wrap = mk("div", "drawer-section");
      wrap.appendChild(mk("h3", null, head));
      wrap.appendChild(kvList(pairs));
      return wrap;
    }

    /**
     * 长文本渲染（真机反馈 2026-10-22：「单内容段较多的要做好段落格式展示」）。
     *
     * **FR-24（2026-10-23）**：此前只做「按空行分段」，表格 / 任务清单 / 列表 / 代码块 / 链接 / 引用
     * 全都不呈现（`**加粗**` 也只是字面量）。现由模块级 `renderMarkdown` 承担 ——
     * **任务描述与评论共用同一份**，避免两套口径；仍是**纯 DOM 构建、零 `innerHTML`**。
     * 口径保持：段落按空行切分、段内保留换行（CSS `white-space: pre-wrap`），HTML 注释不显示。
     */
    const richText = (text) => renderMarkdown(doc, text);

    // ------------------------------------------------------------ 配置视图
    /**
     * FR-84 补口（2026-10-22）· **改绑已有会话**（不新建）。
     * 为什么要有：宿主**建会话**能力不可用时（当前 DSH 实例未加载宿主 shim → `create()` 抛
     * 「Agent preset binding requires a scoped context」），「重建并绑定项目主会话」必失败；
     * 而项目主会话指针可能指着**别的工作区**的旧会话 ⇒ 用户「从任务台回不到本项目的会话」。
     * 本路径只把**本工作区已存在的会话**改绑为主会话：服务端仍会**探活** + **校验工作区归属**。
     */
    async function bindExistingSession(projectRef, sid, { force = false } = {}) {
      const target = String(sid ?? "").trim();
      if (!target) { showBanner("请先选择或粘贴一个会话标识", "error"); return null; }
      try {
        const r = await api("POST", `/api/projects/${encodeURIComponent(projectRef)}/sessions/rebind`, { confirm: true, sessionId: target, force });
        showBanner(`已改绑项目主会话 → ${String(r.after).slice(0, 18)}…（旧指针 ${r.before ? `${String(r.before).slice(0, 14)}…` : "（空）"}；未新建会话）${sessionNameClause(r)}`, r.titleApplied === false ? "error" : "info");
        return r;
      } catch (e) {
        const hint = e.code === "SESSION_OTHER_WORKSPACE" ? "（该会话属于另一个工作区，默认拒绝改绑）"
          : e.code === "SESSION_NOT_FOUND" ? "（该会话在本机不存在：可能已被清理）"
          : e.code === "HOST_UNAVAILABLE" ? "（宿主不支持校验会话）" : "";
        showBanner(`改绑失败：${e.message}${hint}`, "error");
        return null;
      }
    }

    /**
     * 「改绑到本工作区已有会话」控件（按需展开；数据来自宿主 `sessionQuery` 列表 + 项目工作区过滤）。
     * 宿主列不出会话时**如实告知**，并保留「手动粘贴会话标识」通道（不假装没有会话）。
     */
    function buildBindExistingControl(projectRef, after) {
      const box = mk("div", "tb-bind-existing");
      let open = false;
      const toggle = btn("改绑到本工作区已有会话…", () => { void render(); });
      const render = async () => {
        if (open) { open = false; box.replaceChildren(toggle); return; }
        open = true;
        const body = mk("div", "tb-bind-existing-body");
        const note = mk("div", "hint", "正在列出本工作区会话…");
        body.appendChild(note);
        box.replaceChildren(toggle, body);
        let payload = null;
        try { payload = await api("GET", `/api/projects/${encodeURIComponent(projectRef)}/sessions/candidates`); }
        catch (e) { note.textContent = `列出本工作区会话失败：${e.message}`; return; }
        const rows = payload?.candidates ?? [];
        // 真机教训（2026-10-22）：宿主列会话失败时**必须显示原因**，否则只剩一句「暂无会话」，把故障说成空数据。
        note.textContent = rows.length
          ? `本项目工作区（${payload?.workspacePath ?? "未设置"}）下已有 ${rows.length} 个会话（宿主共 ${payload?.total ?? rows.length} 个）：`
          : payload?.source === "sessionQuery.listSessions" || payload?.source === "sessionQuery.list"
            ? `本项目工作区（${payload?.workspacePath ?? "未设置"}）下暂无宿主已持久化会话 —— 先在 DSH 里建一个会话，或直接粘贴会话标识。`
            : `宿主未能列出会话（${payload?.source ?? "未知"}${payload?.reason ? `：${payload.reason}` : ""}）—— 可手动粘贴会话标识改绑，或用「用当前会话作为项目主会话」。`;
        const pick = mk("select", "tb-bind-existing-select");
        pick.appendChild(option("", "（选择要改绑的会话…）"));
        for (const r of rows) {
          const state = r.liveness?.exists === false ? "（本机已不存在）" : r.liveness?.live ? "（在线）" : "";
          pick.appendChild(option(r.sessionId, `${r.isCurrent ? "★ 当前主会话 · " : ""}${String(r.sessionId).slice(0, 18)}…${r.title ? ` · ${r.title}` : ""}${state}`));
        }
        if (rows.length) body.appendChild(pick);
        const manual = mk("input", "tb-bind-existing-input");
        manual.placeholder = "或直接粘贴会话标识（session-…）";
        body.appendChild(manual);
        body.appendChild(btn("改绑为主会话", async () => {
          const r = await bindExistingSession(projectRef, (pick.value || manual.value || "").trim());
          if (!r) return;
          open = false; box.replaceChildren(toggle);
          if (after) await after(r);
        }, "primary"));
      };
      box.appendChild(toggle);
      return box;
    }

    async function renderConfig() {
      configRoot.replaceChildren(mk("p", "hint", "加载配置…"));
      try {
        // 兼容旧服务端：/api/context 可能尚未注册（需重启 web profile）；失败时降级不报错。
        let info = { project: null, requirementDoc: null, cwd: null };
        let stale = false;
        try { info = await api("GET", "/api/context"); }
        catch (e) { if (e && e.code === "NOT_FOUND") { stale = true; } else { throw e; } }
        const meta = await api("GET", "/api/meta").catch(() => null);
        const box = mk("div", "config-view");
        const projName = (state.projects.find((p) => p.id === state.projectId)?.name) ?? state.projectId;
        box.appendChild(mk("h2", null, `任务工作台 · 配置`));
        box.appendChild(mk("p", "hint", `配置对象：${state.projectId}（${projName}）${sessionId ? " · 会话内" : " · 全局入口"} — 用上方“项目”下拉切换；下方所有保存都作用于该项目。`));
        // 开局向导（团队先行七步 + 复制指令）
        const [gSettings, gDocs, gItems, gTasks] = await Promise.all([
          api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/settings`).catch(() => ({})),
          api("GET", `/api/requirements/docs?project=${encodeURIComponent(state.projectId)}`).catch(() => ({ docs: [] })),
          api("GET", `/api/requirements/items?project=${encodeURIComponent(state.projectId)}`).catch(() => ({ items: [] })),
          api("GET", `/api/tasks?project=${encodeURIComponent(state.projectId)}`).catch(() => ({ tasks: [] })),
        ]);
        const gDoc = (gDocs.docs || [])[0] || null;
        const gItemsAll = gItems.items || [];
        const gTasksAll = gTasks.tasks || [];
        const gBound = !!(info.project && (!sessionId || info.sessionBound !== false));
        const gEnv = Object.keys(gSettings.envConfig || {}).length > 0;
        const gRoster = (gSettings.teamTemplate?.roles || []).length > 0;
        const gIntake = gDoc ? /##\s*资料清单/.test(gDoc.body || "") : false;
        const gOpen = gItemsAll.filter((i) => i.status === "open").length;
        const gDraft = gItemsAll.filter((i) => i.status === "draft").length;
        const gProg = gTasksAll.filter((t) => ["in_progress", "in_review", "blocked"].includes(t.status)).length;
        const guide = mk("section", "config-card");
        guide.appendChild(mk("h3", null, "开局向导（团队先行）"));
        const engine = gSettings.teamTemplate?.engine ?? "instruction";
        const gcopy = (label, text) => btn(label, () => { void copyText(text).then((ok) => showBanner(ok ? `已复制：${label}` : `复制失败：浏览器拒绝了剪贴板写入 —— 请手动选择复制（${label}）`, ok ? "info" : "error")); });
        const srow = (ok, n, title, ...actions) => { const r = mk("div", "config-row"); r.appendChild(pill(`${ok ? "✅" : "○"} 第 ${n} 步`, ok ? "ok" : "warn")); r.appendChild(mk("span", null, title)); const right = mk("span", "config-actions"); right.append(...actions); r.appendChild(right); return r; };
        guide.append(
          srow(gBound, 1, "绑定项目 / 会话", mk("span", "hint", info.project ? `${info.project.id}${sessionId ? (info.sessionBound === false ? "（未绑定）" : " · 已绑定会话") : " · 全局入口"}` : "（未解析）")),
          srow(gEnv, 2, "项目环境与约束", mk("span", "hint", gEnv ? "已配置" : "未配置（见下方卡片）")),
          srow(gRoster, 3, `执行团队模板 · 引擎=${engine}`, mk("span", "hint", gRoster ? `${(gSettings.teamTemplate?.roles || []).length} 个角色` : "未配置"), gcopy("复制团队创建指令", teamPrompt(engine))),
          srow(false, 4, "创建执行团队（对应引擎）", gcopy(`复制创建指令（${engine}）`, teamPrompt(engine))),
          srow(gIntake, 5, "引入项目资料", mk("span", "hint", gIntake ? `已引入（条目 ${gItemsAll.length}）` : "未引入（见下方卡片）")),
          srow(gOpen > 0, 6, "确认需求条目", mk("span", "hint", `待确认 ${gDraft} · 已确认 ${gOpen}`), btn("去需求页", () => setView("req"))),
          srow(gTasksAll.length > 0, 7, "生成看板任务", mk("span", "hint", `任务 ${gTasksAll.length}（进行中/待验 ${gProg}）`), btn("去看板", () => setView("board"))),
          srow(false, 8, "开局提示词（新会话首条）", gcopy("复制开局提示词", KICKOFF_PROMPT)),
        );
        box.appendChild(guide);
        if (stale) box.appendChild(mk("p", "hint", "当前服务端为旧版（无 /api/context）：请重启 web profile 后重试。"));
        const card = (title, hint) => { const c = mk("section", "config-card"); c.appendChild(mk("h3", null, title)); if (hint) c.appendChild(mk("p", "hint", hint)); return c; };
        const row = (label, ...nodes) => { const r = mk("div", "config-row"); r.appendChild(mk("span", null, label)); const right = mk("span", "config-actions"); right.append(...nodes); r.appendChild(right); return r; };

        const bind = card("当前绑定", "工作区 → 项目 → 需求文档（初始绑定）");
        bind.appendChild(kvList([
          ["项目", info.project ? `${info.project.name ?? ""}（${info.project.id}）` : "（未绑定）"],
          ["工作区", info.project?.workspacePath ?? info.cwd ?? "（未设置）"],
          ["需求文档", info.requirementDoc ? `v${info.requirementDoc.version} · ${info.requirementDoc.id}` : "（无）"],
        ]));
        bind.appendChild(row("操作", btn("前往需求视图", () => setView("req")), btn("新建项目", () => void createProjectFlow(), "primary")));
        // 真机 2026-10-23（用户报障「配置页只能切换已有项目，不能新增」）：切换走顶部项目下拉，
        // 新建走这里的按钮 —— 此前配置页只有「前往需求视图」，正常使用路径下无法新建项目。
        bind.appendChild(mk("p", "hint", "切换项目用顶部「项目」下拉；要新建项目点上面的「新建项目」（建完即切换为本会话的项目）。"));

        const req = card("需求", "需求文档与条目的管理入口");
        req.appendChild(row("需求视图", btn("打开", () => setView("req"), "primary")));
        req.appendChild(row("新建需求条目", btn("新建", async () => {
          const title = window.prompt("需求条目标题");
          if (!title) return;
          try { await api("POST", "/api/requirements/items", { projectId: state.projectId, title }); showBanner("已新建需求条目", "info"); await renderConfig(); }
          catch (e) { showBanner(`新建失败：${e.message}`, "error"); }
        })));
        req.appendChild(row("AI 拆解（auto）", btn("拆解", async () => {
          try {
            const docs = await api("GET", `/api/requirements/docs?project=${encodeURIComponent(state.projectId)}`);
            const doc = docs.docs[0];
            if (!doc) { showBanner("请先新建/编辑需求文档", "error"); return; }
            const r = await api("POST", `/api/requirements/docs/${encodeURIComponent(doc.id)}/elaborate`, { mode: "auto" });
            showBanner(`拆解：mode=${r.mode}${r.degraded ? "（降级：" + (r.aiError ?? "无AI") + "）" : ""} 候选=${r.candidates ? r.candidates.length : 0}${r.totalFound && r.totalFound > (r.candidates ? r.candidates.length : 0) ? `（共 ${r.totalFound}，已截断）` : ""}`, r.degraded ? "error" : "info");
          } catch (e) { showBanner(`拆解失败：${e.message}`, "error"); }
        })));

        const sess = card("会话区 / 会话关联", "工作台在会话区中的呈现与任务归属");
        sess.appendChild(kvList([
          ["入口位置", "会话标签页 conversation.view + 侧栏面板"],
          ["会话作用域", "随当前会话的工作区自动绑定"],
          ["任务归属", "认领写入 exec.agent.id；详情抽屉可前往/释放"],
        ]));
        sess.appendChild(row("来源会话", mk("span", "hint", state.session ?? "（未检测）")));

        const exec = card("执行与团队", "启动执行 / 归属团队 / 治理红线");
        exec.appendChild(kvList([
          ["执行引擎", "instruction（P2 降级，可经 TEAM_ENGINE 切换）"],
          ["并发口径", "单任务同时 1 个活跃执行单元（任务级锁）"],
          ["治理红线", "done 仅人工 · backlog 不开工 · 审查未过不解锁"],
        ]));
        exec.appendChild(row("团队视图", btn("打开", () => setView("team"), "primary")));

        // 执行团队（引擎）——在配置页统一管理"用哪个团队插件"
        const eng = card("执行团队（引擎）", "选择由哪个团队插件承载执行；在此统一管理");
        const engSel = mk("select");
        for (const e of TEAM_ENGINES) { const o = mk("option"); o.value = e.id; o.textContent = `${e.label}（${e.tools}）`; engSel.appendChild(o); }
        engSel.value = engine;
        const engNote = mk("p", "hint", TEAM_ENGINES.find((e) => e.id === engine)?.note ?? "");
        engSel.addEventListener("change", () => { engNote.textContent = TEAM_ENGINES.find((e) => e.id === engSel.value)?.note ?? ""; });
        eng.appendChild(row("团队引擎", engSel));
        eng.appendChild(engNote);
        // 任务执行团队选择（列出：官方 / 第三方 .agent-teams / 工作台本地）
        const availTeams = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/agent-teams`).catch(() => ({ teams: [] }));
        const teamSel = mk("select");
        for (const t of (availTeams.teams || [])) {
          const o = mk("option");
          o.value = `${t.source}:${t.id}`;
          o.textContent = `${t.name}（${t.source}${t.phase ? ` · ${t.phase}` : ""}${t.memberCount != null ? ` · ${t.memberCount} 成员` : ""}${t.taskCount != null ? ` · ${t.taskCount} 任务` : ""}）`;
          teamSel.appendChild(o);
        }
        teamSel.value = gSettings.teamTemplate?.executionTeam
          ?? (availTeams.teams?.[0] ? `${availTeams.teams[0].source}:${availTeams.teams[0].id}` : "");
        eng.appendChild(row("任务执行团队", teamSel));
        eng.appendChild(mk("p", "hint", "选择本项目用它来下发/执行任务的团队；官方团队由队长 spawn，第三方团队来自工作区 .agent-teams。"));
        const engBar = mk("div", "btn-row");
        engBar.append(
          btn("保存引擎", async () => {
            try { await api("PUT", `/api/projects/${encodeURIComponent(state.projectId)}/settings`, { teamTemplate: { ...(gSettings.teamTemplate || {}), engine: engSel.value, executionTeam: teamSel.value } }); showBanner(`已保存：引擎=${engSel.value} · 执行团队=${teamSel.value}`, "info"); await renderConfig(); }
            catch (e) { showBanner(`保存失败：${e.message}`, "error"); }
          }, "primary"),
          btn("复制创建指令", () => { void copyText(teamPrompt(engSel.value)).then((ok) => showBanner(ok ? "已复制创建指令" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制创建指令", ok ? "info" : "error")); }),
        );
        eng.appendChild(engBar);

        const ops = mk("section", "config-card");
        const opsD = mk("details");
        opsD.appendChild(mk("summary", null, "数据与运维（高级）"));
        opsD.appendChild(kvList([
          ["数据目录", meta?.dataDir ?? "—"],
          ["数据库", meta?.dbPath ?? "—"],
          ["接口版本", meta ? `schemaVersion=${meta.schemaVersion ?? "?"}` : "—"],
          ["工作台版本", `app v${window.__TB_BOARD__?.version ?? "?"}`],
        ]));
        opsD.appendChild(row("自检", btn("刷新", () => void renderConfig()), btn("前往团队视图", () => setView("team"))));
        ops.appendChild(opsD);

        // 项目入口 · 初始化（FR-55/56/57）：引入资料 → 约定环境约束 → 配置执行团队
        const settings = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/settings`).catch(() => ({ envConfig: {}, teamTemplate: {} }));
        const init = card("项目入口 · 初始化", "以工作台作为项目入口：项目开局对齐 → 引入项目资料 → 约定环境约束 → 配置 agent 执行团队");

        // FR-92：**项目开局对齐（标准步骤程序）** —— 用户 2026-10-22 指定引入《Vibe Coding 团队协作技巧》
        // 作为开局对齐事项，并要求「作为任务工作台标准步骤程序执行」。这里把六步自检摆出来：
        // 每步都有可核验判据（工作区文件 / 项目设置），工作台自己回答"对齐了没有"。**只读自检，不改数据**。
        const alignBox = mk("div", "kickoff-box");
        alignBox.appendChild(mk("div", "kickoff-head", "项目开局对齐（6 步 · 标准步骤）"));
        const alignBody = mk("div", "kickoff-body", "自检中…");
        let lastKickoff = null;
        const refreshAlign = async () => {
          alignBody.replaceChildren(mk("div", "empty-note", "自检中…"));
          try {
            const k = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/kickoff`);
            lastKickoff = k;
            const wrap = mk("div", "kickoff-steps");
            wrap.appendChild(mk("div", `kickoff-verdict ${k.ready ? "ok" : "warn"}`, `${k.ready ? "✔ " : "⚠ "}${k.verdict}`));
            if (!k.readable) wrap.appendChild(mk("p", "hint", "项目未配置工作区目录（workspacePath）⇒ 文件类判据无法自检（设置里填上工作区即可）。"));
            for (const s of k.steps) {
              const rowEl = mk("div", `kickoff-step ${s.status}`);
              rowEl.append(pill(`${s.done}/${s.total}`, s.status === "done" ? "ok" : s.status === "partial" ? "warn" : ""), mk("span", "kickoff-title", s.title));
              wrap.appendChild(rowEl);
              if (s.status !== "done") {
                const ul = mk("ul", "kickoff-todo");
                for (const c of s.checks.filter((x) => !x.ok)) ul.appendChild(mk("li", null, c.label));
                wrap.appendChild(ul);
              }
            }
            const src = mk("p", "hint");
            src.append(mk("span", null, `依据：${k.source?.title ?? "开局对齐清单"}　`));
            const link = mk("a", "kickoff-src", "查看原文");
            link.href = k.source?.url ?? "#";
            link.target = "_blank";
            link.rel = "noreferrer";
            src.appendChild(link);
            wrap.appendChild(src);
            alignBody.replaceChildren(wrap);
          } catch (e) { alignBody.replaceChildren(mk("div", "empty-note", `自检失败：${e.message}（服务端旧版本需重载插件才有该端点）`)); }
        };
        const alignBar = mk("div", "btn-row");
        alignBar.append(
          btn("重新自检", () => void refreshAlign(), "primary"),
          btn("复制对齐清单", () => {
            const k = lastKickoff;
            if (!k) { showBanner("请先「重新自检」拿到清单", "error"); return; }
            const lines = ["项目开局对齐（标准步骤 · 开工前先对齐）", k.verdict, ""];
            for (const s of k.steps) {
              lines.push(`${s.done}/${s.total} ${s.title} —— ${s.why}`);
              lines.push(`    要求：${s.spec}`);
              for (const c of s.checks) lines.push(`    ${c.ok ? "[x]" : "[ ]"} ${c.label}`);
            }
            lines.push("", `依据：${k.source?.title ?? ""} ${k.source?.url ?? ""}`.trim());
            void copyText(lines.join("\n")).then((ok) => showBanner(ok ? "已复制对齐清单" : "复制失败：请手动复制", ok ? "info" : "error"));
          }),
        );
        alignBox.append(alignBody, alignBar);
        init.appendChild(alignBox);
        void refreshAlign();

        init.appendChild(row("引入项目资料（md/doc）", btn("引入资料（仅索引）", async () => {
          try {
            // FR-57（2026-10-29 A）：引入**只写资料索引**，不产生需求条目 —— 文案必须说清副作用。
            const r = await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/intake`, { mode: "doc" });
            showBanner(`已同步资料索引：扫描 ${r.scanned} 个文档，需求文档 v${r.doc?.version ?? "?"}（${r.doc?.bytes ?? 0} 字节）；本次不生成需求条目`, "info");
            await renderConfig();
          } catch (e) { showBanner(`引入失败：${e.message}`, "error"); }
        }, "primary")));
        init.appendChild(mk("p", "hint", "项目环境与约束（JSON）——工作区/语言/约定/红线等"));
        const envTa = mk("textarea", "req-editor");
        envTa.value = JSON.stringify(settings.envConfig ?? {}, null, 2);
        init.appendChild(mk("p", "hint", "agent 执行团队模板（JSON）——roles / executor / qualityGates"));
        const tplTa = mk("textarea", "req-editor");
        tplTa.value = JSON.stringify(settings.teamTemplate ?? {}, null, 2);
        const saveCfg = btn("保存配置", async () => {
          let envConfig; let teamTemplate;
          try { envConfig = JSON.parse(envTa.value || "{}"); } catch { showBanner("环境约束不是合法 JSON", "error"); return; }
          try { teamTemplate = JSON.parse(tplTa.value || "{}"); } catch { showBanner("团队模板不是合法 JSON", "error"); return; }
          try { await api("PUT", `/api/projects/${encodeURIComponent(state.projectId)}/settings`, { envConfig, teamTemplate }); showBanner("已保存项目配置", "info"); }
          catch (e) { showBanner(`保存失败：${e.message}`, "error"); }
        }, "primary");
        // 高级项折叠，保持配置页简洁
        const cfgAdv = mk("details");
        cfgAdv.appendChild(mk("summary", null, "环境约束 / 团队模板（JSON，高级）"));
        cfgAdv.append(envTa, tplTa, saveCfg);
        init.appendChild(cfgAdv);

        // FR-63：会话关联（主会话批准）
        const links = card("会话关联（主会话批准）", "已绑定本项目的会话；未绑定的会话可申请，由主会话批准后生效");
        links.appendChild(kvList([
          ["本会话", sessionId ? String(sessionId) : "（全局入口 · 非会话）"],
          ["本会话角色", sessionId ? String(state.context?.association ?? "未绑定") : "—"],
          ["主会话", state.context?.mainSessionId ? String(state.context.mainSessionId) : "（尚无）"],
        ]));
        const sessList = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/sessions`).catch(() => ({ sessions: [], main: null, staleMain: false }));
        // FR-84：**存活徽标**（在线 / 已失效 / 存在性未知）+ 主会话**一键重建**
        // 判不准（exists=null）时如实显示"存在性未知"，不谎报失效。
        const livenessPill = (lv) => {
          if (!lv) return pill("未探活", "");
          const text = lv.exists === true
            ? `在线${lv.live ? (lv.running ? " · 运行中" : " · 空闲") : (lv.status ? ` · ${lv.status}` : "")}`
            : lv.exists === false ? "已失效" : "存在性未知";
          return pill(text, lv.exists === true ? "ok" : lv.exists === false ? "danger" : "");
        };
        const rebindMain = async () => {
          if (!window.confirm("重建并绑定项目主会话？\n\n将新建一个会话、写回项目主会话指针，并投递 FR-61 开局提示词（旧指针被替换；旧会话本身不被删除）。")) return;
          try {
            const r = await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/sessions/rebind`, { confirm: true });
            showBanner(`已重建主会话：${String(r.after).slice(0, 14)}…（开局提示词${r.openingDelivered ? "已投递" : `未投递：${r.deliveryReason ?? "原因未知"}`}）${sessionNameClause(r)}`, r.openingDelivered && r.titleApplied !== false ? "info" : "error");
            await resolveBinding(state.projectId);
            await renderConfig();
          } catch (e) { showBanner(`重建失败：${e.message}`, "error"); }
        };
        const mainRow = sessList.main ?? (state.context?.mainSessionId ? { sessionId: state.context.mainSessionId, liveness: null } : null);
        if (mainRow) {
          links.appendChild(row(`主会话 · ${String(mainRow.sessionId).slice(0, 14)}…`, livenessPill(mainRow.liveness), sessList.staleMain ? btn("重建并绑定主会话", rebindMain, "primary") : mk("span", "hint", "")));
        }
        // FR-84 补口（2026-10-22）：**不新建会话**的接续出口（宿主建会话不可用时的保底路径）。
        const bindBar = mk("div", "tb-bind-bar");
        if (sessionId) bindBar.appendChild(btn("用当前会话作为项目主会话", async () => {
          const r = await bindExistingSession(state.projectId, sessionId);
          if (r) { await resolveBinding(state.projectId); await renderConfig(); }
        }, "primary"));
        bindBar.appendChild(buildBindExistingControl(state.projectId, async () => { await resolveBinding(state.projectId); await renderConfig(); }));
        links.appendChild(bindBar);
        // FR-84 补口 · 续二（2026-10-22）：**先探测再动作** —— 只读探测宿主「建会话」这条路此刻通不通（**不建会话、不写数据**）。
        const probeLine = mk("p", "hint", "宿主建会话能力：未探测（点右侧按钮可只读探测）");
        bindBar.appendChild(btn("探测宿主建会话能力", async () => {
          try {
            const r = await api("GET", "/api/host/probe");
            const p = r?.probe ?? null;
            if (!p) { probeLine.textContent = "宿主建会话能力：探测无结果（宿主端口未接线）"; showBanner("探测无结果：宿主端口未接线", "error"); return; }
            const label = p.verdict === "create-available"
              ? "可用（经作用域取到 sessionController.create）"
              : p.verdict === "create-root-only"
                ? "仅根作用域可用（preset 绑定可能被拒，需作用域 shim）"
                : p.verdict === "create-unavailable"
                  ? "不可用（改绑已有会话是保底出口）"
                  : `未知：${p.verdict}`;
            probeLine.textContent = `宿主建会话能力：${label} · 作用域工厂：${p.scopeFactory} · verdict=${p.verdict}`;
            showBanner(`探测完成：${label}`, p.verdict === "create-available" ? "info" : "error");
          } catch (e) {
            probeLine.textContent = `宿主建会话能力：探测失败（${e.message}）`;
            showBanner(`探测失败：${e.message}`, "error");
          }
        }));
        links.appendChild(probeLine);
        if ((sessList.sessions ?? []).length) {
          for (const s of sessList.sessions) {
            links.appendChild(row(
              `${s.status === "approved" ? "✅ 已批准" : "⏳ 待批准"} · ${String(s.sessionId).slice(0, 14)}…`,
              livenessPill(s.liveness),
              s.status === "pending" ? btn("批准", async () => {
                try { await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/sessions/approve`, { sessionId: s.sessionId }); showBanner("已批准关联", "info"); await renderConfig(); }
                catch (e) { showBanner(`批准失败：${e.message}`, "error"); }
              }, "primary") : mk("span", "hint", ""),
            ));
          }
        } else links.appendChild(mk("p", "hint", "暂无其它会话申请"));
        links.appendChild(mk("p", "hint", "存活判定来源：宿主 `sessionQuery.observeSession`（持久化会话存在性）；判不准时显示「存在性未知」并按有效处理（不阻断打开）。主会话失效时用「重建并绑定主会话」接续。"));

        // FR-81：通知订阅（游标 + notify/wake）——工作台关着也能把任务终态闭环回目标会话
        const NOTIFY_MODES = [
          { id: "notify", label: "只通知（notify）", note: "只把终态写进任务评论，不唤醒会话" },
          { id: "notify+wake", label: "通知并唤醒（notify+wake）", note: "写评论留痕 + 唤醒目标会话投递结果摘要" },
          { id: "wake", label: "只唤醒（wake）", note: "不写评论，仅唤醒目标会话" },
        ];
        const MODE_LABEL = Object.fromEntries(NOTIFY_MODES.map((m) => [m.id, m.label]));
        const notify = card("通知订阅（FR-81）", "订阅任务终态（完成 / 受阻 / 自动阻断）；带事件游标只推未推过的，失败保留游标下轮自动重试");
        const nData = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/notify?activeOnly=0`).catch(() => null);
        const nSubs = nData?.subscriptions ?? [];
        const nSum = nData?.summary ?? { total: 0, active: 0, pending: 0, failing: 0 };
        notify.appendChild(kvList([
          ["订阅口径", "项目级（该项目全部任务）或任务级（单个任务）"],
          ["事件游标", "只推游标之后的未推事件；失败不推进游标（不静默丢失）"],
          ["投递通道", "复用 FR-71 的会话投递（sessionController.prompt）"],
        ]));
        const nSumBar = mk("div", "notify-summary");
        nSumBar.append(
          pill(`订阅 ${nSum.total}`, ""),
          pill(`启用 ${nSum.active}`, nSum.active > 0 ? "ok" : ""),
          pill(`待推送 ${nSum.pending}`, nSum.pending > 0 ? "accent" : ""),
          pill(`投递失败 ${nSum.failing}`, nSum.failing > 0 ? "danger" : ""),
        );
        notify.appendChild(nSumBar);
        const nSession = mk("input", "notify-input");
        nSession.placeholder = "目标会话 ID（工作台关着时把终态投递到这条会话）";
        nSession.value = sessionId ? String(sessionId) : "";
        notify.appendChild(row("目标会话", nSession));
        const nMode = mk("select");
        for (const m of NOTIFY_MODES) nMode.appendChild(option(m.id, m.label));
        nMode.value = "notify+wake";
        const nModeNote = mk("p", "hint", NOTIFY_MODES.find((m) => m.id === nMode.value)?.note ?? "");
        nMode.addEventListener("change", () => { nModeNote.textContent = NOTIFY_MODES.find((m) => m.id === nMode.value)?.note ?? ""; });
        notify.appendChild(row("交付模式", nMode));
        const nTask = mk("input", "notify-input");
        nTask.placeholder = "任务标识（可空；空 = 项目级订阅）";
        notify.appendChild(row("订阅范围", nTask));
        notify.appendChild(nModeNote);
        const nBar = mk("div", "btn-row");
        nBar.append(
          btn("新建订阅", async () => {
            const sid = nSession.value.trim();
            if (!sid) { showBanner("请先填写目标会话 ID", "error"); return; }
            try {
              await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/notify`, { taskRef: nTask.value.trim() || null, sessionId: sid, mode: nMode.value });
              showBanner(`已订阅：${nMode.value} → ${sid}`, "info");
              await renderConfig();
            } catch (e) { showBanner(`订阅失败：${e.message}`, "error"); }
          }, "primary"),
          btn("预览待推送", async () => {
            try {
              const q = new URLSearchParams({ limit: "20" });
              if (nTask.value.trim()) q.set("task", nTask.value.trim());
              const r = await api("GET", `/api/projects/${encodeURIComponent(state.projectId)}/notify/events?${q.toString()}`);
              showBanner(`游标 ${r.since} → ${r.cursor}：待推送 ${r.count} 条${(r.kinds ?? []).length ? `（${r.kinds.join(" / ")}）` : ""}`, "info");
            } catch (e) { showBanner(`预览失败：${e.message}`, "error"); }
          }),
          btn("推送一轮", async () => {
            try {
              const r = await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/notify/flush`, {});
              const rows = r.results ?? [];
              const ok = rows.filter((x) => x.delivered).length;
              const bad = rows.filter((x) => !x.delivered && x.error).length;
              const idle = rows.filter((x) => x.reason === "no-terminal-events").length;
              showBanner(`推送一轮：订阅 ${r.count} 条 · 成功 ${ok} · 失败 ${bad}${idle ? ` · 无待推 ${idle}` : ""}`, bad > 0 ? "error" : "info");
              await renderConfig();
            } catch (e) { showBanner(`推送失败：${e.message}`, "error"); }
          }),
        );
        notify.appendChild(nBar);
        if (!nSubs.length) {
          notify.appendChild(mk("p", "hint notify-empty", "暂无订阅：填「目标会话」后点「新建订阅」（空任务标识 = 订阅该项目全部任务）。"));
        } else {
          const nList = mk("div", "notify-list");
          for (const sub of nSubs) {
            const owner = sub.taskId ? state.tasks.find((t) => t.id === sub.taskId) : null;
            const pend = sub.pending ?? { count: 0, cursor: sub.lastCursor, kinds: [] };
            const item = mk("div", `notify-sub${sub.active ? "" : " is-off"}${sub.lastError ? " is-failing" : ""}`);
            const head = mk("div", "notify-sub-head");
            head.append(
              pill(MODE_LABEL[sub.mode] ?? sub.mode, sub.active ? "accent" : ""),
              mk("span", "notify-scope", sub.scope === "task" ? `任务 ${owner?.identifier ?? sub.taskId}` : "项目级（全部任务）"),
              mk("span", "notify-session", `→ ${String(sub.sessionId).slice(0, 16)}…`),
            );
            item.appendChild(head);
            item.appendChild(mk("div", "notify-meta",
              `游标 ${sub.lastCursor}${pend.count > 0 ? ` → ${pend.cursor}（待推 ${pend.count}${(pend.kinds ?? []).length ? `：${pend.kinds.join(" / ")}` : ""}）` : ""} · 已投递 ${sub.deliveredCount} · 失败 ${sub.failedCount}${sub.lastDeliveryAt ? ` · 末次 ${fmtTime(sub.lastDeliveryAt)}` : ""}`));
            if (sub.lastError) item.appendChild(mk("div", "notify-error", `最近失败：${sub.lastError}`));
            const acts = mk("div", "notify-actions");
            acts.append(
              btn("推送", async () => {
                try {
                  const r = await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/notify/flush`, { subId: sub.id });
                  const it = (r.results ?? [])[0] ?? {};
                  if (it.delivered) { showBanner(`已推送 ${it.count} 条${(it.kinds ?? []).length ? `（${it.kinds.join(" / ")}）` : ""}`, "info"); await renderConfig(); }
                  else if (it.reason === "no-terminal-events") showBanner("没有待推送的终态事件", "info");
                  else showBanner(`推送失败：${it.error ?? "未知原因"}`, "error");
                } catch (e) { showBanner(`推送失败：${e.message}`, "error"); }
              }),
              btn(sub.active ? "停用" : "启用", async () => {
                try { await api("PATCH", `/api/notify/${encodeURIComponent(sub.id)}`, { active: !sub.active }); showBanner(sub.active ? "已停用（保留游标，可再启用）" : "已重新启用", "info"); await renderConfig(); }
                catch (e) { showBanner(e.message, "error"); }
              }),
              btn("游标归零", async () => {
                if (!window.confirm("把游标归零？下一轮推送会重新推送该项目/任务的全部终态事件。")) return;
                try { await api("PATCH", `/api/notify/${encodeURIComponent(sub.id)}`, { since: 0 }); showBanner("游标已归零", "info"); await renderConfig(); }
                catch (e) { showBanner(e.message, "error"); }
              }),
              btn("删除", async () => {
                if (!window.confirm("删除该订阅？（软停用：保留游标与历史，可再启用）")) return;
                try { await api("DELETE", `/api/notify/${encodeURIComponent(sub.id)}`); showBanner("已删除订阅（软停用）", "info"); await renderConfig(); }
                catch (e) { showBanner(e.message, "error"); }
              }),
            );
            item.appendChild(acts);
            nList.appendChild(item);
          }
          notify.appendChild(nList);
        }

        box.append(bind, init, eng, req, sess, exec, notify, links, ops);
        const note = mk("p", "hint", "（配置项为动作入口；持久化配置见插件设置页）");
        note.classList.add("config-note");
        box.appendChild(note);
        configRoot.replaceChildren(box);
      } catch (error) {
        configRoot.replaceChildren(mk("p", "hint", `加载失败：${error.message}`));
      }
    }

    // ------------------------------------------------------------ 需求视图（文档 + 条目 + 详情）
    const reqState = {
      docId: null, itemId: null, editingDoc: false, candidates: [], filter: "all", q: "", selected: new Set(),
      // 卡 `-160` 收尾（2026-10-27）：列表内「完成度结论」的懒取缓存 —— identifier → { at, payload }。
      // `completionInflight` 去重在途请求（同一行不重复打），`focusCompletion` 是「点胶囊 ⇒ 抽屉滚到完成度段」的一次性定位标记。
      completion: new Map(), completionInflight: new Set(), focusCompletion: false,
    };
    const AI_PROMPT = "请阅读「需求文档」中的资料，把项目需求梳理成「需求条目」：\n- 每条：标题 + 说明 + 验收要点 + 优先级；\n- 归并同类、剔除纯资料索引项；\n- 产出候选项，供人工逐条确认。";
    const TEAM_ENGINES = [
      { id: "official", label: "DSH 官方自带（智能体团队/编队）", tools: "spawn_teammate · team_task_*", note: "由 Lead 用 spawn_teammate 召集成员；编队 UI 是它" },
      { id: "nanmicoder", label: "第三方 @nanmicoder/dsh-agent-teams", tools: "agent_teams_create", note: "经 agent_teams_create 建团队（.agent-teams/）" },
      { id: "instruction", label: "指令降级（P2，仅记账）", tools: "—", note: "不驱动任何团队插件，仅把派发指令发给会话/记账" },
    ];
    const teamPrompt = (engine) => {
      const roster = "成员编制（队长 lead + 规划 planner + 执行 engineer + 测试 tester + 审计 reviewer + 文档 archivist；全部 hosted，禁止 cli:claude / cli:codex）：\n- planner   规划：需求拆解 / 可行性 / 技术任务与依赖\n- engineer  执行/开发：按规格改代码，可写仓库，不 push/publish\n- tester    测试/验证：独立复跑、构造反例，不改代码\n- reviewer  审计/审查：质量门；审查未过不解锁下游\n- archivist 文档/归档：写盘文档与索引，不 commit";
      if (engine === "official") return `请用【DSH 官方自带·智能体团队】开局：作为本会话的 Lead，用 spawn_teammate 召集以下成员，并用 team_task_create 建任务看板（质量门：需求→实现→验证→审查→集成）。\n${roster}\n红线：执行侧不得置"完成"（只能提交"待验收"）；失败原样上报；不 commit/push/publish。`;
      if (engine === "nanmicoder") return `请用【@nanmicoder/dsh-agent-teams】创建一个完整执行团队（approval=required，先出计划、由人确认后再启动）：agent_teams_create({ name, approval:"required", plan:{ members:[{name,role,provider,model}], tasks:[...] } })。\n${roster}\n队长=本会话(lead)：按依赖就绪派发、汇总回流。\n红线：执行侧不得置"完成"；不 commit/push/publish。`;
      return `当前为【指令降级(P2)】：不驱动团队插件，只把以下派发指令发给会话并记账。\n${roster}\n（如需真正执行，请在配置里切换到官方或 @nanmicoder 引擎。）`;
    };
    const KICKOFF_PROMPT = "【项目开局】你是本项目队长(lead)。工作目录：<项目绝对路径>。\n① 先做「项目开局对齐」六步自检（配置页 → 项目开局对齐）：统一代码规范 / 文档驱动 / Git 协作流程 / 代码审查门 / 协作机制与知识沉淀 / 明确分工；缺哪步补哪步（依据《Vibe Coding 团队协作技巧》，对齐结果要能核验）；\n② 确认已加载「任务工作台」插件 + agent team 插件可用；\n③ 绑定项目到本会话作为初始会话；\n④ 配置「项目入口·初始化」：创建执行团队 + 约定环境约束（把①的对齐结论写进 envConfig / teamTemplate）；\n⑤ 引入项目资料（md/doc）；\n⑥ 团队完成需求梳理 → 落盘需求文档；\n⑦ 拆解成看板任务并归因；\n⑧ 授权开工 → 派发执行 → 反馈回流（执行侧不得写 done）。";
    // 从需求文档里解析"资料清单" → 引入的文件列表
    function parseIntakeFiles(body) {
      const out = []; let inList = false;
      for (const line of String(body ?? "").split("\n")) {
        if (/^##\s*资料清单/.test(line)) { inList = true; continue; }
        if (inList && /^##\s/.test(line)) break;
        if (!inList) continue;
        const m = line.match(/^-\s*`([^`]+)`\s*[—-]\s*(\d+)\s*B(.*)$/);
        if (m) out.push({ path: m[1], bytes: Number(m[2]), note: m[3].trim() });
      }
      return out;
    }

    /**
     * FR-96（2026-10-23 真机反馈「需求文档的展示按文件夹的列表样式呈现」）：
     * 「引入的文件」按**目录**归成文件夹树（纯函数 · 可直接单测）——
     *  · 只按 `/` 分层（`\` 归一为 `/`，去掉前缀 `./`）；根级文件留在 `files`；
     *  · 目录在前、文件在后，各自按中文排序（不丢也不改任何一项的 path/bytes/note）；
     *  · **单链合并**：只有一条子目录且自身无文件时并成 `a/b` 一个节点，避免层层下钻点开。
     */
    function buildFileFolderTree(files) {
      const root = { folders: new Map(), files: [] };
      for (const f of Array.isArray(files) ? files : []) {
        const raw = String(f?.path ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
        const segs = raw.split("/").filter((seg) => seg !== "");
        const name = segs.pop();
        if (!name) continue;
        let cur = root;
        for (const seg of segs) {
          if (!cur.folders.has(seg)) cur.folders.set(seg, { folders: new Map(), files: [] });
          cur = cur.folders.get(seg);
        }
        cur.files.push({ name, path: raw, bytes: Number(f?.bytes) || 0, note: f?.note ?? "" });
      }
      return finalizeFileTree(root, "");
    }

    /** FR-96 内部：递归排序 / 单链合并 / 计数（folderCount · fileTotal · byteTotal）。 */
    function finalizeFileTree(node, prefix) {
      const cmp = (a, b) => String(a).localeCompare(String(b), "zh-Hans-CN");
      const folders = [];
      for (const key of [...node.folders.keys()].sort(cmp)) {
        const built = finalizeFileTree(node.folders.get(key), prefix ? `${prefix}/${key}` : key);
        folders.push({ name: key, path: prefix ? `${prefix}/${key}` : key, ...built });
      }
      const merged = [];
      for (const folder of folders) {
        if (folder.folders.length === 1 && folder.files.length === 0) {
          const only = folder.folders[0];
          merged.push({ ...only, name: `${folder.name}/${only.name}` });
        } else merged.push(folder);
      }
      const files = node.files.slice().sort((a, b) => cmp(a.name, b.name));
      const folderCount = merged.reduce((n, f) => n + 1 + f.folderCount, 0);
      const fileTotal = files.length + merged.reduce((n, f) => n + f.fileTotal, 0);
      const byteTotal = files.reduce((n, f) => n + f.bytes, 0) + merged.reduce((n, f) => n + f.byteTotal, 0);
      return { folders: merged, files, folderCount, fileTotal, byteTotal };
    }

    /** FR-96：渲染文件夹树 —— 叶子是文件；节点可展开/收起，**默认展开**（不隐藏任何文件）。 */
    function renderFileTree(tree) {
      const wrap = mk("div", "req-tree");
      const walk = (node, container) => {
        for (const folder of node.folders) {
          const details = mk("details", "req-folder");
          details.open = true;
          const summary = mk("summary", null);
          summary.append(mk("span", "req-folder-name", `${folder.name}/`), pill(`${folder.fileTotal} 个文件`));
          details.appendChild(summary);
          const body = mk("div", "req-folder-body");
          walk(folder, body);
          details.appendChild(body);
          container.appendChild(details);
        }
        if (node.files.length) {
          const ul = mk("ul", "req-list-files");
          for (const f of node.files) {
            const li = mk("li", "req-file");
            li.title = f.path;
            li.append(mk("span", "req-file-name", f.name), mk("span", "spacer"), pill(`${f.bytes} B`));
            ul.appendChild(li);
          }
          container.appendChild(ul);
        }
      };
      walk(tree, wrap);
      return wrap;
    }

    /** FR-96：一键展开 / 收起本区块内的所有文件夹。 */
    function setAllFolders(sectionEl, open) {
      for (const d of sectionEl.querySelectorAll("details.req-folder")) d.open = Boolean(open);
    }

    // ---- 卡 `-160` 收尾（2026-10-27）：需求条目**列表内**的「完成度结论」
    // 验收原文第二条：「Given 任一条目，Then 列表内**直接可见**其状态与**完成度结论入口**，不必逐条打开详情」。
    // 上一轮只把终态做显式化，完成度仍只在抽屉里 ⇒ 本轮把结论搬到行上。
    // 取数**复用既有只读端点** `GET /api/requirements/items/:ref/completion`（FR-91 已落地）——
    // **不新增取数通道**、不改后端：逐行懒取 + TTL 缓存 + 并发上限 + 在途去重，取到后**原地更新**该行胶囊
    // （不整表重渲染，避免闪烁、滚动位置丢失与请求风暴）。
    const REQ_COMPLETION_TTL = 20000;         // 缓存新鲜度：20s 内复用，过期只重取不先清空（先显示旧值再刷新）
    const REQ_COMPLETION_CONCURRENCY = 4;     // 并发上限：122 条真机数据下也不会一次打满
    /** 一句话结论（压缩到能放进一行定宽胶囊；完整 `text` 进 title / 抽屉）。 */
    const reqCompletionLabel = (c) => {
      if (!c) return "…";
      if (c.verdict === "no-tasks") return "无任务";
      if (c.ready) return "可收口";
      if (c.verdict === "blocked") return `受阻 ${c.counts?.blocked ?? 0}`;
      if (c.verdict === "in-review") return `待验收 ${c.counts?.in_review ?? 0}`;
      return `${c.closed ?? 0}/${c.total ?? 0} 收口`;
    };
    /** 四档配色类名（与 `is-done` / `is-closed` 的终态色同一套变量）。 */
    const reqVerdictClass = (c) => (c?.ready ? "is-ready"
      : c?.verdict === "blocked" ? "is-blocked"
        : c?.verdict === "in-review" ? "is-review"
          : c?.verdict === "no-tasks" ? "is-none" : "is-progress");
    const reqCompletionChip = (it, c) => {
      const chip = mk("button", `chip req-completion-chip ${reqVerdictClass(c)}${c ? "" : " is-loading"}`);
      chip.type = "button";
      chip.dataset.reqCompletion = it.identifier;
      chip.textContent = reqCompletionLabel(c);
      if (c) chip.dataset.verdict = c.verdict;
      chip.title = c
        ? `完成度：${c.text}（点此打开详情看关联任务）`
        : "完成度读取中…（复用既有 GET /api/requirements/items/:ref/completion，不新增取数通道）";
      chip.setAttribute("aria-label", `完成度：${reqCompletionLabel(c)}`);
      chip.addEventListener("click", (e) => {
        e.stopPropagation();   // 行点击也会开抽屉，这里显式先定位到「关联任务完成情况」
        reqState.itemId = it.identifier;
        reqState.focusCompletion = true;
        void renderRequirements();
      });
      return chip;
    };
    const reqCompletionNode = (identifier) => {
      const escaped = window.CSS?.escape ? window.CSS.escape(identifier) : String(identifier).replace(/["\\]/g, "\\$&");
      return reqRoot.querySelector(`.req-completion-chip[data-req-completion="${escaped}"]`);
    };
    /** 原地刷新**一行**的完成度胶囊（顺带写回缓存）。 */
    const paintReqCompletion = (it, payload) => {
      if (!payload) return;
      reqState.completion.set(it.identifier, { at: Date.now(), payload });
      const chip = reqCompletionNode(it.identifier);
      if (!chip) return;   // 列表已重渲染 ⇒ 新行会从缓存直接画出，无需在这里补
      chip.textContent = reqCompletionLabel(payload);
      chip.dataset.verdict = payload.verdict;
      chip.className = `chip req-completion-chip ${reqVerdictClass(payload)}`;
      chip.title = `完成度：${payload.text}（点此打开详情看关联任务）`;
      chip.setAttribute("aria-label", `完成度：${reqCompletionLabel(payload)}`);
    };
    /** 按并发上限逐行懒取；每条取完即 `onChange()`（用于面板头「可收口 N」计数）。 */
    async function hydrateReqCompletions(items, onChange) {
      const queue = items.filter((it) => {
        const hit = reqState.completion.get(it.identifier);
        const fresh = hit && Date.now() - hit.at < REQ_COMPLETION_TTL;
        return !fresh && !reqState.completionInflight.has(it.identifier);
      });
      if (!queue.length) { onChange?.(); return; }
      for (const it of queue) reqState.completionInflight.add(it.identifier);
      let cursor = 0;
      const worker = async () => {
        while (cursor < queue.length) {
          const it = queue[cursor++];
          try {
            const payload = await api("GET", `/api/requirements/items/${encodeURIComponent(it.identifier)}/completion`);
            paintReqCompletion(it, payload);
          } catch { /* 单条失败不打断整页：胶囊留「…」，点开详情会重新取（详情端点自带 completion） */ }
          finally {
            reqState.completionInflight.delete(it.identifier);
            onChange?.();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(REQ_COMPLETION_CONCURRENCY, queue.length) }, () => worker()));
    }

    async function renderRequirements() {
      reqRoot.replaceChildren(mk("p", "hint", "加载需求…"));
      try {
        if (!state.projectId) { reqRoot.replaceChildren(mk("p", "hint", "请先选择项目")); return; }
        const q = encodeURIComponent(state.projectId);
        const [docs, items] = await Promise.all([
          api("GET", `/api/requirements/docs?project=${q}`),
          api("GET", `/api/requirements/items?project=${q}`),
        ]);
        const box = mk("div", "req-stack");
        const doc = docs.docs.find((d) => d.id === reqState.docId) ?? docs.docs[0] ?? null;
        reqState.docId = doc?.id ?? null;

        // —— 文档面板
        // FR-91（真机反馈「需求文档未关联，请帮我补齐」）：本项目需求文档正文**被旧版「新建文档」清成了 0 字节**
        // （该按钮带 `body:""` 走 update ⇒ 覆盖；服务端已修）。这里把入口改对：已有文档时不再给「新建文档」
        // （那只会再清一次），改成「同步工作区资料」—— 用产品自己的 intake 从工作区重新生成正文索引。
        const newDocBtn = btn("新建文档", async () => {
          try { const r = await api("POST", "/api/requirements/docs", { projectId: state.projectId, body: "" }); reqState.docId = r.doc.id; reqState.editingDoc = true; await renderRequirements(); }
          catch (e) { showBanner(`新建文档失败：${e.message}`, "error"); }
        });
        const syncDocBtn = btn("同步工作区资料", async () => {
          try {
            const r = await api("POST", `/api/projects/${encodeURIComponent(state.projectId)}/intake`, { mode: "doc" });
            showBanner(`已同步工作区资料：扫描 ${r.scanned} 个文档，需求文档 v${r.doc?.version ?? "?"}（${r.doc?.bytes ?? 0} 字节）`, "info");
            await renderRequirements();
          } catch (e) { showBanner(`同步失败：${e.message}`, "error"); }
        });
        const { panel: docPanel, body: docBody } = panelEl("需求文档", ...(doc ? [syncDocBtn] : [newDocBtn]));
        if (!doc) {
          docBody.appendChild(mk("div", "empty-note", "本项目暂无需求文档，点右上角「新建文档」"));
        } else if (reqState.editingDoc) {
          const ta = mk("textarea", "req-editor");
          ta.value = doc.body ?? "";
          const bar = mk("div", "btn-row");
          bar.append(
            btn("保存", async () => {
              try { await api("PATCH", `/api/requirements/docs/${encodeURIComponent(doc.id)}`, { version: doc.version, body: ta.value }); reqState.editingDoc = false; showBanner("需求文档已保存", "info"); await renderRequirements(); }
              catch (e) { showBanner(`保存失败：${e.message}`, "error"); }
            }, "primary"),
            btn("取消", () => { reqState.editingDoc = false; void renderRequirements(); }),
            btn("AI 拆解", async () => {
              try { const r = await api("POST", `/api/requirements/docs/${encodeURIComponent(doc.id)}/elaborate`, { mode: "auto" }); reqState.candidates = r.candidates ?? []; showBanner(`拆解：mode=${r.mode}${r.degraded ? "（降级：" + (r.aiError ?? "无AI") + "）" : ""} 候选=${reqState.candidates.length}`, r.degraded ? "error" : "info"); await renderRequirements(); }
              catch (e) { showBanner(`拆解失败：${e.message}`, "error"); }
            }),
          );
          docBody.append(ta, bar);
        } else {
          docBody.appendChild(mk("div", "req-meta", `v${doc.version} · 更新 ${fmtTime(doc.updatedAt)}`));
          if (!String(doc.body ?? "").trim()) {
            docBody.appendChild(mk("div", "req-warn", "⚠ 需求文档正文为空 —— 旧版「新建文档」会把已有正文覆盖成空（服务端已修）。点右上角「同步工作区资料」从工作区重新生成正文，或用下方「编辑」手工补回。"));
          }
          // (a) AI 拆解提示词
          // 2026-10-27 真机批注（需求页太挤）：提示词正文**常驻**占了整屏 —— 改为折叠，默认收起，
          // 标题里带上「点击展开」，展开后才显示正文与「复制提示词」。
          const ps = mk("details", "req-section");
          const psSum = mk("summary", "req-fold-sum");
          psSum.append(mk("span", null, "AI 拆解提示词"), mk("span", "hint", "（点击展开 / 复制）"));
          ps.appendChild(psSum);
          ps.appendChild(mk("div", "req-desc", AI_PROMPT));
          ps.appendChild(btn("复制提示词", () => { void copyText(AI_PROMPT).then((ok) => showBanner(ok ? "已复制提示词" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制提示词", ok ? "info" : "error")); }));
          docBody.appendChild(ps);
          // (b) 引入的文件列表（来自文档"资料清单"）
          // FR-96（2026-10-23 真机反馈「需求文档的展示按文件夹的列表样式呈现」）：
          // 181 个文件平铺成一列无从查阅 ⇒ 按**目录**归成文件夹树（可展开/收起），文件名只在叶子里显示
          // （完整路径放 `title`）。文件一个不丢：默认全部展开。
          const files = parseIntakeFiles(doc.body);
          // 2026-10-27 真机批注：文件树常驻同样挤占页面 —— 改为折叠（默认收起），
          // **计数与体积留在 summary 上**（不展开也知道有多少），展开后才有「全部展开/收起」与树。
          const fs = mk("details", "req-section");
          if (files.length) {
            const tree = buildFileFolderTree(files);
            const head = mk("summary", "req-fold-sum req-files-head");
            head.append(
              mk("span", null, `引入的文件（${files.length}）`),
              mk("span", "hint", `${tree.folderCount} 个文件夹 · 根级文件 ${tree.files.length} · 合计 ${(tree.byteTotal / 1024).toFixed(1)} KB`),
            );
            fs.appendChild(head);
            const bar = mk("div", "field-inline");
            bar.append(btn("全部展开", () => setAllFolders(fs, true)), btn("全部收起", () => setAllFolders(fs, false)));
            fs.appendChild(bar);
            fs.appendChild(renderFileTree(tree));
          } else {
            const head = mk("summary", "req-fold-sum");
            head.appendChild(mk("span", null, "引入的文件（0）"));
            fs.appendChild(head);
            fs.appendChild(mk("div", "empty-note", "未见「资料清单」（可能尚未引入，或为手工编写的文档）"));
          }
          docBody.appendChild(fs);
          // (c) 原始内容（折叠）
          const raw = mk("details", "req-section");
          raw.appendChild(mk("summary", null, "查看原始内容"));
          raw.appendChild(mk("pre", "req-body", doc.body || "（空）"));
          docBody.appendChild(raw);
          const bar = mk("div", "btn-row");
          bar.append(
            btn("编辑", () => { reqState.editingDoc = true; void renderRequirements(); }, "primary"),
            btn("AI 拆解（auto）", async () => {
              try { const r = await api("POST", `/api/requirements/docs/${encodeURIComponent(doc.id)}/elaborate`, { mode: "auto" }); reqState.candidates = r.candidates ?? []; showBanner(`拆解：mode=${r.mode}${r.degraded ? "（降级：" + (r.aiError ?? "无AI") + "）" : ""} 候选=${reqState.candidates.length}`, r.degraded ? "error" : "info"); await renderRequirements(); }
              catch (e) { showBanner(`拆解失败：${e.message}`, "error"); }
            }),
          );
          docBody.appendChild(bar);
        }

        // —— 条目面板（新建 + 筛选 + 确认/删除；FR-64/65 便于人工查阅确认）
        const allItems = items.items;
        // 卡 `-160`（2026-10-27）：**完成 / 关闭状态显式化** —— 此前面板头只报「待确认 N · 已确认 N」，
        // 「这条需求做完了没有」在面板层完全读不出来（要一条条点开抽屉才知道）。
        // 四态计数一次摆出，与下方状态筛选下拉（draft/open/done/closed）同口径、同顺序。
        const countByStatus = (s) => allItems.filter((it) => it.status === s).length;
        const draftCount = countByStatus("draft");
        const openCount = countByStatus("open");
        const doneCount = countByStatus("done");
        const closedCount = countByStatus("closed");
        // 卡 `-160` 收尾：面板头再加一条「可收口 N」—— 完成度结论的**面板级**入口（行内另有逐条胶囊）。
        const readyCount = mk("span", "hint req-ready-count");
        readyCount.textContent = "完成度取数 0/0";
        const reqCounts = mk("span", "hint req-counts");
        reqCounts.append(
          mk("span", "req-count req-count-draft", `待确认 ${draftCount}`),
          mk("span", "req-count req-count-open", `在办 ${openCount}`),
          mk("span", "req-count req-count-done", `已完成 ${doneCount}`),
          mk("span", "req-count req-count-closed", `已关闭 ${closedCount}`),
          readyCount,
        );
        const { panel: itemPanel, body: itemBody } = panelEl(`需求条目（${allItems.length}）`, reqCounts);
        const newTitle = mk("input");
        newTitle.type = "text";
        newTitle.placeholder = "新条目标题";
        const createRow = mk("div", "field-inline");
        // 真机批注 2026-10-28「新建条目点击无效」：此前标题为空时**静默 return** —— 点了没反应、
        // 也没有任何提示，被读成按钮坏了。口径：空标题必须**当场说话**并把焦点送回输入框；
        // 另外支持回车提交（填完标题顺手敲回车是常态）。
        const createItem = async () => {
          const title = newTitle.value.trim();
          if (!title) { showBanner("请先输入条目标题，再点「新建条目」", "error"); newTitle.focus(); return; }
          try {
            await api("POST", "/api/requirements/items", { projectId: state.projectId, docId: reqState.docId, title });
            newTitle.value = "";
            showBanner(`已新建需求条目「${title}」`, "info");
            await renderRequirements();
          } catch (e) { showBanner(`新建失败：${e.message}`, "error"); }
        };
        const createBtn = btn("新建条目", createItem, "primary");
        createRow.append(newTitle, createBtn);
        newTitle.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          void createItem();
        });
        itemBody.appendChild(createRow);
        const filt = mk("select");
        // FR-91：新增「已完成 / 已关闭」——需求层此前没有"做完了没有"的落点
        for (const [v, l] of [["all", "全部状态"], ["draft", "待确认"], ["open", "在办"], ["done", "已完成"], ["closed", "已关闭"]]) { const o = mk("option"); o.value = v; o.textContent = l; filt.appendChild(o); }
        filt.value = reqState.filter;
        filt.addEventListener("change", () => { reqState.filter = filt.value; void renderRequirements(); });
        const search = mk("input");
        search.type = "search";
        search.placeholder = "搜索编号 / 标题";
        search.value = reqState.q ?? "";
        search.addEventListener("change", () => { reqState.q = search.value.trim(); void renderRequirements(); });
        const fr = mk("div", "field-inline");
        fr.append(filt, search);
        itemBody.appendChild(fr);
        // U-1：下一步引导（团队先行后的收敛路径）——单行，避免拥挤
        itemBody.appendChild(mk("p", "hint", `下一步：确认条目 → 生成看板任务 → 授权开工 → 派发执行　（待确认 ${draftCount} · 已确认 ${openCount}）`));
        if (reqState.candidates.length) {
          const cs = mk("div", "drawer-section");
          cs.appendChild(mk("h3", null, `待确认候选（${reqState.candidates.length}）`));
          const pending = reqState.candidates.filter((c) => (c.status ?? "pending") === "pending");
          for (const c of pending) {
            const row = mk("div", "req-candidate");
            row.append(mk("span", null, c.title ?? c.text ?? "(候选)"), mk("div", "spacer"));
            const wrap = mk("span", "btn-row");
            wrap.append(
              btn("确认", async () => { try { await api("POST", "/api/requirements/candidates/confirm", { ids: [c.id] }); await renderRequirements(); } catch (e) { showBanner(e.message, "error"); } }),
              btn("拒绝", async () => { try { await api("POST", "/api/requirements/candidates/reject", { ids: [c.id] }); await renderRequirements(); } catch (e) { showBanner(e.message, "error"); } }),
            );
            row.appendChild(wrap);
            cs.appendChild(row);
          }
          if (pending.length > 1) cs.appendChild(btn("全部确认", async () => { try { await api("POST", "/api/requirements/candidates/confirm", { ids: pending.map((c) => c.id) }); await renderRequirements(); } catch (e) { showBanner(e.message, "error"); } }, "primary"));
          if (!pending.length) cs.appendChild(mk("p", "hint", "候选已全部处理"));
          cs.appendChild(btn("清空全部候选", async () => {
            if (!window.confirm("清空该文档下全部候选？")) return;
            try { await api("DELETE", `/api/requirements/candidates?doc=${encodeURIComponent(reqState.docId)}`); showBanner("已清空候选", "info"); await renderRequirements(); }
            catch (e) { showBanner(`清空失败：${e.message}`, "error"); }
          }));
          itemBody.appendChild(cs);
        }
        const normQ = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "");
        const visible = allItems.filter((it) => (reqState.filter === "all" || it.status === reqState.filter)
          && (!reqState.q || normQ(`${it.identifier} ${it.title}`).includes(normQ(reqState.q))));
        /** 面板头「可收口 N / 完成度取数 M/N」：随懒取进度刷新（旧闭包在重渲染后自动作废）。 */
        const refreshReadyCount = () => {
          if (!readyCount.isConnected) return;
          const total = visible.length;
          const readyIds = [];
          let fetched = 0;
          for (const it of visible) {
            const hit = reqState.completion.get(it.identifier);
            if (!hit) continue;
            fetched += 1;
            // 已达完成标准且**尚未**收口的才算「可收口」；已 done / closed 的不再计入（否则数字没意义）。
            if (hit.payload?.ready && it.status !== "done" && it.status !== "closed") readyIds.push(it.identifier);
          }
          readyCount.textContent = fetched === total ? `可收口 ${readyIds.length}` : `完成度取数 ${fetched}/${total}`;
          readyCount.title = readyIds.length
            ? `关联任务已全部收口、可人工判「已完成」的需求：${readyIds.join("、")}（自动只给建议，完成 / 关闭仍由人点）`
            : "逐行从既有 GET /api/requirements/items/:ref/completion 取数：关联任务全部收口的需求会显示「可收口」";
        };
        // 批量工具条（默认多选 → 批量生成任务）
        const bulkBar = mk("div", "field-inline");
        bulkBar.append(
          mk("span", "hint", `已选 ${reqState.selected.size}`),
          btn("全选可见", () => { for (const it of visible) reqState.selected.add(it.identifier); void renderRequirements(); }),
          btn("清除选择", () => { reqState.selected.clear(); void renderRequirements(); }),
          btn("批量确认", async () => {
            const ids = [...reqState.selected].filter((id) => allItems.find((x) => x.identifier === id && x.status === "draft"));
            if (!ids.length) { showBanner("请先勾选「待确认」条目", "error"); return; }
            // 真机批注 2026-10-28「检查所有失效按钮」：批量动作此前**吞掉每条的错误**却照报总数，
            // 一条都没成功也显示「已确认 N 条」—— 比报错更坏。改为真实计数并区分色。
            let ok = 0; const failed = [];
            for (const id of ids) { try { await api("PATCH", `/api/requirements/items/${encodeURIComponent(id)}`, { status: "open" }); ok += 1; } catch (e) { failed.push(`${id}:${e.message}`); } }
            showBanner(failed.length ? `已确认 ${ok} 条，失败 ${failed.length} 条（首条：${failed[0]}）` : `已确认 ${ok} 条`, failed.length ? "error" : "info");
            await renderRequirements();
          }),
          btn("批量生成任务", async () => {
            const ids = [...reqState.selected].filter((id) => { const x = allItems.find((y) => y.identifier === id); return x && x.status !== "draft"; });
            if (!ids.length) { showBanner("请先勾选「已确认」条目", "error"); return; }
            let n = 0; const failed = [];
            for (const id of ids) { const x = allItems.find((y) => y.identifier === id); try { await api("POST", `/api/requirements/items/${encodeURIComponent(id)}/split`, { tasks: [{ title: x.title, kind: "work" }] }); n += 1; } catch (e) { failed.push(`${id}:${e.message}`); } }
            showBanner(failed.length ? `已生成 ${n} 个任务，失败 ${failed.length} 条（首条：${failed[0]}）` : `已批量生成 ${n} 个看板任务（待办池，需授权开工）`, failed.length ? "error" : "info");
            setView("board");
          }, "primary"),
          btn("批量删除", async () => {
            const ids = [...reqState.selected];
            if (!ids.length) { showBanner("请先勾选条目", "error"); return; }
            if (!window.confirm(`删除 ${ids.length} 条需求条目？`)) return;
            let ok = 0; const failed = [];
            for (const id of ids) { try { await api("DELETE", `/api/requirements/items/${encodeURIComponent(id)}`); ok += 1; } catch (e) { failed.push(`${id}:${e.message}`); } }
            reqState.selected.clear();
            showBanner(failed.length ? `已删除 ${ok} 条，失败 ${failed.length} 条（首条：${failed[0]}）` : `已删除 ${ok} 条`, failed.length ? "error" : "info");
            await renderRequirements();
          }),
        );
        itemBody.appendChild(bulkBar);
        const ul = mk("ul", "req-list");
        for (const it of visible) {
          // 卡 `-160`：终态（done / closed）在**行上**就要可辨 —— 行加 `is-done` / `is-closed`，
          // 由 CSS 做降权（划掉标题 / 压暗 / 左侧终态色边），而不是"和别的行长得一模一样"。
          const isTerminal = it.status === "done" || it.status === "closed";
          const li = mk("li", `req-item${isTerminal ? ` is-${it.status}` : ""}${it.identifier === reqState.itemId ? " is-active" : ""}`);
          li.dataset.status = it.status;
          const statusTxt = reqStatusLabel(it.status);
          li.title = `状态：${statusTxt}`;
          const srcLabel = it.source === "intake" ? "资料索引" : it.source === "elaborated-ai" ? "AI" : it.source === "elaborated-rule" ? "规则" : "手工";
          const main = mk("div", "req-item-main");
          const cb = mk("input"); cb.type = "checkbox"; cb.checked = reqState.selected.has(it.identifier); cb.title = "选择";
          cb.addEventListener("click", (e) => { e.stopPropagation(); if (cb.checked) reqState.selected.add(it.identifier); else reqState.selected.delete(it.identifier); void renderRequirements(); });
          main.append(cb, mk("span", "req-id", it.identifier.split("-").pop() || it.identifier), mk("span", "req-title", it.title));
          // 卡 `-160`：状态抽成**独立定宽一列**（`req-status-chip`），不再和「来源 / 不可行」挤在同一排小胶囊里 ——
          // 状态是这一行最该先读到的东西，且四态各有自己的色（此前 `closed` 走默认灰胶囊，与来源胶囊看不出区别）。
          const statusChip = mk("span", `chip req-status-chip is-${it.status}`, statusTxt);
          // 卡 `-160` 收尾：**完成度结论**（关联任务的收口情况）也做成独立一列 —— 先画缓存（有就立刻可读），
          // 没有则「…」，由列表渲染后的 hydrateReqCompletions 原地补上（不整表重渲染）。
          const completionChip = reqCompletionChip(it, reqState.completion.get(it.identifier)?.payload ?? null);
          const meta = mk("div", "req-item-meta");
          meta.append(pill(srcLabel, it.source === "intake" ? "" : "accent"));
          if (it.feasibility === "infeasible") meta.append(pill("不可行", "danger"));
          li.append(main, statusChip, completionChip, meta);
          const acts = mk("div", "req-item-actions");
          if (it.status === "draft") acts.appendChild(btn("确认", (e) => { e.stopPropagation(); void (async () => { try { await api("PATCH", `/api/requirements/items/${encodeURIComponent(it.identifier)}`, { status: "open" }); await renderRequirements(); } catch (err) { showBanner(err.message, "error"); } })(); }));
          // FR-91：需求终态由**人**点（自动只给建议，见详情页「关联任务完成情况」）
          const setReq = (status, label, cls) => btn(label, (e) => { e.stopPropagation(); void (async () => {
            try { await api("PATCH", `/api/requirements/items/${encodeURIComponent(it.identifier)}`, { status, actor: "human" }); showBanner(`需求 ${it.identifier} → ${reqStatusLabel(status)}`, "info"); await renderRequirements(); }
            catch (err) { showBanner(`更新失败：${err.message}`, "error"); }
          })(); }, cls);
          if (isTerminal) acts.appendChild(setReq("open", "重新打开"));
          else { acts.appendChild(setReq("done", "标记完成", "primary")); acts.appendChild(setReq("closed", "关闭")); }
          acts.appendChild(btn("生成任务", (e) => { e.stopPropagation(); void (async () => {
            if (it.status === "draft") { showBanner("请先「确认」该条目，再生成任务", "error"); return; }
            try { const r = await api("POST", `/api/requirements/items/${encodeURIComponent(it.identifier)}/split`, { tasks: [{ title: it.title, owner: null, kind: "work" }] }); showBanner(`已生成任务 ${(r.tasks || []).map((t) => t.identifier).join("、")}（待办池，需授权开工）`, "info"); setView("board"); }
            catch (err) { showBanner(`生成任务失败：${err.message}`, "error"); }
          })(); }));
          acts.appendChild(btn("删除", (e) => { e.stopPropagation(); void (async () => { if (!window.confirm(`删除 ${it.identifier}？`)) return; try { await api("DELETE", `/api/requirements/items/${encodeURIComponent(it.identifier)}`); if (reqState.itemId === it.identifier) reqState.itemId = null; await renderRequirements(); } catch (err) { showBanner(err.message, "error"); } })(); }));
          li.appendChild(acts);
          li.addEventListener("click", () => { reqState.itemId = it.identifier; void renderRequirements(); });
          ul.appendChild(li);
        }
        if (visible.length === 0) itemBody.appendChild(mk("div", "empty-note", allItems.length ? "当前筛选无条目" : "暂无条目"));
        itemBody.appendChild(ul);
        // 卡 `-160` 收尾：行内完成度逐条懒取（**复用既有** `/completion` 端点）+ 面板头「可收口」计数。
        // 先画一次计数（缓存里已有的立刻体现），再异步补齐；每取到一条原地刷新对应的胶囊与计数。
        refreshReadyCount();
        void hydrateReqCompletions(visible, refreshReadyCount);

        // —— 详情面板
        // 2026-10-27 真机批注：「需求条目」方块改列表、**点一条用抽屉看详情**（不再常驻占位）。
        const reqBackdrop = mk("div", "tb-drawer-backdrop");
        const detailPanel = mk("aside", "tb-drawer tb-req-drawer");
        const detailHead = mk("div", "tb-drawer-head");
        const detailHeadMain = mk("div");
        detailHeadMain.appendChild(mk("h2", null, "条目详情"));
        const detailClose = mk("button", "ghost", "✕");
        detailClose.title = "关闭";
        detailClose.addEventListener("click", () => { reqState.itemId = null; void renderRequirements(); });
        /* 2026-10-28 真机批注（「详情太过靠右，内容过长不便查看」）：需求详情抽屉此前**只有 560px
           死宽、没有拖拽、没有全屏**，长描述只能一行一行挤。这里给它补上与任务抽屉同款的
           「左缘拖拽调宽 + 一键全屏」，宽度落到行内 `--drawer-width`，记忆键**独立**
           （`tb.reqDrawer.width`）—— 两个抽屉各自记各自的宽度，互不覆盖。 */
        const REQ_DRAWER_WIDTH_KEY = "tb.reqDrawer.width";
        const REQ_DRAWER_WIDTH_FULL = 0;
        const readReqDrawerWidth = () => {
          try {
            const raw = drawerWin?.localStorage?.getItem(REQ_DRAWER_WIDTH_KEY);
            if (raw === null || raw === undefined || raw === "") return null;
            const value = Number(raw);
            return Number.isFinite(value) && value >= REQ_DRAWER_WIDTH_FULL ? value : null;
          } catch (_) { return null; }
        };
        const writeReqDrawerWidth = (value) => {
          try {
            if (value === null) drawerWin?.localStorage?.removeItem(REQ_DRAWER_WIDTH_KEY);
            else drawerWin?.localStorage?.setItem(REQ_DRAWER_WIDTH_KEY, String(value));
          } catch (_) { /* 存储不可用只丢记忆，不影响布局 */ }
        };
        const detailFull = mk("button", "ghost", "全屏");
        detailFull.type = "button";
        detailFull.title = "详情铺满窗口（再点一下还原为默认宽度）";
        const syncReqDrawerWidth = () => {
          const stored = readReqDrawerWidth();
          if (stored === null) detailPanel.style.removeProperty("--drawer-width");
          else if (stored === REQ_DRAWER_WIDTH_FULL) detailPanel.style.setProperty("--drawer-width", `${drawerMaxWidth()}px`);
          else detailPanel.style.setProperty("--drawer-width", `${clampDrawerWidth(stored)}px`);
          detailFull.textContent = stored === REQ_DRAWER_WIDTH_FULL ? "还原" : "全屏";
        };
        detailFull.addEventListener("click", () => {
          const cur = readReqDrawerWidth();
          const nowFull = cur !== REQ_DRAWER_WIDTH_FULL;
          writeReqDrawerWidth(nowFull ? REQ_DRAWER_WIDTH_FULL : null);
          syncReqDrawerWidth();
        });
        const reqDrawerResize = mk("div", "tb-drawer-resize");
        reqDrawerResize.title = "拖动调整详情宽度（双击还原）";
        reqDrawerResize.addEventListener("pointerdown", (event) => {
          if (!event || event.button !== 0) return;
          const startX = event.clientX;
          const startWidth = detailPanel.getBoundingClientRect?.().width ?? 0;
          detailPanel.classList.add("dragging");
          try { reqDrawerResize.setPointerCapture?.(event.pointerId); } catch (_) { /* 捕获失败也能靠层内事件继续 */ }
          const onMove = (moveEvent) => {
            detailPanel.style.setProperty("--drawer-width", `${clampDrawerWidth(startWidth + (startX - moveEvent.clientX))}px`);
          };
          const onUp = () => {
            reqDrawerResize.removeEventListener("pointermove", onMove);
            reqDrawerResize.removeEventListener("pointerup", onUp);
            reqDrawerResize.removeEventListener("pointercancel", onUp);
            detailPanel.classList.remove("dragging");
            const finalWidth = Math.round(detailPanel.getBoundingClientRect?.().width ?? 0);
            writeReqDrawerWidth(finalWidth >= drawerMaxWidth() - 1 ? REQ_DRAWER_WIDTH_FULL : clampDrawerWidth(finalWidth));
            syncReqDrawerWidth();
          };
          reqDrawerResize.addEventListener("pointermove", onMove);
          reqDrawerResize.addEventListener("pointerup", onUp);
          reqDrawerResize.addEventListener("pointercancel", onUp);
          event.preventDefault?.();
        });
        reqDrawerResize.addEventListener("dblclick", () => { writeReqDrawerWidth(null); syncReqDrawerWidth(); });
        syncReqDrawerWidth();
        detailHead.append(detailHeadMain, mk("div", "spacer"), detailFull, detailClose);
        const detailBody = mk("div", "tb-drawer-body");
        detailBody.id = "tb-req-detail";
        detailPanel.append(reqDrawerResize, detailHead, detailBody);

        box.append(docPanel, itemPanel);
        reqRoot.replaceChildren(box, reqBackdrop, detailPanel);
        if (reqState.itemId) {
          detailPanel.classList.add("show");
          reqBackdrop.classList.add("show");
          void renderItemDetail(reqState.itemId);
        } else {
          detailBody.appendChild(mk("p", "hint", "从列表点一条查看详情"));
        }
        reqBackdrop.addEventListener("click", () => { reqState.itemId = null; void renderRequirements(); });
      } catch (error) {
        reqRoot.replaceChildren(mk("p", "hint", `加载失败：${error.message}`));
      }
    }

    async function renderItemDetail(identifier) {
      const host = reqRoot.querySelector("#tb-req-detail");
      if (!host) return;
      // 卡 `-160` 收尾：点行内「完成度胶囊」进来时，允许这一次渲染滚到「关联任务完成情况」段。
      // 一次性消费（避免之后任何一次详情刷新都抢滚动位置）。
      const focusCompletion = reqState.focusCompletion;
      reqState.focusCompletion = false;
      host.replaceChildren(mk("p", "hint", "加载条目…"));
      try {
        const ref = encodeURIComponent(identifier);
        const { item, completion } = await api("GET", `/api/requirements/items/${ref}`);
        // 详情端点本身就带 completion（既有 FR-91 口径，不改后端）—— 顺带回写列表缓存，
        // 免得刚看完详情回到列表还读到 20s 前的旧结论。
        if (completion) reqState.completion.set(identifier, { at: Date.now(), payload: completion });
        const graph = await api("GET", `/api/requirements/items/${ref}/graph`).catch(() => ({ nodes: [], edges: [] }));
        host.replaceChildren();
        const head = mk("div", "req-detail-head");
        head.appendChild(mk("p", "req-meta", item.identifier));
        head.appendChild(mk("h2", null, item.title));
        host.appendChild(head);
        const srcLabel = item.source === "intake" ? "资料索引(引入)" : item.source === "elaborated-ai" ? "AI 拆解" : item.source === "elaborated-rule" ? "规则拆解" : "手工";
        const statusTxt = reqStatusLabel(item.status);
        const dl = mk("dl", "req-fields");
        const addF = (k, v, cls) => { dl.appendChild(mk("dt", null, k)); const dd = mk("dd", null, v); if (cls) dd.className = cls; dl.appendChild(dd); };
        addF("状态", statusTxt);
        addF("来源", srcLabel);
        addF("优先级", PRIORITY_LABELS[item.priority] ?? item.priority);
        addF("可行性", item.feasibility ?? "未评估", item.feasibility === "infeasible" ? "danger" : item.feasibility === "feasible" ? "ok" : "");
        if (item.acceptance) addF("验收要点", item.acceptance);
        host.appendChild(dl);
        if (item.description) {
          const sec = mk("section", "req-section");
          sec.appendChild(mk("h3", null, "说明 / 来源内容"));
          const desc = mk("div", "req-desc", item.description);
          sec.appendChild(desc);
          if (item.description.length > 400) {
            const t = mk("button", "ghost", "展开全文");
            t.type = "button";
            t.addEventListener("click", () => { desc.classList.toggle("is-expanded"); t.textContent = desc.classList.contains("is-expanded") ? "收起" : "展开全文"; });
            sec.appendChild(t);
          }
          host.appendChild(sec);
        }

        // FR-91：关联任务的完成情况 —— 真机反馈「点击需求条目打开需求详情，展示需求内容情况同时，
        // 展示关联需求的任务完成列表情况，以供自动/人工评审需求是否完成」。左边是**自动结论**（可核验），
        // 右边是**人工确认**（终态只能人点，与 FR-85 同一红线：自动只给建议、不替人收口）。
        {
          const c = completion ?? { total: 0, counts: {}, verdict: "no-tasks", ready: false, text: "尚无关联任务" };
          const counts = c.counts ?? {};
          const sec2 = mk("section", "req-section");
          sec2.appendChild(mk("h3", null, `关联任务完成情况（${c.total ?? 0} 个任务）`));
          sec2.appendChild(mk("div", `req-completion-verdict ${c.ready ? "ok" : c.verdict === "blocked" ? "bad" : "warn"}`, `${c.ready ? "自动结论：达到完成标准" : "自动结论：尚未完成"} —— ${c.text}`));
          sec2.appendChild(mk("p", "hint", `完成 ${counts.done ?? 0} · 已取消 ${counts.canceled ?? 0} · 待验收 ${counts.in_review ?? 0} · 受阻 ${counts.blocked ?? 0} · 进行中 ${counts.in_progress ?? 0} · 待办 ${(counts.backlog ?? 0) + (counts.todo ?? 0)}`));
          const tul = mk("ul", "req-task-list");
          for (const t of (c.tasks ?? [])) {
            const li = mk("li", "req-task-row");
            li.append(statusPill(t.status), mk("span", "req-task-title", `${t.identifier} ${t.title ?? ""}`));
            if (t.reviewState) li.appendChild(pill(`评审:${t.reviewState}`, t.reviewState === "changes_requested" ? "warn" : "accent"));
            const openT = mk("button", "ghost", "打开任务");
            openT.type = "button";
            openT.addEventListener("click", () => void openTaskByRef(t.identifier));
            li.appendChild(openT);
            tul.appendChild(li);
          }
          if (!(c.tasks ?? []).length) tul.appendChild(mk("div", "empty-note", "尚无关联任务：先用下方「生成看板任务（分拆）」建任务，再回来评审。"));
          sec2.appendChild(tul);
          const hbar = mk("div", "btn-row");
          const setReqStatus = async (status, label, force = false) => {
            if (!force && status === "done" && !c.ready) {
              if (!window.confirm(`自动结论认为尚未完成：${c.text}\n仍要强制标记「已完成」吗？（会记审计）`)) return;
            }
            try { await api("PATCH", `/api/requirements/items/${ref}`, { status, actor: "human", reason: c.verdict }); showBanner(`需求 ${item.identifier} → ${label}`, "info"); await renderItemDetail(identifier); await renderRequirements(); }
            catch (e) { showBanner(`更新失败：${e.message}`, "error"); }
          };
          if (item.status === "done" || item.status === "closed") {
            hbar.appendChild(btn("重新打开（回到在办）", () => void setReqStatus("open", "在办", true), "primary"));
          } else {
            hbar.appendChild(btn("人工确认：标记需求完成", () => void setReqStatus("done", "已完成"), "primary"));
            hbar.appendChild(btn("关闭需求（不再做）", () => void setReqStatus("closed", "已关闭", true)));
          }
          sec2.appendChild(hbar);
          sec2.appendChild(mk("p", "hint", "红线：自动只给结论，需求的「完成 / 关闭」由人确认（与任务「完成只能人点」同口径）。"));
          // 卡 `-160` 收尾：行内「完成度胶囊」即这条结论的**入口** —— 点它开抽屉并直接定位到这一段。
          sec2.dataset.reqSection = "completion";
          host.appendChild(sec2);
          if (focusCompletion) requestAnimationFrame(() => sec2.scrollIntoView({ block: "start" }));
        }

        const feas = mk("section", "req-section");
        feas.appendChild(mk("h3", null, "可行性门"));
        const feasRow = mk("div", "btn-row");
        feasRow.append(
          btn("标记可行", async () => {
            try { await api("POST", `/api/requirements/items/${ref}/feasibility`, { verdict: "feasible", by: "human" }); showBanner(`已标记可行：${item.identifier}`, "info"); await renderItemDetail(identifier); }
            catch (e) { showBanner(`失败：${e.message}`, "error"); }
          }, "primary"),
          btn("人工判为不可行（否决）", async () => {
            try { await api("POST", `/api/requirements/items/${ref}/feasibility`, { verdict: "infeasible", reason: "人工否决", by: "human", override: `human@${new Date().toISOString()}` }); await renderItemDetail(identifier); }
            catch (e) { showBanner(`否决失败：${e.message}`, "error"); }
          }),
        );
        feas.appendChild(feasRow);
        if (item.feasibilityReason) feas.appendChild(mk("p", "hint", `结论说明：${item.feasibilityReason}`));
        host.appendChild(feas);

        /* 2026-10-28 真机批注：「生成看板任务（分拆）」此前**只有人工 textarea** ——
           没有建议、没有草稿、没有修订回路。按人拍口径 **方案 C（走项目主会话）** 补两件事：
           ① 「自动生成（交主会话）」＝ 投一条指令给项目主会话，让它先出**建议**（不建卡）；
           ② 「按意见重生成」＝ 带上上一版草稿 + 人的修改意见再投一次（同一端点，无状态）；
           ③ 人把主会话回帖里的任务行粘回下面的框 → 点「生成任务 + 依赖」才**真落库**。
           顺带修掉两个"界面承诺 ≠ 实现"：`kind` 不再被丢（落标签 `kind/work|review`）、
           依赖列终于有输入口（`依赖` 填前置**序号**，多个用逗号）。 */
        const split = mk("section", "req-section req-split-collapsed");
        split.appendChild(mk("h3", null, "生成看板任务（分拆）"));
        const splitHint = mk("p", "hint", "草稿 → 修订 → 落库：先让主会话出建议，改到满意再粘回来生成。生成的是「待办池」卡，另需授权开工。");
        split.appendChild(splitHint);
        const ta = mk("textarea", "req-editor");
        ta.placeholder = "每行一个任务：序号 | 标题 | 负责人(planner/engineer/tester/reviewer/archivist，可空) | kind(work/review，可空) | 依赖(前置序号，如 1,2，可空)\n例：1 | 补抽屉宽度 | engineer | work |\n    2 | 真机复验 | tester | review | 1";
        split.appendChild(ta);
        const feedback = mk("textarea", "req-editor");
        feedback.placeholder = "修改意见（可选）：例如「测试那条拆细成单测+真机两行」「去掉归档任务」「依赖要显式写出来」";
        split.appendChild(feedback);
        const splitActions = mk("div", "btn-row");
        let lastLines = [];
        const splitAsk = async (kindLabel) => {
          const rows = ta.value.split("\n").map((l) => l.trim()).filter(Boolean);
          const note = feedback.value.trim();
          if (kindLabel === "revise" && !note) { showBanner("先写一句修改意见，再点「按意见重生成」", "error"); return; }
          try {
            const r = await api("POST", `/api/requirements/items/${ref}/split-ask`, {
              feedback: note || null,
              previous: kindLabel === "revise" ? (lastLines.length ? lastLines : rows) : rows,
            });
            if (!r.delivered) { showBanner(`没投出去（${r.reason ?? "原因不明"}）：${r.nextAction ?? ""}`, "error"); return; }
            lastLines = rows; // 下一轮「按意见重生成」把它作为"上一版草稿"带过去
            showBanner(`已投给项目主会话（${String(r.sessionId ?? "").slice(0, 8)}…）：去会话看建议，把其中的任务行粘回上面的框，再点「生成任务 + 依赖」落库。`, "info");
          } catch (e) {
            // 新端点是**服务端路由**：宿主未重载时这里会 404（旧插件不认识这条路径）。
            // 如实指路，而不是让人对着「投递失败：HTTP 404」猜。
            const notFound = e.code === "NOT_FOUND" || /HTTP 404|not found/i.test(String(e.message ?? ""));
            showBanner(notFound
              ? "当前运行的插件还没有这个端点（需要重载宿主插件后才生效）。可直接把修改意见写在聊天里让主会话协助拆分，或找队长做一次宿主重载。"
              : `投递失败：${e.message}`, notFound ? "info" : "error");
          }
        };
        splitActions.append(
          hostBtn("自动生成（交主会话）", () => void splitAsk("draft"), "primary"),
          hostBtn("按意见重生成", () => void splitAsk("revise")),
        );
        split.appendChild(splitActions);
        split.appendChild(btn("生成任务 + 依赖", async () => {
          const parsed = parseSplitLines(ta.value);
          const tasks = parsed
            ? parsed.tasks
            : ta.value.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
              const [title, owner, kind] = line.split("|").map((s) => (s ?? "").trim());
              return { title, owner: owner || null, kind: kind || null };
            });
          if (!tasks.length) { showBanner("请先填写任务行", "error"); return; }
          if (parsed && parsed.problems.length) showBanner(`有 ${parsed.problems.length} 处没解析上（已按能认的生成）：${parsed.problems.slice(0, 3).join("；")}`, "error");
          try { const r = await api("POST", `/api/requirements/items/${ref}/split`, { tasks }); showBanner(`已生成 ${(r.tasks || []).length} 个任务：${(r.tasks || []).map((t) => t.identifier).join("、")}（待办池，需授权开工）`, "info"); await renderItemDetail(identifier); }
          catch (e) { showBanner(`分拆失败：${e.message}`, "error"); }
        }, "primary"));
        host.appendChild(split);

        host.appendChild(mk("h3", null, `任务 DAG（${graph.nodes.length} 节点 / ${graph.edges.length} 依赖）`));
        if (graph.nodes.length > 0) host.appendChild(mk("p", "hint", "按依赖顺序排列（前置在上）；点任意节点打开该任务，悬停前置胶囊可看原因"));
        const dag = mk("div", "req-dag");
        for (const n of graph.nodes) {
          // 真机批注 2026-10-29：DAG 节点原来只是纯展示的 div（"受阻 dag 提醒点不进去"）——
          // 与「关联任务完成情况」里那行是同一张卡，这里必须同样能打开；用 button 顺带拿到键盘可达。
          const node = mk("button", "req-node");
          node.type = "button";
          node.title = `打开任务 ${n.identifier}`;
          node.addEventListener("click", () => void openTaskByRef(n.identifier));
          node.append(statusPill(n.status), mk("span", "req-node-title", `${n.identifier} ${n.title}`));
          // 二轮优化（同日）：「⛔ 受阻」四个字只说明"卡住了"，不说明"卡在谁身上"——
          // 把前置写成节点上的胶囊，原因进 title（不占行宽，也不丢信息）。
          const blockedBy = Array.isArray(n.blockedBy) ? n.blockedBy : [];
          if (blockedBy.length) {
            const chip = mk("span", "req-node-blocked-by", `⬅ 前置 ${blockedBy.map((b) => b.identifier).join("、")}`);
            chip.title = blockedBy.map((b) => `${b.identifier} ${b.title ?? ""}${b.reason ? `（${b.reason}）` : ""}`).join("\n");
            node.appendChild(chip);
          }
          dag.appendChild(node);
        }
        if (graph.nodes.length === 0) dag.appendChild(mk("div", "empty-note", "该条目尚无技术任务"));
        // 依赖明细默认收起：节点上已有「前置」结论，逐条 `A → B` 常驻只是占屏（真机偏好：清单常驻太挤）。
        if (graph.edges.length) {
          const more = mk("details", "req-dag-edges");
          more.appendChild(mk("summary", null, `依赖明细（${graph.edges.length}）`));
          for (const e of graph.edges) more.appendChild(mk("div", "req-edge", `${e.blocker} → ${e.blocked}${e.reason ? `（${e.reason}）` : ""}`));
          dag.appendChild(more);
        }
        host.appendChild(dag);
      } catch (error) {
        host.replaceChildren(mk("p", "hint", `加载失败：${error.message}`));
      }
    }

    /**
     * 按编号打开任务详情（真机批注 2026-10-29「需求条目里看到受阻任务，点不进去」）。
     *
     * 口径：**列表里没有不等于不存在** —— 以前用 `state.tasks.find(...)` 找不到就提示"可能已归档"，
     * 而抽屉里的关联任务/DAG 节点本来就在讲某张具体的卡，点不开等于没有这个入口。
     * 现在：先在当前列表里找，找不到就**按编号现取一张**（GET /api/tasks/:ref），仍拿不到才报错。
     */
    async function openTaskByRef(identifier) {
      const ref = String(identifier ?? "").trim();
      if (!ref) return;
      const fresh = (state.tasks ?? []).find((x) => x.identifier === ref);
      if (fresh) { void openTaskDetail(fresh); return; }
      try {
        const payload = await api("GET", `/api/tasks/${encodeURIComponent(ref)}`);
        const t = payload?.task;
        if (t) { void openTaskDetail(t); return; }
      } catch { /* 落到下面统一提示 */ }
      showBanner(`打不开任务 ${ref}：可能已被删除，或不属于当前项目`, "error");
    }

    // ------------------------------------------------------------ 归属团队 / 执行会话（任务 ↔ 团队关联呈现）
    function memberCard(member) {
      const card = mk("div", "member-card");
      card.append(
        mk("span", `member-role owner-chip owner-${member.role}`, OWNER_LABELS[member.role] ?? member.role),
        mk("span", "member-model", member.model ?? "默认模型"),
        // FR-50 验收第一条：成员要能看到「执行器」（未配置 ⇒ 明写"默认执行器"，不臆造具体值）。
        mk("span", "member-executor", member.executor ?? "默认执行器"),
        pill(member.status, member.status === "ready" ? "ok" : ""),
      );
      return card;
    }
    function teamDetailCard(entry) {
      const run = entry.run ?? entry;
      const card = mk("div", "team-card");
      const head = mk("div", "team-card-head");
      head.append(statusPill(run.status), mk("span", "team-id", run.id));
      head.append(mk("div", "spacer"));
      head.append(mk("span", "hint", fmtTime(run.createdAt)));
      card.appendChild(head);
      if (run.targetTaskIdentifier) card.appendChild(mk("div", "hint", `目标任务 ${run.targetTaskIdentifier} ${run.targetTaskTitle ?? ""}`));
      const members = entry.members ?? [];
      card.appendChild(mk("h3", null, `成员（${members.length}）`));
      if (members.length) {
        const grid = mk("div", "member-grid");
        for (const m of members) grid.appendChild(memberCard(m));
        card.appendChild(grid);
      } else card.appendChild(mk("div", "empty-note", "暂无成员记录"));
      const tasks = entry.tasks ?? [];
      card.appendChild(mk("h3", null, `团队任务（${tasks.length}）`));
      if (tasks.length) {
        const list = mk("div", "team-task-list");
        for (const tt of tasks) {
          const row = mk("div", "team-task-row");
          row.append(statusPill(tt.status), mk("span", null, `${tt.kind} · ${tt.taskId ?? ""}`), mk("div", "spacer"), mk("span", "hint", tt.memberId ? String(tt.memberId).slice(0, 8) : "未指派"));
          list.appendChild(row);
          const attempts = tt.attempts ?? [];
          if (attempts.length) {
            const al = mk("div", "attempt-list");
            for (const a of attempts) al.appendChild(mk("div", "attempt-row", `attempt ${a.attemptId ?? a.id.slice(0, 8)} → ${a.result ?? "?"} · ${fmtTime(a.createdAt)}`));
            list.appendChild(al);
          }
        }
        card.appendChild(list);
      } else card.appendChild(mk("div", "empty-note", "暂无团队任务"));
      return card;
    }
    async function fillTaskTeam(identifier, host) {
      const head = mk("h3", null, "归属团队");
      try {
        const data = await api("GET", `/api/tasks/${encodeURIComponent(identifier)}/team`);
        host.replaceChildren(head);
        if (data.lock) host.appendChild(mk("p", "hint", `任务级执行锁：${data.lock.status}（team ${String(data.lock.teamId).slice(0, 8)}）`));
        // 2026-10-22（第十报）：归因门在授权门**之前**（store.assertExecutable 的门序列）⇒ 未归因的卡
        // 无论在哪一列，「派发团队」都注定被拒（api.mjs 的 assertAttributed）。先给归因入口，
        // 不把注定被拒的按钮摆出来（此前只挡了「启动执行」，这条漏了 —— 真机 `-80` 的抽屉里就有）。
        if (data.task && !data.task.requirementId) {
          host.appendChild(mk("div", "empty-note", "该任务尚未归属需求条目：归因门会拦下「派发团队」（EXECUTION_NOT_ATTRIBUTED）。先在「归因（关联需求条目）」里选一条关联，再派发。"));
          host.appendChild(btn("去归因（关联需求条目）", () => { void openAttributionEntry(data.task); }, "primary"));
        } else if (data.task?.status === "backlog") {
          host.appendChild(mk("div", "empty-note", "该任务在「待办池(backlog)」= 未授权开工。团队不得认领，请先「授权开工」再派发。"));
          host.appendChild(btn("授权开工", async () => {
            try { await api("PATCH", `/api/tasks/${encodeURIComponent(identifier)}`, { version: data.task.version, status: "todo" }); showBanner("已授权开工", "info"); await fillTaskTeam(identifier, host); }
            catch (e) { showBanner(`授权失败：${e.message}`, "error"); }
          }, "primary"));
        } else if (!data.count) {
          host.appendChild(mk("div", "empty-note", "该任务尚未派发团队。可点下方「派发团队」创建（单任务、planner/reviewer 等 hosted 成员）。"));
          host.appendChild(btn("派发团队", () => dispatchTeam(identifier, () => void fillTaskTeam(identifier, host)), "primary"));
        } else {
          host.appendChild(btn("再派发一队", () => dispatchTeam(identifier, () => void fillTaskTeam(identifier, host))));
        }
        // #3：合并团队信息——成员编制只显示一次；多次派发只列"不同尝试（会话）"
        const runs = data.teams || [];
        if (runs.length) {
          const members = runs[0].members || [];
          const card = mk("div", "team-card");
          const th = mk("div", "team-card-head");
          th.append(pill(`同一团队（${runs.length} 次派发）`, "accent"), mk("div", "spacer"));
          card.appendChild(th);
          card.appendChild(mk("h3", null, `成员编制（${members.length}）`));
          const grid = mk("div", "member-grid");
          for (const m of members) grid.appendChild(memberCard(m));
          if (!members.length) grid.appendChild(mk("div", "empty-note", "无成员记录"));
          card.appendChild(grid);
          card.appendChild(mk("h3", null, `派发尝试 / 执行会话（${runs.length}）`));
          const list = mk("div", "team-task-list");
          for (const e of runs) {
            const row = mk("div", "team-task-row");
            row.append(statusPill(e.run.status), mk("span", null, `${fmtTime(e.run.createdAt)} · ${String(e.run.id).slice(0, 8)}`), mk("div", "spacer"));
            const tt = (e.tasks || [])[0];
            if (tt) row.appendChild(pill(`${tt.kind}:${tt.status}`, tt.status === "completed" ? "ok" : tt.status === "failed" ? "danger" : "warn"));
            list.appendChild(row);
            if (e.directive) list.appendChild(btn("复制派发指令", () => { void copyText(e.directive).then((ok) => showBanner(ok ? "已复制派发指令（交给队长/Lead 执行）" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制派发指令", ok ? "info" : "error")); }));
          }
          card.appendChild(list);
          host.appendChild(card);
        }
      } catch (error) {
        host.replaceChildren(head, mk("p", "hint", `加载失败：${error.message}`));
      }
    }
    /** FR-42/47：从任务详情发起一次团队派发（单任务；引擎经 /api/teams 决定，默认 P2 指令降级）。 */
    async function dispatchTeam(identifier, onDone) {
      const roles = ["engineer", "tester", "reviewer"];
      try {
        const created = await api("POST", "/api/teams", {
          targetTask: identifier,
          tasks: [{ task: identifier, kind: "work" }],
          members: roles.map((role) => ({ role })),
        });
        // 成员已由服务端按模板/`members` 装配（FR-50 验收第一条）——此处**不再**补发逐角色 POST，
        // 否则同一角色会被装配两次（此前靠 `addTeamMember` 的按 role 去重掩盖，去重已按验收口径移除）。
        showBanner(`已派发团队（mode=${created.mode ?? "?"}，成员 ${roles.length}）`, "info");
        onDone?.();
      } catch (error) {
        // 第十报：归因门拦下「派发团队」时走与「启动执行」同一套处置（同步真值 → 按真值措辞 →
        // 打开并高亮归因入口），不再只回一句原始报错让人自己猜该点哪。
        if (error.code === "EXECUTION_NOT_ATTRIBUTED") { await handleExecutionFailure(error, identifier, undefined, "派发团队"); return; }
        showBanner(`派发失败（${identifier}）：${error.message}${error.code ? `（${error.code}）` : ""}`, "error");
      }
    }
    async function openTaskDetail(task) {
      const renderSeq = ++detailRenderSeq; // 本代编号（并发渲染时只有最新一代允许落地）
      detailTask = task;
      drawerId.textContent = task.identifier;
      drawerTitle.textContent = task.title;
      drawerActions.replaceChildren(); // 换卡先清空标题栏动作区，避免上一张卡的按钮残留
      drawerBody.replaceChildren(mk("p", "hint", "加载详情…"));
      drawerBackdrop.classList.add("show");
      drawer.classList.add("show");
      try {
        const ref = encodeURIComponent(task.identifier);
        const [detail, exec, audit, deps, allTasks, reqs] = await Promise.all([
          api("GET", `/api/tasks/${ref}`).catch(() => ({ task, comments: [] })),
          api("GET", `/api/tasks/${ref}/execution`).catch(() => null),
          api("GET", "/api/governance/audit").catch(() => ({ audit: [] })),
          api("GET", `/api/tasks/${ref}/dependencies`).catch(() => null),
          api("GET", `/api/tasks?project=${encodeURIComponent(task.projectId)}`).catch(() => ({ tasks: [] })),
          // 需求条目表：概览的「需求条目」要显示可读标识（裸 UUID 用户在真机上认不出是哪条需求），
          // 归因区块也拿它做下拉候选 —— 一次取回、两处复用，不额外发请求。
          api("GET", `/api/requirements/items?project=${encodeURIComponent(task.projectId)}`).catch(() => ({ items: [] })),
        ]);
        if (renderSeq !== detailRenderSeq) return; // 取数期间已被更新的一代取代 ⇒ 本次渲染作废
        const t = detail.task ?? task;
        // 需求条目 id → 可读「identifier · title」。真机报障（2026-10-22）：概览只打裸 UUID，
        // 用户「不知道这个关联的是哪个需求」—— 归属成了没人看得懂的字段。
        const reqItems = reqs?.items ?? [];
        const reqById = new Map(reqItems.map((item) => [item.id, item]));
        const requirementText = (id) => {
          if (!id) return "未归因";
          const hit = reqById.get(id);
          return hit ? `${hit.identifier} · ${hit.title ?? ""}`.trim() : `${id}（未在本项目需求条目表中找到）`;
        };
        drawerBody.replaceChildren();
        // 概览
        const overview = mk("div", "drawer-section");
        overview.appendChild(mk("h3", null, "概览"));
        const tagRow = mk("div", "req-tags");
        tagRow.append(statusPill(t.status), pill(`优先级 ${PRIORITY_LABELS[t.priority] ?? t.priority}`), t.owner ? mk("span", `owner-chip owner-${t.owner}`, OWNER_LABELS[t.owner] ?? t.owner) : pill("未指派"));
        overview.appendChild(tagRow);
        // FR-94（用户真机 2026-10-22）：「应该在概览内任务添加时即记录完成验收及复核动作标准，
        // 以便快速复核」—— 概览里直接把标准与复核动作摆出来，评审前不必再去翻配置页。
        // 没记就**不渲染**（不臆断、不塞空话）。
        if (String(t.acceptance ?? "").trim() || t.verifyCommand) {
          const accBox = mk("div", "accept-box");
          accBox.appendChild(mk("h4", null, "完成验收标准与复核动作"));
          if (String(t.acceptance ?? "").trim()) accBox.appendChild(richText(t.acceptance));
          accBox.appendChild(mk("p", "hint", `复核动作：${t.verifyCommand ? t.verifyCommand : "未指定（回落项目设置 envConfig.verifyCommand，默认 npm test）"}`));
          overview.appendChild(accBox);
        }
        // 受阻原因 / 执行证据（来自最近一次失败反馈；显眼摆出）
        if (t.status === "blocked") {
          const fb = (detail.comments || []).slice().reverse().find((c) => /失败|受阻|block/i.test(String(c.body || ""))) || (detail.comments || []).slice(-1)[0];
          const box = mk("div", "empty-note");
          box.textContent = `⛔ 受阻：${fb ? fb.body : "（未记录原因；可在下方「反馈/评论」补充，或用「重试」/「释放归属」）"}`;
          // FR-80：分类与复盘信息（类型 / 同因复发次数 / 是否已转人工兜底）
          {
            const KIND_LABELS = { dependency: "依赖未就绪", needs_input: "需人给料", capability: "能力缺失", transient: "瞬时故障" };
            const triage = Boolean(t.triageAt) || (t.labels || []).includes("triage");
            const meta = document.createElement("div");
            meta.className = "hint";
            meta.style.marginTop = "4px";
            meta.textContent = `类型：${KIND_LABELS[t.blockKind] ?? "未分类"} · 同因复发：${t.blockRecurrences ?? 0} 次`
              + (triage ? " · 已转「人工兜底」（不再自动重派；点「重试」= 你已介入）" : "");
            box.appendChild(meta);
          }
          box.style.textAlign = "left";
          box.style.color = "var(--danger)";
          overview.appendChild(box);
        }
        overview.appendChild(kvList([
          ["项目", t.projectId], ["版本", `v${t.version}`], ["归属会话", t.sessionId ?? "未关联"],
          ["需求条目", requirementText(t.requirementId)], ["创建", fmtTime(t.createdAt)], ["更新", fmtTime(t.updatedAt)],
        ]));
        if (t.description) overview.appendChild(richText(t.description));
        drawerBody.appendChild(overview);

        // FR-40 补口（2026-10-19 真机）：归因门只会拒绝，全前端却**没有归因入口** —— 用户点「启动执行」
        // 只看到「请先关联需求条目（归因门）」，任务编辑对话框没有需求条目字段、也没有对应端点，无处可点。
        // 这里把「引导归因」落成可执行动作：列本项目需求条目 → 选一条 → 关联（跨项目由 store 层拒绝）。
        // 归因（关联需求条目）：**已归因也要渲染**。
        // 真机报障（2026-10-22）：① 概览把需求条目打成裸 UUID，用户「不知道这个关联的是哪个需求」；
        // ② 归因成功那一刻起抽屉里再无任何区块可看/可改 —— 归属成了"一次性动作"，事后既无法核对
        //    也无法改绑，用户只能怀疑"到底关没关联"（这正是本轮被误报成"归因门拦下"的背景）。
        // 归因门（store.assertAttributed）判的是 requirementId 是否为真值，与呈现无关；这里只把它
        // 变成可读、可改的呈现，不新增状态、不改执行口径（改绑仍然只写 requirement_id）。
        const attributionBox = mk("div", "drawer-section attr-box");
        attributionBox.appendChild(mk("h3", null, "归因（关联需求条目）"));
        attributionBox.appendChild(mk("div", "hint", t.requirementId
          ? `当前已归因：${requirementText(t.requirementId)} —— 归因门（启动执行 / 派发团队）已放行。如需改绑，选中另一条后点「改绑需求条目」（只改归属，不改任务状态）。`
          : "该任务尚未归属需求条目 —— 归因门会拦下「启动执行 / 派发团队」。选一条需求条目后点「关联」，即可继续执行。"));
        const pick = mk("select");
        const bind = mk("button", "primary", t.requirementId ? "改绑需求条目" : "关联需求条目");
        bind.type = "button";
        bind.disabled = true;
        pick.addEventListener("change", () => { bind.disabled = !pick.value; });
        bind.addEventListener("click", async () => {
          if (!pick.value) { showBanner("请先选择要关联的需求条目", "error"); return; }
          try {
            await api("POST", `/api/tasks/${ref}/attribution`, { requirement: pick.value });
            showBanner(`已归因到 ${pick.value}${t.status === "todo" ? "：现在可以点「启动执行」了" : ""}`, "info");
            await loadTasks();
            await openTaskDetail(t);
          } catch (error) { showBanner(`归因失败：${error.message}${error.code ? `（${error.code}）` : ""}`, "error"); }
        });
        if (reqItems.length) {
          pick.appendChild(option("", "（选择需求条目…）"));
          for (const item of reqItems) {
            const label = `${item.identifier} · ${item.title ?? ""}`.trim();
            pick.appendChild(option(item.identifier, item.id === t.requirementId ? `${label}（当前）` : label));
          }
          // 真机报障（2026-10-23）：已归因的卡，改绑下拉仍停在「（选择需求条目…）」占位 ⇒ 看起来像「没关联」。
          // 口径＝**只回显**当前绑定（预选），不自动改绑；「改绑」按钮仍等用户真的换了选项才可点。
          const curBound = reqItems.find((item) => item.id === t.requirementId);
          if (curBound) pick.value = curBound.identifier;
          pick.disabled = false;
        } else {
          // 随抽屉取回失败（旧宿主未重载插件 / 该项目暂无条目）→ 退回按需拉取，不把入口断掉。
          pick.disabled = true;
          pick.appendChild(option("", "（加载需求条目…）"));
          api("GET", `/api/requirements/items?project=${encodeURIComponent(t.projectId)}`)
            .then((data) => {
              const items = data?.items ?? [];
              pick.replaceChildren(option("", items.length ? "（选择需求条目…）" : "（该项目暂无需求条目）"));
              for (const item of items) pick.appendChild(option(item.identifier, `${item.identifier} · ${item.title ?? ""}`.trim()));
              const curBound2 = items.find((item) => item.id === t.requirementId);
              if (curBound2) pick.value = curBound2.identifier;
              pick.disabled = items.length === 0;
            })
            .catch((error) => { pick.replaceChildren(option("", `需求条目加载失败：${error.message}`)); });
        }
        const pickRow = mk("div", "field-inline");
        pickRow.append(pick, bind);
        attributionBox.appendChild(pickRow);
        drawerBody.appendChild(attributionBox);

        // 人工校验（FR-85 人在环升级门）：看板呈现 + **唯一放行出口**（结论）。
        // 真机缺口（2026-10-18）：API 齐了（/human-reviews、/human-review、/human-review/conclude），
        // 但 UI 一处都没有 —— 人工校验任务在板上与普通卡无异、也没有下结论的入口，与 FR-85 验收
        // 「在看板显著位置可见」不符，且「人在环」实际只能靠 curl。
        {
          const hsec = mk("div", "drawer-section");
          hsec.appendChild(mk("h3", null, "人工校验（FR-85 人在环）"));
          if (isHumanReviewTask(t)) {
            const category = hrCategoryLabel(t.humanReviewCategory);
            const hrPending = isHumanReviewPending(t);
            hsec.appendChild(mk("p", "hint", hrPending
              ? `类别：${category} · 状态：待结论 —— 结论给出前原任务保持受阻、不自动重派；执行侧不得认领、不得置完成。`
              : `类别：${category} · 状态：已结论（${HR_CONCLUSION_LABELS[t.humanReviewConclusion] ?? t.humanReviewConclusion ?? "-"}）${t.humanReviewConcludedAt ? ` · ${fmtTime(t.humanReviewConcludedAt)}` : ""} · 结论人：${t.humanReviewConcludedBy ?? "-"}`));
            if (t.description) hsec.appendChild(mk("pre", "hr-draft", t.description));
            if (hrPending) {
              const noteInput = mk("textarea", "review-input");
              noteInput.rows = 2;
              noteInput.placeholder = "结论说明（可选；会写进任务留痕与治理审计）";
              const bar = mk("div", "review-actions");
              const conclude = async (conclusion, label) => {
                const suffix = conclusion === "continue" ? "（会把被这扇门挡住、且其余前置已就绪的下游放回「可开工」）" : "（不放行下游）";
                if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`确认给出人工结论：${label}${suffix}？`)) return;
                try {
                  const r = await api("POST", `/api/tasks/${ref}/human-review/conclude`, { conclusion, comment: noteInput.value.trim(), actor: "human" });
                  const released = (r.released || []).length;
                  showBanner(`已下结论：${HR_CONCLUSION_LABELS[r.conclusion] ?? r.conclusion}${released ? ` · 已放行下游 ${released} 条：${r.released.join("、")}` : " · 未放行下游"}`, "info");
                  await loadTasks();
                  const fresh = (state.tasks ?? []).find((x) => x.identifier === t.identifier);
                  await openTaskDetail(fresh ?? t);
                } catch (e) { showBanner(`下结论失败：${e.message}${e.code ? `（${e.code}）` : ""}`, "error"); }
              };
              bar.appendChild(btn("继续（按原口径放行下游）", () => void conclude("continue", "继续"), "primary"));
              bar.appendChild(btn("变更需求（按新口径重开）", () => void conclude("change-requirement", "变更需求")));
              bar.appendChild(btn("关闭（不推进该任务）", () => void conclude("close", "关闭")));
              hsec.append(noteInput, bar);
              hsec.appendChild(mk("p", "hint", "口径：`继续`=原任务退回「可开工」重派并放行直接下游（其余前置须已完成/已取消）；`变更需求`/`关闭`=不放行下游。结论给出后这扇门即消耗（本卡转「已取消」），不可重复结论。"));
            }
          } else {
            hsec.appendChild(mkRich("p", "hint", "本任务不是人工校验任务。四类自动化无法自决的情形（真实 bug 阻塞／需求异化／技术架构变化／与上游需求不符）由系统自动升级为人工校验任务；也可在此按**现有可核验痕迹**手工申报（判不准即拒绝，绝不臆断）。**注意**：下面的「申报」按钮走的就是这套判定 —— 四类判据都不成立时它会**拒绝**并列出缺哪一条，结论直接显示在按钮下方。"));
            const bar = mk("div", "review-actions");
            // 真机报障（2026-10-28）：「申报人工校验」点了像没反应。真相两层：
            // ① 这个按钮**按现有可核验痕迹**判定，四类判据都不成立时必然返回 `HUMAN_REVIEW_NOT_CONFIDENT`
            //   （「判不准就不升级」是设计），所以「没成功」本身是正常结果，不是按钮坏了；
            // ② 失败原因原先只走全局 banner，而 banner 被抽屉盖住（见 tokens.css 的 `.banner` 注释）⇒ 用户零反馈。
            // 现在：原因**就地**显示在按钮下方（横幅仍然弹，两条腿走路，任何一条看得见就够）。
            const applyResult = mk("p", "hint hr-apply-result");
            applyResult.hidden = true;
            applyResult.setAttribute("role", "status");
            const sayApply = (text, ok) => {
              applyResult.hidden = !text;
              applyResult.textContent = text;
              applyResult.dataset.kind = ok ? "ok" : "error";
              // 抽屉是长内容（两栏 + 滚动），结论写在按钮下方时经常落在视口之外 ⇒ 主动滚进来。
              // 探针实测（2026-10-28）：修前该行 `applyInViewport=false`，用户等于没看见。
              if (text) { try { applyResult.scrollIntoView({ block: "nearest" }); } catch { /* ignore */ } }
            };
            bar.appendChild(btn("申报人工校验（按现有证据判定）", async () => {
              sayApply("正在按现有可核验痕迹判定…", true);
              try {
                const r = await api("POST", `/api/tasks/${ref}/human-review`, { actor: "human" });
                const ok = `已派发人工校验任务 ${r?.task?.identifier ?? "-"}（类别 ${hrCategoryLabel(r?.classification?.category)}）· 原任务已停手等人`;
                sayApply(ok, true);
                showBanner(ok, "info");
                await loadTasks();
              } catch (e) {
                const msg = `未派发：${e.message}${e.code ? `（${e.code}）` : ""}`;
                sayApply(msg, false);
                showBanner(msg, "error");
              }
            }));
            bar.appendChild(btn("复制申报标记（先贴评论再申报）", () => {
              const text = "【人工校验申报】类别=与上游需求不符；证据=<请填可核验证据：日志/诊断/尝试记录>；候选处置=<可选>";
              void copyText(text).then((ok) => showBanner(ok ? "已复制申报标记：贴到本任务评论后再点「申报人工校验」即可成立" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制", ok ? "info" : "error"));
            }));
            hsec.appendChild(bar);
            hsec.appendChild(applyResult);
            hsec.appendChild(mk("p", "hint", "红线：人工校验任务归人 —— 执行侧不得认领、不得置 done；未结论前被它挡住的下游一律不推进。"));
          }
          drawerBody.appendChild(hsec);
        }

        // 评审（FR-83）：请求评审 / 请求返工 / 评审通过 —— 评审是一等流程，不是单向"提交待验收"
        {
          const rsec = mk("div", "drawer-section");
          rsec.appendChild(mk("h3", null, "评审"));
          const STATE_LABELS = { pending: "待评审", approved: "评审通过（待人确认完成）", changes_requested: "返工中" };
          const rs = t.reviewState ?? null;
          rsec.appendChild(mk("p", "hint", rs
            ? `评审态：${STATE_LABELS[rs] ?? rs} · 评审者：${t.reviewer ?? "未指派"} · 返工轮次：${t.reviewRound ?? 0}${t.reviewSourceStatus ? ` · 返工回列：${t.reviewSourceStatus}` : ""}${t.reviewRequestedAt ? ` · 提交于 ${fmtTime(t.reviewRequestedAt)}` : ""}`
            : "尚未进入评审。执行侧置「待验收」= 请求评审（会记下来源列，返工只回这一列）。"));
          // FR-90：评审人必须先看到**机器结论**。真机反馈（2026-10-22）：「判断为无法人工校验的任务，
          // 理应有自动复核或者已自动跑过测试的返回结论以供人员评审任务通过使用」——否则「评审通过 /
          // 请求返工」两个按钮就只能凭感觉点，评审卡在"无据可依"。
          // 复核说明要能**自动填入**下方评审说明框（真机反馈同批），故先占位声明，稍后创建时赋值。
          let noteInput = null;
          // 复核后抽屉会整体重渲染，DOM 上的输入框会被换掉 —— 用「待填说明」把文案带过重渲染再落到新输入框。
          let pendingReviewNote = null;
          {
            const evidence = detail.reviewEvidence ?? null;
            const auto = evidence?.autoReview ?? null;
            const ev = mk("div", "review-evidence");
            ev.appendChild(mk("h3", null, "自动复核证据"));
            if (auto) {
              // 第三态（真机 2026-10-28 · hydro-two-ticket T7-B）：默认 `npm test` 在非 Node 工作区里
              // 必然 ENOENT（退出码 254），原先把「命令不适用」画成红色「失败」⇒ 评委误判。现在单独一档。
              const autoSkip = auto.applicable === false;
              ev.appendChild(mk("div", `review-evidence-verdict ${autoSkip ? "skip" : (auto.timedOut ? "warn" : (auto.exitCode === 0 ? "ok" : "bad"))}`, `最近一次自动复核：${auto.verdict}`));
              ev.appendChild(mk("p", "hint", `命令：${auto.command} · 退出码：${auto.timedOut ? "（超时未完成）" : (auto.exitCode === null ? "（未执行）" : auto.exitCode)} · 耗时：${(Number(auto.durationMs) / 1000).toFixed(1)}s${auto.at ? ` · ${fmtTime(auto.at)}` : ""}`));
              // 给一条明路：不适用时告诉人去哪儿填命令，而不是让人对着红字猜哪里坏了。
              if (autoSkip) ev.appendChild(mk("p", "hint", `⚠ 这条命令在本项目工作区不适用（${auto.skipReason ?? "未配置复核命令"}）—— **这不是测试失败**。请在本卡「编辑 → 复核动作」里填本项目的复核命令（Java 工程可填 \`mvn -q test\`）后重跑。`));
              // FR-90 强化：证据里带上**总结与失败点**（真机反馈：「只返回一个结果，应该在自动复核证据内
              // 自动填入复核总结证据及结论」）。老证据评论没有这些行 → 不渲染，不臆造。
              if (auto.summary) ev.appendChild(mk("p", "review-evidence-summary", `复核总结：${auto.summary}`));
              // FR-94：把复核时**当时的验收标准**一并摆出来（证据评论里已落盘，可回看）
              if (auto.acceptance) {
                ev.appendChild(mk("p", "hint", "该次复核记录的本卡验收标准："));
                ev.appendChild(richText(String(auto.acceptance).slice(0, 1200)));
              }
              if (Array.isArray(auto.failures) && auto.failures.length) {
                ev.appendChild(mk("p", "hint", "失败点："));
                const ul = mk("ul", "review-evidence-failures");
                for (const f of auto.failures) ul.appendChild(mk("li", null, f));
                ev.appendChild(ul);
              }
              if (auto.tail) {
                const det = mk("details", "review-evidence-tail");
                det.appendChild(mk("summary", null, "输出尾段（点开）"));
                det.appendChild(mk("pre", "review-evidence-pre", String(auto.tail).slice(0, 2000)));
                ev.appendChild(det);
              }
            } else {
              ev.appendChild(mk("div", "review-evidence-verdict warn", "尚无机器复核结论"));
              ev.appendChild(mk("p", "hint", `评审前建议先跑一遍自动复核（命令取本卡「复核动作」，未指定则回落项目设置 envConfig.verifyCommand，默认 npm test）。结论会作为**证据评论**留在本卡，随时可回看；复核**不改状态**。${t.verifyCommand ? `本卡复核动作：${t.verifyCommand}` : ""}`));
            }
            if (evidence?.progress) {
              ev.appendChild(mk("p", "hint", `执行方 / 团队最近回报（${evidence.progress.at ? fmtTime(evidence.progress.at) : "时间未知"}）：`));
              ev.appendChild(richText(String(evidence.progress.body).slice(0, 1200)));
            }
            const evBar = mk("div", "review-actions");
            const runReview = mk("button", "primary", "跑一遍自动复核");
            runReview.type = "button";
            runReview.title = "在当前项目工作区目录跑验证命令，把退出码与输出尾段落成证据评论（不改任务状态）";
            runReview.addEventListener("click", async () => {
              const label = runReview.textContent;
              runReview.disabled = true;
              runReview.textContent = "复核中…（跑命令，可能要几十秒）";
              try {
                const r = await api("POST", `/api/tasks/${ref}/auto-review`, {});
                const notApplicable = r.applicable === false;
                showBanner(`自动复核：${r.verdict}（${r.command} · ${(Number(r.durationMs) / 1000).toFixed(1)}s${r.timedOut ? "，已超时" : ""}）${notApplicable ? " · 未执行，请先在本卡「复核动作」里配置命令" : ""}`, (notApplicable || r.exitCode === 0) ? "info" : "error");
                // 把「结论 + 总结 + 失败点」自动填进评审说明，评审人不必手抄机器输出（真机反馈 2026-10-22）。
                const bits = [`自动复核结论：${r.verdict}（命令 ${r.command}，耗时 ${(Number(r.durationMs) / 1000).toFixed(1)}s${r.timedOut ? "，已超时" : ""}）`];
                if (r.summary) bits.push(`复核总结：${r.summary}`);
                if (Array.isArray(r.failures) && r.failures.length) bits.push(`失败点：\n${r.failures.map((f) => `- ${f}`).join("\n")}`);
                pendingReviewNote = { taskId: t.id, text: bits.join("\n") };
                await loadTasks();
                const fresh = (state.tasks ?? []).find((x) => x.identifier === t.identifier);
                await openTaskDetail(fresh ?? t);
              } catch (e) {
                showBanner(`自动复核失败：${e.message}${e.code ? `（${e.code}）` : ""}`, "error");
                runReview.disabled = false;
                runReview.textContent = label;
              }
            });
            evBar.appendChild(runReview);
            ev.appendChild(evBar);
            rsec.appendChild(ev);
          }
          const reviewerInput = mk("input", "review-input");
          reviewerInput.placeholder = "评审者（可空；空 = 未指派，超时会计入评审死锁诊断）";
          noteInput = mk("textarea", "review-input");
          noteInput.rows = 2;
          noteInput.placeholder = "评审说明 / 返工说明（返工必填，会写进反馈留痕）";
          if (pendingReviewNote && pendingReviewNote.taskId === t.id) { noteInput.value = pendingReviewNote.text; pendingReviewNote = null; }
          const bar = mk("div", "review-actions");
          const callReview = async (action, extra = {}) => {
            try {
              const r = await api("POST", `/api/tasks/${ref}/review`, { action, reviewer: reviewerInput.value.trim() || null, comment: noteInput.value.trim(), ...extra });
              const msg = action === "request" ? `已请求评审（${r.review?.reviewer ? `评审者 ${r.review.reviewer}` : "未指派评审者"}）`
                : action === "changes" ? `已请求返工 → 退回「${r.returnedTo}」（第 ${r.round} 轮）`
                : "评审通过（仍需人工确认后置「完成」）";
              showBanner(msg, "info");
              await loadTasks();
              const fresh = (state.tasks ?? []).find((x) => x.identifier === t.identifier);
              await openTaskDetail(fresh ?? t);
            } catch (e) { showBanner(`评审操作失败：${e.message}`, "error"); }
          };
          bar.appendChild(btn("请求评审（置待验收）", () => void callReview("request"), "primary"));
          bar.appendChild(btn("请求返工（退回实现列）", () => {
            if (!noteInput.value.trim()) { showBanner("返工需要填写说明（会写进反馈留痕）", "error"); return; }
            void callReview("changes");
          }));
          bar.appendChild(btn("评审通过（不自动完成）", () => void callReview("approve")));
          rsec.append(reviewerInput, noteInput, bar);
          rsec.appendChild(mkRich("p", "hint", "红线：评审通过也**不自动置「完成」**——完成只能人确认；返工只回来源列，下游继续受阻直到解锁。"));
          drawerBody.appendChild(rsec);
        }

        // 前后关联 / 阻塞因素（主任务前后关联 + 阻塞信息）
        const depSec = mk("div", "drawer-section");
        depSec.appendChild(mk("h3", null, "前后关联 / 阻塞因素"));
        const relList = mk("ul", "req-list");
        for (const b of (deps?.blockers || [])) { const li = mk("li", "req-item"); li.append(mk("span", "req-title", `前置 ${b.identifier} ${b.title ?? ""}`), statusPill(b.status)); if (b.reason) li.appendChild(pill(`阻塞：${b.reason}`, "warn")); relList.appendChild(li); }
        for (const b of (deps?.blocks || [])) { const li = mk("li", "req-item"); li.append(mk("span", "req-title", `后继 ${b.identifier} ${b.title ?? ""}`), statusPill(b.status)); relList.appendChild(li); }
        if (!(deps?.blockers || []).length && !(deps?.blocks || []).length) relList.appendChild(mk("div", "empty-note", "无前后关联任务"));
        depSec.appendChild(relList);
        drawerBody.appendChild(depSec);

        // 派生自 / 子任务串（子任务继承主任务的反馈/关联/阻塞；只标注派生自哪个主任务）
        const kids = (allTasks.tasks || []).filter((x) => x.parentId === t.id);
        const parent = t.parentId ? (allTasks.tasks || []).find((x) => x.id === t.parentId) : null;
        const kSec = mk("div", "drawer-section");
        kSec.appendChild(mk("h3", null, `派生 / 子任务（${kids.length}）`));
        if (parent) kSec.appendChild(mk("p", "hint", `本任务派生自主任务：${parent.identifier} ${parent.title ?? ""}`));
        if (kids.length) { const ul = mk("ul", "req-list"); for (const k of kids) { const li = mk("li", "req-item"); li.append(mk("span", "req-title", `${k.identifier} ${k.title}`), statusPill(k.status)); ul.appendChild(li); } kSec.appendChild(ul); }
        else if (!parent) kSec.appendChild(mk("div", "empty-note", "无派生/子任务"));
        drawerBody.appendChild(kSec);

        // 操作（2026-10-23 用户真机批注）：整卡动作区上移到标题栏，与「全部收起 / 还原 / ✕」同一排。
        // 做法＝把后续所有 `ops.appendChild(...)` 直接接到标题栏的 `drawerActions` 容器上：
        // 按钮一个不删、回调一个不改，只换挂载点（正文不再留「操作」区块）。
        const ops = drawerActions;
        ops.appendChild(btn("编辑", () => { closeDrawer(); openDialog(t); }));
        ops.appendChild(btn("上一列", () => void moveTask(t, state.statuses[Math.max(0, state.statuses.indexOf(t.status) - 1)])));
        // 「下一列」：与卡片「→」**同一份**判定（`nextColumnTarget`）。
        // 「待验收」卡的下一列恒为「完成」⇒ 这条位移与「下一步」区的「完成（仅人工可确认）」**效果完全一样**，
        // 两个入口做同一件事（真机报障 `-158`）。该状态不再摆这条平行入口，改为指回「下一步」区
        // （评审通过 / 请求返工 / 完成）—— 一处处置（FR-89）。
        const drawerNext = nextColumnTarget(t, state.statuses);
        if (drawerNext.blocked) {
          if (drawerNext.viaNextStep) {
            ops.appendChild(btn("下一列 → 处置见「下一步」", () => {
              const sec = drawerBody.querySelector(".drawer-section.next-step");
              if (!sec) { showBanner("「下一步」区尚未就绪，请稍候重试", "error"); return; }
              sec.classList.remove("collapsed");
              sec.scrollIntoView({ block: "start", behavior: "smooth" });
            }));
          } else {
            const disabled = btn("下一列", () => {});
            disabled.disabled = true;
            disabled.title = drawerNext.reason;
            ops.appendChild(disabled);
          }
        } else {
          ops.appendChild(btn("下一列", () => void moveTask(t, drawerNext.status)));
        }
        // 入口口径与卡片、下一步面板同一份（executionEntry）：未归因的可开工卡在抽屉里也给「去归因」。
        const drawerEntry = executionEntry(t);
        if (drawerEntry === "attribute") ops.appendChild(btn("去归因（关联需求条目）", () => { void openAttributionEntry(t); }, "primary"));
        // 第九报：待办池卡在抽屉里也要有显式入口（此前只有「下一列」按钮，得靠人自己推断那是授权）。
        if (drawerEntry === "authorize") ops.appendChild(btn("授权开工（移出待办池）", async () => {
          if (!window.confirm(`把 ${t.identifier} 移出「待办池」→「可开工」？授权只是放行，仍需人点「启动执行」或由团队/执行循环认领。`)) return;
          const ok = await moveTask(t, "todo");
          if (ok) showBanner(`${t.identifier} 已授权开工（待办池 → 可开工）。下一步：点「启动执行」，或让它被团队/执行循环认领。`, "info");
        }, "primary"));
        if (drawerEntry === "start") ops.appendChild(btn("启动执行", async () => {
          if (!window.confirm(`启动执行会尝试新建/切换会话（可能切换主视图）。${execRunning ? "\n\n⚠ 该任务已有执行会话正在执行且未返回结论，继续会被拒绝（EXECUTION_ALREADY_RUNNING）。" : ""}确认继续？`)) return;
          try { await api("POST", `/api/tasks/${ref}/execute`, undefined); closeDrawer(); await loadTasks(); }
          catch (e) {
            // 与卡片入口同一份处置（含「打开并高亮归因入口」），不再各写一套措辞。
            await handleExecutionFailure(e, ref, t);
          }
        }, "primary"));
        if (t.status === "in_progress") {
          const r2 = mk("div", "btn-row");
          r2.append(
            btn("提交待验收", async () => { try { await api("POST", `/api/tasks/${ref}/execution/review`, {}); closeDrawer(); await loadTasks(); } catch (e) { showBanner(e.message, "error"); } }, "primary"),
            btn("标记失败", async () => { try { await api("POST", `/api/tasks/${ref}/execution/fail`, { evidence: "手动标记失败" }); closeDrawer(); await loadTasks(); } catch (e) { showBanner(e.message, "error"); } }),
            btn("退回待办（重新派发）", async () => {
              const extra = execRunning ? "\n\n⚠ 该任务已有执行会话正在执行中；退回后会释放任务级锁，但再次下发仍会被拒（需等会话结束）。" : "";
              if (!window.confirm(`退回「可开工(todo)」并释放任务级锁，等待执行循环/人工重新派发。确认？${extra}`)) return;
              try { await api("POST", `/api/tasks/${ref}/execution/retry`, {}); closeDrawer(); await loadTasks(); showBanner("已退回待办（锁已释放）", "info"); }
              catch (e) { showBanner(`退回失败：${e.message}`, "error"); }
            }),
            btn("释放归属", async () => { try { await api("POST", `/api/tasks/${ref}/execution/release`, {}); closeDrawer(); await loadTasks(); } catch (e) { showBanner(e.message, "error"); } }),
          );
          ops.appendChild(r2);
        }
        if (t.status === "blocked") ops.appendChild(btn("重试", async () => { try { await api("POST", `/api/tasks/${ref}/execution/retry`, {}); closeDrawer(); await loadTasks(); } catch (e) { showBanner(e.message, "error"); } }, "primary"));
        ops.appendChild(btn("拆解为子任务", async () => {
          if (!window.confirm("按任务描述自动拆解为关联子任务？（无编号行则生成 实现/验证 两条）")) return;
          try { const r = await api("POST", `/api/tasks/${ref}/decompose`, {}); showBanner(`已生成子任务：${(r.children || []).map((c) => c.identifier).join("、")}（待办池）`, "info"); closeDrawer(); await loadTasks(); }
          catch (e) { showBanner(`拆解失败：${e.message}`, "error"); }
        }));
        // （原 `drawerBody.appendChild(ops)` 已移除：动作区改挂标题栏 `drawerActions`。）

        const related = (audit.audit ?? []).filter((a) => a.target === t.identifier);

        // 执行会话（FR-48）：会话标识 + 执行状态 + 最近进展（不可得则降级可见）
        const lastProgress = related.reduce((acc, a) => (a.at && (!acc || a.at > acc) ? a.at : acc), null) ?? t.updatedAt;
        const execSession = exec?.sessionId ?? t.sessionId ?? null;
        // FR-84：**接续会话**＝三级回落解析结果（任务会话 → 项目主会话 → 项目已关联会话）+ 存活三态
        const refSessionId = exec?.sessionRef?.sessionId ?? execSession ?? null;
        const refSource = exec?.sessionRef?.source ?? (execSession ? "task" : null);
        const refLiveness = exec?.sessionRef?.liveness ?? null;
        const REF_SRC_LABEL = { task: "任务执行会话", "project-main": "项目主会话（回落）", "project-bound": "项目已关联会话（回落）" };
        // FR-84 补口（2026-10-18）：存活口径由「存在/失效」二态补齐为**四态呈现**。
        // 真机缺口：`exists===true && live===false`（会话只在磁盘上、当前 dsh 实例没加载它）此前被渲染成「在线」。
        // **同日再更正（硬证）**：当时把它写成「打开可能为空」是**过度悲观**——实测点「打开执行会话」后
        // `session-4dc56efa-…` 由 `live:false` → `live:true`，且**两轮历史完整渲染**（轮次导航 1/2 轮可点）。
        // 「点开只有输入框」的真实成因是**前端脚本没投递到位**（页面级单例，见 lib/client.js 的 injectBoardBundle）
        // 以及宿主草稿污染导致会话区整块崩溃，**不是「未加载」**。故第四态只陈述事实、不吓人。
        const liveText = (lv) => (!lv ? "未探活"
          : lv.exists === true ? (lv.live
            ? `在线${lv.running ? " · 运行中" : " · 空闲"}`
            : "仅在磁盘上 · 本实例未加载（点开会即时加载）")
          : lv.exists === false ? "已失效" : "存在性未知");
        const staleRef = refLiveness?.exists === false;
        // 未加载：不是「已失效」（文件还在），也不该被当成「在线」（打开会是空会话）。
        const notLiveRef = refLiveness?.exists === true && refLiveness?.live === false;
        // FR-84 补口（2026-10-19）· **接续会话的工作区归属**：
        // 真机事故：本项目的主会话指针被指到**另一个工作区**（项目-dsh-acp）的 6.3 MB 会话上 →
        // 看板每张卡「打开执行会话」都打开**别人的、巨大的**会话，对话页长时间只剩输入框。
        // 服务端给出 `origin.cwd` 与 `mismatch`；**判不准时 mismatch=null**（不臆断、不误拦）。
        const refOrigin = exec?.sessionRef?.origin ?? null;
        const originMismatch = refOrigin?.mismatch === true;
        const originText = !refOrigin ? "—"
          : refOrigin.cwd ? `${refOrigin.cwd}${refOrigin.projectId ? `（项目 ${refOrigin.projectId}）` : "（不属于任何在册项目）"}` : `判定不可用（${refOrigin.source ?? "未知"}）`;
        const ss = exec?.sessionState ?? null;
        const execRunning = Boolean(ss?.sessionId && (ss.running || ((ss.pending ?? 0) > 0)));
        const sessionStateLabel = !ss?.sessionId
          ? "未关联（降级）"
          : execRunning ? `执行中${ss.pending ? `（待消费 ${ss.pending}）` : ""}`
          : ss.live ? "空闲（会话在线）" : "未在线 / 已结束";
        // FR-84：重建并重绑项目主会话（无可用引用 / 引用已失效时的接续动作）
        const rebuildMain = async () => {
          if (!window.confirm("重建并绑定项目主会话？\n\n将新建一个会话、写回项目主会话指针，并投递 FR-61 开局提示词（旧指针被替换；旧会话本身不被删除）。")) return;
          try {
            const r = await api("POST", `/api/projects/${encodeURIComponent(t.projectId)}/sessions/rebind`, { confirm: true });
            showBanner(`已重建主会话：${String(r.after).slice(0, 14)}…（开局提示词${r.openingDelivered ? "已投递" : `未投递：${r.deliveryReason ?? "原因未知"}`}）${sessionNameClause(r)}`, r.openingDelivered && r.titleApplied !== false ? "info" : "error");
            await loadTasks();
            await openTaskDetail(t);
          } catch (e) {
            const extra = (e.code === "SESSION_CREATE_FAILED" || e.code === "HOST_UNAVAILABLE")
              ? " —— 宿主**建会话**能力不可用（当前 DSH 实例可能未加载宿主 shim）。改用下方「改绑到本工作区已有会话」：不新建会话，直接把已有会话绑为主会话即可接续。"
              : "";
            showBanner(`重建失败：${e.message}${extra}`, "error");
          }
        };
        // FR-84 补口（2026-10-26 · 真机 `-63` / `-69` 复现）：**任务级改指**是唯一能解开
        // 「任务自己的接续引用被写坏」的动作 —— `resolveSessionRef` 里任务级引用**优先级最高且不看存活/归属**，
        // 故「重建并绑定项目主会话」对这类卡是**无效指引**（那一级只改 `projects.initial_session_id`）：
        // 真机现场＝用户照提示重建完，同一张卡仍报「属于另一个工作区」。
        const rebindTaskToMain = async () => {
          if (!window.confirm("把本任务的接续会话改指到项目主会话？\n\n只改这张任务的会话引用，不动状态、不动认领锁（旧的失效会话不会被删除）。")) return;
          try {
            const r = await api("POST", `/api/tasks/${ref}/session/rebind`, { confirm: true });
            showBanner(`已把本任务接续会话改指到 ${String(r.after).slice(0, 14)}…（工作区 ${r.origin?.cwd ?? "未知"}）`, "info");
          } catch (e) {
            showBanner(`改指失败：${e.message}（若提示项目主会话不可用，先点「重建并绑定项目主会话」建一个，再回来点这里）`, "error");
            return;
          }
          closeDrawer(); await loadTasks(); await openTaskDetail(t);
        };
        const execSec = mk("div", "drawer-section");
        execSec.appendChild(mk("h3", null, "执行会话"));
        execSec.appendChild(kvList([
          ["执行状态", STATUS_LABELS[exec?.status ?? t.status] ?? (exec?.status ?? t.status)],
          ["会话标识", execSession ?? "（本任务尚无执行会话）"],
          ["接续会话", refSessionId ? `${REF_SRC_LABEL[refSource] ?? refSource ?? "会话"} · ${String(refSessionId).slice(0, 18)}…` : "无（任务与项目都没有可用会话引用）"],
          ["接续存活", refSessionId ? liveText(refLiveness) : "—"],
          ["接续归属", refSessionId ? originText : "—"],
          ["会话运行状态", sessionStateLabel],
          ["归因", exec ? (exec.attributed ? "已归因（需求条目）" : "未归因") : "—"],
          ["最近进展", fmtTime(lastProgress)],
          ["连续失败", `${exec?.consecutiveFailures ?? 0} / ${exec?.failureLimit ?? 2}`],
        ]));
        // FR-84 补口（2026-10-23）· **实例工作区预检**（说清「为什么重建也可能不对」）：
        // 一个 DSH 实例只有一个工作区，宿主不提供切换（`uiWorkspace` 不可用）⇒ 在看板里切项目
        // **不会**让宿主换工作区，本实例建出的会话只会落在实例自己的工作区上。
        const instCwd = state.binding?.sessionOrigin?.cwd ?? null;
        const projWs = (state.projects ?? []).find((p) => p.id === t.projectId)?.workspacePath ?? null;
        if (instCwd && projWs && String(instCwd).replace(/\/+$/, "") !== String(projWs).replace(/\/+$/, "")) {
          const w = mk("p", "hint", `⚠ 本 DSH 实例的工作区是 ${instCwd}，本项目工作区是 ${projWs} —— 两者不一致。宿主不提供工作区切换服务，故本实例**建出的会话只会落在 ${instCwd}**：对本项目请用「改绑到本工作区已有会话」，或直接在 ${projWs} 下另起一个 DSH 实例再来接续。`);
          w.style.color = "#b9770e";
          execSec.appendChild(w);
        }
        if (staleRef) {
          // FR-84 补口（2026-10-26）：失效的可能是**两级引用中的任一级**，而只有「项目级」那一级
          // 能被「重建并绑定项目主会话」救回来 —— 任务级失效时那句话把用户指向一个**永远不会生效**的动作。
          // 故按 `sessionRef.source` 分流，并给出**真能生效**的那个按钮。
          const ownRef = (exec?.sessionRef?.source ?? "task") === "task";
          const warn = mk("p", "hint", ownRef
            ? `⚠ 接续会话 ${String(refSessionId).slice(0, 18)}… 已失效（本机已不存在该会话：DSH 重启或被清理）。这是**本任务自己的**接续引用 —— 「重建并绑定项目主会话」改不动它（只改项目指针），点下面的「改指到项目主会话（本任务）」才能接上。`
            : `⚠ 接续会话 ${String(refSessionId).slice(0, 18)}… 已失效（本机已不存在该会话：DSH 重启或被清理）。打开不会成功——请用「重建并绑定项目主会话」接续。`);
          warn.style.color = "#c0392b";
          execSec.appendChild(warn);
          if (ownRef) {
            const ownBar = mk("div", "btn-row", null);
            ownBar.appendChild(btn("改指到项目主会话（本任务）", rebindTaskToMain, "primary"));
            execSec.appendChild(ownBar);
          }
        } else if (!refSessionId) {
          const warn = mk("p", "hint", "⚠ 任务与项目都没有任何会话引用 → 打开执行会话无从下手。请先「重建并绑定项目主会话」，之后的派发与反馈回流都会走到它。");
          warn.style.color = "#b9770e";
          execSec.appendChild(warn);
        } else if (notLiveRef) {
          // FR-84 补口：会话「存在但未加载」——文件还在磁盘上（**历史不会丢**），只是当前 dsh 实例
          // 还没把它加载进运行态。**同日真机更正**：打开会即时加载，实测历史完整渲染，
          // 所以这里只说明事实 + 给出「万一是空会话」的下一步，不再劝人无脑重建。
          const warn = mk("p", "hint", `⚠ 接续会话 ${String(refSessionId).slice(0, 18)}… 当前 dsh 实例尚未加载它（会话文件仍在磁盘上，历史不会丢）。点「打开执行会话」会即时加载它；若点开后仍为空白，通常说明该会话本身没有历史记录 —— 此时改用「重建并绑定项目主会话」接续即可（旧会话不会被删除，历史仍可人工查阅）。`);
          warn.style.color = "#b9770e";
          execSec.appendChild(warn);
        }
        // FR-78：熔断可见 + 人工重置入口
        if (originMismatch) {
          // FR-84 补口（2026-10-23）· **有效动作**：
          // 任务级 `session_id` 指向别的工作区时，「重建并绑定项目主会话」**改不动它**（那只改项目指针）
          // ⇒ 真机现场：用户按提示重建完，同一张卡仍报同一句话（被指了一条对该卡无效的路）。
          // 处置：按「项目主会话此刻是否可用」给出**真正生效**的那一个动作；跨工作区打开保留为显式出口。
          const pm = exec?.sessionRef?.projectMain ?? null;
          const pmUsable = Boolean(pm?.sessionId) && pm?.origin?.mismatch !== true && pm?.liveness?.exists !== false;
          const refIsOwn = (exec?.sessionRef?.source ?? "task") === "task";
          const warn = mkRich("p", "hint", `⚠ 接续会话 ${String(refSessionId).slice(0, 18)}… **属于另一个工作区**：${String(refOrigin.cwd)}${refOrigin.projectName ? `（项目 ${refOrigin.projectName}）` : ""} → 打开它会切到**别的项目**的会话，你要看的历史不在那里。${!refIsOwn ? "错配的是**项目主会话指针** → 用下面的「重建并绑定项目主会话」把它重建到本项目工作区。" : pmUsable ? "这是**本任务自己的**接续引用（项目级重建改不动它）→ 用下面的「改指到项目主会话（本任务）」。" : "本项目主会话当前不可用 → 用下面的「重建主会话并把本任务改指过去」一次到位（新建 + 改指，两步都留审计）。"}确有需要再点「仍要打开（跨工作区）」。`);
          warn.style.color = "#c0392b";
          execSec.appendChild(warn);
          const mismatchBar = mk("div", "btn-row", null);
          if (!refIsOwn) {
            mismatchBar.appendChild(btn("重建并绑定项目主会话", rebuildMain, "primary"));
          } else if (pmUsable) {
            mismatchBar.appendChild(btn("改指到项目主会话（本任务）", async () => {
              if (!window.confirm(`把本任务的接续会话改指到项目主会话？\n\n只改这张任务的会话引用，不动状态、不动认领锁（旧的失效会话不会被删除）。`)) return;
              try {
                const r = await api("POST", `/api/tasks/${ref}/session/rebind`, { confirm: true });
                showBanner(`已把本任务接续会话改指到 ${String(r.after).slice(0, 14)}…（工作区 ${r.origin?.cwd ?? "未知"}）`, "info");
                closeDrawer(); await loadTasks(); await openTaskDetail(t);
              } catch (e) { showBanner(`改指失败：${e.message}`, "error"); }
            }, "primary"));
          } else {
            mismatchBar.appendChild(btn("重建主会话并把本任务改指过去", async () => {
              // FR-84 补口（2026-10-23 · 真机复报「重建完还是同一句话」）：项目主会话不可用时，
              // 光「重建」**解不开这张卡的锁** —— 任务级 `session_id` 仍指着别的工作区。
              // 故这里一次到位：① 重建项目主会话（cwd = 本项目工作区；宿主工作区校验不过会如实失败、不写回指针）
              // ② 把**本任务**的接续引用改指过去。两步各自留审计；任一步失败都如实报，不谎报成功。
              if (!window.confirm(`本项目主会话当前不可用。将新建一个落在本项目工作区的会话，并把本任务的接续引用改指过去。\n\n只改会话引用，不动状态、不动认领锁（旧的失效会话不会被删除）。`)) return;
              let after = null;
              try {
                const rb = await api("POST", `/api/projects/${encodeURIComponent(t.projectId)}/sessions/rebind`, { confirm: true });
                after = rb?.after ?? null;
              } catch (e) {
                showBanner(`重建失败：${e.message}`, "error");
                return;
              }
              try {
                const r = await api("POST", `/api/tasks/${ref}/session/rebind`, { confirm: true, ...(after ? { sessionId: after } : {}) });
                showBanner(`已重建主会话 ${String(after ?? "").slice(0, 14)}… 并把本任务改指过去（工作区 ${r.origin?.cwd ?? "未知"}）`, "info");
              } catch (e) {
                showBanner(`主会话已重建（${String(after ?? "").slice(0, 14)}…），但本任务改指失败：${e.message}`, "error");
              }
              closeDrawer(); await loadTasks(); await openTaskDetail(t);
            }, "primary"));
          }
          execSec.appendChild(mismatchBar);
        }
        if (exec?.guard) {
          const g = exec.guard;
          const gText = g === "quota-blocked" ? "上次失败属配额/鉴权类，已停止自动重试"
            : g === "circuit-open" ? `连续失败达阈值（${exec.consecutiveFailures}/${exec.failureLimit}），已熔断，不再自动重试`
            : "窗口内已成功完成且之后无人工重跑，已跳过自动派发（防重复产出）";
          const p = mk("p", "hint", `⛔ ${gText}。${exec.lastFailureError ? `最近原因：${exec.lastFailureError}` : ""}`);
          p.style.color = "#c0392b";
          execSec.appendChild(p);
          execSec.appendChild(btn("重置失败计数（解除熔断）", async () => {
            try { await api("POST", `/api/tasks/${ref}/reset-failures`, {}); showBanner("已重置失败计数", "info"); await loadTasks(); await openTaskDetail(t); }
            catch (e) { showBanner(`重置失败：${e.message}`, "error"); }
          }, "primary"));
        }
        if (execRunning) {
          const warn = mk("p", "hint", `⚠ 已有执行会话正在执行且未返回结论（${String(ss.sessionId).slice(0, 18)}…）→ 已停止再次下发；重复派发会被拒绝（EXECUTION_ALREADY_RUNNING）。请等其回写状态，或先「打开执行会话」查看进展。`);
          warn.style.color = "#c0392b";
          execSec.appendChild(warn);
        }
        const execBar = mk("div", "btn-row");
        if (refSessionId) {
          execBar.appendChild(hostBtn("打开执行会话", async () => {
            // 1) 服务端先给口径（FR-84）：同一入口负责回落解析 + 存活判定，
            //    session-gone / no-session 时**明确告知**，且绝不复制空标识（真机事故："已复制会话标识：-"）。
            let verdict = null;
            try { verdict = await api("POST", `/api/tasks/${ref}/open-session`, {}); } catch (_) { verdict = null; }
            if (verdict?.opened) {
              // 服务端已经用宿主 `openSession` 把会话切过去了 —— 但**视图**仍按「每会话持久化的偏好」恢复：
              // 用户上次在该会话看的是看板，打开后就还停在看板页（真机取证见 bringConversationToFront 注释）。
              bringConversationToFront(doc, verdict.sessionId ?? refSessionId);
              showBanner(`已切换到执行会话 ${String(verdict.sessionId).slice(0, 14)}…（已把「对话」视图切到前台；若仍停在「任务工作台」页，点上方「对话」即可看历史）`, "info");
              return;
            }
            const target = verdict?.sessionId ?? refSessionId;
            if (verdict?.reason === "session-gone") {
              // FR-84 补口（2026-10-26）：与抽屉同口径 —— 失效的是**本任务自己的**引用时，
              // 项目级重建改不动它，必须走任务级改指。
              const ownRef = (verdict?.source ?? "task") === "task";
              showBanner(`接续会话 ${String(verdict.sessionId ?? "").slice(0, 18)}… 已失效（本机不存在）→ ${ownRef ? "请在「执行会话」区点「改指到项目主会话（本任务）」接续（该引用是本任务自己的，项目级重建改不动它）" : "请用「重建并绑定项目主会话」接续"}`, "error");
              return;
            }
            if (verdict?.reason === "no-session") {
              showBanner("任务与项目都没有可用会话引用 → 请用「重建并绑定项目主会话」接续", "error");
              return;
            }
            // FR-84 补口：会话属于**别的工作区** —— 默认不静默打开（打开的是别人的会话，历史也不是本任务的）。
            if (verdict?.reason === "session-other-workspace") {
              const o = verdict.origin ?? {};
              const ownRef = (verdict?.source ?? "task") === "task";
              showBanner(`未打开：接续会话属于另一个工作区（${o.cwd ?? "路径未知"}${o.projectName ? `，项目 ${o.projectName}` : ""}）→ 打开它会切到别的项目的会话。${ownRef ? "这是**本任务自己的**接续引用（项目级重建改不动它）→ 请在「执行会话」区点「改指到项目主会话（本任务）」接续" : "请用「重建并绑定项目主会话」接续"}；确要打开请点「仍要打开（跨工作区）」。`, "error");
              return;
            }
            // 2) 客户端直开：会话切换属于客户端导航（宿主侧通常返回 ui-workspace-unavailable）
            if (openHostSession && target) {
              const r = openHostSession(target);
              if (r?.ok) {
                // 未加载的会话切过去多半是空的 → 成功也必须如实说明，不能只说「已切换」让人对着空页猜。
                bringConversationToFront(doc, target);
                showBanner(notLiveRef
                  ? `已请求打开 ${String(target).slice(0, 14)}…（该会话此前未在本实例加载，打开时会即时加载；已把「对话」视图切到前台 —— 若仍停在「任务工作台」页，点上方「对话」即可看历史；若「对话」页仍为空白，说明该会话本身没有历史记录 → 可用「重建并绑定项目主会话」接续）`
                  : `已切换到执行会话 ${String(target).slice(0, 14)}…（已把「对话」视图切到前台；若仍停在「任务工作台」页，点上方「对话」即可看历史）`, "info");
                return;
              }
            }
            // 3) 降级：会话标识可复制，人工在会话列表搜索打开
            if (!target) { showBanner("无法自动打开，且没有可复制的会话标识；请先「重建并绑定项目主会话」", "error"); return; }
            void copyText(target).then((ok) => showBanner(
              ok ? `无法自动打开；已复制会话标识：${target}（到会话列表搜索该标识手动打开）`
                : `无法自动打开；会话标识：${target}（浏览器拒绝了剪贴板写入，请手动选择复制）`,
              "error",
            ));
          }, "primary"));
          execBar.appendChild(btn("复制接入指令（人工继续调试）", () => { void copyText(`请继续任务 ${t.identifier}（接续会话 ${refSessionId}）：查看失败原因/现场 → 继续调试 → 回写状态（提交"待验收"；不得置 done）。`).then((ok) => showBanner(ok ? "已复制接入指令" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制接入指令", ok ? "info" : "error")); }));
          execBar.appendChild(btn("复制会话标识", () => { void copyText(refSessionId).then((ok) => showBanner(ok ? "已复制会话标识" : "复制失败，请手动选择", ok ? "info" : "error")); }));
          // FR-84 补口：归属不符时给一条**显式**的越界打开通道 —— 默认不打开，避免"点了没反应"被当成故障。
          if (originMismatch) {
            // FR-84 补口（2026-10-19 真机 UI 复验后补）：**把"请用重建"从提示变成可点的动作**。
            // 复验发现：跨工作区拦截时抽屉里只有「仍要打开（跨工作区）」，用户被拦下后拿不到
            // 「重建并绑定项目主会话」这个出口（只有「会话已失效 / 完全没有会话」两种分支才渲染它）
            // → 承诺的「从任务台重新接续回项目主会话」在这条最真实的路径上其实走不通。
            if (!staleRef) execBar.appendChild(btn("重建并绑定项目主会话（接续）", rebuildMain, "primary"));
            execBar.appendChild(btn("仍要打开（跨工作区）", async () => {
              let v = null;
              try { v = await api("POST", `/api/tasks/${ref}/open-session`, { force: true }); } catch (_) { v = null; }
              const target = v?.sessionId ?? refSessionId;
              if (v?.opened) {
                bringConversationToFront(doc, target);
                showBanner(`已按你的要求打开跨工作区会话 ${String(target).slice(0, 14)}…（历史属于另一个项目，可能很大、打开较慢）`, "info");
                return;
              }
              if (openHostSession && target) {
                const r = openHostSession(target);
                if (r?.ok) { bringConversationToFront(doc, target); showBanner(`已请求打开跨工作区会话 ${String(target).slice(0, 14)}…`, "info"); return; }
              }
              void copyText(target ?? "").then((ok) => showBanner(ok ? `无法自动打开；已复制会话标识：${target}` : "无法自动打开，且剪贴板不可用（请手动复制）", "error"));
            }));
          }
        } else {
          execBar.appendChild(btn("重建并绑定项目主会话", rebuildMain, "primary"));
        }
        if (staleRef) execBar.appendChild(btn("重建并绑定项目主会话（接续）", rebuildMain, "primary"));
        execBar.appendChild(btn("刷新", () => void openTaskDetail(t)));
        execSec.appendChild(execBar);
        // FR-84 补口（2026-10-22）：**改绑已有会话**（不新建）—— 宿主建会话不可用（实例未加载 shim）时的保底接续出口。
        const drawerBindBar = mk("div", "tb-bind-bar");
        if (sessionId) drawerBindBar.appendChild(btn("用当前会话作为项目主会话", async () => {
          const r = await bindExistingSession(t.projectId, sessionId);
          if (r) await openTaskDetail(t);
        }, "primary"));
        drawerBindBar.appendChild(buildBindExistingControl(t.projectId, async () => { await openTaskDetail(t); }));
        execSec.appendChild(drawerBindBar);
        drawerBody.appendChild(execSec);

        // CLI 执行器（FR-52 落地 · 2026-10-18）：把任务交给项目配置的 cli:* 执行器**真实执行**。
        // 在此之前只有 API（POST /api/tasks/:ref/exec-cli），看板上点不到 —— 这一区补的就是那个入口。
        const cliSec = mk("div", "drawer-section");
        cliSec.appendChild(mk("h3", null, "CLI 执行器（真实执行）"));
        cliSec.appendChild(mk("p", "hint", "把该任务交给项目配置的 CLI 执行器（teamTemplate.roles[].executor = cli:*，且不在 forbiddenExecutors 中）真实执行：非交互调用 → 采集退出码 / 耗时 / 本次改动差集 → 写回评论 + 尝试记录；成功转「待验收」，失败走统一受阻入口。执行前会先认领并把卡片置为「进行中」——即使它原先在待办池等其它列，执行期也会如实显示在「进行中」，跑完再回到「待验收」。"));
        const cliOut = mk("pre", "cli-plan");
        cliOut.textContent = "（未预览）先点「预览执行计划」看清要跑什么，再决定是否真实执行。";
        cliSec.appendChild(cliOut);
        const cliBar = mk("div", "btn-row");
        const cliClosed = t.status === "done" || t.status === "cancelled";
        cliBar.appendChild(btn("预览执行计划", async () => {
          try {
            const r = await api("POST", `/api/tasks/${ref}/exec-cli`, { dryRun: true });
            const p = r.plan ?? {};
            cliOut.textContent = [
              `执行器：${p.executor ?? "—"}（CLI：${p.cli ?? "—"}）`,
              `角色：${p.role ?? "—"}`,
              `工作目录：${p.cwd ?? "（项目未设 workspacePath → 请先补）"}`,
              `命令：${p.cli ?? ""} ${(p.args ?? []).join(" ")}`.trim(),
              "",
              "提示词：",
              p.prompt ?? "—",
            ].join("\n");
            showBanner("已取回执行计划（未真正执行）", "info");
          } catch (e) {
            cliOut.textContent = `预览失败：${e.message}`;
            showBanner(`预览失败：${e.message}`, "error");
          }
        }));
        const cliEntryKind = cliEntry(t);
        if (cliEntryKind === "start") cliBar.appendChild(btn("交给 CLI 执行器执行", async () => {
          if (!window.confirm(`确认把 ${t.identifier} 交给 CLI 执行器**真实执行**？\n\n· 非交互调用本地 CLI（通常带文件写权限），耗时数十秒到数分钟\n· 执行前先认领：卡片将被置为「进行中」（原为 todo 则走授权门）\n· 完成后看板自动刷新为「待验收」或「受阻」，并附退出码/耗时/改动清单\n· 期间请勿重复点击`)) return;
          try {
            const r = await api("POST", `/api/tasks/${ref}/exec-cli`, { async: true });
            cliOut.textContent = [
              `已提交后台执行：${r.executor ?? "—"}（CLI：${r.plan?.cli ?? "—"}）`,
              `工作目录：${r.plan?.cwd ?? "—"}`,
              "",
              "执行完成后看板评论会给出退出码 / 耗时 / 改动清单；本页点「刷新」即可看到。",
            ].join("\n");
            showBanner(`已提交 CLI 执行器（${r.executor ?? "cli"}）后台执行，完成后看板自动刷新`, "info");
            await loadTasks();
          } catch (e) {
            showBanner(`提交失败：${e.message}`, "error");
          }
        }, "primary"));
        if (cliEntryKind !== "start") {
          // 入口与门对齐：本卡交给 CLI 执行器**必被拒**（归因门 / 人工校验门）⇒ 不给那个按钮，直接给可做的动作。
          const why = cliEntryKind === "human-review"
            ? "本卡是人工校验任务（FR-85b 升级门）：不得交给 CLI 执行器，请用「人工校验」区块的结论入口处置。"
            : "本卡未归属需求条目：「交给 CLI 执行器执行」会被归因门拦下（EXECUTION_NOT_ATTRIBUTED）。先归因，再预览/执行。";
          const warn = mk("p", "hint", `⚠ ${why}`);
          warn.style.color = "#b9770e";
          cliSec.appendChild(warn);
          if (cliEntryKind === "attribute") cliBar.appendChild(btn("去归因（关联需求条目）", () => { void openAttributionEntry(t); }, "primary"));
        }
        if (cliClosed) {
          const closedWarn = mk("p", "hint", `⚠ 该任务当前为「${STATUS_LABELS[t.status] ?? t.status}」——执行器仍可跑（执行时卡片会被移回「进行中」，跑完回到「待验收」），但产出需要人工确认；评审/完成确认归人，执行侧不得置 done。`);
          closedWarn.style.color = "#b9770e";
          cliSec.appendChild(closedWarn);
        }
        cliSec.appendChild(cliBar);
        drawerBody.appendChild(cliSec);

        // 诊断与恢复动作（FR-79）：结构化诊断（类型 / 严重度 / 说明 / 恢复动作），
        // 卡片上只有摘要徽标，完整列表在这里一次取回（exec.diagnostics）。
        const diagList = Array.isArray(exec?.diagnostics) ? exec.diagnostics : [];
        if (diagList.length > 0) {
          const SEV_LABEL = { high: "高危", medium: "中等", low: "提示" };
          const dsec = mk("div", "drawer-section");
          dsec.appendChild(mk("h3", null, `诊断与恢复动作（${diagList.length}）`));
          dsec.appendChild(mk("p", "hint", "每条诊断都带首选动作：点一下就能处置，处置后看板与计数会刷新（问题消失即自动消解）。"));
          for (const item of diagList) {
            const box = mk("div", `diag-item diag-item-${item.severity}`);
            const head = mk("div", "diag-head");
            head.appendChild(mk("span", `diag-sev diag-sev-${item.severity}`, SEV_LABEL[item.severity] ?? item.severity));
            head.appendChild(mk("span", "diag-title", item.title));
            if (item.count > 1) head.appendChild(mk("span", "diag-count", `第 ${item.count} 次`));
            box.appendChild(head);
            box.appendChild(mk("p", "hint diag-detail", item.detail));
            if (item.firstSeenAt) {
              box.appendChild(mk("p", "hint diag-time", `首次 ${new Date(item.firstSeenAt).toLocaleString()} · 最近 ${item.lastSeenAt ? new Date(item.lastSeenAt).toLocaleString() : "-"}`));
            }
            const bar = mk("div", "diag-actions");
            for (const a of item.actions ?? []) {
              // 需要额外输入的动作（如"派生为子任务"要标题）由上方「执行看护」区逐条提供
              if (a.needs) continue;
              bar.appendChild(btn(a.label, async () => {
                try {
                  const r = await api(a.method ?? "POST", a.path, a.body ?? {});
                  // FR-84：会话类动作的失败必须**说清原因**，且**绝不复制空标识**（真机事故：提示"已复制会话标识：-"）
                  if (a.id === "open_session" && r && r.opened === false) {
                    if (r.reason === "session-gone") {
                      showBanner(`接续会话 ${String(r.sessionId ?? "").slice(0, 18)}… 已失效（本机不存在）→ 请用「重建并绑定项目主会话」接续`, "error");
                    } else if (r.reason === "no-session") {
                      showBanner("任务与项目都没有可用会话引用 → 请用「重建并绑定项目主会话」接续", "error");
                    } else if (openHostSession && r.sessionId) {
                      // 与抽屉「打开执行会话」对齐：先真跳转，跳不动才降级复制标识。
                      // 此前这条路径**从不跳转**，永远只复制标识 —— 在诊断里点「打开会话」等于没打开。
                      const c = openHostSession(r.sessionId);
                      if (c?.ok) {
                        bringConversationToFront(doc, r.sessionId);
                        showBanner(`已切换到执行会话 ${String(r.sessionId).slice(0, 14)}…（已把「对话」视图切到前台；若仍停在「任务工作台」页，点上方「对话」即可看历史）`, "info");
                      } else {
                        void copyText(r.sessionId);
                        showBanner(`无法自动打开（${c?.reason ?? r.reason ?? "原因未知"}）；已复制会话标识：${r.sessionId}`, "error");
                      }
                    } else if (r.sessionId) {
                      void copyText(r.sessionId);
                      showBanner(`无法自动打开（${r.reason ?? "原因未知"}）；已复制会话标识：${r.sessionId}`, "error");
                    } else {
                      showBanner(`无法自动打开：${r.reason ?? "原因未知"}（且没有可复制的会话标识）`, "error");
                    }
                  } else if (a.id === "bind_session" && r && r.rebound) {
                    showBanner(`已重建并绑定项目主会话：${String(r.after).slice(0, 14)}…（开局提示词${r.openingDelivered ? "已投递" : `未投递：${r.deliveryReason ?? "原因未知"}`}）${sessionNameClause(r)}`, r.openingDelivered && r.titleApplied !== false ? "info" : "error");
                  } else {
                    showBanner(`已执行：${a.label}`, "info");
                  }
                  await loadTasks();
                  // 状态可能已变（如退回待办）→ 尽量用刷新后的任务对象重开抽屉
                  const fresh = (state.tasks ?? []).find((x) => x.identifier === t.identifier);
                  await openTaskDetail(fresh ?? t);
                } catch (e) { showBanner(`动作失败：${e.message}`, "error"); }
              }, a.kind === "primary" ? "primary" : "ghost"));
            }
            box.appendChild(bar);
            dsec.appendChild(box);
          }
          drawerBody.appendChild(dsec);
        }

        // 尝试记录（FR-82）：每次认领执行 = 一条尝试（结论 / 摘要 / 起止 / 心跳 / 运行时上限）
        const runs = Array.isArray(exec?.runs) ? exec.runs : [];
        {
          const rsec = mk("div", "drawer-section");
          const OUTCOME_LABELS = {
            success: "成功", blocked: "受阻", failed: "失败", crash: "崩溃", timeout: "超时",
            reclaimed: "认领被回收", cancelled: "人工作废", released: "释放归属", ended: "结束",
          };
          rsec.appendChild(mk("h3", null, `尝试记录（${runs.length}）`));
          if (runs.length === 0) {
            rsec.appendChild(mk("p", "hint", "还没有尝试记录：任务被认领执行时才会开出第一条（认领 → 尝试 → 结论，全程可回看）。"));
          } else {
            const table = mk("div", "run-list");
            for (const run of runs.slice().reverse()) {
              const row = mk("div", `run-item ${run.status === "running" ? "run-running" : "run-ended"}`);
              const head = mk("div", "run-head");
              head.appendChild(mk("span", "run-attempt", `第 ${run.attempt} 次`));
              head.appendChild(mk("span", `run-outcome run-outcome-${run.outcome ?? "running"}`, run.status === "running" ? "进行中" : (OUTCOME_LABELS[run.outcome] ?? run.outcome ?? "-")));
              const started = run.startedAt ? new Date(run.startedAt).toLocaleString() : "-";
              const dur = run.status === "running"
                ? `已跑 ${Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 60000))} 分钟`
                : (run.durationMs != null ? `耗时 ${Math.max(1, Math.round(run.durationMs / 1000))} 秒` : "-");
              head.appendChild(mk("span", "run-time", `${started} · ${dur}`));
              head.appendChild(mk("span", "run-heartbeats", `心跳 ${run.heartbeats}${run.maxMs ? ` · 上限 ${Math.round(run.maxMs / 60000)}m` : ""}`));
              row.appendChild(head);
              if (run.summary) row.appendChild(mk("p", "hint run-summary", run.summary));
              if (run.error) row.appendChild(mk("p", "hint run-error", `错误：${run.error}`));
              table.appendChild(row);
            }
            rsec.appendChild(table);
            rsec.appendChild(mk("p", "hint", "尝试记录与事件流同源：每次认领开一条、结束即闭合（成功 / 受阻 / 崩溃 / 超时 / 被回收）。"));
          }
          drawerBody.appendChild(rsec);
        }

        // 事件流（FR-82）：追加式生命周期事件（供看护 / 通知 / 详情共同消费，不各自造数）
        {
          const esec = mk("div", "drawer-section");
          esec.appendChild(mk("h3", null, "事件流"));
          const host = mk("p", "hint", "加载事件…");
          esec.appendChild(host);
          drawerBody.appendChild(esec);
          void (async () => {
            try {
              const payload = await api("GET", `/api/tasks/${ref}/events?limit=12`);
              if (destroyed) return;
              const list = payload.events ?? [];
              if (list.length === 0) { host.textContent = "暂无事件。"; return; }
              const box = mk("div", "event-list");
              const TYPE_LABELS = {
                created: "创建", status_changed: "状态变化", claimed: "认领", heartbeat: "心跳",
                run_started: "尝试开始", run_ended: "尝试结束", blocked: "受阻", succeeded: "成功记账",
                requeued: "退回待办", released: "释放归属", review_requested: "请求评审", failure_recorded: "记录失败",
              };
              for (const ev of list) {
                const row = mk("div", "event-item");
                row.appendChild(mk("span", "event-type", TYPE_LABELS[ev.type] ?? ev.type));
                row.appendChild(mk("span", "event-time", ev.at ? new Date(ev.at).toLocaleString() : "-"));
                const move = ev.from || ev.to ? `${ev.from ?? "-"} → ${ev.to ?? "-"}` : "";
                row.appendChild(mk("span", "event-move", [move, ev.detail].filter(Boolean).join(" · ")));
                box.appendChild(row);
              }
              host.replaceWith(box);
              esec.appendChild(mk("p", "hint", `最近 ${list.length} 条（游标至 ${payload.cursor}；上游订阅按游标取增量，不重复推送）。`));
            } catch (e) {
              host.textContent = `事件流加载失败：${e.message}`;
            }
          })();
        }

        // 执行看护（FR-75 停滞 / FR-76 "下一步建议"跟进）
        const watch = exec?.watchdog ?? null;
        if (watch && (watch.state === "stalled" || watch.state === "awaiting-decision")) {
          const wsec = mk("div", "drawer-section");
          wsec.appendChild(mk("h3", null, "执行看护"));
          const offline = watch.reason === "session-offline";
          if (watch.state === "stalled") {
            const p = mk("p", "hint", `⚠ 疑似停滞：已 ${watch.minutes} 分钟无进展回报（执行会话${offline ? "未在线" : "空闲"}）。任务会一直停在「进行中」——用上方「退回待办（重新派发）」释放并重派，或「标记失败」留证据。`);
            p.style.color = "#c0392b";
            wsec.appendChild(p);
          } else {
            wsec.appendChild(mk("p", "hint", `● 待你决策：执行方给出「下一步建议」（${watch.followups.length} 条，执行会话${offline ? "未在线" : "空闲"}，已 ${watch.minutes} 分钟）。逐条选择「派生为子任务」或「忽略」。`));
            const list = mk("div", "watchdog-actions");
            watch.followups.forEach((text, idx) => {
              const row = mk("div", "watchdog-suggestion");
              row.appendChild(mk("span", null, `建议 ${idx + 1}：${text}`));
              row.appendChild(btn("派生为子任务", async () => {
                try {
                  const r = await api("POST", `/api/tasks/${ref}/followup`, { action: "derive", title: text });
                  showBanner(`已派生 ${r.child?.identifier ?? "子任务"}（待办池，需授权后派发）`, "info");
                  await loadTasks(); await openTaskDetail(t);
                } catch (e) { showBanner(`派生失败：${e.message}`, "error"); }
              }, "primary"));
              row.appendChild(btn("忽略", async () => {
                try {
                  await api("POST", `/api/tasks/${ref}/followup`, { action: "dismiss", title: text });
                  showBanner("已忽略该建议（原文保留在反馈里可回溯）", "info");
                  await openTaskDetail(t);
                } catch (e) { showBanner(`忽略失败：${e.message}`, "error"); }
              }));
              list.appendChild(row);
            });
            wsec.appendChild(list);
            wsec.appendChild(mk("p", "hint", "派生出的子任务进入「待办池(backlog)」：需人工授权（backlog → 可开工）后才会被派发，不会被自动开工。"));
          }
          drawerBody.appendChild(wsec);
        }

        // 归属团队（FR-47；异步填充）
        const teamHost = mk("div", "drawer-section");
        teamHost.appendChild(mk("h3", null, "归属团队"));
        teamHost.appendChild(mk("p", "hint", "加载团队…"));
        drawerBody.appendChild(teamHost);
        void fillTaskTeam(t.identifier, teamHost);

        // 反馈 / 评论（执行证据、进展；也用于人工反馈）
        const cmSec = mk("div", "drawer-section");
        const comments = (detail && detail.comments) || [];
        cmSec.appendChild(mk("h3", null, `反馈 / 评论（${comments.length}）`));
        for (const c of comments) {
          // FR-24：评论走**与任务描述同一份** Markdown 渲染（`richText` → `renderMarkdown`），
          // 不再只塞 textContent —— 否则同一段 `**加粗**`/表格在描述里渲染、在评论里成字面量。
          const item = mk("div", "empty-note md-comment");
          item.style.textAlign = "left";
          // FR-17：编辑留痕要**看得见**（扁平显示"已编辑"就等于静默覆盖）。
          const editedNote = c.edited ? ` · 已编辑 ${c.editCount} 次（末次 ${fmtTime(c.editedAt)}，原正文可回看）` : "";
          item.appendChild(mk("div", "md-comment-meta", `${fmtTime(c.createdAt)}${editedNote}`));
          item.appendChild(richText(c.body));
          // FR-17：编辑入口。证据类评论（机器复核 `【自动复核】…` / 人工校验申报 `【人工校验申报】…`）
          // 一律只读 —— 与后端 `assertCommentEditable` 同一口径（前端隐藏入口，后端仍会拒绝，两道都在）。
          const rawBody = String(c.body ?? "");
          const readOnlyReason = /^【自动复核】/.test(rawBody)
            ? "评审证据评论（机器产出）· 不可编辑；需说明请另发评论"
            : rawBody.includes("【人工校验申报】")
            ? "人工校验申报评论（升级门判定依据）· 不可编辑；需更正请另发评论"
            : null;
          const editRow = mk("div", "btn-row");
          if (readOnlyReason) {
            editRow.appendChild(mk("span", "hint", readOnlyReason));
          } else {
            const editor = mk("textarea", "req-editor");
            editor.value = String(c.body ?? "");
            editor.style.display = "none";
            editRow.appendChild(btn("编辑", () => {
              const open = editor.style.display !== "none";
              editor.style.display = open ? "none" : "block";
            }));
            editRow.appendChild(btn("保存修改", async () => {
              const body = editor.value;
              if (body.trim() === "") { showBanner("评论正文不能为空", "error"); return; }
              if (body === c.body) { showBanner("内容未变化，未提交（不产生空编辑）", "info"); return; }
              try {
                const r = await api("PATCH", `/api/tasks/${ref}/comments/${encodeURIComponent(c.id)}`, { version: c.version, body });
                showBanner(r.changed ? "评论已更新（原正文已留痕，可回看）" : "内容未变化，未提交", "info");
                await openTaskDetail(t);
              } catch (e) {
                // FR-18：冲突必须**显式**提示，绝不静默覆盖。
                if (e.code === "VERSION_CONFLICT") showBanner("该评论已被他人修改（版本冲突）：请关闭重开会话查看最新内容后再编辑，本次未提交", "error");
                else if (e.code === "COMMENT_NOT_EDITABLE") showBanner(`该评论不可编辑：${e.message}`, "error");
                else showBanner(`编辑失败：${e.message}`, "error");
              }
            }, "primary"));
            editRow.appendChild(btn("查看历史", async () => {
              try {
                const r = await api("GET", `/api/tasks/${ref}/comments/${encodeURIComponent(c.id)}`);
                const revs = r.revisions ?? [];
                showBanner(revs.length ? `该评论有 ${revs.length} 个历史版本（编辑前原正文）：${revs.map((v) => `v${v.rev}@${fmtTime(v.editedAt)}`).join(" · ")}` : "尚无历史版本（未被编辑过）", "info");
              } catch (e) { showBanner(`读取历史失败：${e.message}`, "error"); }
            }));
            editRow.appendChild(editor);
          }
          item.appendChild(editRow);
          cmSec.appendChild(item);
        }
        if (!comments.length) cmSec.appendChild(mk("div", "empty-note", "暂无反馈 / 评论"));
        // 反馈：复制"结构化反馈指令"到执行会话整理，再把回传内容粘贴提交（非纯手工）
        const fbPrompt = `请在【本次执行会话】中真实总结并回传本次执行，按下列分段输出：\n简要：一句话概括\n总结：结论 / 现状\n建议：下一步建议\n解决方案：可执行方案 / 证据（失败请附：失败点 / 退出码 / 命令 / diff 摘要）`;
        const fbBar = mk("div", "btn-row");
        fbBar.appendChild(btn("复制结构化反馈指令（贴到执行会话）", () => { void copyText(fbPrompt).then((ok) => showBanner(ok ? "已复制：把该指令贴到执行会话，整理后回传" : "复制失败：浏览器拒绝了剪贴板写入，请手动复制该指令", ok ? "info" : "error")); }));
        cmSec.appendChild(fbBar);
        const fbTa = mk("textarea", "req-editor");
        fbTa.placeholder = "把执行会话回传的反馈粘贴到这里（简要 / 总结 / 建议 / 解决方案），再提交…";
        cmSec.appendChild(fbTa);
        const submitRow = mk("div", "btn-row");
        submitRow.append(
          btn("提交反馈", async () => { const body = fbTa.value.trim(); if (!body) { showBanner("请先粘贴反馈内容", "error"); return; } try { await api("POST", `/api/tasks/${ref}/comments`, { body: `【反馈】\n${body}` }); showBanner("已提交反馈", "info"); await openTaskDetail(t); } catch (e) { showBanner(`提交失败：${e.message}`, "error"); } }, "primary"),
          btn("清空", () => { fbTa.value = ""; }),
        );
        cmSec.appendChild(submitRow);
        drawerBody.appendChild(cmSec);

        // 治理审计（与本任务相关）
        const gov = mk("div", "drawer-section");
        gov.appendChild(mk("h3", null, `治理审计（${related.length}）`));
        if (related.length) for (const a of related) {
          const line = mk("div", "audit-row");
          line.append(statusPill(a.allowed ? "completed" : "blocked"), mk("span", null, `${a.action} · ${a.reason ?? ""}`), mk("div", "spacer"), mk("span", "hint", fmtTime(a.at)));
          gov.appendChild(line);
        } else gov.appendChild(mk("div", "empty-note", "暂无与本任务相关的治理记录"));
        drawerBody.appendChild(gov);
        // FR-87：把上次折叠的分区原样收起（分区标题即记忆键）
        for (const section of drawerBody.querySelectorAll(".drawer-section")) {
          const head = section.querySelector(":scope > h3");
          if (head && state.collapsedSections.includes(String(head.textContent ?? ""))) section.classList.add("collapsed");
        }
        syncExpandAllLabel();

        // 「下一步」引导（真机反馈 2026-10-22：「详情界面没有下一步该做啥的提示，也没有操作按钮」）。
        // 缺口实质：按钮此前按**功能分类**散落在「评审 / 操作 / 人工校验」各区块，没有一处回答
        // "我现在该干嘛"；被人工校验门挡住的卡只有一行文字，连跳过去下结论的入口都没有。
        // 口径唯一来源＝服务端 `GET /api/tasks/:ref/next-step`（纯函数 src/core/next-step.mjs + 单测），
        // 这里只把 action id 映射成按钮与处理器 —— 不在前端重写一遍判断，避免两份口径。
        {
          const scrollToSection = (keyword) => {
            const sec = Array.from(drawerBody.querySelectorAll(".drawer-section"))
              .find((s) => String(s.querySelector(":scope > h3")?.textContent ?? "").includes(keyword));
            if (!sec) return false;
            sec.classList.remove("collapsed"); // FR-87 折叠态下先展开，否则"跳过去"看不到东西
            sec.scrollIntoView({ block: "start", behavior: "smooth" });
            return true;
          };
          const reopen = async () => { await loadTasks(); const fresh = (state.tasks ?? []).find((x) => x.identifier === t.identifier); await openTaskDetail(fresh ?? t); };
          const openSessionBtn = Array.from(drawerBody.querySelectorAll("button")).find((b) => String(b.textContent ?? "") === "打开执行会话");
          const runs = {
            "open-blocker": async (step) => {
              const target = (allTasks.tasks || []).find((x) => x.identifier === String(step?.blocker?.identifier ?? ""));
              if (!target) { showBanner("前置卡不在当前看板数据里：请刷新后重试", "error"); return; }
              await openTaskDetail(target);
            },
            "conclude-human-review": () => { if (!scrollToSection("人工校验")) showBanner("未找到「人工校验」区块", "error"); },
            "goto-review": () => { if (!scrollToSection("评审")) showBanner("未找到「评审」区块", "error"); },
            "goto-deps": () => { if (!scrollToSection("前后关联")) showBanner("未找到「前后关联」区块", "error"); },
            "goto-diagnostics": () => { if (!scrollToSection("诊断")) showBanner("本卡暂无「诊断」区块（未命中任何诊断规则时不渲染）", "error"); },
            "goto-attribution": () => { if (!scrollToSection("归因")) showBanner("未找到「归因」区块", "error"); },
            "review-approve": async () => {
              try { await api("POST", `/api/tasks/${ref}/review`, { action: "approve", comment: "" }); showBanner("评审通过（仍需人工确认后置「完成」）", "info"); await reopen(); }
              catch (e) { showBanner(`评审操作失败：${e.message}`, "error"); }
            },
            "authorize": async () => {
              try { await api("PATCH", `/api/tasks/${ref}`, { version: t.version, status: "todo" }); showBanner("已授权开工", "info"); await reopen(); }
              catch (e) { showBanner(`授权失败：${e.message}`, "error"); }
            },
            "start-execution": async () => {
              if (!window.confirm(`启动执行会尝试新建/切换会话（可能切换主视图）。${execRunning ? "\n\n⚠ 该任务已有执行会话正在执行且未返回结论，继续会被拒绝（EXECUTION_ALREADY_RUNNING）。" : ""}确认继续？`)) return;
              try { await api("POST", `/api/tasks/${ref}/execute`, undefined); closeDrawer(); await loadTasks(); }
              // 第三条入口（下一步面板）：此前是裸 catch，同一次失败换条路进来就没有归因引导了。
              catch (e) { await handleExecutionFailure(e, ref, t); }
            },
            "retry": async () => {
              const extra = execRunning ? "\n\n⚠ 该任务已有执行会话正在执行中；退回后会释放任务级锁，但再次下发仍会被拒（需等会话结束）。" : "";
              if (!window.confirm(`退回「可开工(todo)」并释放任务级锁，等待重新派发。确认？${extra}`)) return;
              try { await api("POST", `/api/tasks/${ref}/execution/retry`, {}); closeDrawer(); await loadTasks(); showBanner("已退回待办（锁已释放）", "info"); }
              catch (e) { showBanner(`退回失败：${e.message}`, "error"); }
            },
            "open-session": () => { if (openSessionBtn) openSessionBtn.click(); else showBanner("本卡尚无执行会话可打开", "error"); },
            "complete": async () => {
              // FR-83 补口（卡 `-162`）：「下一步」区的「完成」是**处置区的正规入口**，也是唯一还能
              // 主动收口的地方。评审未通过的卡在这里走**跳过评审**这条显式路线（`moveTask` 内部出确认框、
              // 确认后才带 `skipReview: true`）；评审已通过的卡维持原确认文案。
              const skippingReview = needsReviewSkip(t, "done");
              if (!skippingReview && !window.confirm(`确认把 ${t.identifier} 置为「完成」？完成只有人能确认，且不会自动回退。`)) return;
              if (!(await moveTask(t, "done"))) return; // 失败横幅 / 取消提示均由 moveTask 负责，成功则必须自己报出来
              showBanner(skippingReview
                ? `已把 ${t.identifier} 置为「完成」——本次跳过评审，已在事件流与审计里留痕（review_skipped）。`
                : `已把 ${t.identifier} 置为「完成」——完成只能由人确认，且不会自动回退。`, "info");
              // 用户 2026-10-22 约束①「任务执行正常的，确认后即关闭」：收口即关抽屉（卡片已进「完成」列），
              // 需要复核时再点开卡片 —— 那时抽屉是收口版布局（处置区默认收起，可一键展开）。
              closeDrawer();
            },
            // ── FR-97：给「无法规范流转」的卡两个真能往前推的出口 ──────────────────
            // 两个 id 未接线时会被渲染成禁用态「未接线的动作：…」，因此这里必须补齐。
            "dispatch-main-session": async () => {
              if (!window.confirm(`把「${t.identifier}」的调试修复指令投递给项目主会话？\n\n投递成功会把本卡置为「进行中」。指令内含边界红线（不 commit / 不 push / 不置 done / 动 ~/.dsh 与重启宿主须先报批）。`)) return;
              try {
                const r = await api("POST", `/api/tasks/${ref}/dispatch-main-session`, {});
                if (r?.delivered) { showBanner(`已交项目主会话执行（调试修复）——会话 ${r.sessionId}（来源 ${r.source ?? "未知"}）`, "info"); await reopen(); }
                else showBanner(`未能投递：${r?.reason ?? "未知原因"}。下一步：${r?.nextAction ?? "查看诊断"}`, "error");
              } catch (e) { showBanner(`交主会话失败：${e.message}`, "error"); }
            },
            "to-debug": async () => {
              if (!window.confirm(`把「${t.identifier}」标记为「执行调试」并退回「待办」，由人接手？`)) return;
              try {
                await api("POST", `/api/tasks/${ref}/to-debug`, {});
                showBanner("已转为「执行调试」并退回待办", "info");
                await reopen();
              } catch (e) { showBanner(`转调试失败：${e.message}`, "error"); }
            },
          };
          let step = null;
          try { step = (await api("GET", `/api/tasks/${ref}/next-step`))?.nextStep ?? null; } catch (_) { step = null; }
          // 这一步 await 过 ⇒ 必须重判代次，否则本代的「下一步」区块会被追加到后一代的抽屉里（重复区块）。
          if (renderSeq !== detailRenderSeq) return;
          // 引导拿不到不阻断抽屉（老服务/端点异常时照旧能看到其它区块）；但不静默 —— 留一行说明。
          // FR-89（真机反馈 2026-10-22）：「收口了为何还有这么多校验/评审/执行会话按钮」「异常时既可评审又可检验、无从下手」。
          // 处置 = 只做**呈现层默认折叠**（内容与按钮一个不删，点标题即可展开），并把人手动开过的区块排除在外。
          const isClosed = t.status === "done" || t.status === "canceled";
          const foldedTitles = step ? applyFocusPolicy(step.focus) : [];
          syncExpandAllLabel();
          const sec = mk("div", "drawer-section next-step");
          sec.appendChild(mk("h3", null, "下一步"));
          if (!step) {
            sec.appendChild(mk("div", "empty-note", "下一步引导不可用：服务端尚未加载该端点（GET /api/tasks/:ref/next-step 返回 404）——重载插件后生效。当前请按下方各区块自行判断。"));
          } else {
            sec.appendChild(mk("div", "next-step-title", step.title));
            if (step.hint) sec.appendChild(mk("p", "hint", step.hint));
            // 操作顺序：异常/待办卡不许只丢几个并列按钮让人自己猜先点哪个（FR-89 第二条约束）。
            if (Array.isArray(step.steps) && step.steps.length) {
              const ol = mk("ol", "next-steps");
              for (const s of step.steps) ol.appendChild(mk("li", null, s));
              sec.appendChild(ol);
            }
            if ((step.actions || []).length) {
              const bar = mk("div", "next-actions");
              for (const a of step.actions) {
                const cls = a.kind === "primary" ? "primary" : (a.kind === "danger" ? "danger" : "");
                const node = mk("button", cls, a.label);
                node.type = "button";
                const run = runs[a.id];
                if (!run) { node.disabled = true; node.title = `未接线的动作：${a.id}`; }
                else node.addEventListener("click", () => void run(step));
                bar.appendChild(node);
              }
              sec.appendChild(bar);
            } else {
              sec.appendChild(mk("div", "empty-note", isClosed ? "本卡已收口：没有待办动作。要复核就展开下面的处置区（按钮照旧可用）。" : "本卡无待办动作。"));
            }
            if (foldedTitles.length) {
              sec.appendChild(mk("p", "hint", isClosed
                ? `已默认收起 ${foldedTitles.length} 个处置区：${foldedTitles.join(" / ")} —— 收口后不再和只读信息抢位置，内容与按钮都在。`
                : `已收起与「${step.title}」无关的处置区：${foldedTitles.join(" / ")} —— 先做这一步；需要时点区块标题展开。`));
              const moreBar = mk("div", "next-actions");
              const more = mk("button", null, isClosed ? "展开复核处置" : "展开其余处置区");
              more.type = "button";
              more.title = "只影响显示：展开后评审 / 人工校验 / 执行会话的按钮照旧可用";
              more.addEventListener("click", () => {
                for (const section of drawerSections()) {
                  if (foldedTitles.includes(String(section.querySelector(":scope > h3")?.textContent ?? ""))) setSectionCollapsed(section, false);
                }
                syncExpandAllLabel();
                const first = drawerSections().find((s) => foldedTitles.includes(String(s.querySelector(":scope > h3")?.textContent ?? "")));
                first?.scrollIntoView({ block: "start", behavior: "smooth" }); // 展开后直接送到第一个处置区，省得再找
              });
              moreBar.appendChild(more);
              sec.appendChild(moreBar);
            }
          }
          // 幂等兜底（2026-10-23 · 用户批注「两个完成按钮」的第二道防线）：代次守卫已挡住已知的并发路径，
          // 但「下一步」区块是抽屉里**唯一**在 await 之后才追加的 DOM —— 一旦将来又冒出新的并发入口绕过守卫，
          // 症状仍旧是「两个完成按钮」。这里把人能看到的**输出不变量**钉死：同一抽屉里只允许有一个该区块。
          for (const staleNextStep of Array.from(drawerBody.querySelectorAll(".drawer-section.next-step"))) staleNextStep.remove();
          drawerBody.insertBefore(sec, drawerBody.firstChild); // 放最前：先回答"该干嘛"，再看明细
        }
      } catch (error) {
        if (renderSeq !== detailRenderSeq) return; // 已被更新的一代取代 ⇒ 不要把失败占位压到新一代的成品上
        drawerActions.replaceChildren();
        drawerBody.replaceChildren(mk("p", "hint", `加载失败：${error.message}`));
      }
    }

    /**
     * FR-86：把一轮执行循环的裁剪结果压成**一行摘要**（人一眼看到「为什么没全派出去」）。
     * 全 0 时返回空串 —— 界面上不允许留一行「让行 0 · 阻塞 0」的噪音。
     */
    function loopCutSummary(result) {
      if (!result) return "";
      const parts = [];
      const serialized = Array.isArray(result.serialized) ? result.serialized.length : 0;
      if (serialized > 0) parts.push(`让行 ${serialized}（共享文件冲突）`);
      const counted = new Map();
      for (const item of result.stopped ?? []) counted.set(item.reason, (counted.get(item.reason) ?? 0) + 1);
      for (const reason of Object.keys(LOOP_STOP_LABELS)) {
        const n = counted.get(reason) ?? 0;
        if (n > 0) parts.push(`${LOOP_STOP_LABELS[reason]} ${n}`);
        counted.delete(reason);
      }
      for (const [reason, n] of counted) parts.push(`${reason} ${n}`); // 后端新增原因不许静默丢失
      return parts.join(" · ");
    }

    /**
     * FR-86：执行循环结果面板（让行 / 关键阻塞 / 上游 / 同需求并行 四张清单）。
     * FR-86 验收第三句要求「共享文件冲突时串行化相关任务并**在看板显式标注原因**」——
     * 后端早已返回这些结构化字段，缺的一直是**呈现**：此前只报「跳过 N」，原因全丢。
     */
    function loopResultSection(lastLoop) {
      const r = lastLoop?.result ?? {};
      const sec = mk("div", "drawer-section loop-result");
      const at = lastLoop?.at ? new Date(lastLoop.at).toLocaleString() : "（时间未知）";
      sec.appendChild(mk("h3", null, `执行循环结果（${at}）`));
      sec.appendChild(mk("p", "hint", "本轮循环的可复算快照：候选人选、放行了谁、为什么让行或裁剪。"));
      sec.appendChild(kvList([
        ["引擎", r.engine ?? "（未记录）"],
        ["候选", String(r.candidates ?? 0)],
        ["已派发", String((r.dispatched ?? []).length)],
        ["跳过", String(r.skipped ?? 0)],
      ]));
      const cuts = mk("div", "loop-cuts");
      const group = (title, rows) => {
        if (!rows.length) return;
        const box = mk("div", "loop-cut-group");
        box.appendChild(mk("h4", null, `${title}（${rows.length}）`));
        for (const row of rows) box.appendChild(mk("p", "hint loop-cut-row", row));
        cuts.appendChild(box);
      };
      group("让行（共享文件冲突 · 显式串行）", (r.serialized ?? []).map((x) => `${x.task} 与 ${x.heldBy} 冲突于 ${x.file}${x.detail ? `：${x.detail}` : ""}`));
      group("关键阻塞裁剪", (r.stopped ?? []).map((x) => `${x.task} · ${LOOP_STOP_LABELS[x.reason] ?? x.reason}${x.detail ? `：${x.detail}` : ""}${(x.downstream ?? []).length ? `（影响下游 ${(x.downstream ?? []).join("、")}）` : ""}`));
      group("上游依赖未就绪", (r.blockedByUpstream ?? []).map((x) => `${x.task} · ${x.detail ?? x.reason ?? ""}`));
      group("同需求最大并行", (r.parallel ?? []).map((x) => `${x.requirement ?? x.requirementId ?? "（未归因）"}：本轮派发 ${x.count} 条 —— ${x.reason}`));
      if (!cuts.childNodes.length) cuts.appendChild(mk("div", "empty-note", "本轮无裁剪：候选任务全部按并发上限放行。"));
      sec.appendChild(cuts);
      return sec;
    }

    // ------------------------------------------------------------ 团队视图
    async function renderTeamView() {
      teamRoot.replaceChildren(mk("p", "hint", "加载团队…"));
      try {
        const q = encodeURIComponent(state.projectId);
        const [data, settings, avail] = await Promise.all([
          api("GET", "/api/teams"),
          api("GET", `/api/projects/${q}/settings`).catch(() => ({ teamTemplate: {} })),
          api("GET", `/api/projects/${q}/agent-teams`).catch(() => ({ teams: [] })),
        ]);
        const box = mk("div", "config-view");
        const cur = mk("section", "config-card");
        cur.appendChild(mk("h3", null, "当前执行团队（来自配置）"));
        // FR-67：生效派发引擎 = 活跃执行者团队优先（第②条验收：下发走所选团队对应引擎）。
        // 与后端 `resolveEngine()` 同口径：official:* → official；third-party:* → nanmicoder；
        // 未选择 / 来源未知 → 回落 teamTemplate.engine。
        const actTeam = settings.teamTemplate?.executionTeam ?? null;
        const actSrc = String(actTeam ?? "").split(":")[0];
        const effEngine = actSrc === "official" ? "official" : actSrc === "third-party" ? "nanmicoder" : (settings.teamTemplate?.engine ?? "instruction");
        cur.appendChild(kvList([["引擎", `${effEngine}${actTeam ? `（来自活跃执行者 ${actTeam}）` : "（来自团队模板配置）"}`], ["执行团队", actTeam ?? "（未选择）"]]));
        cur.appendChild(mk("p", "hint", "在「配置 → 执行团队(引擎)」修改；此处即时反映。"));
        // 活跃执行者切换（本项目的主会话团队之间切换）
        const actSel = mk("select");
        for (const t of (avail.teams || [])) { const o = mk("option"); o.value = `${t.source}:${t.id}`; o.textContent = `${t.name}（${t.source}）`; actSel.appendChild(o); }
        actSel.value = settings.teamTemplate?.executionTeam ?? (avail.teams?.[0] ? `${avail.teams[0].source}:${avail.teams[0].id}` : "");
        const actRow = mk("div", "config-row");
        actRow.appendChild(mk("span", null, "切换活跃执行者"));
        const actRight = mk("span", "config-actions");
        actRight.append(actSel, btn("设为活跃", async () => { try { await api("PUT", `/api/projects/${q}/settings`, { teamTemplate: { ...(settings.teamTemplate || {}), executionTeam: actSel.value } }); showBanner(`已切换活跃执行者：${actSel.value}`, "info"); await renderTeamView(); } catch (e) { showBanner(`切换失败：${e.message}`, "error"); } }, "primary"));
        actRow.appendChild(actRight);
        cur.appendChild(actRow);
        cur.appendChild(mk("p", "hint", `主会话（本项目的团队归属）：${avail.mainSessionId ?? "（未绑定）"}；仅列主会话自身的团队。`));
        // 执行循环：把"人工设为待执行(todo)且已归因"的任务自动派发给活跃执行者团队
        const loopRow = mk("div", "config-row");
        loopRow.appendChild(mk("span", null, "看板执行循环"));
        const loopRight = mk("span", "config-actions");
        loopRight.append(btn("运行执行循环", async () => {
          try {
            const r = await api("POST", `/api/projects/${q}/execution-loop`, { limit: 20 });
            state.lastLoop = { projectId: q, at: new Date().toISOString(), result: r };
            const inflight = r.blockedByInflight || [];
            const base = `执行循环：候选 ${r.candidates} · 已派发 ${r.dispatched.length}${(r.decomposed || []).length ? ` · 自动拆解 ${r.decomposed.length}` : ""} · 跳过 ${r.skipped}（引擎 ${r.engine}）`;
            const cut = loopCutSummary(r);
            const warn = inflight.length ? `⚠ 已有执行会话在执行、未返回结论，已停发 ${inflight.length} 条：${inflight.map((x) => x.task).join("、")}` : "";
            showBanner([base, cut, warn].filter(Boolean).join(" · "), inflight.length ? "error" : "info");
            await renderTeamView();
          }
          catch (e) { showBanner(`执行循环失败：${e.message}`, "error"); }
        }, "primary"));
        loopRow.appendChild(loopRight);
        cur.appendChild(loopRow);
        cur.appendChild(mk("p", "hint", "对看板中「人工设为待执行(todo)且已归因」的任务，自动派发给当前活跃执行者（按依赖/锁跳过）。"));
        // FR-86：把循环的**结构化裁剪结果**摆到人眼前。此前 UI 只读 `blockedByInflight`，
        // `serialized`（共享文件让行）/`stopped`（关键阻塞/上限）/`blockedByUpstream`/`parallel`
        // 全部被丢掉 —— 人只看到「跳过 N」，**看不到原因**，而 FR-86 验收要求"串行化该文件相关
        // 任务并**在看板显式标注原因**"。这里把 API 已有的原因原样摊开（不新增后端口径）。
        const loopResultHost = mk("div", "loop-result-host");
        if (state.lastLoop && state.lastLoop.projectId === q) loopResultHost.appendChild(loopResultSection(state.lastLoop));
        cur.appendChild(loopResultHost);
        box.appendChild(cur);
        const av = mk("section", "config-card");
        av.appendChild(mk("h3", null, `可用团队（${(avail.teams || []).length}）`));
        const avl = mk("ul", "req-list");
        for (const t of (avail.teams || [])) { const li = mk("li", "req-item"); li.append(mk("span", "req-title", t.name), pill(`${t.source}${t.phase ? ` · ${t.phase}` : ""}${t.memberCount != null ? ` · ${t.memberCount} 成员` : ""}`)); avl.appendChild(li); }
        av.appendChild(avl);
        box.appendChild(av);
        box.appendChild(mk("h2", null, `工作台本地派发记录（${data.count}）`));
        box.appendChild(mk("p", "hint", "数据来源：工作台本地记录（team_runs/team_members/team_tasks）——与承载环境 agent-team 插件的「编队」是两套；插件侧真实团队成员不在此显示（见 G-2）。"));
        if (!data.count) box.appendChild(mk("p", "hint", "暂无团队派发记录。派发入口：任务详情/看板 → 启动执行，或调用 /api/teams。"));
        for (const entry of data.teams) box.appendChild(teamDetailCard(entry));
        teamRoot.replaceChildren(box);
      } catch (error) {
        teamRoot.replaceChildren(mk("p", "hint", `加载失败：${error.message}`));
      }
    }
    return {
      apiBase,
      refresh: loadTasks,
      getState: () => state,
      destroy() {
        destroyed = true;
        try { window.clearInterval(watchdogPoll); } catch { /* ignore */ }
        try { document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("focus", refreshOnReturn); } catch { /* ignore */ }
        try { boardEvents?.close(); } catch { /* ignore */ }
        try {
          dialog.close();
        } catch {
          /* ignore */
        }
        root.replaceChildren();
      },
    };
  }


  /**
   * 解析人粘回来的任务行 → `{ tasks, problems }`（2026-10-28）。
   *
   * 为什么这段在**前端**而不是 `src/core/split-ask.mjs`：服务端只吃结构化 `tasks`（同一条 `/split`），
   * 需要"读懂人贴进来的文本"的只有浏览器。放在这里的好处是零构建、可直接被验证台调用；
   * 单元测试用 `vm` 加载本文件后调 `window.__TB_BOARD__.parseSplitLines`（见 tests/fr-req-split-ask.test.mjs）。
   *
   * 容错口径：允许行首序号列（`3` / `3.` / `3、`）与全角 `｜`、允许缺列、允许 ``` 围栏；
   * **解析不上的行不静默丢** —— 收进 `problems` 交回界面显形。
   */
  function parseSplitLines(text) {
    const tasks = [];
    const problems = [];
    const rows = String(text == null ? "" : text).split("\n").map((l) => l.trim()).filter(Boolean);
    const numOf = new Map();
    const pendingDeps = [];
    for (const raw of rows) {
      if (/^```/.test(raw)) continue;
      const cells = raw.replace(/\uFF5C/g, "|").split("|").map((c) => c.trim());
      let seq = null;
      if (cells.length > 1 && /^\d+[.、)]?$/.test(cells[0])) { seq = Number(cells[0].replace(/[.、)]/g, "")); cells.shift(); }
      const title = String(cells[0] || "").replace(/^[-*]\s+/, "").trim();
      if (!title) { problems.push(`空标题：${raw}`); continue; }
      const owner = cells[1] ? cells[1] : null;
      const kindRaw = cells[2] ? String(cells[2]).toLowerCase() : "";
      const depRaw = cells[3] || "";
      let kind = null;
      if (kindRaw) {
        if (kindRaw === "work" || kindRaw === "review") kind = kindRaw;
        else problems.push(`kind 非法（已忽略）：${raw}`);
      }
      const index = tasks.length;
      tasks.push(Object.assign({ title }, owner ? { owner } : {}, kind ? { kind } : {}));
      if (seq !== null) numOf.set(seq, title);
      const refs = String(depRaw).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      if (refs.length) pendingDeps.push({ index, refs });
    }
    for (const item of pendingDeps) {
      const deps = [];
      for (const ref of item.refs) {
        const bySeq = numOf.get(Number(ref));
        const byTitle = tasks.some((t) => t.title === ref);
        if (bySeq) deps.push(bySeq);
        else if (byTitle) deps.push(ref);
        else problems.push(`依赖目标找不到（已忽略）：${ref}`);
      }
      if (deps.length) tasks[item.index].dependsOn = deps;
    }
    return { tasks, problems };
  }

  window.__TB_BOARD__ = { createBoard, version: 3, parseSplitLines };

  // 独立验证台：index.html 提供 #tb-app 容器时自动挂载
  function autoMount() {
    const host = document.getElementById("tb-app");
    if (!host || window.__TB_BOARD__.__controller) return;
    try {
      localStorage.getItem("tb-theme");
    } catch {
      /* ignore */
    }
    window.__TB_BOARD__.__controller = createBoard({ root: host, apiBase: "" });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", autoMount);
  else autoMount();
})();
