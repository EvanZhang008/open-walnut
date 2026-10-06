/**
 * The lanes and the pointer drag (spec 3.1, 3.2, 8.1): the board's own
 * DndContext (never Home's), PointerSensor with a 6px distance (a click is
 * never a drag), the lane under the pointer first (pointerWithin), then the
 * card closest to the pointer inside it. The drop line is drawn from the same
 * answer the drop sends (kanban-dnd.ts). Escape, or a drop outside every lane,
 * cancels without a request. A narrow section's folded head unfolds after the
 * pointer rests on it 600ms. A read-only board registers no sensor.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragMoveEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import type { BoardLane, DeletePreview } from '../../../../../src/core/boards/board-lanes';
import type { KanbanFilterApi, KanbanMode, KanbanWriteApi } from './kanban-contract';
import type { KanbanBoardVM } from './kanban-model';
import { announce, cardTargetAt, dropInLane, type DropTarget } from './kanban-dnd';
import type { KanbanLayout } from './kanban-freeze';
import type { KanbanLayoutApi } from './useKanbanLayout';
import type { PendingAdd } from './useKanbanWrites';
import { KanbanCard } from './KanbanCard';
import { KanbanLane } from './KanbanLane';
import { KanbanDoneRail } from './KanbanDoneRail';
import { filteredLane } from './kanban-filter-model';
import { useScrollEdges } from './useScrollEdges';

export interface KanbanDropState {
  lane: string;
  /** Line before this card id; null = the lane's end. */
  lineBefore: string | null;
  index: number;
}

export interface KanbanLanesProps {
  vm: KanbanBoardVM;
  layout: KanbanLayout;
  lanes: readonly BoardLane[];
  mode: KanbanMode;
  view: KanbanLayoutApi;
  api: KanbanWriteApi;
  filter: KanbanFilterApi;
  deletePreview(laneId: string): DeletePreview;
  pending: readonly PendingAdd[];
  moved: ReadonlySet<string>;
  flash: ReadonlySet<string>;
  flashingLane: string | null;
  tabStops: Readonly<Record<string, string>>;
  /** The keyboard drag's line (BoardKanban runs that drag). */
  keyDrop: KanbanDropState | null;
  /** The card the keyboard drag holds (N3: drawn lifted, a ghost at its line). */
  keyDragId: string | null;
  autoAddLane: string | null;
  reducedMotion: boolean;
  onDragging(on: boolean): void;
  say(text: string): void;
  addLane: ReactNode;
  /** The horizontal scroll container (wide), for Show and the lane strip. */
  scrollRef: (el: HTMLDivElement | null) => void;
}

/**
 * True while the pointer is over the folded done rails (N1): they are a drop target, not a scroll
 * edge. A rect test on the rails column, no hit test: dnd-kit asks on every pointer move for every
 * scroll ancestor, and a narrow board (no rails) answers without touching layout.
 */
function pointerOnRail(): boolean {
  const { x, y } = pointer;
  if (x === null || y === null || typeof document === 'undefined') return false;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-testid="kanban-rails"]'))) {
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  }
  return false;
}
/**
 * A scroll container scrolls under a drag only while the real pointer is inside it: the lane a card
 * left (its scroll ancestor) never scrolls while the card is held over another lane.
 */
function pointerInside(el: Element): boolean {
  const { x, y } = pointer;
  if (x === null || y === null) return true;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
/**
 * Auto scroll only in the outer 10% of a lane or the sections list (dnd-kit's 20% grabbed half a short pane),
 * and never while the pointer rests on the rail: autoscroll slid the lanes, and with them the rail, out
 * from under a held card, so the drop missed (N1).
 */
const AUTO_SCROLL = { threshold: { x: 0.1, y: 0.1 }, canScroll: (el: Element) => !pointerOnRail() && pointerInside(el) };
// One object for the life of the page: useSensor memoizes on it, and a new sensor list
// re-renders every draggable card on every board render (G36).
const POINTER_OPTIONS = { activationConstraint: { distance: 6 } };

/**
 * The pointer's real client position, kept by one window listener while a board
 * is mounted. dnd-kit's own pointer coordinates and delta both count the scroll
 * it auto-scrolled, so once a narrow board scrolled under a drag they pointed at
 * the section above the one under the pointer, and the drop landed there.
 */
const pointer: { x: number | null; y: number | null } = { x: null, y: null };
/** The pointer's last client position while a board is mounted (nulls before the first move). */
export const lastPointer = (): { x: number | null; y: number | null } => pointer;
let trackers = 0;
const track = (e: PointerEvent) => { pointer.x = e.clientX; pointer.y = e.clientY; };
function useTrackPointer(): void {
  useEffect(() => {
    if (trackers++ === 0) window.addEventListener('pointermove', track, true);
    return () => { if (--trackers === 0) window.removeEventListener('pointermove', track, true); };
  }, []);
}

/**
 * The lane under the pointer, by a live hit test at the real pointer
 * (`data-kanban-drop` on each head, body and rail; the drag overlay skipped):
 * rects measured at drag start go stale when sections move under a drag.
 * Without a DOM, the rects: a head beats its body.
 */
const laneCollision: CollisionDetection = (args) => {
  const pt = pointer.x !== null && pointer.y !== null ? { x: pointer.x, y: pointer.y } : args.pointerCoordinates;
  if (pt && typeof document !== 'undefined' && document.elementsFromPoint) {
    for (const el of document.elementsFromPoint(pt.x, pt.y)) {
      if (el.closest('.kanban-drag-overlay-host, .kanban-drag-overlay')) continue;
      const id = el.closest<HTMLElement>('[data-kanban-drop]')?.dataset.kanbanDrop;
      const c = id ? args.droppableContainers.find((d) => String(d.id) === id && !d.disabled) : undefined;
      return c ? [{ id: c.id, data: { droppableContainer: c, value: 0 } }] : [];
    }
    return [];
  }
  const hits = pointerWithin(args).filter((c) => /^(lane|head):/.test(String(c.id)));
  const head = hits.find((c) => String(c.id).startsWith('head:'));
  return head ? [head] : hits.slice(0, 1);
};

export function KanbanLanes(p: KanbanLanesProps) {
  const { vm, mode, view } = p;
  // One sensor always (useSensors memoizes on its argument list, which must keep its length);
  // a read-only board disables every draggable instead.
  const sensors = useSensors(useSensor(PointerSensor, POINTER_OPTIONS));
  const [active, setActive] = useState<string | null>(null);
  const [drop, setDrop] = useState<KanbanDropState | null>(null);
  const dropRef = useRef<KanbanDropState | null>(null);
  const unfoldTimer = useRef<{ lane: string; t: ReturnType<typeof setTimeout> } | null>(null);
  const lastSaid = useRef('');
  useTrackPointer();

  // Escape during a pointer drag cancels the drag and nothing else: marked consumed before the
  // full screen sheet's document listener sees it (that one ran first and closed the Board).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') e.preventDefault(); };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);

  const shownOf = useCallback((laneId: string): string[] => {
    const order = p.layout[laneId] ?? [];
    return p.filter.active ? order.filter((id) => p.filter.isVisible(id) || p.filter.isHandled(id)) : [...order];
  }, [p.layout, p.filter]);

  const clearUnfold = () => { if (unfoldTimer.current) { clearTimeout(unfoldTimer.current.t); unfoldTimer.current = null; } };

  const onStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActive(id);
    p.onDragging(true);
    p.say(announce.picked(vm.cards[id]?.title ?? id));
  };

  // Move AND over: dnd-kit reports a new `over` through onDragOver after the move that
  // caused it, so a pointer that stops right on a head was never seen there by onDragMove.
  const onMove = (e: DragMoveEvent | DragOverEvent) => {
    const id = String(e.active.id);
    const overId = e.over ? String(e.over.id) : '';
    if (!overId) { if (dropRef.current) { dropRef.current = null; setDrop(null); } clearUnfold(); return; }
    const laneId = overId.slice(overId.indexOf(':') + 1);
    const lane = p.lanes.find((l) => l.id === laneId);
    if (!lane) return;
    const isHead = overId.startsWith('head:');
    if (isHead && view.isFolded(laneId, lane.kind)) {
      if (unfoldTimer.current?.lane !== laneId) {
        clearUnfold();
        unfoldTimer.current = { lane: laneId, t: setTimeout(() => { view.unfold(laneId); unfoldTimer.current = null; }, 600) };
      }
    } else clearUnfold();
    const act = e.activatorEvent as PointerEvent;
    const y = pointer.y ?? (act?.clientY ?? 0) + e.delta.y;
    const shown = shownOf(laneId);
    let target: DropTarget;
    if (isHead) target = { type: 'head' };
    else {
      const body = document.querySelector(`[data-testid="kanban-lane-body"][data-lane-id="${CSS.escape(laneId)}"]`);
      const boxes = Array.from(body?.querySelectorAll<HTMLElement>('[data-testid="kanban-card"]') ?? [])
        .filter((el) => el.dataset.taskId !== id)
        .map((el) => { const r = el.getBoundingClientRect(); return { id: el.dataset.taskId ?? '', top: r.top, height: r.height }; });
      target = cardTargetAt(y, boxes);
    }
    const r = dropInLane(p.layout[laneId] ?? [], shown, id, target, lane.kind);
    const next = { lane: laneId, lineBefore: r.lineBefore, index: r.index };
    const cur = dropRef.current;
    if (!cur || cur.lane !== next.lane || cur.lineBefore !== next.lineBefore || cur.index !== next.index) {
      dropRef.current = next;
      setDrop(next);
      const rest = shown.filter((x) => x !== id);
      const n = rest.length + 1;
      const pos = r.lineBefore === null ? n : rest.indexOf(r.lineBefore) + 1;
      const text = announce.over(vm.cards[id]?.title ?? id, lane.name, lane.kind === 'done' ? 1 : pos, n);
      if (text !== lastSaid.current) { lastSaid.current = text; p.say(text); }
    }
  };

  const finish = () => {
    setActive(null);
    dropRef.current = null;
    setDrop(null);
    clearUnfold();
    p.onDragging(false);
  };

  const onEnd = (e: DragEndEvent) => {
    const id = String(e.active.id);
    const d = dropRef.current;
    finish();
    if (!e.over || !d) { p.say(announce.cancelled()); return; }
    const card = vm.cards[id];
    const lane = p.lanes.find((l) => l.id === d.lane);
    if (!card || !lane) { p.say(announce.cancelled()); return; }
    const same = card.lane === d.lane;
    if (same && (p.layout[card.lane] ?? []).indexOf(id) === d.index) { p.say(announce.cancelled()); return; }
    p.say(announce.dropped(card.title, lane.name, lane.kind === 'done' ? 1 : d.index + 1));
    void p.api.moveCard(id, d.lane, { index: d.index, rankOnly: same, reason: 'drag' });
  };

  const onCancel = () => { finish(); p.say(announce.cancelled()); };

  const line = drop ?? p.keyDrop;
  const keyGhost = !drop && p.keyDrop && p.keyDragId ? p.keyDrop.lane : null;
  const overlayCard = active ? vm.cards[active] : null;
  const lanesEl = useMemo(() => vm.lanes, [vm.lanes]);
  const [edgesRef, edges] = useScrollEdges();
  // Stable: a new ref function each render would detach and attach the scroller every render.
  const outerScrollRef = useRef(p.scrollRef);
  outerScrollRef.current = p.scrollRef;
  const scrollerRef = useCallback((el: HTMLDivElement | null) => { outerScrollRef.current(el); edgesRef(el); }, [edgesRef]);
  // N4: a wide board's folded done lanes sit OUTSIDE the scrolling row, so no lane ever slides under one.
  const rails = mode === 'wide' ? lanesEl.filter((l) => l.lane.kind === 'done' && !view.isRailOpen(l.lane.id)) : [];

  return (
    <DndContext sensors={sensors} collisionDetection={laneCollision} autoScroll={AUTO_SCROLL} onDragStart={onStart} onDragMove={onMove} onDragOver={onMove} onDragEnd={onEnd} onDragCancel={onCancel}>
      <div className={`kanban-lanes-row kanban-lanes-row-${mode}`} onPointerDown={(e) => e.stopPropagation()}>
      <div
        ref={scrollerRef}
        className={`kanban-lanes kanban-lanes-${mode}${active ? ' is-dragging' : ''}`}
        data-testid="kanban-lanes"
        data-more-left={mode === 'wide' && edges.left ? 'true' : undefined}
        data-more-right={mode === 'wide' && edges.right ? 'true' : undefined}
      >
        {lanesEl.map((lvm, i) => {
          const id = lvm.lane.id;
          const order = p.layout[id] ?? lvm.cardIds;
          const visible = p.filter.active ? (t: string) => p.filter.isVisible(t) : null;
          if (rails.includes(lvm)) return null;
          // R3-07: counted as drawn (a Handled card stays drawn), the same rule as the strip.
          const drawn = p.filter.active ? (t: string) => p.filter.isVisible(t) || p.filter.isHandled(t) : null;
          return (
            <KanbanLane
              key={id} lane={filteredLane(lvm, vm.cards, drawn)} order={order} cards={vm.cards} lanes={p.lanes} index={i} mode={mode}
              folded={view.isFolded(id, lvm.lane.kind)} onToggleFold={() => view.toggleFold(id, lvm.lane.kind)}
              api={p.api} deletePreview={p.deletePreview} flashing={p.flashingLane === id}
              visible={visible} isHandled={p.filter.isHandled} filterEmpty={!!p.filter.emptyText}
              tabStop={p.tabStops[id] ?? null} moved={p.moved} flash={p.flash}
              dropBefore={line?.lane === id ? line.lineBefore : undefined} dropOver={line?.lane === id} draggingId={active}
              showAll={view.isShowAll(id)} onShowAll={(all) => view.setShowAll(id, all)}
              pending={p.pending.filter((a) => a.laneId === id)} loading={vm.loading} autoAdd={p.autoAddLane === id}
              {...(mode === 'wide' && lvm.lane.kind === 'done' ? { onFoldRail: () => view.setRailOpen(id, false) } : {})}
              keyDragId={p.keyDragId} reducedMotion={p.reducedMotion} keyGhost={keyGhost === id && p.keyDragId ? vm.cards[p.keyDragId]?.title ?? '' : null}
            />
          );
        })}
        <div className="kanban-add-lane-slot">{p.addLane}</div>
      </div>
      {rails.length > 0 && (
        <div className="kanban-rails" data-testid="kanban-rails">
          {rails.map((lvm) => (
            <KanbanDoneRail key={lvm.lane.id} lane={filteredLane(lvm, vm.cards, p.filter.active ? (t) => p.filter.isVisible(t) || p.filter.isHandled(t) : null)} readOnly={p.api.readOnly} dropOver={line?.lane === lvm.lane.id}
              flashing={p.flashingLane === lvm.lane.id} onOpen={() => view.setRailOpen(lvm.lane.id, true)} />
          ))}
        </div>
      )}
      </div>
      <DragOverlay className="kanban-drag-overlay-host" style={{ pointerEvents: 'none' }} dropAnimation={{ duration: 150, easing: 'ease' }}>
        {overlayCard ? (
          <div className={`kanban-drag-overlay${p.reducedMotion ? '' : ' is-tilted'}`}>
            <KanbanCard vm={overlayCard} laneName={vm.lanes.find((l) => l.lane.id === overlayCard.lane)?.lane.name ?? ''} tabStop={false} overlay />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
