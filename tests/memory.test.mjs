/**
 * 项目记忆（2026-10-28 拍板 D-M1/D-M2/D-M5）
 *
 * 定位：**L2 记忆条目不是第二真源** —— 每条必带 `provenance` 指回事实流；整表删掉功能不少，只是变笨。
 * 三条红线在本文件里逐条钉死：
 *   ① 假记忆比空记忆更坏 ⇒ 写入默认 `proposed`，**不召回**；人 accept 后才召回
 *   ② 不删只取代 ⇒ `supersedeMemoryEntry` 只打标记
 *   ③ 先脱敏再入记忆 ⇒ `sk-*` / `*_token` / 私钥入库即拒
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { renderMemoryBlock } from "../src/core/memory.mjs";

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `mem-${label}-`));
const withStore = (label, fn) => {
  const dir = freshDir(label);
  const store = openStore({ dataDir: dir });
  try { fn(store); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
};

test("memory/A 空库：列表与召回都是 0，装载块说「暂无已确认记忆」（不报错）", () => {
  withStore("a", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    assert.deepEqual(store.listMemoryEntries({ projectId: "p1" }), []);
    const recall = store.recallMemory({ projectId: "p1" });
    assert.equal(recall.count, 0);
    assert.match(renderMemoryBlock(recall), /暂无已确认记忆/);
  });
});

test("memory/B 三条形状门：无 provenance 拒 / 明文密钥拒 / kind=fact 无 verifiedAt 拒", () => {
  withStore("b", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    assert.throws(() => store.upsertMemoryEntry({ projectId: "p1", kind: "convention", title: "无出处", body: "..." }),
      (e) => e.code === "USAGE_ERROR" && /provenance/.test(e.message));
    // 夹具取 13 位：仍命中 memory.mjs 的 SECRET_RE（sk- 后 >=12 位 ⇒ 拒收），
    // 但低于 release-precheck 的 L1 阈值（sk- 后 >=20 位）—— 假密钥不该把发布会话打成阻断。
    assert.throws(() => store.upsertMemoryEntry({ projectId: "p1", kind: "convention", title: "带密钥", body: "key=sk-fixtureonly12", provenance: "doc:x.md#1" }),
      (e) => e.code === "MEMORY_SECRET_REJECTED");
    assert.throws(() => store.upsertMemoryEntry({ projectId: "p1", kind: "fact", title: "无核验时间", body: "版本 0.2.1", provenance: "doc:x.md#1" }),
      (e) => e.code === "USAGE_ERROR" && /verifiedAt/.test(e.message));
  });
});

test("memory/C proposed 不召回，accept 后才召回（假记忆比空记忆更坏）", () => {
  withStore("c", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const { entry, created } = store.upsertMemoryEntry({
      projectId: "p1", kind: "convention", title: "统一用 pnpm", body: "不要用 npm", provenance: "doc:docs/规范/01.md#3",
      createdBy: "agent:codex", tags: ["工具链"],
    });
    assert.equal(created, true);
    assert.equal(entry.confidence, "proposed");
    assert.equal(store.recallMemory({ projectId: "p1" }).count, 0, "proposed 不得被召回");
    assert.equal(store.listMemoryEntries({ projectId: "p1" }).length, 0, "默认列表也不含 proposed");

    store.acceptMemoryEntry(entry.id, { actor: "human" });
    const recall = store.recallMemory({ projectId: "p1" });
    assert.equal(recall.count, 1);
    assert.equal(recall.entries[0].title, "统一用 pnpm");
    assert.match(renderMemoryBlock(recall), /\[约定\] 统一用 pnpm/);
  });
});

test("memory/D 唯一索引去重：同 scope+kind+title+provenance 第二次是更新而非新增", () => {
  withStore("d", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const a = store.upsertMemoryEntry({ projectId: "p1", kind: "pitfall", title: "沙箱内起 Chrome 必崩", body: "用 chrome-outside.sh", provenance: "event:42" });
    const b = store.upsertMemoryEntry({ projectId: "p1", kind: "pitfall", title: "沙箱内起 Chrome 必崩", body: "用 chrome-outside.sh（补充）", provenance: "event:42" });
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.entry.id, b.entry.id);
    const all = store.listMemoryEntries({ projectId: "p1", includeProposed: true });
    assert.equal(all.length, 1);
    assert.match(all[0].body, /补充/);
  });
});

test("memory/E 不删只取代 + 过期不召回：superseded 与 stale 都不进召回", () => {
  withStore("e", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    const oldOne = store.upsertMemoryEntry({ projectId: "p1", kind: "decision", title: "旧口径", body: "旧的", provenance: "event:1" });
    store.acceptMemoryEntry(oldOne.entry.id);
    const newOne = store.upsertMemoryEntry({ projectId: "p1", kind: "decision", title: "新口径", body: "新的", provenance: "event:2" });
    store.acceptMemoryEntry(newOne.entry.id);
    store.supersedeMemoryEntry(oldOne.entry.id, { byId: newOne.entry.id, actor: "human" });

    const titles = store.recallMemory({ projectId: "p1" }).entries.map((e) => e.title);
    assert.deepEqual(titles, ["新口径"], `被取代的旧条目不得召回，实得 ${JSON.stringify(titles)}`);
    // 旧条目仍可回查（不删只取代）
    assert.equal(store.getMemoryEntry(oldOne.entry.id).supersedes, newOne.entry.id);

    // stale：ttlDays=0 的 fact（已带 verifiedAt）⇒ 不召回
    const fact = store.upsertMemoryEntry({ projectId: "p1", kind: "fact", title: "宿主版本", body: "0.2.1-rc.3", provenance: "doc:docs/规范/05.md#1", verifiedAt: new Date().toISOString(), ttlDays: 0 });
    store.acceptMemoryEntry(fact.entry.id);
    assert.equal(store.getMemoryEntry(fact.entry.id).stale, true);
    assert.equal(store.recallMemory({ projectId: "p1" }).entries.some((e) => e.id === fact.entry.id), false);
  });
});

test("memory/F 召回有预算与配额：超过 limit 不再给，且 fact 默认不给", () => {
  withStore("f", (store) => {
    store.createProject({ id: "p1", name: "P1" });
    for (let i = 0; i < 8; i += 1) {
      const { entry } = store.upsertMemoryEntry({ projectId: "p1", kind: "convention", title: `约定 ${i}`, body: "x", provenance: `event:${100 + i}` });
      store.acceptMemoryEntry(entry.id);
    }
    const r = store.recallMemory({ projectId: "p1" });
    assert.equal(r.count, 3, "convention 配额默认 3");
    assert.ok(r.chars <= 3000);
    const r2 = store.recallMemory({ projectId: "p1", quotas: null, limit: 5 });
    assert.equal(r2.count, 5, "显式放宽配额后按 limit 收");
  });
});
