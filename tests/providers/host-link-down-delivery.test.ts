/**
 * A message to a session whose host nothing reaches is a wait, never a silent unknown.
 *
 * 2026-11-06: the Mac's sign-in to a dev host expired, and for hours a person's messages to
 * tasks there read "Send failed: Not sent yet: waiting for the connection to the session host"
 * (no host, no word on when), or a bare "Queued" after a reload. Every delivery failure path
 * of the runner that can meet a link that is down (a held send on a live pipe, a cold resume,
 * any other delivery failure while the host's link is down) now keeps the rows pending, says
 * which host it waits for and when Walnut tries again, and never reports the batch failed.
 * The reconnect delivers them (redeliverPendingForHost); the clock only says the next try.
 *
 * Pinned at the provider seam (SessionRunner without init(), private settle methods called
 * directly), as slow-host-delivery.test.ts does; the host's link is the daemon pool's state,
 * stubbed here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-host-link-down'));

const link = vi.hoisted(() => ({ down: new Set<string>(), redialAt: new Map<string, number>() }));
vi.mock('../../src/providers/daemon-connection.js', async (orig) => ({
  ...(await orig<typeof import('../../src/providers/daemon-connection.js')>()),
  hostLinkDown: (host: string) => link.down.has(host),
  hostReconnectAt: (host: string) => link.redialAt.get(host) ?? null,
}));

import { SessionRunner, hostLinkReason, isHostWaitReason, slowHostReason } from '../../src/providers/claude-code-session.js';
import { SendHeldError } from '../../src/providers/delivery-failure.js';
import { bus, EventNames, type BusEvent } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { createSessionRecord } from '../../src/core/session-tracker.js';
import { enqueueMessage, getQueue, markProcessing, resetCache } from '../../src/core/session-message-queue.js';
import type { QueuedMessage } from '../../src/core/session-message-queue.js';
import { heldWaitOf } from '../../src/core/sessions/held-wait.js';

type Access = {
  settleResumeFailure: (sid: string, msgs: QueuedMessage[], err: Error) => void;
  settleUnansweredLine: (sid: string, msgs: QueuedMessage[], err: Error, stopped: boolean) => Promise<void>;
  deliverRest: (sid: string) => void;
  sendLinkHeld: (host: string) => void;
  activeProcessing: Set<string>;
  slowHostRetries: Map<string, { timer?: ReturnType<typeof setTimeout>; tries: number; at: number; why: string; host?: string }>;
};

let runner: SessionRunner;
let events: BusEvent[] = [];
const access = () => runner as unknown as Access;
const HOST = 'devbox';
const named = (name: string) => events.filter((e) => e.name === name);

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} never happened`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function session(sid: string, host: string | undefined = HOST): Promise<void> {
  await createSessionRecord(sid, '', '', '/tmp/link-down', { ...(host ? { host } : {}), initialProcessStatus: 'idle' } as never);
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  resetCache();
  bus.clear();
  events = [];
  link.down.clear();
  link.redialAt.clear();
  bus.subscribe('main-ai', (event: BusEvent) => { events.push(event); });
  runner = new SessionRunner();
});

afterEach(async () => {
  for (const e of access().slowHostRetries.values()) if (e.timer) clearTimeout(e.timer);
  vi.useRealTimers();
  bus.clear();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

/** The rows wait for the host, named, with a next try; nothing reads as failed. */
async function expectHeldForHost(sid: string, rowIds: string[], host = HOST): Promise<{ reason: string; retryAt: string }> {
  const held = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[0], 'delivery-held');
  const d = held.data as { messageIds: string[]; reason: string; retryAt?: string };
  expect(d.messageIds).toEqual(rowIds);
  expect(d.reason).toBe(hostLinkReason(host));
  expect(d.reason).toContain(host);
  expect(Date.parse(d.retryAt ?? '')).toBeGreaterThan(Date.now());
  expect(named(EventNames.SESSION_BATCH_FAILED)).toHaveLength(0);
  resetCache();
  expect((await getQueue(sid)).map((m) => m.status)).toEqual(rowIds.map(() => 'pending'));
  return { reason: d.reason, retryAt: d.retryAt! };
}

describe('every delivery failure while the host link is down is a wait for that host', () => {
  it('a send held for the connection (a live process, the link gone)', async () => {
    const sid = 'link-held-send';
    await session(sid);
    const row = await enqueueMessage(sid, 'hi any response?');
    await access().settleUnansweredLine(sid, await markProcessing(sid),
      new SendHeldError('Not sent yet: waiting for the connection to the session host'), false);
    await expectHeldForHost(sid, [row.id]);
  });

  it('a cold resume whose host cannot be reached', async () => {
    const sid = 'link-cold-resume';
    await session(sid);
    link.down.add(HOST);
    const row = await enqueueMessage(sid, 'did you get my message?');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('Connection to devbox failed 12s ago: Permission denied (publickey)'));
    const { reason, retryAt } = await expectHeldForHost(sid, [row.id]);
    // The session's error carries the wait, so the panel shows the bubble's note, not an error row.
    const err = (await until(() => named(EventNames.SESSION_ERROR)[0], 'session:error')).data as { error: string; errorKind?: string; retryAt?: string };
    expect(err).toMatchObject({ errorKind: 'delivery_failed', error: reason, retryAt });
  });

  it('any other failure while the host link is down, whatever its words', async () => {
    const sid = 'link-other-failure';
    await session(sid);
    link.down.add(HOST);
    const row = await enqueueMessage(sid, 'i did not see any response');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('ssh: connect to host devbox port 22: Operation timed out'));
    await expectHeldForHost(sid, [row.id]);
  });

  it('the next try is the host re-dial when that comes before the clock', async () => {
    const sid = 'link-redial-first';
    await session(sid);
    link.down.add(HOST);
    const redial = Date.now() + 4_000;
    link.redialAt.set(HOST, redial);
    await enqueueMessage(sid, 'when does it go?');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('DaemonConnection not connected to devbox'));
    const held = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[0], 'delivery-held');
    expect(Date.parse((held.data as { retryAt: string }).retryAt)).toBe(redial);
  });

  it('the clock never dials a host that is still down: it says the next try again', async () => {
    const sid = 'link-clock-quiet';
    await session(sid);
    link.down.add(HOST);
    await enqueueMessage(sid, 'still waiting');
    const deliverRest = vi.spyOn(access(), 'deliverRest').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('DaemonConnection not connected to devbox'));
    await vi.waitFor(() => expect(access().slowHostRetries.get(sid)?.timer).toBeDefined());
    vi.advanceTimersByTime(15_000);
    expect(deliverRest).not.toHaveBeenCalled();
    vi.useRealTimers();
    const again = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[1], 'the next try said again');
    expect((again.data as { reason: string }).reason).toBe(hostLinkReason(HOST));
    expect(Date.parse((again.data as { retryAt: string }).retryAt)).toBeGreaterThan(Date.now() + 20_000);
  });

  it('once the host is back, the clock sends the rows', async () => {
    const sid = 'link-clock-back';
    await session(sid);
    link.down.add(HOST);
    await enqueueMessage(sid, 'goes when it is back');
    const deliverRest = vi.spyOn(access(), 'deliverRest').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('DaemonConnection not connected to devbox'));
    await vi.waitFor(() => expect(access().slowHostRetries.get(sid)?.timer).toBeDefined());
    link.down.clear();
    vi.advanceTimersByTime(15_000);
    expect(deliverRest).toHaveBeenCalledWith(sid);
  });

  it('during a running turn the clock keeps saying the next try, and the link coming back sends at once, mid-turn', async () => {
    const sid = 'link-mid-turn';
    await session(sid);
    link.down.add(HOST);
    await enqueueMessage(sid, 'stop, that is the wrong file');
    const deliverRest = vi.spyOn(access(), 'deliverRest').mockImplementation(() => {});
    access().activeProcessing.add(sid);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await access().settleUnansweredLine(sid, await markProcessing(sid),
      new SendHeldError('Not sent yet: waiting for the connection to the session host'), false);
    await vi.waitFor(() => expect(access().slowHostRetries.get(sid)?.timer).toBeDefined());
    vi.advanceTimersByTime(15_000);
    vi.useRealTimers();
    // The turn still runs: the clock is armed again, not dropped.
    await until(() => named(EventNames.SESSION_DELIVERY_HELD)[1], 'the next try said again during the turn');
    expect(access().slowHostRetries.get(sid)?.timer).toBeDefined();
    expect(deliverRest).not.toHaveBeenCalled();
    // The link is back: the held rows go into the running turn now.
    link.down.clear();
    access().sendLinkHeld(HOST);
    expect(deliverRest).toHaveBeenCalledWith(sid);
    expect(access().slowHostRetries.has(sid)).toBe(false);
    access().activeProcessing.delete(sid);
  });

  it('a failure that says nothing of the link, on a host that is up, still reads failed with Retry', async () => {
    const sid = 'link-up-other';
    await session(sid);
    await enqueueMessage(sid, 'spawn trouble');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('spawn claude EMFILE'));
    await until(() => named(EventNames.SESSION_BATCH_FAILED)[0], 'batch-failed');
    expect(named(EventNames.SESSION_DELIVERY_HELD)).toHaveLength(0);
  });
});

describe('a reloaded panel reads the same wait (session:get-queue)', () => {
  it('a row held for the host keeps its words and its next try', async () => {
    const sid = 'link-reload-held';
    await session(sid);
    link.down.add(HOST);
    const row = await enqueueMessage(sid, 'held then reloaded');
    access().settleResumeFailure(sid, await markProcessing(sid), new Error('DaemonConnection not connected to devbox'));
    const held = await until(() => named(EventNames.SESSION_DELIVERY_HELD)[0], 'delivery-held');
    // heldWaitOf reads the singleton runner; this test's runner holds the clock, so read its words.
    const { heldRows } = await import('../../src/providers/line-consumption.js');
    const wait = (await heldWaitOf(sid))(row.id, heldRows(sid)?.get(row.id));
    expect(wait?.reason).toBe((held.data as { reason: string }).reason);
    expect(isHostWaitReason(wait?.reason)).toBe(true);
  });

  it('after a server restart (no hold kept) a pending row to a host that is down reads the wait', async () => {
    const sid = 'link-reload-restart';
    await session(sid);
    link.down.add(HOST);
    link.redialAt.set(HOST, Date.now() + 30_000);
    const row = await enqueueMessage(sid, 'sent before the restart');
    const wait = (await heldWaitOf(sid))(row.id, undefined);
    expect(wait).toEqual({ reason: hostLinkReason(HOST), retryAt: new Date(link.redialAt.get(HOST)!).toISOString() });
    link.down.clear();
    expect((await heldWaitOf(sid))(row.id, undefined)).toBeNull();
  });

  it('the slow-host words still count as a wait Walnut sends by itself', () => {
    expect(isHostWaitReason(slowHostReason('start'))).toBe(true);
    expect(isHostWaitReason(slowHostReason('send'))).toBe(true);
    expect(isHostWaitReason('Waiting for the permission prompt to be answered')).toBe(false);
  });
});
