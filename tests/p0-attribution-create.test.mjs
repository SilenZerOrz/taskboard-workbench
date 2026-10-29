/**
 * P0 · 建卡即归因（同事务）+ 逃生口 + 可见警告（2026-10-28 拍板 D1）
 *
 * 背景：`store.createTask` 入参**从来没有** `requirementId`，`insert into tasks` 也不写
 * `requirement_id` —— 于是「建卡」这条路根本没法归因，只能事后补 `POST /attribution`。
 * 2026-10-28 一次全量修补 **69 张**无归因卡，其中 taskboard 侧 60 张里 **56 张真实来源已不可考**，
 * 只能挂兜底条目 `R124`（假归因比空归因更坏：门失去信号价值 + 污染条目完成度）。
 *
 * 本测试钉住 P0 的六条判据：
 *   A 带 requirement ⇒ 同一事务写入 `requirement_id` + 事件 `attributed`
 *   B 不带 ⇒ 照样建卡，但**可见**（事件 `attribution_missing` + API 返回 `attribution.warning`）
 *   C 显式 `unattributedReason` ⇒ 走逃生口（事件 `attribution_skipped`，无警告）
 *   D `requirement` 与 `unattributedReason` 同给 ⇒ `USAGE_ERROR`（形状歧义必须报错，不得静默取一）
 *   E **跨项目 / 条目不存在 ⇒ 整笔回滚：零孤儿卡、编号不消耗**（这是旧 `taskboard_create_task` 的真实缺陷）
 *   F `TB_STRICT_ATTRIBUTION=1` ⇒ 未归因被拒 `REQUIREMENT_REQUIRED`，且零副作用
 *   G CLI：`task create --requirement` 落库；`task attribution` 能补；缺归因时 **stderr 有警告且 stdout 仍是合法 JSON**
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "cli", "tb.mjs");

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `p0-attr-${label}-`));

function seed(store) {
  store.createProject({ id: "p1", name: "P1" });
  store.createProject({ id: "p2", name: "P2" });
  const doc = store.ensureRequirementDoc("p1", { body: "# 需求\n" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目 A", docId: doc.id, status: "open" });
  return { item };
}

const eventTypes = (store, taskId) => (store.listTaskEvents(taskId) ?? []).map((e) => e.type);

/* ---------------- A ---------------- */
test("P0/A 带 requirement ⇒ 同事务写入 requirement_id，并记 attributed 事件", () => {
  const dir = freshDir("a");
  const store = openStore({ dataDir: dir });
  try {
    const { item } = seed(store);
    const task = store.createTask({ projectId: "p1", title: "带归因的卡", requirementId: item.id });
    assert.equal(task.requirementId, item.id);
    // 别名 `requirement` 也要认（HTTP 侧两者都收）
    const task2 = store.createTask({ projectId: "p1", title: "用别名", requirement: item.identifier });
    assert.equal(task2.requirementId, item.id);
    assert.ok(eventTypes(store, task.id).includes("attributed"), `事件应含 attributed，实得 ${eventTypes(store, task.id)}`);
    assert.equal(store.listTasks({ projectId: "p1" }).filter((t) => !t.requirementId).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- B ---------------- */
test("P0/B 不带归因 ⇒ 仍然建卡，但必须留下 attribution_missing 事件（不许静默）", () => {
  const dir = freshDir("b");
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "p1", name: "P1" });
    const task = store.createTask({ projectId: "p1", title: "漏填归因", requirementId: null, unattributedReason: null });
    assert.equal(task.requirementId, null);
    assert.ok(eventTypes(store, task.id).includes("attribution_missing"), `事件应含 attribution_missing，实得 ${eventTypes(store, task.id)}`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- C ---------------- */
test("P0/C 显式 unattributedReason ⇒ 走逃生口（attribution_skipped），不再报 missing", () => {
  const dir = freshDir("c");
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "p1", name: "P1" });
    const task = store.createTask({ projectId: "p1", title: "历史批次归档卡", unattributedReason: "2026-10 前的终态卡，条目化之前就存在" });
    assert.equal(task.requirementId, null);
    const types = eventTypes(store, task.id);
    assert.ok(types.includes("attribution_skipped"), `实得 ${types}`);
    assert.ok(!types.includes("attribution_missing"), "给了理由就不该再记 missing");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- D ---------------- */
test("P0/D requirement 与 unattributedReason 同给 ⇒ USAGE_ERROR（形状歧义必须报错）", () => {
  const dir = freshDir("d");
  const store = openStore({ dataDir: dir });
  try {
    const { item } = seed(store);
    assert.throws(
      () => store.createTask({ projectId: "p1", title: "两个都给", requirementId: item.id, unattributedReason: "随便" }),
      (e) => e.code === "USAGE_ERROR",
    );
    assert.equal(store.listTasks({ projectId: "p1" }).length, 0, "歧义被拒后不得留卡");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- E ---------------- */
test("P0/E 跨项目 / 条目不存在 ⇒ 整笔回滚：零孤儿卡且编号不消耗（旧 taskboard_create_task 的缺陷）", () => {
  const dir = freshDir("e");
  const store = openStore({ dataDir: dir });
  try {
    const { item } = seed(store);
    assert.throws(
      () => store.createTask({ projectId: "p2", title: "跨项目", requirementId: item.id }),
      (e) => e.code === "DEPENDENCY_CROSS_PROJECT",
    );
    assert.equal(store.listTasks({ projectId: "p2" }).length, 0, "跨项目失败不得留下孤儿卡");
    // 编号不回退也不得被吃掉：失败后建的第一张卡必须是 p2-1
    const ok = store.createTask({ projectId: "p2", title: "正常卡", unattributedReason: "测试" });
    assert.equal(ok.identifier, "p2-1");

    assert.throws(
      () => store.createTask({ projectId: "p1", title: "条目不存在", requirementId: "R999" }),
      (e) => /REQUIREMENT/.test(e.code),
    );
    assert.equal(store.listTasks({ projectId: "p1" }).length, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- F ---------------- */
test("P0/F TB_STRICT_ATTRIBUTION=1 ⇒ 未归因被拒 REQUIREMENT_REQUIRED，且有理由/有归因都放行", () => {
  const dir = freshDir("f");
  const store = openStore({ dataDir: dir, env: { TB_STRICT_ATTRIBUTION: "1" } });
  try {
    const { item } = seed(store);
    assert.throws(
      () => store.createTask({ projectId: "p1", title: "严格模式下漏填" }),
      (e) => e.code === "REQUIREMENT_REQUIRED",
    );
    assert.equal(store.listTasks({ projectId: "p1" }).length, 0, "严格拒绝必须零副作用");
    assert.ok(store.createTask({ projectId: "p1", title: "有归因", requirementId: item.id }));
    assert.ok(store.createTask({ projectId: "p1", title: "有理由", unattributedReason: "外部导入的历史卡" }));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- G · API 与 CLI ---------------- */
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

test("P0/G API：POST /api/tasks 建卡即归因；不带归因时返回体必须带 attribution.warning", async () => {
  const dir = freshDir("g");
  const store = openStore({ dataDir: dir });
  try {
    const { item } = seed(store);
    const server = createServer({ store });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };

    const withReq = await post({ projectId: "p1", title: "API 带归因", requirement: item.id });
    assert.equal(withReq.status, 201);
    assert.equal(withReq.json.task.requirementId, item.id);
    assert.equal(withReq.json.attribution.attributed, true);

    const noReq = await post({ projectId: "p1", title: "API 漏归因" });
    assert.equal(noReq.status, 201);
    assert.equal(noReq.json.task.requirementId, null);
    assert.equal(noReq.json.attribution.attributed, false);
    assert.match(noReq.json.attribution.warning, /EXECUTION_NOT_ATTRIBUTED/);

    const cross = await post({ projectId: "p2", title: "API 跨项目", requirement: item.id });
    assert.equal(cross.status >= 400, true);
    assert.equal(store.listTasks({ projectId: "p2" }).length, 0, "跨项目失败不得留孤儿卡");

    await new Promise((r) => server.close(r));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("P0/G CLI：--requirement 落库 / task attribution 能补 / 缺归因时 stderr 警告且 stdout 仍可解析", () => {
  const dir = freshDir("gcli");
  const tb = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TB_DATA_DIR: dir } });
    let json = null; try { json = JSON.parse(r.stdout); } catch { /* 见断言 */ }
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
  };
  try {
    assert.equal(tb(["project", "create", "--name", "P1", "--id", "p1"]).code, 0);

    // 先建一条条目（CLI 无建条目命令 ⇒ 用最小 HTTP 面？改用 store 直接写）
    const store = openStore({ dataDir: dir });
    const doc = store.ensureRequirementDoc("p1", { body: "# d" });
    const item = store.createRequirementItem({ projectId: "p1", title: "CLI 条目", docId: doc.id, status: "open" });
    store.close();

    const created = tb(["task", "create", "--project", "p1", "--title", "CLI 带归因", "--requirement", item.identifier]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.json.task.requirementId, item.id);
    assert.equal(created.stderr.includes("⚠"), false, "有归因不该有警告");

    const missing = tb(["task", "create", "--project", "p1", "--title", "CLI 漏归因"]);
    assert.equal(missing.code, 0, missing.stderr);
    assert.notEqual(missing.json, null, "stdout 必须仍是合法 JSON（警告走 stderr）");
    assert.equal(missing.json.task.requirementId, null);
    assert.match(missing.stderr, /未归属需求条目/);
    assert.match(missing.stderr, /tb task attribution/);

    const fixed = tb(["task", "attribution", missing.json.task.identifier, "--requirement", item.identifier]);
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.equal(fixed.json.task.requirementId, item.id);

    const withReason = tb(["task", "create", "--project", "p1", "--title", "CLI 有理由", "--unattributed-reason", "外部导入"]);
    assert.equal(withReason.code, 0, withReason.stderr);
    assert.equal(withReason.json.task.requirementId, null);
    assert.equal(withReason.stderr.includes("⚠"), false, "显式声明理由后不该再警告");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
