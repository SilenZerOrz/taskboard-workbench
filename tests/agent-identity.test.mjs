/**
 * FR-108（0-B-b · 卡 `-239`）：`agents` 进程级本地身份。
 *
 * 三条口径（都容易"看起来做了"）：
 *   ① `--agent-id` 缺省 ⇒ **生成匿名 id 并落盘**（不是只在内存里编一个）；
 *   ② 同 id 重启 ⇒ **复用已有行**（不新建、不换 id）；
 *   ③ 新写入的 `task_evidence.actor` **必须是 `agents.id`**；
 * 外加一条反向约束：`--read-only` 是**零写入**开关 —— 它不得为了登记身份偷偷写一行 `agents`。
 *
 * 边界（本文件刻意不测，因为条款明说"不宣称鉴权生效"）：令牌换身份、`token_hash` 校验、
 * 存量 `task_evidence.actor` 迁移。这些属于 S3 / 阶段 1b，现在测等于把未实现的承诺钉成"已实现"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function tempDir() { return mkdtempSync(join(tmpdir(), "tb-agent-id-")); }

test("A 缺省 id ⇒ 生成匿名 id 并落盘（kind=agent）", () => {
  const dir = tempDir();
  const store = openStore({ dataDir: dir });
  const agent = store.registerAgent({ displayName: "codex" });
  assert.match(agent.id, /^anon-[0-9a-f-]{36}$/, `匿名 id 形状不对：${agent.id}`);
  assert.equal(agent.kind, "agent");
  assert.equal(agent.created, true);
  assert.equal(store.listAgents().length, 1, "必须真落盘（不是只在内存里）");
  assert.equal(agent.hasTokenHash, false, "token_hash 只建表留接口，登记时不该有值");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("B 同 --agent-id 再登记 ⇒ 复用已有行（不新建、不换 id）", () => {
  const dir = tempDir();
  const store = openStore({ dataDir: dir });
  const first = store.registerAgent({ id: "codex", displayName: "codex" });
  const second = store.registerAgent({ id: "codex", displayName: "另一个名字" });
  assert.equal(first.created, true);
  assert.equal(second.created, false, "第二次必须复用");
  assert.equal(second.id, "codex");
  assert.equal(second.displayName, "codex", "已登记的名字不得被重启参数覆盖（否则历史身份会被改写）");
  assert.equal(store.listAgents().length, 1);
  store.close();

  // 跨进程重启（同一个 dataDir 重新 open）也必须复用同一行
  const reopened = openStore({ dataDir: dir });
  const third = reopened.registerAgent({ id: "codex" });
  assert.equal(third.created, false);
  assert.equal(reopened.listAgents().length, 1);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("C 新写入 task_evidence.actor = agents.id（不是自由文本）", () => {
  const dir = tempDir();
  const store = openStore({ dataDir: dir });
  const agent = store.registerAgent({ id: "codex" });
  store.createProject({ id: "p1", name: "P1" });
  const task = store.createTask({ projectId: "p1", title: "身份验收", status: "in_progress" });
  const ev = store.addTaskEvidence(task.identifier, {
    verdict: "写一条", deviation: "无", boundary: "无", artifacts: ["cmd"],
    actor: agent.id,
  });
  assert.equal(ev.actor, "codex", "actor 必须落 agent id");
  assert.ok(store.getAgent(ev.actor), "actor 必须能在 agents 表里查到");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("D --read-only 是零写入：不得为登记身份偷写一行 agents", async () => {
  const dir = tempDir();
  const child = spawn(process.execPath, [join(ROOT, "src/mcp/server.mjs"), "--read-only", "--data-dir", dir], {
    cwd: ROOT, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP 10s 未就绪；stderr=${stderr.slice(0, 400)}`)), 10000);
    child.stderr.on("data", (b) => {
      stderr += String(b);
      if (stderr.includes("[tb-mcp] ready")) { clearTimeout(timer); resolve(); }
    });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`MCP 提前退出 code=${code}；stderr=${stderr.slice(0, 400)}`)); });
  });
  child.kill();
  await new Promise((r) => child.on("exit", r));
  const store = openStore({ dataDir: dir });
  assert.equal(store.listAgents().length, 0, "--read-only 不得写 agents（只读 = 零写入，含身份登记）");
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
