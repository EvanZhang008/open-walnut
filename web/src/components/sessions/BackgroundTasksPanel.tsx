/**
 * BackgroundTasksPanel — the "Background tasks" reader, Claude Code desktop style.
 *
 * Two columns. Left: every background job of the session. Agents and shell commands
 * are different things, so they get their own tabs (Agents, Commands, and Other for
 * any other kind; the tabs appear only when more than one kind is present), each
 * split into Running and Finished. An agent row is a card (title, subagent type,
 * `Agent · elapsed · tokens · tool uses · what it is doing`); a command row is one
 * dense line (title, elapsed), since a session can run hundreds. Right: the selected
 * job's transcript or command output, live while it runs. Each tab keeps its own
 * selection; a tab opens on its first running row unless the caller names one.
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

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';
import type { BackgroundTask } from '@/hooks/useBackgroundTasks';
import { isAgentTask, isCommandTask } from './workflow-layout';
import { buildAgentMeta, fmtElapsed, rowElapsedMs } from './background-ledger';
import { StatusDot } from './WorkflowGraph';
import { BackgroundTaskStopButton } from './BackgroundTaskStopButton';
import { agentModelLabel } from './SessionMessage';
import { TranscriptBody } from './WorkflowTranscriptModal';
import { ICON_CLOSE } from '../common/Icons';
import type { SessionHistoryMessage } from '@/types/session';
import { commandOutput, commandView, type ToolSource } from '@/stream/command-view';
import { useLiveAgentsForSession, useLiveTasksForSession, type LiveAgentStatus } from '@/stores/background-agents-store';
import { openBackgroundPanel, closeBackgroundPanel, registerKnownAgents, unregisterKnownAgents, useBackgroundPanelOpen, useKnownAgents, useLiveLanes, useToolSource } from '@/stores/background-panel-store';

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
  /** A shell command the CLI runs in the background (`local_bash`): a different
   *  thing from an agent, and shown as one — its own pill, its own reader. */
  isCommand: boolean;
  /** Ledger data when the ledger knows this job (drives the meta line). */
  task?: BackgroundTask;
  /** Conversation data when the chat knows this agent. */
  known?: KnownAgent;
  /** Id the transcript endpoint reads (ledger taskId or the parser's agentId). */
  agentId?: string;
}

const RUNNING = new Set(['running', 'paused', 'pending']);

/** The panel's tabs, in order. `other` holds whatever is neither (rare CLI task kinds). */
type Kind = 'agents' | 'commands' | 'other';
const KINDS: Kind[] = ['agents', 'commands', 'other'];
const KIND_LABEL: Record<Kind, string> = { agents: 'Agents', commands: 'Commands', other: 'Other' };
const kindOf = (r: Row): Kind => (r.isAgent ? 'agents' : r.isCommand ? 'commands' : 'other');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const KIND_NOUN: Record<Kind, string> = { agents: 'agent', commands: 'command', other: 'other task' };

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
      isCommand: isCommandTask(t),
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
      isCommand: false,
      known: k,
      agentId: k.agentId,
    });
  }
  return rows;
}

/** The pill the reader's header wears: an agent's subagent type (accent), `Command`
 *  (amber) for a shell command. List rows need it only for agents: the tab names the rest. */
function KindPill({ row }: { row: Row }) {
  if (row.isCommand) return <span className="bg-task-kind bg-task-kind--command" title="Background shell command">Command</span>;
  if (row.isAgent && row.subagentType) return <span className="task-group-agent-type" title="Subagent type">{row.subagentType}</span>;
  if (row.isAgent) return <span className="task-group-agent-type" title="Subagent">Agent</span>;
  return <span className="bg-task-kind bg-task-kind--task" title="Background task">Task</span>;
}

/** A shell command's reader: the command it ran and what it printed, straight from
 *  the conversation (stream while the turn runs, history after). */
function CommandDetail({ row, source }: { row: Row; source: ToolSource }) {
  const task = row.task!;
  const view = commandView({ toolUseId: task.toolUseId, taskId: task.taskId }, source);
  const running = RUNNING.has(row.status);
  if (!view) {
    return (
      <div className="wf-modal-loading">
        {running ? 'The command is running; its call has not reached this conversation yet.' : 'The command and its output are not in this conversation.'}
      </div>
    );
  }
  const output = commandOutput(view);
  return (
    <div className="bg-tasks-command">
      {view.description && view.description !== row.title && (
        <div className="bg-tasks-command-desc">{view.description}</div>
      )}
      <div className="chat-tool-block-section-label">Command</div>
      <pre className="bash-tool-pre"><span className="bash-tool-prompt">$ </span>{view.command || '(command not captured)'}</pre>
      <div className="chat-tool-block-section-label">Output</div>
      <pre className="bash-tool-pre">
        {output ?? (running || view.status === 'calling' ? 'Running…' : '(no output)')}
      </pre>
    </div>
  );
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
  if (!row.isAgent) {
    // A command (or other job) is one line: the tab already names its kind, and a
    // session can run hundreds, so the list must stay scannable.
    const elapsed = row.task ? fmtElapsed(rowElapsedMs(row.task, now)) : '';
    return (
      <button
        className={`bg-task-row bg-task-row--compact bg-task-row-${row.status} ${selected ? 'bg-task-row--selected' : ''}`}
        onClick={() => onSelect(row.key)}
        aria-pressed={selected}
        title={row.task?.summary && RUNNING.has(row.status) ? `${row.title}\n${row.task.summary}` : row.title}
      >
        <StatusDot status={row.status} />
        <span className="bg-task-row-name">{row.title}</span>
        {elapsed && <span className="bg-task-row-time">{elapsed}</span>}
      </button>
    );
  }
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
        <KindPill row={row} />
      </div>
      <div className="bg-task-row-meta">
        {meta.map((seg, i) => <span key={i} className="wf-agent-row-meta-item">{seg}</span>)}
      </div>
    </button>
  );
});

/** `RUNNING 3` / `FINISHED 38 · 2 failed`, then its rows: agent cards as they are,
 *  one-line rows inside one bordered group. */
function TaskSection({ title, count, failed = 0, compact, children }: {
  title: string; count: number; failed?: number; compact: boolean; children: ReactNode;
}) {
  return (
    <>
      <div className="bg-tasks-section">
        <span className="bg-tasks-section-title">{title}</span>
        <span className="bg-tasks-section-count">{count}</span>
        {failed > 0 && <span className="bg-tasks-section-failed">{failed} failed</span>}
      </div>
      {compact ? <div className="bg-task-group">{children}</div> : children}
    </>
  );
}

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
  const source = useToolSource(sessionId);
  const rows = useMemo(() => buildRows(tasks, knownAgents ?? []), [tasks, knownAgents]);
  const groups = useMemo(() => {
    const out: Record<Kind, Row[]> = { agents: [], commands: [], other: [] };
    for (const r of rows) out[kindOf(r)].push(r);
    return out;
  }, [rows]);
  const present = KINDS.filter(k => groups[k].length > 0);
  const allRunning = rows.filter(r => RUNNING.has(r.status)).length;
  const now = useSecondTick(rows.some(r => r.task != null && RUNNING.has(r.status)));

  // The tab: the user's choice, else the kind of the row the caller named, else the
  // first kind present (agents before commands). Each tab remembers its own selection.
  const [chosenTab, setChosenTab] = useState<Kind | null>(null);
  const [picked, setPicked] = useState<Partial<Record<Kind, string>>>({});
  const initialRow = initialKey
    ? rows.find(r => r.key === initialKey || r.task?.toolUseId === initialKey || r.known?.toolUseId === initialKey || r.agentId === initialKey)
    : undefined;
  const tab: Kind = chosenTab && groups[chosenTab].length > 0
    ? chosenTab
    : initialRow ? kindOf(initialRow) : present[0] ?? 'agents';
  const tabRows = groups[tab];
  const running = tabRows.filter(r => RUNNING.has(r.status));
  const finished = tabRows.filter(r => !RUNNING.has(r.status));
  const finishedFailed = finished.filter(r => r.status === 'failed').length;
  const selected = tabRows.find(r => r.key === picked[tab])
    ?? (initialRow && kindOf(initialRow) === tab ? initialRow : undefined)
    ?? running[0] ?? tabRows[0];
  const select = (key: string) => setPicked(p => ({ ...p, [tab]: key }));

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
            {[...present.map(k => plural(groups[k].length, KIND_NOUN[k])), allRunning > 0 && `${allRunning} running`].filter(Boolean).join(' · ')}
          </span>
          <button className="wf-modal-close" onClick={onClose} aria-label="Close background tasks" title="Close (Esc)">
            {ICON_CLOSE}
          </button>
        </div>
        <div className="bg-tasks-body">
          <div className="bg-tasks-side">
            {present.length > 1 && (
              <div className="bg-tasks-tabs" role="tablist" aria-label="Kind of background task">
                {present.map(k => {
                  const live = groups[k].filter(r => RUNNING.has(r.status)).length;
                  return (
                    <button
                      key={k}
                      role="tab"
                      aria-selected={k === tab}
                      data-kind={k}
                      className={`bg-tasks-tab${k === tab ? ' bg-tasks-tab--active' : ''}`}
                      onClick={() => setChosenTab(k)}
                      title={live > 0 ? `${plural(groups[k].length, KIND_NOUN[k])}, ${live} running` : plural(groups[k].length, KIND_NOUN[k])}
                    >
                      {live > 0 && <span className="bg-tasks-tab-live" aria-hidden="true"><span className="task-group-streaming-dot" /></span>}
                      <span className="bg-tasks-tab-label">{KIND_LABEL[k]}</span>
                      <span className="bg-tasks-tab-count">{groups[k].length}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="bg-tasks-list" role={present.length > 1 ? 'tabpanel' : undefined} data-kind={tab}>
              {rows.length === 0 && <div className="wf-modal-loading">No background tasks yet</div>}
              {running.length > 0 && (
                <TaskSection title="Running" count={running.length} compact={tab !== 'agents'}>
                  {running.map(r => <TaskListRow key={r.key} row={r} now={now} selected={r.key === selected?.key} onSelect={select} />)}
                </TaskSection>
              )}
              {finished.length > 0 && (
                <TaskSection title="Finished" count={finished.length} failed={finishedFailed} compact={tab !== 'agents'}>
                  {finished.map(r => <TaskListRow key={r.key} row={r} now={now} selected={r.key === selected?.key} onSelect={select} />)}
                </TaskSection>
              )}
            </div>
          </div>
          <div className="bg-tasks-detail">
            {selected && (
              <div className="bg-tasks-detail-head">
                <StatusDot status={selected.status} />
                <span className="bg-tasks-detail-title">{selected.title}</span>
                <KindPill row={selected} />
                {detailLive && <span className="wf-modal-live" title="Agent still running — this is its live output">{'●'}</span>}
                {/* The pill already names a command's kind; the meta keeps only the timing. */}
                <span className="wf-modal-meta">{rowMeta(selected, now).slice(selected.isAgent ? 0 : 1).join(' · ')}</span>
                {selected.task && RUNNING.has(selected.status) && (
                  <BackgroundTaskStopButton key={selected.task.taskId} sessionId={sessionId} taskId={selected.task.taskId}
                    noun={selected.isAgent ? 'agent' : selected.isCommand ? 'command' : selected.task.taskType === 'local_workflow' ? 'workflow' : 'task'} />
                )}
              </div>
            )}
            <div className="bg-tasks-detail-body">
              {liveLane ? (
                <div className="bg-tasks-live-lane">{liveLane()}</div>
              ) : target ? (
                <TranscriptBody key={target.agentId} target={target} sessionId={sessionId} />
              ) : selected?.isCommand && selected.task ? (
                <CommandDetail row={selected} source={source} />
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

/** Gap between the chip's flex items (keep in step with `.bg-tasks-chip` in CSS). */
const CHIP_GAP_PX = 6;

/** True when the title cannot share the chip's first line with the pills and the
 *  status, measured, not guessed: a narrow column full of pills left the title
 *  as a few clipped characters. The row 1 items (icon, label, type and model pills,
 *  status, tool count) are the same width in either layout, so the answer is stable
 *  across the switch; the ResizeObserver re-measures on every width change. */
function useStackedTitle(ref: RefObject<HTMLElement | null>, deps: unknown[]): boolean {
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const desc = el.querySelector<HTMLElement>('.bg-tasks-chip-desc');
      // The inline text span keeps its full width under the clipping box, so this
      // is the title's natural width in either layout (scrollWidth would report
      // the box, which in the stacked layout is always the whole line).
      const text = desc?.firstElementChild;
      if (!desc || !text) return;
      let others = 0;
      let count = 0;
      for (const child of Array.from(el.children)) {
        count++;
        if (child !== desc) others += child.getBoundingClientRect().width;
      }
      const style = getComputedStyle(el);
      const inner = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const available = inner - others - CHIP_GAP_PX * (count - 1);
      setStacked(text.getBoundingClientRect().width > available + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return stacked;
}

/** `● Agent  general-purpose  opus  Check the messaging code …  Running  16 tools` —
 *  the ONLY thing the chat shows for a burst of subagents (Claude Code desktop
 *  parity): one row per spawn burst carrying what the old per-agent card carried
 *  (type, model, title, tool count, state), never a card per agent and never a
 *  dropdown. A burst of several agents reads `3 agents`, the distinct types and
 *  models, the titles joined, and `2 running · 1 done`. In a column too narrow for
 *  all of that on one line the title moves to a second line of its own, full width,
 *  under the pills. Click opens the panel (owned by the session's
 *  `BackgroundTasksPanelHost`) with the burst's first agent selected. */
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
  const ref = useRef<HTMLButtonElement>(null);
  const stacked = useStackedTitle(ref, [titles, types.join(), models.join(), status, toolUses, n]);
  return (
    <button
      ref={ref}
      className={`bg-tasks-chip bg-tasks-chip--${state}${stacked ? ' bg-tasks-chip--stacked' : ''}`}
      onClick={() => openBackgroundPanel(sessionId, agents[0]?.toolUseId ?? agents[0]?.agentId)}
      title={`${titles}\nOpen background tasks`}
    >
      <span className="bg-tasks-chip-icon">
        {state === 'running' ? <span className="task-group-streaming-dot" /> : state === 'failed' ? '✗' : state === 'done' ? '✓' : '○'}
      </span>
      <span className="bg-tasks-chip-label">{n === 1 ? 'Agent' : `${n} agents`}</span>
      {types.map(t => <span key={t} className="task-group-agent-type" title="Subagent type">{t}</span>)}
      {models.map(m => <span key={m} className="task-group-model" title="Model">{m}</span>)}
      <span className="bg-tasks-chip-desc"><span>{titles}</span></span>
      {(status || toolUses > 0) && (
        <span className="bg-tasks-chip-meta">
          {status && <span className="bg-tasks-chip-status">{status}</span>}
          {toolUses > 0 && <span className="task-group-badge">{toolUses} tool{toolUses === 1 ? '' : 's'}</span>}
        </span>
      )}
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
