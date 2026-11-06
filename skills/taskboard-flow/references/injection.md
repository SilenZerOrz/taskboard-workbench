# 三档装载 + 分层注入策略（档 C **已实现** · 默认 `off`）

> ✅ **已实现（卡 `-210` / 需求 `R128`）** —— `flow_inject_policy` 现在**真有 reader**了：
> 判定与投递在 `src/core/flow-inject.mjs`，宿主出口在 `index.js` 的 `createSession()`，
> 人工出口是 `node scripts/tb-flow.mjs inject --session <id>`。
> **默认 `off` ⇒ 不打开开关时行为与接线前完全一致**（不构建、不投递、不写审计行）。
> **自证**：`node --test tests/flow-inject-policy-gap.test.mjs`（结构 + 文档口径）
> 与 `node --test tests/flow-inject.test.mjs` / `tests/flow-inject-wiring.test.mjs`（四档分流与三处接线）。

## 一、三档从侵入性低到高

| 档 | 场景 | 机制 | 现状 |
| --- | --- | --- | --- |
| **A 开局提示词** | 人在 dsh 主会话新开一轮 | 贴 `node scripts/tb-flow.mjs start` 的输出（或 MCP prompt `taskboard.flow`，同一生成器） | ✅ 已可用 |
| **B 外部 agent 约定开局** | Claude Code / Codex 在**项目仓库**里开工 | 项目 `AGENTS.md` 一段「开工先跑 `<taskboard>/scripts/tb-flow.mjs start`」；片段用 `tb-flow snippet` 打印 | ✅ 已可用 |
| **C 宿主自动注入** | dsh 会话一创建就注入流程 | 宿主插件在 `createSession()` 建完会话后按项目 `flow_inject_policy` 注入（`main`=完整版 / 执行·关联=摘要版 / 子 agent=不注入） | ✅ **已实现·默认 `off`**（打开方式见 §二；生效需一次宿主重载窗口） |

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

## 二、档 C 的接线形状（已生效）

| 项 | 内容 | 现在生效吗 |
| --- | --- | --- |
| `flow_inject_policy` | `off` / `main-only` / `main+exec` / `all`（**默认 `off`**） | ✅ 生效。落在 `project_settings.flow_inject_policy`（API 字段 `flowInjectPolicy`），读点＝`src/core/flow-inject.mjs` |
| 审计表 | `flow_injections(session_id, project_id, policy, contract_version, digest, injected_at)` | ✅ 每次**投递成功**落一行；`digest = sha256(实际投出的正文)`，可事后核「投的是哪一版」 |
| 宿主接入位 | `index.js` 的 `createSession()` 出口（建会话 → 预置任务指令 → **注入装载块**） | ✅ 已接；`role` 由调用方声明（主会话 `main` / 任务执行会话 `exec`），**没声明就不注入** |
| 人工出口 | `node scripts/tb-flow.mjs inject --session <id> [--role …] [--host <url>]` | ✅ 已接（`POST /api/projects/:id/flow/inject`）；审计记 `policy=manual` |

### 怎么打开 / 怎么关掉（不需要改代码）

```bash
# 打开（只给项目主会话注入）
curl -X PUT http://127.0.0.1:3080/integrations/taskboard-workbench/api/projects/<项目id>/settings \
  -H 'content-type: application/json' -d '{"flowInjectPolicy":"main-only"}'
# 关掉（回滚：写回 off，或删掉该字段）
curl -X PUT ... -d '{"flowInjectPolicy":"off"}'
```

> 非法值在**写库之前**被拒（`flow_inject_policy 只能是 …`）；`flowInjectPolicy` 未传 ⇒ 保持不变。
> Web 配置页暂无该控件（配置页只管 `envConfig` / `teamTemplate`）—— 当前入口是上面的 API。

### 接入位长什么样（真实代码路径）

```
api.mjs  POST /api/requirement…/sessions/rebind (mode=create)  → port.createSession({role:"main"})
api.mjs  POST /api/tasks/:ref/execute                          → port.createSession({role:"exec"})
  └─ index.js createSession()
       ├─ sc.create({cwd}) → rename({sessionId,title}) → deliver(preset)   // 原有行为，未改
       └─ injectOpeningFlow() → src/core/flow-inject.mjs
            ├─ 读 project_settings.flow_inject_policy（缺省 off ⇒ 直接返回 policy-off）
            ├─ decideFlowInjection({policy, role})            // 纯函数：策略 × 角色矩阵
            ├─ 完整版 = buildFlowBlock().text                  // ★ 与 tb-flow start / MCP prompts/get 同一生成器
            │  摘要版 = buildFlowSummary(block)               //   由同一个 block 剪裁，不另写规则
            ├─ deliver(sessionId, text)                        // sessionController.prompt(mode:"queue")
            └─ store.recordFlowInjection({…六字段})
```

**关键：注入内容必须由同一个生成器产出** —— 否则宿主注入的、人贴的、agent 自己拉的会是三份不同的说明书。
守卫：`tests/flow-inject-wiring.test.mjs` 的 C1 用**独立进程**跑 `tb-flow inject`，
把 `tb-flow start` 的 stdout 与宿主实际投出的正文**逐字节对拍**（并核 `sha256`）。

## 三、分层注入策略（按会话角色给不同长度）

| 会话类型（`role`） | 注入什么 | 为什么 |
| --- | --- | --- |
| **项目主会话**（`main`） | 完整版：八步全文 + 五条硬规则 + 错误码索引 | 它要做判断、要拆卡、要回填 |
| **执行会话**（`exec`） | **摘要版（≤ 300 tokens）**：当前步 + 两道门 + 常见错误码处置 | 它只需要"别把 done 写了"这类护栏 |
| **关联会话**（`related`） | 摘要版（同 `exec`） | 同上；只在 `all` / `manual` 下注入 |
| **子 agent 会话**（`subagent`） | **不注入**（**硬规则**，`manual` 也不放开） | 子 agent 由父会话派活，注入只会稀释它自己的任务上下文 |

策略 × 角色（✓＝注入）：

| 角色 \ 策略 | `off` | `main-only` | `main+exec` | `all` | `manual` |
| --- | --- | --- | --- | --- | --- |
| `main` | — | ✓ 完整版 | ✓ 完整版 | ✓ 完整版 | ✓ 完整版 |
| `exec` | — | — | ✓ 摘要版 | ✓ 摘要版 | ✓ 摘要版 |
| `related` | — | — | — | ✓ 摘要版 | ✓ 摘要版 |
| `subagent` | — | — | — | — | — |

`manual` 只给人工一次性投递用（显式绕过 `off`，所以审计必须能把它与自动注入区分开）。
角色未知（调用方没声明）⇒ **不注入**（`role-unknown`）：宁可少注，不可把完整版塞进执行会话。

摘要版的真实形状（由 `buildFlowSummary(block)` 生成，长度实测 ≈164 tokens / 374 字符）：

```
任务看板主流程（摘要）
当前步：<S?，来自 buildFlowBlock().nextStep>
两道门：done 只能人点（GOVERNANCE_AGENT_DONE）· backlog→todo 是人工授权（EXECUTION_NOT_AUTHORIZED）
回填要带：evidence[]（file/command/url/reading）+ norm_digest（norm_get "card-update"）
契约：<contract_version>（用旧版本会落 contract-warn）
常见错误码：EXECUTION_NOT_ATTRIBUTED（先补归因）· CONTRACT_STALE / NORM_STALE（重取规范）· REVIEW_NOT_APPROVED（等人复核）
全文：`node scripts/tb-flow.mjs start`（与宿主注入同源）
```

> ⚠ 上一版本文里写的是 `AUTHORIZATION_REQUIRED` —— **本仓没有这个错误码**（真码是 `EXECUTION_NOT_AUTHORIZED`）。
> 摘要版要塞给人/agent 直接照做的错误码，写错等于指路指到墙上；`tests/flow-inject.test.mjs` 的 C 条把它钉住。

## 四、失败与运维边界

- **注入异常不阻断会话创建**（验收 ⑤）：`injectFlow()` **从不抛错**，一律回 `{injected:false, reason}`；
  宿主 `createSession()` 把结果塞进 `injection` 字段如实回包，会话照旧建出来。
- **投递成功但审计写失败** ⇒ 回 `injected:true` + `reason:"injected-audit-failed"`（**不谎报没投**，否则调用方会重复注入）。
- **无宿主通道**（独立进程实例）：`POST /flow/inject` 回 `{delivered:false, reason:"host-unavailable", prompt:"<正文>"}`
  —— 正文原样回带，人可以直接粘贴；CLI 同理（退出码 5，正文打到 stdout）。
- **生产生效仍需一次宿主重载窗口**：本轮的代码改动在仓库内（`index.js` / `api.mjs` / `store.mjs`），
  要让**当前运行中的** `:3080` 实例用上，必须重载宿主 —— 属 AGENTS.md §3 须先报批的动作，本轮未做。
- **不做的事**：不碰 `~/.dsh/**`、不改任何会话创建路径（只在本插件自己的 `createSession()` 出口加一层）、
  不把注入做成「第二真源」（正文只能来自 `buildFlowBlock()` / `buildFlowSummary(block)`）。
