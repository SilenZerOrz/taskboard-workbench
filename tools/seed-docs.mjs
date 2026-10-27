/**
 * seed-docs.mjs —— 按【项目文档】把"开发卡片任务（开发→测试→交付）"完整填充到任务工作台。
 *
 * 数据来源：docs/需求文档.md、docs/计划文档.md、docs/进度/当前状态.md、docs/开发/README.md、
 *           docs/测试/README.md、docs/交付/README.md、docs/进度/2026-10-14-*.md。
 * 幂等：项目已存在且有任务则跳过（重复跑安全）。
 * 用法：TB_DATA_DIR=<目录> node tools/seed-docs.mjs      # 默认与插件同默认目录（os.tmpdir()/tb-workbench-mvp-a）
 */
import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { resolveDataDir, resolveDbPath } from "../src/core/config.mjs";
import { openStore } from "../src/core/store.mjs";

const REPLACE = process.argv.includes("--replace") || process.env.SEED_REPLACE === "1";

/** 整库重置（--replace）：先备份，再清空所有表（含项目），随后重灌。 */
function resetDatabase(dbPath) {
  if (existsSync(dbPath)) {
    const backup = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    try { copyFileSync(dbPath, backup); console.log(`[replace] 已备份：${backup}`); } catch (e) { console.warn(`[replace] 备份失败（继续）：${e.message}`); }
  }
  const db = new DatabaseSync(dbPath);
  // 全新/空的 DB 里还没有任何表：此时无可清空，交给 openStore 建表即可（否则 delete from tasks 会报 no such table）。
  const hasTasks = db.prepare("select 1 from sqlite_master where type='table' and name='tasks'").get() !== undefined;
  if (!hasTasks) { db.close(); return; }
  db.exec("pragma busy_timeout = 5000");
  db.exec("pragma foreign_keys = off");
  db.exec("begin immediate");
  for (const t of ["comments", "task_dependencies", "requirement_candidates", "requirement_items", "requirement_docs", "team_attempts", "team_tasks", "team_members", "team_runs", "governance_audit"]) {
    try { db.exec(`delete from ${t}`); } catch { /* 表可能不存在 */ }
  }
  db.exec("update tasks set parent_id = null");
  db.exec("delete from tasks");
  db.exec("delete from projects");
  db.exec("commit");
  db.exec("pragma foreign_keys = on");
  db.close();
}

const PROJECT_ID = "taskboard-workbench";
const PROJECT_NAME = "Taskboard Workbench · 03（AI 多项目任务工作台）";
const REPO = process.cwd();

// 阶段 → 子任务；子任务 = 开发卡片（可含测试/验收/交付/进度）
const PHASES = [
  {
    title: "P0 部署落地（基线/构建/服务）", status: "done", priority: "high", owner: "planner", labels: ["P0", "阶段"],
    children: [
      { title: "P0-1 仓库基线审计", status: "done", priority: "high", owner: "planner", labels: ["P0", "审计"], comments: ["克隆并固定 commit；工具链/网络边界核对；scripts 零偏差。"] },
      { title: "P0-2 依赖安装与本地服务构建启动", status: "done", priority: "high", owner: "engineer", labels: ["P0", "构建"], comments: ["npm install --cache + npm run build + npm start；/health、/api/projects、/api/events 均 200。"] },
      { title: "P0-3 Codex 内嵌部署（放弃）", status: "canceled", priority: "low", owner: "engineer", labels: ["P0", "不做"], comments: ["F-1：DOM 锚点 + 身份前置条件双不兼容；用户已决定放弃 Codex 内嵌，改走 DSH。"] },
    ],
  },
  {
    title: "P1 测试与评审", status: "done", priority: "high", owner: "tester", labels: ["P1", "阶段"],
    children: [
      { title: "P1-1 端到端测试（多项目跟踪）", status: "done", priority: "urgent", owner: "tester", labels: ["P1", "测试"], comments: ["E2E 31+25+8 全通过；缺陷清单 F-01..F-05（无 high 及以上功能缺陷）。"] },
      { title: "P1-2 部署与集成评审", status: "done", priority: "high", owner: "reviewer", labels: ["P1", "评审"], comments: ["8 个 P0 检查点独立复核；verdict = pass。"] },
      { title: "P1-3 优化回归（F-01/F-02）", status: "done", priority: "high", owner: "engineer", labels: ["P1", "回归"], comments: ["CLI 描述符读取可注入 + 测试隔离；组件测试 60s 预算 + 截断即 skip；退出码 0。"] },
      { title: "P1-4 文档归档与交付手册", status: "done", priority: "medium", owner: "archivist", labels: ["P1", "文档"] },
    ],
  },
  {
    title: "P2 DSH 方向（设计/评估）", status: "done", priority: "medium", owner: "planner", labels: ["P2", "阶段"],
    children: [
      { title: "P2-1 DSH 重开发设计参考", status: "done", priority: "medium", owner: "planner", labels: ["P2", "设计"], comments: ["上游领域模型 + DSH 插件架构取证；R1/R2/R3 对比与 R3→R2 推荐。"] },
      { title: "P2-3 R3 安装后验证矩阵（待用户执行）", status: "blocked", priority: "medium", owner: "tester", labels: ["P2", "待用户"], comments: ["阻塞：需用户终端安装 @shengsheng/dsh-taskboard 并按矩阵执行。"] },
    ],
  },
  {
    title: "P3 目标重定义（能力/样式/会话）", status: "done", priority: "medium", owner: "planner", labels: ["P3", "阶段"],
    children: [
      { title: "P3-1 工作台能力清单盘点", status: "done", priority: "medium", owner: "planner", labels: ["P3", "能力"] },
      { title: "P3-2 前端样式与实现参考", status: "done", priority: "medium", owner: "engineer", labels: ["P3", "样式"] },
      { title: "P3-3 DSH 会话双向关联可行性", status: "done", priority: "medium", owner: "reviewer", labels: ["P3", "可行性"] },
    ],
  },
  {
    title: "P5 需求文档口径（FR-01…33）", status: "done", priority: "high", owner: "planner", labels: ["P5", "需求"], 
    children: [
      { title: "需求文档改写为产品/功能需求（FR-01…33）", status: "done", priority: "high", owner: "planner", labels: ["P5", "需求"] },
      { title: "4 处口径修订（§4.2 升首期 / §4.3 拆分·补注）", status: "done", priority: "high", owner: "planner", labels: ["P5", "需求"] },
      { title: "基线条目四列写回（依赖/追溯/优先级/切片）", status: "done", priority: "high", owner: "planner", labels: ["P5", "需求"] },
      { title: "R-WS-41…73 判据建设与回填（00 对照表）", status: "done", priority: "high", owner: "planner", labels: ["P5", "判据"] },
    ],
  },
  {
    title: "P6 执行与编排（FR-34…43：需求→MVP→切片）", status: "in_progress", priority: "urgent", owner: "planner", labels: ["P6", "阶段"],
    children: [
      { title: "FR-34…43 需求定稿（四段式 + 切片）", status: "done", priority: "urgent", owner: "planner", labels: ["P6", "需求"] },
      { title: "MVP 实施 FR-34 需求文档", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "MVP 实施 FR-35 需求条目", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "MVP 实施 FR-36 条目化（AI 首选 / 规则 fallback）", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "MVP 实施 FR-37 可行性门（追加字段）", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "MVP 实施 FR-38 技术任务分拆", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "MVP 实施 FR-39 任务依赖（blocks + 环检测）", status: "done", priority: "high", owner: "engineer", labels: ["P6", "MVP"] },
      { title: "切片2 实施 FR-40/41（启动执行/跟踪·失败）", status: "done", priority: "urgent", owner: "engineer", labels: ["P6", "切片2"] },
      { title: "切片2 宿主接线（HostSessionPort 懒取 + D2 二次确认）", status: "done", priority: "urgent", owner: "engineer", labels: ["P6", "切片2", "宿主"] },
      { title: "切片3 沙箱部分（团队四表/任务级锁/治理红线/回流）", status: "done", priority: "high", owner: "engineer", labels: ["P6", "切片3"] },
      { title: "切片3 宿主集成（TeamEnginePort：默认 P2 / P1 占位）", status: "done", priority: "high", owner: "engineer", labels: ["P6", "切片3", "宿主"] },
      { title: "切片3 P1（agent-teams 直连）适配待评审", status: "in_review", priority: "medium", owner: "reviewer", labels: ["P6", "切片3", "评审"], comments: ["占位已就绪；待 T-5 运行时确认后切换 TEAM_ENGINE=agent-teams。"] },
    ],
  },
  {
    title: "测试与自验（R-WS 判据 / 回归）", status: "in_progress", priority: "urgent", owner: "tester", labels: ["测试", "阶段"],
    children: [
      { title: "单元/集成测试（73 → 76 例全绿）", status: "done", priority: "urgent", owner: "tester", labels: ["测试"], comments: ["node --test 76/76（含需求/依赖/执行/团队 全链路）。"] },
      { title: "R-WS-41…57 自验（MVP 分析链路）", status: "done", priority: "high", owner: "tester", labels: ["测试", "R-WS"], comments: ["17 例覆盖：文档/条目/条目化/可行性/分拆/依赖。"] },
      { title: "R-WS-58…63 自验（启动执行/跟踪）", status: "done", priority: "high", owner: "tester", labels: ["测试", "R-WS"], comments: ["6 例：session/degraded、未授权/未归因、SSE、失败/重试/释放。"] },
      { title: "R-WS-64…70 沙箱自验（团队/锁/治理/回流）", status: "done", priority: "high", owner: "tester", labels: ["测试", "R-WS"], comments: ["66/68/69/70 沙箱已验；64/65/67 待宿主。"] },
      { title: "T-2/T-3/T-5/T-6 四合一（本机验证）", status: "todo", priority: "urgent", owner: "tester", labels: ["测试", "待用户"], comments: ["清单：docs/交付/本机验证清单-四合一-2026-10-13.md；一键：bash tools/dsh-mvp-verify-all.sh"] },
      { title: "真机验证：面板可见 + 启动执行 + 派发", status: "todo", priority: "urgent", owner: "tester", labels: ["验收", "待用户"] },
      { title: "需求文档改写（FR 陈述/验收逐字保留）待复核", status: "in_review", priority: "medium", owner: "reviewer", labels: ["测试", "评审"], comments: ["四段式写回后逐字校验通过（依赖/追溯/优先级/切片）。"] },
    ],
  },
  {
    title: "DSH 宿主加载与体验修复", status: "in_progress", priority: "urgent", owner: "engineer", labels: ["宿主", "阶段"],
    children: [
      { title: "客户端 slot 注册（panellist + main，id==key）", status: "done", priority: "high", owner: "engineer", labels: ["宿主"] },
      { title: "宿主路由健壮化（懒取 + 服务出现重注册）", status: "done", priority: "urgent", owner: "engineer", labels: ["宿主", "修复"], comments: ["对齐 agent-teams 懒取模式；修复 app.js 404（路由未注册）。"] },
      { title: "app.js 404 竞态：客户端自动重试（300/800/2s/5s×5）", status: "done", priority: "urgent", owner: "engineer", labels: ["宿主", "修复"] },
      { title: "面板布局偏移：面板侧覆盖（--board-max-width:none / 外壳 height:100%）", status: "done", priority: "high", owner: "engineer", labels: ["宿主", "修复"] },
      { title: "插件安装到 DSH profile（用户终端）", status: "blocked", priority: "urgent", owner: "tester", labels: ["宿主", "待用户"], comments: ["阻塞：沙箱对 ~/.dsh 只读；解除=用户跑 bash tools/dsh-mvp-autostart.sh 或 dsh plugin --profile web add \"$REPO\"。"] },
    ],
  },
  {
    title: "交付与脚本", status: "done", priority: "high", owner: "archivist", labels: ["交付", "阶段"],
    children: [
      { title: "交付文档：DSH 安装与自检 / 加载与操作 / 四合一清单", status: "done", priority: "high", owner: "archivist", labels: ["交付", "文档"] },
      { title: "脚本：dsh-mvp-autostart.sh（一条命令自启动）", status: "done", priority: "high", owner: "engineer", labels: ["交付", "脚本"] },
      { title: "脚本：dsh-verify-mvp.mjs（token 自检）", status: "done", priority: "high", owner: "engineer", labels: ["交付", "脚本"] },
      { title: "脚本：dsh-mvp-verify-all.sh（真机验证 V1–V5 + 回传模板）", status: "done", priority: "urgent", owner: "engineer", labels: ["交付", "脚本"] },
    ],
  },
  {
    title: "文档与索引治理", status: "done", priority: "medium", owner: "archivist", labels: ["文档", "阶段"],
    children: [
      { title: "每轮必更新规范（当前状态 + 轮次记录 + 双索引）", status: "done", priority: "medium", owner: "archivist", labels: ["文档", "规范"] },
      { title: "文档索引审计与补全（设计 3 / 开发 5 / 交付 3）", status: "done", priority: "medium", owner: "archivist", labels: ["文档", "索引"] },
    ],
  },
  {
    title: "P4 迭代开发计划（待前置）", status: "todo", priority: "medium", owner: "planner", labels: ["P4", "计划"],
  },
  {
    title: "缺陷与遗留（F-01…F-05）", status: "backlog", priority: "low", owner: "tester", labels: ["缺陷", "看板"],
    children: [
      { title: "F-01 CLI 描述符读取不可注入（已修）", status: "done", priority: "medium", owner: "engineer", labels: ["缺陷", "已修"] },
      { title: "F-02 组件测试 30s 预算贴边（已修）", status: "done", priority: "medium", owner: "engineer", labels: ["缺陷", "已修"] },
      { title: "F-04 自定义 id 项目不可删（文档化）", status: "backlog", priority: "low", owner: "archivist", labels: ["缺陷", "延后"] },
      { title: "F-05 次状态议题空态无引导", status: "backlog", priority: "low", owner: "engineer", labels: ["缺陷", "延后"] },
    ],
  },
];

const dataDir = resolveDataDir({ env: process.env });
if (REPLACE) resetDatabase(resolveDbPath(dataDir));
const store = openStore({ dataDir });
const created = { project: null, tasks: [] };
try {
  if (!store.getProject(PROJECT_ID)) {
    store.createProject({ id: PROJECT_ID, name: PROJECT_NAME, workspacePath: REPO });
    created.project = PROJECT_ID;
  }
  const existing = store.listTasks({ projectId: PROJECT_ID });
  if (existing.length === 0) {
    for (const phase of PHASES) {
      const parent = store.createTask({
        projectId: PROJECT_ID, title: phase.title, description: `阶段：${phase.title}`,
        status: phase.status, priority: phase.priority, owner: phase.owner, labels: [...(phase.labels ?? []), "阶段"],
      });
      created.tasks.push(parent.identifier);
      if (phase.comments) for (const c of phase.comments) store.addComment(parent.id, { body: c });
      for (const child of phase.children ?? []) {
        const t = store.createTask({
          projectId: PROJECT_ID, title: child.title, description: child.description ?? "",
          status: child.status, priority: child.priority, owner: child.owner, labels: child.labels ?? [], parentId: parent.id,
        });
        created.tasks.push(t.identifier);
        if (child.comments) for (const c of child.comments) store.addComment(t.id, { body: c });
      }
    }
  }
  console.log(JSON.stringify({
    ok: true, dataDir: store.dataDir, dbPath: store.dbPath,
    project: PROJECT_ID, createdProject: created.project, createdTasks: created.tasks.length,
    skipped: created.tasks.length === 0 ? "项目已有任务（幂等跳过）" : undefined,
    stats: store.stats(),
  }, null, 2));
} finally {
  store.close();
}
