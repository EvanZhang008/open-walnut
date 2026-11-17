/**
 * What a change link pill and its card read (src/core/changes/model.ts holds the shape and the
 * pill's words): which tag has a change snapshot, the words for review and stage states, the
 * card's one-line summary (where it is, what holds it, who moves next), and which pipeline stages
 * the card folds. Pure, so the rules are tested without a browser (tests/web/change-status.test.ts).
 */
import {
  type ChangeBlocker, type ChangeBlockerKind, type ChangeDeploy, type ChangeDeployIssue, type ChangeReview, type ChangeReviewState,
  type ChangeSnapshot, type ChangeStage, type ChangeStageStatus, type ChangeTone,
} from '../../../../src/core/changes/model';
import { linkUrlOfTag } from '../../../../src/core/link-tags';
import { watchablePrUrls } from '../../../../src/core/pull-requests/model';

/** The part of a task the change pill reads. */
export interface ChangeTask { id?: string; change_status?: Readonly<Record<string, ChangeSnapshot>> }

/** The snapshot a link tag's change has on its task, keyed by the tag's URL. A GitHub pull
 *  request has none here: its status is the pull request pill's (PrPill.tsx, which shows its
 *  deploy too), so one change never reads twice on a row. */
export function changeOfTag(task: ChangeTask | undefined, tag: string): ChangeSnapshot | undefined {
  const url = linkUrlOfTag(tag);
  if (!url || watchablePrUrls([tag]).length) return undefined;
  return task?.change_status?.[url];
}

export const REVIEW_WORDS: Record<ChangeReviewState, string> = {
  draft: 'Draft', open: 'In review', approved: 'Approved', changes_requested: 'Changes requested', merged: 'Merged', closed: 'Closed',
};

/** A review state's tone. */
export const REVIEW_TONES: Record<ChangeReviewState, ChangeTone> = {
  draft: 'waiting', open: 'waiting', approved: 'done', changes_requested: 'blocked', merged: 'done', closed: 'closed',
};

export const STAGE_WORDS: Record<ChangeStageStatus, string> = {
  done: 'Deployed', running: 'Deploying', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed', pending: 'Not reached',
};

export const STAGE_TONES: Record<ChangeStageStatus, ChangeTone> = {
  done: 'done', running: 'running', waiting: 'waiting', blocked: 'blocked', failed: 'blocked', pending: 'unknown',
};

export const BLOCKER_WORDS: Record<ChangeBlockerKind, string> = {
  bake: 'Bake', window: 'Time window', approval: 'Approval', alarm: 'Alarm', failure: 'Failure', hold: 'Hold',
};

/** "1/2 approvals", "7 checks passed": the review's facts in words, absent ones left out. */
export function reviewFacts(review: ChangeReview): string[] {
  const out: string[] = [];
  const a = review.approvals;
  if (a) out.push(a.need ? `${a.got}/${a.need} approvals` : `${a.got} ${a.got === 1 ? 'approval' : 'approvals'}`);
  const c = review.checks;
  if (c) {
    const total = c.passed + c.failed + c.pending;
    if (!total) out.push('No checks');
    else if (c.failed) out.push(`${c.failed} of ${total} checks failed`);
    else if (c.pending) out.push(`${c.pending} of ${total} checks running`);
    else out.push(`${c.passed} checks passed`);
  }
  if (review.revision && review.revision > 1) out.push(`Revision ${review.revision}`);
  return out;
}

/** A short clock time (`today 16:16`, `11-16 16:16` on another day), in the viewer's zone. */
export function stageTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  return d.toDateString() === today.toDateString() ? `today ${hm}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** "in 7 h 12 min", "in 25 min", "now": how long until a blocker ends by itself. */
export function untilWords(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `in ${h} h ${rest} min` : `in ${h} h`;
}

/** A stage that asks for a look: it moves, waits, is stuck, or carries a blocker. */
function asksLook(stage: ChangeStage): boolean {
  return stage.status === 'running' || stage.status === 'waiting' || stage.status === 'blocked' || stage.status === 'failed' || !!stage.blocker;
}

/** Who moves a stuck or waiting stage on: a person, or time. */
export function whoMoves(blocker: ChangeBlocker | undefined, status: ChangeStageStatus, now = Date.now()): { person: boolean; text: string } {
  switch (blocker?.kind) {
    case 'bake':
    case 'window': {
      const when = untilWords(blocker.until, now);
      return { person: false, text: when ? `Moves on by itself ${when}` : 'Moves on by itself' };
    }
    case 'approval': return { person: true, text: 'Waits for an approval' };
    case 'hold': return { person: true, text: 'Held until someone releases it' };
    case 'alarm': return { person: true, text: 'An alarm needs a look' };
    case 'failure': return { person: true, text: 'Needs someone to look' };
    default:
      if (status === 'failed' || status === 'blocked') return { person: true, text: 'Needs someone to look' };
      return { person: false, text: 'Moves on by itself' };
  }
}

/** The card's summary: the one thing to read first, what it means, and who moves next. */
export interface ChangeHeadline {
  tone: ChangeTone;
  title: string;
  detail?: string;
  next?: { person: boolean; text: string };
  /** Other stages that ask for a look, one line each, at most two. */
  also: string[];
  /** The stage the headline is about, for the card's button that opens it. */
  stage?: string;
}

function stageLine(stage: ChangeStage, now: number): string {
  const what = stage.blocker?.text ?? stage.note ?? STAGE_WORDS[stage.status];
  const when = stage.blocker?.until ? `, opens ${stageTime(stage.blocker.until, now)} (${untilWords(stage.blocker.until, now)})` : '';
  return `${stage.name}: ${what}${when}`;
}

/** Why a change shows no deploy, or an older one, in words (ChangeSnapshot.deployIssue). */
export function deployIssueWords(issue: ChangeDeployIssue): string {
  return issue.code === 'none' ? `No deploy found: ${issue.message}` : `Could not read the deploy: ${issue.message}`;
}

export function changeHeadline(snap: Pick<ChangeSnapshot, 'review' | 'deploy' | 'deployIssue'>, now = Date.now()): ChangeHeadline {
  const { review, deploy } = snap;
  if (deploy && deploy.stages.length) {
    const stages = deploy.stages;
    const stuck = stages.find((s) => s.status === 'failed' || s.status === 'blocked');
    const waiting = stages.find((s) => s.status === 'waiting');
    const running = stages.find((s) => s.status === 'running');
    const lead = stuck ?? waiting ?? running;
    const also = stages.filter((s) => s !== lead && asksLook(s)).slice(0, 2).map((s) => stageLine(s, now));
    if (lead) {
      const verb = lead.status === 'failed' ? 'Failed at' : lead.status === 'blocked' ? 'Stuck at'
        : lead.status === 'running' ? 'Deploying to' : lead.blocker?.kind === 'bake' ? 'Baking at' : 'Waiting at';
      const detail = lead.blocker?.text ?? lead.note;
      return {
        tone: STAGE_TONES[lead.status], title: `${verb} ${lead.name}`, ...(detail ? { detail } : {}),
        next: whoMoves(lead.blocker, lead.status, now), also, stage: lead.name,
      };
    }
    if (deploy.done) return { tone: 'done', title: `Deployed to all ${stages.length} ${stages.length === 1 ? 'stage' : 'stages'}`, also };
    if (deploy.last) return { tone: 'running', title: `Deployed up to ${deploy.last}`, ...(deploy.next ? { detail: `Next: ${deploy.next}` } : {}), next: { person: false, text: 'Moves on by itself' }, also };
    return { tone: 'running', title: 'Merged, not deployed yet', next: { person: false, text: 'Starts by itself' }, also };
  }
  if (!review) return { tone: 'unknown', title: 'No status yet', also: [] };
  switch (review.state) {
    // A merged change whose deploy is missing says why, never only "Merged".
    case 'merged': return { tone: 'done', title: 'Merged', ...(snap.deployIssue ? { detail: deployIssueWords(snap.deployIssue) } : {}), also: [] };
    case 'closed': return { tone: 'closed', title: 'Closed without merging', also: [] };
    case 'changes_requested': return { tone: 'blocked', title: 'Changes requested', next: { person: true, text: 'Waits for the author' }, also: [] };
    case 'draft': return { tone: 'waiting', title: 'Draft', next: { person: true, text: 'Waits for the author to send it' }, also: [] };
    default: break;
  }
  if (review.checks?.failed) return { tone: 'blocked', title: 'Checks failed', next: { person: true, text: 'Waits for the author' }, also: [] };
  if (review.state === 'approved') return { tone: 'done', title: 'Approved', next: { person: true, text: 'Ready to merge' }, also: [] };
  const a = review.approvals;
  const left = a?.need ? a.need - a.got : 0;
  return {
    tone: 'waiting',
    title: left > 0 ? `Waiting for ${left} more ${left === 1 ? 'approval' : 'approvals'}` : 'Waiting for review',
    ...(!a?.need && review.waitingOn ? { detail: `Waiting on ${review.waitingOn}` } : {}),
    also: [],
  };
}

/** How far a deploy got: stages deployed, of how many, and the stage it last reached. */
export function deployCounts(deploy: Pick<ChangeDeploy, 'stages' | 'last'>): { done: number; total: number; last?: string } {
  return {
    done: deploy.stages.filter((s) => s.status === 'done').length,
    total: deploy.stages.length,
    ...(deploy.last ? { last: deploy.last } : {}),
  };
}

/** A pipeline this short shows every stage. */
export const FOLD_AT = 7;

export type StageRow =
  | { kind: 'stage'; stage: ChangeStage; index: number }
  | { kind: 'fold'; status: 'done' | 'pending'; stages: ChangeStage[]; from: number }
  /** An opened fold's first row: it folds the run again. */
  | { kind: 'hide'; status: 'done' | 'pending'; size: number; from: number };

/**
 * The card's deploy rows. A pipeline of FOLD_AT stages or more shows the stages that ask for a
 * look (they move, wait, are stuck, or carry a blocker) and the stage it last reached; every
 * other run of two or more deployed or not-reached stages folds into one row ("5 deployed",
 * "14 not reached"). A fold the person opened (`opened`, by the name of its first stage, so a
 * new read that moves a stage keeps it) draws its stages again.
 */
export function stageRows(stages: readonly ChangeStage[], last?: string, opened: ReadonlySet<string> = new Set()): StageRow[] {
  if (stages.length < FOLD_AT) return stages.map((stage, index) => ({ kind: 'stage', stage, index }));
  // A stage not reached with a note says what it waits on: it stays, like the stage last reached.
  const keep = (s: ChangeStage) => asksLook(s) || s.name === last || (s.status !== 'done' && s.status !== 'pending') || (s.status === 'pending' && !!s.note);
  const rows: StageRow[] = [];
  let i = 0;
  while (i < stages.length) {
    const s = stages[i]!;
    if (keep(s)) { rows.push({ kind: 'stage', stage: s, index: i }); i++; continue; }
    const status = s.status as 'done' | 'pending';
    let end = i;
    while (end < stages.length && stages[end]!.status === status && !keep(stages[end]!)) end++;
    if (end - i >= 2 && !opened.has(s.name)) rows.push({ kind: 'fold', status, stages: stages.slice(i, end), from: i });
    else {
      if (end - i >= 2) rows.push({ kind: 'hide', status, size: end - i, from: i });
      for (let k = i; k < end; k++) rows.push({ kind: 'stage', stage: stages[k]!, index: k });
    }
    i = end;
  }
  return rows;
}

/** Groups of the track: consecutive stages whose names share their first word (`build-`, `prod-`),
 *  for a pipeline long enough to fold and made of a few such groups; else none. */
export function trackGroups(stages: readonly ChangeStage[]): Array<{ label: string; from: number; size: number }> {
  if (stages.length < FOLD_AT) return [];
  const word = (name: string) => /^([A-Za-z0-9]+)[-_.]/.exec(name)?.[1] ?? name;
  const groups: Array<{ label: string; from: number; size: number }> = [];
  stages.forEach((s, i) => {
    const w = word(s.name);
    const last = groups.at(-1);
    if (last && last.label === w) last.size++;
    else groups.push({ label: w, from: i, size: 1 });
  });
  return groups.length >= 2 && groups.length <= 8 ? groups : [];
}

/** The fold that holds a stage, by the name of the fold's first stage (to open it). */
export function foldOf(rows: readonly StageRow[], index: number): string | undefined {
  for (const row of rows) {
    if (row.kind === 'fold' && index >= row.from && index < row.from + row.stages.length) return row.stages[0]!.name;
  }
  return undefined;
}
