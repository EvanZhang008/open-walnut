/**
 * The drag handle on the right edge of the folders column or the message list column.
 *
 * Drag it, or focus it and use the arrow keys; double-click puts the column back to the default width
 * (the stylesheet's, which follows the window). The column's live width is read from the DOM when a
 * drag starts, so a column still on its default starts from what is on screen, not from a number the
 * stylesheet picked for another breakpoint.
 *
 * `useDragGesture` captures the pointer, so the drag keeps working over the reader's mail body, which
 * is an iframe and would otherwise swallow the move and the release.
 */
import { useRef, type KeyboardEvent } from 'react';
import { useDragGesture } from '@/hooks/useDragGesture';
import { PANE_BOUNDS, PANE_KEY_STEP, clampPane, type MailPaneId } from './mail-pane-widths';

const LABELS: Record<MailPaneId, string> = {
  accounts: 'Resize the folder list',
  list: 'Resize the message list',
};

export function MailPaneSplitter({ id, width, onWidth, onDone, onReset, measure }: {
  id: MailPaneId;
  /** The stored width, or undefined while the column follows the default. */
  width: number | undefined;
  /** Live, while dragging (not persisted). */
  onWidth: (width: number) => void;
  /** The drag or key press settled on this width: persist it. */
  onDone: (width: number) => void;
  onReset: () => void;
  /** The column's width on screen and the room it may take (console width minus the other column). */
  measure: () => { width: number; room: number } | null;
}) {
  const start = useRef<{ width: number; room: number; stored: number | undefined } | null>(null);
  const last = useRef<number | null>(null);
  const { onPointerDown, isDragging } = useDragGesture({
    cursor: 'col-resize',
    onStart: () => {
      const now = measure();
      start.current = now ? { ...now, stored: width } : null;
      last.current = null;
    },
    onMove: ({ dx }) => {
      const from = start.current;
      if (!from) return;
      const next = clampPane(id, from.width + dx, from.room);
      last.current = next;
      onWidth(next);
    },
    onEnd: ({ canceled }) => {
      const from = start.current;
      start.current = null;
      if (canceled) {
        // Escape (or a lost pointer) puts the column back where the drag began.
        if (from) {
          if (from.stored === undefined) onReset();
          else onWidth(from.stored);
        }
        return;
      }
      if (last.current !== null) onDone(last.current);
    },
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const now = measure();
    if (!now) return;
    const next = clampPane(id, now.width + (event.key === 'ArrowRight' ? PANE_KEY_STEP : -PANE_KEY_STEP), now.room);
    onWidth(next);
    onDone(next);
  };

  const { min, max } = PANE_BOUNDS[id];
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={LABELS[id]}
      aria-valuemin={min}
      aria-valuemax={max}
      {...(width !== undefined ? { 'aria-valuenow': width } : {})}
      tabIndex={0}
      className={`mail-pane-splitter mail-pane-splitter-${id}${isDragging ? ' dragging' : ''}`}
      data-testid={`mail-splitter-${id}`}
      title="Drag to resize. Double-click to reset."
      onPointerDown={onPointerDown}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}
