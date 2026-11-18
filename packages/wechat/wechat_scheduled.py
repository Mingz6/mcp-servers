#!/usr/bin/env python3
"""Scheduled WeChat capture, the entry point launchd runs (see launchd/ and install_launchd.sh).

    python3 wechat_scheduled.py snapshot    # one screenshot + OCR, never clicks, never marks anything read
    python3 wechat_scheduled.py auto-read   # real clicks, ONLY the chats named in ~/.wechat-export/ocr/allowlist.txt

Every run prints exactly one log line and exits 0 when there was simply nothing to do (WeChat closed or
logged out, screen locked, window hidden, Mac not idle, another run still going, empty allowlist):
  <time> ok: ...      captured
  <time> skip: ...    nothing to do, by design
  <time> error: ...   something broke (exit 1)
The logs hold counts and reasons, never chat names or message text.
"""

from __future__ import annotations

import argparse
import fcntl
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import wechat_ocr as w

ALLOWLIST = w.DATA_DIR / "allowlist.txt"
LOCK = w.DATA_DIR / "scheduled.lock"


def log(line: str) -> None:
    print(f"{datetime.now().isoformat(timespec='seconds')} {line}", flush=True)


def read_allowlist(path: Path | None = None) -> list[str]:
    """One chat name per line; blank lines and lines starting with # are ignored."""
    try:
        lines = (path or ALLOWLIST).read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []
    return [n.strip() for n in lines if n.strip() and not n.lstrip().startswith("#")]


def wechat_running() -> bool:
    return subprocess.run(["pgrep", "-x", "WeChat"], capture_output=True).returncode == 0


def skip_reason() -> str:
    """Why a capture would be pointless right now, or ''. Cheap checks first."""
    if not wechat_running():
        return "WeChat is not running"
    if w._screen_locked():
        return "the screen is locked"
    return ""


def run_snapshot() -> int:
    snap = w.snapshot()
    res = w.save(snap)
    log(f"ok: snapshot, {len(snap['chat_list'])} chat rows, {len(res['new'])} new or changed")
    return 0


def run_auto_read(names: list[str], days: int, idle: int) -> int:
    if not names:
        log(f"skip: allowlist is empty ({ALLOWLIST})")
        return 0
    res = w.auto_read(w.Desk(), names, top=len(names), days=days, idle_secs=idle)
    if res["chats"]:
        log(f"ok: auto-read, {len(res['chats'])} of {len(names)} allowlisted chats read"
            + (f", stopped: {res['stopped']}" if res["stopped"] else ""))
    else:
        log(f"skip: auto-read read nothing ({res['stopped'] or 'no reason given'})")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("mode", choices=["snapshot", "auto-read"])
    ap.add_argument("--days", type=int, default=2, help="auto-read: read back this many days")
    ap.add_argument("--idle", type=int, default=120, help="auto-read: seconds without keyboard or mouse input required")
    args = ap.parse_args(argv)

    w.DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            log("skip: the previous run is still going")
            return 0
        try:
            why = skip_reason()
            if why:
                log(f"skip: {why}")
                return 0
            if args.mode == "snapshot":
                return run_snapshot()
            return run_auto_read(read_allowlist(), args.days, args.idle)
        except w.OcrError as e:
            msg = str(e)
            # Window gone or blank: WeChat minimized to the menu bar, on the login QR code, or the grant is missing.
            if msg.startswith("No WeChat window") or "almost no text" in msg:
                log(f"skip: {msg.split(':')[0]} (if this repeats for days, check Screen Recording for the launcher)")
                return 0
            log(f"error: {msg}")
            return 1
        except Exception as e:  # launchd gets one readable line, not a traceback
            log(f"error: {type(e).__name__}: {e}")
            return 1


if __name__ == "__main__":
    sys.exit(main())
