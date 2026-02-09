/**
 * Unit tests for src/logging/levels.ts
 *
 * Covers: LogLevel type presence, LOG_LEVEL_ORDER ordering, shouldLog() gate.
 */
import { describe, it, expect } from 'vitest';
import { LOG_LEVEL_ORDER, shouldLog } from '../../src/logging/levels.js';
import type { LogLevel } from '../../src/logging/levels.js';

describe('LOG_LEVEL_ORDER', () => {
  it('contains all 6 log levels', () => {
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      expect(LOG_LEVEL_ORDER).toHaveProperty(level);
      expect(typeof LOG_LEVEL_ORDER[level]).toBe('number');
    }
  });

  it('orders levels: trace < debug < info < warn < error < fatal', () => {
    expect(LOG_LEVEL_ORDER.trace).toBeLessThan(LOG_LEVEL_ORDER.debug);
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info);
    expect(LOG_LEVEL_ORDER.info).toBeLessThan(LOG_LEVEL_ORDER.warn);
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error);
    expect(LOG_LEVEL_ORDER.error).toBeLessThan(LOG_LEVEL_ORDER.fatal);
  });
});

describe('shouldLog', () => {
  it('returns true when message level equals configured level', () => {
    expect(shouldLog('info', 'info')).toBe(true);
  });

  it('returns false when message level is below configured level', () => {
    expect(shouldLog('debug', 'info')).toBe(false);
  });

  it('returns true when message level is above configured level', () => {
    expect(shouldLog('error', 'trace')).toBe(true);
  });

  it('returns true for fatal at any configured level', () => {
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const configured of levels) {
      expect(shouldLog('fatal', configured)).toBe(true);
    }
  });

  it('returns false for trace when configured above trace', () => {
    const aboveTrace: LogLevel[] = ['debug', 'info', 'warn', 'error', 'fatal'];
    for (const configured of aboveTrace) {
      expect(shouldLog('trace', configured)).toBe(false);
    }
  });

  it('returns true for trace when configured at trace', () => {
    expect(shouldLog('trace', 'trace')).toBe(true);
  });
});
