# mcp-applemail

MCP server for reading and sending email via Apple Mail. Reads directly from the local SQLite envelope index and `.emlx` files; sends via AppleScript.

No cloud auth — works for any account already configured in Apple Mail (iCloud, Gmail, work IMAP/Exchange, etc.).

## Tools (7)

| Tool | What it does |
|---|---|
| `applemail_accounts` | List configured Mail accounts |
| `applemail_inbox` | List recent messages, optionally scoped by account/folder/unread |
| `applemail_search` | Search across mailboxes by sender, subject, or body keywords |
| `applemail_read` | Read a full message body (parses `.emlx`, decodes attachments list) |
| `applemail_attachments` | List a message's attachments with sizes/types |
| `applemail_folders` | List folders for an account with total/unread counts |
| `applemail_send` | Send a new email (or save as draft) via Apple Mail |

## Setup

### 1. Grant Full Disk Access

Apple Mail's database lives at `~/Library/Mail/`. Terminal/VS Code/Node need Full Disk Access to read it.

System Settings → Privacy & Security → **Full Disk Access** → add your terminal (`Terminal.app` or `iTerm`) and VS Code. Restart both after granting.

### 2. Build

```bash
cd packages/applemail
npm install
npm run build
```

Or from repo root:

```bash
npm run build:applemail
```

### 3. Wire into VS Code mcp.json

```json
{
  "servers": {
    "applemail": {
      "type": "stdio",
      "command": "${userHome}/code/personal/mcp-servers/packages/applemail/run.sh"
    }
  }
}
```

Reload the VS Code window.

## Sending behavior

`applemail_send` defaults to **draft mode** — the message is saved to Drafts, not sent. Pass `draft: false` to actually send. Multi-line bodies are supported.

## Troubleshooting

| Problem | Fix |
|---|---|
| `SqliteError: unable to open database file` | Full Disk Access not granted; see Setup step 1 |
| `applemail_send` fails on multi-line body | Update to latest — older builds had AppleScript escaping bugs |
| Stale results after new mail arrives | Apple Mail flushes the envelope DB lazily; force a fetch (Mail.app → Mailbox → Get All New Mail) |
