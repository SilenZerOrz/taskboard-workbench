#!/usr/bin/env python3
"""Stop：一轮结束时做收尾校验。
有未提交改动且有 npm test 时跑测试；失败 -> decision=block 让模型继续修。
stop_hook_active 为真时直接放行，避免续跑死循环。
"""
import json, os, subprocess, sys

def sh(args, cwd, timeout):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    if event.get("stop_hook_active"):
        return 0
    if os.environ.get("CODEX_HOOK_STOP_TESTS") == "0":
        return 0
    cwd = event.get("cwd") or os.getcwd()
    pkg_path = os.path.join(cwd, "package.json")
    if not os.path.isfile(pkg_path):
        return 0
    try:
        pkg = json.load(open(pkg_path, encoding="utf-8"))
    except Exception:
        return 0
    if not (pkg.get("scripts") or {}).get("test"):
        return 0
    try:
        dirty = sh(["git", "status", "--porcelain"], cwd, 10).stdout.strip()
    except Exception:
        return 0
    if not dirty:
        return 0
    try:
        r = sh(["npm", "test", "--silent"], cwd, 120)
    except subprocess.TimeoutExpired:
        return 0
    if r.returncode != 0:
        tail = ((r.stdout or "") + (r.stderr or "")).strip().splitlines()[-25:]
        print(json.dumps({
            "decision": "block",
            "reason": "npm test 未通过，请先修好再收尾：\n" + "\n".join(tail),
        }, ensure_ascii=False))
    return 0

sys.exit(main())
