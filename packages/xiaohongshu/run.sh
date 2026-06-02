#!/bin/bash
# Run the xiaohongshu MCP server
cd "$(dirname "$0")"

if [ ! -d ".venv" ]; then
  python3 -m venv .venv
  .venv/bin/pip install -r requirements.txt
  .venv/bin/playwright install chromium
fi

exec .venv/bin/python mcp_server.py
