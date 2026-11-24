/**
 * 卡 `-293`（需求 `R197`）· 证据引用「点开即读」—— **只读文件查看端点 + 宿主能力探测**守卫。
 *
 * 与另外两份守卫的分工（**三层各守一半，不许互相顶替**）：
 *   · `tools/bench-evidence-ref-open.mjs` 守**渲染后**的界面（点一下真出内容）与**真 HTTP** 的逐条错误码；
 *   · 本份守**服务端路径闸**（`../` / 越界 / 不存在 / 超限 / 二进制）与**前端契约**（按钮形态、探测口径）。
 *
 * 钉九件事：
 *   1. 正常相对路径 ⇒ 200 + 真内容；
 *   2. `../` 穿越 ⇒ **不是 200**，且码是 `FILE_PATH_TRAVERSAL`（不是笼统的 USAGE_ERROR）；
 *   3. workspace 外的**绝对**路径 ⇒ `FILE_OUTSIDE_WORKSPACE`；
 *   4. 不存在的文件 ⇒ `FILE_NOT_FOUND`（且 HTTP 404）；
 *   5. 符号链接逃逸（工作区内的软链指向区外）⇒ 同样被拒（realpath 闸）；
 *   6. >512KB ⇒ `FILE_TOO_LARGE`；二进制 ⇒ `FILE_NOT_TEXT`；
 *   7. 端点**只读**：只 GET，且**不写库**（行数前后不变）；
 *   8. 前端：引用渲染成 `button[type=button]`；宿主探测**列真实 key**、**探不到就降级**（不臆造成功）；
 *   9. 新错误码**已登记**进 `ERROR_CATEGORY`（不登记 ⇒ 退出码落 `EXIT.DATA`，契约就散了）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";

import { openStore } from "../src/core/store.mjs";
import { createApiRouter, resolveWorkspaceFile, MAX_INLINE_FILE_BYTES } from "../src/server/api.mjs";
import { ERROR_CATEGORY } from "../src/core/errors.mjs";
import { createHostSessionPort } from "../index.js";

const web = () => fs.readFileSync(path.resolve("web", "app.js"), "utf8");
const client = () => fs.readFileSync(path.resolve("lib", "client.js"), "utf8");
const hostPlugin = () => fs.readFileSync(path.resolve("index.js"), "utf8");

/** 台内数据：一个项目 + 一个带 `workspacePath` 的临时工作区 + 一张带 `file` 引用的卡。 */
function setup({ withWorkspace = true } = {}) {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "tb-refws-"));
  const outside = mkdtempSync(path.join(os.tmpdir(), "tb-refout-"));
  mkdirSync(path.join(workspace, "docs"), { recursive: true });
  writeFileSync(path.join(workspace, "docs", "a.md"), "# 标题\n正文第一行\n正文第二行\n", "utf8");
  writeFileSync(path.join(workspace, "docs", "big.txt"), "x".repeat(MAX_INLINE_FILE_BYTES + 1024), "utf8");
  writeFileSync(path.join(workspace, "docs", "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
  writeFileSync(path.join(outside, "secret.txt"), "不该被读到\n", "utf8");
  try { symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "docs", "escape.txt")); } catch { /* 平台不支持 ⇒ 跳过该用例 */ }

  const store = openStore({ dbPath: ":memory:" });
  store.createProject({ id: "p1", name: "P1", workspacePath: withWorkspace ? workspace : null });
  const t = store.createTask({ projectId: "p1", title: "T", status: "todo" });
  store.addTaskEvidence(t.identifier, {
    verdict: "判定：完成", deviation: "偏离：无", boundary: "边界：无",
    artifacts: ["docs/a.md"], artifactRefs: [{ kind: "file", ref: "docs/a.md" }], actor: "codex",
  });
  const router = createApiRouter({ store });
  const route = (method, pathname, body) => {
    const [p, q] = String(pathname).split("?");
    return router.route({ method, pathname: p, searchParams: new URLSearchParams(q ?? ""), body });
  };
  const cleanup = () => {
    try { store.close(); } catch { /* ignore */ }
    for (const dir of [workspace, outside]) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  };
  return { store, t, route, workspace, outside, cleanup };
}

/** 断言「这条请求被拒，且拒绝码是它该有的那一个」。 */
async function expectRejected(route, url, code, { status } = {}) {
  let thrown = null;
  try { await route("GET", url); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `应当被拒：${url}`);
  assert.equal(thrown.code, code, `拒绝码不对：${url} → ${thrown.code}（期望 ${code}）`);
  if (status !== undefined) {
    const { httpStatusFor } = await import("../src/server/api.mjs");
    assert.equal(httpStatusFor(thrown), status);
  }
  return thrown;
}

test("A 正常相对路径：200 + 真内容（只读端点拿到的是文件原文）", async () => {
  const { route, cleanup } = setup();
  try {
    const r = await route("GET", "/api/projects/p1/file?path=docs%2Fa.md");
    assert.equal(r.status, 200);
    assert.equal(r.payload.path, "docs/a.md");
    assert.ok(r.payload.text.includes("正文第一行"), "内容必须是文件原文");
    assert.equal(r.payload.lines, 4);
    assert.ok(r.payload.size > 0);
    // 默认不试宿主打开（`open=1` 才试）—— 端点默认是**纯读**。
    assert.equal(r.payload.hostOpen.attempted, false);
  } finally { cleanup(); }
});

test("B `../` 穿越 ⇒ FILE_PATH_TRAVERSAL（HTTP 400），不返回内容", async () => {
  const { route, cleanup } = setup();
  try {
    await expectRejected(route, "/api/projects/p1/file?path=..%2F..%2Fetc%2Fpasswd", "FILE_PATH_TRAVERSAL", { status: 400 });
    // 即使解析后**仍在区内**（`docs/../docs/a.md`）也拒 —— 意图本身就在试探穿越。
    await expectRejected(route, "/api/projects/p1/file?path=docs%2F..%2Fdocs%2Fa.md", "FILE_PATH_TRAVERSAL");
  } finally { cleanup(); }
});

test("C workspace 外的绝对路径 ⇒ FILE_OUTSIDE_WORKSPACE（HTTP 400）", async () => {
  const { route, outside, cleanup } = setup();
  try {
    await expectRejected(route, `/api/projects/p1/file?path=${encodeURIComponent(path.join(outside, "secret.txt"))}`, "FILE_OUTSIDE_WORKSPACE", { status: 400 });
  } finally { cleanup(); }
});

test("D 不存在的文件 ⇒ FILE_NOT_FOUND（HTTP 404）", async () => {
  const { route, cleanup } = setup();
  try {
    await expectRejected(route, "/api/projects/p1/file?path=docs%2Fnot-here.md", "FILE_NOT_FOUND", { status: 404 });
  } finally { cleanup(); }
});

test("E 符号链接逃逸（工作区内的软链指向区外）⇒ 同样被拒（realpath 闸）", async () => {
  const { route, cleanup } = setup();
  try {
    if (!fs.existsSync(path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "x"))) { /* noop */ }
    await expectRejected(route, "/api/projects/p1/file?path=docs%2Fescape.txt", "FILE_OUTSIDE_WORKSPACE");
  } finally { cleanup(); }
});

test("F 超上限（>512KB）⇒ FILE_TOO_LARGE；二进制 ⇒ FILE_NOT_TEXT（各带原因）", async () => {
  const { route, cleanup } = setup();
  try {
    const big = await expectRejected(route, "/api/projects/p1/file?path=docs%2Fbig.txt", "FILE_TOO_LARGE");
    assert.ok(big.details?.maxBytes === MAX_INLINE_FILE_BYTES, "必须写明上限");
    assert.ok(big.details?.size > MAX_INLINE_FILE_BYTES, "必须写明实际体积");
    const bin = await expectRejected(route, "/api/projects/p1/file?path=docs%2Fbin.dat", "FILE_NOT_TEXT");
    assert.ok(bin.message.includes("二进制"), "必须写明原因");
  } finally { cleanup(); }
});

test("G 项目没登记工作区 ⇒ PROJECT_WORKSPACE_MISSING（无从限定只读范围）", async () => {
  const { route, cleanup } = setup({ withWorkspace: false });
  try {
    await expectRejected(route, "/api/projects/p1/file?path=docs%2Fa.md", "PROJECT_WORKSPACE_MISSING", { status: 400 });
  } finally { cleanup(); }
});

test("H 端点只读：只 GET；且**不写库**（行数前后不变）", async () => {
  const { store, route, cleanup } = setup();
  try {
    const before = store.stats();
    let thrown = null;
    try { await route("POST", "/api/projects/p1/file?path=docs%2Fa.md", { path: "docs/a.md" }); }
    catch (error) { thrown = error; }
    assert.ok(thrown, "POST 必须被拒");
    assert.equal(thrown.code, "USAGE_ERROR");
    // 只读路径本身也不该写任何东西（评论 / 事件 / 审计）。
    await route("GET", "/api/projects/p1/file?path=docs%2Fa.md");
    const after = store.stats();
    assert.equal(after.comments, before.comments);
    assert.equal(after.tasks, before.tasks);
  } finally { cleanup(); }
});

test("I resolveWorkspaceFile 是**纯函数式**的路径闸：工作区外一律抛错，不返回路径", () => {
  assert.throws(
    () => resolveWorkspaceFile({ workspacePath: "/tmp", relPath: "../etc/passwd" }),
    (error) => error.code === "FILE_PATH_TRAVERSAL",
  );
  assert.throws(
    () => resolveWorkspaceFile({ workspacePath: null, relPath: "a.md" }),
    (error) => error.code === "PROJECT_WORKSPACE_MISSING",
  );
});

test("J 前端契约：引用渲染成 button[type=button]；主路＝DSH 侧边栏，兜底＝抽屉内只读查看器", () => {
  const src = web();
  // 渲染：引用不再是「一行死文本」，而是可点按钮。
  assert.ok(src.includes("exec-record-refs"), "仍有引用列表容器");
  assert.ok(/renderEvidenceRef\(\{ kind, ref, label, projectId/.test(src), "引用走 renderEvidenceRef");
  assert.ok(/btn\.type = "button"/.test(src), "引用按钮必须是 type=button");
  assert.ok(src.includes("exec-ref-open"), "引用按钮带 exec-ref-open 类");
  // 点击：优先走宿主打开（探不到就降级）；**如实标注**走了哪条路。
  assert.ok(src.includes("openHostFile"), "必须优先走宿主打开");
  assert.ok(src.includes("host-file-open-unavailable") === false || src.includes("本实例没有宿主「打开文件」能力"), "无能力时如实说降级");
  assert.ok(src.includes("data.openVia") || src.includes("dataset.openVia"), "必须标注走了哪条路");
  assert.ok(src.includes("exec-ref-viewer"), "降级后有只读查看器");
  assert.ok(src.includes("REF_VIEWER_MAX_LINES"), "查看器有截断上限（显式提示已截断）");
  assert.ok(src.includes("exec-ref-viewer-trunc"), "截断必须显式写明");
  assert.ok(src.includes("exec-ref-viewer-ln"), "行号可开关");
  // 端点路径与参数口径必须与服务端一致（不许前端另写一套）。
  assert.ok(src.includes("/file?path="), "前端调的是服务端只读端点");
  // 第 2 轮返工口径：① 绝对路径**只认服务端回包**（侧边栏只认绝对路径，前端不许自己拼）；
  //   ② 主路是 DSH 侧边栏；③ 兜底必须**如实标注「兜底」**（不谎称已侧边栏打开）。
  assert.ok(/openHostFile\(payload\?\.absPath\)/.test(src), "必须用服务端回包的 absPath 调宿主");
  assert.ok(!/absoluteWorkspacePath/.test(src), "前端不许另写一套路径拼接（服务端回包才是权威）");
  assert.ok(src.includes("已在 DSH 侧边栏打开"), "主路成功文案写明「已在 DSH 侧边栏打开」");
  assert.ok(src.includes("兜底"), "兜底必须如实标注");
});

test("K 宿主能力探测：候选服务/方法逐一枚举，**打印真实 key 列表**，探不到就降级（不臆造成功）", () => {
  const cli = client();
  assert.ok(cli.includes("OPEN_FILE_SERVICES"), "客户端有候选服务表");
  assert.ok(cli.includes('"uiWorkspace"') && cli.includes('"sessions"') && cli.includes('"workspace"'), "三个候选服务都在");
  assert.ok(cli.includes("OPEN_FILE_METHODS"), "客户端有候选方法表");
  assert.ok(cli.includes("listServiceKeys"), "客户端会列服务的真实 key");
  assert.ok(cli.includes("log(\"open-file-probe\""), "探测结果必须打印（真实 key 列表）");
  assert.ok(cli.includes("host-file-open-unavailable") || cli.includes("better-sidebar-unavailable"), "探不到必须明确降级");
  assert.ok(cli.includes("openFile: hostOpenFile"), "探测结果要传给看板");
  // 宿主插件侧（服务端）也有一份探测：能力位 + 真实 key 列表。
  const host = hostPlugin();
  assert.ok(host.includes("probeOpenFile"), "宿主端口有打开文件探测");
  assert.ok(host.includes("probeOpenFileService"), "宿主端口暴露只读探测（供启动日志打印）");
  assert.ok(host.includes("openFile: probeOpenFile().some"), "能力位按真实探测给，不臆造");
  assert.ok(host.includes("openFileProbe="), "启动日志打印探测结果（真实 key 列表）");
});

/**
 * N（第 2 轮返工）· 客户端「**在 DSH 侧边栏打开文件**」出口。
 *
 * 这一段守的是 `lib/client.js` 里的**真代码**（把 `#region host-open-file` 原样切出来执行）——
 * 台内替身只能证明「前端会调它」，证明不了「软取 / openTab 实参 / scope」是对的。
 */
test("N 客户端侧边栏出口：探到才调、实参对得上、探不到明确降级（不臆造成功）", async () => {
  const cli = client();
  const start = cli.indexOf("// #region host-open-file");
  const end = cli.indexOf("// #endregion", start);
  assert.ok(start > 0 && end > start, "lib/client.js 里必须有 #region host-open-file 区块");
  // `#region` 注释行本身在函数体外是私有字段语法，切出来直接 eval 会炸 ⇒ 去掉那一行。
  const region = cli.slice(start, end).replace(/^\s*\/\/ #region[^\n]*\n/, "");
  const createHostOpenFile = new Function(`${region}; return createHostOpenFile;`)();

  // ① 有 betterSidebar ⇒ `openTab` 真被调一次，实参对得上。
  const calls = [];
  const openFile = createHostOpenFile({
    getService: (name) => (name === "betterSidebar" ? {
      openTab: (seed, scope) => { calls.push({ seed, scope }); },
      getTab: (id) => ({ id }),
      isTabEnabled: () => true,
      features: ["badge", "targetedOpen"],
    } : null),
  });
  const ok = await openFile("/abs/ws/docs/a.md", undefined, "sess-1");
  assert.equal(ok.ok, true);
  assert.equal(ok.via, "betterSidebar.openTab");
  assert.equal(calls.length, 1, "openTab 只能被调一次");
  assert.equal(calls[0].seed.type, "editor", "type 必须是 editor（走原生右侧栏）");
  assert.equal(calls[0].seed.path, "/abs/ws/docs/a.md", "path 必须是绝对路径");
  assert.equal(calls[0].scope.sessionId, "sess-1", "scope 必须带会话标识");
  assert.ok(!("line" in calls[0].seed), "没给行号时不许带这个键");
  assert.ok(ok.probed.betterSidebar.keys.includes("openTab"), "探测读数要带真实 key 列表");
  assert.equal(ok.probed.hostServices.length, 3, "次路候选服务三个都要探");

  // ② `line` 是 1-based：给了就原样带上去。
  const lineCalls = [];
  const withLine = createHostOpenFile({ getService: () => ({ openTab: (seed) => lineCalls.push(seed), isTabEnabled: () => true }) });
  await withLine("/abs/ws/docs/a.md", 12, "sess-2");
  assert.equal(lineCalls[0].line, 12, "line 原样带过去（1-based）");

  // ③ 没有 betterSidebar ⇒ 明确降级，**绝不**谎报成功。
  const missedCalls = [];
  const missed = createHostOpenFile({ getService: () => null });
  const missedResult = await missed("/abs/ws/docs/a.md", undefined, "sess-3");
  assert.equal(missedResult.ok, false);
  assert.match(missedResult.reason, /better-sidebar/);
  assert.equal(missedCalls.length, 0);

  // ④ cordis 的坑：`ctx.get` 对未声明 inject 的服务**会抛** ⇒ 出口必须自己吞掉。
  const throwing = createHostOpenFile({ getService: () => { throw new Error("cannot get property without inject"); } });
  const throwingResult = await throwing("/abs/ws/docs/a.md", undefined, "sess-4");
  assert.equal(throwingResult.ok, false, "取服务抛错时不得把异常抛给调用方");
  assert.match(throwingResult.reason, /better-sidebar/);

  // ⑤ `openTab` 抛错 ⇒ 明确降级 + 带上原消息。
  const boom = createHostOpenFile({ getService: () => ({ openTab: () => { throw new Error("侧边栏炸了"); }, isTabEnabled: () => true }) });
  const boomResult = await boom("/abs/ws/docs/a.md", undefined, "sess-5");
  assert.equal(boomResult.ok, false);
  assert.match(boomResult.reason, /侧边栏炸了/);

  // ⑥ 页签被禁用 ⇒ `openTab` 是静默 no-op ⇒ 不能算成功（如实说「被禁用」）。
  const disabled = createHostOpenFile({ getService: () => ({ openTab: () => {}, isTabEnabled: () => false }) });
  const disabledResult = await disabled("/abs/ws/docs/a.md", undefined, "sess-6");
  assert.equal(disabledResult.ok, false);
  assert.equal(disabledResult.reason, "better-sidebar-editor-disabled");

  // ⑦ `editor` 页签**未注册** ⇒ `openTab` 同样是静默 no-op ⇒ 也不能算成功。
  const unregistered = createHostOpenFile({ getService: () => ({ openTab: () => {}, getTab: () => undefined, isTabEnabled: () => true }) });
  const unregisteredResult = await unregistered("/abs/ws/docs/a.md", undefined, "sess-7");
  assert.equal(unregisteredResult.ok, false);
  assert.equal(unregisteredResult.reason, "better-sidebar-editor-unregistered");

  // ⑧ 老宿主没有 `getTab` / `isTabEnabled` ⇒ 判**未知**（不得当成「没注册」而误拒）。
  const legacy = createHostOpenFile({ getService: () => ({ openTab: () => {} }) });
  const legacyResult = await legacy("/abs/ws/docs/a.md", undefined, "sess-8");
  assert.equal(legacyResult.ok, true, "探不到判定方法时不得误拒（照常调 openTab）");
});

test("L 新错误码已登记进 ERROR_CATEGORY（不登记 ⇒ 退出码/契约就散了）", () => {
  for (const code of ["FILE_PATH_INVALID", "FILE_PATH_TRAVERSAL", "FILE_OUTSIDE_WORKSPACE", "FILE_NOT_FOUND", "FILE_NOT_A_FILE", "FILE_TOO_LARGE", "FILE_NOT_TEXT"]) {
    assert.ok(ERROR_CATEGORY[code] !== undefined, `${code} 未登记`);
  }
});

test("M 宿主端口的「打开文件」探测：探到才调用；探不到**明确降级**（不臆造成功）", async () => {
  // ① 宿主**有**这个能力 ⇒ 真去调，且回包带**真实 key 列表**（验收①要的就是这个）。
  const calls = [];
  const port = createHostSessionPort({
    getService: (name) => {
      if (name === "uiWorkspace") {
        return { openSession: () => {}, openFile: (p) => { calls.push(p); return true; }, listFiles: () => [] };
      }
      return null;
    },
  });
  const probed = port.probeOpenFileService();
  const ui = probed.find((p) => p.service === "uiWorkspace");
  assert.ok(ui?.present === true, "uiWorkspace 必须被探到");
  assert.ok(ui?.keys.includes("openFile"), "必须打印**真实** key 列表");
  assert.equal(ui?.openFileMethod, "openFile");
  const opened = await port.openFile("/abs/workspace/docs/a.md");
  assert.equal(opened.opened, true);
  assert.equal(opened.via, "uiWorkspace.openFile");
  assert.deepEqual(calls, ["/abs/workspace/docs/a.md"], "必须真把路径交给宿主");

  // ② 宿主**没有**这个能力 ⇒ 明确降级（不谎报成功）。
  const bare = createHostSessionPort({ getService: () => null });
  const bareProbed = bare.probeOpenFileService();
  assert.equal(bareProbed.length, 3, "三个候选服务都要探（即便不存在）");
  assert.ok(bareProbed.every((p) => p.present === false && p.openFileMethod === null), "探不到就是探不到");
  const missed = await bare.openFile("/abs/workspace/docs/a.md");
  assert.equal(missed.opened, false);
  assert.equal(missed.reason, "host-file-open-unavailable");
  // ③ 能力位按真实探测给（不恒 true、不恒 false）。
  assert.equal(bare.capabilities().openFile, false);
});
