# Changelog

`taskboard-workbench` 的全部对外版本变更记录。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
每个版本对应一个 annotated tag（`vX.Y.Z`）与一条 GitHub Release；npm dist-tag 与 dsh 兼容区间随版本记录。

## [0.1.0] - 2026-10-23

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
