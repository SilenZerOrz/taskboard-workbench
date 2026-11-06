/**
 * 卡 `-234`（需求 `R171`）· 需求条目引用：「简写 `R170` 可解析，或报错给出完整标识示例」
 *
 * 背景（证据评论 `762dfa1f`，来源团队 t20 实测）：
 *   `POST /api/tasks` 带 `requirement: "R170"` ⇒ **400 `需求条目不存在：R170`**；
 *   同一张卡改写 `taskboard-workbench-R170` ⇒ 201。
 *   根因：`getRequirementItemRef()` 只认 id / 完整 identifier，且 `REQUIREMENT_NOT_FOUND` 的 `details`
 *   只有 `{ ref }` —— **不给可用写法**。于是「写法没被认出来」在人读起来等于「这条需求不存在」。
 *
 * 本测试钉住六条判据（口径＝方案 A）：
 *   A 简写 + 给定 projectId ⇒ 精确解析成 `<projectId>-R<seq>`，建卡 201 且 `requirementId` 指向该条目
 *   B 简写**不跨项目串号**：p1/p2 都有 `R1` 时各解各的；p2 没有该序号时**不会**落到 p1
 *   C 简写 + projectId 但条目不存在 ⇒ 仍 `REQUIREMENT_NOT_FOUND`（**code 一字不改**），
 *     `details` 含 `resolvedIdentifier` + 能照抄的完整标识示例，且 message 说明「已按项目解析」不谎报
 *   D 简写**没有** projectId ⇒ **不猜**：报错 + `candidates` 列出各项目的完整标识（列候选 ≠ 解析）
 *   E 完整 identifier / 条目 id 解析零回归；纯垃圾串也给出「该写什么」
 *   F 真 HTTP：两条回包 —— `requirement:"R170"` 201 且 requirementId 正确；错误路径 4xx 且错误体里
 *     出现 `taskboard-workbench-R170` 这一写法
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `req-ref-${label}-`));
const freePort = () => new Promise((res) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});

/** 两个项目各一条需求条目：p1-R1 / p2-R1（同序号 ⇒ 正好用来验「不许猜」）。 */
function seed(store) {
  store.createProject({ id: "p1", name: "P1" });
  store.createProject({ id: "p2", name: "P2" });
  store.ensureRequirementDoc("p1", { body: "# 需求\n" });
  store.ensureRequirementDoc("p2", { body: "# 需求\n" });
  const p1Item = store.createRequirementItem({ projectId: "p1", title: "条目 A", status: "open" });
  store.createRequirementItem({ projectId: "p2", title: "条目 B", status: "open" });
  return { p1Item };
}

/* ---------------- A ---------------- */
test("R171/A 简写 + projectId ⇒ 解析成本项目的完整标识，建卡归因到该条目", () => {
  const dir = freshDir("a");
  const store = openStore({ dataDir: dir });
  try {
    const { p1Item } = seed(store);
    const byShort = store.getRequirementItemRef("R1", { projectId: "p1" });
    assert.equal(byShort?.identifier, p1Item.identifier, "简写必须解析成 <项目id>-R<序号>");
    const task = store.createTask({ projectId: "p1", title: "简写建卡", requirement: "R1" });
    assert.equal(task.requirementId, p1Item.id);
    // `requirementId` 形参别名同样走简写（HTTP/CLI 两条路都从这两个字段进来）
    const task2 = store.createTask({ projectId: "p1", title: "简写建卡（别名）", requirementId: "R1" });
    assert.equal(task2.requirementId, p1Item.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- B ---------------- */
test("R171/B 简写不跨项目串号：同名序号各解各的，缺了就报错而不是落到别的项目", () => {
  const dir = freshDir("b");
  const store = openStore({ dataDir: dir });
  try {
    const { p1Item } = seed(store);
    // p2 也有 R1 ⇒ 必须解到 p2 自己那条（不是 p1 的）
    const p2Item = store.getRequirementItemRef("R1", { projectId: "p2" });
    assert.equal(p2Item?.identifier, "p2-R1");
    assert.notEqual(p2Item?.id, p1Item.id, "简写不许跨项目串号");
    // p2 里没有 R9 ⇒ 报错；**不得**回落到 p1 的同序号（p1 也没有，更要保证不跨项目找）
    assert.throws(
      () => store.createTask({ projectId: "p2", title: "缺序号", requirement: "R9" }),
      (e) => e.code === "REQUIREMENT_NOT_FOUND" && e.details?.projectId === "p2",
    );
    assert.equal(store.listTasks({ projectId: "p2" }).length, 0, "解析失败必须零副作用（整笔回滚）");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- C ---------------- */
test("R171/C 简写已按项目解析但条目不存在 ⇒ code 不变，details 给出完整标识示例且不谎报", () => {
  const dir = freshDir("c");
  const store = openStore({ dataDir: dir });
  try {
    const { p1Item } = seed(store);
    let err = null;
    try { store.requireRequirementItemRef("R999", { projectId: "p1" }); } catch (e) { err = e; }
    assert.ok(err, "必须抛错");
    assert.equal(err.code, "REQUIREMENT_NOT_FOUND", "错误码不得改（下游按 code 分支）");
    assert.equal(err.details?.ref, "R999", "`ref` 键保留（旧调用方回读）");
    assert.equal(err.details?.refKind, "short");
    assert.equal(err.details?.resolvedIdentifier, "p1-R999");
    assert.ok(Array.isArray(err.details?.examples) && err.details.examples.includes(p1Item.identifier), `examples 必须能照抄：${JSON.stringify(err.details)}`);
    assert.match(err.details?.hint ?? "", /p1-R1/, "hint 必须带本项目真实可用的标识");
    // 不谎报：说明「按项目解析过」，不得只说一句「需求条目不存在」了事
    assert.match(err.message, /R999/);
    assert.match(err.message, /解析/, `message 必须说明已按项目解析：${err.message}`);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- D ---------------- */
test("R171/D 简写没有 projectId ⇒ 不猜，报错并列出各项目候选完整标识", () => {
  const dir = freshDir("d");
  const store = openStore({ dataDir: dir });
  try {
    seed(store);
    assert.equal(store.getRequirementItemRef("R1"), null, "没有项目范围时不得解析（不得猜）");
    let err = null;
    try { store.requireRequirementItemRef("R1"); } catch (e) { err = e; }
    assert.equal(err?.code, "REQUIREMENT_NOT_FOUND");
    assert.equal(err?.details?.resolvedIdentifier, null, "没给项目就不得声称解析成了某条");
    assert.deepEqual(err?.details?.candidates, ["p1-R1", "p2-R1"], "必须把候选列出来（列候选 ≠ 解析）");
    assert.match(err?.message ?? "", /p1-R1/, "message 也要给出可直接照抄的写法");
    assert.doesNotMatch(err?.message ?? "", /^需求条目不存在：R1$/, "不许再是那句裸报错");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- E ---------------- */
test("R171/E 完整标识 / 条目 id 解析零回归；纯垃圾串也指出该写什么", () => {
  const dir = freshDir("e");
  const store = openStore({ dataDir: dir });
  try {
    const { p1Item } = seed(store);
    assert.equal(store.getRequirementItemRef(p1Item.identifier)?.id, p1Item.id, "完整 identifier");
    assert.equal(store.getRequirementItemRef(p1Item.id)?.id, p1Item.id, "条目 id");
    assert.equal(store.getRequirementItemRef("  "), null, "空引用仍是 null（不抛错）");
    let err = null;
    try { store.requireRequirementItemRef("4-abc"); } catch (e) { err = e; }
    assert.equal(err?.code, "REQUIREMENT_NOT_FOUND");
    assert.equal(err?.details?.refKind, "other");
    assert.match(err?.details?.hint ?? "", /p1-R1/, "垃圾串也要给出可照抄的完整标识");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

/* ---------------- F ---------------- */
test("R171/F 真 HTTP 两条回包：简写 201 且归因正确；完整标识 201；错误体含写法示例", async () => {
  const dir = freshDir("f");
  const store = openStore({ dataDir: dir });
  const server = createServer({ store });
  try {
    // 用卡里那两条真标识的形态：项目 id = taskboard-workbench，条目序号 170
    store.createProject({ id: "taskboard-workbench", name: "TB" });
    const doc = store.ensureRequirementDoc("taskboard-workbench", { body: "# 需求\n" });
    // 条目序号由 projects.next_req_seq 顺序分配 ⇒ 先把序号推到 170（否则测的是 R1，不是卡里那个缺口）
    for (let i = 1; i < 170; i += 1) store.createRequirementItem({ projectId: "taskboard-workbench", docId: doc.id, title: `填充条目 ${i}` });
    const item170 = store.createRequirementItem({ projectId: "taskboard-workbench", docId: doc.id, title: "开局缺口闭环", status: "open" });
    assert.equal(item170.identifier, "taskboard-workbench-R170", "种子必须真的落在 R170 上（否则本测试测的不是卡里那个缺口）");

    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;
    const post = async (body) => {
      const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, json: await res.json() };
    };

    // ① 简写建卡 ⇒ 201，归因指向 taskboard-workbench-R170
    const short = await post({ projectId: "taskboard-workbench", title: "简写建卡", requirement: "R170" });
    assert.equal(short.status, 201, `简写建卡应 201，实得 ${short.status}：${JSON.stringify(short.json)}`);
    assert.equal(short.json.task.requirementId, item170.id);
    assert.equal(short.json.attribution.attributed, true);

    // ② 完整标识建卡 ⇒ 201（原路不回归）
    const full = await post({ projectId: "taskboard-workbench", title: "完整标识建卡", requirement: "taskboard-workbench-R170" });
    assert.equal(full.status, 201);
    assert.equal(full.json.task.requirementId, item170.id);

    // ③ 简写指向不存在的条目 ⇒ 4xx，且错误体给出「本次解析成的完整标识 + 可照抄的本项目示例」
    const bad = await post({ projectId: "taskboard-workbench", title: "不存在的简写", requirement: "R999" });
    assert.ok(bad.status >= 400 && bad.status < 500, `应为 4xx，实得 ${bad.status}`);
    assert.equal(bad.json.error?.code, "REQUIREMENT_NOT_FOUND");
    const detail = bad.json.error?.details ?? {};
    assert.equal(detail.resolvedIdentifier, "taskboard-workbench-R999", "必须写明本次解析成的完整标识（不谎报）");
    assert.ok(Array.isArray(detail.examples) && detail.examples.length > 0, `错误体必须给可照抄的示例：${JSON.stringify(detail)}`);
    assert.ok(
      detail.examples.every((x) => /^taskboard-workbench-R\d+$/.test(x)),
      `示例必须都是本项目的完整标识：${JSON.stringify(detail.examples)}`,
    );
    assert.match(JSON.stringify(bad.json), /taskboard-workbench-R\d+/, "错误体正文里必须出现完整标识写法");
    // 未建卡：失败不得留孤儿卡
    assert.equal(store.listTasks({ projectId: "taskboard-workbench" }).length, 2, "失败那一笔必须零副作用");
  } finally {
    await new Promise((r) => server.close(r));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
