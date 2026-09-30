/**
 * The second-writer watchdog runs `lsof` on the task database each tick, and on a
 * machine with ~1000 processes each `lsof` is a full process-table walk. Pins the
 * default tick at 5 minutes (it was 60s) and that an explicit interval still wins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));
vi.mock('../../src/constants.js', () => createMockConstants('walnut-watchdog-interval'));

import { startForeignWriterWatchdog } from '../../src/core/instance-lock.js';

const lsofCalls = () => execFileMock.mock.calls.filter((c) => c[0] === 'lsof').length;

beforeEach(() => {
  execFileMock.mockReset();
  // lsof exit 1 = no holders.
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: (err: Error | null) => void) => {
    cb(Object.assign(new Error('exit 1'), { code: 1 }));
  });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startForeignWriterWatchdog interval', () => {
  it('defaults to one lsof every 5 minutes', () => {
    const dog = startForeignWriterWatchdog();
    try {
      vi.advanceTimersByTime(299_000);
      expect(lsofCalls()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(lsofCalls()).toBe(1);
      vi.advanceTimersByTime(300_000);
      expect(lsofCalls()).toBe(2);
    } finally {
      dog.stop();
    }
  });

  it('honours an explicit interval', () => {
    const dog = startForeignWriterWatchdog(10_000);
    try {
      vi.advanceTimersByTime(30_000);
      expect(lsofCalls()).toBe(3);
    } finally {
      dog.stop();
    }
  });
});
