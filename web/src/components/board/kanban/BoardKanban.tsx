/**
 * The Board tab's Cards view (spec 2 to 9): the team's direct subtasks as a
 * kanban. The header (rollup, chips, search, lane strip) stays fixed above the
 * lanes; the lanes scroll sideways in wide mode and fold as sections in narrow
 * mode (pane width, useKanbanLayout). Owns the write layer (useKanbanWrites,
 * optimistic overlays), the G9 freeze, the keyboard (roving tab stops, arrow
 * keys, the keyboard drag), Show / jump to lane, the toasts, and the narrow
 * card detail. A replica (or a 501) is read only: no drag sensor, every write
 * control aria-disabled with READ_ONLY_TITLE.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTasksContextSafe } from '@/contexts/TasksContext';
import { log } from '@/utils/log';
import { locateTaskOnHome } from '@/utils/open-session';
import { deletePreview as previewDelete, type BoardCard, type BoardKanbanSeenCard } from '../../../../../src/core/boards/board-lanes';
import type { BoardPayload, BoardSeen } from '../board-model';
import type { KanbanBoardVM } from './kanban-model';
import type { KanbanWriteApi } from './kanban-contract';
import { buildBoardVM } from './kanban-model';
import { announce, keyDropResult, keyPosition, startKeyDrag, stepKeyDrag, type KeyDrag, type KeyLane } from './kanban-dnd';
import { useKanbanFreeze, type KanbanLayout } from './kanban-freeze';
import { withDrawnLanes } from './kanban-drawn';
import { KanbanCardContext, type KanbanCardCtx } from './KanbanCard';
import { KanbanCardDetail, type KanbanRenderSession } from './KanbanCardDetail';
import { KanbanEmpty } from './KanbanEmpty';
import { KanbanLanes, lastPointer, type KanbanDropState } from './KanbanLanes';
import { useHoverAnchor } from './useHoverAnchor';
import { useKanbanBoard } from './useKanbanBoard';
import { useKanbanLayout } from './useKanbanLayout';
import { useKanbanWrites } from './useKanbanWrites';
import { KanbanHeader } from './KanbanHeader';
import { useKanbanFilter } from './useKanbanFilter';
import { NO_PROJECTS, type ProjectOf } from '../board-view-projects';
import { useKanbanSeen } from './useKanbanSeen';
import { KanbanLeaderRow } from './KanbanLeaderRow';
import { KanbanAddLane } from './KanbanAddLane';
import { KanbanToasts, useKanbanToasts } from './KanbanToasts';
import '@/styles/board-kanban.css';
import '@/styles/board-kanban-controls.css';

export interface BoardKanbanProps {
  ownerId: string;
  payload: BoardPayload | null;
  threadSeen: BoardSeen;
  fetchStartedAt: number;
  reloadKanban(): void;
  /** Cards view on screen (false = the Page is shown; the board stays mounted). */
  visible: boolean;
  /** A card opened beside the board (the session panel's peek). */
  onOpenTask?: (taskId: string) => void;
  /** A red board signal: switch to the Page and scroll to it. */
  onOpenSignal(target: { kind: 'choice' | 'thread'; id: string }): void;
  /** The team's attention number (G12) for the view toggle. */
  onAttention?: (n: number) => void;
  /** Under the empty board card (`Ask the leader for a page`). */
  emptyExtra?: ReactNode;
  /** A narrow board's opened card shows its session here (R3-05). */
  renderSession?: KanbanRenderSession;
  /** Each card's board project (the Projects view's placement): the card's project chip and the project filter. */
  projectOf?: ProjectOf;
}

const FLASH_MS = 1200;
const LANE_FLASH_MS = 600;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mq) return;
    const on = () => setReduced(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

const cardEl = (root: HTMLElement | null, taskId: string) =>
  root?.querySelector<HTMLElement>(`[data-testid="kanban-card"][data-task-id="${CSS.escape(taskId)}"]`) ?? null;
const laneEl = (root: HTMLElement | null, laneId: string) => root?.querySelector<HTMLElement>(
  `[data-testid="kanban-lane"][data-lane-id="${CSS.escape(laneId)}"], [data-testid="kanban-done-rail"][data-lane-id="${CSS.escape(laneId)}"]`) ?? null;
const EMPTY_VM = (ownerId: string): KanbanBoardVM => buildBoardVM({
  ownerId, owner: null, taskOf: () => undefined, team: [], payload: null, liveOf: () => null, now: 0, titleOf: () => '',
});

export function BoardKanban({
  ownerId, payload, threadSeen, fetchStartedAt, reloadKanban, visible, onOpenTask, onOpenSignal, onAttention, emptyExtra, renderSession,
  projectOf = NO_PROJECTS,
}: BoardKanbanProps) {
  const navigate = useNavigate();
  const reducedMotion = usePrefersReducedMotion();
  const rootEl = useRef<HTMLDivElement | null>(null);
  const scrollEl = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const toasts = useKanbanToasts();
  const vmRef = useRef<KanbanBoardVM | null>(null);
  const cardsRef = useRef<Record<string, BoardCard>>({});
  const layoutRef = useRef<KanbanLayout>({});
  const taskOfRef = useRef<(id: string) => { phase?: string } | undefined>(() => undefined);
  const [flash, setFlash] = useState<ReadonlySet<string>>(() => new Set());
  const [flashingLane, setFlashingLane] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const revealRef = useRef<(taskId: string) => void>(() => undefined);
  const applyNowRef = useRef<() => void>(() => undefined);
  const savedScroll = useRef<number | null>(null);

  const store = useTasksContextSafe();
  const storeRef = useRef(store);
  storeRef.current = store;
  /** Opening a card is looking at its output, as opening its task row is. */
  const markRead = useCallback((taskId: string) => {
    const s = storeRef.current;
    if (s?.tasks.some((t) => t.id === taskId && t.unread)) s.update(taskId, { unread: false });
  }, []);
  const openSession = useCallback((taskId: string, sessionId?: string) => {
    markRead(taskId);
    log.info('board', 'kanban card session opened', { taskId: ownerId, cardTaskId: taskId, sessionId: sessionId ?? '' });
    locateTaskOnHome(taskId, navigate, sessionId ? { sessionId } : undefined);
  }, [navigate, ownerId, markRead]);
  const openBeside = useCallback((taskId: string) => {
    markRead(taskId);
    if (onOpenTask) onOpenTask(taskId);
    else openSession(taskId, vmRef.current?.cards[taskId]?.sessionId);
  }, [onOpenTask, openSession, markRead]);
  const storePhase = useCallback((id: string) => taskOfRef.current(id)?.phase, []);

  const writes = useKanbanWrites({
    ownerId, getVM: () => vmRef.current, getCards: () => cardsRef.current, getLaneOrder: (l) => layoutRef.current[l],
    fetchStartedAt, reloadKanban, toasts, storePhase,
    onApplied: () => applyNowRef.current(), onReveal: (id) => revealRef.current(id), onOpenTask: openBeside,
    // After the render that placed the card where the phase put it, so the baseline holds the new lane.
    onHumanPhase: (id) => { setTimeout(() => markSeenRef.current(id), 0); },
  });
  const api = writes.api;
  const getSnapshot = useCallback((): Record<string, BoardKanbanSeenCard> => {
    const out: Record<string, BoardKanbanSeenCard> = {};
    for (const [id, c] of Object.entries(vmRef.current?.cards ?? {})) if (!c.loading) out[id] = c.snapshot;
    return out;
  }, []);
  const seen = useKanbanSeen(ownerId, payload, { visible, getSnapshot });
  const markSeenRef = useRef(seen.markCardSeen);
  markSeenRef.current = seen.markCardSeen;
  const board = useKanbanBoard({ ownerId, payload, threadSeen, baseline: seen.baseline, overlays: writes.overlays });
  const empty = useMemo(() => EMPTY_VM(ownerId), [ownerId]);
  const vm = board.vm ?? empty;
  vmRef.current = board.vm;
  cardsRef.current = board.cards;
  taskOfRef.current = board.taskOf;
  const filter = useKanbanFilter(vm, projectOf);
  const matchesIn = useCallback((laneId: string) =>
    (vm.lanes.find((l) => l.lane.id === laneId)?.cardIds ?? []).filter((id) => filter.isVisible(id)).length, [vm, filter]);
  const view = useKanbanLayout(ownerId, { filterActive: filter.active, matchesIn });
  const mode = view.mode;
  // Stable: an inline callback ref is re-attached on every render, re-measuring the pane (a forced layout) each drag move.
  const setRoot = useCallback((el: HTMLDivElement | null) => { rootEl.current = el; view.rootRef(el); }, [view.rootRef]);
  useEffect(() => { onAttention?.(vm.attention); }, [vm.attention, onAttention]);
  // C50: one mark per mount when the cards are first on screen and live.
  const markedReady = useRef(false);
  useEffect(() => {
    if (markedReady.current || !board.vm || vm.loading) return;
    markedReady.current = true;
    performance.mark?.('kanban:interactive', { detail: { ownerId, cards: Object.keys(vm.cards).length } });
    log.info('board', 'kanban interactive', { taskId: ownerId, cards: Object.keys(vm.cards).length, at: Math.round(performance.now()) });
  }, [board.vm, vm.loading, vm.cards, ownerId]);
  // ── G9 freeze: the drawn layout ──
  // N5: nothing is laid out while the board still loads (the task store, the team's statuses):
  // the lanes show their skeletons, and the first layout drawn is the settled one, so a reload
  // never re-sorts cards under the user or flashes them as moved.
  const liveLayout = useMemo<KanbanLayout>(() => Object.fromEntries(vm.lanes.map((l) => [l.lane.id, vm.loading ? [] : l.cardIds])), [vm.lanes, vm.loading]);
  const freeze = useKanbanFreeze(liveLayout);
  applyNowRef.current = freeze.applyNow;
  layoutRef.current = freeze.layout;
  const hold = freeze.hold;
  // N1: heads, strip and rail count the cards drawn, not the live layout under a held lane.
  const shown = useMemo(() => withDrawnLanes(vm, freeze.layout), [vm, freeze.layout]);

  // A card that turns changed while the user looks flashes once (8.4), not under reduced motion.
  const changedBefore = useRef<Set<string> | null>(null);
  useEffect(() => {
    const now = new Set(Object.values(vm.cards).filter((c) => c.changed).map((c) => c.taskId));
    const before = changedBefore.current;
    changedBefore.current = now;
    if (!before || !visible || reducedMotion) return;
    const fresh = [...now].filter((id) => !before.has(id));
    if (fresh.length) flashCards(fresh);
  }, [vm.cards]); // eslint-disable-line react-hooks/exhaustive-deps
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flashCards(ids: string[]): void {
    setFlash(new Set(ids));
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(new Set()), FLASH_MS);
  }

  // ── Show (G14) and the lane strip's jump ──
  const flashLane = (laneId: string) => {
    setFlashingLane(laneId);
    setTimeout(() => setFlashingLane((cur) => (cur === laneId ? null : cur)), LANE_FLASH_MS);
  };
  const onJumpToLane = useCallback((laneId: string) => {
    const el = laneEl(rootEl.current, laneId);
    el?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
    flashLane(laneId);
    log.info('board', 'kanban lane jumped to', { taskId: ownerId, lane: laneId });
  }, [ownerId, reducedMotion]);
  const reveal = (taskId: string) => {
    const v = vmRef.current;
    const card = v?.cards[taskId];
    if (!v || !card) return;
    const lane = v.lanes.find((l) => l.lane.id === card.lane);
    if (detail) setDetail(null);
    if (filter.active && !filter.isVisible(taskId)) { filter.setChip(null); filter.setQuery(''); filter.setProject(null); }
    if (lane?.lane.kind === 'done') {
      if (view.mode === 'wide') view.setRailOpen(lane.lane.id, true);
      if (lane.cardIds.indexOf(taskId) >= 5) view.setShowAll(lane.lane.id, true);
    }
    if (lane) view.unfold(lane.lane.id);
    flashCards([taskId]);
    // After the unfold renders.
    setTimeout(() => {
      const el = cardEl(rootEl.current, taskId);
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      el?.focus({ preventScroll: true });
    }, 60);
  };
  revealRef.current = reveal;

  // ── Roving tab stops (G35): one per lane, the card last focused there ──
  const [focusedIn, setFocusedIn] = useState<Record<string, string>>({});
  const drawnOf = useCallback((laneId: string): string[] => {
    const order = freeze.layout[laneId] ?? [];
    return filter.active ? order.filter((id) => filter.isVisible(id) || filter.isHandled(id)) : [...order];
  }, [freeze.layout, filter]);
  const tabStops = useMemo(() => {
    const out: Record<string, string> = {};
    for (const l of vm.lanes) {
      const drawn = drawnOf(l.lane.id);
      const want = focusedIn[l.lane.id];
      const pick = want && drawn.includes(want) ? want : drawn[0];
      if (pick) out[l.lane.id] = pick;
    }
    return out;
  }, [vm.lanes, drawnOf, focusedIn]);

  // ── The keyboard drag (8.2) ──
  const [keyDrag, setKeyDrag] = useState<KeyDrag | null>(null);
  const [said, setSaid] = useState('');
  const say = useCallback((text: string) => setSaid(text), []);
  const keyLanes = (): KeyLane[] => vm.lanes.map((l) => ({ id: l.lane.id, name: l.lane.name, kind: l.lane.kind, shown: drawnOf(l.lane.id), order: freeze.layout[l.lane.id] ?? l.cardIds }));
  const focusCard = (taskId: string) => setTimeout(() => cardEl(rootEl.current, taskId)?.focus(), 0);
  const keyDropState: KanbanDropState | null = useMemo(() => {
    if (!keyDrag) return null;
    const r = keyDropResult(keyDrag, keyLanes());
    return { lane: r.lane, lineBefore: r.lineBefore, index: r.index };
  }, [keyDrag]); // eslint-disable-line react-hooks/exhaustive-deps

  // N3: the keyboard drag's target comes into view (the lane sideways, the line in it), as a pointer drag's would.
  useEffect(() => {
    if (!keyDropState) return;
    const root = rootEl.current;
    const at = root?.querySelector<HTMLElement>('[data-testid="kanban-key-ghost"]')
      ?? root?.querySelector<HTMLElement>(`[data-testid="kanban-done-rail"][data-lane-id="${CSS.escape(keyDropState.lane)}"]`);
    if (!at) return;
    // Instant, and the sideways scroll by hand: WebKit's smooth scrollIntoView left the lanes row where it was.
    at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const row = scrollEl.current;
    if (row && mode === 'wide') {
      const r = at.getBoundingClientRect(), b = row.getBoundingClientRect();
      const dx = r.left < b.left ? r.left - b.left - 12 : r.right > b.right ? r.right - b.right + 12 : 0;
      if (dx) row.scrollLeft += dx;
    }
  }, [keyDropState?.lane, keyDropState?.lineBefore, keyDropState?.index]); // eslint-disable-line react-hooks/exhaustive-deps

  const cardKey = (e: KeyboardEvent<HTMLDivElement>, taskId: string, laneId: string): boolean => {
    const lanes = keyLanes();
    if (keyDrag) {
      e.preventDefault();
      if (e.key === 'Escape') { setKeyDrag(null); hold('key-drag', false); say(announce.cancelled()); return true; }
      if (e.key === ' ' || e.key === 'Enter') {
        const r = keyDropResult(keyDrag, lanes);
        const lane = lanes.find((l) => l.id === r.lane);
        const pos = keyPosition(keyDrag, lanes).position;
        setKeyDrag(null);
        hold('key-drag', false);
        say(announce.dropped(keyDrag.title, lane?.name ?? r.lane, pos));
        const same = r.lane === keyDrag.fromLane;
        void api.moveCard(keyDrag.taskId, r.lane, { index: r.index, rankOnly: same, reason: 'keyboard' }).then(() => focusCard(keyDrag.taskId));
        return true;
      }
      const next = stepKeyDrag(keyDrag, e.key, lanes);
      if (next !== keyDrag) {
        setKeyDrag(next);
        const lp = keyPosition(next, lanes);
        say(announce.over(next.title, lanes[next.laneIndex].name, lp.position, lp.of));
      }
      return true;
    }
    if (e.key === ' ' && !api.readOnly) {
      const s = startKeyDrag(lanes, taskId, vm.cards[taskId]?.title ?? taskId);
      if (!s) return false;
      e.preventDefault();
      setKeyDrag(s);
      hold('key-drag', true);
      say(announce.picked(s.title));
      return true;
    }
    const drawn = drawnOf(laneId);
    const i = drawn.indexOf(taskId);
    let to: string | undefined;
    if (e.ctrlKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const li = vm.lanes.findIndex((l) => l.lane.id === laneId);
      for (let j = li + (e.key === 'ArrowRight' ? 1 : -1); j >= 0 && j < vm.lanes.length; j += e.key === 'ArrowRight' ? 1 : -1) {
        const stop = tabStops[vm.lanes[j].lane.id];
        if (stop) { to = stop; break; }
      }
    } else if (e.key === 'ArrowDown') to = drawn[i + 1];
    else if (e.key === 'ArrowUp') to = drawn[i - 1];
    else if (e.key === 'Home') to = drawn[0];
    else if (e.key === 'End') to = drawn[drawn.length - 1];
    else return false;
    e.preventDefault();
    if (to) cardEl(rootEl.current, to)?.focus();
    return true;
  };
  const cardKeyRef = useRef(cardKey);
  cardKeyRef.current = cardKey;

  // ── The cards' stable context ──
  const leader = vm.leader;
  const leaderInfo = useMemo(() => ({
    taskId: ownerId, title: leader?.title ?? '', ...(leader?.sessionId ? { sessionId: leader.sessionId } : {}),
  }), [ownerId, leader?.title, leader?.sessionId]);
  // Same lane definitions, same array: the cards' context must not move on a status update (G36).
  const lanesKey = JSON.stringify(vm.lanes.map((l) => l.lane));
  const lanesList = useMemo(() => vm.lanes.map((l) => l.lane), [lanesKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // The callbacks above move with the store (the pane's openTask reads it), so the
  // cards reach them through a ref: one status update re-renders one card (G36).
  const live = useRef({ api, openBeside, openSession, onOpenSignal, markSeen: seen.markCardSeen, hold });
  live.current = { api, openBeside, openSession, onOpenSignal, markSeen: seen.markCardSeen, hold };
  const cardReadOnly = api.readOnly;
  const cardApi = useMemo<KanbanWriteApi>(() => ({
    readOnly: cardReadOnly,
    saveLanes: (next) => live.current.api.saveLanes(next),
    moveCard: (id, lane, opts) => live.current.api.moveCard(id, lane, opts),
    setCard: (id, patch, since) => live.current.api.setCard(id, patch, since),
    addTask: (lane, title, tags) => live.current.api.addTask(lane, title, tags),
    completeTask: (id) => live.current.api.completeTask(id),
    reopenTask: (id) => live.current.api.reopenTask(id),
    answerSuggestion: (id, action) => live.current.api.answerSuggestion(id, action),
  }), [cardReadOnly]);
  // Its parts, never `filter` itself: that changes with every status push, and ctx re-renders every card.
  const { project: projectFilter, setProject } = filter;
  const ctx = useMemo<KanbanCardCtx>(() => ({
    api: cardApi, ownerId, mode, lanes: lanesList, leader: leaderInfo, reducedMotion,
    getCard: (id) => cardsRef.current[id],
    openTask: (id) => {
      log.info('board', 'kanban card opened', { taskId: ownerId, cardTaskId: id, mode: modeRef.current });
      if (modeRef.current === 'narrow') { savedScroll.current = scrollEl.current?.scrollTop ?? 0; markRead(id); setDetail(id); } else live.current.openBeside(id);
    },
    openSession: (id, sid) => live.current.openSession(id, sid),
    openSignal: (target) => live.current.onOpenSignal(target),
    markSeen: (id) => live.current.markSeen(id),
    hold: (reason, on, scope) => live.current.hold(reason, on, scope),
    cardKey: (e, id, lane) => cardKeyRef.current(e, id, lane),
    focused: (id, lane) => setFocusedIn((cur) => (cur[lane] === id ? cur : { ...cur, [lane]: id })),
    projectOf, projectFilter, toggleProject: (id) => setProject(projectFilter === id ? null : id),
  }), [cardApi, ownerId, mode, lanesList, leaderInfo, reducedMotion, markRead, projectOf, projectFilter, setProject]);

  const deletePreview = useCallback((laneId: string) => previewDelete(board.lanes, laneId, Object.keys(vm.cards).map((id) => {
    const t = board.taskOf(id);
    return { card: board.cards[id] ?? null, task: { phase: t?.phase ?? '', completed_at: t?.completed_at, hasHadSession: !!(t?.session_ids?.length) } };
  })), [board, vm.cards]);

  const onLaneAdded = useCallback((laneId: string) => {
    setTimeout(() => {
      const el = laneEl(rootEl.current, laneId);
      el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      el?.querySelector<HTMLElement>('[data-testid="kanban-add-task"]')?.focus();
    }, 50);
  }, []);

  // G9: the pointer in the lanes or a card holding focus holds the layout.
  // The focus hold follows document.activeElement, not the events alone: a focused node that
  // leaves the DOM fires no focusout, and a hold that never ends freezes the board for good.
  const focusInCard = () => {
    const a = document.activeElement as HTMLElement | null;
    return !!a && !!rootEl.current?.contains(a) && !!a.closest('[data-testid="kanban-card"]');
  };
  const onFocusIn = (e: FocusEvent) => {
    const id = (e.target as HTMLElement).closest('[data-testid="kanban-card"]')?.getAttribute('data-task-id');
    if (id) hold('focus', true, { card: id });
  };
  const onFocusOut = (e: FocusEvent) => {
    const next = e.relatedTarget as HTMLElement | null;
    if (!next?.closest?.('[data-testid="kanban-card"]')) hold('focus', false);
  };
  // Same for the pointer: when the node under it is removed (a fold, a card that moved), the
  // browser sends no pointerout from it, so React never fires the host's pointerleave.
  const lanesHost = useRef<HTMLDivElement | null>(null);
  const pointerHeld = freeze.holds.split(' ').includes('pointer');
  // The pointer holds the lane it rests in (N1): every other lane stays live.
  const onLanesPointer = (e: { target: EventTarget | null }) => {
    const el = e.target instanceof Element ? e.target.closest('[data-testid="kanban-lane"], [data-testid="kanban-done-rail"]') : null;
    const lane = el?.getAttribute('data-lane-id');
    if (lane) hold('pointer', true, { lane }); else hold('pointer', false);
  };
  useEffect(() => {
    if (!pointerHeld) return;
    const moved = (e: PointerEvent) => {
      const host = lanesHost.current;
      if (!host || !(e.target instanceof Node) || !host.contains(e.target)) hold('pointer', false);
    };
    const out = (e: PointerEvent) => { if (!e.relatedTarget) hold('pointer', false); };
    window.addEventListener('pointermove', moved, true);
    window.addEventListener('pointerout', out, true);
    return () => { window.removeEventListener('pointermove', moved, true); window.removeEventListener('pointerout', out, true); };
  }, [pointerHeld, hold]);
  // Not under a drag (the drop line moves cards on purpose, autoscroll owns the scroll), and
  // not while a card is open in place: Back restores the board's own scroll.
  useHoverAnchor(rootEl, pointerHeld && visible && !detail && !freeze.holds.split(' ').includes('drag'), lastPointer);
  const focusHeld = freeze.holds.split(' ').includes('focus');
  useEffect(() => {
    if (!focusHeld) return;
    const t = setInterval(() => { if (!focusInCard()) hold('focus', false); }, 500);
    return () => clearInterval(t);
  }, [focusHeld, hold]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!visible) { hold('pointer', false); hold('focus', false); } }, [visible, hold]);

  // The hidden board loses its scroll box under display:none: Back puts the scroll back (3.0).
  useLayoutEffect(() => {
    if (detail || savedScroll.current === null) return;
    if (scrollEl.current) scrollEl.current.scrollTop = savedScroll.current;
    savedScroll.current = null;
  }, [detail]);

  const firstTodo = vm.lanes.find((l) => l.lane.kind === 'todo')?.lane.id ?? vm.lanes[0]?.lane.id ?? null;
  const detailCard = detail ? vm.cards[detail] : null;
  useEffect(() => { if (mode === 'wide' && detail) setDetail(null); }, [mode, detail]);
  const showLeaderRow = filter.chip === 'needs' && !!vm.leader?.needsYou;
  const readOnly = api.readOnly;

  return (
    <KanbanCardContext.Provider value={ctx}>
      <div
        ref={setRoot}
        className={`board-kanban kanban-mode-${mode}${readOnly ? ' is-read-only' : ''}${reducedMotion ? ' is-reduced-motion' : ''}`}
        data-testid="board-kanban" data-mode={mode} data-read-only={readOnly ? 'true' : undefined}
        style={visible ? undefined : { display: 'none' }}
        // N2: an Escape inside the board that nothing in it used (an empty search, a card) stays
        // here: claimed, the full screen sheet and the panel keep it, so a leftover press never
        // closes the Board. Leaving it is the bar's own control.
        onKeyDown={(e) => { if (e.key === 'Escape' && !e.nativeEvent.isComposing && !e.defaultPrevented) e.preventDefault(); }}
      >
        <div className="kanban-root" data-testid="kanban-root" data-width={view.width}>
          {detailCard && (
            <KanbanCardDetail
              card={detailCard} laneName={vm.lanes.find((l) => l.lane.id === detailCard.lane)?.lane.name ?? ''} readOnly={readOnly}
              onBack={() => { const id = detail; setDetail(null); if (id) focusCard(id); }}
              onOpenSession={openSession} onSeen={(id) => seen.markCardSeen(id)} renderSession={renderSession}
            />
          )}
          <div className="kanban-board-view" style={detailCard ? { display: 'none' } : undefined}>
            <div className="kanban-head-fixed">
              <KanbanHeader
                board={shown} filter={filter} seen={seen} mode={mode} ownerId={ownerId}
                onJumpToLane={onJumpToLane} onRevealCard={reveal} onOpenTask={openBeside} searchRef={searchRef}
              />
              {showLeaderRow && vm.leader && <KanbanLeaderRow leader={vm.leader} onOpenTask={openBeside} />}
            </div>
            {filter.emptyText && (
              <div className="kanban-filter-empty" data-testid="kanban-filter-empty">
                <span>{filter.emptyText}</span>
                <button type="button" className="kanban-text-btn" data-testid="kanban-show-all-cards" onClick={() => filter.setChip(null)}>Show all cards</button>
              </div>
            )}
            {vm.empty && <KanbanEmpty>{emptyExtra}</KanbanEmpty>}
            <div
              ref={lanesHost} className="kanban-lanes-host" data-hold={freeze.holds || undefined} data-held-lanes={freeze.heldLanes || undefined}
              onPointerEnter={onLanesPointer} onPointerMove={onLanesPointer} onPointerLeave={() => hold('pointer', false)}
              onFocus={onFocusIn} onBlur={onFocusOut}
            >
              <KanbanLanes
                vm={shown} layout={freeze.layout} lanes={lanesList} mode={mode} view={view} api={api} filter={filter}
                deletePreview={deletePreview} pending={writes.pending} moved={freeze.moved} flash={flash} flashingLane={flashingLane}
                tabStops={tabStops} keyDrop={keyDropState} keyDragId={keyDrag?.taskId ?? null} autoAddLane={vm.empty ? firstTodo : null} reducedMotion={reducedMotion}
                onDragging={(on) => hold('drag', on)} say={say}
                addLane={<KanbanAddLane lanes={lanesList} mode={mode} api={api} onAdded={onLaneAdded} />}
                scrollRef={(el) => { scrollEl.current = el; }}
              />
            </div>
          </div>
          <div className="kanban-live" aria-live="polite" role="status" data-testid="kanban-live">{said}</div>
          <KanbanToasts toasts={toasts.list} onDismiss={toasts.dismiss} />
        </div>
      </div>
    </KanbanCardContext.Provider>
  );
}
