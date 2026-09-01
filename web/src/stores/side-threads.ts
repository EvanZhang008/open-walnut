/**
 * Side-threads module store — the shared state behind the "btw" drawer.
 *
 * WHY a module store and not component state: SideQuestionDrawer is mounted TWICE
 * inside one SessionPanel (the main composer's mode bar AND the plan popover's),
 * so per-component `useState` would give the same session two divergent thread
 * lists and two "active thread" answers. One module-level map keyed by PARENT
 * session id keeps every mount looking at the same truth.
 *
 * The server file is the source of truth (no localStorage persistence): the drawer
 * refetches on open. Creates are optimistic (a `pending-…` row + chip appears the
 * moment the user hits Enter) because the fork spawn can take a beat, and the
 * answer streams in afterwards regardless.
 *
 * Also owns the app-wide "which drawer instance is open" claim, so the two mounts
 * can never both render the popover — and therefore never mount two
 * `useSessionStream` subscriptions for one thread session id (documented bug,
 * SessionPanel.tsx:195-199).
 */

import {
  listSideThreads,
  createSideThread as apiCreateSideThread,
  promoteSideThread as apiPromoteSideThread,
  deleteSideThread as apiDeleteSideThread,
  prewarmSideThreadStandby,
  isForkUnsupportedError,
  type SideThread,
} from '@/api/sideThreads';
import type { SideQuestion } from '@/api/sideQuestions';
import { log } from '@/utils/log';

/** Sentinel promotedTaskId while the real id is still on its way. */
export const PENDING_PROMOTE = '__pending__';
/** Prefix of an optimistic (not-yet-confirmed) thread id. */
export const PENDING_THREAD_PREFIX = 'pending-';

export interface SideThreadsState {
  threads: SideThread[];
  /** Pre-thread one-shot Q&A entries — rendered read-only. */
  legacy: SideQuestion[];
  /** null = show the "new thread" empty composer. */
  activeThreadId: string | null;
  loading: boolean;
  creating: boolean;
  error: string | null;
  /** Parent engine can't fork (server 409) — the drawer shows an inline notice. */
  forkUnsupported: boolean;
  /** Date.now() of the last successful list fetch (0 = never). */
  loadedAt: number;
}

const EMPTY_STATE: SideThreadsState = {
  threads: [],
  legacy: [],
  activeThreadId: null,
  loading: false,
  creating: false,
  error: null,
  forkUnsupported: false,
  loadedAt: 0,
};

const byParent = new Map<string, SideThreadsState>();
const listeners = new Set<() => void>();
const inflightList = new Map<string, Promise<void>>();
const lastPrewarmAt = new Map<string, number>();
let pendingSeq = 0;

/** Only ONE drawer instance may be open app-wide (see file header). */
let openInstanceId: string | null = null;

const PREWARM_THROTTLE_MS = 1_500;

function notify(): void {
  for (const l of listeners) l();
}

function read(parentSessionId: string): SideThreadsState {
  return byParent.get(parentSessionId) ?? EMPTY_STATE;
}

function patch(parentSessionId: string, next: Partial<SideThreadsState>): void {
  byParent.set(parentSessionId, { ...read(parentSessionId), ...next });
  notify();
}

// ── React glue (useSyncExternalStore) ────────────────────────────────────────

/** Stable snapshot — the same object identity until something actually changes. */
export function getSideThreadsState(parentSessionId: string | null | undefined): SideThreadsState {
  if (!parentSessionId) return EMPTY_STATE;
  return read(parentSessionId);
}

export function subscribeSideThreads(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getOpenDrawerInstance(): string | null {
  return openInstanceId;
}

/** Claim (or release, with null) the single app-wide open drawer. */
export function setOpenDrawerInstance(instanceId: string | null): void {
  if (openInstanceId === instanceId) return;
  openInstanceId = instanceId;
  notify();
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Total shown on the pill: live threads + legacy one-shot entries. */
export function sideThreadsBadgeCount(state: SideThreadsState): number {
  return state.threads.length + state.legacy.length;
}

export function findSideThread(state: SideThreadsState, threadId: string | null): SideThread | null {
  if (!threadId) return null;
  return state.threads.find((t) => t.id === threadId) ?? null;
}

/** Chip-sized label from a question. Also what we SEND as the thread's `title`,
 *  so the server record carries the same label the chip shows. */
export function deriveThreadTitle(question: string): string {
  const one = question.replace(/\s+/g, ' ').trim();
  if (one.length <= 48) return one || 'Side thread';
  const cut = one.slice(0, 48);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** The label to render for a thread: its stored title, else its question.
 *  `title` is OPTIONAL server-side, so never render `thread.title` directly. */
export function sideThreadLabel(thread: SideThread): string {
  const stored = thread.title?.trim();
  if (stored) return stored;
  return deriveThreadTitle(thread.question ?? '');
}

/**
 * "Inject to chat" text: a thread's transcript flattened into something the user
 * can edit and send from the MAIN composer.
 *
 * TEXT parts only — a side thread's value is its conclusion, and pasting its tool
 * calls, thinking, and CLI system rows into the main conversation would spend the
 * context the thread exists to protect. Trailing blank line so the user's own
 * words start on a fresh paragraph.
 *
 * Pure + exported so the format is pinned by unit tests: the browser tier cannot
 * cover it (the mock CLI writes no user lines, so a fixture thread has no Q rows).
 */
export function formatSideThreadForComposer(
  label: string,
  messages: Array<{ role: 'user' | 'assistant' | 'system'; text?: string; injected?: boolean }>,
): string {
  const lines: string[] = [`[From side thread "${label}"]`];
  for (const m of messages) {
    // `injected` = a CLI-inserted user line (skill dumps, compaction summaries),
    // never something the human asked.
    if (m.injected || m.role === 'system') continue;
    const text = (m.text ?? '').trim();
    if (!text) continue;
    lines.push(`${m.role === 'user' ? 'Q' : 'A'}: ${text}`);
  }
  return `${lines.join('\n')}\n\n`;
}

// ── Writes ───────────────────────────────────────────────────────────────────

/**
 * Refresh the thread list from the server. Concurrent callers share one request
 * (both drawer mounts expand-refresh at once). A failure keeps the previous
 * snapshot — a stale chip row beats an empty drawer.
 */
export function refreshSideThreads(parentSessionId: string | undefined): Promise<void> {
  if (!parentSessionId) return Promise.resolve();
  const existing = inflightList.get(parentSessionId);
  if (existing) return existing;

  patch(parentSessionId, { loading: true });
  const req = listSideThreads(parentSessionId)
    .then((res) => {
      const cur = read(parentSessionId);
      const serverThreads = res.threads ?? [];
      const serverIds = new Set(serverThreads.map((t) => t.id));
      // Keep optimistic rows the server hasn't acknowledged yet: a refresh racing
      // an in-flight create must not make the user's brand-new chip blink away.
      const stillPending = cur.threads.filter(
        (t) => t.id.startsWith(PENDING_THREAD_PREFIX) && !serverIds.has(t.id),
      );
      const threads = [...serverThreads, ...stillPending];
      const activeStillThere = cur.activeThreadId
        && threads.some((t) => t.id === cur.activeThreadId);
      patch(parentSessionId, {
        threads,
        legacy: res.legacy ?? [],
        activeThreadId: activeStillThere ? cur.activeThreadId : null,
        loading: false,
        loadedAt: Date.now(),
      });
    })
    .catch((err) => {
      patch(parentSessionId, { loading: false });
      log.warn('sideThreads', 'list failed (keeping previous snapshot)', {
        sessionId: parentSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => { inflightList.delete(parentSessionId); });

  inflightList.set(parentSessionId, req);
  return req;
}

/**
 * Prewarm a standby fork. Deliberately fire-and-forget + throttled: this is a
 * latency optimisation, so it must never block, never surface an error, and
 * never fan out when the user re-clicks "+ New".
 */
export function prewarmSideThread(parentSessionId: string | undefined): void {
  if (!parentSessionId) return;
  const now = Date.now();
  const last = lastPrewarmAt.get(parentSessionId) ?? 0;
  if (now - last < PREWARM_THROTTLE_MS) return;
  lastPrewarmAt.set(parentSessionId, now);
  prewarmSideThreadStandby(parentSessionId).catch((err) => {
    log.warn('sideThreads', 'standby prewarm failed (ignored)', {
      sessionId: parentSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

export function setActiveSideThread(parentSessionId: string | undefined, threadId: string | null): void {
  if (!parentSessionId) return;
  if (read(parentSessionId).activeThreadId === threadId) return;
  patch(parentSessionId, { activeThreadId: threadId, error: null });
}

export function setSideThreadsError(parentSessionId: string | undefined, message: string): void {
  if (!parentSessionId) return;
  patch(parentSessionId, { error: message });
}

export function clearSideThreadsError(parentSessionId: string | undefined): void {
  if (!parentSessionId) return;
  const cur = read(parentSessionId);
  if (!cur.error && !cur.forkUnsupported) return;
  patch(parentSessionId, { error: null, forkUnsupported: false });
}

/**
 * Open a new thread with its first question. Optimistic: the chip + active body
 * appear immediately, then the row is replaced by the server's record (which
 * carries the real threadSessionId the transcript renders from).
 */
export async function createSideThreadOptimistic(
  parentSessionId: string | undefined,
  question: string,
): Promise<SideThread | null> {
  const q = question.trim();
  if (!parentSessionId || !q) return null;

  const previousActive = read(parentSessionId).activeThreadId;
  const tempId = `${PENDING_THREAD_PREFIX}${++pendingSeq}`;
  const label = deriveThreadTitle(q);
  const placeholder: SideThread = {
    id: tempId,
    title: label,
    question: q,
    threadSessionId: '',
    createdAt: new Date().toISOString(),
  };
  patch(parentSessionId, {
    threads: [...read(parentSessionId).threads, placeholder],
    activeThreadId: tempId,
    creating: true,
    error: null,
    forkUnsupported: false,
  });
  log.info('sideThreads', 'creating thread', { sessionId: parentSessionId, questionLen: q.length });

  try {
    // Send the derived label as `title` so the server row carries it too (the
    // create response returns identity fields only, no `question`), and keep the
    // optimistic label/question if an older server echoes neither back.
    const { thread } = await apiCreateSideThread(parentSessionId, q, label);
    const adopted: SideThread = {
      ...thread,
      title: thread.title ?? label,
      question: thread.question ?? q,
    };
    const cur = read(parentSessionId);
    patch(parentSessionId, {
      threads: cur.threads.map((t) => (t.id === tempId ? adopted : t)),
      activeThreadId: cur.activeThreadId === tempId ? thread.id : cur.activeThreadId,
      creating: false,
    });
    log.info('sideThreads', 'thread created', {
      sessionId: parentSessionId, threadId: thread.id, threadSessionId: thread.threadSessionId,
    });
    // The create consumed (or bypassed) the standby, so the next ask would be
    // cold — re-arm one now. Throttle bypassed: this trigger means the standby
    // is definitively gone, unlike a re-clicked "+ New".
    lastPrewarmAt.delete(parentSessionId);
    prewarmSideThread(parentSessionId);
    return adopted;
  } catch (err) {
    const cur = read(parentSessionId);
    const forkUnsupported = isForkUnsupportedError(err);
    const msg = err instanceof Error ? err.message : String(err);
    patch(parentSessionId, {
      threads: cur.threads.filter((t) => t.id !== tempId),
      activeThreadId: cur.activeThreadId === tempId ? previousActive : cur.activeThreadId,
      creating: false,
      forkUnsupported,
      error: forkUnsupported ? null : msg,
    });
    log.warn('sideThreads', 'create failed', { sessionId: parentSessionId, error: msg, forkUnsupported });
    return null;
  }
}

/** Promote a thread into a task. Optimistic ✓ badge, reconciled in the background. */
export async function promoteSideThreadOptimistic(
  parentSessionId: string | undefined,
  threadId: string,
): Promise<void> {
  if (!parentSessionId) return;
  const mark = (id: string, promotedTaskId: string | undefined) => {
    const cur = read(parentSessionId);
    patch(parentSessionId, {
      threads: cur.threads.map((t) => (t.id === id ? { ...t, promotedTaskId } : t)),
    });
  };
  mark(threadId, PENDING_PROMOTE);
  try {
    const { taskId } = await apiPromoteSideThread(parentSessionId, threadId);
    mark(threadId, taskId);
  } catch (err) {
    const cur = read(parentSessionId);
    const msg = err instanceof Error ? err.message : String(err);
    patch(parentSessionId, {
      threads: cur.threads.map((t) => (
        t.id === threadId && t.promotedTaskId === PENDING_PROMOTE
          ? { ...t, promotedTaskId: undefined }
          : t
      )),
      error: `Promote failed: ${msg}`,
    });
    log.warn('sideThreads', 'promote failed', { sessionId: parentSessionId, threadId, error: msg });
  }
}

/** Delete a thread. Optimistic removal; the active thread falls back to none. */
export async function deleteSideThreadOptimistic(
  parentSessionId: string | undefined,
  threadId: string,
): Promise<void> {
  if (!parentSessionId) return;
  const cur = read(parentSessionId);
  const removed = cur.threads.find((t) => t.id === threadId);
  patch(parentSessionId, {
    threads: cur.threads.filter((t) => t.id !== threadId),
    activeThreadId: cur.activeThreadId === threadId ? null : cur.activeThreadId,
  });
  if (!removed || threadId.startsWith(PENDING_THREAD_PREFIX)) return;
  try {
    await apiDeleteSideThread(parentSessionId, threadId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('sideThreads', 'delete failed (restoring row)', {
      sessionId: parentSessionId, threadId, error: msg,
    });
    // Put it back rather than silently pretending it's gone — the thread session
    // still exists server-side and would reappear on the next refresh anyway.
    patch(parentSessionId, {
      threads: [...read(parentSessionId).threads, removed]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      error: `Delete failed: ${msg}`,
    });
  }
}

/** Apply a legacy (one-shot) entry list update — used after a legacy promote. */
export function updateLegacySideQuestions(
  parentSessionId: string | undefined,
  updater: (legacy: SideQuestion[]) => SideQuestion[],
): void {
  if (!parentSessionId) return;
  patch(parentSessionId, { legacy: updater(read(parentSessionId).legacy) });
}

/** Test-only reset. */
export function __resetSideThreadsStore(): void {
  byParent.clear();
  inflightList.clear();
  lastPrewarmAt.clear();
  openInstanceId = null;
  pendingSeq = 0;
  notify();
}
