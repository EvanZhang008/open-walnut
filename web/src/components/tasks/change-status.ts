/**
 * What a change link pill and its card read (src/core/changes/model.ts holds the shape and the
 * pill's words): which tag has a change snapshot, the words for review and stage states, and
 * which pipeline stages the card folds. Pure, so the rules are tested without a browser
 * (tests/web/change-status.test.ts).
 */
import {
  type ChangeBlockerKind, type ChangeReview, type ChangeReviewState, type ChangeSnapshot, type ChangeStage,
  type ChangeStageStatus, type ChangeTone,
} from '../../../../src/core/changes/model';
import { linkUrlOfTag } from '../../../../src/core/link-tags';

/** The part of a task the change pill reads. */
export interface ChangeTask { id?: string; change_status?: Readonly<Record<string, ChangeSnapshot>> }

/** The snapshot a link tag's change has on its task, keyed by the tag's URL. */
export function changeOfTag(task: ChangeTask | undefined, tag: string): ChangeSnapshot | undefined {
  const url = linkUrlOfTag(tag);
  return url ? task?.change_status?.[url] : undefined;
}

export const REVIEW_WORDS: Record<ChangeReviewState, string> = {
  draft: 'Draft', open: 'In review', approved: 'Approved', changes_requested: 'Changes requested', merged: 'Merged', closed: 'Closed',
};

/** A review state's tone, the pill's five colours. */
export const REVIEW_TONES: Record<ChangeReviewState, ChangeTone> = {
  draft: 'waiting', open: 'running', approved: 'done', changes_requested: 'blocked', merged: 'done', closed: 'closed',
};

export const STAGE_WORDS: Record<ChangeStageStatus, string> = {
  done: 'Deployed', running: 'Deploying', waiting: 'Waiting', blocked: 'Blocked', failed: 'Failed', pending: 'Not reached',
};

export const STAGE_TONES: Record<ChangeStageStatus, ChangeTone> = {
  done: 'done', running: 'running', waiting: 'waiting', blocked: 'blocked', failed: 'blocked', pending: 'unknown',
};

/** A step's or a stage's mark, so a state never reads by colour alone. */
export const STATUS_MARKS: Record<ChangeStageStatus, string> = {
  done: '✓', running: '▸', waiting: '…', blocked: '!', failed: '✕', pending: '·',
};

export const BLOCKER_WORDS: Record<ChangeBlockerKind, string> = {
  bake: 'Bake', window: 'Time window', approval: 'Approval', alarm: 'Alarm', failure: 'Failure', hold: 'Hold',
};

/** "1/2 approvals", "3 passed, 1 failed": the review's facts in words, absent ones left out. */
export function reviewFacts(review: ChangeReview): string[] {
  const out: string[] = [];
  if (review.revision) out.push(`Revision ${review.revision}`);
  const a = review.approvals;
  if (a) out.push(a.need ? `${a.got}/${a.need} approvals` : `${a.got} ${a.got === 1 ? 'approval' : 'approvals'}`);
  const c = review.checks;
  if (c) {
    const parts = [c.passed && `${c.passed} passed`, c.failed && `${c.failed} failed`, c.pending && `${c.pending} running`].filter(Boolean);
    out.push(parts.length ? `Checks: ${parts.join(', ')}` : 'No checks');
  }
  return out;
}

/** A run of more not-reached stages than this folds into one row. */
export const FOLD_RUN = 6;

export type StageRow =
  | { kind: 'stage'; stage: ChangeStage; index: number }
  | { kind: 'fold'; stages: ChangeStage[]; from: number };

/**
 * The card's deploy rows: every stage in pipeline order, except that a run of more than FOLD_RUN
 * consecutive not-reached stages keeps its first (the next stage, which says what it waits on)
 * and folds the rest into one "N more stages" row. A fold the person opened (`opened`, by the
 * index of its first stage) draws its stages again.
 */
export function stageRows(stages: readonly ChangeStage[], opened: ReadonlySet<number> = new Set()): StageRow[] {
  const rows: StageRow[] = [];
  let i = 0;
  while (i < stages.length) {
    if (stages[i]!.status !== 'pending') { rows.push({ kind: 'stage', stage: stages[i]!, index: i }); i++; continue; }
    let end = i;
    while (end < stages.length && stages[end]!.status === 'pending') end++;
    const run = end - i;
    if (run > FOLD_RUN && !opened.has(i + 1)) {
      rows.push({ kind: 'stage', stage: stages[i]!, index: i });
      rows.push({ kind: 'fold', stages: stages.slice(i + 1, end), from: i + 1 });
    } else {
      for (let k = i; k < end; k++) rows.push({ kind: 'stage', stage: stages[k]!, index: k });
    }
    i = end;
  }
  return rows;
}

/** A short clock time for a stage row (`11-16 16:16`), in the viewer's zone. */
export function stageTime(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const today = new Date(now);
  return d.toDateString() === today.toDateString() ? hm : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}
