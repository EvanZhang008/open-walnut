/**
 * Rows held for start recovery (session-queue-park.ts START_RECOVERY_HELD_REASON).
 *
 * 2026-11-05: a session's process ended before it read its first line, and the
 * first version of start recovery removed the rows and sent a copy of their text,
 * which was lost on every path that did not send and turned the user's own words
 * into Walnut's. The rows now stay in the queue, unchanged, held until recovery
 * starts the session again (deliver) or gives up (park for a Retry).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-queue-start-hold'));

import {
  enqueueMessage, getQueue, markNextProcessing, markProcessing, resetCache, removeProcessed,
  START_RECOVERY_HELD_REASON, holdForStartRecovery, sessionsWithStartRecoveryHeld, settleStartRecoveryHeld, startRecoveryHeld,
  parkIfQueued, removeStartRecoveryRows,
} from '../../src/core/session-message-queue.js';
import { WALNUT_HOME } from '../../src/constants.js';

const SID = 'start-hold-session';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

afterEach(async () => {
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('rows held for start recovery', () => {
  it('a held row keeps its id, words and uuid, and no delivery picks it up', async () => {
    const row = await enqueueMessage(SID, 'Fix the flaky test.', { userUuid: '0b6f2f5e-8f3a-4d6e-9c1a-2b3c4d5e6f70' });
    const taken = await markProcessing(SID);
    expect(await holdForStartRecovery(taken)).toEqual([row.id]);
    const [held] = await startRecoveryHeld(SID);
    expect(held).toMatchObject({ id: row.id, message: 'Fix the flaky test.', userUuid: row.userUuid, status: 'parked', parkedReason: START_RECOVERY_HELD_REASON });
    expect(await markNextProcessing(SID)).toEqual([]);
    expect(await sessionsWithStartRecoveryHeld()).toEqual([SID]);
  });

  it('a row a cleanup removed meanwhile is put back, held', async () => {
    await enqueueMessage(SID, 'gone');
    const taken = await markProcessing(SID);
    await removeProcessed(SID, taken.map((m) => m.id));
    await holdForStartRecovery(taken);
    expect((await startRecoveryHeld(SID)).map((m) => m.message)).toEqual(['gone']);
  });

  it('deliver puts them back to pending, as they were', async () => {
    const row = await enqueueMessage(SID, 'first');
    await holdForStartRecovery(await markProcessing(SID));
    expect(await settleStartRecoveryHeld(SID, 'deliver')).toEqual([row.id]);
    const [back] = await getQueue(SID);
    expect(back).toMatchObject({ id: row.id, message: 'first', status: 'pending' });
    expect(back.parkedReason).toBeUndefined();
    expect(await sessionsWithStartRecoveryHeld()).toEqual([]);
  });

  it('park leaves them for a Retry with the reason, and leaves other parked rows alone', async () => {
    await enqueueMessage(SID, 'mine');
    await holdForStartRecovery(await markProcessing(SID));
    await enqueueMessage(SID, 'parked for another reason', { heldReason: 'Waiting for the running turn to finish' });
    expect(await settleStartRecoveryHeld(SID, { park: 'Not delivered: x. Retry it.' })).toHaveLength(1);
    expect((await getQueue(SID)).map((m) => [m.message, m.status, m.parkedReason])).toEqual([
      ['mine', 'parked', 'Not delivered: x. Retry it.'],
      ['parked for another reason', 'parked', 'Waiting for the running turn to finish'],
    ]);
  });

  it('a session with nothing held settles nothing', async () => {
    expect(await settleStartRecoveryHeld(SID, 'deliver')).toEqual([]);
  });

  it('a pending-only park leaves alone a row a delivery took after the snapshot', async () => {
    const row = await enqueueMessage(SID, 'released line');
    const snapshot = await getQueue(SID);
    await markProcessing(SID);
    expect(await parkIfQueued(snapshot, 'Not delivered. Retry it.', { onlyPending: true })).toEqual([]);
    expect((await getQueue(SID)).find((m) => m.id === row.id)?.status).toBe('processing');
  });

  it('rows a late init read leave the queue whether held or already put back, never one being written', async () => {
    const writing = await enqueueMessage(SID, 'writing');
    await markProcessing(SID);
    const held = await enqueueMessage(SID, 'carried', { heldReason: START_RECOVERY_HELD_REASON });
    const back = await enqueueMessage(SID, 'put back');
    expect((await removeStartRecoveryRows(SID, [held.id, back.id, writing.id])).sort()).toEqual([held.id, back.id].sort());
    expect((await getQueue(SID)).map((m) => m.id)).toEqual([writing.id]);
  });

  it('with restart recovery turned off in config, the boot still parks rows a past recovery held', async () => {
    await enqueueMessage(SID, 'held before the restart', { heldReason: START_RECOVERY_HELD_REASON });
    const { recoverAfterBoot, getSessionAutoRecover } = await import('../../src/core/session-auto-recover.js');
    expect(getSessionAutoRecover()).toBeNull();
    await recoverAfterBoot([], new Map());
    const [row] = await getQueue(SID);
    expect(row.status).toBe('parked');
    expect(row.parkedReason).toMatch(/^Not delivered: .*Retry it\.$/);
  });
});
