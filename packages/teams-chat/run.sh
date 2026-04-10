#!/usr/bin/env bash
# Wrapper: loads nvm's default Node, then runs teams-chat MCP server.
# Used by mcp.json so upgrading Node via nvm won't break this server.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

exec node "$SCRIPT_DIR/dist/index.js"
