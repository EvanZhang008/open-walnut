/**
 * Snooze on a Threads card (2026-11-02, the user: "low priority, will follow up later, actually in
 * thread has a snoozed section, also a snoozed button"). The same picker as a Needs you row's
 * Snooze (OrgAlertSnooze: quick times, days, a month), writing the thread's own snooze
 * (core/org/threads-model.ts `snooze`): the card leaves his view for the Snoozed section and
 * comes back on its date, or earlier on news. A date alone is that day's local midnight, the way
 * a task's start date reads. None takes the snooze off.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DatePicker } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/org-rail.css';

/** Tomorrow, the first day a date-only snooze can start (YYYY-MM-DD, local). */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The picker's value as an instant: a date-only pick is that day's local midnight. */
function untilOf(pick: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(pick) ? new Date(`${pick}T00:00:00`).getTime() : Date.parse(pick);
}

export function OrgThreadSnooze({ title, current, onSnooze, label = 'Snooze' }: {
  title: string;
  /** When its snooze ends now, if it is snoozed (the picker shows it, and offers None). */
  current: string | undefined;
  /** The ISO time it comes back, or '' to take the snooze off. */
  onSnooze: (until: string) => void;
  label?: string;
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
    if (!value) { if (current) onSnooze(''); return; }
    const at = untilOf(value);
    if (!(at > Date.now())) { setNote('That time has already begun: pick a later one.'); return; }
    onSnooze(new Date(at).toISOString());
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm"
        data-testid="org-thread-snooze"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label} "${title}" until a time`}
        onClick={() => setOpen(!open)}
      >{label} <span aria-hidden="true">▾</span></button>
      {note && <span className="org-thread-error" role="alert" data-testid="org-thread-snooze-note">{note}</span>}
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu org-snooze-menu"
          role="dialog"
          aria-label={`Snooze "${title}" until`}
          data-testid="org-thread-snooze-menu"
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="org-answer-q">Snooze until</div>
          <DatePicker date={current} onChange={pick} inline minDate={tomorrow()} />
        </div>,
        document.body,
      )}
    </>
  );
}
