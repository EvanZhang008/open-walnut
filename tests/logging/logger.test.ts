/**
 * Unit tests for src/logging/logger.ts
 *
 * Covers: initFileLogger() directory creation, writeLogEntry() JSON-line output,
 * redaction in written lines, file naming, and append behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

// Build a unique tmpdir for LOG_DIR
vi.mock('../../src/constants.js', () => createMockConstants());

import { initFileLogger, writeLogEntry } from '../../src/logging/logger.js';
import { LOG_DIR, LOG_PREFIX } from '../../src/constants.js';

let logDir: string;

beforeEach(async () => {
  logDir = LOG_DIR;
  await fsp.rm(logDir, { recursive: true, force: true });
});

afterEach(async () => {
  await fsp.rm(logDir, { recursive: true, force: true });
});

describe('initFileLogger', () => {
  it('creates the log directory', () => {
    expect(fs.existsSync(logDir)).toBe(false);
    initFileLogger();
    expect(fs.existsSync(logDir)).toBe(true);
  });

  it('is idempotent — calling twice does not throw', () => {
    initFileLogger();
    expect(() => initFileLogger()).not.toThrow();
  });
});

describe('writeLogEntry', () => {
  beforeEach(() => {
    initFileLogger();
  });

  it('writes a JSON line to the log file', () => {
    writeLogEntry({
      time: '2025-01-15T10:00:00.000Z',
      level: 'info',
      subsystem: 'test',
      message: 'hello world',
    });

    const files = fs.readdirSync(logDir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const logFile = files.find((f) => f.startsWith(LOG_PREFIX) && f.endsWith('.log'));
    expect(logFile).toBeDefined();

    const content = fs.readFileSync(path.join(logDir, logFile!), 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.level).toBe('info');
    expect(parsed.subsystem).toBe('test');
    expect(parsed.message).toBe('hello world');
  });

  it('written line can be parsed back as JSON with correct fields', () => {
    writeLogEntry({
      time: '2025-06-01T12:30:00.000Z',
      level: 'warn',
      subsystem: 'bus',
      message: 'slow subscriber',
      duration: 150,
    });

    const files = fs.readdirSync(logDir);
    const logFile = files.find((f) => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))!;
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    const parsed = JSON.parse(content.trim());

    expect(parsed.time).toBe('2025-06-01T12:30:00.000Z');
    expect(parsed.level).toBe('warn');
    expect(parsed.subsystem).toBe('bus');
    expect(parsed.message).toBe('slow subscriber');
    expect(parsed.duration).toBe(150);
  });

  it('redacts sensitive data in written lines', () => {
    writeLogEntry({
      time: '2025-01-15T10:00:00.000Z',
      level: 'error',
      subsystem: 'agent',
      message: 'auth failed with key sk-ant-api03-abcdefghijklmnopqrst',
    });

    const files = fs.readdirSync(logDir);
    const logFile = files.find((f) => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))!;
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');

    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-ant-api03-abcdefghijklmnopqrst');
  });

  it('log file name follows walnut-YYYY-MM-DD.log pattern', () => {
    writeLogEntry({
      time: '2025-01-15T10:00:00.000Z',
      level: 'info',
      subsystem: 'test',
      message: 'check filename',
    });

    const files = fs.readdirSync(logDir);
    const logFile = files.find((f) => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))!;
    // Pattern: <LOG_PREFIX>YYYY-MM-DD.log
    expect(logFile).toMatch(new RegExp(`^${LOG_PREFIX}\\d{4}-\\d{2}-\\d{2}\\.log$`));
  });

  it('multiple writes append, not overwrite', () => {
    writeLogEntry({
      time: '2025-01-15T10:00:00.000Z',
      level: 'info',
      subsystem: 'test',
      message: 'line one',
    });
    writeLogEntry({
      time: '2025-01-15T10:00:01.000Z',
      level: 'debug',
      subsystem: 'test',
      message: 'line two',
    });
    writeLogEntry({
      time: '2025-01-15T10:00:02.000Z',
      level: 'warn',
      subsystem: 'test',
      message: 'line three',
    });

    const files = fs.readdirSync(logDir);
    const logFile = files.find((f) => f.startsWith(LOG_PREFIX) && f.endsWith('.log'))!;
    const content = fs.readFileSync(path.join(logDir, logFile), 'utf-8');
    const lines = content.trim().split('\n');

    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).message).toBe('line one');
    expect(JSON.parse(lines[1]).message).toBe('line two');
    expect(JSON.parse(lines[2]).message).toBe('line three');
  });
});
