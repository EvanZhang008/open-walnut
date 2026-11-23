/**
 * A queue file that exists but cannot be read never turns into an empty queue that the next write
 * saves over every session's rows (src/core/session-queue-store.ts persist; 2026-11-23, the user:
 * no message is ever lost). The read throws, the change waits for a later write, and every row
 * already on disk is still there once the file reads again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/constants.js')>();
  return { ...actual, ...createMockConstants('walnut-queue-read-error') };
});

import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js';
import { enqueueMessage, resetCache } from '../../src/core/session-message-queue.js';
import { mutateStore, readQueueFileFresh } from '../../src/core/session-queue-store.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('an unreadable queue file is never saved over', () => {
  it('a write during a read error fails, and every queued row is still on disk', async () => {
    await enqueueMessage('session-a', 'the user\'s words to a');
    await enqueueMessage('session-b', 'a peer note to b');
    const real = fsp.readFile.bind(fsp);
    const spy = vi.spyOn(fsp, 'readFile').mockImplementation(async (file, ...rest) => {
      if (String(file) === SESSION_QUEUE_FILE) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
      return real(file as never, ...(rest as []));
    });
    await expect(mutateStore((s) => { (s.queues['session-c'] ??= []); }, true)).rejects.toThrow(/EMFILE/);
    spy.mockRestore();
    const disk = await readQueueFileFresh();
    expect(disk.queues['session-a']?.map((m) => m.message)).toEqual(['the user\'s words to a']);
    expect(disk.queues['session-b']?.map((m) => m.message)).toEqual(['a peer note to b']);
  });
});
