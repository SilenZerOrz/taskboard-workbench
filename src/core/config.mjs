/**
 * 运行期配置：数据目录解析（FR-31/FR-33）。
 * 优先级：显式参数 --data-dir > 环境变量 TB_DATA_DIR > 默认临时目录。
 * 默认放临时目录，保证"运行不写仓库"（本机仓库目录只读）。
 */
import os from "node:os";
import path from "node:path";

export const DEFAULT_DATA_DIR = path.join(os.tmpdir(), "tb-workbench-mvp-a");
export const DB_FILENAME = "taskboard.sqlite";

export function resolveDataDir({ dataDir, env = process.env } = {}) {
  const fromArg = typeof dataDir === "string" ? dataDir.trim() : "";
  if (fromArg) return path.resolve(fromArg);
  const fromEnv = typeof env.TB_DATA_DIR === "string" ? env.TB_DATA_DIR.trim() : "";
  if (fromEnv) return path.resolve(fromEnv);
  return DEFAULT_DATA_DIR;
}

export function resolveDbPath(dataDir) {
  return path.join(dataDir, DB_FILENAME);
}
