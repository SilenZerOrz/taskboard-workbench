/**
 * 卡 `-267` / 需求 `R181`：**撤单口径的呈现层收口**（口径本体由已 done 的 `-253` 落地）。
 *
 * 背景：`-253` 把「撤单（canceled）= 前置**终结** ⇒ 下游不再等它」落到了服务端
 * （`store.isTaskReady` 只认 `done`/`canceled` 两个终态 + `releaseDownstreamOnCancel`：
 * 因依赖而受阻的下游当场放回「可开工」，事件 `dependency_released` + 评论 + 审计三重留痕）。
 * 但 `-252` 留下的**撤单成功横幅**仍在说「依赖它的下游卡需要按『前置已撤单』重估」——
 * 那是 `-253` **之前**的服务端口径（撤单不解阻），与现在的服务端行为**矛盾**，
 * 而且把人引到一条已经不存在的路上（人以为自己还得手动把下游拖出「受阻」）。
 * 这正是本仓反复登记的「界面承诺 ≠ 实现」同类缺陷：**界面读到的仍是旧口径**。
 *
 * 本文件守四层：
 *   ① 源码层：横幅不许再叫人工重估（旧措辞 `需要按「前置已撤单」重估` 全仓清零），
 *      且必须写清新口径三要素（前置已终结 / 下游不再等它 / 自动放回「可开工」）；
 *   ② 过度承诺层：横幅**必须**带限定语「因依赖而受阻的」—— 非依赖类受阻（capability 等）
 *      服务端**不**放行，横幅不许说成「下游一律放回」；
 *   ③ 跨层一致层：横幅与服务端事件 detail 用**同一句**「放回「可开工」」——
 *      服务端改了说法，界面不许继续说旧话（源码门与运行时门不是一件事，这里把两边对到同一处）；
 *   ④ 行为层：撤单 ⇒ 因依赖受阻的下游**确实**被放回「可开工」且留痕；非依赖类受阻**不**被放行
 *      （⇒ 横幅的限定语为真，不是安慰话）。
 *
 * 行为层只写真库，不写浏览器 —— 渲染后的横幅文案由源码守卫 + 本仓既有前端台共同覆盖。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appSrc = readFileSync(path.join(repoRoot, "web", "app.js"), "utf8");

/** 每个用例一套独立临时库（跑完即删）。 */
function withStore(label, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t267-${label}-`));
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "demo", name: "Demo" });
    return fn(store);
  } finally {
    store.close();
    rmSync(path.join(dir), { recursive: true, force: true });
  }
}

/**
 * 带 HTTP 路由的一套独立临时库（跑完即删）；`route` 与真实服务端同一份 `createApiRouter`。
 * 必须是 async：路由调用是异步的，若照 `withStore` 那样同步 `return fn(...)`，
 * `finally` 会在 promise 落定**之前**就关库删目录 ⇒ 用例里的第二次请求撞上已关闭的库。
 */
async function withRoute(label, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), `t267-${label}-`));
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "demo", name: "Demo" });
    const router = createApiRouter({ store });
    const route = (method, pathname, body) => {
      const [p, q] = String(pathname).split("?");
      return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
    };
    return await fn(store, route);
  } finally {
    store.close();
    rmSync(path.join(dir), { recursive: true, force: true });
  }
}

/** A → B 的单边依赖。 */
function twoTasks(store) {
  const a = store.createTask({ projectId: "demo", title: "A（确认不执行）" });
  const b = store.createTask({ projectId: "demo", title: "B（等 A）" });
  store.addTaskDependency({ blocker: a.identifier, blocked: b.identifier, reason: "等 A 的产物" });
  return { a, b };
}

const cancel = (store, task, actor = "human") => store.updateTask(task.identifier, {
  expectedVersion: store.requireTaskRef(task.identifier).version,
  status: "canceled",
  actor,
});

/** 撤单成功横幅所在的**那一行**（不是全文件里搜关键词 —— 那会把别处的字串也算进来）。 */
function cancelBannerLine() {
  const idx = appSrc.indexOf("已撤单（已取消）");
  assert.ok(idx > 0, "web/app.js 必须存在撤单成功横幅");
  const start = appSrc.lastIndexOf("\n", idx) + 1;
  const end = appSrc.indexOf("\n", idx);
  return appSrc.slice(start, end === -1 ? appSrc.length : end);
}

test("源码：撤单横幅不再叫人工重估（旧口径全仓清零）", () => {
  const line = cancelBannerLine();
  assert.match(line, /showBanner\(/, "横幅必须是 showBanner 调用");
  assert.ok(
    !appSrc.includes("需要按「前置已撤单」重估"),
    "旧口径（撤单不解阻、要人工重估）不得再出现在 web/app.js 里 —— 服务端已自动放行",
  );
  assert.ok(!/需要按/.test(line), "横幅不许再叫人「按…重估」");
});

test("源码：横幅必须写清新口径三要素（前置已终结 / 下游不再等它 / 自动放回「可开工」）", () => {
  const line = cancelBannerLine();
  assert.match(line, /前置已终结/, "必须说清撤单=前置终结（不是已完成）");
  assert.match(line, /不再等它/, "必须说清下游不再等这张前置");
  assert.match(line, /自动放回「可开工」/, "必须说清因依赖而受阻的下游已自动放回「可开工」");
  assert.match(line, /无需人工重估/, "必须明确「不用人工再拖下游出受阻」");
});

test("源码：横幅不许过度承诺（必须带「因依赖而受阻」的限定语）", () => {
  const line = cancelBannerLine();
  assert.match(
    line,
    /因依赖而受阻/,
    "非依赖类受阻（capability / needs_input / transient）服务端**不**放行，横幅不许说成「下游一律放回」",
  );
});

test("跨层：横幅与服务端事件用同一句「放回「可开工」」（界面不许说旧话）", () => {
  const line = cancelBannerLine();
  withStore("cross", (store) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "dependency", reason: "上游未过评审", actor: "team", route: "hold" });
    cancel(store, a);
    const event = store.listTaskEvents(b.identifier).find((e) => e.type === "dependency_released");
    assert.ok(event, "撤单必须落 `dependency_released` 事件");
    assert.match(
      event.detail,
      /放回「可开工」/,
      "服务端事件 detail 的措辞必须与界面横幅同源（否则界面就在说另一套口径）",
    );
    assert.match(line, /放回「可开工」/, "横幅措辞必须与服务端一致");
  });
});

test("行为：撤单 ⇒ 因依赖受阻的下游自动放回「可开工」，且事件/评论可回读", () => {
  withStore("release", (store) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "dependency", reason: "上游未过评审", actor: "team", route: "hold" });
    assert.equal(store.requireTaskRef(b.identifier).status, "blocked");

    cancel(store, a);
    const after = store.requireTaskRef(b.identifier);
    assert.equal(after.status, "todo", "前置撤单 ⇒ 下游从「受阻」回「可开工」（界面横幅说的就是这件事）");
    assert.equal(store.isTaskReady(b.identifier).ready, true, "就绪判定必须与放行动作同口径");
    assert.equal(store.isTaskReady(b.identifier).basis, "settled-with-canceled");

    const events = store.listTaskEvents(b.identifier).filter((e) => e.type === "dependency_released");
    assert.equal(events.length, 1, "放行必须留事件（不能静默改库）");
    const comments = store.listComments(b.identifier).map((c) => c.body).join("\n");
    assert.match(comments, /放回「可开工」/, "放行必须在下游卡上留评论说明为什么突然可开工");
  });
});

test("行为：非依赖类受阻（capability）不被放行 ⇒ 横幅的限定语为真", () => {
  withStore("capability", (store) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "capability", reason: "本机没有目标运行时", actor: "watchdog" });

    cancel(store, a);
    const after = store.requireTaskRef(b.identifier);
    assert.equal(after.status, "blocked", "「这张卡自己做不了」与「前置撤单」无关 ⇒ 保持受阻");
    assert.equal(
      store.listTaskEvents(b.identifier).filter((e) => e.type === "dependency_released").length,
      0,
      "非依赖类受阻不得留下放行事件",
    );
    assert.equal(store.isTaskReady(b.identifier).ready, true, "就绪（不用再等前置）但受阻（自身能力缺口）是两件事");
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * 跨层：**抽屉真正点下去**的那条链 —— `PATCH /api/tasks/:ref {status:"canceled"}`
 * （= 横幅所在按钮发的那个请求）→ `GET /api/tasks/:ref/ready`（= 下游「还要不要等」的读数）。
 *
 * 为什么必须单列一层：既有守卫都停在 `store.isTaskReady` / `store.updateTask` 的**函数级**，
 * 而人点的是**路由**。路由与 store 之间还隔着：`body.version` 的取值口径、`assertStatus`
 * 的合法枚举、错误的 HTTP 映射。这三处任何一处漂移，函数级守卫仍全绿，而人点下去是 400。
 * 本仓已有先例（`-267` 同族）：撤单横幅的措辞与服务端行为**对不上**，源码看着都对，
 * 只有把「界面怎么读」与「服务端怎么答」摆在一起看才看得见。
 * ──────────────────────────────────────────────────────────────────────────── */

test("跨层：抽屉撤单走 PATCH 路由 ⇒ 下游 GET /ready 由 false 翻 true（basis 点名撤单）", async () => {
  await withRoute("route", async (store, route) => {
    const { a, b } = twoTasks(store);
    store.blockTask(b.identifier, { kind: "dependency", reason: "等 A", actor: "team", route: "hold" });

    const before = await route("GET", `/api/tasks/${b.identifier}/ready`);
    assert.equal(before.status, 200);
    assert.equal(before.payload.ready, false, "撤单前：上游未终结 ⇒ 路由读数必须是 false");
    assert.equal(before.payload.basis, "waiting");

    // 与 `web/app.js` 撤单按钮同一形态：带 version + status=canceled + actor=human
    const fresh = await route("GET", `/api/tasks/${a.identifier}`);
    const patched = await route("PATCH", `/api/tasks/${a.identifier}`, {
      version: fresh.payload.task.version, status: "canceled", actor: "human",
    });
    assert.equal(patched.status, 200, "撤单必须被路由接受（横幅敢说成功，就说明这条链没被门拦）");
    assert.equal(patched.payload.task.status, "canceled");

    const after = await route("GET", `/api/tasks/${b.identifier}/ready`);
    assert.equal(after.payload.ready, true, "撤单后：下游经**路由**读到的必须是 true（不是只有函数层面 true）");
    assert.equal(after.payload.basis, "settled-with-canceled", "路由必须原样透出「靠撤单终结」的依据");
    assert.deepEqual(after.payload.settledByCancel.map((x) => x.identifier), [a.identifier], "点名是谁没交付");
    assert.deepEqual(after.payload.blockers.map((x) => x.status), ["canceled"], "blockers 保留 status 原文（不折叠成 done）");
  });
});

test("跨层：done 前置经路由读到 all-done（撤单那一档不许吃掉原行为）", async () => {
  await withRoute("route-done", async (store, route) => {
    const { a, b } = twoTasks(store);
    const fresh = await route("GET", `/api/tasks/${a.identifier}`);
    await route("PATCH", `/api/tasks/${a.identifier}`, {
      version: fresh.payload.task.version, status: "done", actor: "human",
    });

    const ready = await route("GET", `/api/tasks/${b.identifier}/ready`);
    assert.equal(ready.payload.ready, true);
    assert.equal(ready.payload.basis, "all-done", "真交付走 all-done，与撤单的 settled-with-canceled 分开");
    assert.deepEqual(ready.payload.settledByCancel, []);
  });
});

