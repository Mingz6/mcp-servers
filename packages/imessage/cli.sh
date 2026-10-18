#!/usr/bin/env bash
# Sends one iMessage/SMS for ~/code/brain/outbox/outbox.py: cli.sh send --phone P [--service auto|sms|imessage] < body
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/.venv/bin/python" "$SCRIPT_DIR/mcp_server.py" "$@"
