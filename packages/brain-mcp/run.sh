#!/usr/bin/env bash
# Wrapper: loads nvm's default Node + AOAI secrets, then runs Brain MCP server.
#
# IMPORTANT: VS Code spawns MCP servers with a minimal env (no shell profile,
# no Keychain). This wrapper sources the same secrets file that post-commit
# hooks and the post-reboot rebuild use, so AZURE_OPENAI_* vars are available
# to embeddings.ts. Without this, semantic search silently falls back to
# keyword-only on every query.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

# Load AOAI keys (AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_EMBEDDING_DEPLOYMENT)
# Same source of truth used by brain post-commit hooks.
SECRETS_FILE="$HOME/code/brain/config/zsh.d/secrets.zsh"
if [ -f "$SECRETS_FILE" ]; then
  # shellcheck disable=SC1090
  source "$SECRETS_FILE"
fi

exec node "$SCRIPT_DIR/dist/index.js"
