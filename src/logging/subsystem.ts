/**
 * Subsystem-scoped loggers — the main API callers use.
 *
 * Each method writes to:
 *   1. File  — JSON line via writeLogEntry()
 *   2. stderr — colored human-readable via process.stderr.write()
 *
 * Usage:
 *   const log = createSubsystemLogger('bus');
 *   log.info('event dispatched', { name: 'task:created' });
 *   const child = log.child('coalesce');   // tag = 'bus/coalesce'
 */

import chalk from 'chalk';
import type { LogLevel } from './levels.js';
import { writeLogEntry } from './logger.js';
import { redactSensitiveText } from './redact.js';

// ── Types ──

export interface SubsystemLogger {
  trace(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  fatal(message: string, meta?: Record<string, unknown>): void;
  child(subName: string): SubsystemLogger;
}

// ── Chalk formatters per level ──

type ChalkFn = (text: string) => string;

export const levelColor: Record<LogLevel, ChalkFn> = {
  trace: chalk.gray,
  debug: chalk.cyan,
  info: chalk.green,
  warn: chalk.yellow,
  error: chalk.red,
  fatal: chalk.bgRed.white,
};

const levelLabel: Record<LogLevel, string> = {
  trace: 'TRC',
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
  fatal: 'FTL',
};

// ── Helpers ──

function timeStamp(d: Date): string {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return '';
  // Compact single-line JSON for terminal readability
  return ' ' + chalk.dim(JSON.stringify(meta));
}

function emit(
  level: LogLevel,
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const now = new Date();

  // 1. File — structured JSON line (redaction happens inside writeLogEntry)
  writeLogEntry({
    time: now.toISOString(),
    level,
    subsystem,
    message,
    ...(meta && Object.keys(meta).length > 0 ? meta : {}),
  });

  // 2. Terminal (stderr) — colored human-readable
  try {
    const colorFn = levelColor[level];
    const tag = chalk.bold(`[${subsystem}]`);
    const lbl = colorFn(levelLabel[level]);
    const ts = chalk.dim(timeStamp(now));
    const metaStr = formatMeta(meta);
    const line = redactSensitiveText(`${ts} ${lbl} ${tag} ${message}${metaStr}\n`);
    process.stderr.write(line);
  } catch {
    // Never let stderr failures propagate — pipe may be broken.
  }
}

// ── Factory ──

export function createSubsystemLogger(subsystem: string): SubsystemLogger {
  const logger: SubsystemLogger = {
    trace: (msg, meta) => emit('trace', subsystem, msg, meta),
    debug: (msg, meta) => emit('debug', subsystem, msg, meta),
    info: (msg, meta) => emit('info', subsystem, msg, meta),
    warn: (msg, meta) => emit('warn', subsystem, msg, meta),
    error: (msg, meta) => emit('error', subsystem, msg, meta),
    fatal: (msg, meta) => emit('fatal', subsystem, msg, meta),
    child(subName: string): SubsystemLogger {
      return createSubsystemLogger(`${subsystem}/${subName}`);
    },
  };
  return logger;
}
