/**
 * What an in-place rewind COMMITS, and the plumbing that consumes it.
 *
 * Two fields, two jobs, and keeping them apart is the round-2 rework:
 *   inPlaceRewinds        the DISPLAY filter's input — {uuid, lastUuidAtCommit,
 *                         at}, appended per rewind, replayed against the file at
 *                         every read (see tests/core/transcript-chain.test.ts).
 *   pendingResumeSessionAt  pure SPAWN plumbing — re-sent as --resume-session-at
 *                         on every cold resume until the first completed turn,
 *                         so a CLI death in that window cannot resume the
 *                         abandoned branch tip. It never filters anything.
 *
 * Covered:
 *   WRITE   rewindInPlace commits the cut + the flag, with the anchor (and any
 *           trailing enqueue keys) read off the file
 *           (src/core/sessions/session-rewind.ts)
 *   GUARD   a uuid the CLI could not resume to is a 409 BEFORE any write AND
 *           before anything mutates — the gate lives in resolveRewindTarget
 *           (shared by the preview, so the dialog's dry run already refuses):
 *           the uuid must be on the chain `--resume <sid>` would load, which
 *           excludes a uuid that is merely present on disk (behind a compact
 *           boundary, or on an already-abandoned branch); the CLI exits 1 at
 *           respawn on those. A preserved-segment message IS on that chain
 *           (the CLI relinks it) and stays rewindable. A failure AFTER the
 *           stop respawns the session before rethrowing.
 *   READ    resolveResumeArgs re-sends the flag on every cold resume while set
 *   CLEAR   clearPendingResumeSessionAt drops it, and no-ops when absent — and
 *           since the flag drives no filtering, clearing it needs no cache
 *           invalidation (the P0-B amplifier that structural fix removes)
 *
 * NOT covered here (needs a live CLI / the full turn-event pipeline): that the
 * clear fires on SESSION_RESULT but deliberately NOT on SESSION_ERROR — that
 * branch lives inside the session-runner's bus handler.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';
import { mockLocalDaemonReader } from '../helpers/mock-local-daemon-reader.js';
import { transcript, type TranscriptFixture } from '../helpers/transcript-fixtures.js';

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

/**
 * The rewind PROBE seam: a connected daemon that speaks 'rewind-probe-v1'.
 * Null by default, so every case above keeps taking the server-side transcript
 * read (the fallback for hosts whose daemon predates the capability).
 */
interface FakeProbeConn {
  hasCapability(cap: string): boolean;
  send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
}
const { probeConn } = vi.hoisted(() => ({ probeConn: { value: null as FakeProbeConn | null } }));
vi.mock('../../src/providers/daemon-connection.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConnectedDaemonConnection: () => probeConn.value,
}));

/** Only the history lookup of resolveRewindTarget is faked; the rest is real. */
let historyMessages: Array<{ msgId: string; role: string; text: string }> = [];
vi.mock('../../src/core/sessions/session-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readProviderSessionHistory: vi.fn(async () => ({ messages: historyMessages })),
}));

import { CLAUDE_HOME } from '../../src/constants.js';
import { encodeProjectPath } from '../../src/core/session-history.js';
import { previewSessionRewind, rewindSessionToMessage } from '../../src/core/sessions/session-rewind.js';
import { sessionRunner } from '../../src/providers/claude-code-session.js';
import { updateSessionRecord } from '../../src/core/session-tracker.js';
import type { InPlaceRewindCut } from '../../src/core/types.js';

const tmpBase = CLAUDE_HOME as string;
const CWD = '/proj/pending-resume';
const U1 = '0199aa01-0000-4000-8000-000000000001';
const U2 = '0199aa01-0000-4000-8000-000000000002';
const U3 = '0199aa01-0000-4000-8000-000000000003';

/** resolveResumeArgs / clearPendingResumeSessionAt are private plumbing. */
const runnerInternals = sessionRunner as unknown as {
  resolveResumeArgs(sessionId: string): Promise<{ resumeSessionAt?: string }>;
  clearPendingResumeSessionAt(sessionId: string): void;
};

beforeEach(async () => {
  await fsp.rm(tmpBase, { recursive: true, force: true });
  await fsp.mkdir(tmpBase, { recursive: true });
  records.clear();
  patches.length = 0;
  historyMessages = [];
  probeConn.value = null;
  vi.restoreAllMocks();
  // No live CLI to ask, and no real respawn.
  vi.spyOn(sessionRunner, 'getOrAttachLiveSession').mockResolvedValue(undefined);
  vi.spyOn(sessionRunner, 'reinitialize').mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpBase, { recursive: true, force: true }).catch(() => {});
});

async function writeFixture(sessionId: string, t: TranscriptFixture): Promise<void> {
  const dir = path.join(tmpBase, 'projects', encodeProjectPath(CWD));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${sessionId}.jsonl`), t.text());
}

/** A plain threaded user-line transcript, in the given uuid order. */
async function writeTranscript(sessionId: string, uuids: string[]): Promise<void> {
  const t = transcript();
  uuids.forEach((uuid, i) => t.user(uuid, `message ${i}`));
  await writeFixture(sessionId, t);
}

describe('in-place rewind commit', () => {
  it('records the cut (anchor read off the file) AND the spawn flag, then respawns in place', async () => {
    const sid = 'rw-commit';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude', taskId: 'task-1', title: 'A session' });
    historyMessages = [
      { msgId: U1, role: 'user', text: 'first' },
      { msgId: U2, role: 'user', text: 'second' },
      { msgId: U3, role: 'user', text: 'third' },
    ];
    await writeTranscript(sid, [U1, U2, U3]);

    const result = await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });

    expect(result.status).toBe('rewound');
    expect(result.mode).toBe('in-place');
    expect(result.sessionId).toBe(sid);           // same id — the whole point
    // ONE write with both fields. lastUuidAtCommit is the LAST tree line on disk
    // (U3), not the rewind point: everything between U2 and U3 is what the rewind
    // abandons, and everything the CLI appends afterwards sits past U3 and can
    // never be swept into the cut.
    expect(patches).toHaveLength(1);
    expect(patches[0].sessionId).toBe(sid);
    expect(patches[0].patch.pendingResumeSessionAt).toBe(U2);
    expect(patches[0].patch.inPlaceRewinds).toEqual([
      { uuid: U2, lastUuidAtCommit: U3, at: expect.any(String) },
    ]);
    const at = (patches[0].patch.inPlaceRewinds as Array<{ at: string }>)[0].at;
    expect(Number.isNaN(Date.parse(at))).toBe(false);
    // No line offsets and no fingerprints: both anchors are uuids, resolved fresh
    // at every read, so a file rewrite cannot desync them.
    expect(Object.keys(patches[0].patch).sort()).toEqual(['inPlaceRewinds', 'pendingResumeSessionAt']);
    expect(sessionRunner.reinitialize).toHaveBeenCalledWith(sid);
  });

  it('APPENDS a second cut for a rewind of a rewind, keeping the first', async () => {
    // Both regions must stay recorded: the second rewind's region swallows the
    // first branch's replacement, but the first cut is what hides the original
    // abandoned turns.
    const sid = 'rw-again';
    const first = { uuid: U2, lastUuidAtCommit: U3, at: '2026-08-30T00:00:00.000Z' };
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude', inPlaceRewinds: [first] });
    historyMessages = [
      { msgId: U1, role: 'user', text: 'first' },
      { msgId: U2, role: 'user', text: 'second' },
    ];
    await writeTranscript(sid, [U1, U2, U3]);

    await rewindSessionToMessage(sid, { messageUuid: U1, mode: 'in-place' });
    expect(patches[0].patch.inPlaceRewinds).toEqual([
      first,
      { uuid: U1, lastUuidAtCommit: U3, at: expect.any(String) },
    ]);
  });

  it('refuses with 409 when the uuid is no longer in the transcript, before writing anything', async () => {
    // The parsed history still remembers the message (cached), but the file was
    // rewritten. Committing here would make the respawn exit 1.
    const sid = 'rw-gone';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeTranscript(sid, [U1]);           // U2 is NOT on disk

    await expect(rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' }))
      .rejects.toThrow(/not on the conversation the CLI can resume/);
    expect(patches).toEqual([]);
    expect(sessionRunner.reinitialize).not.toHaveBeenCalled();
  });

  it('refuses with 409 a uuid that is on disk but BEHIND the last compact boundary', async () => {
    // The measured fidelity P2: `--resume-session-at` resolves against the chain
    // getLastSessionLog loads, which terminates at the newest compact boundary. A
    // pre-compaction uuid exists on disk, so the old exists-check accepted it and
    // the respawn died with exit 1. Walnut's own history view keeps pre-compact
    // turns visible, which is exactly why the human can click one.
    const sid = 'rw-precompact';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U1, role: 'user', text: 'before the compaction' }];
    const t = transcript()
      .user(U1, 'before the compaction').assistant('0199aa01-0000-4000-8000-0000000000a1', 'pre-compact reply')
      .compactBoundary('0199aa01-0000-4000-8000-0000000000cb', { logicalParentUuid: '0199aa01-0000-4000-8000-0000000000a1' })
      .user(U2, 'after the compaction');
    await writeFixture(sid, t);

    await expect(rewindSessionToMessage(sid, { messageUuid: U1, mode: 'in-place' }))
      .rejects.toThrow(/not on the conversation the CLI can resume/);
    expect(patches).toEqual([]);
  });

  it('accepts a uuid that IS on the resumable chain of a compacted transcript', async () => {
    // The other half of the guard: post-boundary messages stay rewindable.
    const sid = 'rw-postcompact';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'after the compaction' }];
    const t = transcript()
      .user(U1, 'before the compaction')
      .compactBoundary('0199aa01-0000-4000-8000-0000000000cb', { logicalParentUuid: U1 })
      .user(U2, 'after the compaction')
      .assistant(U3, 'post-compact reply');
    await writeFixture(sid, t);

    const result = await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });
    expect(result.status).toBe('rewound');
    expect(patches[0].patch.inPlaceRewinds).toEqual([
      { uuid: U2, lastUuidAtCommit: U3, at: expect.any(String) },
    ]);
  });

  it('refuses a message id the CLI could never resolve (no transcript uuid)', async () => {
    const sid = 'rw-synthetic';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: 'queue-2026-08-28T10:00:00.000Z', role: 'user', text: 'x' }];
    await expect(rewindSessionToMessage(sid, { messageUuid: 'queue-2026-08-28T10:00:00.000Z' }))
      .rejects.toThrow(/cannot be used as a rewind point/);
    expect(patches).toEqual([]);
  });

  it('the PREVIEW refuses an off-chain uuid too — the dialog grays out before anything mutates', async () => {
    // The gate lives in resolveRewindTarget, shared by preview and commit, so
    // the dry run the dialog opens on already answers "this one can't rewind"
    // with the reason. The old placement (after gracefulStop) meant the dialog
    // said canRewind and the human walked into a refusal with a stopped CLI.
    const sid = 'rw-preview-gate';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U1, role: 'user', text: 'before the compaction' }];
    const t = transcript()
      .user(U1, 'before the compaction')
      .compactBoundary('0199aa01-0000-4000-8000-0000000000cb', { logicalParentUuid: U1 })
      .user(U2, 'after the compaction');
    await writeFixture(sid, t);

    await expect(previewSessionRewind(sid, U1))
      .rejects.toThrow(/not on the conversation the CLI can resume/);
    expect(patches).toEqual([]);
    expect(sessionRunner.reinitialize).not.toHaveBeenCalled();
  });

  it('accepts a rewind point INSIDE the last compaction\'s preserved segment', async () => {
    // A suffix-preserving /compact dedup-skips the kept messages: on disk they
    // keep pre-compact parentUuids while the first post-compact message parents
    // onto the anchor (the last summary). The CLI relinks the endpoints on load
    // (applyPreservedSegmentRelinks), so `--resume-session-at` a preserved
    // message WORKS — the gate must accept it (4/17 real preserved-segment
    // files have a human message this used to 409).
    const sid = 'rw-preserved';
    const HEAD = '0199aa01-0000-4000-8000-000000000011';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: HEAD, role: 'user', text: 'keep this ask' }];
    const t = transcript()
      .user(U1, 'summarized away')
      .user(HEAD, 'keep this ask')                 // preserved head (parent U1 on disk)
      .assistant('tail-a', 'keep this reply')      // preserved tail
      .compactBoundary('cb-seg', {
        logicalParentUuid: 'tail-a',
        compactMetadata: {
          trigger: 'auto', preTokens: 150_000,
          preservedSegment: { headUuid: HEAD, anchorUuid: 'sum-1', tailUuid: 'tail-a' },
        },
      })
      .user('sum-1', 'summary of the earlier conversation', { isCompactSummary: true })
      .from('sum-1').user(U2, 'post-compact ask')  // parents onto the anchor on disk
      .assistant(U3, 'post-compact reply');
    await writeFixture(sid, t);

    const result = await rewindSessionToMessage(sid, { messageUuid: HEAD, mode: 'in-place' });
    expect(result.status).toBe('rewound');
    expect((patches[0].patch.inPlaceRewinds as InPlaceRewindCut[])[0]).toMatchObject({
      uuid: HEAD, lastUuidAtCommit: U3,
    });
  });

  it('captures trailing enqueue identity keys at commit (a queued message the rewind abandons)', async () => {
    // Queue lines carry no uuid, so an enqueue sitting past the last tree line
    // is outside the uuid-anchored region — the commit snapshots its identity
    // key on the cut record so the read can suppress its Pattern-B echo.
    const sid = 'rw-trailq';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    const t = transcript();
    t.user(U1, 'first').user(U2, 'second').user(U3, 'third');
    t.meta({ type: 'queue-operation', operation: 'enqueue', sessionId: sid, content: 'queued mid-turn' });
    await writeFixture(sid, t);

    await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });
    const cut = (patches[0].patch.inPlaceRewinds as InPlaceRewindCut[])[0];
    expect(cut.lastUuidAtCommit).toBe(U3);
    expect(cut.trailingQueueKeys).toHaveLength(1);
    expect(cut.trailingQueueKeys![0].endsWith(' queued mid-turn')).toBe(true);
  });

  it('a failure AFTER the stop respawns the session before rethrowing (never leaves it dead)', async () => {
    // The gate runs before anything mutates, but the commit itself can still
    // fail (record store down). By then the CLI has been gracefully stopped —
    // "rewind failed, and your session is now dead" must never be the outcome,
    // so everything after the stop recovers with a best-effort respawn.
    const sid = 'rw-recover';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeTranscript(sid, [U1, U2, U3]);
    vi.mocked(updateSessionRecord).mockRejectedValueOnce(new Error('record store unavailable'));

    await expect(rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' }))
      .rejects.toThrow(/record store unavailable/);
    expect(sessionRunner.reinitialize).toHaveBeenCalledWith(sid);
    expect(records.get(sid)!.inPlaceRewinds).toBeUndefined();  // nothing committed
  });
});

describe('the host-local rewind probe (capability rewind-probe-v1)', () => {
  /** A connected daemon whose transcript.rewindProbe answers with `replies` in
   *  order (a single reply is reused for every call). */
  function daemonAnswering(...replies: Array<Record<string, unknown> | Error>) {
    const send = vi.fn(async (_cmd: string, _params: Record<string, unknown>) => {
      const reply = replies.length > 1 ? replies.shift()! : replies[0];
      if (reply instanceof Error) throw reply;
      return { ok: true, ...reply };
    });
    probeConn.value = { hasCapability: (cap: string) => cap === 'rewind-probe-v1', send };
    return send;
  }

  const probeReply = (over: Record<string, unknown> = {}) => ({
    found: true, jsonlPath: '/host/projects/x.jsonl', mtimeMs: 1, size: 66_000_000,
    lineCount: 3, leafUuid: U3, lastUuidAtCommit: U3, trailingQueueKeys: [], ...over,
  });

  /** A transcript too big for the reader's ceiling, set below. */
  async function writeOversized(sid: string): Promise<void> {
    const t = transcript();
    for (let i = 0; i < 40; i++) t.user(`0199aa02-0000-4000-8000-${String(i).padStart(12, '0')}`, `padding ${i} ${'x'.repeat(120)}`);
    t.user(U1, 'first').user(U2, 'second').user(U3, 'third');
    await writeFixture(sid, t);
  }

  afterEach(() => { delete process.env.WALNUT_MAX_FILE_READ_BYTES; });

  it('answers BOTH the chain gate and the commit anchor with no transcript read at all', async () => {
    // The live 500: a 66 MB transcript on a remote host: both stages used to
    // shuttle the whole file through DaemonFileReader, which refuses it. There is
    // deliberately NO fixture on disk here, so a server-side read could only
    // fail — a green commit proves the daemon answered both questions.
    const sid = 'rw-probe-both';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    const send = daemonAnswering(probeReply({ onChain: true, trailingQueueKeys: ['2026-08-30T00:00:09.000Z queued mid-turn'] }));

    const result = await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });

    expect(result.status).toBe('rewound');
    expect(patches[0].patch.inPlaceRewinds).toEqual([{
      uuid: U2, lastUuidAtCommit: U3, at: expect.any(String),
      trailingQueueKeys: ['2026-08-30T00:00:09.000Z queued mid-turn'],
    }]);
    // Two RPCs: the gate asks about the uuid, the commit asks only for the anchor.
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe('transcript.rewindProbe');
    expect(send.mock.calls[0][1]).toMatchObject({ sid, cwd: CWD, uuid: U2 });
    expect(send.mock.calls[1][1].uuid).toBeUndefined();
    expect(sessionRunner.reinitialize).toHaveBeenCalledWith(sid);
  });

  it('refuses an off-chain uuid on the probe\'s word alone (409, nothing mutated)', async () => {
    const sid = 'rw-probe-offchain';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U1, role: 'user', text: 'behind a compaction' }];
    daemonAnswering(probeReply({ onChain: false }));

    await expect(rewindSessionToMessage(sid, { messageUuid: U1, mode: 'in-place' }))
      .rejects.toThrow(/not on the conversation the CLI can resume/);
    expect(patches).toEqual([]);
    expect(sessionRunner.reinitialize).not.toHaveBeenCalled();
  });

  it('ignores a daemon that lacks the capability and reads the transcript itself', async () => {
    const sid = 'rw-probe-nocap';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeTranscript(sid, [U1, U2, U3]);
    const send = vi.fn();
    probeConn.value = { hasCapability: () => false, send };

    await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });
    expect(send).not.toHaveBeenCalled();
    expect(patches[0].patch.inPlaceRewinds).toEqual([
      { uuid: U2, lastUuidAtCommit: U3, at: expect.any(String) },
    ]);
  });

  it('falls back to the transcript read when the RPC itself fails', async () => {
    // A daemon that advertises the capability can still die mid-command; the
    // answer must come from the file rather than the rewind failing.
    const sid = 'rw-probe-rpcfail';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeTranscript(sid, [U1, U2, U3]);
    daemonAnswering(new Error('daemon socket closed'));

    await rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' });
    expect(patches[0].patch.inPlaceRewinds).toEqual([
      { uuid: U2, lastUuidAtCommit: U3, at: expect.any(String) },
    ]);
  });

  it('turns a byte-ceiling refusal in the GATE into a 503 upgrade hint, never a raw limit error', async () => {
    // No probe (the host runs an old daemon) + a transcript past the reader's
    // ceiling: the read throws `file read exceeded the N-byte ceiling`, which used
    // to reach the human as a 500. It is a daemon-age problem and says so.
    const sid = 'rw-ceiling-gate';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeOversized(sid);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '2048';

    await expect(rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' }))
      .rejects.toMatchObject({
        statusCode: 503,
        message: expect.stringContaining('needs the current daemon'),
      });
    expect(patches).toEqual([]);
    expect(sessionRunner.reinitialize).not.toHaveBeenCalled();   // nothing was stopped
  });

  it('a byte-ceiling refusal at COMMIT still respawns the session before rethrowing', async () => {
    // The gate passed (the probe answered it), then the daemon dropped — so the
    // commit fell back to the read and hit the ceiling. By then the CLI has been
    // stopped: "rewind failed, and your session is now dead" must never happen.
    const sid = 'rw-ceiling-commit';
    records.set(sid, { sessionId: sid, cwd: CWD, engine: 'claude' });
    historyMessages = [{ msgId: U2, role: 'user', text: 'second' }];
    await writeOversized(sid);
    process.env.WALNUT_MAX_FILE_READ_BYTES = '2048';
    daemonAnswering(probeReply({ onChain: true }), new Error('daemon socket closed'));

    await expect(rewindSessionToMessage(sid, { messageUuid: U2, mode: 'in-place' }))
      .rejects.toMatchObject({ statusCode: 503 });
    expect(patches).toEqual([]);
    expect(sessionRunner.reinitialize).toHaveBeenCalledWith(sid);
  });
});

describe('pendingResumeSessionAt threading', () => {
  it('rides every cold resume while it is set', async () => {
    const sid = 'thread-set';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    const args = await runnerInternals.resolveResumeArgs(sid);
    expect(args.resumeSessionAt).toBe(U2);
  });

  it('is absent for an ordinary session', async () => {
    const sid = 'thread-unset';
    records.set(sid, { sessionId: sid, cwd: CWD });
    expect((await runnerInternals.resolveResumeArgs(sid)).resumeSessionAt).toBeUndefined();
    // Unknown session: no record, no flag, no throw.
    expect((await runnerInternals.resolveResumeArgs('thread-missing')).resumeSessionAt).toBeUndefined();
  });

  it('clears once a turn has really completed — and needs no cache invalidation', async () => {
    const sid = 'thread-clear';
    records.set(sid, { sessionId: sid, cwd: CWD, pendingResumeSessionAt: U2 });
    runnerInternals.clearPendingResumeSessionAt(sid);           // fire-and-forget
    await vi.waitFor(() => {
      expect(patches).toEqual([{ sessionId: sid, patch: { pendingResumeSessionAt: undefined } }]);
    });
    // …and the next resume no longer carries it. Nothing else has to happen:
    // clearing the flag cannot change what history serves, because the display
    // filter reads inPlaceRewinds. Round 1 made this clear a filter input with no
    // invalidation behind it, which is how a truncated parse outlived the flag.
    expect((await runnerInternals.resolveResumeArgs(sid)).resumeSessionAt).toBeUndefined();
    expect(records.get(sid)!.inPlaceRewinds).toBeUndefined();
  });

  it('is a cheap no-op for a session that was never rewound', async () => {
    const sid = 'thread-noop';
    records.set(sid, { sessionId: sid, cwd: CWD });
    runnerInternals.clearPendingResumeSessionAt(sid);
    await new Promise((r) => setTimeout(r, 20));
    expect(patches).toEqual([]);
  });
});
