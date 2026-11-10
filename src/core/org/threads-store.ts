/**
 * Where an Org node's Threads live (threads-model.ts): one JSON file per node task at
 * `WALNUT_HOME/org/threads/<taskId>.json`, written under the file lock (the user's browser and
 * the node's session write at once). Every change emits `org-threads:changed` (envelope only).
 *
 * Only the leader keeps them: the companion has no copy, so its reads are empty and its writes
 * refused, the way Board writes are.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { bus, EventNames } from '../event-bus.js';
import type { OrgThreadsChangedEvent } from '../event-types.js';
// Only the leader keeps Threads: every replica (the companion and a host replica alike) holds none.
import { isFollower } from '../server-role.js';
import { walnutLetterLanguage as letterLang } from '../human-inbox/walnut-letters/languages.js';
import {
  addMovedMessages, emptyThreads, enteredNeeds, fileMessage, markClosesTold, markRechecked, mergeThreads, movedAway, moveThreadIn, moveThreadOut, normalizeThreads, openThread, patchHandsToUser, setAnswers, splitThreadMessage, stampLegacyReplyAt, sweepClosed, ThreadError, updateThread,
  type FileMessageInput, type FileMessageResult, type MoveEnd, type OpenThreadInput, type ThreadMoveKind, type OrgThread, type ThreadAnswer, type ThreadPatch, type ThreadRecheck, type ThreadsFile, type ThreadTextSource, type ThreadWriter,
} from './threads-model.js';

const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const threadsDir = () => path.join(WALNUT_HOME, 'org', 'threads');

function threadsFile(taskId: string): string {
  if (!TASK_ID_RE.test(taskId)) throw new ThreadError('bad_input', 400, `Invalid task id: ${taskId}`);
  return path.join(threadsDir(), `${taskId}.json`);
}

function emit(event: OrgThreadsChangedEvent): void {
  bus.emit(EventNames.ORG_THREADS_CHANGED, event, ['web-ui'], { source: 'org-threads' });
}

function leaderOnly(): void {
  if (isFollower()) throw new ThreadError('bad_input', 501, 'Threads are kept on the primary; this server holds no copy.');
}

/** The tasks that have a threads file (a reader goes through readThreads for each). */
export async function threadTaskIds(): Promise<string[]> {
  if (isFollower()) return [];
  const names = await fs.readdir(threadsDir()).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => TASK_ID_RE.test(id));
}

export async function readThreads(taskId: string): Promise<ThreadsFile> {
  if (isFollower()) return emptyThreads(taskId);
  return normalizeThreads(await readJsonFile<unknown>(threadsFile(taskId), null), taskId);
}

/** Every node that has a threads file (the follow rule reads them all: thread-follow.ts). */
export async function listThreadNodes(): Promise<string[]> {
  if (isFollower()) return [];
  const names = await fs.readdir(threadsDir()).catch(() => [] as string[]);
  return names.map((n) => (n.endsWith('.json') ? n.slice(0, -5) : '')).filter((id) => TASK_ID_RE.test(id));
}

/**
 * Locked read-modify-write; `mutate` throwing writes nothing. The ONE place a threads file is
 * written, so every write path, today's and any later one, hands a thread that just moved into
 * needs to the phone push (push/thread-push.ts; tests/core/org/thread-needs-push-guard.test.ts).
 */
async function mutateThreads<R>(taskId: string, mutate: (cur: ThreadsFile) => { file: ThreadsFile; out: R }): Promise<R> {
  leaderOnly();
  let out: R | undefined;
  let entered: OrgThread[] = [];
  await updateJsonFile<unknown>(threadsFile(taskId), null, (raw) => {
    // A summary from before replyAt gets its time before anything else moves (stampLegacyReplyAt).
    const cur = stampLegacyReplyAt(normalizeThreads(raw, taskId));
    const res = mutate(cur);
    out = res.out;
    entered = enteredNeeds(cur, res.file);
    return res.file;
  });
  if (entered.length) {
    const threads = entered;
    // A push must never fail or slow the write that triggered it.
    void import('../push/thread-push.js').then((m) => m.onThreadsEnteredNeeds(taskId, threads)).catch(() => {});
  }
  return out as R;
}

/** The phone buzzed for this thread's move into needs (push/thread-push.ts). Quiet: nothing he sees changed. */
export async function markNeedsBuzzed(taskId: string, threadId: string, at: string): Promise<void> {
  if (isFollower()) return;
  await mutateThreads(taskId, (cur) => ({
    file: { ...cur, threads: cur.threads.map((t) => (t.id === threadId ? { ...t, needsBuzzedAt: at } : t)) },
    out: undefined,
  }));
}

/** Where a thread lives now: follows a moved thread's movedTo (a few hops at most) from `taskId`. */
export async function threadHolder(taskId: string, threadId: string): Promise<{ node: string; title?: string; thread: OrgThread } | null> {
  let node = taskId;
  let title: string | undefined;
  for (let hop = 0; hop < 4; hop++) {
    const t = (await readThreads(node)).threads.find((x) => x.id === threadId);
    if (!t) return null;
    if (!movedAway(t) || t.movedTo!.task === node) return { node, ...(title ? { title } : {}), thread: t };
    node = t.movedTo!.task;
    title = t.movedTo!.title;
  }
  return null;
}

export async function fileThreadMessage(taskId: string, input: FileMessageInput, hops = 0): Promise<FileMessageResult & { node: string }> {
  const lang = input.lang ?? await letterLang();
  // A Follow up on a thread that moved on (a card opened before the move): his words go to the
  // thread where it lives now, never a new thread here (thread-follow.ts). Judged under the lock,
  // on the file as it is then, so a move that lands while this write waits is seen.
  let movedTo: string | undefined;
  const res = await mutateThreads(taskId, (cur) => {
    const there = input.threadId && hops < 3 ? cur.threads.find((t) => t.id === input.threadId) : undefined;
    if (there && movedAway(there) && there.movedTo!.task !== taskId) {
      movedTo = there.movedTo!.task;
      return { file: cur, out: null };
    }
    const r = fileMessage(cur, { ...input, lang });
    return { file: r.file, out: r };
  });
  // Its answer is read in the chat of the node holding it (thread-answers.ts), never this node's.
  if (movedTo) { const { sid: _sid, ...rest } = input; return fileThreadMessage(movedTo, { ...rest, lang }, hops + 1); }
  if (!res) throw new ThreadError('bad_input', 500, 'The message was not filed.');
  if (!res.duplicate) emit({ taskId, kind: 'filed', threadId: res.thread.id });
  return { ...res, node: taskId };
}

/** The node opens a thread itself (thread_create): its first post is what reached it. */
/**
 * A thread a node hands the user is not a second copy of a decision a task in its team already asks
 * them (same-ask.ts): 409 `same_ask` with that task named, unless same_ask_reason says why. The user's
 * own writes are never asked. Checked before the write: a race only lets one through.
 */
async function refuseSameAskThread(taskId: string, text: string | undefined, by: ThreadWriter, input: { same_ask_reason?: unknown }): Promise<void> {
  if (by === 'human') return;
  const { refuseSameAsk } = await import('../same-ask-tree.js');
  const { SameAskError } = await import('../same-ask.js');
  await refuseSameAsk(taskId, text, 'thread', input).catch((err) => {
    throw err instanceof SameAskError ? new ThreadError('same_ask', 409, err.message) : err;
  });
}

/**
 * `source`: the writer's own session, verified by the caller (the route reads it from the caller's
 * session record, never from the body); absent = an unknown writer (or the user, by 'human').
 */
export async function openNodeThread(taskId: string, input: OpenThreadInput, by: ThreadWriter, source?: ThreadTextSource): Promise<OrgThread> {
  if ((input.state ?? 'needs') === 'needs') await refuseSameAskThread(taskId, input.title, by, input);
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = openThread(cur, input, by, at, source);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'opened', threadId: thread.id });
  return thread;
}

/** `source`: as for openNodeThread; it is recorded only when the patch changes the summary (`reply`). */
export async function patchThread(taskId: string, id: string, patch: ThreadPatch, by: ThreadWriter, source?: ThreadTextSource): Promise<OrgThread> {
  if (by !== 'human') {
    const cur = (await readThreads(taskId)).threads.find((t) => t.id === id);
    if (cur && patchHandsToUser(cur, patch)) await refuseSameAskThread(taskId, patch.ask?.trim() || cur.ask || patch.title?.trim() || cur.title, by, patch);
  }
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = updateThread(cur, id, patch, by, at, source);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'updated', threadId: id });
  return thread;
}

export async function mergeThread(taskId: string, fromId: string, intoId: string, by: ThreadWriter): Promise<OrgThread> {
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = mergeThreads(cur, fromId, intoId, by, at);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'merged', threadId: intoId });
  return thread;
}

export async function splitThread(taskId: string, threadId: string, messageId: string, by: ThreadWriter): Promise<{ thread: OrgThread; from: OrgThread }> {
  const at = new Date().toISOString();
  const lang = await letterLang();
  const res = await mutateThreads(taskId, (cur) => {
    const r = splitThreadMessage(cur, threadId, messageId, by, at, undefined, lang);
    return { file: r.file, out: { thread: r.thread, from: r.from } };
  });
  emit({ taskId, kind: 'split', threadId: res.thread.id });
  return res;
}

export interface MoveThreadInput {
  from: MoveEnd;
  to: MoveEnd;
  threadId: string;
  by: ThreadWriter;
  why?: string;
  /** `work`: the follow rule moved it after its tasks; `hand`: a node or the user handed it on. */
  kind?: ThreadMoveKind;
  /** A hand move: the nodes its tasks work in now (threads-model ThreadMove.owners). */
  owners?: string;
}

/** Moves run one at a time on this server: two movers of one thread never interleave their steps. */
let moveChain: Promise<unknown> = Promise.resolve();

/**
 * Move one open thread from one node's Threads to another's (thread-follow.ts). The copy goes in
 * first and the source closes after, pointing at it: a crash between the two leaves two open copies
 * (the next follow pass moves the source again, and the open copy keeps what it got meanwhile and
 * gains the source's new messages: moveThreadIn), never none. What he wrote into the source in
 * between joins the copy, and what was written to the copy meanwhile (his follow-up there, the new
 * node's summary) stays (addMovedMessages). A source he closed in between keeps his close: the copy
 * is undone only while nothing was written to it since it came in.
 */
export function moveThread(input: MoveThreadInput): Promise<OrgThread> {
  const run = moveChain.then(() => moveThreadNow(input));
  moveChain = run.catch(() => {});
  return run;
}

async function moveThreadNow(input: MoveThreadInput): Promise<OrgThread> {
  leaderOnly();
  const { from, to, threadId, by, why, owners } = input;
  const kind = input.kind ?? 'work';
  if (from.task === to.task) throw new ThreadError('same_node', 409, `Thread ${threadId} is already on ${to.title}'s Threads.`);
  const cur = (await readThreads(from.task)).threads.find((t) => t.id === threadId);
  if (!cur) throw new ThreadError('no_thread', 404, `No thread ${threadId} on this node.`);
  if (cur.closed) {
    throw new ThreadError('thread_closed', 409, cur.movedTo
      ? `Thread ${threadId} already moved to ${cur.movedTo.title} (${cur.movedTo.task}).`
      : `Thread ${threadId} is closed: only an open thread moves with its work.`);
  }
  const at = new Date().toISOString();
  let prior: OrgThread | undefined;
  let moved = await mutateThreads(to.task, (f) => {
    const r = moveThreadIn(f, cur, from, by, at, why, kind, owners);
    prior = r.prior;
    return { file: r.file, out: r.thread };
  });
  let left: OrgThread;
  try {
    left = await mutateThreads(from.task, (f) => {
      const r = moveThreadOut(f, threadId, to, by, at, why, kind);
      return { file: r.file, out: r.thread };
    });
  } catch (err) {
    // He closed it in between (a move of another server's is not possible: only the primary moves):
    // the source stays as he left it, and the copy goes back to what was there before, unless
    // something was written to it since (his follow-up there is never thrown away).
    const mark = (t: OrgThread) => [t.updatedAt, t.state, t.reply ?? '', t.closed?.at ?? '', t.messages.map((m) => `${m.id}:${m.answer?.at ?? ''}`).join(',')].join('|');
    const came = mark(moved);
    await mutateThreads(to.task, (f) => {
      const now = f.threads.find((t) => t.id === threadId);
      if (!now || mark(now) !== came) return { file: f, out: undefined };
      const rest = f.threads.filter((t) => t.id !== threadId);
      return { file: { ...f, threads: prior ? [...rest, prior] : rest }, out: undefined };
    });
    throw err;
  }
  if (left.messages.length !== cur.messages.length || left.messages.some((m, i) => m.id !== cur.messages[i]?.id)) {
    moved = await mutateThreads(to.task, (f) => {
      const next = addMovedMessages(f, left, at);
      return { file: next, out: next.threads.find((t) => t.id === threadId) ?? moved };
    });
  }
  emit({ taskId: to.task, kind: 'moved', threadId });
  emit({ taskId: from.task, kind: 'moved', threadId });
  return moved;
}

/** The node was told these threads closed. Quiet: nothing the user sees changed. */
export async function noteClosesTold(taskId: string, ids: readonly string[]): Promise<void> {
  if (!ids.length || isFollower()) return;
  await mutateThreads(taskId, (cur) => ({ file: markClosesTold(cur, ids), out: undefined }));
}

/** Walnut woke the node about these threads (thread-recheck.ts): the card's line names when. */
export async function noteThreadsRechecked(taskId: string, marks: ReadonlyMap<string, ThreadRecheck>): Promise<void> {
  if (!marks.size || isFollower()) return;
  await mutateThreads(taskId, (cur) => ({ file: markRechecked(cur, marks), out: undefined }));
  emit({ taskId, kind: 'updated', ...(marks.size === 1 ? { threadId: [...marks.keys()][0] } : {}) });
}

/** Answers Walnut read from the node's chat (thread-answers.ts), each onto its message. Returns how many landed. */
export async function setThreadAnswers(taskId: string, answers: ReadonlyMap<string, ThreadAnswer>): Promise<number> {
  if (!answers.size || isFollower()) return 0;
  const changed = await mutateThreads(taskId, (cur) => {
    const r = setAnswers(cur, answers);
    return { file: r.file, out: r.changed };
  });
  // One change for the whole read: a client reads the node's threads once, not once per thread.
  if (changed.length) emit({ taskId, kind: 'answered', ...(changed.length === 1 ? { threadId: changed[0] } : {}) });
  return changed.length;
}

/** The primary's sweep: every node's closed threads past their week are deleted for good. */
export async function sweepClosedThreads(now = Date.now()): Promise<number> {
  if (isFollower()) return 0;
  const names = await fs.readdir(threadsDir()).catch(() => [] as string[]);
  let dropped = 0;
  const at = new Date(now).toISOString();
  for (const name of names) {
    const taskId = name.endsWith('.json') ? name.slice(0, -5) : '';
    if (!TASK_ID_RE.test(taskId)) continue;
    const n = await mutateThreads(taskId, (cur) => {
      const r = sweepClosed(cur, at);
      return { file: r.file, out: r.dropped };
    });
    if (n) { dropped += n; emit({ taskId, kind: 'swept' }); }
  }
  return dropped;
}
