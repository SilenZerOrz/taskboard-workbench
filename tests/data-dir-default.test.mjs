/**
 * 卡 `-236` / 需求 `R173`：数据目录默认值不再放系统临时目录。
 *
 * 真机 2026-11-10：dsh web 显式配了 `dataDir=<仓库>/.data`，dsh desktop **一条都没配** ⇒
 * 落到 `os.tmpdir()/tb-workbench-mvp-a` ⇒ 同一个插件在两个宿主里看到两份库
 * （web 264 张卡 / desktop 0 张），且临时目录会被 macOS 清理 ⇒ 静默丢数据。
 *
 * 本组只钉「默认值 + 优先级」这两件事，保证：
 *  ① 不配置的宿主也落到**同一个**用户目录（两个宿主默认对齐）；
 *  ② 显式 `--data-dir` / `TB_DATA_DIR` 的老行为一字不变（不许因为改默认值把显式配置顶掉）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

import { DEFAULT_DATA_DIR, LEGACY_DATA_DIR, DB_FILENAME, resolveDataDir, resolveDbPath } from "../src/core/config.mjs";

test("默认数据目录 = ~/.dsh/data/taskboard-workbench（不再落系统临时目录）", () => {
  assert.equal(DEFAULT_DATA_DIR, path.join(os.homedir(), ".dsh", "data", "taskboard-workbench"));
  assert.notEqual(DEFAULT_DATA_DIR, LEGACY_DATA_DIR, "默认值必须已经离开临时目录");
});

test("旧默认目录只作为迁移提示常量保留，且确实在系统临时目录下", () => {
  assert.equal(LEGACY_DATA_DIR, path.join(os.tmpdir(), "tb-workbench-mvp-a"));
  assert.ok(LEGACY_DATA_DIR.startsWith(os.tmpdir()), "旧目录判定必须能在真机上认出它");
});

test("优先级：显式 dataDir > TB_DATA_DIR > 默认目录", () => {
  const env = { TB_DATA_DIR: "/tmp/tb-from-env" };
  assert.equal(resolveDataDir({ dataDir: "/tmp/tb-from-arg", env }), path.resolve("/tmp/tb-from-arg"));
  assert.equal(resolveDataDir({ env }), path.resolve("/tmp/tb-from-env"));
  assert.equal(resolveDataDir({ env: {} }), DEFAULT_DATA_DIR);
});

test("空白值不算配置（不许把 dataDir 顶成空串后落到 cwd）", () => {
  assert.equal(resolveDataDir({ dataDir: "   ", env: { TB_DATA_DIR: "  " } }), DEFAULT_DATA_DIR);
  assert.equal(resolveDataDir({ dataDir: "  /tmp/tb-x  ", env: {} }), path.resolve("/tmp/tb-x"));
});

test("库文件名固定，resolveDbPath 与数据目录同源", () => {
  assert.equal(DB_FILENAME, "taskboard.sqlite");
  assert.equal(resolveDbPath("/tmp/tb-dir"), path.join("/tmp/tb-dir", "taskboard.sqlite"));
});
