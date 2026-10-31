/**
 * The Org page's right side: the selected node (Main, or a project's lead).
 *
 *   header   who it is, its counts (each pill opens its tab), when its work last moved; tabs
 *   rail     beside the chat on a wide page, above it on a narrow one (OrgTaskRail): Task, the node's
 *            work in the home panel's four tabs, its asks answered in place; or the Brief its lead
 *            or Main keeps
 *   Board    the Board its lead keeps (TaskBoardPane), when it keeps one
 *   Team     its work by the user's status (Needs you / Working / Waiting), each with its line
 *   Chat     its own session (SessionPanel), or a way to start one
 *   composer under Board and Team: a line to its session, then Chat shows it
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { readOrgPlace, writeOrgPlace } from './org-place';
import type { Task } from '@open-walnut/core';
import { SessionPanel } from '@/components/sessions/SessionPanel';
import { TaskBoardPane } from '@/components/board/TaskBoardPane';
import { LiveActivityLine } from '@/components/board/LiveActivityLine';
import { useFirstLiveTask } from '@/stores/live-activity-store';
import { useSessionSend } from '@/hooks/useSessionSend';
import { resolveTaskSessionId } from '@/utils/session-status';
import { timeAgo } from '@/utils/time';
import { OrgComposerBar } from './OrgComposerBar';
import { OrgTaskRail, TAB_DOT, type OrgAnswers } from './OrgTaskRail';
import { askWords } from './org-ask-form';
import { COMPOSER_INSERT_EVENT, type ComposerInsertDetail } from '@/utils/composer-insert';
import { recentMainStart } from './ask-main';
import { OrgAvatar } from './OrgChannelList';
import { useHasBoard } from './useBoardOwner';
import { flashProbeEnabled } from '@/utils/flash-probe';
import { log } from '@/utils/log';
import { briefUnread, markBriefSeen, readBriefFolded, type OrgTopView } from './org-brief-model';
import { ORG_TASK_TAB_LABELS, orgTaskTabs, type OrgTaskTab, type OrgTaskTabs } from './org-task-tabs';
import { stateCountLabel } from '@open-walnut/user-status';
import {
  mainTeamColumns, teamColumns, type ChannelRow, type OrgAlertView, type TeamColumn,
} from './org-channels-model';

export type OrgTab = 'board' | 'team' | 'chat';

/** The node's width from which the rail sits beside the chat: a chat of about 520px beside it. */
export const RAIL_SIDE_MIN_WIDTH = 880;

export type { OrgAnswers };

interface Props {
  row: ChannelRow;
  rows: readonly ChannelRow[];
  tasks: readonly Task[];
  /** The tab the URL asked for on arrival; the node's default otherwise. */
  initialTab: OrgTab | null;
  /** The tab the user picked for THIS node (`key`), for the URL. */
  onTabChange: (key: string, tab: OrgTab) => void;
  onSelect: (key: string) => void;
  /** Open a task that is not this node: the page's side panel (`inbox`: on its session's Inbox tab). */
  onOpenTask: (taskId: string, opts?: { inbox?: boolean }) => void;
  /** Open a session a chat names: the page's side panel. */
  onOpenSession: (sessionId: string) => void;
  /** Asks answered from their rows (the page's holds, OrgPage). */
  answers: OrgAnswers;
  /** Start a chat with this node, which has no session yet. */
  onStartChat: (row: ChannelRow) => void;
  /** Phone: back to the list. */
  onBack?: () => void;
  now: number;
}

/** An ask its own chat shows: a prompt, a failure, its words. A letter or a Board choice is elsewhere. */
const shownInChat = (a: OrgAlertView) => a.kind !== 'needs' || (a.source !== 'letter' && a.source !== 'choice');
/** The quote Quote puts in the chat: which task, and what it asks. */
export const alertQuote = (a: OrgAlertView): string => `> ${a.title}: ${askWords(a)}\n\n`;

const COLUMN_DOT: Record<TeamColumn['key'], string> = {
  needs: 'var(--error, #FF3B30)', working: 'var(--success, #34C759)', waiting: 'var(--fg-muted, #86868B)',
};


/** The user's status of the node's work, in the words the Board uses (src/core/user-status.ts),
 *  counted from the same lists as the Task view's tabs; each pill opens its tab. */
function CountPills({ row, tabs, onOpen }: { row: ChannelRow; tabs: OrgTaskTabs; onOpen: (tab: OrgTaskTab) => void }) {
  const pill = (tab: OrgTaskTab, n: number) => (
    <button type="button" className="org-pill is-button" data-testid={`org-pill-${tab}`} onClick={() => onOpen(tab)} title={`Show ${ORG_TASK_TAB_LABELS[tab]}`}>
      <i style={{ background: TAB_DOT[tab] }} />{stateCountLabel(tab, n)}
    </button>
  );
  return (
    <span className="org-pills" data-testid="org-detail-counts">
      {tabs.needs.length > 0 && pill('needs', tabs.needs.length)}
      {tabs.working.length > 0 && pill('working', tabs.working.length)}
      {tabs.waiting.length > 0 && pill('waiting', tabs.waiting.length)}
      <span className="org-pill">{row.counts.open} open</span>
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

export function OrgNodeDetail({ row, rows, tasks, initialTab, onTabChange, onSelect, onOpenTask, onOpenSession, answers, onStartChat, onBack, now }: Props) {
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
  const teamCount = row.kind === 'main' ? rows.length : row.node?.teams.length ?? 0;
  const [tab, setTab] = useState<OrgTab | null>(initialTab);
  const [focusChat, setFocusChat] = useState(false);
  /** The chat's Inbox tab, asked for by Answer on a letter (SessionPanel inboxRequest), for the
   *  session it was asked of: a replaced session's new panel does not reopen it. */
  const [chatInbox, setChatInbox] = useState<{ sid: string; n: number } | null>(null);
  /** Above the chat: Task (Latest and the tasks by status) or the Brief its lead or Main keeps
   *  (OrgBrief). A node always opens on Task (2026-10-30, the user: "default 是显示这个 status 的";
   *  2026-10-31: "这个 status 可能就是应该叫做 task 吧"). */
  const [topPick, setTopPick] = useState<OrgTopView>('task');
  const [briefFolded, setBriefFolded] = useState(readBriefFolded);
  const keepsBrief = contact?.org_role === 'main' || contact?.org_role === 'lead';
  const topView: OrgTopView = keepsBrief ? topPick : 'task';
  /** The Task view's tab: Needs you unless the user picked another (a node opens on it). */
  const [taskTab, setTaskTab] = useState<OrgTaskTab>('needs');
  const tabs = useMemo(() => orgTaskTabs(row, rows, tasks, now), [row, rows, tasks, now]);
  const openTab = (t: OrgTaskTab) => { setTopPick('task'); setTaskTab(t); };
  const brief = keepsBrief ? contact?.brief : undefined;
  const pickTop = (v: OrgTopView) => setTopPick(v);
  // Read while shown: the dot on the Brief tab is for a rewrite the user has not seen.
  useEffect(() => { if (topView === 'brief' && contact && brief?.at) markBriefSeen(contact.id, brief.at); }, [topView, contact, brief?.at]);
  const briefNew = topView === 'task' && !!contact && briefUnread(contact.id, brief?.at);
  const title = row.kind === 'main' ? 'CEO' : row.contactTitle;
  // Main is always someone to talk to: its task is made by the first chat.
  const canTalk = row.kind === 'main' || !!row.contactId || !!row.node?.needsLead;
  // A node opens on its chat (the user, 2026-10-25: "chat first, not the board"); one no one
  // answers for (the Inbox) on its team.
  const shown: OrgTab | null = tab ?? (canTalk ? 'chat' : 'team');
  // The Team view comes back scrolled where it was on this node (org-place.ts).
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
  useEffect(() => { if (tab === 'board' && hasBoard === false) setTab('team'); }, [tab, hasBoard]);
  // A pick of this same node that names a tab (a chat that names this node's session) shows it.
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  const pick = (t: OrgTab) => { setTab(t); setFocusChat(false); setChatInbox(null); onTabChange(row.key, t); };
  const { send } = useSessionSend(sessionId);
  // A send that answers after the user moved to another node must not pull them back.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
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
    // The Board may still be loading (null): its tab falls back to Team if there is none.
    if (a.kind === 'needs' && a.source === 'choice' && hasBoard !== false && onContactBoard(a.taskId)) { pick('board'); return; }
    if (a.kind === 'needs' && a.source === 'letter' && !own) { onOpenTask(a.taskId, { inbox: true }); return; }
    if (own) {
      pick('chat');
      if (a.kind === 'needs' && a.source === 'letter' && sessionId) setChatInbox({ sid: sessionId, n: Date.now() });
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
    if (shown !== 'chat') pick('chat');
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
  const lastMoved = row.lastAt ? timeAgo(new Date(row.lastAt).toISOString(), { now }) : '';
  const tabId = (t: OrgTab) => `org-tab-${t}-${row.key}`;
  // On the chat, the contact's own prompt is in view already; its letter or choice is not, so it stays.
  const alertsShown = shown === 'chat' ? tabs.needs.filter((a) => a.taskId !== row.contactId || !shownInChat(a)) : tabs.needs;

  const rail = (
    <OrgTaskRail
      row={row} rows={rows} tasks={tasks} tabs={tabs} alerts={alertsShown} tab={taskTab} onTab={setTaskTab}
      view={topView} onView={pickTop} keepsBrief={keepsBrief} briefNew={briefNew} briefFolded={briefFolded} onBriefFolded={setBriefFolded}
      contact={contact} title={title} onOpenAlert={openAlert} onQuote={quoteAlert} canQuote={!!sessionId} answers={answers}
      onOpenTask={openChip} now={now} placement={railSide ? 'side' : 'top'}
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
            <CountPills row={row} tabs={tabs} onOpen={openTab} />
            {lastMoved && <span className="org-muted">· moved {lastMoved}</span>}
          </div>
          {!!row.led?.length && (
            <div className="org-detail-led org-muted" data-testid="org-detail-led">
              {/* A VP made only to put projects under leads no work of its own while its home has none. */}
              Leads {[...(row.vpOnly && !row.node?.counts.open ? [] : [row.name]), ...row.led.map((l) => l.name)].join(', ')}
            </div>
          )}
        </div>
        <div className="org-tabs" role="tablist" aria-label={`${title} views`}>
          {canTalk && (
            <button type="button" role="tab" id={tabId('chat')} aria-controls="org-detail-panel" aria-selected={shown === 'chat'} className={`org-tab${shown === 'chat' ? ' is-on' : ''}`} data-testid="org-tab-chat" onClick={() => pick('chat')}>Chat</button>
          )}
          <button type="button" role="tab" id={tabId('team')} aria-controls="org-detail-panel" aria-selected={shown === 'team'} className={`org-tab${shown === 'team' ? ' is-on' : ''}`} data-testid="org-tab-team" onClick={() => pick('team')}>
            {row.kind === 'main' ? 'VPs' : 'Team'} <span className="org-tab-count">{teamCount}</span>
          </button>
          {hasBoard && (
            <button type="button" role="tab" id={tabId('board')} aria-controls="org-detail-panel" aria-selected={shown === 'board'} className={`org-tab${shown === 'board' ? ' is-on' : ''}`} data-testid="org-tab-board" onClick={() => pick('board')}>Board</button>
          )}
        </div>
      </header>
      {/* One parent for both places, so moving the rail never remounts it (a picked choice, an
          open More and the held order stay when a side panel narrows the page). */}
      <div className={`org-detail-split ${railSide ? 'has-rail' : 'is-stacked'}`}>
      <div className="org-detail-col">
      <div
        ref={bodyRef}
        onScroll={onBodyScroll}
        id="org-detail-panel"
        role="tabpanel"
        {...(shown ? { 'aria-labelledby': tabId(shown) } : {})}
        className={`org-detail-body org-detail-body-${shown ?? 'loading'}`}
      >
        {shown === null && <div className="org-detail-loading" aria-busy="true" data-testid="org-detail-loading">Loading…</div>}
        {shown === 'board' && row.contactId && (
          <TaskBoardPane
            key={row.contactId}
            taskId={row.contactId}
            {...(sessionId ? { sessionId, onSendToSession: (text: string) => send(sessionId, text) } : {})}
            onOpenTask={openChip}
            quietEmpty
            renderSession={(cardSessionId, opts) => (
              <SessionPanel key={cardSessionId} sessionId={cardSessionId} embedded inset onClose={opts.onClose} onTaskClick={openChip} onSessionClick={onOpenSession} />
            )}
          />
        )}
        {shown === 'team' && (
          <TeamBoard
            columns={columns}
            emptyText={row.kind === 'main' ? 'No project has open work yet.' : 'Nothing open here.'}
            onPick={(it) => { if (it.rowKey) onSelect(it.rowKey); else onOpenTask(it.id); }}
          />
        )}
        {shown === 'chat' && (sessionId ? (
          <div ref={chatHostRef} className="org-chat-host" data-testid="org-chat">
            <SessionPanel key={sessionId} sessionId={sessionId} embedded focusComposer={focusChat} inboxRequest={chatInbox?.sid === sessionId ? chatInbox.n : 0} onTaskClick={openChip} onSessionClick={onOpenSession} />
          </div>
        ) : (
          <div className="org-chat-start" data-testid="org-chat-start">
            {launch ? <p>The CEO is starting…</p> : <>
            <p>{row.contactId || row.kind === 'main' ? `${title} has not started yet.` : `${row.name} has no VP yet.`}</p>
            <button type="button" className="btn btn-sm btn-primary" data-testid="org-start-chat" onClick={() => onStartChat(row)}>
              {row.contactId || row.kind === 'main' ? `Start a chat with ${title}` : 'Make a VP and chat'}
            </button>
            </>}
          </div>
        ))}
      </div>

      {shown !== 'chat' && (
        sessionId ? (
          <OrgComposerBar
            key={sessionId}
            sessionId={sessionId}
            to={title}
            send={(text) => send(sessionId, text)}
            onSent={() => { if (!mounted.current) return; setTab('chat'); setFocusChat(true); onTabChange(row.key, 'chat'); }}
          />
        ) : canTalk ? (
          <div className="org-composer org-composer-start">
            <button type="button" className="btn btn-sm" data-testid="org-start-chat-bar" onClick={() => onStartChat(row)}>
              {row.contactId || row.kind === 'main' ? `Start a chat with ${title}` : 'Make a VP and chat'}
            </button>
          </div>
        ) : (
          <p className="org-composer org-composer-note" data-testid="org-no-contact">The Inbox has no VP: open a task to talk to it.</p>
        )
      )}
      </div>
      {rail}
      </div>
    </div>
  );
}
