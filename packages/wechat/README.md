# WeChat Mac — Decrypt, Export & MCP Server

Scripts to extract SQLCipher keys from WeChat's process memory, export chat history,
and run an MCP server for live chat queries + message sending.

## Files

| File | Purpose |
|------|---------|
| `extract_key.py` | Extracts encryption keys from WeChat memory (requires sudo) |
| `export_messages.py` | Batch export all messages/contacts to JSON + Markdown |
| `mcp_server.py` | MCP server — live chat queries, contact search, send messages |

## When to Run

- After a fresh WeChat install or major update (code signature resets)
- When you want a fresh export of all chat history
- Keys change on WeChat restart, so re-extract if the saved keys stop working

## Prerequisites

```bash
brew install sqlcipher    # SQLCipher 4.x CLI
pip3 install pycryptodome # Only if using HMAC verification (optional)
```

## Steps

### 1. Re-sign WeChat (one-time per install/update)

Quit WeChat first, then strip the hardened runtime so we can read process memory:

```bash
sudo codesign --force --deep --sign - /Applications/WeChat.app
```

This replaces Apple's signature with an ad-hoc one. WeChat still works normally — it just loses Gatekeeper trust and hardened runtime protection. Auto-update or reinstall will revert it.

### 2. Launch WeChat & Login

Open WeChat and scan the QR code from your phone. Wait until you're fully logged in and can see chats.

### 3. Extract Keys

```bash
sudo python3 ~/code/brain/scripts/wechat/extract_key.py
```

Output: `/tmp/wechat_keys.json` (all DB keys) and `/tmp/wechat_key.txt` (primary key).

Verify manually:

```bash
KEY=$(cat /tmp/wechat_key.txt)
DB=~/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/*/db_storage/message/message_0.db
/opt/homebrew/bin/sqlcipher $DB \
  "PRAGMA key = \"x'$KEY'\"; PRAGMA cipher_compatibility = 4; PRAGMA cipher_page_size = 4096; SELECT count(*) FROM sqlite_master;"
# Should output a number > 0
```

### 4. Export Messages

```bash
python3 ~/code/brain/scripts/wechat/export_messages.py
```

Output goes to `~/code/brain/family/minting-zhu/wechat-export/` (gitignored):
- `chats/*.md` — Markdown per contact/group
- `contacts.json` — 8,700+ contacts
- `all_messages.json` — full message dump
- `summary.json` — metadata

### 5. Save Keys

```bash
cp /tmp/wechat_keys.json ~/code/brain/family/minting-zhu/wechat-export/.keys.json
cp /tmp/wechat_key.txt ~/code/brain/family/minting-zhu/wechat-export/.primary_key.txt
```

## How It Works

1. **WCDB** (Tencent's SQLCipher wrapper) caches the derived encryption key in process memory as `x'<64hex_key><32hex_salt>'`
2. The extract script uses macOS Mach VM API (`task_for_pid` → `mach_vm_region` → `mach_vm_read_overwrite`) to scan all readable memory regions
3. It matches the salt from each DB file's first 16 bytes against hex patterns found in memory
4. HMAC verification confirms the key is correct before saving
5. Each DB may have a different key — the script extracts all of them

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `task_for_pid failed (kr=5)` | WeChat needs re-signing: `sudo codesign --force --deep --sign - /Applications/WeChat.app` then restart WeChat |
| `WeChat is not running` | Launch WeChat and login first |
| Keys don't work after restart | Re-run `extract_key.py` — WCDB regenerates keys on restart |
| WeChat won't launch after re-sign | Reinstall from wechat.com, then re-sign |
| `Operation not permitted` | Run with `sudo` |

## MCP Server

### Setup (one-time)

The venv is already created at `scripts/wechat/.venv/`.
If you need to recreate it:

```bash
cd ~/code/personal/mcp-servers/packages/wechat
python3 -m venv .venv
.venv/bin/pip install "mcp[cli]"
```

The MCP config is in `~/Library/Application Support/Code/User/mcp.json`:

```json
"wechat": {
  "type": "stdio",
  "command": "${userHome}/code/personal/mcp-servers/packages/wechat/.venv/bin/python",
  "args": ["${userHome}/code/personal/mcp-servers/packages/wechat/mcp_server.py"]
}
```

### Tools

| Tool | What it does |
|------|-------------|
| `wechat_query_chat` | Get messages for a contact/group, with optional date range filter |
| `wechat_search_messages` | Full-text search across all message databases |
| `wechat_list_contacts` | List/filter contacts by name, remark, or WeChat ID |
| `wechat_recent_activity` | Show recently active chats (last N days) |
| `wechat_send_message` | Send a message via keyboard automation (fragile — needs WeChat visible) |
| `wechat_extract_keys` | Re-run key extraction (needs sudo configured for passwordless) |

### Key Management

The MCP server looks for keys in this order:
1. `/tmp/wechat_keys.json` — freshly extracted keys
2. `~/code/brain/family/minting-zhu/wechat-export/.keys.json` — persisted backup

Keys become stale when WeChat restarts. When queries start failing, re-extract:

```bash
sudo python3 ~/code/brain/scripts/wechat/extract_key.py
```

### Send Message Caveats

Sending uses blind macOS keyboard automation (AppleScript → System Events):
- WeChat must be installed and logged in
- The contact name must be specific enough to be the first search result
- No visual verification — can't confirm the message went to the right person
- Won't work if WeChat has a modal dialog open or is in an unexpected state
