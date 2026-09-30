/**
 * Projection push lanes: how an upload reaches the cloud replica, and what the
 * Mac remembers about it (split out of projection-cache.test.ts).
 *
 * Locked down here:
 *   1. The ingest lane (POST /bridge/ingest) carries uploads off the bridge; a
 *      failed ingest is not retried on the bridge, a replica without the route
 *      gets the bridge, and per key only the newest waiting copy follows one in
 *      flight.
 *   2. The skip record: only a push that provably landed on a known lane is
 *      remembered. A failed ingest, a bridge ack saying nothing was relayed, a
 *      throw, and an ack without a connId (an older daemon) all forget, so the
 *      next push of the old content is sent.
 *   3. The delivery bound: an unchanged list reaches the replica at least every
 *      10 minutes and a transcript every 30, whatever the phase of the sweep.
 *   4. Key order holds across the start of an ingest rest.
 *
 * Real projection-cache code on real files (constants redirected to a temp dir);
 * the daemon connection and the ingest client's network call are stubbed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-push'));

const sendSpy = vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ ok: true }));
let fakeConn: { hasCapability: (c: string) => boolean; send: typeof sendSpy } | null = null;
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => fakeConn,
}));
// The ingest lane's network call is stubbed; its per-key serialization is real.
// Default 'unsupported' = a replica without the route, so the bridge lane runs.
let ingestOutcome: 'sent' | 'failed' | 'unsupported' = 'unsupported';
let ingestResting = false;
const ingestSpy = vi.fn(async (_kind: string, _wire: string): Promise<'sent' | 'failed' | 'unsupported'> => ingestOutcome);
vi.mock('../../src/core/cloud-ingest.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/cloud-ingest.js')>()),
  postToCloudIngest: (kind: string, wire: string) => ingestSpy(kind, wire),
  cloudIngestResting: () => ingestResting,
}));

import {
  writeProjectionCache,
  writeTranscriptCache,
  pushProjectionToCloudNow,
  runProjectionSelfHealSweep,
  _pendingTranscriptPushSidsForTesting,
  _resetProjectionCacheForTesting,
} from '../../src/core/projection-cache.js';
import { WALNUT_HOME } from '../../src/constants.js';

const sessionEnvelope = (id: string) => ({
  version: 1,
  exportedAt: '2026-08-10T00:00:00.000Z',
  sessions: [{ id, host: '', process_status: 'running', started_at: 'x', last_active_at: 'y', message_count: 1 }],
});
const taskEnvelope = (title: string) => ({
  version: 2,
  exportedAt: '2026-08-10T00:00:00.000Z',
  tasks: [{ id: 't1', title, status: 'todo', phase: 'TODO', priority: 'none', project: '', created_at: 'x', updated_at: 'x' }],
});
const tail = (sid: string) => ({
  version: 1, sessionId: sid, exportedAt: 'z', truncated: false,
  messages: [{ role: 'user', text: 'hi', timestamp: 't' }],
});

async function wipe(): Promise<void> {
  _resetProjectionCacheForTesting();
  fakeConn = null;
  sendSpy.mockClear();
  ingestOutcome = 'unsupported';
  ingestResting = false;
  ingestSpy.mockReset();
  ingestSpy.mockImplementation(async () => ingestOutcome);
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}

beforeEach(wipe);
afterEach(wipe);

describe('the ingest lane (POST /bridge/ingest) carries uploads off the bridge', () => {
  const bridgeCapable = (): void => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event' || c === 'bridge-uplink-v1', send: sendSpy };
    sendSpy.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'bridge.status' ? { ok: true, connected: true, connId: 'd-9.1' } : { ok: true, relayed: true, connId: 'd-9.1' });
  };
  const bridgeCalls = () => sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event' || c[0] === 'bridge.status');
  afterEach(() => { sendSpy.mockImplementation(async () => ({ ok: true })); });

  it('sends over ingest, never touches the bridge, and skips a restamped identical list', async () => {
    bridgeCapable();
    ingestOutcome = 'sent';
    const payload = { which: 'tasks', data: taskEnvelope('T') };
    expect(await pushProjectionToCloudNow('projection-upsert', payload)).toBe('sent');
    expect(JSON.parse(ingestSpy.mock.calls[0]![1])).toEqual(payload);
    const restamped = { which: 'tasks', data: { ...taskEnvelope('T'), exportedAt: '2026-08-10T00:09:00.000Z' } };
    expect(await pushProjectionToCloudNow('projection-upsert', restamped)).toBe('unchanged');
    expect(await pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope('U') })).toBe('sent');
    expect(ingestSpy).toHaveBeenCalledTimes(2);
    expect(bridgeCalls()).toHaveLength(0);
  });

  it('a failed ingest is NOT retried on the bridge; the transcript stays owed for the sweep', async () => {
    bridgeCapable();
    ingestOutcome = 'failed';
    const sid = 'ingest-failed-sid';
    expect(await pushProjectionToCloudNow('transcript-upsert', { sid, data: tail(sid) })).toBe('failed');
    expect(bridgeCalls()).toHaveLength(0);
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(true);
    ingestOutcome = 'sent';
    expect(await pushProjectionToCloudNow('transcript-upsert', { sid, data: tail(sid) })).toBe('sent');
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(false);
  });

  it('a replica without the route gets the payload over the bridge instead', async () => {
    bridgeCapable();
    ingestOutcome = 'unsupported';
    expect(await pushProjectionToCloudNow('projection-upsert', { which: 'sessions', data: sessionEnvelope('s1') })).toBe('sent');
    expect(sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event')).toHaveLength(1);
  });

  it('while one upload of a key is in flight, only the newest waiting copy is sent after it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    ingestSpy.mockImplementationOnce(async () => { await gate; return 'sent'; });
    ingestOutcome = 'sent';
    const v = (title: string) => pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope(title) });
    const until = async (cond: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    const first = v('v1');
    await until(() => ingestSpy.mock.calls.length === 1); // v1 is on the wire
    const second = v('v2');
    const third = v('v3');
    await new Promise((r) => setTimeout(r, 100)); // both reached the lane
    expect(ingestSpy).toHaveBeenCalledTimes(1);
    release();
    const outcomes = await Promise.all([first, second, third]);
    expect(outcomes, JSON.stringify({ calls: ingestSpy.mock.calls.length, results: ingestSpy.mock.settledResults })).toEqual(['sent', 'sent', 'sent']);
    const titles = ingestSpy.mock.calls.map((c) => (JSON.parse(c[1]) as { data: { tasks: Array<{ title: string }> } }).data.tasks[0]!.title);
    expect(titles).toEqual(['v1', 'v3']);
  });

  it('the sweep over ingest never asks the daemon for its bridge connection', async () => {
    bridgeCapable();
    ingestOutcome = 'sent';
    await writeProjectionCache('sessions', sessionEnvelope('s1'));
    await writeProjectionCache('tasks', taskEnvelope('T'));
    await writeTranscriptCache('s1', tail('s1'));
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 3 });
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 0, unchanged: 3 });
    expect(bridgeCalls()).toHaveLength(0);
  });
});

describe('what a push that did not clearly land does to the skip record', () => {
  // Gate finding F2: H1 delivered, H2 written by the replica but its answer lost
  // (so 'failed' here), content back to H1: a kept H1 record skipped it as
  // "unchanged" while the replica served H2.
  const bridgeWith = (relayed: () => boolean): void => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event' || c === 'bridge-uplink-v1', send: sendSpy };
    sendSpy.mockImplementation(async (...args: unknown[]) =>
      args[0] === 'bridge.status' ? { ok: true, connected: true, connId: 'd-7.1' } : { ok: true, relayed: relayed(), connId: 'd-7.1' });
  };
  afterEach(() => { sendSpy.mockImplementation(async () => ({ ok: true })); });

  it('ingest: A sent, B failed, A again is SENT (the replica may hold B)', async () => {
    const A = { which: 'tasks', data: taskEnvelope('A') };
    const B = { which: 'tasks', data: taskEnvelope('B') };
    ingestOutcome = 'sent';
    expect(await pushProjectionToCloudNow('projection-upsert', A)).toBe('sent');
    ingestOutcome = 'failed';
    expect(await pushProjectionToCloudNow('projection-upsert', B)).toBe('failed');
    ingestOutcome = 'sent';
    expect(await pushProjectionToCloudNow('projection-upsert', A)).toBe('sent');
    expect(ingestSpy).toHaveBeenCalledTimes(3);
  });

  it('bridge: A relayed, B not relayed, A again is SENT', async () => {
    let relayed = true;
    bridgeWith(() => relayed);
    const sid = 'aba-bridge-sid';
    const v = (text: string) => ({ sid, data: { ...tail(sid), messages: [{ role: 'user', text, timestamp: 't' }] } });
    expect(await pushProjectionToCloudNow('transcript-upsert', v('A'))).toBe('sent');
    relayed = false;
    expect(await pushProjectionToCloudNow('transcript-upsert', v('B'))).toBe('failed');
    relayed = true;
    expect(await pushProjectionToCloudNow('transcript-upsert', v('A'))).toBe('sent');
    expect(sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event')).toHaveLength(3);
  });

  it('a push that threw on the bridge also forgets', async () => {
    let throwNext = false;
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event' || c === 'bridge-uplink-v1', send: sendSpy };
    sendSpy.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'bridge.status') return { ok: true, connected: true, connId: 'd-7.2' };
      if (throwNext) throw new Error('daemon command timed out');
      return { ok: true, relayed: true, connId: 'd-7.2' };
    });
    const A = { which: 'sessions', data: sessionEnvelope('A') };
    expect(await pushProjectionToCloudNow('projection-upsert', A)).toBe('sent');
    throwNext = true;
    expect(await pushProjectionToCloudNow('projection-upsert', { which: 'sessions', data: sessionEnvelope('B') })).toBe('failed');
    throwNext = false;
    expect(await pushProjectionToCloudNow('projection-upsert', A)).toBe('sent');
  });

  it('bridge ack without a connId (an older daemon) forgets too: A over ingest, B over that bridge in a rest, A again is SENT', async () => {
    // Gate A round 2, C7t: the transcript skip window (25 min) outlasts the
    // ingest rest (10 min), so a kept A record would skip A while the replica
    // holds B. An ack without a connId cannot be matched to a connection later.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const sid = 'old-daemon-sid';
      const v = (text: string) => ({ sid, data: { ...tail(sid), messages: [{ role: 'user', text, timestamp: 't' }] } });
      ingestOutcome = 'sent';
      expect(await pushProjectionToCloudNow('transcript-upsert', v('A'))).toBe('sent');
      fakeConn = { hasCapability: (c: string) => c === 'mobile-event', send: sendSpy }; // a pre-uplink daemon
      sendSpy.mockImplementation(async () => ({ ok: true })); // its ack: no relayed, no connId
      ingestResting = true; // a refusal started the rest: the bridge carries B
      expect(await pushProjectionToCloudNow('transcript-upsert', v('B'))).toBe('sent');
      expect(sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event')).toHaveLength(1);
      ingestResting = false;
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1_000); // the rest is over, the skip window is not
      expect(await pushProjectionToCloudNow('transcript-upsert', v('A'))).toBe('sent');
      expect(ingestSpy).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

describe('an unchanged payload reaches the replica within its bound, whatever the phase', () => {
  // Gate finding F1: with a bare 10-minute skip window and a send that takes a
  // second, the 10-minute sweep skipped and the list went at 15 minutes.
  it('the skip windows: a list 4m59s after delivery is skipped, at 5m it is sent; a transcript at 24m59s / 25m', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      ingestOutcome = 'sent';
      const t0 = Date.now();
      const list = { which: 'tasks', data: taskEnvelope('L') };
      const tr = { sid: 'bound-sid', data: tail('bound-sid') };
      await pushProjectionToCloudNow('projection-upsert', list);
      await pushProjectionToCloudNow('transcript-upsert', tr);
      vi.setSystemTime(t0 + 4 * 60_000 + 59_000);
      expect(await pushProjectionToCloudNow('projection-upsert', list)).toBe('unchanged');
      vi.setSystemTime(t0 + 5 * 60_000);
      expect(await pushProjectionToCloudNow('projection-upsert', list)).toBe('sent');
      vi.setSystemTime(t0 + 24 * 60_000 + 59_000);
      expect(await pushProjectionToCloudNow('transcript-upsert', tr)).toBe('unchanged');
      vi.setSystemTime(t0 + 25 * 60_000);
      expect(await pushProjectionToCloudNow('transcript-upsert', tr)).toBe('sent');
    } finally { vi.useRealTimers(); }
  });

  it.each([1_000, 90_000, 4 * 60_000 + 59_000])(
    'a list last delivered %ims after a sweep tick, with 1s per upload, is never 10 minutes without a delivery',
    async (phaseMs) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        ingestOutcome = 'sent';
        const at: number[] = [];
        ingestSpy.mockImplementation(async (_k: string, wire: string) => {
          if (wire.includes('"which":"tasks"')) at.push(Date.now());
          vi.setSystemTime(Date.now() + 1_000); // the upload takes a second
          return 'sent';
        });
        await writeProjectionCache('tasks', taskEnvelope('grid'));
        const t0 = Date.now();
        vi.setSystemTime(t0 + phaseMs); // a write-time push between two ticks
        expect(await pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope('grid') })).toBe('sent');
        for (let tick = 5; tick <= 40; tick += 5) {
          vi.setSystemTime(t0 + tick * 60_000);
          await runProjectionSelfHealSweep();
        }
        const gaps = at.slice(1).map((t, i) => t - at[i]!);
        expect(gaps.length).toBeGreaterThanOrEqual(3);
        expect(Math.max(...gaps)).toBeLessThanOrEqual(10 * 60_000);
      } finally { vi.useRealTimers(); }
    },
  );
});

describe('lanes keep the key order across the start of a rest', () => {
  // Gate note R06: a push that found the lane resting went to the bridge outside
  // the per-key order and could overtake an ingest request of the same key.
  it('a bridge push for a key waits for that key\'s ingest request still in flight', async () => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event', send: sendSpy };
    const order: string[] = [];
    sendSpy.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'mobile-event') order.push('bridge');
      return { ok: true };
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    ingestSpy.mockImplementationOnce(async () => { await gate; order.push('ingest'); return 'sent'; });
    const first = pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope('v1') });
    for (let i = 0; i < 100 && ingestSpy.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    ingestResting = true; // a refusal elsewhere starts the rest
    const second = pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope('v2') });
    await new Promise((r) => setTimeout(r, 100));
    expect(order).toEqual([]);
    release();
    expect(await Promise.all([first, second])).toEqual(['sent', 'sent']);
    expect(order).toEqual(['ingest', 'bridge']);
  });
});
