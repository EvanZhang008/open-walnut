/**
 * A failed delivery must choose between "retry forever" and "give up".
 *
 * `settleResumeFailure` used to revert EVERY failed batch to 'pending', and pending
 * means retried on every server boot and every daemon reconnect. For a permanent
 * failure that is an infinite loop: real user messages sat pending for 12 days
 * targeting sessions whose working folder had been deleted, and each cycle
 * published two error notifications, so every deploy lit up four error cards.
 *
 * This pins the split at the provider seam: permanent → parked (never
 * auto-redelivered), transient → pending exactly as before.
 *
 * SessionRunner is constructed WITHOUT init() and the private settle method is
 * invoked directly — no daemon, no CLI, no WebSocket (the daemon-backed twin of
 * these paths lives in claude-code-session.test.ts, which costs minutes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-msg-park'));

import { SessionRunner } from '../../src/providers/claude-code-session.js';
import { CwdMissingError } from '../../src/providers/cwd-check.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import {
  enqueueMessage, getQueue, markProcessing, getAllSessionsWithPending, resetCache,
} from '../../src/core/session-message-queue.js';
import type { QueuedMessage } from '../../src/core/session-message-queue.js';

type SettleAccess = {
  settleResumeFailure: (sid: string, msgs: QueuedMessage[], err: Error) => void;
};

let runner: SessionRunner;
let batchFailed: BusEvent[] = [];
let sessionErrors: BusEvent[] = [];

function settle(sessionId: string, msgs: QueuedMessage[], err: Error): void {
  (runner as unknown as SettleAccess).settleResumeFailure(sessionId, msgs, err);
}

/**
 * The settle path is fire-and-forget, so poll for its queue write instead of
 * sleeping a guess (a fixed sleep is a flake generator on a loaded machine).
 */
async function waitForStatus(sessionId: string, status: string): Promise<QueuedMessage[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    resetCache();
    const queue = await getQueue(sessionId);
    if (queue.some((m) => m.status === status)) return queue;
    if (Date.now() > deadline) throw new Error(`queue row never reached '${status}': ${JSON.stringify(queue)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();

  bus.clear();
  batchFailed = [];
  sessionErrors = [];
  bus.subscribe('main-ai', (event: BusEvent) => {
    if (event.name === EventNames.SESSION_BATCH_FAILED) batchFailed.push(event);
    if (event.name === EventNames.SESSION_ERROR) sessionErrors.push(event);
  });

  runner = new SessionRunner();
});

afterEach(async () => {
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('settleResumeFailure — permanent failure parks the batch', () => {
  it('parks on the cwd pre-flight error and stops the automatic redelivery', async () => {
    const sid = 'park-cwd-sid';
    await enqueueMessage(sid, 'message for a folder that no longer exists');
    const batch = await markProcessing(sid);

    settle(sid, batch, new CwdMissingError('Working directory no longer exists: /tmp/deleted-project'));

    const queue = await waitForStatus(sid, 'parked');
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('parked');
    expect(queue[0].parkedReason).toContain('/tmp/deleted-project');
    // The text is NOT lost — parking keeps it for Retry/Discard.
    expect(queue[0].message).toBe('message for a folder that no longer exists');

    // THE POINT: startup recovery and reconnect redelivery both gate on this, so
    // the doomed cycle can never start again on its own.
    expect(await getAllSessionsWithPending()).not.toContain(sid);
    expect(await markProcessing(sid)).toHaveLength(0);
  });

  it('parks when the session record is gone (nothing left to --resume)', async () => {
    const sid = 'park-norecord-sid';
    await enqueueMessage(sid, 'orphaned message');
    const batch = await markProcessing(sid);

    settle(sid, batch, new Error(`No active session found for session ID: ${sid}`));

    expect((await waitForStatus(sid, 'parked'))[0].message).toBe('orphaned message');
  });

  it('still reports the failure exactly once (the notification fires, then stops)', async () => {
    const sid = 'park-report-sid';
    await enqueueMessage(sid, 'report me once');
    const batch = await markProcessing(sid);

    settle(sid, batch, new CwdMissingError('Working directory no longer exists: /tmp/gone'));
    await waitForStatus(sid, 'parked');

    // Same reporting contract as a transient failure: one batch-failed for the UI
    // bubble, one delivery_failed status. Parking removes the RE-fire, not the
    // first honest report.
    expect(batchFailed).toHaveLength(1);
    expect(sessionErrors).toHaveLength(1);
    expect((sessionErrors[0].data as { errorKind?: string }).errorKind).toBe('delivery_failed');
  });

  it('survives a restart as parked (loadQueue only revives processing rows)', async () => {
    const sid = 'park-restart-sid';
    await enqueueMessage(sid, 'parked across boots');
    settle(sid, await markProcessing(sid), new CwdMissingError('Working directory no longer exists: /tmp/gone'));
    await waitForStatus(sid, 'parked');

    resetCache();
    const { loadQueue } = await import('../../src/core/session-message-queue.js');
    await loadQueue();

    expect((await getQueue(sid))[0].status).toBe('parked');
  });
});

describe('settleResumeFailure — transient failure keeps retrying (unchanged)', () => {
  it('reverts an ssh/daemon outage to pending, so the reconnect drain still picks it up', async () => {
    const sid = 'transient-sid';
    await enqueueMessage(sid, 'host is just asleep');
    const batch = await markProcessing(sid);

    settle(sid, batch, new Error('daemon start failed: publickey denied (simulated host outage)'));

    const queue = await waitForStatus(sid, 'pending');
    expect(queue).toHaveLength(1);
    expect(queue[0].status).toBe('pending');
    expect(queue[0].parkedAt).toBeUndefined();
    expect(await getAllSessionsWithPending()).toContain(sid);
  });
});
