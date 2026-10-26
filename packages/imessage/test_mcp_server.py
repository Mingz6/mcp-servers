"""Run: .venv/bin/python -m unittest test_mcp_server"""

import sqlite3
import unittest

from mcp_server import _detect_service

PHONE = "+16045550123"


def _db(chat_service: str, messages: list[tuple[str, int, int]]) -> sqlite3.Connection:
    """messages: (service, is_from_me, date)."""
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, service_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, service TEXT, is_from_me INTEGER, date INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        """
    )
    conn.execute("INSERT INTO chat VALUES (1, ?, ?)", (PHONE, chat_service))
    for i, (service, from_me, date) in enumerate(messages, start=1):
        conn.execute("INSERT INTO message VALUES (?, ?, ?, ?)", (i, service, from_me, date))
        conn.execute("INSERT INTO chat_message_join VALUES (1, ?)", (i,))
    return conn


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


if __name__ == "__main__":
    unittest.main()
