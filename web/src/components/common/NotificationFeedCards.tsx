/**
 * The rows of the notification center's feed (NotificationPanel.tsx), each drawn as the one notice
 * card (NoticeCard, `solid` inside the panel): the same frame, avatar, bold title, status as a dot
 * and a word, and two-line preview as every toast (2026-11-21 audit: the center's rows were a third
 * card of their own, unread ones tinted blue with a strong border, the time beside a title cut
 * before it said which task, and the source as two stacked chips).
 *
 * A row reads: its title (in full, never cut: standard.md "Text that does not fit"; the × at its
 * top right), one quiet line with its status, when and how often, its whole text, one quiet line
 * naming who it came from (the debug
 * details, a session id or a host, in that line's title), then what it offers to do.
 * tests/web/notice-card-guard.test.ts fails on a row drawn some other way.
 */
import { memo, useEffect, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  personFixesCard, toolNameOf, formatRelative, effectiveTs, linkTargetOf, resolvedLabelOf,
  categoryOf, presentError, letterIdOf, nextActionExpiry, displayActionsOf,
  type Notification,
} from '@/contexts/notifications';
import { feedRowSource, feedRowStatus } from '@/contexts/notifications/notice-face';
import { AnswerText } from '@/components/sessions/RuleDetail';
import { PermissionAnswerButtons, PermissionAskDetail, permissionOutcomeLabel, usePermissionAnswer } from './PermissionPromptControls';
import { NotificationActionButtons } from './NotificationActionButtons';
import { NoticeCard, NoticeStatus, noticeAvatarOf } from './NoticeCard';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { useHostDisplayLabel } from '@/hooks/useHostDisplayLabel';
import { startNotificationFix } from '@/api/notifications';
import { useLocalAgentBlocked } from '@/utils/local-agent-runnable';
import { taskPath } from '@/utils/task-path';
import { log } from '@/utils/log';
import { DisclosureButton } from '@/components/controls';

/** Tool ids a person does not read, as the phone's center names them (N2-12). */
const PHONE_TOOL_TITLES: Record<string, string> = { AskUserQuestion: 'Question', ExitPlanMode: 'Plan review' };

/**
 * Same-origin collapse key: a session's permission asks stack together, a cron
 * job's repeated runs stack together. Everything else stands alone.
 */
function groupKeyOf(n: Notification): string {
  if (n.kind === 'permission' && n.sessionId) return `perm:${n.sessionId}`;
  if (n.kind === 'operation-error' && n.sessionId) return `error:session:${n.sessionId}`;
  if (n.kind === 'operation-error' && n.taskId) return `error:task:${n.taskId}`;
  if (n.kind === 'cron') return `cron:${n.title}`;
  return n.dedupKey;
}

export interface FeedGroup { key: string; items: Notification[] }

/** Partition a list into same-origin groups, preserving the caller's order. */
export function collapseSameOrigin(items: Notification[]): FeedGroup[] {
  const byKey = new Map<string, Notification[]>();
  for (const n of items) {
    const key = groupKeyOf(n);
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }
  return [...byKey.entries()].map(([key, list]) => ({ key, items: list }));
}

export interface FeedGroupsProps {
  groups: FeedGroup[];
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  onNavigate: (to: string) => void;
  onDismissKey: (dedupKey: string) => void;
  /** A letter envelope in the All feed opens the reader, not a session link. */
  onOpenLetter?: (letterId: string) => void;
  /** All-section only: name the family on an error card, since there is no header. */
  showCategoryChip?: boolean;
  /** Whether an error card may offer "Ask AI to fix" (see the panel's selfRepair).
   *  Passed as a plain boolean because FeedItem is memo'd: reading it from a
   *  context inside would not re-render the card when the fetch lands. */
  canFix?: boolean;
  /** The first fix has to clone Walnut's source (minutes): the button says so. */
  fixNeedsClone?: boolean;
}

/**
 * The card list for one set of same-origin groups, rendered once per error category and once
 * flat for the other sections, so the collapse rules (a collapsed group never buries a pending
 * ask) live in one place.
 */
export function FeedGroups({
  groups, expandedGroups, onToggleGroup, onNavigate, onDismissKey, onOpenLetter, showCategoryChip,
  canFix, fixNeedsClone,
}: FeedGroupsProps) {
  return (
    <>
      {groups.map(({ key, items: groupItems }) => {
        const expanded = expandedGroups.has(key) || groupItems.length === 1;
        // A collapsed group must never bury an actionable entry: a newer
        // resolved permission would otherwise cover an older still-pending
        // one, hiding its Approve/Deny buttons behind "Show N more".
        const pending = groupItems.find(i => i.kind === 'permission' && !i.resolved);
        // `slice(0, 1)` for the fallback, not `[groupItems[0]]`: an empty
        // group would otherwise render one `undefined` child.
        const visible = expanded ? groupItems : (pending ? [pending] : groupItems.slice(0, 1));
        return (
          <div key={key} className="notification-feed-group">
            {visible.map((n) => (
              n.kind === 'permission' ? (
                <PermissionCard key={n.id} n={n} onNavigate={onNavigate} onDismiss={() => onDismissKey(n.dedupKey)} />
              ) : (
                <FeedItem
                  key={n.id}
                  n={n}
                  onNavigate={onNavigate}
                  onDismiss={() => onDismissKey(n.dedupKey)}
                  {...(onOpenLetter ? { onOpenLetter } : {})}
                  showCategoryChip={showCategoryChip}
                  canFix={canFix}
                  fixNeedsClone={fixNeedsClone}
                />
              )
            ))}
            {groupItems.length > 1 && (
              <button className="notification-group-toggle" onClick={() => onToggleGroup(key)}>
                {expanded ? 'Show less' : `Show ${groupItems.length - 1} more`}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/** The × at a row's top right, the same on every card. */
/** Who a row came from, and what only helps debugging (a session id, a host): one hover away. */
function useRowSource(n: Notification): { text: string | null; detail: string | null } {
  const hostName = useHostDisplayLabel(n.host);
  return feedRowSource(n, n.host ? hostName : undefined);
}

/** The quiet line under a row's title: its status, when (its title holds the debug details), and anything else that is state. */
function RowMeta({ n, detail, extra }: { n: Notification; detail: string | null; extra?: ReactNode }) {
  const status = feedRowStatus(n);
  return (
    <>
      {status.text && <NoticeStatus tone={status.tone} className="nfc-row-status">{status.text}</NoticeStatus>}
      <span className="notification-feed-item-time wn-fixed" title={detail ?? undefined}>{formatRelative(effectiveTs(n))}</span>
      {extra}
    </>
  );
}

/** Who a row came from, once, as its last quiet line. */
function RowSource({ source }: { source: { text: string | null; detail: string | null } }) {
  if (!source.text) return null;
  return <div className="nfc-row-source" title={source.detail ?? undefined}>{source.text}</div>;
}

/** A row re-renders when its next button expires, so an open panel drops it then too. */
function useActionExpiry(n: Notification): void {
  const [, tick] = useReducer((x: number) => x + 1, 0);
  const next = nextActionExpiry(n);
  useEffect(() => {
    if (next === null) return undefined;
    // Capped so a far-off expiry never overflows setTimeout's 32-bit delay.
    const timer = window.setTimeout(tick, Math.min(Math.max(0, next - Date.now()) + 50, 2 ** 30));
    return () => window.clearTimeout(timer);
  }, [next]);
}

/**
 * Rich permission card: decide here instead of opening the session. Renders what is being asked
 * from the server's compacted tool input, then the buttons that actually answer it (ACP option
 * list, an AskUserQuestion answer form, or Approve/Deny).
 */
const PermissionCard = memo(function PermissionCard({ n, onNavigate, onDismiss }: {
  n: Notification;
  onNavigate: (to: string) => void;
  onDismiss: () => void;
}) {
  // ONE store per request id, shared with the session timeline card and the toast
  // (web/src/stores/permission-request-store.ts): answering here settles the OTHER two surfaces
  // in the same frame, and 'stale' stays a third outcome.
  const answer = usePermissionAnswer(n);
  const { resolved, failed: respondError } = answer;
  const target = linkTargetOf(n);
  // A phone names the ask in words, not by the tool id (N2-12).
  const phoneTitles = usePhoneLayout();
  const tool = toolNameOf(n);
  const title = (phoneTitles && tool ? PHONE_TOOL_TITLES[tool] : undefined) ?? tool ?? n.title;
  const source = useRowSource(n);
  return (
    // A decision card in a narrow panel: its text opens downward, never across the window.
    <div data-peek-row="" data-peek-grow="down" className="nfc-perm-row">
      <NoticeCard
        solid
        className={`notification-feed-item nfc-perm-card notification-feed-item--${n.severity}${n.read ? '' : ' unread'}`}
        avatar={noticeAvatarOf(n)}
        who={title}
        wrapTitle
        meta={<RowMeta n={n} detail={source.detail} />}
        parts={{ who: 'notification-feed-item-title' }}
        bodyFlush
        onClose={onDismiss}
        closeLabel="Dismiss notification"
        end={(
          <>
            {/* The one way from a permission to its session (the card body is a decision
                surface): it never dismisses or resolves the entry, and the panel closes. */}
            {target && (
              <button
                type="button"
                className="nfc-open-session"
                title="Open the session this came from"
                onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
              >
                Open session ↗
              </button>
            )}
          </>
        )}
      >
        {/* What is being asked, and the answer: shared with the kanban card's prompt. */}
        <PermissionAskDetail n={n} detail={answer.detail} />
        {resolved && (
          /* Pass the LOCAL resolved, not `n`: right after an inline answer only `sent` knows
             the outcome (`n.resolved` waits for the server round-trip). */
          <div className={`notification-feed-item-resolved notification-feed-item-resolved--${resolved}`}><AnswerText text={permissionOutcomeLabel(resolved, answer.stored, answer.acpOptions, answer.detail.type === 'question', answer.detail.type === 'question' ? answer.detail.questions.length : 0) ?? resolvedLabelOf({ kind: n.kind, resolved })} /></div>
        )}
        <RowSource source={source} />
        <PermissionAnswerButtons
          answer={answer}
          fallback={target && (
            <div className="notification-feed-item-actions">
              <button className="notification-perm-btn" onClick={() => onNavigate(target)}>Go to Session</button>
            </div>
          )}
        />
        {/* Gated on !resolved: a request that later settled must not keep advertising an
            earlier failed attempt from this card. */}
        {!resolved && respondError && !answer.stored?.failReason && (
          <span className="notification-perm-error" role="alert">{answer.stored?.failReason ?? 'Failed — open the session to respond'}</span>
        )}
      </NoticeCard>
    </div>
  );
});

/** dedupKeys with an "Ask AI to fix" launch in flight, across card mounts. */
const fixesInFlight = new Set<string>();

/** Error / automation / letter row: title, status and time, preview, source, its buttons. */
const FeedItem = memo(function FeedItem({
  n, onNavigate, onDismiss, onOpenLetter, showCategoryChip, canFix, fixNeedsClone,
}: {
  n: Notification;
  onNavigate: (to: string) => void;
  onDismiss: () => void;
  onOpenLetter?: (letterId: string) => void;
  showCategoryChip?: boolean;
  canFix?: boolean;
  fixNeedsClone?: boolean;
}) {
  // The raw technical block, opened deliberately: the human title and text always show in full
  // (standard.md, "Text that does not fit"), the JSON only when asked for.
  const [detailOpen, setDetailOpen] = useState(false);
  // "Ask AI to fix" in flight / its failure text, per card; the in-flight flag seeds from the
  // module-level set so a card re-mounted mid-launch still reads busy.
  const [fixBusy, setFixBusy] = useState(() => fixesInFlight.has(n.dedupKey));
  const [fixError, setFixError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useActionExpiry(n);
  const source = useRowSource(n);
  // Claude Code cannot run on this computer: no Fix with agent (the same gate as every repair start).
  const agentBlocked = useLocalAgentBlocked();
  const target = linkTargetOf(n);
  const count = n.count ?? 1;
  // Human title/body + the raw line for the toggle (also repairs a pre-humanizer record).
  const presented = n.kind === 'operation-error'
    ? presentError(n)
    : { title: n.title, body: n.body ?? '', detail: undefined as string | undefined };
  const category = n.kind === 'operation-error' && showCategoryChip ? categoryOf(n) : null;
  // The condition this error described is gone; 'expired' is the other end (nothing can recover it).
  const recovered = n.resolved === 'recovered';
  const stale = n.resolved === 'expired';
  // A letter envelope in the All feed opens the LETTER, never its origin session.
  const letterId = n.kind === 'letter' && onOpenLetter ? letterIdOf(n) : null;
  // A row with neither a letter nor a target has nothing to open: its words are already whole,
  // so it is not a button.
  const activate = letterId
    ? () => onOpenLetter?.(letterId)
    : target ? () => onNavigate(target) : null;

  // The repair session this error already has (server-owned `fix`); the task page when the
  // launch answered without a session id.
  const fixTarget = n.fix
    ? (n.fix.sessionId ? `/sessions?id=${n.fix.sessionId}` : taskPath(n.fix.taskId))
    : null;
  // Only an error can be handed to a coding session, and only where a source tree exists
  // (canFix) or a session already ran (n.fix).
  const fixKind = (n.kind === 'operation-error'
    || (n.severity === 'error' && ['cron', 'skill', 'hook'].includes(n.kind))) && !personFixesCard(n);
  // Not while Claude Code cannot run here; a repair session that already ran still opens.
  const showFixActions = fixKind && (!agentBlocked || !!fixTarget);
  // A navigate action the PRODUCER attached, on a card with no session of its own.
  const producerAction = n.kind === 'operation-error' && !n.sessionId && !recovered
    && n.action?.kind === 'navigate' && n.action.to
    ? { label: n.action.label, to: n.action.to }
    : null;
  // A record's own button LIST (a plugin reminder's Done / Snooze), without the ones whose
  // moment passed (a break that ended): then the row is history and offers none.
  const noticeActions = n.actions && n.actions.length > 0 && !recovered && !stale
    ? displayActionsOf(n)
    : [];

  const startFix = async (restart: boolean) => {
    if (fixBusy || fixesInFlight.has(n.dedupKey)) return;
    fixesInFlight.add(n.dedupKey);
    setFixBusy(true);
    setFixError(null);
    try {
      const result = await startNotificationFix(n.dedupKey, restart ? { restart: true } : undefined);
      log.info('notifications', 'repair session started', {
        dedupKey: n.dedupKey, taskId: result.taskId, sessionId: result.sessionId, reused: result.reused,
      });
      // Only the card the user is still looking at may move them.
      if (!mounted.current) return;
      onNavigate(result.sessionId ? `/sessions?id=${result.sessionId}` : taskPath(result.taskId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('notifications', 'repair session failed to start', { dedupKey: n.dedupKey, error: message });
      if (mounted.current) setFixError(message);
    } finally {
      fixesInFlight.delete(n.dedupKey);
      if (mounted.current) setFixBusy(false);
    }
  };

  // Buttons inside a row stop the row's own click and keys (it navigates or opens a letter).
  const stop = { onClick: (e: MouseEvent) => e.stopPropagation(), onKeyDown: (e: KeyboardEvent) => e.stopPropagation() };
  return (
    <NoticeCard
      solid
      className={`notification-feed-item notification-feed-item--${n.severity}${n.read ? '' : ' unread'}${activate ? ' clickable' : ''}${recovered || stale ? ' recovered' : ''}`}
      {...(activate ? {
        role: 'button',
        onClick: activate,
        handlers: {
          tabIndex: 0,
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
          },
        },
      } : {})}
      avatar={noticeAvatarOf(n)}
      who={presented.title}
      wrapTitle
      parts={{ who: 'notification-feed-item-title', line: 'notification-feed-item-body' }}
      meta={<RowMeta n={n} detail={source.detail} extra={(
        <>
          {/* Occurrence fold: 36 identical failures are one row plus how often (99+ at most). Both
              are the one label; on the meta line it reads as a word (styles/badge.css). */}
          {count >= 2 && <span className="badge badge-count nfc-count-badge wn-fixed">&times;{count > 99 ? '99+' : count}</span>}
          {/* All-section only: the Errors rail has category headers, so this would repeat them.
              Metadata: it gives up its words before the time and count do. */}
          {category && <span className="badge nfc-chip-category wn-meta"><span>{category}</span></span>}
        </>
      )} />}
      line={presented.body || undefined}
      onClose={onDismiss}
      closeLabel="Dismiss notification"
    >
      {presented.detail && (
        <div className="nfc-card-detail">
          <DisclosureButton
            className="nfc-detail-toggle"
            expanded={detailOpen}
            onClick={(e) => { e.stopPropagation(); setDetailOpen(v => !v); }}
          >
            Details
          </DisclosureButton>
          {detailOpen && <pre className="nfc-card-pre" onClick={(e) => e.stopPropagation()}>{presented.detail}</pre>}
        </div>
      )}
      <RowSource source={source} />
      {/* The producer's own remedy ("Sign in"): a card that asks for an action shows it. */}
      {producerAction && (
        <div className="nfc-card-actions" {...stop}>
          <button
            className="nfc-card-action nfc-card-action--primary"
            data-testid="nfc-producer-action"
            onClick={(e) => { e.stopPropagation(); onNavigate(producerAction.to); }}
          >
            {producerAction.label} ↗
          </button>
        </div>
      )}
      {noticeActions.length > 0 && (
        <NotificationActionButtons n={n} actions={noticeActions} variant="card" onNavigate={onNavigate} onDone={() => {}} />
      )}
      {/* Hand the error to a coding session in Walnut's own source. */}
      {showFixActions && (
        <div className="nfc-card-actions" {...stop}>
          {fixTarget ? (
            <>
              <button
                className="nfc-card-action nfc-fix-open"
                data-testid="nfc-fix-open"
                title="Open the repair session already working on this error"
                onClick={(e) => { e.stopPropagation(); onNavigate(fixTarget); }}
              >
                Open fix session ↗
              </button>
              {/* Quiet secondary: the first session may have finished or gone wrong. */}
              {!agentBlocked && <button
                className="nfc-card-action nfc-fix-restart"
                data-testid="nfc-fix-restart"
                title="Start a fresh repair session for this error"
                disabled={fixBusy}
                onClick={(e) => { e.stopPropagation(); void startFix(true); }}
              >
                {fixBusy ? 'Starting…' : 'Fix again'}
              </button>}
            </>
          ) : (
            <button
              className="nfc-card-action nfc-fix-start"
              data-testid="nfc-fix-start"
              title={canFix ? "Start a coding session in Walnut's source with this error as the brief" : 'Agent repair is unavailable on this server'}
              disabled={fixBusy || !canFix}
              onClick={(e) => { e.stopPropagation(); void startFix(false); }}
            >
              {fixBusy
                ? (fixNeedsClone ? 'Cloning Walnut source… (first time only)' : 'Starting…')
                : 'Fix with agent'}
            </button>
          )}
          {fixError && <span className="nfc-fix-error">{fixError}</span>}
        </div>
      )}
    </NoticeCard>
  );
});
