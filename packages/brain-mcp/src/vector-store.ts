import Database from "better-sqlite3";
import { promises as fs, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";
import { EMBEDDING_DIMENSION } from "./embeddings.js";

const DEFAULT_DB_DIR = path.join(
  os.homedir(),
  ".local",
  "share",
  "brain-mcp"
);

export type ChunkRow = Readonly<{
  id: number;
  filePath: string;
  chunkId: string;
  content: string;
  mtime: number;
}>;

export type SearchResult = Readonly<{
  filePath: string;
  chunkId: string;
  content: string;
  distance: number;
}>;

export type IndexStats = Readonly<{
  totalChunks: number;
  totalFiles: number;
  dbSizeBytes: number;
  lastIndexed: string | null;
}>;

let db: Database.Database | undefined;

function vectorToJson(vec: Float32Array): string {
  return JSON.stringify(Array.from(vec));
}

export async function initDb(
  dbPath?: string
): Promise<Database.Database> {
  if (db) return db;

  const resolvedPath =
    dbPath ?? path.join(DEFAULT_DB_DIR, "brain-index.db");
  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  db = new Database(resolvedPath);
  sqliteVec.load(db);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path  TEXT    NOT NULL,
      chunk_id   TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      mtime      REAL   NOT NULL,
      indexed_at TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_file_chunk
      ON chunks(file_path, chunk_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_file
      ON chunks(file_path);
  `);

  const vecTableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunks'"
    )
    .get();

  if (!vecTableExists) {
    db.exec(
      `CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${EMBEDDING_DIMENSION}])`
    );
  }

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error("Database not initialized — call initDb() first");
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

export function upsertChunk(
  filePath: string,
  chunkId: string,
  content: string,
  vector: Float32Array,
  mtime: number
): void {
  const d = getDb();

  const existing = d
    .prepare("SELECT id FROM chunks WHERE file_path = ? AND chunk_id = ?")
    .get(filePath, chunkId) as { id: number } | undefined;

  if (existing) {
    d.prepare(
      "UPDATE chunks SET content = ?, mtime = ?, indexed_at = datetime('now') WHERE id = ?"
    ).run(content, mtime, existing.id);

    d.prepare("DELETE FROM vec_chunks WHERE rowid = CAST(? AS INTEGER)").run(existing.id);
    d.prepare(
      "INSERT INTO vec_chunks(rowid, embedding) VALUES (CAST(? AS INTEGER), vec_f32(?))"
    ).run(existing.id, vectorToJson(vector));
  } else {
    const result = d
      .prepare(
        "INSERT INTO chunks(file_path, chunk_id, content, mtime) VALUES (?, ?, ?, ?)"
      )
      .run(filePath, chunkId, content, mtime);

    const rowid = Number(result.lastInsertRowid);
    d.prepare(
      "INSERT INTO vec_chunks(rowid, embedding) VALUES (CAST(? AS INTEGER), vec_f32(?))"
    ).run(rowid, vectorToJson(vector));
  }
}

export function deleteFile(filePath: string): number {
  const d = getDb();

  const rows = d
    .prepare("SELECT id FROM chunks WHERE file_path = ?")
    .all(filePath) as Array<{ id: number }>;

  if (rows.length === 0) return 0;

  const deleteVec = d.prepare("DELETE FROM vec_chunks WHERE rowid = CAST(? AS INTEGER)");
  for (const row of rows) {
    deleteVec.run(row.id);
  }

  d.prepare("DELETE FROM chunks WHERE file_path = ?").run(filePath);
  return rows.length;
}

export function search(
  queryVector: Float32Array,
  topK: number = 10
): SearchResult[] {
  const d = getDb();

  const rows = d
    .prepare(
      `SELECT v.rowid, v.distance, c.file_path, c.chunk_id, c.content
       FROM vec_chunks v
       JOIN chunks c ON v.rowid = c.id
       WHERE v.embedding MATCH vec_f32(?)
         AND k = ?
       ORDER BY v.distance`
    )
    .all(vectorToJson(queryVector), topK) as Array<{
    rowid: number;
    distance: number;
    file_path: string;
    chunk_id: string;
    content: string;
  }>;

  return rows.map((r) => ({
    filePath: r.file_path,
    chunkId: r.chunk_id,
    content: r.content,
    distance: r.distance,
  }));
}

export function getIndexedFiles(): Map<string, number> {
  const d = getDb();

  const rows = d
    .prepare("SELECT file_path, MAX(mtime) as mtime FROM chunks GROUP BY file_path")
    .all() as Array<{ file_path: string; mtime: number }>;

  return new Map(rows.map((r) => [r.file_path, r.mtime]));
}

export function getStats(): IndexStats {
  const d = getDb();

  const totalChunks =
    (d.prepare("SELECT COUNT(*) as n FROM chunks").get() as { n: number }).n;

  const totalFiles =
    (
      d
        .prepare("SELECT COUNT(DISTINCT file_path) as n FROM chunks")
        .get() as { n: number }
    ).n;

  const lastIndexed =
    (
      d
        .prepare("SELECT MAX(indexed_at) as t FROM chunks")
        .get() as { t: string | null }
    ).t;

  let dbSizeBytes = 0;
  try {
    const dbPath = d.name;
    if (dbPath && dbPath !== ":memory:") {
      dbSizeBytes = statSync(dbPath).size;
    }
  } catch {
    // ignore
  }

  return { totalChunks, totalFiles, dbSizeBytes, lastIndexed };
}

export function clearAll(): void {
  const d = getDb();
  d.exec("DELETE FROM vec_chunks");
  d.exec("DELETE FROM chunks");
}
