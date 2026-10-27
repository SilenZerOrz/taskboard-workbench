// 宿主 registry「scoped-context 绕过」运行时 shim —— ESM 加载器
//
// 背景（非本仓库缺陷）：`dsh web` 实际加载的全局副本
//   ~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/
//     @deepseek-ai/dsh-agent-preset-registry/lib/index.js
// 在 `bind(ctx, generation)` 里遇到无作用域的 ctx 会直接 throw
//   "Agent preset binding requires a scoped context"
// → 宿主「新会话」按钮报错，连 `initial Session restoration failed` 也是它。
// profile 侧的另一份副本早已带 2026-10-08 的同类补丁（`if (key === void 0) return;`）。
//
// 本 shim 的行为：**只在内存里**把那一行 throw 换成 return，**不落盘、不修改任何已安装文件**。
// 语义与 profile 副本的既有补丁一致：无作用域时跳过 preset 绑定，会话仍能创建
// （代价：该会话不按 preset 做作用域隔离，上游未修）。
import fs from "node:fs";

const MATCH = "dsh-agent-preset-registry/lib/index.js";
const FROM = 'if (key === void 0) throw new Error("Agent preset binding requires a scoped context");';
const TO = "if (key === void 0) return; // dsh-registry-shim (runtime, in-memory; same semantics as the 2026-10-08 profile-copy patch)";

export async function load(url, context, nextLoad) {
  if (url.includes(MATCH)) {
    const src = fs.readFileSync(new URL(url), "utf8");
    if (src.includes(FROM)) {
      console.error(`[dsh-registry-shim] 内存内改写：${url}`);
      return { format: "module", shortCircuit: true, source: src.replace(FROM, TO) };
    }
    if (src.includes(TO)) console.error(`[dsh-registry-shim] 已是补丁版，放行：${url}`);
    else console.error(`[dsh-registry-shim] 未命中目标行，放行（上游可能已修）：${url}`);
  }
  return nextLoad(url, context);
}
