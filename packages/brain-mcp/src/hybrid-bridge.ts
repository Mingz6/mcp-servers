import { embedSingle } from "./embeddings.js";
import { createLogger } from "./logger.js";
import { closeDb, getStats, initDb, search as vectorSearch } from "./vector-store.js";

const log = createLogger("hybrid-bridge");

let readyPromise: Promise<boolean> | undefined;

/**
 * Initialize the index DB once and remember the outcome.
 * All callers await the same promise — no race window where the first call
 * silently returns "not ready" while init is still in flight.
 */
export async function ensureReady(): Promise<boolean> {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    try {
      await initDb();
      log.info("Index DB initialized");
      return true;
    } catch (err) {
      log.error("Index DB unavailable; semantic search disabled", err);
      // Reset so a later call can retry (e.g. once the file appears).
      readyPromise = undefined;
      return false;
    }
  })();

  return readyPromise;
}

export async function searchIndex(
  query: string,
  topK: number
): Promise<Array<{ path: string; chunkId: string; content: string; distance: number }>> {
  if (!(await ensureReady())) return [];

  let stats;
  try {
    stats = getStats();
  } catch (err) {
    log.error("getStats failed", err);
    return [];
  }
  if (stats.totalChunks === 0) {
    log.warn("Index is empty; run brain-index --full to populate it");
    return [];
  }

  let queryVector: Float32Array;
  try {
    queryVector = await embedSingle(query);
  } catch (err) {
    log.error("Embedding failed for query", err, { queryLen: query.length });
    return [];
  }

  try {
    return vectorSearch(queryVector, topK).map((r) => ({
      path: r.filePath,
      chunkId: r.chunkId,
      content: r.content,
      distance: r.distance,
    }));
  } catch (err) {
    log.error("Vector search failed", err);
    return [];
  }
}

export { closeDb };
