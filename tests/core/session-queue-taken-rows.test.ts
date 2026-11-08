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
  revertIfQueued, revertToPending, settledLineUuid, unparkMessage, editMessage,
} from '../../src/core/session-message-queue.js';
import { lineUuidFor, resetLineCarriesForTesting, rowsCarriedBy } from '../../src/providers/batch-uuid.js';
import { SESSION_QUEUE_FILE, WALNUT_HOME } from '../../src/constants.js';
import { readQueueFileFresh, mutateStore, removeCancelledSnapshots } from '../../src/core/session-queue-store.js';
import { cancelledRows, repairCancelledTaken, requeueUnanswered } from '../../src/core/session-queue-lines.js';
import { fateOf } from '../../src/core/relay-fates.js';

const SID = 'queue-taken-session';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  resetLineCarriesForTesting();
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

  it('cancelled deletion rejects an actual atomic write failure without changing disk or cache, and can be retried', async () => {
    await enqueueMessage(SID, 'cancelled but not deleted');
    const batch = await markProcessing(SID);
    const rename = fsp.rename.bind(fsp);
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected queue replacement failure');
      return rename(from, to);
    });
    try {
      await expect(removeTaken(SID, batch.map((r) => r.id), { ran: false })).rejects.toThrow('injected queue replacement failure');
      expect(await getQueue(SID)).toEqual(batch);
      expect((await readQueueFileFresh()).queues[SID]).toEqual(batch);
      fault.mockRestore();
      await removeTaken(SID, batch.map((r) => r.id), { ran: false });
      expect(await getQueue(SID)).toEqual([]);
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined();
      expect(await settledLineUuid(batch[0].id)).toBeUndefined();
    } finally { fault.mockRestore(); }
  });

  it('cancelled deletion syncs the file and directory before resolving', async () => {
    await enqueueMessage(SID, 'durable cancel');
    const batch = await markProcessing(SID);
    const open = fsp.open.bind(fsp);
    const synced: string[] = [];
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (String(args[0]).startsWith(WALNUT_HOME)) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, 'sync').mockImplementation(async () => { await sync(); synced.push(String(args[0])); });
      }
      return handle;
    });
    try {
      await removeTaken(SID, batch.map((r) => r.id), { ran: false });
      expect(synced).toHaveLength(2);
      expect(synced[0]).toMatch(/\.open-walnut-.*\.tmp$/);
      expect(synced[1]).toBe(WALNUT_HOME);
      expect(await getQueue(SID)).toEqual([]);
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined();
    } finally { spy.mockRestore(); }
  });

  it('cancelled durable deletion keeps complete rows in the same file across cache reset and boot', async () => {
    await enqueueMessage(SID, 'cancelled phone prompt', { id: 'qm-mobile-backup' });
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    expect(await getQueue(SID)).toEqual([]);
    const readBackup = async () => (JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf8')).cancelled?.[SID]?.[batch[0].lineUuid!] as { rows: typeof batch } | undefined)?.rows;
    expect(await readBackup()).toEqual(batch);
    expect(await cancelledRows(SID, batch[0].lineUuid)).toEqual(batch);
    resetCache();
    await loadQueue();
    expect(await getQueue(SID)).toEqual([]); // boot never sends a cancelled snapshot
    expect(await readBackup()).toEqual(batch);
    expect(await cancelledRows(SID)).toEqual(batch);
  });

  it('cancelled snapshot survives a real repair write failure and restores processing after a fresh cache read', async () => {
    await enqueueMessage(SID, 'recover answer hold', { id: 'qm-mobile-repair-backup' });
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    resetCache();
    resetLineCarriesForTesting();
    const rename = fsp.rename.bind(fsp);
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected durable repair failure');
      return rename(from, to);
    });
    try {
      await expect(repairCancelledTaken(SID, batch, false, true)).rejects.toThrow('injected durable repair failure');
      const failed = JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf8'));
      expect(failed.cancelled?.[SID]?.[batch[0].lineUuid!]?.rows).toEqual(batch);
      expect(await getQueue(SID)).toEqual([]);
      expect(rowsCarriedBy(SID, batch[0].lineUuid!)).toEqual([]);
      fault.mockRestore();
      resetCache();
      await repairCancelledTaken(SID, batch, false, true);
      expect(await getQueue(SID)).toEqual(batch);
      expect(rowsCarriedBy(SID, batch[0].lineUuid!)).toEqual(batch.map((r) => r.id));
      expect(fateOf(await readQueueFileFresh(), batch[0].id)).toBe('taken');
      const repaired = JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf8'));
      expect(repaired.cancelled?.[SID]?.[batch[0].lineUuid!]).toBeUndefined();
    } finally { fault.mockRestore(); }
  });

  it('duplicate cancellation merges a durable snapshot once and preserves the original generation', async () => {
    await enqueueMessage(SID, 'original cancellation');
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    const saved = JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf8'));
    expect(saved.cancelled?.[SID]?.[batch[0].lineUuid!]?.rows).toEqual(batch);
    await repairCancelledTaken(SID, batch, true, true);
    expect(await settledLineUuid(batch[0].id)).toBe(batch[0].lineUuid);
    expect(await getQueue(SID)).toEqual([]);
  });

  it.each([false, true])('removal reports only the exact rows it removed under the lock (ran=%s)', async (ran) => {
    await enqueueMessage(SID, 'old first', { id: 'qm-mobile-replaced-first' });
    await enqueueMessage(SID, 'old second', { id: 'qm-mobile-retained-second' });
    const batch = await markProcessing(SID);
    const replacement = { ...batch[0], lineUuid: 'new-line', message: 'new first' };
    await mutateStore((s) => { s.queues[SID]![0] = replacement; }, true, true);
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran, rows: batch })).toEqual([batch[1]]);
    expect(await getQueue(SID)).toEqual([replacement]);
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran, rows: batch })).toEqual([]);
    expect(await getQueue(SID)).toEqual([replacement]);
    expect(await settledLineUuid(batch[0].id)).toBeUndefined();
    expect(await cancelledRows(SID)).toEqual(ran ? [] : [batch[1]]);
  });

  it('an unwritten cancellation keeps rows parked by a persistent Stop under the lock', async () => {
    await enqueueMessage(SID, 'stopped before send');
    const batch = await markProcessing(SID);
    await parkIfQueued(batch, 'Session stopped by user; retry explicitly to send');
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch, preserveParked: true })).toEqual([]);
    const [parked] = (await readQueueFileFresh()).queues[SID];
    expect(parked).toMatchObject({ id: batch[0].id, status: 'parked', lineUuid: batch[0].lineUuid });
    expect(await cancelledRows(SID)).toEqual([]);
    expect(await unparkMessage(SID, batch[0].id)).toBe(true);
    expect((await markProcessing(SID)).map((r) => r.id)).toEqual([batch[0].id]);
  });

  it('a late live cancellation leaves a persistent Stop row and its edited text for explicit Retry', async () => {
    await enqueueMessage(SID, 'old text');
    const batch = await markProcessing(SID);
    await parkIfQueued(batch, 'Session stopped by user; retry explicitly to send');
    expect(await editMessage(SID, batch[0].id, 'edited while stopping')).toBe(true);
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch, confirmedCancelled: true })).toEqual([]);
    const [kept] = await getQueue(SID);
    expect([kept.status, kept.message]).toEqual(['parked', 'edited while stopping']);
    expect(kept.lineUuid).not.toBe(batch[0].lineUuid);
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch, confirmedCancelled: true })).toEqual([]);
    expect((await getQueue(SID))[0].lineUuid).toBe(kept.lineUuid);
    expect(await cancelledRows(SID)).toEqual([]);
  });

  it('a process stop without a CLI cancellation keeps the old parked UUID for a late completed frame', async () => {
    await enqueueMessage(SID, 'stopped before the late completed word');
    const batch = await markProcessing(SID);
    await parkIfQueued(batch, 'Session stopped by user; retry explicitly to send');
    expect(await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch })).toEqual([]);
    expect((await getQueue(SID))[0].lineUuid).toBe(batch[0].lineUuid);
    await removeTaken(SID, batch.map((r) => r.id), { ran: true, rows: batch });
    expect(await getQueue(SID)).toEqual([]);
    expect(await settledLineUuid(batch[0].id)).toBe(batch[0].lineUuid);
  });

  it('a cancellation returns the stored text edited while its line was pending', async () => {
    await enqueueMessage(SID, 'old text');
    const batch = await markProcessing(SID);
    await revertToPending(batch);
    expect(await editMessage(SID, batch[0].id, 'edited text')).toBe(true);
    expect((await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch })).map((r) => r.message)).toEqual(['edited text']);
    expect((await cancelledRows(SID)).map((r) => r.message)).toEqual(['edited text']);
  });

  it('an empty or missing queue reports no removed rows', async () => {
    expect(await removeTaken(SID, [])).toEqual([]);
    expect(await removeTaken(SID, ['missing-row'], { ran: false, rows: [] })).toEqual([]);
  });

  it('a completed captured line cannot delete a same-id row sent under another UUID', async () => {
    await enqueueMessage(SID, 'old line', { id: 'qm-mobile-old-completed' });
    const batch = await markProcessing(SID);
    const replacement = { ...batch[0], lineUuid: '77777777-7777-4777-8777-777777777777', message: 'new line' };
    await mutateStore((s) => { s.queues[SID] = [replacement]; }, true, true);
    await removeTaken(SID, batch.map((r) => r.id), { ran: true, rows: batch });
    expect(await getQueue(SID)).toEqual([replacement]);
    expect((await readQueueFileFresh()).queues[SID]).toEqual([replacement]);
    expect(await settledLineUuid(batch[0].id)).toBeUndefined();
  });

  it('cancelled snapshot repair never overwrites a reused id under a new line uuid', async () => {
    await enqueueMessage(SID, 'old generation');
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    const replacement = { ...batch[0], lineUuid: '44444444-4444-4444-8444-444444444444', message: 'new generation' };
    await mutateStore((s) => { s.queues[SID] = [replacement]; }, true, true);
    resetLineCarriesForTesting();
    await repairCancelledTaken(SID, batch, false, true);
    expect(rowsCarriedBy(SID, batch[0].lineUuid!)).toEqual([]);
    expect(rowsCarriedBy(SID, replacement.lineUuid)).toEqual([]);
    expect(await getQueue(SID)).toEqual([replacement]);
    expect((await readQueueFileFresh()).queues[SID]).toEqual([replacement]);
    expect(await settledLineUuid(batch[0].id)).toBeUndefined();
  });

  it('deleting cancellation snapshots fails durably and retries without clearing other sessions or phone fates', async () => {
    const row = await enqueueMessage(SID, 'original cancelled message', { id: 'pm-snapshot-delete' });
    const batch = await markProcessing(SID);
    await removeTaken(SID, [row.id], { ran: false, rows: batch });
    await enqueueMessage('retained-session', 'retained pending message');
    const before = await readQueueFileFresh();
    const rename = fsp.rename.bind(fsp);
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected snapshot cleanup failure');
      return rename(from, to);
    });
    try {
      await expect(removeCancelledSnapshots(new Set([SID]))).rejects.toThrow('injected snapshot cleanup failure');
      expect(await readQueueFileFresh()).toEqual(before);
      expect(await cancelledRows(SID)).toEqual(batch);
      fault.mockRestore();
      await removeCancelledSnapshots(new Set([SID]));
      resetCache();
      const after = await readQueueFileFresh();
      expect(after.cancelled).toBeUndefined();
      expect(after.queues).toEqual(before.queues);
      expect(after.relay).toEqual(before.relay);
      expect(await cancelledRows(SID)).toEqual([]);
    } finally { fault.mockRestore(); }
  });

  it('an unanswered cancelled backup goes back to pending under its own uuid across a restart, then resends once under a new one', async () => {
    await enqueueMessage(SID, 'taken by a holder that died', { id: 'qm-mobile-unanswered-backup' });
    const batch = await markProcessing(SID);
    const uuid = batch[0].lineUuid!;
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    // The restart: only the file remembers the cancellation.
    resetCache();
    await loadQueue();
    expect(await cancelledRows(SID, uuid)).toEqual(batch);
    const rename = fsp.rename.bind(fsp);
    const fault = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === SESSION_QUEUE_FILE) throw new Error('injected pending restore failure');
      return rename(from, to);
    });
    try {
      // One transaction: a failed write leaves the backup and no pending row, on disk and in the cache.
      await expect(repairCancelledTaken(SID, await cancelledRows(SID), false, true, { pending: true })).rejects.toThrow('injected pending restore failure');
      expect((await readQueueFileFresh()).cancelled?.[SID]?.[uuid]?.rows).toEqual(batch);
      expect((await readQueueFileFresh()).queues[SID]).toBeUndefined();
      expect(await getQueue(SID)).toEqual([]);
    } finally { fault.mockRestore(); }
    await repairCancelledTaken(SID, await cancelledRows(SID), false, true, { pending: true });
    const doubtful = (await readQueueFileFresh()).queues[SID];
    expect(doubtful).toMatchObject([{ id: batch[0].id, status: 'pending', lineUuid: uuid, lineInDoubt: true }]);
    expect(await cancelledRows(SID)).toEqual([]);
    resetCache();
    await loadQueue();
    // The delivery's unanswered verdict: one resend under a new uuid, then exhausted.
    const first = await requeueUnanswered(await getQueue(SID), uuid);
    expect(first.resent.map((r) => r.id)).toEqual([batch[0].id]);
    expect(first.resent[0].lineUuid).not.toBe(uuid);
    expect(first.resent[0].lineInDoubt).toBeUndefined();
    const second = await requeueUnanswered(await markProcessing(SID), first.resent[0].lineUuid);
    expect(second.resent).toEqual([]);
    expect(second.exhausted.map((r) => r.id)).toEqual([batch[0].id]);
  });

  it('a pending restore keeps a parked exact row parked and never touches a reused id under a new uuid', async () => {
    await enqueueMessage(SID, 'parked exact', { id: 'qm-parked-exact' });
    await enqueueMessage(SID, 'reused id', { id: 'qm-reused-id' });
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id), { ran: false, rows: batch });
    const parked = { ...batch[0], status: 'parked' as const, parkedReason: 'test-park' };
    const replacement = { ...batch[1], lineUuid: '88888888-8888-4888-8888-888888888888', message: 'new generation' };
    await mutateStore((s) => { s.queues[SID] = [{ ...parked }, { ...replacement }]; }, true, true);
    await repairCancelledTaken(SID, batch, false, true, { pending: true });
    expect((await readQueueFileFresh()).queues[SID]).toEqual([parked, replacement]);
    // The reused id's backup stays for its own late word; the parked one was restored.
    expect((await cancelledRows(SID)).map((r) => r.id)).toEqual([batch[1].id]);
  });

  it('RAM cancellation claims cannot insert a missing row without a durable cancelled snapshot', async () => {
    await enqueueMessage(SID, 'no cancellation evidence');
    const batch = await markProcessing(SID);
    await removeTaken(SID, batch.map((r) => r.id));
    await repairCancelledTaken(SID, batch, false, true);
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
    expect([b.status, b.parkedReason, b.lineTries]).toEqual(['parked', 'dropped', 0]);
    expect(b.lineUuid).not.toBe(rows[1].lineUuid);
    expect(b.userUuid).toBeUndefined();
    // A second park is a no-op (no second failure report).
    expect(await parkIfQueued(rows, 'again')).toEqual([]);
  });

  it('a fresh-line Retry has a genuinely new uuid even though its row id stays the same', async () => {
    await enqueueMessage(SID, 'try again', { id: 'qm-retry' });
    const [first] = await markProcessing(SID);
    await parkIfQueued([first], 'not acknowledged', { freshLine: true });
    resetCache();
    await loadQueue();
    await unparkMessage(SID, first.id);
    const [retry] = await markProcessing(SID);
    expect(retry.id).toBe(first.id);
    expect(retry.lineUuid).not.toBe(first.lineUuid);
    expect(retry.userUuid).toBeUndefined();
    await revertIfQueued([retry]);
    expect((await markProcessing(SID))[0].lineUuid).toBe(retry.lineUuid);
  });

  it('a pre-upgrade parked row with no line identity gets a fresh uuid on Retry', async () => {
    const originalUuid = lineUuidFor([{ id: 'sn-child-a-waiting' }]);
    const row = await enqueueMessage(SID, 'a later wait', { id: 'sn-child-a-waiting' });
    const { parkMessages } = await import('../../src/core/session-message-queue.js');
    await parkMessages([row], 'Claude Code never read this message (something else read its input). Retry to send it again');
    await unparkMessage(SID, row.id);
    expect((await markProcessing(SID))[0].lineUuid).not.toBe(originalUuid);
  });

  it('a never-sent question keeps its preassigned thread identity on Retry', async () => {
    const uuid = '11111111-1111-4111-8111-111111111111';
    const row = await enqueueMessage(SID, 'retry the dropped question', { userUuid: uuid });
    const { parkMessages } = await import('../../src/core/session-message-queue.js');
    await parkMessages([row], 'not acknowledged');
    await unparkMessage(SID, row.id);
    expect((await markProcessing(SID))[0].lineUuid).toBe(uuid);
  });

  it('a pending row that already went into stdin is immutable even after a restart', async () => {
    await enqueueMessage(SID, 'original');
    const [first] = await markProcessing(SID);
    await revertIfQueued([first]);
    expect(await editMessage(SID, first.id, 'changed', { onlyUnsent: true })).toBe(false);
    resetCache();
    await loadQueue();
    expect(await editMessage(SID, first.id, 'changed', { onlyUnsent: true })).toBe(false);
    expect((await getQueue(SID))[0].message).toBe('original');
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
    // 260 rows as an earlier process left them: one real enqueue gives the row's shape,
    // the rest are copies written to the queue file in one go. 260 enqueues, each a
    // locked rewrite of a growing file, took over 15 s on a loaded machine.
    const model = await enqueueMessage(SID, 'm0', { id: 'qm-s0' });
    const rows = Array.from({ length: 260 }, (_, i) => ({ ...model, id: `qm-s${i}`, message: `m${i}`, seq: model.seq + i }));
    const file = JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf8'));
    file.queues[SID] = rows;
    await fsp.writeFile(SESSION_QUEUE_FILE, JSON.stringify(file));
    await loadQueue();
    expect(await getQueue(SID)).toHaveLength(260);
    // Take them all, then settle them in order, in a few calls: the bound holds across
    // calls as well as inside one (a call settles its rows in queue order). One call per
    // row was 260 more locked rewrites.
    const taken: string[] = [];
    for (;;) {
      const batch = await markProcessing(SID);
      if (batch.length === 0) break;
      taken.push(...batch.map((m) => m.id));
    }
    expect(taken).toHaveLength(260);
    for (let i = 0; i < taken.length; i += 65) await removeTaken(SID, taken.slice(i, i + 65));
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
    expect(parked.lineUuid).not.toBe(again.lineUuid);
    expect(parked.lineTracked).toBeUndefined();
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
