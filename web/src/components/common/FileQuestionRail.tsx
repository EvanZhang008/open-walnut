/**
 * The Files tab's question rail: at the top left of the file on show, one thin
 * mark per question about a passage of THIS file (the draft being written
 * dashed, the open one dark), the same marks the session column's map draws
 * when it is a rail. Hovering, focusing or tapping it opens the labelled list
 * (number, title, status) over the document; a row opens that question's card
 * beside its passage. Without it the reader of a long document had no way to
 * see what had been asked in it, or where (2026-10-02).
 *
 * Positioned by FileThreadLayer under the view's toolbar, so it never covers a
 * button and never depends on the surface (editor, preview, the HTML iframe).
 */
import { memo, useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { MapRow, rowDomId } from '@/components/sessions/ThreadMap';
import type { FileRailRow } from '@/utils/file-thread';
import { mapOverlayWidth, mapStep, railMarks } from '@/utils/thread-map';
import '@/styles/thread-map.css';

export interface FileQuestionRailProps {
  rows: FileRailRow[];
  /** px from the layer's top: just under the file view's toolbar. */
  top: number;
  /** px of height below `top` the rail and its list may use. */
  room: number;
  /** The file view's width, px: the list never runs past it. */
  boxWidth: number;
  onOpen: (key: string) => void;
}

/** Same close-out delay as the map's rail: a diagonal path from the rail to a
 *  row leaves the nav for a frame. */
const CLOSE_DELAY_MS = 140;

export const FileQuestionRail = memo(function FileQuestionRail({ rows, top, room, boxWidth, onOpen }: FileQuestionRailProps) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const show = useCallback(() => { clearTimeout(closeTimer.current); setOpen(true); }, []);
  const hide = useCallback(() => {
    clearTimeout(closeTimer.current);
    closeTimer.current = setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, []);
  const closeNow = useCallback(() => { clearTimeout(closeTimer.current); setOpen(false); }, []);
  const navRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  // A tap opened it: a press anywhere else closes it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && navRef.current?.contains(e.target)) return;
      closeNow();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [open, closeNow]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const onClickRow = useCallback((id: string, byKey: boolean) => {
    const row = rowsRef.current.find((r) => r.key === id);
    if (!row) return;
    closeNow();
    if (byKey) railRef.current?.focus({ preventScroll: true });
    onOpenRef.current(row.key);
  }, [closeNow]);
  const onFocusStop = useCallback((stop: string) => setCursor(stop), []);

  // ArrowDown on the rail goes into its list; arrows walk the rows; Esc closes
  // and hands focus back to the rail.
  const enterList = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown') return;
    e.preventDefault();
    show();
    requestAnimationFrame(() => navRef.current?.querySelector<HTMLElement>('.thread-map-overlay [data-map-entry]')?.focus({ preventScroll: true }));
  };
  const onListKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-map-stop]'));
    const at = (document.activeElement as HTMLElement | null)?.dataset?.mapStop;
    const next = mapStep(els.map((el) => el.dataset.mapStop ?? ''), at, e.key);
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setCursor(next);
    els.find((el) => el.dataset.mapStop === next)?.focus({ preventScroll: true });
  };

  if (rows.length === 0) return null;
  const { marks, more } = railMarks(rows, Math.max(0, room - 12));
  const currentId = rows.find((r) => r.current)?.key;
  const stops = rows.map((r) => rowDomId(r.key));
  const tabStop = (cursor && stops.includes(cursor) ? cursor : undefined)
    ?? (currentId ? rowDomId(currentId) : undefined) ?? stops[0];
  const style = {
    top,
    ['--thread-map-maxh' as string]: `${Math.max(120, room - 8)}px`,
    ['--thread-map-overlay-w' as string]: `${mapOverlayWidth(boxWidth)}px`,
  } as CSSProperties;
  const label = `Questions in this file: ${rows.length}`;
  return (
    <nav
      ref={navRef}
      className={`fv-file-rail${open ? ' is-open' : ''}`}
      aria-label={label}
      style={style}
      data-testid="file-question-rail"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        closeNow();
        railRef.current?.focus({ preventScroll: true });
      }}
    >
      <button
        ref={railRef}
        type="button"
        className="thread-map-rail"
        tabIndex={0}
        aria-expanded={open}
        aria-label={label}
        onClick={show}
        onKeyDown={enterList}
      >
        {marks.map((row) => (
          <span
            key={row.key}
            className="thread-map-mark"
            data-kind={row.kind}
            data-status={row.status}
            data-current={row.current ? 'true' : undefined}
            data-unread={row.unread ? 'true' : undefined}
          >
            <span className="thread-map-tick" aria-hidden="true" />
          </span>
        ))}
        {more > 0 && <span className="thread-map-mark thread-map-mark--more">+{more}</span>}
      </button>
      {open && (
        <div className="thread-map-overlay" onKeyDown={onListKeyDown}>
          <div className="thread-map-head">
            <span className="thread-map-title">In this file</span>
            <span className="thread-map-count">{rows.length}</span>
          </div>
          <div className="thread-map-rows">
            {rows.map((row) => {
              const stop = rowDomId(row.key);
              return (
                <MapRow
                  key={row.key}
                  id={row.key}
                  stop={stop}
                  kind={row.kind}
                  status={row.status}
                  current={row.current}
                  onPath={row.current}
                  expanded={false}
                  disabled={false}
                  name={row.naming ? `${row.title} (naming)` : row.title}
                  label={row.title}
                  naming={row.naming}
                  depth={0}
                  number={row.number}
                  tabIndex={-1}
                  entry={stop === tabStop}
                  unread={row.unread ? 'New answer' : undefined}
                  wide
                  onFocusStop={onFocusStop}
                  onClickRow={onClickRow}
                />
              );
            })}
          </div>
        </div>
      )}
    </nav>
  );
});
