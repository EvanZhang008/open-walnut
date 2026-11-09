/**
 * TerminalDock — the frame the session's terminals sit in inside the split's left
 * column: the whole column (the Terminal view), or docked under Changed / Files /
 * Web with a handle on its top edge to drag its height.
 *
 * One frame for both, at one place in the column, so going from the Terminal view
 * to "Changed above, terminal below" (and back) keeps every terminal mounted:
 * no reconnect, no lost scrollback, no focus jump.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export const DOCK_DEFAULT_PX = 300;
const DOCK_MIN_PX = 120;
/** Room the view above always keeps. */
const VIEW_MIN_PX = 240;

interface TerminalDockProps {
  docked: boolean;
  /** The kept height (px); absent: the default. */
  px?: number;
  /** The height the terminals need (stacked panes); the dock is at least this, as far as the column allows. */
  wantPx?: number;
  onResized: (px: number) => void;
  children: ReactNode;
}

export function TerminalDock({ docked, px, wantPx = 0, onResized, children }: TerminalDockProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [dragPx, setDragPx] = useState<number | null>(null);
  const drag = useRef<{ startY: number; startPx: number; max: number } | null>(null);

  const clamp = useCallback((h: number, max: number) => Math.round(Math.max(DOCK_MIN_PX, Math.min(h, max))), []);
  const maxPx = useCallback(() => {
    const col = frameRef.current?.parentElement;
    return Math.max(DOCK_MIN_PX, (col?.clientHeight ?? 600) - VIEW_MIN_PX);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = frameRef.current?.getBoundingClientRect().height ?? px ?? DOCK_DEFAULT_PX;
    drag.current = { startY: e.clientY, startPx: start, max: maxPx() };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragPx(start);
  }, [maxPx, px]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setDragPx(clamp(d.startPx + (d.startY - e.clientY), d.max));
  }, [clamp]);
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const h = clamp(d.startPx + (d.startY - e.clientY), d.max);
    setDragPx(null);
    onResized(h);
  }, [clamp, onResized]);
  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const cur = frameRef.current?.getBoundingClientRect().height ?? px ?? DOCK_DEFAULT_PX;
    onResized(clamp(cur + (e.key === 'ArrowUp' ? 24 : -24), maxPx()));
  }, [clamp, maxPx, onResized, px]);

  // A column made shorter (the window) keeps the view above its room.
  const [colMax, setColMax] = useState<number | null>(null);
  useEffect(() => {
    if (!docked) return;
    const col = frameRef.current?.parentElement;
    if (!col) return;
    const ro = new ResizeObserver(() => setColMax(maxPx()));
    ro.observe(col);
    return () => ro.disconnect();
  }, [docked, maxPx]);

  const height = dragPx ?? Math.min(Math.max(px ?? DOCK_DEFAULT_PX, wantPx), colMax ?? Number.POSITIVE_INFINITY);
  return (
    <div
      ref={frameRef}
      className={`session-terminal-dock${docked ? ' is-docked' : ' is-full'}${dragPx !== null ? ' is-resizing' : ''}`}
      style={docked ? { height } : undefined}
      data-testid="terminal-dock-frame"
    >
      {docked && (
        <div
          className="session-terminal-dock-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Terminal height"
          tabIndex={0}
          title="Drag to resize the terminal"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          data-testid="terminal-dock-resize"
        />
      )}
      {children}
    </div>
  );
}
