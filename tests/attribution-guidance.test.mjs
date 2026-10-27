/**
 * FR-40 补口（归因引导）：归因门不能只是「拒绝」——真机上用户点「启动执行」只看到
 * 「任务未归属需求条目：请先关联需求条目（归因门）」，而全链路**没有任何归因写入口**（任务编辑
 * 对话框无需求条目字段、也无对应端点），于是这条任务永远启动不了（真机报障，2026-10-19）。
 *
 * 本轮补两件：① `POST /api/tasks/:ref/attribution` 归因写入口；② 前端可点的「归因（关联需求条目）」
 * 区块 + 被拦时的引导（卡片与抽屉两条入口）。归因**只写 requirement_id**，不改状态、不写执行痕迹。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter } from "../src/server/api.mjs";
import { createEventHub } from "../src/server/events.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

function setup() {
  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "s1", name: "S1" });
  store.createProject({ id: "s2", name: "S2" });
  const item = store.createRequirementItem({ projectId: "s1", title: "S1 需求" });
  const other = store.createRequirementItem({ projectId: "s2", title: "S2 需求" });
  const router = createApiRouter({ store, events: createEventHub() });
  const route = (method, pathname, body) => router.route({ method, pathname, searchParams: new URLSearchParams(), body });
  return { store, item, other, route };
}

test("FR-40 补口：未归因任务先被归因门拦下，补归因后即可启动执行（不再是死路）", async () => {
  const { store, item, route } = setup();
  const orphan = store.createTask({ projectId: "s1", title: "游离任务", status: "todo" });
  await assert.rejects(
    () => route("POST", `/api/tasks/${orphan.identifier}/execute`, {}),
    (e) => e.code === "EXECUTION_NOT_ATTRIBUTED",
  );

  const bound = await route("POST", `/api/tasks/${orphan.identifier}/attribution`, { requirement: item.identifier });
  assert.equal(bound.status, 200);
  assert.equal(bound.payload.task.requirementId, item.id, "归因写入口需真的写回 requirement_id");
  assert.equal(bound.payload.task.status, "todo", "归因只归属条目，不得改状态");

  const started = await route("POST", `/api/tasks/${orphan.identifier}/execute`, {});
  assert.equal(started.status, 200);
  assert.equal(started.payload.task.status, "in_progress", "归因后即可启动执行");
  store.close();
});

test("FR-40 补口：跨项目归因被拒、缺参数报错，且被拒后不留半截写入", async () => {
  const { store, other, route } = setup();
  const task = store.createTask({ projectId: "s1", title: "游离任务 2", status: "todo" });
  await assert.rejects(
    () => route("POST", `/api/tasks/${task.identifier}/attribution`, { requirement: other.identifier }),
    (e) => e.code === "DEPENDENCY_CROSS_PROJECT",
  );
  await assert.rejects(
    () => route("POST", `/api/tasks/${task.identifier}/attribution`, {}),
    (e) => e.code === "USAGE_ERROR",
  );
  assert.equal(store.getTaskRef(task.identifier).requirementId, null, "被拒后 requirement_id 必须仍为空");
  store.close();
});

test("FR-40 补口：前端给出可点的归因入口，并在被拦时引导（卡片 + 抽屉两条入口）", () => {
  const source = read("web/app.js");
  assert.match(source, /\/attribution`/, "前端需调用归因写入口");
  assert.match(source, /归因（关联需求条目）/, "抽屉里需有归因区块");
  assert.match(source, /EXECUTION_NOT_ATTRIBUTED/, "被归因门拦下时需识别该错误码");
  // 早期实现把「被拦时的引导」在卡片与抽屉各写一份（于是要求 ≥2 处）；2026-10-22 起收敛成
  // 单一 `handleExecutionFailure`，由三条入口共用 ⇒ 这里改为钉「共用」而不是钉「重复」。
  // 第十报：签名多了入口标签 `label`（默认「启动执行」）——「派发团队」被归因门拒时共用同一处置。
  assert.match(source, /async function handleExecutionFailure\(error, ref, task, label = "启动执行"\)/, "被拦时的引导需收在一处统一给出");
  assert.match(read("web/tokens.css"), /\.attr-box \{/, "归因区块需有样式（含 attention 高亮）");
});

test("FR-40 补口（真机 2026-10-22）：归因呈现必须可读，且已归因时仍可核对与改绑", () => {
  const source = read("web/app.js");
  // ① 概览不得再打裸 UUID —— 真机上用户对着一串 fd570a5d-… 说「我不知道这个关联的是哪个需求」。
  assert.doesNotMatch(
    source,
    /\["需求条目", t\.requirementId \?\? "未归因"\]/,
    "概览不得直接渲染 requirementId（裸 UUID 认不出是哪条需求）",
  );
  assert.match(source, /\["需求条目", requirementText\(t\.requirementId\)\]/, "概览需经 requirementText 解析成 `identifier · title`");
  assert.match(source, /const reqById = new Map\(reqItems\.map/, "需有 需求条目 id → 条目 的解析表");
  // ② 归因区块必须**无条件**渲染：原实现只在未归因时渲染，导致归因成功那刻起归属不可见、不可改，
  //    用户只能反过来怀疑「到底关没关联」。
  assert.match(source, /const attributionBox = mk\("div", "drawer-section attr-box"\);/, "归因区块需无条件创建");
  assert.doesNotMatch(source, /if \(!t\.requirementId\) \{[\s\S]{0,200}attributionBox = mk\(/, "不得再保留「未归因才渲染」的分支");
  assert.match(source, /改绑需求条目/, "已归因的任务需有改绑入口");
});

test("FR-40 补口：已归因任务可改绑 —— 只换需求条目，不改状态、不写执行痕迹", async () => {
  const { store, item, route } = setup();
  const second = store.createRequirementItem({ projectId: "s1", title: "S1 需求二" });
  const task = store.createTask({ projectId: "s1", title: "先归因再改绑", status: "todo" });
  await route("POST", `/api/tasks/${task.identifier}/attribution`, { requirement: item.identifier });
  const rebound = await route("POST", `/api/tasks/${task.identifier}/attribution`, { requirement: second.identifier });
  assert.equal(rebound.payload.task.requirementId, second.id, "改绑需真的换到新条目");
  assert.equal(rebound.payload.task.status, "todo", "改绑不得改任务状态");
  assert.equal(store.listTaskRuns(task.identifier).length, 0, "改绑不得写执行痕迹（尝试记录仍为 0）");
  store.close();
});

/**
 * 真机 2026-10-22（续二十四）：用户报「当前可开工三个看板均报：启动执行失败：任务未归属需求条目
 * （归因门）—— 已打开该任务的「归因（关联需求条目）」入口，选一条关联后即可启动」。
 * 只读取证：服务端当时**唯一的 `todo` 卡已归因**（`attributed=true`），门拦不下任何卡；用户的页面
 * 停在数小时前的快照（抽屉 `版本 v3` vs 服务端 `v8`、需求条目仍打裸 UUID），于是提示与抽屉里的
 * 真实归属自相矛盾 ⇒ 用户「无从下手」。本组用例钉住两件：门只按真值拒绝（行为）+ 前端失败后
 * 先同步真值再措辞（源码）。
 */
test("FR-40 补口（真机 2026-10-22）：门只按服务端真值拒绝 —— 真值已归因后旧快照的「未归因」不成立", async () => {
  const { store, item, route } = setup();
  const task = store.createTask({ projectId: "s1", title: "旧快照卡", status: "todo" });
  // ① 真值未归因：拦下（这正是旧快照报错时页面上看到的文案来源）。
  await assert.rejects(
    () => route("POST", `/api/tasks/${task.identifier}/execute`, {}),
    (e) => e.code === "EXECUTION_NOT_ATTRIBUTED",
  );
  // ② 归因写回后，同一张卡按真值即可开工 —— 门只看真值，不看页面快照。
  await route("POST", `/api/tasks/${task.identifier}/attribution`, { requirement: item.identifier });
  const started = await route("POST", `/api/tasks/${task.identifier}/execute`, {});
  assert.equal(started.payload.task.status, "in_progress", "已归因的 todo 卡必须能开工");
  // ③ 再次下发：真值已是「进行中」⇒ 授权门（而非归因门）拒绝；前端据真值可如实说「本卡当前为 …」。
  await assert.rejects(
    () => route("POST", `/api/tasks/${task.identifier}/execute`, {}),
    (e) => e.code === "EXECUTION_NOT_AUTHORIZED" || e.code === "EXECUTION_ALREADY_RUNNING",
  );
  const fresh = store.getTaskRef(task.identifier);
  assert.equal(fresh.requirementId, item.id, "同步后的真值必须是「已归因」（前端自愈判断的唯一依据）");
  assert.equal(fresh.status, "in_progress", "同步后的真值状态必须与门一致");
  store.close();
});

test("FR-40 补口（真机 2026-10-22）：执行类失败先同步真值再措辞；回到页签/窗口即同步看板", () => {
  const source = read("web/app.js");
  assert.match(source, /async function resyncTasks\(identifier\)/, "需有「失败后同步真值」的辅助函数");
  // 「先同步、再措辞」收成一处：三条「启动执行」入口（卡片 / 抽屉 / 下一步面板）共用同一个处置函数。
  // 真机 2026-10-22 三报的正是「同一次失败换条路进来，提示退化」——下一步面板当时还是裸 catch，
  // 于是只有「请先关联需求条目（归因门）」而没有归因入口，用户照着提示也点不到任何东西。
  // 第十报：签名放开成 `(error, ref, task, label = "启动执行")` ——「派发团队」被归因门拒时
  // 走同一套处置（同步真值 → 措辞 → 打开归因入口），只是入口标签不同。
  assert.match(source, /async function handleExecutionFailure\(error, ref, task, label = "启动执行"\)/, "三条入口的失败处置必须共用一个函数");
  assert.ok(
    (source.match(/await handleExecutionFailure\(/g) ?? []).length >= 3,
    "卡片 / 抽屉 / 下一步面板三条「启动执行」入口都要走统一处置（漏一条就会重新漂移）",
  );
  assert.doesNotMatch(
    source,
    /catch \(e\) \{ showBanner\(`启动执行失败/,
    "不得再有绕过统一处置的裸 catch（下一步面板曾如此）",
  );
  assert.match(source, /!fresh\.requirementId/, "只有真值仍未归因时才给「去归因」入口（否则提示与抽屉自相矛盾）");
  assert.match(source, /if \(!fresh\) \{ showBanner/, "同步取不到真值时不得指人去「再归因一次」（如实说「本卡不在当前视图」）");
  assert.match(source, /本卡不在当前视图（可能被筛选或折叠藏起）/, "需有「取不到真值」的兜底文案");
  assert.match(source, /已同步最新状态：本卡现在已归因/, "真值已归因时须如实说明「本次失败来自页面旧快照」");
  assert.match(source, /已同步最新状态：本卡当前为/, "授权门失败须按真值状态说明，不让人对着旧状态猜");
  assert.match(source, /EXECUTION_NOT_AUTHORIZED/, "授权门失败也应走统一处置（按真值状态说明）");
  assert.match(source, /已尝试同步最新状态但未取回本卡/, "授权门 + 同步没拿到真值时也要另给一句（不许说「本卡当前为 null」）");
  // 真机 2026-10-22（续三十二）：同步**失败**与「同步成功但卡不在视图」必须分开 ——
  // 否则取数失败时会沿用上一轮快照，等于拿过期数据判「未归因」，又会吐出那句误导性的归因引导。
  assert.match(source, /let synced = true;/, "同步失败必须与「卡不在当前视图」区分开（返回值带 synced 标志）");
  assert.match(source, /return \{ synced, task \};/, "resyncTasks 需同时回报「是否同步成功」与卡本身");
  assert.match(source, /重新同步看板失败/, "同步失败时的文案必须如实说「同步失败」，不得照旧快照指路");
  assert.ok(
    source.indexOf("if (!synced)") > -1
      && source.indexOf("if (!synced)") < source.indexOf("if (!fresh.requirementId)"),
    "同步失败必须先于「真值未归因」判定 —— 旧快照拿不到真值，谈不上「未归因」",
  );
  assert.match(source, /showBanner\(synced && fresh/, "授权门措辞也必须先要求「同步成功且取回本卡」，不许拿旧快照的状态说事");
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibility\)/, "回到页签须同步一次看板/详情");
  assert.match(source, /window\.addEventListener\("focus", refreshOnReturn\)/, "窗口获得焦点须同步一次看板/详情");
  assert.match(source, /document\.removeEventListener\("visibilitychange", onVisibility\)/, "销毁时须摘掉监听（不给宿主留泄漏）");
});

/**
 * 真机 2026-10-22（用户**第十四次**投递第九报同一句「当前可开工三个看板均报…归因门」）：
 * 门序列是**归因门先于状态门**（`store.assertExecutable`：人工校验 → 归因 → 待办池 → 可开工），
 * 所以一张**早已收口**、又恰好没归因的旧卡被「启动执行」拦下时，吐出来的也是「未归属需求条目」。
 * 旧页签里它还在「可开工」列上 ⇒ 照提示去归因，后面还有状态门等着拒，那条路**永远启动不了**
 * （用户复投的正是这一句）。处置：只有「真值仍未归因」**且**「真值状态本身可启动」时，
 * 才把归因入口摆到人面前；否则先按真值状态说实话（并说明本次失败来自页面旧快照）。
 */
test("FR-40 补口（真机 2026-10-22 第十四报）：已收口 + 未归因的卡报的是归因门，前端不得再指人去归因", async () => {
  const { store, route } = setup();
  const closed = store.createTask({ projectId: "s1", title: "已收口的游离任务", status: "done" });
  assert.equal(closed.requirementId, null, "前置：这张卡确实未归因");
  await assert.rejects(
    () => route("POST", `/api/tasks/${closed.identifier}/execute`, {}),
    (e) => e.code === "EXECUTION_NOT_ATTRIBUTED",
    "门序列归因先于状态 ⇒ 终态 + 未归因被拒时报的是归因门（那句误导文案的来源）",
  );
  store.close();

  const source = read("web/app.js");
  assert.match(
    source,
    /label === "启动执行" && fresh\.status !== "todo" && fresh\.status !== "backlog"/,
    "真值状态不可启动时须先按状态说清，不得把人指去归因",
  );
  assert.match(source, /不是「可开工」，不可启动执行（本次失败来自页面旧快照/, "需如实说明「本次失败来自页面旧快照」");
  assert.ok(
    source.indexOf('label === "启动执行" && fresh.status !== "todo"') < source.indexOf("if (!fresh.requirementId)"),
    "状态判定必须先于「真值未归因」分支 —— 否则终态卡仍会收到「去归因即可启动」的误导引导",
  );
});

/**
 * 真机 2026-10-22（用户**第八次**投递同一句报障，前七次全是只读复核 · 结论都是「不可复现」）：
 * 只读复核能证明「当前没有一张可开工卡会被归因门拦」，但**证明不了**用户为什么总能撞上它 ——
 * 因为**入口本身**没跟上口径：`next-step.mjs` 早已按 `todo-no-attribution` 给「去归因」，
 * 而卡片与抽屉两条入口仍在 `status === "todo"` 时无条件渲染「启动执行」。
 * 只要有张未归因的卡进到「可开工」，人点下去就**必然**拿到那句「请先关联需求条目（归因门）」。
 *
 * 本轮不再复核、改口径：**先把注定被拒的路拿掉** —— 未归因的可开工卡一律给「去归因」，
 * 三处入口共用同一个谓词 `executionEntry`。服务端的门仍是唯一裁决者，这里只不做无用功。
 */
test("FR-40 补口（真机 2026-10-22 第八报）：先判归因再给按钮 —— 三处入口共用一份谓词", () => {
  const source = read("web/app.js");
  // ① 谓词真跑一遍（与 tests/dsh-plugin.test.mjs 的 HR 谓词同一手法：切出常量区 + new Function 驱动）
  const region = source.slice(source.indexOf("const HR_LABEL ="), source.indexOf("function createBoard("));
  assert.ok(region.includes("const executionEntry"), "谓词必须落在常量区，才能被独立驱动");
  const { executionEntry } = new Function(`${region}; return { executionEntry };`)();
  assert.equal(executionEntry({ status: "todo", requirementId: "req-1" }), "start", "已归因的可开工卡 → 启动执行");
  assert.equal(executionEntry({ status: "todo", requirementId: null }), "attribute", "未归因的可开工卡 → 去归因（不给注定被拒的按钮）");
  assert.equal(executionEntry({ status: "todo" }), "attribute", "requirementId 缺失与 null 同判");
  // 第九报口径修订：待办池不再返回 null —— 它有自己的入口「授权开工」（授权门，不是执行门）。
  // 只给 null 的结果是真机上「卡面只有一个小箭头 →，人看不出该点哪」，于是又被读成「点了没用」。
  assert.equal(executionEntry({ status: "backlog", requirementId: "req-1" }), "authorize", "待办池 → 授权开工（授权门，不是执行门）");
  // 第十报口径修订：门序列是「归因门 → 授权门」（`store.assertExecutable`）⇒ 未归因的待办池卡
  // 先「去归因」。此前一律判 `authorize`，于是「先授权 → 再点启动执行」会在可开工被归因门拒 ——
  // 同一句报错换一条路再来一次（真机第十次投递的正是这句）。
  assert.equal(executionEntry({ status: "backlog", requirementId: null }), "attribute", "待办池 + 未归因 → 先去归因（先授权也过不了归因门）");
  assert.equal(executionEntry({ status: "in_review", requirementId: "req-1" }), null, "待验收不是执行入口");
  assert.equal(executionEntry({ status: "in_progress", requirementId: "req-1" }), null, "非可开工状态没有执行入口");
  assert.equal(executionEntry(null), null, "不得对空任务抛错");

  // ② 卡片与抽屉都走这一份谓词，旧的无条件分支必须消失
  assert.match(source, /const entry = executionEntry\(task\);/, "卡片入口须走谓词");
  assert.match(source, /else if \(entry === "attribute"\) group\.appendChild\(attributeAction\(task\)\);/, "卡片未归因时需给「去归因」");
  assert.match(source, /const drawerEntry = executionEntry\(t\);/, "抽屉入口须走谓词");
  assert.match(source, /去归因（关联需求条目）/, "未归因时须有可点的归因入口");
  assert.doesNotMatch(source, /if \(task\.status === "todo"\) group\.appendChild\(act\("启动执行"/, "卡片不得再无条件下发「启动执行」");
  assert.doesNotMatch(source, /if \(t\.status === "todo"\) ops\.appendChild\(btn\("启动执行"/, "抽屉不得再无条件下发「启动执行」");

  // ③ 「打开并高亮归因入口」只有一份实现（第八报之前内联在 handleExecutionFailure 里，卡片按钮无从复用）
  assert.match(source, /async function openAttributionEntry\(task\)/, "归因入口需收成一处（卡片按钮与被拦提示共用）");
  assert.equal((source.match(/drawerBody\?\.querySelector\?\.\("\.attr-box"\)/g) ?? []).length, 1, "高亮归因区块只能有一处实现");

  // ④ 卡面要能一眼看出「未归因」，不必点开抽屉才知道
  assert.match(source, /mk\("span", "attr-chip", "未归因"\)/, "卡片需有「未归因」标记");
  assert.match(read("web/tokens.css"), /\.attr-chip \{/, "「未归因」标记需有样式");
});

/**
 * 真机 2026-10-22（用户**第九次**投递同一句报障：「当前可开工三个看板均报：启动执行失败：任务未归属
 * 需求条目…（归因门）」）。本轮只读复核的四条硬读数：
 *   ① 看板列表（带看护）⇒ done 85 · in_review 30 · backlog 5 · todo 1 · canceled 3；
 *   ② 直查库（只读）⇒ 非终态卡里**唯一未归因的是 -80**（in_review，本无启动入口）；
 *   ③ 运行中服务端自己的判定 `GET /api/tasks/:ref/execution` ⇒ -58 / -121 / -122 / -123 全部 attributed=true；
 *   ④ 用户真正够得到的那三张（-121/-122/-123）在**待办池**，真实的门是**授权门**。
 * ⇒ 归因门当前拦不下任何可开工卡；这一报与「待办池只有一个「→」小箭头、看不出该点哪」是同一个体感问题。
 * 本组用例钉住三件：待办池有显式入口（谓词 + 卡片 + 抽屉）、执行失败横幅带任务编号（报障可定位）、
 * 「未授权」与「未归因」在卡面上可区分。
 */
test("FR-40 补口（真机 2026-10-22 第九报）：待办池给「授权开工」显式入口 + 失败横幅带任务编号", () => {
  const source = read("web/app.js");
  // ① 待办池入口：谓词 → 卡片与抽屉两处都接上
  assert.match(source, /function authorizeAction\(task\)/, "待办池需有独立的授权动作（不复用「启动执行」）");
  assert.match(source, /else if \(entry === "authorize"\) group\.appendChild\(authorizeAction\(task\)\);/, "卡片须接上授权入口");
  assert.match(source, /if \(drawerEntry === "authorize"\) ops\.appendChild\(btn\("授权开工（移出待办池）"/, "抽屉须接上授权入口");
  assert.match(source, /mk\("span", "auth-chip", "未授权"\)/, "卡面需有「未授权」标记");
  assert.match(read("web/tokens.css"), /\.auth-chip \{/, "「未授权」标记需有样式（与「未归因」区分色）");
  // 授权只放行、不下发：backlog → todo，不得被写成一键开工
  assert.match(source, /await moveTask\(task, "todo"\)/, "授权只移列（backlog → todo），不得直接下发执行");
  assert.doesNotMatch(source, /authorizeAction\(task\)\)[\s\S]{0,80}\/execute/, "授权动作不得触碰 /execute");

  // ② 横幅带编号：第九报的取证成本正是花在「用户说三张卡都报，但不知道是哪三张」上
  assert.match(source, /const who = task\?\.identifier \?\? ref \?\? "该任务";/, "失败横幅必须带任务编号（可定位）");
  assert.doesNotMatch(source, /showBanner\(`\$\{label\}失败：/, "旧的无编号横幅文案必须消失（否则又出现「不知道是哪张卡」）");
  assert.match(source, /已打开该任务的「归因（关联需求条目）」入口/, "真值确实未归因时的引导文案保留");
});

/**
 * 2026-10-22：同一条纪律（不把注定被拒的路摆到人面前）此前只覆盖了「启动执行」三条入口，
 * 漏了**第三条真的会干活的执行入口** —— 抽屉里的「CLI 执行器（真实执行）」。
 * 服务端 `/exec-cli` 当时只判人工校验门，未归因的卡会被 CLI **真跑**（真 spawn + 流入「待验收」）；
 * 补上归因门之后，前端入口也必须同步收敛，否则又是「看着能点、点下去才报错」。
 */
test("FR-40 补口（2026-10-22 · CLI 执行器）：/exec-cli 过归因门，前端入口同步收敛（不给注定被拒的按钮）", () => {
  const source = read("web/app.js");
  const region = source.slice(source.indexOf("const HR_LABEL ="), source.indexOf("function createBoard("));
  assert.ok(region.includes("const cliEntry"), "CLI 入口谓词必须落在常量区，才能被独立驱动");
  const { cliEntry } = new Function(`${region}; return { cliEntry };`)();
  assert.equal(cliEntry({ requirementId: "req-1" }), "start", "已归因的普通卡 → 可交给 CLI 执行器");
  assert.equal(cliEntry({ requirementId: null }), "attribute", "未归因 → 去归因（服务端归因门会拦）");
  assert.equal(cliEntry({ requirementId: "req-1", labels: ["human_review"] }), "human-review", "人工校验任务 → 只能走结论入口");
  assert.equal(cliEntry({}), "attribute", "requirementId 缺失与 null 同判");
  // 入口与门对齐：非 start 时**不得**渲染「真实执行」按钮，且未归因时给出可做的动作。
  assert.match(source, /if \(cliEntryKind === "start"\) cliBar\.appendChild\(btn\("交给 CLI 执行器执行"/, "非 start 不得渲染「交给 CLI 执行器执行」");
  assert.match(source, /cliEntryKind === "attribute"\) cliBar\.appendChild\(btn\("去归因（关联需求条目）"/, "未归因时直接给「去归因」");
  assert.match(source, /本卡是人工校验任务（FR-85b 升级门）：不得交给 CLI 执行器/, "人工校验卡要给明路（结论入口），不是静默少一个按钮");
  assert.match(source, /预览执行计划/, "⚠ 预览（dryRun）必须保留：只回计划、无副作用，服务端也刻意不放归因门");
});

test("FR-40 补口（2026-10-22）：服务端 /exec-cli 的归因门必须在认领/起进程之前（源码口径）", () => {
  const api = read("src/server/api.mjs");
  const routeAt = api.indexOf("const taskExecCliRoute");
  // 必须匹配**行首缩进 + 不可被注释掉**的那一行：否则「临时摘门」这种反证会被注释里的同名文本骗过。
  const gateAt = api.indexOf("\n      store.assertAttributed(task.identifier);", routeAt);
  const claimAt = api.indexOf("const claim = claimForCliExecution(", routeAt);
  assert.ok(routeAt > -1 && gateAt > -1 && claimAt > -1, "路由、归因门、认领三处都要在");
  assert.ok(gateAt < claimAt, "门判定必须**先于**副作用（认领推进状态 / 起子进程）——这正是缺口期的失效点");
  const dryAt = api.indexOf("body.dryRun === true", routeAt);
  assert.ok(dryAt > -1 && dryAt < gateAt, "dryRun 预览必须排在归因门之前（预览不被门挡）");
});

/**
 * 真机 2026-10-22（用户**第十次**投递同一句报障）：第八/九报只把「启动执行」那条路面收干净了，
 * 但归因门能拦下的入口**不止它** ——「派发团队」在未归因的卡上照样可见（真机 `-80`：`in_review`、
 * 未归因，抽屉「归属团队」里就摆着这个按钮，点下去必被 `api.mjs` 的 `assertAttributed` 拒）。
 * 另：门序列是「归因门 → 授权门」，而 `executionEntry` 此前把 `backlog` 一律判成 `authorize`。
 * 本轮把判据从「可开工 + 未归因」放开成**与所在列无关**（`needsAttribution`），三处入口共用一份。
 */
test("FR-40 补口（真机 2026-10-22 第十报）：归因门可达面与列无关 —— 卡面标记 / 团队区块 / 失败引导同一份判据", () => {
  const source = read("web/app.js");
  const region = source.slice(source.indexOf("const HR_LABEL ="), source.indexOf("function createBoard("));
  assert.ok(region.includes("const needsAttribution"), "判据必须落在常量区，才能被独立驱动");
  const { needsAttribution, executionEntry } = new Function(`${region}; return { needsAttribution, executionEntry };`)();

  // ① 判据与所在列无关：未归因的非终态卡都算「会被归因门拦」
  assert.equal(needsAttribution({ status: "todo" }), true, "可开工 + 未归因");
  assert.equal(needsAttribution({ status: "backlog" }), true, "待办池 + 未归因");
  assert.equal(needsAttribution({ status: "in_review" }), true, "待验收 + 未归因（真机 -80 就是这张：卡面无提示却给「派发团队」）");
  assert.equal(needsAttribution({ status: "in_progress" }), true, "进行中 + 未归因");
  assert.equal(needsAttribution({ status: "todo", requirementId: "req-1" }), false, "已归因不算");
  assert.equal(needsAttribution({ status: "done" }), false, "终态不参与（已收口的卡不再提示归因）");
  assert.equal(needsAttribution({ status: "canceled" }), false, "终态不参与");
  assert.equal(needsAttribution(null), false, "不得对空任务抛错");

  // ② 门序列对齐：归因门在授权门之前 ⇒ 待办池 + 未归因先「去归因」
  assert.equal(executionEntry({ status: "backlog", requirementId: null }), "attribute", "待办池 + 未归因 → 先去归因");
  assert.equal(executionEntry({ status: "backlog", requirementId: "req-1" }), "authorize", "待办池 + 已归因 → 授权开工");
  assert.equal(executionEntry({ status: "in_review", requirementId: null }), null, "待验收仍不给执行入口（标归因 ≠ 给执行按钮）");
  assert.equal(executionEntry({ status: "done", requirementId: null }), null, "终态不给执行入口");

  // ③ 卡面标记：未归因按判据（与列无关），未授权按列 —— 二者可并存（顺序＝门序列）
  assert.match(source, /if \(needsAttribution\(task\)\) \{\n        const chip = mk\("span", "attr-chip", "未归因"\);/, "卡面「未归因」标记须与列无关");
  assert.match(source, /if \(task\.status === "backlog"\) \{\n        const chip = mk\("span", "auth-chip", "未授权"\);/, "「未授权」标记按列判定（与归因标记可并存）");

  // ④ 团队区块：「派发团队」在未归因时不得出现，改给「去归因」；且必须排在授权分支之前
  const teamAt = source.indexOf("async function fillTaskTeam(");
  const teamBlock = source.slice(teamAt, source.indexOf("// #3：合并团队信息", teamAt));
  const attrAt = teamBlock.indexOf("!data.task.requirementId");
  const backlogAt = teamBlock.indexOf('data.task?.status === "backlog"');
  assert.ok(attrAt > -1 && backlogAt > -1 && attrAt < backlogAt, "归因分支必须排在授权分支之前（＝门序列）");
  assert.match(teamBlock, /去归因（关联需求条目）/, "未归因时给归因入口");
  assert.ok(teamBlock.indexOf('btn("派发团队"') > attrAt, "「派发团队」不得出现在归因分支之前（未归因时会先被上面拦下）");

  // ⑤ 失败处置：「派发团队」被归因门拒时与「启动执行」同源（带卡号 + 打开并高亮归因入口）
  assert.match(source, /async function handleExecutionFailure\(error, ref, task, label = "启动执行"\)/, "失败处置须支持入口标签（启动执行 / 派发团队共用）");
  assert.match(source, /error\.code === "EXECUTION_NOT_ATTRIBUTED"\) \{ await handleExecutionFailure\(error, identifier, undefined, "派发团队"\); return; \}/, "派发被归因门拒时须走统一处置");
});
