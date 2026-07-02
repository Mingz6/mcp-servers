import { promises as fs } from "node:fs";
import path from "node:path";
import { getIndexRoots, toLabeledPath } from "./brain.js";
import { embed } from "./embeddings.js";
import { createLogger } from "./logger.js";
import {
    clearAll,
    deleteFile,
    getIndexedFiles,
    getStats,
    initDb,
    runWriteBatch,
    upsertChunk
} from "./vector-store.js";

const logger = createLogger("indexer");

const IGNORED_DIRS = new Set([
  ".git",
  ".venv",
  "__pycache__",
  "dist",
  "node_modules",
  "_done",
  "archive",
  "archives",
]);

const MAX_FILE_BYTES = 512 * 1024;

type IndexResult = Readonly<{
  filesProcessed: number;
  chunksUpserted: number;
  filesDeleted: number;
  errors: string[];
}>;

async function walkMarkdownFiles(
  rootDir: string
): Promise<Array<{ absolutePath: string; relativePath: string }>> {
  const files: Array<{ absolutePath: string; relativePath: string }> = [];
  const resolvedRoot = path.resolve(rootDir);

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(path.join(dir, entry.name));
      } else if (
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === ".md"
      ) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(resolvedRoot, abs);
        files.push({ absolutePath: abs, relativePath: rel });
      }
    }
  }

  await walk(resolvedRoot);
  return files;
}

function chunkByHeading(
  content: string,
  filePath: string
): Array<{ chunkId: string; text: string }> {
  const lines = content.split("\n");
  const chunks: Array<{ chunkId: string; text: string }> = [];
  let currentHeading = "preamble";
  let currentLines: string[] = [];
  let headingCount = 0;

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      if (currentLines.length > 0) {
        const text = currentLines.join("\n").trim();
        if (text.length > 0) {
          chunks.push({ chunkId: currentHeading, text });
        }
      }
      headingCount++;
      const slug = headingMatch[2]
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
      currentHeading = `h${headingMatch[1].length}-${slug || `section-${headingCount}`}`;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    const text = currentLines.join("\n").trim();
    if (text.length > 0) {
      chunks.push({ chunkId: currentHeading, text });
    }
  }

  if (chunks.length === 0 && content.trim().length > 0) {
    chunks.push({ chunkId: "full", text: content.trim() });
  }

  return chunks;
}

function makeEmbeddingInput(
  filePath: string,
  chunkText: string
): string {
  return `file: ${filePath}\n\n${chunkText}`;
}

export async function indexFull(
  dbPath?: string,
  log?: (msg: string) => void
): Promise<IndexResult> {
  const print = log ?? console.log;
  const indexRoots = getIndexRoots();
  print(`Full index: ${indexRoots.length} root(s)`);

  await initDb(dbPath);
  clearAll();

  let filesProcessed = 0;
  let chunksUpserted = 0;
  const errors: string[] = [];

  for (const indexRoot of indexRoots) {
    print(`Scanning ${indexRoot.absolutePath}${indexRoot.label ? ` (${indexRoot.label})` : ""}...`);
    const files = await walkMarkdownFiles(indexRoot.absolutePath);
    print(`  Found ${files.length} .md files`);

    for (const file of files) {
      const labeledPath = toLabeledPath(indexRoot.label, file.relativePath);
      try {
        let stat;
        try {
          stat = await fs.stat(file.absolutePath);
        } catch (err) {
          // File disappeared between walk and stat (rename, delete, race).
          // Skip silently — incremental run picks it up next time.
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          throw err;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        const content = await fs.readFile(file.absolutePath, "utf8");
        const chunks = chunkByHeading(content, labeledPath);
        const texts = chunks.map((c) =>
          makeEmbeddingInput(labeledPath, c.text)
        );

        const vectors = await embed(texts);
        const mtime = stat.mtimeMs;

        // Wrap per-file writes in one transaction — cuts fsyncs ~N×.
        runWriteBatch(() => {
          for (let i = 0; i < chunks.length; i++) {
            upsertChunk(
              labeledPath,
              chunks[i].chunkId,
              chunks[i].text,
              vectors[i],
              mtime
            );
          }
        });
        chunksUpserted += chunks.length;
        filesProcessed++;
      } catch (err) {
        const msg = `Error indexing ${labeledPath}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error("Index error", err, { file: labeledPath });
        print(`  ${msg}`);
      }
    }
  }

  const stats = getStats();
  print(
    `Done: ${filesProcessed} files, ${chunksUpserted} chunks, DB ${(stats.dbSizeBytes / 1024).toFixed(0)} KB`
  );
  return { filesProcessed, chunksUpserted, filesDeleted: 0, errors };
}

export async function indexIncremental(
  dbPath?: string,
  log?: (msg: string) => void
): Promise<IndexResult> {
  const print = log ?? console.log;
  const indexRoots = getIndexRoots();
  print(`Incremental index: ${indexRoots.length} root(s)`);

  await initDb(dbPath);
  const indexed = getIndexedFiles();

  let filesProcessed = 0;
  let chunksUpserted = 0;
  let filesDeleted = 0;
  const errors: string[] = [];
  const seenFiles = new Set<string>();

  for (const indexRoot of indexRoots) {
    const files = await walkMarkdownFiles(indexRoot.absolutePath);

    for (const file of files) {
      const labeledPath = toLabeledPath(indexRoot.label, file.relativePath);
      seenFiles.add(labeledPath);

      try {
        let stat;
        try {
          stat = await fs.stat(file.absolutePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
          throw err;
        }
        if (stat.size > MAX_FILE_BYTES) continue;

        const existingMtime = indexed.get(labeledPath);
        if (existingMtime !== undefined && Math.abs(stat.mtimeMs - existingMtime) < 1000) {
          continue;
        }

        const content = await fs.readFile(file.absolutePath, "utf8");
        const chunks = chunkByHeading(content, labeledPath);
        const texts = chunks.map((c) =>
          makeEmbeddingInput(labeledPath, c.text)
        );

        const vectors = await embed(texts);

        runWriteBatch(() => {
          deleteFile(labeledPath);
          for (let i = 0; i < chunks.length; i++) {
            upsertChunk(
              labeledPath,
              chunks[i].chunkId,
              chunks[i].text,
              vectors[i],
              stat.mtimeMs
            );
          }
        });
        chunksUpserted += chunks.length;
        filesProcessed++;
      } catch (err) {
        const msg = `Error indexing ${labeledPath}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(msg);
        logger.error("Incremental index error", err, { file: labeledPath });
        print(`  ${msg}`);
      }
    }
  }

  for (const indexedPath of indexed.keys()) {
    if (!seenFiles.has(indexedPath)) {
      deleteFile(indexedPath);
      filesDeleted++;
    }
  }

  if (filesDeleted > 0) {
    print(`Removed ${filesDeleted} stale file(s)`);
  }

  print(
    `Done: ${filesProcessed} changed, ${chunksUpserted} chunks, ${filesDeleted} removed`
  );
  return { filesProcessed, chunksUpserted, filesDeleted, errors };
}

export { chunkByHeading, makeEmbeddingInput, walkMarkdownFiles };

