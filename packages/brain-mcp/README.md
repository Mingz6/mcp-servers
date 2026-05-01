# brain-mcp

Local MCP server for `~/code/brain`. It gives Copilot, Claude Code, and other agents a deterministic API for the Markdown wiki layer that humans can browse in VS Code or Obsidian.

## Tools

| Tool | Purpose |
|------|---------|
| `brain_search` | Search Markdown pages with simple ranked snippets. |
| `brain_read` | Read one Markdown page by absolute path or brain-relative path. |
| `brain_backlinks` | Find pages that link to a target page. |
| `brain_graph` | Return a local or global Markdown link graph as JSON. |
| `brain_create_page` | Create a new Markdown page inside the brain root. |
| `brain_replace_text` | Replace one exact text block in a page. |
| `brain_capture_source` | Capture an external or local source into `learning/sources/`. |

## Config

Default root:

```bash
~/code/brain
```

Override when needed:

```bash
BRAIN_MCP_ROOT=/path/to/brain ./run.sh
```

## Build And Test

```bash
npm install
npm run build -w packages/brain-mcp
npm test -w packages/brain-mcp
```

## VS Code Graph View

This server is the agent API. For the human graph UI, open Markdown Preview Enhanced's command:

```text
Markdown Preview Enhanced: Open Graph View
```

The graph view reads the same Markdown links that `brain_graph` exposes to agents.
