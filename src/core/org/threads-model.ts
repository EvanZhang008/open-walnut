/**
 * The Threads of an Org node (Main, a VP, a lead): the user's own requests to it, one thread per
 * subject (2026-11-01, the user: "every user request becomes a thread ... I can acknowledge, or
 * do follow up actions ... this brief is focused on task, but this thread is my own request";
 * then "if my multiple ask is about the same thread, add it below that thread").
 *
 * Walnut files every message the user types into the node's chat as a thread message
 * (thread-capture.ts), so none is forgotten; the node keeps each thread current itself
 * (`thread_update`: a short title, its state, a one-line reply, the tasks it went to) and puts
 * a message about an open subject under that thread (`merge_into`). A wrong merge is split back
 * out (`splitThreadMessage`). The user closes a thread with Acknowledge; asking again about a
 * closed subject opens a new thread that `follows` the old one.
 *
 * Each message carries the node's answer to it (`answer`), which Walnut reads from the node's own
 * chat (thread-answers.ts), so a thread reads as its conversation (2026-11-01, the user: "do it
 * like slack thread, make it clear what is the conversation in this thread"). What he already
 * knows folds to one line of context (thread-view.ts). An answer counts as known only once he
 * reacted after it (2026-11-01, the user: "I had not replied ... so clearly I had not acknowledged
 * it"): a node may mark exchanges known (`known`) or close a thread only then (`reactedSince`).
 *
 * His view shows a thread only when it has something for him (thread-view.ts shownToHim): needs,
 * answered, or a node answer he has not reacted to. His message in a thread makes it working, so it
 * leaves his view at once (2026-11-01, the user: "if i reply to a thread, it shoud go out of the
 * thread immediately instead of just show working"); `pending` stays hidden even with an answer on
 * it (a handoff the node judged no news: "if it is just assigned no need to tell me ... thread
 * pending, which is auto hide like closed"). A new summary written without a state is news: answered.
 *
 * A node may also open a thread itself for something that reached it the user must act on or asked
 * to follow (2026-11-01, the user: "you can also create a new thread even if it is not from me ...
 * some new message, from somewhere like mail"): its first post is the node's (`opener`), his reply
 * is filed under it like any follow-up.
 *
 * He may put a thread aside until a time (`snoozed`, 2026-11-02, the user: "low priority, will follow
 * up later, actually in thread has a snoozed section, also a snoozed button"): it leaves his view for
 * a Snoozed section and comes back on its date, or earlier on real news (thread-view.ts snoozedNow).
 * His message in it, a move to needs or to answered takes the snooze off here; the node is not woken.
 *
 * He may pin a thread (`pinned`, 2026-11-03, the user: "have a pin thread feature, like this thread I
 * need to make it pinned"): it stays at the top of his view whatever its state, until he unpins it or
 * acknowledges it. The node may pin and unpin too, but never takes off a pin of his: it cannot unpin,
 * snooze or close a thread he pinned. A pin moves no clock (`updatedAt`), so an unpinned thread goes
 * back to where it was.
 *
 * Pure: every function takes the file and returns the next one, or throws ThreadError. The
 * store (threads-store.ts) runs them under the file lock.
 */
import { userKindVerdict } from './user-kind.js';
import type { LetterLang } from '../human-inbox/walnut-letters/languages.js';
import { PICTURE_TITLE_WORDS } from '../human-inbox/walnut-letters/receipt-words.js';
import { pinnedFirst } from './thread-view.js';
import crypto from 'node:crypto';

export const THREAD_STATES = ['new', 'working', 'needs', 'answered', 'pending'] as const;
export type ThreadState = typeof THREAD_STATES[number];
/** The states his view keeps out of sight unless an answer he has not reacted to is on it (pending: even then). */
export const HIDDEN_STATES: ReadonlySet<ThreadState> = new Set(['new', 'working', 'pending']);
export const THREAD_CLOSE_HOWS = ['acked', 'dropped'] as const;
export type ThreadCloseHow = typeof THREAD_CLOSE_HOWS[number];
/** Where a thread message came from. */
export type ThreadVia = 'chat' | 'follow-up' | 'letter' | 'import' | 'split';
/** Who made a change: the user, or a task's session. */
export type ThreadWriter = 'human' | 'agent' | `task:${string}`;

export const THREAD_TITLE_MAX = 120;
export const THREAD_ASK_MAX = 400;
export const THREAD_REPLY_MAX = 2000;
export const THREAD_MESSAGE_MAX = 8000;
export const THREAD_TASKS_MAX = 12;
export const THREAD_IMAGES_MAX = 12;
/** An answer kept whole up to this; the view folds it to a few lines. */
export const THREAD_ANSWER_MAX = 16_000;
/** Closed threads kept at most, newest first; open threads are never dropped. */
export const CLOSED_KEPT = 200;
/**
 * A closed thread is kept this long, then deleted for good: long enough to undo a mistaken
 * Acknowledge, reopen it, or link a new ask back to it (2026-11-01, the user: "once I acknowledge
 * it, just delete it ... for me Open is enough").
 */
export const CLOSED_KEEP_MS = 7 * 24 * 3600_000;

export const THREAD_ID_RE = /^th-[a-f0-9]{6,32}$/;
export const THREAD_MESSAGE_ID_RE = /^tm-[a-f0-9]{6,32}$/;

export interface ThreadMessage {
  id: string;
  at: string;
  /** The user's words as he sent them (attachment headers taken off), capped. */
  text: string;
  /** Paths of the pictures he attached. */
  images?: string[];
  via: ThreadVia;
  /** A letter answer: the letter's subject, so the words read in context. */
  about?: string;
  /** A letter answer: the letter's id, whose own thread holds the node's answer (thread-answers.ts). */
  letter?: string;
  /** The send's own id (the phone's qm- id): the same send again is the same message. */
  key?: string;
  /** The node session it was sent to, where its answer is read. */
  sid?: string;
  /** The node's answer, read from its chat by Walnut (thread-answers.ts). */
  answer?: ThreadAnswer;
}

export interface ThreadAnswer {
  /** The node's reply as its chat shows it (Markdown, its rich markup kept for the chat renderer). */
  text: string;
  at: string;
  /** The tasks the reply is about (its `<walnut-about>` line, or the history parse). */
  about?: string[];
  clipped?: boolean;
  /** Read from the letter's own thread (a letter note's answer, thread-answers.ts letterAnswerOf). */
  from?: 'letter';
}

/** A letter note whose answer was not read from its letter (filed before 2026-11-03, taken from the chat). */
export function letterAnswerMissing(m: Pick<ThreadMessage, 'via' | 'answer'>): boolean {
  return m.via === 'letter' && m.answer?.from !== 'letter';
}

/** Where a thread the node opened came from. */
export const THREAD_SOURCES = ['mail', 'task', 'letter', 'trigger', 'node'] as const;
export type ThreadSource = typeof THREAD_SOURCES[number];

/** The first post of a thread the node opened itself: what reached it, in its words. */
export interface ThreadOpener {
  text: string;
  at: string;
  from: ThreadSource;
  /** What it points at: a task id, a letter id (lt-...), a mail's subject. */
  ref?: string;
  by: ThreadWriter;
}

/** The node decided the user already knows every exchange through this message (thread-view.ts). */
export interface ThreadKnown {
  through: string;
  by: ThreadWriter;
  at: string;
}

export interface ThreadClosed {
  how: ThreadCloseHow;
  at: string;
  by: ThreadWriter;
  /** The node was told it closed (the threads hint), so it is not told again. */
  told?: boolean;
}

/** He put the thread aside until `until` (the node may too); it comes back then, or on news. */
export interface ThreadSnoozed {
  until: string;
  at: string;
  by: ThreadWriter;
}

/** Kept at the top of his view, whatever its state, until unpinned or closed. */
export interface ThreadPinned {
  at: string;
  by: ThreadWriter;
}

export interface OrgThread {
  id: string;
  /** A few words. Walnut's first line of the first message until the node writes one. */
  title: string;
  /** The node wrote the title (Walnut's stand-in until then). */
  titled?: boolean;
  /** One line: what the user wants, in the node's words. */
  ask?: string;
  state: ThreadState;
  /** The node's latest answer or result, Markdown, one or two lines. */
  reply?: string;
  /** Tasks the thread went to: shown with their live status. */
  tasks?: string[];
  messages: ThreadMessage[];
  /** The closed thread this one asks again about. */
  follows?: string;
  createdAt: string;
  updatedAt: string;
  /** Who made the last change. */
  by?: ThreadWriter;
  closed?: ThreadClosed;
  /** What he already knows, as the node judged it (he reacted after those answers). */
  known?: ThreadKnown;
  /** The node opened this thread itself (not one of his requests): its first post. */
  opener?: ThreadOpener;
  /** Put aside until a time (thread-view.ts snoozedNow says whether it still is). */
  snoozed?: ThreadSnoozed;
  /** Pinned to the top of his view (thread-view.ts pinnedFirst). */
  pinned?: ThreadPinned;
  /** When a node last wrote a new summary (reply): the thread's latest result (human-inbox/thread-instead.ts). */
  replied?: { at: string; by: ThreadWriter };
}

export interface ThreadsFile {
  version: 1;
  taskId: string;
  threads: OrgThread[];
}

export type ThreadErrorCode = 'no_thread' | 'no_message' | 'bad_input' | 'thread_closed' | 'last_message' | 'same_thread' | 'not_reacted' | 'user_kind' | 'pinned_by_user';

export class ThreadError extends Error {
  constructor(public code: ThreadErrorCode, public status: number, message: string) {
    super(message);
    this.name = 'ThreadError';
  }
}

export function newThreadId(): string { return `th-${crypto.randomBytes(6).toString('hex')}`; }
export function newThreadMessageId(): string { return `tm-${crypto.randomBytes(6).toString('hex')}`; }

export function emptyThreads(taskId: string): ThreadsFile {
  return { version: 1, taskId, threads: [] };
}

function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** Walnut's stand-in title: the first line with words in it, cut to a readable length; a picture alone is named in the letter language. */
export function fallbackTitle(text: string, lang: LetterLang = 'en'): string {
  const line = text.split('\n').map((l) => l.replace(/^[>#*\-\s]+/, '').trim()).find(Boolean) ?? '';
  return clip(line || PICTURE_TITLE_WORDS[lang](), 80);
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function normalizeMessage(m: unknown): ThreadMessage | null {
  if (!m || typeof m !== 'object') return null;
  const x = m as Partial<ThreadMessage>;
  if (!isStr(x.id) || !isStr(x.at) || !isStr(x.text)) return null;
  const next = { ...x, via: isStr(x.via) ? x.via : 'chat', ...(Array.isArray(x.images) ? { images: x.images.filter(isStr) } : {}) } as ThreadMessage;
  if (next.answer && !(typeof next.answer === 'object' && isStr(next.answer.text) && isStr(next.answer.at))) delete next.answer;
  return next;
}

/** One thread read from disk: what every reader relies on is there, or the thread is left out. */
function normalizeThread(t: unknown): OrgThread | null {
  if (!t || typeof t !== 'object') return null;
  const x = t as Partial<OrgThread>;
  if (!isStr(x.id) || !Array.isArray(x.messages)) return null;
  const messages = x.messages.map(normalizeMessage).filter((m): m is ThreadMessage => !!m);
  const o = x.opener;
  const opener = o && typeof o === 'object' && isStr(o.text) && isStr(o.at) ? { ...o, from: THREAD_SOURCES.includes(o.from) ? o.from : 'node' } as ThreadOpener : undefined;
  if (!messages.length && !opener) return null;
  const firstAt = opener?.at ?? messages[0].at;
  const updatedAt = isStr(x.updatedAt) ? x.updatedAt : messages[messages.length - 1]?.at ?? firstAt;
  const next: OrgThread = {
    ...x, id: x.id, messages, updatedAt, createdAt: isStr(x.createdAt) ? x.createdAt : firstAt,
    title: isStr(x.title) && x.title.trim() ? x.title : fallbackTitle(opener?.text ?? messages[0].text),
    state: THREAD_STATES.includes(x.state as ThreadState) ? x.state as ThreadState : 'new',
  };
  if (x.closed) {
    if (typeof x.closed === 'object' && THREAD_CLOSE_HOWS.includes(x.closed.how)) {
      next.closed = { ...x.closed, at: isStr(x.closed.at) ? x.closed.at : updatedAt, by: isStr(x.closed.by) ? x.closed.by : 'human' };
    } else delete next.closed;
  }
  if (opener) next.opener = opener; else delete next.opener;
  if (next.snoozed && !(typeof next.snoozed === 'object' && isStr(next.snoozed.until) && isStr(next.snoozed.at) && Number.isFinite(Date.parse(next.snoozed.until)))) delete next.snoozed;
  if (next.pinned && !(typeof next.pinned === 'object' && isStr(next.pinned.at))) delete next.pinned;
  else if (next.pinned && !isStr(next.pinned.by)) next.pinned = { ...next.pinned, by: 'human' };
  // A closed thread holds no pin (a hand edit, or a file from a build that kept one).
  if (next.closed) delete next.pinned;
  if (next.known && !(typeof next.known === 'object' && isStr(next.known.through) && messages.some((m) => m.id === next.known!.through))) delete next.known;
  return next;
}

/** A file read from disk, made safe to work on (an old or hand-edited one included). */
export function normalizeThreads(raw: unknown, taskId: string): ThreadsFile {
  const f = raw && typeof raw === 'object' ? raw as Partial<ThreadsFile> : {};
  const threads = Array.isArray(f.threads) ? f.threads.map(normalizeThread).filter((t): t is OrgThread => !!t) : [];
  return { version: 1, taskId, threads };
}

export function isOpen(t: OrgThread): boolean { return !t.closed; }

/** Open threads first (the pinned ones on top, newest pin first; then newest change first), then closed ones (newest close first). */
export function sortedThreads(threads: readonly OrgThread[]): OrgThread[] {
  const open = pinnedFirst(threads.filter(isOpen).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  const closed = threads.filter((t) => !isOpen(t)).sort((a, b) => (b.closed!.at).localeCompare(a.closed!.at));
  return [...open, ...closed];
}

/** Drop the closed threads past their week (and past the cap), as of `at`. */
function prune(threads: OrgThread[], at: string): OrgThread[] {
  const now = Date.parse(at);
  const expired = (t: OrgThread) => Number.isFinite(now) && now - Date.parse(t.closed!.at) > CLOSED_KEEP_MS;
  const closed = threads.filter((t) => !isOpen(t)).sort((a, b) => b.closed!.at.localeCompare(a.closed!.at));
  const drop = new Set([...closed.filter(expired), ...closed.slice(CLOSED_KEPT)].map((t) => t.id));
  return drop.size ? threads.filter((t) => !drop.has(t.id)) : threads;
}

/** The primary's sweep: closed threads past their week are deleted for good. */
export function sweepClosed(file: ThreadsFile, at: string): { file: ThreadsFile; dropped: number } {
  const threads = prune(file.threads, at);
  return { file: threads === file.threads ? file : { ...file, threads }, dropped: file.threads.length - threads.length };
}

function find(file: ThreadsFile, id: string): OrgThread {
  const t = file.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError('no_thread', 404, `No thread ${id} on this node.`);
  return t;
}

function replace(file: ThreadsFile, next: OrgThread, at: string): ThreadsFile {
  return { ...file, threads: prune(file.threads.map((t) => (t.id === next.id ? next : t)), at) };
}

export interface FileMessageInput {
  text: string;
  images?: string[];
  via: ThreadVia;
  about?: string;
  letter?: string;
  /** Put it under this thread (the Follow up button). A closed one opens a new thread that follows it. */
  threadId?: string;
  /** Ids chosen ahead (the send path tells the node the id before the message is stored). */
  newThreadId?: string;
  messageId?: string;
  /** The send's own id: a message already filed under it is not filed again (a retry). */
  key?: string;
  /** The node session it goes to (its answer is read there). */
  sid?: string;
  at: string;
  /** The letter language, for Walnut's stand-in title (threads-store fills it). */
  lang?: LetterLang;
}

export interface FileMessageResult {
  file: ThreadsFile;
  thread: OrgThread;
  message: ThreadMessage;
  /** A new thread was opened for it. */
  created: boolean;
  /** This send was already filed (its key, or its message id): nothing changed. */
  duplicate: boolean;
}

/** File one message of the user's. Never throws on a missing thread: the message is never lost. */
export function fileMessage(file: ThreadsFile, input: FileMessageInput): FileMessageResult {
  const text = clip(input.text, THREAD_MESSAGE_MAX);
  const images = (input.images ?? []).filter((p) => typeof p === 'string' && p).slice(0, THREAD_IMAGES_MAX);
  // The same send again (a retry with its id): filed once. Words alone never decide it: "yes" to
  // two questions a minute apart is two answers.
  for (const t of file.threads) {
    const seen = t.messages.find((m) => (input.key && m.key === input.key) || (input.messageId && m.id === input.messageId));
    if (seen) return { file, thread: t, message: seen, created: false, duplicate: true };
  }
  const message: ThreadMessage = {
    id: input.messageId && THREAD_MESSAGE_ID_RE.test(input.messageId) ? input.messageId : newThreadMessageId(),
    at: input.at, text, via: input.via,
    ...(images.length ? { images } : {}),
    ...(input.about ? { about: clip(input.about, THREAD_TITLE_MAX) } : {}),
    ...(input.letter ? { letter: input.letter.slice(0, 80) } : {}),
    ...(input.key ? { key: input.key.slice(0, 80) } : {}),
    ...(input.sid ? { sid: input.sid.slice(0, 80) } : {}),
  };
  const target = input.threadId ? file.threads.find((t) => t.id === input.threadId) : undefined;
  if (target && isOpen(target)) {
    // His own message in a snoozed thread brings it back.
    const { snoozed: _s, ...rest } = target;
    const next: OrgThread = {
      ...rest, messages: [...target.messages, message], updatedAt: input.at, by: 'human',
      // He spoke again: a thread answered, waiting on him or pending is the node's turn again.
      ...(target.state === 'answered' || target.state === 'needs' || target.state === 'pending' ? { state: 'working' as ThreadState } : {}),
    };
    return { file: replace(file, next, input.at), thread: next, message, created: false, duplicate: false };
  }
  const thread: OrgThread = {
    id: input.newThreadId && THREAD_ID_RE.test(input.newThreadId) ? input.newThreadId : newThreadId(),
    title: fallbackTitle(text, input.lang),
    state: 'new', messages: [message], createdAt: input.at, updatedAt: input.at, by: 'human',
    ...(target ? { follows: target.id } : {}),
  };
  return { file: { ...file, threads: prune([...file.threads, thread], input.at) }, thread, message, created: true, duplicate: false };
}

export interface ThreadPatch {
  title?: string;
  ask?: string;
  state?: ThreadState;
  reply?: string;
  /** The tasks it went to, all of them (replaces the list). */
  tasks?: string[];
  /** Add these tasks to the list. */
  add_tasks?: string[];
  close?: ThreadCloseHow;
  reopen?: boolean;
  /** He already knows every exchange through this message (tm-...), or "all": they fold to context. */
  known?: string;
  /** Put it aside until this time: an ISO datetime or a duration from now ("4h", "3d"); "" takes the snooze off. */
  snooze?: string;
  /** true pins it to the top of his view, false unpins it (a node never unpins one he pinned). */
  pin?: boolean;
  /** With state needs from an agent: which of the user's kinds this is, and why (user-kind.ts). Never stored. */
  user_kind?: string;
  user_kind_why?: string;
}

/**
 * An agent hands the user a question by moving a thread to needs, or opening one that waits on
 * them: Walnut asks which of the user's kinds it is (user-kind.ts). The user's own writes and a
 * thread already waiting on them are never asked.
 */
const waitsOnUser = (state: ThreadState): boolean => state === 'needs';

function checkHandedToUser(by: ThreadWriter, input: { user_kind?: unknown; user_kind_why?: unknown }): void {
  if (by === 'human') return;
  const v = userKindVerdict(input);
  if (!v.ok) throw new ThreadError('user_kind', 409, v.message.replace(/^Not sent to the user:/, 'Not handed to the user:'));
}

const SNOOZE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
/** The longest snooze: a year. */
const SNOOZE_MAX_MS = 366 * 86_400_000;

/**
 * When a snooze ends: an ISO datetime, a date alone (that day's local midnight, as a task's start
 * date reads), or a duration from `at` ("90m", "4h", "3d"); never a time already begun, at most a year.
 */
export function parseSnoozeUntil(raw: string, at: string): string {
  const text = raw.trim();
  const now = Date.parse(at);
  const d = /^(\d+(?:\.\d+)?)\s*(m|h|d)$/i.exec(text);
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const ms = d ? now + Math.floor(Number(d[1]) * SNOOZE_UNIT_MS[d[2].toLowerCase()])
    : day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime()
    : Date.parse(text);
  if (Number.isFinite(ms) && ms - now > SNOOZE_MAX_MS) throw new ThreadError('bad_input', 400, `snooze "${text}" is more than a year away.`);
  if (!Number.isFinite(ms)) throw new ThreadError('bad_input', 400, `snooze "${text}" is neither an ISO datetime nor a duration like "4h" / "3d".`);
  if (ms <= now) throw new ThreadError('bad_input', 400, `snooze "${text}" is not in the future.`);
  return new Date(ms).toISOString();
}

function checkPatch(p: ThreadPatch): void {
  if (p.title !== undefined && (typeof p.title !== 'string' || !p.title.trim())) throw new ThreadError('bad_input', 400, 'title must be a few words.');
  if (p.state !== undefined && !THREAD_STATES.includes(p.state)) throw new ThreadError('bad_input', 400, `state must be one of ${THREAD_STATES.join(', ')}.`);
  if (p.close !== undefined && !THREAD_CLOSE_HOWS.includes(p.close)) throw new ThreadError('bad_input', 400, `close must be one of ${THREAD_CLOSE_HOWS.join(', ')}.`);
  if (p.close && p.reopen) throw new ThreadError('bad_input', 400, 'close and reopen cannot go together.');
  if (p.snooze !== undefined && typeof p.snooze !== 'string') throw new ThreadError('bad_input', 400, 'snooze must be an ISO datetime, a duration like "4h", or "".');
  if (p.close && p.snooze) throw new ThreadError('bad_input', 400, 'close and snooze cannot go together.');
  if (p.pin !== undefined && typeof p.pin !== 'boolean') throw new ThreadError('bad_input', 400, 'pin must be true or false.');
  if (p.pin && p.close) throw new ThreadError('bad_input', 400, 'pin and close cannot go together.');
  if (p.pin && p.snooze) throw new ThreadError('bad_input', 400, 'pin and snooze cannot go together: a pinned thread stays in his sight.');
  if (p.known !== undefined && p.known !== 'all' && !(typeof p.known === 'string' && THREAD_MESSAGE_ID_RE.test(p.known))) {
    throw new ThreadError('bad_input', 400, 'known must be a message id of this thread (tm-...) or "all".');
  }
}

/** The newest of the user's messages to this node, any thread (every one he sends is filed). */
export function lastUserAt(file: ThreadsFile): string | null {
  let last: string | null = null;
  for (const t of file.threads) for (const m of t.messages) if (!last || m.at > last) last = m.at;
  return last;
}

/** He wrote to the node after `at` (a reply, an ok, a follow-up): what was said before may be known. */
export function reactedSince(file: ThreadsFile, at: string): boolean {
  const last = lastUserAt(file);
  return !!last && last > at;
}

/** When the node last spoke in the exchanges through `upTo` (its answers, its first post); '' = never. */
function nodeWordAt(t: OrgThread, upTo: number): string {
  let at = t.opener?.at ?? '';
  for (const m of t.messages.slice(0, upTo + 1)) if (m.answer && m.answer.at > at) at = m.answer.at;
  return at;
}

/** A plain acknowledgement ("ok, thanks", "got it", a short Chinese "ok"): no question in it, a few words. */
export function isAcknowledgement(text: string): boolean {
  const t = text.trim();
  return !!t && t.length <= 40 && !/[?\uff1f]/.test(t);
}

/**
 * A node may close his thread only once he reacted after its last answer: an answer he did not
 * answer is not known, however clear it was (2026-11-01, the user: "I had not replied ... clearly
 * I had not acknowledged it ... you cannot remove it"). His last message may be that reaction
 * ("ok, thanks", the node replying to it is fine); a question of his the node is still answering,
 * or answered and he has not reacted to, is not. His own Acknowledge needs no check.
 */
function checkClose(file: ThreadsFile, t: OrgThread, by: ThreadWriter): void {
  if (by === 'human') return;
  const lastIdx = t.messages.length - 1;
  const last = t.messages[lastIdx];
  if (!last) {
    // Only the node's own post: closed once he wrote to it after it (anywhere, the node's judgment).
    if (t.opener && reactedSince(file, t.opener.at)) return;
    throw notReacted('closed', t.opener?.at ?? '');
  }
  if (last.answer && reactedSince(file, last.answer.at)) return;
  // His last message is a plain reaction to what the node said before it.
  const before = nodeWordAt(t, lastIdx - 1);
  if (before && last.at > before && isAcknowledgement(last.text)) return;
  throw notReacted('closed', last.answer?.at ?? nodeWordAt(t, lastIdx));
}

/**
 * What he knows, as the node may mark it: the exchanges through the latest message of his whose
 * answer Walnut has read and he wrote after. A later mark asked for is cut back to it; none at all
 * is refused.
 */
function knownThrough(file: ThreadsFile, t: OrgThread, upTo: number, by: ThreadWriter): number {
  if (by === 'human') return upTo;
  for (let k = upTo; k >= 0; k--) {
    const a = t.messages[k].answer;
    if (a && reactedSince(file, a.at)) return k;
  }
  throw notReacted('marked known', nodeWordAt(t, upTo));
}

function notReacted(what: string, at: string): ThreadError {
  return new ThreadError('not_reacted', 409,
    `Not ${what}: ${at ? `the user has not written to you since your last word in it (${at})` : 'there is no answer of yours in it he could have reacted to yet'}. `
    + 'An answer he has not reacted to is not known: the thread stays open (answered, your answer in full) until he replies, says ok or '
    + 'thanks, follows up, or acknowledges it.');
}

/** He pinned it: a node's write may not take it out of his sight. */
function checkHisPin(t: OrgThread, by: ThreadWriter, what: string): void {
  if (by !== 'human' && t.pinned?.by === 'human') {
    throw new ThreadError('pinned_by_user', 409, `Not ${what}: the user pinned thread ${t.id} to keep it in his sight; only he unpins it (or acknowledges it).`);
  }
}

/** Only a pin or unpin asked: the thread's place and its change time stay as they are. */
function onlyPin(p: ThreadPatch): boolean {
  return p.pin !== undefined && Object.entries(p).every(([k, v]) => k === 'pin' || v === undefined);
}

function taskList(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x)))].slice(0, THREAD_TASKS_MAX);
}

export function updateThread(file: ThreadsFile, id: string, patch: ThreadPatch, by: ThreadWriter, at: string): { file: ThreadsFile; thread: OrgThread } {
  checkPatch(patch);
  const cur = find(file, id);
  // Handed to the user: needs, from a state it was not in, or a closed thread reopened into it.
  const target = patch.state ?? cur.state;
  if (waitsOnUser(target) && (cur.state !== target || (patch.reopen === true && !!cur.closed && target === 'needs'))) checkHandedToUser(by, patch);
  if (patch.pin === false && cur.pinned) checkHisPin(cur, by, 'unpinned');
  if (patch.snooze?.trim() && cur.pinned) checkHisPin(cur, by, 'snoozed');
  if (patch.close && !cur.closed) checkHisPin(cur, by, 'closed');
  if (onlyPin(patch)) return pinOnly(file, cur, patch.pin!, by, at);
  const next: OrgThread = { ...cur, updatedAt: at, by };
  if (patch.title !== undefined) { next.title = clip(patch.title, THREAD_TITLE_MAX); next.titled = true; }
  if (patch.ask !== undefined) { if (patch.ask.trim()) next.ask = clip(patch.ask, THREAD_ASK_MAX); else delete next.ask; }
  if (patch.reply !== undefined) { if (patch.reply.trim()) next.reply = clip(patch.reply, THREAD_REPLY_MAX); else delete next.reply; }
  if (next.reply && next.reply !== cur.reply && by !== 'human') next.replied = { at, by };
  if (patch.state !== undefined) next.state = patch.state;
  // A new summary on a thread out of his sight is news: it shows (answered), unless the same write names a state.
  else if (HIDDEN_STATES.has(cur.state) && next.reply !== undefined && next.reply !== cur.reply) next.state = 'answered';
  // Real news takes a snooze off: the thread now waits on him (needs) or its result is in (answered).
  if (next.snoozed && next.state !== cur.state && (next.state === 'needs' || next.state === 'answered')) delete next.snoozed;
  if (patch.snooze !== undefined) {
    if (!patch.snooze.trim()) delete next.snoozed;
    else {
      if (cur.closed && !patch.reopen) throw new ThreadError('thread_closed', 409, `Thread ${id} is closed: there is nothing to snooze.`);
      next.snoozed = { until: parseSnoozeUntil(patch.snooze, at), at, by };
      // Put aside: out of his sight, so no longer pinned.
      delete next.pinned;
    }
  }
  if (patch.tasks !== undefined) { const l = taskList(patch.tasks); if (l.length) next.tasks = l; else delete next.tasks; }
  if (patch.add_tasks?.length) next.tasks = taskList([...(next.tasks ?? []), ...patch.add_tasks]);
  // Closing a closed thread again changes nothing (the node is not told twice).
  if (patch.known !== undefined) {
    const upTo = patch.known === 'all' ? cur.messages.length - 1 : cur.messages.findIndex((m) => m.id === patch.known);
    if (upTo < 0 && patch.known === 'all') throw new ThreadError('no_message', 409, `Thread ${id} holds no message of his yet: there is nothing he knows.`);
    if (upTo < 0) throw new ThreadError('no_message', 404, `No message ${patch.known} in thread ${id}.`);
    next.known = { through: cur.messages[knownThrough(file, cur, upTo, by)].id, by, at };
  }
  if (patch.close && !(cur.closed && cur.closed.how === patch.close)) {
    // A thread the node opened that he never answered may be dropped by it: he was never asked yet.
    const ownUnseen = patch.close === 'dropped' && !!cur.opener && !cur.messages.length && by === cur.opener.by;
    if (!ownUnseen) checkClose(file, cur, by);
    next.closed = { how: patch.close, at, by };
    delete next.snoozed;
    delete next.pinned;
  }
  // Reopened by him: in his sight again until he writes in it.
  if (patch.reopen) { delete next.closed; if (HIDDEN_STATES.has(next.state) && patch.state === undefined) next.state = 'answered'; }
  if (patch.pin !== undefined) applyPin(next, cur, patch.pin, by, at);
  return { file: replace(file, next, at), thread: next };
}

/** Pin (a closed thread first needs reopen) or unpin `next`; a pin of his stays his when a node pins it again. */
function applyPin(next: OrgThread, cur: OrgThread, pin: boolean, by: ThreadWriter, at: string): void {
  if (!pin) { delete next.pinned; return; }
  if (next.closed) throw new ThreadError('thread_closed', 409, `Thread ${cur.id} is closed: reopen it to pin it.`);
  if (!cur.pinned || (by === 'human' && cur.pinned.by !== 'human')) next.pinned = { at, by };
  // Pinned stays in his sight: a snooze on it is over.
  delete next.snoozed;
}

/** A pin or unpin alone: nothing else of the thread moves (its change time keeps its place in the list). */
function pinOnly(file: ThreadsFile, cur: OrgThread, pin: boolean, by: ThreadWriter, at: string): { file: ThreadsFile; thread: OrgThread } {
  const next: OrgThread = { ...cur };
  applyPin(next, cur, pin, by, at);
  if (next.pinned === cur.pinned && next.snoozed === cur.snoozed) return { file, thread: cur };
  return { file: replace(file, next, at), thread: next };
}

/**
 * Put thread `fromId` under `intoId`: its messages join the target in time order, its tasks too,
 * and it is gone. The node does this when a new message is about an open subject.
 */
export function mergeThreads(file: ThreadsFile, fromId: string, intoId: string, by: ThreadWriter, at: string): { file: ThreadsFile; thread: OrgThread } {
  if (fromId === intoId) throw new ThreadError('same_thread', 400, 'A thread cannot be merged into itself.');
  const from = find(file, fromId);
  const into = find(file, intoId);
  // A closed subject asked again is a new thread that follows it, never a reopened one.
  if (!isOpen(into)) throw new ThreadError('thread_closed', 409, `Thread ${intoId} is closed; a new ask about it stays its own thread (it follows ${intoId}).`);
  // A thread the user closed stays closed: merging it would open it again unasked.
  if (!isOpen(from)) throw new ThreadError('thread_closed', 409, `Thread ${fromId} is closed; reopen it first if it belongs under ${intoId}.`);
  // A thread the node opened keeps its first post: his ask goes under it, never the other way.
  if (from.opener) throw new ThreadError('bad_input', 409, `Thread ${fromId} was opened by you with its own first post; merge ${intoId} into it instead.`);
  // A pin goes with the messages: the thread he kept in sight is the one they are in now (his pin wins).
  const pinned = into.pinned?.by === 'human' ? into.pinned : from.pinned?.by === 'human' ? from.pinned : into.pinned ?? from.pinned;
  const messages = [...into.messages, ...from.messages].sort((a, b) => a.at.localeCompare(b.at));
  const next: OrgThread = {
    ...into, messages, updatedAt: at, by,
    ...(pinned ? { pinned } : {}),
    ...(from.tasks?.length || into.tasks?.length ? { tasks: taskList([...(into.tasks ?? []), ...(from.tasks ?? [])]) } : {}),
    ...(into.state === 'answered' || into.state === 'pending' ? { state: 'working' as ThreadState } : {}),
  };
  // Pinned stays in his sight: a snooze the target had is over.
  if (pinned) delete next.snoozed;
  return { file: { ...file, threads: file.threads.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? next : t)) }, thread: next };
}

/** Take one message out of a thread into a thread of its own (a wrong merge undone). */
export function splitThreadMessage(file: ThreadsFile, threadId: string, messageId: string, by: ThreadWriter, at: string, newId?: string, lang: LetterLang = 'en'): { file: ThreadsFile; thread: OrgThread; from: OrgThread } {
  const cur = find(file, threadId);
  const msg = cur.messages.find((m) => m.id === messageId);
  if (!msg) throw new ThreadError('no_message', 404, `No message ${messageId} in thread ${threadId}.`);
  if (cur.messages.length < 2 && !cur.opener) throw new ThreadError('last_message', 409, 'A thread keeps at least one message; this one is already its own thread.');
  const from: OrgThread = { ...cur, messages: cur.messages.filter((m) => m.id !== messageId), updatedAt: at, by };
  // The mark stays on what is left: on the message before the one taken out, or gone with it.
  if (from.known?.through === messageId) {
    const i = cur.messages.findIndex((m) => m.id === messageId);
    const prev = cur.messages.slice(0, i).reverse().find((m) => m.id !== messageId);
    if (prev) from.known = { ...from.known, through: prev.id }; else delete from.known;
  }
  // The first message names a thread Walnut titled: it follows the message that is now first.
  if (!from.titled && from.messages.length) from.title = fallbackTitle(from.messages[0].text, lang);
  const thread: OrgThread = {
    id: newId && THREAD_ID_RE.test(newId) ? newId : newThreadId(),
    title: fallbackTitle(msg.text, lang), state: 'new', messages: [msg], createdAt: msg.at, updatedAt: at, by,
  };
  return { file: { ...file, threads: [...file.threads.map((t) => (t.id === threadId ? from : t)), thread] }, thread, from };
}

export interface OpenThreadInput {
  title: string;
  text: string;
  from: ThreadSource;
  ref?: string;
  state?: ThreadState;
  tasks?: string[];
  id?: string;
  /** With state needs (the default): which of the user's kinds this is, and why (user-kind.ts). Never stored. */
  user_kind?: string;
  user_kind_why?: string;
}

/** The node opens a thread itself: its first post is what reached it (thread_create). */
export function openThread(file: ThreadsFile, input: OpenThreadInput, by: ThreadWriter, at: string): { file: ThreadsFile; thread: OrgThread } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ThreadError('bad_input', 400, 'title must be a few words.');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new ThreadError('bad_input', 400, 'text (what reached you, for him) is required.');
  if (!THREAD_SOURCES.includes(input.from)) throw new ThreadError('bad_input', 400, `from must be one of ${THREAD_SOURCES.join(', ')}.`);
  if (input.state !== undefined && !THREAD_STATES.includes(input.state)) throw new ThreadError('bad_input', 400, `state must be one of ${THREAD_STATES.join(', ')}.`);
  // A thread the node opens is for him to act on or follow: never hidden from the start.
  if (input.state !== undefined && HIDDEN_STATES.has(input.state)) throw new ThreadError('bad_input', 400, 'A thread you open is for him to see: open it as needs or answered.');
  if (waitsOnUser(input.state ?? 'needs')) checkHandedToUser(by, input);
  const tasks = taskList(input.tasks ?? []);
  const thread: OrgThread = {
    id: input.id && THREAD_ID_RE.test(input.id) ? input.id : newThreadId(),
    title: clip(input.title, THREAD_TITLE_MAX), titled: true, state: input.state ?? 'needs', messages: [],
    opener: { text: clip(input.text, THREAD_ANSWER_MAX), at, from: input.from, by, ...(input.ref?.trim() ? { ref: clip(input.ref, THREAD_TITLE_MAX) } : {}) },
    createdAt: at, updatedAt: at, by, ...(tasks.length ? { tasks } : {}),
  };
  return { file: { ...file, threads: prune([...file.threads, thread], at) }, thread };
}

/**
 * Walnut read these answers from the node's chat (thread-answers.ts): each lands on its message, by
 * id, wherever the message is now (a merge or split moved it). An answer already kept stays.
 */
export function setAnswers(file: ThreadsFile, answers: ReadonlyMap<string, ThreadAnswer>): { file: ThreadsFile; changed: string[] } {
  if (!answers.size) return { file, changed: [] };
  const changed: string[] = [];
  const threads = file.threads.map((t) => {
    let hit = false;
    const messages = t.messages.map((m) => {
      const a = answers.get(m.id);
      // A letter note's answer from its letter replaces one an older Walnut took from the chat.
      if (!a || (m.answer && !(a.from === 'letter' && letterAnswerMissing(m)))) return m;
      hit = true;
      const clipped = a.text.length > THREAD_ANSWER_MAX;
      return { ...m, answer: { ...a, text: clipped ? `${a.text.slice(0, THREAD_ANSWER_MAX - 1)}…` : a.text, ...(clipped ? { clipped: true } : {}) } };
    });
    if (!hit) return t;
    changed.push(t.id);
    return { ...t, messages };
  });
  return changed.length ? { file: { ...file, threads }, changed } : { file, changed };
}

/** The node was told these closes (the threads hint). */
export function markClosesTold(file: ThreadsFile, ids: readonly string[]): ThreadsFile {
  if (!ids.length) return file;
  const set = new Set(ids);
  return { ...file, threads: file.threads.map((t) => (t.closed && set.has(t.id) ? { ...t, closed: { ...t.closed, told: true } } : t)) };
}
