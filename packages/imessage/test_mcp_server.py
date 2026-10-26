"""Run: .venv/bin/python -m unittest test_mcp_server"""

import os
import sqlite3
import tempfile
import time
import unittest
from unittest import mock

import mcp_server
from mcp_server import _apple_ns, _detect_service, messages_send

PHONE = "+16045550123"


def _db(chat_service: str, messages: list[tuple]) -> sqlite3.Connection:
    """messages: (service, is_from_me, date[, error, is_sent])."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    _schema(conn, chat_service, messages)
    return conn


def _schema(conn: sqlite3.Connection, chat_service: str | None, messages: list[tuple]) -> None:
    conn.executescript(
        """
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, service_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, service TEXT, is_from_me INTEGER, date INTEGER,
                              error INTEGER DEFAULT 0, is_sent INTEGER DEFAULT 1, is_delivered INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        """
    )
    if chat_service is not None:
        conn.execute("INSERT INTO chat VALUES (1, ?, ?)", (PHONE, chat_service))
    for m in messages:
        _add(conn, *m)
    conn.commit()


def _add(conn, service, from_me, date, error=0, is_sent=1) -> None:
    if conn.execute("SELECT 1 FROM chat WHERE ROWID = 1").fetchone() is None:
        conn.execute("INSERT INTO chat VALUES (1, ?, ?)", (PHONE, service))
    cur = conn.execute(
        "INSERT INTO message (service, is_from_me, date, error, is_sent) VALUES (?, ?, ?, ?, ?)",
        (service, from_me, date, error, is_sent),
    )
    conn.execute("INSERT INTO chat_message_join VALUES (1, ?)", (cur.lastrowid,))
    conn.commit()


class DetectServiceTest(unittest.TestCase):
    def test_rcs_labelled_chat_with_imessage_contact_stays_imessage(self):
        conn = _db("RCS", [("iMessage", 0, 1), ("iMessage", 1, 2)])
        self.assertEqual(_detect_service(conn, PHONE), "iMessage")

    def test_our_own_sms_fallback_does_not_flip_an_imessage_contact(self):
        conn = _db("RCS", [("iMessage", 0, 1), ("SMS", 1, 2), ("SMS", 1, 3)])
        self.assertEqual(_detect_service(conn, PHONE), "iMessage")

    def test_contact_on_rcs_or_sms_gets_sms(self):
        self.assertEqual(_detect_service(_db("iMessage", [("RCS", 0, 1)]), PHONE), "SMS")
        self.assertEqual(_detect_service(_db("SMS", [("SMS", 0, 1)]), PHONE), "SMS")

    def test_no_incoming_falls_back_to_latest_outgoing(self):
        conn = _db("iMessage", [("iMessage", 1, 1), ("SMS", 1, 2)])
        self.assertEqual(_detect_service(conn, PHONE), "SMS")

    def test_no_messages_falls_back_to_chat_label(self):
        self.assertEqual(_detect_service(_db("SMS", []), PHONE), "SMS")
        self.assertEqual(_detect_service(_db("iMessage", []), PHONE), "iMessage")

    def test_unknown_number_defaults_to_imessage(self):
        conn = _db("SMS", [("SMS", 0, 1)])
        self.assertEqual(_detect_service(conn, "+17785550199"), "iMessage")


class SendFallbackTest(unittest.TestCase):
    """messages_send against a chat.db file; the AppleScript send is faked and writes the row Messages would."""

    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        self.addCleanup(os.remove, self.path)
        self.calls: list[str] = []
        for patch in (
            mock.patch.object(mcp_server, "CHAT_DB", self.path),
            mock.patch.object(mcp_server, "IMESSAGE_CONFIRM_SECONDS", 0.2),
            mock.patch.object(mcp_server, "POLL_SECONDS", 0.01),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def _history(self, chat_service, messages=()):
        conn = sqlite3.connect(self.path)
        _schema(conn, chat_service, list(messages))
        conn.close()

    def _send(self, outcomes: dict[str, list[tuple]], service="auto", osascript_fails=()):
        """outcomes: service -> rows (service, error, is_sent) Messages writes when we send with it."""

        def fake(phone, text, svc):
            self.calls.append(svc)
            if svc in osascript_fails:
                return f"FAILED ({svc}): boom"
            conn = sqlite3.connect(self.path)
            for row_service, error, is_sent in outcomes.get(svc, []):
                _add(conn, row_service, 1, _apple_ns(time.time()), error, is_sent)
            conn.close()
            return f"Sent via {svc} to {PHONE}"

        with mock.patch.object(mcp_server, "_send_applescript", fake):
            return messages_send(PHONE, "hello", service)

    def test_new_contact_apple_refuses_imessage_resends_as_sms(self):
        self._history(None)
        result = self._send({"iMessage": [("iMessage", 22, 0)], "SMS": [("SMS", 0, 1)]})
        self.assertEqual(self.calls, ["iMessage", "SMS"])
        self.assertTrue(result.startswith("Sent via SMS"), result)
        self.assertIn("iMessage not available", result)

    def test_imessage_that_went_out_is_not_resent(self):
        self._history("iMessage", [("iMessage", 0, 1)])
        result = self._send({"iMessage": [("iMessage", 0, 1)]})
        self.assertEqual(self.calls, ["iMessage"])
        self.assertEqual(result, f"Sent via iMessage to {PHONE}")

    def test_iphone_already_sent_it_as_text_so_no_second_copy(self):
        self._history(None)
        result = self._send({"iMessage": [("iMessage", 22, 0), ("SMS", 0, 1)]})
        self.assertEqual(self.calls, ["iMessage"])
        self.assertIn("the iPhone sent it as text", result)

    def test_explicit_imessage_refused_is_reported_not_rerouted(self):
        self._history(None)
        result = self._send({"iMessage": [("iMessage", 22, 0)]}, service="imessage")
        self.assertEqual(self.calls, ["iMessage"])
        self.assertTrue(result.startswith("FAILED (iMessage)"), result)

    def test_unconfirmed_imessage_is_flagged_and_not_resent(self):
        self._history("iMessage", [("iMessage", 0, 1)])
        result = self._send({"iMessage": [("iMessage", 0, 0)]})
        self.assertEqual(self.calls, ["iMessage"])
        self.assertTrue(result.startswith("Sent via iMessage"), result)
        self.assertIn("not confirmed", result)

    def test_sms_contact_goes_straight_to_sms(self):
        self._history("SMS", [("SMS", 0, 1)])
        self._send({"SMS": [("SMS", 0, 1)]})
        self.assertEqual(self.calls, ["SMS"])

    def test_osascript_failure_on_imessage_tries_sms(self):
        self._history(None)
        result = self._send({"SMS": [("SMS", 0, 1)]}, osascript_fails={"iMessage"})
        self.assertEqual(self.calls, ["iMessage", "SMS"])
        self.assertTrue(result.startswith("Sent via SMS"), result)


if __name__ == "__main__":
    unittest.main()
