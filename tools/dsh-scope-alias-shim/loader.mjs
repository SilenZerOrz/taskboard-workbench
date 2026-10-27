// 宿主 dsh-scope「归一为单实例」运行时 shim —— ESM 加载器（**非产品代码、不落盘改动**）
//
// 要证明/修复的问题（详见 docs/进度/2026-10-18-看板闭环收官与FR-85_86立项.md §三十六）：
//   `dsh web` 点「新建会话」报
//     Error: Agent preset binding requires a scoped context
//   根因不是「缺 scope」，而是 `@deepseek-ai/dsh-scope` 被**加载了两份**：
//   该包的作用域键是**模块级** `const kScope = Symbol("dsh.scope")`（lib/index.js:229），
//   `scopeOf(ctx) => ctx[kScope]`；同一份源码走两条路径 → 两个不同 Symbol →
//   A 实例写进 ctx 的 scope，B 实例的 scopeOf() 恒读为 undefined → throw。
//
// 本 shim 只在内存里把**所有** `@deepseek-ai/dsh-scope` 的解析结果改写到同一个目录，
// 让运行时只剩**一个模块实例**（= 一个 Symbol）。**不写盘、不修改任何已安装文件**。
//
// 用法：NODE_OPTIONS="--import <abs>/tools/dsh-scope-alias-shim/hook.mjs" dsh web --port 3099 --no-open
// 关闭：不设 NODE_OPTIONS 即完全不生效。
import fs from "node:fs";
import os from "node:os";

const PKG = "/node_modules/@deepseek-ai/dsh-scope/";
const DEFAULT_CANON =
  `${os.homedir()}/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-scope`;

const CANON = (process.env.TB_SCOPE_CANON || DEFAULT_CANON).replace(/\/+$/, "");
let reported = 0;

function rewrite(url) {
  const i = url.indexOf(PKG);
  if (i < 0) return null;
  const tail = url.slice(i + PKG.length); // e.g. lib/index.js
  const target = `file://${CANON}/${tail}`;
  if (url === target) return null; // 已是规范副本
  return target;
}

export async function resolve(specifier, context, nextResolve) {
  const r = await nextResolve(specifier, context);
  if (typeof r?.url === "string" && r.url.startsWith("file:")) {
    const t = rewrite(r.url);
    if (t) {
      reported++;
      if (reported <= 12) console.error(`[dsh-scope-alias] 归一：${r.url}\n                 -> ${t}`);
      return { ...r, url: t };
    }
  }
  return r;
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.includes(PKG)) {
    // 经过上面的 resolve 后仍走到这里的，说明已经是规范副本；直接读盘，避免重复请求。
    try {
      return {
        format: "module",
        shortCircuit: true,
        source: fs.readFileSync(new URL(url), "utf8"),
      };
    } catch {
      /* 落到 nextLoad */
    }
  }
  return nextLoad(url, context);
}
