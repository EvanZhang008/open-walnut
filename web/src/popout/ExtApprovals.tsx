/**
 * The approvals waiting for the person, in the browser side panel and the toolbar popup: an agent's
 * step in this browser (a purchase, a send), a script's command. Read and kept current here as Home
 * does (the store is approvals-store.ts, the buttons are Home's own, ApprovalButtons), since the
 * person is in the browser and answers here.
 *
 * Ask is the panel's main view, so a waiting approval shows there, over the conversation, with its
 * Approve and Deny (review R2-5: it showed only in the drawer's Tasks view, and an agent waited on
 * a person who never saw it). The Tasks view lists them too, with the tasks that need the person.
 */
import { useEffect, useMemo } from 'react';
import type { Approval } from '@/api/approvals';
import { usePendingApprovals } from '@/components/approvals/ApprovalRow';
import { ApprovalButtons, requesterText } from '@/components/approvals/ApprovalPrompts';
import { applyApprovalEvent, approveKind, noApproveReason, refreshApprovals, unlockUndecided, useApprovals, type ApprovalsState } from '@/components/approvals/approvals-store';
import { useEvent } from '@/hooks/useWebSocket';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';

/** The pending approvals, read at mount and kept current by the server's events. */
export function useExtApprovals(): Approval[] {
  useEffect(() => { void refreshApprovals(); }, []);
  useEvent('_ws:reconnected', () => { void refreshApprovals(); });
  useEvent('approval-keys:changed', () => { void refreshApprovals(); });
  useEvent('approval:changed', (data) => {
    const a = (data as { approval?: Approval }).approval;
    if (a) applyApprovalEvent(a);
  });
  return usePendingApprovals();
}

/** How many the Ask view shows itself; the rest wait in the Tasks view. */
export const ASK_APPROVALS_SHOWN = 2;

/**
 * The approvals over the Ask view: the one this conversation's ask is waiting on first, then the
 * oldest; past ASK_APPROVALS_SHOWN, one line opens the Tasks view where all of them are.
 */
export function ExtAskApprovals({ list, taskId, onMore }: { list: readonly Approval[]; taskId: string; onMore: () => void }) {
  const ordered = useMemo(() => {
    if (!taskId) return list;
    const mine = list.filter((a) => a.requester.taskId === taskId);
    return [...mine, ...list.filter((a) => a.requester.taskId !== taskId)];
  }, [list, taskId]);
  if (ordered.length === 0) return null;
  const shown = ordered.slice(0, ASK_APPROVALS_SHOWN);
  const more = ordered.length - shown.length;
  return (
    <section className="ext-ask-approvals" data-testid="ext-ask-approvals" aria-label="Approvals waiting for you">
      {shown.map((a) => <AskApproval key={a.id} a={a} mine={!!taskId && a.requester.taskId === taskId} />)}
      {more > 0 && (
        <button type="button" className="ext-ask-approvals-more" data-testid="ext-ask-approvals-more" onClick={onMore}>
          {more === 1 ? '1 more approval waiting' : `${more} more approvals waiting`}
        </button>
      )}
    </section>
  );
}

function AskApproval({ a, mine }: { a: Approval; mine: boolean }) {
  const s = useApprovals();
  const host = useHostDisplayLabel(a.requester.host);
  return (
    <div className={`ext-ask-approval${mine ? ' is-mine' : ''}`} data-testid="ext-ask-approval" data-approval-id={a.id}>
      <div className="ext-ask-approval-text">
        <span className="ext-ask-approval-what" title={a.what}>{a.what}</span>
        <span className="ext-ask-approval-who">{requesterText(a, host)}</span>
      </div>
      <ApprovalButtons a={a} s={s} />
      <ApprovalLines a={a} s={s} />
    </div>
  );
}

/**
 * What Home's card says under a request (ApprovalPrompts' ApprovalBody), with the same rules and
 * classes: why it was answered on a weaker device, why Approve is not offered here (Face ID or
 * Touch ID on another device, Passwords locked here), and an answer that failed (refused, already
 * answered, expired, the network). Without these, a failed Approve or Deny only brought the
 * buttons back (code review of round 2, finding 3).
 */
export function ApprovalLines({ a, s }: { a: Approval; s: ApprovalsState }) {
  const error = s.errors[a.id];
  // The unlock form open on it says "Unlock Passwords in this window" in its own label.
  const reason = (a.mode === 'biometric' || a.guard) && !approveKind(s, a) && !unlockUndecided(s, a)
    && !(s.unlockId === a.id && noApproveReason(s, a).startsWith('Unlock Passwords in this window'))
    ? noApproveReason(s, a) : '';
  if (!a.downgraded && !error && !reason) return null;
  return (
    <div className="ext-approval-lines">
      {a.downgraded ? <div className="approval-note">{a.downgraded}</div> : null}
      {reason ? <div className="approval-note" data-testid="ext-approval-reason">{reason}</div> : null}
      {error ? <div className="approval-error" role="alert" data-testid="ext-approval-error">{error}</div> : null}
    </div>
  );
}
