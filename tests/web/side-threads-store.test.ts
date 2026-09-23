/**
 * Contract tests for the side-threads store — the shared state behind the "btw"
 * drawer. It exists BECAUSE the drawer is mounted twice per SessionPanel, so the
 * invariants a browser spec can't see are exactly the ones that matter here:
 *
 * 1. One list request serves concurrent openers (both mounts expand at once).
 * 2. A refresh racing an in-flight create must NOT blink away the optimistic row.
 * 3. Create/promote/delete are optimistic AND reversible — a failure restores the
 *    pre-action state instead of leaving a phantom chip or a lost thread.
 * 4. Standby prewarm is fire-and-forget + throttled: it can never reject into the
 *    UI, and re-clicking "+ New" must not fan out spawns.
 * 5. Only ONE drawer instance may claim "open" (two open popovers would mount two
 *    useSessionStream subscriptions for one thread session id).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SideThread, SideThreadsResponse } from '@/api/sideThreads';

const api = vi.hoisted(() => ({
  listSideThreads: vi.fn<(sid: string) => Promise<SideThreadsResponse>>(),
  createSideThread: vi.fn<(sid: string, q: string, opts?: Record<string, unknown>) => Promise<{ thread: SideThread }>>(),
  promoteSideThread: vi.fn<(sid: string, tid: string) => Promise<{ taskId: string; parentTaskId?: string }>>(),
  deleteSideThread: vi.fn<(sid: string, tid: string) => Promise<{ ok: true }>>(),
  archiveSideThread: vi.fn<(sid: string, tid: string) => Promise<{ archived: true; archivedAt: string }>>(),
  restoreSideThread: vi.fn<(sid: string, tid: string) => Promise<{ archived: false }>>(),
  prewarmSideThreadStandby: vi.fn<(sid: string) => Promise<{ ok: true }>>(),
  isForkUnsupportedError: vi.fn<(err: unknown) => boolean>(),
}));

vi.mock('@/api/sideThreads', () => api);

const {
  PENDING_PROMOTE,
  PENDING_THREAD_PREFIX,
  __resetSideThreadsStore,
  createSideThreadOptimistic,
  deleteSideThreadOptimistic,
  deriveThreadTitle,
  activeSideThreads,
  archivedSideThreads,
  setSideThreadArchivedOptimistic,
  isSideThreadReadOnly,
  applySideThreadTitle,
  SIDE_THREAD_DIGEST_MARKER,
  formatSideThreadDigestForComposer,
  formatSideThreadForComposer,
  pickSideThreadDigestReply,
  readSideThreadDigest,
  getOpenDrawerInstance,
  getSideThreadsState,
  prewarmSideThread,
  promoteSideThreadOptimistic,
  refreshSideThreads,
  setActiveSideThread,
  setOpenDrawerInstance,
  sideThreadLabel,
  sideThreadsBadgeCount,
  subscribeSideThreads,
} = await import('@/stores/side-threads');

const PARENT = 'parent-session-1';

function thread(over: Partial<SideThread> = {}): SideThread {
  return {
    id: 'st-1',
    title: 'Why is this flaky?',
    threadSessionId: 'fork-abc',
    createdAt: '2026-08-31T00:00:00.000Z',
    ...over,
  };
}

/** A promise whose resolution the test controls, so the OPTIMISTIC window is observable. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  __resetSideThreadsStore();
  vi.clearAllMocks();
  api.listSideThreads.mockResolvedValue({ threads: [], legacy: [] });
  api.prewarmSideThreadStandby.mockResolvedValue({ ok: true });
  api.isForkUnsupportedError.mockReturnValue(false);
  api.archiveSideThread.mockResolvedValue({ archived: true, archivedAt: '2026-09-04T00:00:00.000Z' });
  api.restoreSideThread.mockResolvedValue({ archived: false });
});

describe('side-threads store — fetch / refresh', () => {
  it('populates threads + legacy and counts both on the badge', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread(), thread({ id: 'st-2', threadSessionId: 'fork-def' })],
      legacy: [{ id: 'sq-1', sessionId: PARENT, question: 'q', answer: 'a', createdAt: 'x' }],
    });
    await refreshSideThreads(PARENT);
    const state = getSideThreadsState(PARENT);
    expect(state.threads.map((t) => t.id)).toEqual(['st-1', 'st-2']);
    expect(state.legacy).toHaveLength(1);
    expect(state.loading).toBe(false);
    expect(state.loadedAt).toBeGreaterThan(0);
    expect(sideThreadsBadgeCount(state)).toBe(3);
  });

  it('unknown parent reads an empty state (no throw, stable object)', () => {
    expect(getSideThreadsState('nobody').threads).toEqual([]);
    expect(getSideThreadsState(undefined)).toBe(getSideThreadsState(null));
  });

  it('concurrent refreshes share ONE request (both drawer mounts expand at once)', async () => {
    const d = deferred<SideThreadsResponse>();
    api.listSideThreads.mockReturnValue(d.promise);
    const a = refreshSideThreads(PARENT);
    const b = refreshSideThreads(PARENT);
    expect(api.listSideThreads).toHaveBeenCalledTimes(1);
    d.resolve({ threads: [thread()], legacy: [] });
    await Promise.all([a, b]);
    expect(getSideThreadsState(PARENT).threads).toHaveLength(1);
  });

  it('a failed refresh keeps the previous snapshot and clears loading', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread()], legacy: [] });
    await refreshSideThreads(PARENT);
    api.listSideThreads.mockRejectedValue(new Error('offline'));
    await refreshSideThreads(PARENT);
    const state = getSideThreadsState(PARENT);
    expect(state.threads).toHaveLength(1);
    expect(state.loading).toBe(false);
  });

  it('drops an active thread the server no longer has', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread()], legacy: [] });
    await refreshSideThreads(PARENT);
    setActiveSideThread(PARENT, 'st-1');
    api.listSideThreads.mockResolvedValue({ threads: [], legacy: [] });
    await refreshSideThreads(PARENT);
    expect(getSideThreadsState(PARENT).activeThreadId).toBeNull();
  });

  it('a refresh racing an in-flight create keeps the optimistic row', async () => {
    const create = deferred<{ thread: SideThread }>();
    api.createSideThread.mockReturnValue(create.promise);
    const creating = createSideThreadOptimistic(PARENT, 'why?');
    const pendingId = getSideThreadsState(PARENT).activeThreadId!;
    expect(pendingId.startsWith(PENDING_THREAD_PREFIX)).toBe(true);

    api.listSideThreads.mockResolvedValue({ threads: [], legacy: [] });
    await refreshSideThreads(PARENT);
    expect(getSideThreadsState(PARENT).threads.map((t) => t.id)).toEqual([pendingId]);

    create.resolve({ thread: thread({ id: 'st-real' }) });
    await creating;
    expect(getSideThreadsState(PARENT).threads.map((t) => t.id)).toEqual(['st-real']);
  });

  it('state is isolated per parent session', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread()], legacy: [] });
    await refreshSideThreads(PARENT);
    expect(getSideThreadsState('other-parent').threads).toEqual([]);
  });

  it('notifies subscribers', async () => {
    let notified = 0;
    const unsub = subscribeSideThreads(() => { notified++; });
    await refreshSideThreads(PARENT);
    unsub();
    expect(notified).toBeGreaterThan(0);
    const after = notified;
    await refreshSideThreads(PARENT);
    expect(notified).toBe(after); // unsubscribed
  });
});

describe('side-threads store — optimistic create', () => {
  it('shows a pending chip immediately, then adopts the server record', async () => {
    const d = deferred<{ thread: SideThread }>();
    api.createSideThread.mockReturnValue(d.promise);
    const p = createSideThreadOptimistic(PARENT, '  why is this test flaky?  ');

    const mid = getSideThreadsState(PARENT);
    expect(mid.creating).toBe(true);
    expect(mid.threads).toHaveLength(1);
    expect(mid.threads[0].id.startsWith(PENDING_THREAD_PREFIX)).toBe(true);
    expect(mid.threads[0].title).toBe('why is this test flaky?');
    expect(mid.threads[0].threadSessionId).toBe('');
    expect(mid.activeThreadId).toBe(mid.threads[0].id);
    // The derived label rides along as `title` — the create RESPONSE carries only
    // identity fields, so without this the chip would go label-less. A text-only
    // ask with no composer picks sends NOTHING else: an inherited model/effort is
    // what keeps the fork on the parent's prompt cache.
    expect(api.createSideThread).toHaveBeenCalledWith(
      PARENT, 'why is this test flaky?', { title: 'why is this test flaky?' },
    );

    d.resolve({ thread: thread({ id: 'st-9', threadSessionId: 'fork-9' }) });
    const created = await p;

    const after = getSideThreadsState(PARENT);
    expect(created?.id).toBe('st-9');
    expect(after.creating).toBe(false);
    expect(after.threads.map((t) => t.id)).toEqual(['st-9']);
    expect(after.activeThreadId).toBe('st-9');
    expect(after.threads[0].threadSessionId).toBe('fork-9');
  });

  it('keeps the optimistic label when the create response carries no title', async () => {
    api.createSideThread.mockResolvedValue({
      thread: {
        id: 'st-bare', threadSessionId: 'fork-bare', createdAt: '2026-08-31T00:00:00.000Z',
      },
    });
    const created = await createSideThreadOptimistic(PARENT, 'why is it slow');
    expect(created?.title).toBe('why is it slow');
    expect(sideThreadLabel(getSideThreadsState(PARENT).threads[0])).toBe('why is it slow');
  });

  it('rolls back the pending chip and records the error on failure', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread()], legacy: [] });
    await refreshSideThreads(PARENT);
    setActiveSideThread(PARENT, 'st-1');
    api.createSideThread.mockRejectedValue(new Error('boom'));

    expect(await createSideThreadOptimistic(PARENT, 'nope')).toBeNull();
    const state = getSideThreadsState(PARENT);
    expect(state.threads.map((t) => t.id)).toEqual(['st-1']);
    expect(state.activeThreadId).toBe('st-1'); // restored, not left on a dead id
    expect(state.creating).toBe(false);
    expect(state.error).toBe('boom');
    expect(state.forkUnsupported).toBe(false);
  });

  it('a 409 fork_unsupported sets the flag instead of a raw error string', async () => {
    api.createSideThread.mockRejectedValue(new Error('fork_unsupported'));
    api.isForkUnsupportedError.mockReturnValue(true);
    expect(await createSideThreadOptimistic(PARENT, 'nope')).toBeNull();
    const state = getSideThreadsState(PARENT);
    expect(state.forkUnsupported).toBe(true);
    expect(state.error).toBeNull();
    expect(state.threads).toEqual([]);
  });

  it('re-arms the standby prewarm after a successful create (throttle bypassed)', async () => {
    api.prewarmSideThreadStandby.mockResolvedValue({ ok: true });
    // A prewarm just fired (drawer open) — the throttle would normally suppress
    // the next one. The create must bypass it: it CONSUMED the standby.
    prewarmSideThread(PARENT);
    expect(api.prewarmSideThreadStandby).toHaveBeenCalledTimes(1);

    api.createSideThread.mockResolvedValue({
      thread: thread({ id: 'st-rearm', threadSessionId: 'fork-rearm' }),
    });
    await createSideThreadOptimistic(PARENT, 'consume the standby');
    expect(api.prewarmSideThreadStandby).toHaveBeenCalledTimes(2);
  });

  it('ignores an empty question and a missing parent', async () => {
    expect(await createSideThreadOptimistic(PARENT, '   ')).toBeNull();
    expect(await createSideThreadOptimistic(undefined, 'hi')).toBeNull();
    expect(api.createSideThread).not.toHaveBeenCalled();
  });
});

describe('side-threads store — composer picks ride the create request', () => {
  it('forwards model / effort / output mode, and images, alongside the derived title', async () => {
    api.createSideThread.mockResolvedValue({ thread: thread() });
    const images = [{ data: 'AAA', mediaType: 'image/png' }];
    await createSideThreadOptimistic(PARENT, 'why so slow?', {
      images: images as never,
      model: 'global.anthropic.claude-opus-5[1m]',
      effort: 'high' as never,
      outputMode: 'rich' as never,
    });
    expect(api.createSideThread).toHaveBeenCalledWith(PARENT, 'why so slow?', {
      title: 'why so slow?',
      images,
      model: 'global.anthropic.claude-opus-5[1m]',
      effort: 'high',
      outputMode: 'rich',
    });
  });

  it('omits every pick the user did not make (inheriting is what keeps the cache)', async () => {
    api.createSideThread.mockResolvedValue({ thread: thread() });
    await createSideThreadOptimistic(PARENT, 'plain ask', {});
    expect(api.createSideThread).toHaveBeenCalledWith(PARENT, 'plain ask', { title: 'plain ask' });
  });
});

describe('side-threads store — active switching', () => {
  beforeEach(async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread(), thread({ id: 'st-2', threadSessionId: 'fork-2' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
  });

  it('activates a thread and returns to the "new thread" state with null', () => {
    setActiveSideThread(PARENT, 'st-2');
    expect(getSideThreadsState(PARENT).activeThreadId).toBe('st-2');
    setActiveSideThread(PARENT, null);
    expect(getSideThreadsState(PARENT).activeThreadId).toBeNull();
  });

  it('re-activating the same thread does not notify (no render churn)', () => {
    setActiveSideThread(PARENT, 'st-2');
    let notified = 0;
    const unsub = subscribeSideThreads(() => { notified++; });
    setActiveSideThread(PARENT, 'st-2');
    unsub();
    expect(notified).toBe(0);
  });
});

describe('side-threads store — promote / delete', () => {
  beforeEach(async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread()], legacy: [] });
    await refreshSideThreads(PARENT);
    setActiveSideThread(PARENT, 'st-1');
  });

  it('promote marks the chip optimistically, then adopts the real task id', async () => {
    const d = deferred<{ taskId: string }>();
    api.promoteSideThread.mockReturnValue(d.promise);
    const p = promoteSideThreadOptimistic(PARENT, 'st-1');
    expect(getSideThreadsState(PARENT).threads[0].promotedTaskId).toBe(PENDING_PROMOTE);
    d.resolve({ taskId: 'task-77' });
    await p;
    expect(getSideThreadsState(PARENT).threads[0].promotedTaskId).toBe('task-77');
  });

  it('a failed promote clears the optimistic mark and surfaces the error', async () => {
    api.promoteSideThread.mockRejectedValue(new Error('nope'));
    await promoteSideThreadOptimistic(PARENT, 'st-1');
    const state = getSideThreadsState(PARENT);
    expect(state.threads[0].promotedTaskId).toBeUndefined();
    expect(state.error).toContain('Promote failed');
  });

  it('delete removes the chip and drops the active selection', async () => {
    api.deleteSideThread.mockResolvedValue({ ok: true });
    await deleteSideThreadOptimistic(PARENT, 'st-1');
    const state = getSideThreadsState(PARENT);
    expect(state.threads).toEqual([]);
    expect(state.activeThreadId).toBeNull();
    expect(api.deleteSideThread).toHaveBeenCalledWith(PARENT, 'st-1');
  });

  it('a failed delete restores the row (the thread still exists server-side)', async () => {
    api.deleteSideThread.mockRejectedValue(new Error('offline'));
    await deleteSideThreadOptimistic(PARENT, 'st-1');
    const state = getSideThreadsState(PARENT);
    expect(state.threads.map((t) => t.id)).toEqual(['st-1']);
    expect(state.error).toContain('Delete failed');
  });

  it('deleting a still-pending row never calls the server', async () => {
    const d = deferred<{ thread: SideThread }>();
    api.createSideThread.mockReturnValue(d.promise);
    void createSideThreadOptimistic(PARENT, 'pending one');
    const pendingId = getSideThreadsState(PARENT).activeThreadId!;
    await deleteSideThreadOptimistic(PARENT, pendingId);
    expect(api.deleteSideThread).not.toHaveBeenCalled();
    expect(getSideThreadsState(PARENT).threads.map((t) => t.id)).toEqual(['st-1']);
    d.resolve({ thread: thread({ id: 'st-late' }) });
  });
});

describe('side-threads store — standby prewarm', () => {
  it('throttles a burst down to one spawn and never rejects', async () => {
    api.prewarmSideThreadStandby.mockRejectedValue(new Error('no standby'));
    prewarmSideThread(PARENT);
    prewarmSideThread(PARENT);
    prewarmSideThread(PARENT);
    expect(api.prewarmSideThreadStandby).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    // A rejected prewarm must not touch UI state.
    expect(getSideThreadsState(PARENT).error).toBeNull();
  });

  it('is a no-op without a parent session', () => {
    prewarmSideThread(undefined);
    expect(api.prewarmSideThreadStandby).not.toHaveBeenCalled();
  });
});

describe('side-threads store — single open drawer', () => {
  it('a second instance claiming open evicts the first', () => {
    expect(getOpenDrawerInstance()).toBeNull();
    setOpenDrawerInstance('mount-a');
    expect(getOpenDrawerInstance()).toBe('mount-a');
    setOpenDrawerInstance('mount-b');
    expect(getOpenDrawerInstance()).toBe('mount-b');
    setOpenDrawerInstance(null);
    expect(getOpenDrawerInstance()).toBeNull();
  });

  it('re-claiming by the same instance does not notify', () => {
    setOpenDrawerInstance('mount-a');
    let notified = 0;
    const unsub = subscribeSideThreads(() => { notified++; });
    setOpenDrawerInstance('mount-a');
    unsub();
    expect(notified).toBe(0);
  });
});

describe('formatSideThreadDigestForComposer', () => {
  it('labels the text as a SUMMARY, not the aside itself', () => {
    // The receiving session must be able to tell second-hand text from the real
    // transcript — it acts on this without ever seeing the thread.
    expect(formatSideThreadDigestForComposer('why is it flaky', '  RETRY_MS races the clock.  '))
      .toBe('[Summary of side thread "why is it flaky"]\nRETRY_MS races the clock.\n\n');
  });
});

describe('formatSideThreadForComposer', () => {
  /** What the browser tier cannot assert: the mock CLI writes no user lines, so a
   *  fixture thread's history has no Q rows. The format lives here instead. */
  it('renders the header, then Q/A lines in transcript order', () => {
    const text = formatSideThreadForComposer('why is it flaky', [
      { role: 'user', text: 'why is it flaky' },
      { role: 'assistant', text: 'the retry races the clock' },
      { role: 'user', text: 'and what changes it' },
      { role: 'assistant', text: 'RETRY_MS' },
    ]);
    expect(text).toBe([
      '[From side thread "why is it flaky"]',
      'Q: why is it flaky',
      'A: the retry races the clock',
      'Q: and what changes it',
      'A: RETRY_MS',
      '',
      '',
    ].join('\n'));
  });

  it('skips system rows, CLI-injected user rows, and empty text', () => {
    const text = formatSideThreadForComposer('t', [
      { role: 'system', text: 'compact boundary' },
      { role: 'user', text: 'skill dump', injected: true },
      { role: 'assistant', text: '   ' },
      { role: 'assistant', text: 'kept' },
    ]);
    expect(text).toBe('[From side thread "t"]\nA: kept\n\n');
  });

  it('ends with a blank line so the user types on a fresh paragraph', () => {
    expect(formatSideThreadForComposer('t', [])).toBe('[From side thread "t"]\n\n');
  });

  /** The digest REQUEST is hidden in history but its reply is not, so a thread that
   *  was summarized once would otherwise paste that summary back as an `A:` row with
   *  no `Q:` above it — the main session reading the aside as answered twice. */
  it('skips a summary this thread wrote for the main session earlier', () => {
    const text = formatSideThreadForComposer('t', [
      { role: 'user', text: 'why is it flaky' },
      { role: 'assistant', text: 'the retry races the clock' },
      { role: 'assistant', text: `${SIDE_THREAD_DIGEST_MARKER} the retry races the clock.` },
    ]);
    expect(text).toBe('[From side thread "t"]\nQ: why is it flaky\nA: the retry races the clock\n\n');
  });
});

describe('sideThreadLabel', () => {
  it('prefers the stored title', () => {
    expect(sideThreadLabel(thread({ title: 'Flaky test', question: 'why?' }))).toBe('Flaky test');
  });

  it('falls back to the question when the server row has no title', () => {
    expect(sideThreadLabel({
      id: 'st-x', threadSessionId: 'fork-x', createdAt: 'x', question: 'why is it flaky',
    })).toBe('why is it flaky');
  });

  it('never renders an empty chip', () => {
    expect(sideThreadLabel({ id: 'st-x', threadSessionId: 'fork-x', createdAt: 'x' }))
      .toBe('Side thread');
  });
});

describe('deriveThreadTitle', () => {
  it('collapses whitespace and keeps short questions verbatim', () => {
    expect(deriveThreadTitle('  why   is  it   flaky? ')).toBe('why is it flaky?');
  });

  it('truncates long questions at a word boundary with an ellipsis', () => {
    const title = deriveThreadTitle('explain in detail why the retry path enqueues the same message twice');
    expect(title.length).toBeLessThanOrEqual(49);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/ …$/);
  });

  it('never produces an empty label', () => {
    expect(deriveThreadTitle('   ')).toBe('Side thread');
  });
});

/**
 * The acceptance rule for "inject summary". This is where the feature's safety
 * lives, so it is pinned here rather than through the browser: the fixture CLI can
 * only echo, so it cannot produce a marker unique to the digest turn, and the two
 * live bugs this rule exists for (a read that beat the transcript flush; a turn that
 * was already running ending first) are both invisible at that level.
 */
describe('pickSideThreadDigestReply', () => {
  const MARKER = 'Summary for the main session:';
  const before = { id: 'm1', text: 'the previous answer' };

  it('accepts the marked reply and strips the marker line', () => {
    expect(pickSideThreadDigestReply(MARKER, before, {
      id: 'm2', text: `${MARKER}\n\n  RETRY_MS races the clock.  `,
    })).toBe('RETRY_MS races the clock.');
  });

  it('refuses a reply that does not carry the marker (the wrong-paste bug)', () => {
    expect(pickSideThreadDigestReply(MARKER, before, {
      id: 'm2', text: 'FIFOs are unidirectional; sockets are not.',
    })).toBeUndefined();
  });

  it('refuses the marked summary of an EARLIER digest (same message as before)', () => {
    const stale = { id: 'm1', text: `${MARKER} the older summary` };
    expect(pickSideThreadDigestReply(MARKER, stale, stale)).toBeUndefined();
  });

  it('tolerates markdown/HTML decoration around the marker', () => {
    expect(pickSideThreadDigestReply(MARKER, before, {
      id: 'm2', text: `<p><strong>${MARKER}</strong> it was the retry path.`,
    })).toBe('</strong> it was the retry path.');
    expect(pickSideThreadDigestReply(MARKER, before, {
      id: 'm2', text: `## ${MARKER}\nit was the retry path.`,
    })).toBe('it was the retry path.');
  });

  it('refuses a reply that says something of its own before the marker', () => {
    expect(pickSideThreadDigestReply(MARKER, before, {
      id: 'm2', text: `I looked into the flake and here is what I found. ${MARKER} the retry path.`,
    })).toBeUndefined();
  });

  it('refuses when the server sent no marker, and when the body is empty', () => {
    expect(pickSideThreadDigestReply('', before, { id: 'm2', text: 'anything' })).toBeUndefined();
    expect(pickSideThreadDigestReply(MARKER, before, { id: 'm2', text: MARKER })).toBeUndefined();
  });
});

describe('readSideThreadDigest', () => {
  const MARKER = 'Summary for the main session:';
  const before = { id: 'm1', text: 'previous answer' };
  /** Injected clock: `waitTick` is what advances it, so no test waits real time. */
  const fakeClock = (stepMs: number) => {
    let t = 0;
    return { now: () => t, tick: async () => { t += stepMs; } };
  };

  it('returns the summary as soon as a marked reply appears', async () => {
    const clock = fakeClock(800);
    const readLast = vi.fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ id: 'm2', text: `${MARKER} it was the retry path.` });
    const res = await readSideThreadDigest(MARKER, before, {
      readLast, waitTick: clock.tick, now: clock.now, timeoutMs: 90_000,
    });
    expect(res).toEqual({ ok: true, summary: 'it was the retry path.' });
    expect(readLast).toHaveBeenCalledTimes(2);
  });

  it('survives a failed read instead of ending the whole attempt', async () => {
    const clock = fakeClock(800);
    const readLast = vi.fn()
      .mockRejectedValueOnce(new Error('503 mid-flush'))
      .mockResolvedValueOnce({ id: 'm2', text: `${MARKER} landed anyway.` });
    const res = await readSideThreadDigest(MARKER, before, {
      readLast, waitTick: clock.tick, now: clock.now, timeoutMs: 90_000,
    });
    expect(res).toEqual({ ok: true, summary: 'landed anyway.' });
  });

  it('times out (never guesses) when only the old answer is ever there', async () => {
    const clock = fakeClock(1_000);
    const readLast = vi.fn().mockResolvedValue(before);
    const res = await readSideThreadDigest(MARKER, before, {
      readLast, waitTick: clock.tick, now: clock.now, timeoutMs: 5_000,
    });
    expect(res).toEqual({ ok: false, reason: 'timeout' });
    expect(readLast).toHaveBeenCalledTimes(5);
  });

  it('stops the moment the caller moves on (thread switch / unmount)', async () => {
    const clock = fakeClock(800);
    let cancelled = false;
    const readLast = vi.fn().mockImplementation(async () => { cancelled = true; return before; });
    const res = await readSideThreadDigest(MARKER, before, {
      readLast, waitTick: clock.tick, now: clock.now, timeoutMs: 90_000,
      cancelled: () => cancelled,
    });
    expect(res).toEqual({ ok: false, reason: 'cancelled' });
    expect(readLast).toHaveBeenCalledTimes(1);
  });
});

describe('SIDE_THREAD_DIGEST_MARKER', () => {
  it('is the exact line the SERVER prompt demands (drift would refuse every summary)', async () => {
    const { SIDE_THREAD_DIGEST_REPLY_MARKER, SIDE_THREAD_DIGEST_MESSAGE } =
      await import('../../src/core/sessions/side-thread-digest.js');
    expect(SIDE_THREAD_DIGEST_MARKER).toBe(SIDE_THREAD_DIGEST_REPLY_MARKER);
    expect(SIDE_THREAD_DIGEST_MESSAGE).toContain(SIDE_THREAD_DIGEST_MARKER);
  });
});

describe('side-threads store — archive (file away, never delete)', () => {
  /**
   * Archiving is the answer to a chip row that grew past what fits: the row must
   * SURVIVE (the thread is still retrievable), only its place in the UI changes.
   * These tests pin exactly that split — the delete path drops the row, this one
   * moves a stamp — plus the two things a browser spec cannot observe: the
   * optimistic window and the rollback.
   */
  async function seedTwo() {
    api.listSideThreads.mockResolvedValue({
      threads: [thread(), thread({ id: 'st-2', threadSessionId: 'fork-def', title: 'Second' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
  }

  it('splits the list: chips show live threads, the shelf shows filed ones', async () => {
    await seedTwo();
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    const state = getSideThreadsState(PARENT);
    // The row is still there — that is the whole point.
    expect(state.threads).toHaveLength(2);
    expect(activeSideThreads(state).map((t) => t.id)).toEqual(['st-2']);
    expect(archivedSideThreads(state).map((t) => t.id)).toEqual(['st-1']);
    expect(api.archiveSideThread).toHaveBeenCalledWith(PARENT, 'st-1');
    expect(api.deleteSideThread).not.toHaveBeenCalled();
  });

  it('the shelf reads newest-filed first (you look for what you just tidied away)', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [
        thread({ id: 'old', archivedAt: '2026-09-01T00:00:00.000Z' }),
        thread({ id: 'new', archivedAt: '2026-09-03T00:00:00.000Z' }),
        thread({ id: 'live' }),
      ],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    const state = getSideThreadsState(PARENT);
    expect(archivedSideThreads(state).map((t) => t.id)).toEqual(['new', 'old']);
    expect(activeSideThreads(state).map((t) => t.id)).toEqual(['live']);
  });

  it('filing the thread you are looking at deselects it (a filed thread must not stay mounted)', async () => {
    await seedTwo();
    setActiveSideThread(PARENT, 'st-1');
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(getSideThreadsState(PARENT).activeThreadId).toBeNull();
  });

  it('filing a DIFFERENT thread leaves your selection alone', async () => {
    await seedTwo();
    setActiveSideThread(PARENT, 'st-2');
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(getSideThreadsState(PARENT).activeThreadId).toBe('st-2');
  });

  it('is optimistic: the chip leaves the row before the server answers', async () => {
    await seedTwo();
    const d = deferred<{ archived: true; archivedAt: string }>();
    api.archiveSideThread.mockReturnValue(d.promise);
    const pending = setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(activeSideThreads(getSideThreadsState(PARENT)).map((t) => t.id)).toEqual(['st-2']);
    d.resolve({ archived: true, archivedAt: '2026-09-04T00:00:00.000Z' });
    await pending;
    expect(archivedSideThreads(getSideThreadsState(PARENT))).toHaveLength(1);
  });

  it('a failed archive puts the chip BACK and surfaces the error', async () => {
    await seedTwo();
    api.archiveSideThread.mockRejectedValue(new Error('offline'));
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    const state = getSideThreadsState(PARENT);
    expect(activeSideThreads(state).map((t) => t.id)).toEqual(['st-1', 'st-2']);
    expect(archivedSideThreads(state)).toEqual([]);
    expect(state.error).toContain('Archive failed');
  });

  it('restore brings it back into the chip row', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    const state = getSideThreadsState(PARENT);
    expect(activeSideThreads(state).map((t) => t.id)).toEqual(['st-1']);
    expect(archivedSideThreads(state)).toEqual([]);
    expect(api.restoreSideThread).toHaveBeenCalledWith(PARENT, 'st-1');
  });

  it('a failed restore re-files it (with its ORIGINAL stamp, so shelf order is stable)', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    api.restoreSideThread.mockRejectedValue(new Error('boom'));
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    const state = getSideThreadsState(PARENT);
    expect(state.threads[0]?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(state.error).toContain('Restore failed');
  });

  it('re-archiving an already-filed thread keeps the FIRST stamp (idempotent, like the server)', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(getSideThreadsState(PARENT).threads[0]?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a pending (not-yet-created) row cannot be filed — there is nothing to file yet', async () => {
    const d = deferred<{ thread: SideThread }>();
    api.createSideThread.mockReturnValue(d.promise);
    const creating = createSideThreadOptimistic(PARENT, 'brand new question');
    const pendingId = getSideThreadsState(PARENT).threads[0]!.id;
    expect(pendingId.startsWith(PENDING_THREAD_PREFIX)).toBe(true);
    await setSideThreadArchivedOptimistic(PARENT, pendingId, true);
    expect(api.archiveSideThread).not.toHaveBeenCalled();
    expect(getSideThreadsState(PARENT).threads[0]?.archivedAt).toBeUndefined();
    d.resolve({ thread: thread() });
    await creating;
  });

  it('a filed thread is read-only the INSTANT it is filed, before any refresh', async () => {
    // The optimistic path only knows `archivedAt`; the record's `archived` flag
    // arrives with the next list. Keying the composer lock on the record alone left
    // a filed thread accepting a follow-up into a process that was just retired.
    await seedTwo();
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    const filed = getSideThreadsState(PARENT).threads.find((t) => t.id === 'st-1');
    expect(filed?.archivedAt).toBeTruthy();
    expect(isSideThreadReadOnly(filed)).toBe(true);
  });

  it('read-only also covers a record the reaper archived without the user filing it', () => {
    expect(isSideThreadReadOnly(thread({ archived: true }))).toBe(true);
    expect(isSideThreadReadOnly(thread())).toBe(false);
    expect(isSideThreadReadOnly(null)).toBe(false);
  });

  it('the btw pill count DROPS when you file one away', async () => {
    await seedTwo();
    expect(sideThreadsBadgeCount(getSideThreadsState(PARENT))).toBe(2);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(sideThreadsBadgeCount(getSideThreadsState(PARENT))).toBe(1);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    expect(sideThreadsBadgeCount(getSideThreadsState(PARENT))).toBe(2);
  });

  it('files BOTH flags, so a restore is not fought by a stale record flag', async () => {
    // The list returns a record-level `archived` too. Tracking only the stamp meant a
    // restore put the chip back while the composer stayed locked and the actions slot
    // had already flipped to "Archive" — no way out without reopening the drawer.
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z', archived: true })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    const row = getSideThreadsState(PARENT).threads[0];
    expect(row?.archivedAt).toBeUndefined();
    expect(row?.archived).toBe(false);
    expect(isSideThreadReadOnly(row)).toBe(false);
  });

  it('believes the SERVER about the session state, and a restore it refused stays FAILED', async () => {
    // Un-archiving the record can fail server-side (the session row is gone). Clearing
    // the stamp anyway moved the row into the live chip row with a locked composer, an
    // action slot offering "Archive" again and no ↺ anywhere — a dead end that survives
    // a refresh. It stays on the shelf, where the retry and the reason both live.
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z', archived: true })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    api.restoreSideThread.mockResolvedValue({ archived: true });
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    const state = getSideThreadsState(PARENT);
    const row = state.threads[0];
    expect(row?.archivedAt).toBe('2026-09-01T00:00:00.000Z');
    expect(isSideThreadReadOnly(row)).toBe(true);
    expect(archivedSideThreads(state).map((t) => t.id)).toEqual(['st-1']);
    expect(state.error).toMatch(/Restore failed/);
  });

  it('filing a PROMOTED thread does not claim its process died (the server keeps it)', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ promotedTaskId: 'task-1' })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    expect(getSideThreadsState(PARENT).threads[0]?.archived).toBeUndefined();
  });

  it('a refresh landing mid-archive keeps the row filed', async () => {
    // The archive POST awaits a bounded process terminate, and either drawer mount can
    // refresh inside that window. Taking the server's pre-request answer put the chip
    // back in the live row with an unlocked composer.
    await seedTwo();
    const d = deferred<{ archived: true; archivedAt: string }>();
    api.archiveSideThread.mockReturnValue(d.promise);
    const pending = setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    await refreshSideThreads(PARENT);
    expect(activeSideThreads(getSideThreadsState(PARENT)).map((t) => t.id)).toEqual(['st-2']);
    d.resolve({ archived: true, archivedAt: '2026-09-04T00:00:00.000Z' });
    await pending;
    expect(archivedSideThreads(getSideThreadsState(PARENT)).map((t) => t.id)).toEqual(['st-1']);
  });

  it('a refresh landing mid-restore keeps the row live', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z', archived: true })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    const d = deferred<{ archived: boolean }>();
    api.restoreSideThread.mockReturnValue(d.promise);
    const pending = setSideThreadArchivedOptimistic(PARENT, 'st-1', false);
    await refreshSideThreads(PARENT);
    expect(activeSideThreads(getSideThreadsState(PARENT)).map((t) => t.id)).toEqual(['st-1']);
    d.resolve({ archived: false });
    await pending;
    expect(archivedSideThreads(getSideThreadsState(PARENT))).toEqual([]);
  });

  it('a failed archive puts your SELECTION back, not just the chip', async () => {
    await seedTwo();
    setActiveSideThread(PARENT, 'st-1');
    api.archiveSideThread.mockRejectedValue(new Error('offline'));
    await setSideThreadArchivedOptimistic(PARENT, 'st-1', true);
    // A refused archive must not silently close the conversation being read.
    expect(getSideThreadsState(PARENT).activeThreadId).toBe('st-1');
  });

  it('promote un-files the row, because the server un-files it too', async () => {
    api.listSideThreads.mockResolvedValue({
      threads: [thread({ archivedAt: '2026-09-01T00:00:00.000Z', archived: true })],
      legacy: [],
    });
    await refreshSideThreads(PARENT);
    api.promoteSideThread.mockResolvedValue({ taskId: 'task-7' });
    await promoteSideThreadOptimistic(PARENT, 'st-1');
    const state = getSideThreadsState(PARENT);
    expect(archivedSideThreads(state)).toEqual([]);
    expect(activeSideThreads(state).map((t) => t.id)).toEqual(['st-1']);
    expect(isSideThreadReadOnly(state.threads[0])).toBe(false);
  });

  it('an unknown thread id is a no-op (a stale second tab must not throw)', async () => {
    await seedTwo();
    await setSideThreadArchivedOptimistic(PARENT, 'st-nope', true);
    expect(api.archiveSideThread).not.toHaveBeenCalled();
    expect(getSideThreadsState(PARENT).threads).toHaveLength(2);
  });
});

describe('side-threads store — auto-generated title', () => {
  it('patches the chip label when the server announces the generated title', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread({ title: 'why is this fla…' })], legacy: [] });
    await refreshSideThreads(PARENT);
    applySideThreadTitle(PARENT, 'st-1', 'Flaky retry timeout');
    expect(sideThreadLabel(getSideThreadsState(PARENT).threads[0]!)).toBe('Flaky retry timeout');
  });

  it('ignores an unknown thread, an unchanged title, and a missing parent', async () => {
    api.listSideThreads.mockResolvedValue({ threads: [thread({ title: 'Kept' })], legacy: [] });
    await refreshSideThreads(PARENT);
    const before = getSideThreadsState(PARENT);
    applySideThreadTitle(PARENT, 'st-nope', 'Other');
    applySideThreadTitle(PARENT, 'st-1', 'Kept');
    applySideThreadTitle(undefined, 'st-1', 'Other');
    // Same object identity: no notify, so no re-render of every drawer mount.
    expect(getSideThreadsState(PARENT)).toBe(before);
  });
});
