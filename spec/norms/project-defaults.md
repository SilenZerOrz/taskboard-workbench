---
norm_id: project-defaults
version: 1
updated: 2026-10-29
applies_to: ["*"]
---
# project-defaults · 项目可覆盖项（机器版）

## 只允许这 3 类覆盖（其余键一律 `NORM_OVERRIDE_FORBIDDEN`）

| 键 | 例 | 为什么允许 |
|---|---|---|
| `verifyCommand` | `mvn -q test` / `pytest -q` | 技术栈不同，这是**事实**不是标准 |
| `workspacePath` | `/path/to/repo` | 同上 |
| `notApplicable` | `["S4"]` + **必填理由** | 有些项目不派发团队；须写理由并落审计 |

## 禁止覆盖（硬拒）

- 八步的**顺序**；
- 四道门：人工校验 / 归因 / 授权 / 评审；
- `done` 只能由人置；
- 「回填必须带证据」。

## 项目自有规范怎么叠加

项目可以在 `<workspace>/AGENTS.md` 写**自己的约定**，加载顺序是：

```
spec/norms/*.md（随包，唯一真源） → <workspace>/AGENTS.md（只能追加/参数化）
```

- 追加的条目**不得**与上面的禁止项冲突；冲突即 `NORM_CONFLICT`（开发期红，不是运行期出事）。
- 加载块里固定带 `norm_notice`：告诉人「当前用的哪份规范、什么版本、怎么查看/替换」。
