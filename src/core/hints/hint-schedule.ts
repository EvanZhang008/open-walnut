/**
 * When a message hint is due: the triggers of one hint read against what this
 * session was told. Pure; hint-send.ts feeds it the session's state.
 *
 *   every_turn        every message
 *   every_n_turns     N messages after it last went out (N = every_turns, default 5)
 *   session_start     the session was never told this hint
 *   after_compaction  told before the session's latest compaction boundary
 *                     (`SessionRecord.lastCompactUuid`, the boundary the place and
 *                     instruction notices use: one boundary, not a second tracker)
 *   on_change         what it says now differs from what the session was told
 *   on_drift          a reply since it last went out broke its rule (hint-drift.ts)
 *   on_request        the sender asked for it on this message (a voice send, a question)
 */

import type { MessageHintTrigger, SessionHintTold } from '../types.js';

export const DEFAULT_EVERY_TURNS = 5;

export interface HintDueInput {
  triggers: readonly MessageHintTrigger[];
  everyTurns?: number;
  told?: SessionHintTold;
  /** The number this send will get (the session's counter + 1). */
  send: number;
  /** What the hint says now. */
  identity: string;
  compactUuid?: string;
  /** When a reply last drifted off this hint's rule. */
  driftAt?: string;
  requested: boolean;
}

/** Every trigger that holds for this send, in registry order. Empty = not due. */
export function dueReasons(i: HintDueInput): MessageHintTrigger[] {
  const out: MessageHintTrigger[] = [];
  const told = i.told;
  for (const t of i.triggers) {
    switch (t) {
      case 'every_turn':
        out.push(t);
        break;
      case 'every_n_turns': {
        const n = i.everyTurns && i.everyTurns > 0 ? i.everyTurns : DEFAULT_EVERY_TURNS;
        if (i.send - (told?.send ?? 0) >= n) out.push(t);
        break;
      }
      case 'session_start':
        if (!told) out.push(t);
        break;
      case 'after_compaction':
        if (told && i.compactUuid && told.compact !== i.compactUuid) out.push(t);
        break;
      case 'on_change':
        if (told && told.hash !== i.identity) out.push(t);
        break;
      case 'on_drift':
        if (i.driftAt && (!told || Date.parse(i.driftAt) > Date.parse(told.at))) out.push(t);
        break;
      case 'on_request':
        if (i.requested) out.push(t);
        break;
    }
  }
  return out;
}
