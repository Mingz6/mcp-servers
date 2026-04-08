# iMessage / SMS MCP Server

Read and send iMessage/SMS via macOS Messages.app.

## Tools

| Tool | Description |
|---|---|
| `messages_read` | Read recent messages with a contact by phone number |
| `messages_search` | Search messages by keyword, optionally filtered to one contact |
| `messages_send` | Send iMessage or SMS (auto-detects service from history) |
| `messages_contacts` | List recent conversations with last message preview |

## Setup

```bash
cd packages/imessage
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## Requirements

- **macOS only** — uses `~/Library/Messages/chat.db` for reads, AppleScript for sends
- **Full Disk Access** must be granted to the host app (VS Code / Terminal)
- No hardcoded PII — phone numbers and names come from the local Messages database at runtime

## Security

- Database is read-only (`?mode=ro`)
- No PII, phone numbers, names, or email addresses in source code
- All contact data stays local — resolved at runtime from macOS Messages.app
- The `messages_send` tool always requires explicit phone + text params from the caller

## VS Code MCP Config

Add to your `settings.json` or `.vscode/mcp.json`:

```json
{
  "servers": {
    "imessage": {
      "type": "stdio",
      "command": "/path/to/packages/imessage/.venv/bin/python",
      "args": ["/path/to/packages/imessage/mcp_server.py"]
    }
  }
}
```
