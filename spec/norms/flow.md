---
norm_id: flow
version: 1
updated: 2026-10-29
applies_to: ["*"]
---
# flow · 主流程八步（机器版）

> 这是**给 agent 执行**的契约，不是给人读的文档。人读正本在 `docs/`（不入 git）。
> 顺序与四道门**不可覆盖**；项目只允许在 `project-defaults` 的 3 类白名单内参数化。

| 步 | 名称 | 该做什么 | 前置门 | 允许的写 |
|---|---|---|---|---|
| S0 | 绑定与对照 | 认项目、认会话归属；先看 `gaps`（未归因卡 / 未绑定会话 / 待确认候选） | 会话归属（主会话或已批准关联） | 无 |
| S1 | 需求文档与条目 | 文档 → 条目，**一条一件事**；`draft` 未确认不得建卡 | 文档 digest 一致 | 需求条目 |
| S2 | 分拆成卡 | 建卡**必带 `requirement`**；一事务内完成归因 | 条目存在 + 同项目 | 卡片 |
| S3 | 授权开工 | `backlog → todo`；**人点**，执行侧不得自我授权 | 归因门 → 授权门 | 卡片状态 |
| S4 | 派发/执行 | 派团队或 CLI；持锁 + 心跳 | 归因 + 授权 + 人工校验门 | 执行记录 |
| S5 | 回填进度 | 每条进展**带可核验证据**（文件 / 命令 / 读数），不是「已完成」三个字 | 契约版本一致 + `norm_digest` 匹配 | 评论 + 事件 |
| S6 | 需求变更 | 先算**影响面**再改；`done` 卡不自动重开，标 `needs_recheck` | 影响面已确认 | 变更集 |
| S7 | 验收收口 | `in_review → done`，**只由人** | 评审门 `review_state==='approved'` 或显式 `skipReview` | 卡片状态 |

## 四道门（不可覆盖）

1. **人工校验**（人在环）：`human_review` 卡两出口都 409 `HUMAN_REVIEW_NOT_EXECUTABLE`。
2. **归因**：未归因卡不得派发 ⇒ `EXECUTION_NOT_ATTRIBUTED`；逃生口 `unattributed_reason` 必须落审计。
3. **授权**：`backlog → todo` 只由人（`GOVERNANCE_ACTOR`）。
4. **评审**：`in_review → done` 需 `approved`；人可 `skipReview:true` 跳过，但服务端落 `review_skipped` 审计。

## 错误码处置（agent 自纠偏，不要问人）

| 错误码 | 含义 | 处置 |
|---|---|---|
| `EXECUTION_NOT_ATTRIBUTED` | 卡未挂需求条目 | 先补归因（`requirement` 参数 / `tb task attribution`），再派发 |
| `CONTRACT_STALE` | 契约版本过期 | 用返回体里的 `snapshot` 重试（**别问人**） |
| `NORM_STALE` | 用了旧规范 | 重取 `norm_get`，按新正文改完再写 |
| `REVIEW_NOT_APPROVED` | 未评审就想 done | 先 `review approve`；跳过须人显式 `skipReview` |
| `HUMAN_REVIEW_NOT_EXECUTABLE` | 人工校验卡被派发 | 停手，转人处理 |
| `GOVERNANCE_AGENT_DONE` | 执行侧想点完成 | 停手，交人点 |

## 红线

- **`done` 只能由人置**；执行侧与评审都不得代点。
- 需求变更**不自动重开**已完成卡。
- 派生动作（建卡 / 派发 / 收口）必须能被审计追到「谁、用哪版契约、什么证据」。
