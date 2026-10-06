/**
 * The What changed popover (spec 7.2, G28): every change since the user's
 * baseline, oldest first (`15:02 the leader moved V1000000104 from New to
 * Mitigating`). A portalled flyout placed by useMenuPlacement, at most 60% of
 * the viewport tall and scrolling inside; a row closes it and reveals its card
 * (scrolled into view, flashing). Escape closes and gives focus back to the
 * button that opened it.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import type { KanbanChange } from './kanban-changes-model';

export interface KanbanChangesProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  changes: readonly KanbanChange[];
  onPick(taskId: string): void;
  onClose(): void;
}

export function KanbanChanges({ open, anchorRef, changes, onPick, onClose }: KanbanChangesProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, menuRef, { align: 'left', minHeight: 120 });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
      anchorRef.current?.focus();
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    // First row takes focus, so the arrows walk the list.
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const maxHeight = Math.min(placement?.maxHeight ?? vh * 0.6, vh * 0.6);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[(i + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length];
    if (next) { e.preventDefault(); next.focus(); }
  };
  return createPortal(
    <div
      ref={menuRef}
      className="kanban-changes"
      data-testid="kanban-changes"
      role="menu"
      aria-label="What changed"
      style={{
        position: 'fixed', top: placement?.top ?? -9999, right: placement?.right ?? 0, maxHeight,
        visibility: placement ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {changes.length === 0 ? (
        <div className="kanban-changes-empty">Nothing changed since you last looked</div>
      ) : changes.map((c, i) => (
        <button
          key={`${c.taskId}-${c.kind}-${i}`}
          type="button"
          role="menuitem"
          className="kanban-changes-row"
          data-testid="kanban-changes-row"
          data-task-id={c.taskId}
          data-kind={c.kind}
          onClick={() => { onClose(); onPick(c.taskId); }}
        >{c.text}</button>
      ))}
    </div>,
    document.body,
  );
}
