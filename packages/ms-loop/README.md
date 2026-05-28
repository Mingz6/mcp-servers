# ms-loop

Microsoft Loop MCP server — CRUD operations on Loop pages via Graph API.

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
