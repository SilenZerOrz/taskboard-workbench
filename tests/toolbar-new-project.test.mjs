import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 真机 2026-10-23 用户报障：「从 dsh 左侧菜单栏进任务工作台，想新建项目找不到入口，
// 配置页只能切换已有项目不能新增；页面上的『新建任务』按钮无意义无用」。
// 本组断言锁住四件事：① 工具栏有「新建项目」且与「新建任务」一起入 toolbar；
// ②「新建任务」只在看板视图显示；③ 配置页也能新建项目；④ 统一流程真调 POST /api/projects
// 并切换当前项目 + 让本会话成为主会话（resolveBinding）。
const src = readFileSync(new URL("../web/app.js", import.meta.url), "utf8");

test("工具栏提供「新建项目」，并与「新建任务」一并入 toolbar", () => {
  assert.ok(src.includes('const newProject = mk("button", "ghost", "新建项目");'));
  assert.ok(src.includes('toolbar.append(summary, wdNotice, archivedToggle, loopToggle, newProject, newTask);'));
});

test("「新建任务」只在看板视图显示（非看板视图不再出现无效按钮）", () => {
  assert.ok(src.includes('newTask.hidden = next !== "board";'));
});

test("「新建项目」走统一流程 createProjectFlow：POST /api/projects + 切换项目 + 绑定本会话", () => {
  assert.ok(src.includes('async function createProjectFlow()'));
  const fn = src.slice(src.indexOf("async function createProjectFlow()"));
  assert.ok(fn.includes('api("POST", "/api/projects", { name: name.trim(), workspacePath:'));
  assert.ok(fn.includes('state.projectId = r.project.id;'));
  assert.ok(fn.includes('await resolveBinding(state.projectId);'));
  assert.ok(src.includes('newProject.addEventListener("click", () => void createProjectFlow());'));
});

test("配置页「当前绑定」也能新建项目（此前只有「前往需求视图」）", () => {
  assert.ok(src.includes('btn("新建项目", () => void createProjectFlow(), "primary")'));
});
