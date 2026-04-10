#!/usr/bin/env bash
# Wrapper: activates the local venv, then runs imessage MCP server.
# Used by mcp.json so rebuilding the venv won't break this server.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ ! -f "$SCRIPT_DIR/.venv/bin/python" ]]; then
    echo "ERROR: .venv not found. Run: cd $SCRIPT_DIR && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
    exit 1
fi

exec "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/mcp_server.py"
