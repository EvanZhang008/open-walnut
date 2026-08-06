/**
 * drag-bus — a tiny cross-component drag platform.
 *
 * Different surfaces own their own drag tech (TodoPanel and CalendarPage each
 * run their own dnd-kit DndContext; calendar chips use useDragGesture), and
 * dnd-kit cannot drop across contexts — so cross-panel drops (todo card →
 * calendar side panel) need a neutral channel. The bus is that channel:
 *
 *   source (any drag tech)            target (any component)
 *   ── begin(payload) on drag start   ── register(spec) with an element getter
 *   ── (bus tracks the live pointer)  ── onDragOver / onDragLeave as it moves
 *   ── end() on drop → handled?       ── onDrop(point, payload) → true = took it
 *   ── cancel() on Escape/abort
 *
 * Contract for sources: call end() BEFORE your own drop handling and skip it
 * when a bus target consumed the drop (dnd-kit's collision detection can
 * still report a stray in-context `over` while the pointer is physically
 * over another panel — closestCenter always finds *something*).
 *
 * Targets hit-test by bounding rect (smallest area wins on overlap) —
 * document.elementFromPoint would hit the source's drag overlay instead.
 * The bus renders nothing; targets own their previews and drop effects.
 */
import type { Task } from '@open-walnut/core';

export type DragBusPayload = { kind: 'task'; task: Task };

export interface DragBusPoint {
  x: number;
  y: number;
}

export interface DropTargetSpec {
  /** Resolved per hit-test, so remounting elements stay correct. */
  element: () => HTMLElement | null;
  onDragOver?: (point: DragBusPoint, payload: DragBusPayload) => void;
  onDragLeave?: () => void;
  /** Return false to decline — the source then runs its own drop handling. */
  onDrop: (point: DragBusPoint, payload: DragBusPayload) => boolean | void;
}

class DragBus {
  private targets = new Set<DropTargetSpec>();
  private payload: DragBusPayload | null = null;
  private point: DragBusPoint = { x: 0, y: 0 };
  private hovered: DropTargetSpec | null = null;

  /** Register a drop target. Returns the unregister function. */
  register(spec: DropTargetSpec): () => void {
    this.targets.add(spec);
    return () => {
      this.targets.delete(spec);
      if (this.hovered === spec) this.hovered = null;
    };
  }

  /** A drag with a bus-relevant payload started. Idempotent-safe: a stale
   *  active drag (source died without end/cancel) is cancelled first. */
  begin(payload: DragBusPayload, start?: DragBusPoint): void {
    if (this.payload) this.cancel();
    this.payload = payload;
    if (start) this.point = { ...start };
    window.addEventListener('pointermove', this.onPointerMove, { passive: true });
  }

  /** The source's drop fired. True = a target consumed it — the source must
   *  skip its own drop semantics. Always safe to call (no-op when idle). */
  end(): boolean {
    const payload = this.payload;
    const target = this.hovered;
    const point = this.point;
    this.teardown();
    if (!payload || !target) return false;
    return target.onDrop(point, payload) !== false;
  }

  cancel(): void {
    this.hovered?.onDragLeave?.();
    this.teardown();
  }

  private onPointerMove = (ev: PointerEvent): void => {
    if (!this.payload) return;
    this.point = { x: ev.clientX, y: ev.clientY };
    const next = this.hitTest(this.point);
    if (this.hovered && this.hovered !== next) this.hovered.onDragLeave?.();
    this.hovered = next;
    next?.onDragOver?.(this.point, this.payload);
  };

  private hitTest(pt: DragBusPoint): DropTargetSpec | null {
    let best: DropTargetSpec | null = null;
    let bestArea = Infinity;
    for (const t of this.targets) {
      const el = t.element();
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (pt.x < r.left || pt.x > r.right || pt.y < r.top || pt.y > r.bottom) continue;
      const area = r.width * r.height;
      if (area < bestArea) {
        best = t;
        bestArea = area;
      }
    }
    return best;
  }

  private teardown(): void {
    this.payload = null;
    this.hovered = null;
    window.removeEventListener('pointermove', this.onPointerMove);
  }
}

/** App-wide singleton — sources and targets live in unrelated React trees. */
export const dragBus = new DragBus();
