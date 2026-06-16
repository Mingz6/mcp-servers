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
import { preflight, verifyCompletion } from "./coupled-actions.js";
import { checkAoaiHealth } from "./embeddings.js";
import { indexFull, indexIncremental } from "./indexer.js";
import { createLogger, getLastError, getLogFilePath } from "./logger.js";
import { getStats as getIndexStats, initDb } from "./vector-store.js";

const log = createLogger("server");
const brainRoot = getBrainRoot();
const server = new McpServer({ name: "brain", version: "1.1.0" });

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
        `   Score: ${result.score} (${result.matchType})`,
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

server.tool(
  "brain_index",
  "Build or update the brain vector search index. Use 'full' to rebuild from scratch, 'incremental' to update changed files only, or 'stats' to check index health.",
  {
    mode: z.enum(["full", "incremental", "stats"]).describe("Index mode."),
  },
  async ({ mode }) => {
    try {
      if (mode === "stats") {
        try {
          const stats = getIndexStats();
          return textResult(
            `Index: ${stats.totalFiles} files, ${stats.totalChunks} chunks, ${(stats.dbSizeBytes / 1024).toFixed(0)} KB, last indexed: ${stats.lastIndexed ?? "never"}`
          );
        } catch {
          return textResult("Index not initialized. Run brain_index with mode 'full' first.");
        }
      }

      const messages: string[] = [];
      const log = (msg: string) => messages.push(msg);

      const result = mode === "full"
        ? await indexFull(undefined, log)
        : await indexIncremental(undefined, log);

      const summary = [
        ...messages,
        "",
        `Files processed: ${result.filesProcessed}`,
        `Chunks upserted: ${result.chunksUpserted}`,
        `Files deleted: ${result.filesDeleted}`,
        result.errors.length > 0
          ? `Errors: ${result.errors.length}\n${result.errors.slice(0, 5).join("\n")}`
          : "No errors.",
      ].join("\n");

      return textResult(summary);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_preflight",
  "Given a task description, returns relevant coupled actions that must be completed before the task can be marked done. Call this when starting work to know what verification gates apply.",
  {
    task: z.string().describe("Description of the task being worked on."),
  },
  async ({ task }) => {
    try {
      const result = preflight(task);
      if (result.matchedActions.length === 0) {
        return textResult("No coupled actions apply to this task.");
      }
      const lines = result.matchedActions.map((a) => {
        const actions = a.actions.map((act) => `    - ${act}`).join("\n");
        return `[${a.severity.toUpperCase()}] ${a.id}: ${a.description}\n${actions}`;
      });
      return textResult(`Coupled actions for this task:\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_verify_completion",
  "Verify all coupled actions are satisfied before marking a task done. Returns pass/fail with missing items. Hard failures block completion.",
  {
    task: z.string().describe("Description of the task being completed."),
    actions_taken: z.array(z.string()).describe("List of actions that were performed."),
  },
  async ({ task, actions_taken }) => {
    try {
      const result = verifyCompletion(task, actions_taken);
      if (result.passed) {
        return textResult("All coupled actions satisfied. Task can be marked done.");
      }
      const lines = result.missing.map((m) => {
        const missing = m.missingActions.map((a) => `    - ${a}`).join("\n");
        return `[${m.severity.toUpperCase()}] ${m.id}: ${m.description}\n  Missing:\n${missing}`;
      });
      const verdict = result.hardFail
        ? "BLOCKED — hard-fail coupled actions not satisfied. Complete them before marking done."
        : "WARNING — soft coupled actions missing. Consider completing them.";
      return textResult(`${verdict}\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_get_relevant_instructions",
  "Given a task description, find the most relevant .instructions.md files using semantic search. Returns top matches with their descriptions and file paths so the agent can load them.",
  {
    task: z.string().describe("Description of the task or domain to find instructions for."),
    limit: z.number().optional().default(5).describe("Max number of instructions to return."),
  },
  async ({ task, limit }) => {
    try {
      const results = await searchBrain(brainRoot, task + " instructions rules standards", {
        limit: limit * 3,
      });
      const instructionResults = results.filter((r) =>
        r.path.endsWith(".instructions.md") || r.path.includes("/instructions/")
      );
      const top = instructionResults.slice(0, limit);
      if (top.length === 0) {
        return textResult("No relevant instructions found for this task.");
      }
      const lines = top.map((r, i) => [
        `${i + 1}. ${r.title}`,
        `   Path: ${r.path}`,
        `   Match: ${r.matchType}`,
        `   Snippet: ${r.snippet}`,
      ].join("\n"));
      return textResult(`Relevant instructions (${top.length}):\n\n${lines.join("\n\n")}`);
    } catch (err) {
      return toolError(err);
    }
  }
);

server.tool(
  "brain_health",
  "Health check for the brain MCP server. Reports: index DB status, semantic search availability (AOAI reachability), coupled-actions config, and last logged error. Call this when search results look wrong or before debugging the brain.",
  {
    checkAoai: z.boolean().default(false).describe("If true, makes a live embedding request to verify AOAI reachability (costs ~$0.000004). Default false for fast checks."),
  },
  async ({ checkAoai }) => {
    const lines: string[] = [];
    let allOk = true;

    // 1. Brain root
    lines.push(`Brain root: ${brainRoot}`);

    // 2. Index DB
    let indexOk = false;
    try {
      await initDb();
      const stats = getIndexStats();
      indexOk = stats.totalChunks > 0;
      lines.push(
        `Index DB: ${indexOk ? "OK" : "EMPTY"} — ${stats.totalFiles} files, ${stats.totalChunks} chunks, ${(stats.dbSizeBytes / 1024 / 1024).toFixed(1)} MB, last indexed: ${stats.lastIndexed ?? "never"}`,
      );
      if (!indexOk) allOk = false;
    } catch (err) {
      allOk = false;
      lines.push(`Index DB: FAIL — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. Env vars (cheap pre-check before optional live AOAI ping)
    const requiredEnv = ["AZURE_OPENAI_ENDPOINT", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_EMBEDDING_DEPLOYMENT"];
    const missingEnv = requiredEnv.filter((k) => !process.env[k]);
    if (missingEnv.length > 0) {
      allOk = false;
      lines.push(`AOAI env: MISSING — ${missingEnv.join(", ")} not set in MCP server process`);
    } else {
      lines.push(`AOAI env: OK — endpoint, api key, deployment all set`);
    }

    // 4. AOAI live check (optional)
    if (checkAoai && missingEnv.length === 0) {
      const aoai = await checkAoaiHealth();
      if (aoai.ok) {
        lines.push(`AOAI live: OK (${aoai.latencyMs}ms)`);
      } else {
        allOk = false;
        lines.push(`AOAI live: FAIL — ${aoai.error} (${aoai.latencyMs}ms)`);
      }
    } else if (checkAoai) {
      lines.push(`AOAI live: SKIPPED — env vars missing`);
    } else {
      lines.push(`AOAI live: not checked (pass checkAoai=true to verify)`);
    }

    // 5. Coupled actions
    try {
      const result = preflight("code edited and tests run");
      const matched = result.matchedActions.length;
      lines.push(`Coupled actions: ${matched > 0 ? "OK" : "WARN"} — ${matched} rule(s) matched test trigger`);
      if (matched === 0) allOk = false;
    } catch (err) {
      allOk = false;
      lines.push(`Coupled actions: FAIL — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Log file location
    lines.push(`Log file: ${getLogFilePath() ?? "<stderr only>"}`);

    // 7. Last error
    const lastErr = getLastError();
    if (lastErr) {
      lines.push(`Last error: ${lastErr.at} — ${lastErr.message}`);
    } else {
      lines.push(`Last error: <none since startup>`);
    }

    const verdict = allOk ? "✅ brain MCP healthy" : "❌ brain MCP has issues";
    return textResult(`${verdict}\n\n${lines.join("\n")}`);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("Brain MCP server started", { brainRoot, version: "1.1.0" });
  console.error(`Brain MCP server started. Root: ${brainRoot} (${BRAIN_ROOT_ENV})`);
}

process.on("unhandledRejection", (err) => { log.error("Unhandled rejection", err); process.exit(1); });
process.on("uncaughtException", (err) => { log.error("Uncaught exception", err); process.exit(1); });

main().catch((err) => {
  log.error("Fatal startup error", err);
  console.error("Fatal:", err);
  process.exit(1);
});
