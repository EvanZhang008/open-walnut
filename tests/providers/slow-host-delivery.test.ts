/**
 * A host that does not answer in time is a wait, not a failed send.
 *
 * 2026-10-29: every `ps` on the Mac hung for 17 minutes, the daemon's session start
 * waited on one, and the server's 30 s start deadline turned the user's message to
 * a stopped task into "Send failed: daemon command timeout: start (30000ms)" while
 * the row sat pending with nothing to send it again but the next message.
 *
 * Pinned at the provider seam (SessionRunner without init(), the private settle
 * methods called directly, as session-message-park.test.ts does): such a failure
 * keeps the rows pending, says in plain words that the message waits and when the
 * next try is, and sends the queue again on a clock; any other transient failure
 * still reports the batch failed with its Retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-slow-host'));

import { SessionRunner, slowHostReason } from '../../src/providers/claude-code-session.js';
import { SendOutcomeUnknownError } from '../../src/providers/delivery-failure.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { enqueueMessage, getQueue, markProcessing, resetCache } from '../../src/core/session-message-queue.js';
import type { QueuedMessage } from '../../src/core/session-message-queue.js';

type Access = {
  settleResumeFailure: (sid: string, msgs: QueuedMessage[], err: Error) => void;
  settleUnansweredLine: (sid: string, msgs: QueuedMessage[], err: Error, stopped: boolean) => Promise<void>;
  deliverRest: (sid: string) => void;
  slowHostRetries: Map<string, { timer?: ReturnType<typeof setTimeout>; tries: number; at: number }>;
};

let runner: SessionRunner;
let events: BusEvent[] = [];
const access = () => runner as unknown as Access;
const START_TIMEOUT = 'daemon command timeout: start (30000ms) [traceId=d324a031]';

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const named = (name: string) => events.filter((e) => e.name === name);

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  bus.clear();
  events = [];
  bus.subscribe('main-ai', (event: BusEvent) => { events.push(event); });
  runner = new SessionRunner();
});

afterEach(async () => {
  for (const e of access().slowHostRetries.values()) if (e.timer) clearTimeout(e.timer);
  vi.useRealTimers();
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('a session start the host did not answer in time', () => {
  it('keeps the message pending, says why in plain words, and when it is sent again', async () => {
    const sid = 'slow-start-sid';
    const row = await enqueueMessage(sid, 'why is Slack empty?');
    const before = Date.now();
    access().settleResumeFailure(sid, await markProcessing(sid), new Error(START_TIMEOUT));

    const held = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[0], 'delivery-held');
    const d = held.data as { messageIds: string[]; reason: string; retryAt?: string };
    expect(d.messageIds).toEqual([row.id]);
    expect(d.reason).toBe(slowHostReason('start'));
    expect(d.reason).not.toMatch(/daemon|timeout|traceId/i);
    const at = Date.parse(d.retryAt ?? '');
    expect(at - before).toBeGreaterThanOrEqual(14_000);
    expect(at - before).toBeLessThan(20_000);

    // Never a bare "Send failed" while the row still waits.
    expect(named(EventNames.SESSION_BATCH_FAILED)).toHaveLength(0);
    const err = (await until(() => named(EventNames.SESSION_ERROR)[0], 'session:error')).data as { error: string; errorKind?: string; retryAt?: string };
    expect(err.errorKind).toBe('delivery_failed');
    expect(err.retryAt).toBe(d.retryAt);
    expect(err.error).toBe(slowHostReason('start'));
    resetCache();
    expect((await getQueue(sid))[0].status).toBe('pending');
  });

  it('sends the queue again by itself, backing off while the host stays slow', async () => {
    const sid = 'slow-start-retry-sid';
    await enqueueMessage(sid, 'to a stopped task');
    const deliverRest = vi.spyOn(access(), 'deliverRest').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    access().settleResumeFailure(sid, await markProcessing(sid), new Error(START_TIMEOUT));
    await vi.waitFor(() => expect(access().slowHostRetries.get(sid)?.timer).toBeDefined());

    vi.advanceTimersByTime(14_000);
    expect(deliverRest).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(deliverRest).toHaveBeenCalledTimes(1);

    // The next try times out too: the clock doubles.
    vi.useRealTimers();
    access().settleResumeFailure(sid, await markProcessing(sid), new Error(START_TIMEOUT));
    const second = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[1], 'second delivery-held');
    const wait = Date.parse((second.data as { retryAt: string }).retryAt) - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThanOrEqual(30_000);
  });

  it('a message that goes in settles the clock', async () => {
    const sid = 'slow-start-settled-sid';
    await enqueueMessage(sid, 'eventually delivered');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error(START_TIMEOUT));
    await until(() => access().slowHostRetries.get(sid)?.timer, 'the clock');
    (runner as unknown as { cancelBudgetRetry: (s: string) => void }).cancelBudgetRetry(sid);
    expect(access().slowHostRetries.has(sid)).toBe(false);
  });

  it('any other transient failure still reads as a failed send with Retry', async () => {
    // A host that is down or refused the login keeps its own words (and its
    // recovery card): only "up but slow" is a clocked wait.
    for (const [sid, message] of [
      ['other-transient-sid', 'daemon start failed: publickey denied'],
      ['not-connected-sid', 'DaemonConnection not connected to devbox'],
      ['conn-failed-sid', 'Connection to devbox failed 12s ago: Permission denied (publickey)'],
    ] as const) {
      events = [];
      await enqueueMessage(sid, 'host refused the key');
      access().settleResumeFailure(sid, await markProcessing(sid), new Error(message));
      await until(() => named(EventNames.SESSION_BATCH_FAILED)[0], `batch-failed for ${sid}`);
      expect(named(EventNames.SESSION_DELIVERY_HELD), sid).toHaveLength(0);
      expect(access().slowHostRetries.has(sid), sid).toBe(false);
    }
  });

  it('a retry that armed nothing (the delivery returned early) is looked at again', async () => {
    const sid = 'slow-start-quiet-sid';
    await enqueueMessage(sid, 'stuck behind a stop request');
    vi.spyOn(access(), 'deliverRest').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    access().settleResumeFailure(sid, await markProcessing(sid), new Error(START_TIMEOUT));
    await vi.waitFor(() => expect(access().slowHostRetries.get(sid)?.timer).toBeDefined());
    vi.advanceTimersByTime(15_000);
    vi.advanceTimersByTime(2_000);
    vi.useRealTimers();
    // The rows still wait under the slow-host words: a fresh "next try" is announced.
    const again = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[1], 'a second delivery-held');
    expect(Date.parse((again.data as { retryAt: string }).retryAt)).toBeGreaterThan(Date.now() + 20_000);
    expect(access().slowHostRetries.get(sid)?.timer).toBeDefined();
  });
});

describe('a send the host did not confirm, with no live process', () => {
  it('waits on the slow-host clock instead of reading "Send failed"', async () => {
    const sid = 'slow-send-sid';
    const row = await enqueueMessage(sid, 'are you there?');
    await access().settleUnansweredLine(sid, await markProcessing(sid),
      new SendOutcomeUnknownError('daemon command timeout: send (30000ms) [traceId=ce669b2b]'), false);
    const held = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[0], 'delivery-held');
    expect((held.data as { messageIds: string[] }).messageIds).toEqual([row.id]);
    expect((held.data as { reason: string }).reason).toBe(slowHostReason('send'));
    expect((held.data as { retryAt?: string }).retryAt).toBeTruthy();
    expect(named(EventNames.SESSION_BATCH_FAILED)).toHaveLength(0);
  });
});
