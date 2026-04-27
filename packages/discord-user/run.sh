#!/usr/bin/env bash
# Wrapper: loads nvm's default Node, then runs discord-user MCP server.
# READ-ONLY mode: never sends/edits/deletes/reacts. Use the bot package (`discord`) for writes.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Load .env if present (DISCORD_USER_TOKEN, optional DISCORD_USER_DEFAULT_GUILD)
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$SCRIPT_DIR/.env"
  set +a
fi

exec node "$SCRIPT_DIR/dist/index.js"
