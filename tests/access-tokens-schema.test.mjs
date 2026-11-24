/**
 * schema 16：`access_tokens` 载体表（卡 `-297` · 需求 `R193`/`R194` · FR-117 设计稿 `-289` §3.2）
 *
 * 守的是三件事：
 * ① 新库一开就有表 + 两个索引（否则 `-300` 的撤销/过期/scope 全都无处落地）；
 * ② **老库（15）升级幂等**：重开即补齐，且**一行业务数据都不动**（迁移只加表，不重建）；
 * ③ 列集合与设计稿逐字一致 —— 少了 `revoked_at`/`expires_at`/`scopes` 就等于「撤不掉 / 过期不了 / 限不了范围」。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { openStore, SCHEMA_VERSION } from "../src/core/store.mjs";

const freshDir = (label) => mkdtempSync(path.join(os.tmpdir(), `tb-s16-${label}-`));
const withRaw = (dbPath, fn) => {
  const db = new DatabaseSync(dbPath);
  try { return fn(db); } finally { db.close(); }
};

test("schema 16：版本号与设计稿一致（15 → 16）", () => {
  assert.equal(SCHEMA_VERSION, 16);
});

test("新库：access_tokens 表与两个索引都在，列集合与设计稿一致", () => {
  const dir = freshDir("fresh");
  const store = openStore({ dataDir: dir });
  try {
    assert.equal(store.schemaVersion, 16);
    withRaw(store.dbPath, (db) => {
      const tables = db.prepare("select name from sqlite_master where type='table' order by name").all().map((r) => r.name);
      assert.ok(tables.includes("access_tokens"), "access_tokens 表必须存在");
      const indexes = db.prepare("select name from sqlite_master where type='index' and tbl_name='access_tokens'").all().map((r) => r.name);
      assert.ok(indexes.includes("access_tokens_hash_idx"), "token_hash 索引必须存在（每请求按 hash 现查）");
      assert.ok(indexes.includes("access_tokens_live_idx"), "撤销/过期索引必须存在（判活口径的扫描面）");
      const cols = db.prepare("pragma table_info(access_tokens)").all().map((r) => r.name);
      assert.deepEqual(cols, [
        "id", "label", "role", "actor", "token_hash", "token_prefix", "scopes", "project_scope",
        "created_at", "created_by", "expires_at", "revoked_at", "revoked_by", "revoke_reason", "last_used_at",
      ]);
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("老库升级：删表后重开即补齐，业务数据一行不动", () => {
  const dir = freshDir("upgrade");
  const first = openStore({ dataDir: dir });
  const taskId = (() => {
    first.createProject({ id: "demo", name: "Demo" });
    return first.createTask({ projectId: "demo", title: "老库里的卡" }).identifier;
  })();
  const dbPath = first.dbPath;
  first.close();

  // 模拟 schema 15 的库：只有缺表这件事与 15 一致，业务行保留
  withRaw(dbPath, (db) => {
    db.exec("drop index if exists access_tokens_hash_idx");
    db.exec("drop index if exists access_tokens_live_idx");
    db.exec("drop table if exists access_tokens");
  });

  const second = openStore({ dataDir: dir });
  try {
    assert.equal(second.schemaVersion, 16);
    const tables = withRaw(dbPath, (db) => db.prepare("select name from sqlite_master where type='table' and name='access_tokens'").all());
    assert.equal(tables.length, 1, "重开必须把表补回来");
    assert.ok(second.getTaskByIdentifier(taskId), "业务数据不得因迁移丢失");
    assert.equal(second.listTasks({ projectId: "demo" }).length, 1);
  } finally {
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等：重开三次，表结构不变、已有令牌行不被覆盖", () => {
  const dir = freshDir("idem");
  const first = openStore({ dataDir: dir });
  const dbPath = first.dbPath;
  first.close();

  withRaw(dbPath, (db) => {
    db.prepare(`insert into access_tokens (id,label,role,actor,token_hash,token_prefix,scopes,created_at)
                values ('t1','张三 · 笔记本','human','human:zhangsan','hash-1','abcd1234','["read:guest"]','2026-11-24T00:00:00.000Z')`).run();
  });

  for (let i = 0; i < 2; i += 1) {
    const again = openStore({ dataDir: dir });
    try {
      assert.equal(again.schemaVersion, 16);
      const rows = withRaw(dbPath, (db) => db.prepare("select id, token_hash, revoked_at from access_tokens").all());
      assert.equal(rows.length, 1, "迁移不得清空令牌行");
      assert.equal(rows[0].token_hash, "hash-1");
      assert.equal(rows[0].revoked_at, null);
    } finally {
      again.close();
    }
  }
  rmSync(dir, { recursive: true, force: true });
});
