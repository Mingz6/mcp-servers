#!/usr/bin/env python3
"""Read WeChat by screenshot + Apple Vision OCR. No database keys, no re-signing.

Captures the main WeChat window (works while it is in the background or on another
display), OCRs it, and saves the chat list (name, time, last-message preview, unread)
and the transcript of the chat that is open. Output goes to ~/.wechat-export/ocr/.

Usage: python wechat_ocr.py [--json] [--keep-image] [--stitch SECONDS [--chat NAME]]
       python wechat_ocr.py --auto-read [--chats A,B | --top N] [--days N] [--idle S] [--wait MIN]
Needs Screen Recording permission for the app that launches it (VS Code, Terminal); --auto-read also
needs Accessibility, because it clicks and scrolls for real, and only runs while nobody is using the Mac.
Layout constants below are pixel positions of WeChat 4.1 at 1x; they scale with the capture.
"""

from __future__ import annotations

import argparse
import difflib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta
from pathlib import Path

DATA_DIR = Path.home() / ".wechat-export" / "ocr"
HELPER = Path.home() / ".wechat-export" / "bin" / "wxvision"
HELPER_SRC = Path(__file__).with_name("wxvision.swift")

LIST_LEFT, LIST_RIGHT = 100, 247  # chat list text column (left rail is 0-60, avatars 72-108)
ROW_H = 65
BODY_TOP = 85  # below the title bar and the pinned-announcement strip
INPUT_H = 292  # message input box at the bottom
BUBBLE_LEFT = 332  # incoming bubbles start left of this; outgoing ones start right of it
OUT_LEFT = 420  # text starting right of this is an outgoing bubble (incoming cards with an icon start near 350)
LABEL_LEFT = 321  # group-chat sender labels start left of this, bubble text right of it

TIME_ONLY = re.compile(r"^[\d:：]{4,5}$")
TIME_STAMP = re.compile(r"^(?:[A-Za-z]+\s+)?(?:\d{1,2}/\d{1,2}\s+)?\d{1,2}:\d{2}$")
SIDE_TIME = re.compile(r"^(\d{1,2}[:：]\d{2}|\d{1,2}/\d{1,2}(/\d{2,4})?|Yes\w*.*|昨天.*|星期.)$")
TRAILING_TIME = re.compile(r"^(.*?)\s*(\d{1,2}:\d{2}|\d{1,2}/\d{1,2}|Yesterday.*|昨天.*)$")
UNREAD_PREFIX = re.compile(r"^[\[［]?\s*(\d{1,3})\s*[\]］|｜]\s*")
GROUP_TITLE = re.compile(r"[(（]\d+[)）]\s*$")  # group chat titles end in the member count
WECHAT_BUNDLE = "com.tencent.xinWeChat"
# Folders and service chats that are not conversations with a person or group.
SKIP_CHATS = re.compile(
    r"^(File Transfer|文件传输助手|Subscriptions?|Subscription Accounts?|订阅号|Official Accounts?|服务号|Service Accounts?|"
    r"Mini Programs?|小程序|Weixin Team|微信团队)",
    re.I,
)
_STAMP = re.compile(
    r"^(?:(?P<word>[A-Za-z]+|今天|昨天|星期[一二三四五六日])\s*)?"
    r"(?:(?P<m>\d{1,2})/(?P<d>\d{1,2})(?:/(?P<y>\d{2,4}))?\s+)?(?P<H>\d{1,2}):(?P<M>\d{2})$"
)
_ABS_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]


class OcrError(RuntimeError):
    pass


def _run(cmd: list[str], timeout: int = 120) -> str:
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise OcrError(f"{Path(cmd[0]).name} failed: {(r.stderr or r.stdout).strip()[:300]}")
    return r.stdout


def _helper() -> str:
    if not HELPER.exists() or HELPER.stat().st_mtime < HELPER_SRC.stat().st_mtime:
        HELPER.parent.mkdir(parents=True, exist_ok=True)
        _run(["swiftc", "-O", str(HELPER_SRC), "-o", str(HELPER)], timeout=300)
    return str(HELPER)


def orphan_time_bands(side: list[dict], s: float) -> list[str]:
    """Vision sometimes drops a short title next to an emoji. Each time with no name beside it gets a thin crop to read again."""
    centre = lambda l: l["y"] + l["h"] / 2
    is_time = lambda l: l["x"] >= 150 * s and bool(SIDE_TIME.match(_text(l)))
    names = [l for l in side if l["x"] >= 100 * s and not is_time(l)]  # avatar text sits left of the titles
    return [
        f"{int(110 * s)},{int(centre(t) - 14 * s)},{int(95 * s)},{int(28 * s)}"
        for t in side if is_time(t) and not any(abs(centre(n) - centre(t)) <= 10 * s for n in names)
    ]


def read_window(keep_image: bool = False) -> tuple[dict, dict, list[dict], list[dict]]:
    """Capture the main WeChat window and OCR it. Returns (window, full ocr, chat-list lines, timestamp lines)."""
    helper = _helper()
    try:
        win = json.loads(_run([helper, "window"]))
    except OcrError as e:
        raise OcrError("No WeChat window found. Open WeChat (not just the menu bar icon).") from e
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "wechat.png"
        _run(["screencapture", "-x", "-o", "-l", str(win["id"]), str(png)])
        if not png.exists() or png.stat().st_size == 0:
            raise OcrError("screencapture produced no image. Check Screen Recording permission.")
        ocr = json.loads(_run([helper, "ocr", str(png)]))
        W, H = ocr["w"], ocr["h"]
        s = W / win["w"]
        # Small text reads better when Vision sees a narrow crop than the whole window.
        side_crop = f"{int(60 * s)},{int(40 * s)},{int(190 * s)},{int(H - 40 * s)}"
        cx = (LIST_RIGHT * s + W) / 2
        top = int(BODY_TOP * s)
        stamp_crop = f"{int(cx - 100 * s)},{top},{int(200 * s)},{int(H - INPUT_H * s) - top}"
        side = json.loads(_run([helper, "ocr", str(png), "--crop", side_crop]))["lines"]
        for band in orphan_time_bands(side, s):
            side += json.loads(_run([helper, "ocr", str(png), "--crop", band, "--scale", "3"]))["lines"]
        stamps = json.loads(_run([helper, "ocr", str(png), "--crop", stamp_crop, "--scale", "3"]))["lines"]
        if keep_image:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy(png, DATA_DIR / "last.png")
    if len(ocr["lines"]) < 5:
        raise OcrError(
            "Window captured but almost no text found: WeChat is locked, on the login QR code, "
            "or Screen Recording permission is missing for this app."
        )
    return win, ocr, side, stamps


def _text(line: dict) -> str:
    return line["text"].replace("\n", " ").strip()


def parse_chat_list(lines: list[dict], reds: list[dict], s: float) -> list[dict]:
    col = sorted(
        (
            l for l in lines
            if LIST_LEFT * s <= l["x"] < LIST_RIGHT * s and l["y"] > 45 * s
            and not (re.fullmatch(r"\d{1,2}", _text(l)) and l["w"] < 20 * s)  # stray badge digit
        ),
        key=lambda l: l["y"],
    )
    yc = lambda l: l["y"] + l["h"] / 2
    times = [l for l in col if l["x"] >= 150 * s and SIDE_TIME.match(_text(l))]
    col = [l for l in col if l not in times]
    used: set[int] = set()
    rows: list[dict] = []
    for i, name in enumerate(col):
        if i in used:
            continue
        used.add(i)
        preview = ""
        near = [t for t in times if abs(yc(t) - yc(name)) <= 10 * s]
        time_txt = _text(min(near, key=lambda t: abs(yc(t) - yc(name)))) if near else ""
        for j, other in enumerate(col):
            if j not in used and 12 * s <= yc(other) - yc(name) <= 30 * s and abs(other["x"] - name["x"]) <= 45 * s:
                preview = _text(other)
                used.add(j)
                break
        title = _text(name)
        m = TRAILING_TIME.match(title)
        if m and name["x"] + name["w"] >= 225 * s and not time_txt and m.group(1):
            title, time_txt = m.group(1), m.group(2)
        unread = 0
        m = UNREAD_PREFIX.match(preview)
        if m:
            unread = int(m.group(1))
            preview = preview[m.end():]
        dot = any(
            96 * s <= r["x"] <= 122 * s and r["w"] <= 26 * s
            and abs(r["y"] + r["h"] / 2 - (yc(name) - 6 * s)) <= 22 * s
            for r in reds
        )
        if title.strip("：:，, ") and (time_txt or preview):
            rows.append({
                "chat": title, "time": time_txt, "preview": preview, "unread": unread or int(dot),
                "y": round(yc(name) / s),  # row position in points from the window top, for clicking
            })
    return rows


def _merge_fragments(lines: list[dict], s: float) -> list[dict]:
    """Join OCR pieces of one visual line (an emoji splits a name or sentence in two)."""
    centre = lambda l: l["y"] + l["h"] / 2
    rows: list[list[dict]] = []
    for l in sorted(lines, key=lambda l: l["y"]):
        head = rows[-1][0] if rows else None
        if head and not head.get("stamp") and not l.get("stamp") and abs(centre(head) - centre(l)) <= 4 * s:
            rows[-1].append(l)  # pieces of one line differ by a pixel or two in y, so group before ordering by x
        else:
            rows.append([l])
    out: list[dict] = []
    for row in rows:
        merged: list[dict] = []
        for l in sorted(row, key=lambda l: l["x"]):
            p = merged[-1] if merged else None
            if p and 0 <= l["x"] - (p["x"] + p["w"]) <= 40 * s:
                merged[-1] = {**p, "text": _text(p) + " " + _text(l), "w": l["x"] + l["w"] - p["x"]}
            else:
                merged.append(l)
        out.extend(merged)
    return out


def parse_open_chat(lines: list[dict], stamps: list[dict], s: float, win_w: int, win_h: int) -> dict:
    pane_left = LIST_RIGHT * s
    pane = [l for l in lines if l["x"] >= pane_left - 2 * s]
    title = next((_text(l) for l in sorted(pane, key=lambda l: l["x"]) if l["y"] < 40 * s), "")
    cx = (pane_left + win_w) / 2
    centered = lambda l: abs(l["x"] + l["w"] / 2 - cx) <= 60 * s and l["x"] > BUBBLE_LEFT * s
    # Timestamps come from the cropped, upscaled pass; the same lines in the full pass are dropped.
    stamp_lines = [{**l, "stamp": True} for l in stamps if TIME_STAMP.match(_text(l))]
    body = [
        l for l in pane
        if BODY_TOP * s <= l["y"] < win_h - INPUT_H * s and "new message" not in l["text"] and "latest message" not in l["text"]
        and not (centered(l) and (TIME_ONLY.match(_text(l)) or TIME_STAMP.match(_text(l))))
    ]
    body = _merge_fragments(body + stamp_lines, s)
    msgs: list[dict] = []
    stamp = label = ""
    one_to_one = bool(title) and not GROUP_TITLE.search(title)
    sender_in = title if one_to_one else ""  # who incoming bubbles belong to until a new label

    def flush_label() -> None:
        nonlocal label
        if label:  # a sender name with no text under it: sticker, emoji or image
            msgs.append({"t": stamp, "side": "in", "sender": label, "text": "[non-text message]"})
            label = ""

    last_y = -10**6
    for l in body:
        txt = _text(l)
        if l.get("stamp"):
            flush_label()
            stamp = txt
        elif centered(l):
            flush_label()
            msgs.append({"t": stamp, "side": "system", "sender": "", "text": txt})
        elif l["x"] < LABEL_LEFT * s:
            if one_to_one:
                continue  # 1:1 chats have no sender labels, so this is text inside an image
            flush_label()
            label = txt
            sender_in = txt
        else:
            side = "in" if l["x"] <= OUT_LEFT * s else "out"
            if side == "out":
                flush_label()  # my reply right after a sticker-only sender label
            sender = sender_in if side == "in" else "me"
            prev = msgs[-1] if msgs else None
            if prev and prev["side"] == side and prev["sender"] == sender and not label and l["y"] - last_y <= 30 * s:
                prev["text"] += "\n" + txt
            else:
                msgs.append({"t": stamp, "side": side, "sender": sender, "text": txt})
            label = ""
            last_y = l["y"]
    flush_label()
    return {"title": title, "messages": msgs}


def snapshot(keep_image: bool = False) -> dict:
    win, ocr, side, stamps = read_window(keep_image)
    s = ocr["w"] / win["w"]
    pane = [
        [_text(l)[:10], round(l["y"] / s)] for l in ocr["lines"]
        if l["x"] >= LIST_RIGHT * s and BODY_TOP * s <= l["y"] < ocr["h"] - INPUT_H * s
    ]
    return {
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "source": "screenshot OCR, approximate: truncated names, emoji lost, OCR typos",
        "chat_list": parse_chat_list(side, ocr["reds"], s),
        "open_chat": parse_open_chat(ocr["lines"], stamps, s, ocr["w"], ocr["h"]),
        "pane_fp": sorted(pane),  # where each text line sits: equal before and after a scroll means nothing moved
    }


def render(snap: dict) -> str:
    out = [f"# WeChat snapshot {snap['captured_at']} ({snap['source']})", "", "## Chat list (newest first)"]
    for r in snap["chat_list"]:
        flag = f" [UNREAD {r['unread']}]" if r["unread"] else ""
        out.append(f"- {r['chat']} ({r['time']}): {r['preview']}{flag}")
    chat = snap["open_chat"]
    out += ["", f"## Open chat: {chat['title']}"]
    for m in chat["messages"]:
        who = m["sender"] if m["side"] == "in" else ("(system)" if m["side"] == "system" else "me")
        out.append(f"- [{m['t']}] {who}: {m['text']}".replace("\n", " / "))
    return "\n".join(out)


def _similar(a: str, b: str) -> bool:
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.6


def stamp_datetime(stamp: str, now: datetime) -> datetime | None:
    """Turn a WeChat time stamp ("08:08", "Yesterday 08:08", "Thursday 09:01", "10/5 12:00") into a datetime."""
    stamp = stamp.strip()
    if _ABS_STAMP.match(stamp):
        return datetime.strptime(stamp, "%Y-%m-%d %H:%M")
    m = _STAMP.match(stamp)
    if not m:
        return None
    day, word = now.date(), m["word"] or ""
    try:
        if m["m"]:
            year = day.year
            if m["y"]:
                year = int(m["y"]) + (2000 if len(m["y"]) == 2 else 0)
            day = date(year, int(m["m"]), int(m["d"]))
            if not m["y"] and day > now.date():
                day = day.replace(year=day.year - 1)
        elif word and word.lower() != "today" and word != "今天":
            if word.lower().startswith("yes") or word == "昨天":
                day -= timedelta(days=1)
            else:
                if word[:3].lower() in _WEEKDAYS:
                    wd = _WEEKDAYS.index(word[:3].lower())
                elif word.startswith("星期") and word[2:] in "一二三四五六日":
                    wd = "一二三四五六日".index(word[2:])
                else:
                    return None
                day -= timedelta(days=(now.weekday() - wd) % 7 or 7)  # names are used for the past week
        return datetime(day.year, day.month, day.day, int(m["H"]), int(m["M"]))
    except ValueError:
        return None


def absolute_stamp(stamp: str, now: datetime) -> str:
    """"Yesterday 08:08" means a different day next week, so saved transcripts keep real dates."""
    dt = stamp_datetime(stamp, now)
    return dt.strftime("%Y-%m-%d %H:%M") if dt else stamp


def oldest_date(msgs: list[dict], now: datetime) -> datetime | None:
    dates = [d for d in (stamp_datetime(m["t"], now) for m in msgs) if d]
    return min(dates) if dates else None


def same_chat_title(a: str, b: str) -> bool:
    """An emoji after a name is read as a different symbol each frame ("小鹿い", "小鹿®"): the same chat."""
    a, b = (_norm(re.sub(r"[（(]\d+[）)]", "", t)) for t in (a, b))
    short, long = sorted((a, b), key=len)
    return len(short) >= 2 and long.startswith(short) and len(long) - len(short) <= 2


def _saved_slug(chats: Path, title: str) -> str:
    for md in sorted(chats.glob("*.md")):
        head = md.read_text(encoding="utf-8").split("\n", 1)[0].removeprefix("# ")
        if same_chat_title(title, head):
            return md.stem
    return re.sub(r"[^\w]+", "_", title).strip("_")[:60] or "chat"


def _write_chat(title: str, messages: list[dict], captured_at: str) -> None:
    """Save chats/<slug>.md and .json. A transcript that overlaps the saved one is merged into it, so a
    later capture never erases an earlier one; one that shares nothing replaces it and the old one moves
    to chats/_previous/."""
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    chats = DATA_DIR / "chats"
    chats.mkdir(exist_ok=True, mode=0o700)
    slug = _saved_slug(chats, title)
    when = datetime.fromisoformat(captured_at)
    msgs = [dict(m) for m in messages]
    _fill_stamps(msgs)
    for m in msgs:
        m["t"] = absolute_stamp(m["t"], when)
    saved = chats / f"{slug}.json"
    if saved.exists():
        merged = merge_transcripts(json.loads(saved.read_text(encoding="utf-8")), msgs)
        if merged is None:
            (chats / "_previous").mkdir(exist_ok=True, mode=0o700)
            for ext in (".json", ".md"):
                if (chats / f"{slug}{ext}").exists():
                    (chats / f"{slug}{ext}").replace(chats / "_previous" / f"{slug}{ext}")
        else:
            msgs = merged
    saved.write_text(json.dumps(msgs, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = [f"# {title}", f"_captured {captured_at}, screenshot OCR_", ""]
    lines += [f"- [{m['t']}] {m['sender'] or '(system)'}: {m['text']}".replace("\n", " / ") for m in msgs]
    (chats / f"{slug}.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def _same_msg(a: dict, b: dict) -> bool:
    # Sender labels are OCR'd less reliably than bubble text, so compare side + text only.
    if a["side"] != b["side"]:
        return False
    sm = difflib.SequenceMatcher(None, a["text"], b["text"], autojunk=False)
    if sm.ratio() >= 0.85:
        return True
    # A message taller than the pane shows a different slice of itself on each screen: one slice inside the other.
    short = min(len(a["text"]), len(b["text"]))
    return short >= 12 and sum(m.size for m in sm.get_matching_blocks()) / short >= 0.7


def _pair_ok(a: dict, b: dict) -> bool:
    # A 1-5 character line is often a quoted-reply label or an emoji, which Vision reads differently every frame.
    return _same_msg(a, b) or (a["side"] == b["side"] and max(len(a["text"]), len(b["text"])) <= 5)


def _run_matches(xs: list[dict], ys: list[dict]) -> bool:
    # One short message ("ok") repeats too often to prove two screens overlap: one real line must match.
    solid = any(len(y["text"]) >= 6 for y in ys)
    return solid and len(xs) == len(ys) and all(_pair_ok(x, y) for x, y in zip(xs, ys))


def merge_transcripts(acc: list[dict], new: list[dict]) -> list[dict] | None:
    """Stitch one screen of messages into the running transcript while the user scrolls.

    Returns the merged list, or None when the screen shares nothing with it (scrolled too fast).
    """
    if not acc or not new:
        return list(acc or new)
    for i in range(len(acc) - len(new) + 1):  # same screen, or one inside the transcript
        if _run_matches(acc[i:i + len(new)], new):
            return acc
    for i in range(len(new) - len(acc) + 1):  # the new screen already covers everything so far
        if _run_matches(new[i:i + len(acc)], acc):
            return list(new)
    for n in range(min(len(acc), len(new)) - 1, 0, -1):
        if _run_matches(new[-n:], acc[:n]):  # scrolled up to older messages
            return new[:-n] + acc
        if _run_matches(acc[-n:], new[:n]):  # scrolled down to newer messages
            return acc + new[n:]
    return _anchor_merge(acc, new)


def _anchor_merge(acc: list[dict], new: list[dict]) -> list[dict] | None:
    """Fallback when noisy lines (text inside images, emoji labels, a line Vision missed) stop the runs lining up.

    Aligns the two lists on the messages they share (longest common subsequence). At least one shared message
    must be 6+ characters long. Lines only one screen has are kept; in the gap before the first shared message
    the new screen's lines go first (it is the one that scrolled toward older messages).
    """
    n, m = len(acc), len(new)
    best = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            best[i][j] = best[i + 1][j + 1] + 1 if _same_msg(acc[i], new[j]) else max(best[i + 1][j], best[i][j + 1])
    pairs, i, j = [], 0, 0
    while i < n and j < m:
        if _same_msg(acc[i], new[j]):
            pairs.append((i, j))
            i, j = i + 1, j + 1
        elif best[i + 1][j] >= best[i][j + 1]:
            i += 1
        else:
            j += 1
    if not any(len(new[j]["text"]) >= 6 for _, j in pairs):
        return None
    out, pi, pj = [], 0, 0
    for k, (i, j) in enumerate(pairs):
        gap_acc, gap_new = acc[pi:i], new[pj:j]
        out += gap_new + gap_acc if k == 0 else gap_acc + gap_new
        out.append(new[j] if len(new[j]["text"]) > len(acc[i]["text"]) else acc[i])
        pi, pj = i + 1, j + 1
    return out + acc[pi:] + new[pj:]


def _fill_stamps(msgs: list[dict]) -> None:
    """A message at the top of a screen has no time stamp in view; take the one before it."""
    last = ""
    for m in msgs:
        last = m["t"] = m["t"] or last


def stitch(seconds: int, chat: str = "") -> dict:
    """Capture repeatedly while the user scrolls the open chat, merging the screens into one transcript."""
    acc: list[dict] = []
    title, frames, skipped, error = "", 0, 0, ""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        frames += 1
        try:
            shown = snapshot()["open_chat"]
        except OcrError as e:  # window moved, resized or locked mid-capture: wait for the next frame
            skipped, error = skipped + 1, str(e)
            time.sleep(1)
            continue
        merged = None if chat and chat.lower() not in shown["title"].lower() else merge_transcripts(acc, shown["messages"])
        if merged is None:
            skipped += 1
            continue
        acc, title = merged, shown["title"]
    _fill_stamps(acc)
    if title and acc:
        _write_chat(title, acc, datetime.now().isoformat(timespec="seconds"))
    return {"title": title, "messages": acc, "frames": frames, "skipped": skipped, "error": error}


def _norm(s: str) -> str:
    return re.sub(r"[\W_]+", "", s).lower()


def titles_match(want: str, shown: str) -> bool:
    """The chat list cuts long names and OCR drops emoji, so compare loosely."""
    a, b = _norm(want), _norm(shown)
    return bool(a and b) and (a in b or b in a or difflib.SequenceMatcher(None, a, b).ratio() >= 0.6)


def pick_targets(rows: list[dict], names: list[str], top: int) -> list[dict]:
    rows = [r for r in rows if not SKIP_CHATS.match(r["chat"])]
    if not names:
        return rows[:top]
    picked: list[dict] = []
    for n in names:
        hit = next((r for r in rows if titles_match(n, r["chat"]) and r not in picked), None)
        if hit:
            picked.append(hit)
    return picked


def _screen_locked() -> bool:
    out = subprocess.run(["ioreg", "-n", "Root", "-d1"], capture_output=True, text=True, timeout=20).stdout
    return bool(re.search(r'"IOConsoleLocked"\s*=\s*Yes', out))


class Desk:
    """Real pointer input through wxvision. The helper refuses to click or scroll unless a WeChat window is
    the topmost window at that point."""

    def __init__(self) -> None:
        self.helper = _helper()

    def state(self) -> dict:
        return json.loads(_run([self.helper, "input"]))

    def front(self) -> str:
        return _run([self.helper, "front"]).strip()

    def window(self) -> dict:
        return json.loads(_run([self.helper, "window"]))

    def click(self, x: float, y: float) -> None:
        _run([self.helper, "click", f"{x:.1f}", f"{y:.1f}"])

    def scroll(self, x: float, y: float, dy: int) -> None:
        _run([self.helper, "scroll", f"{x:.1f}", f"{y:.1f}", str(dy)])

    def move(self, x: float, y: float) -> None:
        _run([self.helper, "move", f"{x:.1f}", f"{y:.1f}"])

    def activate(self, bundle: str) -> None:
        _run(["open", "-b", bundle])


class AutoReader:
    """Opens chats and scrolls them toward older messages, merging every screen. Stops the moment the user
    touches the keyboard or moves the pointer."""

    def __init__(self, desk, snap, days: int, max_steps: int, per_chat_secs: int) -> None:
        self.desk, self.snap, self.days = desk, snap, days
        self.max_steps, self.per_chat_secs = max_steps, per_chat_secs
        self.sign, self.confirmed = 1, False  # scroll direction toward older messages, learned on the first chat
        self.placed: tuple[float, float] | None = None
        self.aborted = False
        self.done: set[str] = set()

    def user_back(self) -> bool:
        s = self.desk.state()
        moved = self.placed and (abs(s["x"] - self.placed[0]) > 6 or abs(s["y"] - self.placed[1]) > 6)
        self.aborted = self.aborted or s["key"] < 5 or bool(moved)
        return self.aborted

    def click(self, x: float, y: float) -> None:
        self.desk.click(x, y)
        self.placed = (x, y)

    def scroll(self, x: float, y: float, dy: float) -> None:
        self.desk.scroll(x, y, int(dy))
        self.placed = (x, y)

    def read_open_chat(self, want: str, win: dict, row_at: tuple[float, float] | None = None, expect: str = "") -> dict:
        px = win["x"] + (LIST_RIGHT + win["w"]) / 2
        py = win["y"] + (BODY_TOP + win["h"] - INPUT_H) / 2
        # Measured on 4.1.15: a wheel step of d moves the content about d + 50 pt. Aim at 30% of the pane so the
        # screens keep two or three messages in common even when one is cut off at the edge.
        dy = max((win["h"] - INPUT_H - BODY_TOP) * 0.3 - 50, 60)
        sent: list[float] = []  # every scroll that stays applied, replayed backwards at the end
        cutoff = datetime.now() - timedelta(days=self.days)
        deadline = time.monotonic() + self.per_chat_secs
        first_snap = self.snap()
        if not first_snap["open_chat"]["title"] and row_at:  # a click on the row that was already open closes it
            self.click(*row_at)
            time.sleep(1.2)
            first_snap = self.snap()
        first, fp = first_snap["open_chat"], first_snap.get("pane_fp")
        res = {"chat": want, "title": first["title"], "messages": [], "steps": 0, "stopped": "already read in this run"}
        # The list name is OCR'd from a small row and often garbled when it has emoji, so read whatever opened.
        if not first["title"] or first["title"] in self.done:
            return res
        if expect and not titles_match(expect, first["title"]):  # the click landed on another row
            return {**res, "stopped": f"opened '{first['title']}' instead of '{expect}', not read"}
        self.done.add(first["title"])
        title = first["title"]
        base_dy = dy
        cap = max((win["h"] - INPUT_H - BODY_TOP) * 0.5 - 50, base_dy)
        blank = 0
        acc, steps, unchanged, shrink, why = first["messages"], 0, 0, 0, "step limit"
        while steps < self.max_steps:
            old = oldest_date(acc, datetime.now())
            if old and old <= cutoff:
                why = f"reached {self.days} days back"
                break
            if time.monotonic() > deadline:
                why = "time limit for this chat"
                break
            if self.user_back():
                why = "you came back"
                break
            steps += 1
            self.scroll(px, py, self.sign * dy)
            time.sleep(0.9)
            try:
                now_snap = self.snap()
            except OcrError:
                continue
            shown, now_fp = now_snap["open_chat"], now_snap.get("pane_fp")
            if not titles_match(title, shown["title"]):
                why = "another chat opened"
                break
            merged = merge_transcripts(acc, shown["messages"])
            if merged is None:  # scrolled past the overlap: step back and take smaller steps
                shrink += 1
                if shrink > 4:
                    why = "screens stopped overlapping"
                    break
                self.scroll(px, py, -self.sign * dy)
                dy = max(dy * 0.6, 40)
                continue
            shrink = 0
            sent.append(dy)
            moved = now_fp is not None and now_fp != fp  # text lines sit elsewhere: the pane did scroll
            fp = now_fp
            if len(merged) == len(acc):
                if moved:  # an image or card filled the screen: nothing new to read, so reach further
                    blank += 1
                    if blank > 12:
                        why = "only images ahead"
                        break
                    dy = min(dy * 1.5, cap)
                    continue
                unchanged += 1
                if unchanged >= 3:
                    why = "top of the chat"
                    break
                if not self.confirmed and unchanged == 1:
                    self.sign = -self.sign  # nothing moved: the first guess at the direction was wrong
                continue
            unchanged = blank = 0
            dy = min(dy, base_dy)
            if not _same_msg(merged[0], acc[0]):
                self.confirmed = True
            elif not self.confirmed:
                self.sign = -self.sign  # it went toward newer messages
            acc = merged
        msgs = [dict(m) for m in acc]
        _fill_stamps(msgs)
        now = datetime.now()
        for m in msgs:
            m["t"] = absolute_stamp(m["t"], now)
        if first["title"] and msgs:
            _write_chat(first["title"], msgs, now.isoformat(timespec="seconds"))
        if self.confirmed and not self.aborted:
            for d in reversed(sent):  # leave the chat at its newest message, as the user left it
                self.scroll(px, py, -self.sign * d)
        return {**res, "messages": msgs, "steps": steps, "stopped": why}


def auto_read(desk, names: list[str] | None = None, top: int = 5, days: int = 3, idle_secs: int = 120,
              max_steps: int = 80, per_chat_secs: int = 240, snap=None) -> dict:
    """Open several chats and read back `days` days of each, using real clicks and scrolls.

    Runs only after `idle_secs` of no keyboard or mouse input, stops the moment the user returns, and puts
    the pointer and the frontmost app back. Opening a chat marks it read, on the phone too.
    """
    snap = snap or snapshot
    out: dict = {"chats": [], "stopped": ""}
    if _screen_locked():
        out["stopped"] = "the screen is locked"
        return out
    state = desk.state()
    if state["idle"] < idle_secs:
        out["stopped"] = f"you used the computer {int(state['idle'])} s ago; needs {idle_secs} s of quiet"
        return out
    home, front = (state["x"], state["y"]), desk.front()
    reader = AutoReader(desk, snap, days, max_steps, per_chat_secs)
    try:
        if front != WECHAT_BUNDLE:
            desk.activate(WECHAT_BUNDLE)
            time.sleep(1.5)
        if not desk.window().get("onscreen"):
            out["stopped"] = "the WeChat window is not visible on this desktop"
            return out
        first = snap()
        save(first)
        targets = pick_targets(first["chat_list"], names or [], top)
        if not targets:
            out["stopped"] = "no matching chats in the visible chat list"
        for idx, row in enumerate(targets):
            if reader.user_back():
                break
            expect = next((n for n in names or [] if titles_match(n, row["chat"])), "")
            for attempt in range(2):
                if idx or attempt:  # the list reorders when a message arrives, so find the row again before each click
                    again = pick_targets(snap()["chat_list"], [row["chat"]], 1)
                    if not again:
                        break
                    row = again[0]
                win = desk.window()
                row_at = (win["x"] + (LIST_LEFT + LIST_RIGHT) / 2, win["y"] + row["y"])
                reader.click(*row_at)
                time.sleep(1.2)
                res = reader.read_open_chat(row["chat"], desk.window(), row_at, expect)
                if attempt == 0 and res["stopped"].startswith("opened '") and not res["messages"]:
                    continue  # a row moved between the screenshot and the click: look again and retry once
                out["chats"].append(res)
                break
        if reader.aborted:
            out["stopped"] = "you came back"
    except OcrError as e:
        out["stopped"] = str(e)
    finally:
        if not reader.aborted:  # never move the pointer of someone who is back at the machine
            desk.move(*home)
            if front and front != WECHAT_BUNDLE:
                desk.activate(front)
    return out


def _fmt(m: dict) -> str:
    who = m["sender"] if m["side"] == "in" else ("(system)" if m["side"] == "system" else "me")
    return f"[{m['t']}] {who}: {m['text']}".replace("\n", " / ")


def render_auto(res: dict, days: int) -> str:
    now = datetime.now()
    cutoff = now - timedelta(days=days)
    out = []
    for c in res["chats"]:
        keep = [m for m in c["messages"] if (stamp_datetime(m["t"], now) or cutoff) >= cutoff]
        out += [f"## {c['title'] or c['chat']}  ({len(keep)} messages in {days} days, {c['steps']} scrolls, stopped: {c['stopped']})"]
        out += [_fmt(m) for m in keep] + [""]
    if res["stopped"]:
        out.append(f"[stopped: {res['stopped']}]")
    return "\n".join(out).strip() or "Nothing read."


def save(snap: dict) -> dict:
    """Write latest.json/latest.md, the open chat transcript, and the activity feed. Returns {'new': [...]}."""
    DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    (DATA_DIR / "chats").mkdir(exist_ok=True, mode=0o700)
    prev_path = DATA_DIR / "latest.json"
    prev_rows = json.loads(prev_path.read_text())["chat_list"] if prev_path.exists() else []
    new = [
        r for r in snap["chat_list"]
        if not any(
            p["time"] == r["time"] and _similar(p["chat"], r["chat"]) and _similar(p["preview"], r["preview"])
            for p in prev_rows
        )
    ]
    with open(DATA_DIR / "activity.jsonl", "a", encoding="utf-8") as f:
        for r in new:
            f.write(json.dumps({"seen_at": snap["captured_at"], **{k: v for k, v in r.items() if k != "y"}}, ensure_ascii=False) + "\n")
    chat = snap["open_chat"]
    if chat["title"] and chat["messages"]:
        _write_chat(chat["title"], chat["messages"], snap["captured_at"])
    snap = {k: v for k, v in snap.items() if k != "pane_fp"}
    prev_path.write_text(json.dumps(snap, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_DIR / "latest.md").write_text(render(snap) + "\n", encoding="utf-8")
    return {"new": new}


def history(days: int = 7, chat: str = "") -> list[dict]:
    """Chat-list changes seen in the last `days` days, newest first, optionally filtered by chat name."""
    path = DATA_DIR / "activity.jsonl"
    if not path.exists():
        return []
    cutoff = (datetime.now() - timedelta(days=days)).isoformat(timespec="seconds")
    rows = [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines() if x.strip()]
    rows = [r for r in rows if r["seen_at"] >= cutoff and (not chat or chat.lower() in r["chat"].lower())]
    return sorted(rows, key=lambda r: r["seen_at"], reverse=True)


def saved_chats(match: str = "") -> list[str]:
    """Saved transcripts of chats that were open during a capture, newest first, filtered by title."""
    files = sorted((DATA_DIR / "chats").glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    texts = [p.read_text(encoding="utf-8") for p in files]
    return [t for t in texts if match.lower() in t.splitlines()[0].lower()]


def _traced(snap):
    count = 0

    def wrapper(*a, **k):
        nonlocal count
        s = snap(*a, **k)
        count += 1
        print(f"--- screen {count}: {s['open_chat']['title']!r}, {len(s.get('pane_fp') or [])} text lines", file=sys.stderr)
        for m in s["open_chat"]["messages"]:
            print(f"    {m['side']:6} {m['t']!r:20} {m['text'][:40]!r}", file=sys.stderr)
        return s

    return wrapper


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json", action="store_true", help="print the snapshot as JSON")
    ap.add_argument("--keep-image", action="store_true", help="keep the screenshot as ~/.wechat-export/ocr/last.png")
    ap.add_argument("--stitch", type=int, metavar="SECONDS", help="capture for this long while you scroll the open chat up, merge into one transcript")
    ap.add_argument("--chat", default="", help="with --stitch: only accept frames whose open chat title contains this")
    ap.add_argument("--auto-read", action="store_true", help="open chats and scroll them back with real clicks and scrolls, only while the Mac is idle")
    ap.add_argument("--chats", default="", help="with --auto-read: comma-separated chat names (must be in the visible chat list)")
    ap.add_argument("--top", type=int, default=5, help="with --auto-read and no --chats: the first N chats in the list")
    ap.add_argument("--days", type=int, default=3, help="with --auto-read: read back this many days")
    ap.add_argument("--idle", type=int, default=120, help="with --auto-read: seconds without keyboard or mouse input required")
    ap.add_argument("--wait", type=int, default=0, metavar="MINUTES", help="with --auto-read: keep waiting this long for the Mac to go idle")
    ap.add_argument("--trace", action="store_true", help="with --auto-read: print every screen read to stderr (contains chat text)")
    args = ap.parse_args()
    try:
        if args.auto_read:
            desk = Desk()
            names = [n.strip() for n in args.chats.split(",") if n.strip()]
            give_up = time.monotonic() + args.wait * 60
            while True:
                res = auto_read(desk, names, args.top, args.days, args.idle, snap=_traced(snapshot) if args.trace else None)
                if res["chats"] or not res["stopped"].startswith("you used") or time.monotonic() > give_up:
                    break
                time.sleep(30)
            print(render_auto(res, args.days))
            return 0 if res["chats"] else 1
        if args.stitch:
            res = stitch(args.stitch, args.chat)
            for m in res["messages"]:
                who = m["sender"] if m["side"] == "in" else ("(system)" if m["side"] == "system" else "me")
                print(f"[{m['t']}] {who}: {m['text']}".replace("\n", " / "))
            print(f"\n[{res['title']}: {len(res['messages'])} messages from {res['frames']} frames, {res['skipped']} skipped]", file=sys.stderr)
            if res["error"]:
                print(f"[last capture error: {res['error']}]", file=sys.stderr)
            return 0 if res["messages"] else 1
        snap = snapshot(args.keep_image)
    except OcrError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    result = save(snap)
    print(json.dumps(snap, ensure_ascii=False, indent=1) if args.json else render(snap))
    print(f"\n[{len(result['new'])} new/changed chat rows logged to {DATA_DIR}/activity.jsonl]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
