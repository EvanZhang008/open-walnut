/**
 * Log level types and severity ordering.
 *
 * Currently everything logs at max verbosity (trace).
 * The shouldLog() gate is here for future use when we add
 * quiet / production modes.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
};

/**
 * Returns true if a message at `messageLevel` should be emitted
 * when the configured threshold is `configuredLevel`.
 */
export function shouldLog(messageLevel: LogLevel, configuredLevel: LogLevel): boolean {
  return LOG_LEVEL_ORDER[messageLevel] >= LOG_LEVEL_ORDER[configuredLevel];
}
