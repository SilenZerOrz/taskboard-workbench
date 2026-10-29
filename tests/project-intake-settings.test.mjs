/** 项目资料引入（intake）+ 项目设置（环境约束 / 团队模板）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter, httpStatusFor } from "../src/server/api.mjs";
import { scanProjectMaterials, buildMaterialIndex } from "../src/core/intake.mjs";

// 验证台建的临时目录/文件：跑完（含断言失败）统一清理，别把 OS 临时目录堆满。
const TEMPS = [];
process.on("exit", () => {
  for (const p of TEMPS) {
    try { rmSync(p, { recursive: true, force: true }); } catch { /* 清理失败不影响测试结论 */ }
  }
});

function makeTree() {
  const dir = mkdtempSync(join(tmpdir(), "tb-intake-"));
  TEMPS.push(dir);
  writeFileSync(join(dir, "README.md"), "# 项目简介\n\n这是首页。\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "需求.md"), "# 需求总纲\n\n- R1 登录\n- R2 报表\n");
  writeFileSync(join(dir, "docs", "二进制.docx"), "not-really-binary");
  mkdirSync(join(dir, "node_modules"));
  writeFileSync(join(dir, "node_modules", "x.md"), "# 应被跳过");
  return dir;
}

test("intake 扫描：只收文档、跳过 node_modules/隐藏；文本可读、二进制登记", async () => {
  const dir = makeTree();
  const scan = await scanProjectMaterials(dir);
  const rels = scan.files.map((f) => f.relPath).sort();
  assert.deepEqual(rels, ["README.md", "docs/二进制.docx", "docs/需求.md"]);
  assert.equal(scan.files.find((f) => f.relPath === "README.md").readable, true);
  assert.equal(scan.files.find((f) => f.relPath === "docs/二进制.docx").readable, false);
  const built = await buildMaterialIndex(scan);
  assert.ok(built.index.includes("资料清单"));
  assert.equal(built.docs.length, 2); // 仅文本类
  assert.ok(built.docs.some((d) => d.title === "需求总纲")); // 取自首个一级标题
});

test("/api/projects/:id/intake：只写资料索引、不建条目；items/both/未知 mode 显式拒绝", async () => {
  const dir = makeTree();
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const post = (pathname, body) => router.route({ method: "POST", pathname, searchParams: new URLSearchParams(), body });
  const reject = async (mode, code) => {
    let err = null;
    try { await post("/api/projects/p1/intake", { mode }); } catch (e) { err = e; }
    assert.ok(err, `mode=${mode} 必须被拒绝，而不是静默按 doc 处理`);
    assert.equal(err.code, code, `mode=${mode}`);
    assert.equal(httpStatusFor(err), 400, `mode=${mode} 必须 400`);
    return err;
  };

  const first = await post("/api/projects/p1/intake", {});
  assert.equal(first.status, 201);
  assert.equal(first.payload.scanned, 3);
  assert.ok(first.payload.doc && first.payload.doc.bytes > 0);
  assert.ok(store.getRequirementDoc("p1").body.includes("资料清单"));
  // FR-57（2026-10-29 修订 · A）：引入**不产生条目**；响应体也不再带 itemsCreated / items
  assert.equal(store.listRequirementItems({ projectId: "p1" }).length, 0);
  assert.equal("itemsCreated" in first.payload, false);
  assert.equal("items" in first.payload, false);

  const second = await post("/api/projects/p1/intake", {});
  assert.equal(second.status, 201);
  assert.ok(second.payload.doc.version > first.payload.doc.version); // 索引幂等更新
  assert.equal(store.listRequirementItems({ projectId: "p1" }).length, 0);

  // 门：显式拒绝 + **零副作用**（索引版本不前进）
  const before = store.getRequirementDoc("p1").version;
  await reject("items", "INTAKE_ITEMS_DISABLED");
  await reject("both", "INTAKE_ITEMS_DISABLED");
  await reject("whatever", "USAGE_ERROR");
  assert.equal(store.getRequirementDoc("p1").version, before, "被拒绝的请求不得留下任何副作用");
  store.close();
});

test("/api/projects/:id/settings：保存并读回 项目环境约束 + 团队模板", async () => {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1" });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });

  const empty = await call("GET", "/api/projects/p1/settings", {});
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.payload.envConfig, {});

  const saved = await call("PUT", "/api/projects/p1/settings", {
    envConfig: { language: "zh-CN", node: ">=20", notes: "本地优先；不改需求正文" },
    teamTemplate: {
      roles: [{ role: "lead", count: 1 }, { role: "engineer", count: 2, executor: "cli:claude" }],
      qualityGates: ["需求", "实现", "验证", "审查"],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.envConfig.language, "zh-CN");
  assert.equal(saved.payload.teamTemplate.roles.length, 2);

  const again = await call("GET", "/api/projects/p1/settings", {});
  assert.equal(again.payload.teamTemplate.roles[1].executor, "cli:claude");
  store.close();
});

test("intake 范围过滤：include / exclude / exts", async () => {
  const dir = makeTree();
  const onlyDocs = await scanProjectMaterials(dir, { include: ["docs"] });
  assert.deepEqual(onlyDocs.files.map((f) => f.relPath).sort(), ["docs/二进制.docx", "docs/需求.md"]);
  const noDocs = await scanProjectMaterials(dir, { exclude: ["docs"] });
  assert.deepEqual(noDocs.files.map((f) => f.relPath), ["README.md"]);
  const mdOnly = await scanProjectMaterials(dir, { exts: [".md"] });
  assert.deepEqual(mdOnly.files.map((f) => f.relPath).sort(), ["README.md", "docs/需求.md"]);
});

test("历史 source=intake 条目仍可改状态(PATCH)与删除(DELETE)（能力 2026-10-29 迁 FR-35）", async () => {
  const dir = makeTree();
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });

  // 引入不再产出条目（A），所以这里**直接 seed 历史存量**：验证「老数据仍可查、可改、可删」不被 A 打破。
  for (const t of ["需求总纲", "项目简介"]) {
    store.createRequirementItem({ projectId: "p1", title: t, description: `来源：\`docs/${t}.md\``, source: "intake", status: "draft" });
  }
  const items = store.listRequirementItems({ projectId: "p1" });
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.status === "draft" && i.source === "intake"));
  assert.equal(store.listRequirementItems({ projectId: "p1", status: "draft" }).length, 2);

  const one = items[0];
  const patched = await call("PATCH", `/api/requirements/items/${one.identifier}`, { status: "open" });
  assert.equal(patched.payload.item.status, "open");

  const del = await call("DELETE", `/api/requirements/items/${one.identifier}`, {});
  assert.equal(del.payload.deleted, true);
  assert.equal(store.listRequirementItems({ projectId: "p1" }).length, 1);
  store.close();
});

test("intake extraPaths：按引用纳入工作区外文件（不拷贝）", async () => {
  const dir = makeTree();
  const external = join(tmpdir(), `tb-ext-${Date.now()}.md`);
  TEMPS.push(external);
  writeFileSync(external, "# 外部取证\n\n技术细节\n");
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });

  const dry = await call("POST", "/api/projects/p1/intake", { extraPaths: [external], dryRun: true });
  assert.equal(dry.payload.scanned, 4); // 3 篇内置 + 1 外部
  assert.ok(dry.payload.files.some((f) => f.external && f.relPath.includes("«外部»")));

  const res = await call("POST", "/api/projects/p1/intake", { extraPaths: [external], mode: "doc" });
  assert.equal(res.status, 201);
  assert.ok(store.getRequirementDoc("p1").body.includes("外部取证")); // 外部文件进索引
  assert.equal(store.listRequirementItems({ projectId: "p1" }).length, 0); // 但**不建条目**
  store.close();
});

test("FR-57 不变量：任意顺序连续 3 次引入后 requirement_items 计数恒定（幂等）", async () => {
  const dir = makeTree();
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const post = (body) => router.route({ method: "POST", pathname: "/api/projects/p1/intake", searchParams: new URLSearchParams(), body });

  const count = () => store.listRequirementItems({ projectId: "p1" }).length;
  assert.equal(count(), 0);

  const modes = [{}, { mode: "doc" }, {}]; // 缺省 / 显式 doc / 再缺省
  for (const body of modes) {
    const r = await post(body);
    assert.equal(r.status, 201);
    assert.equal(count(), 0, `第 ${modes.indexOf(body) + 1} 次引入后条目数必须仍为 0`);
  }
  const doc = store.getRequirementDoc("p1");
  assert.ok(doc.version >= 3, `索引应被更新 3 次，实际 version=${doc.version}`);
  assert.ok(doc.body.includes("资料清单"));
  store.close();
});
