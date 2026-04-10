#!/usr/bin/env python3
"""WeChat MCP Server — query chats, search messages, list contacts.

Reads encrypted WeChat SQLCipher databases using cached keys.
Read-only — sending is not supported (see README.md for why).

Usage:
  # Start via MCP config (see README.md)
  # Or run directly for testing:
  .venv/bin/python mcp_server.py
"""

import csv
import hashlib
import io
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import zstandard as zstd

from mcp.server.fastmcp import FastMCP

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SQLCIPHER = os.environ.get("SQLCIPHER_PATH", "/opt/homebrew/bin/sqlcipher")
WECHAT_DATA = os.path.expanduser(
    "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
)
KEYS_SEARCH_PATHS = [
    "/tmp/wechat_keys.json",  # fresh extraction
    os.path.expanduser(
        "~/.wechat-export/.keys.json"
    ),  # persisted backup
]

MSG_TYPES = {
    "1": "text",
    "3": "image",
    "34": "voice",
    "42": "card",
    "43": "video",
    "47": "sticker",
    "48": "location",
    "49": "link/file",
    "50": "call",
    "10000": "system",
    "10002": "recall",
}

logger = logging.getLogger("wechat-mcp")

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "wechat",
    instructions="Query and interact with WeChat messages on macOS",
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _find_db_storage() -> str:
    """Locate the db_storage directory for the active WeChat account."""
    pattern = Path(WECHAT_DATA)
    if not pattern.exists():
        raise FileNotFoundError(f"WeChat data not found at {WECHAT_DATA}")
    dirs = sorted(pattern.glob("*/db_storage"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not dirs:
        raise FileNotFoundError("No db_storage found under WeChat data directory")
    return str(dirs[0])


def _load_keys() -> dict:
    """Load encryption keys from the first available keys file."""
    for path in KEYS_SEARCH_PATHS:
        if os.path.exists(path):
            with open(path) as f:
                keys = json.load(f)
            if keys:
                logger.info(f"Loaded {len(keys)} keys from {path}")
                return keys
    raise FileNotFoundError(
        "No keys file found. Run extract_key.py first:\n"
        "  sudo python3 ~/code/brain/scripts/wechat/extract_key.py"
    )


def _sqlcipher_query(db_path: str, key: str, sql: str) -> list[dict]:
    """Run a query against an encrypted SQLCipher database."""
    commands = (
        f"PRAGMA key = \"x'{key}'\";\n"
        "PRAGMA cipher_compatibility = 4;\n"
        "PRAGMA cipher_page_size = 4096;\n"
        ".headers on\n.mode csv\n"
        f"{sql}\n"
    )
    result = subprocess.run(
        [SQLCIPHER, db_path],
        input=commands.encode(),
        capture_output=True,
        timeout=30,
    )
    text = result.stdout.decode("utf-8", errors="replace").strip()
    if not text:
        return []
    lines = text.split("\n")
    # Skip the "ok" lines from PRAGMA statements
    while lines and lines[0].strip() == "ok":
        lines.pop(0)
    if len(lines) < 2:
        return []
    return list(csv.DictReader(io.StringIO("\n".join(lines))))


_zstd_dctx = zstd.ZstdDecompressor()


def _decode_content(hex_content: str, ct: str) -> str:
    """Decode message_content from hex, decompressing zstd (CT=4) if needed."""
    if not hex_content:
        return ""
    try:
        raw = bytes.fromhex(hex_content)
    except ValueError:
        return hex_content
    if ct == "4":
        try:
            raw = _zstd_dctx.decompress(raw)
        except Exception:
            pass
    return raw.decode("utf-8", errors="replace")


class WeChat:
    """Cached state for WeChat database access."""

    def __init__(self):
        self._db_dir: Optional[str] = None
        self._keys: Optional[dict] = None
        self._contacts: Optional[dict] = None
        self._name2id: Optional[dict] = None
        self._id2name: Optional[dict] = None

    @property
    def db_dir(self) -> str:
        if self._db_dir is None:
            self._db_dir = _find_db_storage()
        return self._db_dir

    @property
    def keys(self) -> dict:
        if self._keys is None:
            self._keys = _load_keys()
        return self._keys

    def _query(self, db_rel_path: str, sql: str) -> list[dict]:
        entry = self.keys.get(db_rel_path)
        if not entry:
            return []
        db_path = os.path.join(self.db_dir, db_rel_path)
        if not os.path.exists(db_path):
            return []
        return _sqlcipher_query(db_path, entry["enc_key"], sql)

    def load_contacts(self) -> dict[str, dict]:
        """Load and cache contacts. Returns {wxid: {nickname, remark}}."""
        if self._contacts is not None:
            return self._contacts
        self._contacts = {}
        rows = self._query("contact/contact.db", "SELECT * FROM contact;")
        for c in rows:
            wxid = c.get("username", "")
            if wxid:
                self._contacts[wxid] = {
                    "nickname": c.get("nick_name", ""),
                    "remark": c.get("remark", ""),
                    "alias": c.get("alias", ""),
                }
        logger.info(f"Loaded {len(self._contacts)} contacts")
        return self._contacts

    def load_name2id(self) -> tuple[dict, dict]:
        """Load Name2Id mapping from message_0.db. Returns (table→wxid, wxid→table)."""
        if self._name2id is not None:
            return self._name2id, self._id2name
        self._name2id = {}
        self._id2name = {}
        rows = self._query(
            "message/message_0.db",
            "SELECT user_name FROM Name2Id;",
        )
        for r in rows:
            un = r.get("user_name", "")
            if un:
                table = f"Msg_{hashlib.md5(un.encode()).hexdigest()}"
                self._name2id[table] = un
                self._id2name[un] = table
        logger.info(f"Name2Id: {len(self._name2id)} mappings")
        return self._name2id, self._id2name

    def resolve_contact(self, query: str) -> list[dict]:
        """Find contacts matching a query (nickname, remark, wxid, alias)."""
        contacts = self.load_contacts()
        q = query.lower()
        results = []
        for wxid, info in contacts.items():
            searchable = [
                wxid.lower(),
                info.get("nickname", "").lower(),
                info.get("remark", "").lower(),
                info.get("alias", "").lower(),
            ]
            if any(q in s for s in searchable if s):
                results.append({"wxid": wxid, **info})
        return results

    def get_display_name(self, wxid: str) -> str:
        """Get the best display name for a contact."""
        contacts = self.load_contacts()
        info = contacts.get(wxid, {})
        return info.get("remark") or info.get("nickname") or wxid

    def find_chat_db(self, wxid: str) -> Optional[tuple[str, str]]:
        """Find which message DB and table holds this contact's chat.
        Returns (db_rel_path, table_name) or None.
        """
        _, id2name = self.load_name2id()
        table = id2name.get(wxid)
        if not table:
            # Fallback: compute MD5 hash of wxid directly
            table = f"Msg_{hashlib.md5(wxid.encode()).hexdigest()}"
        # Table could be in any message_N.db — check each
        for i in range(11):
            db_rel = f"message/message_{i}.db"
            entry = self.keys.get(db_rel)
            if not entry:
                continue
            tables = self._query(
                db_rel,
                f"SELECT name FROM sqlite_master WHERE type='table' AND name='{table}';",
            )
            if tables:
                return db_rel, table
        return None

    def query_messages(
        self,
        wxid: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        limit: int = 50,
        text_only: bool = False,
    ) -> list[dict]:
        """Query messages for a specific contact/group."""
        result = self.find_chat_db(wxid)
        if not result:
            return []
        db_rel, table = result

        where_parts = []
        if start_date:
            ts = int(datetime.strptime(start_date, "%Y-%m-%d").timestamp())
            where_parts.append(f"create_time >= {ts}")
        if end_date:
            ts = int(
                (datetime.strptime(end_date, "%Y-%m-%d") + timedelta(days=1)).timestamp()
            )
            where_parts.append(f"create_time < {ts}")
        if text_only:
            where_parts.append("(local_type & 0xFFFF) = 1")

        where = f" WHERE {' AND '.join(where_parts)}" if where_parts else ""

        sql = (
            f"SELECT local_id, create_time, local_type, real_sender_id, status, "
            f"hex(message_content) as hex_content, WCDB_CT_message_content as ct "
            f"FROM {table}{where} ORDER BY create_time DESC LIMIT {limit};"
        )
        rows = self._query(db_rel, sql)
        messages = []
        for row in rows:
            raw_type = row.get("local_type", "")
            try:
                type_key = str(int(raw_type) & 0xFFFF) if raw_type else ""
            except (ValueError, TypeError):
                type_key = raw_type
            messages.append({
                "time": _format_time(row.get("create_time", "0")),
                "type": MSG_TYPES.get(type_key, f"other({type_key})"),
                "sender": row.get("real_sender_id", ""),
                "is_sent": str(row.get("status", "")) == "2",
                "content": _decode_content(row.get("hex_content", ""), row.get("ct", "0")),
            })
        messages.reverse()  # chronological order
        return messages

    def search_all_messages(self, query: str, limit: int = 30) -> list[dict]:
        """Search across ALL message databases for text content matching query."""
        name2id, _ = self.load_name2id()
        results = []

        for i in range(11):
            if len(results) >= limit:
                break
            db_rel = f"message/message_{i}.db"
            entry = self.keys.get(db_rel)
            if not entry:
                continue

            # Get all Msg_ tables in this DB
            tables = self._query(
                db_rel,
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';",
            )

            for t in tables:
                if len(results) >= limit:
                    break
                table = t.get("name", "")
                if not table.startswith("Msg_"):
                    continue
                wxid = name2id.get(table, table)
                # Use LIKE for case-insensitive search on plaintext (CT=0) messages
                safe_query = query.replace("'", "''")
                # Search plaintext messages
                rows = self._query(
                    db_rel,
                    f"SELECT create_time, local_type, real_sender_id, "
                    f"hex(message_content) as hex_content, WCDB_CT_message_content as ct "
                    f"FROM {table} WHERE WCDB_CT_message_content=0 "
                    f"AND message_content LIKE '%{safe_query}%' "
                    f"ORDER BY create_time DESC LIMIT {limit - len(results)};",
                )
                # Also decompress CT=4 messages and search in Python
                ct4_rows = self._query(
                    db_rel,
                    f"SELECT create_time, local_type, real_sender_id, "
                    f"hex(message_content) as hex_content, WCDB_CT_message_content as ct "
                    f"FROM {table} WHERE WCDB_CT_message_content=4 "
                    f"ORDER BY create_time DESC;",
                )
                for row in ct4_rows:
                    if len(rows) + len(results) >= limit:
                        break
                    text = _decode_content(row.get("hex_content", ""), "4")
                    if query.lower() in text.lower():
                        rows.append(row)
                for row in rows:
                    raw_type = row.get("local_type", "")
                    try:
                        type_key = str(int(raw_type) & 0xFFFF) if raw_type else ""
                    except (ValueError, TypeError):
                        type_key = raw_type
                    results.append({
                        "chat": self.get_display_name(wxid),
                        "wxid": wxid,
                        "time": _format_time(row.get("create_time", "0")),
                        "type": MSG_TYPES.get(type_key, f"other({type_key})"),
                        "sender": row.get("real_sender_id", ""),
                        "content": _decode_content(row.get("hex_content", ""), row.get("ct", "0")),
                    })

        results.sort(key=lambda m: m["time"], reverse=True)
        return results[:limit]


def _format_time(ts: str) -> str:
    try:
        t = int(ts)
        if t > 0:
            return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError, OSError):
        pass
    return "unknown"


# Singleton
wechat = WeChat()

# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def wechat_query_chat(
    contact: str,
    start_date: str = "",
    end_date: str = "",
    limit: int = 50,
    text_only: bool = False,
) -> str:
    """Query WeChat chat messages for a specific contact or group.

    Args:
        contact: Contact name, remark, or WeChat ID to search for.
        start_date: Start date filter (YYYY-MM-DD). Optional.
        end_date: End date filter (YYYY-MM-DD). Optional.
        limit: Max messages to return (default 50).
        text_only: If true, only return text messages (skip images, stickers, etc).
    """
    matches = wechat.resolve_contact(contact)
    if not matches:
        return f"No contact found matching '{contact}'"

    if len(matches) > 10:
        top = matches[:10]
        return (
            f"Found {len(matches)} contacts matching '{contact}'. "
            f"Be more specific. Top matches:\n"
            + "\n".join(
                f"  - {m.get('remark') or m.get('nickname')} ({m['wxid']})"
                for m in top
            )
        )

    # If multiple matches, try exact match first
    exact = [m for m in matches if contact.lower() in (
        m["wxid"].lower(),
        m.get("nickname", "").lower(),
        m.get("remark", "").lower(),
    )]
    target = exact[0] if exact else matches[0]
    wxid = target["wxid"]
    display_name = target.get("remark") or target.get("nickname") or wxid

    messages = wechat.query_messages(
        wxid,
        start_date=start_date or None,
        end_date=end_date or None,
        limit=limit,
        text_only=text_only,
    )

    if not messages:
        return f"No messages found for {display_name} ({wxid}) in the specified range."

    header = f"Chat with {display_name} ({wxid}) — {len(messages)} messages"
    if start_date or end_date:
        header += f" [{start_date or '...'}→{end_date or '...'}]"
    header += "\n"

    lines = [header]
    is_chatroom = wxid.endswith("@chatroom")
    for msg in messages:
        t, mt, content = msg["time"], msg["type"], msg.get("content", "") or ""
        sender = msg.get("sender", "")
        is_sent = msg.get("is_sent", False)
        sender_label = ""

        if is_chatroom:
            # Group chat: real_sender_id is wxid, use as before
            if sender and sender != wxid:
                sender_name = wechat.get_display_name(sender)
                sender_label = f" {sender_name}:" if sender_name != sender else f" {sender}:"
        else:
            # Direct chat: status=2 means sent by user
            if is_sent:
                sender_label = " Me:"
            else:
                sender_label = f" {display_name}:"

        if mt == "text":
            # Strip sender prefix that WeChat embeds in group message content
            text = content
            if sender and text.startswith(f"{sender}:\n"):
                text = text[len(sender) + 2:]
            lines.append(f"[{t}]{sender_label} {text}")
        elif mt == "system":
            lines.append(f"[{t}] *[system] {content[:200]}*")
        else:
            lines.append(f"[{t}]{sender_label} [{mt}]")

    return "\n".join(lines)


@mcp.tool()
def wechat_search_messages(query: str, limit: int = 20) -> str:
    """Full-text search across all WeChat messages.

    Args:
        query: Text to search for in message content.
        limit: Max results to return (default 20).
    """
    results = wechat.search_all_messages(query, limit=limit)
    if not results:
        return f"No messages found matching '{query}'"

    lines = [f"Search results for '{query}' — {len(results)} matches\n"]
    for msg in results:
        chat = msg.get("chat", "")
        t = msg["time"]
        content = msg.get("content", "")[:200]
        lines.append(f"[{t}] {chat}: {content}")

    return "\n".join(lines)


@mcp.tool()
def wechat_list_contacts(filter: str = "", limit: int = 30) -> str:
    """List WeChat contacts, optionally filtered.

    Args:
        filter: Optional text to filter contacts by name, remark, or ID.
        limit: Max contacts to return (default 30).
    """
    if filter:
        matches = wechat.resolve_contact(filter)
    else:
        contacts = wechat.load_contacts()
        matches = [{"wxid": k, **v} for k, v in contacts.items()]

    # Sort by remark/nickname presence
    matches.sort(key=lambda c: (not c.get("remark"), not c.get("nickname"), c["wxid"]))
    matches = matches[:limit]

    if not matches:
        return f"No contacts found matching '{filter}'" if filter else "No contacts loaded"

    lines = [f"Contacts ({len(matches)} shown):\n"]
    for c in matches:
        parts = []
        if c.get("remark"):
            parts.append(f"remark={c['remark']}")
        if c.get("nickname"):
            parts.append(f"nick={c['nickname']}")
        if c.get("alias"):
            parts.append(f"alias={c['alias']}")
        lines.append(f"  {c['wxid']}: {', '.join(parts)}")

    return "\n".join(lines)


@mcp.tool()
def wechat_recent_activity(days: int = 7, limit: int = 20) -> str:
    """Show recently active chats.

    Args:
        days: Look back this many days (default 7).
        limit: Max chats to return (default 20).
    """
    name2id, _ = wechat.load_name2id()
    cutoff = int((datetime.now() - timedelta(days=days)).timestamp())

    chat_activity: dict[str, dict] = {}

    for i in range(11):
        db_rel = f"message/message_{i}.db"
        entry = wechat.keys.get(db_rel)
        if not entry:
            continue

        tables = wechat._query(
            db_rel,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';",
        )

        for t in tables:
            table = t.get("name", "")
            if not table.startswith("Msg_"):
                continue
            wxid = name2id.get(table, table)

            rows = wechat._query(
                db_rel,
                f"SELECT MAX(create_time) as last_ts, COUNT(*) as cnt "
                f"FROM {table} WHERE create_time >= {cutoff};",
            )
            if rows and rows[0].get("cnt", "0") != "0":
                last_ts = int(rows[0].get("last_ts", 0) or 0)
                cnt = int(rows[0].get("cnt", 0) or 0)
                if cnt > 0:
                    chat_activity[wxid] = {
                        "last_message": _format_time(str(last_ts)),
                        "last_ts": last_ts,
                        "message_count": cnt,
                    }

    if not chat_activity:
        return f"No chat activity in the last {days} days."

    sorted_chats = sorted(
        chat_activity.items(), key=lambda x: x[1]["last_ts"], reverse=True
    )[:limit]

    lines = [f"Recent activity (last {days} days) — {len(sorted_chats)} chats\n"]
    for wxid, info in sorted_chats:
        name = wechat.get_display_name(wxid)
        lines.append(
            f"  {name}: {info['message_count']} msgs, last {info['last_message']}"
        )

    return "\n".join(lines)


@mcp.tool()
def wechat_extract_keys() -> str:
    """Re-extract encryption keys from a running WeChat process.

    Requires WeChat to be running and previously re-signed.
    This runs with sudo via the extract_key.py script.
    Keys are saved to /tmp/wechat_keys.json.
    """
    script = os.path.expanduser("~/code/brain/scripts/wechat/extract_key.py")
    if not os.path.exists(script):
        return f"extract_key.py not found at {script}"

    try:
        result = subprocess.run(
            ["sudo", "-n", sys.executable, script],
            capture_output=True,
            text=True,
            timeout=120,
        )
        output = result.stdout + result.stderr
        if result.returncode != 0:
            return (
                f"Key extraction failed (exit {result.returncode}).\n"
                f"You may need to run manually: sudo python3 {script}\n\n"
                f"Output:\n{output[-500:]}"
            )
        # Reload keys
        wechat._keys = None
        wechat._name2id = None
        wechat._id2name = None
        return f"Keys extracted successfully.\n{output[-500:]}"
    except subprocess.TimeoutExpired:
        return "Key extraction timed out after 120s."


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    mcp.run()
