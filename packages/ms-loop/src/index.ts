import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    createLoopFile,
    deleteLoopFile,
    getLoopByItemId,
    getLoopByShareUrl,
    listLoopContainers,
    listLoopFilesInDrive,
    renameLoopFile,
    searchLoopFiles,
    updateLoopFile,
} from "./loop.js";

const server = new McpServer({
  name: "ms-loop",
  version: "1.0.0",
});

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

// --- READ tools ---

server.tool(
  "loop_list_workspaces",
  "List all Microsoft Loop workspaces (drives) you have access to. Returns driveId, name, and file count for each.",
  {},
  async () => {
    try {
      const workspaces = await listLoopContainers();
      if (workspaces.length === 0) {
        return { content: [{ type: "text", text: "No Loop workspaces found." }] };
      }
      const text = workspaces
        .map(
          (ws) =>
            `• ${ws.name} (driveId: ${ws.driveId}, ${ws.loopFileCount} files)${ws.webUrl ? `\n  ${ws.webUrl}` : ""}`
        )
        .join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_list_files",
  "List all Loop files (.loop/.fluid) in a specific drive/workspace.",
  {
    driveId: z.string().describe("The drive ID of the workspace"),
    path: z
      .string()
      .optional()
      .describe("Subfolder path (default: root). Use 'root' or 'Folder/Subfolder'."),
  },
  async ({ driveId, path }) => {
    try {
      const files = await listLoopFilesInDrive(driveId, path);
      if (files.length === 0) {
        return { content: [{ type: "text", text: "No Loop files found in this drive." }] };
      }
      const text = files
        .map(
          (f) =>
            `• ${f.name} (id: ${f.id}, modified: ${f.lastModified}, size: ${f.size}B)\n  ${f.webUrl}`
        )
        .join("\n");
      return { content: [{ type: "text", text: `${files.length} Loop files:\n${text}` }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_search",
  "Search for Loop files by keyword across all workspaces. Returns file metadata and a content summary snippet.",
  {
    query: z.string().describe("Search query (searches file names and content)"),
  },
  async ({ query }) => {
    try {
      const files = await searchLoopFiles(query);
      if (files.length === 0) {
        return { content: [{ type: "text", text: `No Loop files found for "${query}".` }] };
      }
      const text = files
        .map(
          (f) => {
            let entry = `• ${f.name} (driveId: ${f.driveId}, id: ${f.id}, modified: ${f.lastModified})\n  ${f.webUrl}`;
            if (f.summary) {
              entry += `\n  Summary: ${f.summary}`;
            }
            return entry;
          }
        )
        .join("\n");
      return { content: [{ type: "text", text: `${files.length} results:\n${text}` }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_read_by_url",
  "Read a Loop file's content given its sharing URL. For Loop workspace files (SPE containers), returns a search-indexed summary. For OneDrive-stored .loop files, attempts full HTML content.",
  {
    shareUrl: z.string().describe("The full sharing URL of the Loop file"),
    includeText: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include plain-text version (default true)"),
  },
  async ({ shareUrl, includeText }) => {
    try {
      const content = await getLoopByShareUrl(shareUrl, includeText);
      const parts = [
        `**${content.name}**`,
        `Modified: ${content.lastModified}`,
        `URL: ${content.webUrl}`,
        `DriveId: ${content.driveId} | ItemId: ${content.itemId}`,
        `Content source: ${content.contentSource}`,
        "",
      ];
      if (content.contentSource === "unavailable") {
        parts.push("⚠️ Content not available — Loop workspace files in SPE containers require FileStorageContainer.Selected permission.");
        parts.push("Use loop_search to find content summaries instead.");
      } else if (content.text) {
        parts.push("--- Content ---", content.text);
      } else {
        parts.push("--- HTML ---", content.html);
      }
      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_read_by_id",
  "Read a Loop file's content using driveId and itemId. For Loop workspace files (SPE containers), returns a search-indexed summary. For OneDrive-stored .loop files, attempts full HTML content.",
  {
    driveId: z.string().describe("The drive ID containing the Loop file"),
    itemId: z.string().describe("The item ID of the Loop file"),
    includeText: z
      .boolean()
      .optional()
      .default(true)
      .describe("Include plain-text version (default true)"),
  },
  async ({ driveId, itemId, includeText }) => {
    try {
      const content = await getLoopByItemId(driveId, itemId, includeText);
      const parts = [
        `**${content.name}**`,
        `Modified: ${content.lastModified}`,
        `URL: ${content.webUrl}`,
        `Content source: ${content.contentSource}`,
        "",
      ];
      if (content.contentSource === "unavailable") {
        parts.push("⚠️ Content not available — Loop workspace files in SPE containers require FileStorageContainer.Selected permission.");
        parts.push("Use loop_search to find content summaries instead.");
      } else if (content.text) {
        parts.push("--- Content ---", content.text);
      } else {
        parts.push("--- HTML ---", content.html);
      }
      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- CREATE tools ---

server.tool(
  "loop_create",
  "Create a new Loop file with HTML content in a specific workspace drive.",
  {
    driveId: z.string().describe("The drive ID to create the file in"),
    fileName: z
      .string()
      .describe("Name for the new Loop file (with or without .loop extension)"),
    htmlContent: z
      .string()
      .describe("HTML content for the Loop file"),
    parentPath: z
      .string()
      .optional()
      .describe("Optional parent folder path (default: drive root)"),
  },
  async ({ driveId, fileName, htmlContent, parentPath }) => {
    try {
      const result = await createLoopFile(driveId, fileName, htmlContent, parentPath);
      return {
        content: [
          {
            type: "text",
            text: `Created: ${result.name}\nID: ${result.id}\nDrive: ${result.driveId}\nURL: ${result.webUrl}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- UPDATE tools ---

server.tool(
  "loop_update",
  "Replace the content of an existing Loop file with new HTML content.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to update"),
    htmlContent: z.string().describe("New HTML content to replace the file with"),
  },
  async ({ driveId, itemId, htmlContent }) => {
    try {
      const result = await updateLoopFile(driveId, itemId, htmlContent);
      return {
        content: [
          {
            type: "text",
            text: `Updated: ${result.name}\nURL: ${result.webUrl}\nModified: ${result.lastModified}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "loop_rename",
  "Rename an existing Loop file.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to rename"),
    newName: z.string().describe("The new name (with or without .loop extension)"),
  },
  async ({ driveId, itemId, newName }) => {
    try {
      const result = await renameLoopFile(driveId, itemId, newName);
      return {
        content: [
          {
            type: "text",
            text: `Renamed to: ${result.name}\nURL: ${result.webUrl}`,
          },
        ],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- DELETE tool ---

server.tool(
  "loop_delete",
  "Delete a Loop file permanently. This action cannot be undone.",
  {
    driveId: z.string().describe("The drive ID of the file"),
    itemId: z.string().describe("The item ID of the Loop file to delete"),
  },
  async ({ driveId, itemId }) => {
    try {
      await deleteLoopFile(driveId, itemId);
      return {
        content: [{ type: "text", text: `Deleted item ${itemId} from drive ${driveId}.` }],
      };
    } catch (err) {
      return toolError(err);
    }
  }
);

// --- Start server ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[ms-loop] MCP server started (delegated auth, CRUD enabled)");
}

main().catch((err) => {
  console.error("[ms-loop] Fatal:", err);
  process.exit(1);
});
