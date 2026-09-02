/**
 * recordDeathWindowResumeCut — the awaited record-or-skip that runs BEFORE a
 * death-window cold resume hands anything to the CLI.
 *
 * Every cold `--resume` while pendingResumeSessionAt is set re-sends
 * `--resume-session-at`, so the CLI truncates the transcript AGAIN: whatever
 * the previous post-rewind attempt appended becomes a second abandoned branch,
 * and recordDeathWindowResumeCut persists the cut that hides it. The round-4
 * race fix made that record-or-skip a barrier: it must SETTLE before
 * session.send / the respawn, because its anchor is "the last tree line in the
 * transcript right now" — read concurrently with the respawn, the human's
 * just-sent live line could become the anchor and be hidden forever.
 *
 * Four pins (SPEC4):
 *   DEDUP     an existing cut with the same {uuid, lastUuidAtCommit} pair is
 *             never duplicated
 *   EMPTY     last tree line === the rewind point → no region, no cut
 *   ORDERING  the record (cut row persisted) resolves BEFORE send is invoked
 *             at a real flag-emission site (reinitialize)
 *   BOUNDED   a failed or hung transcript read → no cut + a warn, and the
 *             record-or-skip still resolves so the spawn proceeds (an
 *             unrecorded second truncation only leaves an extra visible
 *             branch — the safe direction — never a hidden live row)
 *
 * Pure logic + spies only: the transcript read is a mocked module seam (same
 * style as tests/core/session-rewind-pending-resume.test.ts), no real spawns,
 * no signals, no network.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
import { transcript } from '../helpers/transcript-fixtures.js';

vi.mock('../../src/constants.js', () => createMockConstants());
vi.mock('../../src/core/daemon-file-reader.js', () => mockLocalDaemonReader());

/** Session records live in a plain map; every write is captured verbatim. */
const records = new Map<string, Record<string, unknown>>();
const patches: Array<{ sessionId: string; patch: Record<string, unknown> }> = [];
vi.mock('../../src/core/session-tracker.js', () => ({
  getSessionByClaudeId: vi.fn(async (sessionId: string) => records.get(sessionId)),
  updateSessionRecord: vi.fn(async (sessionId: string, patch: Record<string, unknown>) => {
    patches.push({ sessionId, patch });
    const rec = records.get(sessionId);
    if (rec) Object.assign(rec, patch);
  }),
}));

/** The anchor read is THE seam under test: fully controllable per test. */
const { readMock } = vi.hoisted(() => ({ readMock: vi.fn() }));
vi.mock('../../src/core/session-file-reader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSessionJsonlContent: (...args: unknown[]) => readMock(...args),
}));

/** The host-local probe is the SECOND seam: mocked the same way, and null by
 *  default so every case below still exercises the transcript-read path. */
const { probeMock } = vi.hoisted(() => ({ probeMock: vi.fn() }));
vi.mock('../../src/core/sessions/session-rewind.js', () => ({
  probeRewindViaDaemon: (...args: unknown[]) => probeMock(...args),
}));

/** No real config reads (getConfig otherwise scans the machine's ssh config). */
vi.mock('../../src/core/config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: vi.fn(async () => ({})),
}));

// Pre-warm the modules the method dynamic-imports, so the fake-timer test's
// microtask spin is enough for it to reach the bounded read.
import '../../src/core/transcript-chain.js';
import '../../src/core/session-file-reader.js';
import { log } from '../../src/logging/index.js';
import { sessionRunner, ClaudeCodeSession } from '../../src/providers/claude-code-session.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

const CWD = '/proj/death-window';
const U1 = '0199bb01-0000-4000-8000-000000000001';
const U2 = '0199bb01-0000-4000-8000-000000000002';
const U3 = '0199bb01-0000-4000-8000-000000000003';

/** recordDeathWindowResumeCut is private spawn plumbing. */
const runnerInternals = sessionRunner as unknown as {
  recordDeathWindowResumeCut(sessionId: string, resumeSessionAt: string): Promise<void>;
};

/** A plain threaded user-line transcript, as raw JSONL content. */
function treeContent(uuids: string[]): string {
  const t = transcript();
  uuids.forEach((uuid, i) => t.user(uuid, `message ${i}`));
  return t.text();
}

beforeEach(() => {
  records.clear();
  patches.length = 0;
  readMock.mockReset();
  vi.restoreAllMocks();
  // Set AFTER restoreAllMocks (which clears implementations): no probe-capable
  // daemon unless a case installs one.
  probeMock.mockReset();
  probeMock.mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('recordDeathWindowResumeCut', () => {
  it('DEDUP: never appends a second cut for the same {uuid, lastUuidAtCommit} pair', async () => {
    const sid = 'dw-dup';
    const existing: InPlaceRewindCut = { uuid: U2, lastUuidAtCommit: U3, at: '2026-08-30T00:00:00.000Z' };
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2, inPlaceRewinds: [existing] });
    // Nothing was appended since the recorded cut: the last tree line still IS
    // that cut's anchor (the respawn right after the rewind commit itself).
    readMock.mockResolvedValue({ content: treeContent([U1, U2, U3]), source: 'local' });

    await expect(runnerInternals.recordDeathWindowResumeCut(sid, U2)).resolves.toBeUndefined();

    expect(patches).toEqual([]);                       // no write at all
    expect(records.get(sid)!.inPlaceRewinds).toEqual([existing]);
  });

  it('EMPTY REGION: last tree line === the rewind point → no cut', async () => {
    const sid = 'dw-empty';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    readMock.mockResolvedValue({ content: treeContent([U1, U2]), source: 'local' });

    await expect(runnerInternals.recordDeathWindowResumeCut(sid, U2)).resolves.toBeUndefined();

    expect(patches).toEqual([]);
    expect(records.get(sid)!.inPlaceRewinds).toBeUndefined();
  });

  it('ORDERING: at the reinitialize flag-emission site, the cut is persisted BEFORE send is invoked', async () => {
    // The race the fix kills: the anchor read landing AFTER the respawned CLI
    // appended the human's live line. Pinned by asserting the whole
    // record-or-skip (read → cut row persisted) settled before the send/spawn
    // primitive ever ran.
    const sid = 'dw-order';
    records.set(sid, { sessionId: sid, cwd: CWD, taskId: 'task-order', pendingResumeSessionAt: U2 });
    const callOrder: string[] = [];
    readMock.mockImplementation(async () => {
      callOrder.push('anchor-read');
      return { content: treeContent([U1, U2, U3]), source: 'local' };
    });
    vi.spyOn(ClaudeCodeSession.prototype, 'gracefulStop').mockResolvedValue(undefined);
    let cutRowsWhenSendInvoked = -1;
    const send = vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation(((...args: unknown[]) => {
      callOrder.push('send');
      cutRowsWhenSendInvoked =
        ((records.get(sid)!.inPlaceRewinds as InPlaceRewindCut[] | undefined) ?? []).length;
      // Settle the spawn so reinitialize resolves.
      const onSpawnSettled = args[13] as ((ok: boolean, err?: Error) => void) | undefined;
      onSpawnSettled?.(true);
    }) as unknown as typeof ClaudeCodeSession.prototype.send);

    await sessionRunner.reinitialize(sid);

    expect(send).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(['anchor-read', 'send']);
    expect(cutRowsWhenSendInvoked).toBe(1);            // persisted before the spawn
    expect((records.get(sid)!.inPlaceRewinds as InPlaceRewindCut[])[0]).toMatchObject({
      uuid: U2, lastUuidAtCommit: U3,
    });
    // …and the spawn still carries the flag it recorded for.
    const opts = send.mock.calls[0][14] as { resumeSessionAt?: string } | undefined;
    expect(opts?.resumeSessionAt).toBe(U2);
    // Drain the ok-callback's async record update so it can't leak into the next test.
    await new Promise((r) => setTimeout(r, 0));
  });

  it('HOST-LOCAL: takes the anchor from the daemon probe and never reads the transcript', async () => {
    // The anchor is one uuid; shuttling a whole transcript over the tunnel to
    // find it is what the byte ceiling refuses on a long one. With the probe the
    // spawn's 5s budget buys an RPC instead of a file transfer.
    const sid = 'dw-probe';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    probeMock.mockResolvedValue({ lastUuidAtCommit: U3, trailingQueueKeys: [] });

    await expect(runnerInternals.recordDeathWindowResumeCut(sid, U2)).resolves.toBeUndefined();

    expect(readMock).not.toHaveBeenCalled();
    expect(probeMock).toHaveBeenCalledWith({ sessionId: sid, cwd: CWD, host: undefined }, {});
    expect(patches).toHaveLength(1);
    expect((patches[0].patch.inPlaceRewinds as InPlaceRewindCut[])[0]).toMatchObject({
      uuid: U2, lastUuidAtCommit: U3,
    });
  });

  it('HOST-LOCAL: an empty region reported by the probe records nothing (same guards)', async () => {
    const sid = 'dw-probe-empty';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    probeMock.mockResolvedValue({ lastUuidAtCommit: U2, trailingQueueKeys: [] });

    await expect(runnerInternals.recordDeathWindowResumeCut(sid, U2)).resolves.toBeUndefined();
    expect(patches).toEqual([]);
    expect(readMock).not.toHaveBeenCalled();
  });

  it('BOUNDED (read failure): no cut, a warn, and the record-or-skip resolves so the spawn proceeds', async () => {
    const sid = 'dw-fail';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    readMock.mockRejectedValue(new Error('tunnel died'));
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {});

    await expect(runnerInternals.recordDeathWindowResumeCut(sid, U2)).resolves.toBeUndefined();

    expect(patches).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to record death-window resume cut'),
      expect.objectContaining({ sessionId: sid, error: 'tunnel died' }),
    );
  });

  it('BOUNDED (hung read): the deadline fires → no cut, a warn, and the record-or-skip resolves', async () => {
    const sid = 'dw-hang';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    readMock.mockImplementation(() => new Promise(() => {})); // never settles
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const settled = runnerInternals.recordDeathWindowResumeCut(sid, U2);
      // Spin microtasks until the deadline timer is armed (the method hops a
      // few awaits — record lookup + dynamic imports — before the read race).
      for (let i = 0; i < 100 && vi.getTimerCount() === 0; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5_001);
      await settled;                                   // resolves: the spawn is never held hostage
    } finally {
      vi.useRealTimers();
    }

    expect(patches).toEqual([]);
    expect(records.get(sid)!.inPlaceRewinds).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('anchor read timed out'),
      expect.objectContaining({ sessionId: sid, rewindPoint: U2 }),
    );
  });

  it('BOUNDED (hung PROBE): the same deadline covers the RPC, not just the read', async () => {
    // The probe carries the rewind path's own generous RPC budget, so a wedged
    // daemon socket would otherwise hold the respawn far past 5s. The deadline is
    // armed BEFORE the probe is raced for exactly this reason — and the fallback
    // read must NOT run afterwards, because its own time is already spent.
    const sid = 'dw-probe-hang';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    probeMock.mockImplementation(() => new Promise(() => {})); // never settles
    readMock.mockResolvedValue({ content: treeContent([U1, U2, U3]), source: 'local' });
    const warn = vi.spyOn(log.session, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const settled = runnerInternals.recordDeathWindowResumeCut(sid, U2);
      for (let i = 0; i < 100 && vi.getTimerCount() === 0; i++) await Promise.resolve();
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(5_001);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(patches).toEqual([]);
    expect(records.get(sid)!.inPlaceRewinds).toBeUndefined();
    expect(readMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('anchor read timed out'),
      expect.objectContaining({ sessionId: sid, rewindPoint: U2 }),
    );
  });

  it('ORDERING (hung PROBE): the spawn still happens, unrecorded, after the deadline', async () => {
    // The whole point of the bound: a probe that never answers costs the cut row,
    // never the respawn. Same ordering contract as the happy path — the
    // record-or-skip settles before send — with zero rows recorded.
    const sid = 'dw-probe-hang-order';
    records.set(sid, { sessionId: sid, cwd: CWD, taskId: 'task-hang', pendingResumeSessionAt: U2 });
    probeMock.mockImplementation(() => new Promise(() => {}));
    readMock.mockResolvedValue({ content: treeContent([U1, U2, U3]), source: 'local' });
    vi.spyOn(log.session, 'warn').mockImplementation(() => {});
    vi.spyOn(ClaudeCodeSession.prototype, 'gracefulStop').mockResolvedValue(undefined);
    let cutRowsWhenSendInvoked = -1;
    const send = vi.spyOn(ClaudeCodeSession.prototype, 'send').mockImplementation(((...args: unknown[]) => {
      cutRowsWhenSendInvoked =
        ((records.get(sid)!.inPlaceRewinds as InPlaceRewindCut[] | undefined) ?? []).length;
      const onSpawnSettled = args[13] as ((ok: boolean, err?: Error) => void) | undefined;
      onSpawnSettled?.(true);
    }) as unknown as typeof ClaudeCodeSession.prototype.send);
    vi.useFakeTimers();
    try {
      const reinit = sessionRunner.reinitialize(sid);
      for (let i = 0; i < 200 && vi.getTimerCount() === 0; i++) await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_001);
      await reinit;
      await vi.advanceTimersByTimeAsync(10);            // drain the ok-callback work
    } finally {
      vi.useRealTimers();
    }

    expect(send).toHaveBeenCalledTimes(1);
    expect(cutRowsWhenSendInvoked).toBe(0);            // nothing recorded…
    const opts = send.mock.calls[0][14] as { resumeSessionAt?: string } | undefined;
    expect(opts?.resumeSessionAt).toBe(U2);            // …but the spawn still carries the flag
  });
});
