#!/usr/bin/env python3
"""iMessage / SMS MCP Server — read, search, and send messages via macOS Messages.app.

Reads from ~/Library/Messages/chat.db (read-only, no PII in code).
Sends via AppleScript → Messages.app (supports both iMessage and SMS).

Usage:
  .venv/bin/python mcp_server.py
"""

import logging
import os
import re
import sqlite3
import subprocess
from datetime import datetime
from typing import Optional

from mcp.server.fastmcp import FastMCP

logger = logging.getLogger("imessage-mcp")

# ---------------------------------------------------------------------------
# Config — no hardcoded PII, paths resolved at runtime
# ---------------------------------------------------------------------------

CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "imessage",
    instructions=(
        "Read and send iMessage/SMS on macOS. "
        "Tools: messages_read, messages_search, messages_send, messages_contacts."
    ),
)

# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _get_db() -> sqlite3.Connection:
    """Open chat.db read-only."""
    if not os.path.exists(CHAT_DB):
        raise FileNotFoundError(
            f"Messages database not found at {CHAT_DB}. "
            "Make sure Full Disk Access is granted."
        )
    conn = sqlite3.connect(f"file:{CHAT_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def _normalize_phone(phone: str) -> str:
    """Strip to digits, prepend +1 if 10 digits (North America)."""
    digits = re.sub(r"[^\d]", "", phone)
    if len(digits) == 10:
        digits = "1" + digits
    return "+" + digits


def _extract_text(row: sqlite3.Row) -> str:
    """Extract message text from either text column or attributedBody blob."""
    text = row["text"]
    if text:
        return text

    abody = row["attributed_body"]
    if not abody:
        return "[attachment]"

    try:
        blob = bytes(abody)
        # NSKeyedUnarchiver format — find readable text between markers
        idx = blob.find(b"NSString")
        if idx == -1:
            idx = 0
        chunk = blob[idx:]
        parts = []
        i = 0
        skip_prefixes = (
            "NSString", "NSOrig", "NSAttr", "NSMutable", "NSObject",
            "NSFont", "NSColor", "NSCG", "NSParagraph", "NSKern",
            "NSDictionary", "NSNumber", "NSValue", "NSData", "NSKeyedArchiver",
            "__kIM",
        )
        while i < len(chunk):
            if 32 <= chunk[i] < 127:
                start = i
                while i < len(chunk) and 32 <= chunk[i] < 127:
                    i += 1
                s = chunk[start:i].decode("ascii", errors="ignore")
                if len(s) > 2 and not any(s.startswith(p) for p in skip_prefixes):
                    parts.append(s)
            i += 1
        if parts:
            return " ".join(parts[:20])
    except Exception:
        pass

    return "[unreadable]"


def _apple_ts_to_datetime(ts: int) -> datetime:
    """Convert Apple epoch nanoseconds to datetime."""
    # Apple epoch: 2001-01-01. Offset from Unix epoch = 978307200 seconds.
    return datetime.fromtimestamp(ts / 1_000_000_000 + 978307200)


def _find_chat_ids(conn: sqlite3.Connection, phone: str) -> list[int]:
    """Find chat rowids matching a phone number (handles multiple formats)."""
    normalized = _normalize_phone(phone)
    digits = re.sub(r"[^\d]", "", normalized)

    # Match against chat_identifier with flexible patterns
    cur = conn.execute("SELECT rowid, chat_identifier FROM chat")
    matches = []
    for row in cur:
        ci = row["chat_identifier"]
        ci_digits = re.sub(r"[^\d]", "", ci)
        if ci_digits and digits.endswith(ci_digits[-10:]) and len(ci_digits) >= 10:
            matches.append(row["rowid"])
    return matches


def _detect_service(conn: sqlite3.Connection, phone: str) -> str:
    """Check existing conversation history to determine iMessage vs SMS."""
    chat_ids = _find_chat_ids(conn, phone)
    if not chat_ids:
        return "iMessage"  # default for new conversations

    placeholders = ",".join("?" * len(chat_ids))
    row = conn.execute(
        f"""
        SELECT c.service_name
        FROM chat c
        WHERE c.rowid IN ({placeholders})
        ORDER BY c.rowid DESC LIMIT 1
        """,
        chat_ids,
    ).fetchone()

    if row and row["service_name"]:
        svc = row["service_name"].lower()
        if "sms" in svc or "rcs" in svc:
            return "SMS"
    return "iMessage"


def _send_applescript(phone: str, text: str, service: str) -> str:
    """Send a message via AppleScript. Returns status string."""
    normalized = _normalize_phone(phone)
    svc_type = "SMS" if service == "SMS" else "iMessage"

    # Escape for AppleScript
    escaped_text = text.replace("\\", "\\\\").replace('"', '\\"')

    script = f'''
    tell application "Messages"
        set targetService to 1st account whose service type = {svc_type}
        set targetBuddy to participant "{normalized}" of targetService
        send "{escaped_text}" to targetBuddy
    end tell
    '''

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True,
        text=True,
        timeout=15,
    )

    if result.returncode != 0:
        err = result.stderr.strip()
        # If iMessage fails, suggest SMS
        if svc_type == "iMessage" and ("not found" in err or "error" in err.lower()):
            return f"FAILED (iMessage): {err}. Try again with service='sms'."
        return f"FAILED ({svc_type}): {err}"

    return f"Sent via {svc_type} to {normalized}"


# ---------------------------------------------------------------------------
# MCP Tools
# ---------------------------------------------------------------------------


@mcp.tool()
def messages_read(
    phone: str,
    limit: int = 20,
    start_date: str = "",
    end_date: str = "",
) -> str:
    """Read recent messages with a contact by phone number.

    Args:
        phone: Phone number (any format: 604-555-0123, +16045550123, etc.)
        limit: Max messages to return (default 20, max 100)
        start_date: Optional filter — only messages on/after this date (YYYY-MM-DD)
        end_date: Optional filter — only messages before this date (YYYY-MM-DD)
    """
    limit = min(max(1, limit), 100)
    conn = _get_db()
    try:
        chat_ids = _find_chat_ids(conn, phone)
        if not chat_ids:
            return f"No conversation found for {phone}"

        placeholders = ",".join("?" * len(chat_ids))
        where = [f"cmj.chat_id IN ({placeholders})"]
        params: list = list(chat_ids)

        if start_date:
            try:
                dt = datetime.strptime(start_date, "%Y-%m-%d")
                apple_ts = int((dt.timestamp() - 978307200) * 1_000_000_000)
                where.append("m.date >= ?")
                params.append(apple_ts)
            except ValueError:
                return f"Invalid start_date format: {start_date}. Use YYYY-MM-DD."

        if end_date:
            try:
                dt = datetime.strptime(end_date, "%Y-%m-%d")
                apple_ts = int((dt.timestamp() - 978307200 + 86400) * 1_000_000_000)
                where.append("m.date < ?")
                params.append(apple_ts)
            except ValueError:
                return f"Invalid end_date format: {end_date}. Use YYYY-MM-DD."

        where_sql = " AND ".join(where)
        rows = conn.execute(
            f"""
            SELECT m.date, m.is_from_me, m.text, m.attributedBody as attributed_body
            FROM message m
            JOIN chat_message_join cmj ON m.rowid = cmj.message_id
            WHERE {where_sql}
            ORDER BY m.date DESC
            LIMIT ?
            """,
            params + [limit],
        ).fetchall()

        if not rows:
            return f"No messages found for {phone} with the given filters."

        lines = []
        for row in reversed(rows):  # chronological order
            ts = _apple_ts_to_datetime(row["date"])
            direction = "→ Sent" if row["is_from_me"] else "← Received"
            text = _extract_text(row)
            lines.append(f"[{ts:%Y-%m-%d %H:%M}] {direction}: {text}")

        service = _detect_service(conn, phone)
        header = f"Messages with {phone} (via {service}) — {len(lines)} messages:\n"
        return header + "\n".join(lines)
    finally:
        conn.close()


@mcp.tool()
def messages_search(
    query: str,
    phone: str = "",
    limit: int = 20,
) -> str:
    """Search messages by keyword, optionally filtered to one contact.

    Args:
        query: Text to search for (case-insensitive)
        phone: Optional — limit search to this phone number
        limit: Max results (default 20, max 50)
    """
    limit = min(max(1, limit), 50)
    conn = _get_db()
    try:
        params: list = []
        joins = "JOIN chat_message_join cmj ON m.rowid = cmj.message_id JOIN chat c ON cmj.chat_id = c.rowid"
        where_parts = []

        if phone:
            chat_ids = _find_chat_ids(conn, phone)
            if not chat_ids:
                return f"No conversation found for {phone}"
            placeholders = ",".join("?" * len(chat_ids))
            where_parts.append(f"cmj.chat_id IN ({placeholders})")
            params.extend(chat_ids)

        # Search in text column (plain text messages)
        safe_query = f"%{query}%"
        where_parts.append("m.text LIKE ?")
        params.append(safe_query)

        where_sql = " AND ".join(where_parts) if where_parts else "1=1"

        rows = conn.execute(
            f"""
            SELECT m.date, m.is_from_me, m.text, m.attributedBody as attributed_body,
                   c.chat_identifier
            FROM message m
            {joins}
            WHERE {where_sql}
            ORDER BY m.date DESC
            LIMIT ?
            """,
            params + [limit],
        ).fetchall()

        if not rows:
            scope = f" in conversation with {phone}" if phone else ""
            return f"No messages matching '{query}'{scope}."

        lines = []
        for row in rows:
            ts = _apple_ts_to_datetime(row["date"])
            direction = "→" if row["is_from_me"] else "←"
            text = _extract_text(row)
            chat_id = row["chat_identifier"]
            lines.append(f"[{ts:%Y-%m-%d %H:%M}] {direction} ({chat_id}): {text}")

        return f"Found {len(lines)} messages matching '{query}':\n" + "\n".join(lines)
    finally:
        conn.close()


@mcp.tool()
def messages_send(
    phone: str,
    text: str,
    service: str = "auto",
) -> str:
    """Send an iMessage or SMS to a phone number.

    IMPORTANT: Always confirm the message content and recipient with the user
    before calling this tool. This sends a real message to a real person.

    Args:
        phone: Phone number (any format: 604-555-0123, +16045550123, etc.)
        text: Message text to send
        service: 'auto' (detect from history), 'imessage', or 'sms'
    """
    if not text.strip():
        return "Cannot send empty message."
    if not phone.strip():
        return "Phone number required."

    # Auto-detect service from conversation history
    if service == "auto":
        try:
            conn = _get_db()
            service = _detect_service(conn, phone)
            conn.close()
        except Exception:
            service = "iMessage"

    svc = "SMS" if service.lower() == "sms" else "iMessage"
    return _send_applescript(phone, text.strip(), svc)


@mcp.tool()
def messages_contacts(
    limit: int = 20,
) -> str:
    """List recent conversations with last message time and preview.

    Args:
        limit: Max conversations to return (default 20, max 50)
    """
    limit = min(max(1, limit), 50)
    conn = _get_db()
    try:
        rows = conn.execute(
            """
            SELECT c.chat_identifier, c.service_name,
                   MAX(m.date) as last_date,
                   m.text, m.is_from_me, m.attributedBody as attributed_body
            FROM chat c
            JOIN chat_message_join cmj ON c.rowid = cmj.chat_id
            JOIN message m ON cmj.message_id = m.rowid
            WHERE m.date = (
                SELECT MAX(m2.date)
                FROM message m2
                JOIN chat_message_join cmj2 ON m2.rowid = cmj2.message_id
                WHERE cmj2.chat_id = c.rowid
            )
            GROUP BY c.chat_identifier
            ORDER BY last_date DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()

        if not rows:
            return "No conversations found."

        lines = []
        for row in rows:
            ts = _apple_ts_to_datetime(row["last_date"])
            svc = "SMS" if row["service_name"] and "sms" in row["service_name"].lower() else "iMsg"
            direction = "→" if row["is_from_me"] else "←"
            text = _extract_text(row)
            preview = text[:80] + "..." if len(text) > 80 else text
            lines.append(f"{row['chat_identifier']} [{svc}] ({ts:%Y-%m-%d %H:%M}) {direction} {preview}")

        return f"Recent conversations ({len(lines)}):\n" + "\n".join(lines)
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    mcp.run(transport="stdio")
