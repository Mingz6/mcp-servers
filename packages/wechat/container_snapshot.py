#!/usr/bin/env python3
"""Read WeChat running in a WechatOnCloud container (WeChat for Linux on an Xvnc display) with the Mac OCR parser.

    python3 container_snapshot.py snapshot               # one screenshot + OCR of the container display, never clicks
    python3 container_snapshot.py read --chats "A,B"     # open these chats in the container and read back --days
    python3 container_snapshot.py read                   # the same for the chats in ~/.wechat-export/ocr/allowlist.txt
    python3 container_snapshot.py read --top N           # the top N chats of the list (by hand only, never on a schedule)
    options: --instance NAME (default $WECHAT_CONTAINER, else the one running wechat-on-cloud container),
             --days N, --print (also print what was read), --keep-image, --from-png FILE (snapshot: OCR a saved
             window PNG instead of capturing)

The screenshot is `docker exec <instance> xwd -root`, decoded here (stdlib only) into a PNG of the WeChat window
and read by the same wxvision helper as the Mac path. The Linux client lays its window out differently and shows
time stamps in Chinese, so every OCR box is mapped onto the Mac layout, and every stamp into the Mac's English
form, before wechat_ocr's parser sees it. Output lands in the same ~/.wechat-export/ocr/ store.

Input (read mode) is xdotool on the container's own X display: it never moves the pointer of the Mac the container
runs on, so there is no idle gate and no Accessibility or Screen Recording grant. Opening a chat still marks it
read on the phone, exactly like the Mac path.

Same log contract as wechat_scheduled.py: one line per run, `ok:` or `skip:` exit 0, `error:` exit 1, never chat
names or message text.
"""

from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from datetime import datetime
from pathlib import Path

import wechat_ocr as w
import wechat_scheduled as sched

DISPLAY = ":1"  # the Xvnc display WechatOnCloud starts WeChat on (/defaults/autostart in the image)
IMAGE_HINT = "wechat-on-cloud"  # image name of a WeChat instance; the panel's image is woc-panel

# WeChat for Linux 4.x at 1x, measured in gloridust/wechat-on-cloud:1.6.0 on 2026-11-06 (window 1060x782).
L_AVATAR_R = 109  # chat list avatars end here (left rail 0-60, avatars 73-109, names from ~116)
L_LIST = 60  # the chat list starts here
L_PANE = 300  # the chat pane starts here (times in the list end near 290)
L_TITLE_TOP = 33  # the pane's title bar starts below the window buttons...
L_BODY_TOP = 80  # ...and ends here; messages start below it
L_INPUT_H = 142  # message input box at the bottom
L_IN_AVATAR = (312, 366)  # incoming avatars sit at 321-357; Vision reads some as a character ("品")
MIN_W, MIN_H = 600, 500  # a smaller wechat window is the login window or a popup, not the main window
NOTCH_PX = 60  # estimated content shift of one wheel click; the merge measures the real shift from pixel rows
# The display is 1x, half the pixels the Mac pipeline sees. At 1x Vision added a stray letter to a short chat title
# and read an avatar as "品", which then merged into the bubble beside it; a 2x upscale read both right in 0.4 s.
SCALE = "2"

# Where the same features sit in the Mac layout wechat_ocr was calibrated on (points).
M_AVATAR_R = 108
M_PANE = w.LIST_RIGHT
DX = L_PANE - M_PANE  # the pane is a plain shift
DY = w.BODY_TOP - L_BODY_TOP  # so is the message body

_WEEKDAY = dict(zip("一二三四五六日天", ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday", "Sunday"]))
_ZH_STAMP = re.compile(r"^(?:(今天)|(昨天)|星期([一二三四五六日天])|(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日)\s*(\d{1,2}[:：]\d{2})$")
_ZH_DAY = re.compile(r"^(?:(?:\d{4})年)?(\d{1,2})月(\d{1,2})日$")
_ZH_UNREAD = re.compile(r"^\[(\d{1,3})条\]")


class Skip(Exception):
    """Nothing to capture right now, by design: logged as `skip:` with exit 0."""


# --- coordinates: Linux window pixels <-> Mac layout points ---------------------------------------------


def map_x(x: float) -> float:
    if x <= L_AVATAR_R:
        return x * M_AVATAR_R / L_AVATAR_R
    if x <= L_PANE:  # the Linux list text column is wider: squeeze it onto the Mac one
        return M_AVATAR_R + (x - L_AVATAR_R) * (M_PANE - M_AVATAR_R) / (L_PANE - L_AVATAR_R)
    return x - DX


def map_y(y: float) -> float:
    if y <= L_TITLE_TOP:
        return 0.0
    if y <= L_BODY_TOP:  # title bar onto the Mac's (0 to TITLE_H); the Mac's pinned strip below it stays empty
        return (y - L_TITLE_TOP) * w.TITLE_H / (L_BODY_TOP - L_TITLE_TOP)
    return y + DY


def unmap_x(x: float) -> float:
    if x <= M_AVATAR_R:
        return x * L_AVATAR_R / M_AVATAR_R
    if x <= M_PANE:
        return L_AVATAR_R + (x - M_AVATAR_R) * (L_PANE - L_AVATAR_R) / (M_PANE - M_AVATAR_R)
    return x + DX


def unmap_y(y: float) -> float:
    if y <= w.TITLE_H:
        return L_TITLE_TOP + y * (L_BODY_TOP - L_TITLE_TOP) / w.TITLE_H
    return max(y - DY, L_BODY_TOP)


def mac_size(W: int, H: int) -> tuple[int, int]:
    """The Mac-layout window that the mapped boxes live in: same pane width, same input box height."""
    return round(map_x(W)), round(map_y(H - L_INPUT_H) + w.INPUT_H)


def mac_rows(rows: list[int] | None, H: int) -> list[int] | None:
    """Pixel-row hashes re-indexed so row y of the Linux body sits at y + DY, with blank (0) rows where the Mac
    layout has its title strip and input box, so pane_shift() looks at exactly the message body."""
    if not rows:
        return None
    return [0] * w.BODY_TOP + rows[L_BODY_TOP:H - L_INPUT_H] + [0] * w.INPUT_H


def en_text(text: str) -> str:
    """Chinese UI strings the parser only knows in English: time stamps, the new-messages bar, muted counts."""
    t = text.strip()
    m = _ZH_STAMP.match(t)
    if m:
        today, yday, wday, _year, mon, day, hm = m.groups()
        hm = hm.replace("：", ":")
        if today:
            return hm
        if yday:
            return f"Yesterday {hm}"
        if wday:
            return f"{_WEEKDAY[wday]} {hm}"
        return f"{int(mon)}/{int(day)} {hm}"
    m = _ZH_DAY.match(t)
    if m:  # a date in the chat list
        return f"{int(m.group(1))}/{int(m.group(2))}"
    if "新消息" in t:
        return "new message"
    m = _ZH_UNREAD.match(t)
    if m:
        return f"[{m.group(1)}]" + t[m.end():]
    return text


def map_box(b: dict) -> dict:
    x0, x1 = map_x(b["x"]), map_x(b["x"] + b["w"])
    y0, y1 = map_y(b["y"]), map_y(b["y"] + b["h"])
    out = {**b, "x": round(x0), "y": round(y0), "w": round(x1 - x0), "h": round(y1 - y0)}
    if "text" in b:
        out["text"] = en_text(b["text"])
    return out


def _crop(x: float, y: float, cw: float, ch: float, W: int, H: int) -> str:
    x0, y0 = max(0, int(x)), max(0, int(y))
    x1, y1 = min(W, int(x + cw)), min(H, int(y + ch))
    return f"{x0},{y0},{max(1, x1 - x0)},{max(1, y1 - y0)}"


# --- capture --------------------------------------------------------------------------------------------


def xwd_to_png(data: bytes, crop: tuple[int, int, int, int] | None = None) -> bytes:
    """Decode a TrueColor ZPixmap XWD (what `xwd -root` writes on Xvnc) into an RGB PNG, optionally
    cropped to (x, y, w, h). Standard library only, so launchd needs no ffmpeg or ImageMagick."""
    if len(data) < 100:
        raise w.OcrError("xwd: short read from the container")
    (hsize, _ver, fmt, _depth, width, height, _xoff, byte_order, _unit, _bit_order, _pad, bpp, bpl,
     _vclass, rmask, gmask, bmask, _bits, _entries, ncolors) = struct.unpack(">20I", data[:80])
    if fmt != 2 or bpp not in (24, 32) or (rmask, gmask, bmask) != (0xFF0000, 0xFF00, 0xFF):
        raise w.OcrError(f"xwd: unsupported pixmap (format {fmt}, {bpp} bpp, masks {rmask:x}/{gmask:x}/{bmask:x})")
    # Pixel size comes from bpp and the row stride from bytes_per_line: a container the panel re-creates
    # packs 3-byte pixels into rows zero-padded to 4 x width.
    size = bpp // 8
    if bpl < width * size:
        raise w.OcrError(f"xwd: unsupported pixmap ({bpl} bytes per line for {width} x {bpp} bpp)")
    start = hsize + ncolors * 12
    if len(data) < start + bpl * height:
        raise w.OcrError("xwd: truncated image")
    x0, y0, cw, ch = crop or (0, 0, width, height)
    x0, y0 = max(0, min(x0, width - 1)), max(0, min(y0, height - 1))
    cw, ch = max(1, min(cw, width - x0)), max(1, min(ch, height - y0))
    # A pixel is 0x00RRGGBB: stored B,G,R(,X) least significant byte first, (X,)R,G,B otherwise.
    ri, gi, bi = (2, 1, 0) if byte_order == 0 else (size - 3, size - 2, size - 1)
    raw = bytearray()
    for y in range(y0, y0 + ch):
        row = data[start + y * bpl + x0 * size:start + y * bpl + (x0 + cw) * size]
        px = bytearray(cw * 3)
        px[0::3], px[1::3], px[2::3] = row[ri::size], row[gi::size], row[bi::size]
        raw += b"\x00" + px

    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", cw, ch, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(raw), 6)) + chunk(b"IEND", b""))


def find_docker() -> str:
    """launchd's PATH has none of the places OrbStack or Docker Desktop put the CLI."""
    for c in [shutil.which("docker"), str(Path.home() / ".orbstack/bin/docker"), "/opt/homebrew/bin/docker",
              "/usr/local/bin/docker"]:
        if c and os.access(c, os.X_OK):
            return c
    raise w.OcrError("docker CLI not found (looked on PATH, ~/.orbstack/bin, /opt/homebrew/bin, /usr/local/bin)")


class Box:
    """One running WeChat container."""

    def __init__(self, docker: str, name: str) -> None:
        self.docker, self.name = docker, name

    def exec(self, argv: list[str], binary: bool = False, timeout: int = 60):
        r = subprocess.run([self.docker, "exec", "-e", f"DISPLAY={DISPLAY}", self.name, *argv],
                           capture_output=True, timeout=timeout)
        if r.returncode != 0:
            raise w.OcrError(f"docker exec {argv[0]} failed: {r.stderr.decode(errors='replace').strip()[:300]}")
        return r.stdout if binary else r.stdout.decode(errors="replace")


def find_instance(docker: str, want: str = "") -> Box:
    r = subprocess.run([docker, "ps", "--format", "{{.Names}}\t{{.Image}}"], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise w.OcrError(f"docker ps failed: {(r.stderr or r.stdout).strip()[:300]}")
    running = [ln.split("\t") for ln in r.stdout.splitlines() if "\t" in ln]
    if want:
        if not any(n == want for n, _ in running):
            raise Skip(f"the WeChat container {want} is not running")
        return Box(docker, want)
    names = [n for n, img in running if IMAGE_HINT in img]
    if not names:
        raise Skip("no WeChat container is running")
    if len(names) > 1:
        raise w.OcrError(f"{len(names)} WeChat containers are running: pass --instance or set WECHAT_CONTAINER")
    return Box(docker, names[0])


def parse_windows(out: str) -> list[dict]:
    """`xdotool getwindowgeometry --shell`, one window per line: WINDOW=.. X=.. Y=.. WIDTH=.. HEIGHT=.."""
    wins = []
    for ln in out.splitlines():
        kv = dict(p.split("=", 1) for p in ln.split() if "=" in p)
        try:
            wins.append({"x": int(kv["X"]), "y": int(kv["Y"]), "w": int(kv["WIDTH"]), "h": int(kv["HEIGHT"])})
        except (KeyError, ValueError):
            continue
    return wins


def find_window(box: Box) -> dict:
    out = box.exec(["sh", "-c", "for id in $(xdotool search --onlyvisible --class wechat 2>/dev/null); do "
                    "xdotool getwindowgeometry --shell $id | tr '\\n' ' '; echo; done"])
    wins = parse_windows(out)
    if not wins:
        raise Skip("No WeChat window in the container (WeChat not started, or closed to the tray)")
    win = max(wins, key=lambda g: g["w"] * g["h"])
    if win["w"] < MIN_W or win["h"] < MIN_H:
        raise Skip("WeChat in the container is logged out or on its login window: log in again from the panel")
    return win


# --- OCR ------------------------------------------------------------------------------------------------


def _ocr(helper: str, png: Path, *args: str) -> dict:
    return json.loads(w._run([helper, "ocr", str(png), *args]))


def junk(b: dict) -> bool:
    """Boxes that are never text a person wrote: window buttons above the title bar, an incoming avatar."""
    if b["y"] + b["h"] / 2 < L_TITLE_TOP:
        return True
    return b["y"] >= L_BODY_TOP and L_IN_AVATAR[0] <= b["x"] and b["x"] + b["w"] <= L_IN_AVATAR[1]


def ocr_window(helper: str, png: Path, W: int, H: int, chat_only: bool = False) -> tuple[dict, list[dict], list[dict]]:
    """The passes wechat_ocr.read_window() makes, at Linux positions, mapped onto the Mac layout. Returns the
    (ocr, chat-list lines, timestamp lines) build_snapshot() takes."""
    full = _ocr(helper, png, "--scale", SCALE, "--rows", f"{L_PANE},{W - w.SCROLLBAR}")
    Wm, Hm = mac_size(W, H)
    lines = [map_box(b) for b in full["lines"] if not junk(b)]
    if not w._title_lines(lines, 1.0, Wm):  # Vision drops a title followed by several emoji; alone in a crop it reads it
        band = _crop(L_PANE, L_TITLE_TOP, W - L_PANE - w.TITLE_ICONS, L_BODY_TOP - L_TITLE_TOP, W, H)
        lines += [map_box(b) for b in _ocr(helper, png, "--crop", band, "--scale", SCALE)["lines"]]
    side: list[dict] = []
    if not chat_only:
        crop = _crop(L_LIST, L_TITLE_TOP, L_PANE - L_LIST, H - L_TITLE_TOP, W, H)
        side = [map_box(b) for b in _ocr(helper, png, "--crop", crop, "--scale", SCALE)["lines"]]
        for band in w.orphan_time_bands(side, 1.0):
            x, y, bw, bh = (float(v) for v in band.split(","))
            lx, ly = unmap_x(x), unmap_y(y)
            crop = _crop(lx, ly, unmap_x(x + bw) - lx, unmap_y(y + bh) - ly, W, H)
            side += [map_box(b) for b in _ocr(helper, png, "--crop", crop, "--scale", "3")["lines"]]
    cx = (L_PANE + W) / 2
    crop = _crop(cx - 100, L_BODY_TOP, 200, H - L_INPUT_H - L_BODY_TOP, W, H)
    stamps = [map_box(b) for b in _ocr(helper, png, "--crop", crop, "--scale", "3")["lines"]]
    if len(full["lines"]) < 5:
        raise w.OcrError("Window captured but almost no text found: WeChat in the container is loading or blank")
    ocr = {"w": Wm, "h": Hm, "paper": full.get("paper"), "lines": lines,
           "reds": [map_box(r) for r in full.get("reds", [])], "rows": mac_rows(full.get("rows"), H)}
    return ocr, side, stamps


def snapshot_png(png: Path, W: int, H: int, chat_only: bool = False, keep_image: bool = False) -> dict:
    ocr, side, stamps = ocr_window(w._helper(), png, W, H, chat_only)
    if keep_image:
        w.DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy(png, w.DATA_DIR / "last.png")
    Wm, Hm = mac_size(W, H)
    return w.build_snapshot({"w": Wm, "h": Hm}, ocr, side, stamps, datetime.now().isoformat(timespec="seconds"))


def snapshot(box: Box, chat_only: bool = False, keep_image: bool = False) -> dict:
    """One capture of the container's WeChat window, in the shape wechat_ocr.snapshot() returns."""
    win = find_window(box)
    data = box.exec(["xwd", "-root", "-silent"], binary=True)
    with tempfile.TemporaryDirectory() as tmp:
        png = Path(tmp) / "wechat.png"
        png.write_bytes(xwd_to_png(data, (win["x"], win["y"], win["w"], win["h"])))
        return snapshot_png(png, win["w"], win["h"], chat_only, keep_image)


def png_size(png: Path) -> tuple[int, int]:
    head = png.read_bytes()[:24]
    return int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")


# --- input ----------------------------------------------------------------------------------------------


class ContainerDesk:
    """wechat_ocr.Desk for the container: xdotool on its X display, in the Mac-layout points AutoReader works in.
    Nobody sits at this display, so it is always idle; someone moving the pointer in the web panel still stops a
    read, through AutoReader's pointer check."""

    def __init__(self, box: Box, win: dict) -> None:
        self.box, self.win = box, win

    def _at(self, x: float, y: float) -> list[str]:
        return [str(round(self.win["x"] + unmap_x(x))), str(round(self.win["y"] + unmap_y(y)))]

    def _xdo(self, *args: str) -> str:
        return self.box.exec(["xdotool", *args])

    def state(self) -> dict:
        kv = dict(p.split("=", 1) for p in self._xdo("getmouselocation", "--shell").split() if "=" in p)
        x, y = int(kv.get("X", 0)) - self.win["x"], int(kv.get("Y", 0)) - self.win["y"]
        return {"idle": 10**9, "key": 10**9, "x": map_x(x), "y": map_y(y)}

    def front(self) -> str:
        return w.WECHAT_BUNDLE  # the container shows nothing else

    def window(self) -> dict:
        Wm, Hm = mac_size(self.win["w"], self.win["h"])
        return {"x": 0, "y": 0, "w": Wm, "h": Hm, "onscreen": True}

    def click(self, x: float, y: float) -> None:
        self._xdo("mousemove", *self._at(x, y), "click", "1")

    def scroll(self, x: float, y: float, dy: int) -> None:
        # Positive dy is a wheel step up, toward older messages, as on the Mac; AutoReader learns the sign anyway.
        n = max(1, round(abs(dy) / NOTCH_PX))
        self._xdo("mousemove", *self._at(x, y), "click", "--repeat", str(n), "--delay", "40", "4" if dy > 0 else "5")

    def move(self, x: float, y: float) -> None:
        self._xdo("mousemove", *self._at(x, y))

    def activate(self, bundle: str) -> None:
        pass

    def raise_window(self) -> None:
        pass


@contextlib.contextmanager
def _container_console():
    """auto_read() first checks whether the Mac's console is locked. That says nothing about the container's own
    display, and the Mac it runs on sits locked most of the time, so the check is off while reading the container."""
    real = w._screen_locked
    w._screen_locked = lambda: False
    try:
        yield
    finally:
        w._screen_locked = real


def read_chats(box: Box, names: list[str], top: int, days: int) -> dict:
    desk = ContainerDesk(box, find_window(box))
    with _container_console():
        return w.auto_read(desk, names, top=top, days=days, idle_secs=0,
                           snap=lambda: snapshot(box), chat_snap=lambda: snapshot(box, chat_only=True))


# --- entry point ----------------------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("mode", choices=["snapshot", "read"])
    ap.add_argument("--instance", default=os.environ.get("WECHAT_CONTAINER", ""))
    ap.add_argument("--chats", default="", help="read: comma-separated chat names (default: the allowlist)")
    ap.add_argument("--top", type=int, default=0, help="read: the top N chats instead; by hand only")
    ap.add_argument("--days", type=int, default=2, help="read: read back this many days")
    ap.add_argument("--print", dest="show", action="store_true", help="also print what was read")
    ap.add_argument("--keep-image", action="store_true", help="snapshot: keep the window PNG as last.png")
    ap.add_argument("--from-png", type=Path, help="snapshot: OCR this saved window PNG instead of capturing")
    args = ap.parse_args(argv)

    w.DATA_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    with open(sched.LOCK, "w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            sched.log("skip: the previous run is still going")
            return 0
        try:
            if args.mode == "snapshot":
                if args.from_png:
                    snap = snapshot_png(args.from_png, *png_size(args.from_png), keep_image=args.keep_image)
                else:
                    snap = snapshot(find_instance(find_docker(), args.instance), keep_image=args.keep_image)
                res = w.save(snap)
                sched.log(f"ok: container snapshot, {len(snap['chat_list'])} chat rows, {len(res['new'])} new or changed")
                if args.show:
                    print(w.render(snap))
                return 0
            names = [n.strip() for n in args.chats.split(",") if n.strip()]
            if not names and not args.top:
                names = sched.read_allowlist()
                if not names:
                    sched.log(f"skip: allowlist is empty ({sched.ALLOWLIST})")
                    return 0
            res = read_chats(find_instance(find_docker(), args.instance), names, args.top or len(names), args.days)
            if res["chats"]:
                sched.log(f"ok: container read, {len(res['chats'])} chats, "
                          f"{sum(len(c['messages']) for c in res['chats'])} messages"
                          + (f", stopped: {res['stopped']}" if res["stopped"] else ""))
            else:
                sched.log(f"skip: container read found nothing to read ({res['stopped'] or 'no reason given'})")
            if args.show:
                print(w.render_auto(res, args.days))
            return 0
        except Skip as e:
            sched.log(f"skip: {e}")
            return 0
        except w.OcrError as e:
            if "almost no text" in str(e):
                sched.log(f"skip: {str(e).split(':')[0]}")
                return 0
            sched.log(f"error: {e}")
            return 1
        except Exception as e:  # launchd gets one readable line, not a traceback
            sched.log(f"error: {type(e).__name__}: {e}")
            return 1


if __name__ == "__main__":
    sys.exit(main())
