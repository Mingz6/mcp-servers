# Attributions & Hardening Notes

## Source

This package is a **read-only fork** of [olivier-motium/discord-user-mcp](https://github.com/olivier-motium/discord-user-mcp) (MIT license, ~5 stars, last updated Feb 2026). All credit for the original API client and tool-shape design goes to that author.

The relevant files we ported:

- `src/client.ts` — Discord API client
- `src/types.ts` — type definitions
- Tool surface (`list_guilds`, `list_channels`, `read_messages`, `search`, etc.)

## What we kept verbatim (or near-verbatim)

| Pattern | Source |
|---|---|
| `DiscordClient.request()` retry-on-429 with `retry_after` | upstream |
| API path layout (`/users/@me/guilds`, `/channels/{id}/messages` etc.) | upstream |
| `MessageQuery` cursor params (`before`/`after`/`around`) | upstream |
| `SearchQuery` shape (Discord's native search API surface) | upstream |
| Plain-text formatted output (no raw JSON) | upstream's "design choices" |
| Token-validation-on-startup pattern | upstream |
| Default-guild env var fallback | upstream (`DISCORD_DEFAULT_GUILD` → renamed `DISCORD_USER_DEFAULT_GUILD` to disambiguate from bot package) |

## What we hardened or removed

| Change | Why |
|---|---|
| **Removed all write methods** (`sendMessage`, `editMessage`, `deleteMessage`, `addReaction`, `createDM`, etc.) | Discord's selfbot detection primarily flags write patterns. Eliminates the highest-risk surface entirely. |
| **Removed write tools** (`discord_send_message`, `discord_send_dm`, `discord_react`, `discord_edit_message`, `discord_delete_message`) | Same — drafts only, user pastes manually |
| **Single `request()` → `get()` only** | Code can't accidentally regress to writing |
| **User-Agent changed** from `"DiscordBot (discord-user-mcp, 0.1.0)"` to a realistic Electron client UA | The original UA self-identifies as a bot — actively unsafe for selfbot use. We mimic what a real desktop client sends. |
| **Conservative pacing** — 250 ms minimum gap between requests | Belt-and-braces on top of 429 handling. Keeps polling pace below most automation heuristics. |
| **Renamed env vars** to `DISCORD_USER_TOKEN` / `DISCORD_USER_DEFAULT_GUILD` | Prevents collision with the bot-based `discord` package which uses `DISCORD_TOKEN`/`DISCORD_GUILD_ID` |
| **Added `discord_user_get_thread_context` tool** | Original had `find_message`/`get_replies`; we combined them into one tool optimized for the "draft a reply" workflow |
| **Tool name prefix** `discord_user_` instead of `discord_` | Disambiguates from sibling `discord` (bot) package in MCP host |
| **Startup banner explicitly states READ-ONLY** | Reminds the user (and the LLM, via stderr) that no writes are possible |

## What we did NOT port (yet)

These exist in the upstream but were skipped because they're either write tools or low-value:

- `discord_send_message`, `discord_send_dm` — write
- `discord_edit_message`, `discord_delete_message` — write
- `discord_react` — write
- `discord_pinned_messages` — could add later if needed (read-only, safe)
- `discord_list_threads`, `discord_get_replies` — could add later (read-only, safe)
- `discord_guild_info`, `discord_user_info`, `discord_find_message` — could add later

## Re-evaluate when

- Discord publishes any official rate-limit guidance for user accounts (unlikely)
- The upstream repo gets significant updates — cherry-pick safe (read) improvements, ignore writes
- You actually need a missing read-only tool — port it from upstream's `src/tools/`
