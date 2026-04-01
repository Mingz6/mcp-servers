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

## Conventions
- Each package has its own `package.json` and `tsconfig.json`
- MCP tool definitions follow the MCP SDK patterns
- Secrets via `.env` files (gitignored) or environment variables
