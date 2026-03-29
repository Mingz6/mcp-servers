# mcp-servers

Personal MCP servers monorepo. Each server lives in `packages/` and is independently buildable.

## Servers

| Package | What it does |
|---------|-------------|
| [teams-chat](packages/teams-chat/) | Read, send, and react to Microsoft Teams messages via Graph API. Includes PR link extraction for code review workflows. |

## Quick Start

```bash
npm install        # installs all workspaces
npm run build      # builds all servers
```

## Adding a New Server

1. Create `packages/{name}/` with its own `package.json` and `tsconfig.json`
2. Add a build script: `"build": "tsc"`
3. Add to the table above
4. Register in `~/code/brain/config/vscode/mcp.json`

## Structure

```
packages/
├── teams-chat/     ← Microsoft Teams chat reader
└── {next-server}/  ← your next MCP server goes here
```
