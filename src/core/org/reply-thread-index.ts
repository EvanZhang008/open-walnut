/**
 * The read step of the chat's thread line (experiment `reply_thread_line`, reply-thread.ts): each
 * history or transcript row a client is served gets the thread it belongs to as that thread is NOW.
 *
 *   his message  the thread its `threads` hint named when it was filed; if a merge or a split has
 *                put his message under another thread since, that one (the message is found by
 *                his words, as thread-answers.ts finds it); then any move is followed to the node
 *                holding it (thread-follow.ts). A thread swept after its closed week keeps the
 *                title it was filed under and opens nothing.
 *   the answer   only an answer to a message he sent on a thread: the thread that keeps this row
 *                as a message's answer (thread-answers.ts), else the thread of the message it
 *                answers (reply-thread.ts answerThreads).
 *
 * Each node's threads are read once and kept until one of them changes (`org-threads:changed`) or
 * a minute passes, so a chat read while a turn streams costs no read of the store. Only the
 * leader keeps Threads (threads-store.ts): a replica's rows get no line.
 */
import { log } from '../../logging/index.js';
import type { CarriedHint } from '../hints/hint-format.js';
import { experimentalEnabled } from '../experimental.js';
import { keepsThreads } from './keeps-threads.js';
import { answerThreads, threadOfHints, type ReplyThread } from './reply-thread.js';
import { ROW_AFTER_MS, ROW_BEFORE_MS, rowMatches } from './thread-answers.js';
import type { ThreadMessage } from './threads-model.js';

/** The fields of a served row this step reads. */
export interface ReplyRow {
  role: string;
  text: string;
  timestamp: string;
  injected?: boolean;
  cliError?: boolean | true;
  hints?: CarriedHint[];
  textWithoutContext?: string;
  thread?: ReplyThread;
}

/** A filed message of his, with its time read once. */
interface Kept { m: ThreadMessage; atMs: number }
interface Entry { id: string; title: string; closed: boolean; movedTo?: string; messages: readonly Kept[] }
/** An answer a thread keeps, by the time of its row: two rows of one moment are told apart by their words. */
interface KeptAnswer { thread: string; head: string; askedAt: number }
interface NodeIndex {
  byId: Map<string, Entry>;
  answers: Map<string, KeptAnswer[]>;
  /** Every filed message of the node by time, so a row looks only at the messages of its own window. */
  timeline: Array<Kept & { entry: Entry }>;
  at: number;
}

const KEEP_MS = 60_000;
/** A chat read waits at most this long for its threads, then is served as it is (a route answers on time). */
const DEADLINE_MS = 1_500;
/** An answer is kept clipped: its row is the one that begins with the same words. */
const HEAD_CHARS = 80;
const head = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, HEAD_CHARS);
const MAX_HOPS = 4;
const cache = new Map<string, Promise<NodeIndex>>();
/** Moves on whenever a node's threads change or are read again: a row's thread found before holds until then. */
let generation = 0;
/** A served row's thread, kept by the row (the parse keeps one row object while its read is cached). */
const rowThreads = new WeakMap<object, { generation: number; chat: string; thread: ReplyThread }>();
let watching = false;

function watch(): void {
  if (watching) return;
  watching = true;
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe('org-reply-thread-index', (event) => {
      if (event.name !== EventNames.ORG_THREADS_CHANGED) return;
      const d = event.data as { taskId?: string; owner?: string } | undefined;
      if (d?.taskId) cache.delete(d.taskId);
      if (d?.owner) cache.delete(d.owner);
      // A row whose thread moved here is kept under its chat's node: forget every kept row.
      generation += 1;
    }, { global: true, interest: [EventNames.ORG_THREADS_CHANGED] });
  }).catch(() => { watching = false; });
}

async function readIndex(node: string): Promise<NodeIndex> {
  const { readThreads } = await import('./threads-store.js');
  const file = await readThreads(node);
  const byId = new Map<string, Entry>();
  const answers = new Map<string, KeptAnswer[]>();
  const timeline: NodeIndex['timeline'] = [];
  for (const t of file.threads) {
    const messages = t.messages.map((m) => ({ m, atMs: Date.parse(m.at) }));
    const entry: Entry = { id: t.id, title: t.title, closed: !!t.closed, ...(t.movedTo?.task && t.movedTo.task !== node ? { movedTo: t.movedTo.task } : {}), messages };
    byId.set(t.id, entry);
    for (const k of messages) {
      if (Number.isFinite(k.atMs)) timeline.push({ ...k, entry });
      if (!k.m.answer?.at) continue;
      const list = answers.get(k.m.answer.at) ?? [];
      list.push({ thread: t.id, head: head(k.m.answer.text), askedAt: k.atMs });
      answers.set(k.m.answer.at, list);
    }
  }
  timeline.sort((a, b) => a.atMs - b.atMs);
  return { byId, answers, timeline, at: Date.now() };
}

function indexOf(node: string): Promise<NodeIndex> {
  watch();
  const hit = cache.get(node);
  if (hit) return hit;
  const p = readIndex(node);
  generation += 1;
  cache.set(node, p);
  // A failed read is not kept; a kept one ages out.
  p.then(() => { setTimeout(() => { if (cache.get(node) === p) cache.delete(node); }, KEEP_MS).unref?.(); }, () => { if (cache.get(node) === p) cache.delete(node); });
  return p;
}

/** Is this filed message the row's (his words, his session, the row's time window)? */
function holds(row: ReplyRow, ts: number, k: Kept, sid: string | undefined): boolean {
  if (sid && k.m.sid && k.m.sid !== sid) return false;
  if (!Number.isFinite(ts) || !Number.isFinite(k.atMs) || ts < k.atMs - ROW_BEFORE_MS || ts > k.atMs + ROW_AFTER_MS) return false;
  return rowMatches(row, k.m);
}

/**
 * The threads that hold a message matching the row now. `only`: the one thread when exactly one
 * does (a short "yes" filed twice is no proof which); `best`: the nearest in time.
 */
function holdersOf(index: NodeIndex, row: ReplyRow, ts: number, sid: string | undefined): { only?: Entry; best?: Entry } {
  if (!Number.isFinite(ts)) return {};
  const list = index.timeline;
  // The window's first message: filed no earlier than ROW_AFTER_MS before the row.
  let lo = 0;
  let hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid]!.atMs < ts - ROW_AFTER_MS) lo = mid + 1; else hi = mid; }
  const found = new Set<Entry>();
  let best: Entry | undefined;
  let bestD = Infinity;
  for (let i = lo; i < list.length && list[i]!.atMs <= ts + ROW_BEFORE_MS; i++) {
    const k = list[i]!;
    if (!holds(row, ts, k, sid)) continue;
    found.add(k.entry);
    const d = Math.abs(ts - k.atMs);
    if (d < bestD) { bestD = d; best = k.entry; }
  }
  return { ...(found.size === 1 ? { only: best } : {}), ...(best ? { best } : {}) };
}

/** The entry followed through its moves to the node that holds it. */
async function holderOf(node: string, entry: Entry): Promise<{ node: string; entry: Entry }> {
  let at = { node, entry };
  for (let hop = 0; hop < MAX_HOPS && at.entry.movedTo; hop++) {
    const next = (await indexOf(at.entry.movedTo)).byId.get(at.entry.id);
    if (!next) break;
    at = { node: at.entry.movedTo, entry: next };
  }
  return at;
}

function lineOf(at: { node: string; entry: Entry }, chat: string): ReplyThread {
  return { id: at.entry.id, title: at.entry.title, ...(at.node !== chat ? { node: at.node } : {}), ...(at.entry.closed ? { closed: true as const } : {}) };
}

/** His message's thread now. `row`: the chat row of it, when there is one to follow through a merge or a split. */
async function userThread(row: ReplyRow | null, told: ReplyThread, chat: string, sid: string | undefined): Promise<ReplyThread> {
  const home = told.node ?? chat;
  const index = await indexOf(home);
  let entry = index.byId.get(told.id);
  if (row) {
    const ts = Date.parse(row.timestamp);
    // A merge or a split put his message under another thread since: that is where it is. While
    // the named thread is still kept, only a thread that alone holds his words takes its place.
    if (!entry) entry = holdersOf(index, row, ts, sid).best;
    else if (!entry.messages.some((k) => holds(row, ts, k, sid))) entry = holdersOf(index, row, ts, sid).only ?? entry;
  }
  if (!entry) return { id: told.id, ...(told.title ? { title: told.title } : {}), ...(home !== chat ? { node: home } : {}), gone: true };
  return lineOf(await holderOf(home, entry), chat);
}

async function resolveReplyThreads<R extends ReplyRow>(rows: readonly R[], ctx: { chat: string; sid?: string }): Promise<R[]> {
  const out = [...rows];
  const own = await indexOf(ctx.chat);
  for (let i = 0; i < out.length; i++) {
    const row = out[i]!;
    if (row.role !== 'user' || row.injected) continue;
    const told = threadOfHints(row.hints);
    if (!told) continue;
    const kept = rowThreads.get(row);
    let thread = kept && kept.generation === generation && kept.chat === ctx.chat ? kept.thread : undefined;
    if (!thread) {
      const at = generation;
      thread = await userThread(row, told, ctx.chat, ctx.sid);
      // Only when no node was read meanwhile: one read later is the newer answer.
      if (at === generation) rowThreads.set(row, { generation, chat: ctx.chat, thread });
    }
    out[i] = { ...row, thread };
  }
  const carried = answerThreads(out, (r) => r.thread);
  for (let i = 0; i < out.length; i++) {
    const row = out[i]!;
    // Only the answer to a message he sent on a thread carries a line: an answer to words he only
    // typed in the chat is a plain answer, as his message is (reply-thread.ts threadOfHints).
    if (row.role !== 'assistant' || !carried.has(i)) continue;
    const words = head(row.text);
    const kept = own.answers.get(row.timestamp)?.filter((a) => a.head && a.head === words) ?? [];
    // One row answering two of his messages: the one the carry names (the later message), else the latest asked.
    const pick = kept.find((a) => a.thread === carried.get(i)?.id) ?? kept.reduce<KeptAnswer | undefined>((b, a) => (!b || a.askedAt > b.askedAt ? a : b), undefined);
    const entry = pick ? own.byId.get(pick.thread) : undefined;
    const thread = entry ? lineOf(await holderOf(ctx.chat, entry), ctx.chat) : carried.get(i);
    if (thread) out[i] = { ...row, thread };
  }
  return out;
}

/**
 * The rows with their `thread` (copies of the rows that get one; the others as they are). `chat`:
 * the task whose chat this is; `sid`: its session. Never throws and never waits past `withinMs`:
 * a failure or a slow store serves the rows as they are.
 */
export async function withReplyThreads<R extends ReplyRow>(rows: readonly R[], ctx: { chat: string; sid?: string }, withinMs = DEADLINE_MS): Promise<R[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<R[]>((resolve) => {
    timer = setTimeout(() => {
      log.session.warn('reply threads: rows served without their threads, past the deadline', { taskId: ctx.chat, sessionId: ctx.sid, withinMs });
      resolve([...rows]);
    }, withinMs);
    timer.unref?.();
  });
  const work = resolveReplyThreads(rows, ctx).catch((err) => {
    log.session.warn('reply threads: rows served without their threads', { taskId: ctx.chat, sessionId: ctx.sid, error: err instanceof Error ? err.message : String(err) });
    return [...rows];
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The thread a message not yet in the chat's rows went to (a send just made, a row still in the
 * queue): the one its `threads` hint names, as it is now. Null when it carried none. Never throws.
 */
export async function threadOfSent(hints: readonly CarriedHint[] | undefined, ctx: { chat: string; sid?: string }): Promise<ReplyThread | null> {
  const told = threadOfHints(hints);
  if (!told) return null;
  try {
    return await userThread(null, told, ctx.chat, ctx.sid);
  } catch {
    return told;
  }
}

/** Do served rows get thread lines here: the experiment on, and the leader (only it keeps Threads)? */
async function replyThreadsOn(): Promise<boolean> {
  const [{ getConfig }, { isFollower }] = await Promise.all([import('../config-manager.js'), import('../server-role.js')]);
  return !isFollower() && experimentalEnabled((await getConfig()).experimental, 'reply_thread_line');
}

/** The chat this session's rows are read for, when they get thread lines: the experiment on, a task that keeps Threads, on the leader. */
export async function replyThreadChat(record: { taskId?: string; claudeSessionId?: string } | null | undefined): Promise<{ chat: string; sid?: string } | null> {
  if (!record?.taskId) return null;
  try {
    if (!(await replyThreadsOn())) return null;
    const { listTasksByIds } = await import('../task-manager.js');
    const task = (await listTasksByIds([record.taskId]))[0];
    if (!keepsThreads(task)) return null;
    return { chat: record.taskId, ...(record.claudeSessionId ? { sid: record.claudeSessionId } : {}) };
  } catch {
    return null;
  }
}

/**
 * The session's queue rows with the thread each went to (`message`: the composed text, hints and
 * all). The rows as they are when the experiment is off: no session read then. Never throws.
 */
export async function withQueueThreads<R extends { message?: unknown }>(rows: R[], sid: string): Promise<Array<R & { thread?: ReplyThread }>> {
  try {
    if (!rows.length || !(await replyThreadsOn())) return rows;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const chat = await replyThreadChat(await getSessionByClaudeId(sid));
    if (!chat) return rows;
    const { parseHinted } = await import('../hints/hint-format.js');
    return await Promise.all(rows.map(async (r) => {
      const thread = typeof r.message === 'string' ? await threadOfSent(parseHinted(r.message).hints, chat) : null;
      return thread ? { ...r, thread } : r;
    }));
  } catch {
    return rows;
  }
}

export function _resetReplyThreadIndexForTesting(): void { cache.clear(); generation += 1; }
