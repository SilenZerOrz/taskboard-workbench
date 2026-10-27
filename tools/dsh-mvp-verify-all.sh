#!/usr/bin/env bash
# dsh-mvp-verify-all.sh —— 一条命令跑完的"终极真机验证"。
# 自动：装插件 → 起/重启 DSH web → 抓带 token URL → 开浏览器 → V1 加载层 / V2 后端链路 / V3 启动执行 / V4 派发团队
#       → 打印【可直接贴回】的 YAML 报告；V5 UI 与 V3/V4 的人工部分按提示补。
# 用法：bash tools/dsh-mvp-verify-all.sh        （覆盖：PROFILE=web；端口自动）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${PROFILE:-web}"
PROF_DIR="$HOME/.dsh/profiles/$PROFILE"
LOG="$(mktemp -t dsh-mvp-verify.XXXXXX.log)"
NODE_PROG="$(mktemp -t dsh-mvp-verify).mjs"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf '\n!! %s\n' "$*"; printf '   下一步：%s\n' "${2:-查看上面的输出并回传}"; exit 1; }

step "0) 环境探测"
command -v dsh >/dev/null 2>&1 || die "找不到 dsh" "安装 @deepseek-ai/dsh 后重跑"
command -v node >/dev/null 2>&1 || die "找不到 node" "安装 Node 后重跑"
DSH_VER="$(dsh --version 2>/dev/null | head -1)"
PNPM="$(command -v pnpm 2>/dev/null || true)"
say "dsh: $DSH_VER    node: $(node -v)    pnpm: ${PNPM:-（未发现）}    profile: $PROFILE"

step "1) 安装插件（幂等）"
if [ -f "$PROF_DIR/package.json" ] && grep -q '"taskboard-workbench"' "$PROF_DIR/package.json"; then
  say "已在 profile dependencies 中，跳过安装"
else
  dsh plugin --profile "$PROFILE" add "$PROJ" || { [ -n "$PNPM" ] && ( cd "$PROF_DIR" && pnpm add "$PROJ" ) || die "安装失败" "回传上面报错"; }
fi
DUMP="未命中"
dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -qi "taskboard-workbench" && DUMP="命中"
say "dump-config: $DUMP"
[ "$DUMP" = "命中" ] || die "dump-config 未命中 taskboard-workbench（未生效或 profile 不对）" "确认 profile=$PROFILE 与安装结果"

step "2) 启动 / 重启 DSH web"
running=""
for p in 3080 8080; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/" 2>/dev/null || echo 000)"
  [ "$code" != "000" ] && { running="$p"; break; }
done
if [ -n "$running" ]; then
  say "检测到 :$running 在跑 → 重启以加载插件"
  pkill -f "dsh web" 2>/dev/null || true
  pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
  sleep 1
fi
if [ "$PROFILE" = "web" ]; then nohup dsh web --no-open >"$LOG" 2>&1 &
else nohup dsh --profile "$PROFILE" --no-open >"$LOG" 2>&1 & fi
say "后台启动（pid=$!）；日志 → $LOG"

step "3) 抓带 token 的 URL（≤30s）"
TOKEN_URL=""
for i in $(seq 1 30); do
  TOKEN_URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1)"
  [ -n "$TOKEN_URL" ] && break
  sleep 1
done
if [ -z "$TOKEN_URL" ]; then say "未抓到 token URL；日志最后 30 行："; tail -n 30 "$LOG" 2>/dev/null; die "无法获取带 token URL" "看日志（若“前端未构建”先 pnpm run build）"; fi
BASE_URL="$(printf '%s' "$TOKEN_URL" | sed -E 's#(http://127\.0\.0\.1:[0-9]+)/.*#\1#')"
TOKEN="$(printf '%s' "$TOKEN_URL" | sed -E 's#.*[?&]token=([A-Za-z0-9_-]+).*#\1#')"
PORT="$(printf '%s' "$BASE_URL" | sed -E 's#.*:([0-9]+)$#\1#')"
say "URL: $TOKEN_URL"

step "4) 打开浏览器（失败不阻断）"
case "$(uname)" in
  Darwin) open "$TOKEN_URL" 2>/dev/null || say "open 失败：请手动打开上面的 URL" ;;
  *) command -v xdg-open >/dev/null 2>&1 && xdg-open "$TOKEN_URL" 2>/dev/null || say "请手动打开上面的 URL" ;;
esac

# ---- 内嵌 Node 程序：V1–V4 自动化 + YAML 报告 ----
cat > "$NODE_PROG" <<'NODEPROG'
const BASE = (process.argv[2] || "").replace(/\/+$/, "");
const TOKEN = process.argv[3] || "";
const API = `${BASE}/integrations/taskboard-workbench/api`;
let cookie = "";
const H = () => (cookie ? { cookie } : {});
const line = (s) => console.log(s);
async function raw(pathOrUrl, opts = {}) {
  const url = /^https?:/.test(pathOrUrl) ? pathOrUrl : BASE + pathOrUrl;
  return fetch(url, { ...opts, headers: { ...H(), ...(opts.headers || {}) }, redirect: opts.redirect ?? "manual" });
}
async function handshake() {
  if (!TOKEN) return;
  try {
    const u = new URL(BASE + "/"); u.searchParams.set("token", TOKEN);
    const r = await fetch(u, { redirect: "manual" });
    const sc = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie")].filter(Boolean);
    for (const c of sc) { const m = /(dsh-auth-[^=]+)=([^;]+)/.exec(c || ""); if (m) { cookie = `${m[1]}=${m[2]}`; return; } }
  } catch { /* ignore */ }
}
async function json(pathOrUrl, opts = {}) {
  const r = await raw(pathOrUrl, opts);
  const t = await r.text();
  let b = null; try { b = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, body: b, text: t };
}
const P = (s) => console.log(s);

await handshake();

// ---------------- V1 加载层 ----------------
const v1 = [];
try {
  // DSH 不单独伺服 /plugins/<pkg>/client.js；客户端半按组合 URL 内联进首页，故从首页抓 combo 复核。
  const r = await raw("/"); const t = await r.text();
  const combo = /plugins\/\?\?[^"']*taskboard-workbench\/client\.js[^"']*/.exec(t)?.[0];
  if (!t.includes("taskboard-workbench")) v1.push(`GET / 含包名: 否(HTTP ${r.status})`);
  else if (!combo) v1.push(`GET / 含包名: 是；但 combo 未含客户端半`);
  else { const cr = await raw("/" + combo.replace(/&amp;/g, "&")); const ct = await cr.text(); v1.push(`combo 含本插件: ${cr.status === 200 && ct.includes("taskboard-workbench") ? "是" : "否"} (HTTP ${cr.status})`); }
} catch (e) { v1.push(`GET /: ERR ${e.message}`); }
try { const r = await json(`${API}/tasks`); v1.push(`API tasks: ${r.body ? "JSON (count=" + r.body.count + ")" : "非JSON HTTP " + r.status}`); } catch (e) { v1.push(`API tasks: ERR ${e.message}`); }
P("【V1 加载层】"); v1.forEach(P);

// ---------------- V2 后端链路（FR-34…39） ----------------
P("【V2 后端链路】");
const v2 = {};
async function step2(name, fn) { try { const detail = await fn(); P(`${name}: PASS ${detail ?? ""}`); v2[name] = "PASS"; } catch (e) { P(`${name}: FAIL ${e.message}`); v2[name] = "FAIL"; } }
let docId = null, itemId = null, itemRef = null, taskA = null, taskB = null;
await step2("建文档", async () => {
  const list = await json(`${API}/requirements/docs?project=default`);
  const existing = list.body?.docs?.[0];
  if (existing) { docId = existing.id; return `(复用 ${existing.id.slice(0, 8)})`; }
  const created = await json(`${API}/requirements/docs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "default", body: "# 验证需求\n- 需求A\n- 需求B\n" }) });
  if (created.status >= 400) throw new Error(`HTTP ${created.status} ${created.text.slice(0, 80)}`);
  docId = created.body?.doc?.id; return `(${docId?.slice(0, 8)})`;
});
await step2("建条目", async () => {
  const created = await json(`${API}/requirements/items`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: "default", title: "验证条目-" + Date.now(), acceptance: "可判定" }) });
  if (created.status >= 400) throw new Error(`HTTP ${created.status} ${created.text.slice(0, 80)}`);
  itemRef = created.body?.item?.identifier; itemId = created.body?.item?.id; return `(${itemRef})`;
});
await step2("设可行性", async () => {
  const r = await json(`${API}/requirements/items/${encodeURIComponent(itemRef)}/feasibility`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ verdict: "feasible", reason: "verify", by: "machine" }) });
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`); return `(feasibility=${r.body?.item?.feasibility})`;
});
await step2("分拆任务", async () => {
  const r = await json(`${API}/requirements/items/${encodeURIComponent(itemRef)}/split`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: [{ title: "验证任务A" }, { title: "验证任务B", dependsOn: ["验证任务A"] }] }) });
  if (r.status >= 400) throw new Error(`HTTP ${r.status} ${r.text.slice(0, 80)}`);
  taskA = r.body?.tasks?.[0]?.identifier; taskB = r.body?.tasks?.[1]?.identifier; return `(${taskA} → ${taskB})`;
});
await step2("建依赖(校验)", async () => {
  if (!taskB) throw new Error("无任务B");
  const r = await json(`${API}/tasks/${encodeURIComponent(taskB)}/dependencies`);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return `(blockers=${r.body?.blockers?.length ?? "?"})`;
});

// ---------------- V3 启动执行 ----------------
P("【V3 启动执行】");
try {
  // 把 A 置为 todo（先读 version）
  const detail = await json(`${API}/tasks/${encodeURIComponent(taskA)}`);
  const v = detail.body?.task?.version;
  await json(`${API}/tasks/${encodeURIComponent(taskA)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ version: v, status: "todo" }) });
  const exec = await json(`${API}/tasks/${encodeURIComponent(taskA)}/execute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
  const L = exec.body?.launch ?? {};
  P(`launch.mode: ${L.mode ?? "?"}`);
  P(`presetApplied: ${L.presetApplied === undefined ? "null" : L.presetApplied}`);
  P(`reason: ${L.reason ?? ""}`);
} catch (e) { P(`launch.mode: ERR ${e.message}`); }

// ---------------- V4 派发团队 ----------------
P("【V4 派发团队】");
try {
  const disp = await json(`${API}/teams`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetTask: taskA }) });
  const b = disp.body ?? {};
  P(`mode: ${b.mode ?? "?"}`);
  P(`team.id: ${b.team?.id ?? ""}`);
  P(`locks: ${b.locks?.length ?? 0}`);
  P(`draft: ${b.draft ? "有" : "无"}`);
} catch (e) { P(`mode: ERR ${e.message}`); }
NODEPROG

step "5) 执行自动化验证（V1–V4）并生成回传报告"
say ""
say '```yaml'
node "$NODE_PROG" "$BASE_URL" "$TOKEN" || say "【自动化】node 程序异常退出（见上方 stderr）"
say "【V3/V4 人工部分】"
say "V3 确认弹窗: 有/无（请在面板点“启动执行”观察）"
say "V4 会话收到“派发指令”: 是/否（看目标会话）"
say "【V5 UI（人工）】"
say "侧栏入口「任务工作台」: 有/无"
say "看板/需求: 可切/不可切"
say "左侧留空: 消失/仍在（请截图）"
say "404: 自动恢复/仍需手点"
say "【环境】"
say "DSH 版本: ${DSH_VER}"
say "端口: ${PORT}"
say "dump-config: ${DUMP}"
say "时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
say "日志: ${LOG}"
say '```'
say ""
say "↑ 把上面 yaml 代码块整段贴回即可（V3/V4 人工部分与 V5 按提示补充，附截图）。"
