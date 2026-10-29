/** FR-36 AI 版条目化 + 规则 fallback（T-6 = 可行，分支一）测试。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createLlmElaborator } from "../src/host/ai-elaborator.mjs";
import { parseElaborationOutput } from "../src/core/requirements.mjs";

function setup(aiElaborator) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "demo", name: "Demo" });
  const doc = store.ensureRequirementDoc("demo", { body: "# 登录\n- 邮箱登录\n" });
  const router = createApiRouter({ store, aiElaborator });
  const call = (body) => router.route({ method: "POST", pathname: `/api/requirements/docs/${doc.id}/elaborate`, searchParams: new URLSearchParams(), body });
  return { store, doc, call };
}

test("parseElaborationOutput：合法 JSON / 代码块包裹 / 非法", () => {
  assert.equal(parseElaborationOutput('[{"title":"A"}]').length, 1);
  assert.equal(parseElaborationOutput('```json\n[{"title":"B"}]\n```')[0].title, "B");
  assert.throws(() => parseElaborationOutput("not json"), (e) => e.code === "AI_OUTPUT_INVALID");
  assert.throws(() => parseElaborationOutput("[]"), (e) => e.code === "AI_OUTPUT_INVALID");
});

test("createLlmElaborator：缺 provider/model/llm 返回 null；可用时聚合 text-delta", async () => {
  assert.equal(createLlmElaborator({}), null);
  assert.equal(createLlmElaborator({ llm: { stream() {} }, provider: "p" }), null);
  const fakeLlm = {
    stream() {
      return (async function* () {
        yield { type: "text-delta", text: '[{"title":"X","acceptance":"ok"}]' };
      })();
    },
  };
  const el = createLlmElaborator({ llm: fakeLlm, provider: "p", model: "m" });
  const out = await el({ body: "doc" });
  assert.equal(out[0].title, "X");
});

// 卡 `-169` P4②（2026-10-29 口径变更）：`auto` 不再静默降级 —— 无 AI 就**拒绝**。
// 旧的「无 AI ⇒ 规则 fallback」整体退到**显式** `fallback:"rule"` 分支（见下一条用例）。
test("auto（无 aiElaborator）→ 拒绝 AI_UNAVAILABLE（零落库）", async () => {
  const { store, call } = setup(undefined);
  await assert.rejects(() => call({}), (e) => e.code === "AI_UNAVAILABLE");
  assert.equal(store.listRequirementCandidates({}).length, 0, "拒绝必须零落库");
  store.close();
});

test("auto + fallback:rule（无 aiElaborator）→ 规则 fallback：mode=rule", async () => {
  const { store, call } = setup(undefined);
  const { payload } = await call({ mode: "auto", fallback: "rule" });
  assert.equal(payload.mode, "rule");
  assert.ok(payload.candidates.length >= 1);
  assert.equal(payload.candidates[0].source, "elaborated-rule");
  store.close();
});

test("auto + AI 成功 → mode=ai，条目来源 elaborated-ai", async () => {
  const ai = async () => [{ title: "AI条目", description: "d", acceptance: "a", priority: "high" }];
  const { store, call } = setup(ai);
  const { payload } = await call({ mode: "auto" });
  assert.equal(payload.mode, "ai");
  const items = store.confirmRequirementCandidates(payload.candidates.map((c) => c.id)).created;
  assert.equal(items[0].source, "elaborated-ai");
  assert.equal(items[0].title, "AI条目");
  store.close();
});

// 口径变更（卡 `-169` P4②）：AI 失败不再被吞成"降级成功"，除非人显式要 fallback。
test("auto + AI 失败（无 fallback）→ 拒绝，不落库", async () => {
  const ai = async () => { throw Object.assign(new Error("boom"), { code: "AI_OUTPUT_INVALID" }); };
  const { store, call } = setup(ai);
  await assert.rejects(() => call({ mode: "auto" }), (e) => e.code === "AI_OUTPUT_INVALID");
  assert.equal(store.listRequirementCandidates({}).length, 0);
  store.close();
});

test("auto + fallback:rule + AI 失败 → 降级为规则，标记 degraded", async () => {
  const ai = async () => { throw Object.assign(new Error("boom"), { code: "AI_OUTPUT_INVALID" }); };
  const { store, call } = setup(ai);
  const { payload } = await call({ mode: "auto", fallback: "rule" });
  assert.equal(payload.mode, "rule");
  assert.equal(payload.degraded, true);
  assert.equal(payload.aiError, "AI_OUTPUT_INVALID");
  store.close();
});

test("ai 模式但不可用 → AI_UNAVAILABLE", async () => {
  const { store, call } = setup(undefined);
  await assert.rejects(() => call({ mode: "ai" }), (e) => e.code === "AI_UNAVAILABLE");
  store.close();
});
