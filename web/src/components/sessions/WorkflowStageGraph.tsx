/**
 * The workflow as a CI-style stage graph: one card per phase, and between cards a
 * connector whose lines and words say how the next stage followed (splits into 5,
 * starts as each finishes, after all 25, merges 75 into 1, takes turns). Phases that
 * ran side by side share a row. Narrow columns stack it top to bottom; wide ones and
 * fullscreen read it left to right. The relationships come from workflow-stages.ts.
 */

import { memo, type ReactNode } from 'react';
import { fmtElapsed } from './background-ledger';
import type { Stage, StageLink, StagePhase } from './workflow-stages';

/** Lines drawn per side of a connector: enough to read a fan at a glance. */
const MAX_LINES = 5;

function StageIcon({ state }: { state: StagePhase['state'] }) {
  if (state === 'running') return <span className="wf-stage-icon wf-stage-icon--running" aria-hidden="true"><span className="task-group-streaming-dot" /></span>;
  if (state === 'done') return <span className="wf-stage-icon wf-stage-icon--done" aria-hidden="true">✓</span>;
  if (state === 'failed') return <span className="wf-stage-icon wf-stage-icon--failed" aria-hidden="true">!</span>;
  return <span className={`wf-stage-icon wf-stage-icon--${state}`} aria-hidden="true" />;
}

function StageMeter({ phase }: { phase: StagePhase }) {
  const pct = (n: number) => `${(n / phase.total) * 100}%`;
  return (
    <span className="wf-stage-meter" aria-hidden="true">
      <span className="wf-stage-meter-done" style={{ width: pct(phase.done) }} />
      <span className="wf-stage-meter-failed" style={{ width: pct(phase.failed) }} />
      <span className="wf-stage-meter-running" style={{ width: pct(phase.running) }} />
      <span className="wf-stage-meter-pending" style={{ width: pct(phase.pending) }} />
    </span>
  );
}

function subline(phase: StagePhase, feeder: string): string {
  if (phase.state === 'future') return 'Not started';
  if (phase.state === 'waiting') return `Waiting on ${feeder}`;
  const span = fmtElapsed(phase.spanMs);
  if (phase.state === 'done') return span ? `Done in ${span}` : 'Done';
  const parts = [
    phase.running > 0 && `${phase.running} running`,
    phase.pending > 0 && `${phase.pending} waiting`,
    phase.failed > 0 && `${phase.failed} failed`,
  ].filter(Boolean) as string[];
  if (phase.state === 'failed' && span) parts.push(span);
  return parts.join(' · ');
}

const PhaseCard = memo(function PhaseCard({ phase, feeder, open, onChoose }: {
  phase: StagePhase;
  feeder: string;
  open: boolean;
  onChoose: (index: number) => void;
}) {
  const title = phase.title || 'Other';
  return (
    <button
      className={`wf-stage-card wf-stage-card--${phase.state}${open ? ' wf-stage-card--open' : ''}`}
      onClick={() => onChoose(phase.index)}
      aria-expanded={open}
      data-phase-index={phase.index}
      title={title}
    >
      <span className="wf-stage-card-head">
        <StageIcon state={phase.state} />
        <span className="wf-stage-card-title">{title}</span>
        <span className="wf-stage-card-count">{phase.total ? `${phase.done + phase.failed}/${phase.total}` : 'next'}</span>
      </span>
      {phase.total > 0 && <StageMeter phase={phase} />}
      <span className={`wf-stage-card-sub${phase.state === 'failed' ? ' wf-stage-card-sub--failed' : ''}`}>{subline(phase, feeder)}</span>
    </button>
  );
});

/** The lines of a connector: `from` points fan into `to` points (normalised 0..100 box). */
function fanLines(from: number, to: number): [number, number][] {
  const a = Math.min(MAX_LINES, Math.max(1, from)), b = Math.min(MAX_LINES, Math.max(1, to));
  const x = (i: number, n: number) => ((i + 1) / (n + 1)) * 100;
  if (a === 1) return Array.from({ length: b }, (_, j) => [50, x(j, b)]);
  if (b === 1) return Array.from({ length: a }, (_, i) => [x(i, a), 50]);
  return Array.from({ length: Math.max(a, b) }, (_, i) => [x(Math.min(i, a - 1), a), x(Math.min(i, b - 1), b)]);
}

function agentCount(stage: Stage): number {
  return stage.phases.reduce((n, p) => n + p.total, 0);
}

/** The paths of a vertical connector. A wait for all gathers every line into one
 *  point before fanning out again; a stream keeps them apart (each hands off alone). */
function linkPaths(kind: StageLink['kind'], from: number, to: number): string[] {
  if (kind === 'next') return ['M50,0 L50,28'];
  if (kind === 'after' && from > 1 && to > 1) {
    const x = (i: number, n: number) => ((i + 1) / (n + 1)) * 100;
    const a = Math.min(MAX_LINES, from), b = Math.min(MAX_LINES, to);
    return [
      ...Array.from({ length: a }, (_, i) => `M${x(i, a)},0 C${x(i, a)},8 50,8 50,14`),
      ...Array.from({ length: b }, (_, j) => `M50,14 C50,20 ${x(j, b)},20 ${x(j, b)},28`),
    ];
  }
  return fanLines(from, to).map(([x0, x1]) => `M${x0},0 C${x0},14 ${x1},14 ${x1},28`);
}

/** Top-to-bottom connector: fanned lines with the sentence beside them. */
function VerticalLink({ link, from, to }: { link: StageLink; from: number; to: number }) {
  return (
    <div className={`wf-stage-link wf-stage-link--v wf-stage-link--${link.kind}`} data-link-kind={link.kind}>
      <svg className="wf-stage-link-lines" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
        {linkPaths(link.kind, from, to).map((d, i) => <path key={i} d={d} vectorEffect="non-scaling-stroke" />)}
      </svg>
      {link.kind !== 'next' && <span className="wf-stage-link-label" title={link.long}>{link.long}</span>}
    </div>
  );
}

/** Left-to-right connector: the verb above an arrow, the counts below it. */
function HorizontalLink({ link }: { link: StageLink }) {
  return (
    <div className={`wf-stage-link wf-stage-link--h wf-stage-link--${link.kind}`} data-link-kind={link.kind} title={link.long}>
      <span className="wf-stage-link-verb">{link.kind === 'next' ? '' : link.verb}</span>
      <svg className="wf-stage-link-arrow" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
        <path d="M2,5 L94,5" vectorEffect="non-scaling-stroke" />
        {link.kind !== 'next' && <path className="wf-stage-link-head" d="M88,1 L96,5 L88,9" vectorEffect="non-scaling-stroke" />}
      </svg>
      <span className="wf-stage-link-counts">{link.counts}</span>
    </div>
  );
}

const feederOf = (stages: Stage[], i: number) => i > 0 ? stages[i - 1].phases.map(p => p.title || 'Other').join(' + ') : '';

/** Narrow layout: stages stacked, the open phase's agent list right under its row. */
export function StageColumn({ stages, openIndex, onChoose, renderList }: {
  stages: Stage[];
  openIndex: number | undefined;
  onChoose: (index: number) => void;
  renderList: (phase: StagePhase) => ReactNode;
}) {
  return (
    <div className="wf-stage-graph wf-stage-graph--column" aria-label="Workflow stages">
      {stages.map((stage, i) => {
        const open = stage.phases.find(p => p.index === openIndex);
        return (
          <div key={stage.phases[0].index} className="wf-stage">
            {stage.link && <VerticalLink link={stage.link} from={agentCount(stages[i - 1])} to={agentCount(stage)} />}
            <div className="wf-stage-row">
              {stage.phases.map(p => <PhaseCard key={p.index} phase={p} feeder={feederOf(stages, i)} open={p.index === openIndex} onChoose={onChoose} />)}
            </div>
            {open && <div className="wf-stage-list">{renderList(open)}</div>}
          </div>
        );
      })}
    </div>
  );
}

/** Wide layout: stages left to right (wrapping), the chosen phase highlighted. */
export function StageStrip({ stages, openIndex, onChoose }: {
  stages: Stage[];
  openIndex: number | undefined;
  onChoose: (index: number) => void;
}) {
  return (
    <div className="wf-stage-graph wf-stage-graph--strip" aria-label="Workflow stages">
      {stages.map((stage, i) => (
        <div key={stage.phases[0].index} className="wf-stage">
          {stage.link && <HorizontalLink link={stage.link} />}
          <div className="wf-stage-stack">
            {stage.phases.map(p => <PhaseCard key={p.index} phase={p} feeder={feederOf(stages, i)} open={p.index === openIndex} onChoose={onChoose} />)}
          </div>
        </div>
      ))}
    </div>
  );
}
