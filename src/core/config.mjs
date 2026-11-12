/**
 * 运行期配置：数据目录解析（FR-31/FR-33）。
 * 优先级：显式参数 --data-dir > 环境变量 TB_DATA_DIR > 默认目录。
 *
 * 默认目录（2026-11-10 · 卡 `-236` / 需求 `R173` 改）：
 *   `~/.dsh/data/taskboard-workbench`
 *   原默认是 `os.tmpdir()/tb-workbench-mvp-a` —— 两个问题：
 *   ① **临时目录会被 macOS 定期清理** ⇒ 看板数据随时静默消失；
 *   ② dsh web 与 dsh desktop 是**两个宿主**，只要有一边没显式配 `dataDir`，就会落到
 *      自己解析的默认位置，于是「两边看到两份库」（真机：web 264 张卡 / desktop 0 张）。
 *   改成用户目录下的固定路径后，**两个宿主不配置也是同一份库**。
 */
import os from "node:os";
import path from "node:path";

export const DEFAULT_DATA_DIR = path.join(os.homedir(), ".dsh", "data", "taskboard-workbench");
/** 旧默认目录：**只用于「空库检测 / 迁移提示」**，不再作为任何写入目标。 */
export const LEGACY_DATA_DIR = path.join(os.tmpdir(), "tb-workbench-mvp-a");
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
