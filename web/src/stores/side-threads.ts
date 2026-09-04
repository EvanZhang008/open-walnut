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
  warmSideThreadStandby,
  promoteSideThread as apiPromoteSideThread,
  deleteSideThread as apiDeleteSideThread,
  archiveSideThread as apiArchiveSideThread,
  restoreSideThread as apiRestoreSideThread,
  prewarmSideThreadStandby,
  isForkUnsupportedError,
  type SideThread,
} from '@/api/sideThreads';
import type { SessionEffort, SessionOutputMode } from '@open-walnut/core';
import type { ImageAttachment } from '@/api/chat';
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
/**
 * Archive/restore writes still awaiting their server answer, keyed `<parent>:<thread>`.
 * A refresh landing inside that window must keep the optimistic flags — the archive
 * POST waits on a bounded process terminate, so the window is seconds wide.
 */
const archiveInFlight = new Map<string, Pick<SideThread, 'archivedAt' | 'archived'>>();
const archiveKey = (parentSessionId: string, threadId: string) => `${parentSessionId}:${threadId}`;
let pendingSeq = 0;

/** Only ONE drawer instance may be open app-wide (see file header). */
let openInstanceId: string | null = null;

const PREWARM_THROTTLE_MS = 1_500;
/** Keystrokes before a new-thread draft counts as intent to ask (the warm-up
 *  costs a full prefix write on a big parent, so a stray character must not fire it). */
const WARM_MIN_CHARS = 8;

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

/**
 * Total shown on the pill: live threads + legacy one-shot entries. FILED threads are
 * excluded on purpose — the number has to fall when you tidy up, or the pill keeps
 * claiming a pile you already dealt with and archiving stops meaning anything.
 */
export function sideThreadsBadgeCount(state: SideThreadsState): number {
  return state.threads.filter((t) => !t.archivedAt).length + state.legacy.length;
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
    // A summary this thread wrote for the main session earlier. Its REQUEST is
    // hidden server-side, so pasting the reply here would land as an `A:` row with
    // no `Q:` above it — the main session would read the thread as having answered
    // the same question twice, in machine wording.
    if (text.startsWith(SIDE_THREAD_DIGEST_MARKER)) continue;
    lines.push(`${m.role === 'user' ? 'Q' : 'A'}: ${text}`);
  }
  return `${lines.join('\n')}\n\n`;
}

/**
 * The SUMMARY variant. Same provenance header shape as the full inject, so the
 * receiving session can tell where the text came from either way, plus a word for
 * WHICH variant it is getting: a summary is second-hand by construction, and the
 * main session should know that before it acts on it.
 *
 * Trailing blank line for the same reason as above: the composer may already hold
 * the user's own sentence.
 */
export function formatSideThreadDigestForComposer(label: string, summary: string): string {
  return `[Summary of side thread "${label}"]\n${summary.trim()}\n\n`;
}

/**
 * The first line the server demands of a digest reply. The SERVER owns this text
 * (`src/core/sessions/side-thread-digest.ts`) and sends it back on the /digest
 * response, which is what the acceptance rule below uses — this copy exists only
 * for the paths that have no response to read (the full inject filtering out an
 * older summary). A unit test pins the two spellings together so they cannot drift.
 */
export const SIDE_THREAD_DIGEST_MARKER = 'Summary for the main session:';

/** How far into the reply the marker may sit. Enough for a heading wrapper, not
 *  enough for the model to have written a paragraph of its own first. */
const MARKER_MAX_OFFSET = 120;

/**
 * Is this transcript message the summary we just asked for — and if so, what is the
 * summary text?
 *
 * This predicate is the whole safety story of "inject summary", so it is pure and
 * unit-tested rather than living inline in the drawer. Two independent rules:
 *
 *  1. The text must carry the marker near its start, preceded by nothing but
 *     decoration. Before this rule existed, live runs pasted the PREVIOUS answer
 *     into the main chat labelled as a summary — twice — because the transcript
 *     flush lags the turn-end event and a turn that was already running ends first.
 *     Decoration is tolerated (`**Summary…**`, `<p>Summary…`) because a thread in
 *     rich output mode still carries a standing HTML instruction from an earlier
 *     turn; prose before the marker is NOT, because that is how an ordinary answer
 *     that merely mentions the phrase would sneak through.
 *  2. It must differ from the message that was newest BEFORE the request, so a
 *     second digest cannot settle for the first one's summary.
 *
 * Returns undefined when either rule fails. A refusal is always better than a
 * confident wrong paste: the caller retries, then tells the user to inject the
 * full aside.
 */
export function pickSideThreadDigestReply(
  replyMarker: string,
  before: { id?: string; text?: string },
  now: { id?: string; text?: string },
): string | undefined {
  const text = (now.text ?? '').trim();
  if (!text || !replyMarker) return undefined;
  if (now.id === before.id && text === (before.text ?? '').trim()) return undefined;
  const at = text.indexOf(replyMarker);
  if (at < 0 || at > MARKER_MAX_OFFSET) return undefined;
  // Only whitespace, markdown emphasis/heading marks, and HTML tags may precede it.
  if (!/^(?:\s|[*_#>`~-]|<[^>]{0,120}>)*$/.test(text.slice(0, at))) return undefined;
  const body = text.slice(at + replyMarker.length).trim();
  return body || undefined;
}

export interface DigestReadDeps {
  /** Newest assistant message in the thread's transcript. May throw; a failed read
   *  costs one attempt, never the whole operation. */
  readLast: () => Promise<{ id?: string; text?: string }>;
  /** Resolves when the thread ends a turn, or after the poll interval — whichever
   *  comes first. Re-armable: it is called once per attempt. */
  waitTick: () => Promise<unknown>;
  /** Injectable clock so tests don't wait out real deadlines. */
  now?: () => number;
  timeoutMs: number;
  /** True once the caller no longer wants the answer (thread switched, unmounted). */
  cancelled?: () => boolean;
}

export type DigestReadResult =
  | { ok: true; summary: string }
  | { ok: false; reason: 'timeout' | 'cancelled' };

/**
 * Poll the thread's transcript until its summary shows up.
 *
 * Deadline-driven, NOT "wait for one turn-end then read a few times": any turn on
 * that session ends the wait (a queued follow-up, a self-wake), so treating the
 * first end-of-turn as ours ended the attempt while the real summary was still
 * being written. Turn-end is used only to wake the poll early.
 */
export async function readSideThreadDigest(
  replyMarker: string,
  before: { id?: string; text?: string },
  deps: DigestReadDeps,
): Promise<DigestReadResult> {
  const clock = deps.now ?? (() => Date.now());
  const deadline = clock() + deps.timeoutMs;
  while (clock() < deadline) {
    if (deps.cancelled?.()) return { ok: false, reason: 'cancelled' };
    try {
      const summary = pickSideThreadDigestReply(replyMarker, before, await deps.readLast());
      if (summary) return { ok: true, summary };
    } catch { /* one bad read (mid-flush 5xx, a tail-read deadline) costs one attempt */ }
    if (deps.cancelled?.()) return { ok: false, reason: 'cancelled' };
    await deps.waitTick();
  }
  return { ok: false, reason: 'timeout' };
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
      // Same protection for a row whose archive/restore is still in flight. The POST
      // waits on an ~8s-bounded terminate, and either drawer mount can refresh inside
      // that window; taking the server's (pre-request) answer would put the chip back
      // in the live row with an unlocked composer, and nothing would re-file it until
      // the NEXT refresh.
      const withOptimisticArchive = serverThreads.map((t) => {
        const local = archiveInFlight.get(archiveKey(parentSessionId, t.id));
        return local ? { ...t, ...local } : t;
      });
      const threads = [...withOptimisticArchive, ...stillPending];
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

/** parentSids whose current standby already got its warm-up request; cleared by
 *  create (the standby is consumed) so the next standby can be warmed again. */
const warmRequested = new Set<string>();

/**
 * Typing-triggered cache warm-up (see api/sideThreads.ts warmSideThreadStandby).
 * Once per standby cycle; the server is idempotent too, this only saves a request
 * per keystroke.
 */
export function warmSideThreadOnTyping(parentSessionId: string | undefined, draft: string): void {
  if (!parentSessionId || draft.trim().length < WARM_MIN_CHARS) return;
  if (warmRequested.has(parentSessionId)) return;
  warmRequested.add(parentSessionId);
  warmSideThreadStandby(parentSessionId).then((r) => {
    log.info('sideThreads', 'standby warm-up requested', { sessionId: parentSessionId, ...r });
    // Nothing to warm yet (standby still forking): let a later keystroke retry.
    if (!r.warmed && r.reason === 'no_standby') warmRequested.delete(parentSessionId);
  }).catch((err) => {
    warmRequested.delete(parentSessionId);
    log.warn('sideThreads', 'standby warm-up failed (ignored)', {
      sessionId: parentSessionId, error: err instanceof Error ? err.message : String(err),
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
 *
 * `images` ride the create request; the server saves them and annotates their
 * paths into the thread's FIRST message, while the stored question (and therefore
 * the chip label) stays the user's plain text.
 */
export async function createSideThreadOptimistic(
  parentSessionId: string | undefined,
  question: string,
  opts?: { images?: ImageAttachment[]; model?: string; effort?: SessionEffort; outputMode?: SessionOutputMode },
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
    const { thread } = await apiCreateSideThread(parentSessionId, q, {
      title: label,
      ...(opts?.images ? { images: opts.images } : {}),
      ...(opts?.model ? { model: opts.model } : {}),
      ...(opts?.effort ? { effort: opts.effort } : {}),
      ...(opts?.outputMode ? { outputMode: opts.outputMode } : {}),
    });
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
    warmRequested.delete(parentSessionId);
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

/**
 * Promote a thread into a task: a SIBLING of the parent session's task, filed in
 * a shared folder (server-side fork semantics). Optimistic ✓ badge, reconciled in
 * the background; `groupId` comes back only when a folder is involved.
 */
export async function promoteSideThreadOptimistic(
  parentSessionId: string | undefined,
  threadId: string,
): Promise<void> {
  if (!parentSessionId) return;
  const mark = (id: string, promotedTaskId: string | undefined, promotedGroupId?: string) => {
    const cur = read(parentSessionId);
    patch(parentSessionId, {
      threads: cur.threads.map((t) => (t.id === id ? { ...t, promotedTaskId, promotedGroupId } : t)),
    });
  };
  mark(threadId, PENDING_PROMOTE);
  try {
    const { taskId, groupId } = await apiPromoteSideThread(parentSessionId, threadId);
    mark(threadId, taskId, groupId);
    // Promote un-files server-side (a task must not own a dead session), so mirror
    // it here: otherwise a thread promoted OUT of the Archived shelf stays sitting
    // in the shelf, dashed and read-only, while its session is live and owns a task.
    patch(parentSessionId, {
      threads: read(parentSessionId).threads.map((t) => (
        t.id === threadId ? { ...t, archivedAt: undefined, archived: false } : t
      )),
    });
  } catch (err) {
    const cur = read(parentSessionId);
    const msg = err instanceof Error ? err.message : String(err);
    patch(parentSessionId, {
      threads: cur.threads.map((t) => (
        t.id === threadId && t.promotedTaskId === PENDING_PROMOTE
          ? { ...t, promotedTaskId: undefined, promotedGroupId: undefined }
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

/**
 * The chip row shows LIVE threads; filed ones live behind the Archived toggle.
 * Both selectors keep the store's order (oldest first, the order threads were
 * created), except the archived list reads newest-filed first — that is the order
 * you look for something you just tidied away.
 */
export function activeSideThreads(state: SideThreadsState): SideThread[] {
  return state.threads.filter((t) => !t.archivedAt);
}

export function archivedSideThreads(state: SideThreadsState): SideThread[] {
  return state.threads.filter((t) => !!t.archivedAt)
    .sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));
}

/**
 * Can this thread still be talked to? A thread you FILED (`archivedAt`) had its CLI
 * process retired at that moment, so a follow-up would silently cold-resume a fork
 * you had put away; restore is the deliberate way back, and the send path refuses
 * the shortcut. `archived` is the record-level flag: the session was archived, which
 * the send path rejects outright — the ordinary idle reaper does NOT set it (it only
 * kills the process, leaving the thread cold-resumable), so in practice this arm
 * catches a filed thread seen through an older list and the sweep's non-revivable
 * branch. Two flags, one consequence, and the optimistic path knows only the first.
 */
export function isSideThreadReadOnly(t: SideThread | null | undefined): boolean {
  return !!t && (!!t.archived || !!t.archivedAt);
}

/**
 * File a thread away / bring it back. Optimistic like every other drawer action, and
 * REVERSIBLE on failure: only two flags move, so a rollback is just putting the old
 * pair back. The row itself is never removed here — that is the whole difference
 * from deleteSideThreadOptimistic.
 *
 * BOTH flags have to move together. The server retires the process on archive and
 * un-archives the record on restore, so a client that tracked `archivedAt` alone
 * would keep a stale `archived: true` from the last list after a restore — the chip
 * comes back but the composer stays locked, with the actions slot already flipped
 * back to "Archive", i.e. no way out without reopening the drawer.
 */
export async function setSideThreadArchivedOptimistic(
  parentSessionId: string | undefined,
  threadId: string,
  archived: boolean,
): Promise<void> {
  if (!parentSessionId) return;
  const cur = read(parentSessionId);
  const target = cur.threads.find((t) => t.id === threadId);
  if (!target || threadId.startsWith(PENDING_THREAD_PREFIX)) return;
  const previousActive = cur.activeThreadId;
  const previous: Pick<SideThread, 'archivedAt' | 'archived'> = {
    archivedAt: target.archivedAt, archived: target.archived,
  };
  const next: Pick<SideThread, 'archivedAt' | 'archived'> = archived
    ? {
      archivedAt: previous.archivedAt ?? new Date().toISOString(),
      // A promoted thread keeps its live process (the server skips the retire),
      // so don't claim its record died just because it was filed.
      archived: target.promotedTaskId ? previous.archived : true,
    }
    : { archivedAt: undefined, archived: false };
  const key = archiveKey(parentSessionId, threadId);
  const apply = (
    value: Pick<SideThread, 'archivedAt' | 'archived'>,
    activeThreadId: string | null,
  ) => {
    // Held while the request is in flight so a concurrent refresh re-applies it
    // instead of taking the server's pre-request answer (see refreshSideThreads).
    archiveInFlight.set(key, value);
    patch(parentSessionId, {
      threads: read(parentSessionId).threads.map(
        (t) => (t.id === threadId ? { ...t, ...value } : t),
      ),
      activeThreadId,
    });
  };
  // Filing the thread you are looking at drops you back on the "+ New" composer;
  // leaving it selected would keep a filed thread mounted in the drawer body.
  apply(next, archived && previousActive === threadId ? null : previousActive);
  try {
    if (archived) {
      await apiArchiveSideThread(parentSessionId, threadId);
      apply(next, read(parentSessionId).activeThreadId);
    } else {
      // The server reports the SESSION's real state: un-archiving the record can
      // fail, and unlocking the composer over a still-archived record would only
      // move the refusal to the send.
      const { archived: recordArchived } = await apiRestoreSideThread(parentSessionId, threadId);
      apply({ archivedAt: undefined, archived: recordArchived },
        read(parentSessionId).activeThreadId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('sideThreads', 'archive toggle failed (restoring row state)', {
      sessionId: parentSessionId, threadId, archived, error: msg,
    });
    // Put the selection back too: a refused archive must not silently close the
    // conversation the user was reading.
    apply(previous, previousActive);
    patch(parentSessionId, {
      error: `${archived ? 'Archive' : 'Restore'} failed: ${msg}`,
    });
  } finally {
    archiveInFlight.delete(key);
  }
}

/**
 * A thread's auto-generated title landed (server event `session:side-thread-renamed`).
 * Patch the row in place: the drawer re-lists only when it opens, so without this the
 * user reads the truncated question for the whole conversation they just started.
 */
export function applySideThreadTitle(
  parentSessionId: string | undefined,
  threadId: string,
  title: string,
): void {
  if (!parentSessionId || !title) return;
  const cur = read(parentSessionId);
  if (!cur.threads.some((t) => t.id === threadId && t.title !== title)) return;
  patch(parentSessionId, {
    threads: cur.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
  });
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
  archiveInFlight.clear();
  lastPrewarmAt.clear();
  warmRequested.clear();
  openInstanceId = null;
  pendingSeq = 0;
  notify();
}
