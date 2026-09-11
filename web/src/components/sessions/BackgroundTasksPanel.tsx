/**
 * BackgroundTasksPanel — the "Background tasks" reader, Claude Code desktop style.
 *
 * Two columns. Left: every background job of the session, split into Running and
 * Finished, one row per job (title, subagent type, `Agent · elapsed · tokens · tool
 * uses · what it is doing`). Right: the selected agent's transcript, live-refreshing
 * while it runs. Clicking a row switches the right column; the first running agent
 * is selected on open unless the caller names one.
 *
 * The chat never shows individual agents: its `N running tasks` chip
 * (BackgroundTasksChip) opens this panel, and so does the pinned Background bar's
 * "View transcript". The panel is rendered by `BackgroundTasksPanelHost` (one per
 * session panel, always mounted) off the background-panel store, so it survives the
 * chip that opened it being replaced (stream chip → history chip at turn end). The row set is the union of two sources: the live ledger
 * (what the CLI process reports) and the agents the caller
 * already knows from the conversation (the Agent tool calls in history or in the
 * stream). The ledger arrives through the background-agents store (published by the
 * pinned bar, which is always mounted), so opening the panel costs no fetch and
 * misses nothing. The ledger row wins when both know an agent; a session whose CLI process
 * is gone still lists its agents from history, with their transcripts readable.
 */

import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';
import { isAgentTask } from './workflow-layout';
import { buildAgentMeta, fmtElapsed, rowElapsedMs } from './background-ledger';
import { StatusDot } from './WorkflowGraph';
import { agentModelLabel } from './SessionMessage';
import { TranscriptBody } from './WorkflowTranscriptModal';
import { ICON_CLOSE } from '../common/Icons';
import type { SessionHistoryMessage } from '@/types/session';
import { useLiveAgentsForSession, useLiveTasksForSession, type LiveAgentStatus } from '@/stores/background-agents-store';
import { openBackgroundPanel, closeBackgroundPanel, registerKnownAgents, unregisterKnownAgents, useBackgroundPanelOpen, useKnownAgents, useLiveLanes } from '@/stores/background-panel-store';

/** An agent the conversation knows about (an Agent tool call), independent of the ledger. */
export interface KnownAgent {
  toolUseId?: string;
  /** Subagent id when the parser learned it (the hex id the transcript endpoint reads). */
  agentId?: string;
  description: string;
  subagentType?: string;
  /** Proven finished by the conversation itself (tool_result settled / task-notification). */
  finished: boolean;
  /** Proven in flight by the conversation itself (a stream tool_call not yet settled). */
  running?: boolean;
  /** The tool_use settled with an error (stream status `error`). */
  failed?: boolean;
  /** Tool result text: the reader's fallback when no transcript can be fetched. */
  result?: string;
  promptInput?: Record<string, unknown>;
  preloaded?: SessionHistoryMessage[];
}

interface Row {
  key: string;
  title: string;
  subagentType?: string;
  status: string;
  isAgent: boolean;
  /** Ledger data when the ledger knows this job (drives the meta line). */
  task?: BackgroundTask;
  /** Conversation data when the chat knows this agent. */
  known?: KnownAgent;
  /** Id the transcript endpoint reads (ledger taskId or the parser's agentId). */
  agentId?: string;
}

const RUNNING = new Set(['running', 'paused', 'pending']);

/** Union of ledger tasks and conversation-known agents, keyed by toolUseId / agentId. */
function buildRows(tasks: readonly BackgroundTask[], known: KnownAgent[]): Row[] {
  const rows: Row[] = [];
  const claimedToolUse = new Set<string>();
  const claimedAgent = new Set<string>();
  for (const t of tasks) {
    const isAgent = isAgentTask(t);
    const k = known.find(a => (a.toolUseId && a.toolUseId === t.toolUseId) || (a.agentId && a.agentId === t.taskId));
    if (k?.toolUseId) claimedToolUse.add(k.toolUseId);
    if (k?.agentId) claimedAgent.add(k.agentId);
    rows.push({
      key: t.taskId,
      title: t.description || k?.description || t.subagentType || t.taskId.slice(0, 8),
      subagentType: t.subagentType || k?.subagentType,
      status: t.status,
      isAgent,
      task: t,
      known: k,
      agentId: isAgent ? t.taskId : undefined,
    });
  }
  for (const k of known) {
    if ((k.toolUseId && claimedToolUse.has(k.toolUseId)) || (k.agentId && claimedAgent.has(k.agentId))) continue;
    rows.push({
      key: k.agentId ?? k.toolUseId ?? k.description,
      title: k.description,
      subagentType: k.subagentType,
      // The conversation sees a run's start and end, never its progress; with the
      // ledger silent and neither proven, the row is pending (⏳), not a guess.
      status: k.failed ? 'failed' : k.finished ? 'completed' : k.running ? 'running' : 'pending',
      isAgent: true,
      known: k,
      agentId: k.agentId,
    });
  }
  return rows;
}

/** ONE 1s clock per panel for the elapsed counters; armed only while a row runs. */
function useSecondTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

/** `Agent · 58s · 64.5k tokens · 16 tool uses · Running a command` for an agent;
 *  `Command · 34s` for a background shell command (the ledger lists those too). */
function rowMeta(row: Row, now: number): string[] {
  if (!row.task) return ['Agent'];
  if (row.isAgent) return buildAgentMeta(row.task, now);
  const out = [row.task.taskType === 'local_bash' ? 'Command' : 'Task'];
  const elapsed = fmtElapsed(rowElapsedMs(row.task, now));
  if (elapsed) out.push(elapsed);
  if (row.task.lastTool) out.push(row.task.lastTool);
  return out;
}

const TaskListRow = memo(function TaskListRow({
  row, now, selected, onSelect,
}: { row: Row; now: number; selected: boolean; onSelect: (key: string) => void }) {
  const meta = rowMeta(row, now);
  return (
    <button
      className={`bg-task-row bg-task-row-${row.status} ${selected ? 'bg-task-row--selected' : ''}`}
      onClick={() => onSelect(row.key)}
      aria-pressed={selected}
    >
      <div className="bg-task-row-head">
        <StatusDot status={row.status} />
        <span className="bg-task-row-name" title={row.title}>{row.title}</span>
        {row.subagentType && <span className="task-group-agent-type" title="Subagent type">{row.subagentType}</span>}
      </div>
      <div className="bg-task-row-meta">
        {meta.map((seg, i) => <span key={i} className="wf-agent-row-meta-item">{seg}</span>)}
        {!row.isAgent && row.task?.summary && row.status === 'running' && (
          <span className="wf-agent-row-meta-item">{row.task.summary.slice(0, 80)}</span>
        )}
      </div>
    </button>
  );
});

export function BackgroundTasksPanel({
  sessionId, knownAgents, initialKey, onClose,
}: {
  sessionId: string;
  knownAgents?: KnownAgent[];
  /** Row to select on open: a ledger taskId, a toolUseId, or an agentId. */
  initialKey?: string;
  onClose: () => void;
}) {
  useModalOverlay(onClose);
  const tasks = useLiveTasksForSession(sessionId);
  const lanes = useLiveLanes(sessionId);
  const rows = useMemo(() => buildRows(tasks, knownAgents ?? []), [tasks, knownAgents]);
  // Agents first inside each section: a fan-out's agents are what the reader came
  // for; the CLI's background shell commands follow, in ledger order.
  const byKind = (a: Row, b: Row) => Number(b.isAgent) - Number(a.isAgent);
  const running = rows.filter(r => RUNNING.has(r.status)).sort(byKind);
  const finished = rows.filter(r => !RUNNING.has(r.status)).sort(byKind);
  const now = useSecondTick(running.some(r => r.task != null));

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const resolveInitial = (): string | null => {
    if (initialKey) {
      const hit = rows.find(r => r.key === initialKey || r.task?.toolUseId === initialKey || r.known?.toolUseId === initialKey || r.agentId === initialKey);
      if (hit) return hit.key;
    }
    return (running.find(r => r.isAgent) ?? rows.find(r => r.isAgent) ?? rows[0])?.key ?? null;
  };
  const selected = rows.find(r => r.key === selectedKey) ?? rows.find(r => r.key === resolveInitial());

  // A running agent whose lane is in the stream buffer reads from there (it IS the
  // live stream: nothing to fetch, nothing to poll). Otherwise the transcript is
  // readable when the endpoint has an id to read, or the conversation carried the
  // transcript / result itself. A history agent with neither (its lane was never
  // captured) shows its title and nothing else — no fetch by a toolUseId the
  // endpoint cannot resolve.
  const selectedToolUseId = selected?.task?.toolUseId ?? selected?.known?.toolUseId;
  const liveLane = selected && selected.isAgent && RUNNING.has(selected.status) && selectedToolUseId
    ? lanes.get(selectedToolUseId)
    : undefined;
  const readable = selected?.isAgent
    && (selected.agentId || selected.known?.preloaded?.length || selected.known?.result);
  const target = selected && readable && !liveLane
    ? {
        agentId: selected.agentId ?? selected.known?.toolUseId ?? selected.key,
        label: selected.title,
        meta: rowMeta(selected, now).join(' · '),
        workflow: false,
        live: RUNNING.has(selected.status),
        preloaded: selected.agentId ? undefined : selected.known?.preloaded,
        fallbackResult: selected.known?.result || undefined,
        promptInput: selected.known?.promptInput,
        fetchable: !!selected.agentId,
        startedAt: selected.task?.startedAt,
        agentLabel: selected.subagentType ? `${selected.subagentType} agent` : 'Agent',
      }
    : null;
  const detailLive = !!liveLane || target?.live === true;

  return createPortal(
    <div className="wf-modal-overlay" onClick={onClose}>
      <div className="wf-modal wf-modal--tasks" onClick={(e) => e.stopPropagation()}>
        <div className="wf-modal-header">
          <span className="wf-modal-title">Background tasks</span>
          <span className="wf-modal-meta">
            {running.length > 0 ? `${running.length} running` : ''}
            {running.length > 0 && finished.length > 0 ? ' · ' : ''}
            {finished.length > 0 ? `${finished.length} finished` : ''}
          </span>
          <button className="wf-modal-close" onClick={onClose} aria-label="Close background tasks" title="Close (Esc)">
            {ICON_CLOSE}
          </button>
        </div>
        <div className="bg-tasks-body">
          <div className="bg-tasks-list">
            {rows.length === 0 && <div className="wf-modal-loading">No background tasks yet</div>}
            {running.length > 0 && <div className="bg-tasks-section">Running</div>}
            {running.map(r => (
              <TaskListRow key={r.key} row={r} now={now} selected={r.key === selected?.key} onSelect={setSelectedKey} />
            ))}
            {finished.length > 0 && <div className="bg-tasks-section">Finished</div>}
            {finished.map(r => (
              <TaskListRow key={r.key} row={r} now={now} selected={r.key === selected?.key} onSelect={setSelectedKey} />
            ))}
          </div>
          <div className="bg-tasks-detail">
            {selected && (
              <div className="bg-tasks-detail-head">
                <StatusDot status={selected.status} />
                <span className="bg-tasks-detail-title">{selected.title}</span>
                {detailLive && <span className="wf-modal-live" title="Agent still running — this is its live output">{'●'}</span>}
                <span className="wf-modal-meta">{rowMeta(selected, now).join(' · ')}</span>
              </div>
            )}
            <div className="bg-tasks-detail-body">
              {liveLane ? (
                <div className="bg-tasks-live-lane">{liveLane()}</div>
              ) : target ? (
                <TranscriptBody key={target.agentId} target={target} sessionId={sessionId} />
              ) : selected ? (
                <div className="wf-modal-loading">
                  {selected.task?.summary || (selected.isAgent ? 'No transcript is available for this agent in this session.' : selected.title)}
                </div>
              ) : (
                <div className="wf-modal-loading">Select a task to read its transcript</div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── The chat's one entry point ─────────────────────────────────────────────────

/** Sum of what the live ledger says about a set of agents, with the conversation's
 *  own settled/unsettled knowledge as the fallback for agents the ledger never saw. */
function summarize(agents: KnownAgent[], live: ReadonlyMap<string, LiveAgentStatus>): { running: number; failed: number; done: number; toolUses: number } {
  let running = 0; let failed = 0; let done = 0; let toolUses = 0;
  for (const a of agents) {
    const entry = a.toolUseId ? live.get(a.toolUseId) : undefined;
    const s = entry?.status;
    toolUses += entry?.toolUses ?? 0;
    if (s === 'running' || s === 'paused' || s === 'pending' || (s == null && a.running && !a.finished)) running++;
    else if (s === 'failed' || a.failed) failed++;
    else if (s != null || a.finished) done++;
    // else: outcome unknown here (reload, no heartbeat yet) — counted in neither.
  }
  return { running, failed, done, toolUses };
}

/** Distinct non-empty values, in first-seen order. */
function distinct(values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out;
}

/** `● Agent  general-purpose  opus  Check the messaging code …  Running  16 tools` —
 *  the ONLY thing the chat shows for a burst of subagents (Claude Code desktop
 *  parity): one row per spawn burst carrying what the old per-agent card carried
 *  (type, model, title, tool count, state), never a card per agent and never a
 *  dropdown. A burst of several agents reads `3 agents`, the distinct types and
 *  models, the titles joined, and `2 running · 1 done`. Click opens the panel (owned
 *  by the session's `BackgroundTasksPanelHost`) with the burst's first agent selected. */
export function BackgroundTasksChip({ sessionId, agents }: { sessionId: string; agents: KnownAgent[] }) {
  const live = useLiveAgentsForSession(sessionId);
  const chipKey = agents[0]?.toolUseId ?? agents[0]?.agentId ?? agents[0]?.description ?? '';
  // Publish on every render: the live-lane closures inside `agents` are rebuilt per
  // stream delta and the panel must read the current one.
  useEffect(() => { if (sessionId && chipKey) registerKnownAgents(sessionId, chipKey, agents); });
  useEffect(() => () => { if (sessionId && chipKey) unregisterKnownAgents(sessionId, chipKey); }, [sessionId, chipKey]);
  const n = agents.length;
  const { running, failed, done, toolUses } = summarize(agents, live);
  const state = running > 0 ? 'running' : failed > 0 ? 'failed' : done === n ? 'done' : 'idle';
  const types = distinct(agents.map(a => a.subagentType));
  const models = distinct(agents.map(a => agentModelLabel(a.promptInput)));
  const titles = agents.map(a => a.description).filter(Boolean).join(' · ');
  const status = n === 1
    ? (state === 'running' ? 'Running' : state === 'failed' ? 'Failed' : state === 'done' ? 'Done' : '')
    : [running > 0 && `${running} running`, done > 0 && `${done} done`, failed > 0 && `${failed} failed`].filter(Boolean).join(' · ');
  return (
    <button
      className={`bg-tasks-chip bg-tasks-chip--${state}`}
      onClick={() => openBackgroundPanel(sessionId, agents[0]?.toolUseId ?? agents[0]?.agentId)}
      title={`${titles}\nOpen background tasks`}
    >
      <span className="bg-tasks-chip-icon">
        {state === 'running' ? <span className="task-group-streaming-dot" /> : state === 'failed' ? '✗' : state === 'done' ? '✓' : '○'}
      </span>
      <span className="bg-tasks-chip-label">{n === 1 ? 'Agent' : `${n} agents`}</span>
      {types.map(t => <span key={t} className="task-group-agent-type" title="Subagent type">{t}</span>)}
      {models.map(m => <span key={m} className="task-group-model" title="Model">{m}</span>)}
      <span className="bg-tasks-chip-desc">{titles}</span>
      {status && <span className="bg-tasks-chip-status">{status}</span>}
      {toolUses > 0 && <span className="task-group-badge">{toolUses} tool{toolUses === 1 ? '' : 's'}</span>}
    </button>
  );
}

/** One per session panel, always mounted: renders the Background tasks panel while
 *  the store says it is open for this session, fed by every chip's registration. */
export function BackgroundTasksPanelHost({ sessionId }: { sessionId: string | undefined }) {
  const request = useBackgroundPanelOpen(sessionId);
  const known = useKnownAgents(sessionId);
  if (!request || !sessionId) return null;
  return (
    <BackgroundTasksPanel
      key={request.nonce}
      sessionId={sessionId}
      knownAgents={known}
      initialKey={request.initialKey}
      onClose={closeBackgroundPanel}
    />
  );
}
