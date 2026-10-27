/**
 * Web 服务契约测试（独立验证台，schemaVersion=2）。
 * 真实启动 `node src/server/server.mjs` + 随机端口 + 临时数据目录。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

async function start(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: { ...process.env, TB_DATA_DIR: dataDir, TB_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk.toString(); });
  child.stderr.on("data", (chunk) => { logs += chunk.toString(); });
  await waitForServer(baseUrl);
  return {
    baseUrl,
    child,
    logs: () => logs,
    async stop() {
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        child.once("exit", resolve);
        setTimeout(resolve, 2_000);
      });
    },
  };
}

async function json(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  return { status: response.status, payload, headers: response.headers };
}

test("静态页与 API：首页 HTML、meta、默认项目、owner 字段 CRUD 与持久化", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t24-server-"));
  let server = await start(dir);
  t.after(async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const page = await fetch(`${server.baseUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /Agent Team 任务工作台/);
  assert.match(html, /id="tb-app"/, "看板容器为 #tb-app（app.js 工厂在运行时构建看板）");
  assert.match(html, /src="\.\/app\.js"/);
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal((await fetch(`${server.baseUrl}/tokens.css`)).status, 200);
  assert.equal((await fetch(`${server.baseUrl}/app.js`)).status, 200);

  const meta = await json("GET", `${server.baseUrl}/api/meta`);
  assert.equal(meta.status, 200);
  assert.deepEqual(meta.payload.statuses, ["backlog", "todo", "in_progress", "in_review", "done", "blocked", "canceled"]);
  assert.deepEqual(meta.payload.priorities, ["none", "low", "medium", "high", "urgent"]);

  const projects = await json("GET", `${server.baseUrl}/api/projects`);
  assert.equal(projects.payload.count, 1);
  assert.equal(projects.payload.projects[0].id, "default");

  const created = await json("POST", `${server.baseUrl}/api/tasks`, {
    projectId: "default",
    title: "看板可用性验收",
    description: "**Markdown** 描述",
    status: "todo",
    priority: "high",
    owner: "tester",
    labels: ["验收", "MVP-A+"],
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.task.identifier, "default-1");
  assert.deepEqual(created.payload.task.labels, ["验收", "MVP-A+"]);
  assert.equal(created.payload.task.owner, "tester");
  assert.equal(created.payload.schemaVersion, 2);

  assert.equal((await json("GET", `${server.baseUrl}/api/tasks?project=default&status=todo`)).payload.count, 1);
  assert.equal((await json("GET", `${server.baseUrl}/api/tasks?status=done`)).payload.count, 0);
  assert.deepEqual((await json("GET", `${server.baseUrl}/api/tasks?owner=tester`)).payload.tasks.map((task) => task.identifier), ["default-1"]);
  assert.equal((await json("GET", `${server.baseUrl}/api/tasks?owner=engineer`)).payload.count, 0);

  const reassigned = await json("PATCH", `${server.baseUrl}/api/tasks/default-1`, { version: 1, owner: "engineer" });
  assert.equal(reassigned.status, 200);
  assert.equal(reassigned.payload.task.owner, "engineer");
  assert.equal(reassigned.payload.task.version, 2);
  assert.equal((await json("PATCH", `${server.baseUrl}/api/tasks/default-1`, { version: 2, owner: null })).payload.task.owner, null);

  const moved = await json("PATCH", `${server.baseUrl}/api/tasks/default-1`, { version: 3, status: "in_progress" });
  assert.equal(moved.status, 200);
  assert.equal(moved.payload.task.version, 4);

  const stale = await json("PATCH", `${server.baseUrl}/api/tasks/default-1`, { version: 1, status: "done" });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.error.code, "VERSION_CONFLICT");
  assert.equal(stale.payload.error.details.currentVersion, 4);

  const missing = await json("PATCH", `${server.baseUrl}/api/tasks/default-1`, { status: "done" });
  assert.equal(missing.status, 400);
  assert.equal(missing.payload.error.code, "MISSING_VERSION");

  const second = await json("POST", `${server.baseUrl}/api/tasks`, { projectId: "default", title: "待删除任务" });
  assert.equal(second.payload.task.identifier, "default-2");
  assert.equal((await json("DELETE", `${server.baseUrl}/api/tasks/default-2?version=1`)).status, 200);

  assert.equal((await json("GET", `${server.baseUrl}/api/nope`)).status, 404);
  assert.equal((await fetch(`${server.baseUrl}/..%2fpackage.json`)).status, 404);

  await server.stop();
  server = await start(dir);
  const after = await json("GET", `${server.baseUrl}/api/tasks?project=default`);
  assert.equal(after.payload.count, 1);
  assert.equal(after.payload.tasks[0].identifier, "default-1");
  assert.equal(after.payload.tasks[0].status, "in_progress");
  assert.equal(after.payload.tasks[0].version, 4);
  assert.equal(after.payload.tasks[0].owner, null);
  assert.equal((await json("GET", `${server.baseUrl}/api/projects`)).payload.count, 1);
  assert.match(server.logs(), /migration\(owner\)/);
});

test("示例数据脚本：owner 为字段，覆盖七状态与五角色", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t24-seed-"));
  const child = spawn(process.execPath, [path.join(ROOT, "tools", "seed.mjs")], {
    cwd: ROOT,
    env: { ...process.env, TB_DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk.toString(); });
  await new Promise((resolve) => child.once("exit", resolve));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const report = JSON.parse(out);
  assert.equal(report.ok, true);
  assert.ok(report.createdTasks.length >= 10);

  const server = await start(dir);
  t.after(() => server.stop());
  const tasks = await json("GET", `${server.baseUrl}/api/tasks`);
  assert.equal(new Set(tasks.payload.tasks.map((task) => task.status)).size, 7, "示例数据覆盖七状态");
  assert.deepEqual(
    [...new Set(tasks.payload.tasks.map((task) => task.owner).filter(Boolean))].sort(),
    ["archivist", "engineer", "planner", "reviewer", "tester"],
  );
  assert.equal(
    tasks.payload.tasks.some((task) => task.labels.some((label) => label.startsWith("owner:"))),
    false,
    "示例数据不得再产生 owner: 标签",
  );
  assert.ok((await json("GET", `${server.baseUrl}/api/tasks?owner=engineer`)).payload.count >= 2);
});
