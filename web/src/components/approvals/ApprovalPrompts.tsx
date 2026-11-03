/**
 * ApprovalPrompts: the approvals a script is blocked on (`walnut approve`), as cards at the
 * bottom right of every console window, answered here.
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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent } from '@/hooks/useWebSocket';
import { answerApproval, enrollApprovalKey, listApprovals, type Approval, type ApprovalKey } from '@/api/approvals';
import { hasTouchIdBridge, touchIdSign, touchIdStatus, type TouchIdStatus } from './touch-id-bridge';
import { log } from '@/utils/log';
import { testRunLabel } from '@/api/test-run';
import './approvals.css';

function useNow(ms: number): number {
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

export function requesterText(a: Approval): string {
  const r = a.requester;
  const who = r.taskTitle ? `Task "${r.taskTitle}"` : r.command ? r.command : 'A script';
  return `${who} on ${r.host}`;
}

function notifyBrowser(a: Approval): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(`Approve? ${a.what}`, { body: requesterText(a), tag: a.id, requireInteraction: true });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* a browser that refuses notifications here */ }
}

export function ApprovalPrompts() {
  const [items, setItems] = useState<Map<string, Approval>>(new Map());
  const [keys, setKeys] = useState<ApprovalKey[]>([]);
  const [touchId, setTouchId] = useState<TouchIdStatus | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<Record<string, Approval>>({});
  const enrolled = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const r = await listApprovals('pending');
      setItems(new Map(r.approvals.map((a) => [a.id, a])));
      setKeys(r.keys);
    } catch {
      // 404/503: an older server or a replica whose Mac is away; nothing to show.
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEvent('_ws:reconnected', () => { void refresh(); });
  useEvent('approval-keys:changed', () => { void refresh(); });
  useEvent('approval:changed', (data) => {
    const a = (data as { approval?: Approval }).approval;
    if (!a) return;
    // A test run's approvals show only in that test window, and a test window sees no real one.
    // The server's list is the judge (a throwaway server marks nothing, so an automated window
    // there sees every approval): a person's window drops a marked one, a test window re-reads.
    const label = testRunLabel();
    if ((a.testRun ?? null) !== label) {
      if (label) void refresh();
      return;
    }
    setItems((prev) => {
      const next = new Map(prev);
      if (a.status === 'pending') {
        if (!prev.has(a.id)) notifyBrowser(a);
        next.set(a.id, a);
      } else next.delete(a.id);
      return next;
    });
    if (a.status !== 'pending') {
      setDone((prev) => ({ ...prev, [a.id]: a }));
      setTimeout(() => setDone((prev) => { const { [a.id]: _gone, ...rest } = prev; return rest; }), 2500);
    }
  });

  // The Mac app: learn whether Touch ID can sign here, and enroll its key once.
  useEffect(() => {
    if (!hasTouchIdBridge()) return;
    void touchIdStatus().then(setTouchId);
  }, []);
  useEffect(() => {
    if (!touchId?.available || !touchId.publicKey || enrolled.current) return;
    if (keys.some((k) => k.id === touchId.keyId)) { enrolled.current = true; return; }
    enrolled.current = true;
    void enrollApprovalKey({ publicKey: touchId.publicKey, name: touchId.name ?? 'Mac', kind: 'mac-app' })
      .then((r) => { log.info('approvals', 'Mac app key enrolled', { keyId: r.key.id, status: r.key.status }); void refresh(); })
      .catch((err) => log.warn('approvals', 'Mac app key enroll failed', { error: String(err) }));
  }, [touchId, keys, refresh]);

  const myKey = useMemo(() => keys.find((k) => k.id === touchId?.keyId), [keys, touchId]);
  const canSign = !!touchId?.available && myKey?.status === 'active';

  const decide = useCallback(async (a: Approval, decision: 'approve' | 'deny', signed: boolean) => {
    setBusy((b) => ({ ...b, [a.id]: decision }));
    setErrors((e) => { const { [a.id]: _old, ...rest } = e; return rest; });
    try {
      const sig = signed ? await touchIdSign(a, decision) : undefined;
      const r = await answerApproval(a.id, {
        decision,
        ...(sig ? { keyId: sig.keyId, signature: sig.signature } : {}),
        device: { name: hasTouchIdBridge() ? (touchId?.name ?? 'Mac app') : 'Web console', kind: hasTouchIdBridge() ? 'mac-app' : 'web' },
      });
      setItems((prev) => { const next = new Map(prev); next.delete(a.id); return next; });
      setDone((prev) => ({ ...prev, [a.id]: r.approval }));
      setTimeout(() => setDone((prev) => { const { [a.id]: _gone, ...rest } = prev; return rest; }), 2500);
    } catch (err) {
      setErrors((e) => ({ ...e, [a.id]: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy((b) => { const { [a.id]: _old, ...rest } = b; return rest; });
    }
  }, [touchId]);

  const now = useNow(1000);
  const pending = [...items.values()].filter((a) => Date.parse(a.expiresAt) > now).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
  const settled = Object.values(done).filter((a) => !items.has(a.id));
  if (pending.length === 0 && settled.length === 0) return null;

  return (
    <div className="approval-stack" role="region" aria-label="Approvals">
      {settled.map((a) => (
        <div key={a.id} className={`approval-card approval-card-settled approval-${a.status}`} data-approval-id={a.id}>
          <div className="approval-settled-line">
            {a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : a.status === 'expired' ? 'Expired' : 'Withdrawn'}
            <span className="approval-settled-what">{a.what}</span>
          </div>
        </div>
      ))}
      {pending.map((a) => {
        const biometric = a.mode === 'biometric';
        const ownEnrollment = !!a.enrollsKey && a.enrollsKey === touchId?.keyId;
        const working = busy[a.id];
        return (
          <div key={a.id} className={`approval-card${biometric ? ' approval-card-biometric' : ''}`} data-approval-id={a.id} data-testid="approval-card">
            <div className="approval-head">
              <span className="approval-kicker">{biometric ? 'Approval · Face ID / Touch ID' : 'Approval'}</span>
              <span className="approval-clock" title={`Expires ${new Date(a.expiresAt).toLocaleString()}`}>{timeLeft(a.expiresAt, now)}</span>
            </div>
            <div className="approval-what">{a.what}</div>
            <div className="approval-who">{requesterText(a)}{a.requester.cwd ? <span className="approval-cwd"> · {a.requester.cwd}</span> : null}</div>
            {a.detail ? (
              <details className="approval-detail">
                <summary>Detail</summary>
                <pre>{a.detail}</pre>
              </details>
            ) : null}
            {a.downgraded ? <div className="approval-note">{a.downgraded}</div> : null}
            {errors[a.id] ? <div className="approval-error" role="alert">{errors[a.id]}</div> : null}
            {biometric && !canSign ? (
              <div className="approval-note">
                {ownEnrollment
                  ? 'This is the request to let this Mac sign approvals: approve it on a device that already signs (your iPhone, with Face ID).'
                  : touchId && !touchId.available && touchId.reason
                    ? `${touchId.reason} Approve it on your iPhone with Face ID.`
                    : myKey?.status === 'pending'
                      ? 'This Mac is waiting to be allowed to sign approvals. Approve it on your iPhone with Face ID.'
                      : 'Approve it on your iPhone with Face ID (or in the Walnut Mac app with Touch ID).'}
              </div>
            ) : null}
            <div className="approval-actions">
              <button type="button" className="approval-btn approval-btn-deny" disabled={!!working} onClick={() => void decide(a, 'deny', false)}>
                {working === 'deny' ? 'Denying…' : 'Deny'}
              </button>
              {!biometric ? (
                <button type="button" className="approval-btn approval-btn-approve" disabled={!!working} onClick={() => void decide(a, 'approve', false)}>
                  {working === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              ) : canSign && !ownEnrollment ? (
                <button type="button" className="approval-btn approval-btn-approve" disabled={!!working} onClick={() => void decide(a, 'approve', true)}>
                  {working === 'approve' ? 'Touch ID…' : 'Approve with Touch ID'}
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
