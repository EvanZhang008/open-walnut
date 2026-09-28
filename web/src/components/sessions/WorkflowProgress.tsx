/**
 * WorkflowProgress shows the live or persisted workflow ledger in a session.
 * A workflow run gets the phase overview (WorkflowGraph); any other background work
 * gets one bar that opens the Background tasks panel, which reads every agent and command.
 * Agent counts are display-only; session completion comes from the backend.
 */

import { memo, useEffect, useState } from 'react';
import { useBackgroundTasks, type BackgroundTask, type WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { publishLiveAgents } from '@/stores/background-agents-store';
import { WorkflowGraph, fmtTokens, agentMeta } from './WorkflowGraph';
import { phaseCounts, isAgentTask, isCommandTask } from './workflow-layout';
import { WorkflowTranscriptModal, type TranscriptTarget } from './WorkflowTranscriptModal';
import { openBackgroundPanel } from '@/stores/background-panel-store';
import { useFullscreen } from '@/hooks/useFullscreen';
import { ICON_EXPAND, ICON_COLLAPSE } from '../common/Icons';
import { useShedToFit } from './shed-to-fit';

export const WorkflowProgress = memo(function WorkflowProgress({ sessionId }: { sessionId: string }) {
  const { workflowName, workflowDescription, scriptSource, inFlight, tasks, phases, agents } = useBackgroundTasks(sessionId);
  // The chat's chips and the Background tasks panel read this same ledger from the
  // store (not a context: a heartbeat must re-render the one chip that moved, not
  // the whole conversation), so every surface shows one status per agent.
  useEffect(() => { publishLiveAgents(sessionId, tasks); }, [sessionId, tasks]);
  const [expandedAgent, setExpandedAgent] = useState<string | null>(null);
  const [chosenPhase, setChosenPhase] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [showScript, setShowScript] = useState(false);
  const [collapseOverride, setCollapseOverride] = useState<boolean | null>(null);
  const [transcriptTarget, setTranscriptTarget] = useState<TranscriptTarget | null>(null);
  // Fullscreen keeps the same panel mounted so selection and scrolling survive.
  const { isFullscreen, enterFullscreen, exitFullscreen, fullscreenClass, FullscreenBackdrop } = useFullscreen();
  // The bar and the header tallies drop meter, tokens, words, then the total until they fit.
  const [barEl, setBarEl] = useState<HTMLElement | null>(null);
  const [metaEl, setMetaEl] = useState<HTMLElement | null>(null);
  useShedToFit(barEl, 5);
  useShedToFit(metaEl, 5);

  const isWorkflow = agents.length > 0;
  const workflowKey = `${sessionId}:${workflowName ?? ''}:${scriptSource ?? ''}`;
  const [currentWorkflowKey, setCurrentWorkflowKey] = useState(workflowKey);
  if (currentWorkflowKey !== workflowKey) {
    setCurrentWorkflowKey(workflowKey);
    setChosenPhase(null);
    setQuery('');
    setExpandedAgent(null);
    setTranscriptTarget(null);
    setShowScript(false);
    setCollapseOverride(null);
  }

  // Always starts collapsed, even while running: auto-expanding a live run took over
  // the chat mid-turn. The user's click wins; fullscreen always expands.
  const collapsed = !isFullscreen && (collapseOverride ?? true);

  // Nothing to show until at least one background task / agent has appeared.
  if (!isWorkflow && tasks.length === 0 && inFlight === 0) return null;

  const wfCounts = phaseCounts(agents);
  // Background mode: split AGENTS from plain TASKS — two different things the user
  // thinks about separately (subagents vs shell cmds).
  const isDone = (t: BackgroundTask) => t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused' && t.status !== 'failed';
  const agentTasks = isWorkflow ? [] : tasks.filter(isAgentTask);
  const plainTasks = isWorkflow ? [] : tasks.filter(t => !isAgentTask(t));
  // Shell commands are named as such; a set that holds anything else stays "tasks".
  const plainWord = plainTasks.length > 0 && plainTasks.every(isCommandTask) ? 'commands' : 'tasks';
  const total = isWorkflow ? wfCounts.total : tasks.length;
  const done = isWorkflow ? wfCounts.done : tasks.filter(isDone).length;
  const running = isWorkflow ? wfCounts.running : inFlight;
  const failed = isWorkflow ? wfCounts.failed : tasks.filter(t => t.status === 'failed').length;
  const totalTokens = isWorkflow
    ? wfCounts.tokens
    : tasks.reduce((s, t) => s + (t.tokens ?? 0), 0);

  const counts = (
    <span className="wf-card-count" data-shed-watch>
      {/* Only the completion tally may be cut short; running and failed always show. */}
      <span className="wf-card-count-done" data-shed-watch>
        {isWorkflow || agentTasks.length === 0 || plainTasks.length === 0 ? (
          <>{done}/{total}{isWorkflow || agentTasks.length > 0 ? ' agents' : ` ${plainWord}`} done</>
        ) : (
          // Mixed set: count agents and plain tasks separately.
          <>
            Agents {agentTasks.filter(isDone).length}/{agentTasks.length}
            {' · '}
            {plainWord === 'commands' ? 'Commands' : 'Tasks'} {plainTasks.filter(isDone).length}/{plainTasks.length}
          </>
        )}
      </span>
      {/* Last to go, and only when a running or failed count is left to carry the line. */}
      <span className={`wf-card-count-short${running > 0 || failed > 0 ? ' wf-card-count-short--optional' : ''}`} data-shed-watch>
        {done}/{total}<span className="wf-card-count-word"> done</span>
      </span>
      {running > 0 && <span className="wf-card-running"><span className="wf-card-sep"> · </span>{running} running</span>}
      {failed > 0 && <span className="wf-card-failed"><span className="wf-card-sep"> · </span>{failed} failed</span>}
    </span>
  );
  const state = running > 0 ? 'running' : failed > 0 ? 'failed' : done === total ? 'done' : 'pending';
  const stateIcon = (
    <span className={`wf-card-state wf-card-state--${state}`} aria-hidden="true">
      {state === 'running' ? <span className="task-group-streaming-dot" /> : state === 'failed' ? '!' : state === 'done' ? '✓' : '○'}
    </span>
  );
  const meter = total > 0 && (
    <span className="wf-card-meter" aria-hidden="true">
      <span className="wf-card-meter-done" style={{ width: `${(done / total) * 100}%` }} />
      <span className="wf-card-meter-failed" style={{ width: `${(failed / total) * 100}%` }} />
    </span>
  );

  if (!isWorkflow) {
    // One line, one action: the whole bar opens the Background tasks panel. No
    // caret, no in-place list — the panel is where agents and commands are read.
    return (
      <button
        ref={setBarEl}
        className={`wf-card wf-card--bar wf-card--${state}`}
        onClick={() => openBackgroundPanel(sessionId)}
        title="Open background tasks"
      >
        {stateIcon}
        <span className="wf-card-title">Background</span>
        {counts}
        {meter}
        {totalTokens > 0 && <span className="wf-card-tokens">{fmtTokens(totalTokens)} tok</span>}
        <span className="wf-card-open"><span className="wf-card-open-label">View all </span><span aria-hidden="true">›</span></span>
      </button>
    );
  }

  const openTranscript = (a: WorkflowAgent) =>
    setTranscriptTarget({ agentId: a.agentId, label: a.label, model: a.model, meta: agentMeta(a) });
  const toggleAgent = (id: string) => setExpandedAgent(prev => (prev === id ? null : id));

  return (
    <>
    {FullscreenBackdrop}
    <div className={`wf-card ${collapsed ? 'wf-card-collapsed' : ''}${fullscreenClass}`}>
      <div className="wf-card-header">
        <button
          className="wf-card-collapse"
          onClick={() => !isFullscreen && setCollapseOverride(!collapsed)}
          aria-expanded={!collapsed}
          title={isFullscreen ? '' : collapsed ? 'Expand' : 'Collapse'}
        >
          <span className="wf-card-caret">{collapsed ? '▸' : '▾'}</span>
          {stateIcon}
          <span className="wf-card-title" title={workflowDescription}>
            {workflowName ? <><span className="wf-card-title-kind">Workflow: </span>{workflowName}</> : 'Background'}
          </span>
        </button>
        <div className="wf-card-header-meta" ref={setMetaEl}>
          {counts}
          {meter}
          {totalTokens > 0 && <span className="wf-card-tokens">{fmtTokens(totalTokens)} tok</span>}
        </div>
        <div className="wf-card-header-actions">
          {scriptSource && (
            <button className="wf-script-toggle" onClick={() => setShowScript(s => !s)} title="View the generated workflow script" aria-pressed={showScript}>
              <span className="wf-script-label">{showScript ? 'Hide script' : 'View script'}</span>
              <span className="wf-script-label-short">Script</span>
            </button>
          )}
          <button
            className="wf-card-fullscreen"
            onClick={isFullscreen ? exitFullscreen : enterFullscreen}
            title={isFullscreen ? 'Collapse back' : 'Expand to full screen'}
            aria-label={isFullscreen ? 'Exit full screen' : 'Expand workflow to full screen'}
          >
            {isFullscreen ? ICON_COLLAPSE : ICON_EXPAND}
          </button>
        </div>
      </div>

      {!collapsed && <div className="wf-card-content">
        {workflowDescription && <div className="wf-card-desc">{workflowDescription}</div>}
        {showScript && scriptSource && <pre className="wf-script">{scriptSource}</pre>}
        <div className="wf-card-tasks">
          <WorkflowGraph
            phases={phases}
            agents={agents}
            finished={inFlight === 0 && running === 0}
            chosenPhase={chosenPhase}
            onChoosePhase={setChosenPhase}
            query={query}
            onQueryChange={setQuery}
            expandedAgent={expandedAgent}
            onToggleAgent={toggleAgent}
            onOpenTranscript={openTranscript}
          />
        </div>
      </div>}

      {transcriptTarget && (
        <WorkflowTranscriptModal
          target={{ ...transcriptTarget, live: agents.find(a => a.agentId === transcriptTarget.agentId)?.status === 'running' }}
          sessionId={sessionId}
          onClose={() => setTranscriptTarget(null)}
        />
      )}
    </div>
    </>
  );
});
