# dsh-tools-alias-shim（宿主「工具链单实例归一」）

**非产品代码**。用途：验证/修复「会话内**工具调用 100% 失败**」的宿主异常

```
Cannot read properties of undefined (reading 'prepare')
```

## 为什么这能修

抛出点在宿主：`@deepseek-ai/dsh-agent-loop/lib/index.js:582`

```js
const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
```

`TOOL_RUNTIME_SCHEDULER` 是 `@deepseek-ai/dsh-tools` 的**模块级 Symbol**：

```js
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");   // dsh-tools/lib/index.js:2526
var ToolRuntime = class extends Service { [TOOL_RUNTIME_SCHEDULER] = { prepare, dispatch, finalize, finish }; }  // :2674
```

报错文案是「reading **'prepare'**」而不是「reading 'Symbol(…)'」→ **`ctx.tools` 是存在的**，
只是那个 **Symbol 键**取不到值。Symbol 是**模块实例内唯一**的：
同一份源码被两条路径加载 → 两个模块实例 → 两个不同 Symbol →
「谁提供 ToolRuntime」与「谁在 agent loop 里查 Symbol」落在不同实例上时，查询必然落空。

## 本机实测（2026-10-19）

**① 副本情况**：`dsh-tools` 与 `dsh-agent-loop` 各有 **4 份**副本（全局安装 1 份 + profile `.pnpm` 3 份），
**sha256 完全相同**：

| 包 | sha256（前 16） | 副本数 |
| --- | --- | --- |
| `dsh-tools` | `40f47709337c3c20` | 4 |
| `dsh-agent-loop` | `00c4814d63f3d1e2` | 4 |

→ 内容一致，归一为同一份文件是**语义安全**的（只消除重复实例，不改变代码）。

**② 两个实例＝两个 Symbol（直接证明）**：分别 import 全局副本与 profile 副本，比较导出的 Symbol：

```
不带 shim：SAME INSTANCE (Symbol 相等) = false
带   shim：SAME INSTANCE (Symbol 相等) = true
```

**③ 运行时确实加载了 profile 副本**：以本 shim 起一个实例，启动日志出现 20+ 次

```
[dsh-tools-alias] 归一：…/.dsh/profiles/web/node_modules/.pnpm/@deepseek-ai+dsh-tools@…/lib/index.js
                  -> …/.npm-global/…/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js
```

即**双实例在真实进程里成立**，不是理论推测。

**④ 受控 A/B 已证明「修好了」**（2026-10-19，两实例同 profile、同代码路径、库隔离）：

| 组 | 开启 | 工具成功 | 工具失败 | 出错回合 |
| --- | --- | --- | --- | --- |
| A（修复） | scope shim + **tools shim**（`:3099`） | **20** | **0** | 无 |
| B（对照） | 仅 scope shim（`:3098`） | 0 | **3** | `reading 'prepare'` |

路径：`POST /api/projects` → `POST /api/projects/:id/sessions/rebind?confirm=1`（**插件**建会话 + 投递开局提示词）。
A 组会话里 agent 连续跑通 `taskboard_context` / `taskboard_list_tasks` / 多次 `bash`。

## 怎么用

已在 `tools/dsh-mvp-autostart.sh` 里**默认启用**（`TB_TOOLS_ALIAS=0` 关闭）：

```bash
bash tools/dsh-mvp-autostart.sh            # 默认带本 shim
TB_TOOLS_ALIAS=0 bash tools/dsh-mvp-autostart.sh   # 回退
```

手起隔离实例：

```bash
cd ${PROJ}
NODE_OPTIONS="--import $PWD/tools/dsh-tools-alias-shim/hook.mjs" dsh web --port 3099 --no-open
```

- `TB_TOOLS_CANON_ROOT` 可改归一目标（默认全局安装那份）。
- **不设 `NODE_OPTIONS` 即完全不生效**；不写盘、不修改任何已安装文件。

## 与 `tools/dsh-scope-alias-shim/` 的关系

| | `dsh-scope-alias-shim` | `dsh-tools-alias-shim`（本目录） |
| --- | --- | --- |
| 归一哪个包 | `@deepseek-ai/dsh-scope` | `@deepseek-ai/dsh-tools` + `@deepseek-ai/dsh-agent-loop` |
| 修什么症状 | 「新建会话 → Agent preset binding requires a scoped context」 | 「会话内工具调用被中断 → `reading 'prepare'`」 |
| 自启开关 | `TB_SCOPE_ALIAS`（默认开） | `TB_TOOLS_ALIAS`（默认开） |

两者可同时启用、互不冲突（都只是把重复副本改写到同一路径）。

## 边界（诚实写明）

- **已证（受控 A/B）**：双实例确实存在；归一后 Symbol 一致；shim 在真实进程里生效；
  **归一足以**让会话内工具调用从「100% 中断」变为「100% 成功」（A/B 见上表）。
- **仍未做**：正在使用的 `:3080` 还是旧配置（只开 scope shim），生效需重启一次
  `bash tools/dsh-mvp-autostart.sh`（重启会让 `?token=` 失效）。回退：`TB_TOOLS_ALIAS=0` 再重启。
- **踩坑**：验证时若想在别的实例上跑，必须用 `--patch`（或 `--data-dir`）改 `dataDir` ——
  只设 `TB_DATA_DIR` **无效**（插件配置里已有 `dataDir`，优先级 `ctx.config.dataDir > TB_DATA_DIR > 临时目录`），
  否则隔离实例会连上**真实看板库**。
