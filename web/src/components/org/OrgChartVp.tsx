/**
 * One VP card of the org chart (OrgChartSheet.tsx), and the CEO's card above them.
 *
 * A card is its avatar, its name, how many it has open and, in one line, what it is doing now
 * (2026-11-06, the user: "just show the name", "and can expand for more detail"; 2026-11-08,
 * names alone went too far: after the name, how many it has and what it is doing). The avatar
 * is the Org list's own, its corner dot that row's state (red: its threads wait on him). The
 * chart is a look at the hierarchy, not a place to decide (2026-11-08, the user: it is "not for
 * making decisions"), so an opened card says nothing about asks: it holds Open chat and its
 * menu. Each card remembers whether it was open (usePageViewOf, per card).
 */
import type { DragEvent, KeyboardEvent, ReactNode } from 'react';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { OrgAvatar } from './OrgChannelList';
import { theVp, type NowLine, type VpCard } from './org-chart-model';
import type { ChannelRow } from './org-channels-model';

/** A clickable div: Enter and Space press it too. */
export function pressable(onPress: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: onPress,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPress(); }
    },
  };
}

/** An element id from a row key ("project:event service" has a space, which breaks aria-controls). */
// One to one: every other UTF-16 unit, "_" included, becomes "_" and four hex digits.
export const domId = (prefix: string, key: string): string => `${prefix}-${key.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;

/** Whether a card or row is open, kept per key on the Org page's view. */
export function useChartOpen(key: string): [boolean, () => void] {
  const [open, setOpen] = usePageViewOf('org', 'chart.open', key, false, isBoolean);
  return [open, () => setOpen((v) => !v)];
}

interface CeoProps {
  main: ChannelRow;
  /** "5 VPs · 5 Working". */
  line: string;
  onOpenChat: () => void;
  /** Its ⋯ menu. */
  more: ReactNode;
}

export function OrgChartCeo({ main, line, onOpenChat, more }: CeoProps) {
  const [open, toggle] = useChartOpen(`vp:${main.key}`);
  return (
    <div className={`oc-card oc-ceo${open ? ' is-open' : ''}`} data-testid="org-chart-ceo-card">
      <div className="oc-card-btn" data-testid="org-chart-ceo" aria-expanded={open} aria-controls="oc-detail-ceo" title={open ? 'Hide the CEO\'s actions' : 'Show the CEO\'s actions'} {...pressable(toggle)}>
        <OrgAvatar row={main} size={34} />
        <span className="oc-card-main">
          <span className="oc-card-title">CEO</span>
          <span className="oc-doing" data-testid="org-chart-ceo-now">{line}</span>
        </span>
      </div>
      {open && (
        <div className="oc-detail" id="oc-detail-ceo" data-testid="org-chart-ceo-detail">
          <div className="oc-detail-actions">
            <button type="button" className="oc-detail-btn" data-testid="org-chart-ceo-open" onClick={onOpenChat}>Open chat</button>
            {more}
          </div>
        </div>
      )}
    </div>
  );
}

interface VpProps {
  card: VpCard;
  /** The li's own class words (drag and drop states) and its drop zone. */
  className: string;
  zone: Record<string, unknown>;
  /** A VP made only to put projects under has no project of its own to drag. */
  draggable: boolean;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onContextMenu: (from: HTMLElement, point: { x: number; y: number }) => void;
  onOpenChat: () => void;
  /** Its open tasks and what it is doing now, after its name. */
  line: NowLine;
  /** Its ⋯ menu, for a VP (the Inbox has none). */
  more: ReactNode;
  /** The project rows, and the drop hint. */
  children: ReactNode;
}

export function OrgChartVp({ card: c, line, className, zone, draggable, onDragStart, onDragEnd, onContextMenu, onOpenChat, more, children }: VpProps) {
  // Its own key is its home project's row key too: the card and that row open apart.
  const [open, toggle] = useChartOpen(`vp:${c.key}`);
  const detailId = domId('oc-detail', c.key);
  return (
    <li
      className={`${className}${open ? ' is-open' : ''}`}
      data-testid="org-chart-vp"
      data-key={c.key}
      data-project={c.project}
      {...zone}
    >
      <div
        className="oc-vp-head"
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onContextMenu={(e) => { e.preventDefault(); onContextMenu(e.currentTarget, { x: e.clientX, y: e.clientY }); }}
        data-testid="org-chart-vp-handle"
      >
        {/* A div, not a button: WebKit and Firefox start no drag from inside a button. */}
        <div
          className="oc-card-btn"
          data-testid="org-chart-vp-toggle"
          aria-expanded={open}
          aria-controls={detailId}
          title={open ? `Hide the actions of ${theVp(c.name)}` : `Show the actions of ${theVp(c.name)}`}
          {...pressable(toggle)}
        >
          <OrgAvatar row={c.row} size={30} />
          <span className="oc-card-main">
            <span className="oc-card-headline">
              <span className="oc-card-title" data-testid="org-chart-vp-name">{c.name}</span>
              <span className="oc-role">{c.role}</span>
              <span className="oc-now" data-testid="org-chart-vp-now">{line.open} open</span>
            </span>
            {/* What it is doing now: its newest task at work, one line the card's width. */}
            {line.doing && <span className="oc-doing" data-testid="org-chart-vp-doing" title={line.words ? `${line.doing}: ${line.words}` : line.doing}>{line.doing}</span>}
          </span>
        </div>
      </div>
      {open && (
        <div className="oc-detail" id={detailId} data-testid="org-chart-vp-detail">
          {c.projects.length === 0 && <p className="oc-detail-line is-muted" data-testid="org-chart-vp-empty">{c.line}</p>}
          <div className="oc-detail-actions">
            <button type="button" className="oc-detail-btn" data-testid="org-chart-vp-open" onClick={onOpenChat}>Open chat</button>
            {more}
          </div>
        </div>
      )}
      {children}
    </li>
  );
}
