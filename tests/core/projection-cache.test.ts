/**
 * Projection cache (Phase 3) — the NON-git home for the cache trio + the
 * bridge push that replaces git-sync for projections/transcripts.
 *
 * Locked down here:
 *   1. Round-trips: cache/projections/{sessions,tasks}.json and
 *      cache/transcripts/<sid>.json survive write→read; corrupt files and
 *      unsafe session ids return null (ids land in filenames).
 *   2. `sync.legacy_projection_files` knob: default TRUE (fail-open to the
 *      legacy git files — a cloud box on old code must keep working), FALSE
 *      only when config says so.
 *   3. Seam read order: readSessionProjection/readSessionTranscript/
 *      readTaskProjection arbitrate cache vs legacy git-synced file by
 *      exportedAt (fresher wins, ties → cache) — the upgrade-transition path,
 *      and the guard against a stale cache shadowing fresher git data after
 *      a long bridge outage.
 *   4. pushProjectionToCloud: sends over the daemon mobile-event lane
 *      UNCONDITIONALLY (no feed-consumer gate — the cloud cache must stay
 *      warm with no phone attached) and skips payloads over the frame cap
 *      (an oversized bridge frame killed every in-flight RPC on 2026-08-09).
 *      The cap is PER KIND: the transcript lane keeps the tight 1MB guard, the
 *      list lane gets PROJECTION_PUSH_MAX_BYTES. Sizing the list lane off the
 *      transcript guard is what froze the cloud replica's task list — the task
 *      projection crossed 1MB at 3,079 rows and every push after was dropped.
 *
 * Real files, real fs — constants redirected to a temp dir; only the daemon
 * connection (network) is mocked. The push lanes (ingest, the skip record, the
 * delivery bound, key order) are pinned in projection-push.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-cache'));

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
  projectionCachePath,
  transcriptCachePath,
  writeProjectionCache,
  readProjectionCache,
  writeTranscriptCache,
  readTranscriptCache,
  legacyProjectionFilesEnabled,
  pickFresherEnvelope,
  pushProjectionToCloud,
  pushProjectionToCloudNow,
  preparePush,
  runProjectionSelfHealSweep,
  _pendingTranscriptPushSidsForTesting,
  _resetProjectionCacheForTesting,
} from '../../src/core/projection-cache.js';
import {
  SESSION_PROJECTION_FILE,
  SESSION_TRANSCRIPTS_DIR,
  readSessionProjection,
  readSessionTranscript,
} from '../../src/core/session-projection.js';
import { PROJECTION_FILE, readTaskProjection } from '../../src/core/task-projection.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';

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

describe('cache round-trips', () => {
  it('projection payloads survive write→read at the cache/ paths', async () => {
    await writeProjectionCache('sessions', sessionEnvelope('s1'));
    await writeProjectionCache('tasks', taskEnvelope('T'));
    expect(await readProjectionCache('sessions')).toEqual(sessionEnvelope('s1'));
    expect(await readProjectionCache('tasks')).toEqual(taskEnvelope('T'));
    expect(projectionCachePath('sessions')).toBe(path.join(WALNUT_HOME, 'cache', 'projections', 'sessions.json'));
    expect(projectionCachePath('tasks')).toBe(path.join(WALNUT_HOME, 'cache', 'projections', 'tasks.json'));
  });

  it('transcripts round-trip; unsafe ids are refused both ways', async () => {
    await writeTranscriptCache('sid-1', tail('sid-1'));
    expect(await readTranscriptCache('sid-1')).toEqual(tail('sid-1'));
    expect(transcriptCachePath('sid-1')).toBe(path.join(WALNUT_HOME, 'cache', 'transcripts', 'sid-1.json'));

    await writeTranscriptCache('../evil', tail('e')); // silent no-op
    expect(await readTranscriptCache('../evil')).toBeNull();
    expect(await fsp.readdir(path.join(WALNUT_HOME, 'cache', 'transcripts'))).toEqual(['sid-1.json']);
  });

  it('missing and corrupt cache files read as null', async () => {
    expect(await readProjectionCache('sessions')).toBeNull();
    await fsp.mkdir(path.dirname(projectionCachePath('tasks')), { recursive: true });
    await fsp.writeFile(projectionCachePath('tasks'), '{ not json', 'utf-8');
    expect(await readProjectionCache('tasks')).toBeNull();
  });
});

describe('sync.legacy_projection_files knob', () => {
  it('defaults TRUE with no config file (fail-open to legacy git files)', async () => {
    expect(await legacyProjectionFilesEnabled()).toBe(true);
  });

  it('reads FALSE from config, TTL-cached until reset', async () => {
    await fsp.mkdir(WALNUT_HOME, { recursive: true });
    await fsp.writeFile(CONFIG_FILE, 'version: 1\nsync:\n  legacy_projection_files: false\n', 'utf-8');
    expect(await legacyProjectionFilesEnabled()).toBe(false);

    // Flag flips back in config but the TTL cache still holds false…
    await fsp.writeFile(CONFIG_FILE, 'version: 1\nsync:\n  legacy_projection_files: true\n', 'utf-8');
    expect(await legacyProjectionFilesEnabled()).toBe(false);
    // …until reset (stands in for TTL expiry).
    _resetProjectionCacheForTesting();
    expect(await legacyProjectionFilesEnabled()).toBe(true);
  });
});

describe('seam read order: fresher of cache vs legacy git file (ties → cache)', () => {
  it('readSessionProjection: cache wins ties, a fresher legacy file wins outright', async () => {
    await fsp.mkdir(path.dirname(SESSION_PROJECTION_FILE), { recursive: true });
    await fsp.writeFile(SESSION_PROJECTION_FILE, JSON.stringify(sessionEnvelope('legacy-s')), 'utf-8');
    expect((await readSessionProjection())!.sessions[0].id).toBe('legacy-s'); // fallback works

    await writeProjectionCache('sessions', sessionEnvelope('cache-s'));
    expect((await readSessionProjection())!.sessions[0].id).toBe('cache-s'); // tie → cache

    // Bridge-outage scenario: git-sync delivered a NEWER legacy file while the
    // cache went stale — the fresher exportedAt must win.
    const fresher = { ...sessionEnvelope('legacy-fresh'), exportedAt: '2026-08-11T00:00:00.000Z' };
    await fsp.writeFile(SESSION_PROJECTION_FILE, JSON.stringify(fresher), 'utf-8');
    expect((await readSessionProjection())!.sessions[0].id).toBe('legacy-fresh');
  });

  it('pickFresherEnvelope: null handling, tie → cache, fresher side wins', () => {
    const older = { exportedAt: '2026-08-10T00:00:00.000Z', v: 'old' };
    const newer = { exportedAt: '2026-08-11T00:00:00.000Z', v: 'new' };
    expect(pickFresherEnvelope(null, null)).toBeNull();
    expect(pickFresherEnvelope(older, null)).toBe(older);
    expect(pickFresherEnvelope(null, newer)).toBe(newer);
    expect(pickFresherEnvelope(older, { ...older, v: 'legacy' })!.v).toBe('old'); // tie → cache
    expect(pickFresherEnvelope(older, newer)!.v).toBe('new');
    expect(pickFresherEnvelope(newer, older)!.v).toBe('new');
  });

  it('readSessionTranscript: tie → cache; missing id → null', async () => {
    await fsp.mkdir(SESSION_TRANSCRIPTS_DIR, { recursive: true });
    await fsp.writeFile(path.join(SESSION_TRANSCRIPTS_DIR, 'sid-9.json'), JSON.stringify(tail('legacy')), 'utf-8');
    expect((await readSessionTranscript('sid-9'))!.sessionId).toBe('legacy');

    await writeTranscriptCache('sid-9', tail('cache'));
    expect((await readSessionTranscript('sid-9'))!.sessionId).toBe('cache');
    expect(await readSessionTranscript('missing-sid')).toBeNull();
  });

  it('readTaskProjection: tie → cache, and BOTH sources fail closed on version skew', async () => {
    await fsp.mkdir(path.dirname(PROJECTION_FILE), { recursive: true });
    await fsp.writeFile(PROJECTION_FILE, JSON.stringify(taskEnvelope('legacy-t')), 'utf-8');
    expect((await readTaskProjection())!.tasks[0].title).toBe('legacy-t');

    await writeProjectionCache('tasks', taskEnvelope('cache-t'));
    expect((await readTaskProjection())!.tasks[0].title).toBe('cache-t');

    // A v1 payload in the CACHE must fail closed AND not fall through to a
    // v1 legacy file — both gates hold.
    await writeProjectionCache('tasks', { version: 1, exportedAt: 'x', tasks: [{ id: 'old' }] });
    await fsp.writeFile(PROJECTION_FILE, JSON.stringify({ version: 1, exportedAt: 'x', tasks: [] }), 'utf-8');
    expect(await readTaskProjection()).toBeNull();
  });
});

describe('pushProjectionToCloud', () => {

  it('sends a mobile-event frame when the local daemon is bridge-capable — no consumer gate', async () => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event', send: sendSpy };
    pushProjectionToCloud('projection-upsert', { which: 'sessions', data: sessionEnvelope('s1') });
    await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
    expect(sendSpy).toHaveBeenCalledWith('mobile-event', {
      kind: 'projection-upsert',
      data: { which: 'sessions', data: sessionEnvelope('s1') },
    });
  });

  it('is a silent no-op with no daemon connection or a pre-mobile-event daemon', async () => {
    // Awaited (not fire-and-forget): a push still in flight when the next test
    // swaps in its own daemon would report that test's calls as its own.
    fakeConn = null;
    expect(await pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: taskEnvelope('T') })).toBe('skipped');
    fakeConn = { hasCapability: () => false, send: sendSpy };
    expect(await pushProjectionToCloudNow('transcript-upsert', { sid: 's1', data: tail('s1') })).toBe('skipped');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('skips a transcript payload over the 1MB transcript-lane cap', async () => {
    fakeConn = { hasCapability: () => true, send: sendSpy };
    expect(await pushProjectionToCloudNow('transcript-upsert', { sid: 's1', data: 'x'.repeat(1_100_000) })).toBe('skipped');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('SENDS a list projection past 1MB — the size that froze the replica task list', async () => {
    // Regression: the real task projection is 1,152,724 bytes at 3,079 rows.
    // Under the old shared 1MB cap this push was skipped on every export, so
    // the cloud replica served its last-pushed copy indefinitely.
    fakeConn = { hasCapability: () => true, send: sendSpy };
    expect(await pushProjectionToCloudNow('projection-upsert', { which: 'tasks', data: 'x'.repeat(1_152_724) })).toBe('sent');
    // (A daemon claiming every capability is also asked for its bridge connection first.)
    expect(sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event')).toHaveLength(1);
  });

  it('still skips a list projection past the list-lane cap', async () => {
    const { PROJECTION_PUSH_MAX_BYTES } = await import('../../src/core/projection-cache.js');
    fakeConn = { hasCapability: () => true, send: sendSpy };
    expect(await pushProjectionToCloudNow('projection-upsert', {
      which: 'tasks', data: 'x'.repeat(PROJECTION_PUSH_MAX_BYTES + 1_000),
    })).toBe('skipped');
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('remembers a failed transcript push and clears it on the next success (stopped-session final tail)', async () => {
    // Unique sid + membership (not whole-set) assertions: other tests' pushes
    // are fire-and-forget IIFEs that may settle inside this test's window.
    const sid = 'stopped-final-tail-sid';
    // Bridge down when the frozen final tail is written…
    fakeConn = null;
    await pushProjectionToCloudNow('transcript-upsert', { sid, data: tail(sid) });
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(true);

    // …the self-heal sweep's retry (same call shape) succeeds once it is back.
    fakeConn = { hasCapability: () => true, send: sendSpy };
    await pushProjectionToCloudNow('transcript-upsert', { sid, data: tail(sid) });
    expect(sendSpy).toHaveBeenCalledWith('mobile-event', { kind: 'transcript-upsert', data: { sid, data: tail(sid) } });
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(false);
  });
});

describe('self-heal sweep: unchanged content is not re-sent on the same bridge connection', () => {
  // Mac uplink, 2026-09-25/26: every 5-minute sweep re-sent ~1.7MB whether or not
  // anything had changed, and bridge flaps clustered within a second of the ticks.
  let connId = 'd-1.1';
  let relayed = true;
  const mobileEvents = () => sendSpy.mock.calls.filter((c) => c[0] === 'mobile-event');
  const bridgeAware = (): void => {
    fakeConn = {
      hasCapability: (c: string) => c === 'mobile-event' || c === 'bridge-uplink-v1',
      send: sendSpy,
    };
    sendSpy.mockImplementation(async (...args: unknown[]) => {
      if (args[0] === 'bridge.status') return { ok: true, connected: true, connId };
      return { ok: true, relayed, connId };
    });
  };
  const seed = async (title = 'T'): Promise<void> => {
    await writeProjectionCache('sessions', sessionEnvelope('s1'));
    await writeProjectionCache('tasks', taskEnvelope(title));
    await writeTranscriptCache('s1', tail('s1'));
  };

  beforeEach(() => { connId = 'd-1.1'; relayed = true; });
  afterEach(() => { sendSpy.mockImplementation(async () => ({ ok: true })); vi.useRealTimers(); });

  it('sends everything once, then only what changed, and everything again on a new connection', async () => {
    bridgeAware();
    await seed();
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 3, unchanged: 0 });
    expect(mobileEvents()).toHaveLength(3);

    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 0, unchanged: 3 });
    expect(mobileEvents()).toHaveLength(3);

    await writeProjectionCache('tasks', taskEnvelope('renamed'));
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 1, unchanged: 2 });
    expect(mobileEvents().at(-1)?.[1]).toMatchObject({ kind: 'projection-upsert', data: { which: 'tasks' } });

    connId = 'd-1.2'; // the bridge redialed (or the replica restarted)
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 3, unchanged: 0 });
  });

  it('never skips a list for longer than 10 minutes, nor a transcript for longer than 30', async () => {
    // The replica serves the list's exportedAt as the phone's "Synced X ago".
    vi.useFakeTimers({ toFake: ['Date'] });
    bridgeAware();
    await seed();
    await runProjectionSelfHealSweep();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 2, unchanged: 1 });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 3, unchanged: 0 });
  });

  it('a write-time push is skipped too when the bridge already holds that content', async () => {
    bridgeAware();
    const payload = { which: 'tasks', data: taskEnvelope('T') };
    expect(await pushProjectionToCloudNow('projection-upsert', payload)).toBe('sent');
    const restamped = { which: 'tasks', data: { ...taskEnvelope('T'), exportedAt: '2026-08-10T00:05:00.000Z' } };
    expect(await pushProjectionToCloudNow('projection-upsert', restamped)).toBe('unchanged');
    expect(mobileEvents()).toHaveLength(1);
  });

  it('a daemon without bridge-uplink-v1 gets every push, as before', async () => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event', send: sendSpy };
    await seed();
    await runProjectionSelfHealSweep();
    await runProjectionSelfHealSweep();
    expect(mobileEvents()).toHaveLength(6);
    expect(sendSpy.mock.calls.some((c) => c[0] === 'bridge.status')).toBe(false);
  });

  it('an ack saying nothing was relayed is a failure: the transcript stays owed and nothing is remembered', async () => {
    bridgeAware();
    relayed = false;
    await seed();
    expect(await runProjectionSelfHealSweep()).toMatchObject({ failed: 3, sent: 0 });
    expect(_pendingTranscriptPushSidsForTesting().has('s1')).toBe(true);
    relayed = true;
    expect(await runProjectionSelfHealSweep()).toMatchObject({ sent: 3 });
    expect(_pendingTranscriptPushSidsForTesting().has('s1')).toBe(false);
  });
});

describe('preparePush: one serialization, a hash blind to exportedAt', () => {
  it.each([
    ['a list envelope', { which: 'tasks', data: taskEnvelope('T') }],
    ['a transcript', { sid: 's1', data: tail('s1') }],
    ['an envelope with nothing but the stamp', { which: 'sessions', data: { exportedAt: 'z' } }],
    ['no exportedAt', { which: 'sessions', data: { version: 1, sessions: [] } }],
    ['a stamp that is undefined', { which: 'sessions', data: { exportedAt: undefined, version: 1 } }],
    ['no head keys', { data: { exportedAt: 'z', a: [1, 'x"y'] } }],
    ['a data that is not an object', { which: 'tasks', data: 'x'.repeat(10) }],
  ])('the wire parses back to the payload: %s', (_label, payload) => {
    const prepared = preparePush(payload);
    expect(prepared).not.toBeNull();
    expect(JSON.parse(prepared!.wire)).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(Buffer.byteLength(prepared!.wire)).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });

  it('the same content under a new stamp hashes the same; any other change does not', () => {
    const a = preparePush({ which: 'tasks', data: taskEnvelope('T') })!;
    const b = preparePush({ which: 'tasks', data: { ...taskEnvelope('T'), exportedAt: '2026-09-30T00:00:00.000Z' } })!;
    const c = preparePush({ which: 'tasks', data: taskEnvelope('renamed') })!;
    const d = preparePush({ which: 'sessions', data: taskEnvelope('T') })!;
    expect(b.hash).toBe(a.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(d.hash).not.toBe(a.hash);
  });
});
