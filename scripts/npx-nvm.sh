#!/usr/bin/env bash
# Wrapper: loads nvm's default Node, then runs npx.
# Used by mcp.json so upgrading Node via nvm won't break MCP servers.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
exec npx "$@"
