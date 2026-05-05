#!/usr/bin/env bash
# Wrapper: loads nvm's default Node, then runs flywheel MCP server.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Source .env for secrets (GITHUB_TOKEN). Never committed — .gitignore covers it.
[[ -f "$SCRIPT_DIR/.env" ]] && set -a && source "$SCRIPT_DIR/.env" && set +a

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

exec node "$SCRIPT_DIR/dist/index.js"
