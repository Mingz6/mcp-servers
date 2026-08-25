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
copy of its `market.db`, which nothing currently keeps in sync automatically. Every
tool call checks how old that local copy is (based on the latest
`worker_runs.started_at`, not file mtime — a file can be "touched" without its data
actually being current):

- **< 24h old**: served as-is, no warning.
- **24h–72h old**: served with a warning prepended that the data is out of date.
- **>= 72h old**: the tool call fails outright. Data that old has no value and is
  never silently returned as if it were current.

This is detect-and-report only for now — it does **not** attempt to auto-refresh
from the Mac Mini (deliberately deferred). To manually refresh the local copy:

```bash
scp mingz@10.64.21.53:code/personal/worker-center/data/market.db "$WORKER_CENTER_DB"
```

## Configuration

Set the `WORKER_CENTER_DB` environment variable to the path of `market.db`:

```bash
export WORKER_CENTER_DB="$HOME/code/personal/worker-center/data/market.db"
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
