#!/usr/bin/env python3
"""UserPromptSubmit：提示词里出现明文凭据就拦下这一次提交。
命中 -> decision=block；未命中 -> exit 0 放行。加 #allow-secret 可临时放行。
"""
import json, re, sys

PATTERNS = [
    (r"\bsk-[A-Za-z0-9_-]{20,}", "API key（sk-…）"),
    (r"\bgh[pousr]_[A-Za-z0-9]{20,}", "GitHub token"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS Access Key"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "私钥文件内容"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
]

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    prompt = event.get("prompt") or ""
    if "#allow-secret" in prompt:
        return 0
    for pat, why in PATTERNS:
        if re.search(pat, prompt):
            print(json.dumps({
                "decision": "block",
                "reason": f"提示词里疑似含{why}。请替换为占位符（如 sk-REDACTED）后重发；确实需要我读取明文，请在消息里加 #allow-secret。",
            }, ensure_ascii=False))
            return 0
    return 0

sys.exit(main())
