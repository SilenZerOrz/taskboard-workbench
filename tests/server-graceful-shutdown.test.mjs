/**
 * P1-4 守卫：优雅重启必须**真的退出**（2026-10-29 实修 + 实证）。
 *
 * 事故链：前端 `web/app.js` 常开 `new EventSource('/api/events')`（SSE 长连接，20s 心跳、永不自然结束），
 * 而 Node 的 `server.close(cb)` 只停止接受新连接、**要等既有连接全部结束才回调** ⇒
 * 只要有一个页面开着，回调永不触发 ⇒ `process.exit(0)` 永远不执行 ⇒ SIGTERM 之后进程挂着不退，
 * 继续持有 `.data/taskboard.sqlite`，下一个实例起来就形成**同库双写者**，再下次重启还要撞 EADDRINUSE。
 *
 * 真机证据：孤儿 `52278`（2026-10-28 重启残留）与 `41116`（2026-10-29 重启残留）—— 两者都是
 * `STAT=S`（活，非僵尸）、不监听端口、仍持有 SQLite。不是两次偶发，是每次优雅重启的必然尾巴。
 *
 * 本文件三层判据：
 *   A 行为（挂 SSE）：SIGTERM ⇒ 退出码 0 且耗时远小于兜底 3s（证明是 closeAllConnections 起效，不是靠兜底）
 *   B 行为（无连接）：SIGTERM ⇒ 退出码 0（反向对照：修复不得把正常路径搞坏）
 *   C 源码守卫：close() 必须同时具备 closeAllConnections 与 3s 兜底 exit（防有人删掉其中一半）
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = path.join(ROOT, "src", "server", "server.mjs");

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitForServer(baseUrl, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return true;
    } catch {
      /* not ready */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function boot(t) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "tb-shutdown-"));
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, TB_DATA_DIR: dataDir, TB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  t.after(() => {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dataDir, { recursive: true, force: true });
  });
  await waitForServer(`http://127.0.0.1:${port}`);
  return { child, port, logs: () => logs };
}

async function termAndWait(child, budgetMs) {
  const startedAt = Date.now();
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    setTimeout(() => resolve(null), budgetMs);
  });
  child.kill("SIGTERM");
  const result = await exited;
  return { result, elapsedMs: Date.now() - startedAt };
}

test("P1-4 A：挂着 SSE 长连接时，SIGTERM 仍必须真的退出（不留孤儿）", { timeout: 40_000 }, async (t) => {
  const { child, port } = await boot(t);

  // 模拟浏览器的 EventSource：一条永不主动结束的 SSE 连接
  const sse = net.connect(port, "127.0.0.1");
  t.after(() => { try { sse.destroy(); } catch { /* ignore */ } });
  sse.write("GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n");
  await new Promise((resolve, reject) => {
    sse.once("data", resolve);
    sse.once("error", reject);
    setTimeout(() => reject(new Error("SSE 未在 5s 内建立")), 5_000);
  });

  const { result, elapsedMs } = await termAndWait(child, 15_000);
  assert.notEqual(result, null, "SIGTERM 之后进程仍未退出 —— 又留了一个孤儿（P1-4 回归）");
  assert.equal(result.signal, null, `期望正常退出，实际被信号 ${result.signal} 杀死`);
  assert.equal(result.code, 0, `期望退出码 0，实际 ${result.code}`);
  // 关键：快 ⇒ 说明是 closeAllConnections 立即断开起效，而不是靠 3s 兜底蒙过去
  assert.ok(elapsedMs < 2_500, `退出耗时 ${elapsedMs}ms，接近/超过 3s 兜底 ⇒ closeAllConnections 可能没生效`);
});

test("P1-4 B（反向对照）：没有任何长连接时，SIGTERM 同样退出码 0（修复不得破坏正常路径）", { timeout: 40_000 }, async (t) => {
  const { child } = await boot(t);
  const { result, elapsedMs } = await termAndWait(child, 15_000);
  assert.notEqual(result, null, "无连接场景下 SIGTERM 后进程未退出");
  assert.equal(result.code, 0, `期望退出码 0，实际 ${result.code}`);
  assert.ok(elapsedMs < 2_500, `无连接场景退出耗时 ${elapsedMs}ms 过长`);
});

test("P1-4 C（源码守卫）：close() 必须同时有 closeAllConnections 与 3s 兜底 exit", () => {
  const source = readFileSync(SERVER, "utf8");
  const closeStart = source.indexOf("const close = () => {");
  assert.ok(closeStart > 0, "找不到 close() 定义");
  const closeBlock = source.slice(closeStart, closeStart + 1_600);
  assert.ok(
    /closeAllConnections\?\.\(\)/.test(closeBlock),
    "close() 里缺少 server.closeAllConnections?.() —— SSE 会让 server.close 的回调永不触发",
  );
  assert.ok(
    /setTimeout\(\(\) => \{[\s\S]*?process\.exit\(0\);[\s\S]*?\}, 3000\)/.test(closeBlock),
    "close() 里缺少 3s 兜底 process.exit(0) —— 平台不给 closeAllConnections 时会重新留孤儿",
  );
});
