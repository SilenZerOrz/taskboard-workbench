# dsh-core-pkg-dedupe（宿主核心包「单物理副本」根因修复）

**非产品代码**。用途：把 `@deepseek-ai/dsh-tools` / `dsh-agent-loop` / `dsh-scope` 在 **profile 下的多份物理副本**
收敛成**指向宿主安装那一份的符号链接**，从根上消掉「双模块实例 ⇒ 双 Symbol」。

## 为什么这能修

抛错点在宿主：`@deepseek-ai/dsh-agent-loop/lib/index.js:582`

```js
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
```

`TOOL_RUNTIME_SCHEDULER` 是 `@deepseek-ai/dsh-tools` 的**模块级** Symbol：

```js
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler"); // dsh-tools/lib/index.js:2526
var ToolRuntime = class extends Service { [TOOL_RUNTIME_SCHEDULER] = { prepare, dispatch, finalize, finish }; }; // :2674
```

`Symbol()` 每次调用都产生**全新且不相等**的值 ⇒ 只要进程里加载了**两份** `dsh-tools`，
「谁创建 `ctx.tools`」与「谁在 agent loop 里按 Symbol 查调度器」就可能落在不同实例上
⇒ 查到 `undefined` ⇒ 抛 `Cannot read properties of undefined (reading 'prepare')`。

同一个坑还有 `dsh-scope`（模块级 `kScope = Symbol("dsh.scope")`，症状是新建会话报
`Agent preset binding requires a scoped context`）。

## 与 `tools/dsh-tools-alias-shim/` / `tools/dsh-scope-alias-shim/` 的关系

| | 运行时 shim（既有） | **本目录（根因修复）** |
| --- | --- | --- |
| 做法 | 用 `node --import` 的 ESM loader 钩子**在内存里**把解析结果改写到宿主那份 | 把 `.pnpm` 下重复的**物理副本目录**换成指向宿主那份的**符号链接** |
| 生效条件 | 必须带上 `NODE_OPTIONS`（否则完全无效） | 无需任何环境变量；Node 默认按 realpath 解析即天然单实例 |
| 覆盖面 | 只覆盖**带 shim 启动**的进程 | 覆盖**所有**用该 profile 的进程 |
| 缺点 | LaunchAgent/桌面应用拉起时会丢（本机就踩过） | 下次 `pnpm install` 会把副本装回来，需重跑 |

两者可**同时启用**，互不冲突；本目录是「盘上形态」的修复，shim 是「进程内」的兜底。

## 用法

```bash
bash tools/dsh-core-pkg-dedupe/apply.sh --check    # 只读体检（有副本时退出码 1）
bash tools/dsh-core-pkg-dedupe/apply.sh --apply    # 归一（幂等）
bash tools/dsh-core-pkg-dedupe/apply.sh --revert   # 回滚成真实副本
node tools/dsh-core-pkg-dedupe/verify.mjs          # 验证（务必不带 NODE_OPTIONS）
```

- 环境变量：`TB_PROFILE_DIR`（默认 `~/.dsh/profiles/web`）、`TB_CANON_ROOT`（默认全局 dsh 安装的 `@deepseek-ai/`）、`TB_DEDUPE_BAK`（默认 `/private/tmp/dsh-dedupe-backup-<时间戳>`）。
- `--apply` **不删除**任何东西：原件用 `mv` 移进备份目录，可原样搬回。

## 本机实测（2026-10-22）

**改前**（不带 shim，直接比较模块导出）：

```
· REAL DIR  .pnpm/@deepseek-ai+dsh-tools@0.2.0-rc.2_5d431451…/node_modules/@deepseek-ai/dsh-tools
· REAL DIR  .pnpm/@deepseek-ai+dsh-tools@0.2.0-rc.2_aac9e94f…/node_modules/@deepseek-ai/dsh-tools
· REAL DIR  .pnpm/@deepseek-ai+dsh-tools@0.2.0-rc.2_e9ca926d…/node_modules/@deepseek-ai/dsh-tools
· Symbol 同一性：DIFFERENT INSTANCE ✗（×3）
真实副本目录：8 个（dsh-tools 3 / dsh-agent-loop 3 / dsh-scope 2）   失败项：11
```

**改后**：

```
· symlink  …（8 条全部指向宿主那份）
· Symbol 同一性：SAME INSTANCE ✓（×3）
真实副本目录：0 个   失败项：0
✓ PASS —— .pnpm 下已无独立物理副本，全部解析到宿主那一份
```

**内容一致性**（归一安全的前提，逐份 sha256 比对）：`dsh-tools` `40f47709…`、`dsh-agent-loop` `00c4814d…`、
`dsh-scope` `2829df71…` —— **profile 副本与宿主那份逐字节相同**。

## 边界（诚实写明）

- 只对「副本与宿主那份内容相同」的包安全。**桌面应用实例（`profiles/desktop`）未动**：
  它的两份 `dsh-tools` 与宿主那份 sha256 不同（属不同版本），强行归一等于换版本。
- `--apply` 之后若再执行 `pnpm install` / `dsh plugin add`，副本会被装回来 ⇒ **SOP：每次装完跑一次 `--check`**。
- 未做「pkill 掉 `pnpm-workspace.yaml` 里那条 `@deepseek-ai/dsh-tools` 版本 override → 改 `link:` 覆盖」的持久形态：
  该思路 2026-10-09 曾用过并**当日撤回**，撤回原因无据可查，故不在未验证前重复。
