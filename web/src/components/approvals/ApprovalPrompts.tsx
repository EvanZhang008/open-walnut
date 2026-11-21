/**
 * ApprovalPrompts: the approvals a script is blocked on (`walnut approve`), everywhere the
 * console shows them. Mounted once in App, it feeds the store (approvals-store.ts) and draws
 * the window-wide parts:
 *
 *  - the card at the bottom left of every console window, on every page, nearest the bottom
 *    corner of the one stack every notice shares (common/corner-stack.tsx); it holds the
 *    request's buttons;
 *  - the dialog that the Needs you line (ApprovalRow: Home, the Org page, the notification
 *    center), the card's title or its "N waiting" or a click on the system notification (approval-notify.ts)
 *    opens, in the order the requests came, so the whole request is read before it is approved; the
 *    asking task's name, a link on the card and in the dialog, opens that task;
 *  - the system notification itself, raised by the store when a new approval arrives.
 *
 * Every request is Approve / Deny with one tap, in a browser and in the Mac app alike, as on
 * every device the person is signed in on (2026-11-21, the user: no signing key; a signed-in
 * device approves). Approve is never greyed out for want of a device.
 * Live through the `approval:changed` event; a reconnect re-reads the list.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { CORNER_ORDER, CornerSlot, useCornerState } from '@/components/common/corner-stack';
import { NoticeCard, NoticeStatus } from '@/components/common/NoticeCard';
import { useEvent } from '@/hooks/useWebSocket';
import { QUIET_CATCHUP_ID } from '@/contexts/notifications/system-notice';
import { OPEN_CENTER_EVENT } from '@/utils/open-anywhere';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import type { Approval } from '@/api/approvals';
import {
  applyApprovalEvent, approveAndStopAsking, dismissStoppedAsking, undoStopAsking, closeApproval, decideApproval, openApproval, pendingAt, refreshApprovals,
  useApprovals, type ApprovalsState,
} from './approvals-store';
import { askNoticePermission, nativeNoticeStatus, noticeAccess, openNoticeSettings, OPEN_APPROVAL_EVENT, takeClickedApproval, type NoticeAccess } from './approval-notify';
import { ApprovalContextRows, AskerLink, hostWords, summaryOf, technicalDetail, wordsOf } from './approval-context';
import { useYieldsToTaskOpen } from '@/hooks/useOpenTask';
import './approvals.css';
import { useSnoozedApprovalIds } from './snoozed-approvals';

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
  // This machine is "this computer": its host name (a container's is a hash) tells the person nothing.
  return `${who} on ${hostWords(a, hostName)}`;
}

/** The time left, said as such; the last minute is marked (a warning colour). */
function Clock({ a, now }: { a: Approval; now: number }) {
  const soon = Date.parse(a.expiresAt) - now < 60_000;
  return (
    <span className={`approval-clock${soon ? ' approval-clock-soon' : ''}`} title={`Expires ${new Date(a.expiresAt).toLocaleString()}`}>
      {timeLeft(a.expiresAt, now)} left
    </span>
  );
}

/** Who asks in a word or two, for the card's short line: the task, else the command's name. */
function shortRequester(a: Approval): string {
  const r = a.requester;
  if (r.taskTitle) return r.taskTitle;
  const cmd = r.command?.trim().split(/\s+/)[0];
  return cmd ? cmd.split('/').pop()! : 'A script';
}

export function settledWord(a: Approval): string {
  return a.status === 'approved' ? 'Approved' : a.status === 'denied' ? 'Denied' : a.status === 'expired' ? 'Expired' : 'Withdrawn';
}

/**
 * Deny and Approve, always both and always live (2026-11-15, the user: "你那个到底在哪里"; 2026-11-21:
 * a signed-in device approves): disabled only while this window's own answer is on its way.
 */
export function ApprovalButtons({ a, s }: { a: Approval; s: ApprovalsState }) {
  const working = s.busy[a.id];
  return (
    <div className="approval-actions">
      <button type="button" className="btn btn-sm approval-btn approval-btn-deny" disabled={!!working}
        onClick={(e) => { e.stopPropagation(); void decideApproval(a, 'deny'); }}>
        {working === 'deny' ? 'Denying…' : 'Deny'}
      </button>
      <button type="button" className="btn btn-sm btn-primary approval-btn approval-btn-approve" data-testid="approval-approve" disabled={!!working}
        onClick={(e) => { e.stopPropagation(); void decideApproval(a, 'approve'); }}>
        {working === 'approve' ? 'Approving…' : 'Approve'}
      </button>
    </div>
  );
}

/**
 * The request's whole text (what it sends, where, why), folded under its title: a title is cut
 * short (a browser step's message after about 80 characters), and the person reads the rest here
 * before approving. Home's card and dialog, and the browser panel's Ask card (ExtApprovals.tsx).
 */
export function ApprovalDetail({ a, open = false }: { a: Approval; open?: boolean }) {
  // The request in words is read whole, never behind a click; only a technical detail folds.
  const words = wordsOf(a);
  if (words) {
    return (
      <div className="approval-detail approval-detail-words" data-testid="approval-detail-words">
        <pre>{words}</pre>
      </div>
    );
  }
  const detail = technicalDetail(a);
  if (!detail.text) return null;
  return (
    <details className="approval-detail" open={open} data-testid="approval-detail">
      <summary>{detail.bound ? 'Detail (used once)' : 'Detail'}</summary>
      <pre>{detail.text}</pre>
    </details>
  );
}

/** What the request is, who asks, the detail, and the answer: the card's and the dialog's body. */
function ApprovalBody({ a, s, now, onOpen, onMinimize, total = 0 }: { a: Approval; s: ApprovalsState; now: number; onOpen?: () => void; onMinimize?: () => void; total?: number }) {
  const hostName = useHostDisplayLabel(a.requester.host);
  const asker = a.requester.taskId;
  // The card leads with what the step does and why, whole, as the dialog does (2026-11-14, the user:
  // "summayr一直都显示不需要点detail"); under Walnut's summary, the request's own line.
  const lead = summaryOf(a);
  return (
    <>
      <div className="approval-head">
        {/* The card names itself in the corner; the dialog has no title of its own: its sentence is the request. */}
        {onOpen ? <NoticeStatus tone="ask" className="approval-kicker">Approve?</NoticeStatus> : <span />}
        {onOpen && total > 1 && (
          <button type="button" className="approval-count" data-testid="approval-count" title={`See all ${total} approvals waiting`} onClick={onOpen}>
            {total} waiting
          </button>
        )}
        <span className="approval-head-end">
          <Clock a={a} now={now} />
          {onMinimize && (
            <button type="button" className="approval-minimize" aria-label="Make it smaller" title="Make it smaller: its title, the time and the buttons" data-testid="approval-minimize" onClick={onMinimize}>
              <span aria-hidden="true">–</span>
            </button>
          )}
        </span>
      </div>
      {onOpen
        ? <button type="button" className="approval-what approval-what-open" title="Open the request" data-testid="approval-what" onClick={onOpen}><span className="approval-what-text">{lead.text}</span></button>
        : null}
      {onOpen && lead.why ? <div className="approval-card-why" data-testid="approval-card-why">{lead.why}</div> : null}
      {onOpen && lead.by === 'walnut' ? <div className="approval-card-request" data-testid="approval-card-request" title="The request itself: what you approve">{a.what}</div> : null}
      {onOpen ? (<>
        <div className="approval-who">
          <span className="approval-who-text">{asker
            ? <><AskerLink a={a} label={a.requester.taskTitle || 'Its task'} />{' '}<span className="approval-who-host">{`on ${hostWords(a, hostName)}`}</span></>
            : <span className="approval-who-host">{requesterText(a, hostName)}</span>}</span>
        </div>
        <ApprovalDetail a={a} />
      </>) : <ApprovalContextRows a={a} hostName={hostName} />}
      {s.errors[a.id] ? <div className="approval-error" role="alert">{s.errors[a.id]}</div> : null}
      <ApprovalButtons a={a} s={s} />
      <StopAsking a={a} s={s} />
    </>
  );
}

/** "Approve, and stop asking me": this one, then the Approvals switch off (Settings, General). */
function StopAsking({ a, s }: { a: Approval; s: ApprovalsState }) {
  if (a.singleUse || a.outsideSwitch || s.busy[a.id]) return null;
  return (
    <button type="button" className="approval-link approval-stop-asking" data-testid="approval-stop-asking"
      title="Approve this one and turn approvals off (Settings › General › Ask me before agents act). Each step then goes ahead and is listed there."
      onClick={(e) => { e.stopPropagation(); void approveAndStopAsking(a); }}>
      Approve, and stop asking me
    </button>
  );
}

/**
 * What the person sees after "stop asking me": the switch is off, with Undo and the way to it.
 * In the corner (and in the dialog it was clicked in) for a while, or until Undo or ×.
 */
function StoppedAsking({ s, now, inDialog = false }: { s: ApprovalsState; now: number; inDialog?: boolean }) {
  const navigate = useNavigate();
  const st = s.stoppedAsking;
  if (!st) return null;
  const what = s.done[st.id]?.what;
  // Asked while it was on: they still wait for the person (the switch never answers them), and the note says so.
  const still = pendingAt(s, now);
  const Frame = inDialog ? StoppedInline : NoticeCard;
  return (
    <Frame className={`approval-card approval-card-settled approval-stopped${inDialog ? ' approval-stopped-inline' : ''}`} role="status" testId="approval-stopped-asking">
      <div className="approval-stopped-line">
        {st.undone ? 'Agents ask you first again.' : 'Approved. From now on agents go ahead without asking you.'}
      </div>
      {what && <div className="approval-stopped-what">{what}</div>}
      {st.undone
        ? <div className="approval-stopped-sub">The one you approved stays approved.</div>
        : still.length > 0 && (
          <div className="approval-stopped-sub" data-testid="approval-stopped-still">
            {still.length === 1 ? '1 other request still waits for you.' : `${still.length} other requests still wait for you.`}{' '}
            {!inDialog && <button type="button" className="approval-link" onClick={() => openApproval(still[0]!.id)}>Review</button>}
          </div>
        )}
      <div className="approval-stopped-actions">
        {!st.undone && <button type="button" className="approval-link" data-testid="approval-stopped-undo" title="Turn approvals back on. The one you approved stays approved." onClick={() => { void undoStopAsking(); }}>Ask me again</button>}
        <button type="button" className="approval-link" data-testid="approval-stopped-settings" onClick={() => { dismissStoppedAsking(); closeApproval(); navigate('/settings#general'); }}>Settings › General</button>
        {!inDialog && <button type="button" className="approval-stopped-close" aria-label="Close" onClick={dismissStoppedAsking}>×</button>}
      </div>
    </Frame>
  );
}

/** Inside the dialog the note is a block of the dialog, not a card of the corner. */
function StoppedInline({ className, role, testId, children }: { className: string; role: string; testId: string; children: ReactNode }) {
  return <div className={className} role={role} data-testid={testId}>{children}</div>;
}

/** A line offering the system notification where this window cannot raise one yet. */
function NoticeOffer() {
  // A phone gets its pushes from the Walnut app, not from this page.
  const phone = usePhoneLayout();
  const [access, setAccess] = useState<NoticeAccess>(() => noticeAccess());
  const [nativeOff, setNativeOff] = useState(false);
  useEffect(() => {
    if (access !== 'native') return;
    let live = true;
    void nativeNoticeStatus().then((st) => { if (live) setNativeOff(st === 'off'); });
    return () => { live = false; };
  }, [access]);
  if (phone) return null;
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
  // Focus goes into the dialog (its close button, never Approve) and back where it came from.
  const boxRef = useRef<HTMLDivElement>(null);
  const isOpen = !!id;
  useEffect(() => {
    if (!isOpen) return;
    const from = document.activeElement as HTMLElement | null;
    boxRef.current?.querySelector<HTMLElement>('.approval-dialog-close')?.focus();
    return () => { if (from?.isConnected) from.focus(); };
  }, [isOpen]);
  useEffect(() => {
    if (!id) return;
    // Escape closes this, the top layer, alone: caught before the layers under it (the
    // notification center listens on document) and kept from them.
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeApproval(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [id]);
  // A task opening (its AskerLink, or any task link) takes the screen: the dialog yields to it.
  useYieldsToTaskOpen(closeApproval, !!id);
  if (!id) return null;
  const a = s.items.get(id);
  const settled = s.done[id];
  const live = a && Date.parse(a.expiresAt) > now ? a : null;
  // More than one waiting: list them all, this one marked, and show another without closing. In
  // the order they came, as the corner shows them: its card is 1.
  const list = pendingAt(s, now);
  const at = live ? list.findIndex((x) => x.id === id) : -1;
  return createPortal(
    <div className="app-modal-overlay approval-dialog-overlay" role="dialog" aria-modal="true" aria-label="Approval" data-testid="approval-dialog" onMouseDown={closeApproval}>
      <div ref={boxRef} className="app-modal approval-dialog" data-approval-id={id} onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" className="approval-dialog-close" aria-label="Close" onClick={closeApproval}>×</button>
        {live ? (
          <ApprovalBody a={live} s={s} now={now} />
        ) : settled ? (
          <>
            {s.stoppedAsking?.id === id
              ? <StoppedAsking s={s} now={now} inDialog />
              : (
                <div className={`approval-settled-line approval-${settled.status}`} data-testid="approval-dialog-settled">
                  {settledWord(settled)}<span className="approval-settled-what">{settled.what}</span>
                </div>
              )}
            {list.length > 0 && (
              <div className="approval-dialog-steps">
                <span>{list.length === 1 ? '1 more waiting' : `${list.length} more waiting`}</span>
                <button type="button" className="approval-link" data-testid="approval-dialog-next" onClick={() => openApproval(list[0]!.id)}>Next ›</button>
              </div>
            )}
          </>
        ) : (
          <div className="approval-note" data-testid="approval-dialog-gone">This request is no longer waiting: it was answered, withdrawn or ran out of time.</div>
        )}
        {at >= 0 && list.length > 1 && (
          // Every request waiting, by its title, in the order they came: one click shows another.
          <div className="approval-dialog-list" data-testid="approval-dialog-list">
            <div className="approval-dialog-list-head">{list.length} waiting</div>
            <ol>
              {list.map((x, i) => (
                <li key={x.id}>
                  <button type="button" aria-current={x.id === id ? 'true' : undefined} onClick={() => openApproval(x.id)}>
                    <span className="approval-dialog-list-n">{i + 1}</span>
                    <span className="approval-dialog-list-what">{x.what}</span>
                    {x.requester.taskTitle && <span className="approval-dialog-list-task">{x.requester.taskTitle}</span>}
                    <Clock a={x} now={now} />
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** The count the corner gives, the same as the Needs you line's. */
const waitingWords = (n: number) => `${n} approval${n === 1 ? '' : 's'} waiting`;

/** A new card's buttons wait this long before they take a click. */
const ARM_MS = 700;
/** The answer of the card shown stays this long in its place before the next request shows. */
const SETTLED_HOLD_MS = 1500;

export function ApprovalPrompts() {
  const s = useApprovals();

  useEffect(() => { void refreshApprovals(); }, []);
  useEvent('_ws:reconnected', () => { void refreshApprovals(); });
  useEvent('approval:changed', (data) => {
    const a = (data as { approval?: Approval }).approval;
    if (a) applyApprovalEvent(a);
  });
  // A click on the Mac app's system notification (desktop/NotificationBridge.swift), also one
  // made before this page was listening (the app opened from it, or the page was reloading).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      // The one reminder after quiet (system-notice.ts) opens the notification center.
      if (id === QUIET_CATCHUP_ID) window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT));
      else if (typeof id === 'string' && id) openApproval(id);
      void takeClickedApproval();
    };
    window.addEventListener(OPEN_APPROVAL_EVENT, onOpen);
    void takeClickedApproval().then((id) => {
      if (id === QUIET_CATCHUP_ID) window.dispatchEvent(new CustomEvent(OPEN_CENTER_EVENT));
      else if (id) openApproval(id);
    });
    return () => window.removeEventListener(OPEN_APPROVAL_EVENT, onOpen);
  }, []);

  const now = useNow(1000);
  const phone = usePhoneLayout();
  // The corner holds one card, the request that came first (the dialog shows the one it opened):
  // it stays until it is answered, a newer one only adds to its "N waiting".
  // One the person snoozed on its task's row (Action needed) waits out its snooze off the corner.
  const snoozed = useSnoozedApprovalIds();
  const waiting = pendingAt(s, now).filter((a) => a.id !== s.openId && !snoozed.has(a.id));
  const first = waiting[0];
  const card = first;
  // The answer of the card the corner was showing stays a moment over its place ("Approved …"),
  // laid over the next request, which is already there, so nothing in the corner moves.
  // Only the card the corner was showing when it was answered: one answered in the dialog (or
  // elsewhere while another card showed) already said so where it was answered. Read before the
  // frame is drawn (a layout effect), so the next card never shows uncovered for a frame.
  const [receipt, setReceipt] = useState<Approval | null>(null);
  const shownCard = useRef<string | null>(null);
  const receiptTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    const was = shownCard.current;
    shownCard.current = card?.id ?? null;
    if (!was || was === card?.id) return;
    const answered = s.done[was];
    if (!answered || s.items.has(was) || was === s.openId || s.stoppedAsking?.id === was || s.stoppingId === was) return;
    setReceipt(answered);
    if (receiptTimer.current) clearTimeout(receiptTimer.current);
    receiptTimer.current = setTimeout(() => setReceipt(null), SETTLED_HOLD_MS);
  }, [card?.id, s.done, s.items, s.openId, s.stoppedAsking?.id, s.stoppingId]);
  useEffect(() => () => { if (receiptTimer.current) clearTimeout(receiptTimer.current); }, []);
  const holding = card ? receipt : null;
  // A card made smaller (two short lines) stays so until another request comes (it opens full again, so the
  // new one is not missed). In a crowded stack (corner-stack.tsx compact) it is that one line
  // too, so it covers as little as it can.
  const [lineFor, setLineFor] = useState<{ id: string; n: number } | null>(null);
  const { compact, summaryInSight } = useCornerState();
  const cardHost = useHostDisplayLabel(card?.requester.host);
  // A page that already lists the approvals in sight (Home's Needs you line): the corner keeps its short form.
  const asLine = !!card && (phone || compact || summaryInSight || (lineFor?.id === card.id && waiting.length <= lineFor.n));
  // Opened full by a newer request (or another card in the corner): the choice to make it smaller
  // is spent, so the card stays whole until the person makes it smaller again.
  // (Set while rendering, React's way of adjusting state to what changed: no effect, no extra frame.)
  if (lineFor && (!card || card.id !== lineFor.id || waiting.length > lineFor.n)) setLineFor(null);
  // Put aside to one small pill, over what the person works in: the same rule brings it back.
  const [asideFor, setAsideFor] = useState<{ id: string; n: number } | null>(null);
  if (asideFor && (!card || card.id !== asideFor.id || waiting.length > asideFor.n)) setAsideFor(null);
  const aside = !!card && !phone && asideFor?.id === card.id;
  const lastSettled = holding ?? (card ? null : receipt);
  // A card that takes another's place answers no click for a moment: a second click meant for the
  // card just answered must not land on the next request's Approve.
  // The clock starts once the answer laid over it has gone, when the card is first seen.
  const [armedId, setArmedId] = useState<string | null>(null);
  const covered = !!holding;
  useEffect(() => {
    setArmedId(null);
    if (!card || covered) return;
    const t = setTimeout(() => setArmedId(card.id), ARM_MS);
    return () => clearTimeout(t);
  }, [card?.id, covered]);

  return (
    <>
      <ApprovalDialog s={s} now={now} />
      {(card || lastSettled || (s.stoppedAsking && s.stoppedAsking.id !== s.openId)) && (
        <CornerSlot order={CORNER_ORDER.approvals} className="corner-slot-approvals">
        <div className="approval-stack" role="region" aria-label="Approvals">
          {s.stoppedAsking && s.stoppedAsking.id !== s.openId && <StoppedAsking s={s} now={now} />}
          {lastSettled && !card && (
            <NoticeCard key={lastSettled.id} className={`approval-card approval-card-settled approval-${lastSettled.status}`} data={{ 'approval-id': lastSettled.id }} testId="approval-settled" role="status">
              <div className="approval-settled-line">
                {settledWord(lastSettled)}
                <span className="approval-settled-what">{lastSettled.what}</span>
              </div>
            </NoticeCard>
          )}
          {card && aside && !holding && (
            <NoticeCard className="wn-notice-pill">
              <button type="button" className="approval-aside" data-approval-id={card.id} data-testid="approval-aside"
                title={`${card.what}: open the request`} onClick={() => openApproval(card.id)}>
                <NoticeStatus tone="ask" className="approval-kicker">Approve?</NoticeStatus>
                <span>{waitingWords(waiting.length)}</span>
                <span className="approval-aside-open" aria-hidden="true">Open ›</span>
              </button>
            </NoticeCard>
          )}
          {card && (!aside || holding) && (
            <div className="approval-card-place">
              {asLine ? (
                // Two short lines: what waits, then how many, the time and the buttons (a phone opens
                // the request instead, whose buttons take a finger).
                // On a phone the whole line is one tap target (it has no buttons of its own).
                <NoticeCard key={card.id} className={`approval-card approval-card-line${phone ? ' approval-card-tap' : ''}${armedId === card.id ? '' : ' approval-card-arming'}`} data={{ 'approval-id': card.id }} testId="approval-card"
                  onClick={phone ? () => openApproval(card.id) : undefined}>
                  <button type="button" className="approval-line-open" data-testid="approval-what" onClick={() => openApproval(card.id)}
                    title={`${card.what}${waiting.length > 1 ? ` (${waitingWords(waiting.length)})` : ''}: open the request`}>
                    <NoticeStatus tone="ask" className="approval-kicker">Approve?</NoticeStatus>
                    <span className="approval-line-what">{card.what}</span>
                    {phone && <span className="approval-row-open" aria-hidden="true">Open ›</span>}
                  </button>
                  {/* "+" where the whole card has its "–": the top right corner. */}
                  {!phone && lineFor?.id === card.id && !compact && !summaryInSight && (
                    <button type="button" className="approval-minimize" aria-label="Show the whole card" title="Show the whole card" data-testid="approval-expand" onClick={() => setLineFor(null)}>
                      <span aria-hidden="true">+</span>
                    </button>
                  )}
                  {/* "–" always makes it smaller: the whole card to these two lines, these to one. */}
                  {!phone && (
                    <button type="button" className="approval-minimize" aria-label="Make it smaller" title="Make it smaller: one line until another request comes" data-testid="approval-put-aside" onClick={() => setAsideFor({ id: card.id, n: waiting.length })}>
                      <span aria-hidden="true">–</span>
                    </button>
                  )}
                  <span className="approval-line-break" aria-hidden="true" />
                  <span className="approval-line-meta">
                    {waiting.length > 1 && (phone
                      ? <span className="approval-line-more">{waiting.length} waiting</span>
                      : <button type="button" className="approval-line-more" data-testid="approval-count" title={`See all ${waiting.length} approvals waiting`} onClick={() => openApproval(card.id)}>{waiting.length} waiting</button>)}
                    {/* Who asks stays in sight beside the buttons: nothing is approved on a title alone. */}
                    <span className={`approval-line-who${card.requester.taskId && !phone ? ' approval-line-who-link' : ''}`} title={requesterText(card, cardHost)}>
                      {card.requester.taskId && !phone ? <AskerLink a={card} label={shortRequester(card)} /> : shortRequester(card)}
                    </span>
                    <Clock a={card} now={now} />
                  </span>
                  {!phone && <ApprovalButtons a={card} s={s} />}
                  {s.errors[card.id] ? <div className="approval-error" role="alert">{s.errors[card.id]}</div> : null}
                </NoticeCard>
              ) : (
                <NoticeCard key={card.id} className={`approval-card${armedId === card.id ? '' : ' approval-card-arming'}`} data={{ 'approval-id': card.id }} testId="approval-card">
                  <ApprovalBody a={card} s={s} now={now} onOpen={() => openApproval(card.id)} onMinimize={() => setLineFor({ id: card.id, n: waiting.length })} total={waiting.length} />
                  <NoticeOffer />
                </NoticeCard>
              )}
              {/* Over the next request while it shows: it also keeps a click meant for the one
                  just answered off the next one's buttons. */}
              {holding && (
                <NoticeCard key={holding.id} className={`approval-card approval-card-settled approval-settled-over approval-${holding.status}`} data={{ 'approval-id': holding.id }} testId="approval-settled" role="status">
                  <div className="approval-settled-line">
                    {settledWord(holding)}
                    <span className="approval-settled-what">{holding.what}</span>
                  </div>
                  <div className="approval-settled-next">Next: {card.what}</div>
                </NoticeCard>
              )}
            </div>
          )}
        </div>
        </CornerSlot>
      )}
    </>
  );
}
