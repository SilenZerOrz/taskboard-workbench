/**
 * FR-94 任务级「完成验收标准 + 复核动作」（真机反馈 2026-10-22）。
 *
 * 用户原话（概览页标注）：「**为方便任务执行情况确认，应该在概览内任务添加时即记录完成验收及复核
 * 动作标准，以便快速复核**」。缺口是：此前只有**需求条目**带 `acceptance`，任务级没有 ——
 * 卡做到「待验收」时评审人手里只有 FR-90 的机器结论，没有"这张卡当初说好按什么判定"。
 *
 * 这里逐层钉住：新建时即写入 / 可编辑可清空 / 老库补列不臆造历史标准 /
 * 复核动作的**回落链**（本次显式 → 本卡 → 项目设置 → 内置默认）/ 证据评论里带上当时的标准。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ACCEPTANCE_MAX, openStore, normalizeAcceptance, normalizeTaskVerifyCommand } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { VERIFY_DEFAULT_COMMAND, VERIFY_MAX_COMMAND, parseVerifyComment } from "../src/core/verify.mjs";

function setup(workspacePath = null) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}

test("归一：验收标准只截断不改写；复核动作空串＝未指定（回落，不是空命令）", () => {
  assert.equal(normalizeAcceptance(undefined), "");
  assert.equal(normalizeAcceptance(null), "");
  assert.equal(normalizeAcceptance("  a\nb  "), "  a\nb  ", "多行 Markdown 原样保留");
  assert.equal(normalizeAcceptance("x".repeat(ACCEPTANCE_MAX + 50)).length, ACCEPTANCE_MAX);

  assert.equal(normalizeTaskVerifyCommand(undefined), null);
  assert.equal(normalizeTaskVerifyCommand(""), null, "空串＝回落项目设置，不是空命令");
  assert.equal(normalizeTaskVerifyCommand("   "), null);
  assert.equal(normalizeTaskVerifyCommand("  npm test  "), "npm test");
  assert.equal(normalizeTaskVerifyCommand("x".repeat(VERIFY_MAX_COMMAND + 50)).length, VERIFY_MAX_COMMAND);
});

test("store：添加任务时即记录；可编辑、可清空（清空复核动作 ⇒ 回落）", () => {
  const { store } = setup();
  const t = store.createTask({
    projectId: "p1", title: "带验收标准的卡",
    acceptance: "接口返回 200 且 `done` 只由人置",
    verifyCommand: "node --test tests/task-acceptance.test.mjs",
  });
  const read = store.getTaskRef(t.identifier);
  assert.equal(read.acceptance, "接口返回 200 且 `done` 只由人置");
  assert.equal(read.verifyCommand, "node --test tests/task-acceptance.test.mjs");

  const bare = store.createTask({ projectId: "p1", title: "没写标准的卡" });
  assert.equal(bare.acceptance, "");
  assert.equal(bare.verifyCommand, null);

  const edited = store.updateTask(t.identifier, {
    expectedVersion: read.version, acceptance: "改成：npm test 全绿", verifyCommand: "",
  });
  assert.equal(edited.acceptance, "改成：npm test 全绿");
  assert.equal(edited.verifyCommand, null, "显式清空 ⇒ 回落项目设置");
  assert.equal(edited.status, read.status, "写验收标准不该动状态");
});

test("老库补列：迁移后旧任务读作「未记录」，且不臆造历史标准（幂等）", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-accept-migrate-"));
  try {
    const dbPath = path.join(dir, "tb.sqlite");
    const s1 = openStore({ dbPath });
    s1.createProject({ id: "p1", name: "P1" });
    const t = s1.createTask({ projectId: "p1", title: "老卡", acceptance: "旧标准", verifyCommand: "npm test" });
    s1.close();

    // 把列删掉，模拟 FR-94 之前落盘的老库
    const raw = new DatabaseSync(dbPath);
    raw.exec("alter table tasks drop column acceptance");
    raw.exec("alter table tasks drop column verify_command");
    raw.close();

    const s2 = openStore({ dbPath });
    assert.equal(s2.migration.addedTaskAcceptanceColumn, true);
    assert.equal(s2.migration.addedTaskVerifyCommandColumn, true);
    const old = s2.getTaskRef(t.identifier);
    assert.equal(old.acceptance, "", "老行补列后为空 —— 不把「没有」写成标准");
    assert.equal(old.verifyCommand, null);
    s2.close();

    const s3 = openStore({ dbPath });
    assert.equal(s3.migration.addedTaskAcceptanceColumn, undefined, "幂等：列已存在就不再标补列");
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：POST/PATCH 透传两字段（添加时即记录），未传则不动", async () => {
  const { store, route } = setup();
  const created = await route("POST", "/api/tasks", {
    projectId: "p1", title: "经 API 建的卡", acceptance: "按 A 判定", verifyCommand: "npm test",
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.task.acceptance, "按 A 判定");
  assert.equal(created.payload.task.verifyCommand, "npm test");

  const ref = created.payload.task.identifier;
  const patched = await route("PATCH", `/api/tasks/${ref}`, { version: created.payload.task.version, acceptance: "按 B 判定" });
  assert.equal(patched.payload.task.acceptance, "按 B 判定");
  assert.equal(patched.payload.task.verifyCommand, "npm test", "没传的字段不得被清掉");
  assert.equal(store.getTaskRef(ref).acceptance, "按 B 判定");
});

test("复核动作回落链：本次显式 → 本卡 → 项目设置 → 内置默认；证据评论带上当时的标准", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-accept-verify-"));
  try {
    const { store, route } = setup(dir);
    store.saveProjectSettings("p1", { envConfig: { verifyCommand: "node -e \"console.log('project-level')\"" } });
    const t = store.createTask({
      projectId: "p1", title: "待评审的卡",
      acceptance: "输出里能看到 card-level",
      verifyCommand: "node -e \"console.log('card-level')\"",
    });
    store.teamSetTaskStatus(t.identifier, { status: "in_review", actor: "team" });

    const byCard = await route("POST", `/api/tasks/${t.identifier}/auto-review`, {});
    assert.equal(byCard.payload.command, "node -e \"console.log('card-level')\"", "本卡复核动作优先于项目设置");
    const byBody = await route("POST", `/api/tasks/${t.identifier}/auto-review`, { command: "node -e \"console.log('body-level')\"" });
    assert.match(byBody.payload.command, /body-level/, "本次显式指定优先于本卡");

    const comment = store.listComments(t.id).find((c) => String(c.body).startsWith("【自动复核】"));
    assert.match(String(comment.body), /本卡验收标准：/, "证据里要带上当时写下的判定标准");
    const parsed = parseVerifyComment(byBody.payload.commentId ? store.listComments(t.id).slice(-1)[0].body : comment.body);
    assert.ok(parsed, "证据评论必须仍可解析回结构（机器可读）");
    assert.equal(parsed.acceptance, "输出里能看到 card-level", "标准可回读，供评审人对着看");

    // 没写标准的卡：命令落到项目设置；证据里**不写**这一块（不臆造）
    const plain = store.createTask({ projectId: "p1", title: "没写标准的卡" });
    store.teamSetTaskStatus(plain.identifier, { status: "in_review", actor: "team" });
    const r2 = await route("POST", `/api/tasks/${plain.identifier}/auto-review`, {});
    assert.match(r2.payload.command, /project-level/, "本卡没写 ⇒ 回落项目设置");
    const c2 = store.listComments(plain.id).slice(-1)[0];
    assert.doesNotMatch(String(c2.body), /本卡验收标准：/, "没记录标准就不写这一块");
    assert.notEqual(r2.payload.command, VERIFY_DEFAULT_COMMAND, "有项目级命令时不必落到内置默认");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("前端接线：对话框可写、卡片有标记、抽屉与评审证据能读到本卡标准", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");
  assert.match(src, /tb-f-acceptance/, "新建/编辑对话框要有验收标准字段（添加时即记录）");
  assert.match(src, /tb-f-verify/, "也要能写本卡复核动作");
  assert.match(src, /acceptance: fAcceptance\.value/, "提交时带上验收标准");
  assert.match(src, /verifyCommand: fVerifyCommand\.value/, "提交时带上复核动作");
  assert.match(src, /accept-chip/, "卡片要能一眼看出有没有记标准");
  assert.match(src, /accept-box/, "抽屉概览要摆出标准与复核动作");
  assert.match(src, /auto\.acceptance/, "评审证据块要能显示该次复核记录的标准");
});
