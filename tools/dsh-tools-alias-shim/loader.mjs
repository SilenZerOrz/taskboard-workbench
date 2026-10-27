// 宿主「工具链单实例归一」运行时 shim —— ESM 加载器（**非产品代码、不写盘、不改任何已安装文件**）
//
// 要证明/修复的问题（详见 docs/进度/2026-10-19-主会话工具被宿主中断.md）：
//   会话内的**工具调用 100% 失败**，宿主异常：
//     Cannot read properties of undefined (reading 'prepare')
//   抛出点：@deepseek-ai/dsh-agent-loop/lib/index.js:582
//     const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
//   其中 TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler")
//   （dsh-tools/lib/index.js:2526，由 ToolRuntime 类字段提供）。
//
// 报错文案是「reading 'prepare'」而不是「reading 'Symbol(...)'」→ ctx.tools **存在**，
// 但该 **Symbol 键**取不到值。而 Symbol 是**模块实例内唯一**的：
// 同一份源码被两条路径加载 → 两个模块实例 → 两个不同 Symbol →
// 「谁提供 ToolRuntime」与「谁在 agent loop 里查 Symbol」一旦落在不同实例上，查询必然落空。
//
// 本机实测（2026-10-19）：三份 profile `.pnpm` 副本与全局安装副本 **sha256 完全相同**
//   dsh-tools       40f47709337c3c20  ×4 处（全局 1 + profile 3）
//   dsh-agent-loop  00c4814d63f3d1e2  ×4 处（全局 1 + profile 3）
//   → 内容一致，归一为同一份文件是**语义安全**的（只消除重复实例，不改变代码）。
//
// 用法：
//   NODE_OPTIONS="--import <abs>/tools/dsh-tools-alias-shim/hook.mjs" dsh web --port 3099 --no-open
// 关闭：不设 NODE_OPTIONS 即完全不生效。
import fs from "node:fs";
import os from "node:os";

const CANON_ROOT = (
  process.env.TB_TOOLS_CANON_ROOT ||
  `${os.homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`
).replace(/\/+$/, "");

// 只归一两包；`dsh-scope` 由既有 tools/dsh-scope-alias-shim 负责（两者可同时启用、互不冲突）。
const PKGS = ["@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-agent-loop"];

let reported = 0;
const counts = Object.create(null);

function rewrite(url) {
  for (const pkg of PKGS) {
    const marker = `/node_modules/${pkg}/`;
    const i = url.indexOf(marker);
    if (i < 0) continue;
    const tail = url.slice(i + marker.length); // e.g. lib/index.js
    const target = `file://${CANON_ROOT}/${pkg.replace("@deepseek-ai/", "")}/${tail}`;
    if (url === target) return null; // 已是规范副本
    counts[pkg] = (counts[pkg] ?? 0) + 1;
    return target;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (typeof r?.url === "string" && r.url.startsWith("file:")) {
    const t = rewrite(r.url);
    if (t) {
      reported++;
      if (reported <= 20) console.error(`[dsh-tools-alias] 归一：${r.url}\n                  -> ${t}`);
      return { ...r, url: t };
    }
  }
  return r;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && PKGS.some((pkg) => url.includes(`/node_modules/${pkg}/`))) {
    // 经 resolve 后仍到这里 = 已是规范副本；直接读盘，避免重复请求。
    try {
      return { format: "module", shortCircuit: true, source: fs.readFileSync(new URL(url), "utf8") };
    } catch {
      /* 落到 nextLoad */
    }
  }
  return nextLoad(url, context);
}
