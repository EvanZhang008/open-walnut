/**
 * Which rows of a session's timeline fold together: ONE rule for every row.
 *
 * Every row that is a step of the work (a tool call, a failed one too, a message
 * received or sent, context the CLI put in, reasoning alone, the no-action line,
 * a line the runtime wrote such as an API error or a retry) joins the stretch of
 * quiet steps around it, in every kind of turn and across every turn boundary,
 * and each stretch is ONE folded row. Only a row the person reads ends a stretch:
 * words, the person's own message, a question's labelled row, a question to the
 * person, a plan or an agent's card, a call still running, a fork or gap divider,
 * an Asked-from list. A failure is not one of them: the fold's header counts it in
 * red ("1 failed"), and its line names the runtime's other lines ("1 notice"), so
 * nothing is folded away unread. SessionChatHistory's `msgKindOf` switches over
 * every part kind (a new one does not type-check until it is placed).
 *
 * 2026-10-30, the user, the fourth report of the same split ("listen, all these
 * need to be combined"): three fold rows sat back to back, "Received 1 message",
 * "Ran 4 commands · 1 failed", "Received 1 message · Ran 1 tool · 20 failed",
 * because each earlier fix folded one more row kind while a failed call and the
 * runtime's error lines still ended a stretch in a turn with no answer. The
 * tables below name every row kind; tests/web/fold-rows.test.ts fails when a
 * new one appears that they do not place. iOS: TimelineTurnFold.isQuiet.
 */
import type { TurnKind } from '../../utils/turn-shape';

export type RowRole = 'step' | 'reads';

/** Every `systemVariant` a history row carries, and a plain system row (`none`).
 *  All are the runtime's own lines and fold as steps: an error one is counted in
 *  the fold's red "N failed", any other one on its line ("1 notice"), so a line
 *  the person should see (a compaction, a retry) is never folded away unnamed. */
export const SYSTEM_VARIANT_ROLE = {
  compact: 'step',
  error: 'step',
  info: 'step',
  none: 'step',
} as const satisfies Record<string, RowRole>;

/** What a single message row is, and its role. */
export const MSG_KIND_ROLE = {
  /** A row at a fork divider or a gap: it carries the divider. */
  boundary: 'reads',
  system: 'step',
  /** A message or notice sent in with no person's words in it. */
  received: 'step',
  /** Context the CLI put in (a loaded skill, a hook's context). */
  context: 'step',
  thinking: 'step',
  ack: 'step',
  /** Calls only, each one a step (`toolRole`). */
  calls: 'step',
  /** Words, the person's own message, or a call that is not a step. */
  other: 'reads',
} as const satisfies Record<string, RowRole>;
export type MsgKind = keyof typeof MSG_KIND_ROLE;

export type ToolRole = 'step' | 'question' | 'running' | 'card';

/** Every tool role, and whether it folds. */
export const TOOL_ROLE_FOLDS = {
  step: true,
  /** AskUserQuestion: the person answers it. */
  question: false,
  /** No result yet: it stays on screen with its own bar. */
  running: false,
  /** A plan, an agent's card, leaving plan mode: drawn as their own card. */
  card: false,
} as const satisfies Record<ToolRole, boolean>;

export interface ToolRead {
  name: string;
  result?: unknown;
  isError?: boolean;
}

/** One call's role. A failed call is a step: its fold's header says "N failed". */
export function toolRole<T extends ToolRead>(t: T, isFoldableCall: (t: T) => boolean): ToolRole {
  if (t.name === 'AskUserQuestion') return 'question';
  if (t.result === undefined && !t.isError) return 'running';
  if (!isFoldableCall(t)) return 'card';
  return 'step';
}

export interface PlaceRead {
  role: RowRole;
  /** The row's turn; null when it has none (it renders open). */
  turn: TurnKind | null;
  /** The person's own message that opened its turn. */
  personStart: boolean;
  /** A question's own row in Conversation Mode (it carries the label). */
  labelled: boolean;
  /** An answered turn's row before its answer. */
  beforeAnswer: boolean;
}

/** Does the row join the stretch of quiet steps? The same answer in every turn
 *  kind, plus what a turn's shape folds on top: a whole hidden turn, and
 *  everything before an answer (narration included). */
export function joinsQuiet(r: PlaceRead): boolean {
  if (r.personStart || r.labelled) return false;
  if (r.turn === 'hidden' || (r.turn === 'answered' && r.beforeAnswer)) return true;
  return r.role === 'step';
}
