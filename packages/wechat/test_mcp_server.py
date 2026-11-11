"""Tests for MCP cache recovery using synthetic data and mocked database access."""

from __future__ import annotations

import hashlib
import os
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import TextContent

import mcp_server as server


SCREEN_READ_SMOKE_TARGET = "@@@---@@@"


class WeChatCacheTests(unittest.TestCase):
    def test_contacts_retry_after_a_failed_query(self) -> None:
        client = server.WeChat()
        rows = [{"username": "wxid_alice", "nick_name": "Alice"}]
        with mock.patch.object(client, "_query", side_effect=[RuntimeError("query failed"), rows]) as query:
            with self.assertRaisesRegex(RuntimeError, "query failed"):
                client.load_contacts()
            self.assertEqual(client.load_contacts()["wxid_alice"]["nickname"], "Alice")
            self.assertEqual(query.call_count, 2)

    def test_successful_empty_contacts_are_cached(self) -> None:
        client = server.WeChat()
        with mock.patch.object(client, "_query", return_value=[]) as query:
            self.assertEqual(client.load_contacts(), {})
            self.assertEqual(client.load_contacts(), {})
            query.assert_called_once()

    def test_name_mapping_retries_when_keys_are_missing(self) -> None:
        client = server.WeChat()
        with mock.patch.object(server, "_load_keys", side_effect=FileNotFoundError("no keys")) as load_keys:
            for _ in range(2):
                with self.assertRaisesRegex(FileNotFoundError, "no keys"):
                    client.load_name2id()
            self.assertEqual(load_keys.call_count, 2)

    def test_name_mapping_retries_after_a_failed_query(self) -> None:
        client = server.WeChat()
        client._keys = {"message/message_0.db": {"enc_key": "synthetic"}}
        rows = [{"user_name": "wxid_alice"}]
        table = f"Msg_{hashlib.md5(b'wxid_alice').hexdigest()}"
        with mock.patch.object(client, "_query", side_effect=[RuntimeError("query failed"), rows]) as query:
            with self.assertRaisesRegex(RuntimeError, "query failed"):
                client.load_name2id()
            self.assertEqual(client.load_name2id(), ({table: "wxid_alice"}, {"wxid_alice": table}))
            self.assertEqual(query.call_count, 2)


class KeylessFallbackTests(unittest.TestCase):
    def test_repeated_chat_queries_keep_using_screen_history(self) -> None:
        with (
            mock.patch.object(server, "wechat", server.WeChat()),
            mock.patch.object(server, "_load_keys", side_effect=FileNotFoundError("no keys")),
            mock.patch.object(server, "wechat_screen_history", return_value="Synthetic transcript") as history,
        ):
            for _ in range(2):
                self.assertEqual(server.wechat_query_chat("Alice"), server.KEYLESS_NOTE + "Synthetic transcript")
            self.assertEqual(history.call_count, 2)

    def test_repeated_activity_queries_keep_using_screen_capture(self) -> None:
        with (
            mock.patch.object(server, "wechat", server.WeChat()),
            mock.patch.object(server, "_load_keys", side_effect=FileNotFoundError("no keys")),
            mock.patch.object(server, "wechat_screen_snapshot", return_value="Synthetic snapshot") as snapshot,
        ):
            for _ in range(2):
                self.assertEqual(server.wechat_recent_activity(), server.KEYLESS_NOTE + "Synthetic snapshot")
            self.assertEqual(snapshot.call_count, 2)

    def test_search_limit_is_shared_by_previews_and_transcripts(self) -> None:
        rows = [
            {"seen_at": "2026-10-14T00:00:00", "chat": "Alice", "time": "00:00", "preview": "hello one"},
            {"seen_at": "2026-10-14T00:01:00", "chat": "Bob", "time": "00:01", "preview": "hello two"},
        ]
        transcripts = ["# Alice\n\nCaptured: synthetic\n[2026-10-14 00:02] Alice: hello three"]
        with (
            mock.patch.object(server.wechat, "search_all_messages", side_effect=FileNotFoundError("no keys")),
            mock.patch.object(server.wechat_ocr, "history", return_value=rows),
            mock.patch.object(server.wechat_ocr, "saved_chats", return_value=transcripts),
        ):
            for limit in (0, 1, 2, 3):
                with self.subTest(limit=limit):
                    result = server.wechat_search_messages("hello", limit=limit).removeprefix(server.KEYLESS_NOTE)
                    matches = [row for row in result.splitlines() if row.startswith("[")]
                    self.assertEqual(len(matches), min(limit, 3))

    def test_live_read_target_cannot_match_visible_chat_names(self) -> None:
        self.assertEqual(server.wechat_ocr._norm(SCREEN_READ_SMOKE_TARGET), "")
        rows = [{"chat": name} for name in ("Ken", "Chat", "2026", "@@@", "Alice")]
        self.assertEqual(server.wechat_ocr.pick_targets(rows, [SCREEN_READ_SMOKE_TARGET], 1), [])


@unittest.skipUnless(os.environ.get("WECHAT_MCP_SMOKE") == "1", "Set WECHAT_MCP_SMOKE=1 for live WeChat smoke tests")
class LiveMcpSmokeTests(unittest.IsolatedAsyncioTestCase):
    async def call_text(self, session: ClientSession, name: str, arguments: dict[str, object]) -> str:
        result = await session.call_tool(name, arguments=arguments)
        self.assertFalse(result.isError, f"{name} returned a tool error")
        return "\n".join(block.text for block in result.content if isinstance(block, TextContent))

    async def test_fresh_server_readonly_tools_and_repeated_fallbacks(self) -> None:
        started = datetime.now().replace(microsecond=0)
        parameters = StdioServerParameters(command=str(Path(__file__).resolve().with_name("run.sh")))
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=30)) as session:
                initialized = await session.initialize()
                self.assertEqual(initialized.serverInfo.name, "wechat")
                tools = await session.list_tools()
                required = {
                    "wechat_screen_snapshot", "wechat_screen_history", "wechat_screen_read",
                    "wechat_query_chat", "wechat_search_messages", "wechat_recent_activity",
                }
                self.assertTrue(required <= {tool.name for tool in tools.tools})

                fresh = await self.call_text(session, "wechat_screen_snapshot", {"refresh": True})
                self.assertTrue(fresh.startswith("# WeChat snapshot "), "Fresh screen capture failed")
                captured = fresh.splitlines()[0].removeprefix("# WeChat snapshot ").split(" (", 1)[0]
                self.assertGreaterEqual(datetime.fromisoformat(captured), started)
                cached = await self.call_text(session, "wechat_screen_snapshot", {"refresh": False})
                self.assertTrue(fresh.strip() == cached.strip(), "Cached capture differs from the fresh snapshot")

                history = await self.call_text(session, "wechat_screen_history", {"days": 1, "limit": 3})
                self.assertTrue(history.startswith("Chat-list changes, last 1 days:"))
                self.assertLessEqual(sum(row.startswith("[seen ") for row in history.splitlines()), 3)

                target = "__mcp_smoke_nonexistent_chat_20261014__"
                queries = [await self.call_text(session, "wechat_query_chat", {"contact": target}) for _ in range(2)]
                self.assertTrue(queries[0] == queries[1], "Repeated chat queries changed after a failed database read")
                for _ in range(2):
                    activity = await self.call_text(session, "wechat_recent_activity", {"days": 1, "limit": 3})
                    self.assertFalse("Screen capture failed:" in activity, "Activity screenshot fallback failed")

                await self.call_text(session, "wechat_search_messages", {"query": target, "limit": 1})
                reading = await self.call_text(session, "wechat_screen_read", {"chats": SCREEN_READ_SMOKE_TARGET, "top": 1, "days": 1})
                self.assertTrue(reading.startswith("[stopped: "), "The synthetic target unexpectedly opened a chat")
                self.assertTrue(any(reason in reading for reason in (
                    "no matching chats", "you used the computer", "the screen is locked", "you came back",
                )), "Screen reader did not stop for an expected safety condition")


if __name__ == "__main__":
    unittest.main()