# Outlook MCP Server

Outlook email access via Microsoft Graph API. Read inbox, search, read messages, manage attachments, and send mail (with draft mode by default).

## Tools

| Tool | Description |
|------|-------------|
| `outlook_inbox` | List recent emails (optionally unread-only) |
| `outlook_search` | Search by keyword across subject, body, sender |
| `outlook_read` | Read full email content by message ID |
| `outlook_folder` | List messages from a named folder (optionally unread-only) |
| `outlook_attachments` | List attachments on a message |
| `outlook_download_attachment` | Download an attachment to a local path |
| `outlook_mark_read` | Mark a message as read or unread |
| `outlook_send` | Send an email (defaults to draft — pass `draft: false` to actually send) |

## Setup

### 1. Azure AD App Registration

Uses the same app registration as `teams-chat`: `e0cb26cf-75e6-44ba-ad09-f2de9b134143`.

Add these **delegated** Microsoft Graph permissions:

- `Mail.ReadWrite` — read inbox + mark messages read/unread
- `Mail.Send` — send messages
- `User.Read` — identify the signed-in user

Steps:

1. Go to [Azure Portal → App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Open app `e0cb26cf-75e6-44ba-ad09-f2de9b134143`
3. **API permissions** → Add a permission → Microsoft Graph → Delegated → add the three above
4. Click **Grant admin consent** (if your tenant requires it)

### 2. Build

```bash
cd ~/code/personal/mcp-servers
npm run build:outlook
```

### 3. VS Code MCP Config

Already configured in `~/code/brain/config/vscode/mcp.json` (symlinked to VS Code settings). The entry uses the same client/tenant IDs with `OUTLOOK_MCP_` prefix env vars.

### 4. First Run

On first use, the server triggers MSAL device code auth — check the MCP server output for the login URL and code. After authenticating, the token is cached at `~/.mcp-outlook/token-cache.json`.

## Auth

MSAL device code flow with persistent token cache. Scopes: `Mail.ReadWrite`, `Mail.Send`, `User.Read`.

Token cache: `~/.mcp-outlook/token-cache.json` (atomic-write + corrupt-cache recovery).

To force re-auth, delete the cache file.

## Sending behavior

`outlook_send` defaults to **draft mode** — the message lands in your Drafts folder, not the recipient's inbox. Pass `draft: false` (after explicit user confirmation in the chat) to actually send.
