/**
 * His message filed into a thread only for coming right after his last one (threads-model.ts
 * SAME_CONVERSATION_MS, ThreadMessage.joined) is checked once by the node that answered it, in its
 * status answer (2026-11-23, Walnut VP, of three messages each joined to the thread of the message
 * before it though their subject was another: each "followed right after the last one, so it went
 * into the last one's thread; the subject was really different"). The hint on the message only suggested thread_split, which nodes left undone:
 * on his data a reader judged 38 of 535 such joins (7%) another subject, 37 of them on one VP node,
 * and no node had split one.
 *
 * The question names each such message with the one before it. The answer splits it with one line,
 * FOR_USER_THREAD_SPLIT: <ref> | <title> | <state> | <where it stands>, or leaves the line out (the
 * same subject). Either way its mark comes off, so each message is asked once. A split takes the
 * joined messages right after it too (they came right after it, as the join did), up to the newest
 * message the question saw; they keep their marks, so the next question asks each in its new thread.
 * The split runs first, in the same locked write as the answer's thread lines (status-threads.ts
 * applyThreadLines), so a line that closes the first subject closes only what is left of it.
 */
import type { OrgThread, ThreadsFile, ThreadWriter } from '../org/threads-model.js';
import { splitMessageInto, splitThreadMessage, ThreadError } from '../org/threads-model.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { markerRe } from './status-marker.js';
import type { StatusThreadLine, ThreadLineState } from './status-threads.js';

/** Messages one question asks about at most (one per thread, its first unchecked join). */
export const JOINS_ASKED_MAX = 3;
/** A mark older than this is not asked: a thread he reopens days later is not carved up by an old join. */
export const JOIN_ASK_MAX_AGE_MS = 24 * 3600_000;
const TEXT_SHOWN_MAX = 80;
const BEFORE_SHOWN_MAX = 60;

/** The message of a listed thread the question asks about, with his message before it there. */
export interface JoinedMessage { messageId: string; text: string; before: string }
/** One message the question asked about: its thread, and that thread's newest message and his newest anywhere then. */
export interface JoinMark { id: string; messageId: string; upTo?: string; hisAt?: string }
/** A FOR_USER_THREAD_SPLIT line, its ref resolved. */
export interface StatusThreadSplit extends JoinMark { title: string; state: ThreadLineState; progress?: string }

const clean = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

/** The first message of `t` still marked joined, with a message of his before it, filed in the last day. Pure. */
export function joinedToAsk(t: Pick<OrgThread, 'messages'>, now = Date.now()): JoinedMessage | undefined {
  const i = t.messages.findIndex((m, k) => k > 0 && m.joined === 'recent' && now - Date.parse(m.at) <= JOIN_ASK_MAX_AGE_MS);
  if (i < 0) return undefined;
  return { messageId: t.messages[i].id, text: t.messages[i].text, before: t.messages[i - 1].text };
}

/** The question's part for the listed refs that carry a join, '' for none. Pure. */
export function splitQuestionPart(asked: ReadonlyArray<{ ref: string; joined: JoinedMessage }>, words: string): string {
  if (!asked.length) return '';
  const items = asked.map(({ ref, joined }) => `${ref} "${clean(joined.text, TEXT_SHOWN_MAX)}" (right after "${clean(joined.before, BEFORE_SHOWN_MAX)}")`);
  return `His messages filed into a thread only for coming right after his last one there: ${items.join('; ')}.`
    + ` Each that is another subject gets a thread of its own, with the messages right after it: FOR_USER_THREAD_SPLIT: <ref> | <title> | <working | waiting | answered | done> | <where it stands for him>${words}.`
    + ' Walnut splits it out first, so that ref\'s own line is about what is left of its first subject. The same subject: leave the line out.';
}

const SPLIT_RE = markerRe('FOR_USER_THREAD_SPLIT', 'gm');

/**
 * The splits an answer asks for and every join the question asked about (`joins_checked`, whatever
 * the answer said: each is asked once). `read` resolves a ref, a state word and a line's text the
 * way the thread lines do. Pure.
 */
export function readSplitLines(
  answer: string,
  refs: ReadonlyMap<string, { id: string; joined?: string; upTo?: string; hisAt?: string }>,
  read: { ref: (raw: string) => string; state: (raw: string) => ThreadLineState | null; text: (raw: string, max: number) => string; titleMax: number; progressMax: number },
): { threads_split?: StatusThreadSplit[]; joins_checked?: JoinMark[] } {
  const markOf = (r: { id: string; joined?: string; upTo?: string; hisAt?: string }): JoinMark =>
    ({ id: r.id, messageId: r.joined!, ...(r.upTo !== undefined ? { upTo: r.upTo } : {}), ...(r.hisAt !== undefined ? { hisAt: r.hisAt } : {}) });
  const checked = [...refs.values()].filter((r) => !!r.joined).map(markOf);
  if (!checked.length) return {};
  const splits = new Map<string, StatusThreadSplit>();
  for (const m of answer.matchAll(SPLIT_RE)) {
    const [ref, title, state, ...rest] = m[1].split(/[|\uff5c]/);
    const target = refs.get(read.ref(ref ?? ''));
    const name = read.text(title ?? '', read.titleMax);
    const st = read.state(state ?? '');
    if (!target?.joined || !name || !st || splits.has(target.id)) continue;
    const progress = read.text(rest.join('|'), read.progressMax);
    splits.set(target.id, { ...markOf(target), title: name, state: st, ...(progress ? { progress } : {}) });
  }
  return { ...(splits.size ? { threads_split: [...splits.values()] } : {}), joins_checked: checked };
}

/**
 * The messages one split takes out of `t`: the asked one and the joined ones right after it, up to
 * `upTo` (the newest the question saw: one he wrote after it stays, and its question comes next).
 * Empty when the asked message is gone from it or no longer marked (a split or merge moved it). Pure.
 */
export function splitRun(t: Pick<OrgThread, 'messages'>, messageId: string, upTo?: string): string[] {
  const i = t.messages.findIndex((m) => m.id === messageId);
  if (i <= 0 || t.messages[i].joined !== 'recent') return [];
  // No fence the question saw (or it moved away): the asked message alone.
  const fence = upTo === undefined ? i : t.messages.findIndex((m) => m.id === upTo);
  const run = [messageId];
  for (let k = i + 1; k <= fence && t.messages[k].joined === 'recent'; k++) run.push(t.messages[k].id);
  return run;
}

/** The file with the join mark taken off one message, wherever it is now. Pure. */
export function clearJoin(file: ThreadsFile, messageId: string): ThreadsFile {
  let hit = false;
  const threads = file.threads.map((t) => {
    if (!t.messages.some((m) => m.id === messageId && m.joined)) return t;
    hit = true;
    return { ...t, messages: t.messages.map((m) => {
      if (m.id !== messageId) return m;
      const { joined: _j, ...rest } = m;
      return rest;
    }) };
  });
  return hit ? { ...file, threads } : file;
}

/** What the splits did: the threads opened with their lines, and for each source the messages moved and the newest one the question saw that is left. */
export interface JoinSplits {
  file: ThreadsFile;
  opened: Array<{ id: string; line: StatusThreadSplit }>;
  moved: Map<string, { ids: Set<string>; last: string }>;
}

/**
 * Carry out the answer's word on its joins (pure, inside the answer's locked write): each split line
 * takes its run into a thread of its own named by the line (the asked message loses its mark, the
 * run's tail keeps it); every other asked message loses its mark. A split a thread refuses only
 * takes the mark off.
 */
export function splitJoins(file: ThreadsFile, checked: readonly JoinMark[], splits: readonly StatusThreadSplit[], by: ThreadWriter, at: string, lang: LetterLang): JoinSplits {
  const byMessage = new Map(splits.map((s) => [s.messageId, s]));
  const opened: JoinSplits['opened'] = [];
  const moved: JoinSplits['moved'] = new Map();
  for (const c of checked) {
    const line = byMessage.get(c.messageId);
    const from = file.threads.find((t) => t.id === c.id && !t.closed);
    const run = line && from ? splitRun(from, c.messageId, c.upTo) : [];
    if (!line || !run.length) { file = clearJoin(file, c.messageId); continue; }
    try {
      let next = splitThreadMessage(file, c.id, run[0], by, at, undefined, lang, { keepOpen: true });
      const id = next.thread.id;
      for (const m of run.slice(1)) next = { ...splitMessageInto(next.file, c.id, m, id, by, at, lang, { keepOpen: true }), thread: next.thread };
      const tail = new Set(run.slice(1));
      // Named by the answer, as a FOR_USER_THREAD_TITLE names an untitled thread; the tail is asked next.
      file = { ...next.file, threads: next.file.threads.map((t) => (t.id !== id ? t : {
        ...t, title: line.title, titled: true, messages: t.messages.map((m) => (tail.has(m.id) ? { ...m, joined: 'recent' as const } : m)),
      })) };
      // What is left of what the question saw there: a word of his after it still holds that line (review round 2).
      const ids = new Set(run);
      const fence = c.upTo === undefined ? -1 : from!.messages.findIndex((m) => m.id === c.upTo);
      const seen = from!.messages.slice(0, fence + 1).filter((m) => !ids.has(m.id));
      moved.set(c.id, { ids, last: seen[seen.length - 1]?.id ?? '' });
      opened.push({ id, line });
    } catch (err) {
      if (!(err instanceof ThreadError)) throw err;
      file = clearJoin(file, c.messageId);
    }
  }
  return { file, opened, moved };
}

/**
 * The answer's thread lines after its splits: a source's line whose newest message moved out reads
 * up to what is left there (a newer word of his still holds it), and each opened thread gets its
 * split line's state and words as a thread line of its own. Pure.
 */
export function linesAfterSplits(lines: readonly StatusThreadLine[], s: Pick<JoinSplits, 'file' | 'opened' | 'moved'>): StatusThreadLine[] {
  const kept = lines.map((l) => {
    const m = s.moved.get(l.id);
    return m && l.upTo !== undefined && m.ids.has(l.upTo) ? { ...l, upTo: m.last } : l;
  });
  const made = s.opened.map(({ id, line }) => {
    const t = s.file.threads.find((x) => x.id === id);
    return { id, title: line.title, state: line.state, ...(line.progress ? { progress: line.progress } : {}),
      upTo: t?.messages[t.messages.length - 1]?.id ?? '', ...(line.hisAt !== undefined ? { hisAt: line.hisAt } : {}) };
  });
  return [...kept, ...made];
}
