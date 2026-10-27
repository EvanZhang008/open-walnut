/**
 * The live turn's steps, as one row where nothing a person reads sits between them.
 *
 * The stream panel folds each kind on its own: a stretch of tools and reasoning is
 * one run row ("Ran 31 commands ›"), neighbouring cards an agent sent are one
 * "Received a message ›" row. So a turn that kept receiving notices while it worked
 * read "Received a message › / Thinking › / Received a message › / Ran 31 commands
 * › / Received a message › / Ran a command ›", six rows and not a word between them
 * (2026-10-26, the user: "still why this is not merged"). A group here is every step
 * and every agent card in a row; one that holds both kinds becomes one fold, the way
 * history folds the same rows once the turn is over (process-fold.ts).
 *
 * Pure: the caller says what each timeline item is.
 *  · `step`: a tool call or reasoning block a run row would take;
 *  · `card`: a card an agent sent, nothing but envelopes (folds on arrival);
 *  · `silent`: draws nothing, so it neither joins nor ends a group;
 *  · `other`: anything a reader sees (words, a person's message, a notice, a
 *    question, an agent chip): it ends the group.
 */
export type StepKind = 'step' | 'card' | 'silent' | 'other';

export interface StepGroup {
  /** Timeline indices of the group's steps and cards, in order (no silent ones). */
  members: number[];
  cards: number;
  steps: number;
}

/** Every maximal group of steps and cards. */
export function stepGroups(kinds: readonly StepKind[]): StepGroup[] {
  const out: StepGroup[] = [];
  let cur: StepGroup | null = null;
  kinds.forEach((kind, i) => {
    if (kind === 'silent') return;
    if (kind === 'other') { cur = null; return; }
    if (!cur) { cur = { members: [], cards: 0, steps: 0 }; out.push(cur); }
    cur.members.push(i);
    if (kind === 'card') cur.cards++;
    else cur.steps++;
  });
  return out;
}

/** The group the timeline opens with (only silent items before it), or null. */
export function leadingStepGroup(kinds: readonly StepKind[]): StepGroup | null {
  const first = kinds.findIndex((k) => k !== 'silent');
  if (first < 0 || kinds[first] === 'other') return null;
  return stepGroups(kinds)[0] ?? null;
}

/** Consecutive members of one kind, so each keeps the row it renders as inside the fold. */
export function chunkByKind(members: readonly number[], kindOf: (i: number) => StepKind): Array<{ kind: 'step' | 'card'; members: number[] }> {
  const out: Array<{ kind: 'step' | 'card'; members: number[] }> = [];
  for (const i of members) {
    const kind = kindOf(i) === 'card' ? 'card' : 'step';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.members.push(i);
    else out.push({ kind, members: [i] });
  }
  return out;
}
