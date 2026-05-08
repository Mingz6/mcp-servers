# LinkedIn MCP Server

Read inbox, conversations, send messages, search people, and view profiles on LinkedIn.

## Auth

Uses [Patchright](https://github.com/AtheerAlhoworini/patchright) (stealth Playwright fork) with a persistent browser profile. First run requires a one-time headed login:

```bash
.venv/bin/python mcp_server.py --login
```

Log in manually (including 2FA), then the session is saved to `~/.linkedin-mcp/` and reused headlessly.

## Setup

```bash
cd packages/linkedin
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
patchright install chromium
```

## Tools

| Tool | Description |
|------|-------------|
| `linkedin_login` | Open headed browser for manual login |
| `linkedin_inbox` | List recent message conversations |
| `linkedin_conversation` | Read messages in a thread |
| `linkedin_send_message` | Send a message (requires `confirm_send=True`) |
| `linkedin_search_people` | Search people by keyword |
| `linkedin_profile` | View a profile by username |
| `linkedin_close` | Close browser session |

## MCP Config

Add to your VS Code `mcp.json`:

```json
{
  "servers": {
    "linkedin": {
      "command": "bash",
      "args": ["/path/to/mcp-servers/packages/linkedin/run.sh"]
    }
  }
}
```

## Session Management

- `--login` — Force a fresh login (opens browser)
- `--logout` — Delete saved session data

Sessions expire periodically. If tools report "not logged in", call `linkedin_login`.

## Safety

- `linkedin_send_message` requires `confirm_send=True` — without it, does a dry run
- No credentials stored in config files
- Session data is in `~/.linkedin-mcp/` with owner-only permissions
- LinkedIn ToS: automation is against their terms. Use responsibly for personal messaging only
