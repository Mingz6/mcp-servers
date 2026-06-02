# Xiaohongshu (小红书) MCP Server

Browse, search, and interact with xiaohongshu.com via headless browser automation.

## Tools

| Tool | Description |
|------|-------------|
| `xhs_check_login` | Check login status |
| `xhs_get_qrcode` | Get QR code for login (scan with app) |
| `xhs_delete_cookies` | Reset login state |
| `xhs_search` | Search posts by keyword with filters |
| `xhs_list_feed` | Get home feed |
| `xhs_get_post_detail` | Get post content, images, comments |
| `xhs_like` | Like/unlike a post |
| `xhs_favorite` | Favorite/unfavorite a post |
| `xhs_comment` | Post a comment |
| `xhs_publish` | Publish image content |

## Setup

```bash
chmod +x run.sh
./run.sh  # Creates venv, installs deps, installs Chromium
```

## MCP Config

Add to your VS Code MCP settings:

```json
{
  "xiaohongshu": {
    "command": "/Users/mingz/code/personal/mcp-servers/packages/xiaohongshu/run.sh",
    "transport": "stdio"
  }
}
```

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `XHS_HEADLESS` | `true` | Set to `false` for visible browser (debugging) |

## Cookie Storage

Cookies are persisted at `~/.config/xiaohongshu-mcp/cookies.json`.
Delete this file or use `xhs_delete_cookies` to reset login.

## Architecture

- `mcp_server.py` — Entry point, FastMCP setup
- `xhs_browser.py` — Playwright browser automation (login, search, interact)
- `xhs_tools.py` — MCP tool definitions wiring browser to MCP interface

Based on patterns from [xpzouying/xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp) (Go + go-rod), rebuilt in Python + Playwright for this monorepo.
