/**
 * Notification panel — slide-out overlay from the sidebar, laid out as a
 * rail + detail pair (same shape as ViewDropdown's receipt body).
 *
 * The rail sorts the feed by WHAT THE USER HAS TO DO:
 *   Needs Action — pending permission asks, answerable right here
 *   Errors       — operation errors (with the server's ×N occurrence folding)
 *   Automation   — cron / skill / hook receipts
 *   System       — ambient health (remote hosts, data backup, embedding search)
 *   All          — the whole feed, newest first
 * A flat single list buried the one entry that blocks a session under twenty
 * receipts, which is why permissions used to need a session round-trip.
 *
 * Opening the panel marks the feed read. Same-origin entries (one cron job's
 * runs, one session's permissions) still collapse into an expandable group, and a
 * collapsed group never hides a pending ask.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import {
  useNotifications, sectionOf, sectionCounts, effectiveTs, permissionDetail, requestIdOf,
  toolNameOf, isUnanswerableAsk, validAcpOptions, isRejectOption, sessionLabelOf, formatRelative,
  linkTargetOf, resolvedLabelOf, categoryOf, presentError, groupErrorsByCategory,
  systemIssueCount,
  type Notification, type NotificationSection,
} from '@/contexts/notifications';
import { respondToPermission } from '@/api/sessions';
import { PermissionAnswerForm } from './PermissionAnswerForm';
import { NotificationSystemPane, useQmdStatus, qmdUnhealthy } from './NotificationSystemPane';
import { navigateToTarget } from '@/utils/open-session';
import { log } from '@/utils/log';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

/** Rail tabs — the notification sections plus the ambient System zone. */
type RailSection = NotificationSection | 'system';

export function NotificationPanel({ open, onClose, sidebarCollapsed }: NotificationPanelProps) {
  const { hasIssues } = useSystemHealth();
  const { feed, loaded, unreadCount, markAllRead, dismissFeed } = useNotifications();
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<RailSection>('all');
  // Second-level filter inside Errors: null = every category (the landing view),
  // a string = just that family. Owned here (not in the section union) because it
  // is a refinement of one section, not a sibling of the others.
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  const navigate = useNavigate();
  const qmdStatus = useQmdStatus(open, section === 'system');

  const counts = useMemo(() => sectionCounts(feed), [feed]);

  // The System zone's own health signal. `hasIssues` is useSystemHealth's own
  // derivation (git-sync unprotected or failing) — the same one the Sidebar's
  // status pill reads; the index error state is the other thing shown in there
  // that can be broken.
  const systemUnhealthy = hasIssues || qmdUnhealthy(qmdStatus);
  // …and how MANY of them are broken, for the rail badge (the derivation is in
  // the model so it is testable and can't drift from the flags above).
  const systemIssues = systemIssueCount({
    gitSyncFailing: hasIssues,
    indexUnhealthy: qmdUnhealthy(qmdStatus),
  });

  // Items of the active section, newest first. Sorting on effectiveTs (not
  // timestamp) keeps a folded recurring error at the top of the list — its
  // `timestamp` is first-seen and can be hours old while it is still firing.
  const items = useMemo(() => {
    const pool = section === 'system' ? []
      : section === 'all' ? feed
      : feed.filter(n => sectionOf(n) === section);
    return [...pool].sort((a, b) => effectiveTs(b) - effectiveTs(a));
  }, [feed, section]);

  // Same-origin entries collapse into one expandable group (iPhone-style):
  // a cron job's repeated runs stack under the job name, a session's permission
  // asks stack under the session. Groups keep the newest-first item order.
  const groups = useMemo(() => collapseSameOrigin(items), [items]);

  // Errors get a SECOND level of structure: a category header per family, so
  // three failures of one plugin read as one problem. Category order is
  // most-recent-activity (groupErrorsByCategory), and the same-origin collapse
  // still applies INSIDE each category — the two groupings answer different
  // questions ("what family" vs "is this the same origin repeating").
  //
  // Computed from the FEED, not from the active section's items: the rail lists
  // the categories as sub-entries under Errors (so a specific family is one
  // click away from anywhere), which means the grouping has to exist even while
  // the user is reading another section.
  const errorCats = useMemo(() => {
    const errs = feed.filter(nn => sectionOf(nn) === 'errors');
    return groupErrorsByCategory([...errs].sort((a, b) => effectiveTs(b) - effectiveTs(a)));
  }, [feed]);

  // The selected category, validated against what actually exists: when the last
  // card of the chosen family recovers or is dismissed, the view falls back to
  // all errors instead of pinning an empty pane to a stale filter.
  const activeErrorCategory =
    errorCategory && errorCats.some(g => g.category === errorCategory) ? errorCategory : null;

  const errorBlocks = useMemo(() => (
    section === 'errors'
      ? errorCats
        .filter(g => !activeErrorCategory || g.category === activeErrorCategory)
        .map(g => ({
          category: g.category,
          count: g.items.length,
          groups: collapseSameOrigin(g.items),
        }))
      : null
  ), [errorCats, section, activeErrorCategory]);

  // Opening the panel clears the unread badge (everything in the feed is now seen).
  // Re-fires while open if new persistent events arrive (unreadCount climbs again) —
  // intentional: items seen while watching the panel should be marked read too.
  useEffect(() => {
    if (open && unreadCount > 0) markAllRead();
  }, [open, unreadCount, markAllRead]);

  // Did the user pick a rail section themselves since this open? Once they have,
  // nothing may move them (see the re-choose effect below). Reset per open.
  const userPickedSection = useRef(false);
  const pickSection = useCallback((next: RailSection) => {
    userPickedSection.current = true;
    setSection(next);
    // Entering Errors through the SECTION button always lands on every category
    // ("all" is the natural landing); a specific family is only reached through
    // its own sub-entry (pickErrorCategory below).
    setErrorCategory(null);
  }, []);

  const pickErrorCategory = useCallback((category: string) => {
    userPickedSection.current = true;
    setSection('errors');
    setErrorCategory(category);
  }, []);

  // Landing section is chosen ONCE per open (not derived every render): a pending
  // ask answered while the panel is open must not yank the user back to an empty
  // Needs Action, and a new ask arriving must not steal the section they're reading.
  useEffect(() => {
    if (!open) return;
    userPickedSection.current = false;
    setSection(sectionCounts(feed).action > 0 ? 'action' : 'all');
    setErrorCategory(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-transition only
  }, [open]);

  // …but on the FIRST open the initial GET may still be in flight, so the feed is
  // empty-so-far and the choice above lands on All even with pending permissions
  // waiting. Re-choose exactly once when the load finishes — unless the user has
  // already clicked a section, in which case their choice wins.
  useEffect(() => {
    if (!open || !loaded || userPickedSection.current) return;
    setSection(sectionCounts(feed).action > 0 ? 'action' : 'all');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded-transition only
  }, [open, loaded]);

  // Escape closes, same idiom as Lightbox/FileViewer: the panel is a portalled
  // overlay, so there is no ancestor to catch the key — it has to be on document.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onNavigate = useCallback((to: string) => {
    navigateToTarget(to, navigate);
    onClose();
  }, [navigate, onClose]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!open) return null;

  // Portal to <body>: the panel is mounted inside the Sidebar, whose mobile
  // styles apply a transform — that turns the sidebar into the containing
  // block for position:fixed, dragging the "fixed" panel off-screen with the
  // slide animation. Rendering at the body level keeps fixed truly viewport-fixed.
  return createPortal(
    <>
      {/* Backdrop */}
      <div className="notification-panel-backdrop" onClick={onClose} />

      {/* Panel */}
      <div
        className={`notification-panel nfc-panel-wide${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}
      >
        <div className="notification-panel-header">
          <span className="notification-panel-title">Notifications</span>
          {feed.length > 0 && (
            <button
              className="notification-clear-all nfc-header-clear"
              onClick={() => { dismissFeed(); setExpandedGroups(new Set()); }}
            >
              Clear All
            </button>
          )}
          <button className="notification-panel-close" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="16" height="16">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body: rail + detail. The panel is a fixed slide-out (top:0/bottom:0),
            so the body's height is fully determined by the viewport — `flex:1` +
            `min-height:0` is safe here (ViewDropdown needs `flex:0 1 <basis>`
            because ITS height comes from an inline maxHeight instead). */}
        <div className="nfc-body">
          {/* Plain buttons + aria-current, deliberately NOT role=tablist/tab —
              same call as ViewDropdown's rail: the ARIA tab pattern obliges a
              tabpanel, arrow-key navigation and a roving tabIndex, and a
              half-implemented contract misleads a screen reader worse than an
              honest list of buttons does. */}
          <div className="nfc-rail" aria-label="Notification sections">
            <RailButton
              label="Needs Action" count={counts.action} warn
              active={section === 'action'} onClick={() => pickSection('action')}
            />
            {/* Every rail section carries a badge, and the non-action ones show
                what the tab LISTS (not just what is unread): a rail where only
                Needs Action had a number left the user unable to see that nine
                errors were sitting one click away, because opening the panel
                marks everything read. Neutral accent — only pending permissions
                get the warning colour. */}
            <RailButton
              label="Errors" count={counts.errorsTotal}
              active={section === 'errors' && !activeErrorCategory}
              onClick={() => pickSection('errors')}
            />
            {/* Second-level entries: the error FAMILIES, one click from anywhere.
                The section button is the "all" view (a category is a refinement,
                so selecting one moves aria-current onto the sub-entry). Rendered
                only when there are two or more families — a single category IS
                the all view, and a sub-entry duplicating its parent is noise. */}
            {errorCats.length >= 2 && errorCats.map(g => (
              <RailSubButton
                key={g.category}
                label={g.category} count={g.items.length}
                active={section === 'errors' && activeErrorCategory === g.category}
                onClick={() => pickErrorCategory(g.category)}
              />
            ))}
            <RailButton
              label="Automation" count={counts.automationTotal}
              active={section === 'automation'} onClick={() => pickSection('automation')}
            />
            {/* System has no feed entries, so its number comes from the two
                ambient health signals the pane renders (git-sync + the search
                index). Zero unhealthy but still flagged → the old dot. */}
            <RailButton
              label="System" count={systemIssues} warn dot={systemUnhealthy}
              active={section === 'system'} onClick={() => pickSection('system')}
            />
            <RailButton
              label="All" count={counts.allTotal}
              active={section === 'all'} onClick={() => pickSection('all')}
            />
          </div>

          <div className="nfc-detail">
            {section === 'system' ? (
              /* Ambient health (daemons / backup / embedding search) — its own
                 component so the QMD poll only runs while this tab is showing. */
              <NotificationSystemPane qmdStatus={qmdStatus} />
            ) : groups.length === 0 ? (
              <div className="notification-feed-empty">{EMPTY_TEXT[section]}</div>
            ) : errorBlocks ? (
              /* Errors: one block per CATEGORY. The header is the whole point of
                 the grouping — it names the family and how many cards are in it,
                 so a rail of twenty reds becomes four readable problems. */
              <div className="notification-feed">
                {errorBlocks.map(block => (
                  <div key={block.category} className="nfc-cat-block">
                    {/* The header doubles as the drill-down: clicking a family in
                        the all-errors view filters to it (same move as its rail
                        sub-entry). Filtered, the header stops being a button and
                        gains "Show all" — the way back mirrors the way in. Same
                        two-family gate as the rail sub-entries: with one family
                        the all view IS the category view, so there is nothing to
                        drill into. */}
                    <div className="nfc-cat-header">
                      {activeErrorCategory || errorCats.length < 2 ? (
                        <span className="nfc-cat-name">{block.category}</span>
                      ) : (
                        <button
                          className="nfc-cat-name nfc-cat-drill"
                          title={`Show only ${block.category} errors`}
                          onClick={() => pickErrorCategory(block.category)}
                        >
                          {block.category}
                        </button>
                      )}
                      <span className="nfc-cat-count">{block.count}</span>
                      {activeErrorCategory && (
                        <button
                          className="nfc-cat-showall"
                          onClick={() => { userPickedSection.current = true; setErrorCategory(null); }}
                        >
                          Show all
                        </button>
                      )}
                    </div>
                    <FeedGroups
                      groups={block.groups}
                      expandedGroups={expandedGroups}
                      onToggleGroup={toggleGroup}
                      onNavigate={onNavigate}
                      onDismissKey={key => dismissFeed([key])}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="notification-feed">
                <FeedGroups
                  groups={groups}
                  expandedGroups={expandedGroups}
                  onToggleGroup={toggleGroup}
                  onNavigate={onNavigate}
                  onDismissKey={key => dismissFeed([key])}
                  showCategoryChip={section === 'all'}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

const EMPTY_TEXT: Record<NotificationSection, string> = {
  action: 'Nothing waiting on you',
  errors: 'No errors',
  automation: 'No automation activity',
  all: 'No notifications yet',
};

/**
 * A category sub-entry under the Errors section button. Same anatomy as
 * RailButton (name + count, aria-current when active) with the indent and
 * smaller type that read as "child of the entry above" — kept as its own
 * component so RailButton's props don't grow a `variant` flag for one caller.
 */
function RailSubButton({ label, count, active, onClick }: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`nfc-rail-btn nfc-rail-sub${active ? ' nfc-active' : ''}`}
      aria-current={active}
      onClick={onClick}
    >
      <span className="nfc-rail-name">{label}</span>
      {count > 0 && (
        <span className="nfc-rail-subcount">{count > 99 ? '99+' : count}</span>
      )}
    </button>
  );
}

function RailButton({ label, count, active, warn, dot, onClick }: {
  label: string;
  count: number;
  active: boolean;
  warn?: boolean;
  /** Countless attention marker (the System zone: health, not a list length). */
  dot?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`nfc-rail-btn${active ? ' nfc-active' : ''}`}
      aria-current={active}
      onClick={onClick}
    >
      <span className="nfc-rail-name">{label}</span>
      {count > 0 ? (
        <span className={`nfc-rail-badge${warn ? ' nfc-warn' : ''}`}>{count > 99 ? '99+' : count}</span>
      ) : dot ? (
        <span
          className={`nfc-rail-dot${warn ? ' nfc-warn' : ''}`}
          aria-label={`${label} needs attention`}
          role="img"
        />
      ) : null}
    </button>
  );
}

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

interface FeedGroup { key: string; items: Notification[] }

/** Partition a list into same-origin groups, preserving the caller's order. */
function collapseSameOrigin(items: Notification[]): FeedGroup[] {
  const byKey = new Map<string, Notification[]>();
  for (const n of items) {
    const key = groupKeyOf(n);
    const list = byKey.get(key);
    if (list) list.push(n);
    else byKey.set(key, [n]);
  }
  return [...byKey.entries()].map(([key, list]) => ({ key, items: list }));
}

/**
 * The card list for one set of same-origin groups.
 *
 * Extracted when Errors gained its category headers: the same list body is now
 * rendered once per category AND once flat for the other sections, and a second
 * copy of the collapse rules (the "a collapsed group must never bury a pending
 * ask" rule especially) would drift.
 */
function FeedGroups({
  groups, expandedGroups, onToggleGroup, onNavigate, onDismissKey, showCategoryChip,
}: {
  groups: FeedGroup[];
  expandedGroups: Set<string>;
  onToggleGroup: (key: string) => void;
  onNavigate: (to: string) => void;
  onDismissKey: (dedupKey: string) => void;
  /** All-section only: name the family on an error card, since there is no header. */
  showCategoryChip?: boolean;
}) {
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
                <PermissionCard
                  key={n.id}
                  n={n}
                  // Session links open on the HOME page's session columns
                  // (the primary surface), not the /sessions page.
                  onNavigate={onNavigate}
                  onDismiss={() => onDismissKey(n.dedupKey)}
                />
              ) : (
                <FeedItem
                  key={n.id}
                  n={n}
                  onNavigate={onNavigate}
                  onDismiss={() => onDismissKey(n.dedupKey)}
                  showCategoryChip={showCategoryChip}
                />
              )
            ))}
            {groupItems.length > 1 && (
              <button
                className="notification-group-toggle"
                onClick={() => onToggleGroup(key)}
              >
                {expanded ? 'Show less' : `Show ${groupItems.length - 1} more`}
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

/**
 * Rich permission card — the whole point of the redesign: decide here instead of
 * opening the session. Renders what is being asked from the server's compacted
 * tool input, then the buttons that actually answer it (ACP option list, an
 * AskUserQuestion answer form, or Approve/Deny).
 */
const PermissionCard = memo(function PermissionCard({ n, onNavigate, onDismiss }: {
  n: Notification;
  onNavigate: (to: string) => void;
  onDismiss: () => void;
}) {
  // 'sent' stamps the card optimistically instead of waiting for the
  // session:permission-resolved WS round-trip — a dropped WS would otherwise
  // leave the buttons pending forever. The WS event later stamps the feed entry
  // itself (idempotent). 'stale' is the THIRD outcome (see respond below).
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<'allowed' | 'denied' | 'stale' | null>(null);
  const [respondError, setRespondError] = useState(false);
  const [detailExpanded, setDetailExpanded] = useState(false);
  const resolved = n.resolved ?? sent;
  const detail = permissionDetail(n);
  const requestId = requestIdOf(n);
  const target = linkTargetOf(n);
  const acpOptions = validAcpOptions(n);
  const answerable = !resolved && !!n.sessionId && !!requestId;

  const respond = async (
    allow: boolean,
    opts?: { optionId?: string; answers?: Record<string, string>; message?: string },
  ) => {
    if (!n.sessionId || !requestId || busy) return;
    setBusy(true);
    setRespondError(false);
    try {
      await respondToPermission(n.sessionId, requestId, allow, opts?.message, opts?.optionId, opts?.answers);
      setSent(allow ? 'allowed' : 'denied');
    } catch (err) {
      // 404/409 = the request already settled elsewhere (answered in another
      // surface, or the turn died). Settle the card instead of re-arming buttons
      // the user would keep clicking (the zombie-card class of bug) — but as its
      // OWN state: stamping 'denied' claimed an outcome we never saw, so a request
      // the user had just APPROVED in the session view read "Denied" here.
      const status = (err as { status?: number }).status;
      if (status === 404 || status === 409) setSent('stale');
      else setRespondError(true);
      log.warn('notifications', 'inline permission respond failed', {
        sessionId: n.sessionId, requestId, status: String(status ?? ''), error: String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  // An AskUserQuestion whose questions we couldn't recover must NOT offer a
  // blanket Approve — the session view has the live request, send them there.
  const askWithoutInput = isUnanswerableAsk(n, detail);

  return (
    <div className={`notification-feed-item nfc-perm-card notification-feed-item--${n.severity}${n.read ? '' : ' unread'}`}>
      <div className="notification-feed-item-head">
        <span className={`notification-feed-dot notification-feed-dot--${n.severity}`} />
        <span className="notification-feed-item-title">{toolNameOf(n) ?? n.title}</span>
        {/* Click-through, on EVERY permission card that has a session — pending or
            settled. The card body stays inert (decision surface, see the class
            comment), so this small header link is the only way to get from a
            permission to the session it came from without hunting for the column.
            stopPropagation so it can never reach an Approve/option handler, and it
            deliberately does NOT dismiss or resolve the entry: only an actual
            decision settles a permission. The panel closes so the session column
            it navigated to is visible. */}
        {target && (
          <button
            className="nfc-open-session"
            title="Open the session this came from"
            onClick={(e) => { e.stopPropagation(); onNavigate(target); }}
          >
            Open session ↗
          </button>
        )}
        <span className="notification-feed-item-time">
          {formatRelative(effectiveTs(n))}
        </span>
        <button
          className="notification-feed-item-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss notification"
        >
          &times;
        </button>
      </div>

      <ContextChips n={n} />

      {/* What is being asked. */}
      {detail.type === 'bash' && (
        <>
          {detail.description && <div className="nfc-card-sub">{detail.description}</div>}
          <code
            className={`nfc-card-cmd${detailExpanded ? ' nfc-expanded' : ''}`}
            onClick={() => setDetailExpanded(v => !v)}
            title={detailExpanded ? 'Collapse' : 'Expand'}
          >
            {detail.command}
          </code>
        </>
      )}
      {detail.type === 'plan' && (
        <div className="nfc-card-plan">
          {/* No plan text (dropped over the size ceiling) → no expand toggle: a
              toggle that reveals nothing is a dead end, so just name the ask. */}
          {detail.plan ? (
            <>
              <button className="nfc-card-toggle" onClick={() => setDetailExpanded(v => !v)}>
                {detailExpanded ? '▼' : '▶'} Plan ready for review
              </button>
              {detailExpanded && <pre className="nfc-card-pre">{detail.plan}</pre>}
            </>
          ) : (
            <div className="nfc-card-sub">Plan ready for review</div>
          )}
        </div>
      )}
      {detail.type === 'file' && <div className="nfc-card-path">{detail.filePath}</div>}
      {detail.type === 'generic' && (
        /* The over-ceiling case: `preview` is the only thing left of the input, so
           render it — the degraded card otherwise showed nothing about the ask. */
        detail.preview ? (
          <code
            className={`nfc-card-cmd${detailExpanded ? ' nfc-expanded' : ''}`}
            onClick={() => setDetailExpanded(v => !v)}
            title={detailExpanded ? 'Collapse' : 'Expand'}
          >
            {detail.preview}
          </code>
        ) : n.body ? (
          <div className="notification-feed-item-body">{n.body}</div>
        ) : null
      )}
      {n.reason && <div className="nfc-card-sub">{n.reason}</div>}

      {resolved && (
        /* Labels live in resolvedLabelOf (kind-aware: 'expired' on a permission
           is "Session ended", on an error it is "Stale") so the panel and the
           toast can't drift apart. */
        <div className="notification-feed-item-resolved">{resolvedLabelOf(n)}</div>
      )}

      {/* The answer form / buttons. */}
      {detail.type === 'question' ? (
        <PermissionAnswerForm
          questions={detail.questions}
          disabled={!answerable || busy}
          resolved={!!resolved}
          onSubmit={(answers) => void respond(true, { answers })}
          onDismissQuestions={() => void respond(false, { message: 'User dismissed the questions' })}
        />
      ) : (!answerable || askWithoutInput) ? (
        /* Two reasons the card can't answer, ONE affordance: nothing to answer
           WITH (no session/requestId, or already settled), or an AskUserQuestion
           whose questions we couldn't recover — a blanket Approve there would
           tell the model the user answered nothing. */
        (!resolved && target) && (
          <div className="notification-feed-item-actions">
            <button className="notification-perm-btn" onClick={() => onNavigate(target)}>
              Go to Session
            </button>
          </div>
        )
      ) : acpOptions.length > 0 ? (
        <div className="notification-feed-item-actions">
          {acpOptions.map((o) => {
            const isReject = isRejectOption(o);
            return (
              <button
                key={o.optionId}
                className={`notification-perm-btn${isReject ? '' : ' approve'}`}
                disabled={busy}
                onClick={() => void respond(!isReject, { optionId: o.optionId })}
              >
                {o.name ?? o.optionId}
              </button>
            );
          })}
          {/* The adapter's own reject option may be absent — keep a plain Deny. */}
          {!acpOptions.some(isRejectOption) && (
            <button className="notification-perm-btn" disabled={busy} onClick={() => void respond(false)}>
              Deny
            </button>
          )}
        </div>
      ) : (
        <div className="notification-feed-item-actions">
          <button
            className="notification-perm-btn approve"
            disabled={busy}
            onClick={() => void respond(true)}
          >
            Approve
          </button>
          <button className="notification-perm-btn" disabled={busy} onClick={() => void respond(false)}>
            Deny
          </button>
        </div>
      )}
      {/* Gated on !resolved: a request that later settled (the user answered it in
          the session view, and session:permission-resolved stamped this entry) must
          not keep advertising an earlier failed attempt from this card. An incoming
          resolution always wins the display — `resolved` reads n.resolved FIRST. */}
      {!resolved && respondError && (
        <span className="notification-perm-error">Failed — open the session to respond</span>
      )}
    </div>
  );
});

/** Where the notification came from: session, host, project. */
function ContextChips({ n }: { n: Notification }) {
  const label = sessionLabelOf(n);
  if (!label && !n.host && !n.project) return null;
  return (
    <div className="nfc-card-chips">
      {label && <span className="nfc-chip">{label}</span>}
      {n.host && <span className="nfc-chip">{n.host}</span>}
      {n.project && <span className="nfc-chip">{n.project}</span>}
    </div>
  );
}

/** Error / automation card: title, body, ×N fold badge, deep-link chips. */
const FeedItem = memo(function FeedItem({ n, onNavigate, onDismiss, showCategoryChip }: {
  n: Notification;
  onNavigate: (to: string) => void;
  onDismiss: () => void;
  showCategoryChip?: boolean;
}) {
  // Entries without a navigation target (e.g. plugin/system errors) expand on
  // click instead — otherwise a truncated error message is simply unreadable.
  const [expanded, setExpanded] = useState(false);
  // The raw technical block, opened deliberately. Separate from `expanded`
  // (which unclamps the human body) so unclamping a long sentence doesn't dump
  // JSON on the user, and reading the JSON doesn't force the body open.
  const [detailOpen, setDetailOpen] = useState(false);
  const target = linkTargetOf(n);
  const count = n.count ?? 1;
  // Human title/body + the raw line for the toggle. `presentError` also repairs a
  // PRE-humanizer record at display time: its `[subsystem] {json}` body moves
  // into the Details block instead of being the card's only text.
  const presented = n.kind === 'operation-error'
    ? presentError(n)
    : { title: n.title, body: n.body ?? '', detail: undefined as string | undefined };
  const category = n.kind === 'operation-error' && showCategoryChip ? categoryOf(n) : null;
  // The condition this error described is gone (the plugin re-authenticated, the
  // disk was freed, the commit landed). The severity is already remapped to
  // 'info' server-side, so the red dot follows automatically — the chip is what
  // tells the user WHY the row went quiet instead of it just looking stale.
  const recovered = n.resolved === 'recovered';
  // 'expired' on an error is the OTHER end of the lifecycle: nothing can ever
  // recover it (its session died, or it predates recoveryKey), which reads as
  // "Stale" — deliberately not the green Recovered chip, because nobody fixed it.
  const stale = n.resolved === 'expired';

  return (
    <div
      className={`notification-feed-item notification-feed-item--${n.severity}${n.read ? '' : ' unread'}${target ? ' clickable' : ''}${expanded ? ' expanded' : ''}${recovered || stale ? ' recovered' : ''}`}
      onClick={target ? () => onNavigate(target) : () => setExpanded(v => !v)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (target) onNavigate(target);
          else setExpanded(v => !v);
        }
      }}
    >
      <div className="notification-feed-item-head">
        <span className={`notification-feed-dot notification-feed-dot--${n.severity}`} />
        <span className={`notification-feed-item-title${expanded ? ' expanded' : ''}`}>{presented.title}</span>
        {/* All-section only: the Errors rail has category HEADERS, so a chip
            there would repeat the header on every row. */}
        {category && <span className="nfc-chip nfc-chip-category">{category}</span>}
        {recovered && <span className="nfc-chip nfc-chip-recovered">{resolvedLabelOf(n)}</span>}
        {stale && <span className="nfc-chip">{resolvedLabelOf(n)}</span>}
        {/* Occurrence fold: the server collapses repeats into one record so 36
            identical failures are one line, with how often it happened. Clamped
            at 99+ like the rail badge — a 4-digit count would push the row's
            timestamp and dismiss button out of the card. */}
        {count >= 2 && <span className="nfc-count-badge">&times;{count > 99 ? '99+' : count}</span>}
        <span className="notification-feed-item-time">
          {formatRelative(effectiveTs(n))}
        </span>
        <button
          className="notification-feed-item-dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
          aria-label="Dismiss notification"
        >
          &times;
        </button>
      </div>
      {presented.body && (
        <div className={`notification-feed-item-body${expanded ? '' : ' clamped'}`}>{presented.body}</div>
      )}
      {/* The raw technical line, opt-in. This is where the old JSON-as-body went:
          a developer still gets every byte, and the user is no longer shown a log
          line as the card's message. stopPropagation because the card itself is a
          click target (navigate / expand) — without it, opening Details would
          also navigate away from the panel. */}
      {presented.detail && (
        <div className="nfc-card-detail">
          <button
            className="nfc-card-toggle"
            onClick={(e) => { e.stopPropagation(); setDetailOpen(v => !v); }}
            aria-expanded={detailOpen}
          >
            {detailOpen ? '▼' : '▶'} Details
          </button>
          {detailOpen && (
            <pre className="nfc-card-pre" onClick={(e) => e.stopPropagation()}>{presented.detail}</pre>
          )}
        </div>
      )}
      <ContextChips n={n} />
    </div>
  );
});
