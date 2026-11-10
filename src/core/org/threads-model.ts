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
 * His view shows a thread only when it has something for him (thread-view.ts shownToHim): needs or
 * answered. His message in a thread makes it working, so it leaves his view at once (2026-11-01, the
 * user: "if i reply to a thread, it shoud go out of the thread immediately instead of just show
 * working"), and it stays out with the node's chat answer on it until the node gives it a state
 * (2026-11-07); `pending` stays hidden (a handoff the node judged no news: "if it is just assigned no
 * need to tell me ... thread pending, which is auto hide like closed"). A new summary written without
 * a state is news: answered. A summary replaces the node's earlier answers on the card (`replyAt`,
 * thread-view.ts supersededBySummary). A thread left new or working, or in needs with nothing new,
 * too long wakes the node once (`recheck`, thread-recheck.ts), then shows to him saying so.
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
import { sameDecisionWords } from '../ask-decision.js';
import crypto from 'node:crypto';

export const THREAD_STATES = ['new', 'working', 'needs', 'answered', 'pending'] as const;
export type ThreadState = typeof THREAD_STATES[number];
/** The states his view keeps out of sight (unless pinned, or overdue with something for him: thread-view.ts shownToHim). */
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
  /**
   * The session whose words these are: the transcript they were read from, or the letter turn's
   * recorded writer. Absent = not recorded (an answer kept before 2026-11-07, or a letter turn with
   * no writer on it): a path in it opens nowhere until the user picks a machine.
   */
  sid?: string;
  /** That session's host as Walnut read it then ('__local__' = the primary). */
  host?: string;
}

/**
 * Who wrote a piece of a thread (its summary, its first post), as Walnut verified it: the caller's
 * own session record behind `x-walnut-caller-sid`, never a sid or host from a request body
 * (2026-11-07: a summary's path opened on the node's current machine, not the writer's).
 */
export interface ThreadTextSource {
  sid: string;
  /** '__local__' = the primary. */
  host?: string;
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
  /** The writing session, when Walnut verified it (ThreadTextSource); absent for the user and for an unknown writer. */
  sid?: string;
  host?: string;
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

/** A thread went from one node to another with its work (thread-follow.ts): the other node, and why. */
export interface ThreadMove {
  /** The other node's task id. */
  task: string;
  /** Its name as the Org page shows it. */
  title: string;
  at: string;
  by: ThreadWriter;
  /** One line: why it moved (its work is now in that team, or the node handed it on). */
  why?: string;
  /** `work`: Walnut's rule moved it after its tasks; `hand`: a node or the user handed it on (thread-follow.ts). */
  kind?: ThreadMoveKind;
  /**
   * A `hand` move only: the nodes its tasks did their work in when it was handed on (ownerKey in
   * thread-follow.ts). While they still do, the work has not moved since and the follow rule leaves
   * the thread where it was handed, however many hands it went through.
   */
  owners?: string;
}

export type ThreadMoveKind = 'work' | 'hand';

/**
 * Closed here because it moved to another node (thread-follow.ts). Stored as a `dropped` close plus
 * `movedTo`, never a close kind of its own: a release that knows only acked and dropped reads it
 * closed, so going back to it never reopens a thread that lives elsewhere now.
 */
export function movedAway(t: Pick<OrgThread, 'closed' | 'movedTo'>): boolean {
  return !!t.closed && !!t.movedTo;
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
  /** When the node last wrote `reply` (thread-view.ts supersededBySummary: an older answer leaves the card). */
  replyAt?: string;
  /**
   * Who wrote `reply`, set only by a write that changed it (a pin, a close or a state move keeps
   * it): `reply_by` the writer, `reply_sid`/`reply_host` its verified session (ThreadTextSource).
   * None of them on a summary written before 2026-11-07: its writer is unknown, never guessed.
   */
  reply_by?: ThreadWriter;
  reply_sid?: string;
  reply_host?: string;
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
  /** When its last move into needs buzzed his phone (push/thread-push.ts): one buzz per absence. */
  needsBuzzedAt?: string;
  /** Walnut woke the node about the overdue stretch that began at `since` (thread-recheck.ts): once per stretch. */
  recheck?: ThreadRecheck;
  /** Closed here as `moved`: the node it went to (the open copy lives there now). */
  movedTo?: ThreadMove;
  /** It came from this node with its work: his messages and that node's answers came with it. */
  movedFrom?: ThreadMove;
}

export interface ThreadRecheck {
  since: string;
  at: string;
  why: 'reply' | 'needs';
  /** Recorded before the send and not confirmed after it: not delivered (yet). */
  pending?: boolean;
}

export interface ThreadsFile {
  version: 1;
  taskId: string;
  threads: OrgThread[];
}

export type ThreadErrorCode = 'no_thread' | 'no_message' | 'bad_input' | 'thread_closed' | 'last_message' | 'same_thread' | 'not_reacted' | 'user_kind' | 'pinned_by_user' | 'same_ask' | 'same_node';

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

const SOURCE_MAX = 128;
/** A recorded session id or host as kept: a short non-empty string, else nothing. */
const sourceStr = (v: unknown): string | undefined => (isStr(v) && v.trim() && v.length <= SOURCE_MAX ? v.trim() : undefined);

/** A source handed in by Walnut's own code (the route's verified caller, a transcript read), checked the same way. */
export function verifiedSource(s: ThreadTextSource | undefined | null): ThreadTextSource | undefined {
  const sid = sourceStr(s?.sid);
  if (!sid) return undefined;
  const host = sourceStr(s?.host);
  return { sid, ...(host ? { host } : {}) };
}

/** `x` with `sid`/`host` kept only as short strings (a host only with its session), none at all for the user's own words. */
function withSource<T extends { sid?: string; host?: string }>(x: T, human: boolean): T {
  const { sid, host, ...rest } = x;
  const s = human ? undefined : verifiedSource({ sid: sid ?? '', host });
  return { ...rest, ...(s ? { sid: s.sid, ...(s.host ? { host: s.host } : {}) } : {}) } as unknown as T;
}

/**
 * The summary's writer as read from disk: kept only with a summary and a writer named. A summary
 * from before the writer was recorded keeps none, so it reads as unknown, never as the node's
 * current session.
 */
function normalizeReplySource(t: OrgThread): void {
  const { reply_by: by, reply_sid: sid, reply_host: host } = t;
  delete t.reply_by;
  delete t.reply_sid;
  delete t.reply_host;
  if (!t.reply || !isStr(by) || !by) return;
  t.reply_by = by;
  const s = by === 'human' ? undefined : verifiedSource({ sid: sid ?? '', host });
  if (s) { t.reply_sid = s.sid; if (s.host) t.reply_host = s.host; }
}

/** The summary written: its writer goes with it. Called only when the words change. */
function setReply(next: OrgThread, text: string | undefined, by: ThreadWriter, source: ThreadTextSource | undefined): void {
  delete next.reply_by;
  delete next.reply_sid;
  delete next.reply_host;
  if (!text) { delete next.reply; return; }
  next.reply = text;
  next.reply_by = by;
  const s = by === 'human' ? undefined : verifiedSource(source);
  if (s) { next.reply_sid = s.sid; if (s.host) next.reply_host = s.host; }
}

function normalizeMessage(m: unknown): ThreadMessage | null {
  if (!m || typeof m !== 'object') return null;
  const x = m as Partial<ThreadMessage>;
  if (!isStr(x.id) || !isStr(x.at) || !isStr(x.text)) return null;
  const next = { ...x, via: isStr(x.via) ? x.via : 'chat', ...(Array.isArray(x.images) ? { images: x.images.filter(isStr) } : {}) } as ThreadMessage;
  if (next.answer && !(typeof next.answer === 'object' && isStr(next.answer.text) && isStr(next.answer.at))) delete next.answer;
  else if (next.answer) next.answer = withSource(next.answer, false);
  return next;
}

/** One thread read from disk: what every reader relies on is there, or the thread is left out. */
function normalizeThread(t: unknown): OrgThread | null {
  if (!t || typeof t !== 'object') return null;
  const x = t as Partial<OrgThread>;
  if (!isStr(x.id) || !Array.isArray(x.messages)) return null;
  const messages = x.messages.map(normalizeMessage).filter((m): m is ThreadMessage => !!m);
  const o = x.opener;
  const opener = o && typeof o === 'object' && isStr(o.text) && isStr(o.at)
    ? withSource({ ...o, from: THREAD_SOURCES.includes(o.from) ? o.from : 'node' } as ThreadOpener, o.by === 'human')
    : undefined;
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
  normalizeReplySource(next);
  if (next.snoozed && !(typeof next.snoozed === 'object' && isStr(next.snoozed.until) && isStr(next.snoozed.at) && Number.isFinite(Date.parse(next.snoozed.until)))) delete next.snoozed;
  if (next.replyAt !== undefined && !(isStr(next.replyAt) && next.reply)) delete next.replyAt;
  if (next.recheck && !(typeof next.recheck === 'object' && isStr(next.recheck.since) && isStr(next.recheck.at))) delete next.recheck;
  if (next.pinned && !(typeof next.pinned === 'object' && isStr(next.pinned.at))) delete next.pinned;
  else if (next.pinned && !isStr(next.pinned.by)) next.pinned = { ...next.pinned, by: 'human' };
  // A closed thread holds no pin (a hand edit, or a file from a build that kept one).
  if (next.closed) delete next.pinned;
  if (next.known && !(typeof next.known === 'object' && isStr(next.known.through) && messages.some((m) => m.id === next.known!.through))) delete next.known;
  if (!validMove(next.movedTo)) delete next.movedTo;
  if (!validMove(next.movedFrom)) delete next.movedFrom;
  return next;
}

function validMove(m: unknown): m is ThreadMove {
  const x = m as Partial<ThreadMove> | undefined;
  return !!x && typeof x === 'object' && isStr(x.task) && isStr(x.title) && isStr(x.at);
}

/** A file read from disk, made safe to work on (an old or hand-edited one included). */
/**
 * A summary written before `replyAt` existed gets the best time Walnut can still tell, once, at the
 * first write after (threads-store.ts mutateThreads, before the write itself): the node's last
 * change when it made the last one, else the node's latest words before his last message, else the
 * thread's start. Never later than the truth can be once he wrote after it, so a state-only write of
 * the node afterwards never makes an old summary read current (review 2026-11-08: "Is it you?" stayed
 * on the card after he answered, once the node set a state). Pure; the same file when none lacks it.
 */
export function stampLegacyReplyAt(file: ThreadsFile): ThreadsFile {
  let changed = false;
  const threads = file.threads.map((t) => {
    if (t.replyAt || !t.reply?.trim()) return t;
    changed = true;
    return { ...t, replyAt: legacySummaryAt(t) };
  });
  return changed ? { ...file, threads } : file;
}

function legacySummaryAt(t: OrgThread): string {
  if (t.by && t.by !== 'human' && t.updatedAt) return t.updatedAt;
  const lastHis = t.messages.reduce((a, m) => (m.at > a ? m.at : a), '');
  const said = [t.opener?.at, ...t.messages.map((m) => m.answer?.at)]
    .filter((at): at is string => !!at && (!lastHis || at < lastHis));
  return said.reduce((a, at) => (at > a ? at : a), '') || t.createdAt;
}

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
  /**
   * Put it under this thread (the Follow up button). A thread he closed himself minutes ago opens
   * again with it (`FOLLOW_UP_REOPENS_MS`); one closed longer ago opens a new thread that follows it.
   */
  threadId?: string;
  /**
   * A chat message with no thread named joins the open thread his last message went to when that
   * came at most this many ms before (the send path sets `SAME_CONVERSATION_MS`; thread-capture.ts).
   */
  joinRecent?: number;
  /** A Follow up reopens a thread he closed at most this many ms before (default `FOLLOW_UP_REOPENS_MS`). */
  reopenWithin?: number;
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
  /**
   * Why it went to a thread it did not name: `reopened`, a Follow up on a thread he had closed
   * minutes ago; `recent`, a chat message right after his last one, which went to that thread.
   */
  joined?: 'reopened' | 'recent';
}

/**
 * A Follow up this soon after he closed the thread himself is a word on it, not a new ask: the
 * thread opens again (2026-11-10, the user, after acknowledging a thread and following up on it:
 * "I send but u don't know which thread").
 */
export const FOLLOW_UP_REOPENS_MS = 10 * 60_000;
/**
 * A chat message this soon after his last one stays in that conversation: it joins the thread the
 * last one went to, never one thread per sentence (2026-11-10: "look", "this is crazy", "OMG" each
 * opened a thread of its own). The node splits it out when it is another subject.
 */
export const SAME_CONVERSATION_MS = 3 * 60_000;

/** The open thread his latest message went to, when it came at most `SAME_CONVERSATION_MS` before `at`. */
export function recentConversation(file: ThreadsFile, at: string, within = SAME_CONVERSATION_MS): OrgThread | undefined {
  const now = Date.parse(at);
  let best: { t: OrgThread; ms: number } | undefined;
  for (const t of file.threads) {
    for (const m of t.messages) {
      const ms = Date.parse(m.at);
      if (Number.isFinite(ms) && (!best || ms > best.ms)) best = { t, ms };
    }
  }
  if (!best || !Number.isFinite(now) || now - best.ms > within || now < best.ms - 60_000) return undefined;
  return isOpen(best.t) ? best.t : undefined;
}

/** He closed it himself (not moved, not the node's close) at most `FOLLOW_UP_REOPENS_MS` before `at`. */
function closedByHimJustNow(t: OrgThread, at: string, within: number): boolean {
  if (!t.closed || t.movedTo || t.closed.by !== 'human') return false;
  const gap = Date.parse(at) - Date.parse(t.closed.at);
  return Number.isFinite(gap) && gap <= within;
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
  const named = input.threadId ? file.threads.find((t) => t.id === input.threadId) : undefined;
  const reopened = !!named && closedByHimJustNow(named, input.at, input.reopenWithin ?? FOLLOW_UP_REOPENS_MS);
  const recent = !input.threadId && input.joinRecent && input.via === 'chat' ? recentConversation(file, input.at, input.joinRecent) : undefined;
  const target = named ?? recent;
  if (target && (isOpen(target) || reopened)) {
    // His own message in a snoozed thread brings it back; one he closed minutes ago opens again.
    const { snoozed: _s, closed: _c, ...rest } = target;
    const next: OrgThread = {
      ...rest, messages: [...target.messages, message], updatedAt: input.at, by: 'human',
      // He spoke again: a thread answered, waiting on him or pending is the node's turn again.
      ...(reopened || target.state === 'answered' || target.state === 'needs' || target.state === 'pending' ? { state: 'working' as ThreadState } : {}),
    };
    const joined = reopened ? 'reopened' as const : recent ? 'recent' as const : undefined;
    return { file: replace(file, next, input.at), thread: next, message, created: false, duplicate: false, ...(joined ? { joined } : {}) };
  }
  const thread: OrgThread = {
    id: input.newThreadId && THREAD_ID_RE.test(input.newThreadId) ? input.newThreadId : newThreadId(),
    title: fallbackTitle(text, input.lang),
    state: 'new', messages: [message], createdAt: input.at, updatedAt: input.at, by: 'human',
    ...(named ? { follows: named.id } : {}),
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
  /** With state needs from an agent: why it asks what a task in the node's team already asks (same-ask.ts). Never stored. */
  same_ask_reason?: string;
  /** With close from a node: his own words asking for it (closeAskOf). Never stored. */
  user_words?: string;
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
 * or answered and he has not reacted to, is not, unless the node quotes his own words asking for
 * the close (`user_words`, closeAskOf). His own Acknowledge needs no check.
 */
function checkClose(file: ThreadsFile, t: OrgThread, by: ThreadWriter, words?: string): void {
  if (by === 'human') return;
  if (closeAskOf(t, words)) return;
  const lastIdx = t.messages.length - 1;
  const last = t.messages[lastIdx];
  if (!last) {
    // Only the node's own post: closed once he wrote to it after it (anywhere, the node's judgment).
    if (t.opener && reactedSince(file, t.opener.at)) return;
    throw notReacted('closed', t.opener?.at ?? '', words);
  }
  if (last.answer && reactedSince(file, last.answer.at)) return;
  // His last message is a plain reaction to what the node said before it.
  const before = nodeWordAt(t, lastIdx - 1);
  if (before && last.at > before && isAcknowledgement(last.text)) return;
  throw notReacted('closed', last.answer?.at ?? nodeWordAt(t, lastIdx), words);
}

/** Words compared as he wrote them, case and spacing aside. */
const wordsKey = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
/** The shortest quote that names a message of his, unless it is the whole message: a word or two is no quote. */
const USER_WORDS_MIN = 6;
const quotes = (text: string, quote: string): boolean => {
  const said = wordsKey(text);
  return said.includes(quote) && (quote.length >= USER_WORDS_MIN || quote === said);
};

/**
 * He asked the node in his own words to close the thread, or said it is done or no longer wanted
 * (2026-11-07: a VP was refused closing a thread on the user's 72-character "... close this
 * thread", which the 40-character acknowledgement test did not read as one). The node quotes them
 * (`user_words`); they count when they are in a message of his in this thread (one filed elsewhere
 * is merged in first, so his words about one subject never close another) written after every
 * word the node said in it, except its own reply to that message, and after his every other
 * message in it. Silence still is not knowing: an answer the node gave after those words (to an
 * earlier question of his) keeps the thread open, and no known mark rides on them.
 */
export function closeAskOf(t: OrgThread, words: string | undefined): ThreadMessage | null {
  const quote = wordsKey(words ?? '');
  if (!quote) return null;
  return t.messages.find((m) => quotes(m.text, quote) && afterAllSaid(t, m)) ?? null;
}

/** `m` came after everything said in `t` but the node's own reply to it. */
function afterAllSaid(t: OrgThread, m: ThreadMessage): boolean {
  if (t.opener && t.opener.at >= m.at) return false;
  return t.messages.every((x) => x.id === m.id || (x.at <= m.at && !(x.answer && x.answer.at > m.at)));
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

function notReacted(what: string, at: string, words?: string): ThreadError {
  return new ThreadError('not_reacted', 409,
    `Not ${what}: ${at ? `the user has not written to you since your last word in it (${at})` : 'there is no answer of yours in it he could have reacted to yet'}. `
    + 'An answer he has not reacted to is not known: the thread stays open (answered, your answer in full) until he replies, says ok or '
    + 'thanks, follows up, or acknowledges it. '
    + (words?.trim()
      ? 'The user_words you quoted are not in a message of his in this thread written after everything said in it: quote his words exactly, from his latest message (merge it into this thread first when it was filed elsewhere).'
      : 'If he asked you in his own words to close it, or said it is done or no longer wanted, close it with user_words quoting them.'));
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

/** Whether this patch hands the thread to the user: needs, from a state it was not in, or a closed thread reopened into it. */
export function patchHandsToUser(cur: Pick<OrgThread, 'state' | 'closed'>, patch: Pick<ThreadPatch, 'state' | 'reopen'>): boolean {
  const target = patch.state ?? cur.state;
  return waitsOnUser(target) && (cur.state !== target || (patch.reopen === true && !!cur.closed && target === 'needs'));
}

/**
 * `source`: the writer's own session as Walnut verified it (ThreadTextSource); absent for the user
 * and for a caller Walnut could not place, whose summary then reads as written by an unknown session.
 */
export function updateThread(file: ThreadsFile, id: string, patch: ThreadPatch, by: ThreadWriter, at: string, source?: ThreadTextSource): { file: ThreadsFile; thread: OrgThread } {
  checkPatch(patch);
  const cur = find(file, id);
  // A thread that moved lives on at the other node: it is changed there, never opened again here.
  if (movedAway(cur) && (patch.reopen || patch.pin)) {
    throw new ThreadError('thread_closed', 409, `Thread ${id} moved to ${cur.movedTo!.title} (${cur.movedTo!.task}) with its work: it is open there.`);
  }
  // Handed to the user: needs, from a state it was not in, or a closed thread reopened into it.
  if (patchHandsToUser(cur, patch)) checkHandedToUser(by, patch);
  if (patch.pin === false && cur.pinned) checkHisPin(cur, by, 'unpinned');
  if (patch.snooze?.trim() && cur.pinned) checkHisPin(cur, by, 'snoozed');
  if (patch.close && !cur.closed) checkHisPin(cur, by, 'closed');
  if (onlyPin(patch)) return pinOnly(file, cur, patch.pin!, by, at);
  const next: OrgThread = { ...cur, updatedAt: at, by };
  if (patch.title !== undefined) { next.title = clip(patch.title, THREAD_TITLE_MAX); next.titled = true; }
  if (patch.ask !== undefined) { if (patch.ask.trim()) next.ask = clip(patch.ask, THREAD_ASK_MAX); else delete next.ask; }
  // The summary's writer moves only with its words: the same words sent again (a state move that
  // repeats the reply) keep the writer they had, so a path in them still opens where it was written.
  // `replyAt` is when the node last wrote it, so it moves with every non-empty write.
  if (patch.reply !== undefined) {
    const text = patch.reply.trim() ? clip(patch.reply, THREAD_REPLY_MAX) : undefined;
    if (text !== cur.reply) setReply(next, text, by, source);
    if (text) next.replyAt = at; else delete next.replyAt;
  }
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
    if (!ownUnseen) checkClose(file, cur, by, patch.user_words);
    next.closed = { how: patch.close, at, by };
    delete next.snoozed;
    delete next.pinned;
  }
  // Reopened by him: in his sight again until he writes in it.
  if (patch.reopen) { delete next.closed; if (HIDDEN_STATES.has(next.state) && patch.state === undefined) next.state = 'answered'; }
  if (patch.pin !== undefined) applyPin(next, cur, patch.pin, by, at);
  // Only its ask in other words: the thread is the decision, so nothing moved (no news, no new
  // change time, no overdue clock reset; 2026-11-09, ask-decision.ts).
  if (onlyAskReworded(cur, next)) { next.updatedAt = cur.updatedAt; next.by = cur.by; }
  return { file: replace(file, next, at), thread: next };
}

/** Whether `next` differs from `cur` only in its ask, said in other words (and who wrote last). Pure. */
export function onlyAskReworded(cur: OrgThread, next: OrgThread): boolean {
  // Its words only: another target, number, "not" or direction is news (ask-decision.ts).
  if (cur.ask === next.ask || !cur.ask || !next.ask || !sameDecisionWords(cur.ask, next.ask)) return false;
  const skip = new Set(['ask', 'updatedAt', 'by']);
  const keys = new Set([...Object.keys(cur), ...Object.keys(next)].filter((k) => !skip.has(k)));
  const a = cur as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  return [...keys].every((k) => a[k] === b[k] || JSON.stringify(a[k]) === JSON.stringify(b[k]));
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
  // The phone buzz either one gave this absence stays with the merged thread (push/thread-push.ts).
  const needsBuzzedAt = [into.needsBuzzedAt, from.needsBuzzedAt].filter((x): x is string => !!x).sort().pop();
  const next: OrgThread = {
    ...into, messages, updatedAt: at, by,
    ...(pinned ? { pinned } : {}),
    ...(needsBuzzedAt ? { needsBuzzedAt } : {}),
    ...(from.tasks?.length || into.tasks?.length ? { tasks: taskList([...(into.tasks ?? []), ...(from.tasks ?? [])]) } : {}),
    ...(into.state === 'answered' || into.state === 'pending' ? { state: 'working' as ThreadState } : {}),
  };
  // Pinned stays in his sight: a snooze the target had is over.
  if (pinned) delete next.snoozed;
  return { file: { ...file, threads: file.threads.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? next : t)) }, thread: next };
}

export interface MoveEnd { task: string; title: string }

/**
 * The thread leaves this node for `to` (thread-follow.ts): it is closed here (movedAway), pointing at
 * the node it went to, and the node is counted as told (the move tells it itself). Returns the thread
 * as it was the moment it left, the copy the other node gets. Refuses a closed thread.
 */
export function moveThreadOut(file: ThreadsFile, id: string, to: MoveEnd, by: ThreadWriter, at: string, why?: string, kind: ThreadMoveKind = 'work'): { file: ThreadsFile; thread: OrgThread } {
  const cur = find(file, id);
  if (cur.closed) {
    throw new ThreadError('thread_closed', 409, cur.movedTo
      ? `Thread ${id} already moved to ${cur.movedTo.title} (${cur.movedTo.task}).`
      : `Thread ${id} is closed: only an open thread moves with its work.`);
  }
  const { pinned: _p, snoozed: _s, recheck: _r, ...rest } = cur;
  const gone: OrgThread = {
    ...rest, updatedAt: at, by,
    closed: { how: 'dropped', at, by, told: true },
    movedTo: { task: to.task, title: to.title, at, by, kind, ...(why ? { why: clip(why, THREAD_ASK_MAX) } : {}) },
  };
  return { file: replace(file, gone, at), thread: cur };
}

/**
 * The thread arrives from `from` with everything on it (his messages, the answers, its state, pin and
 * links), saying where it came from. A copy already here (a move retried after a crash, or run
 * again) keeps everything written here, a close he made of it included, and gains what the source
 * has that it lacks (mergeMovedCopy), so a move is safe to run again; only the tombstone of an
 * earlier move away is replaced (the thread came back). `prior` is what was here before, for an undo.
 */
export function moveThreadIn(file: ThreadsFile, thread: OrgThread, from: MoveEnd, by: ThreadWriter, at: string, why?: string, kind: ThreadMoveKind = 'work', owners?: string): { file: ThreadsFile; thread: OrgThread; prior?: OrgThread } {
  const { closed: _c, movedTo: _t, recheck: _r, ...rest } = thread;
  const movedFrom: ThreadMove = {
    task: from.task, title: from.title, at, by, kind,
    ...(why ? { why: clip(why, THREAD_ASK_MAX) } : {}), ...(kind === 'hand' && owners !== undefined ? { owners } : {}),
  };
  const prior = file.threads.find((t) => t.id === thread.id);
  let next: OrgThread;
  if (prior && !movedAway(prior)) {
    // A copy already here (a move retried after a crash): it keeps everything written here, his
    // close of it included, and gains what the source has that it lacks.
    const merged = mergeMovedCopy(prior, rest);
    next = { ...merged, movedFrom, ...(prior.closed ? { state: prior.state } : {}) };
  } else next = { ...rest, updatedAt: at, movedFrom };
  const others = file.threads.filter((t) => t.id !== thread.id);
  return { file: { ...file, threads: prune([...others, next], at) }, thread: next, ...(prior ? { prior } : {}) };
}

/** The copy here, plus the source's messages and tasks it lacks (an answer the copy lacks too). */
function mergeMovedCopy(copy: OrgThread, src: Pick<OrgThread, 'messages' | 'tasks' | 'updatedAt'>): OrgThread {
  const mine = new Map(copy.messages.map((m) => [m.id, m] as const));
  const messages = [...copy.messages.map((m) => {
    const theirs = src.messages.find((x) => x.id === m.id);
    return !m.answer && theirs?.answer ? { ...m, answer: theirs.answer } : m;
  }), ...src.messages.filter((m) => !mine.has(m.id))].sort((a, b) => a.at.localeCompare(b.at));
  const added = messages.length > copy.messages.length;
  const tasks = [...new Set([...(copy.tasks ?? []), ...(src.tasks ?? [])])];
  return {
    ...copy, messages, ...(tasks.length ? { tasks } : {}),
    updatedAt: src.updatedAt > copy.updatedAt ? src.updatedAt : copy.updatedAt,
    // He spoke again in the source: an open thread waiting on him or answered is the node's turn again.
    ...(added && (copy.state === 'answered' || copy.state === 'needs' || copy.state === 'pending') ? { state: 'working' as ThreadState } : {}),
  };
}

/**
 * What he wrote into the source while the copy was on its way (thread-follow.ts): his messages the
 * copy here lacks join it in time order. Everything written here meanwhile (his follow-up, the new
 * node's summary, a close) stays. A copy no longer here (he closed it here, it moved on) is left alone.
 */
export function addMovedMessages(file: ThreadsFile, left: OrgThread, at: string): ThreadsFile {
  const cur = file.threads.find((t) => t.id === left.id);
  if (!cur) return file;
  const merged = mergeMovedCopy(cur, { messages: left.messages, tasks: cur.tasks, updatedAt: cur.updatedAt });
  if (merged.messages.length === cur.messages.length) return file;
  const next: OrgThread = { ...merged, updatedAt: at > cur.updatedAt ? at : cur.updatedAt };
  // A copy he closed here stays closed with his words kept.
  if (cur.closed) next.state = cur.state;
  return { ...file, threads: file.threads.map((t) => (t.id === left.id ? next : t)) };
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
  /** With state needs: why it asks what a task in the node's team already asks (same-ask.ts). Never stored. */
  same_ask_reason?: string;
}

/** The node opens a thread itself: its first post is what reached it (thread_create). */
export function openThread(file: ThreadsFile, input: OpenThreadInput, by: ThreadWriter, at: string, source?: ThreadTextSource): { file: ThreadsFile; thread: OrgThread } {
  if (typeof input.title !== 'string' || !input.title.trim()) throw new ThreadError('bad_input', 400, 'title must be a few words.');
  if (typeof input.text !== 'string' || !input.text.trim()) throw new ThreadError('bad_input', 400, 'text (what reached you, for him) is required.');
  if (!THREAD_SOURCES.includes(input.from)) throw new ThreadError('bad_input', 400, `from must be one of ${THREAD_SOURCES.join(', ')}.`);
  if (input.state !== undefined && !THREAD_STATES.includes(input.state)) throw new ThreadError('bad_input', 400, `state must be one of ${THREAD_STATES.join(', ')}.`);
  // A thread the node opens is for him to act on or follow: never hidden from the start.
  if (input.state !== undefined && HIDDEN_STATES.has(input.state)) throw new ThreadError('bad_input', 400, 'A thread you open is for him to see: open it as needs or answered.');
  if (waitsOnUser(input.state ?? 'needs')) checkHandedToUser(by, input);
  const tasks = taskList(input.tasks ?? []);
  // The first post's writer: its verified session (never one the input names), none for the user.
  const s = by === 'human' ? undefined : verifiedSource(source);
  const thread: OrgThread = {
    id: input.id && THREAD_ID_RE.test(input.id) ? input.id : newThreadId(),
    title: clip(input.title, THREAD_TITLE_MAX), titled: true, state: input.state ?? 'needs', messages: [],
    opener: {
      text: clip(input.text, THREAD_ANSWER_MAX), at, from: input.from, by,
      ...(input.ref?.trim() ? { ref: clip(input.ref, THREAD_TITLE_MAX) } : {}),
      ...(s ? { sid: s.sid, ...(s.host ? { host: s.host } : {}) } : {}),
    },
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
      // Its session is the one Walnut read it from (ThreadAnswer.sid), or none: never the message's own `sid`.
      return { ...m, answer: { ...withSource(a, false), text: clipped ? `${a.text.slice(0, THREAD_ANSWER_MAX - 1)}…` : a.text, ...(clipped ? { clipped: true } : {}) } };
    });
    if (!hit) return t;
    changed.push(t.id);
    return { ...t, messages };
  });
  return changed.length ? { file: { ...file, threads }, changed } : { file, changed };
}

/** Walnut woke the node about these threads' overdue stretches (thread-recheck.ts). Moves no clock. */
export function markRechecked(file: ThreadsFile, marks: ReadonlyMap<string, ThreadRecheck>): ThreadsFile {
  if (!marks.size) return file;
  return { ...file, threads: file.threads.map((t) => { const r = marks.get(t.id); return r ? { ...t, recheck: r } : t; }) };
}

/** The node was told these closes (the threads hint). */
export function markClosesTold(file: ThreadsFile, ids: readonly string[]): ThreadsFile {
  if (!ids.length) return file;
  const set = new Set(ids);
  return { ...file, threads: file.threads.map((t) => (t.closed && set.has(t.id) ? { ...t, closed: { ...t.closed, told: true } } : t)) };
}

/**
 * The threads a write moved into needs (a node handed it to the user): needs now, by a node, and
 * before it was not needs, was closed, or did not exist. His own write never counts (2026-11-04,
 * Walnut VP: a thread that waits on him buzzes his phone, once per entry; push/thread-push.ts).
 */
export function enteredNeeds(before: ThreadsFile, after: ThreadsFile): OrgThread[] {
  const was = new Map(before.threads.map((t) => [t.id, t]));
  return after.threads.filter((t) => {
    if (t.closed || t.state !== 'needs' || !t.by || t.by === 'human') return false;
    const prev = was.get(t.id);
    // A thread that moved in with its work is no new entry: its buzz, if any, came with it.
    if (t.movedFrom && (!prev || !!prev.movedTo) && t.updatedAt === t.movedFrom.at) return false;
    return !prev || !!prev.closed || prev.state !== 'needs';
  });
}
