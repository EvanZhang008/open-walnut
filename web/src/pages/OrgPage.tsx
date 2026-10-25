/**
 * /org: Main and the project leads, one page (the sidebar's Org).
 *
 *   ┌ list ──────────┬ detail ─────────────────────────────────┐
 *   │ Main (pinned)   │ the selected node: counts, Latest,       │
 *   │ Leads · N       │ Needs you, Board | Team | Chat, composer │
 *   │  one row each   │                                          │
 *   └─────────────────┴──────────────────────────────────────────┘
 *
 * Everything is live from the browser's stores: the org tree is built from the
 * task store with the server's own function (@open-walnut/org-tree), and what
 * waits on a prompt comes from the session status store. The selection and tab
 * ride the URL (?node=…&tab=…), so a reload or Back keeps them. On a phone the
 * list and the detail take turns. The old org chart (drag to reparent) stays one
 * click away.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { log } from '@/utils/log';
import { OrgChartSheet } from '@/components/org/OrgChartSheet';
import { OrgChannelList } from '@/components/org/OrgChannelList';
import { OrgNodeDetail, type OrgTab } from '@/components/org/OrgNodeDetail';
import {
  MAIN_KEY, buildChannels, filterChannels, flattenNodes, pickChannel, projectRowKey, type AlertProbe, type ChannelRow,
} from '@/components/org/org-channels-model';
import '@/styles/org-page.css';

const TABS: readonly OrgTab[] = ['board', 'team', 'chat'];

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

  const tree = useMemo(() => buildOrgTree(tasks), [tasks]);
  // The org's own tasks: Main, the leads, and every task under a project.
  const orgTasks = useMemo(() => {
    const ids = new Set<string>(tree.main ? [tree.main.id] : []);
    for (const p of tree.projects) {
      if (p.lead) ids.add(p.lead.id);
      for (const n of flattenNodes(p.teams)) ids.add(n.id);
    }
    return tasks.filter((t) => ids.has(t.id));
  }, [tree, tasks]);
  // The status epoch moves on every session's every change: only what the org waits on matters
  // here, so the rows are rebuilt when that changes, not on each streamed line.
  const alertSig = useMemo(
    () => orgTasks.map((t) => { const a = probe(t); return a ? `${t.id}:${a.kind}:${a.tool ?? ''}` : ''; }).filter(Boolean).join('|'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orgTasks, epoch],
  );
  const channels = useMemo(
    () => buildChannels(tree, tasks, probe),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- alertSig stands for the status store
    [tree, tasks, alertSig],
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

  const nodeParam = params.get('node');
  const tabParam = params.get('tab');
  const urlTab = TABS.includes(tabParam as OrgTab) ? (tabParam as OrgTab) : null;
  const selected = pickChannel(channels, nodeParam);
  // On a phone the list shows until a row is picked (and again when the picked one is gone).
  const picked = nodeParam === MAIN_KEY || channels.rows.some((r) => r.key === nodeParam);
  const showDetail = !phone || picked;
  const visibleRows = useMemo(() => filterChannels(channels.rows, query), [channels.rows, query]);

  // A phone pushes the pick (Back returns to the list); the desktop replaces it.
  const select = useCallback((key: string) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('node', key);
      next.delete('tab');
      return next;
    }, phone ? { state: { orgPick: true } } : { replace: true });
  }, [setParams, phone]);
  const back = useCallback(() => {
    if ((window.history.state as { usr?: { orgPick?: boolean } } | null)?.usr?.orgPick) { navigate(-1); return; }
    // Opened straight on a node (a link, a reload): the list is this page's own way back.
    setParams((prev) => { const next = new URLSearchParams(prev); next.delete('node'); next.delete('tab'); return next; }, { replace: true });
  }, [navigate, setParams]);

  // Only for the node still shown, and keeping the entry's state (a phone's pick marker).
  const shownKey = useRef(selected.key);
  shownKey.current = selected.key;
  const setTab = useCallback((key: string, tab: OrgTab) => {
    if (key !== shownKey.current) return;
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('node', key);
      next.set('tab', tab);
      return next;
    }, { replace: true, state: (window.history.state as { usr?: unknown } | null)?.usr ?? null });
  }, [setParams]);

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

  // The chart's Chat: a node on this page is selected here (a lead it just made too,
  // by its project, before the store has it); any other task opens on home.
  const chartChat = useCallback(async (taskId: string | 'main') => {
    setChartOpen(false);
    if (taskId === 'main') { select(MAIN_KEY); return; }
    const row = channels.rows.find((r) => r.contactId === taskId);
    if (row) { select(row.key); return; }
    const task = tasks.find((t) => t.id === taskId) ?? await fetchTask(taskId).catch(() => undefined);
    if (task?.org_role === 'lead') { select(projectRowKey(task.project ?? '')); return; }
    chatOnHome(taskId);
  }, [channels.rows, tasks, select, chatOnHome]);

  return (
    <div className={`org-page${phone ? ' is-phone' : ''}${showDetail ? ' shows-detail' : ''}`} data-testid="org-page">
      {(!phone || !showDetail) && (
        <OrgChannelList
          main={channels.main}
          rows={visibleRows}
          total={channels.rows.length}
          selectedKey={phone ? null : selected.key}
          query={query}
          onQuery={setQuery}
          onSelect={select}
          onOpenChart={() => setChartOpen(true)}
          now={now}
        />
      )}
      {showDetail && (
        <section className="org-detail-pane" aria-label={selected.name}>
          <OrgNodeDetail
            key={selected.key}
            row={selected}
            rows={channels.rows}
            tasks={tasks}
            initialTab={nodeParam === selected.key ? urlTab : null}
            onTabChange={setTab}
            onSelect={select}
            onOpenTask={chatOnHome}
            onStartChat={(row) => { void startChat(row); }}
            {...(phone ? { onBack: back } : {})}
            now={now}
          />
        </section>
      )}
      {chartOpen && <OrgChartSheet onClose={() => setChartOpen(false)} onChat={(id) => { void chartChat(id); }} />}
    </div>
  );
}
