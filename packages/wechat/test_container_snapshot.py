"""Tests for the WechatOnCloud container path. Synthetic data only: no docker, no Vision, no real data dir.

Standard library only: python3 -m unittest test_container_snapshot -v
"""

import contextlib
import fcntl
import io
import struct
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

import container_snapshot as c
import wechat_ocr as w
import wechat_scheduled as s

W, H = 1060, 782


def box(x, y, bw, bh, text):
    return {"x": x, "y": y, "w": bw, "h": bh, "text": text, "conf": 1.0}


# Positions measured on a real 1060x782 frame of WeChat for Linux (2026-11-06); the names and text are made up.
LIST = [
    box(116, 96, 90, 18, "Alice Synthetic"),
    box(116, 117, 74, 15, "see you at five"),
    box(260, 98, 30, 14, "09:32"),
    box(117, 163, 80, 12, "Bob Synthetic"),
    box(238, 162, 52, 14, "昨天21:30"),
    box(116, 181, 169, 17, "You've added Bob. Greetings ar..."),
    box(118, 227, 58, 17, "微信团队"),
]
STAMPS = [
    box(650, 93, 67, 18, "昨天21:31"),
    box(650, 190, 64, 20, "昨天21:32"),
    box(662, 266, 37, 20, "09:21"),
    box(660, 420, 38, 20, "09:32"),
]
FULL = LIST + STAMPS + [
    box(80, 50, 46, 15, "Q.搜索"),
    box(314, 49, 100, 20, "Alice Synthetic"),  # chat title
    box(899, 10, 144, 15, "x。-立"),  # window buttons
    box(933, 47, 106, 18, "0、G："),  # title bar icons
    box(379, 137, 64, 23, "hi there"),
    box(319, 363, 37, 36, "品"),  # an incoming avatar read as text, right beside the next bubble
    box(382, 370, 30, 18, "你好"),
    box(382, 467, 60, 18, "test chat"),
    box(545, 227, 272, 21, "You've added Alice. Greetings are shown above."),
    box(938, 315, 38, 15, "Hello"),
    box(887, 524, 83, 18, "how to test?"),
    box(999, 743, 28, 15, "发送"),
]


def fake_ocr(helper, png, *args):
    if "--crop" in args:
        x0 = int(args[args.index("--crop") + 1].split(",")[0])
        if x0 == c.L_LIST:
            return {"w": W, "h": H, "lines": LIST}
        if x0 == int((c.L_PANE + W) / 2 - 100):
            return {"w": W, "h": H, "lines": STAMPS}
        return {"w": W, "h": H, "lines": []}
    return {"w": W, "h": H, "paper": [250, 250, 250], "lines": FULL, "reds": [], "rows": list(range(1, H + 1))}


def xwd(pixels, width, height, byte_order=0, bpp=32, ncolors=256, bpl=None):
    """A minimal XWD file: header, window name, colormap, ZPixmap of 0x00RRGGBB pixels in bpp/8 bytes,
    each row zero-padded to bpl."""
    name = b"xwdump\x00"
    hsize = 100 + len(name)
    size = max(bpp // 8, 1)
    bpl = bpl or width * size
    head = struct.pack(">25I", hsize, 7, 2, 24, width, height, 0, byte_order, 32, byte_order, 32, bpp, bpl,
                       4, 0xFF0000, 0xFF00, 0xFF, 8, ncolors, ncolors, width, height, 0, 0, 0)
    px = [struct.pack("<I", p)[:size] if byte_order == 0 else struct.pack(">I", p)[4 - size:] for p in pixels]
    body = b"".join(b"".join(px[y * width:(y + 1) * width]).ljust(bpl, b"\x00") for y in range(height))
    return head + name + b"\x00" * (12 * ncolors) + body


def png_pixels(data):
    """(width, height, rows of (r, g, b)) of a filter-0 RGB PNG as xwd_to_png writes it."""
    width, height = struct.unpack(">II", data[16:24])
    idat = data.index(b"IDAT")
    size = struct.unpack(">I", data[idat - 4:idat])[0]
    raw = zlib.decompress(data[idat + 4:idat + 4 + size])
    rows, stride = [], 1 + width * 3
    for y in range(height):
        r = raw[y * stride + 1:(y + 1) * stride]
        rows.append([tuple(r[i:i + 3]) for i in range(0, len(r), 3)])
    return width, height, rows


class MappingTests(unittest.TestCase):
    def test_anchor_points(self):
        self.assertEqual(c.map_x(c.L_PANE), w.LIST_RIGHT)  # pane edge onto the Mac pane edge
        self.assertEqual(c.map_y(c.L_BODY_TOP + 1), w.BODY_TOP + 1)
        self.assertLess(c.map_y(49), w.TITLE_H)  # the title bar text lands in the Mac title band
        self.assertEqual(c.map_y(10), 0)  # window buttons collapse to the top edge
        self.assertLess(c.map_x(371), w.LABEL_LEFT)  # a group sender label at the bubble edge (assumed, unseen)...
        self.assertGreater(c.map_x(378), w.LABEL_LEFT)  # ...and incoming bubble text (~378) fall either side

    def test_round_trip(self):
        for x in (20, 100, 116, 200, 289, 300, 380, 700, 1000):
            self.assertAlmostEqual(c.unmap_x(c.map_x(x)), x, delta=0.01)
        for y in (40, 60, 81, 300, 639):
            self.assertAlmostEqual(c.unmap_y(c.map_y(y)), y, delta=0.01)

    def test_mac_size_keeps_body_and_pane(self):
        Wm, Hm = c.mac_size(W, H)
        self.assertEqual(Wm, W - c.DX)
        self.assertEqual(Hm - w.INPUT_H, round(c.map_y(H - c.L_INPUT_H)))  # same body bottom in both layouts

    def test_mac_rows_line_up_with_mapped_boxes(self):
        rows = list(range(1, H + 1))
        out = c.mac_rows(rows, H)
        self.assertEqual(len(out), c.mac_size(W, H)[1])
        for y in (c.L_BODY_TOP + 1, 300, H - c.L_INPUT_H - 1):
            self.assertEqual(out[round(c.map_y(y))], rows[y])
        self.assertEqual(set(out[:w.BODY_TOP]) | set(out[-w.INPUT_H:]), {0})  # outside the body: blank, ignored
        self.assertIsNone(c.mac_rows(None, H))

    def test_chinese_stamps_become_the_english_the_parser_knows(self):
        cases = {
            "昨天21:31": "Yesterday 21:31",
            "昨天 21:31": "Yesterday 21:31",
            "今天 09:05": "09:05",
            "星期三 08:00": "Wednesday 08:00",
            "星期日 8:00": "Sunday 8:00",
            "11月3日 21:31": "11/3 21:31",
            "2025年11月3日 21：31": "11/3 21:31",
            "11月3日": "11/3",
            "↓ 3条新消息": "new message",
            "[3条] see you": "[3] see you",
            "你好": "你好",
            "昨天下午见": "昨天下午见",
        }
        for zh, en in cases.items():
            self.assertEqual(c.en_text(zh), en, zh)
            if ":" in en:
                self.assertTrue(w.is_stamp(en) or w.TIME_STAMP.match(en), en)


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(c, "_ocr", side_effect=fake_ocr)
        self.ocr = p.start()
        self.addCleanup(p.stop)

    def snap(self):
        ocr, side, stamps = c.ocr_window("helper", Path("x.png"), W, H)
        Wm, Hm = c.mac_size(W, H)
        return w.build_snapshot({"w": Wm, "h": Hm}, ocr, side, stamps, "2026-11-06T10:00:00")

    def test_chat_list(self):
        rows = [{k: r[k] for k in ("chat", "time", "preview", "unread")} for r in self.snap()["chat_list"]]
        self.assertEqual(rows, [
            {"chat": "Alice Synthetic", "time": "09:32", "preview": "see you at five", "unread": 0},
            {"chat": "Bob Synthetic", "time": "Yesterday 21:30", "preview": "You've added Bob. Greetings ar...", "unread": 0},
        ])

    def test_open_chat(self):
        chat = self.snap()["open_chat"]
        self.assertEqual(chat["title"], "Alice Synthetic")
        got = [(m["t"], m["side"], m["sender"], m["text"]) for m in chat["messages"]]
        self.assertEqual(got, [
            ("Yesterday 21:31", "in", "Alice Synthetic", "hi there"),
            ("Yesterday 21:32", "system", "", "You've added Alice. Greetings are shown above."),
            ("09:21", "out", "me", "Hello"),
            ("09:21", "in", "Alice Synthetic", "你好"),  # not swallowed by the avatar box beside it
            ("09:32", "in", "Alice Synthetic", "test chat"),
            ("09:32", "out", "me", "how to test?"),
        ])

    def test_every_pass_upscales_the_1x_display(self):
        self.snap()
        for call in self.ocr.call_args_list:
            self.assertIn("--scale", call.args)

    def test_blank_window_is_almost_no_text(self):
        self.ocr.side_effect = lambda *a: {"w": W, "h": H, "lines": FULL[:3], "reds": []}
        with self.assertRaisesRegex(w.OcrError, "almost no text"):
            c.ocr_window("helper", Path("x.png"), W, H)


class XwdTests(unittest.TestCase):
    PIX = [0x112233, 0x445566, 0x778899, 0xAABBCC, 0xDDEEFF, 0x010203]  # 3 x 2

    def test_decode_lsb_and_msb(self):
        for order in (0, 1):
            width, height, rows = png_pixels(c.xwd_to_png(xwd(self.PIX, 3, 2, byte_order=order)))
            self.assertEqual((width, height), (3, 2))
            self.assertEqual(rows[0][0], (0x11, 0x22, 0x33))
            self.assertEqual(rows[1][2], (0x01, 0x02, 0x03))

    def test_decode_24_bpp_rows(self):
        # A container the panel re-creates writes 3-byte pixels in rows padded to 4 x width
        for bpl in (12, 9):
            for order in (0, 1):
                data = xwd(self.PIX, 3, 2, byte_order=order, bpp=24, bpl=bpl)
                width, height, rows = png_pixels(c.xwd_to_png(data))
                self.assertEqual((width, height), (3, 2), (bpl, order))
                self.assertEqual(rows[0], [(0x11, 0x22, 0x33), (0x44, 0x55, 0x66), (0x77, 0x88, 0x99)], (bpl, order))
                self.assertEqual(rows[1][2], (0x01, 0x02, 0x03), (bpl, order))
        _, _, rows = png_pixels(c.xwd_to_png(xwd(self.PIX, 3, 2, bpp=24, bpl=12), crop=(1, 1, 2, 1)))
        self.assertEqual(rows[0], [(0xDD, 0xEE, 0xFF), (0x01, 0x02, 0x03)])

    def test_crop_to_the_window(self):
        width, height, rows = png_pixels(c.xwd_to_png(xwd(self.PIX, 3, 2), crop=(1, 1, 2, 1)))
        self.assertEqual((width, height), (2, 1))
        self.assertEqual(rows[0], [(0xDD, 0xEE, 0xFF), (0x01, 0x02, 0x03)])

    def test_png_size_reads_the_header(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "a.png"
            p.write_bytes(c.xwd_to_png(xwd(self.PIX, 3, 2)))
            self.assertEqual(c.png_size(p), (3, 2))

    def test_rejects_what_it_cannot_decode(self):
        with self.assertRaisesRegex(w.OcrError, "unsupported"):
            c.xwd_to_png(xwd([0] * 6, 3, 2, bpp=16))
        with self.assertRaisesRegex(w.OcrError, "truncated"):
            c.xwd_to_png(xwd(self.PIX, 3, 2)[:-5])
        with self.assertRaisesRegex(w.OcrError, "short read"):
            c.xwd_to_png(b"")


class ContainerTests(unittest.TestCase):
    def test_find_window_picks_the_main_window(self):
        box_ = mock.Mock()
        box_.exec.return_value = ("WINDOW=1 X=0 Y=0 WIDTH=1 HEIGHT=1 SCREEN=0 \n"
                                  "WINDOW=2 X=5 Y=6 WIDTH=1060 HEIGHT=782 SCREEN=0 \n")
        self.assertEqual(c.find_window(box_), {"x": 5, "y": 6, "w": 1060, "h": 782})

    def test_find_window_skips(self):
        box_ = mock.Mock()
        box_.exec.return_value = "WINDOW=3 X=300 Y=200 WIDTH=280 HEIGHT=380 SCREEN=0 \n"
        with self.assertRaisesRegex(c.Skip, "logged out"):
            c.find_window(box_)
        box_.exec.return_value = ""
        with self.assertRaisesRegex(c.Skip, "No WeChat window"):
            c.find_window(box_)

    def ps(self, out, code=0):
        return mock.patch.object(c.subprocess, "run", return_value=mock.Mock(returncode=code, stdout=out, stderr=""))

    def test_find_instance(self):
        two = "woc-wx-a\tgloridust/wechat-on-cloud:1.6.0\nwoc-panel\tgloridust/woc-panel:1.6.0\n"
        with self.ps(two):
            self.assertEqual(c.find_instance("docker").name, "woc-wx-a")
            with self.assertRaisesRegex(c.Skip, "woc-wx-b is not running"):
                c.find_instance("docker", "woc-wx-b")
        with self.ps("woc-panel\tgloridust/woc-panel:1.6.0\n"), self.assertRaisesRegex(c.Skip, "no WeChat container"):
            c.find_instance("docker")
        with self.ps("a\tx/wechat-on-cloud:1\nb\tx/wechat-on-cloud:1\n"), self.assertRaisesRegex(w.OcrError, "pass --instance"):
            c.find_instance("docker")

    def test_desk_speaks_linux_pixels(self):
        box_ = mock.Mock()
        desk = c.ContainerDesk(box_, {"x": 10, "y": 20, "w": W, "h": H})
        desk.click(c.map_x(180), c.map_y(112))
        box_.exec.assert_called_with(["xdotool", "mousemove", "190", "132", "click", "1"])
        desk.scroll(c.map_x(680), c.map_y(400), 130)  # about two wheel clicks, up
        box_.exec.assert_called_with(["xdotool", "mousemove", "690", "420", "click", "--repeat", "2", "--delay", "40", "4"])
        desk.scroll(c.map_x(680), c.map_y(400), -30)
        self.assertEqual(box_.exec.call_args.args[0][-5:], ["--repeat", "1", "--delay", "40", "5"])
        box_.exec.return_value = "X=190 Y=132 SCREEN=0 WINDOW=1\n"
        st = desk.state()
        self.assertAlmostEqual(st["x"], c.map_x(180), delta=0.01)
        self.assertAlmostEqual(st["y"], c.map_y(112), delta=0.01)
        self.assertGreater(st["idle"], 10**6)
        self.assertEqual(desk.front(), w.WECHAT_BUNDLE)
        self.assertEqual(desk.window(), {"x": 0, "y": 0, "w": c.mac_size(W, H)[0], "h": c.mac_size(W, H)[1], "onscreen": True})

    def test_read_ignores_the_mac_console_lock_only_while_reading(self):
        seen = {}

        def fake_auto_read(desk, names, **kw):
            seen["locked"] = w._screen_locked()
            seen["idle_secs"] = kw["idle_secs"]
            return {"chats": [], "stopped": ""}

        real = w._screen_locked
        with mock.patch.object(c, "find_window", return_value={"x": 0, "y": 0, "w": W, "h": H}), \
                mock.patch.object(w, "auto_read", side_effect=fake_auto_read):
            c.read_chats(mock.Mock(), ["Alice Synthetic"], 1, 2)
        self.assertEqual(seen, {"locked": False, "idle_secs": 0})
        self.assertIs(w._screen_locked, real)


class MainTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        for target, values in [(w, {"DATA_DIR": self.dir}),
                               (s, {"ALLOWLIST": self.dir / "allowlist.txt", "LOCK": self.dir / "scheduled.lock"})]:
            for name, v in values.items():
                p = mock.patch.object(target, name, v)
                p.start()
                self.addCleanup(p.stop)
        self.docker = self.patch(c, "find_docker", return_value="docker")
        self.instance = self.patch(c, "find_instance", return_value=mock.Mock())

    def patch(self, target, name, **kw):
        p = mock.patch.object(target, name, **kw)
        m = p.start()
        self.addCleanup(p.stop)
        return m

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = c.main(list(argv))
        return code, out.getvalue()

    def assertOneLine(self, out, prefix):
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1, out)
        self.assertIn(prefix, lines[0])

    def test_snapshot_ok_logs_counts_not_names(self):
        self.patch(c, "snapshot", return_value={"chat_list": [{"chat": "Alice Synthetic"}], "open_chat": {}})
        self.patch(w, "save", return_value={"new": [{"chat": "Alice Synthetic"}]})
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "ok: container snapshot, 1 chat rows, 1 new or changed")
        self.assertNotIn("Alice", out)

    def test_skips_exit_zero_with_one_line(self):
        for exc in [c.Skip("no WeChat container is running"),
                    c.Skip("WeChat in the container is logged out or on its login window: scan the QR code"),
                    w.OcrError("Window captured but almost no text found: WeChat in the container is loading")]:
            self.patch(c, "snapshot", side_effect=exc)
            code, out = self.run_main("snapshot")
            self.assertEqual(code, 0, exc)
            self.assertOneLine(out, "skip: ")

    def test_container_not_running(self):
        self.instance.side_effect = c.Skip("no WeChat container is running")
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: no WeChat container is running")

    def test_errors_exit_one(self):
        self.docker.side_effect = w.OcrError("docker CLI not found")
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 1)
        self.assertOneLine(out, "error: docker CLI not found")
        self.docker.side_effect = None
        self.patch(c, "snapshot", side_effect=KeyError("lines"))
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 1)
        self.assertOneLine(out, "error: KeyError")

    def test_overlap_skips(self):
        with open(s.LOCK, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: the previous run is still going")

    def test_read_with_empty_allowlist_skips_without_touching_docker(self):
        code, out = self.run_main("read")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: allowlist is empty")
        self.docker.assert_not_called()

    def test_read_uses_the_allowlist_and_logs_counts(self):
        s.ALLOWLIST.write_text("# comment\nAlice Synthetic\n\n", encoding="utf-8")
        read = self.patch(c, "read_chats", return_value={
            "chats": [{"messages": [1, 2, 3]}], "stopped": ""})
        code, out = self.run_main("read", "--days", "3")
        self.assertEqual(code, 0)
        self.assertEqual(read.call_args.args[1:], (["Alice Synthetic"], 1, 3))
        self.assertOneLine(out, "ok: container read, 1 chats, 3 messages")
        self.assertNotIn("Alice", out)


if __name__ == "__main__":
    unittest.main()
