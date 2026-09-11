/**
 * WorkflowProgress — live panel for a session's dynamic-workflow / background tasks.
 *
 * Driven by the `session:background-tasks` stream (see useBackgroundTasks). A dynamic
 * workflow fans out many subagents that outlive the agent's text turn. This panel
 * shows WHAT workflow was created (name + generated script) and visualizes the run as
 * a FLOW GRAPH (see WorkflowGraph): phases as layers, agents as nodes — vertical
 * stacked timeline when narrow (Home Panel, the PRIMARY surface), horizontal swimlanes
 * with connectors when fullscreen. Rendered inside SessionChatHistory so BOTH the
 * /sessions page and the home slide-out get it for free.
 *
 * Two render modes:
 *   - Workflow mode (agents.length > 0): the rich WorkflowGraph.
 *   - Legacy mode (no agents): the flat LEDGER — one two-line AgentRow per background
 *     agent (Claude Code "Background tasks" parity) plus the compact TaskRow for plain
 *     background tasks (local_bash shell commands etc.).
 *
 * The counts here are DISPLAY-ONLY — completion is driven by the backend's
 * session_state_changed{idle} signal, never by this panel.
 */

import { memo, useEffect, useState } from 'react';
import { useBackgroundTasks, type BackgroundTask, type WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { publishLiveAgents } from '@/stores/background-agents-store';
import { WorkflowGraph, StatusDot, fmtTokens, agentMeta } from './WorkflowGraph';
import { phaseCounts, isAgentTask } from './workflow-layout';
import { buildAgentMeta } from './background-ledger';
import { WorkflowTranscriptModal, type TranscriptTarget } from './WorkflowTranscriptModal';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { useFullscreen } from '@/hooks/useFullscreen';
import { ICON_EXPAND, ICON_COLLAPSE } from '../common/Icons';

/** ONE 1s clock per panel, not per row: a 20-agent fan-out would otherwise create 20
 *  intervals. Only armed while something is actually ticking (see the call site). */
function useSecondTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now()); // re-arming after a pause must not show a stale second
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

// ── Legacy flat task row (plain background tasks — shell commands etc.) ──
const TaskRow = memo(function TaskRow({ task }: { task: BackgroundTask }) {
  const activity = task.summary
    || (task.lastTool ? `${task.description ?? ''} · ${task.lastTool}` : task.description)
    || '';
  return (
    <div className={`wf-task wf-task-${task.status}`}>
      <StatusDot status={task.status} />
      <span className="wf-task-name" title={task.subagentType}>
        {task.description || task.subagentType || task.taskId.slice(0, 8)}
      </span>
      {task.status === 'running' && activity && (
        <span className="wf-task-activity">{activity.slice(0, 80)}</span>
      )}
      {task.tokens ? <span className="wf-task-tokens">{fmtTokens(task.tokens)}</span> : null}
    </div>
  );
});

// ── Background AGENT ledger row (Claude Code "Background tasks" parity) ──
// Line 1: status + what it was asked to do + its subagent type.
// Line 2: Agent · elapsed · tokens · tool uses · what it's doing · View transcript.
const AgentRow = memo(function AgentRow({
  task, now, onOpenTranscript,
}: { task: BackgroundTask; now: number; onOpenTranscript: (t: BackgroundTask) => void }) {
  const title = task.description || task.subagentType || task.taskId.slice(0, 8);
  return (
    <div className={`wf-agent-row wf-agent-row-${task.status}`}>
      <div className="wf-agent-row-head">
        <StatusDot status={task.status} />
        <span className="wf-agent-row-name" title={title}>{title}</span>
        {task.subagentType && (
          <span className="task-group-agent-type" title="Subagent type">{task.subagentType}</span>
        )}
      </div>
      <div className="wf-agent-row-meta">
        {/* CSS owns the middot separators, so the builder stays a plain list of segments. */}
        {buildAgentMeta(task, now).map((seg, i) => (
          <span key={i} className="wf-agent-row-meta-item">{seg}</span>
        ))}
        <button
          className="wf-agent-row-transcript"
          onClick={() => onOpenTranscript(task)}
          title="Read this agent's full transcript"
        >
          View transcript
        </button>
      </div>
    </div>
  );
});

export const WorkflowProgress = memo(function WorkflowProgress({ sessionId }: { sessionId: string }) {
  const { workflowName, workflowDescription, scriptSource, inFlight, tasks, phases, agents } = useBackgroundTasks(sessionId);
  // The chat's Agent cards read the same ledger by toolUseId (store, not
  // context: a heartbeat must re-render the one card that moved, not the
  // whole conversation), so both surfaces show one status per agent.
  useEffect(() => { publishLiveAgents(sessionId, tasks); }, [sessionId, tasks]);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  // null = follow the smart default (collapse a finished run, expand a live one);
  // true/false = the user clicked the chevron and now owns the state.
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  // Which subagent's full transcript is open in the big modal reader (null = none).
  const [transcriptTarget, setTranscriptTarget] = useState<TranscriptTarget | null>(null);
  // Whole-panel full screen — same CSS-promotion hook the session panel uses
  // (95vw x 95vh, Escape to exit, shared scroll lock).
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();

  const isWorkflow = agents.length > 0;

  // Collapse: ALWAYS default collapsed — the panel sits quietly as a one-line
  // header (counts show liveness) and never auto-expands, even while work is
  // running (auto-expand hogged chat space mid-turn). User clicks win.
  // Fullscreen forces expanded — a collapsed full-screen panel makes no sense.
  // Computed BEFORE the early return below so the tick hook can gate on it (hooks
  // must not sit after a conditional return).
  const collapsed = !isFullscreen && (collapseOverride ?? true);
  // Elapsed on a running agent row only ticks when a row is on screen to show it.
  const now = useSecondTick(!collapsed && !isWorkflow && tasks.some(t => t.status === 'running' && isAgentTask(t)));

  // Nothing to show until at least one background task / agent has appeared.
  if (!isWorkflow && tasks.length === 0 && inFlight === 0) return null;

  // Counts: workflow mode derives from the agents union via the SAME phaseCounts()
  // the per-phase headers + density bar use — single source of truth, so the panel
  // header and the phase headers can't disagree on whether a 'failed' agent counts as
  // "done" (it does NOT: phaseCounts puts failed in its own bucket, surfaced separately
  // below). One pass over the union instead of three separate filter/reduce scans.
  const wfCounts = phaseCounts(agents);
  // Legacy mode: split background AGENTS from plain background TASKS — two
  // different things the user thinks about separately (subagents vs shell cmds).
  const isDone = (t: BackgroundTask) => t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused';
  const agentTasks = isWorkflow ? [] : tasks.filter(isAgentTask);
  const plainTasks = isWorkflow ? [] : tasks.filter(t => !isAgentTask(t));
  const total = isWorkflow ? wfCounts.total : tasks.length;
  const done = isWorkflow ? wfCounts.done : tasks.filter(isDone).length;
  const running = isWorkflow ? wfCounts.running : inFlight;
  const failed = isWorkflow ? wfCounts.failed : 0;
  const totalTokens = isWorkflow
    ? wfCounts.tokens
    : tasks.reduce((s, t) => s + (t.tokens ?? 0), 0);

  // Orientation: Home Panel stays VERTICAL (glanceable stacked timeline — the daily
  // surface); only fullscreen promotes to the HORIZONTAL swimlane graph (space is
  // guaranteed there). Deliberately NOT width-based — predictable, no surprise flips.
  const orientation = isFullscreen ? 'horizontal' : 'vertical';

  const openTranscript = (a: WorkflowAgent) =>
    setTranscriptTarget({ agentId: a.agentId, label: a.label, model: a.model, meta: agentMeta(a) });
  const toggleAgent = (id: string) => setExpandedAgent(prev => (prev === id ? null : id));
  // A plain background agent opens in the Background tasks panel (the same two-column
  // reader the chat's chip opens), selected — the list on its left is this bar's rows.
  const openAgentTranscript = (t: BackgroundTask) => openBackgroundPanel(sessionId, t.taskId);

  // `live`/`meta` must follow the AGENT, not the click that opened the modal: an agent
  // that finishes while the reader is open owes one final (cacheable) fetch, and the
  // header numbers should keep counting. So re-derive them from the current snapshot.
  // An agent the ledger no longer lists (state replaced by the persisted
  // manifest after a reconnect) is not live either: keep the click-time meta
  // but stop polling.
  const openAgent = transcriptTarget?.workflow === false
    ? tasks.find(t => t.taskId === transcriptTarget.agentId)
    : undefined;
  const modalTarget = transcriptTarget?.workflow === false
    ? (openAgent
        ? { ...transcriptTarget, meta: buildAgentMeta(openAgent, now).join(' · '), live: openAgent.status === 'running' }
        : { ...transcriptTarget, live: false })
    : transcriptTarget;

  return (
    <>
    {FullscreenBackdrop}
    <div className={`wf-card ${collapsed ? 'wf-card-collapsed' : ''}${fullscreenClass}`}>
      <div className="wf-card-header">
        {/* The whole bar toggles collapse; the chevron just signals it's clickable.
            (Disabled while fullscreen — the panel is force-expanded then.) */}
        <button
          className="wf-card-collapse"
          onClick={() => !isFullscreen && setCollapseOverride(!collapsed)}
          aria-expanded={!collapsed}
          title={isFullscreen ? '' : collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="wf-card-caret">{collapsed ? '▸' : '▾'}</span>
          <span className="wf-card-icon">{'⚙'}</span>
          <span className="wf-card-title" title={workflowDescription}>
            {workflowName ? `Workflow: ${workflowName}` : 'Background'}
          </span>
        </button>
        <span className="wf-card-count">
          {isWorkflow || agentTasks.length === 0 || plainTasks.length === 0 ? (
            <>{done}/{total}{isWorkflow || agentTasks.length > 0 ? ' agents' : ' tasks'}</>
          ) : (
            // Mixed legacy set: count agents and plain tasks separately.
            <>
              Agents {agentTasks.filter(isDone).length}/{agentTasks.length}
              {' · '}
              Tasks {plainTasks.filter(isDone).length}/{plainTasks.length}
            </>
          )}
          {running > 0 && <span className="wf-card-running"> · {running} running</span>}
          {failed > 0 && <span className="wf-card-failed"> · {failed} failed</span>}
        </span>
        {totalTokens > 0 && <span className="wf-card-tokens">{fmtTokens(totalTokens)} tok</span>}
        {scriptSource && (
          <button className="wf-script-toggle" onClick={() => setShowScript(s => !s)} title="View the generated workflow script">
            {showScript ? 'Hide script' : 'View script'}
          </button>
        )}
        {/* Whole-panel full screen — same affordance as the session panel. */}
        <button
          className="wf-card-fullscreen"
          onClick={isFullscreen ? exitFullscreen : enterFullscreen}
          title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
          aria-label={isFullscreen ? 'Exit full screen' : 'Expand workflow to full screen'}
        >
          {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
        </button>
      </div>

      {!collapsed && (
        <>
          {workflowDescription && isWorkflow && (
            <div className="wf-card-desc">{workflowDescription}</div>
          )}

          {showScript && scriptSource && (
            <pre className="wf-script">{scriptSource}</pre>
          )}

          {isWorkflow ? (
            <div className="wf-card-tasks">
              <WorkflowGraph
                phases={phases}
                agents={agents}
                orientation={orientation}
                expandedAgent={expandedAgent}
                onToggleAgent={toggleAgent}
                onOpenTranscript={openTranscript}
              />
            </div>
          ) : (
            <div className="wf-card-tasks">
              {/* Agents and plain tasks are separate sections; headers only when
                  both kinds are present (a homogeneous list needs no labels). */}
              {agentTasks.length > 0 && plainTasks.length > 0 && (
                <div className="wf-section-label">Agents</div>
              )}
              {agentTasks.map(t => (
                <AgentRow key={t.taskId} task={t} now={now} onOpenTranscript={openAgentTranscript} />
              ))}
              {agentTasks.length > 0 && plainTasks.length > 0 && (
                <div className="wf-section-label">Tasks</div>
              )}
              {plainTasks.map(t => <TaskRow key={t.taskId} task={t} />)}
            </div>
          )}
        </>
      )}

      {modalTarget && (
        <WorkflowTranscriptModal
          target={modalTarget}
          sessionId={sessionId}
          onClose={() => setTranscriptTarget(null)}
        />
      )}
    </div>
    </>
  );
});
