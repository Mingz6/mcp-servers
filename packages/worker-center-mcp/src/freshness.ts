import Database from "better-sqlite3";
import { getDb } from "./db.js";

// worker-center actually runs on the Mac Mini (since the 2026-07-15 migration) —
// WORKER_CENTER_DB is a local file that nothing currently keeps in sync with it.
// For now this only detects and reports staleness; it does not attempt to fix
// it (no auto-refresh) — that's a deliberate, temporary scope decision.
const WARN_THRESHOLD_HOURS = 24;
const FAIL_THRESHOLD_HOURS = 72;

function latestRunTimestamp(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT MAX(started_at) as latest FROM worker_runs").get() as
      | { latest: string | null }
      | undefined;
    return row?.latest ?? null;
  } catch {
    return null;
  }
}

function ageHours(timestamp: string | null): number {
  if (!timestamp) return Infinity;
  const then = new Date(timestamp).getTime();
  return Number.isNaN(then) ? Infinity : (Date.now() - then) / (1000 * 60 * 60);
}

export interface FreshDbResult {
  db: Database.Database;
  warning: string | null;
}

/**
 * Freshness contract (detect + report only — no auto-refresh for now):
 * - < 24h old: served silently.
 * - 24h-72h old: served with a warning that the data is out of date.
 * - >= 72h old: throws. Data that old has no value and should not be silently
 *   treated as current.
 */
export function getFreshDb(): FreshDbResult {
  const db = getDb();
  const timestamp = latestRunTimestamp(db);
  const age = ageHours(timestamp);
  const tsLabel = timestamp ?? "unknown";

  if (age < WARN_THRESHOLD_HOURS) {
    return { db, warning: null };
  }

  if (age >= FAIL_THRESHOLD_HOURS) {
    throw new Error(
      `worker-center data is ${age.toFixed(1)}h old (last worker run: ${tsLabel}) — past the ` +
        `${FAIL_THRESHOLD_HOURS}h freshness limit, refusing to serve stale data. This local copy is not ` +
        `auto-synced with the Mac Mini; refresh it manually, e.g.: scp mingz@10.64.21.53:code/personal/worker-center/data/market.db "$WORKER_CENTER_DB"`
    );
  }

  return {
    db,
    warning: `⚠️ Data is ${age.toFixed(1)}h old (last worker run: ${tsLabel}) — out of date. Not auto-refreshing; showing last-known data.`,
  };
}
