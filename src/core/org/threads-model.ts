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
 * Pure: every function takes the file and returns the next one, or throws ThreadError. The
 * store (threads-store.ts) runs them under the file lock.
 */
import crypto from 'node:crypto';

export const THREAD_STATES = ['new', 'working', 'needs', 'answered'] as const;
export type ThreadState = typeof THREAD_STATES[number];
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
/** Closed threads kept, newest first; open threads are never dropped. */
export const CLOSED_KEPT = 200;

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
  /** The send's own id (the phone's qm- id): the same send again is the same message. */
  key?: string;
}

export interface ThreadClosed {
  how: ThreadCloseHow;
  at: string;
  by: ThreadWriter;
  /** The node was told it closed (the threads hint), so it is not told again. */
  told?: boolean;
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
}

export interface ThreadsFile {
  version: 1;
  taskId: string;
  threads: OrgThread[];
}

export type ThreadErrorCode = 'no_thread' | 'no_message' | 'bad_input' | 'thread_closed' | 'last_message' | 'same_thread';

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

/** Walnut's stand-in title: the first line with words in it, cut to a readable length. */
export function fallbackTitle(text: string): string {
  const line = text.split('\n').map((l) => l.replace(/^[>#*\-\s]+/, '').trim()).find(Boolean) ?? '';
  return clip(line || 'A picture', 80);
}

const isStr = (v: unknown): v is string => typeof v === 'string';

function normalizeMessage(m: unknown): ThreadMessage | null {
  if (!m || typeof m !== 'object') return null;
  const x = m as Partial<ThreadMessage>;
  if (!isStr(x.id) || !isStr(x.at) || !isStr(x.text)) return null;
  return { ...x, via: isStr(x.via) ? x.via : 'chat', ...(Array.isArray(x.images) ? { images: x.images.filter(isStr) } : {}) } as ThreadMessage;
}

/** One thread read from disk: what every reader relies on is there, or the thread is left out. */
function normalizeThread(t: unknown): OrgThread | null {
  if (!t || typeof t !== 'object') return null;
  const x = t as Partial<OrgThread>;
  if (!isStr(x.id) || !Array.isArray(x.messages)) return null;
  const messages = x.messages.map(normalizeMessage).filter((m): m is ThreadMessage => !!m);
  if (!messages.length) return null;
  const updatedAt = isStr(x.updatedAt) ? x.updatedAt : messages[messages.length - 1].at;
  const next: OrgThread = {
    ...x, id: x.id, messages, updatedAt, createdAt: isStr(x.createdAt) ? x.createdAt : messages[0].at,
    title: isStr(x.title) && x.title.trim() ? x.title : fallbackTitle(messages[0].text),
    state: THREAD_STATES.includes(x.state as ThreadState) ? x.state as ThreadState : 'new',
  };
  if (x.closed) {
    if (typeof x.closed === 'object' && THREAD_CLOSE_HOWS.includes(x.closed.how)) {
      next.closed = { ...x.closed, at: isStr(x.closed.at) ? x.closed.at : updatedAt, by: isStr(x.closed.by) ? x.closed.by : 'human' };
    } else delete next.closed;
  }
  return next;
}

/** A file read from disk, made safe to work on (an old or hand-edited one included). */
export function normalizeThreads(raw: unknown, taskId: string): ThreadsFile {
  const f = raw && typeof raw === 'object' ? raw as Partial<ThreadsFile> : {};
  const threads = Array.isArray(f.threads) ? f.threads.map(normalizeThread).filter((t): t is OrgThread => !!t) : [];
  return { version: 1, taskId, threads };
}

export function isOpen(t: OrgThread): boolean { return !t.closed; }

/** Open threads first (newest change first), then closed ones (newest close first). */
export function sortedThreads(threads: readonly OrgThread[]): OrgThread[] {
  const open = threads.filter(isOpen).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const closed = threads.filter((t) => !isOpen(t)).sort((a, b) => (b.closed!.at).localeCompare(a.closed!.at));
  return [...open, ...closed];
}

function prune(threads: OrgThread[]): OrgThread[] {
  const closed = threads.filter((t) => !isOpen(t)).sort((a, b) => b.closed!.at.localeCompare(a.closed!.at));
  if (closed.length <= CLOSED_KEPT) return threads;
  const drop = new Set(closed.slice(CLOSED_KEPT).map((t) => t.id));
  return threads.filter((t) => !drop.has(t.id));
}

function find(file: ThreadsFile, id: string): OrgThread {
  const t = file.threads.find((x) => x.id === id);
  if (!t) throw new ThreadError('no_thread', 404, `No thread ${id} on this node.`);
  return t;
}

function replace(file: ThreadsFile, next: OrgThread): ThreadsFile {
  return { ...file, threads: prune(file.threads.map((t) => (t.id === next.id ? next : t))) };
}

export interface FileMessageInput {
  text: string;
  images?: string[];
  via: ThreadVia;
  about?: string;
  /** Put it under this thread (the Follow up button). A closed one opens a new thread that follows it. */
  threadId?: string;
  /** Ids chosen ahead (the send path tells the node the id before the message is stored). */
  newThreadId?: string;
  messageId?: string;
  /** The send's own id: a message already filed under it is not filed again (a retry). */
  key?: string;
  at: string;
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
    ...(input.key ? { key: input.key.slice(0, 80) } : {}),
  };
  const target = input.threadId ? file.threads.find((t) => t.id === input.threadId) : undefined;
  if (target && isOpen(target)) {
    const next: OrgThread = {
      ...target, messages: [...target.messages, message], updatedAt: input.at, by: 'human',
      // He spoke again: an answered thread is his turn no more, the node's again.
      ...(target.state === 'answered' ? { state: 'working' as ThreadState } : {}),
    };
    return { file: replace(file, next), thread: next, message, created: false, duplicate: false };
  }
  const thread: OrgThread = {
    id: input.newThreadId && THREAD_ID_RE.test(input.newThreadId) ? input.newThreadId : newThreadId(),
    title: fallbackTitle(text),
    state: 'new', messages: [message], createdAt: input.at, updatedAt: input.at, by: 'human',
    ...(target ? { follows: target.id } : {}),
  };
  return { file: { ...file, threads: prune([...file.threads, thread]) }, thread, message, created: true, duplicate: false };
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
}

function checkPatch(p: ThreadPatch): void {
  if (p.title !== undefined && (typeof p.title !== 'string' || !p.title.trim())) throw new ThreadError('bad_input', 400, 'title must be a few words.');
  if (p.state !== undefined && !THREAD_STATES.includes(p.state)) throw new ThreadError('bad_input', 400, `state must be one of ${THREAD_STATES.join(', ')}.`);
  if (p.close !== undefined && !THREAD_CLOSE_HOWS.includes(p.close)) throw new ThreadError('bad_input', 400, `close must be one of ${THREAD_CLOSE_HOWS.join(', ')}.`);
  if (p.close && p.reopen) throw new ThreadError('bad_input', 400, 'close and reopen cannot go together.');
}

function taskList(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x)))].slice(0, THREAD_TASKS_MAX);
}

export function updateThread(file: ThreadsFile, id: string, patch: ThreadPatch, by: ThreadWriter, at: string): { file: ThreadsFile; thread: OrgThread } {
  checkPatch(patch);
  const cur = find(file, id);
  const next: OrgThread = { ...cur, updatedAt: at, by };
  if (patch.title !== undefined) { next.title = clip(patch.title, THREAD_TITLE_MAX); next.titled = true; }
  if (patch.ask !== undefined) { if (patch.ask.trim()) next.ask = clip(patch.ask, THREAD_ASK_MAX); else delete next.ask; }
  if (patch.reply !== undefined) { if (patch.reply.trim()) next.reply = clip(patch.reply, THREAD_REPLY_MAX); else delete next.reply; }
  if (patch.state !== undefined) next.state = patch.state;
  if (patch.tasks !== undefined) { const l = taskList(patch.tasks); if (l.length) next.tasks = l; else delete next.tasks; }
  if (patch.add_tasks?.length) next.tasks = taskList([...(next.tasks ?? []), ...patch.add_tasks]);
  // Closing a closed thread again changes nothing (the node is not told twice).
  if (patch.close && !(cur.closed && cur.closed.how === patch.close)) next.closed = { how: patch.close, at, by };
  if (patch.reopen) delete next.closed;
  return { file: replace(file, next), thread: next };
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
  const messages = [...into.messages, ...from.messages].sort((a, b) => a.at.localeCompare(b.at));
  const next: OrgThread = {
    ...into, messages, updatedAt: at, by,
    ...(from.tasks?.length || into.tasks?.length ? { tasks: taskList([...(into.tasks ?? []), ...(from.tasks ?? [])]) } : {}),
    ...(into.state === 'answered' ? { state: 'working' as ThreadState } : {}),
  };
  return { file: { ...file, threads: file.threads.filter((t) => t.id !== fromId).map((t) => (t.id === intoId ? next : t)) }, thread: next };
}

/** Take one message out of a thread into a thread of its own (a wrong merge undone). */
export function splitThreadMessage(file: ThreadsFile, threadId: string, messageId: string, by: ThreadWriter, at: string, newId?: string): { file: ThreadsFile; thread: OrgThread; from: OrgThread } {
  const cur = find(file, threadId);
  const msg = cur.messages.find((m) => m.id === messageId);
  if (!msg) throw new ThreadError('no_message', 404, `No message ${messageId} in thread ${threadId}.`);
  if (cur.messages.length < 2) throw new ThreadError('last_message', 409, 'A thread keeps at least one message; this one is already its own thread.');
  const from: OrgThread = { ...cur, messages: cur.messages.filter((m) => m.id !== messageId), updatedAt: at, by };
  // The first message names a thread Walnut titled: it follows the message that is now first.
  if (!from.titled) from.title = fallbackTitle(from.messages[0].text);
  const thread: OrgThread = {
    id: newId && THREAD_ID_RE.test(newId) ? newId : newThreadId(),
    title: fallbackTitle(msg.text), state: 'new', messages: [msg], createdAt: msg.at, updatedAt: at, by,
  };
  return { file: { ...file, threads: [...file.threads.map((t) => (t.id === threadId ? from : t)), thread] }, thread, from };
}

/** The node was told these closes (the threads hint). */
export function markClosesTold(file: ThreadsFile, ids: readonly string[]): ThreadsFile {
  if (!ids.length) return file;
  const set = new Set(ids);
  return { ...file, threads: file.threads.map((t) => (t.closed && set.has(t.id) ? { ...t, closed: { ...t.closed, told: true } } : t)) };
}
