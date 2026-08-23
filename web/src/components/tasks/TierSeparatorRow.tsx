/**
 * TierSeparatorRow — one hand-placed divider line inside a pinned tier list.
 *
 * PLAIN DOM with HTML5 drag, deliberately NOT a dnd-kit sortable: the same call
 * the project folder labels make. Entering the SortableContext ids would shift
 * every card index and put a non-task id into the pinned reorder payload; the
 * native drag runs beside dnd-kit and touches neither.
 *
 * While a CARD drag is live the line goes inert (no grip, no delete) so it can't
 * become a second drag source mid-gesture.
 */

const ICON_LINE_DELETE = (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);

export function TierSeparatorRow({ id, inert, isDragging, onDragStart, onDragEnd, onDelete }: {
  id: string;
  /** A card drag owns the pointer — render read-only. */
  inert?: boolean;
  /** This line is the one being dragged (ghosted at its old spot). */
  isDragging?: boolean;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className={`tier-separator${inert ? ' tier-separator-inert' : ''}${isDragging ? ' tier-separator-dragging' : ''}`}
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
      <span className="tier-separator-line" />
      <button
        type="button"
        className="tier-separator-delete"
        // The row is a native drag handle: a dragstart that begins on the button
        // must not arm a move (same trap the project label's "+" hit).
        draggable={false}
        onDragStart={(e) => { e.preventDefault(); e.stopPropagation(); }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onDelete(id); }}
        title="Remove separator"
        aria-label="Remove separator"
      >
        {ICON_LINE_DELETE}
      </button>
    </div>
  );
}
