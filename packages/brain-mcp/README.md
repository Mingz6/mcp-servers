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
| `brain_lint` | Lint Markdown pages for broken links, frontmatter issues, and structure problems. |
| `brain_link_source` | Link a captured source into one or more brain pages by adding cross-references. |
| `brain_context_pack` | Build a context bundle (page + linked sources + backlinks) for an agent task. |
| `brain_index` | Build or update the vector search index (full, incremental, or stats). |
| `brain_preflight` | Given a task, returns coupled actions that must be completed before done. |
| `brain_verify_completion` | Verify all coupled actions are satisfied before marking a task done. |
| `brain_get_relevant_instructions` | Find the most relevant .instructions.md files for a task via semantic search. |

## Config

Default root:

```bash
~/code/brain
```

Override when needed:

```bash
BRAIN_MCP_ROOT=/path/to/brain ./run.sh
```

### Indexing multiple repos

`brain_index` (and the CLI) can index more than just the primary root. Set
`BRAIN_INDEX_PATHS` to a comma-separated list of directories:

```bash
BRAIN_INDEX_PATHS=~/code/brain,~/code/life,~/code/crna ./run.sh
```

The primary root (`BRAIN_MCP_ROOT`) is always included and stays **unlabeled**
— every existing bare reference like `docs/foo.md` keeps resolving exactly as
before. Every other configured root is labeled with its directory basename
(`life`, `crna`, ...), and its pages are addressed as `{label}/{path}`, e.g.
`life/property/foo.md`. This keeps files with the same relative path in
different roots (two `README.md`s, for example) from colliding in the index.
`brain_read` and `brain_replace_text` understand these labeled paths
automatically; other tools (`brain_backlinks`, `brain_lint`, `brain_graph`,
`brain_create_page`, `brain_capture_source`) intentionally stay scoped to the
primary root, since they operate on the curated wiki's own link graph.

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
