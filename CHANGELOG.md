# Changelog

`taskboard-workbench` 的全部对外版本变更记录。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本对应一个 annotated tag（`vX.Y.Z`）与一条 GitHub Release；npm dist-tag 与 dsh 兼容区间随版本记录。

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
