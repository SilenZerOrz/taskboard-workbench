# 三档装载 + 分层注入策略（档 C 预埋，未启用）

## 一、三档从侵入性低到高

| 档 | 场景 | 机制 | 现状 |
| --- | --- | --- | --- |
| **A 开局提示词** | 人在 dsh 主会话新开一轮 | 贴 `node scripts/tb-flow.mjs start` 的输出（或 MCP prompt `taskboard.flow`，同一生成器） | ✅ 已可用 |
| **B 外部 agent 约定开局** | Claude Code / Codex 在**项目仓库**里开工 | 项目 `AGENTS.md` 一段「开工先跑 `<taskboard>/scripts/tb-flow.mjs start`」；片段用 `tb-flow snippet` 打印 | ✅ 已可用 |
| **C 宿主自动注入** | dsh 会话一创建就注入流程 | 宿主插件在 `sessionController` 创建会话时注入 | ⏸ **未启用**（须报批改 `~/.dsh/**` + 重载宿主） |

### 档 B 的 `AGENTS.md` 片段（`tb-flow snippet` 的输出）

```markdown
## 开工（任务看板主流程）

本项目用 taskboard-workbench 管任务。**动代码之前**先跑：

    node <taskboard-workbench>/scripts/tb-flow.mjs start --project <项目id>

把输出的「装载块」当本轮上下文：里面的 `nextStep` 就是本轮该先做的事，
`gaps` 告诉你哪里还欠账。流程细节见
`<taskboard-workbench>/skills/taskboard-flow/SKILL.md`。
```

> 三条边界：① 片段**只指路**，不复制八步正文（避免第二真源）；② 路径写成占位符 —— 每个项目装在哪不一样；
> ③ 这段**不覆盖**项目自己的 `AGENTS.md` 规矩，只是「开工第一步」。

## 二、档 C 的接口形状（已定死，未接线）

| 预埋项 | 内容 | 现在生效吗 |
| --- | --- | --- |
| `flow_inject_policy` | `off` / `main-only` / `main+exec` / `all`（**默认 `off`**） | ✅ 是一个"配置位"，但**没有任何代码读它去注入** |
| 审计表 | `flow_injections(session_id, project_id, policy, contract_version, digest, injected_at)` | ✅ 表在（P1 建的），`recordFlowInjection` / `listFlowInjections` 可用 |
| 接入位 | 「会话创建 → 注入」的 hook 点 | ⏸ **只在本文件文档化，不写任何 `~/.dsh/**` 补丁** |

### 接入位长什么样（将来接线时的位置）

```
宿主 sessionController.createSession()
  └─ 若 flow_inject_policy !== "off"
       ├─ 取 buildFlowBlock()（与本档 A/B 同一个生成器，见 src/mcp/flow-block.mjs）
       ├─ 按会话层级选版本（见下）
       └─ recordFlowInjection({ projectId, sessionId, policy, contractVersion, digest })
```

**关键：注入内容必须由同一个生成器产出** —— 否则宿主注入的、人贴的、agent 自己拉的会是三份不同的说明书。

## 三、分层注入策略（按会话角色给不同长度）

| 会话类型 | 注入什么 | 为什么 |
| --- | --- | --- |
| **项目主会话** | 完整版：八步全文 + 五条硬规则 + 错误码索引 | 它要做判断、要拆卡、要回填 |
| **执行 / 关联会话** | **摘要版（≤ 300 tokens）**：当前步 + 两道门 + 常见错误码处置 | 它只需要"别把 done 写了"这类护栏 |
| **子 agent 会话** | **不注入** | 子 agent 由父会话派活，注入只会稀释它自己的任务上下文 |

摘要版的形状（将来由生成器按 `policy` 剪裁，不另写一份）：

```
任务看板主流程（摘要）
当前步：<S?，来自 flow_start.nextStep>
两条门：done 只能人点（GOVERNANCE_AGENT_DONE）· backlog→todo 是人工授权（AUTHORIZATION_REQUIRED）
回填要带：evidence[]（file/command/url/reading）+ norm_digest（norm_get "card-update"）
契约：<contract_version>（用旧版本会落 contract-warn）
```

## 四、为什么档 C 现在不做

- 它会碰 `~/.dsh/profiles/**` 与宿主重载 —— 属 AGENTS.md §3 明令须先报批的范围；
- A + B 已经覆盖了「人开局」与「外部 agent 约定开局」两个真实场景；
- 插件包形态（市场安装）定下来之后再接，能少返工一次。
