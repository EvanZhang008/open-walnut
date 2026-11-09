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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { keptByRow, lockedTaskIds, slotTaskIds } from '@/components/org/org-task-tabs';
import { buildOrgTree } from '@open-walnut/org-tree';
import { useTasksContext } from '@/contexts/TasksContext';
import { useSessionStatusEpoch } from '@/hooks/useSessionStatus';
import { homeColumnsField, usePhoneLayout } from '@/hooks/usePhoneLayout';
import { hydrateTaskSessionStatuses } from '@/api/sessions';
import { resolveOrgContact, ensureMainTask, startOrgNode } from '@/api/org';
import { fetchTask } from '@/api/tasks';
import { sessionStatusStore } from '@/stores/session-status-store';
import { resolveTaskSessionId } from '@/utils/session-status';
import { createStripWriter, readColumns } from '@/utils/layout-record';
import { recordTaskOpened } from '@/utils/recent-opened';
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
  MAIN_KEY, buildChannels, filterChannels, flattenNodes, movedProjects, pickChannel, projectRowKey, rowOf, settleDefaultNode, vpCount, type AlertProbe, type ChannelRow,
} from '@/components/org/org-channels-model';
import {
  ANSWERED_HOLD_MS, phaseMark, promptAnswered, promptKey, settleHolds, withAnswered, without, type AnsweredHolds,
} from '@/components/org/org-answered';
import { OrgPaneHandle } from '@/components/org/OrgPaneHandle';
import { OrgRouterSetup } from '@/components/org/OrgRouterSetup';
import { useResizablePanel } from '@/hooks/useResizablePanel';
import { useRouterAreaNames } from '@/components/org/router-area-names';
import '@/styles/org-page.css';

/** The page's own panes (the dividers below): the list, the node between, an opened task. */
const ORG_LIST_DEFAULT_PX = 300;
const ORG_LIST_MIN_PX = 200;
const ORG_LIST_MAX_PX = 480;
const ORG_DETAIL_MIN_PX = 480;
const ORG_SIDE_MIN_PX = 340;
/** Up to this window width an opened task is laid over the node (org-page.css), not a column. */
const ORG_SIDE_OVERLAY_MAX_VW = 1180;

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
  const { tasks, loading: tasksLoading, showOperationError, update: updateTaskInStore, refetch } = useTasksContext();
  const navigate = useNavigate();
  const phone = usePhoneLayout();
  const now = useMinuteNow();
  const epoch = useSessionStatusEpoch();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [chartOpen, setChartOpen] = useState(false);
  const [routerSetup, setRouterSetup] = useState(() => params.get('router_setup') === '1');
  /** The question the chart opens on (a row menu's move), or none. */
  const [chartStart, setChartStart] = useState<ChartStart | null>(null);
  const openChart = useCallback((start?: ChartStart) => { setChartStart(start ?? null); setChartOpen(true); }, []);

  /** Asks answered from their row, by task: what the task showed then (org-answered.ts). */
  const [answered, setAnswered] = useState<AnsweredHolds>(() => new Map());
  /** Answers that failed, by task: the row is back with the reason (OrgInlineAnswer); a new ask of the task drops it (OrgTaskRail). */
  const [failedAnswers, setFailedAnswers] = useState<ReadonlyMap<string, AnswerFailure>>(() => new Map());
  const allTasks = tasks;
  const tasksNow = useCommittedRef(allTasks);
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
  // Stopping a watch from the Org list: Home's eye, the same write (WatchToggle), shown on the click.
  const unwatch = useCallback((taskId: string) => { void updateTaskInStore(taskId, { watched_at: '' }); }, [updateTaskInStore]);
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
    for (const router of tree.routers ?? []) ids.add(router.id);
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
  // A router row names its area ("Personal"), not the area's id.
  const routerAreaIds = useMemo(
    () => [...new Set(shownTasks.filter((t) => t.org_role === 'router' && t.router_area_id).map((t) => t.router_area_id as string))],
    [shownTasks],
  );
  const areaNames = useRouterAreaNames(routerAreaIds);
  const channels = useMemo(
    () => buildChannels(tree, shownTasks, answeredProbe, areaNames),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- alertSig stands for the status store
    [tree, shownTasks, alertSig, areaNames],
  );
  // For callbacks that must stay stable across org updates (select: the row menu memo holds it).
  const channelsRef = useCommittedRef(channels);

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
  // With no node named (or one whose row is gone), the default is picked once the tasks are in and
  // then stays (settleDefaultNode).
  const namedRow = !!nodeParam && !!rowOf(channels, nodeParam);
  const [defaultNode, setDefaultNode] = useState<string | null>(null);
  const settledDefault = namedRow ? defaultNode : settleDefaultNode(defaultNode, channels, tasksLoading);
  if (settledDefault !== defaultNode) setDefaultNode(settledDefault);
  const selected = pickChannel(channels, namedRow ? nodeParam : settledDefault);
  // The node it names has no row until the tasks arrive: show none rather than Main for a moment
  // (a reload drew Main's Task view, then the lead's Threads). The same with no node named.
  const nodeArriving = tasksLoading && (nodeParam ? !rowOf(channels, nodeParam) : !settledDefault);
  // On a phone the list shows until a row is picked (and again when the picked one is gone).
  const picked = !!rowOf(channels, nodeParam);
  const showDetail = !phone || picked;
  const visibleRows = useMemo(() => filterChannels(channels.rows, query), [channels.rows, query]);
  const moved = useMemo(() => movedProjects(channels, tasks), [channels, tasks]);
  const openParam = params.get('open') ?? pendingPlace?.open ?? null;
  const side = useMemo(() => parseSideTarget(openParam), [openParam]);

  // The side strip (desktop): the panel `open` names plus the pinned ones. A task and its
  // session are one panel, whichever id named it.
  // A closure over `tasks`, never a ref: the strip's memo calls it during render, where a ref
  // holds the last committed list (useCommittedRef) and missed the tasks this render brought.
  const sameSession = useCallback<SameSession>((a, b) => {
    const sessionOf = (raw: string): string | null => {
      const t = parseSideTarget(raw);
      if (!t) return null;
      if (t.kind === 'session') return t.id;
      const task = tasks.find((x) => x.id === t.id);
      return task ? resolveTaskSessionId(task) ?? null : null;
    };
    const sa = sessionOf(a);
    return !!sa && sa === sessionOf(b);
  }, [tasks]);
  // Only the pins are state; the free panel is the URL's (orgStripView). A saved id this build
  // cannot read is dropped, never drawn as an empty panel.
  const [pins, setPins] = useState<SessionSlot[]>(() => readColumns('orgColumns').filter((s) => s.locked && !!parseSideTarget(s.id)));
  // `sameSession` changes with `tasks`: a task's panel and its session's become one once the tasks are known.
  const strip = useMemo(() => orgStripView(pins, openParam, sameSession), [pins, openParam, sameSession]);
  // Under each row of the list, the tasks the user keeps in view there: the watched ones (Home's
  // Watching) and the ones whose session panel is locked, on Home (this window's strip, read from the
  // saved layout: another window's lock arrives with `storage`, and coming back to the page reads it
  // again) or beside this page (live).
  const [homeLocks, setHomeLocks] = useState(() => readColumns(homeColumnsField()));
  useEffect(() => {
    const reread = () => setHomeLocks((prev) => {
      const next = readColumns(homeColumnsField());
      return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
    });
    const onVisible = () => { if (document.visibilityState === 'visible') reread(); };
    window.addEventListener('storage', reread);
    window.addEventListener('focus', reread);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('storage', reread);
      window.removeEventListener('focus', reread);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const lockedIds = useMemo(() => lockedTaskIds([...pins, ...homeLocks], shownTasks), [pins, homeLocks, shownTasks]);
  const kept = useMemo(() => keptByRow(channels.main, channels.rows, shownTasks, lockedIds), [channels.main, channels.rows, shownTasks, lockedIds]);
  const keptOf = useCallback((row: ChannelRow) => kept.get(row.key) ?? [], [kept]);
  // A kept row whose task is open beside this page wears a light tint (2026-11-03, the user: no frame,
  // "if this page shows it, highlight its background a little ... very elegant").
  const openTaskIds = useMemo(() => new Set(slotTaskIds(phone ? (openParam ? [{ id: openParam, locked: false }] : []) : strip, shownTasks)), [phone, openParam, strip, shownTasks]);
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
    // An open for Home's Recent tab (utils/recent-opened.ts); Main is left out, it is always at hand.
    // rowOf answers a led project's VP row, so the project's own row is looked up in it.
    if (key !== MAIN_KEY) {
      const row = rowOf(channelsRef.current, key);
      recordTaskOpened((row?.key === key ? row : row?.led?.find((l) => l.key === key))?.contactId);
    }
    setParams(() => {
      const next = liveParams();
      next.set('node', key);
      next.delete('router_setup');
      if (tab) next.set('tab', tab); else next.delete('tab');
      next.delete('open');
      return next;
    }, phone ? { state: { orgPick: true } } : { replace: true });
  }, [setParams, phone, channelsRef]);
  const back = useCallback(() => {
    if ((window.history.state as { usr?: { orgPick?: boolean } } | null)?.usr?.orgPick) { navigate(-1); return; }
    // Opened straight on a node (a link, a reload): the list is this page's own way back.
    setParams(() => { const next = liveParams(); next.delete('node'); next.delete('tab'); return next; }, { replace: true });
  }, [navigate, setParams]);

  // Only for the node still shown, and keeping the entry's state (a phone's pick marker).
  const shownKey = useRef(selected.key);
  shownKey.current = selected.key;
  // The node opened the view the URL named (OrgNodeDetail): the URL lets go of it, so a reload
  // comes back to the view the node was left on, not to the one a link once named.
  const tabUsed = useCallback((key: string) => {
    if (key !== shownKey.current) return;
    setParams(() => {
      const next = liveParams();
      next.delete('tab');
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
    const all = [channels.main, ...channels.rows, ...channels.routers];
    return all.find((r) => { const t = r.contactId ? tasks.find((x) => x.id === r.contactId) : undefined; return !!t && match(t); });
  }, [channels, tasks]);
  /** A letter's Answer: the task beside the page opens on its session's Inbox tab. */
  const [sideInbox, setSideInbox] = useState<{ taskId: string; n: number } | null>(null);
  const openTask = useCallback((taskId: string, opts?: { inbox?: boolean }) => {
    const node = nodeOf((t) => t.id === taskId);
    // A node lists its own letter on its chat, with Answer there.
    if (node) { select(node.key, opts?.inbox ? 'chat' : undefined); return; }
    setSideInbox(opts?.inbox ? { taskId, n: Date.now() } : null);
    recordTaskOpened(taskId);
    openSide({ kind: 'task', id: taskId });
  }, [nodeOf, select, openSide]);
  const openSession = useCallback((sessionId: string) => {
    const node = nodeOf((t) => resolveTaskSessionId(t) === sessionId);
    if (node) { select(node.key, 'chat'); return; }
    setSideInbox(null);
    recordTaskOpened(tasks.find((t) => resolveTaskSessionId(t) === sessionId)?.id);
    openSide({ kind: 'session', id: sessionId });
  }, [nodeOf, select, openSide, tasks]);
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

  /** Start a node that has no session, here (src/core/org/org-autostart.ts): it runs in the
   *  background and its chat opens in place, so nothing navigates (2026-11-03). */
  const startChat = useCallback(async (row: ChannelRow) => {
    log.info('org-page', 'start node in place', { node: row.key, taskId: row.contactId });
    try {
      if (row.contactId) await startOrgNode(row.contactId, false);
      else if (row.kind === 'main') {
        // Made here (null on a replica, where Main lives on the primary), then started in place.
        const main = await ensureMainTask();
        if (main) await startOrgNode(main.id, false);
      } else {
        // A project with no VP: the server makes its lead when it has two teams, started here.
        const contact = await resolveOrgContact(row.project || 'Inbox');
        if (contact.kind === 'lead') await startOrgNode(contact.task.id, false);
      }
    } catch (err) {
      showOperationError(`Could not start ${row.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [showOperationError]);

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

  // The two dividers of the page itself (2026-11-02, the user, pointing at the line before an opened
  // task: "this line need ot move the bar"): the list's right edge and the opened tasks' left edge,
  // each dragged, kept (an `open-walnut-` key, synced) and reset by a double-click. Until the user
  // sets one the page keeps its own CSS width. The node between keeps ORG_DETAIL_MIN_PX; the list
  // stays within 200 to 480px, an opened task at least 340px.
  const pageRef = useRef<HTMLDivElement>(null);
  const vw = () => window.innerWidth || 1;
  const elOf = (sel: string) => pageRef.current?.querySelector(sel) as HTMLElement | null;
  const shownOf = (sel: string) => { const el = elOf(sel); return el ? (el.offsetWidth / vw()) * 100 : null; };
  const listBounds = () => {
    // A window too narrow for a column lays the opened task over the node (org-page.css): no room taken.
    const strip = window.innerWidth > ORG_SIDE_OVERLAY_MAX_VW ? elOf('.org-side-strip')?.offsetWidth ?? 0 : 0;
    const room = (pageRef.current?.clientWidth ?? 0) - strip - ORG_DETAIL_MIN_PX;
    return { min: (ORG_LIST_MIN_PX / vw()) * 100, max: (Math.max(ORG_LIST_MIN_PX, Math.min(ORG_LIST_MAX_PX, room)) / vw()) * 100 };
  };
  const listWidth = useResizablePanel('open-walnut-org-list-w', (ORG_LIST_DEFAULT_PX / vw()) * 100, 'left',
    { bounds: listBounds, measure: () => shownOf('.org-list') });
  const sideBounds = () => {
    const page = pageRef.current?.clientWidth ?? 0;
    const room = Math.min(page * 0.7, page - (elOf('.org-list')?.offsetWidth ?? 0) - ORG_DETAIL_MIN_PX);
    return { min: (ORG_SIDE_MIN_PX / vw()) * 100, max: (Math.max(ORG_SIDE_MIN_PX, room) / vw()) * 100 };
  };
  // One opened task and two or more side by side keep their own width: closing one of two must not
  // leave the last one twice as wide.
  const sideOpts = { bounds: sideBounds, measure: () => shownOf('.org-side-strip') };
  const sideOne = useResizablePanel('open-walnut-org-side-w', 34, 'right', sideOpts);
  const sideMany = useResizablePanel('open-walnut-org-side-w-multi', 52, 'right', sideOpts);
  const sideWidth = strip.length > 1 ? sideMany : sideOne;
  const pageVars = phone ? undefined : {
    ...(listWidth.custom ? { '--org-list-w': `clamp(${ORG_LIST_MIN_PX}px, ${listWidth.pct}vw, ${ORG_LIST_MAX_PX}px)` } : {}),
    ...(sideWidth.custom ? { '--org-side-w': `${sideWidth.pct}vw` } : {}),
  } as CSSProperties;

  // A phone shows one of the three at a time; the opened task covers the rest.
  const phoneView = !phone ? null : side ? 'side' : showDetail ? 'detail' : 'list';

  return (
    <div ref={pageRef} className={`org-page${phone ? ' is-phone' : ''}${showDetail ? ' shows-detail' : ''}${(phone ? side : strip.length > 0) ? ' shows-side' : ''}`} style={pageVars} data-testid="org-page">
      {(!phone || phoneView === 'list') && (
        <OrgChannelList
          main={channels.main}
          rows={visibleRows}
          routers={filterChannels(channels.routers, query)}
          moved={moved}
          rowMenu={rowMenu}
          total={channels.rows.length}
          vps={vpCount(channels.rows)}
          selectedKey={phone ? null : selected.key}
          query={query}
          onQuery={setQuery}
          onSelect={select}
          onOpenChart={() => openChart()}
          onNewRouter={() => setRouterSetup(true)}
          keptOf={keptOf}
          openTaskIds={openTaskIds}
          onOpenTask={openTask}
          onUnwatch={unwatch}
          now={now}
        />
      )}
      {!phone && (
        <OrgPaneHandle
          className="org-list-handle"
          testId="org-list-handle"
          label="List width"
          panel={listWidth}
          bounds={listBounds}
          onReset={listWidth.reset}
          roomRef={pageRef}
          shownPct={() => shownOf('.org-list')}
          panelSide="left"
          elRef={(el) => { listWidth.panelRef.current = el; }}
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
        <section className="org-detail-pane" aria-label={selected.name} aria-busy={nodeArriving || undefined}>
          {routerSetup && <OrgRouterSetup tasks={tasks} onCancel={() => { setRouterSetup(false); setParams(() => { const next = liveParams(); next.delete('router_setup'); return next; }, { replace: true }); }} onDone={(id) => { setRouterSetup(false); refetch(); select(`router:${id}`); }} />}
          {!nodeArriving && !routerSetup && <OrgNodeDetail
            key={selected.key}
            row={selected}
            rows={channels.rows}
            tasks={shownTasks}
            initialTab={nodeParam === selected.key ? urlTab : null}
            onTabUsed={tabUsed}
            onSelect={select}
            onOpenTask={openTask}
            onOpenSession={openSession}
            answers={answers}
            onStartChat={(row) => { void startChat(row); }}
            tasksLoading={tasksLoading}
            {...(phone ? { onBack: back } : {})}
            now={now}
          />}
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
        <OrgPaneHandle
          className="org-side-handle"
          testId="org-side-handle"
          label="Opened task width"
          panel={sideWidth}
          bounds={sideBounds}
          onReset={sideWidth.reset}
          roomRef={pageRef}
          shownPct={() => shownOf('.org-side-strip')}
          panelSide="right"
          elRef={(el) => { sideOne.panelRef.current = el; sideMany.panelRef.current = el; }}
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
          routers={channels.routers}
          tasks={tasks}
          {...(chartStart ? { startWith: chartStart } : {})}
          onClose={() => { setChartOpen(false); setChartStart(null); }}
          onPick={(key) => select(rowOf(channels, key)?.key ?? key)}
          onOpenTask={openTask}
        />
      )}
    </div>
  );
}
