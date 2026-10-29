# Changelog

`taskboard-workbench` 的全部对外版本变更记录。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本对应一个 annotated tag（`vX.Y.Z`）与一条 GitHub Release；npm dist-tag 与 dsh 兼容区间随版本记录。

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
