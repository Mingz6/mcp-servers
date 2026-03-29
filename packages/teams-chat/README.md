# mcp-teams-chat

MCP server for Microsoft Teams chat — read messages, send replies, react to messages, and extract PR links for code review workflows. Uses Microsoft Graph API with device code flow for auth.

## Tools

| Tool | What it does |
|------|-------------|
| `teams_list_chats` | List recent chats with participant names and last message preview |
| `teams_find_chat` | Find a chat by participant name or chat topic |
| `teams_read_chat` | Read messages from a specific chat (includes message IDs for reactions) |
| `teams_whoami` | Check the currently authenticated user |
| `teams_get_pending_reviews` | Extract GitHub PR links from a chat (e.g., "Build Team PRs++"), filter out your own, deduplicate |
| `teams_react_to_message` | React to a message with any emoji (✅, ❌, 👍, etc.) |
| `teams_send_message` | Send a message to a chat |

## Setup

### 1. Register an Azure AD App

1. Go to [Azure Portal → App registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Fill in:
   - **Name**: `MCP Teams Chat` (or whatever you want)
   - **Supported account types**: "Accounts in this organizational directory only" (single tenant) — or multi-tenant if you need personal accounts too
   - **Redirect URI**: Select **Public client/native** → `https://login.microsoftonline.com/common/oauth2/nativeclient`
4. Click **Register**
5. Copy the **Application (client) ID** — you'll need this
6. Copy the **Directory (tenant) ID** if you want to lock it to your org

### 2. Add API Permissions

1. In your app registration, go to **API permissions**
2. Click **Add a permission** → **Microsoft Graph** → **Delegated permissions**
3. Add these:
   - `Chat.ReadWrite` (read chats + send messages)
   - `ChatMessage.Send` (send messages)
   - `User.Read` (identify the authenticated user)
4. Click **Grant admin consent** if you have admin access. If not, you'll be prompted to consent on first login — your tenant admin may need to approve the permissions.

### 3. Configure Environment

Set these env vars (e.g., in `~/.zsh.d/secrets.zsh`):

```bash
export TEAMS_MCP_CLIENT_ID="your-client-id-from-step-1"
export TEAMS_MCP_TENANT_ID="your-tenant-id"  # or "common" for multi-tenant
```

### 4. Build

```bash
cd ~/code/personal/mcp-teams-chat
npm install
npm run build
```

### 5. Test Auth

```bash
npm run auth-test
```

First run opens a device code prompt — it'll print a URL and code. Open the URL in a browser, enter the code, sign in. After that, the refresh token is cached at `~/.mcp-teams-chat/token-cache.json` and you won't need to sign in again until it expires.

### 6. Add to VS Code

Add to your MCP config (`~/.vscode/mcp.json` or workspace settings).

> **nvm users:** VS Code doesn't inherit your shell's nvm setup, so use the absolute path to `node`. Find it with `which node` in your terminal.

```json
{
  "servers": {
    "teams-chat": {
      "command": "/Users/you/.nvm/versions/node/v22.17.1/bin/node",
      "args": ["/Users/you/code/personal/mcp-teams-chat/dist/index.js"],
      "env": {
        "TEAMS_MCP_CLIENT_ID": "your-client-id",
        "TEAMS_MCP_TENANT_ID": "your-tenant-id"
      }
    }
  }
}
```

## Usage in Copilot

Once connected, Copilot can call these tools directly:

- "Read my recent Teams chats" → `teams_list_chats`
- "Find my chat with Kelsey" → `teams_find_chat` → `teams_read_chat`
- "What did Chris say in our last conversation?" → `teams_find_chat` → `teams_read_chat`
- "Any PRs to review?" → `teams_find_chat` → `teams_get_pending_reviews`
- "React ✅ to that message" → `teams_react_to_message`
- "Send a message in that chat" → `teams_send_message`

## Troubleshooting

**"AADSTS65001: The user or administrator has not consented"**
Your tenant admin needs to grant consent for `Chat.Read`. Ask IT to approve the app, or try with a personal Microsoft account first.

**"AADSTS700016: Application not found"**
Double-check `TEAMS_MCP_CLIENT_ID` matches your app registration.

**Token expired / auth loop**
Delete the cache and re-authenticate:
```bash
rm ~/.mcp-teams-chat/token-cache.json
npm run auth-test
```

**MCP server hangs on startup (no output)**
The device code flow is waiting for sign-in but the prompt is hidden in MCP's stderr. Run `npm run auth-test` manually first to complete the sign-in, then restart the MCP server.

**`stripHtml` losing URLs from messages**
Teams wraps links in `<a href="...">` tags. The server extracts `href` URLs before stripping HTML so PR links and other URLs are preserved in plain text output.

## Security Notes

- Tokens are cached locally at `~/.mcp-teams-chat/token-cache.json` (file permissions: owner-only 600)
- The cache directory has 700 permissions
- No credentials are stored in the project — only OAuth refresh tokens in the cache file
- Write operations: `Chat.ReadWrite` + `ChatMessage.Send` — can send messages and react to messages in chats the user is a member of
