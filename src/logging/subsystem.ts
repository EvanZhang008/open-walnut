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
import { shouldLog } from './levels.js';
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

// ── Error → notification bridge ──
// A single chokepoint so EVERY log.error()/fatal() anywhere in the server can
// land in the notification center, instead of each producer hand-wiring
// addNotification. The sink is injected by server.ts at startup (dependency
// direction: logging must not import notifications/store — everything imports
// logging, so that edge would be a cycle). CLI commands / daemons / tests that
// never set a sink are unaffected.

export interface ErrorNotifyPayload {
  subsystem: string;
  message: string;
  meta?: Record<string, unknown>;
}

// The sink lives on globalThis, NOT in module state: external plugins are
// esbuild-bundled with their own COPY of this module (integration-loader
// rebases + inlines src/ imports), so a module-level variable would be a
// different instance per bundle and plugin errors (the biggest producer —
// external plugin sync) would silently miss the sink.
const ERROR_SINK_KEY = Symbol.for('open-walnut.errorNotificationSink');
type GlobalWithSink = { [ERROR_SINK_KEY]?: ((payload: ErrorNotifyPayload) => void) | null };

let inErrorSink = false;

/** Install (or clear, with null) the error→notification sink. */
export function setErrorNotificationSink(
  sink: ((payload: ErrorNotifyPayload) => void) | null,
): void {
  (globalThis as GlobalWithSink)[ERROR_SINK_KEY] = sink;
}

function forwardToErrorSink(
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  const sink = (globalThis as GlobalWithSink)[ERROR_SINK_KEY];
  // Reentrancy guard: if the sink itself logs an error (e.g. the notification
  // store failing to write), don't loop back into the sink.
  if (!sink || inErrorSink) return;
  // The notification store's own logger — a store write failure logged at
  // error level must never try to write another notification.
  if (subsystem.startsWith('notif')) return;
  inErrorSink = true;
  try {
    sink({ subsystem, message, meta });
  } catch {
    // The sink must never break logging.
  } finally {
    inErrorSink = false;
  }
}

function emit(
  level: LogLevel,
  subsystem: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  // Level gate — FIRST thing, before any work. On the streaming hot path a
  // single live session emits tens of thousands of `debug` text-delta lines;
  // below the configured threshold we must do ZERO work (no JSON.stringify, no
  // synchronous stderr write, no redaction regex) or the event loop starves and
  // unrelated HTTP requests stall for 15 s. Default threshold is `info`.
  if (!shouldLog(level)) return;

  const now = new Date();

  // 1. File — structured JSON line (redaction happens inside writeLogEntry)
  writeLogEntry({
    time: now.toISOString(),
    level,
    subsystem,
    message,
    ...(meta && Object.keys(meta).length > 0 ? meta : {}),
  });

  // 2. Error/fatal → notification center (sink injected by server.ts; no-op elsewhere)
  if (level === 'error' || level === 'fatal') {
    forwardToErrorSink(subsystem, message, meta);
  }

  // 3. Terminal (stderr) — colored human-readable
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
