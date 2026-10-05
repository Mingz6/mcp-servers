#!/usr/bin/env bash
# Loads nvm's Node and runs the unattended sender (src/cli.ts) for ~/code/brain/scripts/send-queue.py.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

exec node "$SCRIPT_DIR/dist/cli.js" "$@"
