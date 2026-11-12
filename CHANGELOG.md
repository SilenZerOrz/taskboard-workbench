# Changelog

`taskboard-workbench` 的全部对外版本变更记录。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本对应一个 annotated tag（`vX.Y.Z`）与一条 GitHub Release；npm dist-tag 与 dsh 兼容区间随版本记录。

## [0.3.3] - 2026-11-12

> 主题：**把「团队执行时缺的那几条路」补齐，并让两个宿主看见同一份库** —— 双宿主对齐（写者租约 + 数据目录自证）、
> 按卡选执行者、交付证据写入口双通道（含 `agents` 雏形与 WAL）、开局提示词注入当前项目、人工撤单入口，
> 外加四条团队执行期实测出来的缺陷修复。
> 版号按本仓既定口径走 **`0.3.x` patch**（`0.3.2` 已声明「`0.3.x` 期 patch 号承载修复 + 可选能力」，
> `0.4.0` 留给计划文档里预留的确认层 `acceptance_state`）—— 不另起 minor 线。
> 读数：`npm test` **1225 / 0** · `release-precheck` **EXIT=0** · tarball **86** 文件 · `schemaVersion` **14 → 15**。

### 新增

- **双宿主数据对齐（卡 `-236`/`-237` / 需求 `R173`）** —— web 与 desktop **共用同一份库**，且界面能自证「连的是哪个库」：
  只读跟随者常驻条（`role=follower` 30s 刷新）、写者租约（同时只有一个写者）、`/api/health` 直接给 `dataDir` 与 `dbPath`。
- **按卡选执行者（卡 `-238` / 需求 `R174`）** —— 任务卡「启动执行」可按卡挑执行者（团队 / 宿主会话 / claude · codex · hermes 等 CLI），
  前端按注册表渲染图标并按 `id` 派发；**不传执行者 = 原口径**，升级后默认行为不变。
- **交付证据写入口双通道（卡 `-239`/`-241` / 需求 `R175`）** —— HTTP 与 MCP `card_evidence_submit` **同源**：
  同一个 store 方法、同一道四字段硬门、同一套错误码；`task_evidence` 增 `evidence_hash` 幂等索引（重复推送不再堆重复行），
  并落 `agents` / `agent_sessions` 雏形与 WAL（`schemaVersion` **14 → 15**）。
- **人工撤单入口（卡 `-252` / 需求 `R180`）** —— 抽屉标题栏新增 danger 档「取消任务（撤单）」：原因必填、页内 dialog 二次确认，
  撤单后把原因写成评论（此前「确认不执行」的卡在界面上根本没有出口，只能挂着）。

### 修复

- **内嵌宿主下 `window.prompt` 直接报错（卡 `-240`/`-242` / 需求 `R176`）** —— 新建项目 / 返工说明 / 人工结论 / 需求标题
  四处取值出口改走**页内 dialog**（`askFields`），取消零副作用；`tests/no-prompt.test.mjs` 守结构门与「三条取消出口统一归 `null`」。
- **配置页「复制开局提示词」注入当前项目（卡 `-243` / 需求 `R177`）** —— 此前复制的是**默认项目**的开局语，新会话按错误目录开工；
  现按 `state.projectId` 现算，未设工作目录时**如实提示不猜路径**。
- **`requestReview` 缺省自动指派评审者（卡 `-244` / 需求 `R178`）** —— 此前只把 `review_state` 置 pending、`reviewer` 留空，
  ⇒ `review_deadlock` 是**必然产物**；现按团队模板缺省指派（真机验证：不传 reviewer ⇒ 回读 `reviewer="reviewer"`）。
- **同态迁移不再写空转事件（卡 `-245` / 需求 `R178`）** —— `in_review → in_review` 不再追加 `status_changed`，事件流恢复成「状态真的变了」才算。
- **复核命令不可执行时判「不适用」，不再谎报失败（卡 `-249` / 需求 `R179`）** —— 命令里带未替换占位符（如 `<diff文件>`）时，
  此前跑出 `sh: syntax error` 并被记成「失败（退出码 2）」；现在 `applicable=false` 且明确说出是哪个占位符没替换。
- **发布门禁误报（测试夹具）** —— `tests/executors.test.mjs` / `tests/kickoff-prompt-project.test.mjs` 的假家目录写成真机路径形态，
  命中 L2「mac-home」规则使门禁转红；夹具改中性临时路径，门禁回到 `EXIT=0`。

### 兼容性与升级注意

- **npm `latest` 升到 `0.3.3`**；`engines.dsh` 仍为 `>=0.2.1-rc.3`（本机验证形态 `0.2.2-rc.1`）。
- **`schemaVersion` 14 → 15**：首启自动迁移（`task_evidence` 补 `evidence_hash` 列 + 指纹索引，幂等）。
  回退到 `0.3.2` 读同一个库**不安全**（旧代码不认识新列），要回退请连同 `.data` 快照一起回。
- **证据写入变幂等**：同一张卡、同一份产物指纹重复推送只留一行 —— 依赖「每次 push 都新增一行」的外部统计口径需要改。
- **撤单不会自动解锁下游**：`isTaskReady` 仍只把 `done` 当完成（`canceled` 算未完成），口径待定，见卡 `-253` / 需求 `R181`（backlog）。

## [0.3.2] - 2026-11-06

> 主题：**把三轮「卡上已收口、包里还没有」的改动一次补齐** —— `0.3.1` 之后又攒了开局长注入（P5 档 C）、
> 开局对齐（R170）、真机批注批（六条）与规范随包（`4c8f8a9`）四项进包变更，按 D7 攒批一次发。
> 版号 `0.3.2` 为 2026-11-06 拍板结果（`0.3.x` 期内 patch 号承载「修复 + 可选能力」，不另起 `0.4.0` 线；
> `0.4.0` 留给计划文档里预留的「确认层 `acceptance_state`」，那批尚未开工）。
> 读数：`npm test` **1143 / 0** · `release-precheck` **EXIT=0** · tarball **83** 文件 · `schemaVersion` **13 → 14**。

### 新增

- **开局注入 · P5 档 C（卡 `-210` / 需求 `R128`，`ede1d01`）** —— 新模块 `src/core/flow-inject.mjs`；
  项目设置增 `flow_inject_policy`（`off` / `main-only` / `main+exec` / `all`），
  宿主 `createSession` 出口按 **policy × role** 分流：主会话拿完整流程块（逐字节等于 `tb-flow start`），
  执行会话拿摘要版，子代理不注入。**默认 `off` ⇒ 升级后行为零变化**，必须显式开。
  注入异常只回 `injection.reason`、**不阻断会话创建**（建会话失败比少注入一句严重得多）。
- **项目开局对齐 · 可直接进主对话（卡 `-229`/`-230`/`-231` / 需求 `R170`，`ede1d01`）** —— 新模块 `src/core/kickoff.mjs`：
  把「项目开局还缺什么」生成成**分步 todolist 正文**并投递进项目主会话；项目未绑主会话时抛新错误码
  **`NO_MAIN_SESSION`**（冲突类，不是数据错误 —— 与「这件事做不到」区分开）。
- **需求条目简写 `R170`（卡 `-234` / 需求 `R171`，`ede1d01`）** —— 带项目上下文时可直接写简写；
  **不带项目时不跨项目猜**，而是把各项目同序号的全标识列成候选。
  `REQUIREMENT_NOT_FOUND` 收敛到唯一构造点，`details.hint` + `details.examples` 给**可直接照抄**的写法（报错即文档）。
- **兼容层与配置分离（卡 `-216`/`-218`/`-219`/`-220` / 需求 `R159`–`R161`，`4c8f8a9`）** ——
  ① 需求条目 `detailState` 派生三态（`mirror` / `truncated` / `full`），列表胶囊 + 详情「完整性」字段（真实库 87/9/60）；
  ② `spec/norms/item-detail.md` 入册（`NORM_IDS` 5 → 6）+ 项目副本 `<工作区>/.taskboard/norms/` + 配置页「规范来源」卡片；
  ③ `spec/docs/` 四份通用人读文档入包，配只读守卫 `tools/check-docs.mjs`；
  ④ `GET|POST|PUT /api/projects/:id/docs` + 配置页「文档与规范位置」卡片：**包内默认 / 项目存放（可改）/ 生效来源**三栏都可见可改。
- **任务抽屉按钮分层（卡 `-224` / 需求 `R164`）** —— 标题栏拆 `.tb-drawer-actions`（卡片级动作）与
  `.tb-drawer-utils`（全部收起 / 全屏 / 关闭）两段，中间画发丝线，位置不再由 `append` 顺序决定；
  并保证**全抽屉至多一个 primary**（此前一屏 5–7 个同权重蓝块，人看不出该点哪个）。只做呈现，不删按钮、不改回调。
- **真机批注四条（`-225`–`-228` / 需求 `R166`–`R169`）** —— 需求工具栏回归一栏；「引入的文件」按文件夹树呈现
  （对齐 dsh 侧栏样式）；配置页会话关联可直接跳转主会话 / 相关会话；配置页八步引导按**真实代码**重排
  （此前「开局提示词」排在第八步，与实际流程不符）。
- **启动分步容错 + 常驻降级条（卡 `-222` / 需求 `R163`）** —— 启动改 `runBootStep` 分步执行：可降级步骤失败时**面板照常可用**，
  并在顶部留一条**不会自动消失**的说明条（带「重试」+ 失败原因）。与一次性 banner 分开 —— banner 到时会消失，用户就再也看不到"为什么少了一半数据"。

### 修复

- **复核命令超限被静默截断（卡 `-232`，`ede1d01`）** —— 真机事故：`verifyCommand` 超过 300 字符时被 `slice(0,300)` **静默切开**，
  命令变成语法错误 ⇒ 自动复核**恒 exit 2**，人只会看到「自动复核失败」。改为**抛 `USAGE_ERROR` 并带上实际长度与上限**，
  不再截断（截断比报错危险得多：它把"存不进去"伪装成"跑不过"）。全库 33 张带复核命令的卡里只有一张中招。
- **三台既有验证台 PASS 却不退出（卡 `-223`）** —— 只置 `process.exitCode` 而不 `process.exit()` 的台必须自己清句柄；
  实测漏的是 **CDP WebSocket** 与 server 的 keep-alive 连接 ⇒ 11/11 PASS 却被 `timeout` 杀成退出码 124。

### 变更

- **`CHANGELOG [0.3.1]` 段事实修正（卡 `-213`，`34db1b4`）** —— 修正对 `0.3.0` 发布事实的描述，只改文案、不改已发布内容。

### 兼容性与升级注意

- **`schemaVersion` 13 → 14**：新增 `project_settings.flow_inject_policy`。**老库打开即幂等补列**（默认 `off`），无需迁移脚本。
- **零新增运行期依赖**：`node --test` 仍是唯一门禁。`eslint` / `prettier` 是**可选**开发工具，**不随包发布**，
  未安装时 `npm run lint` 会报 command not found —— 属预期。
- **新错误码 `NO_MAIN_SESSION`**：调用方若按错误码分支，需认识这个新值（属冲突类，`EXIT.CONFLICT`）。
- **`engines.dsh` 仍为 `>=0.2.1-rc.3`**：本机已在 `0.2.1-rc.5` 上复跑宿主能力门 **9/9 PASS**；下限不动（floor 不是 pin）。
- **tarball 82 → 83 文件**：只增 `spec/norms/item-detail.md`。`tools/` 与 `.github/` 不在 `files` 白名单，开发工具不计入包内容。

## [0.3.1] - 2026-11-04

> 主题：**7 笔攒批一次发**（`v0.3.0` 后连续攒到 6 项进包变更 + 1 项打包声明），把「卡上收口了、包里还没到」这段补齐。
> 发布轨：`0.2.0` → `0.3.0` → **`0.3.1`** **连续发布**（三个版本都在 registry 上）；D7「攒批」体现在 **`0.3.0` 之后又攒了 7 笔才发 `0.3.1`** —— 攒的是**变更**，不是跳过版本。
> `npm test` **986 / 0**、`release-precheck` **EXIT=0**、tarball **75** 文件。

### 新增

- **`--read-only` 回滚开关（卡 `-208` / 需求 `R153`，`260bdf6`）** —— P3 设计稿承诺的逃生口此前从未实现：
  `--read-only` 下 MCP 工具面 **9 → 5**（只留只读工具），写入类工具不注册而非「注册后报错」——
  注册了就等于告诉调用方「有这条路」，而它注定失败。反向对照：不带开关时 9 个工具全在。
- **`engines.dsh` 打包声明（卡 `-212` / 需求 `R156`，`2385e11`）** —— `package.json` 增 `engines.dsh: ">=0.2.1-rc.3"`
  （下限＝首个实际验证过的宿主版本）。插件市场卡片的 `DSH <range>` 标签读的就是它，此前 `engines` 只有 `node`
  ⇒ 卡片只能显示「未声明宿主要求」。**生效时序**：本版发布后，还要等上游 `probe-npm` 与一轮 nightly 重建索引才会显形。

### 修复

- **「下一步」把半残回包当成「无待办动作」（卡 `-211` / 需求 `R155`，`e8c226b`）** —— 真机事故：宿主未重载时服务端仍回旧形状
  `ticketStage.next = {code,title}`，而前端兜底只判 `next` 是否为 `null` ⇒ 半残回包绕过「旧版服务端」提示，
  落到 else 分支输出**错误结论**「本卡无待办动作。」（那张卡其实只差人点「完成」，且没有「完成」按钮）。
  修：判据改为**按形状**——缺 `steps/focus/actions/hint/blocker` 任一即提示「引导不完整（旧版服务端）」；
  `actions: []` 仍是已收口卡的**合法**形态（空数组是真值，齐全必须回 `null`，首版自测即抓到）。
  **守卫**：新增第 15 台 `tools/bench-next-step-shape.mjs`（真 headless Chrome + CDP；前置代理把详情回包降级成旧形状，
  不必真退回旧进程），A/B/C/D 四组 **11/11 PASS**；反向对照（判据退回 `if (!step)`）**9/11**、A1/A2 双红。
- **任务抽屉三处判断收敛到单一口径（卡 `-199` / 需求 `R151`，`1c83059`）** —— 「下一步 / 看护 / 诊断」不再各自打
  `/next-step` 与 `/execution`（一次请求算一次、还会落库），统一消费详情里那一份 `ticketStage`；
  诊断在详情 GET 里**真实求值但零写**（`persist:false`），计数字段从已落库行补回，保住「详情 GET 无写副作用」这条不变量。

### 变更

- **契约门切 `reject`（R-A，卡 `-209`，`9bb5fcf`）** —— 调用方带 `contract` 且版本/摘要不符时，由「照常写入 + 一条 `contract-warn` 审计」
  改为**拒绝写入**；校验整体前移到事务之前（拒绝即零副作用）。不带 `contract` 仍按 `skipped` 向后兼容。
  ⚠ **这是一处行为口径变更**：靠「带错契约也能写」跑通的脚本会开始报错——请先核对调用方是否带对了 `contract`。
- **`flow_inject_policy` 明标未实现（卡 `-186` / 需求 `R141`，`ad98227`）** —— 技能文档三处（标题 / 顶部警示 / 预埋项表格）
  写明「未实现（全仓无 reader）」，并加缺口守卫 `tests/flow-inject-policy-gap.test.mjs`：扫 `src/scripts/web/cli/tools/spec`
  断言该键命中 **0**，将来接线却没更新文档即转红（反向对照：临时探针 ⇒ 2/3 转红）。

### 移出

- **`dsh --import` shim 死代码下线（卡 `-207` / 需求 `R152`，`f1e4216`）** —— **13 文件 / +13 −538**：
  三个 shim 早已被宿主能力位取代，留着只会让人以为还有那条路；残留引用一并清理。

### 兼容性与升级注意

- **npm `latest` = `0.3.1`**（`0.2.0` → `0.3.0` → `0.3.1` 连续发布，registry 三个版本都在）。若你从 `0.2.0` 直接升上来：`0.3.0` 的条目**同样适用**（`v0.3.0` tag 与源码快照仍在），`0.3.1` 是在它之上追加的 7 笔变更。
- **`engines.dsh = ">=0.2.1-rc.3"`**：宿主低于此版本不再满足声明（此前未声明，等于默认可装）。本版是本机验证过的形态。
- **契约门是行为变更**（上条 `-209`）：升级后请重新核对 CI/脚本里的 `contract` 版本与摘要。
- **`schemaVersion` 仍为 13**（本版无表结构变更，`-197` 引入的两表已在 `0.3.0` 就位）。
- 插件市场卡片出现 `DSH >=0.2.1-rc.3` 标签**不等于**发布当天可见：需上游 `probe-npm` + 一轮 nightly 重建索引。

## [0.3.0] - 2026-11-03

> 主题：让「待验收 → 确认」这段**先变得可信** —— 有度量、有事件、有单一口径、有结构化证据。
> 本版六张卡全部严格走看板全环（`-193` … `-198`，各带证据四节）；`npm test` **974 / 0**、`release-precheck` **EXIT=0**。
> **未做**：npm publish / GitHub Release（另批）；生产重载后的快照复评见 `docs/进度/`。

### 新增

- **基线度量脚本 `tools/baseline-metrics.mjs`（卡 `-193` / 需求 `R146`）** —— 把「改善了多少」变成可复跑读数：
  快照 `.data/backup-20261103.sqlite`（sha256 `21182435…`）、**M1 拆两层**（当前在途滞留中位 **148.4h** vs 已完成周期中位 **19.1h**——
  只报一个会得出「改善 87%」的假结论）、`done` 事件覆盖 **74.2%**（漏 25.8%）、M2 **3.2**；M3/M4 **明标不可测、不写 0**。
- **阶段推导单一口径 `ticketStage()`（卡 `-196` / `-198` / 需求 `R149`）** —— 新模块 `src/core/ticket-stage.mjs`：
  **不写第五套判断**，直接复用 `deriveNextStep` / `assessTask` / `latestAutoReview` / `evidenceFormatOk` 只做归一；
  显式区分 `format_ok`（四字段齐、无内容判定）与 `ready`（判定与证据/版本一致），判过又变 ⇒ `stale`。
  `GET /api/tasks/:ref` 新增只读字段 `ticketStage`；任务抽屉显示交付阶段徽标，**`stale` 用警示色**。
  **安全优先级**：`stale` 先于「只差你点完成」——判定过期时不许邀请人确认他没看过的那一版。
- **交付物证据结构化 + 授权快照（卡 `-197` / 需求 `R150`）** —— `task_evidence`（四字段：判定 / 偏离 / 边界 / 产物 + `artifact_refs` + actor + task_version）
  与 `task_mandates`（**append-only**：只有 insert，范围变大 = 新行）。**门在事务前**：四字段缺一即 `EVIDENCE_INCOMPLETE` 且零落库；
  `artifact_refs` 一条解不开即整体 `unresolved`，不进 `format_ok`。授权快照覆盖**三条认领入口**
  （`claimTask` / 看板 `PATCH→in_progress` / 团队通道 `teamSetTaskStatus→in_progress`）。

### 修复

- **状态事件漏记（卡 `-194` / 需求 `R147`）** —— `teamSetTaskStatus` 与 `applyTeamTaskOutcome`（completed / failed）此前**直接写列不发事件**，
  实测 175 次完成类变更中 **46 次（26%）无 `status_changed`**；而诊断 / 看护 / 通知 / M1 度量**全部**建在事件流上。
  现两处落点补齐（同一状态重复写不产生假事件）。
- **待验收「发起评审」时间缺失（卡 `-195` / 需求 `R148`）** —— 实测 16 张 `in_review` 中 **10 张 `review_requested_at` 为空**，
  M1 因此无从计算。现三条进 `in_review` 的路径（看板 PATCH / 执行侧与团队通道 / 团队回流）都补记，**幂等**（不覆盖首值）、
  **不涨 version**（记账字段不污染乐观锁）。

### 兼容性与升级注意

- **`schemaVersion` 12 → 13**：新增 `task_evidence` / `task_mandates` 两表，`create table if not exists` **可重入**；
  已在真实库副本上验证（连开两次 `schema=13`、217 条任务不变、无报错）。重启宿主即自动迁移。
- **`review_requested_at` 只对新增生效**：存量 10 张 `in_review` 空值**不自动回填**（属 P0①-b，需人工执行补发）。
- **`ticketStage` 是新增只读字段**：既有 `task` / `comments` / `reviewEvidence` 语义未变；详情 GET **零写副作用**（新增测试断言）。
- **`ready` / `stale` 两态暂不可达**：判定层（`decision_log`）属 0-C，未建表前 `decision` 显式 `null`，不伪造判定。
- 任务抽屉的「下一步 / 看护 / 诊断」三处旧判断**本版未合并**（沙箱内无浏览器验证台，盲删即静默删功能）⇒ 见 `R151`。

## [0.2.3] - 2026-10-30

> 本版只有一条修复：**把「只影响人读」的错标改对**（数据一直是对的）。
> 触发：`-176` 证据评论登记的已知限制 —— `REQUIREMENT_SOURCES` 已含 `mcp`，但前端来源文案只认
> `intake / elaborated-ai / elaborated-rule`，其余一律回落「手工」。

### 修复

- **需求条目来源标签：`mcp` 被错标为「手工」（卡 `-179` / 需求 `R134`）** ——
  MCP 建的条目在**列表胶囊**与**详情「来源」字段**都显示成「手工」，人会以为是自己手工建的，
  进而误判「谁该补验收」。数据侧（`source="mcp"`）自 0.2.2 起就是对的，**只有人读的那一层在撒谎**。
  修：`web/app.js` 两处来源文案三元各补 `mcp → "MCP"` 分支（列表 `srcLabel` / 详情 `srcLabel`），
  其余四档文案（资料索引 / AI / 规则 / 兜底手工）**零改动**。
  **守卫**：新增真渲染验证台 `tools/bench-req-source-label.mjs`（临时 `dataDir` + 随机端口 + 真 headless Chrome + CDP，
  读渲染后 DOM 的**列表胶囊**与**详情字段**实际文本，A/B/C/D 四条 + `TB_BENCH_WEB_DIR` 反向对照）；
  配套 `tests/bench-req-source-label-coverage.test.mjs`（5 条）进 `npm test`：含**源码守卫**（两处三元都必须有 `mcp` 分支、
  兜底档必须仍是「手工」）+ 台子不被削薄（隔离形态 / 沙箱自检 / 五档种子 / 反向对照入口 / 退出码契约）。
  **读数**：修复前 A/B 双红（`mcp=手工`、详情`手工`）→ 修复后 **4/4 PASS**（`mcp=MCP`，intake 详情仍「资料索引(引入)」）；
  反向对照（注入旧口径）**2/4**（A/B 转红）；源码守卫同样反向验证（删掉 `mcp` 分支 ⇒ 断言失败）。

## [0.2.2] - 2026-10-29

> 本版是 **0.2.1 之后的第一个小版本**（未发布 npm / 未出 Release 时为「就绪」状态）。
> 主题：**把 0.2.1 收口时登记的四张隔离卡清掉**（软链漏扫 / 去重键陈旧 / 两条无约束写入口）。

### 修复

- **intake 扫描器的符号链接静默漏扫（卡 `-175`）** —— `Dirent.isFile()` 对符号链接**恒为 false**，
  故 `walk()` 的 `isFile()/isDirectory()` 双分支把软链文档静默漏掉（本仓 `docs/团队agent.md → ../spec/团队agent.md`
  从未进索引，`docsTotal` 少 1 且无任何读数提示）。
  修：软链走 `stat` 跟随判类型 → `realpath` **越界判定**（必须仍在 root 内）→ **祖先链**环路保护；
  跳过的每一条进 `symlinks.skipped[{relPath,target,reason}]`（九种 reason），跟随的计入 `followed`，`files[]` 带 `symlink:true`。
  顺带删掉 `tools/audit-intake.mjs` 自带的 `findSymlinks()`（两份实现必然漂移，改读模块记账）。
  **读数更正**：软链修完后 `docsTotal` 是 **391**（不是先前预估的 390）—— 用同版本差集实测钉住：
  HEAD `390` ↔ 新版 `391`、`added=[docs/团队agent.md]`、`removed=[]`；口径漂移的原因是「390」按当时 2 份新文档算的，
  此后又落了 1 份进度文档。**登记到 0.2.2 发布时，基线应再按当次 docs 数量复算**（本轮收尾时为 392，因又新增 1 份轮次文档）。
- **改条目标题时 `norm_title` 不同步（卡 `-178`）** —— 标题去重键停在旧值 ⇒ 改名后
  `confirmRequirementCandidates` 把同一条目当「新条目」再插一次。存量 `normTitleMismatch = 0`，属**防新增**。

### 新增

- **acceptance 显式缺口标记（卡 `-176` / `-177` · 口径 X）** —— 两条无约束写入口（MCP `requirement_upsert` 与
  HTTP `POST/PATCH /api/requirements/items`）此前「没给验收」与「给了空串」在调用方眼里都是成功。
  现：`acceptanceSet` 回包字段 **永远**反映写入后状态；缺省时落 `governance_audit`
  （`action = requirement-acceptance-missing`，`reason` 记入口名）⇒「当初给没给验收」可事后 join 审计查出来。
  **刻意不做**：不设必填、不改 schema（129 条里 99 条 `acceptance` 为空，必填会一刀切破「改标题」这类无关操作；
  审计 join 可查，schema 迁移不可逆）。审计只在**本次写入真碰 `acceptance`** 时落，避免每次改标题都添一行。
- **`REQUIREMENT_SOURCES` 补 `mcp`** —— MCP 建的条目不再落默认 `manual`，「人手建 / MCP 建」在库里可辨。

### 已知限制（本版未做）

- 前端来源标签仍无 `mcp` 分支 ⇒ 列表里 MCP 建的条目会显示成「手工」（**数据正确、标签错标**，2 行改动，待 UI 卡）。
- MCP 回包不暴露 `source`（`requirementSnapshot` 只回内容字段）。

## [0.2.1] - 2026-10-29

> 发版纪律（2026-10-29 起）：`0.2.0` 已对外冻结，**此后任何产品代码改动都要走新版本号 + 本文件**，
> 不得静默混进工作区（否则「registry 上的 0.2.0」与工作区语义漂移）。
> 发布时把本节改成 `## [0.2.1] - <日期>` 并复查 `docs/发布与收录/02` §5.0 的顺序铁律。

### 变更（口径）

- **条目化的失败语义与数量口径（卡 `-169` P4②）** —— 真机上一份「资料索引」类文档走规则拆解，
  产出 **4213 条**、落库 **100 条** `pending` 候选，其中 **0 条**是真需求（全是文件清单行）。
  两条根因一起改掉：

  | 项 | 旧 | 新 |
  | --- | --- | --- |
  | `mode:"auto"` 在 AI 不可用时 | **静默跑规则并落库**，只加 `degraded:true` 标注 | **拒绝 `AI_UNAVAILABLE`、零落库**；要降级必须**显式** `{"mode":"auto","fallback":"rule"}` |
  | `limit` | 默认 **100**，且 **body 传了也不生效** | **从 body 透传**，默认 **20**、硬顶 **200** |
  | `mode:"rule"` | 一点就写，无预览 | 支持 `{"mode":"rule","dryRun":true}` ⇒ **只回预览、零落库**（HTTP 200） |

  ⚠️ **这是有意的收紧**：宿主没配 LLM 之前，看板的「AI 拆解」会**明确报错**而不是"假装成功"。
  这正是要的 —— 把「其实没 AI」从「看起来成功」改成「明确失败」。

### 新增

- **验证台 `tools/bench-market-install.mjs`（第 14 台，11 项）—— 市场安装形态验收**：
  `npm pack` → 解包 → 装进**隔离 profile**（临时 `DSH_HOME`）→ 真 `dsh` 起宿主 → 真 HTTP。
  判据是「**插件化 = 拿到宿主会话通道**」：`host.capabilities` 非空 + `create/sessions` 在 +
  **真建出项目主会话** + `scopeFactory=ready`；**反向对照**＝同一份打包代码 `node src/server/server.mjs`
  独立起 ⇒ `capabilities === null`。它补的盲区：以往「插件能用」的证据全来自**仓库软链**，
  `package.json#files[]` 少写一项也照样绿，而市场安装拿的是打包产物。
- **独立进程启动即声明形态**：`src/server/server.mjs` 多打一行
  `[tb] mode=standalone · 无 DSH 宿主会话通道（投递/建会话/派发团队不可用；需要这些能力请用 DSH 内的 /integrations/taskboard-workbench）`，
  把「为什么按钮是灰的」提前到启动那一刻。

- **规则拆解「先预览再确认」**（前端）：「规则拆解（先预览）」→ 页面内预览块（写多少条 / 前 10 条标题 /
  「规则拆解会把文件清单行也当需求」警示）→「确认写入 / 取消」。
  **不用 `window.confirm`**：IAB 里原生弹窗会被自动拒绝 ⇒ 变成「点了没反应」（见 `docs/发布与收录/06` §E3）。
- **验证台 `tools/bench-elaborate-guard.mjs`**（第 13 台）—— 真 headless Chrome 读渲染后 DOM，**10 项**：
  两个按钮在 / 无 AI 点 AI 拆解⇒明确报错且零落库 / 点预览⇒预览块出现且零落库 / 真列 10 条 /
  「确认写入 20 条」/ 确认后落库 **20** 条 / 页面回报 `候选=20` / 预览块消失。
  含 `TB_BENCH_WEB_DIR` 反证入口（旧 web ⇒ **7/10 转红**）。
- **守卫测试 `tests/elaborate-guard.test.mjs`**（11 条）：① 零落库 ② 显式 `fallback:"rule"` 才降级
  ③ `dryRun` 零落库且 `preview` 非空 ④ `limit:5` 恰好 5 条 · 默认 20 · 硬顶 200 · 非法值报错
  ⑤ `dryRun` 只对 `rule`、`fallback` 只接受 `rule`、`mode` 只接受三值 ⑥ 反向对照。

### 变更（实现细节）

- AI 抛出的错误**保留上游 `code`**（如 `AI_OUTPUT_INVALID`）而不是一律压成 `AI_UNAVAILABLE` ——
  排障要能区分「没有 AI」和「AI 回了没法解析的东西」。
- `clampElaborateLimit` 放在 `src/core/requirements.mjs`（纯模块），`store.mjs` 转发 ——
  这样 `src/server/api.mjs` 取口径时不会把 `node:sqlite` 拽进纯路由层。

### 新增（P1 · 契约快照与机器规范 · 卡 `-170`）

- **机器执行规范 `spec/norms/`（运行时唯一真源，随包分发）** —— 五份：
  `flow`（八步 S0–S7 + 四道门 + 错误码处置）/ `card-update`（状态流转 + 回填证据 + 禁止项）/
  `doc-editing`（每轮收尾 + 写入纪律 + 命名）/ `acceptance`（三层判据 + 反向对照 + 合格证据）/
  `project-defaults`（只允许 3 类覆盖：`verifyCommand` / `workspacePath` / `notApplicable`）。
  每份带 `norm_id / version / updated / applies_to` frontmatter，`manifest.json` 记 `digest = sha256(正文)`。
  `docs/规范/*.md` 仍是**给人读的开发文档**、永不入 git、**不作运行时真源**。
- **契约快照 `src/core/contract.mjs`（纯计算 + 纯读文件，不写库）** ——
  `contract_version = f(需求文档 digest, 规范 digest×版本, 门配置)`；`diffContract` 能回答「**哪份文件变了**」
  （`changed[]` 指到 `spec/norms/card-update.md` 这一级）；`staleError` 固定 `409 CONTRACT_STALE` 形状：
  `your_version` / `current_version` / `changed` / `snapshot` / `remedy`。
- **两个端点** —— `GET /api/projects/:id/contract`（**零副作用**：现算 + 与基线比对，不落库）·
  `POST /api/projects/:id/contract/recheck`（重算并落基线，`project_contract` 的唯一写入点）。
- **构建工具 `tools/build-norms.mjs`** —— 生成 manifest；`--check` 供 CI / 守卫。**正文变了但 `version`
  没 bump ⇒ 硬拒写入（退出码 1，不覆盖 manifest）** —— 否则等于用 manifest 把守卫抹平。
- **两张表（schema `11 → 12`）** —— `project_contract`（每项目一行契约基线，**只是缓存不是真源**）·
  `flow_injections`（装载块注入审计位；D3 档 C 推迟，默认 `off` 不写）。

### 新增（P1.5 · D2 `warn` 档 · 2026-10-29）

- **写路径上的契约校验（内核层，不阻断）** —— `evaluateSubmittedContract()` 纯判据 +
  `store` 在 `createTask` / `updateTask` / `addComment` / `createRequirementItem` / `updateRequirementItem`
  五条写路径上校验调用方带的 `contract`：
  - **不带** `contract` ⇒ `skipped`（老客户端 / Web 零打扰，向后兼容）；
  - 版本或规范摘要不符 ⇒ **照常写入**，另落一条 `contract-warn` 审计
    （`GET /api/governance/audit?action=contract-warn` 可查「谁在用旧规范干活」）；
  - 全符 ⇒ `ok`，**不制造审计噪声**。
- 为什么放内核：MCP / HTTP / CLI / Web / dsh-tool 五个入口都落到 `store`；放门面层就会
  「六个入口两种语义」（D2 拍板 B）。门面只做一件事：把 `body.contract` 原样透传。
- 测试 `tests/contract-warn.test.mjs` **4 条**：纯判据 / warn 不阻断且真落库 / 更新+评论两条路径同样受检 /
  HTTP 透传 + 审计可查。

> **已知限制（P1.5 边界）**：目前是 **`warn` 档**（D2 拍板：先观测一周再切 `reject`）。
> 也就是说「用旧规范干活」现在**只留痕、不失败**；`409 CONTRACT_STALE` 的阻断要等切档时才生效。
> 另外 `project_contract` 目前只在手动 `recheck` 时落基线，需求文档变更时**不会自动 refresh**（随切档一起定）。

### 新增（P2 · MCP 只读四工具 · 卡 `-170` · 2026-10-29）

- **MCP 契约层 `src/mcp/`（stdio，零依赖，零宿主改动）** —— `server.mjs` 是 newline-delimited
  JSON-RPC 2.0 的 MCP server（`initialize` / `notifications/*` / `ping` / `tools/list` / `tools/call`），
  `tools.mjs` 注册四个**只读**工具：
  `flow_start`（开局 S0：项目 + `contract_version` + 三类缺口 + 下一步建议）·
  `project_info`（按状态计数 + 契约是否漂移）·
  `norm_get`（`spec/norms/*` 正文 + `sha256` digest；`norm="project"` 读 `<workspace>/AGENTS.md`）·
  `workbench_audit`（`contract-stale` / `unattributed` / `unbound-session` / `candidate-flood` 四类漂移）。
- **三条实现口径**：① **stdio 而不是 HTTP** —— 不占端口、不碰 `:3080`、不写 `~/.dsh/**`、不需要重载宿主，
  每个 agent 会话一个进程；② **同一份 `taskboard.sqlite`**（`--data-dir` > `$TB_DATA_DIR` > 默认），
  MCP 不是第二份数据；③ **只读到「连计数都不变」** —— 不调任何 `create/update/record*`，
  也不走 `resolveContext()`（它会 `ensureRequirementDoc`，属写操作）。
- **错误分层**：**协议层**用 JSON-RPC error（未知工具 ⇒ `-32602`），**工具层**用 `result.isError` +
  `{code,message}`（如 `NORM_NOT_FOUND`）—— 混用的后果是客户端把「参数写错」当成「服务挂了」。
- **入口**：`node src/mcp/server.mjs --data-dir <dir>` · `npm run mcp` · `bin: tb-mcp` · `--print-tools`（清单自检）。
- 守卫测试 `tests/mcp-readonly.test.mjs` **A–H 八组**：握手 / 四工具且全 `readOnlyHint` / `flow_start` 缺口与
  `nextStep` / `project_info` 计数 / `norm_get` 正文+digest+项目档+未知码 / `workbench_audit` 四类齐 /
  **只读**（跑完一轮后 `projects/tasks/comments/ownedTasks/audit` 逐项不变）/ 协议层 `-32602`。

> **边界**：写工具（`card_create` / `card_progress` / `requirement_upsert` / `requirement_change`）属 **P3**，
> 本轮**不含**。也就是说 MCP 现在只能「读事实、报漂移」，**不能替人建卡或改状态**。

### 新增（P3 · MCP 写四工具 + 条目列表 + `mcp-parity` · 卡 `-170` · 2026-10-29）

- **五个新工具（MCP 共 9 个）**：
  `requirement_list`（只读：条目 + 内容版本 + 每条卡数）·
  `requirement_upsert`（新建 / 改条目，改必带 `expected_version`）·
  `requirement_change`（**先预览拿 `change_id` + 影响面**，带 `change_id` + `apply:true` 才落地）·
  `card_create`（**归因硬门** + `unattributed_reason` 逃生口）·
  `card_progress`（**`evidence[]` 非空** + **`norm_digest` 必填**）。
- **形状即约束（这次的四个「不可能」）**：
  | 老毛病 | 现在怎么被挡住 |
  | --- | --- |
  | 建卡忘了归因 | `card_create` 无 `requirement` 且无 `unattributed_reason` ⇒ `REQUIREMENT_REQUIRED`（逃生口落 `attribution_skipped` 事件，可盘点） |
  | 回填写「已完成」三个字 | `evidence[]` 非空且每项 `{kind∈file\|command\|url\|reading, ref}`；空 / 形状错 ⇒ `EVIDENCE_REQUIRED` / `EVIDENCE_INVALID` |
  | 拿旧规范回填 | `norm_digest` 必填，与当前 `card-update` 不符 ⇒ `NORM_STALE`（**回带最新正文**，agent 自纠偏） |
  | 改了需求忘了下游 | `requirement_change` 先回 `affected_cards` + `change_id`；条目预览后被改过 ⇒ `CHANGE_ID_MISMATCH` |
- **四条红线由门守，不由纪律守**：`done` 走执行侧状态门 ⇒ `GOVERNANCE_AGENT_DONE`；`card_create` 只接受
  `backlog`（`backlog → todo` 是人工授权）⇒ `AUTHORIZATION_REQUIRED`；人工校验任务不得被执行侧改状态；
  同批证据按 `hash` 去重（重复回填不产生第二条评论）。
- **无状态 `change_id`**：`sha256(条目 + 改前内容版本 + 排序后的补丁)` —— 不建表、不存会话，
  条目一变 id 自动失效（比「存一张审批表」更难被绕过）。
- **`mcp-parity` 守卫 `tests/mcp-parity.test.mjs`（4 条）**：同一操作在 **HTTP 与 MCP** 上
  错误码必须相同（`REQUIREMENT_REQUIRED` / `DEPENDENCY_CROSS_PROJECT` / `GOVERNANCE_AGENT_DONE`），
  且**副作用同形**（状态 / 优先级 / 验收 / 复核动作 / 归属条目 / 事件序列 `created + attributed` 逐项相等）。
- 守卫 `tests/mcp-write.test.mjs`（**6 条** A–F）：条目版本乐观锁 · 变更影响面门 · 归因/授权门 ·
  证据与 `norm_digest` 门 · `done` 红线 · **契约仍 `warn` 档**（带旧契约写入成功 + 只留 `contract-warn`）。

> **口径边界（有意为之）**：① `card_create` 的归因硬门只收紧 **MCP 这一个新入口**；内核全局档
> `TB_STRICT_ATTRIBUTION` 仍是默认 `warn`（翻默认会影响 Web / CLI / seed 全部存量调用方，属另一件事，须单独拍板）。
> ② `contract_version` 仍是 **`warn`** 档（D2 观察期内）；写工具返回体带 `contract.verdict`，让 agent 自己知道用了旧规范。
> ③ `requirement_upsert` 的 `expected_version` 是**内容摘要**（`requirement_items` 没有 version 列），纯读、可重算。

### 新增（P4 · `taskboard-flow` 技能包 + 开局档 A/B · 卡 `-170` · 2026-10-29）

- **技能包 `skills/taskboard-flow/`（随包分发，`npm run flow` 即用）** —— `SKILL.md` 是
  **八步 × 六栏**的主流程表（入口 / 前置门 / 判据 / 证据落点 / 失败处置 / 对应 FR），
  外加「随时可用的两个只读入口」与**五条硬规则**；`references/steps/S0.md … S7.md` 给每步的命令与判据读数，
  `references/errors.md` 是错误码 → 该做什么，`references/injection.md` 是装载细节与档 C 的接口形状。
  **这一层只教顺序、判据与失败处置，不持有任何业务规则副本** —— 数据在 `taskboard.sqlite`，
  门在 `src/mcp/` 与 `src/core/`，规范在 `spec/norms/`。
- **装载块唯一生成器 `src/mcp/flow-block.mjs`** —— `readSkill()` / `buildFlowBlock()` / `buildAgentsSnippet()`。
  八步与硬规则**从 `SKILL.md` 的两个标记区间原样抽取**（`<!-- flow-block:steps -->` / `<!-- flow-block:rules -->`），
  不复制正文 ⇒ 「技能改了、装载块没跟上」这一类漂移在结构上不存在。
- **开局档 A（人贴）/ 档 B（外部 agent 约定）**：
  - 档 A：`node scripts/tb-flow.mjs start` 的输出整块贴进 dsh 主会话；或让 MCP 客户端取 prompt **`taskboard.flow`**
    —— **同一生成器、输出逐字节相同**；
  - 档 B：项目根 `AGENTS.md` 写一段「开工先跑 `<taskboard>/scripts/tb-flow.mjs start`」，片段由
    `tb-flow snippet` 打印（`--write` 只打印待粘贴内容，**不替人改文件**）。
- **MCP `prompts` 能力** —— `initialize` 声明 `prompts:{listChanged:false}`，新增 `prompts/list` 与
  `prompts/get`（只认 `taskboard.flow`，未知名字 ⇒ **协议层 `-32602`**）；启动日志带 `prompt=taskboard.flow skill=v1`。
- **CLI `scripts/tb-flow.mjs`（`bin: tb-flow` · `npm run flow`）** ——
  `start [--project --cwd --json --data-dir]`（缺项目时按 `--cwd` / `basename` 猜，猜不到给 `PROJECT_NOT_FOUND` 并
  打印「怎么指定 `--data-dir`」）· `snippet`（打印档 B 的 `AGENTS.md` 片段）· `check`（自检 frontmatter 与八步完整性）。
  `package.json#files[]` 增加 `skills/` 与 `scripts/tb-flow.mjs` —— 市场安装拿的是打包产物，少写一项就静默缺件。
- **`deriveFlowNext` / `projectGaps` / `resolveProject` 从 `tools.mjs` 导出**（`export`）—— 让 `flow-block.mjs`
  复用同一份「下一步」判据，而不是第二份实现。
- 守卫 `tests/skill-flow.test.mjs`（**6 条** A–F）：frontmatter 五项齐全 · 八步连续且每格非空（六栏表头）·
  **双向工具覆盖**（表里提到的工具都在注册表里，注册表里 9 个工具都必须在技能目录被提到）·
  `requires_contract` 与 `CONTRACT_VERSION_PREFIX` 同源 · **档 A/B 同源**（进程内生成 ≡ MCP `prompts/get` ≡ CLI `start`，
  逐字节）· 真跑 S0→S2（无条目 ⇒ S1；建条目 ⇒ 建卡 ⇒ `nextStep.step === "S3"` 且 `humanAction === "authorize"`）。

> **口径边界（有意为之）**：① **档 C（宿主会话创建自动注入）未启用** —— D3 已拍板推迟到「工作台整体封装为插件包」
> 阶段，本轮只预埋接口（`flow_inject_policy` 配置位默认 `off`、`flow_injections` 审计表、`references/injection.md`），
> **没有任何代码读这个配置位去注入**；真要接必须先报批改 `~/.dsh/**` 并重载宿主。
> ② 技能**不进 `docs/规范/`**：后者是本仓库的开发文档、永不入 git，不是运行时真源。
> ③ 卡 `-170` 仍停在 `in_progress` —— P5 未定，不推 `in_review`。


## [0.2.0] - 2026-10-29

> **本版是首个发布到 npm 的版本** —— `0.1.0` 只出过 GitHub Release 源码快照，未进 registry。
> 覆盖 2026-10-23 → 2026-10-29 的全部工作（需求正本 `FR-01…FR-100`，实现缺口 0）。

### 新增

- **项目推进清单与决策回写（`FR-99`）** —— `GET /api/projects/:id/advance` 把五类待办
  （`decide` / `blocked` / `review` / `accept` / `dispatch`）按「先解锁再推进」合一排序，每条带一句 `why` 与稳定
  `decision_id`；清单是**纯投影**（同状态重复请求字节级一致，`done`/`canceled` 不出现）；`?format=block` 产出
  可直接投给项目主会话的指令装载块，`POST …/advance/announce` 投放，`POST …/advance/:decisionId/decide` **幂等**回写。
- **项目记忆与多 agent 执行记忆归档（`FR-100`）** —— 三张记忆表 + 五个端点：按项目 / 会话 / agent 归档执行记忆，
  支持检索、合成装载与清理。
- **需求分拆「自动生成 + 按意见重生成」** —— `POST /api/requirements/items/:ref/split-ask` 走项目主会话，
  **只投一条指令、零建卡零改状态**（因此可安全反复点）；带修改意见时自动回带上一次草稿。
  生成的卡支持 `kind`（`work` / `review`，未知值报错而非静默丢弃）与**依赖边**（`序号｜标题｜owner｜kind｜依赖`）。
- **评审门** —— `in_review → done` 必须 `review_state === 'approved'`，否则 `REVIEW_NOT_APPROVED`（退出码 5；
  门在写之前 ⇒ 零副作用）。人仍可跳过评审，但须显式 `skipReview === true`（严格布尔），服务端落
  `review_skipped` 事件与审计。
- **宿主能力位与能力门** —— `GET /api/health` 的 `host` 块补齐 8 个能力位（`createSession` / `sendPrompt` /
  `openSession` / `listSessions` / `sessionExists` / `sessionOrigin` / `renameSession` / `sessionState`）；
  前端按能力位置灰宿主依赖按钮并给常驻说明，**能力未知时不擅自禁用**；`host-unavailable` 的错误**同时回带
  `prompt`**，可手工投递。
- **需求条目「任务 DAG」** —— 稳定拓扑序（Kahn，同层按创建序）+ 每节点 `blockedBy[]` + 依赖边 `reason`
  （为什么卡）+ 节点可点直达该卡（按编号回源 `GET /api/tasks/:ref`，不再"列表里没有就归档了"）。
- **需求条目详情抽屉** —— 按视口分级宽度 + 左缘拖拽 + 一键全屏，独立记忆键 `tb.reqDrawer.width`
  （不与被任务侧共用的 `tb.drawer.width` 串扰），拖动中不落盘、松手才写。
- **需求条目列表** —— 完成度结论列（`无任务` / `可收口` / `待验收 N` / `受阻 N` / `N/M 收口` 五档，定宽对齐）+
  面板头「可收口 N」+ 点胶囊真滚到详情「关联任务完成情况」段 + 终态显式化（划掉 + 色条 + 降透明）。
- **自动复核第三态「不适用」** —— 非 Node 工作区不再把「命令不适用」谎报成「失败」（`applicable:false`，
  不跑命令、不改状态）。
- **发布门禁** —— `node tools/release-precheck.mjs`：tracked tree + `HEAD` 全历史的 L1/L2 敏感信息扫描、
  `npm pack` 内容边界、`docs/`/`.archify/`/`.data/`/`AGENTS.md` 的 ignore 覆盖；配套 `SECURITY.md` 分级口径。
- **13 个隔离验证台**（`tools/bench-*.mjs`）—— 临时 `dataDir` + 随机端口 + 独立进程，跑真 headless Chrome /
  真 `dsh` / 真 `claude` 取证，**每个都带反向对照**（注入旧口径必须转红）。

### 变更

- **建卡归因并入建卡事务** —— `createTask` 在同一事务内校验 `requirementId`，跨项目/条目不存在 ⇒ **整笔回滚、
  不占编号**；`POST /api/tasks` 读 `requirementId`；CLI 增 `task create --requirement` 与 `task attribution`。
  默认**软提醒**，`TB_STRICT_ATTRIBUTION=1` 才升级为硬门。归因门（`EXECUTION_NOT_ATTRIBUTED`）保持不变。
- **需求视图「引入的文件」按文件夹呈现**（`FR-96`）—— 单链合并、目录排在根级文件之前、叶子 `title` 不丢、
  默认折叠。
- **待验收卡处置入口收敛**（`FR-89`）—— 已通过卡只保留「完成」一处，操作区不再出现裸「下一列」，
  改为「指回下一步」；进行中卡仍保留普通「下一列」（反向对照守住）。
- **`web/app.js` 支持两种宿主形态** —— 宿主能力未知 / 宿主不可用都按「能力位 + 常驻提示」呈现，
  不再把**能力缺失**呈现为**临时故障**（旧文案「检查宿主会话通道后重试」会让人无限重试一个永不成立的条件）。

### 修复

- **断线无提示、重连后不重取**（`FR-20`）—— WebSocket 断开给常驻提示并按 `readyState` 分流，
  重连成功后复用 `reload()` 重新取数（验证台 11/11，含反向对照）。
- **「申报人工校验」点了没反应** —— 抽屉内提示被 `.banner` 遮挡（z-index 40 → 60）。
- **需求条目详情「太过靠右」** —— `.tb-req-drawer` 死钉 `min(560px, …)`，与 `.tb-drawer` **特异性相同又排在
  后面** ⇒ 盖掉按视口分级与拖拽/全屏（同一个抽屉壳：任务侧有能力、需求侧被一行旧 CSS 钉死）。
- **建卡可绕过归因** —— Web / CLI / 工具面三个入口原先都拿不到 `requirementId` ⇒ 派生出无归因卡，
  启动执行与派发团队时被 `EXECUTION_NOT_ATTRIBUTED` 拒。
- **CLI 失败被记成「成功」的相邻问题** —— 失败记账与分类重做：配额/鉴权类（不重试，置受阻 + 审计）与
  瞬时故障（按阈值重试）分流。
- **需求分拆的两处「界面承诺 ≠ 实现」** —— `kind` 被 `assertSplitTasks` 静默丢弃；按钮写「+ 依赖」而 UI
  根本没有依赖输入（一条边都建不出来）。
- **DAG 节点点不开** —— 纯展示 `div` 改可点 `button`，并修掉「列表里查不到就提示可能已归档」的死路。
- **`node --test` 临时目录泄漏** —— 跑完残留临时目录。
- **优雅重启永远不退出（留孤儿）** —— `server.close(cb)` 只停止接受新连接、要等既有连接全部结束才回调；
  而前端常开 `new EventSource('/api/events')`（SSE 长连接），**回调永不触发** ⇒ SIGTERM 之后进程挂着不退、
  继续持有 `.data/taskboard.sqlite`，下一个实例起来就形成**同库双写者**，再下次重启还要撞 `EADDRINUSE`。
  修：`server.closeAllConnections?.()` 强制断开 SSE / keep-alive + **3 s 兜底 `process.exit(0)`**；
  守卫 `tests/server-graceful-shutdown.test.mjs`（3 条：挂 SSE 必须秒退 / 无连接也要退 / 源码双要素）。

### 测试

- `npm test`（`node --test`）**853 / 853 · 0 fail · 0 skipped**（`0.1.0` 时为 678）。
- 13 个浏览器 / 真进程验证台全部带**反向对照**，且全部在 `npm test` 内（不是游离脚本）。

### 已知限制

- 执行侧外部 CLI（如 `claude`）**没有强制的文件写入边界**：`--add-dir` 只表达授权目录，**不阻止越界写**，
  且 `--allowedTools` 含 `Bash` ⇒ shell 重定向不受目录模型约束。该约束是**指令级**的
  （实证：`tools/bench-cli-write-boundary.mjs`）。
- **独立进程形态**（`node src/server/server.mjs` 直起、非 DSH 插件）**天生没有宿主会话通道**，
  `/api/health` 的 `host.capabilities` 为 `null`。此时宿主依赖动作按能力位置灰并给出说明，
  `host-unavailable` 会回带 `prompt` 供手工投递。这属**形态差异**，不是缺陷。
- `docs/` 过程文档不随仓库与包发布，只在本地维护。

### 口径裁定

- **`FR-52` 验收②** 的「外部 CLI 配额不足 ⇒ 回退为成员自行执行并注明原因」**裁定为以实装为准**
  （命中配额/鉴权类错误 ⇒ 熔断置「受阻」+ 停止自动重试 + 审计 + 明确原因）。理由：key 失效时让每个成员
  各回退一次只会把一次明确故障放大成 N 次，且会掩盖真实故障。条款原文保留，裁决记录见
  `docs/需求文档.md` 文末变更记录 2026-10-29 条。

[0.2.0]: https://github.com/SilenZerOrz/taskboard-workbench/releases/tag/v0.2.0

## [0.1.0] - 2026-10-23

> ⚠️ **本版未发布到 npm。** 它只对应一次 **GitHub Release** 的源码快照（tag 指向初始化提交），
> registry 上从未出现过 `taskboard-workbench@0.1.0`。**首个 npm 版本是 `0.2.0`。**

**对外首个版本（初始版本）**。此前仓库仅内部私有演进（`private: true`），
所有历史修改不构成对外语义，故对外发布自 `0.1.0` 起算。

### 新增

- **本地任务工作台核心**：零运行时依赖（`node:sqlite`）的多项目 / 任务 / 需求条目存储，含状态机、
  认领锁与心跳、失败会计与熔断、诊断与尝试记录 / 事件流。
- **看板与呈现**：列看板（含列内拖拽排序）、关键词搜索、Markdown 呈现与内容安全、
  需求视图「引入的文件」按文件夹树呈现。
- **执行与编排**：看板侧 CLI 执行器（`cli:claude`）、派发引擎选择（活跃执行者 / 团队模板回落）、
  执行看护与通知订阅 / 唤醒。
- **DSH 内嵌插件**：`dsh.bundle.patch` + `dsh.client`（web 平台侧栏 / 布局 / 槽位注入），
  会话内「任务工作台」中心标签页。
- **CLI**：`tb` 命令（`bin` 暴露）与本地 Web 服务（`npm start`）。

### 测试

- `npm test`（`node --test`）全量单测全绿。

### 已知限制

- `docs/` 过程文档不随仓库与包发布，只在本地维护。
- 执行侧外部 CLI（如 `claude`）**没有强制的文件写入边界**：`--add-dir` 只表达授权目录，
  不阻止越界写；该约束是指令级的。

[0.1.0]: https://github.com/SilenZerOrz/taskboard-workbench/releases/tag/v0.1.0
