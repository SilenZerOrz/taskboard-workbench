#!/usr/bin/env python3
"""SessionEnd：往 .codex/local/session-log.jsonl 追加一行留痕（同步，≤3 秒）。"""
import datetime, json, os, sys

def main():
    try:
        event = json.load(sys.stdin)
    except Exception:
        return 0
    cwd = event.get("cwd") or os.getcwd()
    d = os.path.join(cwd, ".codex", "local")
    try:
        os.makedirs(d, exist_ok=True)
        rec = {
            "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "session_id": event.get("session_id"),
            "cwd": cwd,
            "model": event.get("model"),
            "reason": event.get("reason"),
        }
        with open(os.path.join(d, "session-log.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass
    return 0

sys.exit(main())
