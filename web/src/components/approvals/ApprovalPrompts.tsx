/**
 * ApprovalPrompts: the approvals a script is blocked on (`walnut approve`), everywhere the
 * console shows them. Mounted once in App, it feeds the store (approvals-store.ts) and draws
 * the window-wide parts:
 *
 *  - the cards at the bottom right of every console window;
 *  - the dialog a Needs you row (ApprovalRow, on Home and the Org page) or a click on the
 *    system notification (approval-notify.ts) opens;
 *  - the system notification itself, raised by the store when a new approval arrives.
 *
 *  - tap: Approve / Deny;
 *  - biometric: Approve needs a device signature. In the Mac app that is Touch ID here
 *    (touch-id-bridge.ts); in a browser the card says to approve on the phone (Face ID),
 *    and Deny still works.
 *
 * In the Mac app the page also enrolls the app's Touch ID key once (keys.ts: the first
 * device is trusted on first use, a later one waits for an existing device's approval).
 * Live through the `approval:changed` event; a reconnect re-reads the list.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEvent } from '@/hooks/useWebSocket';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import type { Approval } from '@/api/approvals';
import {
  applyApprovalEvent, approveKind, closeApproval, decideApproval, noApproveReason, noticePending, openApproval, pendingAt, refreshApprovals,
  startTouchId, useApprovals, type ApprovalsState,
} from './approvals-store';
import { askNoticePermission, nativeNoticeStatus, noticeAccess, openNoticeSettings, OPEN_APPROVAL_EVENT, takeClickedApproval, type NoticeAccess } from './approval-notify';
import './approvals.css';

export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function timeLeft(expiresAt: string, now: number): string {
  const s = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Who asks, on which host: `hostName` is the host's display name (useHostDisplayLabel), never its alias. */
export function requesterText(a: Approval, hostName: string): string {
  const r = a.requester;
  const who = r.taskTitle ? `Task "${r.taskTitle}"` : r.command ? r.command : 'A script';
  return `${who} on ${hostName}`;
}

export function settledWord(a: Approval): string {
  return a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : a.status === 'expired' ? 'Expired' : 'Withdrawn';
}

/** Deny and the Approve this window offers, with their busy words. */
export function ApprovalButtons({ a, s, compact = false }: { a: Approval; s: ApprovalsState; compact?: boolean }) {
  const working = s.busy[a.id];
  const kind = approveKind(s, a);
  return (
    <div className={`approval-actions${compact ? ' approval-actions-compact' : ''}`}>
      <button type="button" className="approval-btn approval-btn-deny" disabled={!!working}
        onClick={(e) => { e.stopPropagation(); void decideApproval(a, 'deny', false); }}>
        {working === 'deny' ? 'Denying…' : 'Deny'}
      </button>
      {kind && (
        <button type="button" className="approval-btn approval-btn-approve" disabled={!!working}
          onClick={(e) => { e.stopPropagation(); void decideApproval(a, 'approve', kind === 'touch-id'); }}>
          {working === 'approve' ? (kind === 'touch-id' ? 'Touch ID…' : 'Approving…') : kind === 'touch-id' ? 'Approve with Touch ID' : 'Approve'}
        </button>
      )}
    </div>
  );
}

/** What the request is, who asks, the detail, and the answer: the card's and the dialog's body. */
function ApprovalBody({ a, s, now, detailOpen = false }: { a: Approval; s: ApprovalsState; now: number; detailOpen?: boolean }) {
  const biometric = a.mode === 'biometric';
  const hostName = useHostDisplayLabel(a.requester.host);
  return (
    <>
      <div className="approval-head">
        <span className="approval-kicker">{biometric ? 'Approval · Face ID / Touch ID' : 'Approval'}</span>
        <span className="approval-clock" title={`Expires ${new Date(a.expiresAt).toLocaleString()}`}>{timeLeft(a.expiresAt, now)}</span>
      </div>
      <div className="approval-what">{a.what}</div>
      <div className="approval-who">{requesterText(a, hostName)}{a.requester.cwd ? <span className="approval-cwd"> · {a.requester.cwd}</span> : null}</div>
      {a.detail ? (
        <details className="approval-detail" open={detailOpen}>
          <summary>Detail</summary>
          <pre>{a.detail}</pre>
        </details>
      ) : null}
      {a.downgraded ? <div className="approval-note">{a.downgraded}</div> : null}
      {s.errors[a.id] ? <div className="approval-error" role="alert">{s.errors[a.id]}</div> : null}
      {biometric && !approveKind(s, a) ? <div className="approval-note">{noApproveReason(s, a)}</div> : null}
      <ApprovalButtons a={a} s={s} />
    </>
  );
}

/** A line offering the system notification where this window cannot raise one yet. */
function NoticeOffer() {
  const [access, setAccess] = useState<NoticeAccess>(() => noticeAccess());
  const [nativeOff, setNativeOff] = useState(false);
  useEffect(() => {
    if (access !== 'native') return;
    let live = true;
    void nativeNoticeStatus().then((st) => { if (live) setNativeOff(st === 'off'); });
    return () => { live = false; };
  }, [access]);
  if (access === 'native') {
    if (!nativeOff) return null;
    return (
      <div className="approval-notice-offer" data-testid="approval-notice-offer">
        Notifications are off for Walnut, so approvals do not pop up on this Mac.{' '}
        <button type="button" className="approval-link" onClick={openNoticeSettings}>Turn them on</button>
      </div>
    );
  }
  if (access !== 'ask') return null;
  return (
    <div className="approval-notice-offer" data-testid="approval-notice-offer">
      <button type="button" className="approval-link" onClick={() => { void askNoticePermission().then(setAccess); }}>
        Notify me on this computer
      </button>{' '}when a script waits for an approval.
    </div>
  );
}

function ApprovalDialog({ s, now }: { s: ApprovalsState; now: number }) {
  const id = s.openId;
  useEffect(() => {
    if (!id) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeApproval(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id]);
  if (!id) return null;
  const a = s.items.get(id);
  const settled = s.done[id];
  const live = a && Date.parse(a.expiresAt) > now ? a : null;
  return createPortal(
    <div className="app-modal-overlay approval-dialog-overlay" role="dialog" aria-modal="true" aria-label="Approval" data-testid="approval-dialog" onMouseDown={closeApproval}>
      <div className={`app-modal approval-dialog${live?.mode === 'biometric' ? ' approval-card-biometric' : ''}`} data-approval-id={id} onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="approval-dialog-close" aria-label="Close" onClick={closeApproval}>×</button>
        {live ? (
          <ApprovalBody a={live} s={s} now={now} detailOpen />
        ) : settled ? (
          <div className={`approval-settled-line approval-${settled.status}`} data-testid="approval-dialog-settled">
            {settledWord(settled)}<span className="approval-settled-what">{settled.what}</span>
          </div>
        ) : (
          <div className="approval-note" data-testid="approval-dialog-gone">This request is no longer waiting: it was answered, withdrawn or ran out of time.</div>
        )}
        {live && <NoticeOffer />}
      </div>
    </div>,
    document.body,
  );
}

export function ApprovalPrompts() {
  const s = useApprovals();

  useEffect(() => { void refreshApprovals(); }, []);
  useEvent('_ws:reconnected', () => { void refreshApprovals(); });
  useEvent('approval-keys:changed', () => { void refreshApprovals(); });
  useEvent('approval:changed', (data) => {
    const a = (data as { approval?: Approval }).approval;
    if (a) applyApprovalEvent(a);
  });
  // The Mac app: learn whether Touch ID can sign here, and enroll its key once.
  useEffect(() => { void startTouchId(); }, []);
  // A click on the Mac app's system notification (desktop/NotificationBridge.swift), also one
  // made before this page was listening (the app opened from it, or the page was reloading).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      if (typeof id === 'string' && id) openApproval(id);
      void takeClickedApproval();
    };
    window.addEventListener(OPEN_APPROVAL_EVENT, onOpen);
    void takeClickedApproval().then((id) => { if (id) openApproval(id); });
    return () => window.removeEventListener(OPEN_APPROVAL_EVENT, onOpen);
  }, []);
  // The end of quiet mode raises the notices it held back (the page's quiet state settles first).
  useEvent('quiet:changed', () => { setTimeout(noticePending, 500); });

  const now = useNow(1000);
  // The dialog shows its approval, so the card stack leaves that one out while it is open.
  const pending = pendingAt(s, now).filter((a) => a.id !== s.openId);
  const settled = Object.values(s.done).filter((a) => !s.items.has(a.id) && a.id !== s.openId);

  return (
    <>
      <ApprovalDialog s={s} now={now} />
      {(pending.length > 0 || settled.length > 0) && (
        <div className="approval-stack" role="region" aria-label="Approvals">
          {settled.map((a) => (
            <div key={a.id} className={`approval-card approval-card-settled approval-${a.status}`} data-approval-id={a.id}>
              <div className="approval-settled-line">
                {settledWord(a)}
                <span className="approval-settled-what">{a.what}</span>
              </div>
            </div>
          ))}
          {pending.map((a, i) => (
            <div key={a.id} className={`approval-card${a.mode === 'biometric' ? ' approval-card-biometric' : ''}`} data-approval-id={a.id} data-testid="approval-card">
              <ApprovalBody a={a} s={s} now={now} />
              {i === pending.length - 1 && <NoticeOffer />}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
