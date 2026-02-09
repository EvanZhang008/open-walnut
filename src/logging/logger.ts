/**
 * File transport — writes JSON-lines to /tmp/walnut/walnut-YYYY-MM-DD.log.
 *
 * initFileLogger()  : ensures the log directory exists & prunes files > 3 days old.
 * writeLogEntry()   : appends one JSON line (after redaction).
 */

import fs from 'node:fs';
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

// ── Public API ──

/**
 * Create the log directory and prune files older than 3 days.
 * Safe to call multiple times (mkdir is idempotent with recursive).
 */
export function initFileLogger(): void {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  pruneOldLogs(3);
}

/**
 * Append a single JSON-line entry to today's log file.
 * The entire serialized line is run through redactSensitiveText() before writing.
 */
export function writeLogEntry(entry: LogEntry): void {
  ensureLogDir();
  const line = redactSensitiveText(JSON.stringify(entry)) + '\n';
  try {
    fs.appendFileSync(logFilePath(), line, 'utf-8');
  } catch {
    // Best-effort — never throw from the logger.
  }
}
