/**
 * One subject is one thread, when the node names his new thread (2026-11-23, the thread monitor's
 * [dup]: his second word on acknowledged cards, 40 minutes after his first, opened a thread the node
 * then titled like the open one, so he had two cards for one subject). Words alone never merge: in
 * review, a merge on the title match put "build fails on Sonoma" under "build fails in CI".
 *
 *   in the answer  an untitled thread that is the subject of another listed thread is merged into it:
 *                  FOR_USER_THREAD_MERGE: <ref> | <other ref>, before the answer's lines
 *   held           a title the answer gives instead that clearly repeats another open thread is not
 *                  written; the thread keeps Walnut's stand-in title and `titleHeld`
 *   asked          the next question names it with that thread when that thread is listed too (and
 *                  asks it no title): FOR_USER_THREAD_MERGE: <ref> merges it; an answer with thread
 *                  lines and no such line writes the held title
 * A merged thread's line and marks speak for the thread it went into when that one has none. A word
 * of his in it since the question keeps it as it is, and the next question asks again.
 */
import { mergeThreads, ThreadError, type OrgThread, type ThreadsFile, type ThreadWriter } from '../org/threads-model.js';
import { sameSubjectCandidates, strongMatch } from '../org/thread-same-subject.js';
import { markerRe } from './status-marker.js';

/** Held threads one question asks about at most. */
export const MERGES_ASKED_MAX = 3;
const TITLE_SHOWN_MAX = 60;

/** A listed thread holding a title, and the open thread it reads like. */
export interface HeldTitle { title: string; like: string; likeTitle: string }
/** A merge the answer may make: its thread and the one it goes into, with each one's newest message when asked. */
export interface MergeMark { id: string; into: string; upTo?: string; intoUpTo?: string }
/** A title an answer gives (status-threads.ts ThreadMark, or a split line's), and a thread it is not compared to. */
interface TitleMark { id: string; title?: string; besides?: string }

const clean = (s: string): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TITLE_SHOWN_MAX ? `${t.slice(0, TITLE_SHOWN_MAX - 3)}...` : t;
};
const newest = (t: Pick<OrgThread, 'messages'>): string => t.messages[t.messages.length - 1]?.id ?? '';

/** The open thread of the node a title for `id` clearly repeats, if any. Pure. */
export function repeatedBy(file: ThreadsFile, id: string, title: string, now: number, besides?: string): string | undefined {
  const others = file.threads.filter((t) => t.id !== id && t.id !== besides && !t.closed);
  return strongMatch(sameSubjectCandidates(title, [{ task: { id: file.taskId, title: '' }, threads: others }], now))?.id;
}

/** What the question says of `t` when it still holds a title and the thread it reads like is open. Pure. */
export function heldTitleOf(file: ThreadsFile, t: OrgThread): HeldTitle | undefined {
  if (!t.titleHeld || t.titled) return undefined;
  const like = file.threads.find((x) => x.id === t.titleHeld!.like && !x.closed);
  return like ? { title: t.titleHeld.title, like: like.id, likeTitle: like.title } : undefined;
}

/**
 * Hold each title of the answer that repeats another open thread (pure, inside the answer's locked
 * write, before its lines): the ids held, whose title marks the plan then leaves out. A thread already
 * held, or titled since, is not held again: its title is written.
 */
export function holdRepeatTitles(file: ThreadsFile, titles: readonly TitleMark[], at: string): { file: ThreadsFile; held: Set<string> } {
  const held = new Set<string>();
  const now = Date.parse(at);
  const threads = file.threads.map((t) => {
    const m = titles.find((x) => x.id === t.id);
    if (!m?.title || t.closed || t.titled || t.titleHeld) return t;
    const like = repeatedBy(file, t.id, m.title, now, m.besides);
    if (!like) return t;
    held.add(t.id);
    return { ...t, titleHeld: { title: m.title, like, at } };
  });
  return { file: held.size ? { ...file, threads } : file, held };
}

/** The line the question adds beside its title line: an untitled thread that is another listed one's subject. */
export const MERGE_UNTITLED_LINE = 'One that is the subject of another listed thread instead: FOR_USER_THREAD_MERGE: <ref> | <that ref> (Walnut puts it under that one before your lines, so that one\'s line speaks for both).';

/** The question's part for the held threads it asks about (each with the listed ref it reads like), '' for none. Pure. */
export function mergeQuestionPart(asked: ReadonlyArray<{ ref: string; held: HeldTitle; likeRef: string }>): string {
  if (!asked.length) return '';
  const items = asked.map(({ ref, held, likeRef }) => `${ref}, which you titled "${clean(held.title)}", reads like ${likeRef} "${clean(held.likeTitle)}"`);
  return `Threads whose title repeats another listed one: ${items.join('; ')}. The same subject: FOR_USER_THREAD_MERGE: <ref> | <that ref> (Walnut puts it under that one before your lines, so that one's line speaks for both);`
    + ' another subject: leave the line out, and the title you gave is written.';
}

const MERGE_RE = markerRe('FOR_USER_THREAD_MERGE', 'gm');

/** A listed ref as the merge lines read it (status-threads.ts ThreadRef). */
interface MergeRef { id: string; untitled?: boolean; mergeInto?: string; upTo?: string }

/**
 * The merges an answer asks for, and the held threads the question asked about (`merges_checked`:
 * each is asked once, only when the answer has thread lines: one that lost them asked nothing). A
 * held thread merges only into the thread it was asked with; an untitled one into any other listed
 * thread. `ref` normalizes a ref as the thread lines do. Pure.
 */
export function readMergeLines(answer: string, refs: ReadonlyMap<string, MergeRef>, ref: (raw: string) => string, answered: boolean): { threads_merge?: MergeMark[]; merges_checked?: MergeMark[] } {
  const byId = new Map([...refs.values()].map((r) => [r.id, r]));
  const mark = (r: MergeRef, into: string): MergeMark => {
    const to = byId.get(into);
    return { id: r.id, into, ...(r.upTo !== undefined ? { upTo: r.upTo } : {}), ...(to?.upTo !== undefined ? { intoUpTo: to.upTo } : {}) };
  };
  const merges = new Map<string, MergeMark>();
  for (const m of answer.matchAll(MERGE_RE)) {
    const [a, b] = m[1].split(/[|｜]/);
    const from = refs.get(ref(a ?? ''));
    const into = b !== undefined ? refs.get(ref(b)) : undefined;
    const target = from?.mergeInto ?? (from?.untitled && into && into.id !== from.id ? into.id : undefined);
    if (from && target && (!into || into.id === target) && !merges.has(from.id)) merges.set(from.id, mark(from, target));
  }
  const checked = answered || merges.size ? [...refs.values()].filter((r) => !!r.mergeInto).map((r) => mark(r, r.mergeInto!)) : [];
  return { ...(merges.size ? { threads_merge: [...merges.values()] } : {}), ...(checked.length ? { merges_checked: checked } : {}) };
}

/** A merge the answer made: its thread, the one it went into, and that one's newest message before and after, and when asked. */
export interface HeldMerge { from: string; into: string; before: string; after: string; intoUpTo?: string }

/**
 * Carry out the answer's merges and its word on the held threads it was asked about (pure, inside
 * the answer's locked write, before its lines). A thread he wrote in since the question, or one
 * titled since, is left as it is; a merge the threads refuse writes a held title instead; every other
 * held thread asked about takes its held title.
 */
export function settleHeldTitles(file: ThreadsFile, checked: readonly MergeMark[], merges: readonly MergeMark[], by: ThreadWriter, at: string): { file: ThreadsFile; merged: HeldMerge[]; titled: string[] } {
  const merged: HeldMerge[] = [];
  const titled: string[] = [];
  const settled = new Set<string>();
  const still = (c: MergeMark): OrgThread | undefined => {
    const t = file.threads.find((x) => x.id === c.id);
    return t && !t.closed && !t.titled && (c.upTo === undefined || newest(t) === c.upTo) ? t : undefined;
  };
  const writeHeld = (id: string) => {
    file = { ...file, threads: file.threads.map((x) => (x.id !== id || !x.titleHeld ? x : titledFrom(x, by, at))) };
    titled.push(id);
  };
  for (const m of merges) {
    settled.add(m.id);
    const t = still(m);
    if (!t) continue;
    const into = file.threads.find((x) => x.id === m.into);
    try {
      const done = mergeThreads(file, m.id, m.into, by, at);
      merged.push({ from: m.id, into: m.into, before: newest(into!), after: newest(done.thread), ...(m.intoUpTo !== undefined ? { intoUpTo: m.intoUpTo } : {}) });
      file = done.file;
    } catch (err) {
      if (!(err instanceof ThreadError)) throw err;
      if (t.titleHeld) writeHeld(m.id);
    }
  }
  for (const c of checked) if (!settled.has(c.id) && still(c)?.titleHeld) writeHeld(c.id);
  return { file, merged, titled };
}

function titledFrom(t: OrgThread, by: ThreadWriter, at: string): OrgThread {
  const { titleHeld, ...rest } = t;
  return { ...rest, title: titleHeld!.title, titled: true, updatedAt: at, by };
}

/**
 * The answer's lines or marks after its merges (pure). One of the thread that went into another
 * speaks for that one when it has none of its own (else it is dropped), and one of the thread it went
 * into, written when that one's newest message was the question's, reads up to the merged newest (the
 * question showed both). A retargeted one reads that far only when the other had nothing newer than
 * the question; otherwise it keeps that one's fence, and holds.
 */
export function throughMerges<T extends { id: string; upTo?: string }>(items: readonly T[], merged: readonly HeldMerge[]): T[] {
  let out = [...items];
  for (const m of merged) {
    const own = out.some((x) => x.id === m.into);
    out = out.flatMap((x) => {
      if (x.id === m.into) return [x.upTo === m.before ? { ...x, upTo: m.after } : x];
      if (x.id !== m.from) return [x];
      if (own) return [];
      const fence = m.intoUpTo === undefined || m.intoUpTo === m.before ? m.after : m.intoUpTo;
      return [{ ...x, id: m.into, ...(x.upTo !== undefined ? { upTo: fence } : {}) }];
    });
  }
  return out;
}
