/**
 * What the `brief` message hint tells Main or a lead about its Brief (hints/hint-registry.ts): how
 * old it is and what moved since, so the node updates it itself (2026-10-31, the user: "每三轮提示他
 * 一下 ... 你有什么新的 update，你要自己去写"). Read on the send path for Main and the leads only.
 */
import type { Task } from '../types.js';
import { agoWords } from '../user-status.js';
import { briefFreshness, freshnessWords } from './brief-fresh.js';

export interface BriefHintState {
  /** When the Brief was written (ISO); null = it has none yet. */
  at: string | null;
  /** Something moved since it was written. */
  stale: boolean;
  /** "2 lines moved since · 1 ask added by Walnut". */
  words: string;
  /** What moved, as one key: a new move is a new thing to say (on_change). */
  key: string;
}

export function briefHintStateOf(owner: Task, tasks: readonly Task[]): BriefHintState | null {
  if (owner.org_role !== 'main' && owner.org_role !== 'lead') return null;
  if (!owner.brief?.text) return { at: null, stale: true, words: '', key: 'none' };
  const f = briefFreshness(owner, tasks);
  if (!f) return null;
  // A moved line's words are not part of it: a line reworded again is no new thing to say.
  const key = [...f.moved.map((m) => `${m.id}:${m.state === 'needs' ? 'needs' : 'open'}`), ...f.finished.map((id) => `${id}:done`), ...f.newAsks.map((id) => `${id}:ask`)].join(',');
  return { at: owner.brief.at, stale: f.stale, words: freshnessWords(f), key: key || 'fresh' };
}

/** The hint's words: behind (moved since, or none yet), or the plain reminder. */
export function briefHintText(state: BriefHintState, nowMs = Date.now()): string {
  if (!state.at) {
    return 'you keep no Brief yet. Write it now with brief_write (content: the three sections "### Needs you", "### Working", '
      + '"### Waiting / snoozed", one line per piece of work starting with its <task-ref/>); brief_read lists your team by its live status.';
  }
  const age = agoWords(Math.max(0, nowMs - Date.parse(state.at)));
  if (state.stale) {
    return `your Brief was written ${age} and is behind (${state.words}). Update it now with brief_write (edits for the lines that `
      + 'changed); brief_read compact:true shows only what moved, with the lines to edit.';
  }
  return `your Brief was written ${age}. When anything you or your teams did changes what the user should know, update it with brief_write.`;
}
