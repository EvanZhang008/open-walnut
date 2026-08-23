/**
 * Unit tests for session message queue (src/core/session-message-queue.ts).
 * Covers enqueue, markProcessing, removeProcessed, edit, delete, getQueue,
 * getAllSessionsWithPending, loadQueue crash recovery, and multi-session isolation.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  loadQueue,
  enqueueMessage,
  markNextProcessing,
  markProcessing,
  removeProcessed,
  revertToPending,
  editMessage,
  deleteMessage,
  getQueue,
  isMessageQueued,
  getAllSessionsWithPending,
  migrateSessionQueue,
  rollbackSessionQueueMigration,
  parkMessages,
  parkStalePending,
  unparkMessage,
  MAX_PENDING_AGE_MS,
  resetCache,
} from '../../src/core/session-message-queue.js';
import { WALNUT_HOME, SESSION_QUEUE_FILE } from '../../src/constants.js';

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
});

afterEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('enqueueMessage', () => {
  it('returns a QueuedMessage with id, status pending, and timestamp', async () => {
    const msg = await enqueueMessage('sess-1', 'hello');
    expect(msg.id).toMatch(/^qm-/);
    expect(msg.sessionId).toBe('sess-1');
    expect(msg.message).toBe('hello');
    expect(msg.status).toBe('pending');
    expect(msg.enqueuedAt).toBeTruthy();
    // Verify it parses as ISO date
    expect(new Date(msg.enqueuedAt).toISOString()).toBe(msg.enqueuedAt);
  });

  it('persists to disk and survives cache reset', async () => {
    const msg = await enqueueMessage('sess-1', 'persisted');

    resetCache();

    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(msg.id);
    expect(queue[0].message).toBe('persisted');
    expect(queue[0].status).toBe('pending');
  });
});

describe('markProcessing', () => {
  it('marks all pending messages as processing and returns them', async () => {
    await enqueueMessage('sess-1', 'msg1');
    await enqueueMessage('sess-1', 'msg2');
    await enqueueMessage('sess-1', 'msg3');

    const batch = await markProcessing('sess-1');
    expect(batch).toHaveLength(3);
    for (const m of batch) {
      expect(m.status).toBe('processing');
    }

    // Verify via getQueue that all are processing
    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(3);
    for (const m of queue) {
      expect(m.status).toBe('processing');
    }
  });

  it('returns empty array if no pending messages', async () => {
    await enqueueMessage('sess-1', 'msg1');
    await markProcessing('sess-1');

    // Second call should return empty since all are processing now
    const batch2 = await markProcessing('sess-1');
    expect(batch2).toEqual([]);
  });

  it('returns empty array for unknown session', async () => {
    const batch = await markProcessing('nonexistent');
    expect(batch).toEqual([]);
  });
});

describe('markNextProcessing', () => {
  it('marks only the oldest pending message and preserves exact text and ID', async () => {
    const first = await enqueueMessage('sess-acp', 'first\n\nexact');
    const second = await enqueueMessage('sess-acp', 'second');

    const selected = await markNextProcessing('sess-acp');

    expect(selected).toEqual([
      expect.objectContaining({
        id: first.id,
        message: 'first\n\nexact',
        status: 'processing',
      }),
    ]);
    expect(await getQueue('sess-acp')).toEqual([
      expect.objectContaining({ id: first.id, status: 'processing' }),
      expect.objectContaining({ id: second.id, status: 'pending' }),
    ]);
  });

  it('advances one item at a time after scoped removal', async () => {
    const first = await enqueueMessage('sess-acp', 'first');
    const second = await enqueueMessage('sess-acp', 'second');

    expect((await markNextProcessing('sess-acp')).map((m) => m.id)).toEqual([first.id]);
    expect(await markNextProcessing('sess-acp')).toEqual([]);

    await removeProcessed('sess-acp', [first.id]);
    expect((await markNextProcessing('sess-acp')).map((m) => m.id)).toEqual([second.id]);
  });

  it('reverts only the selected item without disturbing later pending messages', async () => {
    const first = await enqueueMessage('sess-acp', 'first');
    const second = await enqueueMessage('sess-acp', 'second');
    const selected = await markNextProcessing('sess-acp');

    await revertToPending(selected);

    expect(await getQueue('sess-acp')).toEqual([
      expect.objectContaining({ id: first.id, status: 'pending' }),
      expect.objectContaining({ id: second.id, status: 'pending' }),
    ]);
  });
});

describe('removeProcessed', () => {
  it('removes processing messages, leaving queue empty', async () => {
    await enqueueMessage('sess-1', 'msg1');
    await markProcessing('sess-1');
    await removeProcessed('sess-1');

    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(0);
  });

  it('does nothing for unknown session', async () => {
    // Should not throw
    await removeProcessed('nonexistent');
  });
});

describe('editMessage', () => {
  it('edits a pending message text', async () => {
    const msg = await enqueueMessage('sess-1', 'original');
    const success = await editMessage('sess-1', msg.id, 'edited');
    expect(success).toBe(true);

    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].message).toBe('edited');
  });

  it('fails on processing message', async () => {
    const msg = await enqueueMessage('sess-1', 'original');
    await markProcessing('sess-1');

    const success = await editMessage('sess-1', msg.id, 'too late');
    expect(success).toBe(false);

    // Verify message text unchanged
    const queue = await getQueue('sess-1');
    expect(queue[0].message).toBe('original');
  });

  it('fails on nonexistent message id', async () => {
    await enqueueMessage('sess-1', 'exists');
    const success = await editMessage('sess-1', 'bad-id-999', 'nope');
    expect(success).toBe(false);
  });

  it('fails on nonexistent session', async () => {
    const success = await editMessage('no-session', 'no-id', 'nope');
    expect(success).toBe(false);
  });
});

describe('deleteMessage', () => {
  it('deletes a pending message', async () => {
    const msg1 = await enqueueMessage('sess-1', 'first');
    const msg2 = await enqueueMessage('sess-1', 'second');

    const success = await deleteMessage('sess-1', msg1.id);
    expect(success).toBe(true);

    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe(msg2.id);
  });

  it('fails on processing message', async () => {
    const msg = await enqueueMessage('sess-1', 'locked');
    await markProcessing('sess-1');

    const success = await deleteMessage('sess-1', msg.id);
    expect(success).toBe(false);

    // Message should still be there
    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(1);
  });

  it('fails on nonexistent message id', async () => {
    await enqueueMessage('sess-1', 'exists');
    const success = await deleteMessage('sess-1', 'bad-id');
    expect(success).toBe(false);
  });
});

describe('getAllSessionsWithPending', () => {
  it('returns only sessions that have pending messages', async () => {
    await enqueueMessage('sess-A', 'msgA');
    await enqueueMessage('sess-B', 'msgB');

    // Mark sess-A as processing (no longer pending)
    await markProcessing('sess-A');

    const sessions = await getAllSessionsWithPending();
    expect(sessions).toEqual(['sess-B']);
  });

  it('returns empty array when no sessions have pending', async () => {
    const sessions = await getAllSessionsWithPending();
    expect(sessions).toEqual([]);
  });
});

describe('loadQueue', () => {
  it('resets processing messages back to pending on startup', async () => {
    // Enqueue and mark processing
    await enqueueMessage('sess-1', 'msg1');
    await enqueueMessage('sess-1', 'msg2');
    await markProcessing('sess-1');

    // Verify they are processing
    let queue = await getQueue('sess-1');
    expect(queue.every((m) => m.status === 'processing')).toBe(true);

    // Simulate restart: loadQueue reads from disk and resets processing
    await loadQueue();

    queue = await getQueue('sess-1');
    expect(queue).toHaveLength(2);
    for (const m of queue) {
      expect(m.status).toBe('pending');
    }
  });

  it('does not modify already-pending messages', async () => {
    await enqueueMessage('sess-1', 'pending-msg');

    await loadQueue();

    const queue = await getQueue('sess-1');
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
  });
});

describe('provider identity queue migration', () => {
  it('moves pending and in-flight messages durably while preserving stable IDs', async () => {
    const inFlight = await enqueueMessage('provider-old', 'already selected');
    await markNextProcessing('provider-old');
    const pending = await enqueueMessage('provider-old', 'still pending');
    const existing = await enqueueMessage('provider-new', 'already on target');

    const migration = await migrateSessionQueue('provider-old', 'provider-new');

    expect(migration.movedIds).toEqual([inFlight.id, pending.id]);
    expect(await getQueue('provider-old')).toEqual([]);
    expect(await getQueue('provider-new')).toEqual([
      expect.objectContaining({ id: inFlight.id, sessionId: 'provider-new', status: 'processing' }),
      expect.objectContaining({ id: pending.id, sessionId: 'provider-new', status: 'pending' }),
      expect.objectContaining({ id: existing.id, sessionId: 'provider-new', status: 'pending' }),
    ]);

    resetCache();
    await loadQueue();
    expect(await getQueue('provider-new')).toEqual([
      expect.objectContaining({ id: inFlight.id, status: 'pending' }),
      expect.objectContaining({ id: pending.id, status: 'pending' }),
      expect.objectContaining({ id: existing.id, status: 'pending' }),
    ]);
  });

  it('rolls back only messages moved by the failed identity publication', async () => {
    const moved = await enqueueMessage('provider-old', 'move me');
    const target = await enqueueMessage('provider-new', 'leave me');
    const migration = await migrateSessionQueue('provider-old', 'provider-new');

    await rollbackSessionQueueMigration(
      'provider-old',
      'provider-new',
      migration.movedIds,
    );

    expect(await getQueue('provider-old')).toEqual([
      expect.objectContaining({ id: moved.id, sessionId: 'provider-old' }),
    ]);
    expect(await getQueue('provider-new')).toEqual([
      expect.objectContaining({ id: target.id, sessionId: 'provider-new' }),
    ]);
  });
});

describe('multi-session isolation', () => {
  it('operations on one session do not affect another', async () => {
    await enqueueMessage('sess-A', 'msgA-1');
    await enqueueMessage('sess-A', 'msgA-2');
    await enqueueMessage('sess-B', 'msgB-1');

    // Mark A as processing
    const batchA = await markProcessing('sess-A');
    expect(batchA).toHaveLength(2);

    // B should still have pending messages
    const queueB = await getQueue('sess-B');
    expect(queueB).toHaveLength(1);
    expect(queueB[0].status).toBe('pending');
    expect(queueB[0].message).toBe('msgB-1');
  });
});

describe('combined workflow', () => {
  it('handles enqueue-during-processing correctly', async () => {
    // Phase 1: enqueue 3 messages
    await enqueueMessage('sess-1', 'batch1-a');
    await enqueueMessage('sess-1', 'batch1-b');
    await enqueueMessage('sess-1', 'batch1-c');

    // Phase 2: mark processing — should return all 3
    const batch1 = await markProcessing('sess-1');
    expect(batch1).toHaveLength(3);
    expect(batch1.map((m) => m.message)).toEqual(['batch1-a', 'batch1-b', 'batch1-c']);

    // Phase 3: enqueue 2 more while first batch is processing
    await enqueueMessage('sess-1', 'batch2-a');
    await enqueueMessage('sess-1', 'batch2-b');

    // Queue should have 5 total (3 processing + 2 pending)
    const fullQueue = await getQueue('sess-1');
    expect(fullQueue).toHaveLength(5);
    expect(fullQueue.filter((m) => m.status === 'processing')).toHaveLength(3);
    expect(fullQueue.filter((m) => m.status === 'pending')).toHaveLength(2);

    // Phase 4: remove processed (first batch)
    await removeProcessed('sess-1');

    // Queue should have only the 2 new pending messages
    const remaining = await getQueue('sess-1');
    expect(remaining).toHaveLength(2);
    expect(remaining.map((m) => m.message)).toEqual(['batch2-a', 'batch2-b']);

    // Phase 5: mark processing on second batch
    const batch2 = await markProcessing('sess-1');
    expect(batch2).toHaveLength(2);
    expect(batch2.map((m) => m.message)).toEqual(['batch2-a', 'batch2-b']);
  });
});

// Regression: delivery failure (SSH/daemon down) must NOT drop the user's message.
// This is the contract processNext() relies on — on a delivery error it calls
// revertToPending(msgs) instead of removeProcessed(sessionId), so the message stays
// recoverable (server restart re-picks pending; user can Retry). Previously the catch
// block removed the batch, silently losing the message when the remote host was down.
describe('delivery failure survival (Fix 2 regression)', () => {
  it('revertToPending keeps a failed-delivery message in the queue as pending', async () => {
    await enqueueMessage('sess-fail', 'do not lose me');

    // Simulate processNext: lock the batch for delivery.
    const batch = await markProcessing('sess-fail');
    expect(batch).toHaveLength(1);
    expect(batch[0].status).toBe('processing');

    // Delivery throws (e.g. RemoteSessionManager start/writeMessage rejects on SSH fail).
    // processNext's catch must revert, NOT remove.
    await revertToPending(batch);

    const after = await getQueue('sess-fail');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
    expect(after[0].message).toBe('do not lose me');
  });

  it('reverted message survives a simulated server restart (loadQueue)', async () => {
    await enqueueMessage('sess-fail', 'survive restart');
    const batch = await markProcessing('sess-fail');
    await revertToPending(batch);

    // Simulate restart: drop in-memory cache and reload from disk.
    resetCache();
    await loadQueue();

    const after = await getQueue('sess-fail');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
    expect(after[0].message).toBe('survive restart');
  });

  // inc-1786774073558: the row a Retry must re-drain instead of re-enqueueing.
  it('isMessageQueued sees the row through the whole failed-delivery cycle', async () => {
    const msg = await enqueueMessage('sess-retry', 'retry me');
    expect(await isMessageQueued('sess-retry', msg.id)).toBe(true);

    const batch = await markProcessing('sess-retry');
    // 'processing' still counts: delivery is in flight and hasn't settled, so
    // enqueueing a copy beside it would re-open the doubling window.
    expect(await isMessageQueued('sess-retry', msg.id)).toBe(true);

    await revertToPending(batch);
    expect(await isMessageQueued('sess-retry', msg.id)).toBe(true);

    // Drained (really delivered) → a Retry may legitimately enqueue fresh.
    await markProcessing('sess-retry');
    await removeProcessed('sess-retry', [msg.id]);
    expect(await isMessageQueued('sess-retry', msg.id)).toBe(false);
    expect(await isMessageQueued('sess-retry', 'never-existed')).toBe(false);
    expect(await isMessageQueued('no-such-session', msg.id)).toBe(false);
  });

  it('contrast: removeProcessed would have lost the message (documents the old bug)', async () => {
    await enqueueMessage('sess-bug', 'lost forever');
    await markProcessing('sess-bug');

    // The OLD (buggy) processNext catch path did this on delivery failure:
    await removeProcessed('sess-bug');

    const after = await getQueue('sess-bug');
    expect(after).toHaveLength(0); // message gone — exactly the bug we fixed
  });
});

// Regression for the 2026-06-10 message-loss race: a stale SESSION_RESULT's
// un-scoped removeProcessed(sessionId) swept a CONCURRENT in-flight batch off
// disk while its --resume spawn was still settling. The fixes under test:
//   1. removeProcessed(sessionId, ids) only removes the given batch
//   2. revertToPending re-INSERTS messages that were swept while in flight
describe('scoped removeProcessed + revertToPending re-insert (no-loss guarantees)', () => {
  it('scoped removeProcessed only removes the given ids, not other processing messages', async () => {
    // Batch 1 goes in flight
    await enqueueMessage('sess-1', 'batch1');
    const batch1 = await markProcessing('sess-1');

    // Batch 2 arrives and also goes in flight (e.g. mid-turn injection while
    // a --resume settle for batch 1 is still pending)
    await enqueueMessage('sess-1', 'batch2');
    const batch2 = await markProcessing('sess-1');
    expect(batch2).toHaveLength(1);

    // Batch 1 delivered → its delivery point removes ONLY its own ids
    await removeProcessed('sess-1', batch1.map((m) => m.id));

    const after = await getQueue('sess-1');
    expect(after).toHaveLength(1);
    expect(after[0].message).toBe('batch2');
    expect(after[0].status).toBe('processing');
  });

  it('un-scoped removeProcessed still clears all processing messages (startup/cleanup semantics)', async () => {
    await enqueueMessage('sess-1', 'a');
    await enqueueMessage('sess-1', 'b');
    await markProcessing('sess-1');
    await removeProcessed('sess-1');
    expect(await getQueue('sess-1')).toHaveLength(0);
  });

  it('revertToPending re-inserts a message that was swept from the store while in flight', async () => {
    await enqueueMessage('sess-1', 'in flight');
    const batch = await markProcessing('sess-1');

    // A stale turn-end cleanup sweeps the whole session queue (the old bug)
    await removeProcessed('sess-1');
    expect(await getQueue('sess-1')).toHaveLength(0);

    // Delivery then fails → revertToPending must RESURRECT the message,
    // not just mutate an orphaned object.
    await revertToPending(batch);

    const after = await getQueue('sess-1');
    expect(after).toHaveLength(1);
    expect(after[0].message).toBe('in flight');
    expect(after[0].status).toBe('pending');
  });

  it('re-inserted message survives restart (loadQueue)', async () => {
    await enqueueMessage('sess-1', 'resurrect me');
    const batch = await markProcessing('sess-1');
    await removeProcessed('sess-1'); // swept
    await revertToPending(batch);    // resurrected

    resetCache();
    await loadQueue();

    const after = await getQueue('sess-1');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('pending');
    expect(after[0].message).toBe('resurrect me');
  });

  it('revertToPending keeps queue ordered by enqueue time after re-insert', async () => {
    const m1 = await enqueueMessage('sess-1', 'first');
    const batch = await markProcessing('sess-1');
    await removeProcessed('sess-1'); // first swept while in flight
    await enqueueMessage('sess-1', 'second'); // newer message arrives
    await revertToPending(batch); // first re-inserted

    const after = await getQueue('sess-1');
    expect(after.map((m) => m.message)).toEqual(['first', 'second']);
    expect(after[0].id).toBe(m1.id);
  });
});

// A pending row is retried on EVERY server boot and EVERY daemon reconnect. That
// loops forever when the failure is permanent (deleted cwd): real rows sat pending
// for 12 days, re-firing two error notifications per session per cycle. 'parked' is
// the dead-letter state that ends the loop: kept on disk, never auto-redelivered.
describe('parked rows (dead-letter)', () => {
  it('parkMessages flips a locked batch to parked and records when + why', async () => {
    await enqueueMessage('sess-park', 'undeliverable');
    const batch = await markProcessing('sess-park');

    expect(await parkMessages(batch, 'Working directory no longer exists: /gone')).toBe(1);

    const after = await getQueue('sess-park');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('parked');
    expect(after[0].parkedReason).toBe('Working directory no longer exists: /gone');
    expect(after[0].parkedAt).toBeTruthy();
    expect(after[0].message).toBe('undeliverable');
  });

  it('parking is idempotent (a second park of the same batch changes nothing)', async () => {
    await enqueueMessage('sess-park', 'once');
    const batch = await markProcessing('sess-park');
    await parkMessages(batch, 'first reason');

    expect(await parkMessages(batch, 'second reason')).toBe(0);
    const after = await getQueue('sess-park');
    expect(after[0].parkedReason).toBe('first reason');
  });

  it('parked rows are invisible to BOTH automatic redelivery triggers', async () => {
    await enqueueMessage('sess-park', 'parked one');
    const batch = await markProcessing('sess-park');
    await parkMessages(batch, 'permanent');

    // getAllSessionsWithPending is the single gate startup recovery and
    // redeliverPendingForHost both pass through.
    expect(await getAllSessionsWithPending()).not.toContain('sess-park');
    // And neither batching primitive can pick a parked row up.
    expect(await markProcessing('sess-park')).toHaveLength(0);
    expect(await markNextProcessing('sess-park')).toHaveLength(0);
  });

  it('parked survives a server restart as parked (loadQueue does not revive it)', async () => {
    await enqueueMessage('sess-park', 'still parked after boot');
    await parkMessages(await markProcessing('sess-park'), 'permanent');

    resetCache();
    await loadQueue();

    const after = await getQueue('sess-park');
    expect(after[0].status).toBe('parked');
    expect(await getAllSessionsWithPending()).toHaveLength(0);
  });

  it('parkMessages re-inserts a row swept while in flight (same no-loss rule as revert)', async () => {
    await enqueueMessage('sess-park', 'swept then parked');
    const batch = await markProcessing('sess-park');
    await removeProcessed('sess-park'); // un-scoped sweep races the settle

    await parkMessages(batch, 'permanent');

    const after = await getQueue('sess-park');
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe('parked');
    expect(after[0].message).toBe('swept then parked');
  });

  it('a later transient revert cannot resurrect a parked row', async () => {
    await enqueueMessage('sess-park', 'stays parked');
    const batch = await markProcessing('sess-park');
    await parkMessages(batch, 'permanent');

    // revertToPending only un-sticks rows stored as 'processing'.
    await revertToPending(batch);

    expect((await getQueue('sess-park'))[0].status).toBe('parked');
  });

  it('unparkMessage puts a parked row back in line (explicit user retry)', async () => {
    const msg = await enqueueMessage('sess-park', 'retry me by hand');
    await parkMessages(await markProcessing('sess-park'), 'permanent');

    expect(await unparkMessage('sess-park', msg.id)).toBe(true);

    const after = await getQueue('sess-park');
    expect(after[0].status).toBe('pending');
    expect(after[0].parkedAt).toBeUndefined();
    expect(after[0].parkedReason).toBeUndefined();
    // Now the ordinary drain sees it again.
    expect(await getAllSessionsWithPending()).toContain('sess-park');
    expect(await markProcessing('sess-park')).toHaveLength(1);
  });

  it('unparkMessage refuses rows that are not parked', async () => {
    const msg = await enqueueMessage('sess-park', 'pending already');
    expect(await unparkMessage('sess-park', msg.id)).toBe(false);
    expect(await unparkMessage('sess-park', 'no-such-id')).toBe(false);
    expect(await unparkMessage('no-such-session', msg.id)).toBe(false);
  });

  it('deleteMessage discards a parked row, still refuses one in flight', async () => {
    const parkedMsg = await enqueueMessage('sess-park', 'discard me');
    await parkMessages(await markProcessing('sess-park'), 'permanent');
    expect(await deleteMessage('sess-park', parkedMsg.id)).toBe(true);
    expect(await getQueue('sess-park')).toHaveLength(0);

    const liveMsg = await enqueueMessage('sess-live', 'in flight');
    await markProcessing('sess-live');
    expect(await deleteMessage('sess-live', liveMsg.id)).toBe(false);
  });

  it('a parked row is still listed for the UI (that is how Retry/Discard reach it)', async () => {
    const msg = await enqueueMessage('sess-park', 'visible');
    await parkMessages(await markProcessing('sess-park'), 'permanent');

    const listed = await getQueue('sess-park');
    expect(listed.map((m) => m.id)).toEqual([msg.id]);
    // isMessageQueued still true → the retry route re-drains this row instead of
    // enqueueing a duplicate (it un-parks first).
    expect(await isMessageQueued('sess-park', msg.id)).toBe(true);
  });
});

// Age backstop: the failure classifier only knows the permanent shapes we have
// SEEN. A week-old pending row is retired whatever stranded it.
describe('parkStalePending (7-day age backstop)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

  async function backdate(sessionId: string, messageId: string, enqueuedAt: string): Promise<void> {
    const raw = JSON.parse(await fsp.readFile(SESSION_QUEUE_FILE, 'utf-8'));
    const row = raw.queues[sessionId].find((m: { id: string }) => m.id === messageId);
    row.enqueuedAt = enqueuedAt;
    await fsp.writeFile(SESSION_QUEUE_FILE, JSON.stringify(raw));
    resetCache();
  }

  it('parks a pending row older than the default window, leaves a fresh one alone', async () => {
    const old = await enqueueMessage('sess-age', 'twelve days old');
    const fresh = await enqueueMessage('sess-age', 'sent just now');
    await backdate('sess-age', old.id, daysAgo(12));

    const parked = await parkStalePending();
    expect(parked.map((m) => m.id)).toEqual([old.id]);

    const after = await getQueue('sess-age');
    expect(after.find((m) => m.id === old.id)!.status).toBe('parked');
    expect(after.find((m) => m.id === old.id)!.parkedReason).toContain('7 days');
    expect(after.find((m) => m.id === fresh.id)!.status).toBe('pending');
    // The stale row no longer drags its session into the boot-time drain, but the
    // fresh one still does.
    expect(await getAllSessionsWithPending()).toContain('sess-age');
    expect(await markProcessing('sess-age')).toHaveLength(1);
  });

  it('leaves a row that is exactly inside the window, parks one just outside', async () => {
    const inside = await enqueueMessage('sess-age', 'six days');
    const outside = await enqueueMessage('sess-age', 'eight days');
    await backdate('sess-age', inside.id, daysAgo(6));
    await backdate('sess-age', outside.id, daysAgo(8));

    await parkStalePending(MAX_PENDING_AGE_MS);

    const after = await getQueue('sess-age');
    expect(after.find((m) => m.id === inside.id)!.status).toBe('pending');
    expect(after.find((m) => m.id === outside.id)!.status).toBe('parked');
  });

  it('never touches a row that is in flight (processing)', async () => {
    const msg = await enqueueMessage('sess-age', 'old but in flight');
    await backdate('sess-age', msg.id, daysAgo(30));
    await markProcessing('sess-age');

    expect(await parkStalePending()).toHaveLength(0);
    expect((await getQueue('sess-age'))[0].status).toBe('processing');
  });

  it('is a no-op on an empty queue and on already-parked rows', async () => {
    expect(await parkStalePending()).toHaveLength(0);

    const msg = await enqueueMessage('sess-age', 'already parked');
    await parkMessages(await markProcessing('sess-age'), 'permanent');
    await backdate('sess-age', msg.id, daysAgo(30));

    expect(await parkStalePending()).toHaveLength(0);
    expect((await getQueue('sess-age'))[0].parkedReason).toBe('permanent');
  });
});
