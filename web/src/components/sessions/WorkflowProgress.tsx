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
 *   - Background mode (no workflow): ONE line — `Background · Agents 1/1 · Tasks 4/5 ·
 *     1 running · 132k tok` — that opens the Background tasks panel. Nothing unfolds in
 *     place: the panel (BackgroundTasksPanel) is the single reader for every agent and
 *     shell command, the same one the chat's `N running tasks` chip opens. This bar
 *     also feeds the background-agents store the panel and the chips read from.
 *
 * The counts here are DISPLAY-ONLY — completion is driven by the backend's
 * session_state_changed{idle} signal, never by this panel.
 */

import { memo, useEffect, useState } from 'react';
import { useBackgroundTasks, type BackgroundTask, type WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { publishLiveAgents } from '@/stores/background-agents-store';
import { WorkflowGraph, fmtTokens, agentMeta } from './WorkflowGraph';
import { phaseCounts, isAgentTask } from './workflow-layout';
import { WorkflowTranscriptModal, type TranscriptTarget } from './WorkflowTranscriptModal';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { useFullscreen } from '@/hooks/useFullscreen';
import { ICON_EXPAND, ICON_COLLAPSE } from '../common/Icons';

export const WorkflowProgress = memo(function WorkflowProgress({ sessionId }: { sessionId: string }) {
  const { workflowName, workflowDescription, scriptSource, inFlight, tasks, phases, agents } = useBackgroundTasks(sessionId);
  // The chat's chips and the Background tasks panel read this same ledger from the
  // store (not a context: a heartbeat must re-render the one chip that moved, not
  // the whole conversation), so every surface shows one status per agent.
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

  // Collapse (workflow mode only): ALWAYS default collapsed — the panel sits quietly
  // as a one-line header (counts show liveness) and never auto-expands, even while
  // work is running (auto-expand hogged chat space mid-turn). User clicks win.
  // Fullscreen forces expanded — a collapsed full-screen panel makes no sense.
  const collapsed = !isFullscreen && (collapseOverride ?? true);

  // Nothing to show until at least one background task / agent has appeared.
  if (!isWorkflow && tasks.length === 0 && inFlight === 0) return null;

  // Counts: workflow mode derives from the agents union via the SAME phaseCounts()
  // the per-phase headers + density bar use — single source of truth, so the panel
  // header and the phase headers can't disagree on whether a 'failed' agent counts as
  // "done" (it does NOT: phaseCounts puts failed in its own bucket, surfaced separately
  // below). One pass over the union instead of three separate filter/reduce scans.
  const wfCounts = phaseCounts(agents);
  // Background mode: split AGENTS from plain TASKS — two different things the user
  // thinks about separately (subagents vs shell cmds).
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

  const counts = (
    <span className="wf-card-count">
      {isWorkflow || agentTasks.length === 0 || plainTasks.length === 0 ? (
        <>{done}/{total}{isWorkflow || agentTasks.length > 0 ? ' agents' : ' tasks'}</>
      ) : (
        // Mixed set: count agents and plain tasks separately.
        <>
          Agents {agentTasks.filter(isDone).length}/{agentTasks.length}
          {' · '}
          Tasks {plainTasks.filter(isDone).length}/{plainTasks.length}
        </>
      )}
      {running > 0 && <span className="wf-card-running"> · {running} running</span>}
      {failed > 0 && <span className="wf-card-failed"> · {failed} failed</span>}
    </span>
  );

  if (!isWorkflow) {
    // One line, one action: the whole bar opens the Background tasks panel. No
    // caret, no in-place list — the panel is where agents and commands are read.
    return (
      <button
        className={`wf-card wf-card--bar ${running > 0 ? 'wf-card--live' : ''}`}
        onClick={() => openBackgroundPanel(sessionId)}
        title="Open background tasks"
      >
        <span className="wf-card-icon">{running > 0 ? <span className="task-group-streaming-dot" /> : '⚙'}</span>
        <span className="wf-card-title">Background</span>
        {counts}
        {totalTokens > 0 && <span className="wf-card-tokens">{fmtTokens(totalTokens)} tok</span>}
        <span className="wf-card-open">View all</span>
      </button>
    );
  }

  // Orientation: Home Panel stays VERTICAL (glanceable stacked timeline — the daily
  // surface); only fullscreen promotes to the HORIZONTAL swimlane graph (space is
  // guaranteed there). Deliberately NOT width-based — predictable, no surprise flips.
  const orientation = isFullscreen ? 'horizontal' : 'vertical';

  const openTranscript = (a: WorkflowAgent) =>
    setTranscriptTarget({ agentId: a.agentId, label: a.label, model: a.model, meta: agentMeta(a) });
  const toggleAgent = (id: string) => setExpandedAgent(prev => (prev === id ? null : id));

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
        {counts}
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
          {workflowDescription && (
            <div className="wf-card-desc">{workflowDescription}</div>
          )}

          {showScript && scriptSource && (
            <pre className="wf-script">{scriptSource}</pre>
          )}

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
        </>
      )}

      {transcriptTarget && (
        <WorkflowTranscriptModal
          target={transcriptTarget}
          sessionId={sessionId}
          onClose={() => setTranscriptTarget(null)}
        />
      )}
    </div>
    </>
  );
});
