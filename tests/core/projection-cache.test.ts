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
 *      warm with no phone attached) and skips payloads over the 1MB frame cap
 *      (an oversized bridge frame killed every in-flight RPC on 2026-08-09).
 *
 * Real files, real fs — constants redirected to a temp dir; only the daemon
 * connection (network) is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-cache'));

const sendSpy = vi.fn(async () => ({ ok: true }));
let fakeConn: { hasCapability: (c: string) => boolean; send: typeof sendSpy } | null = null;
vi.mock('../../src/providers/daemon-connection.js', () => ({
  getConnectedDaemonConnection: () => fakeConn,
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
  const flush = () => new Promise((r) => setTimeout(r, 50));

  it('sends a mobile-event frame when the local daemon is bridge-capable — no consumer gate', async () => {
    fakeConn = { hasCapability: (c: string) => c === 'mobile-event', send: sendSpy };
    pushProjectionToCloud('projection-upsert', { which: 'sessions', data: sessionEnvelope('s1') });
    await flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('mobile-event', {
      kind: 'projection-upsert',
      data: { which: 'sessions', data: sessionEnvelope('s1') },
    });
  });

  it('is a silent no-op with no daemon connection or a pre-mobile-event daemon', async () => {
    fakeConn = null;
    pushProjectionToCloud('projection-upsert', { which: 'tasks', data: taskEnvelope('T') });
    fakeConn = { hasCapability: () => false, send: sendSpy };
    pushProjectionToCloud('transcript-upsert', { sid: 's1', data: tail('s1') });
    await flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('skips payloads over the 1MB frame cap', async () => {
    fakeConn = { hasCapability: () => true, send: sendSpy };
    pushProjectionToCloud('transcript-upsert', { sid: 's1', data: 'x'.repeat(1_100_000) });
    await flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('remembers a failed transcript push and clears it on the next success (stopped-session final tail)', async () => {
    // Unique sid + membership (not whole-set) assertions: other tests' pushes
    // are fire-and-forget IIFEs that may settle inside this test's window.
    const sid = 'stopped-final-tail-sid';
    // Bridge down when the frozen final tail is written…
    fakeConn = null;
    pushProjectionToCloud('transcript-upsert', { sid, data: tail(sid) });
    await flush();
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(true);

    // …the self-heal sweep's retry (same call shape) succeeds once it is back.
    fakeConn = { hasCapability: () => true, send: sendSpy };
    pushProjectionToCloud('transcript-upsert', { sid, data: tail(sid) });
    await flush();
    expect(sendSpy).toHaveBeenCalledWith('mobile-event', { kind: 'transcript-upsert', data: { sid, data: tail(sid) } });
    expect(_pendingTranscriptPushSidsForTesting().has(sid)).toBe(false);
  });
});
