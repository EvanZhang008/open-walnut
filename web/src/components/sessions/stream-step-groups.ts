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
 *  · `send`: a message this session sent (an op card's call): a step of the turn,
 *    folded with it from the first frame, as the saved turn folds it ("Sent 2 ›";
 *    2026-11-10, the user: the cards sat open about 10 s until the turn ended);
 *  · `words`: the session's own short words on the way, with a step after them
 *    (history folds the same words before its answer: fold-rows.ts narration);
 *  · `agent`: a subagent it started (its chip);
 *  · `silent`: draws nothing, so it neither joins nor ends a group;
 *  · `other`: anything a reader sees (the answer, a person's message, a notice, a
 *    question): it ends the group.
 * 2026-11-12: words and agents that only the stream had drew between two folds
 * of one live turn, so the turn read as three rows until it was saved.
 *
 * `keyOf` (Conversation Mode): the question an item is filed under. Steps of two
 * questions are never one row, so a change of key starts a new group; with one key
 * (the usual turn) nothing changes. 2026-11-11, the user, of a live turn in a session
 * with a side question that never folded: "If they are togter they need ot be collpesed".
 */
export type StepKind = 'step' | 'card' | 'send' | 'words' | 'agent' | 'silent' | 'other';

export interface StepGroup {
  /** Timeline indices of the group's steps and cards, in order (no silent ones). */
  members: number[];
  cards: number;
  steps: number;
  sends: number;
  words: number;
  agents: number;
}

/** An empty group (the live turn's fold before its first step is drawn). */
export const EMPTY_STEP_GROUP: StepGroup = { members: [], cards: 0, steps: 0, sends: 0, words: 0, agents: 0 };

/** Every maximal group of steps and cards. */
export function stepGroups(kinds: readonly StepKind[], keyOf?: (i: number) => string): StepGroup[] {
  const out: StepGroup[] = [];
  let cur: StepGroup | null = null;
  let curKey = '';
  kinds.forEach((kind, i) => {
    if (kind === 'silent') return;
    if (kind === 'other') { cur = null; return; }
    const key = keyOf ? keyOf(i) : '';
    if (cur && key !== curKey) cur = null;
    curKey = key;
    if (!cur) { cur = { ...EMPTY_STEP_GROUP, members: [] }; out.push(cur); }
    cur.members.push(i);
    if (kind === 'card') cur.cards++;
    else if (kind === 'send') cur.sends++;
    else if (kind === 'words') cur.words++;
    else if (kind === 'agent') cur.agents++;
    else cur.steps++;
  });
  return out;
}

/** The group the timeline opens with (only silent items before it), or null. */
export function leadingStepGroup(kinds: readonly StepKind[], keyOf?: (i: number) => string): StepGroup | null {
  const first = kinds.findIndex((k) => k !== 'silent');
  if (first < 0 || kinds[first] === 'other') return null;
  return stepGroups(kinds, keyOf)[0] ?? null;
}

/** A group that draws as one fold: one with a send, or with two kinds of step. A
 *  group of cards alone keeps its "Received N messages" row, steps alone their run,
 *  agents alone their chip. */
export function foldsAsOne(g: StepGroup): boolean {
  return g.sends > 0 || [g.cards, g.steps, g.words, g.agents].filter((n) => n > 0).length >= 2;
}

/** Words count as words only on the way: a `words` item with no step of the session's
 *  own (a call, reasoning, a send, an agent) after it in its turn and question, before
 *  the next reader's row, is the answer so far (`other`). A card received after it is
 *  not the session working on: a turn's short answer and the notes Walnut delivered at
 *  its end stay apart. `segOf`: the turn and question an item belongs to (an item of
 *  another one never makes words before it "on the way"). */
export function settleWords(kinds: readonly StepKind[], segOf?: (i: number) => string): StepKind[] {
  const out = [...kinds];
  let stepAfter = false;
  let seg: string | undefined;
  for (let i = out.length - 1; i >= 0; i--) {
    const k = out[i];
    if (k === 'silent') continue;
    const here = segOf ? segOf(i) : '';
    if (seg !== undefined && here !== seg) stepAfter = false;
    seg = here;
    if (k === 'other') stepAfter = false;
    else if (k === 'step' || k === 'send' || k === 'agent') stepAfter = true;
    else if (k === 'words' && !stepAfter) out[i] = 'other';
  }
  return out;
}

export type ChunkKind = 'step' | 'card' | 'send' | 'words' | 'agent';

/** Consecutive members of one kind, so each keeps the row it renders as inside the fold. */
export function chunkByKind(members: readonly number[], kindOf: (i: number) => StepKind): Array<{ kind: ChunkKind; members: number[] }> {
  const out: Array<{ kind: ChunkKind; members: number[] }> = [];
  for (const i of members) {
    const k = kindOf(i);
    const kind: ChunkKind = k === 'card' || k === 'send' || k === 'words' || k === 'agent' ? k : 'step';
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.members.push(i);
    else out.push({ kind, members: [i] });
  }
  return out;
}
