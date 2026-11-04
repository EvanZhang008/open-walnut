/**
 * NotificationToaster — the single toast renderer, in the bottom-left corner stack
 * (corner-stack.tsx) with every other notice.
 *
 * Replaces CronToast + PermissionToast + OperationErrorToast (and renders the
 * ephemeral sort / audio-error toasts too). Reads the unified toast stack from
 * NotificationProvider; styling keys off severity. The optional action button
 * navigates (react-router) or fires a callback, then dismisses.
 *
 * Clicking a PERSISTENT toast's body opens the notification center (that toast is
 * also in the feed, so "see it again later" is meaningful). Reuses the window
 * custom-event bridge the layout already uses for cross-tree toggles
 * (e.g. `sidebar:toggle-todo`) — Sidebar listens for `notification:open-center`.
 * Ephemeral toasts (sort / audio-error) aren't in the feed, so they stay inert.
 *
 * PENDING PERMISSIONS render a richer, ANSWERABLE card: what is being asked
 * (command / question / plan / file), where it came from (session + host), and
 * the real buttons. A permission toast that only said "Session needs permission
 * approval" forced a session round-trip for a one-word decision.
 *
 * An AskUserQuestion is answered IN FULL here — every question, every option,
 * multi-select, and the per-question free-text "Other" box — through the same
 * PermissionAnswerForm the panel card uses. The toast used to fall back to an
 * "Answer…" button that merely opened the center for anything beyond one
 * single-select question with at most four options, which made the popup a dead
 * end for exactly the asks that most needed answering.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ICON_CHECK, ICON_CLOSE, ICON_INFO, ICON_WARNING } from './Icons';
import { useNavigate } from 'react-router-dom';
import '@/styles/undo-toast.css';
import {
  useNotifications, permissionDetail, requestIdOf,
  toolNameOf, isUnanswerableAsk, validAcpOptions, isRejectOption, sessionLabelOf,
  linkTargetOf, resolvedLabelOf, displayActionsOf,
  type Notification, type NotificationSeverity,
} from '@/contexts/notifications';
import {
  isSettledPermission, markAnsweredFromToast, respondToPermissionRequest, usePermissionRequest, wasAnsweredFromToast,
} from '@/stores/permission-request-store';
import { PermissionAnswerForm } from './PermissionAnswerForm';
import { DenyWithNote, denyMessageOf, usePermissionNote } from '@/components/sessions/PermissionNoteBox';
import { splitPromptHint, useSecondClick } from '@/components/sessions/prompt-keys';
import { AnswerText, RuleDetail, SavedFileMark } from '@/components/sessions/RuleDetail';
import { isLongRule, permissionOutcomeLabel, releaseAnswerFocus } from './PermissionPromptControls';
import { NotificationActionButtons } from './NotificationActionButtons';
import { navigateToTarget } from '@/utils/open-session';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { isPhoneOverlayOpen, usePhoneOverlayDepth } from '@/hooks/usePhoneOverlayHistory';
import type { ImageAttachment } from '@/api/chat';
import { CORNER_ORDER, CornerSlot, useCornerState } from './corner-stack';
import { CopyCommandButton, NoticeDetailsToggle, NoticeWords, noticeCommands, prettyDetail, useCutOff, wholeTitle } from './NoticeText';
import { pendingAt, useApprovals } from '@/components/approvals/approvals-store';
import { sessionsWithPromptCard, usePromptCardsChanged } from '@/components/sessions/prompt-keys';
import { useNotificationCenterOpen } from '@/stores/notification-center-open';
import { useShiftClickGuard } from './useShiftClickGuard';

/** Downward travel that dismisses a toast on the phone (it sits at the bottom of the screen). */
const SWIPE_DISMISS_PX = 40;

/**
 * Phone rules (spec 4.7 "Toasts"): one toast at a time (the rest wait their
 * turn), and no permission toast for a session whose overlay is open, since
 * its card is already on screen. Pure, so the order rule is testable.
 */
export function phoneVisibleToasts<T extends { kind?: string; resolved?: unknown; sessionId?: string | null }>(
  toasts: readonly T[],
  sessionOverlayOpen: (sid: string) => boolean,
): T[] {
  const first = toasts.find((t) => !(t.kind === 'permission' && !t.resolved && t.sessionId && sessionOverlayOpen(t.sessionId)));
  return first ? [first] : [];
}

/** Swipe down on a toast dismisses it (phone): toward the edge it came from. */
function useSwipeDownDismiss(enabled: boolean, onDismiss: () => void) {
  const start = useRef<{ id: number; y: number } | null>(null);
  if (!enabled) return {};
  return {
    onPointerDownCapture: (e: React.PointerEvent) => { start.current = { id: e.pointerId, y: e.clientY }; },
    // Capture only once the finger moves down: the finger leaves the toast while
    // it swipes, so its pointerup must still land here. Capturing on down
    // would retarget a plain tap's click away from the x and the buttons.
    onPointerMoveCapture: (e: React.PointerEvent) => {
      const s0 = start.current;
      const el = e.currentTarget as HTMLElement;
      if (!s0 || s0.id !== e.pointerId || e.clientY - s0.y < 8 || el.hasPointerCapture?.(e.pointerId)) return;
      try { el.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    },
    onPointerUpCapture: (e: React.PointerEvent) => {
      const s0 = start.current;
      start.current = null;
      if (s0 && s0.id === e.pointerId && e.clientY - s0.y >= SWIPE_DISMISS_PX) onDismiss();
    },
    onPointerCancelCapture: () => { start.current = null; },
  };
}

// Escape-coded so the source bytes are identical across editors/terminals
// (raw multi-codepoint emoji like ⚠️ can render or copy-paste inconsistently).
// Severity marks come from Icons.tsx (SVG, currentColor), never emoji.
const SEVERITY_ICON: Record<NotificationSeverity, ReactNode> = {
  info: ICON_INFO,
  success: ICON_CHECK,
  warning: ICON_WARNING,
  error: ICON_CLOSE,
};

/** Toasts in sight at once on a computer, newest nearest the corner; the corner never outgrows the window. */
const DESKTOP_TOASTS_SHOWN = 2;
/** A window shorter than this shows one toast, so the corner still fits. */
const SHORT_WINDOW_PX = 720;
/** Toasts in sight while an approval card is in the corner: the request a script waits on leads. */
const WITH_APPROVAL_SHOWN = 1;

/** At this width and below the phone keeps a closed toast to its title row (corner-stack.css). */
const PHONE_TITLE_ONLY_PX = 640;

/** How long an answered permission toast stays up before self-dismissing. */
const RESOLVED_DISMISS_MS = 3000;
/** Answerable permission toasts shown at once on a desktop; the rest fold into one line. */
const MAX_ASK_TOASTS = 2;
/** An ask toast left alone this long folds into that line: it stays reachable, not over the page. */
const ASK_TOAST_UP_MS = 30_000;
const PHONE_ASK_TOAST_MS = 15_000;

/**
 * When this browser first showed each ask toast, and a clock that moves while any is up,
 * so one left alone folds on time. `age(id)` is 0 for an ask not seen before.
 */
function useAskToastClock(ids: string[], seenInPanel: string[]): { age: (id: string) => number; touch: (id: string) => void; leave: (id: string) => void } {
  const seenAt = useRef(new Map<string, number>());
  // Toasts the pointer has moved onto and not left: someone reading stays up however long.
  const hovered = useRef(new Set<string>());
  const [now, setNow] = useState(() => Date.now());
  const at = Date.now();
  // Read in the open panel: once it closes, the ask does not pop up again as if new.
  for (const id of seenInPanel) seenAt.current.set(id, Number.NEGATIVE_INFINITY);
  for (const id of ids) if (!seenAt.current.has(id)) seenAt.current.set(id, at);
  const keep = new Set([...ids, ...seenInPanel]);
  for (const id of [...seenAt.current.keys()]) if (!keep.has(id)) seenAt.current.delete(id);
  for (const id of [...hovered.current]) if (!keep.has(id)) hovered.current.delete(id);
  const key = ids.join(' ');
  useEffect(() => {
    if (!key) return;
    const timer = window.setInterval(() => setNow(Date.now()), 2000);
    return () => window.clearInterval(timer);
  }, [key]);
  return {
    age: (id) => (hovered.current.has(id) ? 0 : Math.max(0, now - (seenAt.current.get(id) ?? now))),
    // A pointer moving on a toast is someone reading it: it waits until the pointer leaves.
    touch: (id) => { if (seenAt.current.has(id)) { seenAt.current.set(id, Date.now()); hovered.current.add(id); } },
    // Left, its time starts again from now.
    leave: (id) => { hovered.current.delete(id); if (seenAt.current.has(id)) seenAt.current.set(id, Date.now()); },
  };
}

export function NotificationToaster() {
  const { toasts: allToasts, feed, dismissToast, pinToast, markReadByKey } = useNotifications();
  const navigate = useNavigate();
  const phone = usePhoneLayout();
  usePhoneOverlayDepth(); // re-render when a session overlay opens or closes
  // Only while the approval card really shows: a Needs you line on screen lists them instead.
  const { approvalsListed } = useCornerState();
  const approvalInCorner = pendingAt(useApprovals(), Date.now()).length > 0 && !approvalsListed;
  // Over a chat (compact) the toasts keep to their short form but not to fewer of them: two Undos
  // from two columns closed back to back both stay in reach.
  const shownCount = approvalInCorner ? WITH_APPROVAL_SHOWN : window.innerHeight < SHORT_WINDOW_PX ? 1 : DESKTOP_TOASTS_SHOWN;
  // A permission a session waits on stays in sight whatever the count; the rest fill what is left.
  const asking = (t: (typeof allToasts)[number]) => t.kind === 'permission' && !t.resolved;
  // Asks take at most MAX_ASK_TOASTS places (the rest fold into one line).
  const room = shownCount - Math.min(MAX_ASK_TOASTS, allToasts.filter(asking).length);
  const kept = new Set(room > 0 ? allToasts.filter((t) => !asking(t)).slice(-room) : []);
  // "N more ›" opens the notification center, which lists only what it keeps. A toast it does not
  // keep (an Undo after a column closed) is shown in place instead: the count unfolds the stack.
  const [unfolded, setUnfolded] = useState(false);
  const folded = phone ? [] : allToasts.filter((t) => !asking(t) && !kept.has(t));
  const foldsEphemeral = folded.some((t) => !t.persistent);
  useEffect(() => { if (!foldsEphemeral && unfolded) setUnfolded(false); }, [foldsEphemeral, unfolded]);
  usePromptCardsChanged(); // re-render when a session's prompt card comes on screen or goes
  // The desktop twin of the phone rule: a session whose pending card is on screen gets no
  // permission toast, which would cover the card it repeats.
  const withCard = phone ? null : sessionsWithPromptCard();
  const [engaged, setEngaged] = useState<ReadonlySet<string>>(() => new Set());
  const engage = useCallback((id: string) => setEngaged((prev) => (prev.has(id) ? prev : new Set(prev).add(id))), []);
  // The open notification panel shows every pending ask already: no toast repeats one there.
  const centerOpen = useNotificationCenterOpen();
  const shown = phone
  ? phoneVisibleToasts(allToasts, (sid) => isPhoneOverlayOpen(`session:${sid}`))
  : unfolded && foldsEphemeral ? allToasts : allToasts.filter((t) => (asking(t)
    // An ask whose card is on screen, or with the panel open, is in view already: no toast repeats it.
    ? !(centerOpen || (t.sessionId && withCard?.has(t.sessionId)))
    : kept.has(t)));
  // The older ones stay in the notification center (on the phone they also wait their turn); one
  // line says how many and opens it. Asks are not among them: they have their own fold line.
  const older = phone ? allToasts.length - shown.length : allToasts.filter((t) => !asking(t) && !kept.has(t)).length;
  // Many sessions asking at once: two answerable asks stay up, the rest fold into one
  // line that opens the panel, so the stack never runs off the screen. One the person is
  // using (pointer on it, a note typed) stays; the other places go to the newest asks.
  // An ask nobody touched for ASK_TOAST_UP_MS folds too, so two old asks never sit over
  // the page's top corner for good.
  const pendingAsks = shown.filter((t) => t.kind === 'permission' && !t.resolved);
  const allAsks = allToasts.filter((t) => t.kind === 'permission' && !t.resolved);
  const now = useAskToastClock(pendingAsks.map((t) => t.id), centerOpen ? allAsks.map((t) => t.id) : []);
  const inUse = pendingAsks.filter((t) => engaged.has(t.id)).slice(-MAX_ASK_TOASTS);
  const free = MAX_ASK_TOASTS - inUse.length;
  const fresh = pendingAsks.filter((t) => !engaged.has(t.id) && now.age(t.id) < ASK_TOAST_UP_MS);
  const up = new Set([...inUse, ...(free > 0 ? fresh.slice(-free) : [])]);
  const foldedAsks = phone ? [] : pendingAsks.filter((t) => !up.has(t));
  // A phone has no fold line: an ask left alone goes after PHONE_ASK_TOAST_MS, as it always
  // did (its session's card and Needs you still hold it).
  const phoneGone = phone ? pendingAsks.filter((t) => !engaged.has(t.id) && now.age(t.id) >= PHONE_ASK_TOAST_MS) : [];
  const toasts = foldedAsks.length || phoneGone.length ? shown.filter((t) => !foldedAsks.includes(t) && !phoneGone.includes(t)) : shown;
  // A toast with its own clock hears when it goes out of sight and comes back (an Undo's clock
  // stands still meanwhile, so it never comes back with a moment left).
  const shownBefore = useRef(new Map<string, boolean>());
  useEffect(() => {
    const inSight = new Set(toasts.map((t) => t.id));
    const present = new Set<string>();
    for (const t of allToasts) {
      present.add(t.id);
      if (!t.onShownChange) continue;
      const inView = inSight.has(t.id);
      const was = shownBefore.current.get(t.id);
      if (was === undefined ? !inView : was !== inView) t.onShownChange(inView);
      shownBefore.current.set(t.id, inView);
    }
    for (const id of [...shownBefore.current.keys()]) if (!present.has(id)) shownBefore.current.delete(id);
  });

  // Every ask waiting, as the badge and the panel count them (some came before this page did).
  // An ask whose card is on screen is in view already: the line does not count it.
  const waitingTotal = Math.max(foldedAsks.length + up.size, feed.filter((n) => n.kind === 'permission' && !n.resolved && !(n.sessionId && withCard?.has(n.sessionId))).length);
  const moreCount = Math.max(foldedAsks.length, waitingTotal - up.size);
  // The fold line's ×: hidden until a new ask comes, not back when a toast up now folds later.
  const [lineHiddenFor, setLineHiddenFor] = useState<ReadonlySet<string> | null>(null);
  const askIds = pendingAsks.map((t) => t.id).join('\n');
  useEffect(() => {
    if (lineHiddenFor && pendingAsks.some((t) => !lineHiddenFor.has(t.id))) setLineHiddenFor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askIds, lineHiddenFor]);
  const hideLine = () => {
    setLineHiddenFor(new Set(pendingAsks.map((t) => t.id)));
    foldedAsks.forEach((t) => dismissToast(t.id));
  };

  // A toast that slid up under the pointer (the one above was answered) waits a beat before a click counts.
  const shiftGuard = useShiftClickGuard('.notification-toast');

  if (toasts.length === 0 && (foldedAsks.length === 0 || lineHiddenFor)) return null;
  // The count rides the top toast's title row (a link, not a card of its own); only a stack of
  // permission prompts, which have their own head, keeps it as a line above them.
  const moreHost = toasts.find((t) => !(t.kind === 'permission' && !t.resolved))?.id;
  const openCenter = foldsEphemeral
    ? () => setUnfolded(true)
    : () => window.dispatchEvent(new CustomEvent('notification:open-center'));
  const moreWords = older === 1 ? '1 more ›' : `${older} more ›`;
  // The key runs only the newest Undo: an older toast keeps its button, not the key.
  const keyed = [...toasts].reverse().find((t) => t.actionKeyHint)?.id;

  return (
    <CornerSlot order={CORNER_ORDER.toasts} className="corner-slot-toasts">
    <div ref={shiftGuard.ref} onClickCapture={shiftGuard.onClickCapture} className="notification-toaster" aria-live="polite">
      {older > 0 && !moreHost && (
        <button
          type="button"
          className="corner-more"
          data-testid="notification-toaster-more"
          onClick={openCenter}
        >
          {older === 1 ? '1 more notification ›' : `${older} more notifications ›`}
        </button>
      )}
      {toasts.map((toast) => {
        // A pending permission is answerable in place — its own card. One answered in
        // this browser stays that card a moment, saying which choice went (permissionOutcomeLabel).
        const answeredHere = toast.kind === 'permission' && !!toast.resolved && wasAnsweredFromToast(requestIdOf(toast) ?? '');
        if (toast.kind === 'permission' && (!toast.resolved || answeredHere)) {
          return (
            <PermissionToast
              key={toast.id}
              n={toast}
              onDismiss={() => dismissToast(toast.id)}
              // The toast is now a form; the 15s auto-dismiss must not pull it out
              // from under someone mid-typing. It asks the OWNER of the timer to
              // cancel it (see NotificationProvider.pinToast) rather than racing it.
              onPin={() => { pinToast(toast.id); engage(toast.id); }}
              onRead={() => now.touch(toast.id)}
              onLeave={() => now.leave(toast.id)}
              navigate={navigate}
              phone={phone}
            />
          );
        }
        return (
          <SwipeToast key={toast.id} phone={phone} onDismiss={() => dismissToast(toast.id)}>
            <MessageToast
              toast={toast}
              phone={phone}
              more={older > 0 && toast.id === moreHost ? { words: moreWords, older, open: openCenter, inPlace: foldsEphemeral } : null}
              onDismiss={() => dismissToast(toast.id)}
              onPin={() => pinToast(toast.id)}
              onRead={() => { if (toast.persistent) markReadByKey([toast.dedupKey]); }}
              navigate={navigate}
              keyed={toast.id === keyed}
            />
          </SwipeToast>
        );
      })}
      {foldedAsks.length > 0 && !lineHiddenFor && (
        <div className="nfc-more-asks-row">
          <button
            type="button"
            className="notification-toast nfc-more-asks"
            data-testid="toast-more-asks"
            onClick={() => window.dispatchEvent(new CustomEvent('notification:open-center'))}
          >
            {up.size > 0
              ? `+${moreCount} more ${moreCount === 1 ? 'ask waits' : 'asks wait'} for an answer \u00b7 Open the panel`
              // Nothing above it: the count is every ask waiting, as the badge and the panel have it.
              : `${waitingTotal} ${waitingTotal === 1 ? 'ask waits' : 'asks wait'} for an answer \u00b7 Open the panel`}
          </button>
          {/* Off the page's corner; the asks stay in the panel and on their session cards. */}
          <button type="button" className="nfc-more-asks-close" aria-label="Hide the waiting asks line" title="Hide (the asks stay in the panel)" onClick={hideLine}>&times;</button>
        </div>
      )}
    </div>
    </CornerSlot>
  );
}

/**
 * A toast's message: its title (a few lines), its body (a few more), and Details when either
 * is cut or the record keeps more (the raw line behind it). Details opens the whole text in
 * place and keeps the toast up until it is closed: reading must not race its timer.
 */
function MessageToast({ toast, phone, more, onDismiss, onPin, onRead, navigate, keyed }: {
  toast: Notification;
  phone: boolean;
  more: { words: string; older: number; open: () => void; inPlace: boolean } | null;
  onDismiss: () => void;
  onPin: () => void;
  onRead: () => void;
  navigate: (to: string) => void;
  /** This toast's action is the one the key runs: it shows the key. */
  keyed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // A title the server cut shows whole (its few lines, then Details); the raw rest stays detail.
  const whole = wholeTitle(toast.title, toast.detail);
  const cut = useCutOff([titleRef, bodyRef], `${whole.title}\n${toast.body ?? ''}\n${phone}`);
  const detail = whole.detail && whole.detail !== toast.body ? whole.detail : '';
  const commands = noticeCommands(whole.title, toast.body);
  // One command: one "Copy command" beside Details, no second copy icon in the words.
  const oneCopy = commands.length === 1;
  // Opened, nothing is cut any more: the toggle keeps the name it had when closed.
  const cutClosed = useRef(cut);
  if (!open) cutClosed.current = cut;
  // A narrow phone shows a toast's title alone; its body is what Details opens there.
  const titleOnly = phone && window.innerWidth <= PHONE_TITLE_ONLY_PX;
  const wordsCut = (open ? cutClosed.current : cut) || (titleOnly && !!toast.body);
  const hasMore = wordsCut || !!detail;
  const toggle = (
    <NoticeDetailsToggle open={open} log={!wordsCut && !!detail} onToggle={() => { if (!open) onPin(); setOpen(!open); }} />
  );
  const toolsInHeader = titleOnly && !open && hasMore;
  // Persistent toasts live in the feed too, so the body is a shortcut into
  // the notification center. Ephemeral ones (sort/audio) aren't — inert body.
  const opensCenter = toast.persistent;
  return (
    <div
      className={`notification-toast notification-toast--${toast.severity}${opensCenter ? ' notification-toast--clickable' : ''}${open ? ' is-open' : ''}`}
      role={toast.severity === 'error' || toast.severity === 'warning' ? 'alert' : 'status'}
      data-testid="notification-toast"
      onClick={opensCenter ? (e) => {
        // Selecting words to copy them is not a click on the toast.
        if (window.getSelection()?.toString()) return;
        if ((e.target as Element).closest('.notice-cmd')) return;
        window.dispatchEvent(new CustomEvent('notification:open-center'));
        onDismiss();
      } : undefined}
      title={opensCenter && !open ? 'Open notification center' : undefined}
    >
      <div className="notification-toast-header">
        <span className="notification-toast-icon">{SEVERITY_ICON[toast.severity]}</span>
        <span ref={titleRef} className="notification-toast-title"><NoticeWords text={whole.title} copy={!oneCopy} /></span>
        {more && (
          <button
            type="button"
            className="notification-toast-more"
            data-testid="notification-toaster-more"
            title={more.inPlace
              ? (more.older === 1 ? 'Show 1 more notification here' : `Show ${more.older} more notifications here`)
              : (more.older === 1 ? '1 more notification in the notification center' : `${more.older} more notifications in the notification center`)}
            onClick={(e) => { e.stopPropagation(); more.open(); }}
          >
            {more.words}
          </button>
        )}
        {/* The phone keeps a closed toast to one row: its Details sits in the title row. */}
        {toolsInHeader && toggle}
        <button
          className="notification-toast-close"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>
      {toast.body && <div ref={bodyRef} className="notification-toast-body"><NoticeWords text={toast.body} copy={!oneCopy} /></div>}
      {open && detail && (
        <div className="notification-toast-log" onClick={(e) => e.stopPropagation()}>
          <div className="notification-toast-log-label">Log</div>
          <pre className="notification-toast-detail" data-testid="notification-toast-detail">{prettyDetail(detail)}</pre>
        </div>
      )}
      {!toolsInHeader && (hasMore || open || oneCopy) && (
        <div className="notice-tools">
          {(hasMore || open) && toggle}
          {/* The command it names, in one place, one click away whether the words are cut or open. */}
          {oneCopy && <CopyCommandButton command={commands[0]} label />}
        </div>
      )}
      {/* A record with a button LIST (a plugin reminder's Done / Snooze):
          up to three, an `op` runs the plugin's op. Once the human pressed
          one the reminder is dealt with: the toast goes and the record is
          read. Touching a button pins the toast so a slow op cannot lose it. */}
      {toast.actions && toast.actions.length > 0 ? (
        <NotificationActionButtons
          n={toast}
          actions={displayActionsOf(toast)}
          variant="toast"
          onNavigate={(to) => navigateToTarget(to, navigate)}
          onInteract={onPin}
          onDone={() => { onDismiss(); onRead(); }}
        />
      ) : toast.action && (
        <button
          className="notification-toast-action"
          onClick={(e) => {
            e.stopPropagation();  // action has its own target — don't also open the center
            const a = toast.action;
            if (a?.kind === 'navigate' && a.to) {
              // Session deep links open on the home page's session columns
              // (primary surface) instead of the /sessions page.
              navigateToTarget(a.to, navigate);
            } else if (a?.kind === 'callback') {
              toast.onAction?.();
            } else {
              // Malformed action (e.g. navigate without `to`) — do nothing and
              // leave the toast up rather than silently dismissing on a no-op.
              return;
            }
            onDismiss();
          }}
        >
          {toast.action.label}
          {toast.actionKeyHint && keyed && <kbd className="notification-toast-kbd">{toast.actionKeyHint}</kbd>}
        </button>
      )}
      {/* A toast with its own clock (an Undo) shows how long it has left. */}
      {toast.durationMs && <ToastTimer total={toast.durationMs} timeLeft={toast.timeLeftMs} />}
    </div>
  );
}

/**
 * Answerable permission toast. Same respond() contract as the panel card and the
 * session view: 404/409 means the request already settled elsewhere (answered in
 * another surface, turn died) — settle and dismiss instead of re-arming buttons
 * the user would click forever.
 */
/** A wrapper that only adds the phone's swipe-down dismissal. */
function SwipeToast({ phone, onDismiss, children }: { phone: boolean; onDismiss: () => void; children: ReactNode }) {
  const swipe = useSwipeDownDismiss(phone, onDismiss);
  if (!phone) return <>{children}</>;
  return <div className="notification-toast-swipe" {...swipe}>{children}</div>;
}

function PermissionToast({ n, onDismiss, onPin, onRead, onLeave, navigate, phone = false }: {
  n: Notification;
  onDismiss: () => void;
  onPin: () => void;
  /** The pointer moves on it: it is being read (its fold waits). */
  onRead?: () => void;
  onLeave?: () => void;
  navigate: (to: string) => void;
  phone?: boolean;
}) {
  const detail = permissionDetail(n);
  const requestId = requestIdOf(n);
  // ONE store per request id, shared with the panel card and the session timeline
  // card (web/src/stores/permission-request-store.ts). The optimistic stamp is
  // what settles the other two surfaces in the same frame; 'stale' stays a third
  // outcome so a 404 never claims the user denied something they approved.
  const stored = usePermissionRequest(requestId ?? undefined);
  const busy = stored?.inFlight ?? false;
  const failed = stored?.failed ?? false;
  // The record's own outcome wins over the store (same precedence as the panel
  // card), so an 'expired' — session died, CLI withdrew the ask — renders as
  // settled rather than as live buttons. Today the toaster only routes UNresolved
  // permissions here and the provider dismisses the toast on resolution, so this
  // is the belt to that braces: if either gate changes, the chip is already right
  // instead of offering Approve/Deny for a dead request.
  const settled = n.resolved
    ?? (stored && isSettledPermission(stored.status) ? stored.status : null);
  const { hint: promptHint, options: acpOptions } = splitPromptHint(validAcpOptions(n));

  // An answered toast leaves on its own after a beat. Armed from the settle, not
  // from the click, so a transient failure keeps the toast (and its form) up.
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const selfDismissed = useRef(false);
  useEffect(() => {
    if (!settled || selfDismissed.current) return;
    selfDismissed.current = true;
    const timer = setTimeout(() => dismissRef.current(), RESOLVED_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  // The prompt's one note draft: the Deny below sends it once words are typed.
  const note = usePermissionNote(requestId);
  const second = useSecondClick();
  // A note typed turns the Allow choices off: nothing stays armed under it.
  const kept = { armed: note.text ? null : second.armed, confirm: second.confirm };
  const noteReject = acpOptions.find((o) => isRejectOption(o) && o.takesNote);
  // The server held this choice (its rule's file cannot be written): why, under it.
  const held = stored?.failed && stored.failReason ? stored.optionId : undefined;
  const respond = (
    allow: boolean,
    opts?: { optionId?: string; answers?: Record<string, string>; message?: string; images?: ImageAttachment[] },
  ) => {
    if (!n.sessionId || !requestId) return;
    markAnsweredFromToast(requestId);
    releaseAnswerFocus();
    void respondToPermissionRequest(n.sessionId, requestId, allow, {
      ...(opts?.optionId ? { optionId: opts.optionId } : {}),
      ...(opts?.answers ? { answers: opts.answers } : {}),
      ...(opts?.message ? { message: opts.message } : {}),
      ...(opts?.images?.length ? { images: opts.images } : {}),
    });
  };

  /** Hand a degraded ask over to the panel (a record we can't answer from here). */
  const openCenter = () => {
    window.dispatchEvent(new CustomEvent('notification:open-center'));
    onDismiss();
  };

  // Navigate to the session AND close the toast. The toast is ephemeral, so
  // dropping it on navigation is right — but the FEED copy stays exactly as it
  // was, still pending, because opening a session is not a decision. Only a real
  // resolution settles a permission (session:permission-resolved stamps the feed).
  const target = linkTargetOf(n);
  const openSession = () => {
    if (!target) return;
    navigateToTarget(target, navigate);
    onDismiss();
  };

  // Pin on the FIRST interaction only (pointerdown, focus, keystroke inside the
  // toast). A ref, not state: re-rendering the toast to remember "already pinned"
  // would remount the form's inputs and lose what the user typed.
  const pinned = useRef(false);
  const pinOnce = useCallback(() => {
    if (pinned.current) return;
    pinned.current = true;
    onPin();
  }, [onPin]);

  const swipe = useSwipeDownDismiss(phone, onDismiss);
  const context = [sessionLabelOf(n), n.host].filter(Boolean).join(' · ');
  // A record with no session/requestId can't be answered from here (legacy or a
  // dropped field) — offer the deep link instead of dead buttons. An
  // AskUserQuestion we can't render is the same story for a different reason: a
  // bare allow would report an empty answers map as the user's answer.
  const answerable = !!n.sessionId && !!requestId && !isUnanswerableAsk(n, detail);
  /** The whole ask is answered here now, however many questions it carries. */
  const questionForm = answerable && detail.type === 'question' ? detail.questions : null;

  return (
    <div
      // Answered: the warning stripe gives way to the outcome's tone while it says which choice went.
      className={`notification-toast nfc-perm-toast ${settled ? `nfc-perm-toast--settled nfc-perm-toast--${settled}` : 'notification-toast--warning'}`}
      role="alert"
      // Capture-phase listeners on the wrapper: one place to notice interaction
      // anywhere inside (pills, the free-text input, the option list), instead of
      // wiring a handler onto every control the form owns.
      onPointerDown={pinOnce}
      // A pointer moved onto the ask is someone reading it: it stays up until the pointer
      // leaves. One resting there unmoved (a toast that slid under it) keeps nothing up.
      onPointerMove={onRead}
      onPointerLeave={onLeave}
      onFocusCapture={pinOnce}
      onKeyDownCapture={pinOnce}
      {...swipe}
      // Phone: a tap on the toast's body (not on one of its controls) opens
      // the session it came from, as an overlay.
      onClick={phone && target ? (e) => {
        if ((e.target as Element).closest('button, a, input, textarea, select, label, [role="button"]')) return;
        openSession();
      } : undefined}
    >
      <div className="notification-toast-header">
        <span className="notification-toast-icon">{settled === 'allowed' ? '\u2713' : settled === 'denied' ? '\u2298' : SEVERITY_ICON.warning}</span>
        {/* A question reads as the session card titles it, not by its tool's name. */}
        <span className="notification-toast-title">{toolNameOf(n) === 'AskUserQuestion' ? 'Agent has a question' : toolNameOf(n) ?? n.title}</span>
        {/* Click-through to the session, on every permission toast with one. */}
        {target && (
          <button
            className="nfc-open-session"
            title="Open the session this came from"
            onClick={(e) => { e.stopPropagation(); openSession(); }}
          >
            Open session ↗
          </button>
        )}
        <button
          className="notification-toast-close"
          onClick={onDismiss}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </div>

      {context && <div className="nfc-perm-context">{context}</div>}

      {/* What is actually being asked. */}
      {detail.type === 'bash' && (
        <>
          {/* The agent's own words for the call, as the card and the panel show them. */}
          {detail.description && <div className="nfc-perm-desc">{detail.description}</div>}
          <PermCommand command={detail.command} onOpen={pinOnce} />
        </>
      )}
      {/* Only when the form ISN'T rendering the questions itself — the form prints
          every question text, so a preview line above it would say it twice. */}
      {detail.type === 'question' && !questionForm && (
        <div className="nfc-perm-ask">{detail.questions[0]?.question ?? n.body}</div>
      )}
      {detail.type === 'plan' && <div className="nfc-perm-ask">Plan ready for review</div>}
      {detail.type === 'file' && <div className="nfc-perm-path">{detail.filePath}</div>}
      {detail.type === 'generic' && (
        /* The over-ceiling case: `preview` is all that survived of the input, so
           show it — this branch used to render nothing about the ask. Clamped by
           .nfc-perm-cmd, with Details to open it and Copy beside it. */
        detail.preview
          ? <PermCommand command={detail.preview} onOpen={pinOnce} />
          : n.body ? <div className="notification-toast-body">{n.body}</div> : null
      )}

      {settled ? (
        /* Labels live in resolvedLabelOf so the panel and the toast can't drift
           ('expired' is kind-aware: "Session ended" on a permission, "Stale" on
           an error). The toaster's local 'stale' outcome falls through to its
           neutral "Already answered". */
        <div className="nfc-perm-settled"><AnswerText text={permissionOutcomeLabel(settled, stored, acpOptions, detail.type === 'question', detail.type === 'question' ? detail.questions.length : 0) ?? resolvedLabelOf({ kind: n.kind, resolved: settled })} /></div>
      ) : questionForm ? (
        /* The whole ask, answerable in the popup: every question, every option,
           multi-select, per-question free text. Height-capped + internally
           scrolled (`scrollable`) so a many-question ask keeps its Submit button
           on screen inside a 380px top-right toast. */
        <PermissionAnswerForm
          questions={questionForm}
          disabled={busy}
          resolved={false}
          scrollable
          onSubmit={(answers, images) => respond(true, { answers, ...(images?.length ? { images } : {}) })}
          onDismissQuestions={() => respond(false, { message: 'User dismissed the questions' })}
          // Beside the toast's own close (×), which only hides it: this one answers the agent.
          dismissLabel={questionForm.length === 1 ? 'Dismiss question' : 'Dismiss questions'}
        />
      ) : (
        <>
        {promptHint && answerable && <div className="perm-prompt-hint">{promptHint}</div>}
        <div className={`nfc-perm-actions${acpOptions.some((o) => o.detail || o.takesNote) ? ' perm-options-stack' : ''}`}>
          {!answerable ? (
            /* Nothing to answer WITH (no session/requestId), or an AskUserQuestion
               whose questions never survived the wire — a blanket Approve there
               would report an empty answers map as the user's answer. The center is
               the escape hatch: it shows the record's full detail, and for an
               unanswerable ask it offers the session deep link. */
            <button className="notification-toast-action" onClick={openCenter}>Open</button>
          ) : acpOptions.length > 0 ? (
            <>
              {acpOptions.map((o) => {
                const isReject = isRejectOption(o);
                return (
                  <button
                    key={o.optionId}
                    // A list that names rules stays neutral: no choice looks picked or recommended
                    // before the person picks (a Claude prompt's list, whose Deny takes a note). A plain list keeps its strong yes.
                    className={`nfc-perm-btn${kept.armed === o.optionId ? ' is-armed' : ''}${isLongRule(o.detail) ? ' perm-option--long-rule' : ''}${isReject || o.kind === 'allow_always' || acpOptions.some((x) => x.detail || x.takesNote) ? '' : ' nfc-perm-primary'}${o === noteReject && note.text ? ' perm-deny-with-note' : ''}${held === o.optionId ? ' is-failed' : ''}`}
                    data-choice={o.optionId}
                    // A toast reads each choice in one line: the whole rule and its file are here.
                    title={!isReject && note.text ? 'Clear the note to allow; a note goes with Deny' : [o.detail, o.savedTo && `Saves to ${o.savedTo}`].filter(Boolean).join('\n') || undefined}
                    disabled={busy || (!isReject && !!note.text)}
                    onClick={() => (o.savedTo && !kept.confirm(o.optionId)) || respond(!isReject, { optionId: o.optionId, ...(o === noteReject && note.text ? { message: denyMessageOf(note) } : {}) })}
                  >
                    {kept.armed === o.optionId && o.savedTo ? (
                      /* Armed: what the second click does takes the choice's own line, so the toast keeps its height. */
                      <>
                        <span className="perm-option-name perm-option-confirm-name"><SavedFileMark />Click again to save</span>
                        <span className="perm-option-sub perm-option-confirm-sub">to <span className="perm-saved-file">{o.savedTo}</span></span>
                      </>
                    ) : (
                      <>
                        <span className="perm-option-name">{o.savedTo && <SavedFileMark />}{o === noteReject && note.text ? `${o.name ?? o.optionId} with note` : (o.name ?? o.optionId)}</span>
                        {/* What a remembering choice allows, read before it is chosen. */}
                        {o.detail && <span className="perm-option-sub"><span className="perm-option-detail"><RuleDetail text={o.detail} /></span></span>}
                        {/* The server held this choice: why, under it. Otherwise where the rule is kept. */}
                        {held === o.optionId ? <span className="perm-option-failed" role="alert">{stored?.failReason}</span>
                          : o.savedTo && <span className="perm-option-saved" title={`Saves to ${o.savedTo}`}>Saves to <span className="perm-saved-file">{o.savedTo}</span></span>}
                      </>
                    )}
                  </button>
                );
              })}
              {/* The adapter's own reject option may be absent — keep a plain Deny. */}
              {!acpOptions.some(isRejectOption) && (
                <button className="nfc-perm-btn" disabled={busy} onClick={() => respond(false)}>
                  Deny
                </button>
              )}
              {/* A Claude prompt's Deny takes a note, as on the session card. */}
              {requestId && noteReject && (
                <DenyWithNote note={note} disabled={busy} onDeny={(message) => respond(false, { optionId: noteReject.optionId, message })} />
              )}
            </>
          ) : (
            <>
              <button
                className="nfc-perm-btn nfc-perm-primary"
                disabled={busy || !!note.text}
                title={note.text ? 'Clear the note to allow; a note goes with Deny' : undefined}
                onClick={() => respond(true)}
              >
                Allow
              </button>
              <button className={`nfc-perm-btn${note.text ? ' perm-deny-with-note' : ''}`} disabled={busy} onClick={() => respond(false, note.text ? { message: denyMessageOf(note) } : undefined)}>
                {note.text ? 'Deny with note' : 'Deny'}
              </button>
              {requestId && <DenyWithNote note={note} disabled={busy} onDeny={(message) => respond(false, { message })} />}
            </>
          )}
        </div>
        {/* Said, not only greyed: why the Allow choices went off. Under the note, as on the
            session card, so no choice moves under the pointer while the note is typed. */}
        {answerable && note.text && <div className="perm-prompt-hint perm-note-off">Allow is off while a note is typed. Clear it to allow.</div>}
        </>
      )}
      {/* Hoisted out of the actions row: a failed SUBMIT from the answer form
          above needs the same message, and the form has no actions row of its own. */}
      {!settled && failed && !held && (
        <div className="nfc-perm-error nfc-perm-error--block" role="alert">{stored?.failReason ?? 'Failed. Open the session to respond.'}</div>
      )}
    </div>
  );
}

/** The command a permission asks about: two lines, Details for the rest, and Copy. */
function PermCommand({ command, onOpen }: { command: string; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const cut = useCutOff([ref], command);
  return (
    <div className="nfc-perm-cmd-wrap">
      {/* The box keeps its padding; the words inside clamp, so no sliver of a third line shows. */}
      <code className={`nfc-perm-cmd${open ? ' is-open' : ''}`}><span ref={ref} className="nfc-perm-cmd-text">{command}</span></code>
      <div className="nfc-perm-cmd-tools">
        {(cut || open) && <NoticeDetailsToggle open={open} onToggle={() => { onOpen(); setOpen(!open); }} />}
        <CopyCommandButton command={command} label />
      </div>
    </div>
  );
}

/** A toast's time left as a bar, drawn from where its clock stands when it comes into sight. */
function ToastTimer({ total, timeLeft }: { total: number; timeLeft?: () => number }) {
  const [start] = useState(() => Math.max(0, Math.min(total, timeLeft?.() ?? total)));
  return (
    <div className="notification-toast-timer" aria-hidden="true">
      <div
        className="notification-toast-timer-bar"
        style={{ animationDuration: `${start}ms`, ['--timer-from' as string]: String(total > 0 ? start / total : 0) }}
      />
    </div>
  );
}
