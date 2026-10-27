#!/usr/bin/env bash
# 把 taskboard-workbench 装进本地 DSH web profile（幂等；在【你的终端】运行，不在沙箱内）。
set -uo pipefail
PROJ="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="web"
BASE="${DSH_BASE:-http://127.0.0.1:3080}"

echo "== 1) 安装插件（绝对路径；重复运行安全）=="
if ! dsh plugin --profile "$PROFILE" add "$PROJ"; then
  echo "!! dsh plugin add 失败，改用 pnpm 直装（对照 agent-teams 既有装法）"
  ( cd "$HOME/.dsh/profiles/$PROFILE" && pnpm add "$PROJ" ) || echo "!!! 两种方式均失败：请回传上面输出"
fi

echo "== 2) 自检 profile 注册 =="
grep -n "taskboard-workbench" "$HOME/.dsh/profiles/$PROFILE/package.json" || echo "(dependencies 未出现本包)"
node -e "const p=require(process.env.HOME+'/.dsh/profiles/$PROFILE/package.json');console.log('bundles:',(p.dsh&&p.dsh.profile&&p.dsh.profile.bundles||[]).filter(b=>/taskboard-workbench/.test(b)))"
ls -la "$HOME/.dsh/profiles/$PROFILE/node_modules/" 2>/dev/null | grep -i taskboard || echo "(node_modules 未见 taskboard-workbench)"

echo "== 3) 重启 web profile 后，运行自检 =="
echo "   node \"$PROJ/tools/dsh-verify-mvp.mjs\" $BASE"
