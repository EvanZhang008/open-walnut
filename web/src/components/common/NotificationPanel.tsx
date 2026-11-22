/**
 * Notification panel — slide-out overlay from the sidebar, laid out as a
 * rail + detail pair (same shape as ViewDropdown's receipt body).
 *
 * The rail sorts the feed by WHAT THE USER HAS TO DO:
 *   Needs Action — what a session is asking live (a pending permission or
 *                  question), answerable right here. Never a letter.
 *   Inbox        — letters agents wrote to the human (read in the LetterReader),
 *                  decision letters included, with their buttons
 *   Errors       — operation errors (with the server's ×N occurrence folding),
 *                  led by what is broken right now (NotificationProblems)
 *   Automation   — cron / skill / hook receipts
 *   System       — long-running status (remote hosts, data backup, embedding
 *                  search); each host listed once
 *   All          — the whole feed, newest first, led by the same problems
 * A flat single list buried the one entry that blocks a session under twenty
 * receipts, which is why permissions used to need a session round-trip.
 *
 * Opening the panel marks the feed read — EXCEPT letters, whose read state is
 * owned by the letter store and set by actually reading one. Same-origin entries
 * (one cron job's runs, one session's permissions) still collapse into an
 * expandable group, and a collapsed group never hides a pending ask.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useSystemHealth } from '@/hooks/useSystemHealth';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { PhonePullToRefresh } from '@/components/tasks/PhonePullToRefresh';
import {
  useNotifications, sectionCounts, systemIssueCount, errorsBadgeCount,
  type NotificationSection,
} from '@/contexts/notifications';
import { FeedGroups } from './NotificationFeedCards';
import { NotificationErrorBlocks } from './NotificationErrorBlocks';
import { NotificationPanelHeader, RailButton, RailSubButton, type RailSection } from './NotificationRail';
import { NotificationSystemPane, useSearchIndexStatus, searchIndexUnhealthy } from './NotificationSystemPane';
import { updateAvailable, useUpdateStatus } from '@/hooks/useUpdateStatus';
import { NotificationProblems, useDisabledHosts, useProblemHosts } from './NotificationProblems';
import { useNotificationFeedView } from './useNotificationFeedView';
import { useNotificationLetters } from './useNotificationLetters';
import { HealthErrorsLink } from './HealthErrorsLink';
import { landingSectionFor } from '@/utils/host-attention';
import { useLocalDismissed } from '@/utils/host-banner-dismiss';
import { localNoticeIsFailure, localNoticeShows } from '@/utils/local-claude-banner';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { hasActiveModalOverlay } from '@/hooks/useModalOverlay';
import { navigateToTarget } from '@/utils/open-session';
import { useYieldsToTaskOpen } from '@/hooks/useOpenTask';
import { fetchSelfRepair, type SelfRepairInfo } from '@/api/config';
import { useShiftClickGuard } from './useShiftClickGuard';
import { InboxPane } from '@/components/inbox/InboxPane';
import { LetterReader } from '@/components/inbox/LetterReader';
import { ApprovalRows, usePendingApprovals } from '@/components/approvals/ApprovalRow';
import { EmptyState } from './EmptyState';

interface NotificationPanelProps {
  open: boolean;
  onClose: () => void;
  sidebarCollapsed: boolean;
}

export function NotificationPanel({ open, onClose: ownerClose, sidebarCollapsed }: NotificationPanelProps) {
  // Phone: the center is a full-screen layer (spec 4.7, C55). Back, Escape and
  // the backdrop close it through history; `onClose` below is that UI close.
  // A click-through closes the layer FIRST and navigates once its history entry
  // is gone, so the new page or session layer is never pushed above a ghost.
  const phone = usePhoneLayout();
  const ownerCloseRef = useRef(ownerClose);
  ownerCloseRef.current = ownerClose;
  const afterCloseRef = useRef<(() => void) | null>(null);
  const layer = usePhoneOverlay({
    id: 'notifications',
    kind: 'notifications',
    open,
    bar: { title: 'Notifications' },
    onClose: () => {
      ownerCloseRef.current();
      const next = afterCloseRef.current;
      afterCloseRef.current = null;
      if (next) setTimeout(next, 0);
    },
  });
  const onClose = layer.close;
  // A layer over Home: a task opened from inside it (a letter's task link, a card's pill) or
  // from anywhere else opens on Home, and the panel gives way (useOpenTask.ts).
  useYieldsToTaskOpen(onClose, open);
  const { hasIssues, health, loading: healthLoading } = useSystemHealth();
  // What is broken right now: it leads All and Errors, and counts on the Errors badge.
  const disabledHosts = useDisabledHosts(open);
  const allProblemHosts = useProblemHosts(health.daemons, disabledHosts);
  // The bell lists only the hosts the person must act on; Walnut reconnects the rest and
  // Walnut Health lists them (audience.ts).
  const problemHosts = useMemo(() => allProblemHosts.filter(p => p.needsYou), [allProblemHosts]);
  const healthHostCount = allProblemHosts.length - problemHosts.length;
  const localDismissed = useLocalDismissed();
  const localNotice = localNoticeShows(health, localDismissed, healthLoading);
  const localClaude = localNotice !== null;
  // Only a failure counts as an error: not installed or not signed in yet is a first-run step.
  const localClaudeFailing = localNotice !== null && localNoticeIsFailure(health, localNotice);
  const { feed, loaded, unreadCount, markAllRead, dismissFeed } = useNotifications();
  // A card that moved up under the pointer (the one above was answered) waits a beat before a click counts.
  const shiftGuard = useShiftClickGuard('.notification-feed-item');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [section, setSection] = useState<RailSection>('all');
  // Did the user pick a rail section themselves since this open? Once they have,
  // nothing may move them (see the re-choose effect below). Reset per open.
  const userPickedSection = useRef(false);
  // Landing section is chosen ONCE per open (not derived every render): a pending
  // ask answered while the panel is open must not yank the user back to an empty
  // Needs Action, and a new ask arriving must not steal the section they're reading.
  // Chosen DURING the render that opens the panel, so the first commit already
  // has it: an effect would paint the last open's section for one frame first.
  const [openSeen, setOpenSeen] = useState(false);
  if (openSeen !== open) {
    setOpenSeen(open);
    if (open) {
      userPickedSection.current = false;
      setSection(landingSectionFor(sectionCounts(feed).action));
    }
  }
  // Second-level filter inside Errors: null = every category (the landing view),
  // a string = just that family. Owned here (not in the section union) because it
  // is a refinement of one section, not a sibling of the others.
  const [errorCategory, setErrorCategory] = useState<string | null>(null);
  const navigate = useNavigate();
  const indexStatus = useSearchIndexStatus(open, section === 'system');
  // The shared live copy (read at app start, pushed over WS), read again on open: the
  // System rail wears a quiet accent dot (not the amber one) when a newer Open Walnut is published.
  const update = useUpdateStatus(open);
  const hasUpdate = updateAvailable(update.status);

  // Can an error card offer "Ask AI to fix" here? Fetched on open (the /api/config
  // read is memoized for the page lifetime), and absent by default so a cloud
  // replica or a git-less npm install never renders a button that can only fail.
  const [selfRepair, setSelfRepair] = useState<SelfRepairInfo | null>(null);
  useEffect(() => {
    if (!open) return;
    void fetchSelfRepair().then(setSelfRepair);
  }, [open]);
  const canFix = selfRepair?.available === true;
  // A repair session runs on Claude Code on this computer: while it is missing or signed
  // out, each card's Fix with agent reads the shared gate (useLocalAgentBlocked) and is not offered.
  // Available but no checkout yet → the first click clones upstream, which takes
  // minutes. The button says that while it runs instead of looking wedged.
  const fixNeedsClone = canFix && selfRepair?.source === null;

  // The Inbox's letters, its filter and layout, and the letter open in the reader.
  const letters = useNotificationLetters(open, section);
  const { inbox, inboxSplit, openLetterId, setOpenLetterId, linkOpened } = letters;
  // Escape belongs to the top-most layer: with the reader open, the panel must
  // not also close (both listeners sit on `document`, so stopPropagation in the
  // reader cannot help — the panel has to opt out itself).
  const readerOpenRef = useRef(false);
  readerOpenRef.current = !!openLetterId;

  // Counts read the LIVE letters, never the current view: with Archived open the
  // view holds only archived rows, which badged the Inbox 0.
  const counts = useMemo(() => sectionCounts(feed, inbox.liveLetters), [feed, inbox.liveLetters]);
  const approvals = usePendingApprovals();

  // The System zone's own health signal. `hasIssues` is useSystemHealth's own
  // derivation (git-sync unprotected or failing) — the same one the Sidebar's
  // status pill reads; the index error state is the other thing shown in there
  // that can be broken. Hosts and Claude Code are errors (the Errors badge).
  const systemUnhealthy = hasIssues || searchIndexUnhealthy(indexStatus);
  // …and how MANY of them are broken, for the rail badge (the derivation is in
  // the model so it is testable and can't drift from the flags above).
  const systemIssues = systemIssueCount({
    gitSyncFailing: hasIssues,
    indexUnhealthy: searchIndexUnhealthy(indexStatus),
  });

  // What the active section lists, its error families and causes, and what Clear dismisses.
  const { hostCards, groups, errorCats, activeErrorCategory, errorCauses, errorBlocks, clearKeys } = useNotificationFeedView({
    feed, section, errorCategory, problemHosts,
  });

  // Opening the panel clears the unread badge (everything in the feed is now seen).
  // Re-fires while open if new persistent events arrive (unreadCount climbs again) —
  // intentional: items seen while watching the panel should be marked read too.
  useEffect(() => {
    if (open && unreadCount > 0) markAllRead();
  }, [open, unreadCount, markAllRead]);

  const pickSection = useCallback((next: RailSection) => {
    userPickedSection.current = true;
    if (inboxSplit && next !== 'inbox') setOpenLetterId(null);
    setSection(next);
    // Entering Errors through the SECTION button always lands on every category
    // ("all" is the natural landing); a specific family is only reached through
    // its own sub-entry (pickErrorCategory below).
    setErrorCategory(null);
  }, [inboxSplit]);

  const pickErrorCategory = useCallback((category: string) => {
    userPickedSection.current = true;
    if (inboxSplit) setOpenLetterId(null);
    setSection('errors');
    setErrorCategory(category);
  }, [inboxSplit]);

  useEffect(() => {
    if (open) setErrorCategory(null);
  }, [open]);

  // …but on the FIRST open the initial GET may still be in flight, so the feed is
  // empty-so-far and the choice above lands on All even with pending permissions
  // waiting. Re-choose exactly once when the load finishes — unless the user has
  // already clicked a section, in which case their choice wins.
  useEffect(() => {
    if (!open || !loaded || userPickedSection.current) return;
    setSection(landingSectionFor(sectionCounts(feed).action));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loaded-transition only
  }, [open, loaded]);

  // The dialog contract (focus in, Tab kept inside, back to the bell on close).
  const [panelEl, setPanelEl] = useState<HTMLDivElement | null>(null);
  useDialogFocus(open ? panelEl : null, 'Notifications');
  // A phone's rail is one sideways strip: the selected section is scrolled into
  // view, or a center opening on All (the strip's last entry) showed no
  // selected tab at all (N9).
  // Measured from the two boxes (offsets were read against the panel, not the
  // strip, and missed), and again while the opening panel settles: the strip
  // is not scrollable yet while it slides in and its counts load.
  useEffect(() => {
    if (!phone || !open || !panelEl) return undefined;
    const reveal = () => {
      const active = panelEl.querySelector<HTMLElement>('.nfc-rail-btn[aria-current="page"]');
      const rail = active?.closest<HTMLElement>('.nfc-rail');
      if (!active || !rail) return;
      const a = active.getBoundingClientRect();
      const r = rail.getBoundingClientRect();
      if (a.left < r.left || a.right > r.right) rail.scrollLeft += a.left - r.left - (r.width - a.width) / 2;
    };
    const raf = requestAnimationFrame(reveal);
    const timers = [120, 360, 900].map((ms) => setTimeout(reveal, ms));
    return () => { cancelAnimationFrame(raf); timers.forEach(clearTimeout); };
  }, [phone, open, panelEl, section, feed.length]);

  // The scrim starts at the panel's right edge (its width depends on the sidebar and on Split),
  // so the page beside it reads as behind the panel and the sidebar stays as it is.
  const [backdropEl, setBackdropEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!panelEl || !backdropEl) return undefined;
    // Layout box, not the client rect: the slide-in transform must not move the scrim's edge.
    const place = () => backdropEl.style.setProperty('--nfc-scrim-left', `${panelEl.offsetLeft + panelEl.offsetWidth}px`);
    place();
    const ro = new ResizeObserver(place);
    ro.observe(panelEl);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  }, [panelEl, backdropEl]);

  // Escape closes, same idiom as Lightbox/FileViewer: the panel is a portalled
  // overlay, so there is no ancestor to catch the key — it has to be on document.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // A modal opened from a notice owns the first Escape, regardless of listener order.
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || hasActiveModalOverlay()) return;
      if (e.key === 'Escape' && !readerOpenRef.current) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const onNavigate = useCallback((to: string) => {
    if (phone) {
      afterCloseRef.current = () => navigateToTarget(to, navigate);
      onClose();
      return;
    }
    navigateToTarget(to, navigate);
    onClose();
  }, [navigate, onClose, phone]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  if (!open) return null;

  // What every list's cards share: the group state, the way out, and the fix gate.
  const cardProps = {
    expandedGroups, onToggleGroup: toggleGroup, onNavigate, onDismissKey: (key: string) => dismissFeed([key]), canFix, fixNeedsClone,
  };
  // The problems lead All and the all-errors view (never a drilled-in family,
  // which is the list the user asked for); each host's cards sit under its row.
  const problemsHere = (section === 'all' || (section === 'errors' && !activeErrorCategory))
    && (problemHosts.length > 0 || localClaude);
  const problems = problemsHere ? (
    <NotificationProblems
      hosts={problemHosts}
      health={health}
      healthLoading={healthLoading}
      onLeave={onClose}
      onNavigate={onNavigate}
      renderHostCards={(alias) => {
        const cards = hostCards.get(alias);
        return cards?.length ? (
          <FeedGroups groups={[{ key: `host:${alias}`, items: cards }]} showCategoryChip {...cardProps} />
        ) : null;
      }}
    />
  ) : null;

  const letterReader = openLetterId && <LetterReader
    letterId={openLetterId}
    {...(inbox.byId.get(openLetterId) ? { envelope: inbox.byId.get(openLetterId) } : {})}
    embedded={inboxSplit}
    onClose={() => {
      setOpenLetterId(null);
      if (linkOpened.current) { linkOpened.current = false; onClose(); }
    }}
    onLetterUpdated={inbox.mergeLetter}
    onMarkRead={letters.markLetterRead}
    onTogglePin={letters.toggleLetterPin}
    onToggleArchive={letters.toggleLetterArchive}
    onNavigate={onNavigate}
  />;

  // Portal to <body>: the panel is mounted inside the Sidebar, whose mobile
  // styles apply a transform — that turns the sidebar into the containing
  // block for position:fixed, dragging the "fixed" panel off-screen with the
  // slide animation. Rendering at the body level keeps fixed truly viewport-fixed.
  return createPortal(
    <>
      {/* Backdrop: a click outside closes; a light scrim over the page right of the panel. */}
      <div ref={setBackdropEl} className="notification-panel-backdrop" onClick={onClose} data-testid="notification-panel-backdrop" />

      {/* Panel */}
      <div
        ref={setPanelEl}
        className={`notification-panel nfc-panel-wide${sidebarCollapsed ? ' sidebar-collapsed' : ''}${inboxSplit ? ' nfc-panel-inbox-split' : ''}`}
      >
        <NotificationPanelHeader
          section={section}
          category={section === 'errors' ? activeErrorCategory : null}
          canClear={clearKeys.length > 0}
          onClear={() => { dismissFeed(clearKeys); setExpandedGroups(new Set()); }}
          onClose={onClose}
        />

        <PhonePullToRefresh
          enabled={phone && open}
          getScroller={() => panelEl?.querySelector<HTMLElement>('.nfc-detail') ?? panelEl}
          testId="phone-pull-notifications"
        />
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
              label="Needs you" count={counts.action + approvals.length} tone="alert"
              active={section === 'action'} onClick={() => pickSection('action')}
            />
            {/* Inbox shows UNREAD letters (not the list length): a letter is read
                one at a time, so "how many are still unread" is the number that
                means something here. Unread letters wait on the person, as the bell's
                count says: the same red needs-you count. */}
            <RailButton
              label="Inbox" count={counts.inbox} tone="alert"
              active={section === 'inbox'} onClick={() => pickSection('inbox')}
            />
            {/* Every LISTING section carries a badge showing what the tab LISTS
                (not just what is unread): a rail where only Needs Action had a
                number left the user unable to see that nine errors were sitting
                one click away, because opening the panel marks everything read.
                One `.badge-count` for all of them, toned by what it counts: the
                solid red needs-you count (Needs you, Inbox) as on the bell and
                Mail, Errors red, an unhealthy System amber, a plain total
                (Automation's receipts) grey. */}
            {/* Errors counts what the view leads with too: each problem host
                and this machine's Claude Code, once each. */}
            <RailButton
              label="Errors"
              count={errorsBadgeCount({ feedErrors: counts.errorsTotal, problemHosts: problemHosts.length, localClaude: localClaudeFailing })}
              tone="error"
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
            {/* System has no feed entries, so its number comes from what the
                pane renders as wrong (git sync, the search index). Zero but
                still flagged → the old dot. */}
            <RailButton
              label="System" count={systemIssues} tone={systemUnhealthy ? 'warning' : 'neutral'} warn={systemUnhealthy} dot={systemUnhealthy || hasUpdate}
              active={section === 'system'} onClick={() => pickSection('system')}
            />
            {/* All is the whole feed — its length is history depth, not a
                signal, and "99+" forever read as a problem. No badge. */}
            <RailButton
              label="All" count={0}
              active={section === 'all'} onClick={() => pickSection('all')}
            />
          </div>

          <div className="nfc-detail">
            {/* Walnut's own errors are not the person's: one line says where they are. */}
            {section === 'errors' && !activeErrorCategory && <HealthErrorsLink onNavigate={onNavigate} hosts={healthHostCount} />}
            {/* A script waiting on an approval needs the person too: the same one line as
                Home's Needs you, a click opens the request (ApprovalRow). */}
            {(section === 'action' || section === 'all') && approvals.length > 0 && (
              <div className="nfc-approvals"><ApprovalRows list={approvals} variant="home" /></div>
            )}
            {section === 'system' ? (
              /* Long-running status (hosts, backup, embedding search): its own
                 component so the search-index poll only runs while this tab is
                 showing. */
              <NotificationSystemPane indexStatus={indexStatus} disabled={disabledHosts} onLeave={onClose} onNavigate={onNavigate} />
            ) : section === 'inbox' ? (
              <InboxPane
                layout={letters.inboxLayout}
                onLayoutChange={letters.changeInboxLayout}
                selectedId={openLetterId}
                reader={letterReader}
                letters={letters.inboxRows}
                loaded={inbox.loaded}
                error={inbox.error}
                showArchived={letters.showArchived}
                onToggleArchived={letters.toggleArchived}
                unreadOnly={letters.unreadOnly}
                onToggleUnreadOnly={letters.toggleUnreadOnly}
                onOpen={letters.openLetter}
                onNavigate={onNavigate}
                onTogglePin={letters.toggleLetterPin}
                onToggleArchive={letters.toggleLetterArchive}
                onToggleRead={(l) => letters.markLetterRead(l.id, !l.read)}
              />
            ) : groups.length === 0 && !problems ? (
              (section === 'action' || section === 'all') && approvals.length > 0 ? null : <EmptyState size="pane" testId="notification-feed-empty" title={EMPTY_STATE[section].title} />
            ) : errorBlocks ? (
              /* Errors: one block per root cause, then one per family (NotificationErrorBlocks). */
              <div ref={shiftGuard.ref} onClickCapture={shiftGuard.onClickCapture} className="notification-feed">
                {problems}
                <NotificationErrorBlocks
                  causes={errorCauses?.causes}
                  blocks={errorBlocks}
                  activeCategory={activeErrorCategory}
                  drillable={errorCats.length >= 2}
                  onPickCategory={pickErrorCategory}
                  onShowAll={() => { userPickedSection.current = true; setErrorCategory(null); }}
                  cardProps={cardProps}
                />
              </div>
            ) : (
              <div ref={shiftGuard.ref} onClickCapture={shiftGuard.onClickCapture} className="notification-feed">
                {problems}
                <FeedGroups groups={groups} onOpenLetter={letters.openLetter} showCategoryChip={section === 'all'} {...cardProps} />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Split hosts this same reader in its right column; every other entry uses the overlay. */}
      {!inboxSplit && letterReader}
    </>,
    document.body,
  );
}

const EMPTY_STATE: Record<NotificationSection, { title: string }> = {
  action: { title: 'No session is asking you anything' },
  inbox: { title: 'No letters yet' },
  errors: { title: 'No errors' },
  automation: { title: 'No automation activity' },
  all: { title: 'No notifications yet' },
};
