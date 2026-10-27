#!/usr/bin/env bash
# 给「由 LaunchAgent 托管的 dsh web 实例」注入**宿主单实例归一** shim（scope + tools）。
#
# 为什么需要：
#   桌面应用（com.deepseek.harness.web）拉起的 dsh web **不带 NODE_OPTIONS**，于是两处多副本问题复发：
#     ① `@deepseek-ai/dsh-scope` 多副本 → 新建会话报
#        "Agent preset binding requires a scoped context"
#     ② `@deepseek-ai/dsh-tools` 多副本 → 会话内工具调用被中断，回合以
#        "Cannot read properties of undefined (reading 'prepare')" 收尾
#
# 做法：把两个 `--import` 写进该 plist 的 EnvironmentVariables.NODE_OPTIONS（**幂等**，重复执行结果一致）。
#   shim 只在内存里改写模块解析，**不改任何已安装文件、不写盘**（见 tools/dsh-*-alias-shim/）。
#
# 回滚：脚本会先备份 plist 并打印备份路径；回滚＝把备份拷回 + 重启该服务（命令见脚本输出）。
set -euo pipefail

PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCOPE="$PROJ/tools/dsh-scope-alias-shim/hook.mjs"
TOOLS="$PROJ/tools/dsh-tools-alias-shim/hook.mjs"
LABEL="com.deepseek.harness.web"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -f "$PLIST" ] || { echo "✗ 找不到 $PLIST（该实例不是 LaunchAgent 托管？）"; exit 1; }
[ -f "$SCOPE" ] || { echo "✗ 找不到 $SCOPE"; exit 1; }
[ -f "$TOOLS" ] || { echo "✗ 找不到 $TOOLS"; exit 1; }

BAK="/private/tmp/dsh-web.plist.bak-$(date +%Y%m%d-%H%M%S)"
cp "$PLIST" "$BAK"

NODE_OPT="--import $SCOPE --import $TOOLS"
if /usr/libexec/PlistBuddy -c "Print :EnvironmentVariables:NODE_OPTIONS" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Set :EnvironmentVariables:NODE_OPTIONS '$NODE_OPT'" "$PLIST"
  ACTION="已更新"
else
  /usr/libexec/PlistBuddy -c "Add :EnvironmentVariables:NODE_OPTIONS string '$NODE_OPT'" "$PLIST"
  ACTION="已新增"
fi

plutil -lint "$PLIST"
echo "✓ $ACTION EnvironmentVariables.NODE_OPTIONS"
echo "  值：$NODE_OPT"
echo "  备份：$BAK"
echo "  回滚：cp \"$BAK\" \"$PLIST\" && launchctl kickstart -k gui/$(id -u)/$LABEL"
echo "  ⚠ 注意：NODE_OPTIONS 里写的是本仓库路径；若仓库被移动/删除，该服务将起不来（用上面回滚命令恢复）。"

# 关键：kickstart 只按**已加载的 job 定义**重启，不会重读 plist ⇒ 环境变量进不去。
# 要真正重载必须 bootout（卸载）后 bootstrap（按盘上 plist 重新加载）。
UID_NUM="$(id -u)"
if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "gui/$UID_NUM/$LABEL" >/dev/null 2>&1 || true
fi
sleep 1
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
echo "✓ 已重启 ${LABEL}（约 5–10 秒后就绪；token 会变，取法见 docs）"
