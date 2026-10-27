# dsh-scope-alias-shim（宿主 dsh-scope「单实例归一」验证工具）

**非产品代码**。用途：验证「把两份 `@deepseek-ai/dsh-scope` 归一到同一份文件」能否修好宿主「新建会话」报错
`Error: Agent preset binding requires a scoped context`。

## 为什么这能修

`@deepseek-ai/dsh-scope` 的作用域键是**模块级**常量：

```js
const kScope = Symbol("dsh.scope");   // lib/index.js:229
function scopeOf(ctx) { return ctx[kScope]; }
```

同一份源码被**两条路径**加载 → 两个模块实例 → **两个不同的 Symbol** → A 实例写进 ctx 的 scope，
B 实例的 `scopeOf()` 读出来必然是 `undefined` → `bind()` 抛错。

两份文件实测 **sha256 完全相同**（`2829df71…`），所以归一是**语义安全**的。

## 怎么用

```bash
cd ${PROJ}
NODE_OPTIONS="--import $PWD/tools/dsh-scope-alias-shim/hook.mjs" dsh web --port 3099 --no-open
```

- 日志里出现 `[dsh-scope-alias] 归一：…` 即为生效证据。
- 用 `TB_SCOPE_CANON=<dir>` 指定归一目标（默认全局安装里的那份）。
- **不设 `NODE_OPTIONS` 即完全不生效**；不写盘、不修改任何已安装文件。

## 与 `tools/dsh-registry-shim/` 的区别

| | `dsh-registry-shim` | `dsh-scope-alias-shim`（本目录） |
| --- | --- | --- |
| 改什么 | 把 `bind()` 里那句 `throw` 换成 `return` | 把两份 `dsh-scope` 归一成一份 |
| 性质 | **压掉异常**（治标） | **消除根因**（治本） |
| 实测结果 | 原错误消失，但冒出 `prompt section "context:file-reference" is already registered`，会话仍建不出来 | 见下方「实测结论」 |

## 实测结论

**2026-10-18 隔离实例实测：修好了。**

做法（**完全不打扰正在使用的 3080 实例**）：另起一个实例

```bash
cd ${PROJ}
NODE_OPTIONS="--import $PWD/tools/dsh-scope-alias-shim/hook.mjs" dsh web --port 3099 --no-open
```

然后在内置浏览器打开 `http://127.0.0.1:3099/?token=…`，点「新建会话」。

| 实例 | shim | 点「新建会话」的结果 |
| --- | --- | --- |
| `:3080`（用户正在使用） | 无 | toast：`新建会话失败：gateway/internal: failed to create session "session-f7c591dd…": Error: Agent preset binding requires a scoped context` |
| `:3099`（隔离） | **本 shim** | **无任何错误提示**；界面正常进入新会话；且**真的落盘了会话**（`~/.dsh/storages/session_projcache/sessions/session-ab4411c2-….json` 新增） |

日志证据（`:3099` 启动日志原文，共 **7** 次归一）：

```
[dsh-scope-alias] 归一：file://$HOME/.dsh/profiles/web/node_modules/.pnpm/@deepseek-ai+dsh-scope@0.2.0-rc.2_@deepseek-ai+cordis@4.0.5-alpha.1_…/node_modules/@deepseek-ai/dsh-scope/lib/index.js
                 -> file://$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-scope/lib/index.js
```

这行日志同时**实证**了运行时确实加载了 profile 的 `.pnpm` 副本，而宿主 registry 用的是全局副本 —— 双实例成立。

`:3099` 日志中无 `scoped context`、无 `failed to create session`、无 `initial Session restoration failed`
（唯一一条 `failed to import` 是 `dsh-supervisor` 的既有告警，`:3080` 上同样存在，与本问题无关）。

验证完成后，隔离实例已 `kill`，`:3080` 全程未受影响。

## 现状：已接入自启脚本（默认开）

`tools/dsh-mvp-autostart.sh` 已接入本 shim，**默认开启**：

```bash
bash tools/dsh-mvp-autostart.sh              # 默认带 shim
TB_SCOPE_ALIAS=0 bash tools/dsh-mvp-autostart.sh   # 关闭 shim
```

这只是**运行期**修复（不改任何已安装文件）。若要做**持久**修复，方向是让 profile 与全局只解析到同一份
`dsh-scope`（见 `docs/进度/2026-10-18-看板闭环收官与FR-85_86立项.md` §三十七）。
