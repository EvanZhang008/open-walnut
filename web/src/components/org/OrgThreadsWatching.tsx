/**
 * Watching: the threads he keeps an eye on, a group of their own at the top of a node's Threads
 * (2026-11-23, the user, translated: "turn the pin into a watch ... its own category ... of course
 * it is still in working or whatever, but at the same time it is in Watching ... the same idea as
 * our tasks: a task can become watching, also its own category"). Each watched thread is drawn here
 * AND in its own group, by the same card (OrgThreads ThreadItem with a `copy`); nothing else about
 * it moves. The list is oldest watch first and he drags a card by its grip to reorder it, written as
 * the thread's `watched.at` (the task Watching's order, tasks/status-sections.ts watchReorder). It
 * opens unfolded; a fold he makes lasts while he is here, never remembered (the other groups' rule).
 */
import { memo, useCallback, useMemo, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react';
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, type AnimateLayoutChanges, defaultAnimateLayoutChanges } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DisclosureButton } from '@/components/controls';
import { ICON_EYE_FILLED } from '@/components/common/Icons';
import type { OrgThread } from '@/api/org-threads';
import { watchReorder } from '../tasks/status-sections';

/**
 * The card drawn a second time, in Watching (OrgThreads.tsx ThreadCard): its element ids get a suffix
 * so the two copies never share one, and its grip drags it in that list.
 */
export interface WatchingCopy {
  setNodeRef: (el: HTMLElement | null) => void;
  style: CSSProperties;
  grip: HTMLAttributes<HTMLElement>;
  dragging: boolean;
}

const DRAG = { activationConstraint: { distance: 5 } };
// A card that was just dropped takes its place at once, with no slide back from where it started.
const noAnimateAfterDrag: AnimateLayoutChanges = (args) => (args.isSorting || args.wasDragging ? false : defaultAnimateLayoutChanges(args));

const SortableCard = memo(function SortableCard({ t, card }: { t: OrgThread; card: (t: OrgThread, copy: WatchingCopy) => ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: t.id, animateLayoutChanges: noAnimateAfterDrag });
  const copy = useMemo<WatchingCopy>(() => ({
    setNodeRef,
    style: { transform: CSS.Transform.toString(transform), transition, ...(isDragging ? { zIndex: 2, position: 'relative' as const } : {}) },
    grip: { ...attributes, ...listeners },
    dragging: isDragging,
  }), [setNodeRef, attributes, listeners, transform, transition, isDragging]);
  return <>{card(t, copy)}</>;
});

/** The places a drop writes: each moved thread's new `watched.at`. Pure. */
export function watchingReorder(threads: readonly OrgThread[], fromId: string, toIndex: number, now: number): { id: string; watch_at: string }[] {
  const rows = threads.map((t) => ({ id: t.id, watched_at: t.watched?.at }));
  return watchReorder(rows, fromId, toIndex, now).map((w) => ({ id: w.id, watch_at: w.watched_at }));
}

export function OrgThreadsWatching({ threads, card, onReorder }: {
  /** The watched threads, in Watching's order (thread-view.ts watchingOf). */
  threads: readonly OrgThread[];
  card: (t: OrgThread, copy: WatchingCopy) => ReactNode;
  onReorder: (writes: { id: string; watch_at: string }[]) => void;
}) {
  const [open, setOpen] = useState(true);
  const sensors = useSensors(useSensor(PointerSensor, DRAG));
  const ids = useMemo(() => threads.map((t) => t.id), [threads]);
  const onDragEnd = useCallback((e: DragEndEvent) => {
    const to = e.over ? ids.indexOf(String(e.over.id)) : -1;
    if (to < 0 || String(e.active.id) === String(e.over?.id)) return;
    const writes = watchingReorder(threads, String(e.active.id), to, Date.now());
    if (writes.length) onReorder(writes);
  }, [ids, threads, onReorder]);
  if (!threads.length) return null;
  const count = <span className="org-thread-group-count" data-testid="org-thread-group-count">{threads.length}</span>;
  return (
    <section className="org-thread-group org-thread-watching" data-testid="org-thread-group" data-group="watching" data-open={open ? 'true' : 'false'}>
      <DisclosureButton block expanded={open} trailing={count} className="org-thread-group-fold" data-testid="org-thread-group-head" onClick={() => setOpen(!open)}>
        <span className="org-thread-group-label"><span className="org-thread-watching-eye" aria-hidden="true">{ICON_EYE_FILLED}</span>Watching</span>
      </DisclosureButton>
      {open && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            <ul className="org-thread-list" data-testid="org-thread-list" data-show="watching">
              {threads.map((t) => <SortableCard key={t.id} t={t} card={card} />)}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  );
}
