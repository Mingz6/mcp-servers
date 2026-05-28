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
