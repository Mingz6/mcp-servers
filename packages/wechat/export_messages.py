#!/usr/bin/env python3
"""Export WeChat messages and contacts from decrypted SQLCipher databases.

Reads keys from /tmp/wechat_keys.json (produced by extract_key.py).
Output goes to ~/.wechat-export/.

Usage: python3 export_messages.py
"""

import csv
import hashlib
import io
import json
import os
import subprocess
import sys
from datetime import datetime

SQLCIPHER = os.environ.get("SQLCIPHER_PATH", "/opt/homebrew/bin/sqlcipher")
KEYS_FILE = "/tmp/wechat_keys.json"
WECHAT_DATA = os.path.expanduser(
    "~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files"
)
OUT_DIR = os.path.expanduser("~/.wechat-export")


def _find_db_dir() -> str:
    """Auto-discover the db_storage path from the first account folder."""
    for entry in sorted(os.listdir(WECHAT_DATA)):
        candidate = os.path.join(WECHAT_DATA, entry, "db_storage")
        if os.path.isdir(candidate):
            return candidate
    raise FileNotFoundError(f"No db_storage found under {WECHAT_DATA}")


DB_DIR = _find_db_dir()

MSG_TYPES = {
    "1": "text", "3": "image", "34": "voice", "42": "card",
    "43": "video", "47": "sticker", "48": "location", "49": "link/file",
    "50": "call", "10000": "system", "10002": "recall",
}


def load_keys():
    if not os.path.exists(KEYS_FILE):
        print(f"[ERROR] {KEYS_FILE} not found. Run extract_key.py first.")
        sys.exit(1)
    with open(KEYS_FILE) as f:
        return json.load(f)


def query(db_path, key, sql):
    cmd = (
        f"PRAGMA key = \"x'{key}'\";\n"
        "PRAGMA cipher_compatibility = 4;\n"
        "PRAGMA cipher_page_size = 4096;\n"
        ".headers on\n.mode csv\n"
        f"{sql}\n"
    )
    result = subprocess.run(
        [SQLCIPHER, db_path],
        input=cmd.encode(), capture_output=True, timeout=60,
    )
    text = result.stdout.decode("utf-8", errors="replace").strip()
    if not text:
        return []
    lines = text.split("\n")
    while lines and lines[0].strip() == "ok":
        lines.pop(0)
    if len(lines) < 2:
        return []
    return list(csv.DictReader(io.StringIO("\n".join(lines))))


def format_time(ts):
    try:
        t = int(ts)
        if t > 0:
            return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M:%S")
    except (ValueError, TypeError, OSError):
        pass
    return "unknown"


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    keys = load_keys()
    print(f"Loaded {len(keys)} database keys")

    # --- Export contacts ---
    contacts = {}
    contact_entry = keys.get("contact/contact.db")
    if contact_entry:
        contact_db = os.path.join(DB_DIR, "contact/contact.db")
        contact_key = contact_entry["enc_key"]
        contact_rows = query(contact_db, contact_key, "SELECT * FROM contact;")
        with open(os.path.join(OUT_DIR, "contacts.json"), 'w', encoding='utf-8') as f:
            json.dump(contact_rows, f, ensure_ascii=False, indent=2)
        print(f"Exported {len(contact_rows)} contacts")
        for c in contact_rows:
            wxid = c.get("username", "")
            if wxid:
                contacts[wxid] = {
                    "nickname": c.get("nick_name", ""),
                    "remark": c.get("remark", ""),
                }

    # --- Get Name2Id mapping ---
    # WeChat 4.x may have migrated message_0.db away. Fall back to deriving
    # the mapping directly from contact wxids (Msg_{md5(wxid)} -> wxid).
    name2id = {}
    msg0_entry = keys.get("message/message_0.db")
    if msg0_entry:
        msg0_db = os.path.join(DB_DIR, "message/message_0.db")
        for r in query(msg0_db, msg0_entry["enc_key"], "SELECT user_name FROM Name2Id;"):
            un = r.get("user_name", "")
            if un:
                name2id[f"Msg_{hashlib.md5(un.encode()).hexdigest()}"] = un
        print(f"Name2Id: {len(name2id)} contacts/groups (from message_0.db)")
    else:
        for wxid in contacts.keys():
            name2id[f"Msg_{hashlib.md5(wxid.encode()).hexdigest()}"] = wxid
        print(f"Name2Id: {len(name2id)} contacts (derived from contact wxids — message_0.db missing)")

    # --- Export messages ---
    all_messages = {}
    for i in range(20):
        db_name = f"message/message_{i}.db"
        entry = keys.get(db_name)
        if not entry:
            continue
        db_path = os.path.join(DB_DIR, db_name)
        key = entry["enc_key"]
        tables = [r.get("name") for r in query(db_path, key,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%';")
            if r.get("name", "").startswith("Msg_")]

        count = 0
        for table in tables:
            wxid = name2id.get(table, table)
            rows = query(db_path, key,
                f"SELECT local_id, create_time, local_type, real_sender_id, message_content FROM {table} ORDER BY create_time;")
            if not rows:
                continue
            if wxid not in all_messages:
                all_messages[wxid] = []
            for row in rows:
                raw_type = row.get("local_type", "")
                try:
                    type_key = str(int(raw_type) & 0xFFFF) if raw_type else ""
                except (ValueError, TypeError):
                    type_key = raw_type
                all_messages[wxid].append({
                    "time": format_time(row.get("create_time", "0")),
                    "timestamp": int(row.get("create_time", 0) or 0),
                    "type": MSG_TYPES.get(type_key, f"other({type_key})"),
                    "sender_id": row.get("real_sender_id", ""),
                    "content": row.get("message_content", ""),
                })
                count += 1
        print(f"  {db_name}: {len(tables)} chats, {count} messages")

    # --- Write Markdown chat files ---
    chats_dir = os.path.join(OUT_DIR, "chats")
    os.makedirs(chats_dir, exist_ok=True)
    total_chats = 0
    total_msgs = 0
    for wxid, messages in sorted(all_messages.items()):
        if not messages:
            continue
        info = contacts.get(wxid, {})
        nickname = info.get("remark") or info.get("nickname") or wxid
        safe_name = "".join(c if c.isalnum() or c in "-_" else "_" for c in nickname)
        if not safe_name or safe_name == "_":
            safe_name = wxid.replace("@", "_at_")

        with open(os.path.join(chats_dir, f"{safe_name}.md"), 'w', encoding='utf-8') as f:
            f.write(f"# Chat: {nickname}\nWeChat ID: {wxid}\nMessages: {len(messages)}\n\n")
            for msg in messages:
                t, mt, content = msg["time"], msg["type"], msg.get("content", "") or ""
                if mt == "system":
                    f.write(f"*[{t}] [system] {content[:200]}*\n\n")
                elif mt == "text":
                    f.write(f"[{t}] {content}\n\n")
                elif content.startswith("<"):
                    f.write(f"[{t}] [{mt}]\n\n")
                else:
                    f.write(f"[{t}] [{mt}] {content[:300]}\n\n")
        total_chats += 1
        total_msgs += len(messages)

    # --- Summary ---
    summary = {
        "export_time": datetime.now().isoformat(),
        "total_chats": total_chats,
        "total_messages": total_msgs,
        "chats": {
            wxid: {
                "contact": contacts.get(wxid, {}),
                "message_count": len(msgs),
                "first_message": msgs[0]["time"] if msgs else None,
                "last_message": msgs[-1]["time"] if msgs else None,
            }
            for wxid, msgs in all_messages.items() if msgs
        }
    }
    with open(os.path.join(OUT_DIR, "summary.json"), 'w', encoding='utf-8') as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    with open(os.path.join(OUT_DIR, "all_messages.json"), 'w', encoding='utf-8') as f:
        json.dump(all_messages, f, ensure_ascii=False, indent=2)

    print(f"\nDone: {total_chats} chats, {total_msgs} messages → {OUT_DIR}")


if __name__ == '__main__':
    main()
