#!/usr/bin/env python3
"""Read WeChat by screenshot + Apple Vision OCR. No database keys, no re-signing.

Captures the main WeChat window (works while it is in the background or on another
display), OCRs it, and saves the chat list (name, time, last-message preview, unread)
and the transcript of the chat that is open. Output goes to ~/.wechat-export/ocr/.

Usage: python wechat_ocr.py [--json] [--keep-image] [--stitch SECONDS [--chat NAME]]
       python wechat_ocr.py --auto-read [--chats A,B | --top N] [--days N] [--idle S] [--wait MIN] [--record]
       python wechat_ocr.py --replay FRAMES_DIR [--reocr] [--trace] [--write]  |  --retidy
Needs Screen Recording permission for the app that launches it (VS Code, Terminal); --auto-read also
needs Accessibility, because it clicks and scrolls for real, and only runs while nobody is using the Mac.
Layout constants below are pixel positions of WeChat 4.1 at 1x; they scale with the capture.
"""

from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections import Counter
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
TITLE_H = 40  # title bar text starts above this
TITLE_ICONS = 160  # call / more icons at the right end of the title bar, read as junk ("日<")

TIME_ONLY = re.compile(r"^[\d:：]{4,5}$")
TIME_STAMP = re.compile(r"^(?:[A-Za-z]+\s+)?(?:\d{1,2}/\d{1,2}\s+)?\d{1,2}:\d{2}$")
SIDE_TIME = re.compile(r"^(\d{1,2}[:：]\d{2}|\d{1,2}/\d{1,2}(/\d{2,4})?|Yes\w*.*|昨天.*|星期.)$")
TRAILING_TIME = re.compile(r"^(.*?)\s*(\d{1,2}:\d{2}|\d{1,2}/\d{1,2}|Yesterday.*|昨天.*)$")
UNREAD_PREFIX = re.compile(r"^[\[［]?\s*(\d{1,3})\s*[\]］|｜]\s*")
GROUP_TITLE = re.compile(r"[(（]\d+[)）]\s*$")  # group chat titles end in the member count
NON_TEXT = "[non-text message]"  # a sender label with no text under it: sticker, emoji or image
IMAGE = "[image] "  # prefix for text read off a sticker, photo or video cover
IMAGE_H = 250  # lines of one image (a video cover's caption and its channel name) can sit this far apart
PANE_LEFT = 290  # the chat pane starts right of this (the chat list ends before it)
SCROLLBAR = 20  # the scroll bar overlay at the right edge of the pane comes and goes: leave it out of row hashes
AVATAR_W = 72  # my avatar sits in this column at the right edge (seen at 1734-1740pt of 1800); Vision reads it as "品"
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
_STAMP_TIME = re.compile(r"([\dOoIlASBZ]{1,2})\s*[.・·:：,;]\s*([\dOoIlASBZ]{2})$")
_DIGIT_FIX = str.maketrans("OoIlASBZ", "00114582")


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


def _ocr_main(helper: str, png: Path, win_w: float) -> dict:
    """OCR the whole window, plus the title bar on its own when the full pass dropped it. Also hashes each pixel
    row of the chat pane, so pane_shift() can tell how far the next screen scrolled."""
    with open(png, "rb") as f:
        w_px = int.from_bytes(f.read(24)[16:20], "big")  # PNG header: IHDR width
    s = w_px / win_w
    ocr = json.loads(_run([helper, "ocr", str(png), "--rows", f"{int(PANE_LEFT * s)},{int(w_px - SCROLLBAR * s)}"]))
    if not _title_lines(ocr["lines"], s, ocr["w"]):
        # Vision drops a name followed by several emoji on the full window; alone in a crop it reads it.
        band = f"{int(LIST_RIGHT * s)},0,{int(ocr['w'] - (LIST_RIGHT + TITLE_ICONS) * s)},{int((TITLE_H + 10) * s)}"
        ocr["lines"] += json.loads(_run([helper, "ocr", str(png), "--crop", band]))["lines"]
    return ocr


def read_window(keep_image: bool = False, chat_only: bool = False, frame: Path | None = None) -> tuple[dict, dict, list[dict], list[dict]]:
    """Capture the main WeChat window and OCR it. Returns (window, full ocr, chat-list lines, timestamp lines).

    chat_only skips the chat-list passes (no chat-list lines), which roughly halves the time per screen while
    scrolling inside one chat. frame: also keep the screenshot as frame.png."""
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
        ocr = _ocr_main(helper, png, win["w"])
        W, H = ocr["w"], ocr["h"]
        s = W / win["w"]
        # Small text reads better when Vision sees a narrow crop than the whole window.
        side_crop = f"{int(60 * s)},{int(40 * s)},{int(190 * s)},{int(H - 40 * s)}"
        cx = (LIST_RIGHT * s + W) / 2
        top = int(BODY_TOP * s)
        stamp_crop = f"{int(cx - 100 * s)},{top},{int(200 * s)},{int(H - INPUT_H * s) - top}"
        side: list[dict] = []
        if not chat_only:
            side = json.loads(_run([helper, "ocr", str(png), "--crop", side_crop]))["lines"]
            for band in orphan_time_bands(side, s):
                side += json.loads(_run([helper, "ocr", str(png), "--crop", band, "--scale", "3"]))["lines"]
        stamps = json.loads(_run([helper, "ocr", str(png), "--crop", stamp_crop, "--scale", "3"]))["lines"]
        if keep_image:
            DATA_DIR.mkdir(parents=True, exist_ok=True)
            shutil.copy(png, DATA_DIR / "last.png")
        if frame:
            shutil.copy(png, frame.with_suffix(".png"))
    if len(ocr["lines"]) < 5:
        raise OcrError(
            "Window captured but almost no text found: WeChat is locked, on the login QR code, "
            "or Screen Recording permission is missing for this app."
        )
    return win, ocr, side, stamps


def _text(line: dict) -> str:
    return line["text"].replace("\n", " ").strip()


def _title_lines(lines: list[dict], s: float, win_w: int) -> list[dict]:
    return sorted(
        (l for l in lines if l["y"] < TITLE_H * s and LIST_RIGHT * s - 2 * s <= l["x"] < win_w - TITLE_ICONS * s),
        key=lambda l: l["x"],
    )


def clean_stamp(text: str) -> str:
    """Vision misreads the small gray time stamps ("Saturdav 09.21|", "Yesterday 21:A7"): repair the time part."""
    t = re.sub(r"[|｜丨]+$", "", text.strip()).strip()
    m = _STAMP_TIME.search(t)
    if not m or sum(c.isdigit() for c in m.group(1) + m.group(2)) < 3:
        return t
    return t[:m.start()] + m.group(1).translate(_DIGIT_FIX) + ":" + m.group(2).translate(_DIGIT_FIX)


def is_stamp(text: str) -> bool:
    return bool(TIME_ONLY.match(text) or TIME_STAMP.match(clean_stamp(text)))


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
                merged[-1] = {**p, "text": _text(p) + " " + _text(l), "w": l["x"] + l["w"] - p["x"],
                              "img": bool(p.get("img") and l.get("img"))}
            else:
                merged.append(l)
        out.extend(merged)
    return out


def _plain(c: list[int], paper: list[int], out_side: bool) -> bool:
    """A gray close to the window background (a bubble or the window itself), or my green bubble."""
    if len(c) != 3:
        return True  # the strip fell off the image: no evidence either way
    if max(c) - min(c) <= 6 and abs(sum(c) - sum(paper)) <= 120:
        return True
    return out_side and c[1] > c[0] + 40 and c[1] > c[2] + 20


def on_image(l: dict, paper: list[int] | None, s: float) -> bool:
    """Text printed on a sticker, photo or video cover: the colour on both sides of it is not a bubble's.
    Measured on 4.1.15 dark mode: bubble and window strips are [46,46,47] and [30,30,31] on paper [28,28,28];
    sticker captions and covers are white, tinted ([48,41,51]) or coloured. Needs both sides, so an emoji next
    to real text on one side cannot hide it."""
    sides = l.get("bgc") or []
    if not paper or len(paper) != 3 or not any(len(c) == 3 for c in sides):
        return False
    return not any(_plain(c, paper, l["x"] >= OUT_LEFT * s) for c in sides)


def parse_open_chat(lines: list[dict], stamps: list[dict], s: float, win_w: int, win_h: int,
                    paper: list[int] | None = None) -> dict:
    pane_left = LIST_RIGHT * s
    pane = [l for l in lines if l["x"] >= pane_left - 2 * s]
    title = next((_text(l) for l in _title_lines(pane, s, win_w)), "")
    cx = (pane_left + win_w) / 2
    centered = lambda l: abs(l["x"] + l["w"] / 2 - cx) <= 60 * s and l["x"] > BUBBLE_LEFT * s
    # Timestamps come from the cropped, upscaled pass; the same lines in the full pass are dropped.
    stamp_lines = [{**l, "text": clean_stamp(_text(l)), "stamp": True} for l in stamps if TIME_STAMP.match(clean_stamp(_text(l)))]
    body = [
        {**l, "img": on_image(l, paper, s)} for l in pane
        if BODY_TOP * s <= l["y"] < win_h - INPUT_H * s and "new message" not in l["text"] and "latest message" not in l["text"]
        and not (centered(l) and is_stamp(_text(l))) and l["x"] < win_w - AVATAR_W * s
    ]
    body = _merge_fragments(body + stamp_lines, s)
    msgs: list[dict] = []
    stamp = label = ""
    label_y = 0
    one_to_one = bool(title) and not GROUP_TITLE.search(title)
    sender_in = title if one_to_one else ""  # who incoming bubbles belong to until a new label
    # y, y2: the message's top and bottom on this screen (pixels, its sender label included), for shift_merge.

    def flush_label() -> None:
        nonlocal label
        if label:  # a sender name with no text under it: sticker, emoji or image
            msgs.append({"t": stamp, "side": "in", "sender": label, "text": NON_TEXT, "y": label_y, "y2": label_y + 20 * s})
            label = ""

    last_y = -10**6
    for l in body:
        txt = _text(l)
        if l.get("stamp"):
            flush_label()
            stamp = txt
        elif centered(l) and not l["img"]:
            flush_label()
            msgs.append({"t": stamp, "side": "system", "sender": "", "text": txt, "y": l["y"], "y2": l["y"] + l["h"]})
        elif l["x"] < LABEL_LEFT * s and not l["img"]:
            if one_to_one:
                continue  # 1:1 chats have no sender labels, so this is text inside an image
            flush_label()
            label, label_y = txt, l["y"]
            sender_in = txt
        else:
            # Text on a sticker, photo or video cover stays as one "[image]" message: it tells the reader what
            # was sent, and the merge needs it to line up screens of a chat that is mostly media.
            img = l["img"]
            side = "in" if l["x"] <= OUT_LEFT * s else "out"
            if side == "out":
                flush_label()  # my reply right after a sticker-only sender label
            sender = sender_in if side == "in" else "me"
            prev = msgs[-1] if msgs else None
            gap = (IMAGE_H if img else 30) * s
            if prev and prev["side"] == side and prev["sender"] == sender and not label and l["y"] - last_y <= gap \
                    and prev.get("img", False) == img:
                prev["text"] += "\n" + txt
                prev["y2"] = l["y"] + l["h"]
            else:
                msgs.append({"t": stamp, "side": side, "sender": sender, "text": IMAGE + txt if img else txt,
                             "y": label_y if label else l["y"], "y2": l["y"] + l["h"]} | ({"img": True} if img else {}))
            label = ""
            last_y = l["y"]
    flush_label()
    return {"title": title, "messages": msgs}


def snapshot(keep_image: bool = False, chat_only: bool = False, record_dir: Path | None = None) -> dict:
    """One capture. record_dir keeps each screen (PNG + raw OCR) so the parser can be replayed offline."""
    frame = None
    if record_dir:
        record_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        frame = record_dir / f"{len(list(record_dir.glob('*.json'))):04d}"
    win, ocr, side, stamps = read_window(keep_image, chat_only, frame)
    captured_at = datetime.now().isoformat(timespec="seconds")
    if frame:
        raw = {"captured_at": captured_at, "win": win, "ocr": ocr, "side": side, "stamps": stamps}
        frame.with_suffix(".json").write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    return build_snapshot(win, ocr, side, stamps, captured_at)


def build_snapshot(win: dict, ocr: dict, side: list[dict], stamps: list[dict], captured_at: str) -> dict:
    s = ocr["w"] / win["w"]
    pane = [
        [_text(l)[:10], round(l["y"] / s)] for l in ocr["lines"]
        if l["x"] >= LIST_RIGHT * s and BODY_TOP * s <= l["y"] < ocr["h"] - INPUT_H * s
    ]
    return {
        "captured_at": captured_at,
        "source": "screenshot OCR, approximate: truncated names, emoji lost, OCR typos",
        "chat_list": parse_chat_list(side, ocr["reds"], s),
        "open_chat": parse_open_chat(ocr["lines"], stamps, s, ocr["w"], ocr["h"], ocr.get("paper")),
        "pane_fp": sorted(pane),  # where each text line sits: equal before and after a scroll means nothing moved
        "rows": ocr.get("rows"),  # pixel-row hashes of the chat pane, for pane_shift()
        "scale": s,
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


def _write_chat(title: str, messages: list[dict], captured_at: str, replace: bool = False) -> None:
    """Save chats/<slug>.md and .json. A transcript that overlaps the saved one is merged into it, so a
    later capture never erases an earlier one; one that shares nothing (or replace=True) replaces it and the
    old one moves to chats/_previous/."""
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
        merged = None if replace else merge_transcripts(json.loads(saved.read_text(encoding="utf-8")), msgs)
        if merged is None:
            (chats / "_previous").mkdir(exist_ok=True, mode=0o700)
            for ext in (".json", ".md"):
                if (chats / f"{slug}{ext}").exists():
                    (chats / f"{slug}{ext}").replace(chats / "_previous" / f"{slug}{ext}")
        else:
            msgs = merged
    _save_chat_files(chats / slug, title, tidy(msgs, title), captured_at)


def _save_chat_files(base: Path, title: str, msgs: list[dict], captured_at: str) -> None:
    base.with_suffix(".json").write_text(json.dumps(msgs, ensure_ascii=False, indent=1), encoding="utf-8")
    lines = [f"# {title}", f"_captured {captured_at}, screenshot OCR_", ""]
    lines += [f"- [{m['t']}] {m['sender'] or '(system)'}: {m['text']}".replace("\n", " / ") for m in msgs]
    base.with_suffix(".md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def retidy_saved() -> list[str]:
    """Run every saved transcript through tidy() again (after a parser fix). Returns the titles touched."""
    done = []
    for js in sorted((DATA_DIR / "chats").glob("*.json")):
        md = js.with_suffix(".md")
        head = md.read_text(encoding="utf-8").split("\n", 2) if md.exists() else []
        title = head[0].removeprefix("# ") if head else js.stem
        captured = re.search(r"_captured (\S+),", head[1]) if len(head) > 1 else None
        when = captured.group(1) if captured else datetime.now().isoformat(timespec="seconds")
        _save_chat_files(js.with_suffix(""), title, tidy(json.loads(js.read_text(encoding="utf-8")), title), when)
        done.append(title)
    return done


def _same_person(a: str, b: str) -> bool:
    """Sender labels drift like titles do: an emoji read as a new symbol, a name cut short, one stroke misread."""
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return a == b
    short, long = sorted((a, b), key=len)
    if long.startswith(short) and (len(short) >= 4 or (len(short) >= 2 and len(long) - len(short) <= 2)):
        return True
    return len(short) >= 3 and difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def _display_name(spellings: list[str], counts: dict[str, int]) -> str:
    prefix = os.path.commonprefix(spellings).strip()
    if len(_norm(prefix)) >= 2 and all(len(v) - len(prefix) <= 2 for v in spellings):
        return prefix  # the part every frame agrees on, without the misread emoji
    return max(spellings, key=lambda v: (counts.get(v, 0), len(v)))


def canonical_senders(senders: list[str], title: str) -> dict[str, str]:
    """Map every spelling of a sender seen in one transcript to one name."""
    counts = {n: senders.count(n) for n in set(senders)}
    head = _norm(title)[:2]
    if len(head) == 2 and not GROUP_TITLE.search(title) and all(_norm(n).startswith(head) for n in counts):
        spellings = list(counts) + [title]  # 1:1 chat: every incoming message is the other person
        name = _display_name(spellings, counts)
        return {n: name for n in spellings}
    groups: list[list[str]] = []
    for n in sorted(counts, key=lambda n: (-counts[n], n)):
        g = next((g for g in groups if any(_same_person(n, o) for o in g)), None)
        if g:
            g.append(n)
        else:
            groups.append([n])
    return {n: _display_name(g, counts) for g in groups for n in g}


def tidy(msgs: list[dict], title: str) -> list[dict]:
    """Clean a merged transcript: time stamps misread as system lines go, every sender gets one spelling,
    messages go in time order (a screen merged at the wrong spot puts a stamped block out of place), and the
    same message read twice in a row (same time stamp) is kept once. Stamps must already be absolute."""
    out = [_public(m) for m in msgs if not (m["side"] == "system" and is_stamp(m["text"]))]
    names = canonical_senders([m["sender"] for m in out if m["side"] == "in" and m["sender"]], title)
    for m in out:
        if m["side"] == "in":
            m["sender"] = names.get(m["sender"], m["sender"])
    _fill_stamps(out)
    now, last, keys = datetime.now(), datetime.min, []
    for m in out:
        last = stamp_datetime(m["t"], now) or last
        keys.append(last)
    out = [out[i] for i in sorted(range(len(out)), key=lambda i: keys[i])]
    kept: list[dict] = []
    for m in out:
        p = kept[-1] if kept else None
        if p and p["side"] == m["side"] and p["sender"] == m["sender"] and p["t"] == m["t"] \
                and max(len(p["text"]), len(m["text"])) >= 6 and _same_msg(p, m):
            if len(m["text"]) > len(p["text"]):
                kept[-1] = m
            continue
        kept.append(m)
    return kept


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


def _solid(m: dict) -> bool:
    """Long enough to be unlikely to repeat by chance; the sticker/image placeholder is on half the screens."""
    t = m["text"].removeprefix(IMAGE)
    return len(t) >= 6 and t != NON_TEXT


def _run_matches(xs: list[dict], ys: list[dict]) -> bool:
    # One short message ("ok") repeats too often to prove two screens overlap: one real line must match.
    solid = any(_solid(y) for y in ys)
    return solid and len(xs) == len(ys) and all(_pair_ok(x, y) for x, y in zip(xs, ys))


def merge_transcripts(acc: list[dict], new: list[dict], toward_older: bool = False) -> list[dict] | None:
    """Stitch one screen of messages into the running transcript while the user scrolls.

    Returns the merged list, or None when the screen shares nothing with it (scrolled too fast).
    toward_older: the caller knows this screen is above the last one, so it can only add older messages. A noisy
    short line can otherwise make an older screen look like a newer one and land after the newest message.
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
        if not toward_older and _run_matches(acc[-n:], new[:n]):  # scrolled down to newer messages
            return acc + new[n:]
    return _anchor_merge(acc, new, toward_older)


def _anchor_merge(acc: list[dict], new: list[dict], toward_older: bool = False) -> list[dict] | None:
    """Fallback when noisy lines (text inside images, emoji labels, a line Vision missed) stop the runs lining up.

    Aligns the two lists on the messages they share (longest common subsequence). At least one shared message
    must be 6+ characters long. Lines only one screen has are kept; in the gap before the first shared message
    the new screen's lines go first (it is the one that scrolled toward older messages). With toward_older, the
    new screen's lines after the last shared message are dropped: that part of the screen was read already, so
    they are misread copies, and appending them would put them after the newest message.
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
    if not any(_solid(new[j]) for _, j in pairs):
        return None
    out, pi, pj = [], 0, 0
    for k, (i, j) in enumerate(pairs):
        gap_acc, gap_new = acc[pi:i], new[pj:j]
        out += gap_new + gap_acc if k == 0 else gap_acc + gap_new
        out.append(new[j] if len(new[j]["text"]) > len(acc[i]["text"]) else acc[i])
        pi, pj = i + 1, j + 1
    return out + acc[pi:] + ([] if toward_older else new[pj:])


def pane_shift(prev_rows: list[int] | None, rows: list[int] | None, s: float) -> int | None:
    """How many pixels the chat pane's content moved down from one screen to the next: positive means it scrolled
    toward older messages, 0 that it did not move. None when the screens share no rows (scrolled a whole screen).

    Rows that occur once on each screen vote for the distance between their heights; a scrolled line of text
    renders to the same pixels, so one distance gets hundreds of votes. Blank rows (0) and rows that repeat (bubble
    padding) say nothing about the distance and are left out."""
    if not prev_rows or not rows or len(prev_rows) != len(rows):
        return None
    lo, hi = int(BODY_TOP * s), int(len(rows) - INPUT_H * s)

    def once(rs: list[int]) -> dict[int, int]:
        n = Counter(rs[lo:hi])
        return {h: y for y, h in enumerate(rs[lo:hi], lo) if h and n[h] == 1}

    a, b = once(prev_rows), once(rows)
    votes = Counter(b[h] - a[h] for h in a.keys() & b.keys()).most_common(2)
    if not votes or votes[0][1] < 8 or (len(votes) > 1 and votes[1][1] * 2 > votes[0][1]):
        return None
    return votes[0][0]


def _placed(msgs: list[dict], off: int) -> list[dict]:
    """Give a screen's messages positions in the chat as a whole (ay, ay2): screen pixels minus the total scroll."""
    return [{**m, "ay": m["y"] - off, "ay2": m["y2"] - off} if "y" in m else dict(m) for m in msgs]


def _overlaps(a: dict, b: dict) -> bool:
    ov = min(a["ay2"], b["ay2"]) - max(a["ay"], b["ay"])
    return ov > 0.4 * max(min(a["ay2"] - a["ay"], b["ay2"] - b["ay"]), 1)


def _fuller(a: dict, b: dict) -> dict:
    """Two reads of one message: keep the longer text (the other was cut off at the screen edge), and the
    sender and time stamp from whichever read has them."""
    keep, other = (b, a) if len(b["text"]) > len(a["text"]) else (a, b)
    return {**keep, "sender": keep["sender"] or other["sender"], "t": keep["t"] or other["t"],
            "ay": min(a["ay"], b["ay"]), "ay2": max(a["ay2"], b["ay2"])}


def shift_merge(acc: list[dict], new: list[dict]) -> list[dict]:
    """Merge a screen whose messages were _placed() with the measured scroll. A message where one already sits is
    the same message read again; any other goes in by its position. No text has to match, so a screen of stickers
    or one tall image still lines up, and a message cut off at the top is replaced by its whole self."""
    out = list(acc)
    for m in new:
        if "ay" not in m:
            continue
        hits = [k for k, a in enumerate(out) if "ay" in a and _overlaps(a, m)]
        if len(hits) > 1 and len(m["text"]) >= 0.8 * sum(len(out[k]["text"]) for k in hits):
            # One whole read where earlier screens had pieces (a cover split into lines, a run of bubbles).
            whole = dict(m)
            for k in hits:
                a = out[k]
                whole.update(sender=whole["sender"] or a["sender"], t=whole["t"] or a["t"],
                             ay=min(whole["ay"], a["ay"]), ay2=max(whole["ay2"], a["ay2"]))
            out[hits[0]] = whole
            for k in reversed(hits[1:]):
                del out[k]
            continue
        if hits:
            k = max(hits, key=lambda k: min(out[k]["ay2"], m["ay2"]) - max(out[k]["ay"], m["ay"]))
            out[k] = _fuller(out[k], m)
            continue
        below = next((k for k, a in enumerate(out) if "ay" in a and a["ay"] >= m["ay2"] - 2), None)
        if below is None:  # under every placed message: after the last one
            below = max((k + 1 for k, a in enumerate(out) if "ay" in a), default=0)
        out.insert(below, m)
    return out


def _reposition(merged: list[dict], screen: list[dict]) -> list[dict]:
    """After a text merge the old positions mean nothing: place the screen's own messages again, at offset 0."""
    out = [{k: v for k, v in m.items() if k not in ("ay", "ay2")} for m in merged]
    start = 0
    for m in screen:
        k = next((k for k in range(start, len(out)) if out[k]["side"] == m["side"] and _same_msg(out[k], m)), None)
        if k is not None and "ay" in m:
            out[k].update(ay=m["ay"], ay2=m["ay2"])
            start = k + 1
    return out


def merge_screen(acc: list[dict], off: int, prev_rows: list[int] | None, snap: dict,
                 toward_older: bool = False) -> tuple[list[dict] | None, int, int | None]:
    """Merge the next screen of one chat. Returns (merged or None, new total scroll, this scroll or None).
    Uses the measured scroll when the pixel rows line up, the text merge otherwise."""
    msgs = snap["open_chat"]["messages"]
    d = pane_shift(prev_rows, snap.get("rows"), snap.get("scale") or 2)
    if d is not None:
        return shift_merge(acc, _placed(msgs, off + d)), off + d, d
    merged = merge_transcripts(acc, msgs, toward_older)
    return (None, off, None) if merged is None else (_reposition(merged, _placed(msgs, 0)), 0, None)


def _public(m: dict) -> dict:
    return {k: m[k] for k in ("t", "side", "sender", "text")}


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

    def raise_window(self) -> None:
        _run([self.helper, "raise"])


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
        acc, steps, unchanged, shrink, why = _placed(first["messages"], 0), 0, 0, 0, "step limit"
        off, rows = 0, first_snap.get("rows")
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
            merged, now_off, d = merge_screen(acc, off, rows, now_snap, toward_older=self.confirmed)
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
            off, rows = now_off, now_snap.get("rows")
            moved = d != 0 if d is not None else now_fp is not None and now_fp != fp  # the pane did scroll
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
        msgs = [_public(m) for m in acc]
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
              max_steps: int = 80, per_chat_secs: int = 240, snap=None, chat_snap=None) -> dict:
    """Open several chats and read back `days` days of each, using real clicks and scrolls.

    Runs only after `idle_secs` of no keyboard or mouse input, stops the moment the user returns, and puts
    the pointer and the frontmost app back. Opening a chat marks it read, on the phone too.
    chat_snap reads the open chat only (no chat list); it is what runs on every scroll step.
    """
    chat_snap = chat_snap or snap or (lambda: snapshot(chat_only=True))
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
    reader = AutoReader(desk, chat_snap, days, max_steps, per_chat_secs)
    try:
        if front != WECHAT_BUNDLE:
            desk.activate(WECHAT_BUNDLE)
            time.sleep(1.5)
        if not desk.window().get("onscreen"):  # on another desktop, or minimized: bring it over
            desk.raise_window()
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
    snap = {k: v for k, v in snap.items() if k not in ("pane_fp", "rows")}
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
        t0 = time.monotonic()
        s = snap(*a, **k)
        count += 1
        print(f"--- screen {count}: {s['open_chat']['title']!r}, {len(s.get('pane_fp') or [])} text lines, "
              f"{time.monotonic() - t0:.1f} s", file=sys.stderr)
        for m in s["open_chat"]["messages"]:
            print(f"    {m['side']:6} {m['t']!r:20} {m['text'][:40]!r}", file=sys.stderr)
        return s

    return wrapper


def replay(frames_dir: Path, reocr: bool = False, trace: bool = False) -> list[dict]:
    """Parse a recorded run again and merge its screens per chat, in the order they were taken. Captures nothing.
    reocr: run the OCR helper again on each recorded screenshot (after a helper change).
    trace: print each screen's messages and whether it lined up, to stderr."""
    chats: list[dict] = []
    for f in sorted(frames_dir.glob("*.json")):
        raw = json.loads(f.read_text(encoding="utf-8"))
        if reocr and f.with_suffix(".png").exists():
            raw["ocr"] = _ocr_main(_helper(), f.with_suffix(".png"), raw["win"]["w"])
            f.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")  # later replays reuse it
        snap = build_snapshot(raw["win"], raw["ocr"], raw["side"], raw["stamps"], raw["captured_at"])
        shown = snap["open_chat"]
        if not shown["title"]:
            continue
        cur = chats[-1] if chats and titles_match(chats[-1]["title"], shown["title"]) else None
        if cur is None:
            cur = {"title": shown["title"], "messages": [], "frames": 0, "skipped": 0, "off": 0, "rows": None}
            chats.append(cur)
        cur["frames"] += 1
        cur["captured_at"] = raw["captured_at"]
        if cur["messages"]:
            merged, off, d = merge_screen(cur["messages"], cur["off"], cur["rows"], snap, toward_older=True)
        else:
            merged, off, d = _placed(shown["messages"], 0), 0, None
        if trace:
            how = ("did not line up" if merged is None else f"scrolled {d} px" if d is not None
                   else "text merge" if cur["frames"] > 1 else "first screen")
            print(f"-- {f.stem} {shown['title']}: {how}", file=sys.stderr)
            print("\n".join("   " + _fmt(m) for m in shown["messages"]), file=sys.stderr)
        if merged is None:
            cur["skipped"] += 1
        else:
            cur.update(messages=merged, off=off, rows=snap.get("rows"))
    for c in chats:
        _fill_stamps(c["messages"])
        when = datetime.fromisoformat(c["captured_at"])
        c["messages"] = tidy([{**m, "t": absolute_stamp(m["t"], when)} for m in c["messages"]], c["title"])
    return chats


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
    ap.add_argument("--wait", type=int, default=0, metavar="MINUTES", help="with --auto-read: keep waiting this long for the Mac to be unlocked and idle")
    ap.add_argument("--trace", action="store_true", help="with --auto-read: print every screen read to stderr (contains chat text)")
    ap.add_argument("--record", action="store_true", help="with --auto-read: keep every screen (PNG + raw OCR) in ~/.wechat-export/ocr/frames/<time>/ for --replay")
    ap.add_argument("--replay", metavar="DIR", help="re-parse a recorded run offline and print the transcripts; no clicks, no capture")
    ap.add_argument("--write", action="store_true", help="with --replay: replace the saved transcripts with the replayed ones")
    ap.add_argument("--reocr", action="store_true", help="with --replay: OCR the recorded screenshots again (after a wxvision change)")
    ap.add_argument("--retidy", action="store_true", help="run every saved transcript through the cleanup pass again")
    args = ap.parse_args()
    if args.retidy:
        print("\n".join(retidy_saved()))
        return 0
    if args.replay:
        chats = replay(Path(args.replay).expanduser(), reocr=args.reocr, trace=args.trace)
        for c in chats:
            print(f"## {c['title']}  ({len(c['messages'])} messages, {c['frames']} screens, {c['skipped']} did not line up)")
            print("\n".join(_fmt(m) for m in c["messages"]) + "\n")
            if args.write and c["messages"]:
                _write_chat(c["title"], c["messages"], c["captured_at"], replace=True)
        return 0 if chats else 1
    try:
        if args.auto_read:
            desk = Desk()
            names = [n.strip() for n in args.chats.split(",") if n.strip()]
            rec = DATA_DIR / "frames" / datetime.now().strftime("%Y%m%d-%H%M%S") if args.record else None
            full = lambda: snapshot(record_dir=rec)
            chat_only = lambda: snapshot(chat_only=True, record_dir=rec)
            if args.trace:
                full, chat_only = _traced(full), _traced(chat_only)
            give_up = time.monotonic() + args.wait * 60
            while True:
                res = auto_read(desk, names, args.top, args.days, args.idle, snap=full, chat_snap=chat_only)
                waiting = res["stopped"].startswith(("you used", "the screen is locked"))  # locked: wait for unlock + idle
                if res["chats"] or not waiting or time.monotonic() > give_up:
                    break
                time.sleep(30)
            print(render_auto(res, args.days))
            if rec:
                print(f"[screens recorded in {rec}]", file=sys.stderr)
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
    print(json.dumps({k: v for k, v in snap.items() if k != "rows"}, ensure_ascii=False, indent=1) if args.json else render(snap))
    print(f"\n[{len(result['new'])} new/changed chat rows logged to {DATA_DIR}/activity.jsonl]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
