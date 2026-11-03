/**
 * The Org page's right side: the selected node (Main, or a project's lead).
 *
 *   header   one row (2026-11-02, the user picked design 1 of the side-bar round): who it is, its counts
 *            (each pill opens its tab), who it leads, when its work last moved; on the right the chat's
 *            status, the side bar's switch (dotted while it is closed and has news) and the chat's
 *            kebab, which holds Changed, Files, Terminal and Board ("hide all of them in the drop
 *            down button"). The chat draws no header of its own here (SessionPanel headerSlot).
 *   chat     its own session (SessionPanel), always on screen; or a way to start one
 *   side bar beside the chat on a wide page, above it on a narrow one (OrgTaskRail): Tasks (by status,
 *            by team, or as the Board its lead keeps), Brief and Threads; it widens beside the chat
 *            and closes, and never takes the chat's place
 *   A node no one answers for (the Inbox) has no chat: its teams fill the page instead.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { usePendingApprovals } from '@/components/approvals/ApprovalRow';
import { approvalsForNode } from '@/components/approvals/approvals-store';
import { readOrgPlace, writeOrgPlace } from './org-place';
import { isBoolean, usePageViewOf } from '@/utils/view-memory';
import { oneOf } from '@/hooks/usePersistentState';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { yieldFullscreen } from '@/hooks/useFullscreen';
import type { Task } from '@open-walnut/core';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { OrgPaneHandle } from './OrgPaneHandle';
import { TaskBoardPane } from '@/components/board/TaskBoardPane';
import { LiveActivityLine } from '@/components/board/LiveActivityLine';
import { useFirstLiveTask } from '@/stores/live-activity-store';
import { useSessionSend } from '@/hooks/useSessionSend';
import { useOrgThreads } from './useOrgThreads';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import { ORG_TASK_MODES, OrgTaskRail, TAB_DOT, type OrgAnswers, type OrgTaskMode } from './OrgTaskRail';
import { askWords } from './org-ask-form';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { recentMainStart } from './ask-main';
import { OrgNodeStart } from './OrgNodeStart';
import { OrgAvatar } from './OrgChannelList';
import { useHasBoard } from './useBoardOwner';
import { flashProbeEnabled } from '@/utils/flash-probe';
import { log } from '@/utils/log';
import { ORG_TOP_VIEWS, briefUnread, markBriefSeen, markThreadsSeen, readBriefFolded, threadsUnread, type OrgTopView } from './org-brief-model';
import { newsAt, sharedAnswers, threadCountLabel, threadCounts, type ThreadCounts } from '@open-walnut/thread-view';
import { briefUpdating } from '@open-walnut/brief-fresh';
import { useBriefRefresh } from './useBriefRefresh';
import { ORG_TASK_TAB_LABELS, isKeptRailTab, orgTaskTabs, ownAskFirst, railTabShown, type KeptRailTab, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import { stateCountLabel } from '@open-walnut/user-status';
import type { ImageAttachment } from '@/api/chat';
import {
  mainTeamColumns, teamColumns, type ChannelRow, type OrgAlertView, type TeamColumn,
} from './org-channels-model';

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
  /** Open a task that is not this node: the page's side panel (`inbox`: on its session's Inbox tab). */
  onOpenTask: (taskId: string, opts?: { inbox?: boolean }) => void;
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

/** The quote Quote puts in the chat: which task, and what it asks. */
export const alertQuote = (a: OrgAlertView): string => `> ${a.title}: ${askWords(a)}\n\n`;

const COLUMN_DOT: Record<TeamColumn['key'], string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)',
};

/** The user's status of the node's work, in the words the Board uses (src/core/user-status.ts),
 *  counted from the same lists as the Task view's tabs; each pill opens its tab. Needs you counts
 *  its cards, a result or an answer to look at included (To read has no pill of its own). Its own
 *  Threads come first, and no "N open" (2026-11-03, the user: "remove xx open not needed also show
 *  thread and number"). */
function CountPills({ tabs, onOpen, approvals, threads, onThreads }: { tabs: OrgTaskTabs; onOpen: (tab: OrgTaskTab) => void; approvals: number; threads?: ThreadCounts; onThreads?: () => void }) {
  const pill = (tab: OrgTaskTab, n: number) => (
    <button type="button" className="org-pill is-button" data-testid={`org-pill-${tab}`} onClick={() => onOpen(tab)} title={`Show ${ORG_TASK_TAB_LABELS[tab]}`}>
      <i style={{ background: TAB_DOT[tab] }} />{stateCountLabel(tab, n)}
    </button>
  );
  return (
    <span className="org-pills" data-testid="org-detail-counts">
      {!!threads?.shown && (
        <button
          type="button"
          className="org-pill is-button"
          data-testid="org-pill-threads"
          data-needs={threads.needs}
          onClick={onThreads}
          title={threads.needs ? `${threadCountLabel(threads.needs)} waiting on you${threads.title ? `: ${threads.title}` : ''}` : 'Show Threads'}
        >
          <i style={{ background: threads.needs ? TAB_DOT.needs : 'var(--accent, #007AFF)' }} />{threadCountLabel(threads.shown)}
        </button>
      )}
      {tabs.needs.length + approvals > 0 && pill('needs', tabs.needs.length + approvals)}
      {tabs.working.length > 0 && pill('working', tabs.working.length)}
      {tabs.waiting.length > 0 && pill('waiting', tabs.waiting.length)}
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
  if (!columns.length) return <p className="org-empty-note" data-testid="org-team-empty">{emptyText}</p>;
  return (
    <div className="org-team" data-testid="org-team">
      {columns.map((c) => (
        <section key={c.key} className="org-team-col" data-testid="org-team-col" data-column={c.key}>
          <h3 className="org-team-head"><i style={{ background: COLUMN_DOT[c.key] }} />{c.label}<span className="org-team-count">{c.items.length}</span></h3>
          <ul className="org-team-list">
            {c.items.map((it) => (
              <li key={it.id}>
                <button type="button" className="org-team-item" data-testid="org-team-item" data-task-id={it.id} onClick={() => onPick(it)} title={it.title}>
                  <span className="org-team-ring" style={{ borderColor: COLUMN_DOT[c.key] }} aria-hidden="true" />
                  <span className="org-team-text">
                    <span className="org-team-title">{it.title}</span>
                    {it.live && <TeamLiveLine live={it.live} />}
                    {it.note && <span className="org-team-note" data-testid="org-team-note">{it.note}</span>}
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

export function OrgNodeDetail({ row, rows, tasks, initialTab, onTabUsed, onSelect: selectRow, onOpenTask: openTaskOut, onOpenSession, answers, onStartChat, tasksLoading, onBack, now }: Props) {
  // What opens instead of this node or beside it (another node, a task's panel, the chat this
  // fills) lies under a full-screen sheet, its side bar's or its chat's: leave it first, as a home
  // column does (useFullscreen's COLUMN-OPEN EXIT), or the click reads as nothing happened.
  const onSelect = (key: string) => { yieldFullscreen('org-select-node'); selectRow(key); };
  const onOpenTask = (taskId: string, opts?: { inbox?: boolean }) => { yieldFullscreen('org-open-task'); openTaskOut(taskId, opts); };
  const contact = useMemo(() => (row.contactId ? tasks.find((t) => t.id === row.contactId) : undefined), [tasks, row.contactId]);
  // Temporary (utils/flash-probe.ts): a remount of the node's detail is one cause of a flash.
  useEffect(() => { if (flashProbeEnabled()) log.info('flash-probe', 'org detail mounted', { node: row.key }); }, [row.key]);
  // A Main started a moment ago by a quick action: its session before the store has it.
  const launch = row.kind === 'main' ? recentMainStart(row.contactId) : null;
  const sessionId = (contact ? resolveTaskSessionId(contact) : null) ?? launch?.sessionId ?? null;
  const hasBoard = useHasBoard(row.contactId);
  const columns = useMemo(
    () => (row.kind === 'main' ? mainTeamColumns(rows) : teamColumns(row, tasks)),
    [row, rows, tasks],
  );
  /** The chat's Inbox tab, asked for by Answer on a letter (SessionPanel inboxRequest), for the
   *  session it was asked of: a replaced session's new panel does not reopen it. */
  const [chatInbox, setChatInbox] = useState<{ sid: string; n: number } | null>(null);
  /** Above the chat: Task (Latest and the tasks by status), the Brief its lead or Main keeps
   *  (OrgBrief), or Threads. Task first (2026-10-30, the user, translated: "by default it shows this status");
   *  after that each node opens on the view it was left on (2026-11-01: "If I was in Threads it puts me back
   *  in Task"), kept per node (utils/view-memory.ts). */
  const [topPick, setTopPick] = usePageViewOf<OrgTopView>('org', 'node.top', row.key, 'task', oneOf(ORG_TOP_VIEWS));
  const [briefFolded, setBriefFolded] = useState(readBriefFolded);
  // Main and a lead keep a Brief and Threads. The row says so too, before the node's own task has
  // loaded (a reload paints from the cache first), so a reload does not show Task for a moment
  // before the view it was left on.
  const keepsBrief = contact?.org_role === 'main' || contact?.org_role === 'lead'
    || (!!row.contactId && (row.kind === 'main' || row.isLead));
  const topView: OrgTopView = keepsBrief ? topPick : 'task';
  /** The Task view's tab: Needs you until the user picks another, then the one he left it on. */
  const [keptTab, setTaskTab] = usePageViewOf<KeptRailTab>('org', 'node.taskTab', row.key, 'needs', isKeptRailTab);
  const taskTab = railTabShown(keptTab);
  /** Tasks by status, by team, or as the Board (2026-11-02: Team and Board went under Tasks). */
  const [taskMode, setTaskMode] = usePageViewOf<OrgTaskMode>('org', 'node.taskMode', row.key, 'status', oneOf(ORG_TASK_MODES));
  const tabs = useMemo(() => orgTaskTabs(row, rows, tasks, now), [row, rows, tasks, now]);
  const openTab = (t: OrgTaskTab) => { setRailHidden(false); setTopPick('task'); setTaskMode('status'); setTaskTab(t); };
  const brief = keepsBrief ? contact?.brief : undefined;
  const pickTop = (v: OrgTopView) => setTopPick(v);
  /** The panel above or beside the chat (Task, Brief, Threads) closed: the chat takes its room;
   *  kept per node (2026-11-02, the user: "it is a panel too, you can at least let me close it"). */
  const [railHidden, setRailHidden] = usePageViewOf<boolean>('org', 'node.railHidden', row.key, false, isBoolean);
  // Read while shown: the dot on the Brief tab is for a rewrite the user has not seen.
  useEffect(() => { if (!railHidden && topView === 'brief' && contact && brief?.at) markBriefSeen(contact.id, brief.at); }, [railHidden, topView, contact, brief?.at]);
  const briefNew = (railHidden || topView !== 'brief') && !!contact && briefUnread(contact.id, brief?.at);
  // Opening a node whose Brief is stale asks it for one refresh turn (core/sessions/brief-refresh.ts).
  const briefFresh = useBriefRefresh(keepsBrief ? contact : undefined, tasks);
  const updating = keepsBrief && !!contact && briefUpdating(contact, now);
  const title = row.kind === 'main' ? 'CEO' : row.contactTitle;
  // Main is always someone to talk to: its task is made by the first chat.
  const canTalk = row.kind === 'main' || !!row.contactId || !!row.node?.needsLead;
  // The chat is always there (2026-11-02, the user: the side bar "can expand to more but not like a
  // individual page"); a node no one answers for (the Inbox) shows its teams instead.
  const shown: 'chat' | 'team' = canTalk ? 'chat' : 'team';
  // The Inbox's teams (its page has no chat) come back scrolled where they were (org-place.ts).
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
  const openTasks = (mode: OrgTaskMode) => { setRailHidden(false); setTopPick('task'); setTaskMode(mode === 'board' && hasBoard === false ? 'status' : mode); };
  // A view the URL names (a row's "Open team", an old link to Board): the side bar opens on it, once.
  useEffect(() => {
    if (!initialTab) return;
    if (initialTab === 'team' || initialTab === 'board') openTasks(initialTab);
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
  /** A task chip on the Board: a node of this page is selected; any other task opens beside it. */
  const openChip = (id: string) => {
    const hit = rows.find((r) => r.contactId === id);
    if (hit) { onSelect(hit.key); return; }
    onOpenTask(id);
  };

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
   *  session's Inbox tab, anything else in its chat (this node's, or the task's beside the page). */
  const openAlert = (a: OrgAlertView) => {
    const own = a.taskId === row.contactId;
    // The Board may still be loading (null): the side bar shows the work by status until it is known.
    if (a.kind === 'needs' && a.source === 'choice' && hasBoard !== false && onContactBoard(a.taskId)) { openTasks('board'); return; }
    if (a.kind === 'needs' && a.source === 'letter' && !own) { onOpenTask(a.taskId, { inbox: true }); return; }
    if (own) {
      if (a.kind === 'needs' && a.source === 'letter' && sessionId) { yieldFullscreen('org-own-letter'); setChatInbox({ sid: sessionId, n: Date.now() }); }
      return;
    }
    onOpenTask(a.taskId);
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
  // Every ask the Needs you count holds is a row, the node's own first (2026-10-31: a count with
  // "Its ask is in the chat." under it left the user hunting for it).
  const alertsShown = useMemo(() => ownAskFirst(tabs.needs, row.contactId), [tabs.needs, row.contactId]);
  // Approvals a script waits on: Main lists every one, any other node those its own work asked for.
  const pendingApprovals = usePendingApprovals();
  const approvals = useMemo(() => {
    const ids = new Set<string>();
    // Its own work: the open tasks under it, the ones it just finished, and the node's own task.
    for (const t of [...tabs.watching, ...tabs.working, ...tabs.waiting, ...tabs.done]) ids.add(t.id);
    for (const a of tabs.needs) ids.add(a.taskId);
    if (row.contactId) ids.add(row.contactId);
    return approvalsForNode(pendingApprovals, row.kind, ids);
  }, [pendingApprovals, row.kind, row.contactId, tabs]);

  /** The node's teams by the user's status, each with its line. */
  const renderTeam = () => (
    <TeamBoard
      columns={columns}
      emptyText={row.kind === 'main' ? 'No project has open work yet.' : 'Nothing open here.'}
      onPick={(it) => { if (it.rowKey) onSelect(it.rowKey); else onOpenTask(it.id); }}
    />
  );
  /** The Board its lead keeps, in the side bar. */
  const renderBoard = () => row.contactId ? (
    <TaskBoardPane
      key={row.contactId}
      taskId={row.contactId}
      {...(sessionId ? { sessionId, onSendToSession: (text: string) => send(sessionId, text) } : {})}
      onOpenTask={openChip}
      quietEmpty
      renderSession={(cardSessionId, opts) => (
        <SessionPanel key={cardSessionId} sessionId={cardSessionId} viewPlace="org-node-card" embedded inset onClose={opts.onClose} onTaskClick={openChip} onSessionClick={onOpenSession} />
      )}
    />
  ) : null;

  const rail = (
    <OrgTaskRail
      row={row} rows={rows} tasks={tasks} tabs={tabs} alerts={alertsShown} approvals={approvals} tab={taskTab} onTab={setTaskTab}
      view={topView} onView={pickTop} keepsBrief={keepsBrief} briefNew={briefNew} threadsNew={threadsNew} threadsCount={threadsCount} onClose={() => setRailHidden(true)}
      mode={taskMode} onMode={setTaskMode} renderTeam={renderTeam} renderBoard={hasBoard && row.contactId ? renderBoard : null} briefFolded={briefFolded} onBriefFolded={setBriefFolded} briefFresh={briefFresh} briefUpdating={updating}
      threads={threads} onThreadFollowUp={followUp}
      contact={contact} title={title} onOpenAlert={openAlert} onQuote={quoteAlert} canQuote={!!sessionId} answers={answers}
      onOpenTask={openChip} now={now} placement={railSide ? 'side' : 'top'}
      {...(railSide ? { width: railCss } : {})}
    />
  );

  return (
    <div ref={detailRef} className="org-detail" data-testid="org-detail" data-key={row.key}>
      <header className="org-detail-head">
        {onBack && <button type="button" className="org-back" onClick={onBack} aria-label="Back to the org">‹</button>}
        <OrgAvatar row={row} size={40} />
        <div className="org-detail-who">
          <h2 className="org-detail-title" data-testid="org-detail-title">{title}</h2>
          <div className="org-detail-sub">
            <CountPills tabs={tabs} onOpen={openTab} approvals={approvals.length} threads={keepsBrief ? threadsCounted : undefined} onThreads={() => { setRailHidden(false); pickTop('threads'); }} />
            {!!row.led?.length && (
              <span className="org-detail-led org-muted" data-testid="org-detail-led">
                {/* A VP made only to put projects under leads no work of its own while its home has none. */}
                Leads {[...(row.vpOnly && !row.node?.counts.open ? [] : [row.name]), ...row.led.map((l) => l.name)].join(', ')}
              </span>
            )}
            {lastMoved && <span className="org-muted">· moved {lastMoved}</span>}
          </div>
        </div>
        <div className="org-detail-tools" data-testid="org-detail-tools">
          {/* The chat's status and its kebab (Changed, Files, Terminal, Board, the session's menu). */}
          <span ref={setChatTools} className="org-detail-chat-tools" data-testid="org-detail-chat-tools" />
          <button
            type="button"
            className={`org-rail-toggle${railHidden ? '' : ' is-on'}`}
            data-testid="org-rail-toggle"
            aria-pressed={!railHidden}
            aria-label={keepsBrief ? 'Side bar: Tasks, Brief and Threads' : 'Side bar: Tasks'}
            title={railHidden ? (keepsBrief ? 'Show Tasks, Brief and Threads' : 'Show the tasks') : 'Hide the side bar'}
            onClick={() => setRailHidden(!railHidden)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
            {railHidden && (briefNew || threadsNew) && <i className="org-top-new" data-testid="org-rail-toggle-new"><span className="org-sr-only">, something new</span></i>}
          </button>
        </div>
      </header>
      {/* One parent for both places, so moving the rail never remounts it (a picked choice, an
          open More and the held order stay when a side panel narrows the page). */}
      <div ref={(el) => { splitRef.current = el; railWidth.panelRef.current = el; }} className={`org-detail-split ${railHidden ? 'no-rail' : railSide ? 'has-rail' : 'is-stacked'}`}>
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
            <SessionPanel key={sessionId} sessionId={sessionId} viewPlace="org-node" embedded headerSlot={chatTools} {...(hasBoard && row.contactId ? { onHostBoard: () => openTasks('board') } : {})} inboxRequest={chatInbox?.sid === sessionId ? chatInbox.n : 0} onTaskClick={openChip} onSessionClick={onOpenSession} />
          </div>
        ) : (
          // No session yet: it starts by itself in the background (org-autostart.ts); Retry only after a failure.
          <OrgNodeStart row={row} contact={contact} title={title} onStart={onStartChat} loading={!!tasksLoading} starting={!!launch} />
        ))}
      </div>
      {!canTalk && <p className="org-composer org-composer-note" data-testid="org-no-contact">The Inbox has no VP: open a task to talk to it.</p>}
      </div>
      {railSide && !railHidden && (
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
      {!railHidden && rail}
      </div>
    </div>
  );
}
