/**
 * /org: Main and the project leads, one page (the sidebar's Org).
 *
 *   ┌ list ──────────┬ detail ─────────────────────────────────┬ side ─────────┐
 *   │ Main (pinned)   │ the selected node: counts, Latest,       │ a task opened │
 *   │ Leads · N       │ Needs you, Board | Team | Chat, composer │ from the page │
 *   │  one row each   │                                          │ (its session) │
 *   └─────────────────┴──────────────────────────────────────────┴───────────────┘
 *
 * Everything is live from the browser's stores: the org tree is built from the
 * task store with the server's own function (@open-walnut/org-tree), and what
 * waits on a prompt comes from the session status store. The selection, tab and
 * opened task ride the URL (?node=…&tab=…&open=…), so a reload or Back keeps them.
 * A task clicked on the page opens in the side panel, so the user stays here (a
 * narrow window lays it over the detail). A wide window keeps a strip of side panels:
 * the one `open` names plus the ones the user locked (org-side-columns.ts), saved in the
 * layout record so the pins come back after a restart. On a phone the list, the detail and the
 * opened task take turns. The old org chart (drag to reparent) stays one click away.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { buildOrgTree } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { usePhoneLayout } from '@/hooks/usePhoneLayout';
import { hydrateTaskSessionStatuses } from '@/api/sessions';
import { resolveOrgContact } from '@/api/org';
import { fetchTask } from '@/api/tasks';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import { createStripWriter, readColumns } from '@/utils/layout-record';
import type { SessionSlot } from '@/pages/sessionColumns';
import { log } from '@/utils/log';
import { OrgChartSheet, type ChartStart } from '@/components/org/OrgChartSheet';
import { OrgChannelList, type ChannelMenuTarget } from '@/components/org/OrgChannelList';
import { placeParams, readOrgPlace, writeOrgPlace } from '@/components/org/org-place';
import type { ContextMenuItem } from '@/components/common/ContextMenu';
import { vpCards } from '@/components/org/org-chart-model';
import { OptionPickerFlyout, useCursorFlyout, type CursorPoint } from '@/components/tasks/CursorFlyout';
import { orgRowMenu, type OrgRowPick } from '@/components/org/org-row-menu';
import { OrgNodeDetail, type OrgAnswers, type OrgTab } from '@/components/org/OrgNodeDetail';
import type { AnswerFailure } from '@/components/org/OrgInlineAnswer';
import { OrgSidePanel, parseSideTarget, sideTargetParam, type OrgSideTarget } from '@/components/org/OrgSidePanel';
import {
  orgStripToggleLock, orgStripView, type SameSession,
} from '@/components/org/org-side-columns';
import {
  MAIN_KEY, buildChannels, filterChannels, flattenNodes, movedProjects, pickChannel, projectRowKey, rowOf, type AlertProbe, type ChannelRow,
} from '@/components/org/org-channels-model';
import {
  ANSWERED_HOLD_MS, phaseMark, promptAnswered, promptKey, settleHolds, withAnswered, without, type AnsweredHolds,
} from '@/components/org/org-answered';
import '@/styles/org-page.css';

const TABS: readonly OrgTab[] = ['board', 'team', 'chat'];

/** The URL's params now. setParams hands its updater the params of the last render, so two quick
 *  changes (a tab, then a task opened beside it, before the page drew the first) lost the first. */
const liveParams = (): URLSearchParams => new URLSearchParams(window.location.search);

/** A question or approval the task's session waits on now, else a failed session. */
const probe: AlertProbe = (task: Task) => {
  const sid = resolveTaskSessionId(task);
  if (!sid) return null;
  const s = sessionStatusStore.getStatus(sid);
  const tool = s?.pendingPermissionTool;
  if (tool && (s.process_status === 'running' || s.process_status === 'idle')) {
    return tool === 'AskUserQuestion' ? { kind: 'question' } : { kind: 'permission', tool };
  }
  if ((s?.process_status ?? task.session_status?.process_status) === 'error') return { kind: 'error' };
  return null;
};

/** A clock that moves once a minute, for the rows' "5m". */
function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function OrgPage() {
  const { tasks, showOperationError } = useTasksContext();
  const navigate = useNavigate();
  const phone = usePhoneLayout();
  const now = useMinuteNow();
  const epoch = useSessionStatusEpoch();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [chartOpen, setChartOpen] = useState(false);
  /** The question the chart opens on (a row menu's move), or none. */
  const [chartStart, setChartStart] = useState<ChartStart | null>(null);
  const openChart = useCallback((start?: ChartStart) => { setChartStart(start ?? null); setChartOpen(true); }, []);

  /** Asks answered from their row, by task: what the task showed then (org-answered.ts). */
  const [answered, setAnswered] = useState<AnsweredHolds>(() => new Map());
  /** Answers that failed, by task: the row is back with the reason (OrgInlineAnswer); a new ask of the task drops it (OrgTaskRail). */
  const [failedAnswers, setFailedAnswers] = useState<ReadonlyMap<string, AnswerFailure>>(() => new Map());
  const allTasks = tasks;
  const tasksNow = useRef(allTasks);
  tasksNow.current = allTasks;
  const answers = useMemo<OrgAnswers>(() => ({
    // The row goes on the click, before the server answers: the hold keeps what the task showed now.
    start: (taskId) => {
      const task = tasksNow.current.find((t) => t.id === taskId);
      const hold = {
        phase: phaseMark(task), source: task?.user_status?.source ?? '', ask: task?.user_status?.ask ?? '',
        probe: task ? promptKey(probe(task)) : '', until: Date.now() + ANSWERED_HOLD_MS,
      };
      setAnswered((prev) => new Map(prev).set(taskId, hold));
      setFailedAnswers((prev) => without(prev, taskId));
      return (failure) => {
        if (!failure) return;
        setAnswered((prev) => (prev.get(taskId) === hold ? without(prev, taskId) : prev));
        setFailedAnswers((prev) => new Map(prev).set(taskId, failure));
      };
    },
    failed: failedAnswers,
    seen: (taskId) => setFailedAnswers((prev) => without(prev, taskId)),
  }), [failedAnswers]);
  // A hold ends when the task asks again or its session's prompt moves (a new ask shows at once).
  useEffect(() => {
    setAnswered((prev) => settleHolds(prev, allTasks, (t) => promptKey(probe(t)), Date.now()));
  }, [allTasks, epoch]);
  // A held answer lapses on its own: the minute clock is too coarse for a one-minute hold.
  useEffect(() => {
    if (!answered.size) return;
    const next = Math.min(...[...answered.values()].map((a) => a.until));
    const id = window.setTimeout(() => setAnswered((prev) => new Map([...prev].filter(([, a]) => a.until > Date.now()))), Math.max(0, next - Date.now()) + 50);
    return () => window.clearTimeout(id);
  }, [answered]);
  const shownTasks = useMemo(() => withAnswered(allTasks, answered, Date.now()), [allTasks, answered]);
  // The prompt it answered is gone at once too, until the session's status catches up.
  const answeredProbe = useMemo<AlertProbe>(() => (task) => {
    const p = probe(task);
    return promptAnswered(answered, task.id, promptKey(p), Date.now()) ? null : p;
  }, [answered]);

  const tree = useMemo(() => buildOrgTree(shownTasks), [shownTasks]);
  // The org's own tasks: Main, the leads, and every task under a project.
  const orgTasks = useMemo(() => {
    const ids = new Set<string>(tree.main ? [tree.main.id] : []);
    for (const p of tree.projects) {
      if (p.lead) ids.add(p.lead.id);
      for (const n of flattenNodes(p.teams)) ids.add(n.id);
    }
    return shownTasks.filter((t) => ids.has(t.id));
  }, [tree, shownTasks]);
  // The status epoch moves on every session's every change: only what the org waits on matters
  // here, so the rows are rebuilt when that changes, not on each streamed line.
  const alertSig = useMemo(
    () => orgTasks.map((t) => { const a = answeredProbe(t); return a ? `${t.id}:${a.kind}:${a.tool ?? ''}` : ''; }).filter(Boolean).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgTasks, epoch, answeredProbe],
  );
  const channels = useMemo(
    () => buildChannels(tree, shownTasks, answeredProbe),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- alertSig stands for the status store
    [tree, shownTasks, alertSig],
  );

  // The status store only knows sessions someone asked about: ask for the org's.
  const orgSessionKey = useMemo(
    () => orgTasks.map((t) => resolveTaskSessionId(t)).filter(Boolean).sort().join(','),
    [orgTasks],
  );
  useEffect(() => {
    if (!orgSessionKey) return;
    void hydrateTaskSessionStatuses(orgTasks.filter((t) => !!resolveTaskSessionId(t)))
      .catch((err) => log.warn('org-page', 'status hydration failed', { error: err instanceof Error ? err.message : String(err) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key is the set
  }, [orgSessionKey]);

  // A bare /org (the sidebar, a reload) opens where this window was (org-place.ts).
  const [restore] = useState(() => (params.get('node') || params.get('open') ? null : placeParams(readOrgPlace())));
  const restoring = useRef(!!restore);
  useLayoutEffect(() => {
    if (!restore) return;
    log.info('org-page', 'place restored', restore);
    setParams(() => {
      const next = liveParams();
      for (const [k, v] of Object.entries(restore)) next.set(k, v);
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the bare first render
  }, []);

  // Until the URL has caught up, the page is already at the restored place (no first lead flashing by).
  const pendingPlace = restoring.current && !params.get('node') && !params.get('open') ? restore : null;
  const nodeParam = params.get('node') ?? pendingPlace?.node ?? null;
  const tabParam = params.get('tab') ?? pendingPlace?.tab ?? null;
  const urlTab = TABS.includes(tabParam as OrgTab) ? (tabParam as OrgTab) : null;
  const selected = pickChannel(channels, nodeParam);
  // On a phone the list shows until a row is picked (and again when the picked one is gone).
  const picked = !!rowOf(channels, nodeParam);
  const showDetail = !phone || picked;
  const visibleRows = useMemo(() => filterChannels(channels.rows, query), [channels.rows, query]);
  const moved = useMemo(() => movedProjects(channels, tasks), [channels, tasks]);
  const openParam = params.get('open') ?? pendingPlace?.open ?? null;
  const side = useMemo(() => parseSideTarget(openParam), [openParam]);

  // The side strip (desktop): the panel `open` names plus the pinned ones. A task and its
  // session are one panel, whichever id named it.
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const sameSession = useCallback<SameSession>((a, b) => {
    const sessionOf = (raw: string): string | null => {
      const t = parseSideTarget(raw);
      if (!t) return null;
      if (t.kind === 'session') return t.id;
      const task = tasksRef.current.find((x) => x.id === t.id);
      return task ? resolveTaskSessionId(task) ?? null : null;
    };
    const sa = sessionOf(a);
    return !!sa && sa === sessionOf(b);
  }, []);
  // Only the pins are state; the free panel is the URL's (orgStripView). A saved id this build
  // cannot read is dropped, never drawn as an empty panel.
  const [pins, setPins] = useState<SessionSlot[]>(() => readColumns('orgColumns').filter((s) => s.locked && !!parseSideTarget(s.id)));
  // `tasks` too: a task's panel and its session's become one once the tasks are known.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const strip = useMemo(() => orgStripView(pins, openParam, sameSession), [pins, openParam, sameSession, tasks]);
  // A phone shows one panel from the URL and never touches the desktop's saved strip.
  const [writeStrip] = useState(() => createStripWriter('orgColumns'));
  useEffect(() => { if (!phone) writeStrip(strip); }, [strip, phone, writeStrip]);
  // Remember the place as the URL moves (not before the URL has caught up with a restore).
  const urlPlaced = !!(params.get('node') || params.get('open'));
  useEffect(() => {
    if (restoring.current && !urlPlaced) return;
    restoring.current = false;
    writeOrgPlace({ node: nodeParam ?? undefined, tab: tabParam ?? undefined, open: openParam ?? undefined });
  }, [nodeParam, tabParam, openParam, urlPlaced]);

  // A phone pushes the pick (Back returns to the list); the desktop replaces it. A new pick
  // closes the side panel: what it showed belonged to the node the user left.
  const select = useCallback((key: string, tab?: OrgTab) => {
    setParams(() => {
      const next = liveParams();
      next.set('node', key);
      if (tab) next.set('tab', tab); else next.delete('tab');
      next.delete('open');
      return next;
    }, phone ? { state: { orgPick: true } } : { replace: true });
  }, [setParams, phone]);
  const back = useCallback(() => {
    if ((window.history.state as { usr?: { orgPick?: boolean } } | null)?.usr?.orgPick) { navigate(-1); return; }
    // Opened straight on a node (a link, a reload): the list is this page's own way back.
    setParams(() => { const next = liveParams(); next.delete('node'); next.delete('tab'); return next; }, { replace: true });
  }, [navigate, setParams]);

  // Only for the node still shown, and keeping the entry's state (a phone's pick marker).
  const shownKey = useRef(selected.key);
  shownKey.current = selected.key;
  const setTab = useCallback((key: string, tab: OrgTab) => {
    if (key !== shownKey.current) return;
    setParams(() => {
      const next = liveParams();
      next.set('node', key);
      next.set('tab', tab);
      return next;
    }, { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [setParams]);

  // The side panel. A phone pushes its first opening (Back closes it); switching what it shows,
  // and the desktop, replace, keeping the entry's state.
  // Both refs move at the click, not at the next render, so two fast clicks push once and go back once.
  const sideOpen = useRef(!!side);
  sideOpen.current = !!side;
  const closing = useRef(false);
  useEffect(() => { closing.current = false; }, [openParam]);
  const openSide = useCallback((t: OrgSideTarget) => {
    log.info('org-page', 'open beside', { kind: t.kind, id: t.id });
    const push = phone && !sideOpen.current;
    sideOpen.current = true;
    setParams(() => {
      const next = liveParams();
      next.set('open', sideTargetParam(t));
      return next;
    }, push
      ? { state: { orgSide: true } }
      : { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [setParams, phone]);
  // Main or a lead named anywhere on the page is a node of the page: it is selected, not opened beside.
  const nodeOf = useCallback((match: (t: Task) => boolean): ChannelRow | undefined => {
    const all = [channels.main, ...channels.rows];
    return all.find((r) => { const t = r.contactId ? tasks.find((x) => x.id === r.contactId) : undefined; return !!t && match(t); });
  }, [channels, tasks]);
  /** A letter's Answer: the task beside the page opens on its session's Inbox tab. */
  const [sideInbox, setSideInbox] = useState<{ taskId: string; n: number } | null>(null);
  const openTask = useCallback((taskId: string, opts?: { inbox?: boolean }) => {
    const node = nodeOf((t) => t.id === taskId);
    // A node lists its own letter on its chat, with Answer there.
    if (node) { select(node.key, opts?.inbox ? 'chat' : undefined); return; }
    setSideInbox(opts?.inbox ? { taskId, n: Date.now() } : null);
    openSide({ kind: 'task', id: taskId });
  }, [nodeOf, select, openSide]);
  const openSession = useCallback((sessionId: string) => {
    const node = nodeOf((t) => resolveTaskSessionId(t) === sessionId);
    if (node) { select(node.key, 'chat'); return; }
    setSideInbox(null);
    openSide({ kind: 'session', id: sessionId });
  }, [nodeOf, select, openSide]);
  const closeSide = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    sideOpen.current = false;
    setSideInbox(null);
    if ((window.history.state as { usr?: { orgSide?: boolean } } | null)?.usr?.orgSide) { navigate(-1); return; }
    setParams(() => { const next = liveParams(); next.delete('open'); return next; },
      { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [navigate, setParams]);

  /** × on one panel of the strip: the free one closes through the URL, a pin leaves the strip. */
  const closePanel = useCallback((id: string) => {
    setPins((cols) => cols.filter((c) => c.id !== id && !sameSession(c.id, id)));
    if (openParam && (id === openParam || sameSession(id, openParam))) closeSide();
  }, [openParam, closeSide, sameSession]);
  /** The lock: the free panel joins the pins; an unlocked pin becomes the free panel (one per page). */
  const togglePanelLock = useCallback((id: string) => {
    const wasPinned = pins.some((c) => c.id === id);
    setPins(orgStripToggleLock(strip, id).filter((c) => c.locked));
    const target = parseSideTarget(id);
    if (wasPinned && target && id !== openParam && !(openParam && sameSession(id, openParam))) openSide(target);
  }, [pins, strip, openParam, sameSession, openSide]);

  /** Talk to a task off this page: its session on home, or a composer bound to it (MainPage). */
  const chatOnHome = useCallback((taskId: string) => {
    log.info('org-page', 'open on home', { taskId });
    window.dispatchEvent(new CustomEvent('org:chat', { detail: { taskId } }));
    navigate('/');
  }, [navigate]);

  const startChat = useCallback(async (row: ChannelRow) => {
    if (row.kind === 'main') { chatOnHome('main'); return; }
    if (row.contactId) { chatOnHome(row.contactId); return; }
    try {
      const answer = await resolveOrgContact(row.project || 'Inbox');
      chatOnHome(answer.task.id);
    } catch (err) {
      showOperationError(`Could not reach ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [chatOnHome, showOperationError]);

  // A right-click on a row: open it on a tab, and move its project the way the chart does
  // (the chart opens on the same question, so a move is confirmed in one place). The menu stays
  // short (2026-10-26, the user: "too messy"): a list of VPs or projects is one row that opens a
  // picker at the cursor, the way a folder menu's Project row does.
  const cards = useMemo(() => vpCards(channels.projects), [channels.projects]);
  const picker = useCursorFlyout<OrgRowPick>();
  const rowMenu = useCallback((target: ChannelMenuTarget, point: CursorPoint, origin: HTMLElement | null): ContextMenuItem[] =>
    orgRowMenu({ target, cards, select, openChart, pick: (p) => picker.open(p, point, origin) }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- picker.open only sets its state
  [cards, select, openChart]);

  // A phone shows one of the three at a time; the opened task covers the rest.
  const phoneView = !phone ? null : side ? 'side' : showDetail ? 'detail' : 'list';

  return (
    <div className={`org-page${phone ? ' is-phone' : ''}${showDetail ? ' shows-detail' : ''}${(phone ? side : strip.length > 0) ? ' shows-side' : ''}`} data-testid="org-page">
      {(!phone || phoneView === 'list') && (
        <OrgChannelList
          main={channels.main}
          rows={visibleRows}
          moved={moved}
          rowMenu={rowMenu}
          total={channels.rows.length}
          selectedKey={phone ? null : selected.key}
          query={query}
          onQuery={setQuery}
          onSelect={select}
          onOpenChart={() => openChart()}
          now={now}
        />
      )}
      {picker.state && (
        <OptionPickerFlyout
          anchorPoint={picker.state.point}
          anchorRef={picker.noTrigger}
          options={picker.state.payload.options}
          current={undefined}
          ariaLabel={picker.state.payload.label}
          onPick={picker.state.payload.onPick}
          onClose={picker.close}
        />
      )}
      {showDetail && (!phone || phoneView === 'detail') && (
        <section className="org-detail-pane" aria-label={selected.name}>
          <OrgNodeDetail
            key={selected.key}
            row={selected}
            rows={channels.rows}
            tasks={shownTasks}
            initialTab={nodeParam === selected.key ? urlTab : null}
            onTabChange={setTab}
            onSelect={select}
            onOpenTask={openTask}
            onOpenSession={openSession}
            answers={answers}
            onStartChat={(row) => { void startChat(row); }}
            {...(phone ? { onBack: back } : {})}
            now={now}
          />
        </section>
      )}
      {phone && side && (
        <OrgSidePanel
          target={side}
          tasks={tasks}
          onClose={closeSide}
          onOpenTask={openTask}
          onOpenSession={openSession}
          onStartChat={chatOnHome}
          {...(side.kind === 'task' && sideInbox?.taskId === side.id ? { inboxRequest: sideInbox.n } : {})}
        />
      )}
      {!phone && strip.length > 0 && (
        <div className={`org-side-strip${strip.length > 1 ? ' is-multi' : ''}`} data-testid="org-side-strip">
          {strip.map((slot) => {
            const target = parseSideTarget(slot.id);
            if (!target) return null;
            return (
              <OrgSidePanel
                key={slot.id}
                target={target}
                tasks={tasks}
                locked={slot.locked}
                onToggleLock={() => togglePanelLock(slot.id)}
                onClose={() => closePanel(slot.id)}
                onOpenTask={openTask}
                onOpenSession={openSession}
                onStartChat={chatOnHome}
                {...(target.kind === 'task' && sideInbox?.taskId === target.id ? { inboxRequest: sideInbox.n } : {})}
              />
            );
          })}
        </div>
      )}
      {chartOpen && (
        <OrgChartSheet
          main={channels.main}
          rows={channels.projects}
          tasks={tasks}
          {...(chartStart ? { startWith: chartStart } : {})}
          onClose={() => { setChartOpen(false); setChartStart(null); }}
          onPick={(key) => select(rowOf(channels, key)?.key ?? key)}
          onOpenTask={openTask}
          now={now}
        />
      )}
    </div>
  );
}
