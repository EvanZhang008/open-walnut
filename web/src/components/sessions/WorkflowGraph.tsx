import { memo, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { WorkflowPhase, WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { buildLayout, NO_PHASE_OPEN, preferredPhase, visibleWorkflowAgents } from './workflow-layout';
import { buildStages } from './workflow-stages';
import { StageColumn, StageStrip } from './WorkflowStageGraph';
import { fmtTokens } from './background-ledger';

export { fmtTokens };

function fmtDuration(ms?: number): string {
  if (!ms) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function shortModel(model?: string): string {
  if (!model) return '';
  const last = model.split('.').pop() ?? model;
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '').replace(/\[1m\]$/, ' 1M');
}

export function agentMeta(agent: WorkflowAgent): string {
  return [
    shortModel(agent.model),
    agent.toolCalls != null && `${agent.toolCalls} tools`,
    fmtTokens(agent.tokens) && `${fmtTokens(agent.tokens)} tok`,
    fmtDuration(agent.durationMs),
  ].filter(Boolean).join(' · ');
}

export function StatusDot({ status }: { status: string }) {
  if (status === 'running') return <span className="wf-task-dot wf-task-dot-running" title="Running">{'●'}</span>;
  if (status === 'completed') return <span className="wf-task-dot wf-task-dot-done" title="Completed">{'✓'}</span>;
  if (status === 'failed') return <span className="wf-task-dot wf-task-dot-error" title="Failed">{'✗'}</span>;
  if (status === 'stopped' || status === 'killed') return <span className="wf-task-dot wf-task-dot-stopped" title="Stopped">{'■'}</span>;
  if (status === 'paused') return <span className="wf-task-dot wf-task-dot-paused" title="Paused">{'⏸'}</span>;
  return <span className="wf-task-dot wf-task-dot-pending" title="Pending">{'○'}</span>;
}

const statusLabel = (status: string) => {
  if (status === 'completed') return 'Done';
  if (status === 'failed') return 'Failed';
  if (status === 'stopped' || status === 'killed') return 'Stopped';
  if (status === 'paused') return 'Paused';
  if (status === 'running') return 'Running';
  return 'Pending';
};

const AgentRow = memo(function AgentRow({ agent, expanded, onToggle, onOpenTranscript }: {
  agent: WorkflowAgent;
  expanded: boolean;
  onToggle: () => void;
  onOpenTranscript: (agent: WorkflowAgent) => void;
}) {
  const name = agent.label || agent.agentId;
  const meta = agentMeta(agent);
  return (
    <div className={`wf-gnode wf-gnode-${agent.status} ${expanded ? 'wf-gnode-expanded' : ''}`}>
      <button className="wf-gnode-head" onClick={onToggle} aria-expanded={expanded} title={name}>
        <StatusDot status={agent.status} />
        <span className="wf-gnode-main">
          <span className="wf-gnode-name">{name}</span>
          <span className="wf-gnode-meta">{statusLabel(agent.status)}{meta && ` · ${meta}`}</span>
        </span>
        <span className="wf-gnode-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
      </button>
      {expanded && (
        <div className="wf-agent-detail">
          {agent.promptPreview && (
            <div className="wf-agent-block">
              <div className="wf-agent-block-label">Prompt</div>
              <div className="wf-agent-prompt">{agent.promptPreview}</div>
            </div>
          )}
          {agent.error && (
            <div className="wf-agent-block">
              <div className="wf-agent-block-label">Error</div>
              <div className="wf-agent-result wf-agent-error">{agent.error}</div>
            </div>
          )}
          <div className="wf-agent-block">
            <div className="wf-agent-block-label">Result</div>
            {agent.resultPreview
              ? <div className="wf-agent-result">{agent.resultPreview}</div>
              : <div className="wf-agent-result wf-agent-result-empty">{agent.status === 'running' ? 'Running…' : 'No result available'}</div>}
          </div>
          <button className="wf-transcript-toggle" onClick={() => onOpenTranscript(agent)}>View full transcript →</button>
        </div>
      )}
    </div>
  );
});

/** True when the overview is wide enough to read the stages left to right. */
function useIsWide(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWide(el.clientWidth > min);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, min]);
  return wide;
}

/** Wider than this, the stages read left to right with the list below them. */
const WIDE_MIN_PX = 620;

export const WorkflowGraph = memo(function WorkflowGraph({ phases, agents, finished, chosenPhase, onChoosePhase, query, onQueryChange, expandedAgent, onToggleAgent, onOpenTranscript }: {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  /** The whole run is over: a stage fed one by one can no longer get more agents. */
  finished: boolean;
  /** null = follow the phase that needs attention; NO_PHASE_OPEN = the user closed it. */
  chosenPhase: number | null;
  onChoosePhase: (index: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
  expandedAgent: string | null;
  onToggleAgent: (id: string) => void;
  onOpenTranscript: (agent: WorkflowAgent) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const wide = useIsWide(rootRef, WIDE_MIN_PX);
  const all = useMemo(() => buildLayout(phases, agents, { keepEmpty: true }), [phases, agents]);
  const layout = useMemo(() => all.filter(phase => phase.agents.length > 0), [all]);
  const stages = useMemo(() => buildStages(all, finished), [all, finished]);
  const auto = preferredPhase(layout)?.index;
  // The wide layout always shows one phase's list; the narrow one may have none open.
  const openIndex = chosenPhase === NO_PHASE_OPEN ? (wide ? auto : undefined) : (chosenPhase ?? auto);
  const searching = query.trim().length > 0;
  const choose = (index: number) => {
    onQueryChange('');
    onChoosePhase(!wide && index === openIndex ? NO_PHASE_OPEN : index);
  };
  const stagePhase = (index: number | undefined) => stages.flatMap(s => s.phases).find(p => p.index === index);
  const linkInto = (index: number | undefined) => stages.find(s => s.phases.some(p => p.index === index))?.link;

  const list = (agentsShown: WorkflowAgent[], empty: string) => (
    <div className="wf-overview-list">
      {agentsShown.length ? agentsShown.map(agent => (
        <AgentRow key={agent.agentId} agent={agent} expanded={expandedAgent === agent.agentId}
          onToggle={() => onToggleAgent(agent.agentId)} onOpenTranscript={onOpenTranscript} />
      )) : <div className="wf-empty">{empty}</div>}
    </div>
  );
  const results = visibleWorkflowAgents(layout, undefined, query);
  const openPhase = stagePhase(openIndex);
  const openLink = linkInto(openIndex);

  return (
    <div ref={rootRef} className={`wf-overview ${wide ? 'wf-overview--wide' : 'wf-overview--narrow'}`}>
      <div className="wf-overview-tools">
        <input className="wf-search" type="search" value={query} onChange={event => onQueryChange(event.target.value)}
          aria-label="Find agents" placeholder="Find agents in this workflow…" />
      </div>
      {wide && <StageStrip stages={stages} openIndex={searching ? undefined : openIndex} onChoose={choose} />}
      {searching ? (
        <div className="wf-overview-main">
          <div className="wf-overview-heading">
            <span className="wf-overview-title">Search results</span>
            <span className="wf-overview-count">{results.length} matches</span>
          </div>
          {list(results, 'No matching agents')}
        </div>
      ) : wide ? (
        <div className="wf-overview-main">
          <div className="wf-overview-heading">
            <span className="wf-overview-title">{openPhase?.title || 'Other'}</span>
            <span className="wf-overview-count">{openPhase?.total ?? 0} agents</span>
            {openLink && openLink.kind !== 'next' && <span className="wf-overview-link">{openLink.long}</span>}
          </div>
          {list(visibleWorkflowAgents(layout, openIndex, ''), 'No agents yet: they appear when this phase starts')}
        </div>
      ) : (
        <StageColumn stages={stages} openIndex={openIndex} onChoose={choose}
          renderList={phase => list(visibleWorkflowAgents(layout, phase.index, ''), 'No agents yet: they appear when this phase starts')} />
      )}
    </div>
  );
});
