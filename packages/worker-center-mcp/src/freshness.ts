import { execFileSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { getDb, getDbPath, reopenDb } from "./db.js";

// worker-center actually runs on the Mac Mini (since the 2026-07-15 migration) —
// WORKER_CENTER_DB is a local file, only ever refreshed by pulling from there.
const WARN_THRESHOLD_HOURS = 24;
const FAIL_THRESHOLD_HOURS = 72;
const FETCH_THROTTLE_MINUTES = 10;

// Same host/user/path convention as scripts/deploy-to-mini.sh, so this works out
// of the box wherever that script already works — override via env if it ever changes.
const REMOTE_USER = process.env.WORKER_CENTER_REMOTE_USER ?? "mingz";
const REMOTE_HOST = process.env.WORKER_CENTER_REMOTE_HOST ?? "10.64.21.53";
const REMOTE_DB_PATH = process.env.WORKER_CENTER_REMOTE_DB_PATH ?? "code/personal/worker-center/data/market.db";

let lastFetchAttemptAt = 0;

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

function attemptFetch(dbPath: string): { succeeded: boolean; detail: string } {
  const tmpPath = `${dbPath}.fetching-${process.pid}`;
  try {
    execFileSync(
      "scp",
      ["-o", "ConnectTimeout=8", "-o", "BatchMode=yes", `${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DB_PATH}`, tmpPath],
      { timeout: 15000, stdio: "pipe" }
    );

    // Sanity-check before trusting it — don't swap in a partial/corrupt file.
    const test = new Database(tmpPath, { readonly: true });
    test.prepare("SELECT COUNT(*) FROM worker_runs").get();
    test.close();

    renameSync(tmpPath, dbPath);
    reopenDb();
    return { succeeded: true, detail: `refreshed from ${REMOTE_USER}@${REMOTE_HOST}` };
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup, not worth failing over */
      }
    }
    const stderr = (err as { stderr?: Buffer })?.stderr?.toString().trim();
    const message = stderr || (err instanceof Error ? err.message.split("\n")[0] : String(err));
    return { succeeded: false, detail: `refresh from ${REMOTE_USER}@${REMOTE_HOST} failed (${message})` };
  }
}

export interface FreshDbResult {
  db: Database.Database;
  warning: string | null;
}

/**
 * Freshness contract:
 * - < 24h old: served silently, no fetch attempted.
 * - >= 24h old: one throttled refresh attempt (max once per 10min) from the Mac
 *   Mini. Served with a warning either way — whether the refresh failed, or it
 *   succeeded but the Mac Mini's own data is itself still stale.
 * - >= 72h old even after the refresh attempt: throws. Data that old has no
 *   value and should not be silently treated as current.
 */
export function getFreshDb(): FreshDbResult {
  let db = getDb();
  let timestamp = latestRunTimestamp(db);
  let age = ageHours(timestamp);

  if (age < WARN_THRESHOLD_HOURS) {
    return { db, warning: null };
  }

  const now = Date.now();
  const throttled = now - lastFetchAttemptAt < FETCH_THROTTLE_MINUTES * 60 * 1000;
  let fetchAttempted = false;
  let fetchDetail = `not retried yet (last attempt ${Math.round(
    (now - lastFetchAttemptAt) / 60000
  )}m ago, refresh attempts are throttled to once per ${FETCH_THROTTLE_MINUTES}m)`;

  if (!throttled) {
    fetchAttempted = true;
    lastFetchAttemptAt = now;
    const result = attemptFetch(getDbPath());
    fetchDetail = result.detail;
    if (result.succeeded) {
      db = getDb();
      timestamp = latestRunTimestamp(db);
      age = ageHours(timestamp);
    }
  }

  // A refresh that actually resolved the staleness needs no warning — only surface
  // something when the data is still stale (fetch failed, throttled, or the Mac
  // Mini's own data is itself still old) after trying.
  if (fetchAttempted && age < WARN_THRESHOLD_HOURS) {
    return { db, warning: null };
  }

  const tsLabel = timestamp ?? "unknown";

  if (age >= FAIL_THRESHOLD_HOURS) {
    throw new Error(
      `worker-center data is ${age.toFixed(1)}h old (last worker run: ${tsLabel}) — past the ` +
        `${FAIL_THRESHOLD_HOURS}h freshness limit, refusing to serve stale data. Fetch attempt: ${fetchDetail}. ` +
        `Manual fix: scp ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DB_PATH} ${getDbPath()}`
    );
  }

  return {
    db,
    warning: `⚠️ Data is ${age.toFixed(1)}h old (last worker run: ${tsLabel}). Fetch attempt: ${fetchDetail}. Showing last-known data.`,
  };
}
