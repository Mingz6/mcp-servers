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
cd /path/to/mcp-servers
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

## Multiple accounts (e.g. personal outlook.com alongside work M365)

This server reads its client ID, tenant, and cache dir entirely from env vars, so a second
mailbox just needs a second `mcp.json` entry pointing at the same `run.sh` with different env:

```jsonc
"outlook-personal": {
  "type": "stdio",
  "command": "${userHome}/code/personal/mcp-servers/packages/outlook/run.sh",
  "env": {
    "OUTLOOK_MCP_CLIENT_ID": "<separate app registration id>",
    "OUTLOOK_MCP_TENANT_ID": "consumers",       // personal Microsoft accounts only; use "common" for either
    "OUTLOOK_MCP_CACHE_DIR": "${userHome}/.mcp-outlook-personal"
  }
}
```

**Why a separate Azure AD app is required**: the work app (`Ming Dev Tools`, shared with
`teams-chat`) has `signInAudience: AzureADMyOrg` — locked to one work tenant, personal
Microsoft accounts (like a plain outlook.com/hotmail.com address) cannot sign into it at all.
A personal-account app needs `signInAudience: AzureADandPersonalMicrosoftAccount` (or
`PersonalMicrosoftAccount`) instead:

```bash
az ad app create --display-name "Ming Personal Mail MCP" \
  --sign-in-audience AzureADandPersonalMicrosoftAccount --is-fallback-public-client true
az ad sp create --id <new appId>
az ad app permission add --id <new appId> --api 00000003-0000-0000-c000-000000000000 \
  --api-permissions 024d486e-b451-40bb-833d-3e66d98c5c73=Scope e383f46e-2787-4529-855e-0e479a3ffac0=Scope e1fe6dd8-ba31-4d61-89e7-88639da4683d=Scope
```

`OUTLOOK_MCP_CACHE_DIR` is required whenever you run a second instance — without it both
instances share `~/.mcp-outlook/token-cache.json` and each sign-in clobbers the other's cached
token. First run after adding a new instance still needs an interactive device-code sign-in
(reload/restart VS Code to pick up the new server, then call any tool — it prints a URL + code).

**Why this fixes the Apple Mail body-sync gotcha**: Graph API returns the full message body
directly in the API response (no local cache/sync layer), unlike `applemail_read` which depends
on Mail.app having already fetched and persisted that specific message locally.

## Sending behavior

`outlook_send` defaults to **draft mode** — the message lands in your Drafts folder, not the recipient's inbox. Pass `draft: false` (after explicit user confirmation in the chat) to actually send.
