/**
 * t25 自证测试（无 DSH 环境可做的部分）
 *  A. dsh 清单 + cordis.patch.yml   B. index.js 无静态 @deepseek-ai/* import
 *  C. 宿主注册的 handler 可直接服务 API   D. client.js 形态与落点   E. web/app.js 工厂化
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

function freePort() {
  return new Promise((resolve, reject) => {
    const socket = net.createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

test("A. dsh 清单与 cordis.patch.yml 结构", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.type, "module");
  assert.ok(typeof pkg.main === "string" && pkg.main.startsWith("./"));
  assert.equal(pkg.exports["."], "./index.js");
  assert.equal(pkg.exports["./client"], "./lib/client.js");
  assert.equal(pkg.exports["./cordis.patch.yml"], "./cordis.patch.yml");
  assert.equal(pkg.exports["./package.json"], "./package.json");
  assert.deepEqual(pkg.dsh.bundle, { patch: "./cordis.patch.yml" });
  assert.equal(pkg.dsh.client.platform, "web");
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length > 0);
  for (const dep of pkg.dsh.client.inject) {
    assert.ok(dep.startsWith("@deepseek-ai/"), `inject 项应为 @deepseek-ai/* 包名：${dep}`);
  }
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-sidebar"));
  assert.ok(pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-layout"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);

  const patch = read("cordis.patch.yml");
  assert.match(patch, /^- insert:/m);
  assert.match(patch, /^\s+-\s+id: taskboard-workbench$/m);
  assert.match(patch, /^\s+name: taskboard-workbench$/m, "条目 name 必须等于包名");
  assert.equal(read(pkg.dsh.bundle.patch.replace(/^\.\//, "")).includes("taskboard-workbench"), true);
});

test("B. index.js 无静态 @deepseek-ai/* import（动态仅限 dsh-scope，懒加载+守护）；可脱离 DSH 构造运行时", async () => {
  const source = read("index.js");
  assert.equal(/^\s*import[^\n]*@deepseek-ai/m.test(source), false, "不得静态 import @deepseek-ai/*");
  assert.equal(/require\(\s*["']@deepseek-ai/.test(source), false, "不得 require @deepseek-ai/*");
  // FR-84：派发投递需要 `@deepseek-ai/dsh-scope` 铸会话作用域（否则 preset binding 必被拒）。
  // 该包**只能动态 import**（懒加载 + try/catch 守护 + 拿不到就如实降级），且**只允许引用这一个包**。
  const pkgRefs = [...new Set(source.match(/@deepseek-ai\/[a-z0-9-]+/gi) ?? [])];
  assert.deepEqual(pkgRefs, ["@deepseek-ai/dsh-scope"], `只允许引用 dsh-scope，实际：${pkgRefs.join(", ")}`);
  assert.match(source, /await import\(/, "必须走动态 import（懒加载）");

  const dir = mkdtempSync(path.join(os.tmpdir(), "t25-host-"));
  const { createPluginRuntime, PREFIX, name, inject } = await import("../index.js");
  const runtime = createPluginRuntime({ dataDir: dir });
  try {
    assert.equal(name, "taskboard-workbench");
    assert.deepEqual(inject, ["webServer"]);
    assert.equal(PREFIX, "/integrations/taskboard-workbench");
    assert.equal(runtime.dataDir, dir);
    assert.equal(runtime.ensured.created, true, "空库首次启动应自动建内置默认项目");
    assert.equal(typeof runtime.handler, "function");
  } finally {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C. 宿主插件注册的 handler 可直接服务 API（命名空间前缀下）", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t25-serve-"));
  const { apply, PREFIX } = await import("../index.js");
  const registered = [];
  const ctx = {
    config: { dataDir: dir },
    effect(fn) {
      return fn();
    },
    webServer: {
      register(spec) {
        registered.push(spec);
        return () => {};
      },
    },
  };
  const runtime = apply(ctx);
  t.after(() => {
    runtime.close();
    rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(registered.length >= 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, PREFIX);
  assert.equal(typeof registered[0].handler, "function");

  const port = await freePort();
  const server = http.createServer((req, res) => registered[0].handler(req, res));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}${PREFIX}`;

  const health = await (await fetch(`${base}/api/health`)).json();
  assert.equal(health.schemaVersion, 10); // FR-79/FR-82/FR-83/FR-81/FR-85b/FR-11：… + tasks.board_position（列内手工顺序）+ FR-50：team_members.executor → schema 版本 10
  assert.equal(health.status, "ok");
  const projects = await (await fetch(`${base}/api/projects`)).json();
  assert.equal(projects.count, 1);
  assert.equal(projects.projects[0].id, "default");

  const created = await fetch(`${base}/api/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "default", title: "DSH 内嵌冒烟", owner: "engineer", priority: "high", labels: ["内嵌"] }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.task.identifier, "default-1");
  assert.equal(createdBody.task.owner, "engineer");

  const moved = await fetch(`${base}/api/tasks/default-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, status: "in_progress" }),
  });
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).task.status, "in_progress");

  const stale = await fetch(`${base}/api/tasks/default-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 1, status: "done" }),
  });
  assert.equal(stale.status, 409, "过期版本应 409");

  assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 404, "前缀外不占用他人命名空间");
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/tokens.css`)).status, 200);
  assert.equal((await fetch(`${base}/`)).status, 200);
});

test("D. client.js：手写 IIFE、注册 会话标签页/侧栏图标/主列（不含侧栏底部入口）、不注册 overlay", () => {
  const source = read("lib/client.js");
  assert.match(source, /\(\(\) => \{/, "必须包含手写 IIFE");
  assert.match(source, /\}\)\(\);\s*$/, "文件需以 IIFE 调用收尾");
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/);
  assert.match(source, /id: BUNDLE_ID/);
  assert.match(source, /factory:\s*\(require\)\s*=>/);
  assert.match(source, /const React = require\("react"\)/);
  assert.match(source, /return \{ apply, inject: \["slots"\] \}/);
  for (const slot of ["conversation.view", "sidebar.panellist", "main"]) {
    assert.ok(source.includes(slot), `应注册落点 ${slot}`);
  }
  assert.equal(/register\(ctx,\s*"sidebar\.footer\.action"/.test(source), false, "不再注册侧栏底部（设置上方）入口");
  assert.match(source, /key: BUNDLE_ID/, "main(keyed) 必须传 key");
  assert.match(source, /id: BUNDLE_ID, order: 0, label: "任务工作台"/, "panellist 需 id + label（与 main 同 key）");
  assert.equal(/name:\s*["']shell\.overlay/.test(source), false, "不得注册 overlay 落点");
  assert.match(source, /不使用 shell\.overlay/, "注释需说明为何不用 overlay（pointer-events:none）");
  assert.match(source, /__TB_BOARD__\.createBoard/, "面板必须复用 web/app.js 的工厂");
  assert.match(source, /\/integrations\/taskboard-workbench/);
  assert.equal(/^\s*import\s/m.test(source), false, "客户端 bundle 不得使用 ESM import");
  // 样式表必须在**每次进入面板**时重挂一次（换新的 ?v=）：assetsPromise 是页面级单例，
  // 否则长生命周期页面会一直沿用首次挂载时那份 tokens.css —— 真机两次踩坑（改了 CSS 但面板没变）。
  assert.match(source, /function ensureStyles\(force = false\)/, "需有独立的 ensureStyles()（force 供自愈重挂用）");
  assert.match(source, /link\.id = STYLE_LINK_ID/, "样式表元素需带稳定 id，便于复用同一 <link>（改 href 不闪白）");
  const ensureAssetsBody = source.slice(source.indexOf("function ensureAssets()"));
  assert.match(
    ensureAssetsBody,
    /ensureStyles\(\);\s*\n\s*if \(assetsPromise\) return assetsPromise;/,
    "ensureStyles() 必须在 assetsPromise 记忆化之前调用（每次挂载都刷新样式）",
  );
  const check = spawnSync(process.execPath, ["--check", path.join(ROOT, "lib", "client.js")], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
});

test("D2. 样式自愈：只改 tokens.css 时也必须能换新 ?v= 重挂（`-80` 补口）", async () => {
  const source = read("lib/client.js");
  // 行为验证：把 assets 区段从 IIFE 里原样取出，用假 DOM 验证「force 重挂」换到新的 ?v=、
  // 且复用同一 <link> 元素（不新建、不闪白）。
  const region = source.slice(source.indexOf("  let assetsPromise = null; //"), source.indexOf("  window.__ModuleLoader__.load({"));
  const links = [];
  const makeDoc = () => ({
    head: { appendChild(el) { if (el.tagName === "LINK") links.push(el); } },
    getElementById: (id) => links.find((el) => el.id === id) ?? null,
    querySelectorAll: () => [],
    createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } }),
  });
  const doc = makeDoc();
  const win = { __TB_BOARD__: undefined, setTimeout: (fn) => { win.pending.push(fn); return 0; }, pending: [] };
  const api = new Function(
    "document", "window", "BASE", "report",
    `${region}\n return { ensureStyles };`,
  )(doc, win, "/integrations/taskboard-workbench", {});

  const first = api.ensureStyles();
  const href1 = first.getAttribute("href");
  const second = api.ensureStyles(true); // 自愈路径：强制重挂
  const href2 = second.getAttribute("href");
  assert.equal(links.length, 1, "必须复用同一个 <link>（改 href 不闪白），不得新建元素");
  assert.equal(second, first, "force 路径也必须返回同一个 link 元素");
  assert.notEqual(href2, href1, "force 重挂必须换新的 ?v=（否则浏览器直接命中旧缓存）");
  assert.match(href2, /^\/integrations\/taskboard-workbench\/tokens\.css\?v=/);
  // 同毫秒连续两次 force 也必须换出不同的 ?v=
  const href3 = api.ensureStyles(true).getAttribute("href");
  assert.notEqual(href3, href2, "同一毫秒内连续自愈也要换到不同的 ?v=");
});

test("E. web/app.js：工厂化 + 独立页自动挂载；七状态与卡片结构完好", () => {
  const source = read("web/app.js");
  assert.match(source, /function createBoard\(options = \{\}\)/);
  assert.match(source, /window\.__TB_BOARD__ = \{ createBoard, version: 2 \}/);
  assert.match(source, /function autoMount\(\)/);
  assert.match(source, /createBoard\(\{ root: host, apiBase: "" \}\)/);
  for (const status of ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]) {
    assert.ok(source.includes(`${status}:`), `应含状态文案映射 ${status}`);
  }
  assert.match(source, /board-column status-\$\{status\}/);
  assert.match(source, /task-card/);
  assert.match(source, /owner-chip owner-\$\{owner\}/);
  assert.match(source, /priority-chip priority-\$\{task\.priority\}/);
  assert.match(source, /async function api\(method, apiPath, body\)/);
  assert.match(source, /fetch\(`\$\{apiBase\}\$\{apiPath\}`/, "API 基址必须可注入（面板用插件前缀）");

  const html = read("web/index.html");
  assert.match(html, /<div id="tb-app"><\/div>/);
  assert.match(html, /<title>Agent Team 任务工作台<\/title>/);
  assert.match(html, /href="\.\/tokens\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.equal(html.includes('type="module"'), false, "app.js 现为经典脚本（IIFE 工厂）");
});

test("F. tokens.css 布局防御：工具栏在窄面板下不许被压成「一字一行」", () => {
  const css = read("web/tokens.css");
  // 真机事故（2026-10-18，DSH 面板内容宽 ~1140）：`.toolbar` 固定 44px 且不许换行，
  // 文字项被压成竖排 —— 实测工具栏被撑到 304px 高（`新建任务` 40×94、`执行看护` 54×304）。
  const toolbar = css.slice(css.indexOf(".toolbar {"), css.indexOf(".toolbar label"));
  assert.match(toolbar, /flex-wrap:\s*wrap/, "工具栏必须允许换行");
  assert.match(toolbar, /flex:\s*0 0 auto/, "不得再用固定 flex-basis 锁死工具栏高度");
  assert.match(toolbar, /min-height:\s*var\(--row-height\)/, "工具栏需保留 44px 高度下限");
  assert.match(css, /\.toolbar > \.hint,[\s\S]{0,80}\.toolbar > button \{[^}]*white-space:\s*nowrap/, "文字项与按钮必须保持单行");
  assert.match(css, /\.toolbar > select \{[^}]*max-width:\s*320px/, "项目选择器需有宽度上限，避免独占整行把其余控件挤爆");
});

test("G. 宿主草稿持久化自愈：非字符串 draft 必须归位成 \"\"（否则整个会话区白屏）", () => {
  const source = read("lib/client.js");
  // 真机 2026-10-18：任何会话、任何标签页都只剩输入框、看不到历史。
  // 控制台两条 error：`TypeError: text.replace is not a function`（DraftEditorRuntime.setDraft）
  // 与 `slot entry crashed in 'conversation.session'`。
  // 链路：dsh-client-store 整值 JSON 存 localStorage `dsh.conversation*`，rehydrate 零校验；
  // `DefaultConversationViews` 只判 `storedDraft !== ""` 就 setDraft(storedDraft)。
  assert.match(source, /repairConversationDraftStore/, "client.js 需有草稿持久化自愈");
  const applyBody = source.slice(source.indexOf("function apply(ctx) {"), source.indexOf("hostOpenSession = (id) =>"));
  assert.match(applyBody, /repairConversationDraftStore\(\)/, "自愈必须在 apply() 里调用（早于会话视图挂载）");

  // 把自愈函数从 IIFE 里原样取出，用假 localStorage 驱动（不依赖浏览器）。
  const region = source.slice(source.indexOf("#region repair-draft-store"), source.indexOf("#endregion"));
  const fnSource = region.slice(
    region.indexOf("const repairConversationDraftStore = "),
    region.indexOf("\n  report.repairConversationDraftStore"),
  );
  assert.ok(fnSource.includes("typeof value.draft === \"string\""), "必须按字段判定而非常量判定");
  const repair = new Function(`${fnSource}; return repairConversationDraftStore;`)();

  const makeStorage = (entries) => {
    const map = new Map(Object.entries(entries));
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, v),
      get: (k) => map.get(k),
      keys: () => [...map.keys()],
    };
  };
  const withKeyEnumeration = (storage) => {
    const wrapped = Object.create(storage);
    storage.keys().forEach((k) => { wrapped[k] = true; }); // Object.keys(storage) 需能枚举出键名
    return wrapped;
  };

  // 1) 字符串被炸成 {0:'h',1:'e',…} 的损坏
  const s1 = makeStorage({ "dsh.conversation": JSON.stringify({ draft: { 0: "h", 1: "i" }, view: "chat" }) });
  const r1 = repair(withKeyEnumeration(s1));
  assert.equal(r1.repaired, 1);
  assert.deepEqual(r1.keys, ["dsh.conversation"]);
  assert.equal(JSON.parse(s1.get("dsh.conversation")).draft, "");
  assert.equal(JSON.parse(s1.get("dsh.conversation")).view, "chat", "只修 draft，其余字段保持原样");

  // 2) 旧版 zustand persist 的 {state,version} 包装 → 顶层 draft 为 undefined
  const s2 = makeStorage({ "dsh.conversation.session-abc": JSON.stringify({ state: { draft: "旧" }, version: 0 }) });
  const r2 = repair(withKeyEnumeration(s2));
  assert.equal(r2.repaired, 1);
  assert.equal(JSON.parse(s2.get("dsh.conversation.session-abc")).draft, "");

  // 3) 合法字符串草稿与无关键都不得被碰
  const s3 = makeStorage({ "dsh.conversation": JSON.stringify({ draft: "写了一半的字", view: "taskboard-workbench" }), "其它": "x" });
  const r3 = repair(withKeyEnumeration(s3));
  assert.equal(r3.scanned, 1, "只扫 dsh.conversation* ");
  assert.equal(r3.repaired, 0);
  assert.equal(JSON.parse(s3.get("dsh.conversation")).draft, "写了一半的字", "合法草稿绝不能被清掉");
  assert.equal(s3.get("其它"), "x");

  // 4) 幂等：再跑一次不再改
  assert.equal(repair(withKeyEnumeration(s3)).repaired, 0);

  // 5) 存储不可用 / 值不是合法 JSON / 不可写 —— 一律静默返回，绝不抛
  assert.deepEqual(repair(null), { scanned: 0, repaired: 0, keys: [] });
  assert.deepEqual(repair({}), { scanned: 0, repaired: 0, keys: [] });
  const s5 = makeStorage({ "dsh.conversation": "{ 不是 JSON" });
  assert.equal(repair(withKeyEnumeration(s5)).repaired, 0);
  const s6 = makeStorage({ "dsh.conversation": JSON.stringify({ draft: 7 }) });
  const throwy = Object.assign(Object.create(s6), { "dsh.conversation": true, setItem: () => { throw new Error("QuotaExceeded"); } });
  assert.equal(repair(throwy).repaired, 0, "写入失败必须吞掉，不能把面板弄崩");
});

test("H. FR-85 人工校验：看板显著可见 + 唯一放行出口（结论三值）", () => {
  const source = read("web/app.js");
  const css = read("web/tokens.css");

  // 真机缺口（2026-10-18）：后端三条路由齐了，但 web/app.js 里 human-review 一次都没出现 ——
  // 人工校验任务在板上与普通卡无异、没有下结论入口，而 FR-85 验收写着「在看板显著位置可见」，
  // 且人在环的唯一出口 conclude 只能靠 curl。

  // 1) 任务类型判定与后端同口径（labels 含 human_review），并把它当**可执行谓词**真跑一遍
  const region = source.slice(source.indexOf("const HR_LABEL ="), source.indexOf("function createBoard("));
  assert.ok(region.includes("const isHumanReviewPending"), "谓词必须落在常量区，便于独立驱动");
  const hr = new Function(
    `${region}; return { isHumanReviewTask, isHumanReviewPending, hrCategoryLabel, HR_CONCLUSION_LABELS, HR_CATEGORY_LABELS };`,
  )();
  assert.equal(hr.isHumanReviewTask({ labels: ["human_review", "probe"] }), true);
  assert.equal(hr.isHumanReviewTask({ labels: [" human_review "] }), true, "标签需去空白后再比");
  assert.equal(hr.isHumanReviewTask({ labels: ["triage"] }), false);
  assert.equal(hr.isHumanReviewTask({}), false);
  assert.equal(hr.isHumanReviewTask(null), false, "不得对空任务抛错");
  assert.equal(hr.isHumanReviewPending({ labels: ["human_review"] }), true, "缺省即「待结论」");
  assert.equal(hr.isHumanReviewPending({ labels: ["human_review"], humanReviewState: "concluded" }), false);
  assert.equal(hr.isHumanReviewPending({ labels: ["probe"] }), false);
  assert.equal(hr.hrCategoryLabel("real-bug-blocked"), "真实 bug 阻塞");
  assert.equal(hr.hrCategoryLabel("requirement-drift"), "需求异化");
  assert.equal(hr.hrCategoryLabel(null), "未分类");
  assert.equal(hr.hrCategoryLabel("unknown-x"), "unknown-x", "未知类别回落原文，不抛错");
  assert.deepEqual(Object.keys(hr.HR_CONCLUSION_LABELS).sort(), ["change-requirement", "close", "continue"]);
  assert.deepEqual(Object.keys(hr.HR_CATEGORY_LABELS).sort(),
    ["architecture-change", "real-bug-blocked", "requirement-drift", "upstream-mismatch"]);

  // 2) 卡片徽标：类别 + 待结论/已结论（显著可见）
  assert.match(source, /hr-chip \$\{hrPending \? "hr-pending" : "hr-concluded"\}/);
  assert.match(source, /人工校验·\$\{category\}·\$\{hrPending \? "待结论" : "已结论"\}/);
  // 3) 工具栏计数：待人工校验 N（未结论就该一直挂在执行看护行上）
  assert.match(source, /const hrPending = state\.tasks\.filter\(isHumanReviewPending\)\.length/);
  assert.match(source, /待人工校验 \$\{hrPending\}/);
  assert.match(source, /wdNotice\.hidden = [^;]*\+ hrPending === 0;/);
  // 4) 抽屉：四要素（草案原文整段可读）+ 三出口结论 + 手工申报
  assert.match(source, /人工校验（FR-85 人在环）/);
  assert.match(source, /mk\("pre", "hr-draft", t\.description\)/);
  for (const conclusion of ["continue", "change-requirement", "close"]) {
    assert.ok(source.includes(`conclude("${conclusion}"`), `抽屉必须给出「${conclusion}」这个出口`);
  }
  assert.match(source, /\/human-review\/conclude`, \{ conclusion, comment: noteInput\.value\.trim\(\), actor: "human" \}/);
  assert.match(source, /POST", `\/api\/tasks\/\$\{ref\}\/human-review`/, "非人工校验任务要有手工申报入口");
  // 5) 一次误点会消耗掉门并放行下游 → 必须二次确认，且如实回报放行了哪几条
  assert.match(source, /window\.confirm\(`确认给出人工结论/);
  assert.match(source, /已放行下游 \$\{released\} 条/);
  // 6) 样式：人工校验徽标不许被压扁；草案整段可读可滚动
  assert.match(css, /\.card-topline > \.hr-chip \{ flex: 0 0 auto; max-width: 100%; \}/);
  assert.match(css, /\.card-topline > \.hr-chip \{ white-space: normal; overflow-wrap: anywhere; \}/);
  assert.match(css, /\.hr-chip\.hr-pending \{/);
  assert.match(css, /\.hr-chip\.hr-concluded \{/);
  assert.match(css, /\.hr-draft \{[^}]*white-space: pre-wrap/);
});

test("I. FR-84 补口：会话「存在但未加载」必须显式呈现（打开不许让人对着空页猜）", () => {
  const source = read("web/app.js");
  const api = read("src/server/api.mjs");

  // 真机缺口（2026-10-18）：`sessionStateOf` 是 exists/live **两维**，但前端只按 exists 分了三态，
  // 于是 `exists===true && live===false`（会话只在磁盘上、当前实例没加载）被渲染成「在线」；
  // 用户据此点「打开执行会话」→ 客户端切过去后**只有输入框、看不到历史**，且全程没有任何解释。
  // 后端契约不变（仍返回 exists 三态 + live），缺口在**呈现与措辞**，所以只改 web/app.js。

  // 1) 四态文案当**可执行函数**真跑（不许只做字符串包含检查）
  const start = source.indexOf("const liveText =");
  const end = source.indexOf("const staleRef =");
  assert.ok(start > 0 && end > start, "liveText 必须仍在执行会话区可定位");
  const liveText = new Function(`${source.slice(start, end)}; return liveText;`)();
  assert.equal(liveText(null), "未探活");
  assert.equal(liveText({ exists: null }), "存在性未知");
  assert.equal(liveText({ exists: false, live: false }), "已失效");
  assert.equal(liveText({ exists: true, live: true, running: true }), "在线 · 运行中");
  assert.equal(liveText({ exists: true, live: true, running: false }), "在线 · 空闲");
  assert.equal(liveText({ exists: true, live: false }), "仅在磁盘上 · 本实例未加载（点开会即时加载）",
    "未加载绝不能被渲染成「在线」——那是本条缺口的第一现场");
  // 同日真机更正：原措辞「打开可能为空」是**过度悲观**（实测点开即加载、历史完整渲染），
  // 不许回灌 —— 它会把人劝去白建一个新会话。
  assert.ok(!/打开可能为空/.test(source.slice(start, end)), "「打开可能为空」的过度悲观措辞不得回灌");

  // 2) 未加载判据与「已失效」是**两条互斥分支**，且后端仍按 exists/live 两维供数
  const nlStart = source.indexOf("const notLiveRef =");
  const notLive = new Function("refLiveness", `${source.slice(nlStart, source.indexOf("\n", nlStart))}; return notLiveRef;`);
  assert.equal(notLive({ exists: true, live: false }), true);
  assert.equal(notLive({ exists: true, live: true }), false);
  assert.equal(notLive({ exists: false, live: false }), false, "已失效走 staleRef，不许被未加载分支抢走");
  assert.equal(notLive(null), false);
  assert.match(api, /live: Boolean\(live\?\.live\)/, "后端 liveness 必须继续给 live 位，前端才有得判");

  // 3) 抽屉里必须有「未加载」的显式告警，且与「已失效」并列互斥
  assert.match(source, /\} else if \(notLiveRef\) \{/);
  assert.match(source, /当前 dsh 实例尚未加载它/);
  assert.match(source, /历史不会丢/, "必须说清历史没丢，只是没加载");
  assert.match(source, /历史仍可人工查阅/, "必须说清旧会话不会被删除");
  // 4) 打开成功也要如实说明：未加载时不许只说「已切换」
  assert.match(source, /showBanner\(notLiveRef/);
  // 2026-10-19 补：真机确认打开后视图会停在看板页 → 文案里必须补上「对话」兜底（见 L 组）
  assert.match(source, /打开时会即时加载；已把「对话」视图切到前台/);
  assert.match(source, /若「对话」页仍为空白，说明该会话本身没有历史记录/);
  // 5) 诊断动作 open_session 与抽屉对齐：先真跳转，跳不动才降级复制标识
  assert.match(source, /const c = openHostSession\(r\.sessionId\)/);
  assert.ok(!/仅复制标识/.test(source), "占位措辞不得回灌");
});

test("J. FR-86 补口：执行循环的裁剪原因必须在看板上显式标注（不许只报「跳过 N」）", () => {
  const source = read("web/app.js");
  const loop = read("src/core/loop.mjs");

  // 真机缺口（2026-10-18）：loop.mjs 早已返回 serialized/stopped/blockedByUpstream/parallel，
  // 但 web/app.js 只读 blockedByInflight 与 dispatched/skipped —— 人只看到「跳过 N」，
  // 看不到「为什么没全派」（FR-86 验收第三句要求串行化相关任务并**在看板显式标注原因**）。

  // 1) 摘要函数当**可执行函数**真跑
  const consts = source.slice(source.indexOf("const LOOP_STOP_LABELS = {"), source.indexOf("function createBoard("));
  const fn = source.slice(source.indexOf("function loopCutSummary("), source.indexOf("function loopResultSection("));
  const { loopCutSummary } = new Function(`${consts}\n${fn}; return { loopCutSummary };`)();
  assert.equal(loopCutSummary(null), "");
  assert.equal(loopCutSummary({ serialized: [], stopped: [] }), "", "全 0 必须是空串，不留噪音行");
  assert.equal(loopCutSummary({ serialized: [{ task: "a" }, { task: "b" }], stopped: [] }), "让行 2（共享文件冲突）");
  assert.equal(
    loopCutSummary({ serialized: [], stopped: [{ reason: "upstream-blocked" }, { reason: "batch-limit" }, { reason: "batch-limit" }] }),
    "上游依赖未就绪 1 · 同轮并发上限已用满 2",
  );
  assert.match(loopCutSummary({ serialized: [], stopped: [{ reason: "brand-new-reason" }] }), /brand-new-reason 1/,
    "后端新增原因不许被静默吞掉");

  // 2) 防漂移：前端标签表必须覆盖 loop.mjs 真实会产生的 reason 集合
  // 只取**进 stopped 的**原因：loop.mjs 里 blockedByHumanReview / serialized 用的是另一套键，
  // 混在一起会把「human-review」这类非 stopped 原因误判成缺文案（漂移检查要精确，不能一刀切）。
  const reasons = new Set(
    [...loop.matchAll(/stopped\.push\(\{([\s\S]{0,400}?)\}\)/g)]
      .flatMap((m) => [...m[1].matchAll(/reason: "([a-z-]+)"/g)].map((x) => x[1])),
  );
  assert.ok(reasons.size >= 2, `stopped 里可静态提取的原因应至少 2 个，实得 ${reasons.size}`);
  const labels = new Function(`${consts}; return Object.keys(LOOP_STOP_LABELS);`)();
  const missing = [...reasons].filter((r) => !labels.includes(r) && r !== "shared-file-conflict");
  assert.deepEqual(missing, [], `loop.mjs 的原因必须在看板有中文文案，缺：${missing.join(",")}`);
  assert.ok(labels.includes("shared-file-conflict"), "让行文案键必须保留");
  // 反向防僵化：文案表里的每个键都必须真会在 loop.mjs 出现（不许留已废弃的键骗人）
  const stale = labels.filter((k) => !loop.includes(k));
  assert.deepEqual(stale, [], `文案表里的键必须在 loop.mjs 真实出现，僵尸键：${stale.join(",")}`);

  // 3) 接线：结果必须存进 state 并在按钮下方渲染成面板（含四张清单）
  assert.match(source, /state\.lastLoop = \{ projectId: q, at: new Date\(\)\.toISOString\(\), result: r \}/);
  assert.match(source, /const cut = loopCutSummary\(r\)/);
  assert.match(source, /loopResultHost\.appendChild\(loopResultSection\(state\.lastLoop\)\)/);
  assert.match(source, /让行（共享文件冲突 · 显式串行）/);
  assert.match(source, /关键阻塞裁剪/);
  assert.match(source, /上游依赖未就绪/);
  assert.match(source, /同需求最大并行/);
  assert.match(source, /本轮无裁剪：候选任务全部按并发上限放行。/);
});

test("K. 前端脚本版本刷新：每次挂载都要换新 ?v= 重新注入 app.js（不许页面级单例钉死旧前端）", async () => {
  const source = read("lib/client.js");

  // 真机取证（2026-10-18）：用户页面上 `script[data-taskboard-owned]` 的 `?v=` 停在 22:36:50，
  // 而同页 tokens.css 每次进面板都重挂（`?v=` 是当下时间）→ CSS 修复能落地、JS 修复落不了地，
  // 用户看到 22:36 之后的所有前端修复都不生效（抽屉里仍是旧口径「接续存活=在线」）。
  assert.match(source, /function injectBoardBundle\(/, "注入逻辑必须独立成一次性的 injectBoardBundle");
  assert.match(source, /app\.js\?v=\$\{encodeURIComponent\(version\)\}/, "注入必须带新 `?v=`");
  // 关键：注入前必须清掉上一版工厂，否则「工厂已就绪」立刻成立 → 拿到的还是旧前端
  assert.match(source, /window\.__TB_BOARD__ = undefined;/, "注入前必须清掉旧工厂");
  assert.match(source, /if \(previousFactory\?\.createBoard\) window\.__TB_BOARD__ = previousFactory;/, "注入失败必须回滚旧工厂");
  // 关键：结算后必须放行，使下一次挂载重新注入
  assert.match(source, /assetsPromise\.finally\(\(\) => \{ assetsPromise = null; \}\)/, "注入结算后必须清掉单例");
  const ensureBody = source.slice(source.indexOf("function ensureAssets() {"), source.indexOf("window.__ModuleLoader__.load({"));
  assert.doesNotMatch(ensureBody, /if \(window\.__TB_BOARD__\?\.createBoard\) \{\s*waitForFactory\(\)/, "不得再因「工厂已存在」跳过注入");

  // 行为验证：把这段（含 ensureStyles/injectBoardBundle/ensureAssets）从 IIFE 里原样取出，
  // 用假 DOM 连挂两次 —— 必须产出两条脚本、且 `?v=` 不同。
  const region = source.slice(source.indexOf("  let assetsPromise = null; //"), source.indexOf("  window.__ModuleLoader__.load({"));
  const makeEnv = () => {
    const scripts = [];
    const win = { __TB_BOARD__: undefined, setTimeout: (fn) => { win.pending.push(fn); return 0; }, pending: [] };
    const doc = {
      head: {
        appendChild(el) {
          if (el.tagName !== "SCRIPT") return;
          scripts.push(el);
          win.__TB_BOARD__ = { createBoard: () => ({ destroy() {} }) }; // 模拟脚本执行：定义工厂
          el.onload?.();
        },
      },
      getElementById: () => null,
      querySelectorAll: () => [],
      createElement: (tag) => ({ tagName: String(tag).toUpperCase(), dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } }),
    };
    return { win, doc, scripts };
  };
  const env = makeEnv();
  const api = new Function(
    "document", "window", "BASE", "report",
    `${region}\n return { ensureAssets, state: () => ({ version: assetsVersion, promise: assetsPromise }) };`,
  )(env.doc, env.win, "/integrations/taskboard-workbench", {});
  assert.equal(api.state().promise, null, "初始不得持有单例");
  await api.ensureAssets();
  const firstVersion = api.state().version;
  await api.ensureAssets();
  assert.equal(env.scripts.length, 2, "两次挂载必须注入两次（页面级单例会让第二次什么都拿不到）");
  assert.notEqual(env.scripts[0].src, env.scripts[1].src, "两次注入必须换新的 ?v=");
  assert.notEqual(api.state().version, firstVersion, "版本号必须随之更新");
});

test("L. 打开执行会话后必须把「对话」视图带到前台（否则用户停在看板页、看不到历史对话）", () => {
  const app = read("web/app.js");

  // 真机取证（2026-10-19，用户真实页面 + 真实数据 `session-4dc56efa-…` / `session-45d9ed98-…`）：
  // 点「打开执行会话」后 ① 会话**确实切了**（title 变成「任务 obsidian-dsh-acp-15：…」）；
  // ② 该会话历史**确实完整**（手动点「对话」即完整渲染）；③ **视图仍停在「任务工作台」标签页**。
  // 成因：宿主按「每会话持久化的视图偏好」恢复标签页 —— 上次在该会话看的是看板，打开后就还看板。
  // 关键（第一版修错的地方）：服务端 `POST /open-session` 成功时（`verdict.opened`）客户端**不会**再走
  // `openHostSession` —— 所以修复必须落在 app.js 的**三条成功出口**上，而不是只挂在客户端导航能力里。
  assert.match(app, /function activateDefaultConversationTab\(/, "切视图必须独立成可测函数");
  assert.match(app, /\[data-conversation-tabs\]/, "必须用宿主稳定的 tablist 属性定位标签页");
  assert.match(app, /if \(!boardSelected\) return false;/, "用户不在看板页时不得动宿主标签页");
  // 2026-10-19 补：新增「仍要打开（跨工作区）」出口（FR-84 补口）后，出口数由 3 变 5 ——
  // 断言从"恰好 3 条"改为"**至少**三条既有出口都在"，语义不变，且不阻止新增出口也切视图。
  const frontCalls = (app.match(/bringConversationToFront\(doc, [^)]*\);/g) || []).length;
  assert.ok(frontCalls >= 3, `三条成功出口（服务端 opened / 客户端直开 / 诊断动作）都必须切视图，且都要带上目标会话 id（实得 ${frontCalls}）`);
  const openedBranch = app.slice(app.indexOf("if (verdict?.opened) {"), app.indexOf('if (verdict?.reason === "session-gone")'));
  assert.ok(openedBranch.length > 100 && openedBranch.length < 900, "必须能精确定位服务端 opened 分支");
  assert.match(openedBranch, /bringConversationToFront\(doc,/, "服务端 opened 分支必须先切视图（本条的原始漏点）");

  // 行为验证：把这段（BOARD_TAB_LABEL + activateDefaultConversationTab + bringConversationToFront）原样取出，用假 DOM 真跑。
  const region = app.slice(app.indexOf('const BOARD_TAB_LABEL = "任务工作台";'), app.indexOf("function createBoard(options = {}) {"));
  assert.ok(region.length > 200, "region 必须取到实现体");
  const mkTab = (label, selected) => ({
    textContent: label, _selected: selected, _clicked: 0,
    getAttribute(k) { return k === "aria-selected" ? String(this._selected) : null; },
    click() { this._clicked += 1; },
  });
  // 假 tablist：带 addEventListener（watchTabStripTakeover 会挂一次 pointerdown/keydown 监听）
  const mkStrip = (tabs, plus = {}) => ({
    querySelectorAll: () => tabs,
    addEventListener: (type, fn) => { (plus.listeners || (plus.listeners = {}))[type] = fn; },
    ...plus,
  });
  const mkDoc = (tabs, defaultView = null, plus = {}) => ({
    defaultView,
    querySelector: (sel) => (sel === "[data-conversation-tabs]" && tabs ? mkStrip(tabs, plus) : null),
    ...plus,
  });
  const load = (doc) => new Function("document", "window", `${region}\n return { activateDefaultConversationTab, bringConversationToFront };`)(
    doc, undefined,
  );
  const loadWithStorage = (doc) => new Function("document", "window", `${region}\n return { activateDefaultConversationTab, bringConversationToFront, preferConversationView };`)(
    doc, undefined,
  );

  // ① 看板页在前台 → 必须点走「对话」
  {
    const board = mkTab("任务工作台", true), chat = mkTab("对话", false);
    const api = load(mkDoc([chat, board]));
    assert.equal(api.activateDefaultConversationTab(mkDoc([chat, board])), true, "看板在前台时必须切走");
    assert.equal(chat._clicked, 1, "必须点的是「对话」");
    assert.equal(board._clicked, 0, "绝不能点本插件自己的标签页");
  }
  // ② 已经在「对话」页 → 不得动宿主标签页
  {
    const board = mkTab("任务工作台", false), chat = mkTab("对话", true);
    const api = load(mkDoc([chat, board]));
    assert.equal(api.activateDefaultConversationTab(mkDoc([chat, board])), false, "已在对话页时必须 no-op");
    assert.equal(chat._clicked + board._clicked, 0, "不得误点");
  }
  // ③ 拿不到 tablist（宿主改版 / 独立页）→ 静默 false，不抛
  {
    const api = load(mkDoc(null));
    assert.equal(api.activateDefaultConversationTab(mkDoc(null)), false);
    const doc = { querySelector: () => { throw new Error("boom"); } };
    assert.equal(api.activateDefaultConversationTab(doc), false, "异常必须被吞掉");
  }
  // ④ 只有本插件一个标签页 → no-op（点无可点）
  {
    const board = mkTab("任务工作台", true);
    const api = load(mkDoc([board]));
    assert.equal(api.activateDefaultConversationTab(mkDoc([board])), false);
    assert.equal(board._clicked, 0);
  }
  // ⑤ 立刻切成功 → 返回 true
  {
    const board = mkTab("任务工作台", true), chat = mkTab("对话", false);
    const timers = [];
    const api = load(mkDoc([chat, board], { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } }));
    assert.equal(api.bringConversationToFront(mkDoc([chat, board], { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } })), true);
    assert.equal(chat._clicked, 1);
  }
  // ⑥ 立刻**成功也必须**安排延迟重申（宿主会在新会话绑定后 restoreView 把标签页弹回看板）
  {
    const timers = [];
    const win = { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } };
    const board = mkTab("任务工作台", true), chat = mkTab("对话", false);
    const doc = { defaultView: win, querySelector: () => ({ querySelectorAll: () => [chat, board] }) };
    const api = load(doc);
    assert.equal(api.bringConversationToFront(doc), true, "立刻那次应当成功");
    assert.equal(timers.length, 5, "成功也要重申 —— 否则会被宿主的 restoreView 弹回看板");
    assert.ok(timers.at(-1)[1] >= 6000, "最后一次重申必须足够晚（大会话加载慢，宿主 restoreView 可能拖到数秒后）");
    // 模拟宿主弹回看板 → 重申必须把它再切回「对话」
    board._selected = true; chat._selected = false;
    timers.forEach(([fn]) => fn());
    assert.equal(chat._clicked, 6, "重申必须真的反复把「对话」点回前台");
  }
  // ⑦ 立刻失败（宿主渲染晚于导航）→ 也必须安排延迟重试
  {
    const timers = [];
    const win = { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } };
    const board = mkTab("任务工作台", true), chat = mkTab("对话", false);
    let ready = false;
    const doc = { defaultView: win, querySelector: (sel) => (sel === "[data-conversation-tabs]" && ready ? { querySelectorAll: () => [chat, board] } : null) };
    const api = load(doc);
    assert.equal(api.bringConversationToFront(doc), false, "立刻失败必须返回 false");
    assert.equal(timers.length, 5, "必须安排延迟重试（宿主渲染晚于导航）");
    ready = true;
    timers.forEach(([fn]) => fn());
    assert.equal(chat._clicked, 5, "重试都必须真的把「对话」点出来");
  }
  // ⑧ 根因修复：先把宿主「每会话视图偏好」改写成对话页（宿主的 restoreView 自己就落在对话页，竞态消失）
  {
    const store = (init) => {
      const map = new Map(Object.entries(init || {}));
      return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, v), _map: map };
    };
    const api = loadWithStorage(mkDoc(null));
    // ① 偏好是看板 → 必须被改写成对话页，并保留 draft 等其它字段
    const s1 = store({ "dsh.conversation.session-A": JSON.stringify({ draft: "草稿别动", view: "taskboard-workbench", viewRequest: null }) });
    assert.equal(api.preferConversationView("session-A", s1), true, "偏好是看板时必须改写");
    assert.deepEqual(JSON.parse(s1.getItem("dsh.conversation.session-A")), { draft: "草稿别动", view: "chat", viewRequest: null }, "只改 view，草稿与其它字段必须原样保留");
    // ② 已经是对话页 → 幂等 no-op
    assert.equal(api.preferConversationView("session-A", s1), false, "已是对话页时必须幂等 no-op");
    // ③ 没有记录 → 建一条（并补齐 draft，避免宿主 restoreView 拿到损坏草稿）
    const s2 = store();
    assert.equal(api.preferConversationView("session-B", s2), true);
    assert.deepEqual(JSON.parse(s2.getItem("dsh.conversation.session-B")), { view: "chat", draft: "", viewRequest: null });
    // ④ 坏 JSON / 无 sessionId / 不可写 → 静默，绝不抛
    const s3 = store({ "dsh.conversation.session-C": "{不是 JSON" });
    assert.equal(api.preferConversationView("session-C", s3), true, "坏 JSON 也必须能覆盖成合法值");
    assert.equal(api.preferConversationView("", s3), false);
    assert.equal(api.preferConversationView("session-D", { getItem: () => null }), false);
    assert.equal(api.preferConversationView("session-E", { getItem: () => null, setItem: () => { throw new Error("quota"); } }), false, "写入失败必须静默");
  }
  // ⑨ 用户自己点了标签栏 → 立即停止重申（绝不与用户抢方向盘）
  {
    const timers = [];
    const win = { setTimeout: (fn, ms) => { timers.push([fn, ms]); return timers.length; } };
    const board = mkTab("任务工作台", false), chat = mkTab("对话", true);
    const plus = {};
    const doc = { defaultView: win, querySelector: (sel) => (sel === "[data-conversation-tabs]" ? mkStrip([chat, board], plus) : null) };
    const api = load(doc);
    api.bringConversationToFront(doc, "session-F");
    assert.equal(typeof plus.listeners.pointerdown, "function", "必须监听标签栏上的用户操作");
    plus.listeners.pointerdown();                       // 用户点了看板标签页
    board._selected = true; chat._selected = false;     // 于是看板又在前台
    timers.forEach(([fn]) => fn());
    assert.equal(chat._clicked, 0, "用户接管后重申必须全部作废，不得把界面抢回对话页");
  }
});

test("K. FR-84 补口：接续会话的「工作区归属」必须有真实接线（后端判定 + 前端如实呈现）", () => {
  const api = read("src/server/api.mjs");
  const idx = read("index.js");
  const source = read("web/app.js");

  // 1) 宿主要能给会话 cwd（数据源 = sessionQuery 的会话头；判不准必须回 null，不臆断）
  assert.match(idx, /async sessionOrigin\(sessionId\)/, "宿主端口必须有 sessionOrigin");
  assert.match(idx, /listSessions\(\)/, "优先用 sessionQuery.listSessions() 取 header.cwd");
  // 判不准必须回 null、不得臆断（允许 header→record 的兜底链；2026-10-22 补口把 buildSessionIndex 抽成闭包函数后形式略变）
  assert.match(idx, /cwd: header\??\.cwd \?\? (rec\??\.cwd \?\? )?null/, "会话 cwd 必须取自会话头，取不到回 null");
  assert.match(idx, /SESSION_ORIGIN_TTL_MS/, "批量列举必须带 TTL 缓存，避免每次请求都列全会话");

  // 2) 服务端：判定归属 + 不符时**默认不打开**
  assert.match(api, /const mismatch = hasOwnPath \? !under\(project\.workspacePath\) : null;/);
  assert.match(api, /reason: "session-other-workspace"/);
  assert.match(api, /body\?\.force !== true/, "必须留出显式越界打开的通道");
  assert.match(api, /origin: sref\.sessionId \? await sessionOriginOf\(/, "/execution 必须带 origin");
  // 不得用会「回落第一个项目」的解析器判归属（会把"谁都不属于"误判成"属于本项目"）
  const originFn = api.slice(api.indexOf("async function sessionOriginOf"), api.indexOf("async function sessionOriginOf") + 2200);
  // 判定必须走**显式路径比对**（mismatch 由 `!under(project.workspacePath)` 算出），
  // 不得依赖 `resolveProjectForCwd`（无匹配时会回落"第一个项目"，把"谁都不属于"误判成"属于本项目"）。
  assert.match(originFn, /const mismatch = hasOwnPath \? !under\(project\.workspacePath\) : null;/);
  assert.match(originFn, /const under = \(base\) => \{/);
  assert.ok(!/= resolveProjectForCwd\(/.test(originFn), "归属判定不得调用会回落默认项目的解析器");

  // 3) 前端：抽屉如实呈现归属；不符时明说 + 给显式越界按钮（不许「点了没反应」）
  assert.match(source, /\[\"接续归属\", refSessionId \? originText : \"—\"\]/);
  assert.match(source, /属于另一个工作区/, "归属不符必须明说，而不是含糊的「无法自动打开」");
  assert.match(source, /仍要打开（跨工作区）/);
  assert.match(source, /open-session`, \{ force: true \}/);
  assert.match(source, /const originMismatch = refOrigin\?\.mismatch === true;/);
  // 5) FR-84 补口·续二：「先探测再动作」——配置页必须能**只读**探测宿主建会话能力（有则明说可用，无则指向改绑出口）
  assert.match(source, /探测宿主建会话能力/, "配置页必须有宿主能力探测按钮");
  assert.match(source, /api\("GET", "\/api\/host\/probe"\)/, "探测必须打到只读的 /api/host/probe");
  assert.match(source, /改绑已有会话是保底出口/, "探测到不可用时必须指向改绑出口，而不是死胡同");
  assert.ok(!/api\("POST", "\/api\/host\/probe/.test(source), "探测必须只读（不得用 POST）");

  // 判不准（mismatch=null）不得被当成不符
  assert.ok(!/originMismatch = refOrigin\?\.mismatch !== false/.test(source), "mismatch=null 不得被当作不符");

  // 4) 归属不符时，「请用重建并绑定项目主会话接续」**必须真的可点**。
  //    2026-10-19 真机 UI 复验发现的缺口：当时跨工作区分支只渲染「仍要打开（跨工作区）」，
  //    用户在拦截处拿不到重建出口（那句提示因此是空头支票）→ 抽屉里必须同时出现重建按钮。
  const mismatchAt = source.lastIndexOf("if (originMismatch) {");
  // 注意锚点要用**代码形态**（`btn("仍要打开（跨工作区）"`）：提示语与注释里也含这串字，
  // 用裸字符串会让切片在自己的注释处就结束（第一版断言就是这么假通过的）。
  const execBarMismatch = source.slice(mismatchAt, source.indexOf('btn("仍要打开（跨工作区）"', mismatchAt));
  assert.match(execBarMismatch, /重建并绑定项目主会话（接续）/, "跨工作区拦截处必须提供可点的「重建并绑定项目主会话」出口");
  assert.match(execBarMismatch, /rebuildMain/, "该出口必须真的接到重建动作上，而不是只改文案");
});

test("M. FR-63 绑定门不许是死胡同：门页必须说清「谁在哪儿批准」并给出可复制标识", () => {
  const source = read("web/app.js");
  const gateAt = source.indexOf("async function showBlockedGate()");
  const viewAt = source.indexOf("function renderCurrentView()");
  assert.ok(gateAt > 0 && viewAt > gateAt, "必须能定位 showBlockedGate / renderCurrentView 两个函数");
  const gateFn = source.slice(gateAt, viewAt);

  // 1) 门**仍然**遮蔽工作台数据（FR-63 验收：未绑定会话不显示工作台数据）。
  //    不许为了「让用户自救」而放开配置视图 —— 批准是**主会话**的动作，放开配置等于允许待批准会话自助批准。
  assert.match(gateFn, /configScroll\.hidden = true/, "门必须继续遮蔽配置视图（自助批准不是出路）");

  // 2) 门页必须指名批准入口。此前只写「已提交申请，等待批准」—— 用户无从知道**谁**批、在**哪**批，
  //    而批准按钮只在配置页，配置页又被本门挡住 → 唯一的出路是死循环地点「重新申请关联」。
  assert.match(gateFn, /批准只能在主会话侧完成/, "门页必须说清批准只能在主会话侧完成");
  assert.match(gateFn, /本面板「配置」→「会话关联（主会话批准）」/, "必须指名批准入口的具体位置");

  // 3) 给出可复制标识：用户在主会话侧栏里认不出哪条是主会话时，标识是**唯一**的对照手段。
  assert.match(gateFn, /const gateMainId = state\.binding\.mainSessionId \? String\(state\.binding\.mainSessionId\) : null;/);
  assert.match(gateFn, /btn\("复制主会话标识"/, "门页必须能复制主会话标识");
  assert.match(gateFn, /btn\("复制本会话标识"/, "门页必须能复制本会话标识");

  // 4) 有主会话才给「复制主会话标识」；无主会话时要给出真正的自救路径（申请关联 / 新建并绑定本会话）。
  assert.match(gateFn, /if \(gateMainId\) bar\.appendChild\(/, "无主会话时不得渲染「复制主会话标识」");
  assert.match(gateFn, /本项目尚无主会话：先点「申请关联」/);
});

test("N. 「下一步」的人工「完成」不许静默：写成功后必须给可见反馈并刷新抽屉", () => {
  const source = read("web/app.js");

  // 真机反馈 2026-10-22：点「完成（仅人工可确认）」"无反应" —— 查事件流其实写成功了
  // （`status_changed human`），但成功路径只 `hideBanner()`、抽屉不刷新，界面零变化。
  // 断言分两半：① `moveTask` 必须回传成功与否；② `complete` 必须在成功后报横幅 + 重开抽屉。
  const moveAt = source.indexOf("async function moveTask(task, status)");
  assert.ok(moveAt > 0, "必须能定位 moveTask");
  const moveFn = source.slice(moveAt, moveAt + 900);
  assert.match(moveFn, /let ok = true;/, "moveTask 必须有成功/失败标记");
  assert.match(moveFn, /return ok;/, "moveTask 必须回传成功与否（否则调用方无法给反馈）");
  assert.match(moveFn, /ok = false;/, "失败分支必须置为失败");

  const doneAt = source.indexOf('"complete": async');
  assert.ok(doneAt > 0, "必须能定位 next-step 的 complete 动作处理器");
  const doneFn = source.slice(doneAt, doneAt + 700);
  assert.match(doneFn, /window\.confirm\(/, "置「完成」前必须人工确认");
  assert.match(doneFn, /if \(!\(await moveTask\(t, "done"\)\)\) return;/, "失败时不得再报成功");
  assert.match(doneFn, /showBanner\(/, "成功后必须给可见反馈（否则＝点了没反应）");
  // 用户 2026-10-22 约束①「任务执行正常的，确认后即关闭」：成功后直接关抽屉（不再留一张写着
  // 「只差你点完成」的旧抽屉），需要复核时再点开卡片看收口版布局。
  assert.match(doneFn, /closeDrawer\(\)/, "收口成功后必须关闭抽屉");
  assert.equal(/await reopen\(\)/.test(doneFn), false, "收口后不应再重开抽屉（旧读数会让人以为没用）");
  // 顺序：先写入 → 再反馈 → 再关闭（顺序颠倒会被随后的 hideBanner / 旧读数盖掉）。
  assert.ok(doneFn.indexOf("moveTask") < doneFn.indexOf("showBanner("), "必须先写成功再报成功");
  assert.ok(doneFn.indexOf("showBanner(") < doneFn.indexOf("closeDrawer()"), "必须先报成功再关闭");
});

test("O. FR-89 抽屉按状态分层：默认只展开「该做的那一处」，收口卡处置区收起且可一键展开", () => {
  const source = read("web/app.js");

  // ① 默认折叠策略必须由服务端的 focus 驱动（不在前端重写一套判断）。
  const policyAt = source.indexOf("const applyFocusPolicy = (focus)");
  assert.ok(policyAt > 0, "必须能定位 applyFocusPolicy");
  const policy = source.slice(policyAt, policyAt + 900);
  assert.match(policy, /if \(!Array\.isArray\(focus\)\) return \[\];/, "focus 为 null（状态未识别）时不得按猜测重排界面");
  assert.match(policy, /ACTION_SECTION_KEYS/, "必须有「哪些区块属于处置区」的清单");
  assert.match(policy, /state\.touchedSections\.includes\(title\)/, "人手动开过的区块不得被默认策略收回去");
  assert.match(policy, /collapsed", !keepOpen/, "只有 focus 命中的处置区保持展开");

  // ② 人在环的四个处置区必须在清单里 —— 收口后这几处正是用户投诉「这么多按钮动作」的来源。
  const keysAt = source.indexOf("const ACTION_SECTION_KEYS = [");
  assert.ok(keysAt > 0, "必须能定位处置区清单");
  const keysList = source.slice(keysAt, source.indexOf("];", keysAt));
  for (const key of ["评审", "人工校验", "归因", "执行会话"]) {
    assert.ok(keysList.includes(`"${key}"`), `处置区清单必须包含「${key}」`);
  }
  assert.match(keysList, /"诊断与恢复动作"/, "诊断与恢复动作也是处置区");
  assert.match(keysList, /"操作"/, "「操作」（编辑等）也算处置区 —— 收口卡只需留这一处可动");

  // ③ 向导块必须渲染 1-2-3 操作顺序，并给出展开入口（内容不删、按钮不删，只收起）。
  // 从「默认折叠」那句起切（它就写在向导块之前，顺序本身也是断言的一部分）。
  const stepAt = source.indexOf('const isClosed = t.status === "done"');
  assert.ok(stepAt > 0, "必须能定位向导块前的默认折叠段");
  const stepBlock = source.slice(stepAt, stepAt + 3200);
  assert.match(stepBlock, /mk\("ol", "next-steps"\)/, "异常/待办卡必须给 1-2-3 步骤清单");
  assert.match(stepBlock, /applyFocusPolicy\(step\.focus\)/, "必须先按 focus 收起处置区再渲染向导块");
  assert.ok(stepBlock.indexOf("applyFocusPolicy(step.focus)") < stepBlock.indexOf('mk("div", "drawer-section next-step")'), "折叠策略必须在向导块渲染之前执行");
  assert.match(stepBlock, /"展开复核处置"/, "收口卡要给出「展开复核处置」的独立入口");
  assert.match(stepBlock, /setSectionCollapsed\(section, false\)/, "展开入口必须真的把区块展开（不是只改文案）");
  assert.match(stepBlock, /syncExpandAllLabel\(\)/, "折叠状态变了必须同步「全部收起/展开」按钮文案");

  // ④ 手动开过的区块要记账（否则默认策略会在下次打开时把它又收回去）。
  assert.match(source, /state\.touchedSections\.push\(key\)/, "手动折叠动作必须记账到 touchedSections");
});

// t25 回归（2026-10-26 隔离真宿主实测）：`inject` 未声明 `config` 时**不得**读 `ctx.config`。
// 现象：全新 profile（无 `config.dataDir`）装载即抛 `cannot get property "config" without inject`
// ⇒ 整条 entry 不激活、工作台前后端全不挂。真实 profile 因用户层 patch 给了 `config.dataDir`
// 把 `??` 右侧短路，才长期未暴露。
test("P. 插件装载不得触碰未声明的 ctx.config（无 dataDir 配置也要能激活）", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "t25-inject-"));
  const { apply, PREFIX } = await import("../index.js");
  const registered = [];
  const ctx = {
    effect(fn) {
      return fn();
    },
    // cordis 的 `inject` 守卫：未声明就读取 ⇒ 抛这个错（这里按真实报错原文复刻）。
    get config() {
      throw new Error('cannot get property "config" without inject');
    },
    get(name) {
      if (name === "config") return undefined; // 宿主不提供 config 服务时的真实形态
      if (name === "webServer") return undefined;
      return undefined;
    },
    webServer: {
      register(spec) {
        registered.push(spec);
        return () => {};
      },
    },
  };
  let runtime = null;
  assert.doesNotThrow(() => {
    runtime = apply(ctx); // 无第二参数 ⇒ config 为 undefined，必须走安全路径
  }, "无 dataDir 配置时装载不得抛错");
  t.after(() => {
    runtime?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(registered.length >= 1, "必须照常注册命名空间 handler");
  assert.equal(registered[0].path, PREFIX);
  assert.equal(typeof registered[0].handler, "function");

  // 反向钉子：源码里不得再出现裸的 `ctx.config` / `ctx?.config` 读取（只能走 ctx.get("config")）。
  // 只看代码、不看注释（头部注释正是用来解释这条禁令的）。
  const codeOnly = read("index.js")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  assert.match(codeOnly, /ctx\?\.get\?\.\("config"\)/, "必须优先经 ctx.get(\"config\") 取宿主数据目录（不触发 inject 守卫）");
  // 历史写法（裸属性访问）只允许留在 try 守护里：'ctx?.config?.dataDir' 之后 80 字符内必须出现 catch。
  const legacyAt = codeOnly.indexOf("ctx?.config?.dataDir");
  assert.ok(legacyAt > 0, "应保留历史取法作为兜底");
  assert.match(codeOnly.slice(legacyAt, legacyAt + 100), /catch/, "裸读 ctx.config 必须包在 try/catch 里");
});

// FR-95 补口（2026-10-26）：探针必须把「改名那一跳」也探出来。
// 此前 `probeHost()` 只探 create/prompt ⇒ 命名到底能不能落地**从未被真机探过**，
// 于是「会话名没生效」只能靠人工肉眼看会话栏。真宿主实测（tools/bench-host-naming.mjs）：
// root/scoped 的 `sessionController.rename` 都在，本测试在**源码层**钉住探针不许再漏这一项。
test("Q. /api/host/probe 必须探 `rename`（FR-95 命名那一跳），且不改动既有 verdict 语义", () => {
  const code = read("index.js")
    .split("\n")
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join("\n");
  assert.match(code, /rootRename:\s*typeof sessionController\(\)\?\.rename === "function"/, "根 ctx 的 rename 必须被探");
  assert.match(code, /out\.scopedRename = typeof sc\?\.rename === "function"/, "作用域 ctx 的 rename 必须被探");
  assert.match(code, /out\.rename = \{[\s\S]{0,200}?out\.scopedRename \|\| out\.rootRename \? "rename-available" : "rename-unavailable"/, "必须给出 rename 三值化结论");
  assert.match(code, /out\.verdict = out\.scopedCreate \? "create-available"/, "既有 verdict（只讲建会话）语义不得被改名结果污染");
  // 同一条探针契约要知道「改名到底为什么失败」：rename 走的是 renameSession 的如实回报。
  assert.match(read("index.js"), /renameSession/, "改名出口必须仍在（如实回 renamed/titleReason）");
});
