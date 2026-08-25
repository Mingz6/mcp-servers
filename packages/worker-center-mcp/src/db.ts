import Database from "better-sqlite3";
import { existsSync } from "node:fs";

let db: Database.Database | null = null;

function resolveDbPath(): string {
  const dbPath = process.env.WORKER_CENTER_DB;
  if (!dbPath) {
    throw new Error("WORKER_CENTER_DB environment variable not set");
  }
  return dbPath;
}

/** Path to the local db file, independent of whether it currently exists (freshness.ts needs this to know where to write a refreshed copy). */
export function getDbPath(): string {
  return resolveDbPath();
}

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = resolveDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at: ${dbPath}`);
  }

  // Readonly connection — never sets journal_mode. Setting it is itself a write
  // (it patches the file header), which throws on any file not already in WAL
  // mode; reads work fine regardless of whatever journal mode the file is in.
  db = new Database(dbPath, { readonly: true });
  return db;
}

/** Closes the cached handle so the next getDb() re-opens from disk — used after a freshness refresh replaces the file on disk. */
export function reopenDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
