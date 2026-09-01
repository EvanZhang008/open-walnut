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
  createSideThread: vi.fn<(sid: string, q: string, title?: string) => Promise<{ thread: SideThread }>>(),
  promoteSideThread: vi.fn<(sid: string, tid: string) => Promise<{ taskId: string; parentTaskId?: string }>>(),
  deleteSideThread: vi.fn<(sid: string, tid: string) => Promise<{ ok: true }>>(),
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
  formatSideThreadForComposer,
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
    // identity fields, so without this the chip would go label-less.
    expect(api.createSideThread).toHaveBeenCalledWith(
      PARENT, 'why is this test flaky?', 'why is this test flaky?',
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
