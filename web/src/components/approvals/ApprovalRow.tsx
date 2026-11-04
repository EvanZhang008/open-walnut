/**
 * Approvals in a Needs you list: on Home, with the tasks that wait on the person; on the Org page,
 * in a node's Needs you; in the notification center. One line says how many wait and opens the
 * dialog (ApprovalPrompts); the request's title and its Approve / Deny are on the corner card,
 * so one request has one place with its buttons.
 *
 * Which approvals a surface lists is usePendingApprovals / approvalsForNode (approvals-store.ts): a person's window
 * lists the person's own, a test window only its test run's (approvals-store.ts).
 */
import { useMemo } from 'react';
import type { Approval } from '@/api/approvals';
import * as ICONS from '@/components/common/Icons';
import { openApproval, pendingAt, useApprovals, type ApprovalsState } from './approvals-store';
import { useNow } from './ApprovalPrompts';
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

/**
 * The approvals waiting, as one line: how many, and a way in. The corner card (ApprovalPrompts)
 * shows the first of them with its title and buttons on every page, so this line repeats neither;
 * a click opens the dialog on the same request the corner shows, in the order they came.
 */
export function ApprovalRows({ list, variant }: { list: readonly Approval[]; variant: 'home' | 'org' }) {
  const now = useNow(1000);
  const live = list.filter((a) => Date.parse(a.expiresAt) > now);
  if (live.length === 0) return null;
  const words = live.length === 1 ? '1 approval waiting' : `${live.length} approvals waiting`;
  return (
    <div className={`approval-rows approval-rows-${variant}`} data-testid="approval-rows">
      <button type="button" className="approval-row" data-testid="approval-summary" aria-label={`${words}. Open them`} onClick={() => openApproval(live[0]!.id)}>
        <span className="approval-row-icon" aria-hidden="true">{ICONS.ICON_ATTENTION}</span>
        <span className="approval-row-what">{words}</span>
        <span className="approval-row-open" aria-hidden="true">›</span>
      </button>
    </div>
  );
}
