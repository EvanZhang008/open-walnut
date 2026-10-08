/**
 * CalendarsPopover — the in-view calendar visibility switcher (toolbar
 * "Calendars" button). Same data + PUT as Settings → Calendar, scoped to the
 * one thing you tweak while looking at the grid: which calendars show.
 * Footer links into the full Settings section for everything else.
 *
 * Visibility is written through the shared calendar store, not a private copy:
 * this popover used to keep its own optimistic list while the context menu's
 * "Hide calendar" patched the grid, so the same action felt instant one way and
 * laggy the other.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useCalendarVisibility } from '@/hooks/useCalendarEvents';
import type { CalendarEvent, CalendarInfo } from '@/api/calendar';
import './visibility.css';

interface Props {
  anchorEl: HTMLElement;
  onClose: () => void;
  /** Individually hidden events in the surface's range. */
  hiddenEvents?: CalendarEvent[];
  onShowEvent?: (eventId: string) => void;
}

function formatWhen(ev: CalendarEvent): string {
  const at = new Date(ev.start.includes('T') ? ev.start : `${ev.start}T00:00:00`);
  if (Number.isNaN(at.getTime())) return ev.start;
  const day = at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  return ev.allDay ? day : `${day}, ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

/** Its own portalled flyout, so a long list scrolls instead of growing the parent. */
function HiddenEventsFlyout({ anchorRef, events, onShow, onClose }: {
  anchorRef: RefObject<HTMLElement | null>;
  events: CalendarEvent[];
  onShow: (eventId: string) => void;
  onClose: () => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, listRef, { minHeight: 120, onAnchorLost: onClose });
  return createPortal(
    <div
      ref={listRef}
      className="cal-cals-popover cal-hidden-events"
      style={{ ...menuPlacementStyle(placement), zIndex: 10001 }}
      role="dialog"
      aria-label="Hidden events"
      data-testid="cal-hidden-events"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cal-cals-account">Hidden events</div>
      {events.length === 0 && <div className="cal-cals-empty">No hidden events here.</div>}
      {events.map((ev) => (
        <div key={ev.id} className="cal-hidden-events-row">
          <span className="cal-settings-dot" style={{ background: ev.color ?? 'var(--accent)' }} />
          <span className="cal-hidden-events-text">
            <span className="cal-cals-name" title={ev.title}>{ev.title || '(No title)'}</span>
            <span className="cal-hidden-events-when">{formatWhen(ev)}</span>
          </span>
          <button type="button" className="cal-hidden-events-show" onClick={() => onShow(ev.id)}>
            Show
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

export function CalendarsPopover({ anchorEl, onClose, hiddenEvents = [], onShowEvent }: Props) {
  const anchorRef = useRef<HTMLElement | null>(anchorEl);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hiddenBtnRef = useRef<HTMLButtonElement | null>(null);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const placement = useMenuPlacement(true, anchorRef, menuRef);
  const { calendars, unavailable, setHidden } = useCalendarVisibility();

  // Window-level Escape — the popover contains no autofocused input, so a div
  // onKeyDown never fires (focus stays on the toolbar button / body).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const byAccount = new Map<string, CalendarInfo[]>();
  for (const c of calendars ?? []) {
    const list = byAccount.get(c.account);
    if (list) list.push(c);
    else byAccount.set(c.account, [c]);
  }

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} />
      <div
        className="cal-cals-popover"
        ref={menuRef}
        style={menuPlacementStyle(placement)}
        data-testid="cal-cals-popover"
        role="menu"
        aria-label="Visible calendars"
        onPointerDown={(event) => event.stopPropagation()}
      >
        {calendars === null && !unavailable && <div className="cal-cals-empty">Loading…</div>}
        {unavailable && (
          <div className="cal-cals-empty">
            External calendars are off or unavailable — check{' '}
            <Link to="/settings#calendar" onClick={onClose}>
              Settings → Calendar Accounts
            </Link>
            .
          </div>
        )}
        {[...byAccount.entries()].map(([account, list]) => (
          <div key={account} className="cal-cals-group">
            <div className="cal-cals-account">{account}</div>
            {list.map((c) => (
              <button
                key={c.id}
                type="button"
                className="cal-cals-row"
                title={c.readonly ? `${c.title} (read-only)` : c.title}
                role="menuitemcheckbox"
                aria-checked={!c.hidden}
                onClick={() => setHidden(c.id, !c.hidden)}
              >
                <span className="cal-cals-check" aria-hidden="true" />
                <span className="cal-settings-dot" style={{ background: c.color }} />
                <span className="cal-cals-name">{c.title}</span>
              </button>
            ))}
          </div>
        ))}
        {onShowEvent && (hiddenEvents.length > 0 || hiddenOpen) && (
          <div className="cal-cals-group">
            <button
              ref={hiddenBtnRef}
              type="button"
              className="cal-cals-row cal-hidden-events-btn"
              aria-expanded={hiddenOpen}
              aria-label={`Hidden events (${hiddenEvents.length})`}
              onClick={() => setHiddenOpen((open) => !open)}
            >
              <span className="cal-cals-name">Hidden events</span>
              <span className="cal-hidden-events-count">{hiddenEvents.length}</span>
            </button>
          </div>
        )}
        {onShowEvent && hiddenOpen && (
          <HiddenEventsFlyout
            anchorRef={hiddenBtnRef}
            events={hiddenEvents}
            onShow={onShowEvent}
            onClose={() => setHiddenOpen(false)}
          />
        )}
        <div className="cal-cals-footer">
          <Link to="/settings#calendar" onClick={onClose}>
            Calendar settings…
          </Link>
        </div>
      </div>
    </>,
    document.body
  );
}
