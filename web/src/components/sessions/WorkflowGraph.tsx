/**
 * WorkflowGraph — flow-graph visualization of a dynamic workflow's phases + agents.
 *
 * The CLI gives us only "ordered phases × a bag of agents per phase" — there are NO
 * agent→agent dependency edges. So we render a LAYERED view (phase = layer), never a
 * free-form DAG. Two orientations driven by available space:
 *
 *   - vertical   (narrow / Home Panel, the PRIMARY surface): stacked phase timeline.
 *   - horizontal (fullscreen ⤢): swimlane columns + SVG connectors between phases.
 *
 * Within a phase, render adapts to agent count (Level-of-Detail):
 *   - ≤ DENSITY_THRESHOLD agents → individual clickable nodes.
 *   - >  DENSITY_THRESHOLD agents → a density bar (status histogram + aggregate),
 *     click to expand the full (height-capped) list. Keeps a 400-agent fan-out to a
 *     bounded height.
 *
 * Data is display-only (mirrors WorkflowProgress's contract): nothing here feeds
 * turn-completion. Node click reuses the parent's expand state + transcript modal.
 */

import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowPhase, WorkflowAgent } from '@/hooks/useBackgroundTasks';
import { buildLayout, phaseCounts, DENSITY_THRESHOLD, type LaidOutPhase } from './workflow-layout';

// ── shared formatting helpers (exported — WorkflowProgress reuses for its legacy path) ──
export function fmtTokens(n?: number): string {
  if (!n) return '';
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
function fmtDuration(ms?: number): string {
  if (!ms) return '';
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}
/** Short model label that KEEPS the version (e.g. "opus-4-8"), per the user's
 *  preference to distinguish versions — not just "opus". */
function shortModel(model?: string): string {
  if (!model) return '';
  const last = model.split('.').pop() ?? model;
  return last.replace(/^claude-/, '').replace(/-v\d+.*$/, '').replace(/\[1m\]$/, ' 1M');
}
export function agentMeta(agent: WorkflowAgent): string {
  return [shortModel(agent.model), fmtTokens(agent.tokens) && `${fmtTokens(agent.tokens)} tok`, fmtDuration(agent.durationMs)]
    .filter(Boolean).join(' · ');
}

export function StatusDot({ status }: { status: string }) {
  if (status === 'running') return <span className="wf-task-dot wf-task-dot-running" title="Running">{'●'}</span>;
  if (status === 'completed') return <span className="wf-task-dot wf-task-dot-done" title="Completed">{'✓'}</span>;
  if (status === 'failed') return <span className="wf-task-dot wf-task-dot-error" title="Failed">{'✗'}</span>;
  if (status === 'stopped' || status === 'killed') return <span className="wf-task-dot wf-task-dot-stopped" title="Stopped">{'■'}</span>;
  if (status === 'paused') return <span className="wf-task-dot wf-task-dot-paused" title="Paused">{'⏸'}</span>;
  return <span className="wf-task-dot wf-task-dot-pending" title="Pending">{'⏳'}</span>;
}

// ── one agent: clickable node with inline prompt/result + transcript (shared by both orientations) ──
const AgentNode = memo(function AgentNode({
  agent, expanded, onToggle, onOpenTranscript, variant,
}: {
  agent: WorkflowAgent; expanded: boolean; variant: 'row' | 'card';
  onToggle: () => void; onOpenTranscript: (a: WorkflowAgent) => void;
}) {
  const meta = agentMeta(agent);
  return (
    <div className={`wf-gnode wf-gnode-${variant} wf-gnode-${agent.status} ${expanded ? 'wf-gnode-expanded' : ''}`}>
      <button className="wf-gnode-head" onClick={onToggle} title={agent.agentId}>
        <span className="wf-gnode-caret">{expanded ? '▾' : '▸'}</span>
        <StatusDot status={agent.status} />
        <span className="wf-gnode-name">{agent.label || agent.agentId.slice(0, 8)}</span>
        {meta && <span className="wf-gnode-meta">{meta}</span>}
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
              : <div className="wf-agent-result wf-agent-result-empty">{agent.status === 'running' ? 'Running…' : 'No result yet'}</div>}
          </div>
          <button className="wf-transcript-toggle" onClick={() => onOpenTranscript(agent)}>View full transcript →</button>
        </div>
      )}
    </div>
  );
});

// ── density bar: aggregate histogram for a large fan-out; click to expand the list ──
const DensityBar = memo(function DensityBar({
  agents, expanded, onToggleExpand, renderNode,
}: {
  agents: WorkflowAgent[]; expanded: boolean; onToggleExpand: () => void;
  renderNode: (a: WorkflowAgent) => React.ReactNode;
}) {
  const c = phaseCounts(agents);
  return (
    <div className="wf-density">
      <div className="wf-density-stats">
        {c.done > 0 && <span className="wf-density-stat"><span className="wf-task-dot wf-task-dot-done">{'✓'}</span> {c.done} done</span>}
        {c.running > 0 && <span className="wf-density-stat"><span className="wf-task-dot wf-task-dot-running">{'●'}</span> {c.running} running</span>}
        {c.failed > 0 && <span className="wf-density-stat"><span className="wf-task-dot wf-task-dot-error">{'✗'}</span> {c.failed} failed</span>}
        {c.tokens > 0 && <span className="wf-density-stat">Σ {fmtTokens(c.tokens)} tok</span>}
      </div>
      <button
        className="wf-density-bar"
        onClick={onToggleExpand}
        title={expanded ? 'Collapse' : `Expand all ${c.total} agents`}
        aria-label={`${c.done} done, ${c.running} running, ${c.failed} failed of ${c.total} agents — ${expanded ? 'collapse' : 'expand'}`}
      >
        {/* cells are a decorative histogram — the aria-label above carries the numbers */}
        {agents.map(a => <span key={a.agentId} aria-hidden="true" className={`wf-density-cell wf-density-cell-${a.status}`} title={`${a.label || a.agentId.slice(0, 8)} · ${a.status}`} />)}
      </button>
      <button className="wf-density-more" onClick={onToggleExpand}>{expanded ? '▾ collapse' : `▸ expand all ${c.total} agents`}</button>
      {expanded && <div className="wf-density-list">{agents.map(renderNode)}</div>}
    </div>
  );
});

// ── one phase body: nodes (≤K) or density bar (>K) ──
function PhaseBody({
  agents, variant, expandedAgent, densityOpen, onToggleAgent, onToggleDensity, onOpenTranscript,
}: {
  agents: WorkflowAgent[]; variant: 'row' | 'card'; expandedAgent: string | null; densityOpen: boolean;
  onToggleAgent: (id: string) => void; onToggleDensity: () => void; onOpenTranscript: (a: WorkflowAgent) => void;
}) {
  const node = (a: WorkflowAgent) => (
    <AgentNode key={a.agentId} agent={a} variant={variant}
      expanded={expandedAgent === a.agentId}
      onToggle={() => onToggleAgent(a.agentId)} onOpenTranscript={onOpenTranscript} />
  );
  if (agents.length > DENSITY_THRESHOLD) {
    return <DensityBar agents={agents} expanded={densityOpen} onToggleExpand={onToggleDensity} renderNode={node} />;
  }
  return <>{agents.map(node)}</>;
}

export const WorkflowGraph = memo(function WorkflowGraph({
  phases, agents, orientation, expandedAgent, onToggleAgent, onOpenTranscript,
}: {
  phases: WorkflowPhase[]; agents: WorkflowAgent[];
  orientation: 'vertical' | 'horizontal';
  expandedAgent: string | null;
  onToggleAgent: (id: string) => void;
  onOpenTranscript: (a: WorkflowAgent) => void;
}) {
  // Memoize: buildLayout does several sort/filter/reduce passes, and `layout` feeds
  // HorizontalLanes' useLayoutEffect deps — without this, a fresh array identity on
  // every live snapshot would re-run the effect (tearing down + rebuilding the
  // ResizeObserver and forcing a getBoundingClientRect reflow) on each snapshot.
  const layout = useMemo(() => buildLayout(phases, agents), [phases, agents]);
  // Which phases have their density bar expanded (keyed by phase index).
  const [openDensity, setOpenDensity] = useState<Set<number>>(new Set());
  const toggleDensity = (idx: number) => setOpenDensity(prev => {
    const next = new Set(prev);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    return next;
  });

  const phaseHeader = (p: LaidOutPhase) => {
    const c = phaseCounts(p.agents);
    return (
      <div className="wf-gphase-head">
        {p.title && <span className="wf-gphase-title">{p.title}</span>}
        <span className="wf-gphase-count">{c.done}/{c.total}{c.running > 0 ? ` · ${c.running} run` : ''}</span>
      </div>
    );
  };
  const body = (p: LaidOutPhase, variant: 'row' | 'card') => (
    <PhaseBody agents={p.agents} variant={variant} expandedAgent={expandedAgent}
      densityOpen={openDensity.has(p.index)}
      onToggleAgent={onToggleAgent} onToggleDensity={() => toggleDensity(p.index)} onOpenTranscript={onOpenTranscript} />
  );

  if (orientation === 'vertical') {
    return (
      <div className="wf-graph wf-graph-vertical">
        {layout.map(p => (
          <div key={p.index} className="wf-gphase">
            {phaseHeader(p)}
            <div className="wf-gphase-rail">{body(p, 'row')}</div>
          </div>
        ))}
      </div>
    );
  }
  return <HorizontalLanes layout={layout} phaseHeader={phaseHeader} body={body} />;
});

// ── horizontal swimlanes + SVG connectors between consecutive phases ──
function HorizontalLanes({
  layout, phaseHeader, body,
}: {
  layout: LaidOutPhase[];
  phaseHeader: (p: LaidOutPhase) => React.ReactNode;
  body: (p: LaidOutPhase, variant: 'row' | 'card') => React.ReactNode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const laneRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [edges, setEdges] = useState<{ d: string; barrier: boolean }[]>([]);

  // Recompute connector paths from lane geometry whenever size/content changes.
  useLayoutEffect(() => {
    // Drop stale ref slots if the lane count shrank (sparse/reordered snapshots) so we
    // never read a detached node from a prior, longer render.
    laneRefs.current.length = layout.length;
    const compute = () => {
      const wrap = wrapRef.current;
      if (!wrap) return;
      const base = wrap.getBoundingClientRect();
      const next: { d: string; barrier: boolean }[] = [];
      for (let i = 1; i < layout.length; i++) {
        const a = laneRefs.current[i - 1]?.getBoundingClientRect();
        const b = laneRefs.current[i]?.getBoundingClientRect();
        if (!a || !b) continue;
        const sx = a.right - base.left, sy = a.top - base.top + a.height / 2;
        const tx = b.left - base.left, ty = b.top - base.top + b.height / 2;
        const mx = (sx + tx) / 2;
        next.push({ d: `M ${sx} ${sy} C ${mx} ${sy} ${mx} ${ty} ${tx} ${ty}`, barrier: layout[i].barrierFromPrev });
      }
      setEdges(next);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [layout]);

  return (
    <div className="wf-graph wf-graph-horizontal" ref={wrapRef}>
      <svg className="wf-graph-edges" aria-hidden="true">
        {edges.map((e, i) => (
          <path key={i} d={e.d} className={`wf-graph-edge ${e.barrier ? 'wf-graph-edge-barrier' : 'wf-graph-edge-flow'}`} />
        ))}
      </svg>
      {layout.map((p, i) => (
        <div key={p.index} className="wf-glane" ref={el => { laneRefs.current[i] = el; }}>
          {phaseHeader(p)}
          <div className="wf-glane-body">{body(p, 'card')}</div>
        </div>
      ))}
    </div>
  );
}
