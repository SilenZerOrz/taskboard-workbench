/**
 * 守卫（2026-10-29 真机）：**「按钮在」≠「功能可用」** —— 独立进程实例必须把宿主依赖动作置灰并指路。
 *
 * 触发：用户在 `:47830`（`node src/server/server.mjs` 手起的**独立进程**）上连撞两次：
 *   ① 「自动生成（交主会话）」→ `未能投递：host-unavailable。下一步：检查宿主会话通道后重试`
 *   ② 「打开会话」→ `无法自动打开…（到会话列表搜索该标识手动打开）`
 * 而这两件事在那个进程上**根本做不到**：`/api/health` 早已如实报 `host.capabilities = null`、
 * `createSession/sendPrompt/openSession` 全 `false`。前端**从没读过这个能力位**，于是按钮一直亮着。
 *
 * 守卫四组：
 *   A. 前端必须读 `/api/health` 并把能力位落到 `state.host`，且**未知时不擅自禁用**；
 *   B. 宿主依赖按钮必须打 `data-needs-host`，能力缺失 ⇒ `disabled` + 指明"独立进程 / 去 DSH 内操作"；
 *   C. 常驻提示必须存在且**指路**（`/integrations/taskboard-workbench`）；
 *   D. 服务端 `host-unavailable` 的 `nextAction` 不得再说「检查宿主会话通道后重试」（那是**永远不成立**的条件），
 *      且必须回带 `prompt`（能力缺失时人至少能自己粘到会话里）。
 *
 * 只读源码，另加一条**真 HTTP** 运行期断言（hostless server 上的 split-ask）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { openStore } from "../src/core/store.mjs";
import { createServer } from "../src/server/server.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(join(ROOT, "web", "app.js"), "utf8");
const apiSrc = readFileSync(join(ROOT, "src", "server", "api.mjs"), "utf8");
const css = readFileSync(join(ROOT, "web", "tokens.css"), "utf8");

test("A 能力位：启动读 /api/health 落 state.host，且「未知」不擅自禁用", () => {
  assert.match(app, /api\("GET", "\/api\/health"\)/, "启动必须读一次 /api/health");
  assert.match(app, /state\.host = h\?\.host \?\? null/, "能力位必须落到 state.host");
  const gate = app.slice(app.indexOf("function applyHostGate()"), app.indexOf("function renderHostNotice()"));
  assert.match(gate, /if \(!caps\) return;/, "能力未知（health 未回 / 老宿主不报）时不得擅自禁用，交给服务端如实拒绝");
  assert.match(app, /host: null,/, "state 必须有 host 字段（默认 null = 未知）");
});

test("B 宿主依赖按钮：打 data-needs-host，缺失 ⇒ disabled + 说明是独立进程", () => {
  assert.match(app, /const needsHost = \(el, cap\) => \{ if \(el\) el\.dataset\.needsHost = cap; return el; \}/, "必须有统一的标记助手");
  assert.match(app, /el\.disabled = missing/, "能力缺失必须真的置灰");
  assert.match(app, /无宿主会话通道（独立进程）/, "置灰时必须说清原因（独立进程），不能只变灰不说");
  assert.match(app, /MutationObserver\(\(\) => \{ try \{ applyHostGate\(\); \} catch/, "渲染后才出现的按钮必须由 DOM 观察补齐（否则抽屉里的按钮漏掉）");
  for (const call of ['hostBtn("自动生成（交主会话）"', 'hostBtn("投给主会话"', 'hostBtn("打开执行会话"']) {
    assert.ok(app.includes(call), `必须用 hostBtn 标记：${call}`);
  }
});

test("C 常驻提示：可见 + 指路到 DSH 内的任务工作台（不是一次性 banner）", () => {
  assert.match(app, /const hostNotice = mk\("div", "banner warn"\)/, "能力提示必须是独立常驻元素（banner.warn），不能复用会 5s 消失的一次性 banner");
  const fn = app.slice(app.indexOf("function renderHostNotice()"), app.indexOf("function renderHostNotice()") + 1200);
  assert.match(fn, /hostNotice\.hidden = false/, "能力缺失时必须显示");
  assert.match(fn, /integrations\/taskboard-workbench/, "必须指路（否则人被置灰拦住却不知去哪做）");
  assert.match(fn, /看板、建卡、改状态、评审、人工收口都照常可用/, "必须同时说清「哪些还能用」，不然人会以为整页作废");
  assert.match(css, /\.banner\.warn \{/, "banner.warn 必须有样式（否则与 error 同色，被当成故障）");
});

test("D 服务端：host-unavailable 的 nextAction 必须准确，并回带 prompt", () => {
  // 只禁「当作返回值用」的那一处；注释里引用旧文案作历史说明是允许的。
  assert.ok(!apiSrc.includes('nextAction: "检查宿主会话通道后重试"'), "旧 nextAction 必须消失：它把「能力缺失」说成「临时故障」，人会一直重试永不成立的条件");
  assert.match(apiSrc, /const HOST_UNAVAILABLE_NEXT = "/, "必须有统一措辞常量");
  const uses = apiSrc.match(/nextAction: HOST_UNAVAILABLE_NEXT/g) ?? [];
  assert.equal(uses.length, 3, `三处 host-unavailable 都要用它（实际 ${uses.length}）`);
  assert.match(apiSrc, /reason: "host-unavailable", hostCapabilities: null, nextAction: HOST_UNAVAILABLE_NEXT, prompt \}/, "投递类必须回带 prompt（能力缺失时人可手工投递）");
});

test("E 能力位要按「真正依赖的能力」报，不能拿 createSession 当万能代理", () => {
  const health = apiSrc.slice(apiSrc.indexOf('if (pathname === "/api/health"'), apiSrc.indexOf('if (pathname === "/api/host/probe"'));
  for (const cap of ["listSessions", "sessionExists", "sessionOrigin", "renameSession", "sessionState"]) {
    assert.match(health, new RegExp(`${cap}: has\\(port\\?\\.${cap}\\)`), `health 必须报 ${cap}（前端要按它置灰）`);
  }
});

test("F 标签 → 能力的映射：两族不能混（改绑/改指 ≠ 建会话），且不过度置灰", () => {
  const table = app.slice(app.indexOf("const HOST_BUTTON_LABELS = new Map(["), app.indexOf("function applyHostGate()"));
  const pairs = [...table.matchAll(/\["([^"]+)", "([a-zA-Z]+)"\]/g)].map((m) => [m[1], m[2]]);
  const map = new Map(pairs);
  assert.equal(map.get("重建并绑定主会话"), "createSession");
  assert.equal(map.get("重建并绑定项目主会话"), "createSession");
  assert.equal(map.get("重建主会话并把本任务改指过去"), "createSession");
  assert.equal(map.get("改绑为主会话"), "sessionExists", "改绑已有会话只需 sessionExists（FR-84 的保底出口不得跟着建会话一起置灰）");
  assert.equal(map.get("改指到项目主会话（本任务）"), "sessionExists");
  assert.equal(map.get("用当前会话作为项目主会话"), "sessionExists");
  // 反向：这两类**不能**置灰 —— 置灰就等于把还能用的功能删掉
  assert.equal(map.has("启动执行"), false, "启动执行在无宿主时**降级为 directive**（不是失败），不得置灰");
  assert.equal(map.has("申请关联"), false, "申请关联只是写库（pending），不依赖宿主");
  assert.equal(map.has("批准"), false, "批准只是写库（approved），不依赖宿主");
});

test("G 扫台的标签表不得与 app 的标签表漂移（两处副本必须一致）", () => {
  const bench = readFileSync(join(ROOT, "tools", "bench-host-gate-sweep.mjs"), "utf8");
  const seg = bench.slice(bench.indexOf("const GATE_LABELS = ["), bench.indexOf("];", bench.indexOf("const GATE_LABELS = [")));
  const labels = [...seg.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(labels.length >= 8, `扫台标签表异常（只有 ${labels.length} 条）`);
  const table = app.slice(app.indexOf("const HOST_BUTTON_LABELS = new Map(["), app.indexOf("function applyHostGate()"));
  const missing = labels.filter((l) => !table.includes(`["${l}"`));
  assert.deepEqual(missing, [], `扫台里有、app 表里没有：${missing.join(" / ")}（改一处就会漏掉另一处的置灰）`);
});

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });

test("D2 真 HTTP：hostless 实例上 split-ask 如实回 host-unavailable + 可手工投递的 prompt", async () => {
  const dir = mkdtempSync(join(os.tmpdir(), "tb-hostgate-"));
  const store = openStore({ dataDir: dir });
  try {
    store.createProject({ id: "p1", name: "P1" });
    store.approveSessionAssociation("p1", "sess-hostless"); // 无主会话时 resolveSessionRef 回落到"已绑定会话"
    const item = store.createRequirementItem({ projectId: "p1", title: "需要拆分的需求" });
    assert.equal(store.hostSessionPort ?? null, null, "前置：这个 store 必须**没有**宿主会话通道（等价 :47830）");

    const server = createServer({ store });
    const port = await freePort();
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    const base = `http://127.0.0.1:${port}`;

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.host.capabilities, null, "健康检查必须如实报「无能力位」（前端据此置灰）");

    const res = await fetch(`${base}/api/requirements/items/${item.identifier}/split-ask`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.delivered, false);
    assert.equal(body.reason, "host-unavailable");
    assert.match(body.nextAction, /独立进程/, "nextAction 必须点明是能力缺失而非临时故障");
    assert.match(body.nextAction, /任务工作台|粘到会话/, "nextAction 必须给出可执行的出路");
    assert.ok(typeof body.prompt === "string" && body.prompt.length > 40, "必须回带 prompt（否则人连手工投递都做不到）");

    await new Promise((r) => server.close(r));
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
