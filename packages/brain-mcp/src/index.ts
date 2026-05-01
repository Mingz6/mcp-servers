import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
    BRAIN_ROOT_ENV,
    buildGraph,
    captureSource,
    createBrainPage,
    findBacklinks,
    getBrainRoot,
    readBrainPage,
    replaceBrainText,
    searchBrain,
} from "./brain.js";

const brainRoot = getBrainRoot();
const server = new McpServer({ name: "brain", version: "1.0.0" });

function toolError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

server.tool(
  "brain_search",
  "Search the local brain Markdown wiki. Use this before raw file reads when looking for durable knowledge.",
  {
    query: z.string().describe("Search query. Multi-word queries require all words to match."),
    limit: z.number().min(1).max(50).default(10).describe("Maximum result count."),
    roots: z
      .array(z.string())
      .optional()
      .describe("Optional brain-relative folders to search, such as docs, crna, or copilot/skills."),
    includeArchived: z.boolean().default(false).describe("Include _done/archive folders."),
  },
  async ({ query, limit, roots, includeArchived }) => {
    try {
      const results = await searchBrain(brainRoot, query, { limit, roots, includeArchived });
      if (results.length === 0) {
        return textResult(`No brain pages found for "${query}".`);
      }

      const lines = results.map((result, index) => [
        `${index + 1}. ${result.title}`,
        `   Path: ${result.path}`,
        `   Score: ${result.score}`,
        `   Snippet: ${result.snippet}`,
      ].join("\n"));

      return textResult(`Brain search results for "${query}" (${results.length}):\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_read",
  "Read a Markdown page from the local brain repo by brain-relative or absolute path.",
  {
    path: z.string().describe("Markdown page path, such as docs/projects.md."),
    maxChars: z.number().min(1000).max(50000).default(12000).describe("Maximum characters to return."),
  },
  async ({ path, maxChars }) => {
    try {
      const page = await readBrainPage(brainRoot, path, maxChars);
      const truncated = page.truncated ? "\n\n[Truncated. Increase maxChars if needed.]" : "";
      return textResult(`Path: ${page.path}\nTitle: ${page.title}\n\n${page.content}${truncated}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_backlinks",
  "Find brain pages that link to a target Markdown page.",
  {
    path: z.string().describe("Target Markdown page path."),
    limit: z.number().min(1).max(200).default(100).describe("Maximum backlink count."),
    includeArchived: z.boolean().default(false).describe("Include _done/archive folders."),
  },
  async ({ path, limit, includeArchived }) => {
    try {
      const backlinks = await findBacklinks(brainRoot, path, { limit, includeArchived });
      if (backlinks.length === 0) {
        return textResult(`No backlinks found for ${path}.`);
      }

      const lines = backlinks.map((backlink, index) => [
        `${index + 1}. ${backlink.title}`,
        `   Path: ${backlink.path}`,
        `   Link text: ${backlink.text}`,
        `   Raw target: ${backlink.rawTarget}`,
      ].join("\n"));

      return textResult(`Backlinks for ${path} (${backlinks.length}):\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_graph",
  "Return the Markdown link graph as JSON. Pass path for a local graph around one page; omit it for a global high-degree graph.",
  {
    path: z.string().optional().describe("Optional Markdown page path for a local graph."),
    depth: z.number().min(0).max(5).default(1).describe("Local graph depth when path is provided."),
    maxNodes: z.number().min(1).max(1000).default(200).describe("Maximum nodes to return."),
    includeArchived: z.boolean().default(false).describe("Include _done/archive folders."),
  },
  async ({ path, depth, maxNodes, includeArchived }) => {
    try {
      const graph = await buildGraph(brainRoot, { startPath: path, depth, maxNodes, includeArchived });
      return textResult(JSON.stringify(graph, null, 2));
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_create_page",
  "Create a new Markdown page inside the brain repo. Fails if the page already exists.",
  {
    path: z.string().describe("Brain-relative Markdown path to create."),
    content: z.string().describe("Full Markdown content to write."),
  },
  async ({ path, content }) => {
    try {
      const result = await createBrainPage(brainRoot, path, content);
      return textResult(`Created ${result.path} (${result.bytes} bytes).`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_replace_text",
  "Replace one exact text block in a brain Markdown page. The old text must appear exactly once.",
  {
    path: z.string().describe("Brain-relative Markdown path to edit."),
    oldText: z.string().describe("Exact text to replace. Must appear exactly once."),
    newText: z.string().describe("Replacement text."),
  },
  async ({ path, oldText, newText }) => {
    try {
      const result = await replaceBrainText(brainRoot, path, oldText, newText);
      return textResult(`Updated ${result.path}; replacements: ${result.replacements}.`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_capture_source",
  "Capture a URL, document, or session summary as a raw source note under learning/sources by default.",
  {
    title: z.string().describe("Source title."),
    source: z.string().describe("URL, file path, or source identifier."),
    summary: z.string().describe("Short source summary or why it matters."),
    tags: z.array(z.string()).default([]).describe("Optional tags."),
    targetDir: z.string().default("learning/sources").describe("Brain-relative target directory."),
  },
  async ({ title, source, summary, tags, targetDir }) => {
    try {
      const result = await captureSource(brainRoot, { title, source, summary, tags, targetDir });
      return textResult(`Captured source at ${result.path} (${result.bytes} bytes).`);
    } catch (err) {
      return toolError(err);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Brain MCP server started. Root: ${brainRoot} (${BRAIN_ROOT_ENV})`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
