/**
 * Snooze on one "Needs you" row of the Org page (2026-10-31, the user: "this one should have 3
 * button, quote, answer, and snooze which after click will show snooze until x time"). It opens
 * the task panel's own date picker (quick times, days, a date) and writes the same snooze the task
 * menu's "Start / Snooze until" does: the task's start date. Which state a snoozed task is in is
 * Walnut's call (the task's user status, which reads a start date still ahead as Waiting /
 * snoozed), never this button's: the row leaves Needs you, and the Waiting / snoozed tab says until when.
 * The row goes on the pick, before the server answers (2026-10-31, the user, translated: "I clicked
 * snooze ... it should just disappear, why wait?"); a refused snooze brings it back with the reason.
 * The menu holds Walnut's own picker (DatePicker's month, never the browser's date field) and no
 * title tooltips, which drew over it.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTasksContext } from '@/contexts/TasksContext';
import { DatePicker } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { log } from '@/utils/log';
import type { AnswerSettle } from './OrgInlineAnswer';
import type { OrgAlertView } from './org-channels-model';
import { MenuCaret } from '@/components/controls';

/** Tomorrow, the first day a date-only snooze can start (YYYY-MM-DD, local). */
function tomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The Snooze button and its picker. `onStart` takes the row off now and settles it with the write. */
export function OrgAlertSnooze({ alert, current, onStart }: {
  alert: OrgAlertView;
  /** The task's start date now, if it has one (the picker shows it). */
  current: string | undefined;
  onStart: () => AnswerSettle;
}) {
  const { update } = useTasksContext();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 140, onAnchorLost: () => setOpen(false) });
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { setOpen(false); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  // A refusal of an unsnooze, or a pick that would not snooze (a day already begun): said on the row.
  const [note, setNote] = useState('');
  // A time snoozes it; None takes a snooze off, as in the task menu.
  const pick = (until: string | null) => {
    setOpen(false);
    setNote('');
    if (!until && !current) return;
    // A date-only start is that day's local midnight (core/snooze.ts startDateMs): today is no snooze.
    const at = until ? (/^\d{4}-\d{2}-\d{2}$/.test(until) ? new Date(`${until}T00:00:00`).getTime() : Date.parse(until)) : NaN;
    if (until && !(at > Date.now())) { setNote('That time has already begun: pick a later one.'); return; }
    // Only a snooze takes the row off; None (unsnooze) leaves it where it is.
    const settle = until ? onStart() : null;
    // Through the store: the row's start date changes on Home and the board on the click too.
    void update(alert.taskId, { start_date: until }).then((ok) => {
      if (ok) { settle?.(); return; }
      log.warn('org', 'snooze from a Needs you row failed', { taskId: alert.taskId, until });
      if (settle) settle({ message: 'Snooze failed: the server refused. Try again.', of: 'snooze' });
      else setNote('Unsnooze failed: the server refused. Try again.');
    });
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm btn-ghost org-alert-snooze"
        data-testid="org-alert-snooze"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Snooze ${alert.title} until a time`}
        onClick={() => setOpen(!open)}
      >Snooze <MenuCaret /></button>
      {note && <span className="org-answer-error" role="alert" data-testid="org-alert-snooze-note">{note}</span>}
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu org-snooze-menu wn-overlay"
          role="dialog"
          aria-label={`Snooze ${alert.title} until`}
          data-testid="org-snooze-menu"
          data-task-id={alert.taskId}
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="org-answer-q">Snooze until</div>
          <DatePicker date={current} onChange={pick} inline minDate={tomorrow()} withTime />
        </div>,
        document.body,
      )}
    </>
  );
}
