// 环境自检工具：确认本项目代码在本机可运行的最小前提。
// 用法：node tools/env-check.mjs   （cwd = 本项目根目录）
import { DatabaseSync } from "node:sqlite";
import { writeFileSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const out = { node: process.version, cwd: process.cwd() };

try {
  const db = new DatabaseSync(":memory:");
  db.exec("create table t(a integer)");
  db.prepare("insert into t values (?)").run(1);
  const row = db.prepare("select count(*) as n from t").get();
  out.nodeSqlite = `ok (rows=${row.n})`;
} catch (e) {
  out.nodeSqlite = `FAIL: ${e.message}`;
}

try {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-probe-"));
  writeFileSync(path.join(dir, "x.txt"), "1");
  out.tmpWrite = "ok";
} catch (e) {
  out.tmpWrite = `FAIL: ${e.code || e.message}`;
}

try {
  writeFileSync(path.join(process.cwd(), ".perm-write-test"), "1");
  out.repoWrite = "ok";
} catch (e) {
  out.repoWrite = `FAIL: ${e.code || e.message}`;
}

console.log(JSON.stringify(out, null, 2));
