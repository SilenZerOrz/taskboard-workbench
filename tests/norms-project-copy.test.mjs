/**
 * 卡 `-216`（需求 `R160`）· 项目级机器规范：默认随包 + 项目副本 + 逐份回落。
 *
 * 为什么：`spec/norms/*.md` 是**包内**规范，用户想按自己团队口径改，只能改 `node_modules`（升级即丢）；
 * 而 `docs/规范/07-条目详情规范.md` 住在被 gitignore 的 `docs/` 里 —— 没有 git 历史、不进包、
 * 没有 version/digest ⇒ `NORM_STALE` 护不到它。本卡把它收进 `spec/norms/item-detail.md`，
 * 并给每个项目一份可改副本 `<工作区>/.taskboard/norms/`。
 *
 * 三条口径（人已拍）：D-A 位置 `.taskboard/norms/` · D-B 只在显式动作时复制 · D-C 改正文必须 bump version。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NORM_IDS, loadNorms } from "../src/core/contract.mjs";
import { PROJECT_NORMS_SUBDIR, materializeProjectNorms, normsView, projectNormsDir } from "../src/core/norms.mjs";
import { openStore } from "../src/core/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = path.join(ROOT, "spec", "norms");
const freshWs = (tag) => mkdtempSync(path.join(os.tmpdir(), `tb-norms-${tag}-`));

test("A 第六份规范在位：`item-detail` 进 NORM_IDS，且 manifest 与文件一致", () => {
  assert.ok(NORM_IDS.includes("item-detail"), "`item-detail` 必须在随包规范白名单里");
  assert.equal(NORM_IDS.length, 6);
  const manifest = JSON.parse(readFileSync(path.join(PKG, "manifest.json"), "utf8"));
  assert.ok(manifest.norms.some((n) => n.norm_id === "item-detail"), "manifest 必须登记 item-detail");
  const check = spawnSync(process.execPath, [path.join(ROOT, "tools/build-norms.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(check.status, 0, `build-norms --check 必须 0（实际 ${check.status}）：${check.stderr}`);
});

test("B 不是空壳：`item-detail.md` 真写清两轨骨架与预算", () => {
  const body = loadNorms(PKG).find((n) => n.id === "item-detail").body;
  for (const key of ["任务卡", "需求条目", "目标", "范围", "禁止", "验收", "关联", "1200", "800"]) {
    assert.ok(body.includes(key), `机器规范正文必须含「${key}」—— 文件在、内容不在等于没规范`);
  }
});

test("C materialize：显式动作才复制，且 6 份 + README + manifest 都到位", () => {
  const ws = freshWs("c");
  try {
    assert.equal(existsSync(projectNormsDir(ws)), false, "复制前不应有目录");
    const out = materializeProjectNorms({ packagedDir: PKG, workspacePath: ws });
    assert.equal(out.count, 6);
    assert.equal(out.written.length, 6);
    const dir = path.join(ws, PROJECT_NORMS_SUBDIR);
    for (const n of loadNorms(PKG)) assert.ok(existsSync(path.join(dir, path.basename(n.file))), `${n.id} 必须落盘`);
    assert.ok(existsSync(path.join(dir, "README.md")), "必须带 README（说明怎么改、要不要入库由用户定）");
    assert.ok(existsSync(path.join(dir, "manifest.json")), "必须带 manifest（副本可自检）");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("D **逐份回落**（反向对照）：删掉副本里一份 ⇒ 该份回落包内，其余仍用副本，不报错", () => {
  const ws = freshWs("d");
  try {
    materializeProjectNorms({ packagedDir: PKG, workspacePath: ws });
    // 让副本与包内**可区分**：改一份**正文** + bump version（只改 version 不改正文的话 digest 不变 ⇒ 不算 modified）
    const target = path.join(ws, PROJECT_NORMS_SUBDIR, "flow.md");
    const edited = readFileSync(target, "utf8")
      .replace("version: 1", "version: 9")
      .replace("# flow · 主流程八步（机器版）", "# flow · 主流程八步（本项目口径：第八步多一道口头确认）");
    writeFileSync(target, edited, "utf8");
    unlinkSync(path.join(ws, PROJECT_NORMS_SUBDIR, "item-detail.md"));

    const view = normsView({ packagedDir: PKG, workspacePath: ws });
    assert.equal(view.source, "project");
    assert.equal(view.norms.length, 6, "仍是 6 份 —— 不是整目录回落");
    assert.deepEqual(view.fallbackIds, ["item-detail"], "只有被删的那份回落");
    assert.equal(view.norms.find((n) => n.id === "item-detail").origin, "packaged");
    assert.equal(view.norms.find((n) => n.id === "flow").origin, "project");
    assert.equal(view.norms.find((n) => n.id === "flow").version, 9, "副本里的版本号必须生效");
    assert.equal(view.norms.find((n) => n.id === "flow").modified, true);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("E 陌生文件不炸：README / 用户笔记（无 frontmatter）被忽略并列出来", () => {
  const ws = freshWs("e");
  try {
    materializeProjectNorms({ packagedDir: PKG, workspacePath: ws });
    writeFileSync(path.join(ws, PROJECT_NORMS_SUBDIR, "notes.md"), "我的私人笔记，不是规范\n", "utf8");
    const view = normsView({ packagedDir: PKG, workspacePath: ws });
    assert.equal(view.norms.length, 6);
    const files = view.ignoredFiles.map((x) => `${x.file}:${x.reason}`);
    assert.ok(files.includes("notes.md:no-frontmatter"), `陌生文件应被忽略并说明原因，实际 ${JSON.stringify(files)}`);
    assert.ok(files.includes("README.md:no-frontmatter"), "自带 README 也应被忽略而不是解析失败");
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("F D-C：改副本正文不 bump version ⇒ `build-norms --dir … --check` 退出码 1", () => {
  const ws = freshWs("f");
  try {
    materializeProjectNorms({ packagedDir: PKG, workspacePath: ws });
    const dir = path.join(ws, PROJECT_NORMS_SUBDIR);
    const file = path.join(dir, "flow.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n偷偷加一句\n`, "utf8");

    const bad = spawnSync(process.execPath, [path.join(ROOT, "tools/build-norms.mjs"), "--dir", dir, "--check"], { encoding: "utf8" });
    assert.equal(bad.status, 1, "改了正文没 bump ⇒ 必须红（否则 digest 守卫形同虚设）");
    assert.match(`${bad.stderr}${bad.stdout}`, /NORM_VERSION_NOT_BUMPED|version/i);

    // 反向：bump 之后只需重生成 manifest ⇒ 转绿
    writeFileSync(file, readFileSync(file, "utf8").replace("version: 1", "version: 2"), "utf8");
    const regen = spawnSync(process.execPath, [path.join(ROOT, "tools/build-norms.mjs"), "--dir", dir], { encoding: "utf8" });
    assert.equal(regen.status, 0, regen.stderr);
    const good = spawnSync(process.execPath, [path.join(ROOT, "tools/build-norms.mjs"), "--dir", dir, "--check"], { encoding: "utf8" });
    assert.equal(good.status, 0, `bump 后应转绿：${good.stderr}`);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("G 契约真读副本：副本里 bump 一份 ⇒ contractVersion 变（证不是只读了包内）", () => {
  const ws = freshWs("g");
  try {
    const store = openStore({ dbPath: ":memory:" });
    store.createProject({ id: "p1", name: "P1", workspacePath: ws });
    const before = store.contractSnapshot("p1");
    assert.equal(before.normsSource, "packaged");

    materializeProjectNorms({ packagedDir: PKG, workspacePath: ws });
    const dir = path.join(ws, PROJECT_NORMS_SUBDIR);
    const file = path.join(dir, "acceptance.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("version: 2", "version: 3"), "utf8");

    const after = store.contractSnapshot("p1");
    assert.equal(after.normsSource, "project");
    assert.notEqual(after.snapshot.contractVersion, before.snapshot.contractVersion, "副本生效必须反映到契约版本");
    store.close();
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("H 边界：无工作区不静默写；建项目也不自动生成副本（D-B）", () => {
  assert.throws(() => materializeProjectNorms({ packagedDir: PKG, workspacePath: null }), /WORKSPACE_MISSING|工作区/);
  const ws = freshWs("h");
  try {
    const store = openStore({ dbPath: ":memory:" });
    store.createProject({ id: "p2", name: "P2", workspacePath: ws });
    assert.equal(existsSync(projectNormsDir(ws)), false, "建项目不得静默写用户工作区（只在配置页点按钮时复制）");
    assert.equal(store.contractSnapshot("p2").normsSource, "packaged");
    store.close();
  } finally { rmSync(ws, { recursive: true, force: true }); }
});
