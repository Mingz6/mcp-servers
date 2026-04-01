# mcp-servers

All MCP servers in one place — custom and third-party. VS Code's `mcp.json` points here for everything.

## Server Registry

| Server | Type | What it does | Why I need it |
|--------|------|-------------|---------------|
| [teams-chat](packages/teams-chat/) | Custom (Node) | Read/send Teams messages, extract PR links | Standup, PR review requests, colleague replies |
| [outlook](packages/outlook/) | Custom (Node) | Read Outlook emails, search, mark read | Email triage during standup, PO reply detection |
| [wechat](packages/wechat/) | Custom (Python) | Query WeChat chats, search messages, send | Family/personal chat access from Copilot |
| awesome-copilot | Third-party (Docker) | Microsoft MCP .NET sample — copilot instructions search | Load custom copilot instructions dynamically |
| context7 | Third-party (npx) | Fetch up-to-date library docs from Upstash | Get current API docs instead of outdated training data |

## Structure

```
mcp-servers/
├── packages/
│   ├── teams-chat/    # Custom — MS Teams via Graph API
│   ├── outlook/       # Custom — Outlook via Graph API
│   └── wechat/        # Custom — WeChat via SQLCipher + keyboard automation
├── scripts/
│   └── npx-nvm.sh     # Wrapper: loads nvm before running npx (for third-party servers)
└── README.md           # This file — the single registry
```

## Quick Start

```bash
npm install        # installs Node workspaces (teams-chat, outlook)
npm run build      # builds all Node servers
```

For wechat (Python):
```bash
cd packages/wechat
python3 -m venv .venv
.venv/bin/pip install "mcp[cli]"
```

## VS Code Config

All servers are registered in `~/Library/Application Support/Code/User/mcp.json`.
That file should only contain server entries — all paths point back into this repo.

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
| wechat | `cd packages/wechat && .venv/bin/pip install --upgrade "mcp[cli]"` |
| awesome-copilot | Update the Docker image SHA in `mcp.json` |
| context7 | Automatic — `npx -y @upstash/context7-mcp` always pulls latest |

## Troubleshooting

**Server won't start in VS Code?**
- Check `mcp.json` paths are correct (use `${userHome}` not `~`)
- For Node servers: verify `which node` matches the path in `mcp.json`
- For npx servers: run `scripts/npx-nvm.sh -y <package>` manually to test
- For Python servers: verify the `.venv/bin/python` path exists

**Auth issues?**
- Teams/Outlook: run the auth-test script in the package → `npm run auth-test`
- WeChat: re-extract keys → `sudo python3 packages/wechat/extract_key.py`
