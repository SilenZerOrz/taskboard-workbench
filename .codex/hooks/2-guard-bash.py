#!/usr/bin/env python3
"""PreToolUse / Bash：拦下破坏性命令。
命中 -> 输出 permissionDecision=deny 阻断本次调用；未命中 -> exit 0 放行。
临时放行：命令里含 CODEX_ALLOW_DANGER，或环境变量 CODEX_HOOK_BASH_GUARD=0。
"""
import json, os, re, sys

PATTERNS = [
    (r"(^|[;&|]\s*)rm\s+(-[A-Za-z]+\s+)*-[A-Za-z]*[rf]", "递归/强制删除（rm -r / -f）"),
    (r"git\s+push\b[^\n]*(--force\b|--force-with-lease|\s-f\b)", "git 强推"),
    (r"git\s+reset\s+--hard", "git reset --hard"),
    (r"git\s+clean\s+-[A-Za-z]*[fd]", "git clean -f/-d"),
    (r"\b(mkfs|diskutil\s+erase|dd\s+if=)", "格式化 / 直写设备"),
    (r">\s*/dev/(sd|disk|rdisk)", "重定向到块设备"),
    (r"\bnpm\s+publish\b|\byarn\s+publish\b", "对外发包"),
    (r"\b(DROP|TRUNCATE)\s+(DATABASE|TABLE)\b", "SQL 删库删表"),
    (r"\bchmod\s+-R\s+777\s+/\s*$", "整盘 777"),
]

def main():
    if os.environ.get("CODEX_HOOK_BASH_GUARD") == "0":
        return 0
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    if event.get("tool_name") != "Bash":
        return 0
    cmd = ((event.get("tool_input") or {}).get("command") or "")
    if "CODEX_ALLOW_DANGER" in cmd:
        return 0
    for pat, why in PATTERNS:
        if re.search(pat, cmd):
            print(json.dumps({
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason":
                        f"被 2-危险命令守卫 拦下：{why}。确需执行请在命令里加 CODEX_ALLOW_DANGER 并说明理由。",
                }
            }, ensure_ascii=False))
            return 0
    return 0

sys.exit(main())
