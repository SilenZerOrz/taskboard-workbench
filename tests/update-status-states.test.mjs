/**
 * 卡 `-261`：**`taskboard_update_status` 的状态取值 —— 四种执行侧状态 + 四种看板列名**。
 *
 * 现象（2026-11-12 卡 `-253` 执行期实测）：按 MCP 工具描述传 `status: "待验收"` ⇒ 报错
 * `执行侧不允许写入 待验收`；改传 `in_review` 才成功。根因＝工具描述与 `loop.mjs` 派发文案教中文，
 * 而工具实现只认英文枚举（`TEAM_WRITABLE_STATUSES`），且没有中文映射。
 *
 * 口径（需求 `R186` · 卡 `-262` 已定并已被人接受）：**单一真源英文枚举** —— 中文一律**拒绝**、
 * **不做静默映射**。本卡（`-261`）在这条口径下补两件事：
 *   ① 报错**点名对应枚举**（误传看板列名时直接告诉你该传哪个 ⇒ 少一次「读报错 → 猜语言 → 重试」的往返）；
 *   ② 守卫**覆盖四种执行侧状态**（`-262` 的守卫只覆盖 `in_review` 一条）。
 *
 * 本文件守六层：
 *   A 四种执行侧状态各落到对应英文状态（in_progress / in_review / blocked / canceled）—— 卡验收 ③；
 *   B 四种看板列名各被拒、**报错点名对应枚举**、状态不变（不静默降级）—— 卡验收 ②；
 *   C 未知值**不给猜测**：只列全部合法值、状态不变；
 *   D 红线不回归：`done` 仍抛 `GOVERNANCE_AGENT_DONE`，且不在 schema enum 内；
 *   E 映射与枚举**同源**：列名对照表恰好覆盖四个可写枚举（不多不少）、schema enum 精确相等；
 *   F 看板列名别名（「已取消」→ canceled）也认得出，不做成死胡同。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { openStore } from "../src/core/store.mjs";
import { TEAM_STATUS_COLUMN_LABELS, TEAM_WRITABLE_STATUSES, teamStatusEnumForColumn } from "../src/core/team.mjs";
import { registerTaskboardTools } from "../src/host/tool-surface.mjs";

const ENUMS = ["in_progress", "in_review", "blocked", "canceled"];
/** 看板列名 → 期望落到的英文状态（卡验收 ③ 的核心对照表）。 */
const COLUMNS = { 进行中: "in_progress", 待验收: "in_review", 受阻: "blocked", 取消: "canceled" };

function surface() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "default", name: "默认项目" });
  const defs = new Map();
  registerTaskboardTools({ store, tools: { register: (d) => { defs.set(d.name, d); return () => {}; } } });
  return { store, def: defs.get("taskboard_update_status") };
}

test("A 四种执行侧状态各落到对应英文状态", async () => {
  const { store, def } = surface();
  for (const s of ENUMS) {
    const t = store.createTask({ projectId: "default", title: `状态卡-${s}`, status: "todo" });
    const r = await def.execute({ ref: t.identifier, status: s, kind: "transient", reason: "探针", comment: "探针" }, { agent: { id: "s1" } });
    assert.equal(r.status, s, `${s} 的返回值必须是 ${s}`);
    assert.equal(store.requireTaskRef(t.identifier).status, s, `${s} 必须真的落库（不能只在返回里好看）`);
  }
  // 三条分支各自的专属副作用（防「状态对了但走错入口」）：
  const t = store.createTask({ projectId: "default", title: "受阻卡", status: "in_progress" });
  const r = await def.execute({ ref: t.identifier, status: "blocked", kind: "needs_input", reason: "缺参数" }, { agent: { id: "s1" } });
  assert.equal(r.blockKind, "needs_input", "blocked 仍走 blockTask 的分类入口（kind 不得丢）");
  const rev = store.createTask({ projectId: "default", title: "评审卡", status: "in_progress" });
  await def.execute({ ref: rev.identifier, status: "in_review", comment: "请评审" }, { agent: { id: "s1" } });
  assert.ok(store.requireTaskRef(rev.identifier).reviewRequestedAt, "in_review 仍走 requestReview（须补评审发起时间）");
});

test("B 四种看板列名各被拒、报错点名对应枚举、状态不变", async () => {
  const { store, def } = surface();
  for (const [column, expected] of Object.entries(COLUMNS)) {
    const t = store.createTask({ projectId: "default", title: `中文卡-${column}`, status: "todo" });
    await assert.rejects(
      () => def.execute({ ref: t.identifier, status: column }, { agent: { id: "s1" } }),
      (error) => {
        assert.equal(error.code, "INVALID_FIELD", `${column} 必须被拒（不做静默映射）`);
        for (const e of ENUMS) assert.ok(error.message.includes(e), `报错缺少合法值 ${e}：${error.message}`);
        assert.match(error.message, /中文只是看板列名/, "报错要指出「中文只是列名」");
        // 卡 `-261` 的新增价值：**点名**该传哪个枚举，而不是让 agent 自己在四个合法值里猜。
        assert.ok(
          error.message.includes(`对应的 status 枚举是 ${expected}`),
          `报错必须点名「${column} → ${expected}」，否则 agent 还得再撞一次：${error.message}`,
        );
        return true;
      },
      `status=${column} 必须被拒且报错可判读`,
    );
    assert.equal(store.requireTaskRef(t.identifier).status, "todo", `被拒的 ${column} 调用不得改动状态`);
  }
});

test("C 未知值不给猜测：只列合法值、状态不变", async () => {
  const { store, def } = surface();
  for (const bad of ["已完成", "IN_REVIEW", "in_progress ", "", "待验收中"]) {
    const t = store.createTask({ projectId: "default", title: `未知卡-${bad}`, status: "todo" });
    await assert.rejects(
      () => def.execute({ ref: t.identifier, status: bad }, { agent: { id: "s1" } }),
      (error) => {
        assert.equal(error.code, "INVALID_FIELD");
        for (const e of ENUMS) assert.ok(error.message.includes(e), `报错缺少合法值 ${e}：${error.message}`);
        assert.ok(
          !error.message.includes("对应的 status 枚举是"),
          `认不得的值不得猜（${bad}）：${error.message}`,
        );
        return true;
      },
      `status=${JSON.stringify(bad)} 必须被拒且不给猜测`,
    );
    assert.equal(store.requireTaskRef(t.identifier).status, "todo", "被拒的调用不得改动状态");
  }
});

test("D 红线不回归：done 不在枚举内、直连 execute 仍抛 GOVERNANCE_AGENT_DONE", async () => {
  const { store, def } = surface();
  assert.ok(!def.parameters.status.enum.includes("done"), "done 不得出现在可写枚举里");
  const t = store.createTask({ projectId: "default", title: "红线卡", status: "in_progress" });
  await assert.rejects(
    () => def.execute({ ref: t.identifier, status: "done" }, { agent: { id: "s1" } }),
    (e) => e.code === "GOVERNANCE_AGENT_DONE",
  );
  assert.equal(store.requireTaskRef(t.identifier).status, "in_progress", "红线拒绝后状态不得变化");
});

test("E 映射与枚举同源：列名对照表恰好覆盖四个可写枚举、schema enum 精确相等", () => {
  const { def } = surface();
  assert.deepEqual(Object.keys(TEAM_STATUS_COLUMN_LABELS).sort(), [...TEAM_WRITABLE_STATUSES].sort());
  assert.deepEqual(def.parameters.status.enum, [...TEAM_WRITABLE_STATUSES]);
  // 反查函数：四种列名各自落到对应枚举；认不得的返回 null（不猜）。
  for (const [column, expected] of Object.entries(COLUMNS)) {
    assert.equal(teamStatusEnumForColumn(column), expected, `${column} 应对应 ${expected}`);
  }
  assert.equal(teamStatusEnumForColumn("已完成"), null);
  assert.equal(teamStatusEnumForColumn(null), null);
  // 参数描述里带对照（模型填这一格时看得到对照本身，而不只是禁令）。
  assert.match(def.parameters.status.description, /待验收=in_review/);
});

test("F 看板列名别名：已取消 也认得出，不做成死胡同", () => {
  assert.equal(teamStatusEnumForColumn("已取消"), "canceled");
  assert.equal(teamStatusEnumForColumn("取消"), "canceled");
});
