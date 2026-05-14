#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Load nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Load env vars if present
[ -f .env ] && set -a && source .env && set +a

exec node mcp_server.mjs
