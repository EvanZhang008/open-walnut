/**
 * The Org page's right side: the selected node (Main, or a project's lead).
 *
 *   header   one row on the avatar's centre line (2026-11-23, the user picked design 4 of the header
 *            round): who it is, its counts as round quiet keys (each opens its tab); on the right the
 *            chat's labels (Trigger, VP · 50), its kebab and the side bar's switch (dotted while it is
 *            closed and has news). The kebab holds Watch, Locate, Minimize and the Tags list ("just move
 *            all these to the drop done"), then Changed, Files, Terminal and Board. A narrow column puts
 *            the counts on a line under the name. The chat draws no header of its own here
 *            (SessionPanel headerSlot).
 *   chat     its own session (SessionPanel), always on screen; or a way to start one
 *   side bar beside the chat on a wide page, above it on a narrow one (OrgTaskRail): Tasks (by status,
 *            by team, or as the Board its lead keeps), Brief and Threads; it widens beside the chat
 *            and closes, and never takes the chat's place
 *   A row no one answers for yet (none on a current server: a project of one team talks to it,
 *            one of more makes its VP on first contact, the Inbox too) shows its teams instead.
 *   A router (row kind 'router', OrgRouterSettings) is its own node, not a VP: its header has a folded
 *            settings section of its own under it, and it has no side bar, so no Tasks (it owns no
 *            team and never sees the Inbox's tasks), no Brief and no Threads. A VP gets none of it.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { usePendingApprovals } from '@/components/approvals/ApprovalRow';
import { approvalsForNode } from '@/components/approvals/approvals-store';
import { readOrgPlace, writeOrgPlace } from './org-place';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { useExperimental } from '@/hooks/useExperimental';
import { oneOf } from '@/hooks/usePersistentState';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { yieldFullscreen } from '@/hooks/useFullscreen';
import { useOpenTask } from '@/hooks/useOpenTask';
import type { Task } from '@open-walnut/core';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { threadFocusAsk, topShows, useThreadFocusTick } from './thread-focus';
import { ReplyThreadContext, type ReplyThreadHost } from '@/components/sessions/reply-thread-line';
import { OrgPaneHandle } from './OrgPaneHandle';
import { TaskBoardPane } from '@/components/board/TaskBoardPane';
import { LiveActivityLine } from '@/components/board/LiveActivityLine';
import { useFirstLiveTask } from '@/stores/live-activity-store';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useOrgThreads } from './useOrgThreads';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import { ORG_TASK_MODES, OrgTaskRail, TAB_DOT, type OrgAnswers, type OrgTaskMode } from './OrgTaskRail';
import '@/styles/header-fit.css';
import { askWords } from './org-ask-form';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { recentMainStart } from './ask-main';
import { OrgNodeStart } from './OrgNodeStart';
import { OrgRouterSettings, routerLinkRows } from './OrgRouterSettings';
import { OrgRouterOverview, routerEmptyChatLine, selfRouterLine } from './OrgRouterOverview';
import { useRouterAreaNames } from './router-area-names';
import { OrgRouterFromMail } from './OrgRouterFromMail';
import { OrgAvatar } from './OrgAvatar';
import { useHasBoard } from './useBoardOwner';
import { flashProbeEnabled } from '@/utils/flash-probe';
import { log } from '@/utils/log';
import { ORG_TOP_DEFAULT, ORG_TOP_VIEWS, briefUnread, markBriefSeen, markThreadsSeen, readBriefFolded, seenVersion, subscribeSeen, threadsUnread, type OrgTopView } from './org-brief-model';
import { newsAt, sharedAnswers, threadCountLabel, type ThreadCounts } from '@open-walnut/thread-view';
import { threadCounts } from '@open-walnut/thread-groups';
import { briefUpdating } from '@open-walnut/brief-fresh';
import { useBriefRefresh } from './useBriefRefresh';
import { ORG_TASK_TAB_LABELS, allTasksSections, headerPillWords, headerPills, isSectionFlips, nodeKeepsThreads, orgTaskTabs, ownAskFirst, sectionFor, sectionOpen, type OrgRailTab, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import type { ImageAttachment } from '@/api/chat';
import {
  areaIdWords, mainTeamColumns, teamColumns, type ChannelRow, type OrgAlertView, type TeamColumn,
} from './org-channels-model';
import { EmptyState } from '@/components/common/EmptyState';

export type OrgTab = 'board' | 'team' | 'chat';

/** The node's width from which the rail sits beside the chat: a chat of about 520px beside it. */
export const RAIL_SIDE_MIN_WIDTH = 880;
/** The side rail's room: never narrower than this, and the chat beside it never narrower than that. */
export const RAIL_MIN_PX = 300;
export const CHAT_MIN_PX = 420;
/** Its width when the user never set one: about a third of a 1280px window's node. */
export const RAIL_DEFAULT_VW = 27;
/** The rail's width the user set, per surface (the CEO's, a VP's), as % of the window: an
 *  `open-walnut-` key, so it follows them to every window and device (ui-prefs-sync.ts). */
export const railWidthKey = (kind: ChannelRow['kind']) => `open-walnut-org-rail-w-${kind === 'main' ? 'main' : 'vp'}`;

export type { OrgAnswers };

interface Props {
  row: ChannelRow;
  rows: readonly ChannelRow[];
  tasks: readonly Task[];
  /** A view the URL asked for (a link, a row's menu): Team or Board opens the side bar's Tasks on it. */
  initialTab: OrgTab | null;
  /** That view was opened: the URL lets go of it, so the node keeps the view it is left on. */
  onTabUsed: (key: string) => void;
  onSelect: (key: string) => void;
  /** A letter another task wrote: its Answer, on that task's session Inbox tab (OrgPage). A letter,
   *  not a task reference: a task reference opens beside the page (useOpenTask). */
  onOpenLetterOf: (taskId: string) => void;
  /** Open a session a chat names: the page's side panel. */
  onOpenSession: (sessionId: string) => void;
  /** Asks answered from their rows (the page's holds, OrgPage). */
  answers: OrgAnswers;
  /** Start this node, which has no session yet, in place (Retry, Make a VP). */
  onStartChat: (row: ChannelRow) => void;
  /** The task list is still loading: a node with no session yet may only not be known yet. */
  tasksLoading?: boolean;
  /** Phone: back to the list. */
  onBack?: () => void;
  now: number;
}

/** What the side bar of a node that keeps Threads holds, in words. */
const railParts = (briefOff: boolean): string => (briefOff ? 'Tasks and Threads' : 'Tasks, Brief and Threads');

/** The quote Quote puts in the chat: which task, and what it asks. */
export const alertQuote = (a: OrgAlertView): string => `> ${a.title}: ${askWords(a)}\n\n`;

const COLUMN_DOT: Record<TeamColumn['key'], string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)',
};

/** The header's counts: the user's status of the node's work in the Board's words, made by
 *  `headerPills` from the same tabs as the side bar's sections; each pill opens its tab, and no
 *  "N open" (2026-11-03, the user: "remove xx open not needed also show thread and number").
 *  `keepsThreads` (the CEO, a VP, `nodeKeepsThreads`): its threads first, always, "0 threads" too,
 *  and no Needs you of its own (2026-11-03, the user: "the little red should be thread instead of need
 *  u ... even if no thread, show 0 thread"); its tasks' asks are in its Tasks. The threads pill counts
 *  the threads for him (Needs you and Done, thread-groups.ts threadsForHim), its red dot only while
 *  there is one; the pills after it count its tasks in his words ("51 working", "22 waiting":
 *  headerPillWords), no dot or icon of their own, except the red of a Needs you. Round quiet keys
 *  (.btn-round), the user's pick of the header's layouts (2026-11-23, design 4). */
function CountPills({ tabs, onOpen, approvals, keepsThreads, threads, onThreads }: { tabs: OrgTaskTabs; onOpen: (tab: OrgTaskTab) => void; approvals: number; keepsThreads: boolean; threads?: ThreadCounts; onThreads?: () => void }) {
  const shown = threads?.shown ?? 0;
  const pill = (tab: OrgTaskTab, n: number) => (
    <button key={tab} type="button" className="btn btn-round" data-testid={`org-pill-${tab}`} onClick={() => onOpen(tab)} title={`Show ${ORG_TASK_TAB_LABELS[tab]}`}>
      {tab === 'needs' && <i style={{ background: TAB_DOT.needs }} />}{headerPillWords(tab, n)}
    </button>
  );
  return (
    <span className="org-pills" data-testid="org-detail-counts">
      {keepsThreads && (
        <button
          type="button"
          className="btn btn-round"
          data-testid="org-pill-threads"
          data-threads={shown}
          onClick={onThreads}
          title={shown ? `${threadCountLabel(shown)} for you${threads?.title ? `: ${threads.title}` : ''}` : 'Show Threads'}
        >
          {shown > 0 && <i style={{ background: TAB_DOT.needs }} />}{threadCountLabel(shown)}
        </button>
      )}
      {headerPills(tabs, approvals, keepsThreads).map((p) => pill(p.tab, p.n))}
    </span>
  );
}

/** The live action of the team's first running task (core/live-activity.ts), named when it is a worker. */
function TeamLiveLine({ live }: { live: NonNullable<TeamColumn['items'][number]['live']> }) {
  const ids = useMemo(() => live.map((l) => l.id), [live]);
  const id = useFirstLiveTask(ids);
  if (!id) return null;
  const prefix = live.find((l) => l.id === id)?.title;
  return <LiveActivityLine taskId={id} className="org-team-live" {...(prefix ? { prefix } : {})} />;
}

function TeamBoard({ columns, onPick, emptyText }: {
  columns: TeamColumn[];
  onPick: (item: TeamColumn['items'][number]) => void;
  emptyText: string;
}) {
  if (!columns.length) return <EmptyState size="section" title={emptyText} testId="org-team-empty" />;
  return (
    <div className="org-team" data-testid="org-team">
      {columns.map((c) => (
        <section key={c.key} className="org-team-col" data-testid="org-team-col" data-column={c.key}>
          <h3 className="org-team-head"><i style={{ background: COLUMN_DOT[c.key] }} />{c.label}<span className="org-team-count">{c.items.length}</span></h3>
          <ul className="org-team-list">
            {c.items.map((it) => (
              <li key={it.id}>
                <button type="button" className="org-team-item" data-testid="org-team-item" data-peek-row="" data-task-id={it.id} onClick={() => onPick(it)} title={it.title}>
                  <span className="org-team-ring" style={{ borderColor: COLUMN_DOT[c.key] }} aria-hidden="true" />
                  <span className="org-team-text">
                    <span className="org-team-title wn-title">{it.title}</span>
                    {it.live && <TeamLiveLine live={it.live} />}
                    {it.note && <span className="org-team-note wn-meta" data-testid="org-team-note">{it.note}</span>}
                  </span>
                  {it.workers > 0 && <span className="org-team-meta" title={`${it.workers} more under it`}>{it.workers}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function OrgNodeDetail({ row, rows, tasks, initialTab, onTabUsed, onSelect: selectRow, onOpenLetterOf, onOpenSession, answers, onStartChat, tasksLoading, onBack, now }: Props) {
  // What opens instead of this node or beside it (another node, a letter's panel, the chat this
  // fills) lies under a full-screen sheet, its side bar's or its chat's: leave it first, as a home
  // column does (useFullscreen's COLUMN-OPEN EXIT), or the click reads as nothing happened. A task
  // clicked on the page opens beside it (useOpenTask -> OrgPage's openTaskOnOrg, which yields it).
  const onSelect = (key: string) => { yieldFullscreen('org-select-node'); selectRow(key); };
  const openLetter = (taskId: string) => { yieldFullscreen('org-open-letter'); onOpenLetterOf(taskId); };
  const openTask = useOpenTask();
  const contact = useMemo(() => (row.contactId ? tasks.find((t) => t.id === row.contactId) : undefined), [tasks, row.contactId]);
  // Temporary (utils/flash-probe.ts): a remount of the node's detail is one cause of a flash.
  useEffect(() => { if (flashProbeEnabled()) log.info('flash-probe', 'org detail mounted', { node: row.key }); }, [row.key]);
  // A Main started a moment ago by a quick action: its session before the store has it.
  const launch = row.kind === 'main' ? recentMainStart(row.contactId) : null;
  const sessionId = (contact ? resolveTaskSessionId(contact) : null) ?? launch?.sessionId ?? null;
  // A router is its own node: no team, no Board, no Brief, no Threads, no side bar (OrgRouterSettings).
  const isRouter = row.kind === 'router';
  const routerTask = isRouter && contact?.org_role === 'router' ? contact : undefined;
  // A task that routes by itself (Task.self_router): its own chat, with one line on what it is.
  const selfRouterTask = isRouter && contact && !contact.org_role && contact.self_router ? contact : undefined;
  const selfRouterLinks = useMemo(
    () => (selfRouterTask ? routerLinkRows(selfRouterTask.self_router?.links ?? [], tasks).filter((r) => r.state === 'open').map((r) => r.name) : []),
    [selfRouterTask, tasks],
  );
  const hasBoard = useHasBoard(isRouter ? undefined : row.contactId);
  // A router's chat is empty until mail of its area reaches it: say so instead of "No conversation
  // history found" (memoized: SessionChatHistory is memo'd and compares the element by identity).
  const routerLinkNames = useMemo(
    () => (routerTask ? routerLinkRows(routerTask.router_links ?? [], tasks).filter((r) => r.state === 'open').map((r) => r.name) : []),
    [routerTask, tasks],
  );
  // Keyed on primitives: routerTask is a new object on every task update, and the chat is memo'd.
  const isRouterNode = !!routerTask;
  const routerAreaId = routerTask?.router_area_id || '';
  const routerAreaNames = useRouterAreaNames(routerAreaId ? [routerAreaId] : []);
  const routerAreaLabel = routerAreaId ? (routerAreaNames[routerAreaId] || areaIdWords(routerAreaId)) : 'its area';
  // A string: the chat draws it as its own pane state (title, then hint).
  const routerEmptyChat = isRouterNode ? routerEmptyChatLine(routerAreaLabel) : undefined;
  const columns = useMemo(
    () => (row.kind === 'main' ? mainTeamColumns(rows) : isRouter ? [] : teamColumns(row, tasks)),
    [row, rows, tasks, isRouter],
  );
  /** The chat's Inbox tab, asked for by Answer on a letter (SessionPanel inboxRequest), for the
   *  session it was asked of: a replaced session's new panel does not reopen it. */
  const [chatInbox, setChatInbox] = useState<{ sid: string; n: number } | null>(null);
  /** Above the chat: Task (Latest and the tasks by status), the Brief its lead or Main keeps
   *  (OrgBrief), or Threads. Task first (2026-10-30, the user, translated: "by default it shows this status");
   *  after that each node opens on the view it was left on (2026-11-01: "If I was in Threads it puts me back
   *  in Task"), kept per node (utils/view-memory.ts). */
  // 'node.view', not the 'node.top' the old order kept: a pick made while Task came first and was the
  // default is not read as one, so every node opens on Threads once after the change, then on its pick.
  const [topPick, setTopPick] = usePageViewOf<OrgTopView>('org', 'node.view', row.key, ORG_TOP_DEFAULT, oneOf(ORG_TOP_VIEWS));
  const [briefFolded, setBriefFolded] = useState(readBriefFolded);
  // Main and a lead keep a Brief and Threads. The row says so too, before the node's own task has
  // loaded (a reload paints from the cache first), so a reload does not show Task for a moment
  // before the view it was left on.
  // By what the node is, never whether its task exists yet: a CEO not started reads as it will once
  // it runs, so its header never flips from Needs you to its threads on start (nodeKeepsThreads).
  const keepsBrief = nodeKeepsThreads(row, contact);
  // The Brief is off (core/org/brief-off.ts): Threads by state take its place; a node left on the
  // Brief opens on Threads, and nothing reads or refreshes the letter.
  const briefOff = useExperimental('brief_off');
  const showsBrief = keepsBrief && !briefOff;
  const topView: OrgTopView = keepsBrief ? (briefOff && topPick === 'brief' ? 'threads' : topPick) : 'task';
  /** All tasks or the Board (2026-11-12, the user: "under tasks, just show all taks, and then board").
   *  A node an older build left on Status or Team reads neither and opens on All tasks. */
  const [taskMode, setTaskMode] = usePageViewOf<OrgTaskMode>('org', 'node.taskMode', row.key, 'all', oneOf(ORG_TASK_MODES));
  /** The All tasks sections folded or opened against their default, per node. Kept under a new name
   *  since Working folds by default (2026-11-23): a flip kept against the old default would now open
   *  Working, so every node starts again from the new default (only Needs you and Watching open). */
  const [flipped, setFlipped] = usePageViewOf<string[]>('org', 'node.sectionFlips2', row.key, [], isSectionFlips);
  const flipSection = (t: OrgRailTab) => setFlipped((f) => (f.includes(t) ? f.filter((x) => x !== t) : [...f, t]));
  const [focusSection, setFocusSection] = useState<{ tab: OrgRailTab; n: number } | null>(null);
  const tabs = useMemo(() => orgTaskTabs(row, rows, tasks, now), [row, rows, tasks, now]);
  /** A count in the header: All tasks, with that section open and brought into view (its tasks may
   *  all be watched, then Watching; a section not drawn is never flipped). */
  const openTab = (t: OrgTaskTab) => {
    setRailHidden(false); setTopPick('task'); setTaskMode('all');
    const to = sectionFor(t, allTasksSections(tabs, alertsShown, approvals.length));
    if (!to) return;
    if (!sectionOpen(to, flipped)) flipSection(to);
    setFocusSection({ tab: to, n: Date.now() });
  };
  const brief = showsBrief ? contact?.brief : undefined;
  const pickTop = (v: OrgTopView) => setTopPick(v);
  /** The panel above or beside the chat (Task, Brief, Threads) closed: the chat takes its room;
   *  kept per node (2026-11-02, the user: "it is a panel too, you can at least let me close it"). */
  const [railKeptHidden, setRailHidden] = usePageViewOf<boolean>('org', 'node.railHidden', row.key, false, isBoolean);
  const railHidden = isRouter || railKeptHidden;
  // Read while shown: the dot on the Brief tab is for a rewrite the user has not seen. A read in
  // another window of this browser takes the dot off here too, at once (org-brief-model.ts).
  useSyncExternalStore(subscribeSeen, seenVersion, seenVersion);
  useEffect(() => { if (!railHidden && topView === 'brief' && contact && brief?.at) markBriefSeen(contact.id, brief.at); }, [railHidden, topView, contact, brief?.at]);
  const briefNew = showsBrief && (railHidden || topView !== 'brief') && !!contact && briefUnread(contact.id, brief?.at);
  // Opening a node whose Brief is stale asks it for one refresh turn (core/sessions/brief-refresh.ts).
  const briefFresh = useBriefRefresh(showsBrief ? contact : undefined, tasks);
  const updating = showsBrief && !!contact && briefUpdating(contact, now);
  const title = row.kind === 'main' ? 'CEO' : isRouter ? row.name : row.contactTitle;
  // Main is always someone to talk to: its task is made by the first chat.
  const canTalk = row.kind === 'main' || !!row.contactId || !!row.node?.needsLead;
  // The chat is always there (2026-11-02, the user: the side bar "can expand to more but not like a
  // individual page"); a row no one answers for shows its teams instead.
  const shown: 'chat' | 'team' = canTalk ? 'chat' : 'team';
  // Those teams come back scrolled where they were (org-place.ts).
  const bodyRef = useRef<HTMLDivElement>(null);
  const teamShown = shown === 'team';
  useLayoutEffect(() => {
    const el = bodyRef.current;
    const saved = readOrgPlace().team;
    if (teamShown && el && saved?.key === row.key && saved.top) el.scrollTop = saved.top;
  }, [teamShown, row.key]);
  const teamSave = useRef<number | null>(null);
  const onBodyScroll = () => {
    if (!teamShown || teamSave.current !== null) return;
    teamSave.current = window.setTimeout(() => {
      teamSave.current = null;
      if (bodyRef.current) writeOrgPlace({ team: { key: row.key, top: Math.round(bodyRef.current.scrollTop) } });
    }, 200);
  };
  /** The side bar on Tasks, drawn by `mode` (the Board: the one its lead keeps). */
  const openTasks = (mode: OrgTaskMode) => { setRailHidden(false); setTopPick('task'); setTaskMode(mode === 'board' && hasBoard === false ? 'all' : mode); };
  // A view the URL names (a row's "Open tasks", whose URL still says team, an old link to Board): the
  // side bar opens on it, once.
  useEffect(() => {
    if (!initialTab) return;
    if (initialTab === 'team') openTasks('all');
    else if (initialTab === 'board') openTasks('board');
    onTabUsed(row.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask
  }, [initialTab]);
  const { send } = useSessionSend(sessionId);
  // The user's own requests to this node (core/org/threads-model.ts), read while its view is shown.
  // Read whenever the node keeps them, so the Threads tab can say it has news (2026-11-02, the user:
  // "if this thread has something new, it should show").
  const threadsId = keepsBrief ? contact?.id ?? row.contactId : undefined;
  const threads = useOrgThreads(threadsId, keepsBrief);
  const threadsNews = useMemo(() => (threads.threads ? newsAt(threads.threads, sharedAnswers(threads.threads)) : null), [threads.threads]);
  const threadsShown = !railHidden && topView === 'threads';
  useEffect(() => { if (threadsShown && threadsId && threadsNews) markThreadsSeen(threadsId, threadsNews); }, [threadsShown, threadsId, threadsNews]);
  const threadsNew = !threadsShown && !!threadsId && threadsUnread(threadsId, threadsNews);
  // The live list when it is read here, else the node's own status (the count every surface shows).
  const threadsCounted = useMemo<ThreadCounts | undefined>(() => (threads.threads ? threadCounts(threads.threads) : row.threads), [threads.threads, row.threads]);
  const threadsCount = threadsCounted?.shown ?? 0;
  const followUp = sessionId ? (threadId: string, text: string, images?: ImageAttachment[]) => send(sessionId, text, images, { threadId }) : null;
  /** The chat's thread lines (reply-thread-line.tsx) open this node's own Threads in the side bar. */
  const showOwnThreads = useLeanCallback(() => { setRailHidden(false); setTopPick('threads'); }, [setRailHidden, setTopPick]);
  const replyHost = useMemo<ReplyThreadHost | null>(() => (threadsId
    ? { chat: threadsId, threads: threads.threads, showOwn: showOwnThreads }
    : null), [threadsId, threads.threads, showOwnThreads]);
  // A thread line clicked in another chat (Home, Ask Walnut, another node's) asked for one of this
  // node's threads: the side bar shows Threads, which then brings that card into view (thread-focus.ts).
  // One the chat's top shows already (TopThread) steps there instead.
  const focusTick = useThreadFocusTick();
  useEffect(() => {
    const asked = threadsId ? threadFocusAsk(threadsId) : null;
    if (asked && !topShows(threadsId!, asked)) { setRailHidden(false); setTopPick('threads'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask
  }, [focusTick, threadsId]);
  /** The contact's Board is its team's (resolveTeamBoardTask): the contact's own choices and its
   *  subtasks' are there, another task's are not. */
  const onContactBoard = (id: string): boolean => {
    let t = tasks.find((x) => x.id === id);
    for (let hops = 0; t && hops < 10; hops++) {
      if (t.id === row.contactId) return true;
      const parent = t.parent_task_id;
      t = parent ? tasks.find((x) => x.id === parent) : undefined;
    }
    return false;
  };
  /** The task's name: where the ask lives. A choice on this node's Board, a letter in its
   *  session's Inbox tab, anything else in its chat (this node's, or the task's on Home). */
  const openAlert = (a: OrgAlertView) => {
    const own = a.taskId === row.contactId;
    // The Board may still be loading (null): the side bar shows all its tasks until it is known.
    if (a.kind === 'needs' && a.source === 'choice' && hasBoard !== false && onContactBoard(a.taskId)) { openTasks('board'); return; }
    if (a.kind === 'needs' && a.source === 'letter' && !own) { openLetter(a.taskId); return; }
    if (own) {
      if (a.kind === 'needs' && a.source === 'letter' && sessionId) { yieldFullscreen('org-own-letter'); setChatInbox({ sid: sessionId, n: Date.now() }); }
      return;
    }
    openTask(a.taskId);
  };
  /** Quote: the ask into this node's chat composer, to answer it in the chat. The chat may need
   *  to open first, so the quote waits for its panel (which takes COMPOSER_INSERT_EVENT). */
  const [quote, setQuote] = useState<{ sid: string; text: string } | null>(null);
  const chatHostRef = useRef<HTMLDivElement>(null);
  const quoteAlert = (a: OrgAlertView) => {
    if (!sessionId) return;
    yieldFullscreen('org-quote');
    setQuote({ sid: sessionId, text: alertQuote(a) });
  };
  useEffect(() => {
    if (!quote || shown !== 'chat' || quote.sid !== sessionId) return;
    // The panel registers on mount; a frame later covers a panel still mounting. 'lead': the
    // quote starts the message and what was typed stays after it, as the panel's own Quote does.
    let tries = 0;
    let timer: number | undefined;
    const put = () => {
      // Only this chat's panel takes it: a Home column of the same session stays mounted behind the page.
      const host = chatHostRef.current;
      const detail: ComposerInsertDetail = { sessionId: quote.sid, text: quote.text, mode: 'lead', handled: false, ...(host ? { within: host } : {}) };
      if (host) window.dispatchEvent(new CustomEvent<ComposerInsertDetail>(COMPOSER_INSERT_EVENT, { detail }));
      if (detail.handled || ++tries >= 20) { setQuote(null); return; }
      timer = window.setTimeout(put, 100);
    };
    put();
    return () => { if (timer !== undefined) window.clearTimeout(timer); };
  }, [quote, shown, sessionId]);
  // The rail sits beside the chat when the node has the room for both (design 10 of the ten the user
  // was shown, 2026-10-31); a phone or a narrow window stacks it above.
  const detailRef = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = detailRef.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth >= RAIL_SIDE_MIN_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const railSide = wide && !onBack;
  // The divider between the chat and the side rail moves the rail (2026-10-31, the user, translated: "this
  // sidebar can't be adjusted ... can't this bar's width be changed?"): dragged, kept, double-click resets.
  const splitRef = useRef<HTMLDivElement>(null);
  /** The rail's room now, as % of the window: at least 300px, and the chat keeps 420px. */
  const railBounds = () => {
    const room = splitRef.current?.clientWidth ?? 0;
    const vw = window.innerWidth || 1;
    return { min: (RAIL_MIN_PX / vw) * 100, max: (Math.max(RAIL_MIN_PX, room - CHAT_MIN_PX) / vw) * 100 };
  };
  const railWidth = useResizablePanel(railWidthKey(row.kind), RAIL_DEFAULT_VW, 'right', { bounds: railBounds });
  // The window's own clamp too, so a width set on a wider window still leaves both sides readable.
  const railCss = `clamp(${RAIL_MIN_PX}px, ${railWidth.pct}vw, max(${RAIL_MIN_PX}px, calc(100% - ${CHAT_MIN_PX}px)))`;
  /** The chat's header goes into the node's (SessionPanel headerSlot): its status and its kebab. */
  const [chatTools, setChatTools] = useState<HTMLElement | null>(null);
  const lastMoved = row.lastAt ? timeAgo(new Date(row.lastAt).toISOString(), { now }) : '';
  // A VP made only to put projects under leads no work of its own while its home has none.
  const leads = row.led?.length ? [...(row.vpOnly && !row.node?.counts.open ? [] : [row.name]), ...row.led.map((l) => l.name)] : [];
  const headTitle = [title, leads.length ? `Leads ${leads.join(', ')}` : '', lastMoved ? `Moved ${lastMoved}` : ''].filter(Boolean).join('\n');
  // Every ask the Needs you count holds is a row, the node's own first (2026-10-31: a count with
  // "Its ask is in the chat." under it left the user hunting for it).
  const alertsShown = useMemo(() => ownAskFirst(tabs.needs, row.contactId), [tabs.needs, row.contactId]);
  // Approvals a script waits on: Main lists every one, any other node those its own work asked for.
  const pendingApprovals = usePendingApprovals();
  const approvals = useMemo(() => {
    const ids = new Set<string>();
    // Its own work: the open tasks under it, the ones it just finished, and the node's own task.
    for (const t of [...tabs.watching, ...tabs.working, ...tabs.waiting, ...tabs.notstarted, ...tabs.done]) ids.add(t.id);
    for (const a of tabs.needs) ids.add(a.taskId);
    if (row.contactId) ids.add(row.contactId);
    return approvalsForNode(pendingApprovals, row.kind, ids);
  }, [pendingApprovals, row.kind, row.contactId, tabs]);

  /** A row's teams by the user's status, each with its line (a row with no chat). */
  const renderTeam = () => (
    <TeamBoard
      columns={columns}
      emptyText={row.kind === 'main' ? 'No project has open work yet' : 'Nothing open here'} // empty-state-ok: title handed to EmptyState in TeamBoard
      // A project's row is a node of this page (the page's own navigation); a task opens beside the page.
      onPick={(it) => { if (it.rowKey) onSelect(it.rowKey); else openTask(it.id); }}
    />
  );
  /** The Board its lead keeps, in the side bar. */
  const renderBoard = () => row.contactId ? (
    <TaskBoardPane
      key={row.contactId}
      taskId={row.contactId}
      {...(sessionId ? { onSendToSession: (text: string) => send(sessionId, text) } : {})}
      quietEmpty
      renderSession={(cardSessionId, opts) => (
        <SessionPanel key={cardSessionId} sessionId={cardSessionId} viewPlace="org-node-card" embedded inset onClose={opts.onClose} onSessionClick={onOpenSession} />
      )}
    />
  ) : null;

  const rail = (
    <OrgTaskRail
      row={row} rows={rows} tasks={tasks} tabs={tabs} alerts={alertsShown} approvals={approvals} flipped={flipped} onFlip={flipSection} focus={focusSection} onFocused={() => setFocusSection(null)}
      view={topView} onView={pickTop} keepsBrief={keepsBrief} briefOff={briefOff} briefNew={briefNew} threadsNew={threadsNew} threadsCount={threadsCount} onClose={() => setRailHidden(true)}
      mode={taskMode} onMode={setTaskMode} renderBoard={hasBoard && row.contactId ? renderBoard : null} briefFolded={briefFolded} onBriefFolded={setBriefFolded} briefFresh={briefFresh} briefUpdating={updating}
      threads={threads} onThreadFollowUp={followUp}
      contact={contact} title={title} onOpenAlert={openAlert} onQuote={quoteAlert} canQuote={!!sessionId} answers={answers}
      now={now} placement={railSide ? 'side' : 'top'}
      {...(railSide ? { width: railCss } : {})}
    />
  );

  return (
    <div ref={detailRef} className="org-detail" data-testid="org-detail" data-key={row.key}>
      {/* On the header rule; its tools take a line of their own under the name before they would
          cut it (org-page.css), so they keep their own wrap instead of the rule's actions group. */}
      <header className="org-detail-head" data-fit-header="">
        {onBack && <button type="button" className="org-back" onClick={onBack} aria-label="Back to the org">‹</button>}
        {/* No state mark on the avatar, and the projects it leads and its last move only on hover
            (2026-11-22/23, the user: "no fucking the ! mark", "why we need Leads Walnut, Walnut-Idea
            · moved just now???"). */}
        <OrgAvatar row={row} size={40} plain />
        <div className="org-detail-who">
          <h2 className="org-detail-title wn-title" data-fit-title="" data-testid="org-detail-title" title={headTitle}>{title}</h2>
          <div className="org-detail-sub">
            <CountPills tabs={tabs} onOpen={openTab} approvals={approvals.length} keepsThreads={keepsBrief} threads={keepsBrief ? threadsCounted : undefined} onThreads={() => { setRailHidden(false); pickTop('threads'); }} />
            {isRouter && <span className="org-muted" data-testid="org-detail-router-role">Router</span>}
          </div>
        </div>
        <div className="org-detail-tools" data-testid="org-detail-tools">
          {/* The chat's labels and its kebab (Watch, Locate, Minimize, Tags, then Changed, Files,
              Terminal, Board and the session's menu): SessionPanel headerSlot. */}
          <span ref={setChatTools} className="org-detail-chat-tools" data-testid="org-detail-chat-tools" />
          {!isRouter && <button
            type="button"
            className={`org-rail-toggle${railHidden ? '' : ' is-on'}`}
            data-testid="org-rail-toggle"
            aria-pressed={!railHidden}
            aria-label={keepsBrief ? `Side bar: ${railParts(briefOff)}` : 'Side bar: Tasks'}
            title={railHidden ? (keepsBrief ? `Show ${railParts(briefOff)}` : 'Show the tasks') : 'Hide the side bar'}
            onClick={() => setRailHidden(!railHidden)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
            {railHidden && (briefNew || threadsNew) && <i className="org-top-new" data-testid="org-rail-toggle-new"><span className="org-sr-only">, something new</span></i>}
          </button>}
        </div>
      </header>
      {/* A router's own settings, folded under its header; outside the split, so opening it or a
          save never moves or remounts the chat below. */}
      {routerTask && <OrgRouterFromMail node={row.key} routerId={routerTask.id} title={title} paused={routerTask.router_paused !== false} />}
      {routerTask && <OrgRouterSettings key={routerTask.id} router={routerTask} tasks={tasks} tasksLoading={!!tasksLoading} />}
      {routerTask && <OrgRouterOverview key={`overview-${routerTask.id}`} routerId={routerTask.id} title={title} links={routerLinkNames} paused={routerTask.router_paused !== false} />}
      {selfRouterTask && (
        <div className="org-router-overview" data-testid="org-self-router-overview">
          <p className="org-router-overview-what">{selfRouterLine(title, selfRouterTask.project || '', selfRouterLinks)}</p>
        </div>
      )}
      {/* One parent for both places, so moving the rail never remounts it (a picked choice, an
          open More and the held order stay when a side panel narrows the page). */}
      <div ref={(el) => { splitRef.current = el; railWidth.panelRef.current = el; }} className={`org-detail-split ${railHidden ? 'no-rail' : railSide ? 'has-rail' : 'is-stacked'}${isRouter ? ' is-router-split' : ''}`}>
      <div className="org-detail-col">
      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        id="org-detail-panel"
        className={`org-detail-body org-detail-body-${shown}`}
      >
        {shown === 'team' && renderTeam()}
        {shown === 'chat' && (sessionId ? (
          <div ref={chatHostRef} className="org-chat-host" data-testid="org-chat">
            <ReplyThreadContext.Provider value={replyHost}>
              <SessionPanel key={sessionId} sessionId={sessionId} viewPlace="org-node" embedded headerSlot={chatTools} {...(!isRouter && hasBoard && row.contactId ? { onHostBoard: () => openTasks('board') } : {})} inboxRequest={chatInbox?.sid === sessionId ? chatInbox.n : 0} {...(routerEmptyChat ? { emptyHistory: routerEmptyChat } : {})} threadsBeside={threadsShown} onSessionClick={onOpenSession} />
            </ReplyThreadContext.Provider>
          </div>
        ) : (
          // No session yet: it starts by itself in the background (org-autostart.ts); Retry only after a failure.
          <OrgNodeStart row={row} contact={contact} title={title} onStart={onStartChat} loading={!!tasksLoading} starting={!!launch} />
        ))}
      </div>
      </div>
      {!isRouter && railSide && !railHidden && (
        <OrgPaneHandle
          className="org-rail-handle"
          testId="org-rail-handle"
          label="Task panel width"
          panel={railWidth}
          bounds={railBounds}
          onReset={() => railWidth.setPct(RAIL_DEFAULT_VW)}
          roomRef={splitRef}
          panelSide="right"
        />
      )}
      {!isRouter && !railHidden && rail}
      </div>
    </div>
  );
}
