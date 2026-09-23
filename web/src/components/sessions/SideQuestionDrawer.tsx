/**
 * SideQuestionDrawer — the "btw" PILL (inline next to the mode pill) opening a
 * FLOATING POPOVER that holds a multi-THREAD mini-chat.
 *
 * Each side thread is a HIDDEN FORK of this coding session: its own session id,
 * its own transcript, its own streaming answers. The main conversation never sees
 * them, so a tangent ("why is this test flaky?") costs the main thread nothing —
 * and when it produces something worth keeping, the thread can be injected into
 * the composer or promoted into a task.
 *
 * Layout: header · thread chips row (+ New) · the ACTIVE thread's conversation ·
 * per-thread actions · one composer (new thread / follow-up) · a collapsed
 * "Earlier quick questions" section for the pre-thread one-shot entries
 * (read-only, promote still works through the old API).
 *
 * The composer is the app's REAL `ChatInput`, not a bare text field: a side thread
 * is a full session, so it deserves dictation, image attach, the "@" file palette,
 * multi-line editing and its own permission-mode pill. The pill acts on the THREAD
 * session (or, before one exists, on the mode the next thread will be created in).
 *
 * Two things worth knowing before editing:
 *  - The drawer is mounted TWICE per SessionPanel (main mode bar + plan popover),
 *    so ALL thread state lives in the shared module store
 *    (`stores/side-threads.ts`), and so does the "which instance is open" claim:
 *    only one popover may be open app-wide, which is also what guarantees we
 *    never mount two `useSessionStream`s for one thread session id.
 *  - The thread body is just `SessionChatHistory` (the precedent is
 *    `popout/PopoutSession.tsx`): it owns its own stream subscription, history,
 *    absorption and working indicator. ONLY the active thread is mounted — it is
 *    the heaviest subtree in the app.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { SESSION_MODE_LABELS } from '@open-walnut/core';
import type { SessionEffort, SessionOutputMode } from '@open-walnut/core';
import { ChatInput } from '@/components/chat/ChatInput';
import { renderMarkdown } from '@/components/chat/ChatMessage';
import { ComposerModelPill } from '@/components/sessions/ComposerModelPill';
import { OutputModePill } from '@/components/sessions/OutputModePill';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { SessionNotesBar, SessionNotesPill, useSessionNote } from '@/components/sessions/SessionNotes';
import { useEnabledModes } from '@/hooks/useEnabledModes';
import { useEngineCatalog } from '@/hooks/useEngineCatalog';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useEvent } from '@/hooks/useWebSocket';
import { engineCaps } from '@/utils/engine-capabilities';
import { log } from '@/utils/log';
import { useConfirm } from '@/hooks/useConfirm';
import { PROCESS_COLORS, PROCESS_LABELS } from '@/utils/session-status';
import type { ImageAttachment } from '@/api/chat';
import { ApiError } from '@/api/client';
import { fetchSession, fetchSessionHistory, updateSession } from '@/api/sessions';
import { promoteSideQuestion, type SideQuestion } from '@/api/sideQuestions';
import { requestSideThreadDigest, type SideThread } from '@/api/sideThreads';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import { SessionPinsContext, type SessionPinsApi } from '@/contexts/SessionPinsContext';
import { SessionThreadsContext, NO_THREADS } from '@/contexts/SessionThreadsContext';
import { SessionRewindContext, type SessionRewindApi } from '@/contexts/SessionRewindContext';
import type { ProcessStatus, SessionEngine, SessionMode, SessionRecord } from '@/types/session';
import {
  PENDING_PROMOTE,
  PENDING_THREAD_PREFIX,
  activeSideThreads,
  archivedSideThreads,
  isSideThreadReadOnly,
  clearSideThreadsError,
  createSideThreadOptimistic,
  formatSideThreadDigestForComposer,
  deleteSideThreadOptimistic,
  findSideThread,
  formatSideThreadForComposer,
  getOpenDrawerInstance,
  getSideThreadsState,
  prewarmSideThread,
  promoteSideThreadOptimistic,
  readSideThreadDigest,
  refreshSideThreads,
  setActiveSideThread,
  setOpenDrawerInstance,
  setSideThreadArchivedOptimistic,
  setSideThreadsError,
  sideThreadLabel,
  sideThreadsBadgeCount,
  subscribeSideThreads,
  updateLegacySideQuestions,
  applySideThreadTitle,
} from '@/stores/side-threads';

interface SideQuestionDrawerProps {
  /** The PARENT Claude session id. Drawer is disabled until the session has one. */
  sessionId: string | undefined;
  /** Parent engine / cwd / host — forwarded to the thread's SessionChatHistory so
   *  tool rendering, file links and image paths resolve the same as the main chat. */
  engine?: SessionEngine;
  cwd?: string;
  host?: string;
  /** The PARENT's permission mode — what a thread inherits at fork time, so it is
   *  also the mode pill's value until the thread's own record is read. */
  parentMode?: string;
  /** The PARENT's model / effort / reply style. A fork inherits all three, so these
   *  are what the pills must SHOW before the thread exists — anything else would
   *  invite the user to "fix" a value that is already correct. Picking a different
   *  one is an explicit override carried into the create request. */
  parentModel?: string;
  parentEffort?: SessionEffort;
  parentOutputMode?: SessionOutputMode;
  /** Drop text into the MAIN composer (SessionPanel's prefill driver). */
  onInjectToComposer?: (text: string) => void;
}

/** How much of a thread transcript "Inject full" pulls. */
const INJECT_TAIL = 200;

/** How long "Inject summary" waits for the thread's own summary turn. Generous:
 *  the thread's cache is warm and the reply is short, but a long aside on a slow
 *  host still has to be READ before it can be summarized. */
const DIGEST_TIMEOUT_MS = 90_000;

/** The turn-end event fires BEFORE the transcript flush lands, and it fires for
 *  ANY turn on that session, so the summary is found by polling until the deadline
 *  rather than by trusting the first read after the first result. Measured on a
 *  live session: that first read returned the PREVIOUS answer, which is exactly
 *  the "confident wrong answer" failure — the wrong text in the main chat. */
const DIGEST_READ_INTERVAL_MS = 800;

/** Widened to string keys: a mode id that is enabled but not in the registry must
 *  still render (its raw id), never crash the pill. Same read SessionPanel does. */
const MODE_LABELS: Record<string, string> = SESSION_MODE_LABELS;

/**
 * The drawer renders INSIDE SessionPanel's providers, which are bound to the
 * PARENT session — so a pin/rewind button on a THREAD row would act on the
 * parent's transcript. Neutralise all three for the thread body: a side thread
 * has no pins, no rewind and no plan of its own.
 */
const NO_REWIND: SessionRewindApi = { available: false, request: () => {} };
// A side thread has no session record of its own to PATCH, so pinning is off here
// — `canPinQuote: false` is what keeps the selection pill from offering it.
const NO_PINS: SessionPinsApi = {
  pins: [], isPinned: () => false, toggle: () => {}, pinQuote: () => {}, unpin: () => {},
  canPinQuote: false,
};

/** Live dot for one thread session — its own subscription, so a chip updates
 *  without re-rendering the whole drawer. */
function ThreadStatusDot({ threadSessionId }: { threadSessionId: string }) {
  const status = useSessionStatus(threadSessionId || null);
  const ps = status?.process_status as ProcessStatus | undefined;
  const color = ps ? PROCESS_COLORS[ps] : 'var(--fg-muted)';
  const label = ps ? PROCESS_LABELS[ps] : 'Starting…';
  return (
    <span
      className={`side-thread-dot${ps === 'running' ? ' is-running' : ''}`}
      style={{ background: color }}
      title={label}
    />
  );
}

export function SideQuestionDrawer({
  sessionId, engine, cwd, host, parentMode,
  parentModel, parentEffort, parentOutputMode, onInjectToComposer,
}: SideQuestionDrawerProps) {
  const instanceId = useId();
  const getState = useCallback(() => getSideThreadsState(sessionId), [sessionId]);
  const state = useSyncExternalStore(subscribeSideThreads, getState, getState);
  const openInstance = useSyncExternalStore(
    subscribeSideThreads, getOpenDrawerInstance, getOpenDrawerInstance,
  );
  const expanded = openInstance === instanceId;

  const [legacyOpen, setLegacyOpen] = useState(false);
  // The Archived list is collapsed by default — it is a shelf, not part of the
  // working row. Opened automatically when the thread you are viewing lives there.
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [injecting, setInjecting] = useState(false);
  // 'digest' while the thread is writing its own summary — the button says so, and
  // both inject actions stay disabled so a second click can't start a second turn.
  const [digesting, setDigesting] = useState(false);
  const confirmDialog = useConfirm();
  const rootRef = useRef<HTMLDivElement>(null);
  // Focus lands here after a chip is filed: the button the user just pressed
  // unmounts, and browsers drop focus to <body>, which strands keyboard users
  // outside the drawer with no signal that the thread was filed, not deleted.
  const archivedToggleRef = useRef<HTMLButtonElement>(null);
  // The ACTIVE thread's own record — the subject every composer control acts on
  // (permission mode, output mode, model/effort, note). Null while no thread is
  // active or its read is still in flight, in which case the controls fall back to
  // "follow the parent", which is exactly what the fork will do.
  const [threadRecord, setThreadRecord] = useState<SessionRecord | null>(null);
  // Values picked BEFORE a thread exists. They ride the create request, so the
  // very first answer already obeys them (a post-create PATCH would land after
  // the question was asked).
  const [newThreadMode, setNewThreadMode] = useState<SessionMode | null>(null);
  const [newOutputMode, setNewOutputMode] = useState<SessionOutputMode | undefined>(undefined);
  const [newModel, setNewModel] = useState<string | undefined>(undefined);
  const [newEffort, setNewEffort] = useState<SessionEffort | undefined>(undefined);
  const enabledModes = useEnabledModes();
  // Everything a control has already applied to a thread, per THREAD SESSION ID.
  // Two jobs, both load-bearing:
  //  · a pick made while that thread's record read is still in flight would be
  //    silently undone when the (pre-pick) read resolves — nothing re-reads
  //    afterwards, so the pill would show the old value forever;
  //  · the same PATCH-then-read race happens right after create, for the mode a
  //    new thread was asked for.
  // Keyed by sid so one thread's pick can NEVER be replayed onto another.
  const localPatchRef = useRef<Record<string, Partial<SessionRecord>>>({});
  // Follow-ups go straight to the THREAD session id — the same RPC the main
  // composer uses, just a different sid. Passing null keeps the hook from
  // rehydrating a disk queue we don't render.
  const {
    send, stopTurn, optimisticMsgs, clearOptimistic,
    handleMessagesDelivered, handleBatchCompleted, handleBatchFailed,
  } = useSessionSend(null);
  // Legacy cards render markdown with entity pills.
  useEntityLabelsVersion();

  const activeThread = useMemo(
    () => findSideThread(state, state.activeThreadId),
    [state],
  );
  // Filed threads are out of the chip row but never out of reach.
  const liveThreads = useMemo(() => activeSideThreads(state), [state]);
  const archivedThreads = useMemo(() => archivedSideThreads(state), [state]);
  const badgeCount = sideThreadsBadgeCount(state);
  const disabled = !sessionId;

  // ONE send hook serves EVERY thread (keyed on null), so optimistic bubbles
  // from thread A must not follow the user into thread B — drop them on switch
  // (the switched-away thread's echo lands in its transcript regardless).
  const activeThreadSid = activeThread?.threadSessionId ?? null;
  useEffect(() => { clearOptimistic(); }, [activeThreadSid, clearOptimistic]);
  // Switching threads abandons any summary still being written: its text belongs to
  // the thread the user left, and prefilling the composer with it now would overwrite
  // whatever they typed after moving on.
  useEffect(() => { digestRunRef.current += 1; }, [activeThreadSid]);
  // Viewing a filed thread (a refresh, or another tab set it active) must not leave
  // the shelf collapsed with nothing on screen explaining where the thread came from.
  useEffect(() => {
    if (activeThread?.archivedAt) setArchivedOpen(true);
  }, [activeThread?.archivedAt]);

  // The active thread's OWN record, read once per thread (a pending row has no
  // session id yet, so there is nothing to read and the controls follow the parent).
  useEffect(() => {
    // Cleared UNCONDITIONALLY, before the read: holding the PREVIOUS thread's
    // record while this one loads is how one thread's note ended up being saved
    // onto another (the note editor seeds itself from whatever record is present).
    setThreadRecord(null);
    if (!activeThreadSid) return;
    let alive = true;
    fetchSession(activeThreadSid).then((rec) => {
      if (!alive || !rec) return;
      // Local picks win over a read that was issued before them.
      setThreadRecord({ ...rec, ...localPatchRef.current[activeThreadSid] });
    }).catch((err) => {
      log.warn('sideThreads', 'thread record read failed', {
        sessionId: activeThreadSid, error: err instanceof Error ? err.message : String(err),
      });
    });
    return () => { alive = false; };
  }, [activeThreadSid]);

  /** Optimistic patch of the active thread's record — every control's local apply
   *  and its revert both come through here. */
  const patchThreadRecord = useCallback((patch: Partial<SessionRecord>) => {
    if (activeThreadSid) {
      localPatchRef.current[activeThreadSid] = {
        ...localPatchRef.current[activeThreadSid], ...patch,
      };
    }
    // While the read is in flight there is no record to merge into — the ledger
    // above is what carries the pick, and the read applies it on arrival.
    setThreadRecord((prev) => (prev ? { ...prev, ...patch } : prev));
  }, [activeThreadSid]);

  // Session note — the same control the main composer has, on the THREAD. Before a
  // thread exists there is nothing to annotate, so the pill is simply absent (an
  // empty sid is never written: the pill/bar only render with a live thread).
  const noteState = useSessionNote(activeThreadSid ?? '', threadRecord?.human_note);
  // A side thread is a FORK, so it always runs the parent's engine — the model
  // pill and its picker read the same capability view as the main composer.
  const engineUi = engineCaps(engine, useEngineCatalog());
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => { setNotesOpen(false); }, [activeThreadSid]);

  // Mid-turn state of the ACTIVE thread only — the composer's stop button and
  // queue wording come from it. Per-chip dots keep their own subscriptions.
  const activeThreadStatus = useSessionStatus(activeThreadSid || null);
  const threadStreaming = activeThreadStatus?.process_status === 'running';

  const closeDrawer = useCallback(() => { setOpenDrawerInstance(null); }, []);

  const toggleDrawer = useCallback(() => {
    setOpenDrawerInstance(expanded ? null : instanceId);
  }, [expanded, instanceId]);

  // Opening the drawer = refresh the list AND prewarm a standby fork, so the
  // first ask doesn't pay for the spawn. Prewarm is fire-and-forget by contract.
  useEffect(() => {
    if (!expanded || !sessionId) return;
    void refreshSideThreads(sessionId);
    prewarmSideThread(sessionId);
  }, [expanded, sessionId]);

  // The bare input this composer replaced had autoFocus; ChatInput has no such
  // prop, so put the caret in the box by hand. Safe to steal focus: the drawer
  // only opens because the user clicked the pill.
  useEffect(() => {
    if (!expanded) return;
    const raf = requestAnimationFrame(() => {
      rootRef.current
        ?.querySelector<HTMLTextAreaElement>('.side-question-composer textarea')
        ?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [expanded]);

  // Turn-end signal for the digest poll. `session:result` is the honest end-of-turn
  // event (process_status can flap mid-turn) and the drawer already receives it, but
  // it says "a turn ended", NOT "your turn ended" — a queued follow-up or a self-wake
  // fires it too. So it only WAKES the poll early; whether the summary has landed is
  // decided by reading the transcript (see readSideThreadDigest).
  const digestWaiterRef = useRef<{ sid: string; done: () => void } | null>(null);
  useEvent('session:result', useCallback((data: unknown) => {
    const waiter = digestWaiterRef.current;
    if (!waiter) return;
    if ((data as { sessionId?: string })?.sessionId !== waiter.sid) return;
    digestWaiterRef.current = null;
    waiter.done();
  }, []));
  // Bumped whenever the drawer moves on (thread switch, unmount): a digest in flight
  // must not prefill the composer for a thread the user has left.
  const digestRunRef = useRef(0);
  useEffect(() => () => { digestRunRef.current += 1; }, []);

  // The thread's real title is generated in the background (fast model, off the
  // thread's own FIFO), so it lands a second or two after the chip appears.
  useEvent('session:side-thread-renamed', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; threadId?: string; title?: string };
    if (!sessionId || d?.sessionId !== sessionId || !d.threadId || !d.title) return;
    applySideThreadTitle(sessionId, d.threadId, d.title);
  }, [sessionId]));

  // Legacy one-shot entries can still arrive from another tab/route.
  useEvent('session:side-question-done', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; id?: string };
    if (!sessionId || d?.sessionId !== sessionId) return;
    updateLegacySideQuestions(sessionId, (legacy) => (
      legacy.some((q) => q.id === d.id) ? legacy : [...legacy, data as SideQuestion]
    ));
  }, [sessionId]));

  // Close on outside-click / Escape (only the open instance reacts).
  //
  // The composer's own overlays (command palette, "@" mention palette, recents
  // popup, the "+" menu) all render INLINE inside ChatInput's DOM, so they are
  // already inside `rootRef` and the mousedown test covers them. Escape is the
  // one that needs care: a palette answers Escape by closing itself and calling
  // preventDefault, so respecting `defaultPrevented` here is what keeps one
  // Escape from also tearing the whole drawer down.
  useEffect(() => {
    if (!expanded) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!rootRef.current || !target || rootRef.current.contains(target)) return;
      // Popups the thread body opens (Bash output, plan, quote pins) portal to
      // document.body: a click inside them must not read as "outside".
      if (target.closest?.('.plan-popup-overlay, .quote-pin-popover, .quote-pin-pill')) return;
      closeDrawer();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeDrawer();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded, closeDrawer]);

  // ChatInput's contract: resolve false and it puts the text (and images) back in
  // the box. That is the whole failure story here — a failed create rolls its
  // optimistic row away, so nothing else is holding the user's words.
  const submit = useCallback(async (text: string, images?: ImageAttachment[]): Promise<boolean> => {
    const question = text.trim();
    if (!question || !sessionId) return false;
    // A filed thread's process was retired, so a follow-up would cold-resume a fork
    // the user had deliberately put away — invisible in every session list, and past
    // the reach of the thread reapers. The composer is disabled, but a disabled prop
    // is not a guarantee (another tab files the thread while this one holds focus).
    if (isSideThreadReadOnly(activeThread)) {
      log.info('sideThreads', 'follow-up refused — thread is filed/archived', {
        sessionId, threadId: activeThread?.id,
      });
      return false;
    }
    if (activeThread?.threadSessionId) {
      log.info('sideThreads', 'follow-up', {
        sessionId, threadId: activeThread.id, threadSessionId: activeThread.threadSessionId,
      });
      return send(activeThread.threadSessionId, question, images);
    }
    // Model / effort / output mode ride the REQUEST: they shape the spawn argv and
    // the first message, so a post-create PATCH would arrive after the question was
    // already asked on the inherited settings.
    const created = await createSideThreadOptimistic(sessionId, question, {
      ...(images ? { images } : {}),
      ...(newModel ? { model: newModel } : {}),
      ...(newEffort ? { effort: newEffort } : {}),
      ...(newOutputMode ? { outputMode: newOutputMode } : {}),
    });
    if (!created) return false;
    // Mode is the exception: it is inherited from the PARENT at fork time, so only a
    // deliberately different pick needs a PATCH. Fire-and-forget — the thread and
    // its answer are already live, and a failed mode switch must not read as a
    // failed ask.
    const parentDefault = parentMode ?? 'default';
    if (newThreadMode && newThreadMode !== parentDefault && created.threadSessionId) {
      localPatchRef.current[created.threadSessionId] = {
        ...localPatchRef.current[created.threadSessionId], mode: newThreadMode,
      };
      updateSession(created.threadSessionId, { mode: newThreadMode }).catch((err) => {
        log.warn('sideThreads', 'new thread mode apply failed', {
          sessionId: created.threadSessionId, mode: newThreadMode,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    setNewThreadMode(null);
    setNewOutputMode(undefined);
    setNewModel(undefined);
    setNewEffort(undefined);
    return true;
  }, [
    sessionId, activeThread, send, parentMode,
    newThreadMode, newOutputMode, newModel, newEffort,
  ]);

  const startNewThread = useCallback(() => {
    setActiveSideThread(sessionId, null);
    clearSideThreadsError(sessionId);
    prewarmSideThread(sessionId);
  }, [sessionId]);

  /** File a thread away, then hand focus to the shelf it went into. */
  const fileThread = useCallback(async (threadId: string) => {
    await setSideThreadArchivedOptimistic(sessionId, threadId, true);
    archivedToggleRef.current?.focus();
  }, [sessionId]);

  /**
   * The one irreversible action in the drawer, so it asks first. It sits two pixels
   * from Restore on an 18px target, and the whole point of this feature is that a
   * tidy-up click can't destroy the only place a decision was reasoned out.
   */
  const purgeThread = useCallback(async (thread: SideThread) => {
    const ok = await confirmDialog({
      title: `Delete "${sideThreadLabel(thread)}" permanently?`,
      message: 'Its conversation goes away for good. Leaving it in Archived costs nothing.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return;
    await deleteSideThreadOptimistic(sessionId, thread.id);
  }, [sessionId, confirmDialog]);

  // ── Mode pill ──────────────────────────────────────────────────────────────
  // One control, two subjects: with a thread active it switches THAT session's
  // permission mode; before one exists it picks the mode the next thread will be
  // created in. Same cycle as the main composer's pill (useEnabledModes).
  const pillMode = ((activeThreadSid ? threadRecord?.mode : newThreadMode)
    ?? parentMode ?? 'default') as SessionMode;
  const nextPillMode = enabledModes[
    (enabledModes.indexOf(pillMode) + 1) % enabledModes.length
  ] ?? pillMode;

  const cycleMode = useCallback(() => {
    if (!activeThreadSid) { setNewThreadMode(nextPillMode); return; }
    patchThreadRecord({ mode: nextPillMode });
    updateSession(activeThreadSid, { mode: nextPillMode }).catch((err) => {
      patchThreadRecord({ mode: pillMode });
      log.warn('sideThreads', 'mode toggle failed', {
        sessionId: activeThreadSid, mode: nextPillMode,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [activeThreadSid, pillMode, nextPillMode, patchThreadRecord]);

  // Inject: flatten the thread's Q&A (TEXT parts only — no tool blocks, no
  // thinking) into the main composer through SessionPanel's prefill driver.
  const injectToComposer = useCallback(async (thread: SideThread) => {
    if (!onInjectToComposer || !thread.threadSessionId) return;
    setInjecting(true);
    try {
      const res = await fetchSessionHistory(thread.threadSessionId, { tail: INJECT_TAIL });
      // A fork's transcript EMBEDS the parent conversation (the CLI copies the
      // resumed prefix); the server marks where the aside starts. Inject only
      // the aside — pasting the parent's own conversation back at itself is
      // the opposite of the feature.
      const all = res.messages ?? [];
      const asideOnly = res.forkBoundaryIndex != null && res.forkBoundaryIndex > 0
        ? all.slice(res.forkBoundaryIndex)
        : all;
      const text = formatSideThreadForComposer(sideThreadLabel(thread), asideOnly);
      onInjectToComposer(text);
      log.info('sideThreads', 'injected into composer', {
        sessionId, threadId: thread.id, chars: text.length,
      });
      closeDrawer();
    } catch (err) {
      log.warn('sideThreads', 'inject failed', {
        sessionId, threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Surface it — a silently empty composer reads as a dead button.
      setSideThreadsError(sessionId, 'Inject failed — could not load the thread transcript');
    } finally {
      setInjecting(false);
    }
  }, [onInjectToComposer, sessionId, closeDrawer]);

  /**
   * Inject a SUMMARY instead of the whole aside. The thread writes it itself: it
   * already holds the aside in context, so this is one small incremental turn, and
   * the summary stays visible in the drawer (the request line is hidden server-side)
   * so the user can read it, re-run it, or fall back to the full inject.
   *
   * The composer is prefilled only AFTER the turn ends — a half-streamed summary in
   * the main composer would be worse than no summary at all.
   */
  const injectDigest = useCallback(async (thread: SideThread) => {
    const sid = thread.threadSessionId;
    if (!onInjectToComposer || !sid || !sessionId) return;
    const run = digestRunRef.current + 1;
    digestRunRef.current = run;
    setDigesting(true);
    clearSideThreadsError(sessionId);
    try {
      // Which assistant message is newest BEFORE the request. Everything below is
      // about not confusing it with the summary.
      const readLast = async (): Promise<{ id?: string; text?: string }> => {
        const res = await fetchSessionHistory(sid, { tail: 4 });
        const last = [...(res.messages ?? [])].reverse()
          .find((m) => m.role === 'assistant' && (m.text ?? '').trim());
        return { id: last?.msgId, text: last?.text?.trim() };
      };
      const before = await readLast().catch(() => ({}));
      // The server tells us the first line it demanded of the reply; the drawer
      // accepts nothing else as the summary.
      const { replyMarker } = await requestSideThreadDigest(sessionId, thread.id);
      const outcome = await readSideThreadDigest(replyMarker, before, {
        readLast,
        // Wake on this session's next turn-end, or on the poll interval, whichever
        // comes first — a missed event must never stall the poll.
        waitTick: () => new Promise((resolve) => {
          digestWaiterRef.current = { sid, done: () => resolve(undefined) };
          setTimeout(() => resolve(undefined), DIGEST_READ_INTERVAL_MS);
        }),
        timeoutMs: DIGEST_TIMEOUT_MS,
        cancelled: () => digestRunRef.current !== run,
      });
      digestWaiterRef.current = null;
      // The user moved on (switched threads, closed the panel). Say nothing and
      // touch nothing: prefilling now would overwrite whatever they are doing.
      if (outcome.ok === false && outcome.reason === 'cancelled') return;
      if (outcome.ok === false) {
        setSideThreadsError(sessionId, 'No summary came back — inject the full thread instead');
        return;
      }
      onInjectToComposer(formatSideThreadDigestForComposer(
        sideThreadLabel(thread), outcome.summary,
      ));
      log.info('sideThreads', 'injected summary into composer', {
        sessionId, threadId: thread.id, threadSessionId: sid, chars: outcome.summary.length,
      });
      closeDrawer();
    } catch (err) {
      digestWaiterRef.current = null;
      log.warn('sideThreads', 'digest failed', {
        sessionId, threadId: thread.id,
        error: err instanceof Error ? err.message : String(err),
      });
      // Prefer the server's own words: its 409s say exactly why this thread can't
      // summarize itself (promoted, reaped, waiting on a permission prompt) and a
      // generic "could not summarize" would hide all of it.
      const detail = err instanceof ApiError
        ? (err.body as { error?: string } | undefined)?.error
        : undefined;
      setSideThreadsError(
        sessionId,
        detail || 'Could not summarize this thread — inject the full thread instead',
      );
    } finally {
      // ALWAYS clear it. Guarding this on "still the current run" left the button
      // stuck on "✦ Summarizing…" forever after the user switched threads (the
      // switch is what abandons the run, so the guard was false exactly then).
      setDigesting(false);
    }
  }, [onInjectToComposer, sessionId, closeDrawer]);

  const promoteLegacy = useCallback(async (id: string) => {
    if (!sessionId) return;
    updateLegacySideQuestions(sessionId, (legacy) => legacy.map(
      (q) => (q.id === id ? { ...q, promotedTaskId: PENDING_PROMOTE } : q),
    ));
    try {
      const { taskId, parentTaskId } = await promoteSideQuestion(sessionId, id);
      updateLegacySideQuestions(sessionId, (legacy) => legacy.map(
        (q) => (q.id === id ? { ...q, promotedTaskId: taskId, promotedAsSubtask: !!parentTaskId } : q),
      ));
    } catch (err) {
      updateLegacySideQuestions(sessionId, (legacy) => legacy.map(
        (q) => (q.id === id && q.promotedTaskId === PENDING_PROMOTE
          ? { ...q, promotedTaskId: undefined } : q),
      ));
      log.warn('sideThreads', 'legacy promote failed', {
        sessionId, id, error: err instanceof Error ? err.message : String(err),
      });
    }
  }, [sessionId]);

  const activeIsPending = !!activeThread && activeThread.id.startsWith(PENDING_THREAD_PREFIX);

  return (
    <div className="side-question-root" ref={rootRef}>
      {/* Pill trigger — sits inline like the mode pill, NOT a full-width bar. */}
      <button
        className={`side-question-pill${expanded ? ' is-open' : ''}`}
        onClick={toggleDrawer}
        // Hovering the pill is the earliest honest signal that an ask is coming —
        // spend it on the fork spawn (throttled + fire-and-forget in the store).
        onMouseEnter={() => { if (sessionId) prewarmSideThread(sessionId); }}
        disabled={disabled}
        title={disabled
          ? 'Available once the session has started'
          : 'Side threads — multi-turn questions kept out of the main conversation'}
      >
        <span>btw</span>
        {badgeCount > 0 && <span className="side-question-count">{badgeCount}</span>}
      </button>

      {expanded && (
        <div
          className="side-question-popover side-question-popover--threads"
          // The popover lives INSIDE the main composer's controls row, so a file
          // dropped on the drawer's composer would keep bubbling and attach to the
          // MAIN composer as well. The inner ChatInput has already handled it here.
          onDragOver={(e) => e.stopPropagation()}
          onDragLeave={(e) => e.stopPropagation()}
          onDrop={(e) => e.stopPropagation()}
        >
          <div className="side-question-popover-header">
            <span className="side-question-popover-title">Side threads</span>
            <span className="side-question-popover-hint">multi-turn · kept out of the chat</span>
          </div>

          {/* Thread chips — one per LIVE thread, plus "+ New". Filed ones move to
              the Archived shelf below, which is why the × is an archive and not a
              delete: an aside is often the only place a decision was reasoned out. */}
          <div className="side-thread-chips">
            {liveThreads.map((t) => {
              const isActive = t.id === state.activeThreadId;
              const pending = t.id.startsWith(PENDING_THREAD_PREFIX);
              return (
                <span key={t.id} className="side-thread-chip-wrap">
                  <button
                    className={`side-thread-chip${isActive ? ' is-active' : ''}`}
                    onClick={() => setActiveSideThread(sessionId, t.id)}
                    title={sideThreadLabel(t)}
                  >
                    {pending
                      ? <span className="side-question-spinner side-thread-chip-spinner" />
                      : <ThreadStatusDot threadSessionId={t.threadSessionId} />}
                    <span className="side-thread-chip-title">{sideThreadLabel(t)}</span>
                    {t.promotedTaskId && (
                      <span
                        className="side-thread-chip-badge"
                        title={t.promotedTaskId === PENDING_PROMOTE ? 'Creating task…' : 'Task created'}
                      >
                        {'✓task'}
                      </span>
                    )}
                  </button>
                  {/* Not rendered for a pending row: there is no server-side thread to
                      file yet, and the id would be the optimistic one. */}
                  {!pending && (
                    <button
                      className="side-thread-chip-archive"
                      onClick={() => void fileThread(t.id)}
                      title="Archive this side thread (kept, and restorable)"
                      aria-label={`Archive side thread: ${sideThreadLabel(t)}`}
                    >
                      {'×'}
                    </button>
                  )}
                </span>
              );
            })}
            <button
              className={`side-thread-chip side-thread-chip-new${state.activeThreadId === null ? ' is-active' : ''}`}
              onClick={startNewThread}
              title="Start a new side thread"
            >
              {'+ New'}
            </button>
            {archivedThreads.length > 0 && (
              <button
                ref={archivedToggleRef}
                className={`side-thread-chip side-thread-chip-archived-toggle${archivedOpen ? ' is-active' : ''}`}
                onClick={() => setArchivedOpen((v) => !v)}
                title="Side threads you filed away — still readable, and restorable"
                aria-expanded={archivedOpen}
                aria-controls={`${instanceId}-archived-shelf`}
              >
                {`${archivedOpen ? '▾' : '▸'} Archived (${archivedThreads.length})`}
              </button>
            )}
          </div>

          {archivedOpen && archivedThreads.length > 0 && (
            <div className="side-thread-archived" id={`${instanceId}-archived-shelf`}>
              {archivedThreads.map((t) => (
                <span
                  key={t.id}
                  className={`side-thread-chip-wrap${t.id === state.activeThreadId ? ' is-active' : ''}`}
                >
                  <button
                    className={`side-thread-chip is-archived${t.id === state.activeThreadId ? ' is-active' : ''}`}
                    onClick={() => setActiveSideThread(sessionId, t.id)}
                    title={`${sideThreadLabel(t)} — open (read-only until restored)`}
                  >
                    <span className="side-thread-chip-title">{sideThreadLabel(t)}</span>
                    {t.promotedTaskId && <span className="side-thread-chip-badge">{'✓task'}</span>}
                  </button>
                  <button
                    className="side-thread-chip-archive"
                    onClick={() => void setSideThreadArchivedOptimistic(sessionId, t.id, false)}
                    title="Restore this side thread (its process resumes on the next follow-up)"
                    aria-label={`Restore side thread: ${sideThreadLabel(t)}`}
                  >
                    {'↺'}
                  </button>
                  <button
                    className="side-thread-chip-archive side-thread-chip-purge"
                    onClick={() => void purgeThread(t)}
                    title="Delete permanently — this one cannot be undone"
                    aria-label={`Delete side thread permanently: ${sideThreadLabel(t)}`}
                  >
                    {'🗑'}
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Active thread conversation — the ONLY mounted SessionChatHistory. */}
          {activeThread && activeThread.threadSessionId && !activeIsPending ? (
            <div className="side-thread-body">
              <SessionRewindContext.Provider value={NO_REWIND}>
                <SessionPinsContext.Provider value={NO_PINS}>
                  {/* The drawer sits inside the PARENT session's threads provider.
                      Left connected, this timeline would read the parent's anchors,
                      publish its own tree over the parent's, and in tree mode filter
                      itself by the parent's current thread (writing that key back). */}
                  <SessionThreadsContext.Provider value={NO_THREADS}>
                  <PlanContentContext.Provider value={null}>
                    <SessionChatHistory
                      key={activeThread.threadSessionId}
                      sessionId={activeThread.threadSessionId}
                      engine={engine}
                      sessionCwd={cwd}
                      sessionHost={host}
                      optimisticMessages={optimisticMsgs}
                      onMessagesDelivered={handleMessagesDelivered}
                      onBatchCompleted={handleBatchCompleted}
                      onBatchFailed={handleBatchFailed}
                    />
                  </PlanContentContext.Provider>
                  </SessionThreadsContext.Provider>
                </SessionPinsContext.Provider>
              </SessionRewindContext.Provider>
            </div>
          ) : activeIsPending ? (
            <div className="side-thread-body side-thread-body-pending">
              <span className="side-question-spinner" /> Forking a side thread…
            </div>
          ) : (
            <div className="side-question-empty">
              {/* "pick a thread above" has to be true: with every thread filed, the
                  chip row is empty and the only pickable threads are in the shelf. */}
              {liveThreads.length === 0 && archivedThreads.length === 0
                ? 'No side threads yet — ask something below. Each thread is a hidden fork of this session, so the answers never enter the main chat.'
                : liveThreads.length === 0
                  ? 'New thread — ask below, or reopen one from Archived above.'
                  : 'New thread — ask below, or pick a thread above to follow up.'}
            </div>
          )}

          {/* Per-thread actions — only meaningful with a real (confirmed) thread. */}
          {activeThread && !activeIsPending && (
            <div className="side-thread-actions">
              {/* Two ways in, because the right one depends on the aside's LENGTH:
                  the full Q&A when it is short and every word matters, a summary
                  when it is ten turns of debugging the main session would have to
                  re-read. The summary is written by the thread itself. */}
              <button
                className="btn btn-sm"
                onClick={() => void injectToComposer(activeThread)}
                disabled={injecting || digesting || !onInjectToComposer}
                title="Copy this thread's whole Q&A into the main composer"
              >
                {injecting ? '⤴ Injecting…' : '⤴ Inject full'}
              </button>
              {/* Refuses to run MID-TURN. Measured why: clicking while the thread was
                  still answering caught that turn's end event, read the answer as
                  if it were the summary, and injected the wrong text — a confident
                  wrong answer, the worst outcome for a paste-into-chat action. */}
              <button
                className="btn btn-sm"
                onClick={() => void injectDigest(activeThread)}
                disabled={injecting || digesting || !onInjectToComposer || activeIsPending
                  || threadStreaming || isSideThreadReadOnly(activeThread) || !!activeThread.promotedTaskId}
                title={threadStreaming
                  ? 'Wait for this thread to finish answering, then summarize'
                  : isSideThreadReadOnly(activeThread)
                    ? 'This thread\'s process is gone — inject the full aside instead'
                    : activeThread.promotedTaskId
                      ? 'This thread is a task now — inject the full aside instead'
                      : 'Ask this thread to summarize itself, then put the summary in the main composer'}
              >
                {digesting ? '✦ Summarizing…' : '✦ Inject summary'}
              </button>
              {activeThread.promotedTaskId === PENDING_PROMOTE ? (
                <span className="side-question-promoted">{'✓'} creating…</span>
              ) : activeThread.promotedTaskId ? (
                <span className="side-question-promoted">
                  {'✓'} {activeThread.promotedGroupId ? 'task created in folder' : 'task created'}
                </span>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => void promoteSideThreadOptimistic(sessionId, activeThread.id)}
                >
                  {'➜ Promote to task'}
                </button>
              )}
              {/* The default "done with this" action ARCHIVES; permanent delete lives
                  in the Archived shelf, one deliberate step further away. On a thread
                  you already filed, the same slot is the way back — offering "Archive"
                  there would be a no-op button on the one screen it can't apply to. */}
              {activeThread.archivedAt ? (
                <button
                  className="btn btn-sm side-thread-archive-action side-thread-restore"
                  onClick={() => void setSideThreadArchivedOptimistic(sessionId, activeThread.id, false)}
                  title="Restore this side thread so you can follow up again"
                  aria-label="Restore this side thread"
                >
                  {'↺ Restore'}
                </button>
              ) : (
                <button
                  className="btn btn-sm side-thread-archive-action side-thread-delete"
                  onClick={() => void setSideThreadArchivedOptimistic(sessionId, activeThread.id, true)}
                  title="Archive this side thread — kept and restorable, out of the chip row"
                  aria-label="Archive this side thread"
                >
                  {'⌦ Archive'}
                </button>
              )}
            </div>
          )}

          {state.forkUnsupported && (
            <div className="side-question-notice">This engine can&apos;t fork side threads</div>
          )}
          {state.error && <div className="side-question-error">{state.error}</div>}

          {/* One composer: new thread when nothing is active, follow-up otherwise.
              An ARCHIVED thread's session is gone — its transcript is history
              only, so the follow-up input locks rather than silently failing. */}
          <div className="side-question-composer">
            <label className="side-question-composer-label">
              {activeThread
                ? (isSideThreadReadOnly(activeThread)
                  ? `Archived · ${sideThreadLabel(activeThread)} — history only${activeThread.archivedAt ? ' (restore it to follow up)' : ''}`
                  : `Follow up · ${sideThreadLabel(activeThread)}`)
                : 'New side thread'}
            </label>
            <ChatInput
              onSend={(text, images) => submit(text, images)}
              placeholder={activeThread ? 'Follow up…' : 'Ask a side question…'}
              disabled={disabled || state.creating || isSideThreadReadOnly(activeThread)}
              showCommands={false}
              enableEntityMention={false}
              mentionCwd={cwd}
              mentionHost={host}
              draftKey={sessionId ? `side-thread-draft:${sessionId}` : undefined}
              isStreaming={!!activeThreadSid && threadStreaming}
              onStop={activeThread?.threadSessionId
                ? () => { void stopTurn(activeThread.threadSessionId); }
                : undefined}
              onToggleMode={cycleMode}
              controlsSlot={(
                <div className="session-mode-bar">
                  <button
                    className={`mode-toggle-pill${pillMode === 'plan' ? ' plan-active' : ''}`}
                    onClick={cycleMode}
                    type="button"
                    title={activeThreadSid
                      ? `Thread mode: ${pillMode}. Click or Shift+Tab to cycle → ${nextPillMode}`
                      : `The new thread starts in ${pillMode}. Click or Shift+Tab to cycle → ${nextPillMode}`}
                  >
                    <span className="mode-toggle-pill-label">
                      {MODE_LABELS[pillMode] ?? pillMode}
                    </span>
                    <span className="mode-toggle-pill-shortcut">{'⇧'}Tab</span>
                  </button>
                  {/* Reply style. On a live thread it PATCHes that session like the
                      main composer's pill; before one exists the pick rides the
                      create request, so even the FIRST answer obeys it. */}
                  <OutputModePill
                    {...(activeThreadSid ? { sessionId: activeThreadSid } : { pending: true })}
                    // Unread record ⇒ fall back to the parent's style, which is
                    // what a fork inherits. The config default would be a worse
                    // guess: a thread pinned to markdown under a rich parent
                    // would read "Rich" for the length of the read.
                    mode={(activeThreadSid ? threadRecord?.output_mode : newOutputMode)
                      ?? parentOutputMode}
                    onOptimistic={(output_mode) => {
                      if (activeThreadSid) patchThreadRecord({ output_mode });
                      else setNewOutputMode(output_mode);
                    }}
                    titleSuffix={activeThreadSid
                      ? 'Applies to this side thread'
                      : 'Applies to the next side thread'}
                  />
                  {/* A note annotates something that EXISTS — before the first ask
                      there is no thread to attach one to, so the pill appears with
                      the thread rather than pretending to work. */}
                  {activeThreadSid && (
                    <SessionNotesPill
                      noteState={noteState}
                      expanded={notesOpen}
                      onToggleExpanded={() => setNotesOpen((o) => !o)}
                    />
                  )}
                  {/* Model + effort. On a live thread this is the main composer's
                      control, unchanged. Before one exists it runs PENDING: the
                      pill SHOWS what the fork would inherit from the parent, and a
                      different pick becomes an explicit override on the create
                      request (which costs the parent's warm cache — the fork can no
                      longer reuse the prewarmed standby). NOTE: no "btw" pill here
                      on purpose; a side thread of a side thread is not a feature. */}
                  <ComposerModelPill
                    sessionId={activeThreadSid || undefined}
                    session={activeThreadSid ? threadRecord : undefined}
                    engineUi={engineUi}
                    onOptimistic={patchThreadRecord}
                    {...(activeThreadSid ? {} : {
                      pending: {
                        model: newModel ?? parentModel,
                        effort: newEffort ?? parentEffort,
                        onPick: setNewModel,
                        onPickEffort: setNewEffort,
                        host,
                        cwd,
                        // A fork's "no pick" means INHERIT the parent, which is not
                        // the same thing as the picker's Auto (spawn with no
                        // --model). Offering Auto here would report the same
                        // `undefined` for two different intents, so it is hidden.
                        allowAuto: false,
                      },
                    })}
                    title={activeThreadSid
                      ? 'Applies to this side thread.'
                      : 'Applies to the next side thread (inherited from the parent).'}
                  />
                </div>
              )}
            />
            {activeThreadSid && (
              <SessionNotesBar
                noteState={noteState}
                expanded={notesOpen}
                onToggleExpanded={() => setNotesOpen((o) => !o)}
                onCollapse={() => setNotesOpen(false)}
              />
            )}
          </div>

          {/* Pre-thread one-shot entries — read-only, promote still works. */}
          {state.legacy.length > 0 && (
            <div className="side-question-legacy">
              <button
                className="side-question-legacy-toggle"
                onClick={() => setLegacyOpen((v) => !v)}
              >
                {legacyOpen ? '▾' : '▸'} Earlier quick questions ({state.legacy.length})
              </button>
              {legacyOpen && (
                <div className="side-question-stack">
                  {state.legacy.map((q) => (
                    <div key={q.id} className="side-question-card">
                      <div className="side-question-card-q">{q.question}</div>
                      <div
                        className="markdown-body side-question-card-a"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(q.answer ?? '') }}
                      />
                      <div className="side-question-card-actions">
                        {q.promotedTaskId === PENDING_PROMOTE ? (
                          <span className="side-question-promoted">{'✓'} creating…</span>
                        ) : q.promotedTaskId ? (
                          <span className="side-question-promoted">
                            {'✓'} {q.promotedAsSubtask ? 'subtask created' : 'task created'}
                          </span>
                        ) : (
                          <button className="btn btn-sm" onClick={() => void promoteLegacy(q.id)}>
                            {'➜ Promote to task'}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
