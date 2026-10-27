/**
 * FR-87（任务详情抽屉：布局与交互）/ FR-88（看板卡片折叠 · 软归档）专项测试。
 *
 *  · 呈现层契约用静态断言（不依赖浏览器）；行为断言落在 os.tmpdir() 临时目录，绝不写入仓库。
 *  · FR-88 的红线：折叠**只改 labels** —— 不改状态、不删数据、不动父子关系（子任务串完整）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

test("FR-87（修订）：抽屉宽度按视口分级放宽 + 左缘可拖拽 + 可全屏 + 宽屏两栏", () => {
  const css = read("web/tokens.css");
  const drawer = css.slice(css.indexOf(".tb-drawer {"), css.indexOf(".tb-drawer-head {"));
  assert.match(drawer, /width: var\(--drawer-width, min\(920px, calc\(100vw - 12px\)\)\)/, "抽屉默认宽度需保持 ≥920px 基线");
  assert.equal(/width: min\(560px/.test(drawer), false, "旧的 560px 上限必须被替换");
  // 真机二次报障：1988px 视口下旧口径只给到 1080px（54%），13 个区块仍全挤在一条竖列里 → 按视口分级放宽
  assert.match(css, /@media \(min-width: 1280px\) \{ \.tb-drawer \{ --drawer-width: min\(1160px, 88vw\); \} \}/, "≥1280px 需放宽");
  assert.match(css, /@media \(min-width: 1600px\) \{ \.tb-drawer \{ --drawer-width: min\(1440px, 86vw\); \} \}/, "≥1600px 需再放宽");
  assert.match(css, /@media \(min-width: 2200px\) \{ \.tb-drawer \{ --drawer-width: min\(1720px, 84vw\); \} \}/, "≥2200px 需再放宽");
  assert.match(css, /\.tb-drawer-resize \{/, "左缘需有拖拽手柄");
  assert.match(css, /\.tb-drawer-body\[data-cols="2"\] \{/, "够宽时正文需两栏");
  const source = read("web/app.js");
  assert.match(source, /tb\.drawer\.width/, "自定宽度需落盘记忆");
  assert.match(source, /"pointerdown"/, "需支持拖拽调宽");
  assert.match(source, /"全屏"/, "需有全屏档");
  assert.match(source, /全部收起/, "需有一键收起 / 展开全部区块");
  assert.match(source, /DRAWER_COLS_MIN_WIDTH/, "分栏阈值需按实测抽屉宽度判定（拖宽/全屏/改窗口都能重算）");
});

test("FR-87：分区可折叠 + ESC 关闭，且没有删掉任何内容区块", () => {
  const css = read("web/tokens.css");
  const source = read("web/app.js");
  assert.match(css, /\.drawer-section\.collapsed > \*:not\(h3\) \{ display: none; \}/, "折叠态样式缺失");
  assert.match(css, /\.drawer-section > h3 \{ cursor: pointer/, "分区标题需可点击（交互提示）");
  assert.match(source, /target\.closest\("\.drawer-section > h3"\)/, "点击分区标题需切换折叠");
  assert.match(source, /event\.key === "Escape"/, "ESC 需能关闭抽屉");
  assert.match(source, /state\.collapsedSections/, "折叠状态需按分区标题记忆");
  // 内容不动：这些区块一个都不能少
  for (const heading of ["概览", "人工校验（FR-85 人在环）", "尝试记录（", "事件流", "治理审计（"]) {
    assert.ok(source.includes(heading), `抽屉内容区块「${heading}」不得因布局调整被删`);
  }
});

test("FR-88：折叠 = 标签载体（不新增任务状态、不改后端契约）", () => {
  const source = read("web/app.js");
  const css = read("web/tokens.css");
  assert.match(source, /const ARCHIVE_LABEL = "archived";/);
  assert.match(
    source,
    /const visible = state\.showArchived \? state\.tasks : state\.tasks\.filter\(\(task\) => !isArchived\(task\)\);/,
    "折叠卡默认不进列",
  );
  assert.match(source, /archivedToggle/, "工具栏需有「显示已折叠」开关");
  assert.match(css, /\.archive-chip \{/, "折叠标记需有样式");
  assert.equal(/archived/.test(read("src/core/domain.mjs")), false, "折叠不得引入新的任务状态（状态是流程语义）");
});

test("FR-88：折叠 / 取消折叠只改 labels —— 状态、数据、父子关系全不变", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tb-fold-"));
  const store = openStore({ dataDir: dir });
  try {
    const project = store.createProject({ name: "Fold Demo" });
    const umbrella = store.createTask({ projectId: project.id, title: "主任务", status: "in_review" });
    const child = store.createTask({ projectId: project.id, title: "子任务", parentId: umbrella.identifier, status: "done" });

    const before = store.getTaskRef(umbrella.identifier);
    const eventsBefore = store.listTaskEvents(before.id).length;

    // 折叠：与 web/app.js 的 PATCH 载荷一致（整体替换 labels）
    const folded = store.updateTask(umbrella.identifier, {
      expectedVersion: before.version,
      labels: [...before.labels, "archived"],
    });
    assert.deepEqual(folded.labels, ["archived"]);
    assert.equal(folded.status, "in_review", "折叠不得改状态");
    assert.equal(store.listTasks({ projectId: project.id }).length, 2, "折叠不得删数据（仍在库里）");
    assert.equal(store.getTaskRef(child.identifier).parentId, before.id, "折叠不得动父子关系（子任务串完整）");
    assert.equal(store.listTaskEvents(before.id).length, eventsBefore, "折叠不是状态变化，不应写 status_changed 事件");

    // 取消折叠
    const restored = store.updateTask(umbrella.identifier, {
      expectedVersion: folded.version,
      labels: folded.labels.filter((label) => label !== "archived"),
    });
    assert.deepEqual(restored.labels, []);
    assert.equal(restored.status, "in_review");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * 真机 2026-10-23（用户报障「评审通过点击后，出现下一步提醒的时候有两个完成按钮」）：
 * 抽屉渲染会被**并发**触发 —— 评审/授权成功后处理器里的 `reopen()`、SSE `task.updated` 回流、
 * 60s 看护轮询、回到页签自愈，任两条撞上就有两代渲染同时在跑。而「下一步」区块是**唯一在
 * await（`GET …/next-step`）之后才追加**的区块 ⇒ 先完成的一代把自己的 section 插进了后一代的 body，
 * 该区块出现两次（按钮也就成了两个）。处置＝渲染代次：await 回来发现已被取代即退出。
 * 本测试钉「取号 → await 后重判代次 → 再追加」这段顺序，防止有人把守卫删掉（删掉即复发）。
 */
test("FR-89 补口（真机 2026-10-23）：抽屉并发渲染不得重复追加「下一步」区块（两个完成按钮）", () => {
  const source = read("web/app.js");
  assert.match(source, /let detailRenderSeq = 0;/, "需有渲染代次计数（并发渲染只允许最新一代落地）");
  assert.match(source, /const renderSeq = \+\+detailRenderSeq;/, "每次渲染须取号");
  assert.match(source, /if \(renderSeq !== detailRenderSeq\) return;/, "须在 await 之后重判代次");
  const takeTicket = source.indexOf("const renderSeq = ++detailRenderSeq;");
  const recheck = source.indexOf("这一步 await 过 ⇒ 必须重判代次");
  const insert = source.indexOf("drawerBody.insertBefore(sec, drawerBody.firstChild);");
  assert.ok(takeTicket > -1 && recheck > -1 && insert > -1, "三处锚点都必须在位");
  assert.ok(takeTicket < recheck && recheck < insert, "代次判定必须夹在「取号」与「追加下一步区块」之间");
  // 同一渲染里只允许有一处追加「下一步」区块（唯一性本身也是防重复的一部分）。
  assert.equal((source.match(/drawerBody\.insertBefore\(sec, drawerBody\.firstChild\)/g) ?? []).length, 1, "「下一步」区块只能有一处追加点");
  // 输出不变量（第二道防线，2026-10-23 用户批注当日补）：即使代次守卫被将来的新并发入口绕过，
  // 同一抽屉里也**只允许存在一个**「下一步」区块 —— 追加前先清掉同代残留，
  // 于是人所看到的症状（两个「完成（仅人工可确认）」）在输出层就不可能成立。
  const cleanup = source.indexOf('drawerBody.querySelectorAll(".drawer-section.next-step")');
  assert.ok(cleanup > -1, "追加「下一步」区块前必须先清理同代残留（幂等）");
  assert.ok(cleanup < insert, "幂等清理必须早于追加点执行");
});
