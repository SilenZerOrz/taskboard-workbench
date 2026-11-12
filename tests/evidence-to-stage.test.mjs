/**
 * FR-106（0-B-b · 卡 `-239`）：交付证据**双通道写入口** + 四字段硬门 + 入口层 kind 白名单。
 *
 * 这一批要守的不是"能不能写进去"，而是四条容易假绿的口径：
 *   ① **四字段缺一即零落库**（不是"落了再补"）；
 *   ② `artifact_refs` 的非法 kind 在**入口层**就拒（规则层的静默丢弃契约不变，是另一件事）；
 *   ③ 核验 `root` 绑 **`project.workspacePath`** —— 默认 `process.cwd()` 会让 MCP 子进程核到别的仓库；
 *   ④ 同指纹**幂等**（不增行）。
 *
 * HTTP 与 MCP 两条通道**必须同码同副作用** —— 它们的 handler 都落到 `store.addTaskEvidence`，
 * 本文件两边都测，防止将来有人在某一侧加旁路。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { artifactRefKindProblems } from "../src/core/evidence.mjs";
import { cardEvidenceSubmit } from "../src/mcp/tools.mjs";

/** 临时工作区：只在这里放一个文件，用来证明核验 root 走的是 `project.workspacePath` 而不是 `process.cwd()`。 */
function setup() {
  const ws = mkdtempSync(join(tmpdir(), "tb-evidence-ws-"));
  writeFileSync(join(ws, "only-in-workspace.txt"), "ok\n");
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: ws });
  const task = store.createTask({ projectId: "p1", title: "证据双通道", status: "in_progress" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, task, ws, route, cleanup: () => { try { store.close(); } catch { /* ignore */ } try { rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

const valid = {
  verdict: "双通道落库一致",
  deviation: "无",
  boundary: "真机渲染未取",
  artifacts: ["tests/evidence-to-stage.test.mjs"],
};

test("A 四字段齐 + file 引用可解 ⇒ 1 行、refs_state=resolved、ticketStage 不是 none", async () => {
  const { store, task, route, cleanup } = setup();
  const res = await route("POST", `/api/tasks/${task.identifier}/evidence`, {
    ...valid,
    artifact_refs: [{ kind: "file", ref: "only-in-workspace.txt" }],
  });
  assert.equal(res.status, 201);
  assert.equal(res.payload.evidence.refsState, "resolved", "文件应在 project.workspacePath 下解得开");
  assert.equal(store.listTaskEvidence(task.identifier).length, 1);
  assert.ok(res.payload.ticketStage.stage && res.payload.ticketStage.stage !== "none", `ticketStage 不得是 none（实际 ${res.payload.ticketStage.stage}）`);
  cleanup();
});

test("B 四字段缺一 ⇒ EVIDENCE_INCOMPLETE（HTTP 与 MCP 同码）且零落库", async () => {
  const { store, task, route, cleanup } = setup();
  const http = await route("POST", `/api/tasks/${task.identifier}/evidence`, { ...valid, deviation: "" })
    .then(() => null).catch((e) => e);
  assert.equal(http?.code, "EVIDENCE_INCOMPLETE");

  let mcpError = null;
  try {
    cardEvidenceSubmit({ store, agentId: "anon-test" }, { card: task.identifier, ...valid, boundary: "   " });
  } catch (e) { mcpError = e; }
  assert.equal(mcpError?.code, "EVIDENCE_INCOMPLETE");
  assert.equal(store.listTaskEvidence(task.identifier).length, 0, "被拒必须零落库（不许落半条）");
  cleanup();
});

test("C artifact_refs 的 kind 非 {commit,file} ⇒ INVALID_ARTIFACT_REF（入口层显式拒，两通道同码）", async () => {
  const { store, task, route, cleanup } = setup();
  assert.deepEqual(artifactRefKindProblems([{ kind: "url", ref: "https://example.com" }]).map((b) => b.index), [0]);

  const http = await route("POST", `/api/tasks/${task.identifier}/evidence`, { ...valid, artifact_refs: [{ kind: "url", ref: "https://example.com" }] })
    .then(() => null).catch((e) => e);
  assert.equal(http?.code, "INVALID_ARTIFACT_REF");

  let mcpError = null;
  try {
    cardEvidenceSubmit({ store, agentId: "anon-test" }, { card: task.identifier, ...valid, artifact_refs: [{ kind: "url", ref: "https://example.com" }] });
  } catch (e) { mcpError = e; }
  assert.equal(mcpError?.code, "INVALID_ARTIFACT_REF");
  assert.equal(store.listTaskEvidence(task.identifier).length, 0);
  cleanup();
});

test("D 过程性证据只进 artifacts、不进 artifact_refs ⇒ 行级 refs_state=unchecked", async () => {
  const { store, task, cleanup } = setup();
  const ev = store.addTaskEvidence(task.identifier, {
    ...valid,
    artifacts: ["npm test 1186/1186", "https://example.com/run/1", "gaps.unattributedTasks=0"],
  });
  assert.equal(ev.refsState, "unchecked", "没有 artifact_refs 就不假装校验过");
  assert.deepEqual(ev.artifactRefs, []);
  assert.equal(ev.artifacts.length, 3);
  cleanup();
});

test("E 同指纹重复提交 ⇒ 幂等（deduped=true 且不增行）", async () => {
  const { store, task, route, cleanup } = setup();
  const first = await route("POST", `/api/tasks/${task.identifier}/evidence`, { ...valid, artifact_refs: [{ kind: "file", ref: "only-in-workspace.txt" }] });
  const second = await route("POST", `/api/tasks/${task.identifier}/evidence`, { ...valid, artifact_refs: [{ kind: "file", ref: "only-in-workspace.txt" }] });
  assert.equal(first.payload.evidence.deduped, false);
  assert.equal(second.payload.evidence.deduped, true, "第二次必须是幂等命中");
  assert.equal(second.payload.evidence.id, first.payload.evidence.id, "返回首次那条");
  assert.equal(store.listTaskEvidence(task.identifier).length, 1);
  cleanup();
});

test("F 不传 resolve ⇒ 核验绑 project.workspacePath（不是 process.cwd()）", async () => {
  const { store, task, cleanup } = setup();
  // 这个文件只存在于临时工作区；若核验走 process.cwd()（= 仓库根）会解不开 ⇒ refsState 会是 unresolved。
  const ev = store.addTaskEvidence(task.identifier, {
    ...valid,
    artifactRefs: [{ kind: "file", ref: "only-in-workspace.txt" }],
  });
  assert.equal(ev.refsState, "resolved", "root 必须绑 project.workspacePath");
  const missing = store.addTaskEvidence(task.identifier, {
    ...valid,
    verdict: "另一个判定",
    artifactRefs: [{ kind: "file", ref: "definitely-missing.txt" }],
  });
  assert.equal(missing.refsState, "unresolved", "解不开就是 unresolved，不许静默 resolved");
  cleanup();
});
