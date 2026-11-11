# mcp-servers — Personal MCP Server Monorepo

## Context
TypeScript and Python monorepo for personal MCP (Model Context Protocol) servers. Each server lives in `packages/` and is independently buildable.

## Tech Stack
- Languages: TypeScript (ES2022, strict) and Python 3.12; whatsapp is plain JavaScript
- Runtime: Node.js 22+ (CI runs 22 and 24)
- Auth: Microsoft Graph through the shared `packages/msgraph-auth` (msgraph, outlook, teams-chat, ms-loop)
- Build: npm workspaces, tsc; `npm test` runs every package's tests, `npm run demo` smoke-tests brain-mcp

## Structure
- One package per server in `packages/`; the server table in `README.md` lists each one with its status
- `examples/sample-brain/` is made-up content for the demo; `docs/demo.tape` re-records `docs/demo.gif` (vhs)
- CI: `.github/workflows/ci.yml` (actions pinned to commit SHAs)

## Conventions
- Each package has its own `package.json` (Node) or `requirements.txt` (Python) and `tsconfig.json`
- Each package has a `run.sh` wrapper — mcp.json calls the wrapper, not the binary directly
- MCP tool definitions follow the MCP SDK patterns
- Secrets via `.env` files (gitignored) or environment variables passed through mcp.json `env` block
- No hardcoded personal data (account IDs, paths, credentials) in tracked files
