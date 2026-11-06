# Pull Request 模板

> 本仓 `AGENTS.md §3` 规定**默认不 commit / 不 push**（除非用户明确要求）。
> 本模板仅在「确需走 PR 流程」时使用；请先确认该前提。

## 关联

- 任务卡：`taskboard-workbench-___`
- 需求条目：`taskboard-workbench-R___`
- 相关轮次文档：`docs/进度/____.md`

## 改动范围

- [ ] 只改了卡面 `inScope` 内的文件
- [ ] 未触碰 `docs/进度/`（除轮次记录）、`.data/`、`~/.dsh/**`、`package.json`（如触碰请说明）
- 关键文件与行号：
  - `path/to/file.mjs:123` —— 做了什么

## 验证读数（贴真实输出，不写"应该没问题"）

```text
$ npm test
ℹ tests ___ ℹ pass ___ ℹ fail ___

$ node --check <改动文件>
（无输出 = 通过）
```

- 反证 / 回归（若有）：
- 真机验收台（若有）：`node tools/bench-xxx.mjs` → __/__ PASS

## 边界自查

- [ ] 未 commit / 未 push（或已获明确授权并注明）
- [ ] 未删用户数据（看板项目 / 任务 / 需求条目）
- [ ] 未影响 dsh 主进程会话与官方插件加载
- [ ] 生效前置条件已登记（如需重载 / 装依赖 / 迁移）

## 遗留与后续

- 已知未做：
- 需要人拍的口径：
