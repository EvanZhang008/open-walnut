/**
 * Related threads beside a new one (experiment `threads_related`; 2026-11-25, the user: "It should
 * do a fuzzy match, or go through a vector database, and attach the related threads; the agent
 * decides"). A message of his that Walnut files as a NEW thread is compared with the threads of
 * the node and of the tasks above, below and beside it (open, or closed in the last week), and up
 * to five that may be its subject ride its `threads` hint (thread-capture.ts threadHintText), so
 * the agent joins it to the right one instead of keeping two. Advice only: nothing is merged or
 * refused here.
 *
 * Two lanes, either one puts a thread on the list:
 *   - words: his message against each thread's title, ask and first summary sentence, with the
 *     telling-word rule of the same-subject brake (thread-same-subject.ts), at a lower bar;
 *   - meaning: the search stack's model (search/short-text-vectors.ts), his message as a query and
 *     each thread's text as a passage, by cosine. Optional: off wherever search by meaning is off,
 *     only on workers that already run (none is started for it), and past its deadline (or on any
 *     error) the list is the words lane alone.
 * The whole lookup has a deadline, so filing and sending his message never waits longer.
 */
import { log } from '../../logging/index.js';
import { experimentCache } from '../experimental-cache.js';
import { firstSentence } from './ask-clarity.js';
import { candidatesIn, sharedPlaces, subjectIndex, treeOpenThreads, type SubjectCandidate, type TreeThreads } from './thread-same-subject.js';
import { movedAway, type OrgThread, type ThreadState } from './threads-model.js';
import type { ShortTextEmbedder } from '../search/short-text-vectors.js';

const flag = experimentCache('threads_related');
/** The experiment, read from the config now. */
export const threadsRelatedOn = flag.on;

export const RELATED_MAX = 5;
/** A closed thread is still offered this long after it closed. */
export const RELATED_CLOSED_MS = 7 * 24 * 3_600_000;
/**
 * The whole lookup (the tree's threads read, both lanes) ends by this. His send waits on it once
 * per new thread, so it stays well under a second; the tree read is a few dozen small files.
 */
export const RELATED_DEADLINE_MS = 600;
/**
 * The meaning lane's share of it. Search's rescore gives a query 150 ms per keystroke (about 25 ms
 * on a warm worker on the Mac); a loaded 8-CPU Linux box took 350 ms at the median (2026-11-25). One
 * new thread is no keystroke, so it gets 400 ms; a busy worker falls back to words in time, and its
 * answer still lands in the caches for the next message. A worker that is not running is not asked.
 */
export const MEANING_DEADLINE_MS = 400;
/**
 * Words lane bar: telling words shared with the thread's text, and that share of the fewer of the
 * two sides' words. Calibrated 2026-11-25 by replaying his own messages: a CJK run counts each pair
 * of characters, so the share is low by nature; strongMatch's bar (3 words, half the title) showed
 * almost no list at all.
 */
export const WORDS_MIN_SHARED = 2;
export const WORDS_MIN_SHARE = 0.1;
/**
 * Meaning lane bar: cosine of his message (query) and the thread's text (passage) with the default
 * model. Calibrated 2026-11-25 on the same replay: the thread a message later sat in scored 0.44 at
 * the median, the others 0.37 (0.45 at the 90th percentile), so the bar sits past most others.
 */
export const MEANING_MIN_COSINE = 0.5;
/** Cuts in the hint: a thread's title, a task's title, and the whole addition in bytes. */
const TITLE_CUT = 60;
const TASK_CUT = 30;
export const RELATED_HINT_MAX_BYTES = 1000;

export interface RelatedThread {
  id: string;
  title: string;
  state: ThreadState;
  closed?: true;
  /** Another task's thread: that task. Absent for the node's own. */
  task?: { id: string; title: string };
  lanes: Array<'words' | 'meaning'>;
}

/** What one lookup did, for its log line: counts, never thread text. */
export interface RelatedStats {
  candidates: number;
  words: number;
  meaning: number;
  shown: number;
  /**
   * off: no embedder here; no-worker: its query worker does not run now (none is started for
   * this; suspended under memory pressure too); partial: some threads' vectors were not cached and
   * could not be embedded in time (no passage worker running, or past the deadline).
   */
  semantic: 'off' | 'no-worker' | 'on' | 'partial' | 'timeout' | 'error';
  /** The tree's threads were not read in time: only the node's own were compared. */
  timedOut?: true;
  ms: number;
}

/** What a thread is compared by: its title, ask and the first sentence of its summary. Pure. */
export function relatedTextOf(t: Pick<OrgThread, 'title' | 'ask' | 'reply'>): string {
  const parts = [t.title, t.ask, t.reply ? firstSentence(t.reply) : ''].map((s) => (s ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  return parts.join('. ').slice(0, 600);
}

/** A thread that may be offered: open, or closed within the week; never a moved-away pointer or the new thread. Pure. */
export function offerable(t: OrgThread, now: number, newThreadId: string): boolean {
  if (t.id === newThreadId || movedAway(t)) return false;
  return !t.closed || now - Date.parse(t.closed.at) <= RELATED_CLOSED_MS;
}

/**
 * The words lane's pass. `places`: in how many places of his message the shared words stand. Two
 * pairs of CJK characters can be one word of three characters, so words that stand in one place
 * need one more (review 2026-11-25). Pure.
 */
export function wordsPass(c: Pick<SubjectCandidate, 'shared' | 'of' | 'theirs'>, places: number): boolean {
  return c.shared >= WORDS_MIN_SHARED && c.shared >= WORDS_MIN_SHARE * Math.max(1, Math.min(c.of, c.theirs))
    && (places >= WORDS_MIN_SHARED || c.shared > WORDS_MIN_SHARED);
}

/**
 * The related threads of `text` among `tree`, best first, at most RELATED_MAX, from the words lane
 * and (when given) the meaning lane's cosines by thread id. Pure.
 */
export function rankRelated(input: {
  text: string; tree: readonly TreeThreads[]; selfTaskId: string; newThreadId: string; now: number;
  cosines?: ReadonlyMap<string, number>;
}): { related: RelatedThread[]; rows: number; words: number; meaning: number } {
  const keep = (t: OrgThread, now: number) => offerable(t, now, input.newThreadId);
  const index = subjectIndex(input.tree, input.now, { keep, textOf: relatedTextOf });
  const byId = new Map(index.rows.map((r) => [r.t.id, r]));
  const scores = new Map<string, { words?: number; meaning?: number }>();
  for (const c of candidatesIn(index, input.text, { head: false })) {
    if (c.shared >= WORDS_MIN_SHARED && wordsPass(c, sharedPlaces(input.text, relatedTextOf(byId.get(c.id)!.t)))) scores.set(c.id, { words: Math.min(1, c.shared / Math.max(1, Math.min(c.of, c.theirs))) });
  }
  let meaning = 0;
  for (const [id, cos] of input.cosines ?? []) {
    if (!byId.has(id) || cos < MEANING_MIN_COSINE) continue;
    meaning++;
    scores.set(id, { ...scores.get(id), meaning: (cos - MEANING_MIN_COSINE) / (1 - MEANING_MIN_COSINE) });
  }
  const words = [...scores.values()].filter((s) => s.words !== undefined).length;
  const score = (s: { words?: number; meaning?: number }) => (s.words !== undefined && s.meaning !== undefined ? 1 : 0) + Math.max(s.words ?? 0, s.meaning ?? 0);
  const ranked = [...scores.entries()]
    .map(([id, s]) => ({ r: byId.get(id)!, s }))
    .sort((a, b) => score(b.s) - score(a.s) || Number(b.r.task.id === input.selfTaskId) - Number(a.r.task.id === input.selfTaskId) || b.r.t.updatedAt.localeCompare(a.r.t.updatedAt))
    .slice(0, RELATED_MAX);
  const related = ranked.map(({ r, s }): RelatedThread => ({
    id: r.t.id, title: r.t.title, state: r.t.state,
    ...(r.t.closed ? { closed: true as const } : {}),
    ...(r.task.id !== input.selfTaskId ? { task: { id: r.task.id, title: r.task.title } } : {}),
    lanes: [...(s.words !== undefined ? ['words' as const] : []), ...(s.meaning !== undefined ? ['meaning' as const] : [])],
  }));
  return { related, rows: index.rows.length, words, meaning };
}

/** The meaning lane: his message's cosine with each row's text, by thread id; what it managed by the deadline. Never throws. */
export async function meaningCosines(e: ShortTextEmbedder, text: string, rows: ReadonlyArray<{ id: string; text: string }>, deadlineMs: number): Promise<{ cosines: Map<string, number>; semantic: RelatedStats['semantic'] }> {
  const cosines = new Map<string, number>();
  try {
    // No query worker running: none is started for this, the list is the words lane's.
    if (!e.running().query) return { cosines, semantic: 'no-worker' };
    const vectors = await import('../search/short-text-vectors.js');
    const { cosineInt8 } = await import('../../lib/hybrid-search/embedder.js');
    const passages = rows.map((r) => ({ id: r.id, text: vectors.shortText(r.text) }));
    const [q, vecs] = await Promise.all([
      vectors.queryVector(e, vectors.shortText(text), deadlineMs),
      vectors.passageVectors(e, passages.map((p) => p.text), deadlineMs),
    ]);
    if (!q) return { cosines, semantic: 'timeout' };
    for (const p of passages) {
      const v = vecs.get(p.text);
      if (v && v.length === q.length) cosines.set(p.id, cosineInt8(q, v));
    }
    return { cosines, semantic: cosines.size < passages.length ? 'partial' : 'on' };
  } catch {
    return { cosines, semantic: 'error' };
  }
}

function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, ms)); })]).finally(() => clearTimeout(timer));
}

/** The lookup running for a node now: its next message is planned after it (lookupsSettled). */
const running = new Map<string, Promise<unknown>>();

/**
 * Wait for a related-threads lookup of node `taskId` still running (at most RELATED_DEADLINE_MS).
 * His next message is planned after it, never beside it: without this, a message sent right after
 * one that opened a thread was planned and queued while the first one's lookup still ran, so it
 * could reach the session first, or be told a thread the write then put elsewhere (review
 * 2026-11-25). Never throws.
 */
export async function lookupsSettled(taskId: string): Promise<void> {
  const p = running.get(taskId);
  if (p) await p.catch(() => {});
}

/**
 * The related threads of his message that opens `newThreadId` on node `taskId`, within
 * RELATED_DEADLINE_MS; [] on any failure. `own`: the node's threads as already read, compared
 * alone when the tree is not read in time. Logs one line with the counts. Never throws.
 */
export async function relatedForNewThread(input: { taskId: string; text: string; newThreadId: string; now?: number; embedder?: ShortTextEmbedder | null; own?: readonly OrgThread[] }): Promise<RelatedThread[]> {
  const lookup = lookUp(input);
  running.set(input.taskId, lookup);
  try {
    return await lookup;
  } finally {
    if (running.get(input.taskId) === lookup) running.delete(input.taskId);
  }
}

async function lookUp(input: Parameters<typeof relatedForNewThread>[0]): Promise<RelatedThread[]> {
  const started = Date.now();
  const now = input.now ?? started;
  const stats: RelatedStats = { candidates: 0, words: 0, meaning: 0, shown: 0, semantic: 'off', ms: 0 };
  let related: RelatedThread[] = [];
  try {
    let tree = await within(treeOpenThreads(input.taskId, [], { closedWithinMs: RELATED_CLOSED_MS, now }).catch(() => [] as TreeThreads[]), RELATED_DEADLINE_MS);
    if (!tree) {
      stats.timedOut = true;
      tree = input.own?.length ? [{ task: { id: input.taskId, title: '' }, threads: input.own }] : [];
    }
    if (tree.length) {
      const rows = tree.flatMap((b) => b.threads.filter((t) => offerable(t, now, input.newThreadId)).map((t) => ({ id: t.id, text: relatedTextOf(t) })));
      const e = input.embedder !== undefined ? input.embedder : await (await import('../search/short-text-vectors.js')).shortTextEmbedder();
      let cosines: Map<string, number> | undefined;
      const left = RELATED_DEADLINE_MS - (Date.now() - started);
      if (e && rows.length && left > 0) {
        const lane = await meaningCosines(e, input.text, rows, Math.min(MEANING_DEADLINE_MS, left));
        cosines = lane.cosines;
        stats.semantic = lane.semantic;
      }
      const ranked = rankRelated({ text: input.text, tree, selfTaskId: input.taskId, newThreadId: input.newThreadId, now, ...(cosines ? { cosines } : {}) });
      related = ranked.related;
      Object.assign(stats, { candidates: ranked.rows, words: ranked.words, meaning: ranked.meaning, shown: related.length });
    }
  } catch (err) {
    log.session.warn('org threads: related threads not read', { taskId: input.taskId, error: err instanceof Error ? err.message : String(err) });
  }
  stats.ms = Date.now() - started;
  log.session.info('org threads: related threads', { taskId: input.taskId, threadId: input.newThreadId, ...stats });
  return related;
}

/** Cut by characters, never inside one (an emoji is two UTF-16 units). */
const cut = (s: string, n: number): string => {
  const chars = Array.from(s.replace(/\s+/g, ' ').trim());
  return chars.length > n ? `${chars.slice(0, n - 1).join('').trimEnd()}\u2026` : chars.join('');
};

/**
 * The related threads as the `threads` hint adds them, after "filed as new thread": the open ones
 * under how to join one, the closed ones apart (a merge into a closed thread is refused: a new ask
 * about a closed subject is its own thread, threads-model.ts mergeThreads). A thread of the node
 * already named in the hint's Open list goes by its id alone. At most RELATED_HINT_MAX_BYTES: the
 * lowest ranked go first. '' when there are none. Pure.
 * `how` 'line': the hint asks for the reply's card line (threads_reply_tag), so joining one of the
 * node's own is that line's merge, never a thread_update beside it.
 */
export function relatedThreadsText(related: readonly RelatedThread[], newThreadId: string, listed: ReadonlySet<string> = new Set(), how: 'op' | 'line' = 'op'): string {
  const join = how === 'line' ? 'its line with merge="<id>" alone' : `thread_update {"id":"${newThreadId}","merge_into":"<id>"}`;
  const item = (r: RelatedThread): string => {
    const whose = r.task ? `on ${JSON.stringify(cut(r.task.title, TASK_CUT))} ${r.task.id}` : 'yours';
    if (!r.task && !r.closed && listed.has(r.id)) return `${r.id} (yours)`;
    return `${r.id} ${JSON.stringify(cut(r.title, TITLE_CUT))} (${r.closed ? whose : `${r.state}, ${whose}`})`;
  };
  const text = (rs: readonly RelatedThread[]): string => {
    const open = rs.filter((r) => !r.closed).map(item);
    const closed = rs.filter((r) => r.closed).map(item);
    return (open.length ? ` Related threads (its subject is one of yours: ${join}; another task's: that task keeps it, task_send it): ${open.join('; ')}.` : '')
      + (closed.length ? ` Related, closed this week (no merge: a new ask about it stays its own thread; read it, and say on the new card that it continues it): ${closed.join('; ')}.` : '');
  };
  for (let n = related.length; n > 0; n--) {
    const out = text(related.slice(0, n));
    if (Buffer.byteLength(out, 'utf8') <= RELATED_HINT_MAX_BYTES) return out;
  }
  return '';
}
