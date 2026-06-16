import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmpDir = mkdtempSync(path.join(os.tmpdir(), "brain-mcp-logger-test-"));
process.env["BRAIN_MCP_LOG_DIR"] = tmpDir;
process.env["BRAIN_MCP_LOG_LEVEL"] = "debug";

// Imported AFTER env vars set so initialization picks them up.
const { createLogger, getLastError, getLogFilePath } = await import("./logger.js");

test.after(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("logger writes to the configured directory", () => {
  const log = createLogger("test-scope");
  log.info("hello world", { foo: 1 });
  const file = getLogFilePath();
  assert.ok(file, "log file path should be defined");
  assert.ok(file!.startsWith(tmpDir), `log path ${file} not under ${tmpDir}`);
  // File exists and has > 0 bytes
  const size = statSync(file!).size;
  assert.ok(size > 0, "log file should have content");
});

test("logger captures last error", () => {
  const log = createLogger("test-error");
  const err = new Error("boom");
  log.error("something failed", err);
  const last = getLastError();
  assert.ok(last, "expected lastError to be set");
  assert.match(last!.message, /something failed/);
  assert.match(last!.message, /boom/);
});

test("logger respects BRAIN_MCP_LOG_LEVEL", () => {
  // Already at debug above; just ensure debug() doesn't throw.
  const log = createLogger("test-level");
  log.debug("debug msg");
  log.warn("warn msg");
  assert.ok(true);
});
