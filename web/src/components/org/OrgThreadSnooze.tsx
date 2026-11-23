/**
 * Snooze on a Threads card (2026-11-02, the user: "low priority, will follow up later, actually in
 * thread has a snoozed section, also a snoozed button"). The same picker as a Needs you row's
 * Snooze (OrgAlertSnooze: quick times, days, a month), writing the thread's own snooze
 * (core/org/threads-model.ts `snooze`): the card leaves his view for the Snoozed section and
 * comes back on its date, or earlier on news. A date alone is that day's local midnight, the way
 * a task's start date reads.
 *
 * A snoozed card always has its way back (2026-11-21, a review on his data: a snoozed card said
 * neither when it comes back nor how to bring it back): the card says "Snoozed until ..."
 * (SnoozedUntil), its button reads Snoozed and its menu opens on that time with Unsnooze, and an
 * Unsnooze button stands beside it. Every Threads card (the node's own, a task's below) draws these
 * from here. After a pick the focus goes back to the button; when the card leaves the group on
 * screen, the line left in its place takes it (thread-moves.ts).
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DatePicker } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/org-rail.css';
import { MenuCaret } from '@/components/controls';

/** Tomorrow, the first day a date-only snooze can start (YYYY-MM-DD, local). */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** When a snoozed thread comes back, as a person says it: "today, 3:30 PM", "tomorrow, 9:00 AM", "Tue, Nov 24, 12:00 AM". Pure. */
export function backAt(until: string, now: number): string {
  const d = new Date(until);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now);
  if (day.toDateString() === d.toDateString()) return `today, ${time}`;
  day.setDate(day.getDate() + 1);
  if (day.toDateString() === d.toDateString()) return `tomorrow, ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** The card's line while it is put aside. */
export function SnoozedUntil({ until, now }: { until: string; now: number }) {
  return <p className="org-thread-snoozed" data-testid="org-thread-snoozed-until">Snoozed until {backAt(until, now)}</p>;
}

/** The picker's value as an instant: a date-only pick is that day's local midnight. */
function untilOf(pick: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(pick) ? new Date(`${pick}T00:00:00`).getTime() : Date.parse(pick);
}

export function OrgThreadSnooze({ title, current, onSnooze }: {
  title: string;
  /** When its snooze ends, while it is snoozed now: the button reads Snoozed, the menu offers Unsnooze. */
  current: string | undefined;
  /** The ISO time it comes back, or '' to take the snooze off. */
  onSnooze: (until: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 140, onAnchorLost: () => setOpen(false) });
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { setOpen(false); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  const pick = (value: string | null) => {
    setOpen(false);
    setNote('');
    // The menu goes with the pick: the focus goes back to its button, never to the page.
    btnRef.current?.focus({ preventScroll: true });
    if (!value) { if (current) onSnooze(''); return; }
    const at = untilOf(value);
    if (!(at > Date.now())) { setNote('That time has already begun: pick a later one.'); return; }
    onSnooze(new Date(at).toISOString());
  };
  const snoozed = !!current;
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm"
        data-testid="org-thread-snooze"
        data-snoozed={snoozed ? 'true' : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={snoozed ? `Change when "${title}" comes back` : `Snooze "${title}" until a time`}
        onClick={() => setOpen(!open)}
      >{snoozed ? 'Snoozed' : 'Snooze'} <MenuCaret /></button>
      {snoozed && <button type="button" className="btn btn-sm" data-testid="org-thread-unsnooze" onClick={() => pick(null)}>Unsnooze</button>}
      {note && <span className="org-thread-error" role="alert" data-testid="org-thread-snooze-note">{note}</span>}
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu org-snooze-menu wn-overlay"
          role="dialog"
          aria-label={`Snooze "${title}" until`}
          data-testid="org-thread-snooze-menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {snoozed && (
            <div className="org-snooze-now">
              <span className="org-answer-q" data-testid="org-thread-snooze-current">Snoozed until {backAt(current, Date.now())}</span>
              <button type="button" className="btn btn-sm" data-testid="org-thread-snooze-clear" onClick={() => pick(null)}>Unsnooze</button>
            </div>
          )}
          <div className="org-answer-q">{snoozed ? 'Or snooze until' : 'Snooze until'}</div>
          {/* No date passed: Unsnooze above is the one way to take it off (the picker's None would be a second). */}
          <DatePicker date={undefined} onChange={pick} inline minDate={tomorrow()} withTime />
        </div>,
        document.body,
      )}
    </>
  );
}
