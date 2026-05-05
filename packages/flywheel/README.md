# mcp-flywheel

MCP server for flywheel knowledge aggregation — repo tracking, change detection, and growth-score discovery.

## Tools

| Tool | Purpose |
|------|---------|
| `flywheel_list_repos` | List all tracked repos (active + retired sections) |
| `flywheel_check_updates` | Check repos for new commits since last check |
| `flywheel_get_changes` | Get detailed diff/changelog for a specific repo |
| `flywheel_add_repo` | Add a new GitHub repo to the watchlist |
| `flywheel_remove_repo` | Hard-delete a repo (prefer retire) |
| `flywheel_retire_repo` | Retire a repo — stop checking, keep history |
| `flywheel_scout` | Full scout cycle: check all repos + discover new ones |
| `flywheel_search` | Search GitHub ranked by growth score (stars/day) |

## Setup

Requires `GITHUB_TOKEN` env var with `public_repo` scope.

```bash
npm run build
# Add to mcp.json or run directly:
GITHUB_TOKEN=ghp_xxx node dist/index.js
```

## Config

Watchlist stored at `~/.config/flywheel/repos.json`. The server manages this file — add/remove/retire repos via the MCP tools.

## Growth Score

`growth_score = total_stars / days_since_creation`

Filters out repos younger than 7 days (noise) and below 50 stars (weekend projects). Both thresholds are configurable per-search.
