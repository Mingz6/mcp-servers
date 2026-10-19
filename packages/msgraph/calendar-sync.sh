#!/usr/bin/env bash
# Loads nvm's Node and runs the one-way work-calendar copy (src/calendar-sync.ts). launchd calls
# it with TEAMS_MCP_CLIENT_ID / TEAMS_MCP_TENANT_ID already in the environment.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

exec node "$SCRIPT_DIR/dist/calendar-sync.js" "$@"
