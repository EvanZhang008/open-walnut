/**
 * Ranking for the related-open-tasks check (related-open-tasks.ts): which OPEN tasks
 * a session's new task looks like, scored so that a near-duplicate blocks and two
 * tasks that merely share the busy words of one project ("fix", "iOS", "test") do not.
 *
 * In memory over the open rows the caller hands in; terms come from
 * related-open-terms.ts (search's term rules, CJK pairs, word families, boilerplate
 * sentences dropped). Why not the search index itself (measured 2026-10-26 against
 * a live server with its semantic rescore on): GET /api/search held the event loop for
 * the whole request, 33 to 144 ms (a trivial route sent alongside waited exactly as
 * long), over the ~20 ms a create may spend; its only finds the first version of this
 * ranking missed were short titles inside longer ones, which the containment rule below
 * now catches; and its semantic rescore, given 250 ms, found neither paraphrase pair
 * (an English rewording, and two titles that share one word and a meaning). So the
 * check stays in memory, and pairs with no shared words stay out of its reach.
 *
 * The score, per candidate:
 *   - every term carries an IDF weight over the open tasks themselves, so a word half
 *     the board uses ("fix" in a busy project) is worth little and a rare one a lot;
 *   - title vs title: the F1 of the two coverages (how much of the new title the
 *     candidate holds, how much of the candidate's title the new task holds); a new
 *     title word found only in the candidate's description, or the reverse, counts 0.3;
 *   - containment: the new title (a session's titles are short) read inside a longer
 *     candidate title. A CJK pair that only spans two words ("AB" + "CD" read as
 *     "BC") is not held against it when both its characters are in matched pairs;
 *   - description only: how much of the candidate's title the new description holds
 *     (a session that names the subject in its brief, not its title), scaled down;
 *   - a small boost when the candidate sits where the new task will land (same
 *     folder, else same project). The boost only lifts a real text match: it can
 *     never block on its own.
 * A candidate blocks with at least two matched words that carry weight (one word is a
 * topic, not a duplicate) when the text match reaches BASE_MIN and the boosted score
 * RELATED_SCORE_MIN, or the new title is contained (CONTAIN_MIN); or when both titles
 * hold exactly the same words. When each title also keeps a telling word of its own
 * ("Prior inbox ranking", "Priority inbox ranking"), two shared words are a common
 * topic and it takes three.
 *
 * Work is split into steps (`rankSteps`): the server runs them with a yield between
 * chunks of rows (related-open-tasks.ts), tests run them straight through.
 */

import {
  type Terms, DESC_CHARS, relatedTerms, descriptionSentences, boilerplateOf, withoutBoilerplate,
  familyMap, inFamilies, isCjkTerm,
} from './related-open-terms.js';

export { relatedTerms } from './related-open-terms.js';

/** The fields of an open task the ranking reads. */
export interface RankableTask {
  id: string;
  title: string;
  description?: string;
  project?: string;
  group_id?: string;
}

export interface RankContext {
  /** Where the new task will land (after caller placement). */
  project?: string;
  groupId?: string;
}

export interface RankedTask<T extends RankableTask = RankableTask> {
  task: T;
  score: number;
  /** The shared words that carry weight, as the new task wrote them (title words first). */
  matched: string[];
  sameFolder: boolean;
  sameProject: boolean;
}

/** A scored candidate: whether it blocks, and whether its title alone matches the new one. */
export type Scored<T extends RankableTask = RankableTask> = RankedTask<T> & { blocks: boolean; sameTitle: boolean };

/** Calibrated on a dense fixture (130 open tasks in one project) and the real board: see the tests. */
export const RELATED_SCORE_MIN = 0.6;
export const RELATED_MIN_MATCHED = 2;
export const RELATED_MAX_CANDIDATES = 5;
/** Rows prepared between two yields when the server runs the steps. */
export const RANK_CHUNK = 64;
const SAME_FOLDER_BOOST = 0.08;
const SAME_PROJECT_BOOST = 0.04;
const DESC_ONLY_SCALE = 0.7;
const DESC_ONLY_MIN_MATCHED = 3;
/** A new title word found only in the candidate's description (or the reverse) counts this much. */
const CROSS_CREDIT = 0.3;
/** The text match alone must reach this; the place boost then decides a close call. */
const BASE_MIN = 0.55;
/** This much of the new title's weight inside the candidate's title blocks on its own. */
const CONTAIN_MIN = 0.75;
const CONTAIN_SCALE = 0.8;
const UNIT_MIN_IDF = 1;
/** Shared words that block even when each title keeps a telling word of its own. */
const TWO_SIDED_MIN_MATCHED = 3;
/** Words that say what kind of change, not which work: never a title's own subject word. */
const KIND_OF_CHANGE = new Set(['fix', 'bug', 'issue', 'problem', 'broken', 'error', 'wrong', 'fail', 'investigate', 'debug', 'cleanup']);

/**
 * Matched words that say something, counting a CJK run's pairs at a little over half
 * each (a 4-char run is 3 pairs). A word over a third of the open tasks share
 * (idf under UNIT_MIN_IDF: "fix" on a busy board) is no evidence of the same work.
 */
function matchedUnits(terms: Iterable<string>, idf: (t: string) => number): number {
  let latin = 0;
  let cjk = 0;
  for (const t of terms) {
    if (idf(t) < UNIT_MIN_IDF) continue;
    if (isCjkTerm(t)) cjk++; else latin++;
  }
  return latin + Math.ceil(cjk * 0.6);
}

/** A CJK pair whose two characters both sit in matched pairs (it only spans a word boundary). */
function excusedPairs(title: Terms, matched: ReadonlySet<string>): Set<string> {
  const covered = new Set<string>();
  for (const t of matched) if (isCjkTerm(t)) for (const c of t) covered.add(c);
  const out = new Set<string>();
  for (const t of title.keys()) {
    if (matched.has(t) || !isCjkTerm(t)) continue;
    const [a, b] = [...t];
    if (a && b && covered.has(a) && covered.has(b)) out.add(t);
  }
  return out;
}

interface Prepared<T> { task: T; title: Terms; desc: Terms }

/**
 * The ranking as steps: each `yield` ends one chunk of rows, and the generator returns
 * every candidate with a text match, scored (also the ones under the threshold).
 */
export function* rankSteps<T extends RankableTask>(
  input: { title: string; description?: string },
  open: readonly T[],
  ctx: RankContext = {},
): Generator<void, Scored<T>[]> {
  if (relatedTerms(input.title).size === 0) return [];
  // 1. Boilerplate: sentences many open descriptions share say how, not what. Counted over
  // the open tasks only: the new brief sharing a sentence with two of them is a match.
  const sentenceSets: Array<Set<string>> = [];
  for (let i = 0; i < open.length; i++) {
    sentenceSets.push(new Set(descriptionSentences(open[i].description)));
    if ((i + 1) % RANK_CHUNK === 0) yield;
  }
  const boilerplate = boilerplateOf(sentenceSets);
  // 2. Terms, then word families over all of them.
  const read = (title: string, description?: string): { title: Terms; desc: Terms } => ({
    title: relatedTerms(title),
    desc: relatedTerms(withoutBoilerplate(description, boilerplate), DESC_CHARS),
  });
  const q = read(input.title, input.description);
  const raw: Array<{ task: T; title: Terms; desc: Terms }> = [];
  for (let i = 0; i < open.length; i++) {
    raw.push({ task: open[i], ...read(open[i].title, open[i].description) });
    if ((i + 1) % RANK_CHUNK === 0) yield;
  }
  const families = familyMap([q.title, q.desc, ...raw.flatMap((r) => [r.title, r.desc])]);
  const qTitle = inFamilies(q.title, families);
  const qDesc = inFamilies(q.desc, families);
  for (const k of qTitle.keys()) qDesc.delete(k);
  const prepared: Prepared<T>[] = raw.map((r) => {
    const title = inFamilies(r.title, families);
    const desc = inFamilies(r.desc, families);
    for (const k of title.keys()) desc.delete(k);
    return { task: r.task, title, desc };
  });
  yield;
  // 3. IDF over the open tasks (the new one counted in): a word most of them share is cheap.
  const df = new Map<string, number>();
  for (const p of prepared) {
    for (const k of p.title.keys()) df.set(k, (df.get(k) ?? 0) + 1);
    for (const k of p.desc.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  }
  const n = prepared.length + 1;
  const idf = (t: string): number => Math.max(0, Math.log((n + 1) / ((df.get(t) ?? 0) + 0.5)));
  const weight = (terms: Iterable<string>): number => { let w = 0; for (const t of terms) w += idf(t); return w; };
  const wQTitle = weight(qTitle.keys());
  const projectKey = (ctx.project ?? '').trim().toLowerCase();

  const out: Scored<T>[] = [];
  for (const p of prepared) {
    const tt: string[] = [];
    const tx: string[] = [];
    for (const t of qTitle.keys()) {
      if (p.title.has(t)) tt.push(t);
      else if (p.desc.has(t)) tx.push(t);
    }
    const xt = [...qDesc.keys()].filter((t) => p.title.has(t));
    if (tt.length + tx.length + xt.length === 0) continue;
    const wCTitle = weight(p.title.keys());
    const covQ = wQTitle > 0 ? (weight(tt) + CROSS_CREDIT * weight(tx)) / wQTitle : 0;
    const covC = wCTitle > 0 ? (weight(tt) + CROSS_CREDIT * weight(xt)) / wCTitle : 0;
    const titleScore = covQ + covC > 0 ? (2 * covQ * covC) / (covQ + covC) : 0;
    // The new title inside the candidate's title, boundary-spanning CJK pairs excused.
    const excused = excusedPairs(qTitle, new Set(tt));
    const wContainDen = wQTitle - weight(excused);
    const contain = wContainDen > 0 ? weight(tt) / wContainDen : 0;
    // Two shared words are enough only when one of the titles has no telling word of its
    // own: "Prior inbox ranking" and "Priority inbox ranking" each keep one, so they name
    // a common topic; "Keyboard layout broken on iOS" covers all of "Fix iOS keyboard layout".
    const telling = (t: string): boolean => idf(t) >= UNIT_MIN_IDF;
    const own = (t: string): boolean => telling(t) && !isCjkTerm(t) && !KIND_OF_CHANGE.has(t);
    const ownQ = [...qTitle.keys()].some((t) => own(t) && !p.title.has(t) && !p.desc.has(t));
    const ownC = [...p.title.keys()].some((t) => own(t) && !qTitle.has(t) && !qDesc.has(t));
    const enough = (terms: readonly string[]): boolean => {
      if (matchedUnits(terms, idf) < RELATED_MIN_MATCHED) return false;
      // CJK pairs are never a title's own word (no word boundaries to tell a subject by),
      // and a shared CJK run counts by its pairs here: it is one phrase.
      return !(ownQ && ownC) || terms.filter(telling).length >= TWO_SIDED_MIN_MATCHED;
    };
    const contained = contain >= CONTAIN_MIN && enough(tt);
    // Only for a candidate title of 3+ words, at least one of them read in the new
    // description: a two-word title ("AI round") is in half the long briefs on a board.
    const descOnly = wCTitle > 0 && xt.length > 0 && matchedUnits([...tt, ...xt], idf) >= DESC_ONLY_MIN_MATCHED
      ? DESC_ONLY_SCALE * ((weight(tt) + weight(xt)) / wCTitle) : 0;
    const base = Math.max(titleScore, descOnly, contained ? CONTAIN_SCALE * Math.min(1, contain) : 0);
    const sameFolder = !!ctx.groupId && p.task.group_id === ctx.groupId;
    const sameProject = !!projectKey && (p.task.project ?? '').trim().toLowerCase() === projectKey;
    const score = base + (sameFolder ? SAME_FOLDER_BOOST : sameProject ? SAME_PROJECT_BOOST : 0);
    const matchedTerms = [...tt, ...tx, ...xt];
    const sameWords = tt.length === qTitle.size && tt.length === p.title.size;
    const blocks = sameWords || contained || (base >= BASE_MIN && score >= RELATED_SCORE_MIN
      && enough(matchedTerms));
    const said = (t: string): string => qTitle.get(t) ?? qDesc.get(t) ?? t;
    // The words that carried the match: a word most open tasks share is left out of the list.
    const carried = matchedTerms.filter(telling);
    out.push({
      task: p.task, score: Math.round(score * 1000) / 1000,
      matched: (carried.length ? carried : matchedTerms).map(said), sameFolder, sameProject, blocks,
      sameTitle: sameWords || contained || titleScore >= BASE_MIN,
    });
  }
  // Ties: the same folder, then the same project, then input order (the caller passes most recent first).
  return out.sort((a, b) => b.score - a.score
    || Number(b.sameFolder) - Number(a.sameFolder) || Number(b.sameProject) - Number(a.sameProject));
}

/** Run the steps straight through. */
function runSync<R>(steps: Generator<void, R>): R {
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/** Every candidate with a text match, scored (also the ones under the threshold: for calibration). */
export function scoreRelatedOpenTasks<T extends RankableTask>(
  input: { title: string; description?: string },
  open: readonly T[],
  ctx: RankContext = {},
): Scored<T>[] {
  return runSync(rankSteps(input, open, ctx));
}

/** Does the new task's text name this task by id (the whole id, or the 8-char head of a long one)? */
export function textNamesTask(said: string, taskId: string): boolean {
  return said.includes(taskId) || (taskId.length >= 12 && said.includes(taskId.slice(0, 8)));
}

/**
 * Leave out the open tasks the new brief names by id as OTHER work ("depends on X",
 * "coordinate with X"): the session already knows them. A named task whose title the
 * new one matches stays: "redo X" or "take over X" under X's own title is X's work.
 */
export function withoutNamedPartners<T extends RankableTask>(
  input: { title: string; description?: string }, scored: Scored<T>[],
): Scored<T>[] {
  const said = `${input.title}\n${input.description ?? ''}`;
  return scored.filter((r) => r.sameTitle || !textNamesTask(said, r.task.id));
}

/** Only the candidates that block, best first, at most `max`. */
export function blockingOnly<T extends RankableTask>(
  scored: Scored<T>[], max = RELATED_MAX_CANDIDATES,
): RankedTask<T>[] {
  return scored.filter((r) => r.blocks).slice(0, max).map(({ blocks: _blocks, sameTitle: _same, ...r }) => r);
}

/** Rank `open` against a new task. Returns only the candidates that block, best first, at most `max`. */
export function rankRelatedOpenTasks<T extends RankableTask>(
  input: { title: string; description?: string },
  open: readonly T[],
  ctx: RankContext = {},
  max = RELATED_MAX_CANDIDATES,
): RankedTask<T>[] {
  return blockingOnly(scoreRelatedOpenTasks(input, open, ctx), max);
}
