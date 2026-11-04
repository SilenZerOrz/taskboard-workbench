/**
 * 随包人读文档的**位置**（卡 `-220` / 需求 `R161`）—— HTTP 面 + 物化真落盘
 *
 * 守的是用户那句「默认解压位置 / 后续存放位置可查可看可改」：
 *   A `GET /docs` 回三路（包内默认 / 项目存放 / 生效来源）+ 覆盖标记
 *   B `POST materialize` 文件**真落盘**；`reset` 覆盖；`kept` 不静默回滚
 *   C `PUT {dir}` 改路径（相对按工作区解析）→ 回读生效 + **落审计**；`{dir:null}` 回落默认
 *   D `?file=` 只读「看一眼」，且**拒绝路径穿越**
 *   E 无工作区 + 相对路径 ⇒ **写库之前**就拒（不许存进一个用不了的配置）
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";

const payloadOf = (r) => r.payload ?? r.body ?? r;
const setup = (workspacePath) => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "项目一", workspacePath });
  const router = createApiRouter({ store });
  const route = (method, pathname, body = null, query = "") =>
    router.route({ method, pathname, searchParams: new URLSearchParams(query), body });
  return { store, route };
};
const attempt = async (fn) => { try { return { ok: await fn() }; } catch (error) { return { error }; } };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "docs-loc-"));

test("A GET /docs：包内默认 + 项目存放（默认路径）+ 生效来源=包内", async () => {
  const ws = tmp();
  try {
    const { route } = setup(ws);
    const v = payloadOf(await route("GET", "/api/projects/p1/docs"));
    assert.match(v.packaged.dir, /spec\/docs$/);
    assert.equal(v.project.dir, path.join(ws, ".taskboard", "docs"));
    assert.equal(v.project.dirIsOverride, false);
    assert.equal(v.project.exists, false);
    assert.equal(v.effective.source, "packaged");
    assert.ok(v.packaged.files.length >= 4, JSON.stringify(v.packaged.files));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("B POST materialize 真落盘；重复调用 kept 不覆盖；reset 才覆盖", async () => {
  const ws = tmp();
  try {
    const { store, route } = setup(ws);
    const out = payloadOf(await route("POST", "/api/projects/p1/docs", { action: "materialize", actor: "human" }));
    assert.ok(out.written.length >= 4, JSON.stringify(out.written));
    const dir = out.view.project.dir;
    assert.ok(existsSync(path.join(dir, "01-项目开局.md")));
    assert.equal(out.view.effective.source, "project");
    // 改一份 → 再 materialize ⇒ kept（不无声回滚）
    const target = path.join(dir, "01-项目开局.md");
    writeFileSync(target, readFileSync(target, "utf8") + "\n本项目的私有补充\n", "utf8");
    const again = payloadOf(await route("POST", "/api/projects/p1/docs", { action: "materialize", actor: "human" }));
    assert.ok(again.kept.length >= 1);
    assert.match(readFileSync(target, "utf8"), /本项目的私有补充/);
    // reset ⇒ 覆盖回包内版本
    payloadOf(await route("POST", "/api/projects/p1/docs", { action: "reset", actor: "human" }));
    assert.equal(readFileSync(target, "utf8").includes("本项目的私有补充"), false);
    // 两次写都落审计
    const audits = store.listGovernanceAudit().filter((a) => a.action.startsWith("docs-"));
    assert.ok(audits.length >= 3, JSON.stringify(audits.map((a) => a.action)));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("C PUT {dir} 相对路径 ⇒ 按工作区解析、回读生效、落审计；{dir:null} 回落默认", async () => {
  const ws = tmp();
  try {
    const { store, route } = setup(ws);
    const out = payloadOf(await route("PUT", "/api/projects/p1/docs", { dir: "handbook", actor: "human" }));
    assert.equal(out.project.dir, path.join(ws, "handbook"));
    assert.equal(out.project.dirIsOverride, true);
    assert.equal(store.getProjectSettings("p1").envConfig.docsDir, "handbook");
    assert.ok(store.listGovernanceAudit({ action: "docs-set-dir" }).length === 1);
    const back = payloadOf(await route("PUT", "/api/projects/p1/docs", { dir: null, actor: "human" }));
    assert.equal(back.project.dir, path.join(ws, ".taskboard", "docs"));
    assert.equal(back.project.dirIsOverride, false);
    assert.equal("docsDir" in store.getProjectSettings("p1").envConfig, false);
    // 相对路径指向新位置后，materialize 写到那里（证「改」真的改变了落点）
    payloadOf(await route("PUT", "/api/projects/p1/docs", { dir: "handbook", actor: "human" }));
    const m = payloadOf(await route("POST", "/api/projects/p1/docs", { action: "materialize", actor: "human" }));
    assert.equal(m.dir, path.join(ws, "handbook"));
    assert.ok(existsSync(path.join(ws, "handbook", "README.md")));
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("D ?file= 只读看一眼（带 source）；路径穿越被拒", async () => {
  const ws = tmp();
  try {
    const { route } = setup(ws);
    const d = payloadOf(await route("GET", "/api/projects/p1/docs", null, "file=01-%E9%A1%B9%E7%9B%AE%E5%BC%80%E5%B1%80.md"));
    assert.equal(d.source, "packaged");
    assert.match(d.text, /项目开局/);
    const bad = await attempt(() => route("GET", "/api/projects/p1/docs", null, "file=../../etc/passwd"));
    assert.ok(bad.error, "路径穿越必须被拒");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("E 无工作区 + 相对路径 ⇒ 写库之前就拒（配置不得存进用不了的值）", async () => {
  const { store, route } = setup(null);
  const r = await attempt(() => route("PUT", "/api/projects/p1/docs", { dir: "handbook", actor: "human" }));
  assert.ok(r.error, "should reject");
  assert.match(String(r.error.message), /工作区/);
  assert.equal("docsDir" in store.getProjectSettings("p1").envConfig, false);
});

test("E2 无工作区 + materialize ⇒ WORKSPACE_MISSING（不静默写）", async () => {
  const { route } = setup(null);
  const r = await attempt(() => route("POST", "/api/projects/p1/docs", { action: "materialize", actor: "human" }));
  assert.ok(r.error);
  assert.match(String(r.error.message), /工作区/);
});
