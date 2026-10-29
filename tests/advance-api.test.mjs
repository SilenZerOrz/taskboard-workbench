/**
 * 推进清单 / 决定回写 / 项目记忆 —— **HTTP 面**（2026-10-28 拍板 E1–E3 · D-M1/D-M2/D-M5）
 *
 * store 层已由 `tests/advance.test.mjs` 与 `tests/memory.test.mjs` 钉住；本文件只证明**接线**：
 *   A `GET  /api/projects/:id/advance` 返回五类清单；`?format=block` 给出可直接投的装载块
 *   B `POST …/advance/announce` 复用既有 `sendPrompt` 投**一段**（清单 + 记忆），并落召回审计
 *   C `POST …/advance/:decisionId/decide` 幂等；`accept/complete` 非人 ⇒ 409 `HUMAN_CONFIRM_REQUIRED`
 *   D `POST /api/projects/:id/memory` 落地即 `proposed`（不召回）→ `POST …/memory/:id/accept` 后才召回
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { buildAdvance } from "../src/core/advance.mjs";

function setup(port) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "接口项目", workspacePath: "/tmp/ws-p1" });
  store.bindInitialSession("p1", "sess-main");
  if (port) store.hostSessionPort = port;
  const router = createApiRouter({ store });
  const route = (method, pathname, body = null, query = "") =>
    router.route({ method, pathname, searchParams: new URLSearchParams(query), body });
  const doc = store.ensureRequirementDoc("p1", { body: "# 需求\n" });
  const item = store.createRequirementItem({ projectId: "p1", title: "条目 A", docId: doc.id, status: "open" });
  const task = store.createTask({ projectId: "p1", title: "可开工的卡", status: "todo", requirementId: item.id });
  return { store, route, item, task };
}

const payloadOf = (r) => r.payload ?? r.body ?? r;
/** `route()` 对错误是**抛 TbError**（由 HTTP 层转状态码）—— 这里统一收成 { ok } / { error }。 */
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (error) { return { error }; } };

test("advance-api/A GET /advance 返回清单；?format=block 返回可投递装载块（含记忆段）", async () => {
  const { store, route } = setup();
  const plain = payloadOf(await route("GET", "/api/projects/p1/advance"));
  assert.equal(plain.count, 1);
  assert.equal(plain.counts.dispatch, 1);
  assert.equal(plain.items[0].kind, "dispatch");
  assert.match(plain.items[0].id, /^adv-[0-9a-f]{12}$/);

  const withBlock = payloadOf(await route("GET", "/api/projects/p1/advance", null, "format=block"));
  assert.match(withBlock.block, /【项目推进清单 · 接口项目】/);
  assert.match(withBlock.block, /【项目记忆/);
  assert.deepEqual(withBlock.memory, { count: 0, ids: [] });
  store.close();
});

test("advance-api/B announce 复用 sendPrompt 投一段（清单 + 记忆），并落召回审计", async () => {
  const sent = [];
  const port = { sendPrompt: async (sid, prompt) => { sent.push({ sid, prompt }); return { sent: true }; } };
  const { store, route } = setup(port);
  const m = payloadOf(await route("POST", "/api/projects/p1/memory", {
    kind: "convention", title: "统一用 pnpm", body: "不要用 npm", provenance: "doc:docs/规范/01.md#3",
  }));
  await route("POST", `/api/projects/p1/memory/${m.entry.id}/accept`, { actor: "human" });

  const r = payloadOf(await route("POST", "/api/projects/p1/advance/announce", {}));
  assert.equal(r.delivered, true, JSON.stringify(r));
  assert.equal(r.sessionId, "sess-main", "默认投给项目主会话");
  assert.equal(sent.length, 1, "只投一次（清单与记忆合成一段，不投两段）");
  assert.match(sent[0].prompt, /【项目推进清单/);
  assert.match(sent[0].prompt, /统一用 pnpm/);
  assert.equal(r.memory, 1);
  assert.equal(store.listMemoryRecalls({ limit: 5 }).length, 1, "召回必须留审计");
  store.close();
});

test("advance-api/C decide 幂等；accept/complete 非人 ⇒ 409 HUMAN_CONFIRM_REQUIRED", async () => {
  const { store, route, task } = setup();
  store.requestReview(task.identifier, { reviewer: "codex" });
  store.approveReview(task.identifier, { actor: "codex" });
  const list = buildAdvance(store, "p1");
  const acceptItem = list.items.find((i) => i.kind === "accept");
  assert.ok(acceptItem);

  const denied = await attempt(() => route("POST", `/api/projects/p1/advance/${acceptItem.id}/decide`, { choice: "complete", actor: "agent:main" }));
  assert.equal(denied.error?.code, "HUMAN_CONFIRM_REQUIRED", String(denied.error));
  assert.equal(denied.error?.exitCode, 4, "拒绝要落 409（退出码 4）");
  assert.equal(store.getTaskByIdentifier(task.identifier).status, "in_review", "被拒时不得改状态");

  const ok = await route("POST", `/api/projects/p1/advance/${acceptItem.id}/decide`, { choice: "complete", actor: "human" });
  assert.equal(ok.status, 200);
  assert.equal(payloadOf(ok).taskStatus, "done");

  const again = payloadOf(await route("POST", `/api/projects/p1/advance/${acceptItem.id}/decide`, { choice: "complete", actor: "human" }));
  assert.equal(again.replay, true, "第二次必须重放，不产生副作用");
  store.close();
});

test("advance-api/D 记忆：POST 即 proposed（不召回）→ accept 后才召回；无 provenance 被拒", async () => {
  const { store, route } = setup();
  const created = await route("POST", "/api/projects/p1/memory", {
    kind: "pitfall", title: "沙箱内起 Chrome 必崩", body: "用 chrome-outside.sh", provenance: "event:42",
  });
  assert.equal(created.status, 201);
  assert.equal(payloadOf(created).entry.confidence, "proposed");
  assert.match(String(payloadOf(created).note), /人 accept 后才会被召回/);

  const before = payloadOf(await route("GET", "/api/projects/p1/memory"));
  assert.equal(before.count, 0, "默认列表不含 proposed");
  assert.equal(before.recall.count, 0, "proposed 不召回");

  await route("POST", `/api/projects/p1/memory/${payloadOf(created).entry.id}/accept`, { actor: "human" });
  const after = payloadOf(await route("GET", "/api/projects/p1/memory"));
  assert.equal(after.count, 1);
  assert.equal(after.recall.count, 1);

  const bad = await attempt(() => route("POST", "/api/projects/p1/memory", { kind: "convention", title: "无出处", body: "x" }));
  assert.equal(bad.error?.code, "USAGE_ERROR", String(bad.error));
  assert.match(bad.error.message, /provenance/, "无出处必须被拒（R-M3）");
  store.close();
});
