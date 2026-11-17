/**
 * The change card's status marks (ChangeCard.tsx, ChangeDeployView.tsx): one line icon per stage
 * status, 14px with a 1.5 stroke in the status's tone, so a state never reads by colour alone.
 */
import type { ReactNode } from 'react';
import type { ChangeStageStatus } from '../../../../src/core/changes/model';

const PATHS: Record<ChangeStageStatus, ReactNode> = {
  done: <path d="M4.5 8.2l2.3 2.3 4.7-4.9" />,
  running: <><circle cx="8" cy="8" r="5.25" strokeDasharray="3 2.2" /><circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" /></>,
  waiting: <><circle cx="8" cy="8" r="5.25" /><path d="M8 5.2V8l1.9 1.3" /></>,
  blocked: <><circle cx="8" cy="8" r="5.25" /><path d="M8 5v3.4" /><circle cx="8" cy="10.9" r="0.4" fill="currentColor" /></>,
  failed: <><circle cx="8" cy="8" r="5.25" /><path d="M6 6l4 4M10 6l-4 4" /></>,
  pending: <circle cx="8" cy="8" r="4.5" />,
};

export function StatusIcon({ status, label }: { status: ChangeStageStatus; label?: string }) {
  return (
    <svg
      className="change-icon"
      data-status={status}
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {PATHS[status]}
    </svg>
  );
}

/** "Opens in a new tab": the small arrow after an outward link. */
export function OutIcon() {
  return (
    <svg className="change-icon-out" width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.5 2.5h5v5M9.5 2.5L3 9" />
    </svg>
  );
}

/** A chevron: sideways, down for what opens in place, up for what folds it again. */
export function Chevron({ down, up }: { down?: boolean; up?: boolean }) {
  return (
    <svg className="change-icon-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={down ? 'M3 4.5l3 3 3-3' : up ? 'M3 7.5l3-3 3 3' : 'M4.5 3l3 3-3 3'} />
    </svg>
  );
}
