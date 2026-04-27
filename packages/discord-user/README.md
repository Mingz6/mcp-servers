# mcp-discord-user (read-only personal Discord assistant)

**Read-only MCP server for Discord using your personal user token.** Lets an LLM see everything you see in Discord — server channels, DMs, group DMs — and draft replies. **It never sends, edits, deletes, or reacts.** You always paste replies manually.

> ⚠️ **Read this whole README before using.** Using a user token for automation is against Discord's Terms of Service. This package minimizes risk by being **read-only**, but the risk is not zero.

## Why this exists

The bot-based [`discord`](../discord/) package is officially supported but only sees servers where you can invite the bot. For server channels you don't control, that's not enough. This package fills the gap by reading as you — same access as your Discord client.

## Tools (7, all read-only)

| Tool | What it does |
|---|---|
| `discord_user_whoami` | Confirm token works, show your account |
| `discord_user_list_guilds` | List all servers you're in |
| `discord_user_list_channels` | List channels in a server |
| `discord_user_list_dms` | List recent DM/group DM conversations |
| `discord_user_read_messages` | Read messages from any channel or DM |
| `discord_user_get_thread_context` | Fetch a target message + N messages before for reply context |
| `discord_user_search` | Discord's native search API (content/author/channel/attachment filters) |

There are no `send_message`, `edit_message`, `delete_message`, or `add_reaction` tools. Intentionally. **Drafts only.**

## Risk model — read this

| Risk | Severity | Mitigation in this package |
|---|---|---|
| ToS violation (account ban) | High in theory, low in practice for read-only | Zero write traffic, conservative pacing (250 ms min gap), realistic User-Agent matching desktop client |
| Token leak | Critical | `.env` gitignored, never logged, `.env.example` does not contain a real value |
| Compromised LLM exfiltrates token | High | Token only in env var, never echoed in tool output. Still: don't run untrusted MCP servers alongside this one |
| Multi-account confusion | Medium | `discord_user_whoami` on every session start (logs to stderr) |

**Selfbot detection mainly fires on write patterns** (rapid sends, mass joins, reaction floods). Read traffic at human pace looks like a Discord client. That said: **don't use this on an account you can't afford to lose.** Use a secondary account if possible.

## Setup

### 1. Get your user token

1. Open <https://discord.com/app> in a browser (not the desktop app).
2. Open DevTools (`Cmd+Opt+I`).
3. Go to the **Network** tab.
4. Click any channel — you'll see requests to `discord.com/api/v10/...`.
5. Click any of those requests → **Headers** → **Request Headers** → copy the value of `Authorization`.

This token is a JWT-like string starting with letters/numbers. **Treat it like a password.**

If Discord ever logs you out (password change, etc.), the token rotates and you'll need to re-extract.

### 2. Configure

```bash
cp .env.example .env
# edit .env: paste DISCORD_USER_TOKEN, optionally set DISCORD_USER_DEFAULT_GUILD
```

### 3. Build

```bash
npm install
npm run build
```

### 4. Wire into VS Code mcp.json

```json
{
  "servers": {
    "discord-user": {
      "type": "stdio",
      "command": "${userHome}/code/personal/mcp-servers/packages/discord-user/run.sh"
    }
  }
}
```

Reload VS Code window. The 7 read-only tools will appear.

## Typical workflow

> **You:** "What's been happening on my Discord today?"

Assistant calls `discord_user_list_guilds` → for the active ones, `discord_user_list_channels` → reads recent messages → summarizes.

> **You:** "Reply to that thing Alice said in #dev-chat earlier"

Assistant calls `discord_user_search` (author=alice) → finds the message → calls `discord_user_get_thread_context` → drafts a reply → shows it to you.

> **You:** Copy the draft, paste into Discord, send manually.

Done. No automated writes, ever.

## What this package will NOT do

- Send messages on your behalf
- React to messages
- Edit/delete anything
- Join servers
- Do anything that changes server state

If you want write capabilities, use the bot-based [`discord`](../discord/) package and accept that messages will be posted under the bot's name.

## See also

- [ATTRIBUTIONS.md](./ATTRIBUTIONS.md) — what was borrowed and what was hardened
- [`../discord/`](../discord/) — bot-based companion (full read/write, but only invited servers)
