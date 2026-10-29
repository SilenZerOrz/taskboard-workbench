---
name: taskboard-flow
version: 1
updated: 2026-10-29
applies_to: [dsh-main-session, claude-code, codex, hermes, other-coding-agents]
requires_contract: v1
---

# taskboard-flow · 任务看板主流程（八步）

> **这一层只教顺序、判据与失败处置，不持有任何业务规则副本。**
> 数据在 `taskboard.sqlite`，门与错误码在 `src/mcp/`（L2 契约层）与 `src/core/`（L3 内核）。
> 机器规范（唯一真源，随包）：`spec/norms/*.md` —— 用 `norm_get` 取正文 + `digest`，**不要凭记忆**。

---

## 一句话开局

| 档 | 谁用 | 怎么做 | 要不要改宿主 |
| --- | --- | --- | --- |
| **A 开局提示词** | 人，在 dsh 主会话里新开一轮工作 | 把 `node scripts/tb-flow.mjs start` 的输出整块贴进会话；或让 MCP 客户端取 prompt `taskboard.flow`（同一个生成器，输出逐字节相同） | ❌ 不用 |
| **B 外部 agent 约定开局** | Claude Code / Codex 在**项目仓库**里开工 | 项目根 `AGENTS.md` 写一段「开工先跑 `<taskboard>/scripts/tb-flow.mjs start`，把输出当本轮上下文」；片段用 `tb-flow snippet` 打印 | ❌ 不用 |
| **C 宿主自动注入** | dsh 会话创建即注入 | **未启用**（须报批改 `~/.dsh/**` 并重载宿主）。接口形状已定死，见 [`references/injection.md`](./references/injection.md) | ✅ 须报批 |

---

## 八步（每步六栏：入口 / 前置门 / 判据 / 证据落点 / 失败处置 / 对应 FR）

<!-- flow-block:steps -->
| # | 步骤 | 入口 | 前置门 | 判据 | 证据落点 | 失败处置 | 对应 FR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **S0** | 绑定与对照 | `flow_start` · `project_info` · `workbench_audit` · `tb-flow start` | 会话归属（主会话，或已批准关联的会话） | 拿到 `project` + `contract_version` + `gaps`（未归因卡 / 未绑定主会话 / 待确认候选）；**这一步不做任何写操作** | 无（只读） | `PROJECT_NOT_FOUND` ⇒ 先建项目 / 显式带 `project`；`gaps.unboundSession` ⇒ 回看板「重建/绑定主会话」 | FR-91 / FR-99 |
| **S1** | 需求文档与条目 | `requirement_list` · `requirement_upsert` | 需求文档 digest 与契约一致 | 一条条目**只讲一件事**；`draft` 未确认的条目不得建卡；改条目必须带 `expected_version` | `requirement_items` | `MISSING_VERSION` / `VERSION_CONFLICT` ⇒ 重新 `requirement_list` 拿新 `version` 再提交（**不许覆盖**） | FR-35 / FR-36 |
| **S2** | 分拆成卡 | `card_create` | 条目存在 + 同项目 + 归因硬门 | 返回 `attribution.kind="requirement"`；卡在 `backlog`；依赖真成边 | `tasks` + `task_events`（`created` / `attributed`） | `REQUIREMENT_REQUIRED` ⇒ 补 `requirement`，或显式 `unattributed_reason`（会落审计）；`DEPENDENCY_CROSS_PROJECT` ⇒ 前置卡挂错项目；`AUTHORIZATION_REQUIRED` ⇒ 新卡只能进 `backlog` | FR-29 / FR-38 |
| **S3** | 授权开工（人） | 看板「启动执行」/ 人点 | 归因门 → 授权门 | `backlog → todo` 由**人**点；执行侧不得自我授权 | `task_events`（`set-status`，`actor=human`） | 执行侧想推 ⇒ `AUTHORIZATION_REQUIRED`；卡还没归因 ⇒ 先回 S2 | FR-40 / FR-84 |
| **S4** | 派发 / 执行 | 看板派发 · 宿主团队工具 · MCP `card_progress` 推进状态 | 归因 + 授权 + **人工校验门** | 卡进 `in_progress` 且带认领心跳；人工校验任务不得被执行侧改状态 | `team_runs` / claims / `task_events` | `HUMAN_REVIEW_NOT_EXECUTABLE` ⇒ 这是人在环任务，走人工结论入口；`EXECUTION_NOT_ATTRIBUTED` ⇒ 回 S2 补归因 | FR-41 / FR-42 / FR-85 |
| **S5** | 回填进度 + 证据 | `card_progress` | `contract_version` 一致 + `norm_digest` 一致 | 每条进展带**可核验证据**（`file` / `command` / `url` / `reading`），不是「已完成」三个字；`in_review` 前必须有证据 | 评论（`【MCP 证据】hash=…`）+ 审计 | `EVIDENCE_REQUIRED` / `EVIDENCE_INVALID` ⇒ 按形状补；`NORM_DIGEST_REQUIRED` / `NORM_STALE` ⇒ 先 `norm_get {norm:"card-update"}` 再回填 | FR-94 / FR-50 |
| **S6** | 需求变更 | `requirement_change` | 影响面已计算（`affected_cards`） | 先预览拿 `change_id`，确认影响面后带 `change_id` + `apply:true` 才落地；`done` 卡**不自动重开** | `governance_audit`（`requirement-change`，带 `reason`） | `CHANGE_NEEDS_APPROVAL` ⇒ 忘了先预览；`CHANGE_ID_MISMATCH` ⇒ 条目在预览后被改过，重新预览；`CHANGE_REASON_REQUIRED` ⇒ 补理由 | FR-39 / FR-100 |
| **S7** | 验收收口（人） | 看板「完成」/ 人点 | 评审门 `review_state==='approved'`（或显式 `skipReview`） | `in_review → done` **只由人**；执行侧写 `done` 一律被拒 | `governance_audit`（`actor=human`） | `REVIEW_NOT_APPROVED` ⇒ 先评审通过；`GOVERNANCE_AGENT_DONE` ⇒ 这不是执行侧该做的事 | FR-83 / FR-99 |
<!-- /flow-block:steps -->

---

## 随时可用的两个只读入口

八步之外，这两件随时可查、**不改变任何状态**：

| 工具 | 什么时候用 | 它回答什么 |
| --- | --- | --- |
| `project_info` | 想一眼看项目全貌（S0 之外的中途确认也行） | 任务 / 条目按状态计数 + 契约版本与基线是否漂移 |
| `workbench_audit` | 怀疑"哪里在漏"时（交接、回归、发版前） | 四类漂移各自多少条：`contract-stale`（谁在用旧契约）/ `unattributed`（未归因卡）/ `unbound-session`（主会话没绑）/ `candidate-flood`（候选超阈值） |

> 这两个是**盘点**，不是流程步骤：`workbench_audit.ok === true` 只代表"没有已知漂移"，
> 不代表"该做的事都做完了" —— 后者要看 `flow_start.nextStep`。

---

## 五条硬规则（都由门守，不靠自觉）

<!-- flow-block:rules -->
1. **`done` 只能人点** —— `card_progress` 写 `done` ⇒ `GOVERNANCE_AGENT_DONE`。
2. **`backlog → todo` 是人工授权** —— `card_create` 只接受 `backlog` ⇒ 其它值 `AUTHORIZATION_REQUIRED`。
3. **建卡必须归因** —— 无 `requirement` 且无 `unattributed_reason` ⇒ `REQUIREMENT_REQUIRED`。
4. **回填必须带证据 + 规范摘要** —— `EVIDENCE_REQUIRED` / `NORM_DIGEST_REQUIRED` / `NORM_STALE`。
5. **人工校验任务不得被执行侧改状态** —— `HUMAN_REVIEW_NOT_EXECUTABLE`。

> 这五条不是"建议"：它们是 MCP 入参形状与内核门的一部分。**照做不会更慢，绕过会直接失败。**
<!-- /flow-block:rules -->

---

## 我不做的事（防第二真源）

- ❌ **不存**任何项目数据 / 卡片状态 / 条目列表 —— 一律现取（`flow_start` / `requirement_list`）。
- ❌ **不写**某个项目的具体规范 —— 那是 `spec/norms/` + 项目 `<workspace>/AGENTS.md` 的事，本技能只给**顺序与指针**。
- ❌ **不定义**错误码语义 —— 错误码在 L2/L3；本技能只说「见到 X 该做什么」。
- ❌ **不替代** `AGENTS.md` —— 后者管「在这个仓库干活的规矩」，本技能管「跑这条主流程的顺序」。

---

## 参考

| 文件 | 内容 |
| --- | --- |
| [`references/steps/S0.md`](./references/steps/S0.md) … [`S7.md`](./references/steps/S7.md) | 每步的详细做法、命令示例、判据读数长什么样 |
| [`references/errors.md`](./references/errors.md) | 错误码 → 该做什么（含"别重试同一请求"的那些） |
| [`references/injection.md`](./references/injection.md) | 三档装载的细节 + 分层注入策略（档 C 预埋，未启用） |
| `spec/norms/flow.md` | 机器版主流程（运行时唯一真源，随包；`norm_get { norm:"flow" }`） |
| `spec/norms/card-update.md` | 卡片更新规范（`card_progress` 的 `norm_digest` 就取它） |
