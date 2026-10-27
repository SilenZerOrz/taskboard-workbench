/** 项目资料引入（intake）+ 项目设置（环境约束 / 团队模板）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
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

test("/api/projects/:id/intake：写入需求文档 + 生成条目；重复执行不重复建条目", async () => {
  const dir = makeTree();
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const post = (pathname, body) => router.route({ method: "POST", pathname, searchParams: new URLSearchParams(), body });

  const first = await post("/api/projects/p1/intake", {});
  assert.equal(first.status, 201);
  assert.equal(first.payload.scanned, 3);
  assert.equal(first.payload.itemsCreated, 2);
  assert.ok(first.payload.doc && first.payload.doc.bytes > 0);
  assert.ok(store.getRequirementDoc("p1").body.includes("资料清单"));
  assert.equal(store.listRequirementItems({ projectId: "p1" }).length, 2);

  const second = await post("/api/projects/p1/intake", {});
  assert.equal(second.payload.itemsCreated, 0); // 幂等：不重复建条目
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

test("intake 生成条目默认 draft/intake；条目可改状态(PATCH)与删除(DELETE)", async () => {
  const dir = makeTree();
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: dir });
  const router = createApiRouter({ store });
  const call = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });

  const res = await call("POST", "/api/projects/p1/intake", {});
  assert.equal(res.status, 201);
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

  await call("POST", "/api/projects/p1/intake", { extraPaths: [external], mode: "items" });
  assert.ok(store.listRequirementItems({ projectId: "p1" }).some((i) => i.title === "外部取证"));
  store.close();
});
