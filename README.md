# mcp-servers

All MCP servers in one place — custom and third-party. VS Code's `mcp.json` points here for everything.

## Server Registry

| Server | Type | What it does | Why I need it |
|--------|------|-------------|---------------|
| [teams-chat](packages/teams-chat/) | Custom (Node) | Read/send Teams messages, extract PR links | Standup, PR review requests, colleague replies |
| [outlook](packages/outlook/) | Custom (Node) | Read/send Outlook mail, search, mark read, attachments | Email triage during standup, PO reply detection |
| [applemail](packages/applemail/) | Custom (Node) | Read/send via local Apple Mail (SQLite + .emlx, AppleScript) | Personal mail across iCloud/Gmail/work without cloud auth |
| [imessage](packages/imessage/) | Custom (Python) | Read iMessage/SMS via Messages.app, send via AppleScript | Tenant/family chats |
| [brain-mcp](packages/brain-mcp/) | Custom (Node) | Search/read/link/update `~/code/brain` Markdown wiki | Agent-readable knowledge layer for Copilot and Claude Code |
| [discord-user](packages/discord-user/) | Custom (Node) | Read Discord servers/DMs via personal user token (read-only) | See community channels the bot can't access |
| [wechat](packages/wechat/) | Custom (Python) | Query WeChat chats, search messages, voice transcription (read-only) | Family/personal chat access from Copilot |
| [flywheel](packages/flywheel/) | Custom (Node) | Track reference repos, check updates, scout for new patterns | Daily self-improvement loop — knowledge aggregator for `/flywheel` skill |
| awesome-copilot | Third-party (Docker) | Microsoft MCP .NET sample — copilot instructions search | Load custom copilot instructions dynamically |
| context7 | Third-party (npx) | Fetch up-to-date library docs from Upstash | Get current API docs instead of outdated training data |

## Structure

```
mcp-servers/
├── packages/
│   ├── teams-chat/    # Custom — MS Teams via Graph API
│   │   └── run.sh     # Wrapper: loads nvm → exec node dist/index.js
│   ├── outlook/       # Custom — Outlook via Graph API
│   │   └── run.sh     # Wrapper: loads nvm → exec node dist/index.js
│   ├── brain-mcp/     # Custom — local brain Markdown wiki API
│   │   └── run.sh     # Wrapper: loads nvm → exec node dist/index.js
│   ├── wechat/        # Custom — WeChat via SQLCipher (read-only)
│   │   └── run.sh     # Wrapper: activates .venv → exec python mcp_server.py
│   └── imessage/      # Custom — iMessage/SMS via macOS Messages.app
│       └── run.sh     # Wrapper: activates .venv → exec python mcp_server.py
├── scripts/
│   └── npx-nvm.sh     # Wrapper: loads nvm before running npx (for third-party servers)
└── README.md           # This file — the single registry
```

## Quick Start

```bash
npm install        # installs Node workspaces (all *.ts packages)
npm run build      # builds all Node servers
```

For Python servers (wechat, imessage):
```bash
cd packages/wechat   # or packages/imessage
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

## VS Code Config

All servers are registered in your VS Code `mcp.json` (user or workspace level).
Each custom server uses a `run.sh` wrapper — no hardcoded Python/Node paths:

```jsonc
{
    "servers": {
        "teams-chat": {
            "type": "stdio",
            "command": "${userHome}/code/personal/mcp-servers/packages/teams-chat/run.sh",
            "env": {
                "TEAMS_MCP_CLIENT_ID": "your-client-id",
                "TEAMS_MCP_TENANT_ID": "your-tenant-id"
            }
        },
        "wechat": {
            "type": "stdio",
            "command": "${userHome}/code/personal/mcp-servers/packages/wechat/run.sh"
        },
        "brain": {
            "type": "stdio",
            "command": "${userHome}/code/personal/mcp-servers/packages/brain-mcp/run.sh",
            "env": {
                "BRAIN_MCP_ROOT": "${userHome}/code/brain"
            }
        }
    }
}
```

The wrappers handle runtime discovery (nvm for Node, .venv for Python) so upgrading
Node/Python versions won't break your MCP config.

## Adding a New Server

### Custom server
1. Create `packages/{name}/` with its own `package.json` (Node) or `requirements.txt` (Python)
2. Add a README.md in the package folder
3. Add to the registry table above
4. Add entry to VS Code's `mcp.json`

### Third-party server
1. Add entry to VS Code's `mcp.json` (use `scripts/npx-nvm.sh` for npx-based servers)
2. Add to the registry table above with upgrade notes

## Upgrading

| Server | How to upgrade |
|--------|---------------|
| teams-chat | `cd packages/teams-chat && npm update && npm run build` |
| outlook | `cd packages/outlook && npm update && npm run build` |
| brain-mcp | `cd packages/brain-mcp && npm update && npm run build` |
| wechat | `cd packages/wechat && .venv/bin/pip install --upgrade "mcp[cli]"` |
| awesome-copilot | Update the Docker image SHA in `mcp.json` |
| context7 | Automatic — `npx -y @upstash/context7-mcp` always pulls latest |

## Troubleshooting

**Server won't start in VS Code?**
- Check `mcp.json` paths are correct (use `${userHome}` not `~`)
- Run the `run.sh` manually to test: `./packages/teams-chat/run.sh`
- For Python servers: check `.venv` exists — the wrapper will tell you how to create it
- For npx servers: run `scripts/npx-nvm.sh -y <package>` manually to test

**Auth issues?**
- Teams/Outlook: run the auth-test script in the package → `npm run auth-test`
- WeChat: re-extract keys → `sudo python3 packages/wechat/extract_key.py`
