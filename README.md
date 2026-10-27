# taskboard-workbench

> **Agent Team 任务工作台**：一个本地优先（local-first）的多项目任务看板，
> 零运行时依赖（`node:sqlite`），既可独立跑成 **CLI + 本地 Web 服务**，也能作为
> **DSH（DeepSeek Harness）内嵌插件**挂进会话里，派发任务、回流证据、独立复验。

---

## 它解决什么

把「需求条目 → 看板派发 → CLI/agent 实际开发 → 证据回流 → 独立复验 → 人工验收」
这条闭环固化成可查询的数据与可重放的流程，而不是散落在聊天记录里。

- **任务不是聊天**：任务卡有状态机（`backlog → todo → in_progress → in_review → done`）、
  乐观锁（`--if-version`）、认领锁与心跳、失败会计与熔断。
- **证据留在卡上**：评论、事件流、尝试记录、诊断信息都挂在任务上，可回溯。
- **人工守住最后一道门**：执行侧只能把卡推到「待验收」，`done` 必须由人确认。

## 功能概览

| 模块 | 内容 |
| --- | --- |
| 存储核心 | 零依赖 SQLite（`node:sqlite`）；多项目 / 任务 / 需求条目；状态机、父任务、标签、负责人 |
| 看板 | 列看板（列内拖拽排序）、关键词搜索、Markdown 呈现与内容安全过滤 |
| 需求视图 | 需求条目列表化展示（行式列表 + 点击右侧抽屉看详情）、引入文件按文件夹树呈现 |
| 执行编排 | 看板侧 CLI 执行器（如 `cli:claude`）、派发引擎选择、执行看护、通知订阅与唤醒 |
| CLI | `tb` 命令（项目 / 任务 / 评论的 CRUD，JSON 输出 + 稳定退出码） |
| DSH 插件 | `dsh.bundle.patch` + `dsh.client`（web 平台侧栏 / 布局 / 槽位注入），会话内「任务工作台」标签页 |

## 安装

### 作为 DSH 插件

```bash
dsh plugin --profile web add taskboard-workbench
```

插件通过 `dsh.bundle.patch`（`cordis.patch.yml`）与 `dsh.client` 注入到宿主；
需要宿主支持的 `@deepseek-ai/dsh-client-ui-{layout,sidebar,slots}`（已声明为**可选 peer**）。

### 从源码

```bash
git clone https://github.com/SilenZerOrz/taskboard-workbench.git
cd taskboard-workbench
dsh plugin --profile web add .
```

### 独立跑（不用 DSH）

```bash
npm start                      # 启动本地 Web 服务（默认监听本机端口）
node cli/tb.mjs project list   # 或用 CLI 直接操作
```

## 要求

| 项 | 值 |
| --- | --- |
| Node.js | `>= 22.5.0`（依赖 `node:sqlite`） |
| DSH | `0.2.0-rc.2` 线真机验证通过（`0.2.1-alpha.1` 历史走通） |
| 运行时依赖 | 无（`dependencies` 为空） |

## 快速上手（CLI）

```bash
# 数据目录：--data-dir > $TB_DATA_DIR > 系统临时目录
export TB_DATA_DIR="$HOME/.taskboard-data"

node cli/tb.mjs project create --name "示例项目" --id demo
node cli/tb.mjs task create --project demo --title "跑通一次闭环" --description "验证一下"
node cli/tb.mjs task list --project demo
node cli/tb.mjs comment add 1 --body "证据：npm test 全绿"
```

CLI 约定：成功 `stdout` 输出 JSON（含 `schemaVersion`），退出码 `0`；
失败 `stderr` 输出 `{schemaVersion, error:{code,message}}`，退出码 `2/3/4/5`。
并发编辑用 `--if-version`，版本不符返回 `VERSION_CONFLICT`（退出码 5）而不静默覆盖。

## 配置

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `TB_DATA_DIR` | SQLite 数据目录 | 系统临时目录（仅适合试跑，正式用请显式指定） |

项目级配置（工作区路径、审批策略、执行者选择等）在 Web 看板的「项目设置」里维护。

## 目录结构

```
index.js              DSH 插件入口（cordis patch 注入点）
lib/client.js         宿主侧客户端桥
cordis.patch.yml      dsh.bundle.patch
src/core/             存储、状态机、团队模板、执行编排、看护
src/server/           HTTP API 与事件流
src/host/             团队引擎与工具面
web/                  本地 Web 看板（app.js / tokens.css / index.html）
cli/tb.mjs            `tb` 命令行
spec/团队agent.md      团队契约（随包发布，供工作台里的 agent 读取）
tests/                `node --test` 单测
tools/                开发与验证脚本（不进 npm 包，除 seed/env-check）
```

## 测试

```bash
npm test          # node --test，全量单测
node --check index.js   # 语法自检（对每个源文件）
```

## 版本

见 [CHANGELOG.md](./CHANGELOG.md)。对外首个版本为 `0.1.0`。

## 说明：`docs/` 不随仓库发布

本仓库的过程文档（需求 / 计划 / 进度 / 验证 / 规范 / 发布 SOP 等）在本地维护，
**不进入 git 与 npm 包**（见 `.gitignore`）。仓库只发布可运行的代码与随包契约 `spec/`。

## License

[MIT](./LICENSE)
