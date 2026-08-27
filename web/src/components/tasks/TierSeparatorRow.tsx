/**
 * TierSeparatorRow — one hand-placed divider line inside a pinned tier list.
 * With a `label` it reads as a section heading ("Now", "Next"); without one it
 * is the plain hairline it always was. Either way it is layout, not data: no
 * task references it.
 *
 * TWO variants, one per tier view mode:
 *
 *  • TierSeparatorRow (project mode) — PLAIN DOM with HTML5 drag, same call the
 *    project folder labels make: folders aren't sortable units, so the line
 *    can't be one either. While a CARD drag is live it goes inert.
 *
 *  • SortableTierSeparatorRow (custom mode) — a REAL dnd-kit sortable unit, the
 *    same architecture as the group chip (tier-group-sentinels.ts). Being in
 *    `items` means the strategy displaces the line together with the cards
 *    around it during any drag, so a card can never visually cross it
 *    (2026-08-25: the static line let make-room transforms slide cards straight
 *    through it, and no slot could open above a top-anchored line).
 */
import { useState, useRef, useEffect, type CSSProperties, type FormEvent } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const ICON_LINE_DELETE = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

const ICON_LINE_EDIT = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10z" />
  </svg>
);

/** Label + inline rename, shared by both variants. Editing is local state; the
 *  commit goes through onRename (empty text clears the label back to a line). */
function SeparatorLabel({ id, label, onRename }: {
  id: string;
  label?: string;
  onRename?: (id: string, label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
  if (!onRename) {
    return label ? <span className="tier-separator-label">{label}</span> : null;
  }
  if (editing) {
    const commit = (e: FormEvent) => {
      e.preventDefault();
      setEditing(false);
      const next = (inputRef.current?.value ?? '').trim();
      if (next !== (label ?? '')) onRename(id, next);
    };
    return (
      <form className="tier-separator-label-form" onSubmit={commit}
        // The row is (or sits inside) a drag source — typing/clicking in the
        // input must never arm a drag. Keys must not bubble either: the sortable
        // container carries dnd-kit's KeyboardSensor listeners, and an Enter that
        // reaches them starts a keyboard DRAG instead of submitting the name.
        onPointerDown={(e) => e.stopPropagation()} draggable={false}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}>
        <input ref={inputRef} className="tier-separator-label-input" defaultValue={label ?? ''}
          placeholder="Heading…" autoFocus
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Escape') setEditing(false);
          }} />
      </form>
    );
  }
  return label ? (
    <span className="tier-separator-label" title="Rename heading"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {label}
    </span>
  ) : (
    <button type="button" className="tier-separator-edit" title="Name this heading" aria-label="Name this heading"
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}>
      {ICON_LINE_EDIT}
    </button>
  );
}

function DeleteButton({ id, onDelete }: { id: string; onDelete: (id: string) => void }) {
  return (
    <button
      type="button"
      className="tier-separator-delete"
      // The row is a native/dnd drag handle: a dragstart that begins on the
      // button must not arm a move (same trap the project label's "+" hit).
      draggable={false}
      onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.stopPropagation(); onDelete(id); }}
      title="Remove"
      aria-label="Remove separator"
    >
      {ICON_LINE_DELETE}
    </button>
  );
}

export function TierSeparatorRow({ id, label, inert, isDragging, onDragStart, onDragEnd, onDelete, onRename }: {
  id: string;
  label?: string;
  /** A card drag owns the pointer — render read-only. */
  inert?: boolean;
  /** This line is the one being dragged (ghosted at its old spot). */
  isDragging?: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDelete: (id: string) => void;
  onRename?: (id: string, label: string) => void;
}) {
  return (
    <div
      className={`tier-separator${inert ? ' tier-separator-inert' : ''}${isDragging ? ' tier-separator-dragging' : ''}${label ? ' tier-separator-named' : ''}`}
      data-separator-id={id}
      data-testid="tier-separator"
      draggable={!inert}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/walnut-separator', id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(id);
      }}
      onDragEnd={onDragEnd}
      title="Drag to move this separator"
    >
      <SeparatorLabel id={id} label={label} onRename={onRename} />
      <span className="tier-separator-line" />
      <DeleteButton id={id} onDelete={onDelete} />
    </div>
  );
}

/** Custom-mode variant: a full sortable unit. The whole row is the drag handle
 *  (listeners on the container), matching how the plain row drags today; the
 *  label/edit/delete controls stop pointer-down so they never arm a drag. */
export function SortableTierSeparatorRow({ id, tier, label, onDelete, onRename }: {
  id: string;
  tier: string;
  label?: string;
  onDelete: (id: string) => void;
  onRename?: (id: string, label: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    data: { type: 'separator', tier },
  });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // The DragOverlay carries the visible line; the in-list row marks the slot.
    opacity: isDragging ? 0.4 : undefined,
    position: 'relative',
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`tier-separator tier-separator-sortable${isDragging ? ' tier-separator-dragging' : ''}${label ? ' tier-separator-named' : ''}`}
      data-separator-id={id}
      data-testid="tier-separator"
      title="Drag to move this separator"
      {...attributes}
      {...listeners}
    >
      <SeparatorLabel id={id} label={label} onRename={onRename} />
      <span className="tier-separator-line" />
      <DeleteButton id={id} onDelete={onDelete} />
    </div>
  );
}
