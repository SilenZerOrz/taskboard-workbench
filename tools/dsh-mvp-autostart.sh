#!/usr/bin/env bash
# dsh-mvp-autostart.sh —— 一条命令自启动测试环境（装插件 → 起 DSH web → 抓带 token URL
# → 开浏览器 → 自检 → 打印“该看到什么”）。幂等、可重复跑。用法：
#   bash tools/dsh-mvp-autostart.sh
# 覆盖：PROFILE=web（默认） · BASE 端口自动探测 · 不改任何业务代码。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(cd "$SCRIPT_DIR/.." && pwd)"
PROFILE="${PROFILE:-web}"
PROF_DIR="$HOME/.dsh/profiles/$PROFILE"
LOG="$(mktemp -t dsh-mvp-autostart.XXXXXX.log)"

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
die()  { printf '\n!! %s\n' "$*"; printf '   下一步：%s\n' "${2:-查看上面的输出并回传}"; exit 1; }

step "0) 环境探测"
command -v dsh  >/dev/null 2>&1 || die "找不到 dsh（请先安装 @deepseek-ai/dsh）" "安装 DSH 后重跑本脚本"
command -v node >/dev/null 2>&1 || die "找不到 node" "安装 Node 后重跑"
DSH_VER="$(dsh --version 2>/dev/null | head -1)"
PNPM="$(command -v pnpm 2>/dev/null || true)"
say "dsh: $DSH_VER    node: $(node -v)    pnpm: ${PNPM:-（未发现，仅备用）}"
say "profile: $PROFILE    project: $PROJ"
say "日志: $LOG"

step "1) 安装插件（幂等）"
installed=0
if [ -f "$PROF_DIR/package.json" ] && grep -q '"taskboard-workbench"' "$PROF_DIR/package.json"; then
  say "已在 profile dependencies 中，跳过安装"
  installed=1
fi
if [ "$installed" -eq 0 ]; then
  say "执行：dsh plugin --profile $PROFILE add \"$PROJ\""
  if ! dsh plugin --profile "$PROFILE" add "$PROJ"; then
    say "dsh plugin add 失败，改用 pnpm 直装"
    if [ -z "$PNPM" ]; then die "pnpm 不可用且 dsh plugin add 失败" "安装 pnpm 或回传 dsh 报错"; fi
    ( cd "$PROF_DIR" && pnpm add "$PROJ" ) || die "pnpm add 也失败" "回传上面的报错输出"
  fi
fi

step "2) 校验已进入 Loader 组合"
if ! dsh --profile "$PROFILE" --dump-config 2>/dev/null | grep -qi "taskboard-workbench"; then
  die "dump-config 未出现 taskboard-workbench（安装未生效或 profile 不对）" "确认 profile=$PROFILE 且安装命令成功；回传 dump-config 片段"
fi
say "OK：dump-config 命中 taskboard-workbench"

step "3) 启动 / 重启 DSH web"
running_port=""
for p in 3080 8080; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$p/" 2>/dev/null || echo 000)"
  if [ "$code" != "000" ]; then running_port="$p"; break; fi
done
if [ -n "$running_port" ]; then
  say "检测到已在 :$running_port 运行 → 需重启以加载新插件"
  pkill -f "dsh web" 2>/dev/null || true
  pkill -f "dsh --profile $PROFILE" 2>/dev/null || true
  sleep 1
fi
# 宿主 registry 运行时 shim（**默认关**；TB_REGISTRY_SHIM=1 开启）
# 只解决宿主层「新建会话 → Agent preset binding requires a scoped context」，
# 做法是 node --import 一个内存加载器，**不修改任何已安装文件**（见 tools/dsh-registry-shim/README.md）。
# ⚠ 2026-10-18 实测：开了它只会把第一个错误换成**后面那个**（prompt section 重复注册），
#   会话创建**仍然失败** → 单行补丁不足以修复该宿主缺陷，故默认关。
SHIM_HOOK="$PROJ/tools/dsh-registry-shim/hook.mjs"
if [ "${TB_REGISTRY_SHIM:-0}" = "1" ] && [ -f "$SHIM_HOOK" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $SHIM_HOOK"
  say "registry shim：已启用（${SHIM_HOOK}）—— 注意：实测不足以修复宿主会话创建"
else
  say "registry shim：未启用（默认；要开请设 TB_REGISTRY_SHIM=1）"
fi

# 宿主 dsh-scope「单实例归一」shim（**默认开**；TB_SCOPE_ALIAS=0 关闭）
# 解决的是同一个「新建会话 → Agent preset binding requires a scoped context」的**根因**：
# @deepseek-ai/dsh-scope 被加载了两份（profile .pnpm 一份、全局一份），而它的作用域键是
# 模块级 Symbol —— 两份实例 = 两个 Symbol，跨实例 scopeOf() 恒为 undefined。
# 本 shim 在内存里把所有 dsh-scope 的解析结果改写到同一个目录（两份文件 sha256 相同，
# 语义安全），同样**不修改任何已安装文件**。见 tools/dsh-scope-alias-shim/README.md。
# 2026-10-18 隔离实例（--port 3099）实测：开启后点「新建会话」不再报错且真落盘了新会话。
ALIAS_HOOK="$PROJ/tools/dsh-scope-alias-shim/hook.mjs"
if [ "${TB_SCOPE_ALIAS:-1}" = "1" ] && [ -f "$ALIAS_HOOK" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $ALIAS_HOOK"
  say "scope-alias shim：已启用（${ALIAS_HOOK}）—— 修「新建会话」报错；关闭请设 TB_SCOPE_ALIAS=0"
else
  say "scope-alias shim：未启用（TB_SCOPE_ALIAS=0）"
fi

# 宿主「工具链单实例归一」shim（**默认开**；TB_TOOLS_ALIAS=0 关闭）
# 解决的是另一个同族缺陷：会话内**工具调用 100% 失败**，宿主异常
#   Cannot read properties of undefined (reading 'prepare')
#   （dsh-agent-loop/lib/index.js:582 查 ctx.tools[TOOL_RUNTIME_SCHEDULER]，Symbol 是模块级常量）。
# 本机实测：dsh-tools 与 dsh-agent-loop 各有 4 份副本（全局 1 + profile .pnpm 3），
# sha256 完全相同 → 不同路径 = 不同模块实例 = 不同 Symbol。本 shim 在内存里归一到全局那份，
# 同样**不修改任何已安装文件**。见 tools/dsh-tools-alias-shim/README.md 与
# docs/进度/2026-10-19-主会话工具被宿主中断.md。
TOOLS_ALIAS_HOOK="$PROJ/tools/dsh-tools-alias-shim/hook.mjs"
if [ "${TB_TOOLS_ALIAS:-1}" = "1" ] && [ -f "$TOOLS_ALIAS_HOOK" ]; then
  export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--import $TOOLS_ALIAS_HOOK"
  say "tools-alias shim：已启用（${TOOLS_ALIAS_HOOK}）—— 修「会话内工具调用被中断」；关闭请设 TB_TOOLS_ALIAS=0"
else
  say "tools-alias shim：未启用（TB_TOOLS_ALIAS=0）"
fi

# 用 perl 调 setsid(2) 起**新会话**再 exec，避免 dsh web 随启动方会话被 killpg 回收。
# 坑：单纯 `nohup … &` 挡不住会话结束时对进程组的清理 —— 自检刚 PASS 就变 HTTP 000。
# macOS 没有 setsid 命令，故走 perl POSIX::setsid。
launch_detached() {
  nohup perl -e 'use POSIX qw(setsid); setsid(); exec @ARGV or die "exec failed: $!"' -- "$@" >"$LOG" 2>&1 &
}
if [ "$PROFILE" = "web" ]; then
  launch_detached dsh web --no-open
else
  launch_detached dsh --profile "$PROFILE" --no-open
fi
DSH_PID=$!
say "已后台启动（pid=${DSH_PID}），输出 → $LOG"

step "4) 抓取带 token 的 URL（≤30s）"
TOKEN_URL=""
for i in $(seq 1 30); do
  TOKEN_URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[A-Za-z0-9_-]+' "$LOG" 2>/dev/null | head -1)"
  [ -n "$TOKEN_URL" ] && break
  sleep 1
done
if [ -z "$TOKEN_URL" ]; then
  say "30s 内未抓到 token URL；日志最后 30 行："
  tail -n 30 "$LOG" 2>/dev/null || say "(日志为空)"
  die "无法获取带 token 的 URL" "看上面日志：若是“前端未构建”，在该 DSH checkout 跑 pnpm run build；否则回传日志"
fi
say "带 token URL: $TOKEN_URL"
BASE_URL="$(printf '%s' "$TOKEN_URL" | sed -E 's#(http://127\.0\.0\.1:[0-9]+)/.*#\1#')"

step "5) 自动打开浏览器（失败不阻断）"
if [ "$(uname)" = "Darwin" ]; then
  open "$TOKEN_URL" 2>/dev/null || say "open 失败；请手动打开上面的 URL"
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$TOKEN_URL" 2>/dev/null || say "xdg-open 失败；请手动打开上面的 URL"
else
  say "未找到浏览器打开器；请手动打开上面的 URL"
fi

step "6) 自检（用带 token 的 URL）"
VERIFY="$PROJ/tools/dsh-verify-mvp.mjs"
if [ -f "$VERIFY" ]; then
  node "$VERIFY" "$TOKEN_URL" 2>&1
  SELF=$?
else
  say "未找到 ${VERIFY}（跳过）"; SELF=0
fi

step "7) 你现在该看到什么"
cat <<TXT
  1) 浏览器已打开（或用上面的带 token URL 打开）DSH Web。
  2) 侧栏找【任务工作台】图标 → 点开主列面板。
  3) 面板顶部应有【看板 / 需求】切换；看板按状态分列显示任务。
  4) 对一条 todo 且已归因需求条目的任务，点【启动执行】→ 任务转“进行中”
     （无会话上下文时会给出可复制的“任务编号 + 指引”= 降级）。
TXT
if [ "${SELF:-0}" -ne 0 ]; then
  cat <<TXT

  ⚠ 自检有 FAIL：按上面逐项排查——
    · combo 未含 taskboard-workbench → 客户端半未注册：查首页 combo 是否列出本包；未列出=宿主 apply 抛错。
    · combo 请求 401 → 鉴权：本脚本已用带 token URL，若仍 401，回传该行。
    · 首页未含 taskboard-workbench → 起的不是 web profile 或未加载。
    · API 404 / 非 JSON → 宿主路由未注册：日志里搜「taskboard-workbench (taskboard-workbench): Error」。
      常见原因：apply 里读了 ctx.config（cordis 代理会抛 “cannot get property config without inject”），
      配置应取 apply(ctx, config) 的第二个参数。
  日志：${LOG}
TXT
fi
say ""
say "（后台 DSH 保持运行，供你继续操作；日志路径：${LOG}）"
exit 0
