/**
 * 回归守卫：`tools/bench-cli-chain.mjs` 的 HTTP 客户端**不得退回裸 `fetch`**。
 *
 * 来由（2026-10-26 真跑发现）：本台 B 部分会**同步等一次真跑 claude**，而 `TB_BENCH_REAL_TIMEOUT_MS`
 * 默认 600000（文档还写着真实任务可达 14 分钟）。裸 `fetch` 走 undici，其 `headersTimeout` 默认 **300s**
 * ⇒ 只要那次真跑超过 5 分钟，**台子自己先断**（`HeadersTimeoutError`），没有判定、没有清理，
 * 还会被误读成「产品链路故障」。
 *
 * 本用例只做**源码级**断言（不真跑 claude，秒级、无副作用）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = await readFile(path.join(ROOT, "tools", "bench-cli-chain.mjs"), "utf8");

test("bench-cli-chain：HTTP 客户端用 node:http，不用裸 fetch", () => {
  assert.match(src, /import http from "node:http";/);
  assert.match(src, /http\.request\(/);
  assert.ok(!/await fetch\(/.test(src), "不得退回裸 fetch：undici 默认 300s headersTimeout 会掐断真跑 claude");
});

test("bench-cli-chain：关闭请求空闲超时，等待时长只由产品 timeoutMs 决定", () => {
  assert.match(src, /req\.setTimeout\(0\)/);
});
