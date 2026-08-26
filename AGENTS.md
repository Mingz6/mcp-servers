# mcp-servers — Agent Instructions

Personal MCP (Model Context Protocol) server monorepo. Each server in `packages/` is independently buildable.

See `.github/copilot-instructions.md` for full stack and conventions.

## Quick reference

- Language: TypeScript (ES2022), Node.js runtime
- Each package has its own `package.json`/`tsconfig.json`, plus a `run.sh` wrapper — mcp.json calls the wrapper, not the binary directly
- See brain repo's `copilot/instructions/mcp-server-design.instructions.md` for tool-boundary design rules
- No hardcoded personal data (account IDs, paths, credentials) in tracked files
