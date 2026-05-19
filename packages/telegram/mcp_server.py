#!/usr/bin/env python3
"""Telegram MCP Server — read chats, search messages, send messages, list contacts.

Uses Telethon (user API) for full personal chat access.
First run requires phone number + OTP for session auth. Session is saved and reused.

Usage:
  .venv/bin/python mcp_server.py
  .venv/bin/python mcp_server.py --login    # Force fresh login
  .venv/bin/python mcp_server.py --logout   # Delete saved session
"""

import argparse
import asyncio
import logging
import os
import stat
import sys
from datetime import datetime, timezone
from typing import Optional

from mcp.server.fastmcp import FastMCP
from telethon import TelegramClient
from telethon.tl.types import User, Chat, Channel, Message

logger = logging.getLogger("telegram-mcp")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

SESSION_DIR = os.path.expanduser("~/.telegram-mcp")
SESSION_FILE = os.path.join(SESSION_DIR, "session")

API_ID = int(os.environ.get("TELEGRAM_API_ID", "0"))
API_HASH = os.environ.get("TELEGRAM_API_HASH", "")

# ---------------------------------------------------------------------------
# MCP Server
# ---------------------------------------------------------------------------

mcp = FastMCP(
    "telegram",
    instructions=(
        "Read and send Telegram messages, search chats, list contacts. "
        "Tools: telegram_chats, telegram_messages, telegram_search, "
        "telegram_send_message, telegram_contacts, telegram_login, telegram_close."
    ),
)

# ---------------------------------------------------------------------------
# Client lifecycle
# ---------------------------------------------------------------------------

_client: Optional[TelegramClient] = None


def _secure_mkdir(path: str) -> None:
    os.makedirs(path, exist_ok=True)
    os.chmod(path, stat.S_IRWXU)


async def _get_client() -> TelegramClient:
    global _client

    if _client and _client.is_connected():
        return _client

    if not API_ID or not API_HASH:
        raise RuntimeError(
            "TELEGRAM_API_ID and TELEGRAM_API_HASH env vars required. "
            "Get them from https://my.telegram.org/apps"
        )

    _secure_mkdir(SESSION_DIR)
    _client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
    await _client.connect()

    if not await _client.is_user_authorized():
        raise RuntimeError(
            "Not logged in. Run: cd packages/telegram && "
            ".venv/bin/python mcp_server.py --login"
        )

    return _client


def _entity_name(entity) -> str:
    if isinstance(entity, User):
        parts = [entity.first_name or "", entity.last_name or ""]
        name = " ".join(p for p in parts if p)
        return name or entity.username or str(entity.id)
    if isinstance(entity, (Chat, Channel)):
        return entity.title or str(entity.id)
    return str(entity.id) if hasattr(entity, "id") else "Unknown"


def _format_message(msg: Message, sender_name: str = "") -> dict:
    return {
        "id": msg.id,
        "date": msg.date.isoformat() if msg.date else None,
        "sender": sender_name,
        "text": msg.text or "",
        "media": bool(msg.media),
        "reply_to": msg.reply_to_msg_id if msg.reply_to else None,
    }


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@mcp.tool()
async def telegram_login() -> str:
    """Force interactive login. Only needed on first use or session expiry."""
    raise RuntimeError(
        "Interactive login required. Run from terminal:\n"
        "  cd /path/to/mcp-servers/packages/telegram\n"
        "  .venv/bin/python mcp_server.py --login"
    )


@mcp.tool()
async def telegram_close() -> str:
    """Disconnect the Telegram client."""
    global _client
    if _client:
        await _client.disconnect()
        _client = None
    return "Disconnected."


@mcp.tool()
async def telegram_chats(limit: int = 30) -> str:
    """List recent chats/conversations.

    Args:
        limit: Max number of chats to return (default 30, max 100).
    """
    client = await _get_client()
    limit = min(limit, 100)

    results = []
    async for dialog in client.iter_dialogs(limit=limit):
        entity = dialog.entity
        chat_type = "user"
        if isinstance(entity, Channel):
            chat_type = "channel" if entity.broadcast else "group"
        elif isinstance(entity, Chat):
            chat_type = "group"

        last_msg = dialog.message
        results.append({
            "id": dialog.id,
            "name": dialog.name or _entity_name(entity),
            "type": chat_type,
            "unread": dialog.unread_count,
            "last_message": {
                "date": last_msg.date.isoformat() if last_msg and last_msg.date else None,
                "text": (last_msg.text or "")[:100] if last_msg else "",
                "sender": _entity_name(await last_msg.get_sender()) if last_msg and last_msg.sender_id else "",
            } if last_msg else None,
        })

    import json
    return json.dumps(results, ensure_ascii=False, indent=2)


@mcp.tool()
async def telegram_messages(
    chat: str,
    limit: int = 20,
    offset_id: int = 0,
) -> str:
    """Read messages from a specific chat.

    Args:
        chat: Chat name, username (@user), phone number (+1234), or numeric ID.
        limit: Number of messages to fetch (default 20, max 100).
        offset_id: Fetch messages before this message ID (for pagination). 0 = latest.
    """
    client = await _get_client()
    limit = min(limit, 100)

    entity = await _resolve_entity(client, chat)
    messages = []

    async for msg in client.iter_messages(entity, limit=limit, offset_id=offset_id):
        sender = await msg.get_sender() if msg.sender_id else None
        sender_name = _entity_name(sender) if sender else ""
        messages.append(_format_message(msg, sender_name))

    import json
    return json.dumps(messages, ensure_ascii=False, indent=2)


@mcp.tool()
async def telegram_search(
    query: str,
    chat: str = "",
    limit: int = 20,
) -> str:
    """Search messages globally or within a specific chat.

    Args:
        query: Search text.
        chat: Optional — chat name/username/ID to search within. Empty = search all chats.
        limit: Max results (default 20, max 50).
    """
    client = await _get_client()
    limit = min(limit, 50)

    entity = None
    if chat:
        entity = await _resolve_entity(client, chat)

    messages = []
    async for msg in client.iter_messages(entity, search=query, limit=limit):
        sender = await msg.get_sender() if msg.sender_id else None
        sender_name = _entity_name(sender) if sender else ""

        chat_entity = await msg.get_chat()
        chat_name = _entity_name(chat_entity) if chat_entity else ""

        entry = _format_message(msg, sender_name)
        entry["chat"] = chat_name
        messages.append(entry)

    import json
    return json.dumps(messages, ensure_ascii=False, indent=2)


@mcp.tool()
async def telegram_send_message(
    chat: str,
    text: str,
    reply_to: int = 0,
    confirm_send: bool = True,
) -> str:
    """Send a message to a Telegram chat.

    Args:
        chat: Chat name, username, phone, or ID.
        text: Message text to send.
        reply_to: Optional message ID to reply to.
        confirm_send: Safety guard. Set to True to actually send. Default True.
    """
    if not confirm_send:
        return f"DRY RUN — would send to '{chat}':\n{text}"

    client = await _get_client()
    entity = await _resolve_entity(client, chat)

    kwargs = {}
    if reply_to:
        kwargs["reply_to"] = reply_to

    sent = await client.send_message(entity, text, **kwargs)

    return (
        f"Sent message ID {sent.id} to {_entity_name(entity)} "
        f"at {sent.date.isoformat() if sent.date else 'now'}."
    )


@mcp.tool()
async def telegram_contacts(query: str = "", limit: int = 50) -> str:
    """List or search Telegram contacts.

    Args:
        query: Optional search filter for contact name/username.
        limit: Max results (default 50, max 200).
    """
    client = await _get_client()
    limit = min(limit, 200)

    from telethon.tl.functions.contacts import GetContactsRequest
    result = await client(GetContactsRequest(hash=0))
    contacts = []

    for user in result.users:
        name = _entity_name(user)
        if query and query.lower() not in name.lower() and (
            not user.username or query.lower() not in user.username.lower()
        ):
            continue

        contacts.append({
            "id": user.id,
            "name": name,
            "username": user.username or "",
            "phone": user.phone or "",
        })

        if len(contacts) >= limit:
            break

    import json
    return json.dumps(contacts, ensure_ascii=False, indent=2)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _resolve_entity(client: TelegramClient, identifier: str):
    """Resolve a chat identifier to a Telethon entity."""
    identifier = identifier.strip()

    # Numeric ID
    if identifier.lstrip("-").isdigit():
        return await client.get_entity(int(identifier))

    # Username (@handle)
    if identifier.startswith("@"):
        return await client.get_entity(identifier)

    # Phone number
    if identifier.startswith("+"):
        return await client.get_entity(identifier)

    # Search by name in dialogs
    async for dialog in client.iter_dialogs(limit=200):
        if dialog.name and identifier.lower() in dialog.name.lower():
            return dialog.entity

    raise ValueError(f"Could not find chat: {identifier}")


# ---------------------------------------------------------------------------
# Interactive login flow (terminal only)
# ---------------------------------------------------------------------------


async def _interactive_login():
    """Run interactive phone + OTP login."""
    if not API_ID or not API_HASH:
        print("ERROR: Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars.")
        sys.exit(1)

    _secure_mkdir(SESSION_DIR)
    client = TelegramClient(SESSION_FILE, API_ID, API_HASH)
    await client.connect()

    if await client.is_user_authorized():
        me = await client.get_me()
        print(f"Already logged in as: {me.first_name} ({me.phone})")
        await client.disconnect()
        return

    phone = input("Enter your phone number (with country code, e.g. +1234567890): ").strip()
    await client.send_code_request(phone)

    code = input("Enter the code you received: ").strip()

    try:
        await client.sign_in(phone, code)
    except Exception:
        password = input("2FA password required. Enter password: ").strip()
        await client.sign_in(password=password)

    me = await client.get_me()
    print(f"Logged in as: {me.first_name} ({me.phone})")
    print(f"Session saved to: {SESSION_DIR}")
    await client.disconnect()


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Telegram MCP Server")
    parser.add_argument("--login", action="store_true", help="Force interactive login")
    parser.add_argument("--logout", action="store_true", help="Delete saved session")
    args = parser.parse_args()

    if args.logout:
        import shutil
        if os.path.exists(SESSION_DIR):
            shutil.rmtree(SESSION_DIR)
            print("Session deleted.")
        else:
            print("No session found.")
        sys.exit(0)

    if args.login:
        asyncio.run(_interactive_login())
        sys.exit(0)

    mcp.run(transport="stdio")
