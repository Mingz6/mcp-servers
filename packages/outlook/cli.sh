#!/usr/bin/env bash
# Loads nvm's Node and the account settings in .env (untracked, same values as the outlook-mingz6
# entry in mcp.json), then runs the unattended personal-mail sender (src/cli.ts) for outbox.py.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
if [ -f "$SCRIPT_DIR/.env" ]; then
    set -a
    \. "$SCRIPT_DIR/.env"
    set +a
fi

exec node "$SCRIPT_DIR/dist/cli.js" "$@"
