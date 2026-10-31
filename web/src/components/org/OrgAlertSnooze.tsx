/**
 * Snooze on one "Needs you" row of the Org page (2026-10-31, the user: "this one should have 3
 * button, quote, answer, and snooze which after click will show snooze until x time"). It opens
 * the task panel's own date picker (quick times, days, a date) and writes the same snooze the task
 * menu's "Start / Snooze until" does: the task's start date. Which state a snoozed task is in is
 * Walnut's call (the task's user status), never this button's: the row leaves Needs you when that
 * status does, and until then it reads "Snoozed until <time>".
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateTask } from '@/api/tasks';
import { DatePicker } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { log } from '@/utils/log';
import type { OrgAlertView } from './org-channels-model';

/** The Snooze button and its picker. `onSnoozed` is told the moment a time is picked (the row
 *  answers the click; null when the snooze was taken off), and again with an error when the write
 *  failed. */
export function OrgAlertSnooze({ alert, current, onSnoozed }: {
  alert: OrgAlertView;
  /** The task's start date now, if it has one. */
  current: string | undefined;
  onSnoozed: (taskId: string, until: string | null, error?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, btnRef, menuRef, { align: 'right', minHeight: 140, onAnchorLost: () => setOpen(false) });
  useOverlayLayer({
    open,
    refs: [menuRef, btnRef],
    onClose: (reason) => { setOpen(false); if (reason === 'escape') btnRef.current?.focus({ preventScroll: true }); },
  });
  // A time snoozes it; None (or the date's ×) takes a snooze off, as in the task menu.
  const pick = (until: string | null) => {
    setOpen(false);
    if (!until && !current) return;
    onSnoozed(alert.taskId, until);
    updateTask(alert.taskId, { start_date: until }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('org', 'snooze from a Needs you row failed', { taskId: alert.taskId, until, error: message });
      onSnoozed(alert.taskId, null, message);
    });
  };
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="btn btn-sm org-alert-snooze"
        data-testid="org-alert-snooze"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Snooze it: it leaves Needs you until then"
        onClick={() => setOpen(!open)}
      >Snooze <span aria-hidden="true">▾</span></button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="org-answer-menu org-snooze-menu"
          role="dialog"
          aria-label={`Snooze ${alert.title} until`}
          data-testid="org-snooze-menu"
          data-task-id={alert.taskId}
          style={menuPlacementStyle(placement)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="org-answer-q">Snooze until</div>
          <DatePicker date={current} onChange={pick} inline />
        </div>,
        document.body,
      )}
    </>
  );
}
