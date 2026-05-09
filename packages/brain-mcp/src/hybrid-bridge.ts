import { embedSingle } from "./embeddings.js";
import { closeDb, getStats, initDb, search as vectorSearch } from "./vector-store.js";

let ready = false;
let initAttempted = false;

export function isIndexReady(): boolean {
  if (ready) return true;
  if (initAttempted) return false;

  initAttempted = true;
  try {
    // Synchronous check: try to open the DB
    initDb().then(() => { ready = true; }).catch(() => { /* DB not available */ });
    return false; // First call returns false, subsequent calls return true once init completes
  } catch {
    return false;
  }
}

export async function ensureReady(): Promise<boolean> {
  if (ready) return true;
  try {
    await initDb();
    ready = true;
    return true;
  } catch {
    return false;
  }
}

export async function searchIndex(
  query: string,
  topK: number
): Promise<Array<{ path: string; chunkId: string; content: string; distance: number }>> {
  if (!await ensureReady()) return [];

  const stats = getStats();
  if (stats.totalChunks === 0) return [];

  const queryVector = await embedSingle(query);
  return vectorSearch(queryVector, topK).map((r) => ({
    path: r.filePath,
    chunkId: r.chunkId,
    content: r.content,
    distance: r.distance,
  }));
}

export { closeDb };
