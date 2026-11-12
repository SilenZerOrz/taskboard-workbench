/**
 * 卡 `-237` / 需求 `R173`：follower 实例的**写操作必须 409**，读操作照常。
 *
 * 口径（刻意一刀切）：**所有非 GET/HEAD/OPTIONS 一律 409 FOLLOWER_READ_ONLY**。
 * 不做「部分放行」——放行一半比全拒更难解释，也更容易踩到对端正跑着的执行；
 * 用户要写，去那个正在写的窗口（提示里带 host · pid），或等对端退出（45s 租约过期）后本窗口自动接管。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-follower-"));
  const dbPath = path.join(dir, "taskboard.sqlite");
  const writer = openStore({ dbPath });
  const follower = openStore({ dbPath });
  writer.acquireInstanceLease({ host: "web", pid: 111, nowMs: Date.now() });
  follower.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: Date.now() + 1000 });
  const router = createApiRouter({ store: follower });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  const cleanup = () => {
    try { writer.close(); } catch { /* ignore */ }
    try { follower.close(); } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true });
  };
  return { writer, follower, route, cleanup, dbPath };
}

test("follower：写操作一律 409 FOLLOWER_READ_ONLY，且提示里点名对端 host · pid", async () => {
  const { writer, route, cleanup } = setup();
  writer.createProject({ id: "p1", name: "P1" });
  try {
    await assert.rejects(
      () => route("POST", "/api/tasks", { projectId: "p1", title: "不该写进去的卡" }),
      (error) => {
        assert.equal(error.code, "FOLLOWER_READ_ONLY");
        assert.match(error.message, /web · pid 111/, "必须说清是谁在写，否则用户不知道该去哪个窗口");
        assert.equal(error.details?.role, "follower");
        return true;
      },
    );
    // PATCH / DELETE 同理（不是只拦 POST）
    await assert.rejects(() => route("PATCH", "/api/tasks/x", { title: "y" }), (e) => e.code === "FOLLOWER_READ_ONLY");
    await assert.rejects(() => route("DELETE", "/api/tasks/x"), (e) => e.code === "FOLLOWER_READ_ONLY");
  } finally { cleanup(); }
});

test("follower：读操作照常（GET /api/health 200 且 role=follower；GET /api/tasks 200）", async () => {
  const { writer, route, cleanup } = setup();
  writer.createProject({ id: "p1", name: "P1" });
  const t = writer.createTask({ projectId: "p1", title: "对端建的卡", status: "todo" });
  try {
    const health = await route("GET", "/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.payload.status, "ok");
    assert.equal(health.payload.role, "follower");
    assert.equal(health.payload.leaseOwner.pid, 111);

    const list = await route("GET", "/api/tasks?project=p1");
    assert.equal(list.status, 200);
    assert.ok(list.payload.tasks.some((x) => x.identifier === t.identifier), "follower 必须能看见对端写的数据（同一份库）");
  } finally { cleanup(); }
});

test("对端释放后 follower 接管 ⇒ 同一个路由立刻可写（不需要重启）", async () => {
  const { writer, follower, route, cleanup } = setup();
  writer.createProject({ id: "p1", name: "P1" });
  try {
    await assert.rejects(() => route("POST", "/api/tasks", { projectId: "p1", title: "x" }), (e) => e.code === "FOLLOWER_READ_ONLY");
    writer.releaseInstanceLease();
    const take = follower.acquireInstanceLease({ host: "desktop", pid: 222, nowMs: Date.now() });
    assert.equal(take.role, "writer");
    const created = await route("POST", "/api/tasks", { projectId: "p1", title: "接管后能写" });
    assert.equal(created.status, 201);
  } finally { cleanup(); }
});
