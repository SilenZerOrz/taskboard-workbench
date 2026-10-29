/**
 * P4 · `taskboard-flow` 技能守卫（2026-10-29）
 *
 * 判据（方案 §5.4 / §5.2）：
 *   A frontmatter 齐全（`name` / `version` / `updated` / `applies_to` / `requires_contract`）
 *   B 八步一步不缺：S0…S7 全在；表头含**六栏**（入口 / 前置门 / 判据 / 证据落点 / 失败处置 / 对应 FR）；
 *     每行这六栏**都非空**（空一格＝这一步没写完）
 *   C 每步「入口」里点名的工具**必须真实存在**于 `src/mcp/tools.mjs`；反向：注册表里的 9 个工具
 *     **每一个都必须在 skill 里被提到**（防"加了工具没人知道"）
 *   D `requires_contract` 与当前契约材料主版本一致（`v1`）—— 哈希版本没法比大小，只能比主版本
 *   E **档 A / 档 B 同源**：`buildFlowBlock()`（进程内）=== MCP prompt `taskboard.flow`（真子进程）
 *     === `node scripts/tb-flow.mjs start`（真子进程），三者**逐字节相同**
 *   F 真跑一遍 S0→S2：`flow_start` ⇒ `requirement_upsert` ⇒ `card_create`，下一步建议随之推进到 S3
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { CONTRACT_VERSION_PREFIX } from "../src/core/contract.mjs";
import { openStore } from "../src/core/store.mjs";
import { buildFlowBlock, readSkill } from "../src/mcp/flow-block.mjs";
import { TOOL_NAMES } from "../src/mcp/tools.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIR = path.join(ROOT, "skills", "taskboard-flow");
const MCP = path.join(ROOT, "src", "mcp", "server.mjs");
const CLI = path.join(ROOT, "scripts", "tb-flow.mjs");

const SKILL = readSkill();
const STEP_ROWS = SKILL.steps.split("\n").filter((l) => l.startsWith("| **S"));
const HEADER = SKILL.steps.split("\n").find((l) => l.startsWith("| # |")) ?? "";

/** 把 markdown 表格行切成单元格（去掉首尾空段）。 */
const cells = (line) => line.split("|").slice(1, -1).map((c) => c.trim());
const COLUMNS = ["入口", "前置门", "判据", "证据落点", "失败处置", "对应 FR"];

/* ---------------- A ---------------- */
test("P4/A frontmatter 齐全", () => {
  for (const key of ["name", "version", "updated", "applies_to", "requires_contract"]) {
    assert.ok(SKILL.meta[key] !== undefined && SKILL.meta[key] !== "", `SKILL.md frontmatter 缺 ${key}`);
  }
  assert.equal(SKILL.meta.name, "taskboard-flow");
  assert.ok(Number.isInteger(SKILL.meta.version) && SKILL.meta.version >= 1, "version 必须是 ≥1 的整数");
  assert.ok(Array.isArray(SKILL.meta.applies_to) && SKILL.meta.applies_to.length >= 2, "applies_to 要列清适用对象");
});

/* ---------------- B ---------------- */
test("P4/B 八步一步不缺 · 六栏齐全 · 每格非空", () => {
  assert.equal(STEP_ROWS.length, 8, `应有 8 步，实际 ${STEP_ROWS.length}`);
  const steps = STEP_ROWS.map((row) => cells(row)[0].replace(/\*/g, ""));
  assert.deepEqual(steps, ["S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7"], "步骤编号必须连续且不缺");

  const headerCells = cells(HEADER);
  const idx = {};
  for (const col of COLUMNS) {
    const i = headerCells.indexOf(col);
    assert.ok(i >= 0, `表头缺「${col}」栏（实际：${headerCells.join(" / ")}）`);
    idx[col] = i;
  }
  for (const row of STEP_ROWS) {
    const c = cells(row);
    assert.equal(c.length, headerCells.length, `行单元格数与表头不一致：${row.slice(0, 40)}`);
    for (const col of COLUMNS) {
      assert.ok(c[idx[col]] && c[idx[col]] !== "", `${c[0]} 的「${col}」是空的 —— 这一步没写完`);
    }
  }
});

/* ---------------- C ---------------- */
test("P4/C 入口点名的工具真实存在 + 9 个工具逐个被提到", () => {
  const headerCells = cells(HEADER);
  const entryIdx = headerCells.indexOf("入口");
  assert.ok(entryIdx >= 0);

  const claimed = new Set();
  for (const row of STEP_ROWS) {
    const entry = cells(row)[entryIdx] ?? "";
    for (const m of entry.matchAll(/`([^`]+)`/g)) {
      const token = m[1].trim();
      if (/^[a-z][a-z0-9_]*$/.test(token)) claimed.add(token);
    }
  }
  assert.ok(claimed.size >= 4, `入口里只认出 ${claimed.size} 个工具名 —— 解析或写法有问题`);
  for (const name of claimed) {
    assert.ok(TOOL_NAMES.includes(name), `SKILL.md 的「入口」提到 \`${name}\`，但它不在 MCP 注册表里（已注册：${TOOL_NAMES.join(", ")}）`);
  }

  // 反向：注册表里的工具必须都能在 skill 里找到 —— 否则 agent 根本不知道有它
  const dirText = [
    readFileSync(SKILL.path, "utf8"),
    ...readdirSync(path.join(SKILL_DIR, "references"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(path.join(SKILL_DIR, "references", f), "utf8")),
    ...readdirSync(path.join(SKILL_DIR, "references", "steps"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => readFileSync(path.join(SKILL_DIR, "references", "steps", f), "utf8")),
  ].join("\n");
  for (const name of TOOL_NAMES) {
    assert.ok(dirText.includes(name), `MCP 注册了 \`${name}\`，但 skill 目录里一次都没提到它`);
  }
});

/* ---------------- D ---------------- */
test("P4/D requires_contract 与当前契约材料主版本一致", () => {
  // `contract_version` 是 `v1-<12位hash>`：hash 无法比大小，能比的只有材料主版本。
  const major = CONTRACT_VERSION_PREFIX.replace(/-$/, "");
  assert.equal(SKILL.meta.requires_contract, major,
    `skill 声明 requires_contract=${SKILL.meta.requires_contract}，当前契约材料是 ${major} —— 主版本变了必须人工复核 skill`);
});

/* ---------------- E ---------------- */
function seedDir(dir) {
  mkdirSync(path.join(dir, "ws"), { recursive: true });
  writeFileSync(path.join(dir, "ws", "AGENTS.md"), "# 项目补充\n");
  const store = openStore({ dataDir: dir });
  store.createProject({ id: "p1", name: "P1 演示", workspacePath: path.join(dir, "ws") });
  store.ensureRequirementDoc("p1", { body: "# 需求 v1\n" });
  store.close();
}

test("P4/E 档 A / 档 B 同源：进程内 === MCP prompt === CLI，逐字节相同", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-skill-"));
  seedDir(dir);
  const store = openStore({ dataDir: dir });
  let inProcess;
  try { inProcess = buildFlowBlock({ store, project: "p1" }).text; } finally { store.close(); }

  const cli = spawnSync(process.execPath, [CLI, "start", "--project", "p1", "--data-dir", dir], { encoding: "utf8" });
  assert.equal(cli.status, 0, `tb-flow 退出码 ${cli.status}：${cli.stderr}`);
  assert.equal(cli.stdout, inProcess, "CLI 的装载块必须与进程内生成器逐字节相同（否则就是两份说明书）");

  const child = spawn(process.execPath, [MCP, "--data-dir", dir], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`rpc timeout: ${method}`)); }, 15000);
  });
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });
    assert.ok(init.result.capabilities.prompts, "initialize 必须声明 prompts 能力");
    const list = await rpc("prompts/list", {});
    assert.deepEqual(list.result.prompts.map((p) => p.name), ["taskboard.flow"]);

    const got = await rpc("prompts/get", { name: "taskboard.flow", arguments: { project: "p1" } });
    const text = got.result.messages[0].content.text;
    assert.equal(text, inProcess, "MCP prompt 的装载块必须与进程内生成器逐字节相同");
    assert.match(text, /## 5\. 八步/, "装载块必须含八步全文");
    assert.match(text, /S7/, "八步要到最后一步");

    const bad = await rpc("prompts/get", { name: "nope" });
    assert.equal(bad.error.code, -32602, "未知 prompt 属协议层错误");
  } finally {
    try { child.stdin.end(); } catch { /* 已关 */ }
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------------- F ---------------- */
test("P4/F 真跑 S0→S2：flow_start ⇒ requirement_upsert ⇒ card_create，下一步推进到 S3", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-skill-run-"));
  seedDir(dir);
  const child = spawn(process.execPath, [MCP, "--data-dir", dir], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, res);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    setTimeout(() => { if (pending.delete(id)) rej(new Error(`rpc timeout: ${method}`)); }, 15000);
  });
  const call = async (name, args) => {
    const m = await rpc("tools/call", { name, arguments: args });
    return { isError: Boolean(m.result?.isError), v: JSON.parse(m.result.content[0].text) };
  };
  try {
    await rpc("initialize", { protocolVersion: "2025-06-18", clientInfo: { name: "t", version: "0" } });

    // S0：没有条目 ⇒ 建议 S1
    const s0 = await call("flow_start", { project: "p1" });
    assert.equal(s0.v.nextStep.step, "S1", "没有需求条目时应先做 S1");
    assert.equal(s0.v.gaps.unattributedTasks, 0);

    // S1：录一条需求
    const item = await call("requirement_upsert", { project: "p1", title: "需求一：跑通闭环", acceptance: "npm test 全绿" });
    assert.equal(item.isError, false);
    assert.equal(item.v.created, true);

    // S2：拆一张卡（带归因 + 验收 + 复核动作）
    const card = await call("card_create", {
      project: "p1", title: "跑通一次闭环", requirement: item.v.item.identifier,
      acceptance: "npm test 全绿", verifyCommand: "npm test",
    });
    assert.equal(card.isError, false, JSON.stringify(card.v));
    assert.equal(card.v.attribution.kind, "requirement");
    assert.equal(card.v.card.status, "backlog");

    // 回到 S0 的视角：缺口清零，下一步推进到 S3（等人授权）
    const again = await call("flow_start", { project: "p1" });
    assert.equal(again.v.gaps.unattributedTasks, 0, "建卡即归因 ⇒ 不该有未归因卡");
    assert.equal(again.v.gaps.requirementsWithoutTasks, 0, "条目已经有卡了");
    assert.equal(again.v.state.tasks, 1);
    assert.equal(again.v.nextStep.step, "S3", `建完卡应等人授权（S3），实际 ${again.v.nextStep.step}`);
    assert.equal(again.v.nextStep.humanAction, "authorize", "S3 必须标出「要人做」");
  } finally {
    try { child.stdin.end(); } catch { /* 已关 */ }
    try { child.kill("SIGKILL"); } catch { /* 已退出 */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
