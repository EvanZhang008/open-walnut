import { useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { RouteShownContext } from '@/contexts/RouteShownContext';
import { createPortal } from 'react-dom';
import { DndContext, DragOverlay, PointerSensor, KeyboardSensor, useDraggable, useDroppable, useSensor, useSensors, pointerWithin, rectIntersection, type CollisionDetection, type DragEndEvent } from '@dnd-kit/core';
import type { Task } from '@open-walnut/core';
import { shownState } from '@open-walnut/user-status';
import { useTasksContext } from '@/contexts/TasksContext';
import { useFocusBarContext } from '@/contexts/FocusBarContext';
import { useFullscreen } from '@/hooks/useFullscreen';
import { usePageView } from '@/utils/view-memory';
import { taskStatusLabel, taskUserState } from '@/utils/session-status';
import { ICON_CLOSE, ICON_CHEVRON_DOWN, ICON_CHEVRON_RIGHT } from '@/components/common/Icons';
import { OptionPickerFlyout, useCursorFlyout } from './CursorFlyout';
import { boardMoveIds, buildHomeBoard, homeBoardTier, type BoardFamily, type HomeBoardColumn, type HomeBoardMode } from './home-board-model';
import '@/styles/home-board.css';

function BoardTask({ family, mode, onOpen, onMove, depth = 0, folded, onFold, tierLabel, moving }: {
  family: BoardFamily; mode: HomeBoardMode; onOpen: (task: Task) => void;
  onMove: (task: Task, origin: HTMLElement) => void; depth?: number; tierLabel: (task: Task) => string;
  folded: readonly string[]; onFold: (id: string) => void; moving: boolean;
}) {
  const { task, children, parent } = family;
  const state = shownState(taskUserState(task));
  const drag = useDraggable({ id: task.id, data: { family }, disabled: mode !== 'pin' || moving });
  const closed = folded.includes(task.id);
  return <article ref={drag.setNodeRef} className={`home-board-card${depth ? ' home-board-child' : ''}${drag.isDragging ? ' is-dragging' : ''}`} data-board-task={task.id} data-state={state} style={{ '--board-depth': Math.min(depth, 4) } as CSSProperties}>
    <div className="home-board-card-top">
      <button type="button" className="home-board-title" onClick={() => onOpen(task)}>{task.title}</button>
      {mode === 'pin' && <button type="button" className="home-board-drag" disabled={moving} aria-label={`Drag ${task.title}`} title="Drag to another pin tier" {...drag.attributes} {...drag.listeners}>⠿</button>}
    </div>
    <div className="home-board-meta"><span className={`home-board-state home-board-state-${state}`}><i />{taskStatusLabel(task)}</span>{mode === 'status' && <span>{tierLabel(task)}</span>}
      {mode === 'pin' && <button type="button" disabled={moving} aria-label={`Move ${task.title} to pin tier`} onClick={e => onMove(task, e.currentTarget)}>Move</button>}
    </div>
    {!depth && parent && <div className="home-board-parent" title={parent.title}>Under {parent.title}</div>}
    {children.length > 0 && <div className="home-board-family">
      <button type="button" className="home-board-family-toggle" aria-expanded={!closed} aria-label={`Subtasks of ${task.title}`} onClick={() => onFold(task.id)}>{closed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}{children.length} {children.length === 1 ? 'subtask' : 'subtasks'}</button>
      {!closed && children.map(child => <BoardTask key={child.task.id} family={child} mode={mode} onOpen={onOpen} onMove={onMove} depth={depth + 1} folded={folded} onFold={onFold} tierLabel={tierLabel} moving={moving} />)}
    </div>}
  </article>;
}

function BoardColumn({ column, mode, doneLimit, onMoreDone, ...props }: { column: HomeBoardColumn; mode: HomeBoardMode; doneLimit: number; onMoreDone: () => void } & Omit<Parameters<typeof BoardTask>[0], 'family' | 'depth' | 'mode'>) {
  const { setNodeRef, isOver } = useDroppable({ id: `board-tier:${column.id}`, data: { tier: column.id }, disabled: mode !== 'pin' });
  return <section ref={setNodeRef} className={`home-board-column${isOver ? ' is-over' : ''}`} data-board-column={column.id} aria-label={column.label}>
    <header className="home-board-column-head"><h2>{column.label}</h2><span>{column.count}</span></header>
    <div className="home-board-column-body">
      {column.projects.map(project => <section key={project.key} className="home-board-project" data-board-project={project.key}>
        <h3>{project.label}<span>{project.count}</span></h3>
        {project.families.map(family => <BoardTask key={family.task.id} family={family} mode={mode} {...props} />)}
      </section>)}
      {!column.projects.length && <p className="home-board-empty">{mode === 'pin' ? 'Drop tasks here' : 'No tasks'}</p>}
      {column.id === 'done' && column.count > doneLimit && <button type="button" className="home-board-more" onClick={onMoreDone}>Show more completed tasks</button>}
    </div>
  </section>;
}

export function HomeBoardSheet({ onOpenTask }: { onOpenTask: (task: Task) => void }) {
  const { tasks, loading, error, refetch, ensureAllTasks, completedHidden } = useTasksContext();
  const focus = useFocusBarContext();
  const fullscreen = useFullscreen({ keepAcrossRoutes: true, place: 'home-board|tasks' });
  const [mode, setMode] = usePageView<HomeBoardMode>('home-board', 'group', 'pin', (v): v is HomeBoardMode => v === 'pin' || v === 'status');
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
  const [doneLimit, setDoneLimit] = useState(30);
  const shown = useContext(RouteShownContext) ?? true;
  const picker = useCursorFlyout<BoardFamily>();
  const sheetRef = useRef<HTMLElement>(null);
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
    const labels: Record<string, string> = { focus: 'Focus', satellite: 'Satellite', wait: 'Parked', unpinned: 'Unpinned' };
    return focus.customTiers.find(c => c.id === tier)?.label ?? labels[tier] ?? tier;
  };
  const columns = useMemo(() => fullscreen.isFullscreen ? buildHomeBoard(tasks, focus.customTiers, mode, query, doneLimit) : [], [fullscreen.isFullscreen, tasks, focus.customTiers, mode, query, doneLimit]);
  const families = useMemo(() => {
    const result = new Map<string, BoardFamily>();
    const add = (family: BoardFamily) => { result.set(family.task.id, family); family.children.forEach(add); };
    columns.forEach(column => column.projects.forEach(project => project.families.forEach(add)));
    return result;
  }, [columns]);
  useEffect(() => {
    const open = () => fullscreen.enterFullscreen();
    window.addEventListener('home:open-board', open);
    return () => window.removeEventListener('home:open-board', open);
  }, [fullscreen.enterFullscreen]);
  useEffect(() => {
    moveEpoch.current++;
    setMoveError(null);
    retryMove.current = null;
    if (!fullscreen.isFullscreen) { dragCancelled.current = true; setQuery(''); picker.close(); setDragging(null); }
  }, [fullscreen.isFullscreen, mode]);
  useEffect(() => {
    if (shown && fullscreen.isFullscreen && mode === 'pin') return;
    moveEpoch.current++;
    retryMove.current = null;
    setMoveError(null);
    if (dragging) {
      dragCancelled.current = true;
      const event = new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true });
      event.preventDefault();
      document.dispatchEvent(event);
    }
    picker.close();
  }, [shown, fullscreen.isFullscreen, mode, dragging]);
  useEffect(() => { setDoneLimit(30); setSearchFold({ query, ids: [] }); }, [query]);
  const sendMove = useCallback((ids: string[], tier: string) => {
    if (moveInFlight.current) return;
    const epoch = ++moveEpoch.current;
    moveInFlight.current = true;
    retryMove.current = { ids, tier };
    setMoveError(null);
    setMoving(true);
    void focus.setTierBulk(ids, tier === 'unpinned' ? null : tier, (message, failedIds) => {
      if (moveEpoch.current !== epoch) return;
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
  const onOpen = (task: Task) => { fullscreen.exitFullscreen(); onOpenTask(task); };
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
  const total = columns.reduce((n, c) => n + c.count, 0) + (mode === 'status' && !query.trim() ? completedHidden : 0);
  if (!fullscreen.isFullscreen) return null;
  return <>{fullscreen.FullscreenBackdrop}{createPortal(<section ref={sheetRef} className={`home-board-sheet${fullscreen.fullscreenClass}`} onPointerDownCapture={e => {
    if ((e.target as Element).closest('.home-board-drag')) pointerHeld.current = true;
  }} onKeyDownCapture={e => {
    if (e.defaultPrevented || (e.key === 'Escape' && dragging)) return;
    if (e.key === 'Escape' && picker.state) { e.preventDefault(); e.stopPropagation(); picker.close(); return; }
    if (e.key === 'Escape' && searching) { e.preventDefault(); e.stopPropagation(); setQuery(''); return; }
    if (e.key !== 'Tab' || picker.state) return;
    const items = [...(sheetRef.current?.querySelectorAll<HTMLElement>('button, input') ?? [])].filter(el => el.getClientRects().length && !el.hasAttribute('disabled'));
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && current <= 0) { e.preventDefault(); items.at(-1)?.focus(); }
    else if (!e.shiftKey && current === items.length - 1) { e.preventDefault(); items[0]?.focus(); }
  }} role="dialog" aria-modal="true" aria-label="Task board" data-testid="home-board" data-mode={mode}>
    <header className="home-board-head"><h1>Board</h1><span className="home-board-count">{total} {mode === 'pin' ? `open ${total === 1 ? 'task' : 'tasks'}` : total === 1 ? 'task' : 'tasks'}</span>
      <div className="home-board-controls"><div className="home-board-switch" aria-label="Group board"><button type="button" aria-pressed={mode === 'pin'} onClick={() => setMode('pin')}>By pin</button><button type="button" aria-pressed={mode === 'status'} onClick={() => setMode('status')}>By status</button></div>
        <input data-no-draft="search" aria-label="Search board tasks" placeholder="Search tasks" value={query} onChange={e => setQuery(e.target.value)} />
        <button type="button" className="home-board-close" aria-label="Close board" title="Close board" onClick={fullscreen.exitFullscreen}>{ICON_CLOSE}</button>
      </div>
    </header>
    <div className="home-board-hint">{(error || moveError) ? <div className="home-board-error" role="alert"><span title={error || moveError || undefined}>{error || moveError}</span><button type="button" disabled={moving} onClick={() => {
      const retry = retryMove.current;
      if (moveError && retry && mode === 'pin') sendMove(retry.ids, retry.tier);
      else refetch();
    }}>Retry</button></div> : moving ? 'Saving pin tier…' : mode === 'pin' ? 'Grouped by project. Drag or use Move to change pin tier. Subtasks in the same tier move with their leader, across projects.' : 'Grouped by project. Status follows each task’s live state.'}</div>
    {loading ? <p className="home-board-empty">Loading your tasks…</p> : <DndContext sensors={sensors} collisionDetection={boardCollision} autoScroll={autoScroll} onDragStart={e => { dragCancelled.current = false; setDragging(e.active.data.current?.family ?? null); }} onDragEnd={onDrop} onDragCancel={() => setDragging(null)}>
      <div className="home-board-columns">{columns.map(column => <BoardColumn key={column.id} column={column.id === 'done' ? { ...column, count: column.count + (query.trim() ? 0 : completedHidden) } : column} mode={mode} onOpen={onOpen} onMove={onMove} folded={visibleFolds} onFold={onFold} tierLabel={tierLabel} moving={moving} doneLimit={doneLimit} onMoreDone={() => { ensureAllTasks(); setDoneLimit(v => v + 30); }} />)}</div>
      <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>{dragging && <div className="home-board-card home-board-drag-preview">{dragging.task.title}</div>}</DragOverlay>
    </DndContext>}
    {shown && picker.state && <OptionPickerFlyout anchorPoint={picker.state.point} anchorRef={picker.noTrigger} options={columns.map(c => ({ value: c.id, label: c.label }))} current={homeBoardTier(picker.state.payload.task, focus.customTiers)} ariaLabel="Move to pin tier" onPick={tier => move(picker.state!.payload, tier)} onClose={picker.close} />}
  </section>, document.body)}</>;
}
