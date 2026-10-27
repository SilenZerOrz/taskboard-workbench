#!/usr/bin/env bash
# dsh-core-pkg-dedupe/apply.sh —— 「宿主核心包多物理副本」的**根因级持久修复**（非产品代码）
#
# 要修的问题（与 tools/dsh-tools-alias-shim/ 同一根因，但那是运行时兜底）：
#   会话内工具调用以宿主异常收尾：
#     Cannot read properties of undefined (reading 'prepare')
#   抛出点：@deepseek-ai/dsh-agent-loop/lib/index.js:582
#     const prepared = await ctx.tools[TOOL_RUNTIME_SCHEDULER].prepare(call.exec);
#   TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler") 是**模块级** Symbol
#   （dsh-tools/lib/index.js:2526）。Symbol 在模块实例内唯一 ⇒ 进程里只要有**两份**
#   dsh-tools，就可能「A 实例挂调度器 / B 实例去查」⇒ 查到 undefined ⇒ 抛 .prepare。
#   同一个坑还有 dsh-scope（症状：新建会话报 Agent preset binding requires a scoped context）。
#
# pnpm 在 profile 下的实际拓扑（本机实测）：
#   · **真实副本目录**：.pnpm/@deepseek-ai+<pkg>@<ver>_<peerhash>/node_modules/@deepseek-ai/<pkg>
#     dsh-tools ×3、dsh-agent-loop ×3、dsh-scope ×2
#   · **成百个 peer 符号链接**：.pnpm/<其它包>@…/node_modules/@deepseek-ai/<pkg> → 指向上面的真实副本
#   所以只要「真实副本目录」多于一个，进程里就有多实例；peer 符号链接本身无害。
#
# 副本来源（已核对）：profile 的 package.json **并没有**声明 @deepseek-ai/dsh-tools，
# 副本来自 5 个社区插件的依赖声明（dsh-better-sidebar / dsh-chat-import / dsh-recall /
# dsh-supervisor / dsh-univer-office）＋ pnpm-workspace.yaml 里一条显式版本 override。
#   ⇒ 「删掉 package.json 里的声明」在本机不适用；「删 node_modules 重装」也**不会**消除副本
#     （重装后 pnpm 仍会为上述插件解析出 .pnpm 副本）。
#
# 本脚本的做法（＝推荐方案「确保全局只有一份」的实际落地）：
#   这些真实副本与宿主自带那份**内容完全相同**（sha256 一致，见 verify.mjs），
#   于是把每一份复制目录**替换为指向宿主那份的符号链接**。
#   Node 默认按 realpath 解析（preserveSymlinks=false）⇒ 所有解析路径落到同一个真实文件
#   ⇒ 模块实例唯一 ⇒ Symbol 唯一 ⇒ .prepare 不再落空。
#
# 不下载、不重装、不联网；幂等；可回滚。
#   体检：bash apply.sh --check      （只报不改；有副本时退出码 1）
#   应用：bash apply.sh --apply      （默认）
#   回滚：bash apply.sh --revert     （把符号链接原地还原成真实副本 = cp -R 宿主那份）
set -euo pipefail

PROFILE_DIR="${TB_PROFILE_DIR:-$HOME/.dsh/profiles/web}"
CANON_ROOT="${TB_CANON_ROOT:-$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai}"
PKGS=(dsh-tools dsh-agent-loop dsh-scope)
MODE="${1:---apply}"

NM="$PROFILE_DIR/node_modules"
[ -d "$NM" ] || { echo "✗ 找不到 $NM"; exit 1; }

# 只枚举 .pnpm 下的**真实副本目录**（排除 peer 符号链接：它们只是指向上面的真实副本）
find_copies() {
  local pkg="$1" d inner
  for d in "$NM"/.pnpm/"@deepseek-ai+$pkg"@*/; do
    [ -d "$d" ] || continue
    inner="${d%/}/node_modules/@deepseek-ai/$pkg"
    [ -d "$inner" ] || continue
    [ -L "$inner" ] && continue          # peer 链接，不是真实副本
    printf '%s\n' "$inner"
  done
}

TS="$(date +%Y%m%d-%H%M%S)"
BAK_ROOT="${TB_DEDUPE_BAK:-/private/tmp/dsh-dedupe-backup-$TS}"

need_apply=0
for pkg in "${PKGS[@]}"; do
  canon="$CANON_ROOT/$pkg"
  echo "### $pkg"
  if [ ! -d "$canon" ]; then echo "    ✗ 宿主副本不存在：$canon"; exit 1; fi
  echo "    宿主唯一副本：$canon"
  copies="$(find_copies "$pkg")"
  n=0
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    n=$((n + 1))
    echo "    · 真实副本：${dir#"$NM"/}"
  done <<< "$copies"

  if [ "$n" = 0 ]; then
    echo "    = 已归一（.pnpm 下无真实副本目录，全部是指向宿主的符号链接）"
    continue
  fi

  case "$MODE" in
    --check) need_apply=1 ;;
    --apply)
      # 先把清单取全再改盘（避免边遍历边改写）
      while IFS= read -r dir; do
        [ -n "$dir" ] || continue
        mkdir -p "$BAK_ROOT"
        safe="$(printf '%s' "${dir#"$NM"/}" | tr '/' '_')"
        mv "$dir" "$BAK_ROOT/$safe"
        ln -s "$canon" "$dir"
        echo "      → 已替换为符号链接（原件移入 $BAK_ROOT/${safe}）"
      done <<< "$copies"
      ;;
    --revert)
      echo "      · 无需还原（已是普通目录）" ;;
    *) echo "未知参数：$MODE"; exit 2 ;;
  esac
done

if [ "$MODE" = "--revert" ]; then
  for pkg in "${PKGS[@]}"; do
    canon="$CANON_ROOT/$pkg"
    for d in "$NM"/.pnpm/"@deepseek-ai+$pkg"@*/; do
      [ -d "$d" ] || continue
      inner="${d%/}/node_modules/@deepseek-ai/$pkg"
      if [ -L "$inner" ] && [ "$(readlink "$inner")" = "$canon" ]; then
        echo "    · 还原为真实副本：${inner#"$NM"/}"
        rm -f "$inner"
        cp -R "$canon" "$inner"
      fi
    done
  done
fi

echo
case "$MODE" in
  --check)
    if [ "$need_apply" = 0 ]; then echo "✓ 已归一：没有任何多余的真实副本"; else
      echo "✗ 仍存在多余的真实副本（＝会造出第二个模块实例）"; echo "  运行： bash $0 --apply"; exit 1; fi ;;
  --apply) echo "✓ 已归一。下一步： node tools/dsh-core-pkg-dedupe/verify.mjs" ;;
  --revert) echo "✓ 已还原为真实副本（回到修改前形态）" ;;
esac
