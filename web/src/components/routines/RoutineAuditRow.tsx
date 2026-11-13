import { useEffect, useRef, useState } from 'react';
import type { Routine, RoutineAuditEntry } from '@/api/routines';
import { auditClock, describeAuditEntry } from '@/utils/routine-format';
import '@/styles/trigger-state.css';

/**
 * One audit row. A fire opens to show the message the session actually received
 * (the answer to "what is the injected context") plus a way into that session;
 * a quiet or failed check is the sentence alone, since there is nothing to open.
 */
export function AuditRow({ entry, check, onOpenSession, nameTask, repeat = 1 }: {
  entry: RoutineAuditEntry;
  /** The routine's check, so a row can say how a run sat against its time limit. */
  check?: Routine['check'];
  /** The same line this many times in a row, said once (the Routines page). */
  repeat?: number;
  onOpenSession: (sessionId: string) => void;
  /** Names the routine's task in a line that carries its id (the Routines page). */
  nameTask?: (text: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const sessionId = entry.delivery?.sessionId;
  const fired = entry.outcome === 'fired';
  const warnings = entry.warnings ?? [];
  const canOpen = (fired && (!!entry.injected || !!sessionId)) || warnings.length > 0;
  // The list scrolls inside a bounded flyout, so a row opened near its bottom edge
  // puts the injected text half below the fold with nothing saying to scroll. The
  // whole ROW is scrolled, not just the detail: bringing only the detail into view
  // pushed its own headline out, leaving text with nothing saying what it belongs to.
  useEffect(() => {
    if (open) rowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open]);
  return (
    <li ref={rowRef} className="trigger-audit-row" data-outcome={entry.outcome} data-delivery={entry.delivery?.status} data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="trigger-audit-line"
        disabled={!canOpen}
        aria-expanded={canOpen ? open : undefined}
        onClick={() => canOpen && setOpen((v) => !v)}
      >
        <span className="trigger-audit-clock">{auditClock(entry.atMs)}</span>
        <span className="trigger-audit-what">{nameTask ? nameTask(describeAuditEntry(entry, check)) : describeAuditEntry(entry, check)}</span>
        {repeat > 1 && <span className="trigger-audit-repeat" title={`The same ${repeat} times in a row`}>×{repeat}</span>}
        {canOpen && <span className={`trigger-audit-chevron${open ? ' open' : ''}`}>›</span>}
      </button>
      {open && (
        <div className="trigger-audit-detail">
          {warnings.length > 0 && (
            <>
              <div className="trigger-audit-detail-label">
                The daemon repaired what the check printed, so this run still counted. Fix the script:
              </div>
              <pre className="trigger-audit-injected">{warnings.map((w) => `- ${w}`).join('\n')}</pre>
            </>
          )}
          {!fired ? null : entry.injected ? (
            <>
              <div className="trigger-audit-detail-label">
                {entry.delivery?.status === 'error'
                  ? `Not delivered. What it would have sent (${entry.injected.chars} chars):`
                  : `Injected into the session (${entry.injected.chars} chars)`}
              </div>
              <pre className="trigger-audit-injected">{entry.injected.preview}</pre>
            </>
          ) : (
            <div className="trigger-audit-detail-label">No injected text was recorded for this fire.</div>
          )}
          {sessionId && (
            <button type="button" className="trigger-jobs-link" onClick={() => onOpenSession(sessionId)}>
              Open that session
            </button>
          )}
        </div>
      )}
    </li>
  );
}
