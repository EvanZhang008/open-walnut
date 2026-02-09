/**
 * Logging barrel — pre-created subsystem loggers and init entrypoint.
 *
 * Usage:
 *   import { log, initLogging } from './logging/index.js';
 *
 *   initLogging();                   // once at startup
 *   log.bus.info('event dispatched'); // anywhere
 */

import { initFileLogger } from './logger.js';
import { createSubsystemLogger } from './subsystem.js';

// ── Pre-created loggers for each Walnut subsystem ──

export const log = {
  bus: createSubsystemLogger('bus'),
  agent: createSubsystemLogger('agent'),
  session: createSubsystemLogger('session'),
  subagent: createSubsystemLogger('subagent'),
  web: createSubsystemLogger('web'),
  ws: createSubsystemLogger('ws'),
  hook: createSubsystemLogger('hook'),
  task: createSubsystemLogger('task'),
  memory: createSubsystemLogger('memory'),
  cron: createSubsystemLogger('cron'),
  usage: createSubsystemLogger('usage'),
  heartbeat: createSubsystemLogger('heartbeat'),
  git: createSubsystemLogger('git'),
};

// ── Initialization ──

let initialized = false;

/**
 * Create log directory and prune old files.
 * Safe to call multiple times — only runs once.
 */
export function initLogging(): void {
  if (initialized) return;
  initialized = true;
  initFileLogger();
}

// ── Re-exports ──

export { createSubsystemLogger } from './subsystem.js';
export type { SubsystemLogger } from './subsystem.js';
export type { LogLevel } from './levels.js';
export { shouldLog, LOG_LEVEL_ORDER } from './levels.js';
export type { LogEntry } from './logger.js';
export { redactSensitiveText } from './redact.js';
