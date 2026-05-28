# whatsapp

WhatsApp MCP server — read chats, search messages, send messages, list contacts.

Uses Baileys (WebSocket-based WhatsApp Web API). First run requires QR code scan via `node login.mjs`.

## Tools

| Tool | Description |
|------|-------------|
| `whatsapp_login` | Connect to WhatsApp (uses saved auth) |
| `whatsapp_close` | Disconnect |
| `whatsapp_chats` | List recent chats |
| `whatsapp_messages` | Read messages from a chat |
| `whatsapp_search` | Search messages by keyword |
| `whatsapp_send_message` | Send a message |
| `whatsapp_contacts` | List contacts |

## Setup

```bash
cd packages/whatsapp
npm install
node login.mjs   # scan QR code (first time only)
```

Auth state saved to `~/.whatsapp-mcp/auth/`.

## MCP Config

```jsonc
{
  "whatsapp": {
    "type": "stdio",
    "command": "${userHome}/code/personal/mcp-servers/packages/whatsapp/run.sh"
  }
}
```
