# Outlook MCP Server

Read-only Outlook email access via Microsoft Graph API. Exposes 3 tools for listing, searching, and reading emails.

## Tools

| Tool | Description |
|------|-------------|
| `outlook_inbox` | List recent emails (optionally unread-only) |
| `outlook_search` | Search by keyword across subject, body, sender |
| `outlook_read` | Read full email content by message ID |

## Setup

### 1. Azure AD App Registration

Uses the same app registration as `teams-chat`: `e0cb26cf-75e6-44ba-ad09-f2de9b134143`.

Add the `Mail.Read` **delegated** permission:

1. Go to [Azure Portal → App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Open app `e0cb26cf-75e6-44ba-ad09-f2de9b134143`
3. **API permissions** → Add a permission → Microsoft Graph → Delegated → `Mail.Read`
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

MSAL device code flow with persistent token cache. Scopes: `Mail.Read`, `User.Read`.

Token cache: `~/.mcp-outlook/token-cache.json`

To force re-auth, delete the cache file.
