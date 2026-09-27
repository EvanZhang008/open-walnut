/**
 * Queue rule for pre-assigned uuid rows (spec 5.4, C49 queue half).
 *
 * A row with a `userUuid` is a question's head row: a thread anchor is keyed by
 * that uuid. It must become its own transcript line in its own turn, so the
 * native drain never batches it and a mid-turn inject never takes it. Plain rows
 * keep today's batching byte for byte.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-queue-uuid-rows'));

import {
  enqueueMessage, getQueue, markProcessing, removeProcessed, resetCache,
} from '../../src/core/session-message-queue.js';
import { pickBatchUuid, splitBatchAtUuid } from '../../src/providers/batch-uuid.js';
import { WALNUT_HOME } from '../../src/constants.js';

const SID = 'queue-uuid-session';
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

afterEach(async () => {
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

/** Drain like processNext does: one markProcessing per turn, then remove. */
async function drainTurns(): Promise<Array<{ texts: string[]; uuid: string | undefined }>> {
  const turns: Array<{ texts: string[]; uuid: string | undefined }> = [];
  for (let i = 0; i < 10; i++) {
    const batch = await markProcessing(SID, null);
    if (batch.length === 0) break;
    turns.push({ texts: batch.map((m) => m.message), uuid: pickBatchUuid(batch) });
    await removeProcessed(SID, batch.map((m) => m.id));
  }
  return turns;
}

describe('splitBatchAtUuid', () => {
  it('a uuid row at the head goes alone; a plain run stops before the first uuid row', () => {
    const p = (message: string) => ({ message });
    const u = (message: string, userUuid: string) => ({ message, userUuid });
    expect(splitBatchAtUuid([])).toEqual([]);
    expect(splitBatchAtUuid([u('q1', U1), p('a'), u('q2', U2)])).toEqual([u('q1', U1)]);
    expect(splitBatchAtUuid([p('a'), p('b'), u('q1', U1), p('c')])).toEqual([p('a'), p('b')]);
    expect(splitBatchAtUuid([p('a'), p('b')])).toEqual([p('a'), p('b')]);
  });
});

describe('markProcessing with uuid rows', () => {
  it('3 questions queued while an answer streams: never batched, one uuid per turn', async () => {
    await enqueueMessage(SID, 'question one', { userUuid: U1 });
    await enqueueMessage(SID, 'question two', { userUuid: U2 });
    await enqueueMessage(SID, 'question three', { userUuid: U3 });
    const turns = await drainTurns();
    expect(turns).toEqual([
      { texts: ['question one'], uuid: U1 },
      { texts: ['question two'], uuid: U2 },
      { texts: ['question three'], uuid: U3 },
    ]);
  });

  it('plain rows still batch; a uuid row between them splits the run', async () => {
    await enqueueMessage(SID, 'plain a');
    await enqueueMessage(SID, 'plain b');
    await enqueueMessage(SID, 'question one', { userUuid: U1 });
    await enqueueMessage(SID, 'plain c');
    await enqueueMessage(SID, 'plain d');
    const turns = await drainTurns();
    expect(turns).toEqual([
      { texts: ['plain a', 'plain b'], uuid: undefined },
      { texts: ['question one'], uuid: U1 },
      { texts: ['plain c', 'plain d'], uuid: undefined },
    ]);
  });

  it('rows without any uuid keep the old whole-queue batch', async () => {
    for (const t of ['a', 'b', 'c']) await enqueueMessage(SID, t);
    const batch = await markProcessing(SID, null);
    expect(batch.map((m) => m.message)).toEqual(['a', 'b', 'c']);
    expect(batch.every((m) => !('userUuid' in m))).toBe(true);
  });

  it('mid-turn takes nothing while any pending row carries a uuid', async () => {
    await enqueueMessage(SID, 'plain a');
    await enqueueMessage(SID, 'question one', { userUuid: U1 });
    expect(await markProcessing(SID, null, { midTurn: true })).toEqual([]);
    const queue = await getQueue(SID);
    expect(queue.map((m) => m.status)).toEqual(['pending', 'pending']);
    // The turn ends: processNext's normal drain delivers them one turn each.
    const turns = await drainTurns();
    expect(turns.map((t) => t.uuid)).toEqual([undefined, U1]);
  });

  it('mid-turn still injects plain rows exactly as before', async () => {
    await enqueueMessage(SID, 'plain a');
    await enqueueMessage(SID, 'plain b');
    const batch = await markProcessing(SID, null, { midTurn: true });
    expect(batch.map((m) => m.message)).toEqual(['plain a', 'plain b']);
  });
});
