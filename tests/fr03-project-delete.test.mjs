/**
 * FR-03 缺口补口：项目删除 + **非空守卫**（验收要点：删除非空项目被拒绝且有明确提示）。
 *
 * 覆盖四种情形（任务书要求）：
 *   ① 非空被拒（且剩余数正确）  ② 空项目可删  ③ 未确认被拒  ④ 无级联删除
 * 外加 API 层：`DELETE /api/projects/:ref` 透传 confirm、把 TbError 映射成明确错误码。
 *
 * 所有数据都落在内存库 / 临时目录，**绝不触碰真机库**。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

test("FR-03 · store：非空项目被拒且剩余数正确（任务 + 需求条目 + 文档正文 + 会话关联）", () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "busy", name: "有内容的项目" });
    store.createTask({ projectId: "busy", title: "任务一" });
    store.createTask({ projectId: "busy", title: "任务二" });
    store.createRequirementItem({ projectId: "busy", title: "需求一" });
    store.ensureRequirementDoc("busy", { body: "正文非空" });
    store.requestSessionAssociation("busy", "sess-1");

    assert.throws(
      () => store.deleteProject("busy", { confirm: true }),
      (e) => {
        assert.equal(e.code, "PROJECT_NOT_EMPTY");
        assert.equal(e.details.remaining.tasks, 2, "剩余任务数应为 2");
        assert.equal(e.details.remaining.requirementItems, 1, "剩余需求条目数应为 1");
        assert.equal(e.details.remaining.requirementDocs, 1, "非空正文的需求文档计 1");
        assert.equal(e.details.remaining.sessions, 1, "项目会话关联计 1");
        assert.equal(e.details.total, 5);
        assert.match(e.message, /已拒绝删除/);
        return true;
      },
    );
    // 被拒后项目与所有数据仍在（守卫不产生任何副作用）
    assert.ok(store.getProject("busy"));
    assert.equal(store.listTasks({ projectId: "busy" }).length, 2);
  } finally {
    store.close();
  }
});

test("FR-03 · store：空项目可删（含仅空正文文档的项目）", () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "empty", name: "空项目" });
    const result = store.deleteProject("empty", { confirm: true });
    assert.equal(result.deleted, true);
    assert.equal(result.id, "empty");
    assert.equal(store.getProject("empty"), null, "删除后应查不到");

    // 「仅建了空正文需求文档」的项目仍算空（空串正文不计占用）——否则 UI 一进项目就再也删不掉
    store.createProject({ id: "doc-only", name: "只有空文档" });
    store.ensureRequirementDoc("doc-only", { body: "" });
    assert.doesNotThrow(() => store.deleteProject("doc-only", { confirm: true }));
    assert.equal(store.getProject("doc-only"), null);
  } finally {
    store.close();
  }
});

test("FR-03 · store：未确认被拒（confirm 缺失 / 非 true）", () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "guard", name: "守卫" });
    for (const opts of [{}, { confirm: false }, { confirm: "true" }, { confirm: 1 }]) {
      assert.throws(
        () => store.deleteProject("guard", opts),
        (e) => e.code === "PROJECT_DELETE_UNCONFIRMED",
        `confirm=${JSON.stringify(opts.confirm)} 应被拒`,
      );
    }
    // 拒绝路径也必须留痕（治理审计）
    const audit = store.listGovernanceAudit({ action: "delete-project" });
    assert.equal(audit.length >= 4, true, "每次未确认拒绝都应写审计");
    assert.equal(audit.every((a) => a.allowed === false), true);
    assert.ok(store.getProject("guard"), "未确认不得删除");
  } finally {
    store.close();
  }
});

test("FR-03 · store：无级联删除（非空项目任何数据都不被删）", () => {
  const store = openStore({ dbPath: ":memory:" });
  try {
    store.createProject({ id: "keep", name: "保留" });
    const task = store.createTask({ projectId: "keep", title: "有用的任务" });
    store.addComment(task.id, { body: "有用的评论" });
    const item = store.createRequirementItem({ projectId: "keep", title: "有用的需求" });
    const doc = store.ensureRequirementDoc("keep", { body: "有用的正文" });

    assert.throws(() => store.deleteProject("keep", { confirm: true }), (e) => e.code === "PROJECT_NOT_EMPTY");

    assert.ok(store.getProject("keep"), "项目应仍在");
    assert.equal(store.listTasks({ projectId: "keep" }).length, 1, "任务不得被删");
    assert.equal(store.listComments(task.id).length, 1, "评论不得被删");
    assert.equal(store.getTaskById(task.id).id, task.id);
    assert.equal(store.listRequirementItems({ projectId: "keep" }).length, 1, "需求条目不得被删");
    assert.equal(store.listRequirementItems({ projectId: "keep" })[0].id, item.id);
    assert.equal(store.getRequirementDoc("keep").id, doc.id, "需求文档不得被删");
    assert.equal(store.getRequirementDoc("keep").body, "有用的正文", "正文不得被清空");
  } finally {
    store.close();
  }
});

test("FR-03 · API：DELETE /api/projects/:ref 透传 confirm 并映射错误码", async () => {
  const store = openStore({ dbPath: ":memory:" });
  const router = createApiRouter({ store });
  const route = (method, pathname, body = {}, query = "") =>
    router.route({ method, pathname, searchParams: new URLSearchParams(query), body });
  try {
    store.createProject({ id: "p1", name: "P1" });
    store.createProject({ id: "p2", name: "空 P2" });
    store.createTask({ projectId: "p1", title: "占用任务" });

    // ① 非空 + 已确认 ⇒ 拒绝，错误码 + 剩余数明确
    await assert.rejects(
      () => route("DELETE", "/api/projects/p1", { confirm: true }),
      (e) => e.code === "PROJECT_NOT_EMPTY" && e.details.remaining.tasks === 1,
    );
    // ② 空项目 + 已确认 ⇒ 200
    const ok = await route("DELETE", "/api/projects/p2", { confirm: true });
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.deleted.deleted, true);
    // ③ query 形式透传 confirm（空项目 p3）
    store.createProject({ id: "p3", name: "空 P3" });
    const okQuery = await route("DELETE", "/api/projects/p3", {}, "confirm=1");
    assert.equal(okQuery.payload.deleted.deleted, true);
    // ④ 未确认 ⇒ 拒绝
    await assert.rejects(
      () => route("DELETE", "/api/projects/p1", {}),
      (e) => e.code === "PROJECT_DELETE_UNCONFIRMED",
    );
    // ⑤ 不存在的项目 ⇒ PROJECT_NOT_FOUND
    await assert.rejects(
      () => route("DELETE", "/api/projects/nope", { confirm: true }),
      (e) => e.code === "PROJECT_NOT_FOUND",
    );
    // ⑥ 非 DELETE 方法 ⇒ 用法错误
    await assert.rejects(
      () => route("GET", "/api/projects/p1"),
      (e) => e.code === "USAGE_ERROR",
    );
    assert.ok(store.getProject("p1"), "非空项目不得被删");
  } finally {
    store.close();
  }
});
