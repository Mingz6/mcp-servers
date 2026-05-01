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
    linkSourceCitations,
    lintBrain,
    packContext,
    readBrainPage,
    replaceBrainText,
    searchBrain,
    validatePageLinks,
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
    validateCitations: z.boolean().default(false).describe("Reject the write if any internal link does not resolve."),
    linkSources: z.boolean().default(false).describe("After write, append the new page to wiki_pages: in any cited learning/sources/* page."),
  },
  async ({ path, content, validateCitations, linkSources }) => {
    try {
      if (validateCitations) {
        const broken = await validatePageLinks(brainRoot, path, { content });
        if (broken.length > 0) {
          return toolError(
            new Error(
              `Refusing to create ${path}: ${broken.length} unresolved link(s): ${broken
                .map((b) => b.rawTarget)
                .join(", ")}`
            )
          );
        }
      }
      const result = await createBrainPage(brainRoot, path, content);
      let suffix = "";
      if (linkSources) {
        const linked = await linkSourceCitations(brainRoot, result.path);
        suffix = ` Linked sources: ${linked.updated.length} updated of ${linked.cited.length} cited.`;
      }
      return textResult(`Created ${result.path} (${result.bytes} bytes).${suffix}`);
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
    validateCitations: z.boolean().default(false).describe("Reject the edit if it would introduce unresolved internal links."),
    linkSources: z.boolean().default(false).describe("After edit, append this page to wiki_pages: in any cited learning/sources/* page."),
  },
  async ({ path, oldText, newText, validateCitations, linkSources }) => {
    try {
      if (validateCitations) {
        const { promises: fs } = await import("node:fs");
        const { resolveBrainPath } = await import("./brain.js");
        const absolutePath = resolveBrainPath(brainRoot, path);
        const current = await fs.readFile(absolutePath, "utf8");
        if (!current.includes(oldText)) {
          return toolError(new Error("oldText not found in page; cannot validate"));
        }
        const projected = current.replace(oldText, newText);
        const broken = await validatePageLinks(brainRoot, path, { content: projected });
        if (broken.length > 0) {
          return toolError(
            new Error(
              `Refusing to edit ${path}: ${broken.length} unresolved link(s) after edit: ${broken
                .map((b) => b.rawTarget)
                .join(", ")}`
            )
          );
        }
      }
      const result = await replaceBrainText(brainRoot, path, oldText, newText);
      let suffix = "";
      if (linkSources) {
        const linked = await linkSourceCitations(brainRoot, result.path);
        suffix = ` Linked sources: ${linked.updated.length} updated of ${linked.cited.length} cited.`;
      }
      return textResult(`Updated ${result.path}; replacements: ${result.replacements}.${suffix}`);
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

server.tool(
  "brain_lint",
  "Lint the brain wiki: orphan pages, broken wikilinks/markdown links, missing H1 headings, and source pages cited without wiki_pages: frontmatter. Pass paths to scope to specific files; useful for pre-commit hooks.",
  {
    paths: z.array(z.string()).optional().describe("Optional brain-relative paths to lint. Omit to scan everything."),
    kinds: z
      .array(z.enum(["orphan", "broken-link", "missing-title", "missing-source-frontmatter"]))
      .optional()
      .describe("Filter to specific issue kinds."),
    includeArchived: z.boolean().default(false).describe("Include _done/archive folders."),
    limit: z.number().min(1).max(500).default(100).describe("Maximum issues to display."),
  },
  async ({ paths, kinds, includeArchived, limit }) => {
    try {
      const report = await lintBrain(brainRoot, { paths, kinds, includeArchived });
      if (report.issues.length === 0) {
        return textResult(`Lint clean. Scanned ${report.scanned} page(s).`);
      }
      const shown = report.issues.slice(0, limit);
      const lines = shown.map(
        (issue, index) => `${index + 1}. [${issue.kind}] ${issue.path} — ${issue.detail}`
      );
      const summary = `Lint found ${report.issues.length} issue(s) across ${report.scanned} page(s).`;
      const truncatedNote =
        report.issues.length > shown.length
          ? `\n\n[Showing first ${shown.length}; ${report.issues.length - shown.length} more truncated.]`
          : "";
      return textResult(`${summary}\n\n${lines.join("\n")}${truncatedNote}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_link_source",
  "After a wiki page cites raw sources, add the wiki page path to each source's wiki_pages: frontmatter (bidirectional backlinks).",
  {
    path: z.string().describe("Brain-relative wiki page that cites raw sources."),
    sourceRoots: z
      .array(z.string())
      .optional()
      .describe("Override which folders count as raw sources. Defaults to learning/sources/, learning/, docs/chat-summaries/."),
  },
  async ({ path, sourceRoots }) => {
    try {
      const result = await linkSourceCitations(brainRoot, path, { sourceRoots });
      if (result.cited.length === 0) {
        return textResult(`No source citations found in ${path}.`);
      }
      const updatedList = result.updated.length
        ? result.updated.map((p) => `  - ${p}`).join("\n")
        : "  (all already linked)";
      return textResult(
        `${path} cites ${result.cited.length} source(s); updated frontmatter on ${result.updated.length}:\n${updatedList}`
      );
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_context_pack",
  "Build a token-budgeted evidence bundle for an agent kickoff. BFS the link graph from seedPaths or top search hits, ranks by hops then degree, and packs pages until the budget fills.",
  {
    seedPaths: z.array(z.string()).optional().describe("Brain-relative paths to seed the graph walk."),
    query: z.string().optional().describe("Optional search query whose top 5 hits seed the walk."),
    budgetTokens: z.number().min(500).max(64000).default(4000).describe("Token budget (estimated at 4 chars/token)."),
    maxHops: z.number().min(0).max(5).default(2).describe("Maximum BFS depth from seeds."),
    includeArchived: z.boolean().default(false).describe("Include _done/archive folders."),
  },
  async ({ seedPaths, query, budgetTokens, maxHops, includeArchived }) => {
    try {
      const pack = await packContext(brainRoot, {
        seedPaths,
        query,
        budgetTokens,
        maxHops,
        includeArchived,
      });
      const header = `Context pack | seeds: ${pack.seed.join(", ")} | budget: ${pack.budgetTokens}t | used: ${pack.usedTokens}t | pages: ${pack.pages.length}`;
      const sections = pack.pages.map(
        (page) =>
          `\n--- [hop ${page.hops} | ~${page.estimatedTokens}t] ${page.path} | ${page.title} ---\n${page.content}`
      );
      return textResult(`${header}\n${sections.join("\n")}`);
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
