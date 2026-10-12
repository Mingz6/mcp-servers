"""Tests for the screenshot-OCR reader. Synthetic OCR lines only, no real chat content.

Standard library only, so no extra install: python3 -m unittest test_wechat_ocr -v
"""

import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import wechat_ocr as w


def line(text, x, y, wd, h):
    return {"text": text, "x": x, "y": y, "w": wd, "h": h}


CHAT_LIST_LINES = [
    line("3", 100, 70, 8, 12),  # stray badge digit, must not become a chat name
    line("Alice", 114, 66, 49, 20),
    line("19:26", 207, 68, 29, 11),
    line("[3]Bob：hi", 116, 87, 117, 15),
    line("14:59", 207, 131, 29, 10),  # time line sits above the name line, as OCR returns it
    line("File Transfer", 116, 133, 85, 15),
    line("note", 117, 154, 40, 12),
    line("Carol", 114, 198, 40, 16),
    line("10/01", 207, 200, 30, 11),
    line("ok", 116, 219, 30, 12),
]
REDS = [{"x": 104, "y": 192, "w": 8, "h": 12}]


def chat_list():
    return w.parse_chat_list(CHAT_LIST_LINES, REDS, 1.0)


class ChatListTests(unittest.TestCase):
    def test_rows_times_and_unread(self):
        rows = [(r["chat"], r["time"], r["preview"], r["unread"]) for r in chat_list()]
        self.assertEqual(rows, [
            ("Alice", "19:26", "Bob：hi", 3),  # "[3]" prefix is the muted-chat unread count
            ("File Transfer", "14:59", "note", 0),
            ("Carol", "10/01", "ok", 1),  # red dot, no count
        ])

    def test_empty_input(self):
        self.assertEqual(w.parse_chat_list([], [], 1.0), [])

    def test_a_time_with_no_title_beside_it_gets_a_thin_crop_to_read_again(self):
        side = [
            line("Alice", 116, 66, 49, 20), line("19:26", 207, 68, 29, 11),
            line("EMD", 72, 190, 34, 12),  # avatar text must not count as a title
            line("01:31", 207, 193, 28, 11),  # the title next to the emoji was dropped
            line("［Draft］确认", 115, 214, 116, 14),
        ]
        self.assertEqual(w.orphan_time_bands(side, 1.0), ["110,184,95,28"])
        self.assertEqual(w.orphan_time_bands(CHAT_LIST_LINES, 1.0), [])


STAMPS = [line("07:30", 742, 139, 35, 12)]
PANE_LINES = [
    line("群聊(3)", 261, 18, 196, 19),
    line("07:30", 742, 140, 35, 12),  # same time seen in the full pass, must be dropped
    line("Bob", 315, 255, 43, 12),
    line("你好", 326, 284, 30, 17),
    line("再见", 326, 303, 30, 17),  # second line of the same bubble run
    line("Carol", 315, 378, 41, 12),  # sender label followed by a sticker
    line("收到", 1150, 500, 40, 17),
    line('"Eve" joined', 560, 600, 400, 15),
]


def open_chat():
    return w.parse_open_chat(PANE_LINES, STAMPS, 1.0, 1280, 1440)


class OpenChatTests(unittest.TestCase):
    def test_title_and_messages(self):
        chat = open_chat()
        self.assertEqual(chat["title"], "群聊(3)")
        self.assertEqual(chat["messages"], [
            {"t": "07:30", "side": "in", "sender": "Bob", "text": "你好\n再见"},
            {"t": "07:30", "side": "in", "sender": "Carol", "text": "[non-text message]"},
            {"t": "07:30", "side": "out", "sender": "me", "text": "收到"},
            {"t": "07:30", "side": "system", "sender": "", "text": '"Eve" joined'},
        ])

    def test_trailing_sticker_label_is_kept(self):
        chat = w.parse_open_chat([line("Carol", 315, 378, 41, 12)], [], 1.0, 1280, 1440)
        self.assertEqual(chat["messages"], [{"t": "", "side": "in", "sender": "Carol", "text": "[non-text message]"}])

    def test_one_to_one_ignores_label_like_text_from_images_and_keeps_cards_incoming(self):
        pane = [
            line("Mom", 261, 18, 40, 19),
            line("text inside a screenshot", 319, 100, 120, 14),  # x < LABEL_LEFT, not a sender label here
            line("see this listing", 329, 150, 90, 17),
            line("Mini program card title", 351, 200, 120, 15),  # icon pushes the card text right
            line("sure thing", 1587, 300, 70, 17),
        ]
        chat = w.parse_open_chat(pane, [], 1.0, 1800, 1131)
        self.assertEqual([(m["side"], m["sender"], m["text"]) for m in chat["messages"]], [
            ("in", "Mom", "see this listing"),
            ("in", "Mom", "Mini program card title"),
            ("out", "me", "sure thing"),
        ])

    def test_one_to_one_chat_uses_title_as_sender(self):
        pane = [line("Mom", 261, 18, 40, 19), line("hi there", 326, 284, 60, 17)]
        chat = w.parse_open_chat(pane, [], 1.0, 1280, 1440)
        self.assertEqual(chat["messages"], [{"t": "", "side": "in", "sender": "Mom", "text": "hi there"}])

    def test_merge_fragments_joins_split_name_but_not_far_pieces(self):
        parts = [line("小鹿", 100, 50, 30, 15), line("凶", 140, 51, 12, 15), line("far", 400, 50, 20, 15)]
        self.assertEqual([m["text"] for m in w._merge_fragments(parts, 1.0)], ["小鹿 凶", "far"])


def snap(rows):
    return {
        "captured_at": datetime.now().isoformat(timespec="seconds"),
        "source": "test",
        "chat_list": rows,
        "open_chat": open_chat(),
    }


def msg(text, t="", side="in"):
    return {"t": t, "side": side, "sender": "Mom", "text": text}


A, B, C, D, E = (msg(t) for t in (
    "the contractor called about the permit",
    "can you send the invoice tomorrow",
    "sure I will do that after lunch",
    "thanks see you at six on Friday",
    "running late traffic on the bridge",
))
LETTER = {m["text"]: k for k, m in zip("abcde", (A, B, C, D, E))}


class MergeTests(unittest.TestCase):
    def texts(self, msgs):
        return [LETTER[m["text"]] for m in msgs]

    def test_scroll_up_prepends_older_messages(self):
        self.assertEqual(self.texts(w.merge_transcripts([C, D, E], [A, B, C, D])), list("abcde"))

    def test_scroll_down_appends_newer_messages(self):
        self.assertEqual(self.texts(w.merge_transcripts([A, B, C], [B, C, D])), list("abcd"))

    def test_same_screen_with_ocr_noise_changes_nothing(self):
        noisy = [dict(m, text=m["text"].replace("invoice", "inv0ice")) for m in (B, C)]
        self.assertEqual(self.texts(w.merge_transcripts([A, B, C], noisy)), list("abc"))

    def test_no_overlap_means_scrolled_too_fast(self):
        self.assertIsNone(w.merge_transcripts([A, B], [D, E]))

    def test_one_short_message_is_not_proof_of_overlap(self):
        ok = msg("ok")
        self.assertIsNone(w.merge_transcripts([A, ok], [ok, E]))

    def test_one_long_message_is_enough(self):
        self.assertEqual(self.texts(w.merge_transcripts([A, B], [B, C])), list("abc"))

    def test_a_short_line_read_differently_each_frame_does_not_break_the_overlap(self):
        quote_a, quote_b = msg("小鹿窩"), msg("小鹿？")
        merged = w.merge_transcripts([A, quote_a, B], [A, quote_b, B, C])
        self.assertEqual(self.texts([m for m in merged if m["text"] in LETTER]), list("abc"))

    def test_two_slices_of_one_tall_message_count_as_the_same_message(self):
        top = msg("【周末徒步】（江边）集合时间早上8点半 2026.10.18出发 每人车费250元")
        bottom = msg("集合时间早上8点半 2026.10.18出发 每人车费250元 记得带好雨衣和1升水")
        self.assertTrue(w._same_msg(top, bottom))
        self.assertFalse(w._same_msg(A, B))

    def test_noisy_lines_around_one_long_message_still_line_up(self):
        garbage1, garbage2, garbage3 = msg("子豚"), msg("現在牌价"), msg("0呢？5")
        merged = w.merge_transcripts([A, garbage1, B, C], [garbage2, garbage3, B, C, D])
        self.assertEqual(self.texts([m for m in merged if m["text"] in LETTER]), list("abcd"))
        self.assertIsNone(w.merge_transcripts([A, garbage1], [garbage2, D]))

    def test_a_line_the_new_screen_missed_keeps_its_place(self):
        later = [msg("好"), msg("那天240的车票还没有买到"), msg("调不调"), msg("以前发过给你")]
        card = [msg("钥匙找不到了，不知道放哪里了"), msg("小王周六在公园门口等大家集合")]
        merged = w.merge_transcripts(later, card + [msg("调不调"), msg("以前发过给你")])
        self.assertEqual([m["text"] for m in merged], [c["text"] for c in card] + [m["text"] for m in later])

    def test_first_screen_starts_the_transcript(self):
        self.assertEqual(w.merge_transcripts([], [A, B]), [A, B])

    def test_fill_stamps_carries_the_previous_time_forward(self):
        msgs = [msg("x", ""), msg("y", "07:30"), msg("z", "")]
        w._fill_stamps(msgs)
        self.assertEqual([m["t"] for m in msgs], ["", "07:30", "07:30"])


class DataDirCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data_dir = Path(tmp.name) / "ocr"
        patcher = mock.patch.object(w, "DATA_DIR", self.data_dir)
        patcher.start()
        self.addCleanup(patcher.stop)


class StorageTests(DataDirCase):
    def test_save_logs_only_new_or_changed_rows(self):
        rows = chat_list()
        self.assertEqual(len(w.save(snap(rows))["new"]), 3)
        self.assertEqual(w.save(snap(rows))["new"], [])  # nothing changed between captures

        changed = [dict(r) for r in rows]
        changed[2].update(time="10:05", preview="see you tomorrow")
        self.assertEqual([r["chat"] for r in w.save(snap(changed))["new"]], ["Carol"])

    def test_save_writes_files_in_private_dir(self):
        w.save(snap(chat_list()))
        self.assertTrue((self.data_dir / "latest.json").exists())
        self.assertIn("Alice", (self.data_dir / "latest.md").read_text(encoding="utf-8"))
        self.assertEqual(self.data_dir.stat().st_mode & 0o777, 0o700)
        self.assertEqual(len(w.saved_chats("群聊")), 1)
        self.assertEqual(w.saved_chats("nobody"), [])

    def test_history_window_and_chat_filter(self):
        w.save(snap(chat_list()))
        old = (datetime.now() - timedelta(days=30)).isoformat(timespec="seconds")
        with open(self.data_dir / "activity.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"seen_at": old, "chat": "Alice", "time": "1:00", "preview": "old", "unread": 0}) + "\n")
        self.assertEqual(len(w.history(7)), 3)
        self.assertEqual([r["chat"] for r in w.history(7, "carol")], ["Carol"])
        self.assertEqual(len(w.history(60, "alice")), 2)

    def test_stitch_merges_screens_and_skips_other_chats(self):
        frames = [
            {"open_chat": {"title": "Mom", "messages": [dict(m) for m in (C, D, E)]}},
            {"open_chat": {"title": "Mom", "messages": [dict(m, t="Yesterday 09:00") for m in (A, B, C, D)]}},
            {"open_chat": {"title": "Other group", "messages": [dict(m) for m in (A, E)]}},
        ]
        clock = mock.Mock(monotonic=mock.Mock(side_effect=[0, 1, 2, 3, 100]))
        with mock.patch.object(w, "snapshot", side_effect=frames), mock.patch.object(w, "time", clock):
            res = w.stitch(10, "mom")
        self.assertEqual((res["frames"], res["skipped"], len(res["messages"])), (3, 1, 5))
        self.assertEqual(res["messages"][-1]["t"], "Yesterday 09:00")  # carried forward from the older screen
        self.assertIn(A["text"], (self.data_dir / "chats" / "Mom.md").read_text(encoding="utf-8"))

    def test_stitch_survives_a_blank_frame(self):
        frames = [w.OcrError("no text"), {"open_chat": {"title": "Mom", "messages": [dict(m) for m in (A, B)]}}]
        clock = mock.Mock(monotonic=mock.Mock(side_effect=[0, 1, 2, 100]))
        with mock.patch.object(w, "snapshot", side_effect=frames), mock.patch.object(w, "time", clock):
            res = w.stitch(10)
        self.assertEqual((res["skipped"], len(res["messages"]), res["error"]), (1, 2, "no text"))

    def test_history_without_log_is_empty(self):
        self.assertEqual(w.history(), [])

    def test_later_capture_merges_into_the_saved_transcript(self):
        now = "2026-10-11T22:00:00"
        w._write_chat("Mom", [msg(A["text"], "Yesterday 08:08"), msg(B["text"]), msg(C["text"])], now)
        w._write_chat("Mom", [msg(B["text"], "Yesterday 08:08"), msg(C["text"]), msg(D["text"], "21:00")], now)
        saved = json.loads((self.data_dir / "chats" / "Mom.json").read_text(encoding="utf-8"))
        self.assertEqual([m["text"] for m in saved], [A["text"], B["text"], C["text"], D["text"]])
        self.assertEqual([m["t"] for m in saved], ["2026-10-10 08:08"] * 3 + ["2026-10-11 21:00"])

    def test_capture_sharing_nothing_replaces_the_transcript_and_keeps_the_old_one(self):
        now = "2026-10-11T22:00:00"
        w._write_chat("Mom", [msg(A["text"], "08:00"), msg(B["text"])], now)
        w._write_chat("Mom", [msg(D["text"], "09:00"), msg(E["text"])], now)
        self.assertIn(D["text"], (self.data_dir / "chats" / "Mom.md").read_text(encoding="utf-8"))
        self.assertIn(A["text"], (self.data_dir / "chats" / "_previous" / "Mom.md").read_text(encoding="utf-8"))
        self.assertEqual(len(w.saved_chats("mom")), 1)  # _previous is not a second chat

    def test_an_emoji_read_differently_each_time_stays_one_chat(self):
        now = "2026-10-11T22:00:00"
        w._write_chat("小鹿い", [msg(A["text"], "08:00"), msg(B["text"])], now)
        w._write_chat("小鹿®", [msg(B["text"], "08:00"), msg(C["text"])], now)
        w._write_chat("周末&徒步爱好搭子群（498）", [msg(D["text"], "09:00")], now)
        w._write_chat("周末&徒步爱好第五群（92）", [msg(E["text"], "09:00")], now)
        self.assertEqual(sorted(p.name for p in (self.data_dir / "chats").glob("*.json")),
                         ["周末_徒步爱好搭子群_498.json", "周末_徒步爱好第五群_92.json", "小鹿い.json"])
        saved = json.loads((self.data_dir / "chats" / "小鹿い.json").read_text(encoding="utf-8"))
        self.assertEqual([m["text"] for m in saved], [A["text"], B["text"], C["text"]])


class StampTests(unittest.TestCase):
    NOW = datetime(2026, 10, 11, 23, 0)  # a Sunday

    def test_relative_stamps_become_dates(self):
        cases = {
            "08:08": "2026-10-11 08:08",
            "Yesterday 08:08": "2026-10-10 08:08",
            "Thursday 09:01": "2026-10-08 09:01",
            "Sunday 09:01": "2026-10-04 09:01",  # same weekday name means a week ago
            "10/5 12:00": "2026-10-05 12:00",
            "12/30 10:00": "2025-12-30 10:00",  # a future date means last year
            "昨天 07:15": "2026-10-10 07:15",
            "星期四 09:01": "2026-10-08 09:01",
        }
        for stamp, want in cases.items():
            self.assertEqual(w.absolute_stamp(stamp, self.NOW), want, stamp)

    def test_unknown_and_absolute_stamps_pass_through(self):
        self.assertEqual(w.absolute_stamp("", self.NOW), "")
        self.assertEqual(w.absolute_stamp("Someday 09:01", self.NOW), "Someday 09:01")
        self.assertEqual(w.absolute_stamp("2026-10-08 09:01", self.NOW), "2026-10-08 09:01")

    def test_oldest_date(self):
        msgs = [msg("x", ""), msg("y", "Thursday 09:01"), msg("z", "Yesterday 08:08")]
        self.assertEqual(w.oldest_date(msgs, self.NOW), datetime(2026, 10, 8, 9, 1))
        self.assertIsNone(w.oldest_date([msg("x", "")], self.NOW))


class TargetTests(unittest.TestCase):
    ROWS = [{"chat": n, "y": 70 + 65 * i} for i, n in enumerate(["File Transfer", "小鹿", "Subscriptions", "周末徒步群"])]

    def test_top_skips_service_chats(self):
        self.assertEqual([r["chat"] for r in w.pick_targets(self.ROWS, [], 2)], ["小鹿", "周末徒步群"])

    def test_names_match_loosely_and_missing_names_are_dropped(self):
        picked = w.pick_targets(self.ROWS, ["周末", "nobody"], 5)
        self.assertEqual([r["chat"] for r in picked], ["周末徒步群"])

    def test_title_match_ignores_emoji_and_member_count(self):
        self.assertTrue(w.titles_match("小鹿", "小鹿®"))
        self.assertTrue(w.titles_match("周末徒步群", "周末徒步群(92)"))
        self.assertFalse(w.titles_match("Alice", "Bob"))


def _long_chat(n=40):
    """n distinct messages, 10 per day ending today, oldest first."""
    now = datetime.now()
    return [
        {"t": (now - timedelta(days=3 - i // 10 + 1)).strftime("%Y-%m-%d %H:%M"), "side": "in", "sender": "Mom",
         "text": hashlib.md5(str(i).encode()).hexdigest()[:14]}
        for i in range(n)
    ]


class FakeDesk:
    """A WeChat window with 6 messages in view. dir=+1: a positive scroll moves toward older messages."""

    def __init__(self, chat, dir=1, key_idle=999, idle=999, list_name="Mom"):
        self.chat, self.dir, self.key_idle, self.idle = chat, dir, key_idle, idle
        self.list_name = list_name
        self.pos = len(chat) - 6
        self.x = self.y = 0.0
        self.clicks, self.moves, self.activations = [], [], []

    def state(self):
        return {"idle": self.idle, "key": self.key_idle, "x": self.x, "y": self.y}

    def front(self):
        return "com.microsoft.VSCode"

    def window(self):
        return {"x": 0, "y": 38, "w": 1800, "h": 1131, "onscreen": True}

    def click(self, x, y):
        self.clicks.append((x, y))
        self.x, self.y = x, y

    def scroll(self, x, y, dy):
        self.x, self.y = x, y
        self.pos = max(0, min(len(self.chat) - 6, self.pos + (-3 if dy * self.dir > 0 else 3)))

    def move(self, x, y):
        self.moves.append((x, y))

    def activate(self, bundle):
        self.activations.append(bundle)

    def snap(self):
        shown = [dict(m) for m in self.chat[self.pos:self.pos + 6]]
        rows = [{"chat": "File Transfer", "time": "", "preview": "", "unread": 0, "y": 70},
                {"chat": self.list_name, "time": "", "preview": "", "unread": 1, "y": 135}]
        return {"captured_at": datetime.now().isoformat(timespec="seconds"), "source": "test",
                "chat_list": rows, "open_chat": {"title": "Mom", "messages": shown}}


class AutoReadTests(DataDirCase):
    def run_read(self, desk, **kw):
        clock = mock.Mock(monotonic=mock.Mock(return_value=0), sleep=mock.Mock())
        with mock.patch.object(w, "time", clock), mock.patch.object(w, "_screen_locked", return_value=False):
            return w.auto_read(desk, snap=desk.snap, **kw)

    def check_full_read(self, dir):
        chat = _long_chat()
        desk = FakeDesk(chat, dir=dir)
        res = self.run_read(desk, days=3)
        mom = res["chats"][0]
        self.assertTrue(mom["stopped"].startswith("reached 3 days"), mom["stopped"])
        all_texts = [c["text"] for c in chat]
        texts = [m["text"] for m in mom["messages"]]
        self.assertEqual(texts, all_texts[all_texts.index(texts[0]):])  # contiguous, in order, up to the newest
        self.assertEqual(desk.clicks[0][1], 38 + 135)  # the Mom row, File Transfer skipped
        self.assertEqual(desk.pos, len(chat) - 6)  # chat left at its newest message
        self.assertEqual(desk.moves, [(0.0, 0.0)])  # pointer put back
        self.assertEqual(desk.activations[-1], "com.microsoft.VSCode")

    def test_reads_back_three_days_when_positive_scroll_goes_older(self):
        self.check_full_read(+1)

    def test_learns_the_direction_when_positive_scroll_goes_newer(self):
        self.check_full_read(-1)

    def test_big_wheel_steps_overshoot_and_the_reader_backs_off(self):
        class Jumpy(FakeDesk):  # a step above 120 skips a whole screen
            def scroll(self, x, y, dy):
                self.x, self.y = x, y
                n = 3 if abs(dy) <= 120 else 7
                self.pos = max(0, min(len(self.chat) - 6, self.pos + (-n if dy * self.dir > 0 else n)))

        chat = _long_chat()
        desk = Jumpy(chat)
        res = self.run_read(desk, days=3)
        mom = res["chats"][0]
        self.assertTrue(mom["stopped"].startswith("reached 3 days"), mom["stopped"])
        self.assertEqual(desk.pos, len(chat) - 6)

    def test_an_image_filling_the_screen_is_not_the_top_of_the_chat(self):
        class Images(FakeDesk):  # 4 scrolls per message: the screen is mostly picture, the text barely changes
            def __init__(self, chat):
                super().__init__(chat)
                self.px = (len(chat) - 6) * 4

            def scroll(self, x, y, dy):
                self.x, self.y = x, y
                self.px = max(0, min((len(self.chat) - 6) * 4, self.px + (-1 if dy > 0 else 1)))
                self.pos = self.px // 4

            def snap(self):
                return {**super().snap(), "pane_fp": [["x", self.px]]}

        chat = _long_chat()
        desk = Images(chat)
        res = self.run_read(desk, days=3, max_steps=150)
        self.assertTrue(res["chats"][0]["stopped"].startswith("reached 3 days"), res["chats"][0]["stopped"])
        self.assertEqual(desk.pos, len(chat) - 6)

    def test_a_click_that_closes_the_open_chat_is_repeated(self):
        class Toggle(FakeDesk):  # the row was already open: the first click closes it, the second opens it
            def __init__(self, chat):
                super().__init__(chat)
                self.open = True

            def click(self, x, y):
                super().click(x, y)
                self.open = not self.open

            def snap(self):
                s = super().snap()
                if not self.open:
                    s["open_chat"] = {"title": "", "messages": []}
                return s

        desk = Toggle(_long_chat())
        res = self.run_read(desk, days=3)
        self.assertEqual((len(desk.clicks), res["chats"][0]["title"]), (2, "Mom"))
        self.assertTrue(res["chats"][0]["stopped"].startswith("reached"), res["chats"][0]["stopped"])

    def test_a_click_that_opened_another_chat_is_not_read(self):
        class Shifted(FakeDesk):  # the list reordered, so the click opened a different chat
            def snap(self):
                s = super().snap()
                s["open_chat"]["title"] = "Dad"
                return s

        desk = Shifted(_long_chat())
        res = self.run_read(desk, names=["Mom"], days=3)
        self.assertTrue(res["chats"][0]["stopped"].startswith("opened 'Dad' instead of 'Mom'"), res["chats"][0]["stopped"])
        self.assertEqual(res["chats"][0]["steps"], 0)

    def test_a_row_that_moved_before_the_click_is_found_again_and_clicked_once_more(self):
        class MovedOnce(FakeDesk):  # the first click lands on the neighbour, the second on the right row
            def click(self, x, y):
                super().click(x, y)
                self.opened = "Dad" if len(self.clicks) == 1 else "Mom"

            def snap(self):
                s = super().snap()
                s["open_chat"]["title"] = getattr(self, "opened", "Mom")
                return s

        desk = MovedOnce(_long_chat())
        res = self.run_read(desk, names=["Mom"], days=3)
        self.assertEqual((len(desk.clicks), len(res["chats"]), res["chats"][0]["title"]), (2, 1, "Mom"))
        self.assertTrue(res["chats"][0]["stopped"].startswith("reached"), res["chats"][0]["stopped"])

    def test_reads_the_chat_that_opened_even_when_the_list_name_is_garbled(self):
        res = self.run_read(FakeDesk(_long_chat(), list_name="日<"), days=3)
        self.assertEqual((res["chats"][0]["title"], res["chats"][0]["stopped"][:7]), ("Mom", "reached"))

    def test_the_same_chat_is_not_read_twice(self):
        desk = FakeDesk(_long_chat())
        reader = w.AutoReader(desk, desk.snap, 3, 5, 10)
        reader.done.add("Mom")
        again = reader.read_open_chat("Mom", desk.window())
        self.assertEqual((again["stopped"], again["messages"]), ("already read in this run", []))

    def test_saved_transcript_has_real_dates(self):
        self.run_read(FakeDesk(_long_chat()), days=3)
        saved = json.loads((self.data_dir / "chats" / "Mom.json").read_text(encoding="utf-8"))
        self.assertTrue(all(m["t"][:2] == "20" for m in saved))

    def test_does_not_start_while_the_user_is_active(self):
        desk = FakeDesk(_long_chat(), idle=5)
        res = self.run_read(desk)
        self.assertIn("needs 120 s", res["stopped"])
        self.assertEqual((desk.clicks, desk.moves), ([], []))

    def test_stops_and_leaves_the_pointer_when_the_user_types(self):
        desk = FakeDesk(_long_chat(), key_idle=1)
        res = self.run_read(desk)
        self.assertEqual(res["stopped"], "you came back")
        self.assertEqual((desk.clicks, desk.moves), ([], []))

    def test_screen_lock_blocks_everything(self):
        desk = FakeDesk(_long_chat())
        with mock.patch.object(w, "_screen_locked", return_value=True):
            res = w.auto_read(desk, snap=desk.snap)
        self.assertEqual((res["stopped"], desk.clicks), ("the screen is locked", []))


if __name__ == "__main__":
    unittest.main()
