import { memo, useMemo } from 'react';
import type { WorkflowPhase, WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { buildLayout, phaseCounts, preferredPhase, visibleWorkflowAgents } from './workflow-layout';
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

export const WorkflowGraph = memo(function WorkflowGraph({ phases, agents, chosenPhase, onChoosePhase, query, onQueryChange, expandedAgent, onToggleAgent, onOpenTranscript }: {
  phases: WorkflowPhase[];
  agents: WorkflowAgent[];
  chosenPhase: number | null;
  onChoosePhase: (index: number) => void;
  query: string;
  onQueryChange: (query: string) => void;
  expandedAgent: string | null;
  onToggleAgent: (id: string) => void;
  onOpenTranscript: (agent: WorkflowAgent) => void;
}) {
  const layout = useMemo(() => buildLayout(phases, agents), [phases, agents]);
  const selected = layout.find(phase => phase.index === chosenPhase) ?? preferredPhase(layout);
  const searching = query.trim().length > 0;
  const visible = visibleWorkflowAgents(layout, selected?.index, query);
  const counts = selected ? phaseCounts(selected.agents) : null;

  return (
    <div className="wf-overview">
      <nav className="wf-phase-nav" aria-label="Workflow phases">
        {layout.map((phase, order) => {
          const count = phaseCounts(phase.agents);
          const active = !searching && selected?.index === phase.index;
          return (
            <button key={phase.index} className={`wf-phase-link ${active ? 'wf-phase-link-active' : ''}`}
              onClick={() => { onChoosePhase(phase.index); onQueryChange(''); }} aria-current={active ? 'step' : undefined}>
              <span className="wf-phase-order">{String(order + 1).padStart(2, '0')}</span>
              <span className="wf-phase-label">{phase.title || 'Other'}</span>
              <span className="wf-phase-count">{count.done}/{count.total}</span>
              {count.failed > 0 && <span className="wf-phase-failed">{count.failed} failed</span>}
              {count.running > 0 && <span className="wf-phase-running">{count.running} running</span>}
            </button>
          );
        })}
      </nav>
      <div className="wf-overview-main">
        <div className="wf-overview-tools">
          <div className="wf-overview-heading">
            <span className="wf-overview-title">{searching ? 'Search results' : selected?.title || 'Other'}</span>
            <span className="wf-overview-count">{searching ? `${visible.length} matches` : `${counts?.total ?? 0} agents`}</span>
          </div>
          <input className="wf-search" type="search" value={query} onChange={event => onQueryChange(event.target.value)}
            aria-label="Find agents" placeholder="Find agents in this workflow…" />
        </div>
        <div className="wf-overview-list">
          {visible.length ? visible.map(agent => (
            <AgentRow key={agent.agentId} agent={agent} expanded={expandedAgent === agent.agentId}
              onToggle={() => onToggleAgent(agent.agentId)} onOpenTranscript={onOpenTranscript} />
          )) : <div className="wf-empty">{searching ? 'No matching agents' : 'No agents in this phase'}</div>}
        </div>
      </div>
    </div>
  );
});
