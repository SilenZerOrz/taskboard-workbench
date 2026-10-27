/**
 * seed.mjs —— 灌入体现 agent team 语义的示例数据（幂等：项目已有任务则跳过）。
 * owner 为 tasks 表正式字段（t24 起不再写 owner: 标签）。
 * 用法：TB_DATA_DIR=/path/to/taskboard-data node tools/seed.mjs
 */
import { resolveDataDir } from "../src/core/config.mjs";
import { openStore } from "../src/core/store.mjs";

const PROJECTS = [
  {
    id: "workbench",
    name: "Agent Team 工作台（自研）",
    tasks: [
      { title: "看板骨架：七状态分列渲染", description: "按状态分列渲染任务卡；卡片显示编号/标题/优先级/标签/负责人。", status: "done", priority: "high", owner: "engineer", labels: ["看板", "MVP-A+"] },
      { title: "HTTP API：任务列表/创建/更新/删除", description: "零依赖 node:http；写操作带 version 乐观锁。", status: "in_review", priority: "high", owner: "engineer", labels: ["API"] },
      { title: "验收：浏览器可打开且能改状态", description: "在真实浏览器打开看板，点按钮改状态后刷新仍保持。", status: "in_progress", priority: "urgent", owner: "tester", labels: ["验收"] },
      { title: "示例数据：角色与状态分布", description: "planner/engineer/tester/reviewer/archivist 五角色，七状态各有代表任务。", status: "in_progress", priority: "medium", owner: "planner", labels: ["数据"] },
      { title: "评审：API 契约与前端一致性", description: "核对退出码/JSON 形状与前端调用一致；检查乐观锁冲突提示。", status: "todo", priority: "medium", owner: "reviewer", labels: ["评审"] },
      { title: "待授权：会话关联（MVP-C）", description: "把任务与会话双向关联；本阶段不做，先登记在待办池。", status: "backlog", priority: "low", owner: "planner", labels: ["MVP-C"] },
      { title: "受阻：浏览器自动化截图环境", description: "沙箱下 headless Chrome 不退出，截图改由人工核对页面 HTML。", status: "blocked", priority: "low", owner: "tester", labels: ["环境"] },
      { title: "已取消：甘特视图", description: "不在 MVP-A+ 范围，明确取消。", status: "canceled", priority: "none", owner: "archivist", labels: ["不做"] },
      { title: "文档：MVP-A+ 交付说明", description: "文件清单、API 一览、启动方式、实测命令与输出、已知限制。", status: "todo", priority: "high", owner: "archivist", labels: ["文档"] },
    ],
  },
  {
    id: "upstream",
    name: "上游 dashi-taskboard 参考",
    tasks: [
      { title: "样式 token 对照：38 个语义变量", description: "把上游 tokens 映射到本项目 tokens.css，含暗色覆盖。", status: "done", priority: "medium", owner: "engineer", labels: ["样式"] },
      { title: "参考实现盘点：看板与卡片职责", description: "见 docs/设计/前端样式与实现参考-2026-10-10.md。", status: "in_review", priority: "low", owner: "archivist", labels: ["参考"] },
    ],
  },
];

const store = openStore({ dataDir: resolveDataDir({ env: process.env }) });
const created = { projects: [], tasks: [] };
try {
  for (const spec of PROJECTS) {
    if (!store.getProject(spec.id)) {
      store.createProject({ id: spec.id, name: spec.name, workspacePath: null });
      created.projects.push(spec.id);
    }
    if (store.listTasks({ projectId: spec.id }).length > 0) continue;
    for (const task of spec.tasks) {
      const saved = store.createTask({
        projectId: spec.id,
        title: task.title,
        description: task.description,
        status: task.status,
        priority: task.priority,
        owner: task.owner,
        labels: task.labels,
      });
      created.tasks.push(saved.identifier);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    dataDir: store.dataDir,
    dbPath: store.dbPath,
    createdProjects: created.projects,
    createdTasks: created.tasks,
    stats: store.stats(),
  }, null, 2));
} finally {
  store.close();
}
