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
import { renderMarkdown } from '@/components/chat/ChatMessage';
import { SessionChatHistory } from '@/components/sessions/SessionChatHistory';
import { useEntityLabelsVersion } from '@/hooks/useEntityLabels';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useSessionStatus } from '@/hooks/useSessionStatus';
import { useEvent } from '@/hooks/useWebSocket';
import { log } from '@/utils/log';
import { NO_AUTOFILL_PROPS } from '@/utils/no-autofill';
import { PROCESS_COLORS, PROCESS_LABELS } from '@/utils/session-status';
import { fetchSessionHistory } from '@/api/sessions';
import { promoteSideQuestion, type SideQuestion } from '@/api/sideQuestions';
import type { SideThread } from '@/api/sideThreads';
import { PlanContentContext } from '@/contexts/PlanContentContext';
import { SessionPinsContext, type SessionPinsApi } from '@/contexts/SessionPinsContext';
import { SessionRewindContext, type SessionRewindApi } from '@/contexts/SessionRewindContext';
import type { ProcessStatus, SessionEngine } from '@/types/session';
import {
  PENDING_PROMOTE,
  PENDING_THREAD_PREFIX,
  clearSideThreadsError,
  createSideThreadOptimistic,
  deleteSideThreadOptimistic,
  findSideThread,
  formatSideThreadForComposer,
  getOpenDrawerInstance,
  getSideThreadsState,
  prewarmSideThread,
  promoteSideThreadOptimistic,
  refreshSideThreads,
  setActiveSideThread,
  setOpenDrawerInstance,
  setSideThreadsError,
  sideThreadLabel,
  sideThreadsBadgeCount,
  subscribeSideThreads,
  updateLegacySideQuestions,
} from '@/stores/side-threads';

interface SideQuestionDrawerProps {
  /** The PARENT Claude session id. Drawer is disabled until the session has one. */
  sessionId: string | undefined;
  /** Parent engine / cwd / host — forwarded to the thread's SessionChatHistory so
   *  tool rendering, file links and image paths resolve the same as the main chat. */
  engine?: SessionEngine;
  cwd?: string;
  host?: string;
  /** Drop text into the MAIN composer (SessionPanel's prefill driver). */
  onInjectToComposer?: (text: string) => void;
}

/** How much of a thread transcript "Inject to chat" pulls. */
const INJECT_TAIL = 200;

/**
 * The drawer renders INSIDE SessionPanel's providers, which are bound to the
 * PARENT session — so a pin/rewind button on a THREAD row would act on the
 * parent's transcript. Neutralise all three for the thread body: a side thread
 * has no pins, no rewind and no plan of its own.
 */
const NO_REWIND: SessionRewindApi = { available: false, request: () => {} };
const NO_PINS: SessionPinsApi = {
  pins: [], isPinned: () => false, toggle: () => {}, unpin: () => {},
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
  sessionId, engine, cwd, host, onInjectToComposer,
}: SideQuestionDrawerProps) {
  const instanceId = useId();
  const getState = useCallback(() => getSideThreadsState(sessionId), [sessionId]);
  const state = useSyncExternalStore(subscribeSideThreads, getState, getState);
  const openInstance = useSyncExternalStore(
    subscribeSideThreads, getOpenDrawerInstance, getOpenDrawerInstance,
  );
  const expanded = openInstance === instanceId;

  const [draft, setDraft] = useState('');
  const [legacyOpen, setLegacyOpen] = useState(false);
  const [injecting, setInjecting] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  // Follow-ups go straight to the THREAD session id — the same RPC the main
  // composer uses, just a different sid. Passing null keeps the hook from
  // rehydrating a disk queue we don't render.
  const {
    send, optimisticMsgs, clearOptimistic,
    handleMessagesDelivered, handleBatchCompleted, handleBatchFailed,
  } = useSessionSend(null);
  // Legacy cards render markdown with entity pills.
  useEntityLabelsVersion();

  const activeThread = useMemo(
    () => findSideThread(state, state.activeThreadId),
    [state],
  );
  const badgeCount = sideThreadsBadgeCount(state);
  const disabled = !sessionId;

  // ONE send hook serves EVERY thread (keyed on null), so optimistic bubbles
  // from thread A must not follow the user into thread B — drop them on switch
  // (the switched-away thread's echo lands in its transcript regardless).
  const activeThreadSid = activeThread?.threadSessionId ?? null;
  useEffect(() => { clearOptimistic(); }, [activeThreadSid, clearOptimistic]);

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

  // Legacy one-shot entries can still arrive from another tab/route.
  useEvent('session:side-question-done', useCallback((data: unknown) => {
    const d = data as { sessionId?: string; id?: string };
    if (!sessionId || d?.sessionId !== sessionId) return;
    updateLegacySideQuestions(sessionId, (legacy) => (
      legacy.some((q) => q.id === d.id) ? legacy : [...legacy, data as SideQuestion]
    ));
  }, [sessionId]));

  // Close on outside-click / Escape (only the open instance reacts).
  useEffect(() => {
    if (!expanded) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) closeDrawer();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDrawer(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded, closeDrawer]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setDraft('');
    if (activeThread?.threadSessionId) {
      log.info('sideThreads', 'follow-up', {
        sessionId, threadId: activeThread.id, threadSessionId: activeThread.threadSessionId,
      });
      const ok = await send(activeThread.threadSessionId, text);
      if (!ok) setDraft(text);
      return;
    }
    // A failed create must give the typed question back — the optimistic row
    // rolls away and there is nothing else holding the user's text.
    if (!(await createSideThreadOptimistic(sessionId, text))) setDraft(text);
  }, [draft, sessionId, activeThread, send]);

  const startNewThread = useCallback(() => {
    setActiveSideThread(sessionId, null);
    clearSideThreadsError(sessionId);
    prewarmSideThread(sessionId);
  }, [sessionId]);

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
        disabled={disabled}
        title={disabled
          ? 'Available once the session has started'
          : 'Side threads — multi-turn questions kept out of the main conversation'}
      >
        <span>btw</span>
        {badgeCount > 0 && <span className="side-question-count">{badgeCount}</span>}
      </button>

      {expanded && (
        <div className="side-question-popover side-question-popover--threads">
          <div className="side-question-popover-header">
            <span className="side-question-popover-title">Side threads</span>
            <span className="side-question-popover-hint">multi-turn · kept out of the chat</span>
          </div>

          {/* Thread chips — one per thread, plus "+ New". */}
          <div className="side-thread-chips">
            {state.threads.map((t) => {
              const isActive = t.id === state.activeThreadId;
              const pending = t.id.startsWith(PENDING_THREAD_PREFIX);
              return (
                <button
                  key={t.id}
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
              );
            })}
            <button
              className={`side-thread-chip side-thread-chip-new${state.activeThreadId === null ? ' is-active' : ''}`}
              onClick={startNewThread}
              title="Start a new side thread"
            >
              {'+ New'}
            </button>
          </div>

          {/* Active thread conversation — the ONLY mounted SessionChatHistory. */}
          {activeThread && activeThread.threadSessionId && !activeIsPending ? (
            <div className="side-thread-body">
              <SessionRewindContext.Provider value={NO_REWIND}>
                <SessionPinsContext.Provider value={NO_PINS}>
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
                </SessionPinsContext.Provider>
              </SessionRewindContext.Provider>
            </div>
          ) : activeIsPending ? (
            <div className="side-thread-body side-thread-body-pending">
              <span className="side-question-spinner" /> Forking a side thread…
            </div>
          ) : (
            <div className="side-question-empty">
              {state.threads.length === 0
                ? 'No side threads yet — ask something below. Each thread is a hidden fork of this session, so the answers never enter the main chat.'
                : 'New thread — ask below, or pick a thread above to follow up.'}
            </div>
          )}

          {/* Per-thread actions — only meaningful with a real (confirmed) thread. */}
          {activeThread && !activeIsPending && (
            <div className="side-thread-actions">
              <button
                className="btn btn-sm"
                onClick={() => void injectToComposer(activeThread)}
                disabled={injecting || !onInjectToComposer}
                title="Copy this thread's Q&A into the main composer"
              >
                {injecting ? '⤴ Injecting…' : '⤴ Inject to chat'}
              </button>
              {activeThread.promotedTaskId === PENDING_PROMOTE ? (
                <span className="side-question-promoted">{'✓'} creating…</span>
              ) : activeThread.promotedTaskId ? (
                <span className="side-question-promoted">{'✓'} task created</span>
              ) : (
                <button
                  className="btn btn-sm"
                  onClick={() => void promoteSideThreadOptimistic(sessionId, activeThread.id)}
                >
                  {'➜ Promote to task'}
                </button>
              )}
              <button
                className="btn btn-sm side-thread-delete"
                onClick={() => void deleteSideThreadOptimistic(sessionId, activeThread.id)}
                title="Delete this side thread"
                aria-label="Delete this side thread"
              >
                {'🗑'}
              </button>
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
                ? (activeThread.archived
                  ? `Archived · ${sideThreadLabel(activeThread)} — history only`
                  : `Follow up · ${sideThreadLabel(activeThread)}`)
                : 'New side thread'}
            </label>
            <div className="side-question-composer-row">
              <input
                type="text"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void submit(); }
                }}
                placeholder={activeThread ? 'Follow up…' : 'Ask a side question…'}
                disabled={disabled || state.creating || !!activeThread?.archived}
                autoFocus
                {...NO_AUTOFILL_PROPS}
              />
              <button
                className="btn btn-sm btn-primary"
                onClick={() => void submit()}
                disabled={disabled || state.creating || !draft.trim()}
              >
                {activeThread ? 'Send' : 'Ask'}
              </button>
            </div>
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
