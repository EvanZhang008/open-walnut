/**
 * AskWalnutSlot — the home page's chat column.
 *
 * There is no "main agent" any more: talking to Walnut IS an ordinary
 * claude-code session bound to a task flagged `walnut_agent`, filed under the
 * agent's project (`Ask Walnut`; `Ask Mentor` for the Mentor agent, …). So this
 * slot is a VIEW over the task store: the REGULAR `SessionPanel` for the
 * selected task, exactly as a session column renders it (same header, same
 * ×/popout/fullscreen, same composer), plus ONE addition — a ≡ button at the
 * start of its title row that opens a drawer of the asks to switch between (the
 * Claude app's sidebar shape). The drawer's title is the agent switcher: every
 * console agent (Walnut, Mentor, Note Assistant, config-defined ones) has its
 * own list of asks, and New chat starts one with the agent on show. The panel's
 * × hides the slot, the way a column's × closes the column. Nothing here owns
 * conversation state; the session panel and the session queue do, exactly as
 * in a column.
 *
 * Three body states, and the transitions between them are the whole component:
 *   new      → `DraftSessionPanel` in its Ask Walnut shape (the tab users
 *              already know: copy, one-tap seeds, composer, model pill pinned to
 *              claude). Start calls quick-start DIRECTLY — no session column, no
 *              pending column, the answer streams right here.
 *   pending  → the HTTP round-trip, with the message echoed; an error keeps the
 *              payload so Retry replays the same launch.
 *   session  → `SessionPanel embedded` (every window control but lock — there
 *              is no column rotation to pin within).
 *
 * Selection persists in sessionStorage and is re-resolved whenever the task list
 * changes; the decisions live in ./ask-walnut-slot-model so they can be pinned
 * without a DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Task } from '@open-walnut/core';
import type { ImageAttachment } from '@/api/chat';
import { fetchAskWalnutLaunch, fetchWorkingDirs, quickStartSession } from '@/api/sessions';
import { DraftSessionPanel } from '@/components/sessions/DraftSessionPanel';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import type { DraftColumn } from '@/components/sessions/draft-column';
import { freshLauncherMeta } from '@/components/sessions/task-meta-constants';
import type { QuickStartTaskMeta } from '@/components/sessions/SessionPathSelector';
import { useEvent } from '@/hooks/useWebSocket';
import { getAgentsSnapshot, loadAgents, subscribeAgents } from '@/stores/agents-store';
import { log } from '@/utils/log';
import { resolveTaskSessionId } from '@/utils/session-status';
import { AskWalnutDrawer, AskWalnutMenuButton, type DrawerRow } from './AskWalnutDrawer';
import {
  GENERAL_AGENT_ID, GENERAL_ASK_AGENT, agentOfTask, resolveSelection, selectAgentTasks, toAskAgent,
  type AskAgent,
} from './ask-walnut-slot-model';
import '@/styles/walnut-agent.css';

/** Which task the slot is showing. sessionStorage (not localStorage): a tab is a
 *  per-window view, and two windows should be able to watch two asks. */
const SS_SELECTED_KEY = 'walnut:ask-slot:selected';
/** Which agent the drawer is on. Per-window like the selection; it matters on
 *  its own only while the agent has no asks (a reload must not drop the user
 *  from Mentor's empty composer back to Walnut). */
const SS_AGENT_KEY = 'walnut:ask-slot:agent';

/** The synthetic draft row's id. Fixed rather than timestamped: the slot holds at
 *  most ONE draft, and a stable id means ChatInput's persisted composer text
 *  survives a cancel → New round trip (a successful send clears it, as in any
 *  composer). */
const SLOT_DRAFT_ID = 'ask-walnut-slot';

/**
 * How long the launch response may cover for the task store.
 *
 * `launched` exists to bridge the WS echo (normally <1s). A task that never
 * arrives is a phantom row — one the user can click but nothing can ever
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
  /** Rendered above the body while the inspector is open. */
  inspectorPanel?: ReactNode;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  /** "Fix Walnut" — a draft column pre-armed on Walnut's own checkout. Absent
   *  (npm install / cloud) hides the link. */
  onFixWalnut?: () => void;
  /** Collapse the slot — the panel's own × (the Focus Dock brings it back). */
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

/** Same precedence the panel mounts with (resolveTaskSessionId). */
const hasSession = (task: Task): boolean => resolveTaskSessionId(task) !== null;

/** The launch meta a fresh slot draft opens on: the launcher baseline with the
 *  Ask Walnut seeds the draft tab applies (Focus tier, model Auto). */
function initialDraftMeta(): QuickStartTaskMeta {
  return { ...freshLauncherMeta(), pinTier: 'focus', model: undefined };
}

export function AskWalnutSlot({
  tasks, tasksLoading, banner, inspectorPanel,
  inspectorOpen, onToggleInspector, onFixWalnut, onCloseChat, onSelectionChange,
  onTaskClick, onOpenTaskDetail, onSessionClick, onSessionReplaced, onOpenForkDraft,
}: AskWalnutSlotProps) {
  // The console agents, from the shared agent store (the /agents page writes to
  // the same store, so a rename lands here without a reload). Walnut is always
  // first and always present: before the list resolves (or if it never does) the
  // slot is the plain Ask Walnut slot.
  const agentsSnapshot = useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);
  useEffect(() => { void loadAgents(); }, []);
  useEvent('agents:changed', () => { void loadAgents(true); });
  const agents = useMemo<AskAgent[]>(() => {
    const consoleAgents = agentsSnapshot.agents
      .filter((a) => a.console || a.id === GENERAL_AGENT_ID)
      .map(toAskAgent);
    const general = consoleAgents.find((a) => a.id === GENERAL_AGENT_ID) ?? GENERAL_ASK_AGENT;
    return [general, ...consoleAgents.filter((a) => a.id !== GENERAL_AGENT_ID)];
  }, [agentsSnapshot.agents]);
  // Until the registry has answered once (a failed load counts: the list is
  // then Walnut alone, for good), every agent but Walnut is unknown, and any
  // selection logic run against that stand-in list would move the user off a
  // Mentor ask onto Walnut's newest — and, once the real list landed, back.
  const agentsLoaded = agentsSnapshot.agentsLoaded;

  const [agentId, setAgentId] = useState<string>(() => {
    try { return sessionStorage.getItem(SS_AGENT_KEY) || GENERAL_AGENT_ID; } catch { return GENERAL_AGENT_ID; }
  });
  // An agent id nobody knows (deleted from config, a stale key) falls back to
  // Walnut rather than to an empty drawer with an unnamed title.
  const agent = useMemo(() => agents.find((a) => a.id === agentId) ?? agents[0] ?? GENERAL_ASK_AGENT, [agents, agentId]);
  useEffect(() => {
    try { sessionStorage.setItem(SS_AGENT_KEY, agentId); } catch { /* per-render only */ }
  }, [agentId]);

  const askTasks = useMemo(() => selectAgentTasks(tasks, agent), [tasks, agent]);
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
  /** The ≡ drawer. Closed on every pick; not persisted (it is a gesture, not a view). */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** The ≡ button, wherever the current body renders it — where the drawer
   *  returns focus when the element that had it is gone. */
  const menuBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      if (selectedTaskId) sessionStorage.setItem(SS_SELECTED_KEY, selectedTaskId);
      else sessionStorage.removeItem(SS_SELECTED_KEY);
    } catch { /* storage disabled — selection is per-render only */ }
  }, [selectedTaskId]);

  // Ref mirrors for the []-dep callbacks below (they must not be re-created on
  // every selection change — DraftSessionPanel and the drawer take them as props).
  const selectedTaskIdRef = useRef(selectedTaskId);
  selectedTaskIdRef.current = selectedTaskId;
  const askTasksRef = useRef(askTasks);
  askTasksRef.current = askTasks;

  // ONE reconciler for the pair (agent, selection), with a fixed precedence,
  // run whenever either input moves:
  //   1. The ask on show owns the agent. If the selected task exists and one of
  //      the known agents owns it (stamp first, project second), the drawer moves
  //      to THAT agent and the selection is left alone. The two persisted keys
  //      can disagree (a window restored with one agent's ask and another agent
  //      in the drawer, a task re-filed by hand), and the task is the thing the
  //      user is looking at.
  //   2. Otherwise the selection is re-resolved within the agent's list: a
  //      deleted/archived selection falls back to the newest ask WITH a
  //      conversation (a todo filed under the project by hand stays pickable but
  //      is never the default), an empty list to nothing (the composer).
  // Two effects doing these separately ping-ponged forever when the keys
  // disagreed: one moved the selection to the agent, the other moved the agent
  // to the (stale) selection, each commit undoing the last. Here a run changes
  // at most one of the two, and the next run finds them agreeing.
  // The just-launched task is EXEMPT until the store carries it — re-resolving
  // there would yank the user off the ask they just sent, for the second the
  // WS echo takes to land. selectAgent never trips step 1: it re-points the
  // selection at the new agent's ask (or nothing) in the same act.
  useEffect(() => {
    if (!agentsLoaded) return;
    if (selectedTaskId) {
      const task = tasks.find((t) => t.id === selectedTaskId);
      const owner = task ? agentOfTask(task, agents) : null;
      if (owner && owner.id !== agent.id) {
        setAgentId(owner.id);
        return;
      }
    }
    if (launched && selectedTaskId === launched.taskId
      && !askTasks.some((t) => t.id === selectedTaskId)) return;
    const next = resolveSelection(selectedTaskId, askTasks, hasSession);
    if (next !== selectedTaskId) setSelectedTaskId(next);
  }, [agentsLoaded, tasks, agents, agent, askTasks, selectedTaskId, launched]);

  // Once the store carries the launched task WITH its session slot, the launch
  // response has nothing left to cover — drop it, so a later delete of that ask
  // is not shadowed by a phantom row until reload.
  useEffect(() => {
    if (!launched) return;
    const own = askTasks.find((t) => t.id === launched.taskId);
    if (own && resolveTaskSessionId(own)) setLaunched(null);
  }, [askTasks, launched]);

  // Second exit, for the launch whose task NEVER arrives (created under a
  // different flag, deleted right after, a lost WS echo): after the grace window
  // the placeholder is a row that can never resolve, so drop it. A task that IS
  // in the store keeps its bridge — the effect above owns that case, and pulling
  // the launch response out from under a task whose session slot has not landed
  // yet would blank the panel.
  useEffect(() => {
    if (!launched) return;
    const timer = setTimeout(() => {
      // The store check reads the ref OUTSIDE the updater: a state updater must
      // stay pure (React can call it twice), and the log below is a side effect.
      if (askTasksRef.current.some((t) => t.id === launched.taskId)) return;
      log.warn('ask-walnut-slot', 'the launched Ask Walnut task never reached the task store — dropping its placeholder row', {
        taskId: launched.taskId, sessionId: launched.sessionId ?? null,
      });
      setLaunched((prev) => (prev && prev.taskId === launched.taskId ? null : prev));
    }, LAUNCHED_GRACE_MS);
    return () => clearTimeout(timer);
  }, [launched]);

  // The drawer's list: every ask of the agent on show, newest first, with the
  // just-launched one on top until the store carries it.
  const rows = useMemo<DrawerRow[]>(() => {
    const list = askTasks.map((t) => ({ id: t.id, title: t.title || agent.project, task: t }));
    if (launched && !askTasks.some((t) => t.id === launched.taskId)) {
      return [{ id: launched.taskId, title: launched.title }, ...list];
    }
    return list;
  }, [askTasks, launched, agent]);

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

  // 'loading' is the FIRST-PAINT state only: the task store starts empty, and
  // reading that as "no asks" flashed the composer (and stole focus) on every
  // page load. The agent list is part of first paint too: until it answers the
  // list on screen would be Walnut's whatever agent the window was on.
  const view: 'new' | 'pending' | 'session' | 'loading' = pending
    ? 'pending'
    : newMode ? 'new'
      : rows.length > 0 && agentsLoaded ? 'session'
        : (tasksLoading || !agentsLoaded) ? 'loading' : 'new';

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
   * Any navigation (New, a drawer pick) bumps it, so a POST that resolves AFTER the
   * user moved on lands under a stale generation and touches neither the
   * selection nor the pending state. Without this, a launch that took 20s yanked
   * the user off the ask they had switched to — and a FAILED one replaced the
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

  const selectAsk = useCallback((taskId: string) => {
    launchGenRef.current++;
    dropLaunchedUnless(taskId);
    setPending(null);
    setNewMode(false);
    setSelectedTaskId(taskId);
  }, [dropLaunchedUnless]);

  // Switch the drawer (and the slot) to another agent: its newest ask with a
  // conversation comes up, or, when it has none yet, its composer — the way
  // picking a project in the Claude sidebar shows that project's chats. The
  // selection is re-pointed HERE, in the same act, so the follow-the-task effect
  // above has nothing to correct. A launch still in flight belongs to the agent
  // the user just left; its response must not pull them back.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const selectAgent = useCallback((id: string) => {
    const next = agentsRef.current.find((a) => a.id === id);
    if (!next) return;
    launchGenRef.current++;
    setLaunched(null);
    setPending(null);
    setNewMode(false);
    // A fresh composer for the new agent: the model/dates picked for the old
    // one's draft are not this agent's.
    setDraftMeta(initialDraftMeta());
    setAgentId(next.id);
    setSelectedTaskId(resolveSelection(null, selectAgentTasks(tasksRef.current, next), hasSession));
  }, []);

  const toggleDrawer = useCallback(() => setDrawerOpen((v) => !v), []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

  // The panel's × — the same control a session column has, meaning "put this
  // away": the slot collapses (the Focus Dock brings it back). Stable so the
  // memo'd SessionPanel is not re-rendered by a fresh closure each tick.
  const onCloseChatRef = useRef(onCloseChat);
  onCloseChatRef.current = onCloseChat;
  const hideSlot = useCallback(() => onCloseChatRef.current(), []);
  // The composer's ×: back to the conversation it was opened over, or, when
  // there is none to go back to, away like the panel's.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const closeDraft = useCallback(() => {
    if (rowsRef.current.length) setNewMode(false);
    else onCloseChatRef.current();
  }, []);

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
        title: launch.message.split('\n')[0]?.trim() || launch.payload.project || 'Ask Walnut',
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
      project: agent.project,
      walnutAgent: true,
      // Absent for Walnut: the server's default, and the payload the draft
      // column's Ask Walnut card has always sent.
      ...(agent.id !== GENERAL_AGENT_ID ? { agentId: agent.id } : {}),
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
  }, [draftMeta, runLaunch, agent]);

  const draft = useMemo<DraftColumn>(() => ({
    // Per agent: the composer's persisted text rides the draft id, and a
    // sentence typed for Mentor must not come back in Walnut's composer.
    id: agent.id === GENERAL_AGENT_ID ? SLOT_DRAFT_ID : `${SLOT_DRAFT_ID}:${agent.id}`,
    cwd: '',
    host: null,
    walnut: true,
    ...(agent.id !== GENERAL_AGENT_ID
      ? { agent: { id: agent.id, name: agent.name, ...(agent.description ? { description: agent.description } : {}) } }
      : {}),
    project: agent.project,
    // 'seed', not 'user': the project is a server-owned fact here, not a pick.
    projectSource: 'seed',
    meta: draftMeta,
  }), [draftMeta, agent]);

  const handleMetaChange = useCallback((
    _draftId: string, updater: (m: QuickStartTaskMeta) => QuickStartTaskMeta,
  ) => {
    setDraftMeta((m) => updater(m));
  }, []);

  const noopDraftEdit = useCallback(() => { /* walnut mode renders no folder/project pill */ }, []);
  const alwaysKnownProject = useCallback(() => true, []);

  // The ONE thing this slot adds to the regular panels: the ≡ session switcher,
  // rendered by whichever body is on screen so it always sits at the top-left.
  // Memoized because it is a PROP of the memo'd SessionPanel: a fresh element on
  // every slot render (and the slot re-renders on every task-store tick) would
  // defeat that memo and re-render the whole transcript each time.
  const menuButton = useMemo(
    () => <AskWalnutMenuButton ref={menuBtnRef} open={drawerOpen} onToggle={toggleDrawer} label={agent.project} />,
    [drawerOpen, toggleDrawer, agent.project],
  );

  return (
    <div className="ask-walnut-slot" data-testid="ask-walnut-slot">
      {banner}
      {inspectorPanel}

      <div className="ask-walnut-slot-body">
        {view === 'loading' ? (
          <div className="ask-walnut-loading" data-testid="ask-walnut-loading">
            <div className="ask-walnut-bare-header">{menuButton}</div>
            <p className="ask-walnut-pending-status">
              <span className="spinner ask-walnut-pending-spinner" />
              Loading your asks…
            </p>
          </div>
        ) : view === 'new' ? (
          <div className="ask-walnut-draft" data-testid="ask-walnut-draft">
            <DraftSessionPanel
              draft={draft}
              headerLeading={menuButton}
              // ONLY an explicit New click takes the caret. `view` is also 'new'
              // for the DERIVED empty state (no asks yet), which is what the slot
              // shows on a plain page load — autofocusing there stole the caret
              // from whatever the user was doing, including while the whole slot
              // sat collapsed at opacity 0.
              autoFocus={newMode}
              onStart={handleStart}
              onSaveAsTask={noopDraftEdit}
              onClose={closeDraft}
              onPathChange={noopDraftEdit}
              onProjectChange={noopDraftEdit}
              onMetaChange={handleMetaChange}
              isKnownProject={alwaysKnownProject}
            />
          </div>
        ) : view === 'pending' && pending ? (
          <div className="ask-walnut-pending" data-testid="ask-walnut-pending">
            <div className="ask-walnut-bare-header">{menuButton}</div>
            {pending.error ? (
              <>
                <p className="ask-walnut-pending-error">{agent.project} couldn&apos;t start: {pending.error}</p>
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
                Starting {agent.project}…
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
              headerLeading={menuButton}
              onClose={hideSlot}
              {...(onTaskClick ? { onTaskClick } : {})}
              {...(onOpenTaskDetail ? { onOpenTaskDetail } : {})}
              {...(onSessionClick ? { onSessionClick } : {})}
              onSessionReplaced={handleSessionReplaced}
              {...(onOpenForkDraft ? { onOpenForkDraft } : {})}
            />
          </div>
        ) : (
          <div className="ask-walnut-empty">
            <div className="ask-walnut-bare-header">{menuButton}</div>
            <p>This ask has no session yet.</p>
            <button className="btn btn-sm btn-primary" onClick={startNew}>New</button>
          </div>
        )}
      </div>

      <AskWalnutDrawer
        open={drawerOpen}
        onClose={closeDrawer}
        returnFocusRef={menuBtnRef}
        agents={agents}
        agent={agent}
        onPickAgent={selectAgent}
        rows={rows}
        selectedTaskId={view === 'session' ? selectedTaskId : null}
        onPick={selectAsk}
        onNew={startNew}
        {...(onFixWalnut ? { onFixWalnut } : {})}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
      />
    </div>
  );
}
