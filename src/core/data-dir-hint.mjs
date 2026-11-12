/**
 * data-dir-hint.mjs —— 「你这个库是空的，但旧默认目录里还有数据」的**只读**检测（卡 `-236` / 需求 `R173`）。
 *
 * 为什么需要它：默认目录从 `os.tmpdir()/tb-workbench-mvp-a` 改到 `~/.dsh/data/taskboard-workbench` 之后，
 * 老用户的卡还在旧目录里。如果只是静默换目录，用户看到的就是「升级后看板全空」——比原来的 bug 更吓人。
 * 所以启动时做一次**只读**对照：新库 0 张卡 + 旧库有卡 ⇒ 打一条明确的迁移提示（并在 /api/health 里带出来）。
 *
 * 边界（都很硬）：
 *  - **不复制、不删除、不写入**旧库；只读打开 + 一条 count。旧库打开失败一律当"没有提示"，绝不打断启动。
 *  - 新库已经有卡 ⇒ 不提示（用户显然已在用新目录）。
 *  - 两个目录相同（用户显式把 dataDir 指回旧目录）⇒ 不提示。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILENAME, LEGACY_DATA_DIR } from "./config.mjs";

export function detectLegacyDataHint({
  dataDir,
  activeTaskCount = 0,
  legacyDir = LEGACY_DATA_DIR,
  dbFilename = DB_FILENAME,
} = {}) {
  if (!dataDir || !legacyDir) return null;
  if (path.resolve(String(dataDir)) === path.resolve(String(legacyDir))) return null;
  if (Number(activeTaskCount) > 0) return null;

  const legacyDbPath = path.join(legacyDir, dbFilename);
  if (!existsSync(legacyDbPath)) return null;

  let legacyTaskCount = 0;
  try {
    const db = new DatabaseSync(legacyDbPath, { readOnly: true });
    try {
      const row = db.prepare("select count(*) as n from tasks").get();
      legacyTaskCount = Number(row?.n ?? 0);
    } finally { db.close(); }
  } catch {
    return null; // 旧库读不开（权限 / 损坏 / 不是本插件库）⇒ 不当提示，更不当错误
  }
  if (legacyTaskCount <= 0) return null;

  return {
    reason: "EMPTY_ACTIVE_WITH_LEGACY_DATA",
    dataDir: path.resolve(String(dataDir)),
    legacyDir: path.resolve(String(legacyDir)),
    legacyDbPath,
    legacyTaskCount,
    hint: `当前数据目录（${path.resolve(String(dataDir))}）没有任务，但旧默认目录 ${legacyDir} 里有 ${legacyTaskCount} 张卡。要看旧数据：把 dataDir 指回旧目录（TB_DATA_DIR=… 或插件配置 dataDir），或自行把 ${dbFilename} 复制过来后重启。本插件不会自动搬库。`,
  };
}
