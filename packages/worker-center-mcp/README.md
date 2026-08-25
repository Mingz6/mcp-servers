# worker-center-mcp

MCP server for querying the worker-center `market.db` database. Read-only access to worker status, price history, job pipeline, notifications, and more.

## Tools

| Tool | Purpose |
|------|---------|
| `worker_status` | Get recent run status for all or specific workers |
| `price_history` | Query price change history for tracked products |
| `price_alerts` | Get recent price drops / notable changes |
| `listings` | Query active marketplace listings |
| `job_pipeline` | View job application pipeline status |
| `worker_notifications` | Recent alert delivery log |
| `worker_query` | Freeform read-only SQL for advanced queries |

## Freshness

worker-center runs on the Mac Mini (since 2026-07-15); this server reads a **local**
copy of its `market.db`. Every tool call checks how old that local copy is (based on
the latest `worker_runs.started_at`, not file mtime — a file can be "touched" without
its data actually being current):

- **< 24h old**: served as-is, no network call.
- **24h–72h old**: one refresh attempt from the Mac Mini (`scp`, throttled to once per
  10 minutes so repeated calls don't hammer a flaky connection), then served either
  way — with a warning prepended if the refresh failed, or if it succeeded but the
  Mac Mini's *own* data is itself still stale (a real signal something's wrong there,
  not just a local caching gap).
- **>= 72h old, even after a refresh attempt**: the tool call fails outright. Data
  that old has no value and is never silently returned as if it were current.

Requires passwordless SSH (key-based) to the Mac Mini already set up — the same
prerequisite `scripts/deploy-to-mini.sh` in the `worker-center` repo relies on.

## Configuration

Set the `WORKER_CENTER_DB` environment variable to the path of `market.db`:

```bash
export WORKER_CENTER_DB="$HOME/code/personal/worker-center/data/market.db"
```

Optional overrides for the Mac Mini refresh target (defaults match
`scripts/deploy-to-mini.sh` in the `worker-center` repo):

```bash
export WORKER_CENTER_REMOTE_USER="mingz"
export WORKER_CENTER_REMOTE_HOST="10.64.21.53"
export WORKER_CENTER_REMOTE_DB_PATH="code/personal/worker-center/data/market.db"
```

## Usage

```bash
npm run build
npm start
```

Or via mcp.json:
```json
{
  "worker-center": {
    "command": "/path/to/mcp-servers/packages/worker-center-mcp/run.sh",
    "env": {
      "WORKER_CENTER_DB": "/Users/you/code/personal/worker-center/data/market.db"
    }
  }

}
```
