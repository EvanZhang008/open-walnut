/**
 * The queue marks a trigger message that sat too long when it picks the row for a
 * write, on both pick paths, and keeps what it wrote (a later resend says the
 * newer wait, never two notes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  enqueueMessage, markNextProcessing, markProcessing, revertToPending, getQueue, resetCache,
} from '../../src/core/session-message-queue.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { buildTriggerMessage } from '../../src/core/routines/trigger-envelope.js';
import type { CronJob } from '../../src/core/cron/types.js';

const job = { id: 'job-1', name: 'Pipeline watch' } as CronJob;
const T0 = Date.parse('2026-10-06T01:20:05.000Z');
const envelope = buildTriggerMessage(job, { atMs: T0, items: [{ id: 'run-7' }] }, 'Check the run.');

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});

afterEach(async () => {
  vi.useRealTimers();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('a stale trigger message in the queue', () => {
  it('goes out as it was when it is written promptly', async () => {
    await enqueueMessage('s1', envelope);
    vi.setSystemTime(T0 + 30_000);
    const [row] = await markProcessing('s1');
    expect(row.message).toBe(envelope);
  });

  it('says how old it is when written days later, and a resend rewrites the note', async () => {
    await enqueueMessage('s1', envelope);
    vi.setSystemTime(T0 + 2 * 3_600_000);
    const [first] = await markProcessing('s1');
    expect(first.message).toContain('Walnut note: this trigger message was queued at 2026-10-06T01:20:05.000Z and reaches you 2h later');
    // The note is stored: a restart resends the same text.
    resetCache();
    expect((await getQueue('s1'))[0].message).toBe(first.message);

    await revertToPending([first]);
    vi.setSystemTime(T0 + 4 * 86_400_000);
    const [again] = await markProcessing('s1');
    expect(again.lineUuid).toBe(first.lineUuid);
    expect(again.message.match(/Walnut note:/g)).toHaveLength(1);
    expect(again.message).toContain('reaches you 4d later');
  });

  it('the one-at-a-time pick marks it too, and a plain message is never touched', async () => {
    await enqueueMessage('acp', envelope);
    await enqueueMessage('plain', 'please look at the build');
    vi.setSystemTime(T0 + 3 * 3_600_000);
    const [row] = await markNextProcessing('acp');
    expect(row.message).toContain('reaches you 3h later');
    const [plain] = await markProcessing('plain');
    expect(plain.message).toBe('please look at the build');
  });
});
