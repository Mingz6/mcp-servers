"""Tests for the launchd entry point. Synthetic data only, nothing touches the screen or the real data dir.

Standard library only: python3 -m unittest test_wechat_scheduled -v
"""

import contextlib
import fcntl
import io
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import wechat_ocr as w
import wechat_scheduled as s

SNAP = {"chat_list": [{"chat": "Alice Synthetic"}, {"chat": "Bob Synthetic"}], "open_chat": {}}


class ScheduledTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        for target, value in [
            (w, {"DATA_DIR": self.dir}),
            (s, {"ALLOWLIST": self.dir / "allowlist.txt", "LOCK": self.dir / "scheduled.lock"}),
        ]:
            for name, v in value.items():
                p = mock.patch.object(target, name, v)
                p.start()
                self.addCleanup(p.stop)
        # Default world: WeChat running, screen unlocked.
        self.running = self.patch(s, "wechat_running", return_value=True)
        self.locked = self.patch(w, "_screen_locked", return_value=False)

    def patch(self, target, name, **kw):
        p = mock.patch.object(target, name, **kw)
        m = p.start()
        self.addCleanup(p.stop)
        return m

    def run_main(self, *argv):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = s.main(list(argv))
        return code, out.getvalue()

    def assertOneLine(self, out, prefix):
        lines = out.strip().splitlines()
        self.assertEqual(len(lines), 1, out)
        self.assertIn(prefix, lines[0])

    # --- snapshot mode -------------------------------------------------

    def test_snapshot_ok_logs_counts_not_names(self):
        self.patch(w, "snapshot", return_value=SNAP)
        self.patch(w, "save", return_value={"new": [{"chat": "Alice Synthetic"}]})
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "ok: snapshot, 2 chat rows, 1 new or changed")
        self.assertNotIn("Alice", out)

    def test_wechat_not_running_skips_without_capturing(self):
        self.running.return_value = False
        snap = self.patch(w, "snapshot")
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: WeChat is not running")
        snap.assert_not_called()

    def test_locked_screen_skips_without_capturing(self):
        self.locked.return_value = True
        snap = self.patch(w, "snapshot")
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: the screen is locked")
        snap.assert_not_called()

    def test_no_window_is_a_quiet_skip(self):
        self.patch(w, "snapshot", side_effect=w.OcrError("No WeChat window found. Open WeChat (not just the menu bar icon)."))
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: No WeChat window found")
        self.assertNotIn("Traceback", out)

    def test_login_screen_or_missing_grant_is_a_quiet_skip(self):
        self.patch(w, "snapshot", side_effect=w.OcrError("Window captured but almost no text found: WeChat is locked, on the login QR code"))
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: Window captured but almost no text found")

    def test_real_ocr_failure_exits_1_with_one_line(self):
        self.patch(w, "snapshot", side_effect=w.OcrError("wxvision failed: boom"))
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 1)
        self.assertOneLine(out, "error: wxvision failed: boom")

    def test_unexpected_exception_exits_1_without_traceback(self):
        self.patch(w, "snapshot", side_effect=ValueError("bad json"))
        code, out = self.run_main("snapshot")
        self.assertEqual(code, 1)
        self.assertOneLine(out, "error: ValueError: bad json")

    def test_overlapping_run_skips(self):
        snap = self.patch(w, "snapshot")
        with open(s.LOCK, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            code, out = self.run_main("snapshot")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: the previous run is still going")
        snap.assert_not_called()

    def test_lock_is_released_after_a_run(self):
        self.patch(w, "snapshot", return_value=SNAP)
        self.patch(w, "save", return_value={"new": []})
        self.run_main("snapshot")
        code, out = self.run_main("snapshot")
        self.assertIn("ok: snapshot", out)

    # --- auto-read mode ------------------------------------------------

    def test_allowlist_parsing(self):
        s.ALLOWLIST.write_text("# family\nAlice Synthetic\n\n  Bob Synthetic  \n   # off\n", encoding="utf-8")
        self.assertEqual(s.read_allowlist(), ["Alice Synthetic", "Bob Synthetic"])

    def test_missing_allowlist_is_empty(self):
        self.assertEqual(s.read_allowlist(), [])

    def test_empty_allowlist_never_clicks(self):
        auto = self.patch(w, "auto_read")
        desk = self.patch(w, "Desk")
        code, out = self.run_main("auto-read")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: allowlist is empty")
        auto.assert_not_called()
        desk.assert_not_called()

    def test_auto_read_opens_only_the_allowlist(self):
        s.ALLOWLIST.write_text("Alice Synthetic\nBob Synthetic\n", encoding="utf-8")
        auto = self.patch(w, "auto_read", return_value={"chats": [{"chat": "Alice Synthetic"}], "stopped": ""})
        self.patch(w, "Desk")
        code, out = self.run_main("auto-read", "--days", "3")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "ok: auto-read, 1 of 2 allowlisted chats read")
        self.assertNotIn("Alice", out)
        _, args, kw = auto.mock_calls[0]
        self.assertEqual(args[1], ["Alice Synthetic", "Bob Synthetic"])  # names, so never "the first N chats"
        self.assertEqual(kw["top"], 2)
        self.assertEqual(kw["days"], 3)
        self.assertEqual(kw["idle_secs"], 120)

    def test_auto_read_not_idle_is_a_quiet_skip(self):
        s.ALLOWLIST.write_text("Alice Synthetic\n", encoding="utf-8")
        self.patch(w, "auto_read", return_value={"chats": [], "stopped": "you used the computer 4 s ago; needs 120 s of quiet"})
        self.patch(w, "Desk")
        code, out = self.run_main("auto-read")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: auto-read read nothing (you used the computer 4 s ago")

    def test_auto_read_skips_when_wechat_closed(self):
        s.ALLOWLIST.write_text("Alice Synthetic\n", encoding="utf-8")
        self.running.return_value = False
        auto = self.patch(w, "auto_read")
        code, out = self.run_main("auto-read")
        self.assertEqual(code, 0)
        self.assertOneLine(out, "skip: WeChat is not running")
        auto.assert_not_called()


if __name__ == "__main__":
    unittest.main()
