/**
 * 面板脚本陈旧自愈（2026-10-22 真机第四次踩坑，`-80`/`-126` 同类）。
 *
 * 宿主页面是长生命周期的：`ensureAssets()` 只在**每次挂载面板**时重新注入脚本，
 * 面板开着不重挂就永远停在旧构建 ⇒ 用户看到的是几小时前的界面（抽屉 `版本 v3` vs 服务端 `v8`、
 * 需求条目打裸 UUID），据此反复判断「改的代码根本没生效」。
 *
 *  A. 纯函数：从 `lib/client.js` 的 `#region pure-assets-fingerprint` 区块**提取执行**（不是只做源码断言）
 *  B. 胶水层：探测 → 指纹比对 → 重注入 → 重建看板的源码形态（节流 / 摘监听 / 先 destroy 再建）
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");

function loadPureFunctions() {
  const start = source.indexOf("// #region pure-assets-fingerprint");
  const end = source.indexOf("// #endregion", start);
  assert.ok(start >= 0 && end > start, "必须保留 pure-assets-fingerprint 区块（纯函数提取点）");
  const body = source.slice(start, end);
  return new Function(`${body}; return { assetsFingerprint, mergeFingerprint, shouldReloadAssets, classifyAssetsChange };`)();
}

test("A3. 探测函数：必须真的分别取回 app.js 与 tokens.css 两份字节（`-80` 补口的可执行防线）", async () => {
  // 上一轮反证暴露的测试缺口：源码正则断言无法发现「探测恒返回空字���」这类回归
  // （mergeFingerprint 会整体作废 ⇒ shouldReloadAssets 恒 false ⇒ 全绿）。
  // 这里用假 fetch 直接驱动 probeAssetsFingerprints()，把「取的是哪两个 URL」钉死。
  const region = source.slice(source.indexOf("  let assetsPromise = null; //"), source.indexOf("  window.__ModuleLoader__.load({"));
  const served = {
    "/integrations/taskboard-workbench/app.js": "app 初始构建",
    "/integrations/taskboard-workbench/tokens.css": ".a { color: red; }",
  };
  const requested = [];
  const fetchStub = (url, opts) => {
    requested.push({ url, cache: opts?.cache });
    if (!(url in served)) return Promise.reject(new Error(`unexpected url: ${url}`));
    return Promise.resolve({ text: () => Promise.resolve(served[url]) });
  };
  const win = { __TB_BOARD__: undefined, setTimeout: () => 0 };
  const doc = { head: { appendChild() {} }, getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } }) };
  const api = new Function(
    "document", "window", "BASE", "report", "fetch",
    `${region}\n return { probeAssetsFingerprints, mergeFingerprint };`,
  )(doc, win, "/integrations/taskboard-workbench", {}, fetchStub);

  const { js, css } = await api.probeAssetsFingerprints();
  assert.equal(requested.length, 2, "一次探测必须取两份资源");
  assert.deepEqual(
    requested.map((r) => r.url).sort(),
    ["/integrations/taskboard-workbench/app.js", "/integrations/taskboard-workbench/tokens.css"],
    "探测必须同时覆盖 app.js 与 tokens.css（只探 app.js 会让纯 CSS 修复在长生命周期面板上失效）",
  );
  assert.ok(requested.every((r) => r.cache === "no-store"), "两份都必须绕过缓存");
  assert.ok(js && css, "两份字节都必须真的取回来（不能是空串）");
  assert.equal(api.mergeFingerprint(js, css) !== "", true, "两份齐了才构得出可用基线");

  // 只改 tokens.css ⇒ css 指纹变、js 指纹不变（这正是 -80 的场景）
  const jsBefore = js;
  served["/integrations/taskboard-workbench/tokens.css"] = ".a { color: red; } .b { color: blue; }";
  const after = await api.probeAssetsFingerprints();
  assert.equal(after.js, jsBefore, "只改 CSS 不得影响 js 指纹");
  assert.notEqual(after.css, css, "只改 CSS 必须让 css 指纹变化");
});

test("A. 指纹纯函数：同字节同指纹、变一字节即变、无基线一律不重载", () => {
  const { assetsFingerprint, shouldReloadAssets } = loadPureFunctions();
  const a = assetsFingerprint("const x = 1;\n");
  const b = assetsFingerprint("const x = 1;\n");
  const c = assetsFingerprint("const x = 1; // 注释\n");
  assert.equal(a, b, "同字节必须同指纹（否则会无谓重挂看板）");
  assert.notEqual(a, c, "只加一个注释也必须变指纹（真机自查就靠这个）");
  assert.equal(shouldReloadAssets(a, b), false);
  assert.equal(shouldReloadAssets(a, c), true);
  assert.equal(shouldReloadAssets("", c), false, "还没记上基线时不许重载");
  assert.equal(shouldReloadAssets(a, ""), false, "服务端取不到字节时不许重载");
  assert.doesNotThrow(() => assetsFingerprint(undefined), "非字符串输入不许抛（探测路径不能拖垮面板）");
  assert.equal(assetsFingerprint(""), "0-811c9dc5");
});

test("A2. 指纹必须覆盖 tokens.css：`-80` 的补口（只改 CSS 也要能判出变化）", () => {
  const { assetsFingerprint, mergeFingerprint, shouldReloadAssets, classifyAssetsChange } = loadPureFunctions();
  const jsV1 = assetsFingerprint("app 初始构建");
  const jsV2 = assetsFingerprint("app 第二版构建");
  const cssV1 = assetsFingerprint(".a { color: red; }");
  const cssV2 = assetsFingerprint(".a { color: red; } .b { color: blue; }");

  const base = mergeFingerprint(jsV1, cssV1);
  assert.notEqual(jsV1, cssV1, "两侧指纹必须本身可区分（否则合并基线分不出 js/css，测试就失去意义）");
  assert.equal(mergeFingerprint("", cssV1), "", "缺一侧 ⇒ 整条基线作废（半份基线不能拿去比对）");
  assert.equal(mergeFingerprint(jsV1, ""), "");
  assert.equal(mergeFingerprint(jsV1, cssV1), base, "同样两侧必须合并成同样的基线");

  // 只改 CSS：这是 -80 的原样场景（纯样式修复、面板开着一整天不重挂）
  const cssChanged = mergeFingerprint(jsV1, cssV2);
  assert.equal(shouldReloadAssets(base, cssChanged), true, "只改 CSS 必须判定为「需要刷新」");
  assert.equal(classifyAssetsChange(base, cssChanged), "css", "且必须识别为纯样式变化（轻量处置）");

  assert.equal(classifyAssetsChange(base, mergeFingerprint(jsV2, cssV1)), "js", "只改 JS ⇒ 重建看板");
  assert.equal(classifyAssetsChange(base, mergeFingerprint(jsV2, cssV2)), "both", "两边都变");
  assert.equal(classifyAssetsChange(base, base), "none", "没变就不要动");
  assert.equal(classifyAssetsChange("", cssChanged), "unknown", "基线缺失不猜");
  assert.equal(classifyAssetsChange(base, ""), "unknown", "探测缺一侧不猜");
  assert.equal(classifyAssetsChange(base, "垃圾指纹"), "unknown", "格式不认识也不猜");
});

test("B. 胶水：回页签/定时探测 → 变了才重注入并重建；节流、摘监听、先 destroy 再建", () => {
  assert.match(source, /const STALE_CHECK_MIN_MS = \d+;/, "需要探测节流常量");
  assert.match(source, /function assetsFingerprint\(text\)/);
  // 探测必须**两份资源都覆盖**：只探 app.js 会让「只改 tokens.css」在长生命周期面板上失效（-80 的补口）
  assert.match(source, /fetch\(`\$\{BASE\}\/app\.js`, \{ cache: "no-store" \}\)/, "探测必须绕过缓存取 app.js 字节");
  assert.match(source, /fetch\(`\$\{BASE\}\/tokens\.css`, \{ cache: "no-store" \}\)/, "探测必须同样绕过缓存取 tokens.css 字节");
  assert.match(source, /if \(now - lastStaleCheckAt < STALE_CHECK_MIN_MS\) return;/, "探测必须节流");
  assert.match(source, /shouldReloadAssets\(loadedFingerprint, current\)/, "必须用指纹判据决定是否重载");
  assert.match(source, /resetAssets\(\);/, "重注入前要清掉旧脚本（否则残留旧工厂）");

  const staleBody = source.slice(source.indexOf("const checkForStaleBundle"), source.indexOf("const onReturn"));
  assert.match(staleBody, /if \(cancelled\) return;/, "卸载后不再动作");
  assert.match(staleBody, /ensureAssets\(\)[\s\S]*mountBoard\(\)/, "重注入后必须重建看板");
  assert.match(staleBody, /catch\(\(\) => \{ \/\* 探测失败不阻断面板 \*\/ \}\);/, "探测失败不许影响面板");
  // 纯 CSS 变化走轻量处置：重挂样式表，不重建看板
  assert.match(staleBody, /if \(kind === "css"\) \{[\s\S]*ensureStyles\(true\);[\s\S]*return;/,
    "只有样式变了时必须只重挂样式表（不重建看板、不闪 loading）");
  assert.match(staleBody, /if \(kind === "unknown"\) return;/, "半份基线不猜，不做任何处置");

  const mountBody = source.slice(source.indexOf("const mountBoard"), source.indexOf("const rememberFingerprint"));
  assert.ok(mountBody.indexOf("destroy()") < mountBody.indexOf("createBoard("), "重建前必须先 destroy 旧控制器");

  assert.match(source, /window\.addEventListener\("focus", onReturn\)/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onReturn\)/);
  assert.match(source, /window\.setInterval\(onReturn, STALE_CHECK_MIN_MS \* 2\)/, "长时间盯着面板也要能自愈");
  assert.match(source, /window\.removeEventListener\("focus", onReturn\)/, "卸载要摘监听");
  assert.match(source, /document\.removeEventListener\("visibilitychange", onReturn\)/);
  assert.match(source, /if \(staleTimer\) window\.clearInterval\(staleTimer\)/);
});
