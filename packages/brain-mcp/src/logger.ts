import { appendFileSync, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_LOG_DIR = path.join(homedir(), ".local", "share", "brain-mcp");
const LOG_FILE_NAME = "mcp.log";
const ROTATE_AT_BYTES = 5 * 1024 * 1024;
const ROTATED_SUFFIX = ".1";

let logFilePath: string | undefined;
let initialized = false;
let lastError: { at: string; message: string } | undefined;

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = typeof LEVELS[number];

const ENABLED_LEVEL: Level = (process.env["BRAIN_MCP_LOG_LEVEL"] as Level) ?? "info";

function shouldLog(level: Level): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(ENABLED_LEVEL);
}

function ensureInitialized(): void {
  if (initialized) return;
  try {
    const dir = process.env["BRAIN_MCP_LOG_DIR"] ?? DEFAULT_LOG_DIR;
    mkdirSync(dir, { recursive: true });
    logFilePath = path.join(dir, LOG_FILE_NAME);
    initialized = true;
  } catch {
    // File logging disabled; stderr only.
    initialized = true;
  }
}

function rotateIfNeeded(): void {
  if (!logFilePath) return;
  try {
    const size = statSync(logFilePath).size;
    if (size < ROTATE_AT_BYTES) return;
    const rotated = `${logFilePath}${ROTATED_SUFFIX}`;
    if (existsSync(rotated)) {
      // Best-effort overwrite; ignore failures.
      try { renameSync(rotated, `${rotated}.old`); } catch { /* ignore */ }
    }
    renameSync(logFilePath, rotated);
  } catch {
    // ignore — rotation is best effort
  }
}

function format(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): string {
  const ts = new Date().toISOString();
  const metaStr = meta && Object.keys(meta).length > 0 ? " " + JSON.stringify(meta) : "";
  return `${ts} [${level.toUpperCase()}] [${scope}] ${msg}${metaStr}`;
}

function write(level: Level, scope: string, msg: string, meta?: Record<string, unknown>): void {
  if (!shouldLog(level)) return;
  ensureInitialized();
  const line = format(level, scope, msg, meta);

  // stderr is safe — MCP uses stdout for JSON-RPC.
  process.stderr.write(line + "\n");

  if (logFilePath) {
    try {
      rotateIfNeeded();
      appendFileSync(logFilePath, line + "\n");
    } catch {
      // ignore — never let logging break a request
    }
  }
}

export function createLogger(scope: string) {
  return {
    debug: (msg: string, meta?: Record<string, unknown>) => write("debug", scope, msg, meta),
    info: (msg: string, meta?: Record<string, unknown>) => write("info", scope, msg, meta),
    warn: (msg: string, meta?: Record<string, unknown>) => write("warn", scope, msg, meta),
    error: (msg: string, err?: unknown, meta?: Record<string, unknown>) => {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : err === undefined ? "" : String(err);
      const fullMsg = errMsg ? `${msg} — ${errMsg}` : msg;
      lastError = { at: new Date().toISOString(), message: fullMsg };
      write("error", scope, fullMsg, meta);
    },
  };
}

export function getLastError(): { at: string; message: string } | undefined {
  return lastError;
}

export function getLogFilePath(): string | undefined {
  ensureInitialized();
  return logFilePath;
}

export type Logger = ReturnType<typeof createLogger>;
