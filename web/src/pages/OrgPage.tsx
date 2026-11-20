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
 * A task clicked anywhere on the page opens here, in the side panel (useOpenTask ->
 * openTaskHere, which this page answers through onOpenTaskOnPage), as do a session a chat names
 * and a letter's Answer, so the user stays here (a
 * narrow window lays it over the detail). A wide window keeps a strip of side panels:
 * the one `open` names plus the ones the user locked (org-side-columns.ts), saved in the
 * layout record so the pins come back after a restart. On a phone the list, the detail and the
 * opened task take turns. The old org chart (drag to reparent) stays one click away.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useCommittedRef } from '@/hooks/useCommittedRef';
import { useLeanCallback } from '@/hooks/useLeanCallback';
import { ICON_LOCK } from '@/components/common/Icons';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Task } from '@open-walnut/core';
import { useKeptLockToggle } from '@/components/org/useKeptLockToggle';
import { keptByRow, lockedTaskIds, slotTask, slotTaskIds, taskRowKey } from '@/components/org/org-task-tabs';
import { buildOrgTree, userStateOf } from '@open-walnut/org-tree';
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
import { log } from '@/utils/log';
import { beginSessionOpen } from '@/utils/session-open-latency';
import { primeSessionOpenHistory } from '@/api/session-open-prime';
import { OrgChartSheet, type ChartStart } from '@/components/org/OrgChartSheet';
import { useOrgLeaders } from '@/components/org/useOrgLeaders';
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
  adoptLegacyPins, homeLocksFor, homeSlotKey, HOME_OFF_MAX, HOME_OFF_VIEW, orgStripToggleLock, orgStripView, pinsOfNode, readNodeOpen,
  setNodePins, writeNodeOpen, type OrgPin, type SameSession,
} from '@/components/org/org-side-columns';
import { usePageView } from '@/utils/view-memory';
import { isStringArray } from '@/hooks/usePersistentState';
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
import { onOpenOnPage } from '@/utils/taskbar-minimize';
import { onOpenTaskOnPage, type OpenTaskOptions } from '@/utils/open-session';
import { yieldFullscreen } from '@/hooks/useFullscreen';
import '@/styles/org-page.css';

/** The page's own panes (the dividers below): the list, the node between, an opened task. */
const ORG_LIST_DEFAULT_PX = 300;
const ORG_LIST_MIN_PX = 200;
const ORG_LIST_MAX_PX = 480;
const ORG_DETAIL_MIN_PX = 480;
const ORG_SIDE_MIN_PX = 340;
/** Up to this window width an opened task is laid over the node (org-page.css), not a column. */
const ORG_SIDE_OVERLAY_MAX_VW = 1180;
const OVERLAY_QUERY = `(max-width: ${ORG_SIDE_OVERLAY_MAX_VW}px)`;
const overlaysNow = () => typeof window !== 'undefined' && !!window.matchMedia?.(OVERLAY_QUERY).matches;
const onOverlayChange = (cb: () => void) => {
  const mq = typeof window !== 'undefined' ? window.matchMedia?.(OVERLAY_QUERY) : undefined;
  mq?.addEventListener('change', cb);
  return () => mq?.removeEventListener('change', cb);
};

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

/** How soon a failed first load of the tasks is tried again while the Org page shows. */
const FIRST_LOAD_RETRY_MS = 5_000;

export function OrgPage() {
  const { tasks, loading: tasksLoading, error: tasksError, refetch: refetchTasks, showOperationError, update: updateTaskInStore, refetch, predictStatus } = useTasksContext();
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
      // The same reading for every other surface (Home's Needs you, the board, a count): the
      // hold above is this page's; the store's prediction is the page-wide one, and it gives
      // way the moment the server derives the task again.
      const unpredict = predictStatus(taskId, (row) => {
        if (userStateOf(row) !== 'needs') return row.user_status;
        const { ask: _ask, source: _source, ...rest } = row.user_status ?? { state: 'working' as const };
        return { ...rest, state: 'working' as const };
      });
      return (failure) => {
        if (!failure) return;
        unpredict();
        setAnswered((prev) => (prev.get(taskId) === hold ? without(prev, taskId) : prev));
        setFailedAnswers((prev) => new Map(prev).set(taskId, failure));
      };
    },
    failed: failedAnswers,
    seen: (taskId) => setFailedAnswers((prev) => without(prev, taskId)),
  }), [failedAnswers, predictStatus]);
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
  // A first load that failed is no list yet: settling then left the page on Main until it was
  // opened again (2026-11-08). The load is tried again until it lands, and the node settles then.
  const tasksUnknown = tasksLoading || (!!tasksError && tasks.length === 0);
  useEffect(() => {
    if (tasksLoading || !tasksError || tasks.length > 0) return;
    const id = window.setTimeout(refetchTasks, FIRST_LOAD_RETRY_MS);
    return () => window.clearTimeout(id);
  }, [tasksLoading, tasksError, tasks.length, refetchTasks]);
  const [defaultNode, setDefaultNode] = useState<string | null>(null);
  const settledDefault = namedRow ? defaultNode : settleDefaultNode(defaultNode, channels, tasksUnknown);
  if (settledDefault !== defaultNode) setDefaultNode(settledDefault);
  const selected = pickChannel(channels, namedRow ? nodeParam : settledDefault);
  // The node it names has no row until the tasks arrive: show none rather than Main for a moment
  // (a reload drew Main's Task view, then the lead's Threads). The same with no node named.
  const nodeArriving = tasksUnknown && (nodeParam ? !rowOf(channels, nodeParam) : !settledDefault);
  // On a phone the list shows until a row is picked (and again when the picked one is gone).
  const picked = !!rowOf(channels, nodeParam);
  const showDetail = !phone || picked;
  // The chart's cards: the row menu moves projects with them, and the leaders under a row come from them.
  const cards = useMemo(() => vpCards(channels.projects), [channels.projects]);
  const leaders = useOrgLeaders(cards, tasks);
  const filterRows = leaders.filter;
  const visibleRows = useMemo(() => filterRows(channels.rows, query), [filterRows, channels.rows, query]);
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
  // cannot read is dropped, never drawn as an empty panel. Every node's pins are here; the strip
  // shows the selected node's (`shownPins`).
  const [pins, setPins] = useState<OrgPin[]>(() => readColumns('orgColumns').filter((s) => s.locked && !!parseSideTarget(s.id)));
  // Panels a restore brought back (the saved pins, the remembered open panel): one whose session
  // is gone closes itself instead of drawing "Session not found" (SessionPanel onRestoredGone).
  const restoredSide = useRef<Set<string> | null>(null);
  if (!restoredSide.current) restoredSide.current = new Set([...pins.map((s) => s.id), ...(restore?.open ? [restore.open] : [])]);
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
  // Beside a node, the panels locked on Home that belong to it stay locked here too, in Home's order
  // (2026-11-04, the user: "the lock should always show for that vp"; homeLocksFor). One taken off
  // here (its lock or its ×) leaves this page only, never Home's lock, until Home's lock button is pressed on it
  // again (releaseHomeTakeoff).
  // Never pruned on what a mount reads (2026-11-15: a stale read of Home's strip dropped the user's
  // taking-off, and the panel stood beside the node again): it lapses only on Home's lock button.
  const [homeOff, setHomeOff] = usePageView<string[]>('org', HOME_OFF_VIEW, [], isStringArray);
  const rowKeyOf = useMemo(() => taskRowKey(channels.main, channels.rows), [channels.main, channels.rows]);
  // Only where they fit beside the chat: a window that lays side panels over the node never covers its
  // chat with them unasked (the VP: "don't squeeze the chat away"); its kept row still opens one.
  const overlays = useSyncExternalStore(onOverlayChange, overlaysNow, () => false);
  const homeHere = useMemo(
    () => (phone ? [] : homeLocksFor(selected.key, homeLocks, tasks, rowKeyOf, new Set(homeOff))),
    [phone, selected.key, homeLocks, tasks, rowKeyOf, homeOff],
  );
  const fromHome = useMemo(() => (overlays ? [] : homeHere), [overlays, homeHere]);
  // A pin saved before pins had a node, or under a node gone since, goes (once the tasks are known)
  // to the row holding its task.
  useEffect(() => {
    if (tasksUnknown || nodeArriving) return;
    const ownerOf = (id: string) => { const task = slotTask(id, tasks); return task ? rowKeyOf(task) : undefined; };
    const known = (node: string) => rowOf(channels, node)?.key === node;
    setPins((prev) => { const next = adoptLegacyPins(prev, ownerOf, selected.key, known); return next === prev ? prev : [...next]; });
  }, [tasksUnknown, nodeArriving, tasks, rowKeyOf, channels, selected.key]);
  // The pins of the node shown: one locked under another node stands only beside that node. None
  // while the named node is still arriving (the page would draw Main's for a moment).
  const shownPins = useMemo(() => (nodeArriving ? [] : pinsOfNode(pins, selected.key)), [pins, selected.key, nodeArriving]);
  // `sameSession` changes with `tasks`: a task's panel and its session's become one once the tasks are known.
  const strip = useMemo(
    () => orgStripView([...fromHome, ...shownPins.filter((p) => !fromHome.some((h) => h.id === p.id))], openParam, sameSession),
    [fromHome, shownPins, openParam, sameSession],
  );
  // A Home lock taken off this page is no longer listed here as kept either.
  const homeLocksHere = useMemo(() => homeLocks.filter((s) => !homeOff.includes(homeSlotKey(s.id))), [homeLocks, homeOff]);
  const docked = useMemo(() => (!overlays ? [] : homeHere
    .filter((h) => !strip.some((c) => c.id === h.id || sameSession(c.id, h.id)))
    .flatMap((slot) => { const task = slotTask(slot.id, tasks); return task ? [{ slot, task }] : []; })),
  [overlays, homeHere, strip, sameSession, tasks]);
  const lockedIds = useMemo(() => lockedTaskIds([...pins, ...homeLocksHere], shownTasks), [pins, homeLocksHere, shownTasks]);
  // A task only locked hangs under the node it was locked beside (its first pin's), where its panel stands.
  const lockedAt = useMemo(() => {
    const at = new Map<string, string>();
    for (const p of pins) { const task = p.node ? slotTask(p.id, shownTasks) : undefined; if (task && !at.has(task.id)) at.set(task.id, p.node!); }
    return at;
  }, [pins, shownTasks]);

  // A kept row whose task is open beside this page wears a light tint (2026-11-03, the user: no frame,
  // "if this page shows it, highlight its background a little ... very elegant").
  const openTaskIds = useMemo(() => new Set(slotTaskIds(phone ? (openParam ? [{ id: openParam, locked: false }] : []) : strip, shownTasks)), [phone, openParam, strip, shownTasks]);
  // A phone shows one panel from the URL and never touches the desktop's saved strip.
  const [writeStrip] = useState(() => createStripWriter('orgColumns'));
  // The page's own strip only (a panel Home locked is Home's, read again from there), under the node
  // shown, with every other node's pins as they are.
  useEffect(() => {
    // Not while the named node arrives: its pins are not drawn yet, and writing none would drop them.
    if (phone || nodeArriving) return;
    const own = strip.filter((s) => !fromHome.some((h) => h.id === s.id) || shownPins.some((p) => p.id === s.id));
    writeStrip(setNodePins(pins, selected.key, own));
  }, [strip, phone, nodeArriving, writeStrip, fromHome, shownPins, pins, selected.key]);
  // Remember the place as the URL moves (not before the URL has caught up with a restore).
  const urlPlaced = !!(params.get('node') || params.get('open'));
  useEffect(() => {
    if (restoring.current && !urlPlaced) return;
    restoring.current = false;
    writeOrgPlace({ node: nodeParam ?? undefined, tab: tabParam ?? undefined, open: openParam ?? undefined });
  }, [nodeParam, tabParam, openParam, urlPlaced]);
  // Each node keeps its free panel (readNodeOpen): leaving it for another node and coming back shows
  // it again, and so does a link that names the node alone. Only the user's x lets it go (closeSide).
  // Only for the node the URL names, once it is the one shown: a link to a row the list has not
  // brought yet shows the default node meanwhile, and a project its VP leads shows that VP.
  const nodePlaced = !phone && !nodeArriving && !(restoring.current && !urlPlaced) && (!nodeParam || nodeParam === selected.key);
  useEffect(() => {
    if (!nodePlaced) return;
    if (openParam) { writeNodeOpen(selected.key, openParam); return; }
    // Kept for when the window is wide again: laid over the node, it would cover the chat unasked.
    const kept = overlays ? null : readNodeOpen(selected.key);
    if (!kept) return;
    restoredSide.current?.add(kept);
    setParams(() => { const next = liveParams(); next.set('open', kept); return next; },
      { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [nodePlaced, overlays, selected.key, openParam, setParams]);

  // A phone pushes the pick (Back returns to the list); the desktop replaces it. A new pick
  // closes the side panel: what it showed belonged to the node the user left.
  const select = useCallback((key: string, tab?: OrgTab) => {
    // rowOf answers a led project's VP row, so the project's own row is looked up in it.
    const row = rowOf(channelsRef.current, key);
    const contactId = (row?.key === key ? row : row?.led?.find((l) => l.key === key))?.contactId;
    const contact = contactId ? tasks.find((t) => t.id === contactId) : undefined;
    const sid = contact ? resolveTaskSessionId(contact) : null;
    if (sid) { beginSessionOpen(sid, 'org-node'); primeSessionOpenHistory(sid); }
    // The person picked a node: record the task it represents.
    recordTaskOpened(contactId);
    setParams(() => {
      const next = liveParams();
      next.set('node', key);
      next.delete('router_setup');
      if (tab) next.set('tab', tab); else next.delete('tab');
      // The node's own free panel comes back with it (readNodeOpen); a phone shows the node alone, and
      // a window that lays side panels over the node never covers its chat with one unasked.
      const kept = phone || overlays || rowOf(channelsRef.current, key)?.key !== key ? null : readNodeOpen(key);
      if (kept) { restoredSide.current?.add(kept); next.set('open', kept); } else next.delete('open');
      return next;
    }, phone ? { state: { orgPick: true } } : { replace: true });
  }, [setParams, phone, overlays, channelsRef, tasks]);
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
  // Main or a lead named anywhere on the page is a node of the page: its letter or session selects it,
  // not a second copy beside the page. A self router is still its project's work: opened beside.
  const nodeOf = useCallback((match: (t: Task) => boolean): ChannelRow | undefined => {
    const all = [channels.main, ...channels.rows, ...channels.routers.filter((r) => !r.selfRouter)];
    return all.find((r) => { const t = r.contactId ? tasks.find((x) => x.id === r.contactId) : undefined; return !!t && match(t); });
  }, [channels, tasks]);
  /** A letter's Answer: the task beside the page opens on its session's Inbox tab. */
  const [sideInbox, setSideInbox] = useState<{ taskId: string; n: number } | null>(null);
  /** Answer on another task's letter (OrgNodeDetail's alert rows): the task opens beside the page
   *  on its session's Inbox tab. */
  const openLetterOf = useCallback((taskId: string) => {
    const node = nodeOf((t) => t.id === taskId);
    // A node lists its own letter on its chat, with Answer there.
    if (node) { select(node.key, 'chat'); return; }
    setSideInbox({ taskId, n: Date.now() });
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
  /** A task clicked anywhere on this page (a chat's pill, a thread's chip, a Tasks row, a Board card,
   *  the Brief, a notice, search): it opens here, never on Home (2026-11-15, the user: "if we click in
   *  te org seciton the taks need ot open in org that is only difference, all other page go to home").
   *  Main or a lead is a node of the page and is selected; any other task opens beside the page. */
  const openTaskOnOrg = useLeanCallback((taskId: string, opts?: OpenTaskOptions) => {
    // A full-screen sheet (a node's chat, its side bar) would cover what opens: leave it first.
    yieldFullscreen('org-open-task');
    if (opts?.sessionId) { openSession(opts.sessionId); return; }
    const node = nodeOf((t) => t.id === taskId);
    // The node already shown keeps its tab and its side panel (a pill of its own task in its chat).
    if (node) { if (node.key !== shownKey.current) select(node.key); return; }
    setSideInbox(null);
    recordTaskOpened(taskId);
    openSide({ kind: 'task', id: taskId });
  }, [openSession, nodeOf, select, openSide]);
  useEffect(() => onOpenTaskOnPage(openTaskOnOrg), [openTaskOnOrg]);
  // A chip on the app's taskbar opens here the way the page opens any session (AppTaskbar.tsx):
  // a node's own chat selects its node, never a second copy beside the page.
  useEffect(() => onOpenOnPage(openSession), [openSession]);
  const closeSide = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    sideOpen.current = false;
    setSideInbox(null);
    // The user closed the node's free panel: it no longer comes back with the node. (A phone keeps
    // none, and its × never closes the one a wide window keeps.)
    if (!phone) writeNodeOpen(shownKey.current, null);
    if ((window.history.state as { usr?: { orgSide?: boolean } } | null)?.usr?.orgSide) { navigate(-1); return; }
    setParams(() => { const next = liveParams(); next.delete('open'); return next; },
      { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [navigate, setParams, phone]);

  /** The Home locks a panel of the strip shows (one, or none for the page's own). */
  const homeIdsOf = useLeanCallback((id: string) => fromHome.filter((h) => h.id === id || sameSession(h.id, id)).map((h) => h.id), [fromHome, sameSession]);
  /** × on one panel of the strip: the free one closes through the URL, a pin leaves the strip. */
  const closePanel = useCallback((id: string) => {
    restoredSide.current?.delete(id);
    const home = homeIdsOf(id);
    if (home.length) setHomeOff([...homeOff, ...home.filter((h) => !homeOff.includes(h))].slice(-HOME_OFF_MAX));
    const node = selected.key;
    setPins((cols) => cols.filter((c) => c.node !== node || (c.id !== id && !sameSession(c.id, id))));
    if (openParam && (id === openParam || sameSession(id, openParam))) closeSide();
  }, [openParam, closeSide, sameSession, homeIdsOf, homeOff, setHomeOff, selected.key]);
  const restoredGone = (id: string, close: () => void) => (restoredSide.current?.has(id) ? { onRestoredGone: close } : {});
  /** The lock: the free panel joins the pins; an unlocked pin becomes the free panel (one per page). */
  const togglePanelLock = useCallback((id: string) => {
    // A panel Home locked: unlocked here, it leaves this page (the VP: "unlocking on Org only takes it
    // off here"); Home keeps its own lock.
    if (homeIdsOf(id).length && strip.some((c) => c.id === id && c.locked)) { closePanel(id); return; }
    const wasPinned = shownPins.some((c) => c.id === id);
    const node = selected.key;
    const here = orgStripToggleLock(strip, id).filter((c) => c.locked);
    setPins((prev) => setNodePins(prev, node, here));
    const target = parseSideTarget(id);
    if (wasPinned && target && id !== openParam && !(openParam && sameSession(id, openParam))) openSide(target);
  }, [shownPins, strip, openParam, sameSession, openSide, homeIdsOf, closePanel, selected.key]);

  // A kept row's lock unlocks and locks again like the panel's own (useKeptLockToggle); a row
  // unlocked there stays, with an open lock, until the page closes.
  const keptLock = useKeptLockToggle({ tasks: shownTasks, locked: lockedIds, pins, setPins, homeLocks: homeLocksHere, homeOff, setHomeOff, strip, togglePanelLock });
  const kept = useMemo(
    () => keptByRow(channels.main, channels.rows, shownTasks, lockedIds, lockedAt, keptLock.relockable),
    [channels.main, channels.rows, shownTasks, lockedIds, lockedAt, keptLock.relockable],
  );
  const keptOf = useCallback((row: ChannelRow) => kept.get(row.key) ?? [], [kept]);

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
          onToggleLock={keptLock.toggle}
          onUnwatch={unwatch}
          {...(leaders.leadersOf ? { leadersOf: leaders.leadersOf } : {})}
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
            onOpenLetterOf={openLetterOf}
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
          {...restoredGone(sideTargetParam(side), () => { restoredSide.current?.delete(sideTargetParam(side)); closeSide(); })}
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
                {...restoredGone(slot.id, () => closePanel(slot.id))}
                onOpenSession={openSession}
                onStartChat={chatOnHome}
                {...(target.kind === 'task' && sideInbox?.taskId === target.id ? { inboxRequest: sideInbox.n } : {})}
              />
            );
          })}
        </div>
      )}
      {/* Too narrow to stand beside the chat: each one waits as a slim tab at the right edge, one click
          opens it (the chat keeps its room, as on Home, where columns never cover the chat). */}
      {docked.length > 0 && (
        <div className="org-locked-dock" role="group" aria-label="Locked on Home" data-testid="org-locked-dock">
          {docked.map(({ slot, task }) => (
            <button key={slot.id} type="button" className="org-locked-dock-item" data-peek-row="" data-testid="org-locked-dock-item" data-id={slot.id}
              title={`${task.title}: locked on Home. Open it`} onClick={() => { const t = parseSideTarget(slot.id); if (t) openSide(t); }}>
              {ICON_LOCK}<span className="org-locked-dock-label">{task.title}</span>
            </button>
          ))}
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
        />
      )}
    </div>
  );
}
