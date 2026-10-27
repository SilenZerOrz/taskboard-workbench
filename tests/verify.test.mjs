/**
 * FR-90 自动复核证据 —— 纯函数（格式化/解析/装配）+ 命令运行器 + API 层。
 *
 * 真机反馈（2026-10-22）：「判断为无法人工校验的任务，理应有自动复核或者已自动跑过测试的
 * 返回结论以供人员评审任务通过使用」⇒ 评审人必须拿到机器结论。这里逐层锁住：
 * 证据评论可往返、取最近一条、**复核不改状态**、异常路径如实拒绝。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { buildHumanReviewContext, buildHumanReviewDraft, classifyHumanReview } from "../src/core/human-review.mjs";
import {
  buildReviewEvidence,
  formatVerifyComment,
  latestAutoReview,
  normalizeVerifyCommand,
  parseVerifyComment,
  summarizeVerifyOutput,
  verdictLabel,
  VERIFY_DEFAULT_COMMAND,
  VERIFY_MAX_COMMAND,
} from "../src/core/verify.mjs";
import { runVerifyCommand } from "../src/server/verify.mjs";

function setup(workspacePath) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: workspacePath ?? null });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  return { store, route };
}

/** 人工校验卡草案（与 next-step-api 测试同一口径：判定必须有凭）。 */
function draftFor(overrides = {}) {
  const input = { blockRecurrences: 2, evidence: ["退出码 1"], taskTitle: "实现 X", ...overrides };
  const classification = classifyHumanReview(input);
  return buildHumanReviewDraft({ ...buildHumanReviewContext(input), ...input, classification });
}

test("命令归一：空 → 默认命令；两端空白去掉；超长按上限截断", () => {
  assert.equal(normalizeVerifyCommand(), VERIFY_DEFAULT_COMMAND);
  assert.equal(normalizeVerifyCommand("   "), VERIFY_DEFAULT_COMMAND);
  assert.equal(normalizeVerifyCommand("  npm run check  "), "npm run check");
  assert.equal(normalizeVerifyCommand("x".repeat(500)).length, VERIFY_MAX_COMMAND);
});

test("结论口径：通过 / 失败（带退出码）/ 超时", () => {
  assert.equal(verdictLabel({ exitCode: 0, timedOut: false }), "通过");
  assert.equal(verdictLabel({ exitCode: 1, timedOut: false }), "失败（退出码 1）");
  assert.equal(verdictLabel({ exitCode: null, timedOut: true }), "超时未完成");
});

test("证据评论可往返：通过 / 失败 / 超时三种都解析回同一结论", () => {
  const cases = [
    { command: "npm test", exitCode: 0, durationMs: 12300, timedOut: false, tail: "tests 391\npass 391" },
    { command: "npm test", exitCode: 1, durationMs: 800, timedOut: false, tail: "fail 2" },
    { command: "npm test", exitCode: null, durationMs: 180000, timedOut: true, tail: "（超时前输出）" },
  ];
  for (const c of cases) {
    const body = formatVerifyComment(c);
    assert.ok(body.startsWith("【自动复核】命令="), "必须以机器可读前缀开头");
    const parsed = parseVerifyComment(body);
    assert.ok(parsed, "本机制写的评论必须解析得回来");
    assert.equal(parsed.command, c.command);
    assert.equal(parsed.timedOut, c.timedOut);
    assert.equal(parsed.exitCode, c.timedOut ? null : c.exitCode);
    assert.equal(parsed.durationMs, c.durationMs);
    assert.equal(parsed.verdict, verdictLabel(c));
  }
});

test("解析不许猜：别家评论 / 手写正文 / 空值一律 null", () => {
  const bad = ["随便聊聊", "【人工校验申报】类别=需求异化；证据=x", "【自动复核】命令=npm test", "", null, undefined];
  for (const body of bad) assert.equal(parseVerifyComment(body), null, "不该把这条当自动复核：" + String(body));
});

test("取最近一次：无时间戳时按写入顺序取最后一条；有时间戳时按时间取最新", () => {
  const early = { id: "c1", createdAt: "2026-10-22T01:00:00.000Z", body: formatVerifyComment({ command: "npm test", exitCode: 1, durationMs: 10 }) };
  const late = { id: "c2", createdAt: "2026-10-22T02:00:00.000Z", body: formatVerifyComment({ command: "npm test", exitCode: 0, durationMs: 20 }) };
  assert.equal(latestAutoReview([early, late]).exitCode, 0);
  assert.equal(latestAutoReview([late, early]).exitCode, 0, "乱序也要按时间取最新");
  const noTime = [{ body: early.body }, { body: late.body }];
  assert.equal(latestAutoReview(noTime).exitCode, 0, "没有时间戳时按数组顺序取最后一条");
  assert.equal(latestAutoReview([]), null);
});

test("评审证据包：自动复核结论 + 最近一条进展评论（证据评论自己不算进展）", () => {
  const comments = [
    { id: "c1", createdAt: "2026-10-22T01:00:00.000Z", body: "改动摘要：加了两个端点" },
    { id: "c2", createdAt: "2026-10-22T01:30:00.000Z", body: "进度：已跑通真机复验\n下一步：等评审" },
    { id: "c3", createdAt: "2026-10-22T02:00:00.000Z", body: formatVerifyComment({ command: "npm test", exitCode: 0, durationMs: 9000, tail: "pass 391" }) },
  ];
  const ev = buildReviewEvidence({ comments });
  assert.equal(ev.autoReview.exitCode, 0);
  assert.equal(ev.autoReview.commentId, "c3");
  assert.match(ev.progress.body, /进度/);
  assert.equal(buildReviewEvidence({}).autoReview, null);
  assert.equal(buildReviewEvidence({}).progress, null);
});

test("运行器：成功 / 失败 / 超时都如实回报，且只留输出尾段", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-verify-"));
  try {
    const ok = await runVerifyCommand({ command: "node -e \"console.log('ALL PASS')\"", cwd: dir, timeoutMs: 30000 });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.timedOut, false);
    assert.match(ok.tail, /ALL PASS/);

    const bad = await runVerifyCommand({ command: "node -e \"process.exit(3)\"", cwd: dir, timeoutMs: 30000 });
    assert.equal(bad.exitCode, 3, "退出码必须如实回报（评审证据不能粉饰）");

    const long = await runVerifyCommand({ command: "node -e \"console.log('x'.repeat(20000))\"", cwd: dir, timeoutMs: 30000, maxTailChars: 200 });
    assert.equal(long.tail.length <= 200, true, "只留尾段：证据评论不是日志搬运");

    const slow = await runVerifyCommand({ command: "node -e \"setTimeout(()=>{},8000)\"", cwd: dir, timeoutMs: 1000 });
    assert.equal(slow.timedOut, true);
    assert.equal(slow.exitCode, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：自动复核产证据但**不改状态**；已收口与人工校验卡被拒", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-verify-api-"));
  try {
    const { store, route } = setup(dir);
    const task = store.createTask({ projectId: "p1", title: "待评审的卡" });
    store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "team" });
    const before = store.getTaskRef(task.identifier);

    const r = await route("POST", "/api/tasks/" + task.identifier + "/auto-review", { command: "node -e \"console.log('ok')\"" });
    assert.equal(r.status, 201);
    assert.equal(r.payload.exitCode, 0);
    assert.equal(r.payload.verdict, "通过");

    const after = store.getTaskRef(task.identifier);
    assert.equal(after.status, before.status, "自动复核**不得**改状态（评审通过/完成只能人点）");
    assert.equal(after.version, before.version, "也不该改任务版本（只旁路写证据评论）");

    const comments = store.listComments(task.id);
    assert.equal(comments.length, 1);
    assert.match(comments[0].body, /^【自动复核】命令=/);

    const detail = await route("GET", "/api/tasks/" + task.identifier);
    assert.equal(detail.payload.reviewEvidence.autoReview.exitCode, 0, "详情里要带上评审证据包");

    store.updateTask(task.identifier, { expectedVersion: store.getTaskRef(task.identifier).version, status: "done" });
    await assert.rejects(() => route("POST", "/api/tasks/" + task.identifier + "/auto-review", {}), /已收口/);

    const human = store.createHumanReviewTask({ projectId: "p1", draft: draftFor() });
    await assert.rejects(() => route("POST", "/api/tasks/" + human.identifier + "/auto-review", {}), /人工校验卡/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("API：项目未配工作区目录 → 明确拒绝（不许猜目录跑命令）", async () => {
  const { store, route } = setup(null);
  const task = store.createTask({ projectId: "p1", title: "无工作区的卡" });
  store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "team" });
  await assert.rejects(() => route("POST", "/api/tasks/" + task.identifier + "/auto-review", {}), (e) => e.code === "PROJECT_WORKSPACE_MISSING");
  assert.equal(store.listComments(task.id).length, 0, "拒绝时不得留下半截证据评论");
});

test("API：auto-review 只支持 POST", async () => {
  const { store, route } = setup(null);
  const task = store.createTask({ projectId: "p1", title: "t" });
  await assert.rejects(() => route("GET", "/api/tasks/" + task.identifier + "/auto-review"), /仅支持 POST/);
});

test("复核总结：认 node --test 计数 / TAP 计数 / 认不出时如实兜底（绝不编造）", () => {
  const nodeTest = summarizeVerifyOutput({ exitCode: 0, tail: "# tests 12\n# pass 12\n# fail 0\nduration_ms 3456.7" });
  assert.match(nodeTest.summary, /共 12 项/);
  assert.match(nodeTest.summary, /通过 12/);
  assert.match(nodeTest.summary, /失败 0/);
  assert.match(nodeTest.summary, /3\.5s/);
  assert.deepEqual(nodeTest.counts, { tests: 12, passed: 12, failed: 0, durationMs: 3456.7 });

  // 真机 2026-10-22（-130）：node 默认 spec reporter 的计数行以 `ℹ` 开头，原实现不认 —— 用真机尾段原文当夹具。
  const spec = summarizeVerifyOutput({
    exitCode: 0,
    tail: "✔ 改绑已有会话：本机不存在的会话不让绑 (1.6ms)\nℹ tests 458\nℹ suites 0\nℹ pass 458\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 10351.523417\n",
  });
  assert.deepEqual(spec.counts, { tests: 458, passed: 458, failed: 0, durationMs: 10351.523417 });
  assert.match(spec.summary, /共 458 项/);
  assert.match(spec.summary, /通过 458/);
  assert.match(spec.summary, /失败 0/);
  assert.match(spec.summary, /10\.4s/);
  assert.equal(spec.failures.length, 0, "spec reporter 全绿时不得误报失败点");

  const tap = summarizeVerifyOutput({ exitCode: 1, tail: "3 passing\n1 failing\n" });
  assert.match(tap.summary, /通过 3/);
  assert.match(tap.summary, /失败 1/);

  const noCounts = summarizeVerifyOutput({ exitCode: 0, tail: "all good\n" });
  assert.match(noCounts.summary, /没有测试计数/);
  assert.match(noCounts.summary, /退出码 0/);
  const badNoCounts = summarizeVerifyOutput({ exitCode: 2, tail: "boom\n" });
  assert.match(badNoCounts.summary, /退出码 2/);
  assert.equal(badNoCounts.failures.length, 0, "认不出失败点就不要塞噪音");
});

test("复核总结：失败点最多取 3 条并截断；超时不给假结论", () => {
  const s = summarizeVerifyOutput({
    exitCode: 1,
    tail: ["not ok 1 - a", "not ok 2 - b", "Error: c", "not ok 4 - d", "not ok 5 - e"].join("\n"),
  });
  assert.equal(s.failures.length, 3, "失败点封顶 3 条，避免把评论撑爆");
  assert.match(s.failures[0], /not ok 1/);
  const long = summarizeVerifyOutput({ exitCode: 1, tail: "✖ " + "x".repeat(500) });
  assert.ok(long.failures[0].length <= 200, "单条失败点截断到 200 字符");

  const t = summarizeVerifyOutput({ exitCode: null, timedOut: true, tail: "# tests 5\n" });
  assert.match(t.summary, /超时/);
});

test("证据评论往返：总结与失败点解析回来与写入一致", () => {
  const summary = summarizeVerifyOutput({ exitCode: 1, tail: "# tests 4\n# pass 3\n# fail 1\nnot ok 4 - 用例四" });
  const body = formatVerifyComment({ command: "npm test", exitCode: 1, durationMs: 1234, timedOut: false, tail: "# tests 4\n# pass 3\n# fail 1\nnot ok 4 - 用例四", ...summary });
  assert.match(body, /^【自动复核】命令=npm test；退出码=1；耗时=1\.2s；结论=失败（退出码 1）/);
  assert.match(body, /总结：/);
  assert.match(body, /失败点：/);
  const parsed = parseVerifyComment(body);
  assert.equal(parsed.summary, summary.summary);
  assert.deepEqual(parsed.failures, summary.failures);
  assert.match(parsed.tail, /# tests 4/);

  // 老证据评论（无总结/失败点行）仍能解析，字段为空而非报错 —— 向后兼容
  const legacy = parseVerifyComment("【自动复核】命令=npm test；退出码=0；耗时=0.5s；结论=通过\n输出尾段：\n```\nok\n```");
  assert.equal(legacy.summary, null);
  assert.deepEqual(legacy.failures, []);
});

test("API：auto-review 回传复核总结与失败点，且证据评论带总结", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-verify-sum-"));
  try {
    const { store, route } = setup(dir);
    const task = store.createTask({ projectId: "p1", title: "带总结的卡" });
    store.teamSetTaskStatus(task.identifier, { status: "in_review", actor: "team" });
    const r = await route("POST", "/api/tasks/" + task.identifier + "/auto-review", {
      command: "node -e \"console.log('# tests 2');console.log('# pass 2');console.log('# fail 0')\"",
    });
    assert.equal(r.status, 201);
    assert.match(r.payload.summary, /共 2 项/);
    assert.deepEqual(r.payload.failures, []);

    const body = store.listComments(task.id)[0].body;
    assert.match(body, /总结：/);

    const detail = await route("GET", "/api/tasks/" + task.identifier);
    assert.match(detail.payload.reviewEvidence.autoReview.summary, /共 2 项/, "详情证据包要带上总结");

    // 真机 2026-10-22（-130）：node 默认 spec reporter（`ℹ tests` 系）也要走通同一条链路 ——
    // 计数不得为 null，且结论必须落到证据评论与详情证据包里。
    const spec = await route("POST", "/api/tasks/" + task.identifier + "/auto-review", {
      command: "node -e \"console.log('ℹ tests 458');console.log('ℹ pass 458');console.log('ℹ fail 0');console.log('ℹ duration_ms 10351.5')\"",
    });
    assert.equal(spec.status, 201);
    assert.deepEqual(spec.payload.counts, { tests: 458, passed: 458, failed: 0, durationMs: 10351.5 });
    assert.match(spec.payload.summary, /共 458 项 · 通过 458 · 失败 0 · 10\.4s/);
    // 第二次复核的评论追加在末尾（listComments 按写入顺序升序），要看最后一条。
    const specBody = store.listComments(task.id).slice(-1)[0].body;
    assert.match(specBody, /总结：测试计数：共 458 项 · 通过 458 · 失败 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
