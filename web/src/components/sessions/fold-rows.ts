/**
 * Which rows of a session's timeline fold together: ONE rule for every row.
 *
 * Every row that is a step of the work (a tool call, a failed one too, a message
 * received or sent, context the CLI put in, reasoning alone, the no-action line,
 * a line the runtime wrote such as an API error or a retry) joins the stretch of
 * quiet steps around it, in every kind of turn and across every turn boundary,
 * and each stretch is ONE folded row. Only a row the person reads ends a stretch:
 * words, the person's own message, a question's labelled row, a question to the
 * person, a plan or an agent's card, a fork or gap divider, an Asked-from list.
 * A call still running is a step too (its fold's row breathes while the turn
 * runs; the phone folds it the same way). A failure is not one of them: the fold's header counts it in
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
  /** No result yet: a step, and its fold breathes while the turn runs (2026-10-30:
   *  a lead's run with one command still going sat as its own "Ran 3 commands"
   *  row under the fold before it). */
  running: true,
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
  // A card first: a call the timeline draws as its own card (a plan, a question's answer).
  if (!isFoldableCall(t)) return 'card';
  if (t.result === undefined && !t.isError) return 'running';
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
  /** A person's own message is at or before this row in its turn: what the session wrote from
   *  there on answers the person. */
  afterPerson: boolean;
  /** Short words on the way (narration: a line or two, no table, heading, code or list). */
  narration?: boolean;
  /** A turn with no answer yet (running, or cut off) has more of its rows after this one:
   *  the words here are on the way, not where the turn ended. */
  beforeEnd?: boolean;
}

/**
 * Words that only narrate the way to an answer ("It is the same deliverable, so I
 * reopen it"): short, no table, heading, code block or list. Before the answer they
 * fold with the steps (2026-11-11, the user: "I only want to know the question I asked
 * and last message AI had"); words with any of those stay on screen, so a real answer
 * with its table never folds under a short last line (2026-11-09).
 */
export function isNarration(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  const lines = t.split('\n').filter((l) => l.trim());
  if (lines.length > 4) return false;
  if (lines.some((l) => /^\s*(#|\||```|~~~|>)/.test(l))) return false;
  // A picture it points to renders inline (an image path, a screenshot): that is shown, not narration.
  if (/\.(png|jpe?g|gif|webp|svg|heic)\b/i.test(t) || /!\[[^\]]*\]\(/.test(t)) return false;
  return lines.filter((l) => /^\s*([-*+]|\d+[.)])\s/.test(l)).length < 2;
}

/** Does the row join the stretch of quiet steps? The same answer in every turn
 *  kind, plus what a turn's shape folds on top: a whole hidden turn, and
 *  everything before an answer (narration included), except that a row the person
 *  reads after the person's own message folds only when it is narration before the
 *  answer (isNarration): the session's words answering them stay on screen wherever
 *  the turn's last line is (2026-11-09, the user, of a whole answer with its table
 *  folded under "Sent 1 · Ran 2 tools" because one short line came after it: "why
 *  this get auto collpes this si nto right"). */
export function joinsQuiet(r: PlaceRead): boolean {
  if (r.personStart || r.labelled) return false;
  // Narration with more of its turn after it folds with the steps around it, in a turn
  // that has its answer and in one that has none yet (2026-11-11, the user, of a running
  // turn whose short line between steps split its fold in two: "If they are togter they
  // need ot be collpesed").
  const onTheWay = !!r.narration && ((r.turn === 'answered' && r.beforeAnswer) || (r.turn === 'open' && !!r.beforeEnd));
  if (r.afterPerson && r.role === 'reads' && !onTheWay) return false;
  if (r.turn === 'hidden' || (r.turn === 'answered' && r.beforeAnswer)) return true;
  return r.role === 'step' || onTheWay;
}

/**
 * What a fold's red count holds: its failed calls, and apart from them the runtime's error lines
 * (2026-11-09: a Codex session's fold read "Ran 344 tools · 7859 failed", because 7,835 error
 * lines of a steering retry loop were counted as failed calls). "N failed" counts calls only, so it
 * never exceeds the calls the fold ran; error lines read "N errors".
 */
export interface FoldFailures { calls: number; errors: number }

export interface FailureRowRead<T> {
  role: string;
  systemVariant?: string;
  tools?: readonly T[];
}

/** Count a stretch of rows' failures; `failedCall` says whether one call failed. */
export function countFoldFailures<T>(rows: Iterable<{ row: FailureRowRead<T>; toolsShown: boolean }>, failedCall: (t: T) => boolean): FoldFailures {
  const out: FoldFailures = { calls: 0, errors: 0 };
  for (const { row, toolsShown } of rows) {
    if (row.role === 'system' && row.systemVariant === 'error') out.errors++;
    if (toolsShown) out.calls += (row.tools ?? []).filter(failedCall).length;
  }
  return out;
}

/** The red words of a fold's header: "2 failed", "1 error", "2 failed · 3 errors", or none. */
export function foldFailureWords(f: number | FoldFailures): string {
  const { calls, errors } = typeof f === 'number' ? { calls: f, errors: 0 } : f;
  const parts: string[] = [];
  if (calls > 0) parts.push(`${calls} failed`);
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  return parts.join(' · ');
}
