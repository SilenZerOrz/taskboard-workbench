#!/usr/bin/env python3
"""PostToolUse / apply_patch：对改动过的文件做语法体检。
有错 -> decision=block 把错误回给模型；无错 -> exit 0。
只查 .mjs/.cjs/.json/.py，避免误伤。
"""
import json, os, subprocess, sys

def changed_files(cwd):
    out = []
    for args in (["git", "diff", "--name-only", "HEAD"],
                 ["git", "ls-files", "-o", "--exclude-standard"]):
        try:
            r = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=10)
            out += [l.strip() for l in r.stdout.splitlines() if l.strip()]
        except Exception:
            pass
    return sorted(set(out))

def check(path, cwd):
    ext = os.path.splitext(path)[1]
    full = os.path.join(cwd, path)
    if not os.path.isfile(full):
        return None
    try:
        if ext == ".json":
            json.load(open(full, encoding="utf-8"))
        elif ext in (".mjs", ".cjs"):
            r = subprocess.run(["node", "--check", full], capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                return (r.stderr or r.stdout).strip()[:400]
        elif ext == ".py":
            r = subprocess.run([sys.executable, "-m", "py_compile", full],
                               capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                return (r.stderr or r.stdout).strip()[:400]
    except Exception as e:
        return f"{type(e).__name__}: {e}"
    return None

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    cwd = event.get("cwd") or os.getcwd()
    bad = []
    for p in changed_files(cwd):
        err = check(p, cwd)
        if err:
            bad.append(f"- {p}: {err}")
    if bad:
        print(json.dumps({
            "decision": "block",
            "reason": "改动文件语法检查未通过，请先修复：\n" + "\n".join(bad),
        }, ensure_ascii=False))
    return 0

sys.exit(main())
