# mcp-servers — Personal MCP Server Monorepo

## Context
TypeScript monorepo for personal MCP (Model Context Protocol) servers. Each server lives in `packages/` and is independently buildable.

## Tech Stack
- Language: TypeScript (ES2022)
- Runtime: Node.js
- Auth: Microsoft Graph API (teams-chat, outlook)
- Build: npm workspaces, tsc

## Structure
- `packages/teams-chat/` — Teams message read/send/react via Graph API
- `packages/outlook/` — Outlook mail via Graph API
- `packages/wechat/` — WeChat message query via SQLCipher (read-only, Python)
- `packages/imessage/` — iMessage/SMS via macOS Messages.app (Python)

## Conventions
- Each package has its own `package.json` (Node) or `requirements.txt` (Python) and `tsconfig.json`
- Each package has a `run.sh` wrapper — mcp.json calls the wrapper, not the binary directly
- MCP tool definitions follow the MCP SDK patterns
- Secrets via `.env` files (gitignored) or environment variables passed through mcp.json `env` block
- No hardcoded personal data (account IDs, paths, credentials) in tracked files
