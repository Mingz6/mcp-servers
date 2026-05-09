#!/usr/bin/env node
import { indexFull, indexIncremental } from "./indexer.js";
import { closeDb, getStats, initDb } from "./vector-store.js";

const args = process.argv.slice(2);
const mode = args[0];

if (!mode || mode === "--help" || mode === "-h") {
  process.stdout.write(
    [
      "brain-index — build or update the brain vector search index.",
      "",
      "Usage:",
      "  brain-index --full          Full rebuild (deletes existing index)",
      "  brain-index --incremental   Update only changed files",
      "  brain-index --stats         Show index statistics",
      "",
      "Env vars:",
      "  BRAIN_INDEX_PATHS               Comma-separated repo dirs to index",
      "  BRAIN_MCP_ROOT                  Fallback single root (default: ~/code/brain)",
      "  AZURE_OPENAI_ENDPOINT           Azure OpenAI endpoint",
      "  AZURE_OPENAI_API_KEY            Azure OpenAI API key",
      "  AZURE_OPENAI_EMBEDDING_DEPLOYMENT  Embedding model deployment name",
      "",
    ].join("\n")
  );
  process.exit(0);
}

async function main(): Promise<void> {
  try {
    if (mode === "--stats") {
      await initDb();
      const stats = getStats();
      process.stdout.write(
        [
          `Files:   ${stats.totalFiles}`,
          `Chunks:  ${stats.totalChunks}`,
          `DB size: ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`,
          `Last:    ${stats.lastIndexed ?? "never"}`,
          "",
        ].join("\n")
      );
      closeDb();
      return;
    }

    if (mode === "--full") {
      await indexFull();
    } else if (mode === "--incremental") {
      await indexIncremental();
    } else {
      process.stderr.write(`Unknown mode: ${mode}\n`);
      process.exit(1);
    }

    closeDb();
  } catch (err) {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  }
}

main();
