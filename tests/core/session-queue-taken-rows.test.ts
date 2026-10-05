/**
 * Queue primitives for rows whose line may already be in a CLI.
 *
 * - A row's line uuid is fixed by the write that first marks it, persisted with
 *   it, and kept across a server restart (loadQueue), so a redelivery goes out
 *   under the same uuid and alone: rows that went out in a line never merge
 *   with rows that did not (the r1 restart path merged them under a NEW uuid,
 *   and the CLI ran the first message twice).
 * - `removeTaken` removes rows the CLI reported taking, whatever their state.
 * - `revertIfQueued` / `parkIfQueued` never re-insert a row that is gone: a
 *   missing row is one the CLI already took.
 * - A resend of a row that ran (Retry, the phone's same-id resend) keeps its
 *   line's uuid; a resend of a cancelled one does not.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-queue-taken-rows'));

import {
  enqueueMessage, getQueue, loadQueue, markProcessing, parkIfQueued, removeProcessed, removeTaken, resetCache,
  revertIfQueued, revertToPending, settledLineUuid,
} from '../../src/core/session-message-queue.js';
import { lineUuidFor } from '../../src/providers/batch-uuid.js';
import { WALNUT_HOME } from '../../src/constants.js';

const SID = 'queue-taken-session';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

afterEach(async () => {
  resetCache();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

const statuses = async () => (await getQueue(SID)).map((m) => `${m.message}:${m.status}`);

describe('rows whose line may be in a CLI', () => {
  it('the first mark fixes the line uuid on the rows, on disk', async () => {
    await enqueueMessage(SID, 'a');
    await enqueueMessage(SID, 'b');
    const batch = await markProcessing(SID);
    const uuid = lineUuidFor(batch);
    expect(batch.map((m) => [m.message, m.lineUuid, m.lineTries])).toEqual([['a', uuid, 1], ['b', uuid, 1]]);
    // A restart reads the rows back with their uuid and try count.
    resetCache();
    await loadQueue();
    const rows = await getQueue(SID);
    expect(rows.map((m) => [m.message, m.status, m.lineUuid, m.lineTries])).toEqual([
      ['a', 'pending', uuid, 1], ['b', 'pending', uuid, 1],
    ]);
  });

  it('after a restart a written line goes out alone, under its uuid, and new rows never join it', async () => {
    await enqueueMessage(SID, 'first');
    const [first] = await markProcessing(SID);
    // The server dies after the write; the user sends another message meanwhile.
    resetCache();
    await loadQueue();
    await enqueueMessage(SID, 'second');
    const redelivery = await markProcessing(SID);
    expect(redelivery.map((m) => m.message)).toEqual(['first']);
    expect(redelivery[0].lineUuid).toBe(first.lineUuid);
    expect(redelivery[0].lineTries).toBe(2);
    const next = await markProcessing(SID);
    expect(next.map((m) => m.message)).toEqual(['second']);
    expect(next[0].lineUuid).not.toBe(first.lineUuid);
    expect(next[0].lineTries).toBe(1);
  });

  it('two written lines stay apart after a restart', async () => {
    await enqueueMessage(SID, 'a');
    const [a] = await markProcessing(SID);
    await enqueueMessage(SID, 'b');
    const [b] = await markProcessing(SID);
    resetCache();
    await loadQueue();
    expect((await markProcessing(SID)).map((m) => [m.message, m.lineUuid])).toEqual([['a', a.lineUuid]]);
    expect((await markProcessing(SID)).map((m) => [m.message, m.lineUuid])).toEqual([['b', b.lineUuid]]);
  });

  it('removeTaken removes a row even after it went back to pending', async () => {
    await enqueueMessage(SID, 'a');
    const [row] = await markProcessing(SID);
    await revertToPending([row]);
    await removeTaken(SID, [row.id]);
    expect(await getQueue(SID)).toEqual([]);
  });

  it('revertIfQueued never brings back a row the CLI took', async () => {
    await enqueueMessage(SID, 'a');
    await enqueueMessage(SID, 'b');
    const rows = await markProcessing(SID);
    await removeTaken(SID, [rows[0].id]);
    await revertIfQueued(rows);
    expect(await statuses()).toEqual(['b:pending']);
  });

  it('parkIfQueued parks what is still there and returns it; freshLine clears the uuid', async () => {
    await enqueueMessage(SID, 'a');
    await enqueueMessage(SID, 'b');
    const rows = await markProcessing(SID);
    await removeTaken(SID, [rows[0].id]);
    const parked = await parkIfQueued(rows, 'dropped', { freshLine: true });
    expect(parked.map((m) => m.message)).toEqual(['b']);
    const [b] = await getQueue(SID);
    expect([b.status, b.parkedReason, b.lineUuid, b.lineTries]).toEqual(['parked', 'dropped', undefined, undefined]);
    // A second park is a no-op (no second failure report).
    expect(await parkIfQueued(rows, 'again')).toEqual([]);
  });

  it('a resend of a row that ran keeps its line uuid; of a cancelled one, not', async () => {
    await enqueueMessage(SID, 'ran', { id: 'qm-ran' });
    await enqueueMessage(SID, 'cancelled', { id: 'qm-cancelled' });
    await enqueueMessage(SID, 'written', { id: 'qm-written' });
    const rows = await markProcessing(SID);
    await removeTaken(SID, ['qm-ran']);
    await removeTaken(SID, ['qm-cancelled'], { ran: false });
    await removeProcessed(SID, ['qm-written']);
    expect(await settledLineUuid('qm-ran')).toBe(rows[0].lineUuid);
    expect(await settledLineUuid('qm-cancelled')).toBeUndefined();
    expect(await settledLineUuid('qm-written')).toBe(rows[0].lineUuid);
    // The phone's same-id resend inherits it; so does an explicit lineUuid (web Retry).
    const again = await enqueueMessage(SID, 'ran', { id: 'qm-ran' });
    expect([again.lineUuid, again.lineTries]).toEqual([rows[0].lineUuid, 1]);
    const [resend] = await markProcessing(SID);
    expect([resend.lineUuid, resend.lineTries]).toEqual([rows[0].lineUuid, 2]);
    const retry = await enqueueMessage(SID, 'retry', { lineUuid: rows[0].lineUuid });
    expect(retry.lineUuid).toBe(rows[0].lineUuid);
  });

  it('M2: a settled line uuid survives a server restart (a Retry after a deploy keeps it)', async () => {
    await enqueueMessage(SID, 'ran before the deploy', { id: 'qm-before' });
    const [row] = await markProcessing(SID);
    await removeTaken(SID, ['qm-before']);
    // The restart: a fresh process reads the queue file again.
    resetCache();
    await loadQueue();
    expect(await settledLineUuid('qm-before')).toBe(row.lineUuid);
    const again = await enqueueMessage(SID, 'ran before the deploy', { id: 'qm-before' });
    expect(again.lineUuid).toBe(row.lineUuid);
  });

  it('M2: the settled record is bounded, oldest first', async () => {
    for (let i = 0; i < 260; i++) await enqueueMessage(SID, `m${i}`, { id: `qm-s${i}` });
    // One line per batch: take them all, then settle them in order.
    const taken: string[] = [];
    for (;;) {
      const batch = await markProcessing(SID);
      if (batch.length === 0) break;
      taken.push(...batch.map((m) => m.id));
    }
    for (const id of taken) await removeTaken(SID, [id]);
    expect(await settledLineUuid('qm-s0')).toBeUndefined();
    expect(await settledLineUuid('qm-s3')).toBeUndefined();
    expect(await settledLineUuid('qm-s4')).toBeDefined();
    expect(await settledLineUuid('qm-s259')).toBeDefined();
  });

  it('B2: rows written into a CLI that reports its queue say so, also after a restart', async () => {
    await enqueueMessage(SID, 'tracked', { id: 'qm-t' });
    await markProcessing(SID, undefined, { tracked: true });
    resetCache();
    await loadQueue();
    const [row] = await getQueue(SID);
    expect([row.status, row.lineTracked]).toEqual(['pending', true]);
    // A later attempt that does not know never clears it.
    const [again] = await markProcessing(SID);
    expect(again.lineTracked).toBe(true);
    // A line the CLI dropped goes out fresh on a Retry: the flag goes with the uuid.
    const [parked] = await parkIfQueued([again], 'dropped', { freshLine: true });
    expect([parked.lineUuid, parked.lineTracked]).toEqual([undefined, undefined]);
  });

  it('the same rows always get the same line uuid, other rows another one', async () => {
    const a = [{ id: 'qm-1' }, { id: 'qm-2' }];
    expect(lineUuidFor(a)).toBe(lineUuidFor([{ id: 'qm-1' }, { id: 'qm-2' }]));
    expect(lineUuidFor(a)).not.toBe(lineUuidFor([{ id: 'qm-1' }]));
    expect(lineUuidFor(a)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // A question row keeps its pre-assigned uuid.
    const u = '11111111-1111-4111-8111-111111111111';
    expect(lineUuidFor([{ id: 'qm-1', userUuid: u }])).toBe(u);
  });
});
