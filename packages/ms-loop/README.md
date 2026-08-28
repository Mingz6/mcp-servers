# ms-loop

Microsoft Loop MCP server — discovery and reads over Graph API, plus writes on personal
OneDrive. Writes to shared Loop workspaces are **not** supported; see Limitations.

## Tools

| Tool | Description |
|------|-------------|
| `loop_list_workspaces` | List Loop workspaces (containers) |
| `loop_list_files` | List Loop pages in a workspace |
| `loop_search` | Search Loop pages by keyword |
| `loop_read_by_url` | Read a Loop page by its share URL |
| `loop_read_by_id` | Read a Loop page by drive item ID |
| `loop_create` | Create a new Loop page |
| `loop_update` | Update an existing Loop page |
| `loop_rename` | Rename a Loop page |
| `loop_delete` | Delete a Loop page |

## Limitations — read this before using the write tools

Loop pages live in one of two places, and the API behaves very differently in each.

| | Loop **workspace** pages (SPE containers) | **Personal OneDrive** `.loop` files |
|---|---|---|
| Read | ~200-char search summary only | Full content |
| Create / Update / Rename / Delete | ❌ `403 accessDenied` | ✅ works |

Loop *workspace* pages — the unnamed drives from `loop_list_workspaces`, where shared team
content lives — are stored in SharePoint Embedded containers that this app registration has
no write access to. Every write returns `403 accessDenied`. Fixing that needs a tenant admin
to grant `FileStorageContainer.Selected` plus container-level access; it is not a code issue.

For anything this API can't do, drive the Loop web app in a browser instead — it runs as
Loop's own first-party app and can both read and write these pages. See the `loop-manager`
skill for the working browser recipe.

Also note: a file created or updated through `loop_create`/`loop_update` **cannot be read
back** via `loop_read_by_id`/`loop_read_by_url` — it fails with
`Graph GET 406 … Sandbox_FluidParser_InvalidSchemaPrague`. Verify with `loop_list_files`
or the browser instead.

## Setup

Uses delegated auth via MSAL (same pattern as teams-chat/outlook).

```bash
npm run build -w packages/ms-loop
```

## MCP Config

```jsonc
{
  "ms-loop": {
    "type": "stdio",
    "command": "${userHome}/code/personal/mcp-servers/packages/ms-loop/run.sh"
  }
}
```
