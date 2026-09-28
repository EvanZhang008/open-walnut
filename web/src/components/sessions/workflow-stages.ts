/**
 * How the stages of a workflow relate, read from the agents' own clocks.
 *
 * The CLI reports phases and agents, never which agent fed which. What it does
 * report is when each agent was handed its work (queuedAt), when it started and how
 * long it ran. That is enough to say, honestly, how one stage followed the last:
 *
 *   after all   the next stage appeared once every agent before it had finished
 *               (reads "splits into 5", "merges 75 into 1", "after all 25, fans out to 75")
 *   stream      the next stage appeared while the one before was still working:
 *               each finished agent handed off on its own
 *   branches    two phases appeared together and ran side by side
 *   loop        the earlier stage came back after this one started (review, fix, review)
 *   next        nothing has appeared yet: no count is claimed before it exists
 *   then        the agents carry no clock, so only the counts are shown
 *
 * While a stage still has agents working it may get more (the CLI names a queued
 * agent only when it starts), so its sentence counts "so far" instead of claiming
 * a shape: "after all 15, 8 so far", never "narrows to 8" before it fans out to 20.
 *
 * Pure data, no React (same convention as workflow-layout.ts).
 */

import type { WorkflowAgent } from '@/hooks/useBackgroundTasks';
import type { LaidOutPhase } from './workflow-layout';

/** Two phases whose first agents appeared this close together started together. */
const TOGETHER_MS = 1500;

export type StageLinkKind = 'split' | 'merge' | 'after' | 'branches' | 'stream' | 'loop' | 'next' | 'then';

export interface StageLink {
  kind: StageLinkKind;
  /** One or two words for a narrow connector: "splits", "after all", "streams". */
  verb: string;
  /** The counts the verb applies to: "1 → 5", "5 → 25", "round 3". */
  counts: string;
  /** The whole sentence: "starts as each finishes (5 → 25)". */
  long: string;
}

/** A phase card's state. `waiting` = everything here finished, but the stage feeding it still runs, so more may come. */
export type StageState = 'future' | 'running' | 'waiting' | 'done' | 'failed';

export interface StagePhase extends LaidOutPhase {
  state: StageState;
  done: number;
  running: number;
  pending: number;
  failed: number;
  total: number;
  /** Wall time from the first agent's hand-off to the last agent's end (finished phases only). */
  spanMs?: number;
}

export interface Stage {
  /** Usually one phase; several when they appeared together and ran side by side. */
  phases: StagePhase[];
  /** How this stage followed the one before it (absent on the first). */
  link?: StageLink;
}

const RUNNING = new Set(['running', 'paused']);
const TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);

const appearedAt = (a: WorkflowAgent) => a.queuedAt ?? a.startedAt;
/** Infinity while it works; undefined when a finished agent never reported its span. */
function endedAt(a: WorkflowAgent): number | undefined {
  if (!TERMINAL.has(a.status)) return Infinity;
  return a.startedAt != null && a.durationMs != null ? a.startedAt + a.durationMs : undefined;
}

function firstAppearance(agents: WorkflowAgent[]): number | undefined {
  let first: number | undefined;
  for (const a of agents) {
    const t = appearedAt(a);
    if (t != null && (first == null || t < first)) first = t;
  }
  return first;
}

function count(agents: WorkflowAgent[]) {
  let done = 0, running = 0, pending = 0, failed = 0;
  for (const a of agents) {
    if (RUNNING.has(a.status)) running++;
    else if (a.status === 'failed') failed++;
    else if (TERMINAL.has(a.status)) done++;
    else pending++;
  }
  return { done, running, pending, failed, total: agents.length };
}

function span(agents: WorkflowAgent[]): number | undefined {
  const first = firstAppearance(agents);
  let last: number | undefined;
  for (const a of agents) {
    const end = endedAt(a);
    if (end == null || end === Infinity) return undefined;
    if (last == null || end > last) last = end;
  }
  return first != null && last != null ? last - first : undefined;
}

const titles = (phases: LaidOutPhase[]) => phases.map(p => p.title || 'Other').join(' + ');

/** The loop round when the earlier stage came back after this one started, else 0. */
function loopRound(from: WorkflowAgent[], to: WorkflowAgent[]): { round: number; perFrom: number; perTo: number } {
  const events: [number, 'A' | 'B'][] = [];
  for (const a of from) { const t = appearedAt(a); if (t != null) events.push([t, 'A']); }
  for (const a of to) { const t = appearedAt(a); if (t != null) events.push([t, 'B']); }
  events.sort((x, y) => x[0] - y[0]);
  const runs: ('A' | 'B')[] = [];
  for (const [, who] of events) if (runs[runs.length - 1] !== who) runs.push(who);
  if (runs[0] !== 'A' || runs.length < 3) return { round: 0, perFrom: 0, perTo: 0 };
  const per = (n: number, who: 'A' | 'B') => Math.max(1, Math.round(n / runs.filter(r => r === who).length));
  return { round: Math.ceil(runs.length / 2), perFrom: per(from.length, 'A'), perTo: per(to.length, 'B') };
}

function linkBetween(from: LaidOutPhase[], to: LaidOutPhase[], growing: boolean): StageLink {
  const a = from.flatMap(p => p.agents), b = to.flatMap(p => p.agents);
  const nFrom = a.length, nTo = b.length;
  if (nTo === 0) return { kind: 'next', verb: 'next', counts: '', long: 'next' };
  const bFirst = firstAppearance(b);
  if (bFirst == null || firstAppearance(a) == null) {
    return { kind: 'then', verb: 'then', counts: `${nFrom} → ${nTo}`, long: `${nFrom} → ${nTo}` };
  }
  const loop = loopRound(a, b);
  if (loop.round >= 2) {
    return {
      kind: 'loop', verb: 'takes turns', counts: `round ${loop.round}`,
      long: `takes turns with ${titles(from)}: round ${loop.round}, ${loop.perFrom} → ${loop.perTo} each round`,
    };
  }
  // Still busy at the moment the next stage appeared: it did not wait for all of them.
  const busy = a.some(x => {
    const t = appearedAt(x), end = endedAt(x);
    return t != null && t <= bFirst && end != null && end > bFirst + TOGETHER_MS;
  });
  if (busy) return { kind: 'stream', verb: 'streams', counts: `${nFrom} → ${nTo}`, long: `starts as each finishes (${nFrom} → ${nTo})` };
  const soFar = growing ? ' so far' : '';
  if (to.length > 1) {
    const parts = to.map(p => p.agents.length).join(' + ');
    return {
      kind: 'branches', verb: 'branches', counts: `${nFrom} → ${parts}`,
      long: nFrom === 1 ? `splits into ${to.length} branches (${parts}${soFar})` : `after all ${nFrom}, ${to.length} branches (${parts}${soFar})`,
    };
  }
  if (nFrom === 1 && nTo > 1) return { kind: 'split', verb: 'splits', counts: `1 → ${nTo}`, long: growing ? `splits, ${nTo} so far` : `splits into ${nTo}` };
  // One after one claims no shape, so it reads the same live and settled.
  if (nFrom === 1 && nTo === 1) return { kind: 'after', verb: 'then', counts: '1 → 1', long: 'then' };
  if (growing) return { kind: nTo === 1 ? 'merge' : 'after', verb: 'after all', counts: `${nFrom} → ${nTo}`, long: `after all ${nFrom}, ${nTo} so far` };
  if (nTo === 1 && nFrom > 1) return { kind: 'merge', verb: 'merges', counts: `${nFrom} → 1`, long: `merges ${nFrom} into 1` };
  const long = nTo > nFrom ? `after all ${nFrom}, fans out to ${nTo}` : nTo < nFrom ? `after all ${nFrom}, narrows to ${nTo}` : `after all ${nFrom}`;
  return { kind: 'after', verb: 'after all', counts: `${nFrom} → ${nTo}`, long };
}

/**
 * Stages in order, each with the phases that ran side by side in it, its cards'
 * states, and how it followed the stage before. `layout` must keep phases that
 * have no agents yet (they render as "next"); `finished` is the whole run being over.
 */
export function buildStages(layout: LaidOutPhase[], finished: boolean): Stage[] {
  const groups: LaidOutPhase[][] = [];
  let prevFirst: number | undefined;
  for (const phase of layout) {
    const first = firstAppearance(phase.agents);
    const last = groups[groups.length - 1];
    if (last && first != null && prevFirst != null && Math.abs(first - prevFirst) < TOGETHER_MS) last.push(phase);
    else groups.push([phase]);
    prevFirst = first;
  }
  const stages: Stage[] = groups.map((group, i) => ({
    phases: [],
    link: i > 0
      ? linkBetween(groups[i - 1], group, !finished && group.some(p => p.agents.some(a => !TERMINAL.has(a.status))))
      : undefined,
  }));
  groups.forEach((group, i) => {
    const feederRunning = i > 0 && groups[i - 1].some(p => p.agents.some(a => !TERMINAL.has(a.status)));
    const laterStarted = groups.slice(i + 1).some(g => g.some(p => p.agents.length > 0));
    const fedLive = stages[i].link?.kind === 'stream' || stages[i].link?.kind === 'loop';
    stages[i].phases = group.map(phase => {
      const c = count(phase.agents);
      const open = c.running + c.pending > 0;
      let state: StageState;
      if (c.total === 0) state = 'future';
      else if (open) state = 'running';
      else if (fedLive && feederRunning && !laterStarted && !finished) state = 'waiting';
      else state = c.failed > 0 ? 'failed' : 'done';
      return { ...phase, ...c, state, spanMs: open ? undefined : span(phase.agents) };
    });
  });
  return stages;
}
