---
norm_id: acceptance
version: 2
updated: 2026-10-29
applies_to: ["*"]
---
# acceptance · 验收口径（机器版）

## 三层判据

| 层 | 命令 | 通过线 |
|---|---|---|
| 单测 | `npm test` | **全绿**（0 fail），条数只增不减 |
| 语法 | `node --check`（全量 `.mjs`/`.js`） | 0 fail |
| 隔离验证台 | `node tools/bench-<name>.mjs` | 断言全 PASS；浏览器类须**沙箱外**跑（沙箱内 `SKIP` 退出码 2） |

> 浏览器类正路：`bash ~/.codex/skills/codex-local-env-fix/scripts/chrome-outside.sh -- node tools/bench-<name>.mjs`
> （沙箱里 spawn Chrome 必崩，与参数/内核/版本无关 —— 见全局 AGENTS §7）

## 反向对照（防止「测试跟着实现改」）

每条守卫断言都要有**反证入口**：注入旧口径/坏实现 ⇒ 断言必须转红。
只证明「现在绿」不算验收，要证明「坏了会红」。

## 证据是否合格

- ✅ `命令 + 输出摘要 + 时间`，例如 `npm test → 866/866 PASS`。
- ✅ `文件路径 + 行号`，改动点能落到具体位置。
- ❌ 「已修复」「跑通了」「应该没问题」。
- ❌ 只有截图没有读数（截图证明「长这样」，不证明「逻辑对」）。

## 不允许的验收方式

- 用 `--force` / `-y` 跳过确认。
- 改测试来让红变绿（除非口径变更并已人工拍板）。
- 把沙箱内的浏览器失败当产品缺陷（先判 `CODEX_SANDBOX`）。
