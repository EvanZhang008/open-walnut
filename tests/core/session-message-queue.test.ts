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
  markProcessing,
  removeProcessed,
  editMessage,
  deleteMessage,
  getQueue,
  getAllSessionsWithPending,
  resetCache,
} from '../../src/core/session-message-queue.js';
import { WALNUT_HOME } from '../../src/constants.js';

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
