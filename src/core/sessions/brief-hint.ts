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
  // One line of what is new; how a Brief is written is in the prompt (session-context.ts BRIEF_LINE).
  if (!state.at) return 'you keep no Brief yet: write it with brief_write.';
  if (state.stale) return `your Brief is behind (${state.words}): update it with brief_write.`;
  return `your Brief was written ${agoWords(Math.max(0, nowMs - Date.parse(state.at)))}.`;
}
