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
# 2026-10-30：三个 --import shim（registry / scope-alias / tools-alias）**已全部下线并删除**。
# 原因：它们建立在「同一份源码被两条路径加载 ⇒ 两个模块级 Symbol」的假设上。实测三处副本
# 内容完全一致、且相关符号已用 Symbol.for 全局注册，该假设不成立（真病灶是 ToolRuntime
# 构造期竞态，见 dsh-tools 的 2026-10-30 补丁）。shim 会劫持模块解析、依赖本仓库路径，
# 仓库一移动服务就起不来，已从 LaunchAgent 移除。

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
