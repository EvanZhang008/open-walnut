/**
 * File transport — writes JSON-lines to /tmp/open-walnut/walnut-YYYY-MM-DD.log.
 *
 * initFileLogger()  : ensures the log directory exists & prunes files > 3 days old.
 * writeLogEntry()   : buffers one JSON line; flushed to disk every 2 s (async).
 * flushLogBuffer()  : manual flush (called on graceful shutdown).
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LOG_DIR, LOG_PREFIX } from '../constants.js';
import type { LogLevel } from './levels.js';
import { redactSensitiveText } from './redact.js';

// ── Types ──

export interface LogEntry {
  time: string;
  level: LogLevel;
  subsystem: string;
  message: string;
  [key: string]: unknown;
}

// ── Helpers ──

let dirEnsured = false;

function ensureLogDir(): void {
  if (dirEnsured) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirEnsured = true;
  } catch {
    // Best-effort — don't throw from the logger.
  }
}

function todayFileName(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${LOG_PREFIX}${yyyy}-${mm}-${dd}.log`;
}

export function logFilePath(): string {
  return path.join(LOG_DIR, todayFileName());
}

/** Remove log files older than `maxAgeDays`. */
function pruneOldLogs(maxAgeDays: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(LOG_DIR);
  } catch {
    return; // dir doesn't exist yet — nothing to prune
  }

  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

  for (const name of entries) {
    if (!name.startsWith(LOG_PREFIX) || !name.endsWith('.log')) continue;
    const full = path.join(LOG_DIR, name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(full);
      }
    } catch {
      // Ignore per-file errors (race condition, permissions, etc.)
    }
  }
}

// ── Write buffer ──
// Instead of appendFileSync per entry (blocks the event loop), buffer entries
// in memory and flush to disk every FLUSH_INTERVAL_MS via a single async write.

const FLUSH_INTERVAL_MS = 2_000;
let buffer: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false; // guard against overlapping async flushes

function startFlushTimer(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => { void flushLogBuffer(); }, FLUSH_INTERVAL_MS);
  // Don't keep the process alive just for log flushing
  if (flushTimer && typeof flushTimer === 'object' && 'unref' in flushTimer) {
    flushTimer.unref();
  }
}

/**
 * Flush buffered log entries to disk (async, non-blocking).
 * Safe to call concurrently — only one flush runs at a time.
 */
export async function flushLogBuffer(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;

  // Swap buffer so new writes don't interfere
  const batch = buffer;
  buffer = [];

  try {
    ensureLogDir();
    await fsp.appendFile(logFilePath(), batch.join(''), 'utf-8');
  } catch {
    // Best-effort — never throw from the logger.
    // Batch is intentionally dropped on failure to avoid infinite retry loops.
  } finally {
    flushing = false;
  }
}

/**
 * Write everything buffered so far and resolve once it is on disk, or after
 * `timeoutMs`. Unlike flushLogBuffer, which returns at once while a timer flush
 * is running, this waits that flush out and then writes what came after it.
 * For a caller about to be killed: a launchd job removing itself is SIGTERMed
 * before `launchctl remove` returns, and the entry it just logged must land.
 */
export async function flushLogBufferNow(timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (buffer.length > 0 || flushing) {
    if (Date.now() >= deadline) return;
    if (flushing) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      continue;
    }
    await flushLogBuffer();
  }
}

/**
 * Synchronous flush for process exit — last-resort to avoid losing buffered entries.
 * Only called from beforeExit / exit handlers where async is unreliable.
 */
function flushLogBufferSync(): void {
  if (buffer.length === 0) return;
  const batch = buffer;
  buffer = [];
  try {
    ensureLogDir();
    fs.appendFileSync(logFilePath(), batch.join(''), 'utf-8');
  } catch {
    // Best-effort
  }
}

// Flush remaining entries on graceful shutdown
process.on('beforeExit', flushLogBufferSync);
process.on('exit', flushLogBufferSync);

// ── Public API ──

/**
 * Create the log directory and prune files older than 3 days.
 * Safe to call multiple times (mkdir is idempotent with recursive).
 */
export function initFileLogger(): void {
  // Always mkdir (callers expect the directory to exist after this call),
  // then mark dirEnsured so the first flush skips redundant mkdir.
  fs.mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
  pruneOldLogs(3);
}

/**
 * Buffer a single JSON-line entry for writing to today's log file.
 * The entire serialized line is run through redactSensitiveText() before buffering.
 * Actual disk write happens asynchronously every 2 seconds.
 */
export function writeLogEntry(entry: LogEntry): void {
  const line = redactSensitiveText(JSON.stringify(entry)) + '\n';
  buffer.push(line);
  startFlushTimer();
}
