import Database from "better-sqlite3";
import { existsSync } from "node:fs";

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dbPath = process.env.WORKER_CENTER_DB;
  if (!dbPath) {
    throw new Error("WORKER_CENTER_DB environment variable not set");
  }
  if (!existsSync(dbPath)) {
    throw new Error(`Database not found at: ${dbPath}`);
  }

  db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  return db;
}
