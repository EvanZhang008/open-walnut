/**
 * Unit tests for src/logging/subsystem.ts
 *
 * Covers: createSubsystemLogger() — all 6 methods, child() nesting,
 * writeLogEntry delegation, meta passthrough, and stderr output.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock writeLogEntry so we don't need real file I/O
vi.mock('../../src/logging/logger.js', () => ({
  writeLogEntry: vi.fn(),
}));

import { createSubsystemLogger } from '../../src/logging/subsystem.js';
import { writeLogEntry } from '../../src/logging/logger.js';
import type { LogLevel } from '../../src/logging/levels.js';

const mockedWriteLogEntry = vi.mocked(writeLogEntry);

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  mockedWriteLogEntry.mockClear();
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  stderrSpy.mockRestore();
});

describe('createSubsystemLogger', () => {
  it('returns a logger with all 6 level methods', () => {
    const logger = createSubsystemLogger('test');
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      expect(typeof logger[level]).toBe('function');
    }
  });

  it('has a child() method', () => {
    const logger = createSubsystemLogger('parent');
    expect(typeof logger.child).toBe('function');
  });

  it('each level method calls writeLogEntry with correct subsystem and level', () => {
    const logger = createSubsystemLogger('bus');
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

    for (const level of levels) {
      mockedWriteLogEntry.mockClear();
      logger[level](`${level} message`);

      expect(mockedWriteLogEntry).toHaveBeenCalledOnce();
      const entry = mockedWriteLogEntry.mock.calls[0][0];
      expect(entry.level).toBe(level);
      expect(entry.subsystem).toBe('bus');
      expect(entry.message).toBe(`${level} message`);
      expect(entry.time).toBeDefined();
    }
  });

  it('passes meta through to writeLogEntry', () => {
    const logger = createSubsystemLogger('agent');
    logger.info('task created', { taskId: 'abc', count: 5 });

    expect(mockedWriteLogEntry).toHaveBeenCalledOnce();
    const entry = mockedWriteLogEntry.mock.calls[0][0];
    expect(entry.taskId).toBe('abc');
    expect(entry.count).toBe(5);
  });

  it('does not include meta keys when meta is undefined', () => {
    const logger = createSubsystemLogger('web');
    logger.info('no meta');

    const entry = mockedWriteLogEntry.mock.calls[0][0];
    // Only the standard fields should be present
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(['time', 'level', 'subsystem', 'message']),
    );
    // No extra keys beyond the standard 4
    const extraKeys = Object.keys(entry).filter(
      (k) => !['time', 'level', 'subsystem', 'message'].includes(k),
    );
    expect(extraKeys).toHaveLength(0);
  });

  it('does not include meta keys when meta is empty object', () => {
    const logger = createSubsystemLogger('web');
    logger.warn('empty meta', {});

    const entry = mockedWriteLogEntry.mock.calls[0][0];
    const extraKeys = Object.keys(entry).filter(
      (k) => !['time', 'level', 'subsystem', 'message'].includes(k),
    );
    expect(extraKeys).toHaveLength(0);
  });
});

describe('child()', () => {
  it('creates a logger with tag "parent/sub"', () => {
    const parent = createSubsystemLogger('parent');
    const child = parent.child('sub');
    child.info('from child');

    const entry = mockedWriteLogEntry.mock.calls[0][0];
    expect(entry.subsystem).toBe('parent/sub');
  });

  it('supports nested children: parent/a/b', () => {
    const parent = createSubsystemLogger('parent');
    const grandchild = parent.child('a').child('b');
    grandchild.debug('deep');

    const entry = mockedWriteLogEntry.mock.calls[0][0];
    expect(entry.subsystem).toBe('parent/a/b');
  });

  it('child logger has all 6 level methods', () => {
    const child = createSubsystemLogger('root').child('child');
    const levels: LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    for (const level of levels) {
      expect(typeof child[level]).toBe('function');
    }
  });
});

describe('stderr output', () => {
  it('writes to process.stderr', () => {
    const logger = createSubsystemLogger('test-stderr');
    logger.info('visible on stderr');

    expect(stderrSpy).toHaveBeenCalled();
  });

  it('stderr output contains the subsystem tag', () => {
    const logger = createSubsystemLogger('my-subsystem');
    logger.warn('some warning');

    expect(stderrSpy).toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('my-subsystem');
  });

  it('stderr output contains the message', () => {
    const logger = createSubsystemLogger('test');
    logger.error('oh no');

    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('oh no');
  });

  it('stderr output ends with a newline', () => {
    const logger = createSubsystemLogger('test');
    logger.info('newline test');

    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written.endsWith('\n')).toBe(true);
  });

  it('stderr output contains the level label', () => {
    const logger = createSubsystemLogger('test');

    // Test a few representative levels
    logger.info('info msg');
    let written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('INF');

    stderrSpy.mockClear();
    logger.error('err msg');
    written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('ERR');
  });
});
