/**
 * The divider between two panes of the Org page: the channel list and the node, the node's chat
 * and its side bar, the node and a task opened beside it (2026-11-02, the user, pointing at the line
 * before an opened task: "this line need ot move the bar"). One look and one behaviour for all of
 * them: drag it, or use the arrow keys (Home and End go to its edges); double-click resets it. The
 * width lives in useResizablePanel (an `open-walnut-` key, so it reaches the synced prefs).
 */
import type React from 'react';
import type { useResizablePanel } from '@/hooks/useResizablePanel';

type Panel = Pick<ReturnType<typeof useResizablePanel>, 'pct' | 'setPct' | 'handleProps'>;

interface Props {
  panel: Panel;
  /** The panel's room now, as % of the window (the same bounds the panel's hook takes). */
  bounds: () => { min: number; max: number };
  /** What a double-click does: put the default width back. */
  onReset: () => void;
  /** The room the bounds measure: until it is on screen the divider states no width. */
  roomRef: React.RefObject<HTMLElement | null>;
  /** The width that shows now, as % of the window, when it can differ from the panel's pct (a CSS default). */
  shownPct?: () => number | null;
  /** Which side of the divider the panel it sizes is on: a panel on the right widens to the left. */
  panelSide: 'left' | 'right';
  label: string;
  testId: string;
  className?: string;
  /** The element the panel's hook marks `resizing` while a drag runs, when it is this divider. */
  elRef?: (el: HTMLDivElement | null) => void;
}

export function OrgPaneHandle({ panel, bounds, onReset, roomRef, shownPct, panelSide, label, testId, className, elRef }: Props) {
  /** The width that shows, within its room now. */
  const shown = (b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, shownPct?.() ?? panel.pct));
  const px = (v: number) => Math.round((v / 100) * (window.innerWidth || 1));
  // What the divider tells a screen reader: the width that shows, in pixels, within its room.
  const b = roomRef.current ? bounds() : null;
  const aria = b && b.max >= b.min
    ? { 'aria-valuemin': px(b.min), 'aria-valuemax': px(b.max), 'aria-valuenow': px(shown(b)), 'aria-valuetext': `${px(shown(b))} pixels wide` }
    : {};
  const step = panelSide === 'right' ? 2 : -2;
  return (
    <div
      ref={elRef}
      className={`org-pane-handle${className ? ` ${className}` : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label}: drag, or use the arrow keys; double-click resets it`}
      {...aria}
      tabIndex={0}
      data-testid={testId}
      {...panel.handleProps}
      onDoubleClick={onReset}
      onKeyDown={(e) => {
        const now = bounds();
        const at = shown(now);
        const next = e.key === 'ArrowLeft' ? at + step : e.key === 'ArrowRight' ? at - step
          : e.key === 'End' ? now.max : e.key === 'Home' ? now.min : null;
        if (next === null) return;
        e.preventDefault();
        panel.setPct(next);
      }}
    />
  );
}
