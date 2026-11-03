/**
 * An approval as a Needs you row: on Home, in the Needs you section with the tasks that wait on
 * the person; on the Org page, in a node's Needs you list. It says what waits and who asks, with
 * Deny and Approve right in the row; a click on the row opens the dialog with the detail
 * (ApprovalPrompts), the same one a click on the system notification opens.
 *
 * Which approvals a surface lists is usePendingApprovals / approvalsForNode (approvals-store.ts): a person's window
 * lists the person's own, a test window only its test run's (approvals-store.ts).
 */
import { useMemo } from 'react';
import type { Approval } from '@/api/approvals';
import * as ICONS from '@/components/common/Icons';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { approveKind, openApproval, pendingAt, useApprovals, type ApprovalsState } from './approvals-store';
import { ApprovalButtons, requesterText, timeLeft, useNow } from './ApprovalPrompts';
import './approvals.css';

/**
 * The approvals waiting, oldest first. No clock: the server's own expiry event takes one off, so a
 * big panel reading this does not draw itself again every second (the rows tick on their own).
 */
export function usePendingApprovals(): Approval[] {
  const items = useApprovals().items;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- one list per change of the items
  return useMemo(() => pendingAt({ items } as ApprovalsState, Date.now()), [items]);
}

export function ApprovalRow({ a, s, now, variant }: { a: Approval; s: ApprovalsState; now: number; variant: 'home' | 'org' }) {
  const biometric = a.mode === 'biometric';
  const hostName = useHostDisplayLabel(a.requester.host);
  const open = () => openApproval(a.id);
  return (
    <div
      className={`approval-row approval-row-${variant}${biometric ? ' approval-card-biometric' : ''}`}
      data-testid="approval-row"
      data-approval-id={a.id}
      role="button"
      tabIndex={0}
      aria-label={`Approval: ${a.what}. Open it`}
      onClick={open}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); open(); } }}
    >
      <span className="approval-row-icon" aria-hidden="true">{ICONS.ICON_ATTENTION}</span>
      <span className="approval-row-mid">
        <span className="approval-row-kicker">
          {biometric ? 'Approve with Face ID / Touch ID' : 'Approve?'}
          <span className="approval-clock" title={`Expires ${new Date(a.expiresAt).toLocaleString()}`}>{timeLeft(a.expiresAt, now)}</span>
        </span>
        <span className="approval-row-what">{a.what}</span>
        <span className="approval-row-who">{requesterText(a, hostName)}</span>
        {s.errors[a.id] ? <span className="approval-error" role="alert">{s.errors[a.id]}</span> : null}
        {biometric && !approveKind(s, a) ? <span className="approval-row-note">Approve it on your iPhone with Face ID.</span> : null}
      </span>
      <ApprovalButtons a={a} s={s} compact />
    </div>
  );
}

/** The rows, oldest first, with their own clock. */
export function ApprovalRows({ list, variant }: { list: readonly Approval[]; variant: 'home' | 'org' }) {
  const s = useApprovals();
  const now = useNow(1000);
  const shown = list.filter((a) => Date.parse(a.expiresAt) > now);
  if (shown.length === 0) return null;
  return (
    <div className="approval-rows" role="list" aria-label="Approvals waiting for you" data-testid="approval-rows">
      {shown.map((a) => <div role="listitem" key={a.id}><ApprovalRow a={s.items.get(a.id) ?? a} s={s} now={now} variant={variant} /></div>)}
    </div>
  );
}
