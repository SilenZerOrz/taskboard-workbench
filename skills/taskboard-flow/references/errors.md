# 错误码 → 该做什么

> 错误码由 L2（`src/mcp/`）与 L3（`src/core/`）产生，**本文件只是索引**：
> 真正权威的是代码里的抛出点。见到不认识的码，先 `grep -n "<CODE>" src/` 再动手。

## 一、协议层 vs 工具层（先分清这个，再看具体码）

| 层 | 长什么样 | 含义 |
| --- | --- | --- |
| 协议层 | JSON-RPC `error.code`（如 `-32602`） | **调用姿势错了**：未知工具、参数结构不对 |
| 工具层 | `result.isError: true` + `{ code, message, details }` | **业务上被拒了**：门没过、形状不对、状态冲突 |

分不清这两层的后果：把「参数写错」当成「服务挂了」而不停重试。

## 二、建卡 / 归因 / 授权

| 错误码 | 意思 | 该做什么 | 能不能原样重试 |
| --- | --- | --- | --- |
| `REQUIREMENT_REQUIRED` | 没归因也没声明不归因 | 补 `requirement`，或显式 `unattributed_reason` | ❌ 改了参数再发 |
| `USAGE_ERROR` | `requirement` 与 `unattributed_reason` 同时给了 | 二选一 | ❌ |
| `AUTHORIZATION_REQUIRED` | 想直接建进 `todo`（或执行侧想自我授权） | 建进 `backlog`，之后请人授权 | ❌ |
| `DEPENDENCY_CROSS_PROJECT` | 条目/前置卡属于别的项目 | 回到正确项目 | ❌ |
| `TASK_NOT_FOUND` | 引用的卡不存在 | 核对编号（`project-123` 或 uuid） | ❌ |
| `INVALID_TITLE` / `INVALID_STATUS` / `INVALID_PRIORITY` | 字段值不合法 | 按 `details.allowed` 改 | ❌ |

## 三、回填进度

| 错误码 | 意思 | 该做什么 | 能不能原样重试 |
| --- | --- | --- | --- |
| `EVIDENCE_REQUIRED` | `evidence[]` 空 / 没传 | 给至少一条 `{kind, ref}` | ❌ |
| `EVIDENCE_INVALID` | `kind` 不在四类里，或 `ref` 为空 | 按 `details.allowedKinds` / `index` 改 | ❌ |
| `NORM_DIGEST_REQUIRED` | 没带 `norm_digest` | `norm_get { norm: "card-update" }` 取 `digest` | ❌ |
| `NORM_STALE` | 你用的是旧规范 | 读 `details.body`（最新正文）后重新回填 | ❌（但**不需要人介入**） |
| `GOVERNANCE_AGENT_DONE` | 执行侧写 `done` | 交人点完成（S7） | ❌ 永不 |
| `HUMAN_REVIEW_NOT_EXECUTABLE` | 人工校验任务被执行侧改状态 | 走人工结论入口 | ❌ 永不 |

## 四、需求条目 / 需求变更

| 错误码 | 意思 | 该做什么 | 能不能原样重试 |
| --- | --- | --- | --- |
| `MISSING_VERSION` | 改条目没带 `expected_version` | 先 `requirement_list` 取 `version` | ❌ |
| `VERSION_CONFLICT` | 条目已被改过 | 重新取 `version`，**合并**后再提交 | ❌ |
| `CHANGE_NEEDS_APPROVAL` | `apply:true` 但没带 `change_id` | 先预览 | ❌ |
| `CHANGE_ID_MISMATCH` | 预览后条目被改 / 补丁换了 | 重新预览拿新 `change_id` | ❌ |
| `CHANGE_REASON_REQUIRED` | 变更没写理由 | 补 `reason` | ❌ |

## 五、契约 / 项目

| 错误码 | 意思 | 该做什么 | 能不能原样重试 |
| --- | --- | --- | --- |
| `CONTRACT_STALE` | 契约版本对不上（**切 `reject` 档后才会出现**） | 用 `details.snapshot.contractVersion` 重试；`details.changed[]` 告诉你**哪份文件变了** | ✅ 换版本号后 |
| `NORM_NOT_FOUND` | 规范 id 写错 / 规范文件缺失 | 按 `details.allowed` 改 | ❌ |
| `PROJECT_NOT_FOUND` | 项目不存在 / cwd 不在任何项目里 | 显式传 `project` | ❌ |

## 六、只有这三类**值得等一等再试**

1. **上游/宿主临时故障**（`host-unavailable`、投递超时）—— 等几秒到几分钟；
2. **`CONTRACT_STALE`** —— 换个 `contract_version` 立刻可以重试；
3. **`VERSION_CONFLICT`** —— 重读后合并再试（**不是原样重试**）。

其余全部属于「**输入就不对**」：原样重试只会烧掉时间，而且往往会把同一个错误刷进审计。
