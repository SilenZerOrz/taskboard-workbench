/**
 * 卡 `-262` / 需求 `R186`：**`taskboard_update_status` 的状态取值口径单一化**。
 *
 * 现象（2026-11-13 实测）：工具描述写中文「进行中/待验收/受阻/取消」，实现只认英文枚举
 * （`TEAM_WRITABLE_STATUSES = ["in_progress","in_review","blocked","canceled"]`）⇒
 * `status=待验收` 抛 `INVALID_FIELD: 执行侧不允许写入 待验收`，而报错不列合法值。
 * 且 `loop.mjs` 下发给执行会话的指令原文同样写中文 ⇒ **派发出去的 agent 按指令填，必然失败**。
 *
 * 本文件守五层：
 *   A 描述：四个英文枚举齐全、明写「不要传中文」、旧误导串已消失；
 *   B schema：`status.enum` 精确等于 `TEAM_WRITABLE_STATUSES`（顺序与值都比），且 `required:true`；
 *   C 报错可判读：直连 `execute` 传中文 ⇒ `INVALID_FIELD` 且文案列出全部合法值 + 中文列名对照；
 *   D 行为不变：英文 `in_review` 仍走 `requestReview`（状态 + `reviewRequestedAt` 双证）；
 *   E 红线不与枚举冲突：`done` 不在 enum 内（schema 层就拒），而直连 `execute` 传 `done` 仍抛
 *     `GOVERNANCE_AGENT_DONE`（治理红线由 store 兜底，不因 schema 放宽）；
 *   F 下发文案：`loop.mjs` 那行含英文枚举、不含旧串「（进行中/待验收/受阻）」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { TEAM_WRITABLE_STATUSES } from "../src/core/team.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";
import { buildDispatchBriefLines, directiveFor } from "../src/core/loop.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function surface() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "default", name: "默认项目" });
  const defs = new Map();
  registerTaskboardTools({ store, tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  return { store, def: defs.get("taskboard_update_status"), defs };
}

const ENUMS = ["in_progress", "in_review", "blocked", "canceled"];

test("A 描述：四个英文枚举齐全、明写「不要传中文」、旧误导串消失", () => {
  const { def } = surface();
  for (const e of ENUMS) assert.match(def.description, new RegExp(e), `描述缺少英文枚举 ${e}`);
  assert.match(def.description, /不要传中文|传中文会被拒/, "描述必须明写中文不可传");
  assert.ok(!def.description.includes("执行侧可用：进行中/待验收/受阻/取消"), "旧的中文取值串必须消失（它就是误导源）");
  // 中文列名只作**对照**保留，且必须以英文枚举在前
  assert.match(def.description, /in_review（待验收）/);
});

test("B schema：status.enum 精确等于 TEAM_WRITABLE_STATUSES，且 required", () => {
  const { def } = surface();
  const p = def.parameters.status;
  assert.equal(p.type, "string");
  assert.equal(p.required, true);
  assert.ok(Array.isArray(p.enum), "status 必须有 enum（否则模型仍只能照描述猜）");
  assert.deepEqual(p.enum, [...TEAM_WRITABLE_STATUSES]);
  assert.deepEqual(p.enum, ENUMS);
  assert.ok(typeof p.description === "string" && p.description.includes("英文枚举"));
});

test("C 报错可判读：中文取值被拒且文案列出全部合法值", async () => {
  const { store, def } = surface();
  const t = store.createTask({ projectId: "default", title: "探针卡", status: "in_progress" });
  for (const zh of ["待验收", "受阻", "取消"]) {
    await assert.rejects(
      () => def.execute({ ref: t.identifier, status: zh }, { agent: { id: "s1" } }),
      (error) => {
        assert.equal(error.code, "INVALID_FIELD");
        for (const e of ENUMS) assert.ok(error.message.includes(e), `报错缺少合法值 ${e}：${error.message}`);
        assert.match(error.message, /中文只是看板列名/, "报错要指出「中文只是列名」，而不是只说不允许");
        return true;
      },
      `status=${zh} 必须被拒且文案可判读`,
    );
  }
  assert.equal(store.requireTaskRef(t.identifier).status, "in_progress", "被拒的调用不得改动状态");
});

test("D 行为不变：英文 in_review 仍走 requestReview", async () => {
  const { store, def } = surface();
  const t = store.createTask({ projectId: "default", title: "待评审卡", status: "in_progress" });
  const r = await def.execute({ ref: t.identifier, status: "in_review", comment: "实现完成，请评审" }, { agent: { id: "s1" } });
  assert.equal(r.status, "in_review");
  const fresh = store.requireTaskRef(t.identifier);
  assert.equal(fresh.status, "in_review");
  assert.ok(fresh.reviewRequestedAt, "进待验收必须补评审发起时间（FR-83/FR-111 未被本卡改动）");
});

test("E 红线：done 不在 enum 内，但直连 execute 传 done 仍抛 GOVERNANCE_AGENT_DONE", async () => {
  const { store, def } = surface();
  assert.ok(!def.parameters.status.enum.includes("done"), "done 不得出现在可写枚举里");
  const t = store.createTask({ projectId: "default", title: "红线卡", status: "in_progress" });
  await assert.rejects(
    () => def.execute({ ref: t.identifier, status: "done" }, { agent: { id: "s1" } }),
    (e) => e.code === "GOVERNANCE_AGENT_DONE",
  );
  assert.equal(store.requireTaskRef(t.identifier).status, "in_progress", "红线拒绝后状态不得变化");
});

test("F 下发文案：团队派发指令（directiveFor 的真实输出）给的是英文枚举，不是旧中文串", () => {
  // 卡 `-270` 补口：原 F 是「在源码里 find 含『状态回写：』的那一行」——
  // 锁的是**源码文本**，而源码里可能有好几行、也可能一行都没真正下发。
  // 现在直接调用产出函数断言**真正派发出去的这份文本**。
  const text = directiveFor("official", { teamId: "team-1", taskRef: "taskboard-workbench-270", requirementId: null, qualityGates: null });
  assert.ok(text.includes("状态回写用英文枚举"), `下发文案必须写明英文枚举口径：${text}`);
  assert.ok(!text.includes("（进行中/待验收/受阻）"), `下发文案仍在给中文取值：${text}`);
  for (const e of ENUMS) assert.ok(text.includes(e), `下发文案缺少英文枚举 ${e}：${text}`);
  // 中文只允许以「英文（中文）」对照形态出现（列名解释），不得再当取值教。
  assert.ok(text.includes("in_review（待验收）"), `中文必须作括号对照：${text}`);
  assert.ok(!text.includes("提交\"待验收\""), `仍在教中文取值：${text}`);
  assert.ok(!text.includes("不得置\"完成\""), `红线应写成英文枚举 done（与工具描述同口径）：${text}`);
});

test("F2 主会话汇总指令（buildDispatchBriefLines 的真实输出）：不得再把中文当取值教给执行会话", () => {
  // 卡 `-270` 补口：这条**才是真正投进项目主会话的正文**，此前没人锁过它
  // （原 F2 靠 `find` 源码里含「工作台任务标识：」的那一行 ⇒ 锁到的是相邻说明行，
  //  于是「提交"待验收"（失败→受阻）」长期绿着）。现在断言真实产出。
  const text = buildDispatchBriefLines([{ task: "taskboard-workbench-270", teamId: "team-1" }]).join("\n");
  assert.ok(text.includes("状态回写："), `汇总指令必须写明状态回写口径：${text}`);
  assert.ok(!text.includes("（进行中/待验收/受阻）"), `下发文案仍在给中文取值：${text}`);
  assert.ok(!text.includes("提交\"待验收\""), `仍在教中文取值：${text}`);
  assert.ok(!text.includes("失败→受阻"), `仍在教中文取值：${text}`);
  for (const e of ENUMS) assert.ok(text.includes(e), `下发文案缺少英文枚举 ${e}：${text}`);
  // 中文只作括号对照。
  assert.ok(text.includes("in_review（待验收）"), `中文必须作括号对照：${text}`);
  assert.ok(text.includes("blocked（受阻）"), `中文必须作括号对照：${text}`);
});

test("F3 兜底：loop.mjs 里凡出现中文状态词的**非注释行**，必须同时给出对应英文枚举对照", () => {
  // 为什么还要扫源码：F/F2 断言的是**那两条真实下发文案**，但下次有人再加第三条下发路径
  // （或往别的行上加中文取值）时它们不会红。扫描兜住「loop.mjs 里还有别的行在教中文取值」。
  const src = readFileSync(path.join(ROOT, "src/core/loop.mjs"), "utf8");
  const WORDS = { 进行中: "in_progress", 待验收: "in_review", 受阻: "blocked", 取消: "canceled" };
  src.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) return; // 注释行
    for (const [word, en] of Object.entries(WORDS)) {
      if (!line.includes(word)) continue;
      assert.ok(
        line.includes(`${en}（${word}）`),
        `loop.mjs:${i + 1} 出现中文状态词「${word}」却没给对应枚举对照「${en}（${word}）」：${line}`,
      );
    }
  });
});
