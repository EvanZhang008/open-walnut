/**
 * The session git glance's server side (src/core/session-git-status.ts): which
 * repos it reads for a session, when it reads them again, and when it tells
 * the web. The host reads are injected; the real git code has its own test
 * (tests/providers/git-status-core.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetSessionGitStatusForTesting, _setSessionGitStatusDepsForTesting,
  computeSessionGitGlance, getSessionGitGlances, noteSessionActivity, noteSessionChangesComputed,
  type GitRepoStatus, type SessionGitGlance,
} from '../../src/core/session-git-status.js';

function repo(root: string, over: Partial<GitRepoStatus> = {}): GitRepoStatus {
  return { repoRoot: root, branch: 'main', head: 'abc123456', upstream: 'origin/main', ahead: 0, behind: 0, files: 0, untracked: 0, conflicted: 0, insertions: 0, deletions: 0, ...over };
}

let now = 1_000_000;
let emitted: SessionGitGlance[];
let readLocal: ReturnType<typeof vi.fn>;
let readRemote: ReturnType<typeof vi.fn>;
let sessions: Record<string, { cwd?: string; host?: string }>;
let peeks: Record<string, { fileCount: number; groups: Array<{ repoRoot: string; files: unknown[] }> } | null>;
let countChanges: ReturnType<typeof vi.fn>;
let shedding: boolean;
let busy: boolean;
/** Each session transcript's size+mtime signature, as a stat would read it. */
let sigs: Record<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  emitted = [];
  sessions = {
    s1: { cwd: '/w/task-dir' },
    remote: { cwd: '~/code/app', host: 'devbox' },
  };
  peeks = {
    s1: { fileCount: 3, groups: [{ repoRoot: '/w/task-dir/small', files: [1] }, { repoRoot: '/w/task-dir/big', files: [1, 2] }] },
    remote: null,
  };
  readLocal = vi.fn(async (dirs: string[]) => dirs.filter((d) => d !== '/w/task-dir').map((d) => repo(d, { files: 1 })));
  readRemote = vi.fn(async (_host: string, dirs: string[]) => dirs.map((d) => repo(d)));
  shedding = false;
  busy = false;
  sigs = { s1: 'v1' };
  // The real compute reports its count back through noteSessionChangesComputed.
  countChanges = vi.fn(async (id: string) => { noteSessionChangesComputed(id, 7); });
  _setSessionGitStatusDepsForTesting({
    getSession: async (id) => sessions[id] ?? null,
    peekChanges: async (id) => peeks[id] ?? null,
    readLocal,
    readRemote,
    emit: (g) => { emitted.push(g); },
    countChanges,
    shedding: () => shedding,
    changesBusy: () => busy,
    transcriptSig: async (id) => sigs[id] ?? null,
    now: () => now,
  });
});

afterEach(() => {
  _resetSessionGitStatusForTesting();
  _setSessionGitStatusDepsForTesting(null);
  vi.useRealTimers();
});

describe('which repos a session is read in', () => {
  it('the repos it changed (most files first), then its cwd; the Changed count from the cache', async () => {
    const g = await computeSessionGitGlance('s1');
    expect(readLocal).toHaveBeenCalledWith(['/w/task-dir/big', '/w/task-dir/small', '/w/task-dir']);
    expect(g.repos.map((r) => r.repoRoot)).toEqual(['/w/task-dir/big', '/w/task-dir/small']);
    expect(g.changedFiles).toBe(3);
    expect(g.unavailable).toBeUndefined();
  });

  it('a remote session asks its host; an unconnected host keeps the last answer and says so', async () => {
    const first = await computeSessionGitGlance('remote');
    expect(readRemote).toHaveBeenCalledWith('devbox', ['~/code/app']);
    expect(first.repos).toHaveLength(1);
    expect(first.changedFiles).toBeNull();
    readRemote.mockResolvedValueOnce('host_offline');
    now += 60_000;
    const second = await computeSessionGitGlance('remote');
    expect(second.unavailable).toBe('host_offline');
    expect(second.repos).toEqual(first.repos);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('a session with no cwd and no edits has no repos and reads nothing', async () => {
    sessions.bare = {};
    const g = await computeSessionGitGlance('bare');
    expect(g.repos).toEqual([]);
    expect(readLocal).not.toHaveBeenCalled();
  });
});

describe('when it tells the web', () => {
  it('only when something changed', async () => {
    await computeSessionGitGlance('s1');
    expect(emitted).toHaveLength(1);
    now += 60_000;
    await computeSessionGitGlance('s1');
    expect(emitted).toHaveLength(1);
    readLocal.mockImplementationOnce(async (dirs: string[]) => dirs.filter((d) => d !== '/w/task-dir').map((d) => repo(d, { files: 2, insertions: 4 })));
    now += 60_000;
    await computeSessionGitGlance('s1');
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.repos[0]!.insertions).toBe(4);
  });

  it('a new Changed count goes out at once, and the repos are read again', async () => {
    await computeSessionGitGlance('s1');
    await getSessionGitGlances(['s1']); // watched
    noteSessionChangesComputed('s1', 5);
    expect(emitted.at(-1)!.changedFiles).toBe(5);
    noteSessionChangesComputed('s1', 5);
    expect(emitted.filter((g) => g.changedFiles === 5)).toHaveLength(1);
    const calls = readLocal.mock.calls.length;
    now += 20_000;
    await vi.runOnlyPendingTimersAsync();
    expect(readLocal.mock.calls.length).toBe(calls + 1);
  });
});

describe('reads', () => {
  it('a batch serves the cache at once and re-reads only what is stale', async () => {
    const cold = await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    expect(cold.s1?.repos).toHaveLength(2);
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 5_000;
    await getSessionGitGlances(['s1']);
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 30_000;
    const stale = await getSessionGitGlances(['s1']);
    expect(stale.s1?.repos).toHaveLength(2); // served from the cache, re-read behind
    await vi.runOnlyPendingTimersAsync();
    expect(readLocal).toHaveBeenCalledTimes(2);
  });

  it('a cold read that takes too long answers null now and the result comes as an event', async () => {
    let release!: () => void;
    readLocal.mockImplementationOnce(() => new Promise((r) => { release = () => r([repo('/w/task-dir/big')]); }));
    const p = getSessionGitGlances(['s1'], { waitMs: 500 });
    await vi.advanceTimersByTimeAsync(600);
    expect((await p).s1).toBeNull();
    release();
    await vi.runOnlyPendingTimersAsync();
    expect(emitted.at(-1)?.sessionId).toBe('s1');
  });

  it('refresh re-reads unless the last read is under 10 s old; one read at a time per session', async () => {
    await computeSessionGitGlance('s1');
    now += 3_000;
    await getSessionGitGlances(['s1'], { refresh: true, waitMs: 1_000 });
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 10_000;
    const a = computeSessionGitGlance('s1');
    const b = computeSessionGitGlance('s1');
    expect(a).toBe(b);
    await a;
    expect(readLocal).toHaveBeenCalledTimes(2);
  });
});

describe('activity of a watched session', () => {
  it('a burst of tool calls is one read, no sooner than 10 s after the last', async () => {
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    expect(readLocal).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) noteSessionActivity('s1');
    await vi.advanceTimersByTimeAsync(3_500);
    expect(readLocal).toHaveBeenCalledTimes(1); // the 10 s floor holds it
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(readLocal).toHaveBeenCalledTimes(2);
  });

  it('a session nobody looked at is never read on activity', async () => {
    noteSessionActivity('s1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readLocal).not.toHaveBeenCalled();
  });

  it('the watch lapses 15 minutes after the last look', async () => {
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    now += 16 * 60_000;
    noteSessionActivity('s1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(readLocal).toHaveBeenCalledTimes(1);
  });
});

describe('load', () => {
  it('a hung remote host never holds up local sessions', async () => {
    for (let i = 0; i < 6; i++) sessions[`r${i}`] = { cwd: `/h/app${i}`, host: 'slowbox' };
    readRemote.mockImplementation(() => new Promise(() => { /* never answers */ }));
    for (let i = 0; i < 6; i++) void computeSessionGitGlance(`r${i}`);
    await vi.advanceTimersByTimeAsync(10);
    expect(readRemote).toHaveBeenCalledTimes(2); // two at a time on that host
    const g = await computeSessionGitGlance('s1');
    expect(g.repos).toHaveLength(2);
  });

  it('sessions working in the same dirs share one read', async () => {
    sessions.twin = { cwd: '/w/task-dir' };
    peeks.twin = peeks.s1!;
    await Promise.all([computeSessionGitGlance('s1'), computeSessionGitGlance('twin')]);
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 6_000;
    await computeSessionGitGlance('twin');
    expect(readLocal).toHaveBeenCalledTimes(2);
  });

  it('a failed read is not retried at every ask', async () => {
    readLocal.mockRejectedValueOnce(new Error('timeout'));
    const g = await computeSessionGitGlance('s1');
    expect(g.unavailable).toBe('error');
    now += 5_000;
    await getSessionGitGlances(['s1']);
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 30_000;
    await getSessionGitGlances(['s1']);
    await vi.runOnlyPendingTimersAsync();
    expect(readLocal).toHaveBeenCalledTimes(2);
  });

  it('a page keeping its rows watched re-reads only old answers', async () => {
    await computeSessionGitGlance('s1');
    now += 5 * 60_000;
    await getSessionGitGlances(['s1'], { maxAgeMs: 10 * 60_000 });
    expect(readLocal).toHaveBeenCalledTimes(1);
    now += 6 * 60_000;
    await getSessionGitGlances(['s1'], { maxAgeMs: 10 * 60_000 });
    await vi.runOnlyPendingTimersAsync();
    expect(readLocal).toHaveBeenCalledTimes(2);
  });
});

it('a Changed count that lands while a read runs is not overwritten by it', async () => {
  peeks.s1 = null;
  await computeSessionGitGlance('s1');
  await getSessionGitGlances(['s1']);
  let release!: () => void;
  readLocal.mockImplementationOnce(() => new Promise((r) => { release = () => r([repo('/w/task-dir/big')]); }));
  now += 60_000;
  const reading = computeSessionGitGlance('s1');
  await vi.advanceTimersByTimeAsync(1);
  noteSessionChangesComputed('s1', 4);
  release();
  const g = await reading;
  expect(g.changedFiles).toBe(4);
  expect(emitted.at(-1)!.changedFiles).toBe(4);
});

describe('a Changed count before the tab is ever opened', () => {
  it('a watched session with no list gets one counted behind, and its count goes out', async () => {
    peeks.s1 = null;
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(1);
    expect(countChanges.mock.calls[0]![0]).toBe('s1');
    expect(emitted.at(-1)!.changedFiles).toBe(7);
  });

  it('one count at a time, paced; an open panel (refresh) goes first; never twice in 10 minutes', async () => {
    for (const id of ['a', 'b', 'c']) { sessions[id] = { cwd: `/w/${id}` }; peeks[id] = null; }
    let release!: () => void;
    countChanges.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    await getSessionGitGlances(['a', 'b'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges.mock.calls.map((c) => c[0])).toEqual(['a']); // b waits its turn
    await getSessionGitGlances(['c'], { waitMs: 1_000 });
    now += 20_000;
    await getSessionGitGlances(['c'], { refresh: true, waitMs: 1_000 });
    release();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges.mock.calls.map((c) => c[0])).toEqual(['a', 'c', 'b']);
    // b's count is known now; a session whose count failed is not retried at every read.
    countChanges.mockClear();
    countChanges.mockRejectedValueOnce(new Error('parse failed'));
    sessions.d = { cwd: '/w/d' }; peeks.d = null;
    await getSessionGitGlances(['d'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    now += 60_000;
    await computeSessionGitGlance('d');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges.mock.calls.map((c) => c[0])).toEqual(['d']);
  });

  it('nothing is counted for a session nobody watches, one with no cwd, or while memory is short', async () => {
    peeks.s1 = null;
    await computeSessionGitGlance('s1');
    sessions.bare = {};
    await getSessionGitGlances(['bare'], { waitMs: 1_000 });
    shedding = true;
    sessions.e = { cwd: '/w/e' }; peeks.e = null;
    await getSessionGitGlances(['e'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges).not.toHaveBeenCalled();
  });

  it('a count waits behind a compute already running (one transcript parse at a time)', async () => {
    peeks.s1 = null;
    busy = true;
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(countChanges).not.toHaveBeenCalled();
    busy = false;
    await vi.advanceTimersByTimeAsync(2_100);
    expect(countChanges).toHaveBeenCalledTimes(1);
  });

  it('an open panel retries a failed count after 30 s, a row only after 10 minutes', async () => {
    peeks.s1 = null;
    countChanges.mockRejectedValueOnce(new Error('host away'));
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(1);
    now += 60_000;
    await computeSessionGitGlance('s1'); // a row's re-read: still inside the 10 minutes
    await vi.advanceTimersByTimeAsync(3_000);
    expect(countChanges).toHaveBeenCalledTimes(1);
    await getSessionGitGlances(['s1'], { refresh: true, waitMs: 1_000 }); // the panel opens
    await vi.advanceTimersByTimeAsync(3_000);
    expect(countChanges).toHaveBeenCalledTimes(2);
  });

  it('the queue holds at most 100 sessions', async () => {
    let release!: () => void;
    countChanges.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const ids = Array.from({ length: 130 }, (_, i) => `q${i}`);
    for (const id of ids) { sessions[id] = { cwd: `/w/${id}` }; peeks[id] = null; }
    await getSessionGitGlances(ids, { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(1); // q0 runs, 100 wait, the rest are dropped
    release();
    countChanges.mockImplementation(async () => {});
    await vi.advanceTimersByTimeAsync(130 * 2_100);
    expect(countChanges).toHaveBeenCalledTimes(101);
  });
});


describe('a counted session is counted again when its repos move', () => {
  async function counted(): Promise<void> {
    peeks.s1 = null;
    await getSessionGitGlances(['s1'], { waitMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(1);
    expect(emitted.at(-1)!.changedFiles).toBe(7);
  }

  it('its list grew with no Changed tab open: the count follows, keeping its parse state', async () => {
    await counted();
    countChanges.mockImplementationOnce(async (id: string) => { noteSessionChangesComputed(id, 8); });
    // The session writes a new file: its transcript grows, one more uncommitted file in its repo.
    sigs.s1 = 'v2';
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 2 })));
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges).toHaveBeenCalledTimes(2);
    expect(countChanges.mock.calls[1]![2]).toEqual({ recount: true });
    expect(emitted.at(-1)!.changedFiles).toBe(8);
  });

  it('repos that did not move are never counted again; a move inside the window waits for its end', async () => {
    await counted();
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges).toHaveBeenCalledTimes(1);
    // A recount runs, then the repos move again 10s later: not now, but when its 30s are up.
    sigs.s1 = 'v2';
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 2 })));
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(2);
    sigs.s1 = 'v3';
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 3 })));
    now += 10_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(1);
    expect(countChanges).toHaveBeenCalledTimes(2);
    now += 20_000;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(countChanges).toHaveBeenCalledTimes(3);
  });

  it('a repo another session (or the user) moved: an idle session is not counted again', async () => {
    await counted();
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 5 })));
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(countChanges).toHaveBeenCalledTimes(1);
    // Its own transcript moves next: now it is.
    sigs.s1 = 'v2';
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 6 })));
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges).toHaveBeenCalledTimes(2);
  });

  it('a session nobody watches any more is not counted again', async () => {
    await counted();
    _resetSessionGitStatusForTesting();
    readLocal.mockImplementation(async (dirs: string[]) => dirs.map((d) => repo(d, { files: 2 })));
    await computeSessionGitGlance('s1');
    now += 60_000;
    await computeSessionGitGlance('s1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(countChanges).toHaveBeenCalledTimes(1);
  });
});
