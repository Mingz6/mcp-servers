#!/usr/bin/env python3
"""Xiaohongshu (小红书) MCP Server — browse, search, interact with xiaohongshu.com.

Uses Playwright headless browser for automation.
Cookies persisted locally for session management.

Usage:
  .venv/bin/python mcp_server.py
"""

import logging

from mcp.server.fastmcp import FastMCP

from xhs_browser import XhsBrowser
from xhs_tools import register_tools

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("xiaohongshu-mcp")

mcp = FastMCP(
    "xiaohongshu",
    instructions=(
        "小红书 (Xiaohongshu/RED) social media automation. "
        "Tools: xhs_check_login, xhs_get_qrcode, xhs_search, xhs_get_post_detail, "
        "xhs_list_feed, xhs_like, xhs_favorite, xhs_comment, xhs_publish."
    ),
)

browser = XhsBrowser()
register_tools(mcp, browser)


def main():
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
