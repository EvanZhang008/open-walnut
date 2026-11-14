import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, pointerWithin, rectIntersection, type CollisionDetection, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import type { Task } from '@open-walnut/core';
import { shownState } from '@open-walnut/user-status';
import { isHiddenFromTaskLists } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useFullscreen } from '@/hooks/useFullscreen';
import { useOpenTask } from '@/hooks/useOpenTask';
import { usePageView } from '@/utils/view-memory';
import { taskStatusLabel, taskUserState } from '@/utils/session-status';
import { ICON_CLOSE, ICON_CHEVRON_DOWN, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { OptionPickerFlyout, useCursorFlyout } from './CursorFlyout';
import { QuickSortView } from './QuickSortView';
import { SnoozeDateFlyout, SnoozeFlyout, SnoozeRows } from './SnoozeChoices';
import { isSnoozed, snoozeUntilText } from './quick-sort-model';
import { boardMoveIds, buildHomeBoard, homeBoardTier, pinBoardColumns, type BoardFamily, type HomeBoardColumn, type HomeBoardMode, type HomeBoardView } from './home-board-model';
import { projectDisplayName } from '@/utils/project-display';
import { orgDisplayTitle } from '@open-walnut/org-tree';
import '@/styles/home-board.css';

function BoardTask({ family, mode, onOpen, onMove, onSnooze, onDone, depth = 0, folded, onFold, tierLabel, moving, snoozed }: {
  family: BoardFamily; mode: HomeBoardMode; onOpen: (task: Task) => void; snoozed: (task: Task) => boolean;
  /** One tap on the card itself (2026-11-07, the user: not in the Move menu, "several buttons ... including Snooze"). */
  onSnooze: (task: Task, origin: HTMLElement) => void; onDone: (task: Task) => void;
  onMove: (task: Task, origin: HTMLElement) => void; depth?: number; tierLabel: (task: Task) => string;
  folded: readonly string[]; onFold: (id: string) => void; moving: boolean;
}) {
  const { task, children, parent } = family;
  const state = shownState(taskUserState(task));
  const drag = useDraggable({ id: task.id, data: { family }, disabled: mode !== 'pin' || moving });
  const closed = folded.includes(task.id);
  const until = task.start_date && snoozed(task) ? snoozeUntilText(task.start_date) : '';
  const open = state !== 'done';
  return <article data-peek-row="" ref={drag.setNodeRef} className={`home-board-card${depth ? ' home-board-child' : ''}${drag.isDragging ? ' is-dragging' : ''}`} data-board-task={task.id} data-state={state} data-draggable={mode === 'pin' && !moving} onPointerDown={e => {
    const target = e.target as Element;
    if (e.pointerType !== 'mouse' || target.closest('[data-board-task]') !== e.currentTarget || target.closest('button, a, input, textarea, select, [contenteditable="true"]')) return;
    drag.listeners?.onPointerDown?.(e);
  }} style={{ '--board-depth': Math.min(depth, 4) } as CSSProperties}>
    <div className="home-board-card-top">
      <button type="button" className="home-board-title" onClick={() => onOpen(task)}>{orgDisplayTitle(task)}</button>
      {mode === 'pin' && <button ref={drag.setActivatorNodeRef} type="button" className="home-board-drag" disabled={moving} aria-label={`Drag ${orgDisplayTitle(task)}`} title="Drag to another pin tier" {...drag.attributes} {...drag.listeners}>⠿</button>}
    </div>
    <div className="home-board-meta"><span className={`home-board-state home-board-state-${state}`}><i />{taskStatusLabel(task)}</span>{mode === 'status' && <span>{tierLabel(task)}</span>}
      {until && <span className="home-board-snoozed" data-board-snoozed>{/^snoozed/i.test(taskStatusLabel(task)) ? `until ${until}` : `Snoozed until ${until}`}</span>}
      {open && <span className="home-board-actions">
        <button type="button" data-board-snooze aria-haspopup="dialog" aria-label={`Snooze ${orgDisplayTitle(task)}`} onClick={e => onSnooze(task, e.currentTarget)}>Snooze</button>
        <button type="button" data-board-done-button aria-label={`Mark ${orgDisplayTitle(task)} done`} onClick={() => onDone(task)}>Done</button>
        {mode === 'pin' && <button type="button" data-board-move disabled={moving} aria-label={`Move ${orgDisplayTitle(task)} to pin tier`} onClick={e => onMove(task, e.currentTarget)}>Move</button>}
      </span>}
    </div>
    {!depth && parent && <div className="home-board-parent" title={orgDisplayTitle(parent)}>Under {orgDisplayTitle(parent)}</div>}
    {children.length > 0 && <div className="home-board-family">
      <button type="button" className="home-board-family-toggle" aria-expanded={!closed} aria-label={`Subtasks of ${orgDisplayTitle(task)}`} onClick={() => onFold(task.id)}>{closed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}{children.length} {children.length === 1 ? 'subtask' : 'subtasks'}</button>
      {!closed && children.map(child => <BoardTask key={child.task.id} family={child} mode={mode} onOpen={onOpen} onMove={onMove} onSnooze={onSnooze} onDone={onDone} depth={depth + 1} folded={folded} onFold={onFold} tierLabel={tierLabel} moving={moving} snoozed={snoozed} />)}
    </div>}
  </article>;
}

function BoardColumn({ column, mode, doneLimit, onMoreDone, ...props }: { column: HomeBoardColumn; mode: HomeBoardMode; doneLimit: number; onMoreDone: () => void } & Omit<Parameters<typeof BoardTask>[0], 'family' | 'depth' | 'mode'>) {
  const { setNodeRef, isOver } = useDroppable({ id: `board-tier:${column.id}`, data: { tier: column.id }, disabled: mode !== 'pin' });
  return <section ref={setNodeRef} className={`home-board-column${isOver ? ' is-over' : ''}`} data-board-column={column.id} aria-label={column.label}>
    <header className="home-board-column-head"><h2>{column.label}</h2><span>{column.count}</span></header>
    <div className="home-board-column-body">
      {column.projects.map(project => <section key={project.key} className="home-board-project" data-board-project={project.key}>
        <h3>{projectDisplayName(project.label)}<span>{project.count}</span></h3>
        {project.families.map(family => <BoardTask key={family.task.id} family={family} mode={mode} {...props} />)}
      </section>)}
      {!column.projects.length && <p className="home-board-empty">{mode === 'pin' ? 'Drop tasks here' : 'No tasks'}</p>}
      {column.id === 'done' && column.count > doneLimit && <button type="button" className="home-board-more" onClick={onMoreDone}>Show more completed tasks</button>}
    </div>
  </section>;
}

export function HomeBoardSheet() {
  const openTask = useOpenTask();
  const { tasks, loading, error, refetch, ensureAllTasks, completedHidden, update, setPhase } = useTasksContext();
  const focus = useFocusBarContext();
  const fullscreen = useFullscreen({ keepAcrossRoutes: true, place: 'home-board|tasks' });
  const [mode, setMode] = usePageView<HomeBoardView>('home-board', 'group', 'pin', (v): v is HomeBoardView => v === 'pin' || v === 'status' || v === 'sort');
  const [folded, setFolded] = usePageView<string[]>('home-board', 'folded', [], (v): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string'));
  const [query, setQuery] = useState('');
  const [searchFold, setSearchFold] = useState<{ query: string; ids: string[] }>({ query: '', ids: [] });
  const searching = query.trim() !== '';
  const visibleFolds = searching ? (searchFold.query === query ? searchFold.ids : []) : folded;
  const [dragging, setDragging] = useState<BoardFamily | null>(null);
  const dragCancelled = useRef(false);
  const pointerHeld = useRef(false);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const retryMove = useRef<{ ids: string[]; tier: string } | null>(null);
  const moveInFlight = useRef(false);
  const moveEpoch = useRef(0);
  const movedTask = useRef<{ id: string; tier: string } | null>(null);
  const [doneLimit, setDoneLimit] = useState(30);
  const shown = useContext(RouteShownContext) ?? true;
  const picker = useCursorFlyout<BoardFamily>();
  const datePicker = useCursorFlyout<Task>();
  const snoozePicker = useCursorFlyout<Task>();
  const [lastDone, setLastDone] = useState<{ id: string; label: string; phase: string; write: Promise<boolean> } | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const keepGrabVisible = useCallback<Modifier>(({ activatorEvent, activeNodeRect, transform }) => {
    const height = previewRef.current?.offsetHeight;
    if (!(activatorEvent instanceof PointerEvent) || !activeNodeRect || !height) return transform;
    const offset = activatorEvent.clientY - activeNodeRect.top;
    return offset > height - 8 ? { ...transform, y: transform.y + offset - height / 2 } : transform;
  }, []);
  const previewModifiers = useMemo(() => [keepGrabVisible], [keepGrabVisible]);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!fullscreen.isFullscreen) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    sheetRef.current?.querySelector<HTMLButtonElement>('.home-board-close')?.focus({ preventScroll: true });
    return () => { previousFocus.current?.focus({ preventScroll: true }); };
  }, [fullscreen.isFullscreen]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }), useSensor(KeyboardSensor));
  const boardCollision = useCallback<CollisionDetection>(args => {
    pointer.current = args.pointerCoordinates;
    return args.pointerCoordinates ? pointerWithin(args) : rectIntersection(args);
  }, []);
  const autoScroll = useMemo(() => ({
    threshold: { x: 0.1, y: 0.1 },
    canScroll: (element: Element) => {
      const point = pointer.current;
      if (!point || !element.classList.contains('home-board-columns')) return false;
      const box = element.getBoundingClientRect();
      return point.y >= box.top && point.y <= box.bottom && point.x >= box.left && point.x <= box.right
        && (point.x <= box.left + 24 || point.x >= box.right - 24);
    },
  }), []);
  useEffect(() => {
    if (!fullscreen.isFullscreen) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (!dragging && !pointerHeld.current)) return;
      dragCancelled.current = true;
      pointerHeld.current = false;
      // The sensor must receive this key; the fullscreen listener must not close the sheet.
      event.preventDefault();
    };
    const release = () => { pointerHeld.current = false; };
    document.addEventListener('keydown', cancel, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return () => {
      document.removeEventListener('keydown', cancel, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
    };
  }, [dragging, fullscreen.isFullscreen]);
  const tierLabel = (task: Task) => {
    const tier = homeBoardTier(task, focus.customTiers);
    return pinBoardColumns(focus.customTiers).find(c => c.id === tier)?.label ?? tier;
  };
  const columns = useMemo(() => fullscreen.isFullscreen && mode !== 'sort' ? buildHomeBoard(tasks, focus.customTiers, mode, query, doneLimit) : [], [fullscreen.isFullscreen, tasks, focus.customTiers, mode, query, doneLimit]);
  const families = useMemo(() => {
    const result = new Map<string, BoardFamily>();
    const add = (family: BoardFamily) => { result.set(family.task.id, family); family.children.forEach(add); };
    columns.forEach(column => column.projects.forEach(project => project.families.forEach(add)));
    return result;
  }, [columns]);
  useLayoutEffect(() => {
    const moved = movedTask.current;
    if (!moved || !shown || !fullscreen.isFullscreen || mode !== 'pin') return;
    const card = sheetRef.current?.querySelector<HTMLElement>(`[data-board-column="${CSS.escape(moved.tier)}"] [data-board-task="${CSS.escape(moved.id)}"]`);
    if (!card) {
      const ancestors = (nodes: BoardFamily[], parents: string[] = []): string[] | undefined => {
        for (const family of nodes) {
          if (family.task.id === moved.id) return parents;
          const found = ancestors(family.children, [...parents, family.task.id]);
          if (found !== undefined) return found;
        }
      };
      const path = ancestors(columns.filter(c => c.id === moved.tier).flatMap(c => c.projects.flatMap(p => p.families)));
      if (!path?.some(id => visibleFolds.includes(id))) { movedTask.current = null; return; }
      if (searching) setSearchFold({ query, ids: visibleFolds.filter(id => !path.includes(id)) });
      else setFolded(ids => ids.filter(id => !path.includes(id)));
      return;
    }
    movedTask.current = null;
    const title = card.querySelector<HTMLElement>('.home-board-title');
    const column = card.closest<HTMLElement>('[data-board-column]');
    if (!title || !column) return;
    const body = column.querySelector<HTMLElement>('.home-board-column-body');
    const header = column.querySelector<HTMLElement>('header');
    if (!body || !header) return;
    const titleBox = title.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    const top = Math.max(bodyBox.top, header.getBoundingClientRect().bottom) + 8;
    const bottom = bodyBox.bottom - 8;
    if (titleBox.top < top || titleBox.height > bottom - top) body.scrollTop += titleBox.top - top;
    else if (titleBox.bottom > bottom) body.scrollTop += titleBox.bottom - bottom;
    const strip = column.parentElement!;
    const stripBox = strip.getBoundingClientRect();
    const left = stripBox.left + 8;
    const right = stripBox.right - 8;
    if (titleBox.left < left || titleBox.width > right - left) strip.scrollLeft += titleBox.left - left;
    else if (titleBox.right > right) strip.scrollLeft += titleBox.right - right;
  }, [columns, mode, shown, fullscreen.isFullscreen, searching, query, visibleFolds, setFolded]);
  useEffect(() => {
    const open = () => fullscreen.enterFullscreen();
    window.addEventListener('home:open-board', open);
    return () => window.removeEventListener('home:open-board', open);
  }, [fullscreen.enterFullscreen]);
  useEffect(() => {
    moveEpoch.current++;
    movedTask.current = null;
    setMoveError(null);
    retryMove.current = null;
    if (!fullscreen.isFullscreen) { dragCancelled.current = true; setQuery(''); picker.close(); datePicker.close(); snoozePicker.close(); setLastDone(null); setDragging(null); }
  }, [fullscreen.isFullscreen, mode]);
  useEffect(() => {
    if (shown && fullscreen.isFullscreen && mode === 'pin') return;
    moveEpoch.current++;
    movedTask.current = null;
    retryMove.current = null;
    setMoveError(null);
    if (dragging) {
      dragCancelled.current = true;
      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      event.preventDefault();
      document.dispatchEvent(event);
    }
    picker.close(); datePicker.close(); snoozePicker.close();
  }, [shown, fullscreen.isFullscreen, mode, dragging]);
  useEffect(() => { setDoneLimit(30); setSearchFold({ query, ids: [] }); }, [query]);
  const sendMove = useCallback((ids: string[], tier: string) => {
    if (moveInFlight.current) return;
    const epoch = ++moveEpoch.current;
    movedTask.current = { id: ids[0], tier };
    moveInFlight.current = true;
    retryMove.current = { ids, tier };
    setMoveError(null);
    setMoving(true);
    void focus.setTierBulk(ids, tier === 'unpinned' ? null : tier, (message, failedIds) => {
      if (moveEpoch.current !== epoch) return;
      movedTask.current = null;
      if (failedIds) retryMove.current = { ids: failedIds, tier };
      setMoveError(message);
    }).finally(() => { moveInFlight.current = false; setMoving(false); });
  }, [focus]);
  const move = useCallback((family: BoardFamily, tier: string) => {
    if (moveInFlight.current) return;
    const current = buildHomeBoard(tasks, focus.customTiers, 'pin');
    const find = (nodes: BoardFamily[]): BoardFamily | undefined => {
      for (const node of nodes) {
        if (node.task.id === family.task.id) return node;
        const child = find(node.children);
        if (child) return child;
      }
    };
    const live = find(current.flatMap(c => c.projects.flatMap(p => p.families)));
    if (!live || homeBoardTier(live.task, focus.customTiers) === tier) return;
    sendMove(boardMoveIds(tasks, live.task, focus.customTiers), tier);
  }, [focus.customTiers, tasks, sendMove]);
  const onDrop = (event: DragEndEvent) => {
    setDragging(null);
    const family = event.active.data.current?.family as BoardFamily | undefined;
    const tier = event.over?.data.current?.tier as string | undefined;
    if (!dragCancelled.current && shown && fullscreen.isFullscreen && family && tier && mode === 'pin') move(family, tier);
  };
  // A card is a task reference: the sheet's full screen first, so Home's column shows.
  const onOpen = (task: Task) => { fullscreen.exitFullscreen(); openTask(task.id); };
  const onMove = (task: Task, origin: HTMLElement) => {
    if (moveInFlight.current) return;
    const box = origin.getBoundingClientRect();
    const family = families.get(task.id);
    if (family) picker.open(family, { x: box.left, y: box.bottom }, origin);
  };
  const onFold = (id: string) => {
    const toggle = (ids: string[]) => ids.includes(id) ? ids.filter(v => v !== id) : [...ids, id];
    if (searching) setSearchFold({ query, ids: toggle(visibleFolds) });
    else setFolded(toggle);
  };
  useEffect(() => { if (fullscreen.isFullscreen && mode === 'status' && query.trim()) ensureAllTasks(); }, [fullscreen.isFullscreen, mode, query, ensureAllTasks]);
  const byId = useMemo(() => new Map(tasks.map(t => [t.id, t])), [tasks]);
  const snoozedNow = useCallback((task: Task) => isSnoozed(task, byId, Date.now()), [byId]);
  const sortTiers = useMemo(() => pinBoardColumns(focus.customTiers), [focus.customTiers]);
  const boardMode: HomeBoardMode = mode === 'status' ? 'status' : 'pin';
  const snoozeFromMenu = (task: Task, date: string | null) => { update(task.id, { start_date: date ?? '' }); };
  const onSnoozeCard = (task: Task, origin: HTMLElement) => {
    const box = origin.getBoundingClientRect();
    picker.close();
    snoozePicker.open(task, { x: box.left, y: box.bottom }, origin);
  };
  const onDoneCard = (task: Task) => {
    const write = setPhase(task.id, 'COMPLETE');
    const done = { id: task.id, label: orgDisplayTitle(task), phase: task.phase, write };
    setLastDone(done);
    // A refused completion was reported and rolled back: there is nothing to undo.
    void write.then(ok => { if (!ok) setLastDone(d => d === done ? null : d); });
  };
  const total = mode === 'sort' ? tasks.filter(t => !isHiddenFromTaskLists(t) && taskUserState(t) !== 'done').length : columns.filter(c => c.id !== 'done').reduce((n, c) => n + c.count, 0);
  const completed = (columns.find(c => c.id === 'done')?.count ?? 0) + (query.trim() ? 0 : completedHidden);
  if (!fullscreen.isFullscreen) return null;
  return <>{fullscreen.FullscreenBackdrop}{createPortal(<section ref={sheetRef} className={`home-board-sheet${fullscreen.fullscreenClass}`} onPointerDownCapture={e => {
    const target = e.target as Element;
    if (e.isPrimary && e.button === 0 && mode === 'pin' && !moving && (target.closest('.home-board-drag') || (e.pointerType === 'mouse' && target.closest('[data-board-task]') && !target.closest('button, a, input, textarea, select, [contenteditable="true"]')))) pointerHeld.current = true;
  }} onKeyDownCapture={e => {
    if (e.defaultPrevented || (e.key === 'Escape' && dragging)) return;
    if (e.key === 'Escape' && (picker.state || datePicker.state || snoozePicker.state)) {
      e.preventDefault(); e.stopPropagation();
      const origin = snoozePicker.state?.origin;
      picker.close(); datePicker.close(); snoozePicker.close();
      if (origin?.isConnected) origin.focus({ preventScroll: true });
      return;
    }
    // A text box on the board (a Sort card's reply) takes its own Escape: it closes that box, never the search.
    if (e.key === 'Escape' && (e.target as HTMLElement | null)?.closest?.('textarea, [contenteditable="true"]')) return;
    if (e.key === 'Escape' && searching) { e.preventDefault(); e.stopPropagation(); setQuery(''); return; }
    if (e.key !== 'Tab' || picker.state || datePicker.state || snoozePicker.state) return;
    const items = [...(sheetRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])].filter(el => el.getClientRects().length && !el.hasAttribute('disabled'));
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && current <= 0) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && current === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
  }} role="dialog" aria-modal="true" aria-label="Task board" data-testid="home-board" data-mode={mode}>
    <header className="home-board-head"><h1>Board</h1><span className="home-board-count">{total} open {total === 1 ? 'task' : 'tasks'}{mode === 'status' && ` · ${completed} completed`}</span>
      <div className="home-board-controls"><div className="home-board-switch" aria-label="Group board"><button type="button" aria-pressed={mode === 'pin'} onClick={() => setMode('pin')}>By pin</button><button type="button" aria-pressed={mode === 'status'} onClick={() => setMode('status')}>By status</button><button type="button" aria-pressed={mode === 'sort'} onClick={() => setMode('sort')} title="Decide a few tasks at a time, one tap each">Sort</button></div>
        <input data-no-draft="search" aria-label="Search board tasks" placeholder="Search tasks" value={query} onChange={e => setQuery(e.target.value)} />
        <button type="button" className="home-board-close" aria-label="Close board" title="Close board" onClick={fullscreen.exitFullscreen}>{ICON_CLOSE}</button>
      </div>
    </header>
    <div className="home-board-hint">{(error || moveError) ? <div className="home-board-error" role="alert"><span title={error || moveError || undefined}>{error || moveError}</span><button type="button" disabled={moving} onClick={() => {
      const retry = retryMove.current;
      if (moveError && retry && mode === 'pin') sendMove(retry.ids, retry.tier);
      else refetch();
    }}>Retry</button></div> : lastDone && mode !== 'sort' ? <div className="home-board-done-note" role="status"><span>Marked "{lastDone.label}" done.</span><button type="button" onClick={() => { const { id, phase, write } = lastDone; setLastDone(null); void write.then(ok => { if (ok) void setPhase(id, phase); }); }}>Undo</button></div> : moving ? 'Saving pin tier…' : mode === 'pin' ? 'Grouped by project. Drag or use Move to change pin tier, snooze or mark done. Subtasks in the same tier move with their leader, across projects.' : mode === 'sort' ? 'Decide each card in one tap. Keys: 1 to 9 pin tier, R reply, S snooze, D done, X skip, ← → pick a card, ⌘Z undo.' : 'Grouped by project. Status follows each task’s live state.'}</div>
    {loading ? <p className="home-board-empty">Loading your tasks…</p> : mode === 'sort' ? <QuickSortView query={query} tiers={sortTiers} onOpen={onOpen} active={shown} /> : <DndContext sensors={sensors} collisionDetection={boardCollision} autoScroll={autoScroll} onDragStart={e => { dragCancelled.current = false; setDragging(e.active.data.current?.family ?? null); }} onDragEnd={onDrop} onDragCancel={() => setDragging(null)}>
      <div className="home-board-columns">{columns.map(column => <BoardColumn key={column.id} column={column.id === 'done' ? { ...column, count: column.count + (query.trim() ? 0 : completedHidden) } : column} mode={boardMode} onOpen={onOpen} onMove={onMove} onSnooze={onSnoozeCard} onDone={onDoneCard} folded={visibleFolds} onFold={onFold} tierLabel={tierLabel} moving={moving} snoozed={snoozedNow} doneLimit={doneLimit} onMoreDone={() => { ensureAllTasks(); setDoneLimit(v => v + 30); }} />)}</div>
      <DragOverlay dropAnimation={null} modifiers={previewModifiers} style={{ pointerEvents: 'none' }}>{dragging && <div ref={previewRef} className="home-board-card home-board-drag-preview">{orgDisplayTitle(dragging.task)}</div>}</DragOverlay>
    </DndContext>}
    {shown && picker.state && <OptionPickerFlyout anchorPoint={picker.state.point} anchorRef={picker.noTrigger} options={columns.map(c => ({ value: c.id, label: c.label }))} current={homeBoardTier(picker.state.payload.task, focus.customTiers)} ariaLabel="Move to pin tier" onPick={tier => move(picker.state!.payload, tier)} onClose={picker.close}
      footer={(() => {
        const { payload: family, point, origin } = picker.state!;
        const task = family.task;
        return <>
          <SnoozeRows onSnooze={date => { snoozeFromMenu(task, date); picker.close(); }}
            onPickDate={() => { picker.close(); datePicker.open(task, point, origin); }}
            onClear={snoozedNow(task) && task.start_date ? () => { snoozeFromMenu(task, null); picker.close(); } : undefined} />
          <button type="button" className="task-kebab-project-opt snooze-row board-move-done" data-board-done onClick={e => { e.stopPropagation(); setPhase(task.id, 'COMPLETE'); picker.close(); }}>
            <span className="task-kebab-project-check" /><span className="task-kebab-project-opt-name">Mark done</span>
          </button>
        </>;
      })()} />}
    {shown && snoozePicker.state && <SnoozeFlyout point={snoozePicker.state.point} anchorRef={snoozePicker.noTrigger}
      onSnooze={date => snoozeFromMenu(snoozePicker.state!.payload, date)}
      onPickDate={() => { const s = snoozePicker.state!; snoozePicker.close(); datePicker.open(s.payload, s.point, s.origin); }}
      onClear={snoozedNow(snoozePicker.state.payload) && snoozePicker.state.payload.start_date ? () => snoozeFromMenu(snoozePicker.state!.payload, null) : undefined}
      onClose={snoozePicker.close} />}
    {shown && datePicker.state && <SnoozeDateFlyout point={datePicker.state.point} anchorRef={datePicker.noTrigger} date={datePicker.state.payload.start_date}
      onPick={date => snoozeFromMenu(datePicker.state!.payload, date)} onClose={datePicker.close} />}
  </section>, document.body)}</>;
}
