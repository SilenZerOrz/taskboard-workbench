/**
 * FR-92「项目开局对齐（标准步骤程序）」回归。
 *
 * 用户 2026-10-22 指定引入《Vibe Coding 团队协作技巧》作为项目开局对齐事项，并要求
 * 「作为任务工作台标准步骤程序执行」⇒ 六步要有**可核验判据**，工作台能自己回答"对齐了没有"。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { KICKOFF_ALIGNMENT_STEPS, KICKOFF_SOURCE, evaluateKickoff, isFilled, pickSetting } from "../src/core/kickoff.mjs";
import { collectKickoffFacts, hasEngineerExecutor, hasReviewerRole } from "../src/server/kickoff.mjs";

const routeOf = (router) => (method, pathname, body, params = {}) => router.route({ method, pathname, searchParams: new URLSearchParams(params), body });

test("步骤清单是数据驱动的：6 步、每步都有判据与说明", () => {
  assert.equal(KICKOFF_ALIGNMENT_STEPS.length, 6);
  assert.match(KICKOFF_SOURCE.url, /liyupi\/ai-guide/);
  for (const s of KICKOFF_ALIGNMENT_STEPS) {
    assert.ok(s.id && s.title && s.why && s.spec, `${s.id} 缺说明字段`);
    assert.ok(s.checks.length >= 2, `${s.id} 判据太少（对齐必须是可核验的）`);
    for (const c of s.checks) assert.ok(c.paths || c.setting || c.custom, `${s.id}.${c.id} 没有判据来源`);
  }
});

test("pickSetting / isFilled：点路径取值 + 空值判定", () => {
  const settings = { envConfig: { gitFlow: "main/develop/feature", qualityGates: [] }, teamTemplate: { roles: ["lead"] } };
  assert.equal(pickSetting(settings, "envConfig.gitFlow"), "main/develop/feature");
  assert.equal(pickSetting(settings, "envConfig.nope.deep"), undefined);
  assert.equal(isFilled("  "), false);
  assert.equal(isFilled([]), false);
  assert.equal(isFilled({}), false);
  assert.equal(isFilled(0), true);
  assert.equal(isFilled(["a"]), true);
});

test("evaluateKickoff：全缺 → ready=false；全满足 → ready=true；半满足 → partial", () => {
  const empty = evaluateKickoff({});
  assert.equal(empty.ready, false);
  assert.equal(empty.doneCount, 0);
  assert.equal(empty.missing.length, 6);
  assert.match(empty.verdict, /未完成（0\/6）/);

  const full = evaluateKickoff({
    files: Object.fromEntries(KICKOFF_ALIGNMENT_STEPS.flatMap((s) => s.checks).flatMap((c) => (c.paths ?? []).map((p) => [p, true]))),
    settings: { envConfig: { gitFlow: "x", qualityGates: "y", cadence: "z" }, teamTemplate: { roles: ["lead", "reviewer"], engineer: { verifyCommand: "npm test" } } },
    custom: { reviewerRole: true, engineerExecutor: true },
  });
  assert.equal(full.ready, true, "六步全满足才 ready");
  assert.equal(full.doneCount, 6);
  assert.deepEqual(full.missing, []);

  const partial = evaluateKickoff({ files: { "README.md": true } });
  const docs = partial.steps.find((s) => s.id === "docs-first");
  assert.equal(docs.status, "partial", "三步判据中只中一条 ⇒ partial");
  assert.equal(docs.done, 1);
  assert.equal(partial.ready, false);
});

test("hasReviewerRole：数组/对象写法都认，没有就不认", () => {
  assert.equal(hasReviewerRole({ roles: ["lead", "reviewer"] }), true);
  assert.equal(hasReviewerRole({ roles: { lead: {}, Reviewer: {} } }), true);
  assert.equal(hasReviewerRole({ roles: ["lead", "engineer"] }), false);
  assert.equal(hasReviewerRole({}), false);
  assert.equal(hasReviewerRole(null), false);
});

test("hasEngineerExecutor：roles 里的 engineer.executor 或 engineer.verifyCommand 任一即认", () => {
  assert.equal(hasEngineerExecutor({ roles: [{ role: "engineer", executor: "cli:claude" }] }), true);
  assert.equal(hasEngineerExecutor({ roles: [{ role: "engineer", executor: "" }] }), false);
  assert.equal(hasEngineerExecutor({ engineer: { verifyCommand: "npm test" } }), true);
  assert.equal(hasEngineerExecutor({ roles: ["lead"] }), false);
  assert.equal(hasEngineerExecutor(null), false);
});

test("collectKickoffFacts：只读目录，存在性如实回报；目录不可读不炸", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-kickoff-"));
  try {
    writeFileSync(path.join(dir, "README.md"), "# hi");
    mkdirSync(path.join(dir, "docs", "规范"), { recursive: true });
    const facts = collectKickoffFacts(dir);
    assert.equal(facts.readable, true);
    assert.equal(facts.files["README.md"], true);
    assert.equal(facts.files["docs/规范"], true);
    assert.equal(facts.files["CONTRIBUTING.md"], false);
    assert.equal(collectKickoffFacts(null).readable, false);
    assert.equal(collectKickoffFacts(path.join(dir, "nope")).readable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：/api/projects/:id/kickoff 只读自检，且不改设置", async () => {
  const store = openStore({ dbPath: ":memory:" });
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-kickoff-api-"));
  writeFileSync(path.join(dir, "README.md"), "# x");
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const before = store.getProjectSettings("p1");
  const router = createApiRouter({ store });
  const route = routeOf(router);

  const r = await route("GET", "/api/projects/p1/kickoff");
  assert.equal(r.status, 200);
  assert.equal(r.payload.project, "p1");
  assert.equal(r.payload.readable, true);
  assert.equal(r.payload.steps.length, 6);
  assert.equal(r.payload.ready, false);
  assert.ok(r.payload.missing.length > 0);
  assert.match(r.payload.source.url, /liyupi/);

  assert.deepEqual(store.getProjectSettings("p1"), before, "自检不得改项目设置");
  await assert.rejects(() => route("POST", "/api/projects/p1/kickoff", {}), /仅支持 GET/);
  await assert.rejects(() => route("GET", "/api/projects/no-such/kickoff"), (e) => e.code === "PROJECT_NOT_FOUND");

  rmSync(dir, { recursive: true, force: true });
  store.close();
});
