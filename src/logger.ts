/**
 * stdout protection for a stdio MCP server.
 *
 * The JSON-RPC stream owns process.stdout. A single stray console.log (from
 * this code or any dependency) corrupts the pipe and the client disconnects.
 * Importing this module FIRST redirects every console method that would write
 * to stdout onto stderr, and exposes a small leveled logger that only ever
 * writes to stderr.
 */
import { format } from "node:util";

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function resolveLevel(): Level {
  const raw = (process.env.MCP_REPO_AUDITOR_LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? (raw as Level) : "info";
}

const threshold = LEVELS[resolveLevel()];

function writeStderr(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = `[mcp-repo-auditor] ${new Date().toISOString()} ${level.toUpperCase()} ${format(...args)}\n`;
  try {
    process.stderr.write(line);
  } catch {
    // stderr closed: nothing sensible left to do.
  }
}

// Redirect every stdout-bound console method. console.error/warn already target stderr,
// but they are routed through the same formatter for consistency.
console.log = (...args: unknown[]) => writeStderr("info", args);
console.info = (...args: unknown[]) => writeStderr("info", args);
console.debug = (...args: unknown[]) => writeStderr("debug", args);
console.trace = (...args: unknown[]) => writeStderr("debug", args);
console.dir = (obj: unknown) => writeStderr("debug", [obj]);
console.table = (data: unknown) => writeStderr("debug", [data]);
console.warn = (...args: unknown[]) => writeStderr("warn", args);
console.error = (...args: unknown[]) => writeStderr("error", args);

export const logger = {
  debug: (...args: unknown[]) => writeStderr("debug", args),
  info: (...args: unknown[]) => writeStderr("info", args),
  warn: (...args: unknown[]) => writeStderr("warn", args),
  error: (...args: unknown[]) => writeStderr("error", args),
};
