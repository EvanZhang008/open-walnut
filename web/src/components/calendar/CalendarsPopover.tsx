/**
 * CalendarsPopover — the in-view calendar visibility switcher (toolbar
 * "Calendars" button). Same data + PUT as Settings → Calendar, scoped to the
 * one thing you tweak while looking at the grid: which calendars show.
 * Footer links into the full Settings section for everything else.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { listCalendarSources, updateCalendarSource, type CalendarInfo } from '@/api/calendar';

interface Props {
  anchorEl: HTMLElement;
  onClose: () => void;
}

export function CalendarsPopover({ anchorEl, onClose }: Props) {
  const anchorRef = useRef<HTMLElement | null>(anchorEl);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const placement = useMenuPlacement(true, anchorRef, menuRef);
  const [calendars, setCalendars] = useState<CalendarInfo[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Window-level Escape — the popover contains no autofocused input, so a div
  // onKeyDown never fires (focus stays on the toolbar button / body).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    listCalendarSources()
      .then((res) => {
        if (!alive) return;
        setCalendars(res.calendars);
        setUnavailable(!res.sources[0]?.available || !res.sources[0]?.enabled);
      })
      .catch(() => alive && setUnavailable(true));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = (id: string, hidden: boolean) => {
    if (!calendars) return;
    const next = calendars.map((c) => (c.id === id ? { ...c, hidden } : c));
    setCalendars(next); // optimistic — server push refreshes the grid
    updateCalendarSource({ hidden_calendar_ids: next.filter((c) => c.hidden).map((c) => c.id) }).catch(() => {
      setCalendars(calendars);
    });
  };

  const byAccount = new Map<string, CalendarInfo[]>();
  for (const c of calendars ?? []) {
    const list = byAccount.get(c.account);
    if (list) list.push(c);
    else byAccount.set(c.account, [c]);
  }

  return createPortal(
    <>
      <div className="cal-popover-backdrop" onClick={onClose} />
      <div className="cal-cals-popover" ref={menuRef} style={menuPlacementStyle(placement)} data-testid="cal-cals-popover">
        {calendars === null && !unavailable && <div className="cal-cals-empty">Loading…</div>}
        {unavailable && (
          <div className="cal-cals-empty">
            External calendars are off or unavailable — check{' '}
            <Link to="/settings#calendar" onClick={onClose}>
              Settings → Calendar
            </Link>
            .
          </div>
        )}
        {[...byAccount.entries()].map(([account, list]) => (
          <div key={account} className="cal-cals-group">
            <div className="cal-cals-account">{account}</div>
            {list.map((c) => (
              <label key={c.id} className="cal-cals-row" title={c.readonly ? `${c.title} (read-only)` : c.title}>
                <input type="checkbox" checked={!c.hidden} onChange={(e) => toggle(c.id, !e.target.checked)} />
                <span className="cal-settings-dot" style={{ background: c.color }} />
                <span className="cal-cals-name">{c.title}</span>
              </label>
            ))}
          </div>
        ))}
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
