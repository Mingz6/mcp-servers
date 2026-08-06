# IMAP Mail MCP Server

Generic IMAP email access — one codebase, deploy once per account via env vars.
Built for accounts that don't have (or aren't worth the setup ceremony of) a
provider-specific OAuth API: Gmail via app password, QQ Mail, or any other
IMAP-capable provider. For Microsoft/Outlook accounts, use the `outlook`
package instead (Graph API — richer and no password handling required).

## Tools

| Tool | Description |
|------|-------------|
| `imap_inbox` | List recent emails (optionally unread-only) |
| `imap_search` | Search by keyword across subject, sender, body |
| `imap_read` | Read full email content by UID |
| `imap_attachments` | List attachments on a message |
| `imap_download_attachment` | Download an attachment to a local temp file |
| `imap_mark_read` | Mark messages as read by UID |

No `imap_send` yet — this package was built to solve *reading* reliably (the
Apple Mail local-cache sync gap). Sending would need SMTP + its own credential
handling; add it later if actually needed.

## Why IMAP instead of each provider's own API

Gmail has a full REST API; QQ Mail does not (Tencent has no public OAuth mail
API for third-party apps). Building a bespoke integration per provider means
re-doing OAuth/API work for each one. Plain IMAP + an app password works
identically across both, and across anything else with an IMAP server, using
this exact same package. Trade-off: no labels/threads, weaker search than a
provider's native search — fine for "what did this email say," not a full
inbox-management replacement.

## Adding an account

1. Get an app password / authorization code from the provider (not your normal login password):
   - **Gmail**: requires 2-Step Verification enabled first, then Google Account → Security → App passwords → generate one scoped to "Mail".
   - **QQ Mail**: Settings (设置) → Account (账户) → POP3/IMAP/SMTP service → enable it → generate an authorization code (授权码).
2. Store the password as a real environment variable (same mechanism as `NOTION_TOKEN`/`AZURE_DEVOPS_EXT_PAT` elsewhere in this repo's `mcp.json`) — never put the raw password directly in `mcp.json`, which is a tracked file.
3. Add an entry to `~/code/brain/config/vscode/mcp.json`:

```jsonc
"gmail": {
  "type": "stdio",
  "command": "${userHome}/code/personal/mcp-servers/packages/imap-mail/run.sh",
  "env": {
    "IMAP_MCP_HOST": "imap.gmail.com",
    "IMAP_MCP_USER": "you@gmail.com",
    "IMAP_MCP_PASSWORD": "${env:GMAIL_APP_PASSWORD}",
    "IMAP_MCP_LABEL": "Gmail"
  }
}
```

4. Reload VS Code, then call any `imap_*` tool once to confirm the connection (a clear error is returned if the password/host is wrong — there's no interactive device-code flow to complete, unlike `outlook`).

Each mcp.json entry is a fully separate stdio process — running Gmail and QQ Mail simultaneously just means two entries pointing at the same `run.sh` with different env blocks. No shared state between them (unlike the Outlook package, there's no on-disk token cache to collide over).

## Common IMAP hosts

| Provider | IMAP host | Port |
|---|---|---|
| Gmail | imap.gmail.com | 993 |
| QQ Mail | imap.qq.com | 993 |
| Outlook/Hotmail (if not using the Graph-based `outlook` package) | outlook.office365.com | 993 |
| iCloud | imap.mail.me.com | 993 |
