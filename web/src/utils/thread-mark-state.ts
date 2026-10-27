/**
 * What a question's passage mark says (Conversation Mode and file marks), as one
 * pure rule (2026-10-26, the user: queued is yellow and visibly waiting, the
 * first answer text turns it green and moving, a finished answer nobody opened
 * is red until its card is opened, then green again; a new question on it
 * starts over at yellow).
 *
 *  - waiting: sent (or queued behind another turn) and no answer text yet;
 *  - answering: its answer text is streaming in;
 *  - unread: the answer finished after the question was last viewed;
 *  - failed: its last turn ended without an answer (error, interrupt, silent);
 *  - read: viewed since its newest answer (or never viewed here: not announced);
 *  - resolved: archived.
 *
 * Tree Mode paints branch hues and does not read this.
 */
import type { ThreadLiveState } from '@/utils/thread-meta';
import { ROOT_THREAD_KEY, type ThreadNode, type ThreadTree } from '@/utils/thread-tree';

export type ThreadMarkState = 'waiting' | 'answering' | 'unread' | 'failed' | 'read' | 'resolved';

/** Most urgent first: where marks overlap, the first one paints on top. */
export const MARK_STATE_ORDER: readonly ThreadMarkState[] = ['waiting', 'answering', 'unread', 'failed', 'read', 'resolved'];

/** Higher is more urgent (resolved 0 ... waiting 5). */
export function markStateRank(state: ThreadMarkState | undefined): number {
  if (!state) return 0;
  return MARK_STATE_ORDER.length - 1 - MARK_STATE_ORDER.indexOf(state);
}

export interface MarkStateInput {
  live?: ThreadLiveState;
  /** Its own newest send still waits in the queue (a follow-up behind its own
   *  answer included: that new question has not started). */
  queued?: boolean;
  /** Its newest send failed to deliver. */
  unsent?: boolean;
  /** The live turn already has answer text for this question. */
  spoke?: boolean;
  /** Asked in this tab and nothing came back since (the turn has not started). */
  pending?: boolean;
  /** When its newest answer landed (ms). */
  answeredAt?: number;
  /** When its page or card was last viewed (ms); undefined = never here. */
  lastViewedAt?: number;
  /** Its page or card is on screen now. */
  viewing?: boolean;
  resolved?: boolean;
}

export function markStateOf(i: MarkStateInput): ThreadMarkState {
  if (i.resolved) return 'resolved';
  if (i.queued) return 'waiting';
  if (i.live === 'answering') return i.spoke ? 'answering' : 'waiting';
  if (i.live === 'queued') return 'waiting';
  if (i.live === 'failed' || i.unsent) return 'failed';
  if (i.pending) return 'waiting';
  // Never viewed here (asked elsewhere, or before this was kept): not announced.
  if (!i.viewing && i.answeredAt !== undefined && i.lastViewedAt !== undefined && i.answeredAt > i.lastViewedAt) return 'unread';
  return 'read';
}

export interface MarkStatesInput {
  tree: ThreadTree;
  live: ReadonlyMap<string, ThreadLiveState>;
  /** Keys whose live turn has answer text. */
  spoke: ReadonlySet<string>;
  answeredAt: ReadonlyMap<string, number>;
  /** When this tab saw each answer land, on this tab's clock (askedAt's clock). */
  datedAt: ReadonlyMap<string, number>;
  /** Questions with a send of this tab on its way / still queued / failed to deliver. */
  sentKeys: ReadonlySet<string>;
  queuedKeys: ReadonlySet<string>;
  unsentKeys: ReadonlySet<string>;
  /** By HEAD id, as the stack keeps it. */
  lastViewedAt: ReadonlyMap<string, number>;
  /** The question on screen ('' = none). */
  viewingKey: string;
  /** Key to when this tab last sent into it (ms). */
  askedAt: ReadonlyMap<string, number>;
  isResolved: (node: ThreadNode) => boolean;
}

export function markStatesOf(input: MarkStatesInput): Map<string, ThreadMarkState> {
  const out = new Map<string, ThreadMarkState>();
  for (const node of input.tree.threads) {
    if (node.key === ROOT_THREAD_KEY) continue;
    const answeredAt = input.answeredAt.get(node.key);
    const asked = input.askedAt.get(node.key);
    const lastViewedAt = input.lastViewedAt.get(node.headId);
    const live = input.live.get(node.key);
    out.set(node.key, markStateOf({
      ...(live ? { live } : {}),
      queued: input.queuedKeys.has(node.key),
      unsent: input.unsentKeys.has(node.key),
      spoke: input.spoke.has(node.key),
      // Sent from here and not answered since, on this tab's own clock (a host
      // clock ahead would hide it), while the send is still on its way: a
      // withdrawn or undelivered send waits for nothing.
      pending: asked !== undefined && asked > (input.datedAt.get(node.key) ?? -Infinity)
        && (input.sentKeys.has(node.key) || live === 'queued' || live === 'answering'),
      ...(answeredAt !== undefined ? { answeredAt } : {}),
      ...(lastViewedAt !== undefined ? { lastViewedAt } : {}),
      viewing: node.key === input.viewingKey,
      resolved: input.isResolved(node),
    }));
  }
  return out;
}

export function sameMarkStates(a: ReadonlyMap<string, ThreadMarkState>, b: ReadonlyMap<string, ThreadMarkState>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/** What the mark's tooltip adds after `Open “title”` (null: nothing). */
export const MARK_STATE_TIP: Record<ThreadMarkState, string | null> = {
  waiting: 'waiting for an answer',
  answering: 'answering',
  unread: 'new answer',
  failed: 'no answer',
  read: null,
  resolved: null,
};
