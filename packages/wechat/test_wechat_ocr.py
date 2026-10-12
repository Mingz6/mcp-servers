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


def public(msgs):
    return [w._public(m) for m in msgs]


class OpenChatTests(unittest.TestCase):
    def test_title_and_messages(self):
        chat = open_chat()
        self.assertEqual(chat["title"], "群聊(3)")
        self.assertEqual((chat["messages"][0]["y"], chat["messages"][0]["y2"]), (255, 320))  # label to last line
        self.assertEqual(public(chat["messages"]), [
            {"t": "07:30", "side": "in", "sender": "Bob", "text": "你好\n再见"},
            {"t": "07:30", "side": "in", "sender": "Carol", "text": "[non-text message]"},
            {"t": "07:30", "side": "out", "sender": "me", "text": "收到"},
            {"t": "07:30", "side": "system", "sender": "", "text": '"Eve" joined'},
        ])

    def test_trailing_sticker_label_is_kept(self):
        chat = w.parse_open_chat([line("Carol", 315, 378, 41, 12)], [], 1.0, 1280, 1440)
        self.assertEqual(public(chat["messages"]), [{"t": "", "side": "in", "sender": "Carol", "text": "[non-text message]"}])

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
        self.assertEqual(public(chat["messages"]), [{"t": "", "side": "in", "sender": "Mom", "text": "hi there"}])

    def test_a_misread_stamp_is_a_stamp_not_a_message(self):
        misread = line("Saturdav 09.21|", 720, 139, 90, 12)
        pane = [line("Mom", 261, 18, 40, 19), misread, line("see you then", 326, 184, 80, 17)]
        chat = w.parse_open_chat(pane, [misread], 1.0, 1280, 1440)
        self.assertEqual(public(chat["messages"]), [{"t": "Saturdav 09:21", "side": "in", "sender": "Mom", "text": "see you then"}])

    def test_title_bar_icons_are_not_a_title(self):
        pane = [line("日<", 1671, 18, 34, 15), line("hi there", 326, 284, 60, 17)]
        self.assertEqual(w.parse_open_chat(pane, [], 1.0, 1800, 1131)["title"], "")

    def test_a_title_the_full_pass_drops_is_read_from_a_crop(self):
        body = [line(f"message line {i}", 652, 200 + 40 * i, 240, 34) for i in range(6)]  # 2x pixels
        calls = []

        def run(cmd, timeout=120):
            calls.append(cmd)
            if cmd[1] == "window":
                return json.dumps({"id": 7, "x": 0, "y": 38, "w": 900, "h": 600, "onscreen": True})
            if cmd[0] == "screencapture":  # just the PNG header: width 1800, height 1200
                Path(cmd[-1]).write_bytes(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR" + (1800).to_bytes(4, "big") + (1200).to_bytes(4, "big"))
                return ""
            if "--crop" not in cmd:
                return json.dumps({"w": 1800, "h": 1200, "lines": [line("日<", 3343, 36, 68, 31)] + body, "reds": []})
            crop = cmd[cmd.index("--crop") + 1]
            title = [line("小鹿大大美女fC1909", 520, 36, 439, 41)] if crop.split(",")[1] == "0" else []
            return json.dumps({"w": 1800, "h": 1200, "lines": title, "reds": []})

        with mock.patch.object(w, "_helper", return_value="wxvision"), mock.patch.object(w, "_run", side_effect=run):
            win, ocr, _, stamps = w.read_window(chat_only=True)
        chat = w.parse_open_chat(ocr["lines"], stamps, 2.0, 1800, 1200)
        self.assertEqual(chat["title"], "小鹿大大美女fC1909")
        self.assertEqual(len(chat["messages"]), 1)
        full = next(c for c in calls if c[1] == "ocr" and "--crop" not in c)
        self.assertEqual(full[full.index("--rows") + 1], "580,1760")  # the chat pane, scroll bar left out

    def test_text_on_a_sticker_or_cover_is_marked_as_image_and_keeps_the_sender(self):
        paper, bubble, window = [28, 28, 28], [46, 46, 47], [30, 30, 31]
        lines = [
            line("群聊(3)", 261, 18, 196, 19),
            {**line("Carol", 315, 200, 41, 12), "bgc": [window, window]},
            {**line("咬牙切齿", 340, 230, 60, 17), "bgc": [[232, 232, 232], [246, 224, 196]]},  # sticker caption
            {**line("Bob", 315, 400, 41, 12), "bgc": [window, window]},
            {**line("see you at six", 340, 430, 90, 17), "bgc": [bubble, [232, 200, 50]]},  # emoji on one side
            {**line("on my way", 1150, 500, 60, 17), "bgc": [[52, 192, 130], [52, 192, 130]]},  # my green bubble
        ]
        chat = w.parse_open_chat(lines, [], 1.0, 1280, 1440, paper)
        self.assertEqual([(m["sender"], m["text"]) for m in chat["messages"]], [
            ("Carol", "[image] 咬牙切齿"), ("Bob", "see you at six"), ("me", "on my way")])
        self.assertFalse(w.on_image(lines[2], None, 1.0))  # an old recording has no paper colour: nothing is marked
        self.assertFalse(w._solid({"text": "[image] 好"}))  # the prefix does not make a short caption an anchor

    def test_text_read_off_my_avatar_is_not_part_of_my_message(self):
        pane = [line("Mom", 261, 18, 40, 19), line("on my way", 1640, 300, 70, 17), line("品", 1734, 298, 39, 30)]
        chat = w.parse_open_chat(pane, [], 1.0, 1800, 1131)
        self.assertEqual(public(chat["messages"]), [{"t": "", "side": "out", "sender": "me", "text": "on my way"}])
        with mock.patch.object(w, "AVATAR_W", 0):  # without the avatar column the glyph lands in the message
            self.assertIn("品", w.parse_open_chat(pane, [], 1.0, 1800, 1131)["messages"][0]["text"])

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

    def test_the_sticker_placeholder_is_not_proof_of_overlap(self):
        sticker = msg(w.NON_TEXT)
        self.assertIsNone(w.merge_transcripts([C, D, sticker], [sticker, A, B]))

    def test_an_older_screen_never_lands_after_the_newest_message(self):
        repeat = dict(D)  # the same text sent twice, days apart
        self.assertEqual(self.texts(w.merge_transcripts([B, C, D], [repeat, A])), list("bcda"))  # direction unknown
        self.assertEqual(self.texts(w.merge_transcripts([B, C, D], [repeat, A], toward_older=True)), list("bcd"))
        self.assertEqual(self.texts(w.merge_transcripts([C, D, E], [A, B, C], toward_older=True)), list("abcde"))

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


def screen_rows(top, height=900, blank_every=5):
    """Row hashes of a pane showing a long virtual chat from content row `top` down; title and input box blank."""
    rows = [0] * height
    for r in range(w.BODY_TOP, height - w.INPUT_H):
        g = top + r
        rows[r] = 0 if g % blank_every == 0 else (7 if g % 11 == 0 else 10_000 + g)  # 7: bubble padding, repeats
    return rows


class ScrollShiftTests(unittest.TestCase):
    def test_rows_measure_the_scroll(self):
        self.assertEqual(w.pane_shift(screen_rows(500), screen_rows(380), 1.0), 120)  # moved down: older
        self.assertEqual(w.pane_shift(screen_rows(380), screen_rows(500), 1.0), -120)
        self.assertEqual(w.pane_shift(screen_rows(500), screen_rows(500), 1.0), 0)
        self.assertIsNone(w.pane_shift(screen_rows(500), screen_rows(5000), 1.0))  # a whole screen apart
        self.assertIsNone(w.pane_shift(screen_rows(500), screen_rows(500, height=800), 1.0))  # window resized
        self.assertIsNone(w.pane_shift(None, screen_rows(500), 1.0))  # an old recording without rows

    def test_a_message_cut_off_at_the_top_is_replaced_by_its_whole_self(self):
        first = [{**msg("after lunch"), "sender": "", "y": 85, "y2": 110},  # its first lines and label were above
                 {**D, "y": 200, "y2": 230}]
        acc = w._placed(first, 0)
        second = [{**B, "y": 90, "y2": 120}, {**C, "y": 150, "y2": 210}, {**D, "y": 300, "y2": 330}]
        merged = w.shift_merge(acc, w._placed(second, 100))
        self.assertEqual([(m["sender"], m["text"]) for m in merged],
                         [("Mom", B["text"]), ("Mom", C["text"]), ("Mom", D["text"])])

    def test_pieces_of_one_cover_are_replaced_by_its_whole_read(self):
        pieces = [{**msg(t), "sender": "", "y": y, "y2": y + 30}
                  for t, y in (("[image] age 29", 10), ("[image] worth 30 billion", 60), ("wears clogs", 110))]
        acc = w._placed(pieces + [{**D, "y": 300, "y2": 330}], 0)
        whole = {**msg("[image] super product / age 29 / worth 30 billion / wears clogs"), "y": 200, "y2": 360}
        merged = w.shift_merge(acc, w._placed([whole, {**D, "y": 500, "y2": 530}], 200))
        self.assertEqual([(m["sender"], m["text"]) for m in merged], [("Mom", whole["text"]), ("Mom", D["text"])])
        short = {**msg("[image] age 29 / worth"), "y": 200, "y2": 300}  # a partial read spanning two pieces keeps both
        self.assertEqual(len(w.shift_merge(acc, w._placed([short], 200))), 4)

    def test_a_screen_of_stickers_lines_up_by_its_rows(self):
        acc = w._placed([{**C, "y": 400, "y2": 440}, {**D, "y": 500, "y2": 540}], 0)
        stickers = [{**msg(w.NON_TEXT), "y": y, "y2": y + 20} for y in (150, 250, 350)]
        shot = {"open_chat": {"title": "Mom", "messages": stickers + [{**C, "y": 520, "y2": 560}]},
                "rows": screen_rows(380), "scale": 1.0}
        merged, off, d = w.merge_screen(acc, 0, screen_rows(500), shot, toward_older=True)
        self.assertEqual((off, d), (120, 120))
        self.assertEqual([m["text"] for m in merged], [w.NON_TEXT] * 3 + [C["text"], D["text"]])
        no_rows = {**shot, "open_chat": {"title": "Mom", "messages": stickers}, "rows": None}
        self.assertEqual(w.merge_screen(acc, 0, screen_rows(500), no_rows, toward_older=True), (None, 0, None))


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

    def test_misread_stamps_are_repaired(self):
        cases = {
            "Saturdav 09.21|": "Saturdav 09:21",
            "Yesterday 21:A7": "Yesterday 21:47",
            "10/5 12・00": "10/5 12:00",
            "好的": "好的",
            "OK.SO": "OK.SO",  # too few digits to be a time
        }
        for raw, want in cases.items():
            self.assertEqual(w.clean_stamp(raw), want, raw)
        self.assertEqual(w.absolute_stamp(w.clean_stamp("Saturdav 09.21|"), self.NOW), "2026-10-10 09:21")
        self.assertTrue(w.is_stamp("Saturdav 09.21|"))
        self.assertFalse(w.is_stamp("see you at 9"))

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

    def test_a_window_on_another_desktop_is_brought_over(self):
        class Away(FakeDesk):
            raised = False

            def window(self):
                return {**super().window(), "onscreen": self.raised}

            def raise_window(self):
                self.raised = True

        res = self.run_read(Away(_long_chat()), days=3)
        self.assertTrue(res["chats"] and res["chats"][0]["stopped"].startswith("reached"), res["stopped"])

    def test_scroll_steps_read_the_open_chat_only(self):
        desk = FakeDesk(_long_chat())
        calls = {"full": 0, "chat": 0}

        def counted(kind):
            def snap():
                calls[kind] += 1
                return desk.snap()
            return snap

        clock = mock.Mock(monotonic=mock.Mock(return_value=0), sleep=mock.Mock())
        with mock.patch.object(w, "time", clock), mock.patch.object(w, "_screen_locked", return_value=False):
            res = w.auto_read(desk, snap=counted("full"), chat_snap=counted("chat"), days=3)
        self.assertTrue(res["chats"][0]["stopped"].startswith("reached"))
        self.assertEqual(calls["full"], 1)  # the chat list is read once, to find the row
        self.assertGreater(calls["chat"], 5)

    def test_a_run_of_stickers_does_not_stop_the_read_when_rows_measure_the_scroll(self):
        class Measured(FakeDesk):  # every message 100 px tall; the pane's pixel rows follow the scroll
            def snap(self):
                s = super().snap()
                for i, m in enumerate(s["open_chat"]["messages"]):
                    m.update(y=w.BODY_TOP + 100 * i + 10, y2=w.BODY_TOP + 100 * i + 70)
                return {**s, "rows": screen_rows(self.pos * 100, height=1131), "scale": 1.0}

        chat = _long_chat()
        for m in chat[18:30]:  # more stickers in a row than one screen holds
            m["text"] = w.NON_TEXT
        res = self.run_read(Measured(chat), days=3)
        mom = res["chats"][0]
        self.assertTrue(mom["stopped"].startswith("reached 3 days"), mom["stopped"])
        texts = [m["text"] for m in mom["messages"]]
        self.assertEqual(texts, [c["text"] for c in chat][-len(texts):])  # contiguous, each sticker once
        self.assertNotIn("y", mom["messages"][0])  # positions stay internal
        self.data_dir.joinpath("chats", "Mom.json").unlink()
        blind = self.run_read(FakeDesk(chat), days=3)["chats"][0]  # text alone loses its place in the stickers
        self.assertFalse(blind["stopped"].startswith("reached"), blind["stopped"])


def stamped(text, t, sender="Mom", side="in"):
    return {"t": t, "side": side, "sender": sender if side == "in" else ("me" if side == "out" else ""), "text": text}


class TidyTests(DataDirCase):
    def test_a_block_merged_at_the_wrong_spot_goes_back_in_time_order(self):
        msgs = [
            stamped("photos from the open house", "2026-10-10 08:08"),
            stamped("what did the agent say", "2026-10-11 20:37"),
            stamped("I will look it up online", "2026-10-11 22:03", side="out"),
            stamped("ok got it thanks", "2026-10-10 09:21", side="out"),  # an older screen stitched in at the end
            stamped("done yet? send it tomorrow", "2026-10-12 01:31"),
            stamped("the bank can do it next week", "2026-10-11 20:43"),
        ]
        w._write_chat("Mom", msgs, "2026-10-12T10:00:00")
        saved = json.loads((self.data_dir / "chats" / "Mom.json").read_text(encoding="utf-8"))
        self.assertEqual([m["t"][-5:] for m in saved], ["08:08", "09:21", "20:37", "20:43", "22:03", "01:31"])

    def test_one_spelling_for_the_other_person_in_a_one_to_one_chat(self):
        msgs = [stamped(f"message number {i}", "2026-10-11 08:00", sender=s)
                for i, s in enumerate(["小鹿。", "小鹿◎", "小鹿啄", "小鹿い", "小鹿。"])]
        w._write_chat("小鹿®", msgs, "2026-10-12T10:00:00")
        saved = json.loads((self.data_dir / "chats" / "小鹿.json").read_text(encoding="utf-8"))
        self.assertEqual({m["sender"] for m in saved}, {"小鹿"})

    def test_group_senders_collapse_but_different_people_stay_apart(self):
        senders = ["Bobby", "Bobbyy", "Lena", "Lina", "山间小路一abc区", "山间小路一abc区", "山间小路—abc区", "山间小路-"]
        names = w.canonical_senders(senders, "周末徒步群（12）")
        self.assertEqual(names["Bobbyy"], "Bobby")
        self.assertEqual((names["Lena"], names["Lina"]), ("Lena", "Lina"))
        self.assertEqual({names[s] for s in senders[4:]}, {"山间小路一abc区"})

    def test_stamp_lines_and_a_message_read_twice_are_dropped_and_gaps_keep_their_place(self):
        msgs = [
            stamped("are you coming tomorrow?", "2026-10-11 21:24", sender="Bobby"),
            stamped("are you c0ming tomorrow?", "2026-10-11 21:24", sender="Bobbyy"),
            stamped("Saturdav 09.21|", "2026-10-11 21:24", side="system"),
            stamped("top of a screen, no stamp in view", "", sender="Lena"),
            stamped("later that night", "2026-10-11 21:40", sender="Lena"),
        ]
        out = w.tidy(msgs, "周末徒步群（12）")
        self.assertEqual([(m["sender"], m["text"][:8], m["t"][-5:]) for m in out], [
            ("Bobby", "are you ", "21:24"),
            ("Lena", "top of a", "21:24"),
            ("Lena", "later th", "21:40"),
        ])

    def test_retidy_rewrites_saved_transcripts(self):
        chats = self.data_dir / "chats"
        chats.mkdir(parents=True)
        bad = [stamped("second message here", "2026-10-11 09:00"), stamped("first message here", "2026-10-11 08:00")]
        (chats / "Mom.json").write_text(json.dumps(bad), encoding="utf-8")
        (chats / "Mom.md").write_text("# Mom\n_captured 2026-10-11T10:00:00, screenshot OCR_\n", encoding="utf-8")
        self.assertEqual(w.retidy_saved(), ["Mom"])
        md = (chats / "Mom.md").read_text(encoding="utf-8").split("\n")
        self.assertTrue(md[3].endswith("first message here") and md[4].endswith("second message here"), md)


def raw_frame(lines, captured_at="2026-10-12T10:00:00"):
    pane = [line("Mom", 261, 18, 40, 19)] + [line(t, 326, 200 + 100 * i, 200, 17) for i, t in enumerate(lines)]
    return {"captured_at": captured_at, "win": {"x": 0, "y": 0, "w": 1280, "h": 1440, "id": 1},
            "ocr": {"w": 1280, "h": 1440, "lines": pane, "reds": []}, "side": [],
            "stamps": [line("Yesterday 08:00", 720, 150, 90, 12)]}


class ReplayTests(DataDirCase):
    def test_replay_merges_recorded_screens_without_capturing(self):
        frames = self.data_dir / "frames" / "run"
        frames.mkdir(parents=True)
        screens = [[C["text"], D["text"]], [A["text"], B["text"], C["text"]]]  # the second scrolled up
        for i, texts in enumerate(screens):
            (frames / f"{i:04d}.json").write_text(json.dumps(raw_frame(texts)), encoding="utf-8")
        with mock.patch.object(w, "_run", side_effect=AssertionError("replay must not capture")):
            chats = w.replay(frames)
        self.assertEqual([(c["title"], c["frames"], c["skipped"]) for c in chats], [("Mom", 2, 0)])
        self.assertEqual([m["text"] for m in chats[0]["messages"]], [A["text"], B["text"], C["text"], D["text"]])
        self.assertEqual(chats[0]["messages"][0]["t"], "2026-10-11 08:00")


if __name__ == "__main__":
    unittest.main()
