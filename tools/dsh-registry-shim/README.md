# dsh-registry-shim（宿主层运行时 shim，**非产品代码**）

## 它解决什么

宿主「**新建会话**」按钮报错，且 `initial Session restoration failed` 同因：

```
Error: Agent preset binding requires a scoped context
```

抛错点在 `dsh web` **实际加载的全局副本**：

```
~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js
```

`bind(ctx, generation)` 第 662–663 行：`const key = scopeOf(ctx); if (key === void 0) throw new Error(...)`。
本仓库**不注册任何 preset**，所以这是**宿主层**问题；profile 侧另一份副本其实**已带** 2026-10-08 的同类补丁，只有全局这份 10-05 原版没打。

## 它怎么做（关键：不动任何已安装文件）

`hook.mjs` + `loader.mjs` 通过 `node --import` 注册一个 ESM 加载器，**只在内存里**把那一行 `throw` 换成 `return`。

- **不写盘**：`~/.npm-global` 下那份 `index.js` 一个字节都不改（可自行 `shasum` 比对）。
- **语义等同**：与 profile 副本的既有补丁完全一致 —— 无作用域时跳过 preset 绑定，会话照常创建（代价是该会话不做 preset 作用域隔离，上游未修）。
- **可逆**：不设环境变量即完全不生效；`TB_REGISTRY_SHIM=0` 显式关闭。

## 怎么用

默认经 `tools/dsh-mvp-autostart.sh` 自动启用；日志里会出现一行 `[dsh-registry-shim] 内存内改写：…` 作为生效证据。

手动启动：

```bash
NODE_OPTIONS="--import $PWD/tools/dsh-registry-shim/hook.mjs" dsh web --no-open
```

关闭：

```bash
TB_REGISTRY_SHIM=0 bash tools/dsh-mvp-autostart.sh
```

## 什么时候可以删掉它

上游 `@deepseek-ai/dsh-agent-preset-registry` 修掉该 throw（或全局副本被官方升级为带补丁的版本）后，本目录即可删除 —— 加载器会打印「未命中目标行，放行（上游可能已修）」。

---

## ⚠ 2026-10-18 实测结论：**这一行补丁不足以修好**，故默认关闭

在 `dsh 0.2.0-rc.2`（本机全局副本）上做了对照实测（`node --import` 加载本 shim → 无头 Chrome 点宿主「新会话」）：

| 状态 | 点「新会话」得到的错误 |
| --- | --- |
| 不开 shim | `Agent preset binding requires a scoped context`（原错误） |
| 开 shim | `prompt section "context:file-reference" is already registered (for a per-agent override, register through that agent's \`agent.ctx\` instead)` |

**两次都失败，只是错误换了。** 原因链路（读上游源码得出的判断）：

1. `dsh-agent-preset-registry` 的 `bind()` 因 `scopeOf(ctx) === void 0` 而 throw —— 但上游注释自己写明，`setup(agentCtx, agent)` 传进来的 ctx **是带 scope 的**（`scope.ctx = loopCtx.fiber.ctx.extend({[kScope]: this})`），只是 `scopeOf()` 在 0.2.x 下读不出来 —— **真正的 bug 在 `scopeOf` 读不到，而不是"缺少 scope"**。
2. 因此"跳过绑定"只是把异常压掉：预设的贡献随后在**根作用域**被注册第二次，撞上 `dsh-system-prompt` 的重复注册保护（该错误文案正是 `scope === void 0` 那一支），会话创建照旧中止。

**结论与建议**：

- **不要**为了这个错误去给全局安装打持久补丁（`/private/tmp/tb-patch-registry.mjs` 做的是同一处替换，实测同样修不好）—— 那只会改动一个**全局** npm 安装却拿不到收益。
- 该缺陷属**上游 host 层**（本仓库不注册任何 preset），正解是等上游修 `scopeOf`/`bind`，或把 dsh 升到已修版本。
- 本目录保留为**诊断工具**：设 `TB_REGISTRY_SHIM=1` 可复现"第二层错误"，便于向上游报 issue。

（`tools/dsh-mvp-autostart.sh` 已按此改为**默认不启用**，并保留同一段说明。）
