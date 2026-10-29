/**
 * 「生成看板任务（分拆）」的自动生成 + 修订回路（2026-10-28 真机批注）。
 *
 * 现象：需求条目详情里的分拆区此前**只有一个人工 textarea** —— 人按 `标题 | 负责人 | kind`
 * 一行一条手打，没有建议、没有草稿、没有"按意见改"。用户要求「引入自动生成按钮，并可交互提交
 * 修改意见变更优化」；人拍口径 = **方案 C：走项目主会话**（不新增第二条 LLM 通道）。
 *
 * 同时修掉两个"界面承诺 ≠ 实现"（本轮读码 + 实测确认）：
 *   ① placeholder 宣称有 `kind(work/review)`，而 `assertSplitTasks` **把它丢了** ⇒ 填了等于没填；
 *   ② 按钮写着「+ 依赖」，但 UI 没有任何依赖输入 ⇒ 从界面分拆出来的卡**一条依赖边都没有**。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { assertSplitTasks, normalizeSplitKind } from "../src/core/requirements.mjs";
import { buildSplitAskPrompt, SPLIT_ASK_BOUNDARIES, SPLIT_ASK_LINE_FORMAT } from "../src/core/split-ask.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function setup(port, { bindSession = true } = {}) {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: "/tmp/ws-p1" });
  if (bindSession) store.bindInitialSession("p1", "sess-main"); // 项目主会话（三级回落的第二级）
  if (port) store.hostSessionPort = port;
  const router = createApiRouter({ store });
  const route = (method, pathname, body) =>
    router.route({ method, pathname, searchParams: new URLSearchParams(""), body });
  const item = store.createRequirementItem({ projectId: "p1", title: "R1 需求", description: "- 做 A\n- 做 B", acceptance: "① A 可跑 ② B 有测试" });
  return { store, route, item };
}

/** 浏览器里的解析器：用 vm 加载 web/app.js（stub 掉 document/window），取 `__TB_BOARD__.parseSplitLines`。 */
function loadClientParser() {
  const code = readFileSync(path.join(ROOT, "web/app.js"), "utf8");
  const win = {};
  const doc = { readyState: "complete", getElementById: () => null, addEventListener: () => {}, querySelectorAll: () => [] };
  const sandbox = { window: win, document: doc, localStorage: { getItem: () => null, setItem: () => {} }, console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return win.__TB_BOARD__.parseSplitLines;
}

test("kind：不再静默丢弃（保留合法值、非法值报错、空值 → null）", () => {
  assert.equal(normalizeSplitKind("review"), "review");
  assert.equal(normalizeSplitKind(" WORK "), "work");
  assert.equal(normalizeSplitKind(""), null);
  assert.equal(normalizeSplitKind(undefined), null);
  assert.throws(() => normalizeSplitKind("test"), (e) => e.code === "INVALID_FIELD" || /kind/.test(e.message));
  const out = assertSplitTasks([{ title: "A", kind: "review" }, { title: "B" }]);
  assert.equal(out[0].kind, "review", "kind 必须穿过校验层");
  assert.equal(out[1].kind, null);
});

test("splitRequirement：kind 落成标签 `kind/review`（任务表没有 kind 列），依赖真的建边", () => {
  const { store, item } = setup();
  const r = store.splitRequirement(item.id, {
    tasks: [
      { title: "实现", kind: "work", owner: "engineer" },
      { title: "评审", kind: "review", owner: "reviewer", dependsOn: ["实现"] },
    ],
  });
  assert.equal(r.tasks.length, 2);
  assert.ok((r.tasks[0].labels ?? []).includes("kind/work"), JSON.stringify(r.tasks[0].labels));
  assert.ok((r.tasks[1].labels ?? []).includes("kind/review"), JSON.stringify(r.tasks[1].labels));
  const graph = store.requirementTaskGraph(item.id);
  assert.equal(graph.edges.length, 1, "必须真的产生一条依赖边（旧 UI 永远建不出来）");
  assert.equal(graph.edges[0].blocked, r.tasks[1].identifier);
});

test("指令：必须带条目原文、只出建议不建卡、格式行、以及修改意见/上一版草稿", () => {
  const { item } = setup();
  const base = buildSplitAskPrompt({ item, project: { name: "P1", workspacePath: "/tmp/ws-p1" } });
  assert.ok(base.includes("R1 需求"), "必须带条目标题");
  assert.ok(base.includes("① A 可跑"), "必须带验收标准原文");
  assert.ok(base.includes("不要建卡"), "必须明确「先不要建卡」");
  for (const l of SPLIT_ASK_LINE_FORMAT) assert.ok(base.includes(l), `缺少格式约定：${l}`);
  for (const l of SPLIT_ASK_BOUNDARIES) assert.ok(base.includes(l), `缺少边界红线：${l}`);

  const revised = buildSplitAskPrompt({ item, feedback: "测试那条拆细", previous: ["1 | 实现 | engineer | work |"] });
  assert.ok(revised.includes("测试那条拆细"), "第二轮必须带人的修改意见");
  assert.ok(revised.includes("1 | 实现 | engineer | work |"), "第二轮必须带上一版草稿");
  assert.ok(revised.includes("只改受意见影响的行"), "第二轮必须要求只改受影响的行");
});

test("API：无会话 ⇒ delivered:false / no-session，且**一张卡都不建**（无副作用）", async () => {
  // 不绑主会话、也没有已绑定会话 ⇒ 三级回落全空
  const { store, route, item } = setup(null, { bindSession: false });
  const before = store.listTasks({ projectId: "p1" }).length;
  const r = await route("POST", `/api/requirements/items/${item.identifier}/split-ask`, {});
  const payload = r.payload ?? r.body ?? r;
  assert.equal(payload.delivered, false, JSON.stringify(payload));
  assert.equal(payload.reason, "no-session", JSON.stringify(payload));
  assert.equal(store.listTasks({ projectId: "p1" }).length, before, "投递失败不得建卡");
});

test("API：有宿主通道 ⇒ 只投一条指令（不建卡、不改条目状态、不写评论）", async () => {
  const sent = [];
  const port = { sendPrompt: async (sid, prompt) => { sent.push({ sid, prompt }); return { sent: true }; } };
  const { store, route, item } = setup(port);
  const tasksBefore = store.listTasks({ projectId: "p1" }).length;
  const statusBefore = store.requireRequirementItemRef(item.identifier).status;
  const r = await route("POST", `/api/requirements/items/${item.identifier}/split-ask`, { feedback: null });
  const payload = r.payload ?? r.body ?? r;
  assert.equal(payload.delivered, true, JSON.stringify(payload));
  assert.equal(sent.length, 1, "只投一次");
  assert.equal(sent[0].sid, "sess-main", "必须投给项目主会话");
  assert.ok(sent[0].prompt.includes("不要建卡"));
  assert.equal(store.listTasks({ projectId: "p1" }).length, tasksBefore, "split-ask 不得建卡");
  assert.equal(store.requireRequirementItemRef(item.identifier).status, statusBefore, "split-ask 不得改条目状态");
});

test("浏览器解析器：序号 / 依赖序号 / 全角竖线 / 缺列 / 围栏 / 认不出的进 problems", () => {
  const parse = loadClientParser();
  const { tasks, problems } = parse([
    "```",
    "1 | 补抽屉宽度 | engineer | work |",
    "2｜真机复验 | tester | review | 1",
    "3. 归档说明 | | | 1,2",
    "只有标题的一行",
    "```",
  ].join("\n"));
  assert.equal(tasks.length, 4, JSON.stringify(tasks));
  assert.deepEqual(JSON.parse(JSON.stringify(tasks[0])), { title: "补抽屉宽度", owner: "engineer", kind: "work" });
  assert.deepEqual(JSON.parse(JSON.stringify(tasks[1].dependsOn)), ["补抽屉宽度"], "依赖序号必须折成标题（store 按标题匹配）");
  assert.deepEqual(JSON.parse(JSON.stringify(tasks[2].dependsOn)), ["补抽屉宽度", "真机复验"]);
  assert.equal(tasks[3].title, "只有标题的一行");
  assert.equal(problems.length, 0, JSON.stringify(problems));

  const bad = parse("1 | A | engineer | 不认识 |\n2 | B | | work | 9");
  assert.equal(bad.tasks.length, 2);
  assert.equal(bad.tasks[0].kind, undefined, "非法 kind 不落进任务，但要进 problems");
  assert.ok(bad.problems.some((p) => p.includes("kind")), JSON.stringify(bad.problems));
  assert.ok(bad.problems.some((p) => p.includes("依赖目标找不到")), JSON.stringify(bad.problems));
});
