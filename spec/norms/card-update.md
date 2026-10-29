---
norm_id: card-update
version: 1
updated: 2026-10-29
applies_to: ["*"]
---
# card-update · 卡片更新规范（机器版）

## 状态怎么走

```
backlog ──人授权──▶ todo ──派发──▶ in_progress ──回填──▶ in_review ──人验收──▶ done
   ▲                    ▲                    │                 │
   └── 驳回/返工 ◀───────┴────────────────────┘                 └── 返工 ──▶ in_progress
in_progress ──阻断──▶ blocked ──解除──▶ todo（依赖类）/ in_progress（其它）
```

- **`in_review → done`** 必须 `review_state === 'approved'`；人可显式 `skipReview: true`。
- **`blocked`** 分两类：`dependency`（回到 `todo` 等父卡，不进人工队列）/ 其它（进 `blocked`，同因复发达阈值转人工兜底）。
- **`canceled`** 不是完成：不得计入完成度。

## 每条回填必须带证据

| 字段 | 要求 |
|---|---|
| `body` | 说清「改了什么 / 为什么 / 影响面」，不要写「已完成」 |
| 证据 | 至少一条可复核读数：**命令 + 输出摘要** 或 **文件路径 + 行号** |
| 验证 | 与 `gate.config.verifyCommand` 一致（默认 `npm test`） |

## 禁止

- 执行侧写 `done`（`GOVERNANCE_AGENT_DONE`）。
- 「先改状态、事后再补证据」——回填与状态推进要同时到。
- 用评论代替事件：状态变化必须落 `task_events`。
- 把多件事塞进一张卡（一张卡＝一件事，便于收口与追因）。

## 卡面字段最小集

`title`（动词开头的短句）· `requirementId`（必填或显式豁免理由）· `owner` · `labels`（`kind/work` · `kind/review` · 领域标签）· `acceptance`（验收要点，可核验）。
