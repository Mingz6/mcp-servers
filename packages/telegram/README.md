# telegram

Telegram MCP server — read chats, search messages, send messages, list contacts.

Uses Telethon (user API) for full personal chat access. First run requires phone number + OTP.

## Tools

| Tool | Description |
|------|-------------|
| `telegram_login` | Authenticate (phone + OTP) |
| `telegram_close` | Disconnect session |
| `telegram_chats` | List recent chats |
| `telegram_messages` | Read messages from a chat |
| `telegram_search` | Search messages by keyword |
| `telegram_send_message` | Send a message |
| `telegram_contacts` | List contacts |

## Setup

```bash
cd packages/telegram
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Requires `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in `.env` (get from https://my.telegram.org).

## MCP Config

```jsonc
{
  "telegram": {
    "type": "stdio",
    "command": "${userHome}/code/personal/mcp-servers/packages/telegram/run.sh"
  }
}
```
