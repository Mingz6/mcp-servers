#!/usr/bin/env bash
# Wrapper: activates the local venv, then runs telegram MCP server.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$SCRIPT_DIR/.venv/bin/python" ]]; then
    echo "ERROR: .venv not found. Run: cd $SCRIPT_DIR && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

# Load .env if present
if [[ -f "$SCRIPT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
    set +a
fi

exec "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/mcp_server.py"
