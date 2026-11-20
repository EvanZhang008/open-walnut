/**
 * A thread that holds something outside Threads that waits on the user: a decision letter
 * (experiment letters_as_threads, letter-thread-model.ts) or a Board choice (experiment brief_off,
 * choice-thread-model.ts). One rule for both: the thread's id comes from what it holds, so one item
 * has one thread; it waits on him in needs while the item is live; when the item ends the thread
 * says how; the experiment going off sets it aside (`off`) and coming back on opens it again.
 *
 * Pure: each function takes the file and returns the next one. The runtime (held-threads.ts and
 * its two users) runs them under the threads file lock.
 */
import crypto from 'node:crypto';
import type { OrgThread, ThreadsFile, ThreadWriter } from './threads-model.js';

export type HeldKind = 'letter' | 'choice';
/** What every held item carries on its thread. */
interface HeldMark { done?: true; off?: true }
interface Marks { letter?: HeldMark; choice?: HeldMark }
type Holding = Pick<OrgThread, 'closed' | 'state'> & Marks & { movedTo?: unknown };

const markOf = (t: Marks, kind: HeldKind): HeldMark | undefined => (kind === 'letter' ? t.letter : t.choice);

/** The one thread id of a held item: `key` is the letter's id, or `<board>/<choice id>`. */
export function heldThreadId(kind: HeldKind, key: string): string {
  return `th-${crypto.createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 24)}`;
}

/** The item the thread still stands for: not ended, not set aside by the experiment going off. */
export function liveHeld(t: Marks, kind: HeldKind): boolean {
  const m = markOf(t, kind);
  return !!m && !m.done && !m.off;
}

/** The thread still waits on him for its item: open, in needs, holding a live item. */
export function holdsHeld(t: Holding, kind: HeldKind): boolean {
  return liveHeld(t, kind) && !t.closed && t.state === 'needs';
}

/** Set aside when the experiment went off, and not moved on since: the experiment coming back opens it again. */
export function heldAside(t: Holding, kind: HeldKind): boolean {
  const m = markOf(t, kind);
  return !!m?.off && !m.done && !t.movedTo && (!!t.closed || t.state === 'needs');
}

/**
 * The item's thread on `file`: `fresh()` opened in needs when the file has none with its id; one
 * set aside holds it again; any other (open, closed by him or its node, ended, a pointer to where
 * it moved) is left as it is. Never two.
 */
export function openHeldThread(file: ThreadsFile, kind: HeldKind, id: string, fresh: () => OrgThread, at: string, by: ThreadWriter): { file: ThreadsFile; thread: OrgThread; changed: 'opened' | 'reopened' | null } {
  const cur = file.threads.find((t) => t.id === id);
  if (cur) {
    if (!heldAside(cur, kind)) return { file, thread: cur, changed: null };
    const { closed: _c, ...rest } = cur;
    const { off: _o, ...mark } = markOf(cur, kind)!;
    const next = { ...rest, state: 'needs', [kind]: mark, updatedAt: at, by } as OrgThread;
    return { file: { ...file, threads: file.threads.map((t) => (t.id === id ? next : t)) }, thread: next, changed: 'reopened' };
  }
  const thread = fresh();
  return { file: { ...file, threads: [...file.threads, thread] }, thread, changed: 'opened' };
}

/** How the item ended, as its thread says it. */
export type HeldOutcome =
  /** He answered it himself: nothing new for him, so the thread closes as known. */
  | { kind: 'his'; words: string }
  /** Someone answered it for him (a lead, a VP, Main, another task): news for him, so it stays as answered. */
  | { kind: 'for_him'; words: string }
  /** Nobody needs to answer it any more (settled, withdrawn, archived, gone): the thread closes as dropped. */
  | { kind: 'moot'; words: string; byHim?: boolean }
  /** The experiment went off: closed, and opened again when it comes back. */
  | { kind: 'off' };

const REPLY_MAX = 2000;
const clip = (s: string, max: number): string => { const t = s.trim(); return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`; };

/**
 * The item no longer waits on him: its thread, while it still waits on him for it (holdsHeld),
 * says how it ended. A thread that left needs (his words on it made it working, its node moved it
 * on) is its own conversation now and is left as it is. Null when nothing changed.
 */
export function settleHeldThread(file: ThreadsFile, threadId: string, kind: HeldKind, outcome: HeldOutcome, at: string): { file: ThreadsFile; thread: OrgThread } | null {
  const cur = file.threads.find((t) => t.id === threadId);
  if (!cur || !holdsHeld(cur, kind)) return null;
  const mark = markOf(cur, kind)!;
  let next: OrgThread;
  if (outcome.kind === 'off') {
    next = { ...cur, [kind]: { ...mark, off: true }, closed: { how: 'dropped', at, by: 'agent', told: true } } as OrgThread;
  } else {
    const reply = clip(outcome.words, REPLY_MAX);
    const by: ThreadWriter = outcome.kind === 'his' || (outcome.kind === 'moot' && outcome.byHim) ? 'human' : 'agent';
    const { pinned: _p, snoozed: _s, ...rest } = cur;
    next = {
      ...(outcome.kind === 'for_him' ? cur : rest), state: 'answered', reply, replyAt: at, reply_by: by, updatedAt: at, by,
      // Ended: a later ask on this thread is the node's own, never this item's again.
      [kind]: { ...mark, done: true },
      ...(outcome.kind === 'his' ? { closed: { how: 'acked' as const, at, by, reacted: true, told: true }, reactedAt: at } : {}),
      ...(outcome.kind === 'moot' ? { closed: { how: 'dropped' as const, at, by, told: true } } : {}),
    } as OrgThread;
    // Walnut wrote this summary from the item: no session's words, so no session to open paths on.
    delete next.reply_sid;
    delete next.reply_host;
  }
  return { file: { ...file, threads: file.threads.map((t) => (t.id === threadId ? next : t)) }, thread: next };
}
