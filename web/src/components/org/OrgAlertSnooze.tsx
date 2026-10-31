/**
 * Snooze on one "Needs you" row of the Org page (2026-10-31, the user: "this one should have 3
 * button, quote, answer, and snooze which after click will show snooze until x time"). It opens
 * the task panel's own date picker (quick times, days, a date) and writes the same snooze the task
 * menu's "Start / Snooze until" does: the task's start date. Which state a snoozed task is in is
 * Walnut's call (the task's user status, which reads a start date still ahead as Waiting /
 * snoozed), never this button's: the row leaves Needs you, and the Waiting / snoozed tab says until when.
 */
import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { updateTask } from '@/api/tasks';
import { DatePicker } from '@/components/common/DatePicker';
import { useMenuPlacement, menuPlacementStyle } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { log } from '@/utils/log';
import type { OrgAlertView } from './org-channels-model';

/** The Snooze button and its picker. `onFailed` is told when the write failed, `onDone` when it took. */
export function OrgAlertSnooze({ alert, current, onFailed, onDone }: {
  alert: OrgAlertView;
  /** The task's start date now, if it has one (the picker shows it). */
  current: string | undefined;
  onFailed: (taskId: string, error: string) => void;
  onDone?: (taskId: string) => void;
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
    updateTask(alert.taskId, { start_date: until }).then(() => onDone?.(alert.taskId), (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('org', 'snooze from a Needs you row failed', { taskId: alert.taskId, until, error: message });
      onFailed(alert.taskId, message);
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
        title="Snooze it until a time (its start date, as in the task menu)"
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
