/**
 * AskWalnutSlot — the home page's chat column.
 *
 * There is no "main agent" any more: talking to Walnut IS an ordinary
 * claude-code session bound to a task flagged `walnut_agent`, filed under the
 * `Ask Walnut` project. So this slot is a VIEW over the task store — a tab strip
 * of those tasks (newest first) and a real `SessionPanel` for the selected one.
 * Nothing here owns conversation state; the session panel and the session queue
 * do, exactly as they do in a session column.
 *
 * Three body states, and the transitions between them are the whole component:
 *   new      → `DraftSessionPanel` in its Ask Walnut shape (the tab users
 *              already know: copy, one-tap seeds, composer, model pill pinned to
 *              claude). Start calls quick-start DIRECTLY — no session column, no
 *              pending column, the answer streams right here.
 *   pending  → the HTTP round-trip, with the message echoed; an error keeps the
 *              payload so Retry replays the same launch.
 *   session  → `SessionPanel embedded` (no lock / popout / close chrome; locate
 *              and fullscreen stay).
 *
 * Selection persists in sessionStorage and is re-resolved whenever the task list
 * changes; the decisions live in ./ask-walnut-slot-model so they can be pinned
 * without a DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { ImageAttachment } from '@/api/chat';
import { fetchAskWalnutLaunch, fetchWorkingDirs, quickStartSession } from '@/api/sessions';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { ASK_WALNUT_PROJECT, type DraftColumn } from '@/components/sessions/draft-column';
import { freshLauncherMeta } from '@/components/sessions/task-meta-constants';
import type { QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { log } from '@/utils/log';
import { resolveTaskSessionId } from '@/utils/session-status';
import { AskWalnutSlotHeader, type SlotTab } from './AskWalnutSlotHeader';
import { resolveSelection, selectAskWalnutTasks } from './ask-walnut-slot-model';
import '@/styles/walnut-agent.css';

/** Which task the slot is showing. sessionStorage (not localStorage): a tab is a
 *  per-window view, and two windows should be able to watch two asks. */
const SS_SELECTED_KEY = 'walnut:ask-slot:selected';

/** The synthetic draft row's id. Fixed rather than timestamped: the slot holds at
 *  most ONE draft, and a stable id means ChatInput's persisted composer text
 *  survives a cancel → New round trip (a successful send clears it, as in any
 *  composer). */
const SLOT_DRAFT_ID = 'ask-walnut-slot';

/** Tabs rendered inline; everything past this goes behind the "⋯" menu. */
const MAX_VISIBLE_TABS = 6;

/**
 * How long the launch response may cover for the task store.
 *
 * `launched` exists to bridge the WS echo (normally <1s). A task that never
 * arrives is a phantom tab — a row the user can click but nothing can ever
 * resolve — so the placeholder expires instead of surviving until reload.
 */
const LAUNCHED_GRACE_MS = 60_000;

interface PendingLaunch {
  /** The exact quick-start body, kept so Retry replays the SAME launch. */
  payload: Parameters<typeof quickStartSession>[0];
  /** Echoed under the spinner so the user sees what is being sent. */
  message: string;
  error?: string;
}

export interface AskWalnutSlotProps {
  /** The shared task store's list — the slot filters it, never fetches. */
  tasks: readonly Task[];
  /** True while that store is doing its FIRST load. Without it the slot reads the
   *  empty starting list as "no asks yet" and flashes the composer on every single
   *  page load before the real list arrives. */
  tasksLoading?: boolean;
  /** Rendered above the body (the setup banner). */
  banner?: ReactNode;
  /** Rendered under the header while the inspector is open. */
  inspectorPanel?: ReactNode;
  /** The task composer popover, placed against the header's "+ Task" button. */
  taskComposer?: ReactNode;
  /** Whether that composer is open — the header needs it to place the popover. */
  taskComposerOpen?: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  /** "+ Task" — opens the task composer the owner passed in. */
  onOpenTaskComposer: () => void;
  /** "+ Session" — the ordinary draft session column. */
  onOpenDraftColumn: () => void;
  /** "Sessions" — the session finder overlay (the old QuickAccessBar pill). */
  onOpenSessionFinder?: () => void;
  /** "Fix Walnut" — a draft column pre-armed on Walnut's own checkout. Absent
   *  (npm install / cloud) hides the button. */
  onFixWalnut?: () => void;
  /** Collapse the slot — the same affordance the old chat header's ✕ had. */
  onCloseChat: () => void;
  /** Reported on every selection change, so the owner can point the context
   *  inspector at the session actually on screen. */
  onSelectionChange?: (selection: { taskId: string | null; sessionId: string | null }) => void;
  onTaskClick?: (taskId: string) => void;
  onOpenTaskDetail?: (taskId: string) => void;
  onSessionClick?: (sessionId: string) => void;
  onSessionReplaced?: (oldSessionId: string, newSessionId: string) => void;
  onOpenForkDraft?: (seed: {
    forkOf: { sessionId: string; title?: string };
    cwd: string; host: string | null; hostLabel?: string;
    project?: string; model?: string; cwdPinned: true;
  }) => void;
}

/** The launch meta a fresh slot draft opens on: the launcher baseline with the
 *  Ask Walnut seeds the draft tab applies (Focus tier, model Auto). */
function initialDraftMeta(): QuickStartTaskMeta {
  return { ...freshLauncherMeta(), pinTier: 'focus', model: undefined };
}

export function AskWalnutSlot({
  tasks, tasksLoading, banner, inspectorPanel, taskComposer, taskComposerOpen,
  inspectorOpen, onToggleInspector, onOpenTaskComposer, onOpenDraftColumn, onOpenSessionFinder,
  onFixWalnut, onCloseChat, onSelectionChange,
  onTaskClick, onOpenTaskDetail, onSessionClick, onSessionReplaced, onOpenForkDraft,
}: AskWalnutSlotProps) {
  const askTasks = useMemo(() => selectAskWalnutTasks(tasks), [tasks]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => {
    try { return sessionStorage.getItem(SS_SELECTED_KEY); } catch { return null; }
  });
  /** The user asked for a fresh ask (the "New" action). */
  const [newMode, setNewMode] = useState(false);
  const [pending, setPending] = useState<PendingLaunch | null>(null);
  const [draftMeta, setDraftMeta] = useState<QuickStartTaskMeta>(initialDraftMeta);
  /** What the last slot launch returned. Held because the task/session stores
   *  only refresh over WS a beat later: without it the panel could not mount, and
   *  the selection would bounce back to the previous task in the meantime. */
  const [launched, setLaunched] = useState<{ taskId: string; sessionId?: string; title: string } | null>(null);

  useEffect(() => {
    try {
      if (selectedTaskId) sessionStorage.setItem(SS_SELECTED_KEY, selectedTaskId);
      else sessionStorage.removeItem(SS_SELECTED_KEY);
    } catch { /* storage disabled — selection is per-render only */ }
  }, [selectedTaskId]);

  // Ref mirrors for the []-dep callbacks below (they must not be re-created on
  // every selection change — DraftSessionPanel and the header take them as props).
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const askTasksRef = useRef(askTasks);
  askTasksRef.current = askTasks;

  // Re-resolve the selection whenever the task list moves: a deleted/archived
  // selection falls back to the newest ask, an empty list to nothing (which
  // renders the composer). The just-launched task is EXEMPT until the store
  // carries it — re-resolving there would yank the user off the ask they just
  // sent, for the second the WS echo takes to land.
  useEffect(() => {
    if (launched && selectedTaskId === launched.taskId
      && !askTasks.some((t) => t.id === selectedTaskId)) return;
    const next = resolveSelection(selectedTaskId, askTasks);
    if (next !== selectedTaskId) setSelectedTaskId(next);
  }, [askTasks, selectedTaskId, launched]);

  // Once the store carries the launched task WITH its session slot, the launch
  // response has nothing left to cover — drop it, so a later delete of that ask
  // is not shadowed by a phantom tab until reload.
  useEffect(() => {
    if (!launched) return;
    const own = askTasks.find((t) => t.id === launched.taskId);
    if (own && resolveTaskSessionId(own)) setLaunched(null);
  }, [askTasks, launched]);

  // Second exit, for the launch whose task NEVER arrives (created under a
  // different flag, deleted right after, a lost WS echo): after the grace window
  // the placeholder is a tab that can never resolve, so drop it. A task that IS
  // in the store keeps its bridge — the effect above owns that case, and pulling
  // the launch response out from under a task whose session slot has not landed
  // yet would blank the panel.
  useEffect(() => {
    if (!launched) return;
    const timer = setTimeout(() => {
      // The store check reads the ref OUTSIDE the updater: a state updater must
      // stay pure (React can call it twice), and the log below is a side effect.
      if (askTasksRef.current.some((t) => t.id === launched.taskId)) return;
      log.warn('ask-walnut-slot', 'the launched Ask Walnut task never reached the task store — dropping its placeholder tab', {
        taskId: launched.taskId, sessionId: launched.sessionId ?? null,
      });
      setLaunched((prev) => (prev && prev.taskId === launched.taskId ? null : prev));
    }, LAUNCHED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [launched]);

  const tabs = useMemo<SlotTab[]>(() => {
    const rows = askTasks.map((t) => ({ id: t.id, title: t.title || 'Ask Walnut' }));
    if (launched && !askTasks.some((t) => t.id === launched.taskId)) {
      return [{ id: launched.taskId, title: launched.title }, ...rows];
    }
    return rows;
  }, [askTasks, launched]);

  // Up to MAX_VISIBLE_TABS inline. The SELECTED tab is always one of them — a
  // tab strip whose active row hides behind a "⋯" reads as nothing selected.
  const { visibleTabs, overflowTabs } = useMemo(() => {
    if (tabs.length <= MAX_VISIBLE_TABS) return { visibleTabs: tabs, overflowTabs: [] as SlotTab[] };
    const visible = tabs.slice(0, MAX_VISIBLE_TABS);
    const overflow = tabs.slice(MAX_VISIBLE_TABS);
    const hiddenIdx = overflow.findIndex((t) => t.id === selectedTaskId);
    if (hiddenIdx < 0) return { visibleTabs: visible, overflowTabs: overflow };
    const swapped = [...visible.slice(0, MAX_VISIBLE_TABS - 1), overflow[hiddenIdx]];
    return {
      visibleTabs: swapped,
      overflowTabs: [visible[MAX_VISIBLE_TABS - 1], ...overflow.filter((_, i) => i !== hiddenIdx)],
    };
  }, [tabs, selectedTaskId]);

  const selectedTask = useMemo(
    () => askTasks.find((t) => t.id === selectedTaskId) ?? null,
    [askTasks, selectedTaskId],
  );

  /**
   * Sessions the panel replaced ITSELF with, old id → new id.
   *
   * A rewind-as-fork mints a new session continuing the same task. The server
   * DOES relink the task's session slot to it (`linkSessionSlot` in
   * claude-code-session.ts), so this map is only a LAG BRIDGE: it keeps the panel
   * on the new transcript for the beat between the fork and the task row landing
   * in this browser's store. Session columns get that for free (their id IS the
   * column's key, which `onSessionReplaced` swaps); the slot derives its id from
   * the task, so it has to remember the hop itself.
   *
   * COMPRESSED ON RECORD: every entry already pointing at `oldId` is re-pointed
   * at `newId` before the new hop is stored, so a lookup is always one step and a
   * chain of rewinds can never build a cycle to walk.
   */
  const [replacedBy, setReplacedBy] = useState<Record<string, string>>({});
  const handleSessionReplaced = useCallback((oldId: string, newId: string) => {
    setReplacedBy((prev) => {
      if (prev[oldId] === newId) return prev;
      const next: Record<string, string> = {};
      for (const [from, to] of Object.entries(prev)) next[from] = to === oldId ? newId : to;
      next[oldId] = newId;
      return next;
    });
    onSessionReplaced?.(oldId, newId);
  }, [onSessionReplaced]);

  // The task's own slot wins (it is what every other surface resolves); the
  // launch response covers the window before that slot is persisted; the
  // replacement chain covers a panel that re-minted its own session.
  const sessionId = useMemo(() => {
    if (!selectedTaskId) return null;
    const own = selectedTask ? resolveTaskSessionId(selectedTask) : null;
    const base = own ?? (launched?.taskId === selectedTaskId ? launched.sessionId ?? null : null);
    if (!base) return null;
    // ONE hop: the map is compressed on record (see handleSessionReplaced).
    const next = replacedBy[base];
    return next && next !== base ? next : base;
  }, [selectedTaskId, selectedTask, launched, replacedBy]);

  // 'loading' is the FIRST-PAINT state only: the store starts empty, and reading
  // that as "no asks" flashed the composer (and stole focus) on every page load.
  const view: 'new' | 'pending' | 'session' | 'loading' = pending
    ? 'pending'
    : newMode ? 'new'
      : tabs.length > 0 ? 'session'
        : tasksLoading ? 'loading' : 'new';

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    onSelectionChangeRef.current?.({ taskId: selectedTaskId, sessionId });
  }, [selectedTaskId, sessionId]);

  // Ask Walnut's own launch memory (the model last picked FOR an Ask Walnut
  // session, at a launch or in a running session's picker) seeds the pill each
  // time the composer opens, so it shows what the launch will carry — the same
  // seeding the draft tab does (MainPage.handleDraftWalnutToggle). Fetched per
  // open, never cached: a pick made in a running session a minute ago must show
  // now. The server applies the memory to a launch that names no model, so a
  // send that beats this fetch still lands on it; a stale response must not
  // override a model the user set since the open (`undefined` = untouched;
  // the Auto row leaves 'default'), hence the generation guard.
  const draftOpenGen = useRef(0);
  useEffect(() => {
    if (view !== 'new') return;
    const gen = ++draftOpenGen.current;
    fetchAskWalnutLaunch().then((mem) => {
      if (!mem.model || gen !== draftOpenGen.current) return;
      setDraftMeta((m) => (m.model === undefined ? { ...m, model: mem.model } : m));
    }).catch(() => { /* pill stays on Auto */ });
  }, [view]);

  /**
   * Which launch the slot is still listening to.
   *
   * Any navigation (New, a tab click) bumps it, so a POST that resolves AFTER the
   * user moved on lands under a stale generation and touches neither the
   * selection nor the pending state. Without this, a launch that took 20s yanked
   * the user off the tab they had switched to — and a FAILED one replaced the
   * conversation they were reading with a Retry screen for a message they had
   * already left behind.
   */
  const launchGenRef = useRef(0);

  /** The launch response only covers the task the slot is SHOWING. Once the
   *  selection points elsewhere the placeholder is a phantom row, so drop it —
   *  the task itself is real and arrives with the next store refresh. */
  const dropLaunchedUnless = useCallback((taskId: string | null) => {
    setLaunched((prev) => (prev && prev.taskId !== taskId ? null : prev));
  }, []);

  const startNew = useCallback(() => {
    launchGenRef.current++;
    dropLaunchedUnless(selectedTaskIdRef.current);
    setPending(null);
    setDraftMeta(initialDraftMeta());
    setNewMode(true);
  }, [dropLaunchedUnless]);

  const selectTab = useCallback((taskId: string) => {
    launchGenRef.current++;
    dropLaunchedUnless(taskId);
    setPending(null);
    setNewMode(false);
    setSelectedTaskId(taskId);
  }, [dropLaunchedUnless]);

  // ── The launch ──

  const runLaunch = useCallback(async (launch: PendingLaunch): Promise<boolean> => {
    const gen = ++launchGenRef.current;
    setPending({ payload: launch.payload, message: launch.message });
    try {
      const result = await quickStartSession(launch.payload);
      log.info('ask-walnut-slot', 'Ask Walnut launched from the home slot', {
        taskId: result.taskId, sessionId: result.sessionId ?? null,
      });
      // RE-WARM the working-dirs cache this launch just invalidated (a new
      // session = a new/updated path entry, so quickStartSession drops it).
      // Without this the cache stays cold for the rest of the page's life and
      // every later draft loses its recent-folder chips + per-directory launch
      // memory — both of which read the cache SYNCHRONOUSLY and never fetch.
      void fetchWorkingDirs().catch(() => { /* chips stay hidden until the next launch */ });
      if (gen !== launchGenRef.current) {
        log.info('ask-walnut-slot', 'Ask Walnut launch landed after the user moved on — leaving the selection alone', {
          taskId: result.taskId, sessionId: result.sessionId ?? null,
        });
        return true;
      }
      setLaunched({
        taskId: result.taskId,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        title: launch.message.split('\n')[0]?.trim() || 'Ask Walnut',
      });
      setSelectedTaskId(result.taskId);
      setNewMode(false);
      setPending(null);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('ask-walnut-slot', 'Ask Walnut launch failed', { error: message });
      if (gen !== launchGenRef.current) {
        log.info('ask-walnut-slot', 'Ask Walnut launch failed after the user moved on — not showing Retry over the new view', { error: message });
        return false;
      }
      setPending({ ...launch, error: message });
      return false;
    }
  }, []);

  /** DraftSessionPanel's Start. Returns a PROMISE always — ChatInput restores the
   *  composer only for a promise resolving false. */
  const handleStart = useCallback(async (
    _draftId: string, text: string, images?: ImageAttachment[],
  ): Promise<boolean> => {
    const message = text.trim();
    // The same payload launchQuickStart builds for a walnut draft: the server
    // owns the cwd, the engine is forced native, and `pinTier: null` (never
    // undefined) is how "don't pin" survives JSON.stringify. The model rides
    // only when the user picked one — with walnutAgent the launch engine is
    // always claude, so a pick here was necessarily made under claude.
    const payload: Parameters<typeof quickStartSession>[0] = {
      cwd: '',
      message,
      ...(images?.length ? { images } : {}),
      project: ASK_WALNUT_PROJECT,
      walnutAgent: true,
      taskMeta: {
        unread: draftMeta.unread,
        priority: draftMeta.priority,
        pinTier: draftMeta.pinTier ?? null,
        ...(draftMeta.dueDate ? { due_date: draftMeta.dueDate } : {}),
        ...(draftMeta.startDate ? { start_date: draftMeta.startDate } : {}),
        ...(draftMeta.endDate ? { end_date: draftMeta.endDate } : {}),
      },
      ...(draftMeta.model ? { model: draftMeta.model } : {}),
    };
    return runLaunch({ payload, message });
  }, [draftMeta, runLaunch]);

  const draft = useMemo<DraftColumn>(() => ({
    id: SLOT_DRAFT_ID,
    cwd: '',
    host: null,
    walnut: true,
    project: ASK_WALNUT_PROJECT,
    // 'seed', not 'user': the project is a server-owned fact here, not a pick.
    projectSource: 'seed',
    meta: draftMeta,
  }), [draftMeta]);

  const handleMetaChange = useCallback((
    _draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta,
  ) => {
    setDraftMeta((m) => updater(m));
  }, []);

  const noopDraftEdit = useCallback(() => { /* walnut mode renders no folder/project pill */ }, []);
  const alwaysKnownProject = useCallback(() => true, []);

  return (
    <div className="ask-walnut-slot" data-testid="ask-walnut-slot">
      <AskWalnutSlotHeader
        visibleTabs={visibleTabs}
        overflowTabs={overflowTabs}
        hasTabs={tabs.length > 0}
        activeTabId={view === 'session' ? selectedTaskId : null}
        onPickTab={selectTab}
        onNew={startNew}
        onOpenTaskComposer={onOpenTaskComposer}
        onOpenDraftColumn={onOpenDraftColumn}
        {...(onOpenSessionFinder ? { onOpenSessionFinder } : {})}
        {...(onFixWalnut ? { onFixWalnut } : {})}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
        onCloseChat={onCloseChat}
        {...(taskComposer ? { taskComposer } : {})}
        taskComposerOpen={taskComposerOpen === true}
      />

      {banner}
      {inspectorPanel}

      <div className="ask-walnut-slot-body">
        {view === 'loading' ? (
          <div className="ask-walnut-loading" data-testid="ask-walnut-loading">
            <p className="ask-walnut-pending-status">
              <span className="spinner ask-walnut-pending-spinner" />
              Loading your asks…
            </p>
          </div>
        ) : view === 'new' ? (
          <div className="ask-walnut-draft" data-testid="ask-walnut-draft">
            <DraftSessionPanel
              draft={draft}
              // ONLY an explicit New click takes the caret. `view` is also 'new'
              // for the DERIVED empty state (no asks yet), which is what the slot
              // shows on a plain page load — autofocusing there stole the caret
              // from whatever the user was doing, including while the whole slot
              // sat collapsed at opacity 0.
              autoFocus={newMode}
              onStart={handleStart}
              onSaveAsTask={noopDraftEdit}
              onClose={() => setNewMode(false)}
              onPathChange={noopDraftEdit}
              onProjectChange={noopDraftEdit}
              onMetaChange={handleMetaChange}
              isKnownProject={alwaysKnownProject}
            />
          </div>
        ) : view === 'pending' && pending ? (
          <div className="ask-walnut-pending" data-testid="ask-walnut-pending">
            {pending.error ? (
              <>
                <p className="ask-walnut-pending-error">Ask Walnut couldn&apos;t start: {pending.error}</p>
                <div className="ask-walnut-pending-actions">
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => { void runLaunch({ payload: pending.payload, message: pending.message }); }}
                  >
                    Retry
                  </button>
                  <button className="btn btn-sm" onClick={() => { setPending(null); setNewMode(true); }}>
                    Back
                  </button>
                </div>
              </>
            ) : (
              <p className="ask-walnut-pending-status">
                <span className="spinner ask-walnut-pending-spinner" />
                Starting Ask Walnut…
              </p>
            )}
            {pending.message && <p className="ask-walnut-pending-echo">{pending.message}</p>}
          </div>
        ) : sessionId ? (
          <div className="ask-walnut-session" data-testid="ask-walnut-session" data-session-id={sessionId}>
            <SessionPanel
              key={sessionId}
              sessionId={sessionId}
              embedded
              {...(onTaskClick ? { onTaskClick } : {})}
              {...(onOpenTaskDetail ? { onOpenTaskDetail } : {})}
              {...(onSessionClick ? { onSessionClick } : {})}
              onSessionReplaced={handleSessionReplaced}
              {...(onOpenForkDraft ? { onOpenForkDraft } : {})}
            />
          </div>
        ) : (
          <div className="ask-walnut-empty">
            <p>This ask has no session yet.</p>
            <button className="btn btn-sm btn-primary" onClick={startNew}>New</button>
          </div>
        )}
      </div>
    </div>
  );
}
