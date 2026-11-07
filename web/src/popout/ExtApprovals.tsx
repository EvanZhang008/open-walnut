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
import { ApprovalButtons, ApprovalDetail, requesterText } from '@/components/approvals/ApprovalPrompts';
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

/**
 * What tells apart approvals that read the same (the same step asked again, by the same asker:
 * four "Place order" clicks on one page read word for word alike, review round 4, #7): their place
 * among them, oldest first, and the second each was asked at. One line by id, only for those with
 * a twin; the others say nothing more. Pure.
 */
export function alikeLines(list: readonly Approval[], timeOf: (iso: string) => string = askedTime): Map<string, string> {
  const groups = new Map<string, Approval[]>();
  for (const a of list) {
    const r = a.requester;
    const k = JSON.stringify([a.what, a.detail ?? '', r.host, r.taskId ?? '', r.sessionId ?? '', r.command ?? ''])
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out = new Map<string, string>();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || x.id.localeCompare(y.id));
    sorted.forEach((a, i) => out.set(a.id, `${i + 1} of ${sorted.length} alike · asked ${timeOf(a.createdAt)}`));
  }
  return out;
}

function askedTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

/** The alike line under an approval's asker, when it has a twin among those waiting. */
export function AlikeLine({ line }: { line?: string }) {
  return line ? <span className="ext-approval-alike" data-testid="ext-approval-alike">{line}</span> : null;
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
  const alike = alikeLines(list);
  return (
    <section className="ext-ask-approvals" data-testid="ext-ask-approvals" aria-label="Approvals waiting for you">
      {shown.map((a) => <AskApproval key={a.id} a={a} mine={!!taskId && a.requester.taskId === taskId} alike={alike.get(a.id)} />)}
      {more > 0 && (
        <button type="button" className="ext-ask-approvals-more" data-testid="ext-ask-approvals-more" onClick={onMore}>
          {more === 1 ? '1 more approval waiting' : `${more} more approvals waiting`}
        </button>
      )}
    </section>
  );
}

function AskApproval({ a, mine, alike }: { a: Approval; mine: boolean; alike?: string }) {
  const s = useApprovals();
  const host = useHostDisplayLabel(a.requester.host);
  return (
    <div className={`ext-ask-approval${mine ? ' is-mine' : ''}`} data-testid="ext-ask-approval" data-approval-id={a.id}>
      {/* Whole, on the card's full width: what, on which site, and why it waits (review round 3:
          cut after two lines beside the buttons, it hid the site and the reason). */}
      <span className="ext-ask-approval-what">{a.what}</span>
      <span className="ext-ask-approval-who">{requesterText(a, host)}<AlikeLine line={alike} /></span>
      <ApprovalButtons a={a} s={s} />
      {/* The whole request, as Home's card has it: the title cuts a message after about 80
          characters, and what it sends and where is read here before Approve (round 3 code
          review, item 2). */}
      <ApprovalDetail a={a} />
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
