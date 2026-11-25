/**
 * Where an Org node's Threads live (threads-model.ts): one JSON file per node task at
 * `WALNUT_HOME/org/threads/<taskId>.json`, written under the file lock (the user's browser and
 * the node's session write at once), or, while the experiment `threads_sqlite` is on, the Threads
 * database with those files kept current beside it (threads-backend.ts, threads-sync.ts). Every
 * function here reads and writes the same on either. Every change emits `org-threads:changed`
 * (envelope only).
 *
 * Only the leader keeps them: the companion has no copy, so its reads are empty and its writes
 * refused, the way Board writes are.
 */
import { oneCardOn } from './one-card.js';
import { readJsonFile, updateJsonFile } from '../../utils/fs.js';
import { bus, EventNames } from '../event-bus.js';
import type { OrgThreadsChangedEvent } from '../event-types.js';
// Only the leader keeps Threads: every replica (the companion and a host replica alike) holds none.
import { isFollower } from '../server-role.js';
import { walnutLetterLanguage as letterLang } from '../human-inbox/walnut-letters/languages.js';
import {
  addMovedMessages, deliveryOpen, emptyThreads, enteredNeeds, fileMessage, markClosesTold, markRechecked, mergeThreads, movedAway, moveThreadIn, moveThreadOut, normalizeThreads, openThread, patchHandsToUser, relocateThreadOut, setAnswers, splitMessageInto, splitThreadMessage, stampLegacyReplyAt, sweepClosed, ThreadError, updateThread,
  type FileMessageInput, type FileMessageResult, type MoveEnd, type OpenThreadInput, type ThreadAskOwner, type ThreadMoveKind, type OrgThread, type ThreadAnswer, type ThreadDelivery, type ThreadMessage, type ThreadPatch, type ThreadState, type ThreadRecheck, type ThreadsFile, type ThreadTextSource, type ThreadWriter,
} from './threads-model.js';
import { threadsDbOnNow, useThreadsDb, writeThreadsLeftovers } from './threads-backend.js';
import { dbDropExpired, dbMutateThreads, dbReadThreads, dbThreadNodes, flushNodeExport, jsonNodes, threadsJsonFile as threadsFile } from './threads-sync.js';
import { askOwnerKept, askOwnerOf, askOwnerTask, askPointerView, pointerTaskIds } from './thread-task-ask.js';
import { heldCandidate, ownThreadTaskIds } from './thread-subject-pairs.js';
import type { ThreadAskedIn, ThreadHeldAsk } from './thread-view.js';
import { placeAsk, withHeldAsk, type TaskAsk } from './thread-report-ask.js';
import { stampAskIds, threadsPopUpNow } from './thread-popup-rules.js';
import { liveLetter } from './letter-thread-model.js';

function emit(event: OrgThreadsChangedEvent): void {
  bus.emit(EventNames.ORG_THREADS_CHANGED, event, ['web-ui'], { source: 'org-threads' });
}

function leaderOnly(): void {
  if (isFollower()) throw new ThreadError('bad_input', 501, 'Threads are kept on the primary; this server holds no copy.');
}

/**
 * Before the JSON files are read or written: what the database still holds for them goes out first
 * (a crash's leftovers at a start with the experiment off, a write waiting when it went off).
 */
async function jsonReady(taskId: string): Promise<void> {
  await writeThreadsLeftovers();
  await flushNodeExport(taskId);
}

/** The tasks that have a threads file (a reader goes through readThreads for each). */
export async function threadTaskIds(): Promise<string[]> {
  if (isFollower()) return [];
  return (await useThreadsDb()) ? dbThreadNodes() : jsonNodes();
}

export async function readThreads(taskId: string): Promise<ThreadsFile> {
  if (isFollower()) return emptyThreads(taskId);
  const file = threadsFile(taskId);
  if (await useThreadsDb()) return dbReadThreads(taskId);
  await jsonReady(taskId);
  return normalizeThreads(await readJsonFile<unknown>(file, null), taskId);
}

/**
 * The node's threads as he reads them: each in needs whose decision a task already asks carries
 * that task (`askedIn`, thread-task-ask.ts). Every reader of what waits on him goes through this
 * (the route, the status counts, the recheck, the push), so they agree. A store Walnut cannot read
 * leaves the threads as they are: a miss shows an ask twice, never hides one.
 */
export async function withTaskAsks<T extends OrgThread>(taskId: string, threads: readonly T[], tasks?: readonly import('../types.js').Task[], opts: NodeViewOpts = {}): Promise<Array<T & { askedIn?: ThreadAskedIn; heldAsk?: ThreadHeldAsk }>> {
  return (await nodeView(taskId, threads, tasks, opts)).threads;
}

/**
 * `carry: false`: a reader of the node's needs alone (the push, the threads below, owed waits) skips
 * the results below, which only ever hold threads that do not ask him (thread-subject-pairs.ts): no
 * read of the linked tasks' Threads for it. Every reader of what he sees in the node's list keeps it.
 */
export interface NodeViewOpts { carry?: boolean }

/** A result of a task below that answers the subject of one of the node's own threads (thread-subject-pairs.ts carriedResults). */
export interface CarriedBelow { thread: OrgThread; task: import('../types.js').Task; carries: string }

/**
 * withTaskAsks, and with threads_pop_up the results of tasks below on the subjects of the node's own
 * threads, which those threads wait behind (thread-subject-pairs.ts): the route and the status counts
 * list them above the node (thread-popup.ts carriedRows).
 */
export async function nodeView<T extends OrgThread>(taskId: string, threads: readonly T[], tasks?: readonly import('../types.js').Task[], opts: NodeViewOpts = {}): Promise<{ threads: Array<T & { askedIn?: ThreadAskedIn; heldAsk?: ThreadHeldAsk }>; carried: CarriedBelow[] }> {
  const now = Date.now();
  const plain = (list: readonly T[]) => ({ threads: [...list] as Array<T & { askedIn?: ThreadAskedIn; heldAsk?: ThreadHeldAsk }>, carried: [] as CarriedBelow[] });
  const carry = opts.carry !== false && threadsPopUpNow() && threads.some((t) => !t.closed && t.state !== 'needs' && !!t.tasks?.some((id) => id !== taskId));
  // A result a linked task's own thread may hold (thread-subject-pairs.ts) is read like a needs thread.
  const results = threads.some((t) => heldCandidate(t, now)) || carry;
  const needs = threads.some((t) => !t.closed && t.state === 'needs') || results;
  if (!needs && !threads.some((t) => t.reportAsk && !t.closed)) return plain(threads);
  try {
    // The store's own rows, read only: a copy of every task per threads read was garbage the size of the board.
    const all = tasks ?? await (await import('../task-manager.js')).taskStoreSnapshot();
    const node = all.find((t) => t.id === taskId);
    if (!node) return plain(threads);
    // The task's own ask reads on the thread that holds it (thread-report-ask.ts); a stored needs
    // thread is never one of those, so the pointers below read the same threads either way.
    if (!needs) return { threads: withHeldAsk(node, threads), carried: [] };
    const { treeAround } = await import('../same-ask-tree.js');
    // Completed tasks can still hold an answered decision: membership counts every task open
    // (allOpen); the rows are the real ones, so a completion never revives the thread's old ask.
    const around = treeAround(taskId, all, { allOpen: true }).map((row) => row.task);
    // His own word to a task that stopped asking is the evidence it was settled there: one read of
    // the session records for those tasks only.
    const ids = pointerTaskIds(threads);
    const quiet = around.filter((t) => ids.has(t.id) && t.user_status?.state !== 'needs');
    const personAt = quiet.length ? await personWroteAt(quiet) : new Map<string, string>();
    // The Threads of the few tasks a result here is linked to (and of one under them that asks now).
    const own = new Map<string, readonly OrgThread[]>();
    if (results) for (const id of ownThreadTaskIds(node, threads, around, now, carry)) own.set(id, await threadsForPointers(id));
    const view = askPointerView(node, threads, around, { nowMs: now, personAt: (id) => personAt.get(id), threadsOf: (id) => own.get(id), carry });
    const byId = new Map(around.map((t) => [t.id, t] as const));
    const carried = view.carried.flatMap((c) => {
      const task = byId.get(c.task.id);
      return task ? [{ thread: c.thread as OrgThread, task, carries: c.carries }] : [];
    });
    return { threads: withHeldAsk(node, view.threads), carried };
  } catch {
    return plain(threads);
  }
}

/**
 * Another task's threads, for a pointer of this node (withTaskAsks). Kept two seconds, and dropped
 * by every write of that task's threads here (mutateThreads): one page load reads the same few
 * files for every node it lists (the Board's thread states read up to 300 nodes). None on a failed read.
 */
const POINTER_THREADS_MS = 2_000;
const pointerThreads = new Map<string, { at: number; threads: readonly OrgThread[] }>();
async function threadsForPointers(taskId: string): Promise<readonly OrgThread[]> {
  const now = Date.now();
  const hit = pointerThreads.get(taskId);
  if (hit && now - hit.at < POINTER_THREADS_MS) return hit.threads;
  const threads = (await readThreads(taskId).catch(() => null))?.threads ?? [];
  if (pointerThreads.size > 500) pointerThreads.clear();
  pointerThreads.set(taskId, { at: now, threads });
  return threads;
}

/** When a person last wrote to each task's sessions (SessionRecord.humanInputAt, chatInputAt); none on a failed read. */
async function personWroteAt(tasks: readonly import('../types.js').Task[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const { listSessionsForTasks } = await import('../session-tracker.js');
    const bySid = new Map<string, string>();
    for (const t of tasks) for (const sid of [t.session_id, ...(t.session_ids ?? [])]) if (sid) bySid.set(sid, t.id);
    for (const rec of await listSessionsForTasks(new Set(tasks.map((t) => t.id)), new Set(bySid.keys()))) {
      const id = rec.taskId && tasks.some((t) => t.id === rec.taskId) ? rec.taskId : bySid.get(rec.claudeSessionId);
      for (const at of [rec.humanInputAt, rec.chatInputAt]) if (id && at && at > (out.get(id) ?? '')) out.set(id, at);
    }
  } catch { /* no evidence read: the thread keeps its own ask */ }
  return out;
}

/** Every node that has a threads file (the follow rule reads them all: thread-follow.ts). */
export async function listThreadNodes(): Promise<string[]> {
  return threadTaskIds();
}

/**
 * Locked read-modify-write; `mutate` throwing writes nothing. The ONE place a threads file is
 * written, so every write path, today's and any later one, hands a thread that just moved into
 * needs to the phone push (push/thread-push.ts; tests/core/org/thread-needs-push-guard.test.ts).
 */
async function mutateThreads<R>(taskId: string, mutate: (cur: ThreadsFile) => { file: ThreadsFile; out: R }): Promise<R> {
  leaderOnly();
  // Its threads are about to change: no pointer of another node reads the copy kept of them.
  pointerThreads.delete(taskId);
  let out: R | undefined;
  let entered: OrgThread[] = [];
  const step = (read: ThreadsFile): ThreadsFile => {
    // A summary from before replyAt gets its time before anything else moves (stampLegacyReplyAt).
    const cur = stampLegacyReplyAt(read);
    const res = mutate(cur);
    out = res.out;
    entered = enteredNeeds(cur, res.file);
    // A decision waiting on him gets its id, so a reply names the ask it answers (thread-popup.ts).
    return threadsPopUpNow() ? stampAskIds(cur, res.file) : res.file;
  };
  const file = threadsFile(taskId);
  // false: the experiment went off before the database write began, so the file takes it.
  if (!((await useThreadsDb()) && (await dbMutateThreads(taskId, step, threadsDbOnNow)))) {
    await jsonReady(taskId);
    await updateJsonFile<unknown>(file, null, (raw) => step(normalizeThreads(raw, taskId)));
  }
  if (entered.length) {
    const threads = entered;
    // A push must never fail or slow the write that triggered it. A thread whose decision a task
    // already asks him buzzes nothing: that task's ask is the one he answers (thread-task-ask.ts).
    void withTaskAsks(taskId, threads, undefined, { carry: false })
      .then(async (read) => {
        // A thread holding a decision letter buzzes nothing either: the letter's own push did (letter-thread-model.ts).
        const own = threads.filter((t) => !read.find((r) => r.id === t.id)?.askedIn && !liveLetter(t));
        if (own.length) await (await import('../push/thread-push.js')).onThreadsEnteredNeeds(taskId, own);
      })
      .catch(() => {});
  }
  return out as R;
}

/** What a write of Walnut's own changed: one thread, or a sweep over several (thread-ended.ts). */
type WrittenFor = { kind: 'opened' | 'updated'; threadId: string } | { kind: 'swept' };

/**
 * A write of Walnut's own that is no op of a node or of his (human-inbox/letter-threads.ts: the
 * thread that holds a decision letter): `mutate` under the lock, then one change event when it says
 * which thread changed.
 */
export async function writeThreadsFor<R>(taskId: string, mutate: (cur: ThreadsFile) => { file: ThreadsFile; out: R; changed?: WrittenFor }): Promise<R> {
  let changed: WrittenFor | undefined;
  const out = await mutateThreads(taskId, (cur) => {
    const r = mutate(cur);
    changed = r.changed;
    return r;
  });
  if (changed) emit({ taskId, ...changed });
  return out;
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
  let mergedThere: string | undefined;
  let answeredAsk = false;
  const res = await mutateThreads(taskId, (cur) => {
    const there = input.threadId && hops < 3 ? cur.threads.find((t) => t.id === input.threadId) : undefined;
    if (there && movedAway(there) && there.movedTo!.task !== taskId) {
      movedTo = there.movedTo!.task;
      mergedThere = there.movedTo!.merged;
      return { file: cur, out: null };
    }
    const r = fileMessage(cur, { ...input, lang });
    // Joined to a thread that waited on him: his answer to it, whatever its words (review 2026-11-24).
    answeredAsk = cur.threads.find((t) => t.id === r.thread.id)?.state === 'needs';
    return { file: r.file, out: r };
  });
  // Its answer is read in the chat of the node holding it (thread-answers.ts), never this node's.
  if (movedTo) { const { sid: _sid, ...rest } = input; return fileThreadMessage(movedTo, { ...rest, ...(mergedThere ? { threadId: mergedThere } : {}), lang }, hops + 1); }
  if (!res) throw new ThreadError('bad_input', 500, 'The message was not filed.');
  if (!res.duplicate) emit({ taskId, kind: 'filed', threadId: res.thread.id });
  // Joined only for its timing: its subject is checked now, and it leaves for a thread of its own unless it is that one (thread-join-check.ts).
  if (!res.duplicate && res.joined === 'recent' && !answeredAsk) void import('./thread-join-check.js').then((m) => m.checkJoinedMessage(taskId, res.thread.id, res.message.id));
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
/** `sameSubject`: thread_create's own door asks its one-subject check (thread-same-subject.ts); Walnut's own opens (a letter, a topic) do not. */
export async function openNodeThread(taskId: string, input: OpenThreadInput, by: ThreadWriter, source?: ThreadTextSource, opts: { sameSubject?: boolean } = {}): Promise<OrgThread> {
  // The needs_options check below reads the switch as it is now (one-card.ts).
  await oneCardOn();
  const needs = !input.quiet_summary?.trim() && (input.state ?? 'needs') === 'needs';
  if (needs) await refuseSameAskThread(taskId, input.title, by, input);
  // The task's other asks: named as replaced, or said to be other decisions (thread-supersede.ts).
  const { refuseOtherOpenAsks, applySupersedes, namedElsewhere, applyElsewhere, namedRefusal } = await import('./thread-supersede.js');
  // The thread's own refusals come first (a missing kind, an unclear card): a dry run on the file as it is.
  if (needs && by !== 'human') openThread(await readThreads(taskId), input, by, new Date().toISOString(), source);
  const replaced = needs ? await refuseOtherOpenAsks(taskId, by, input) : [];
  // An ask it names beyond its own (its lead's card, a card below it): stepped aside there, or refused by name.
  if (!needs && by !== 'human' && input.supersedes?.length) throw new ThreadError('bad_input', 409, namedRefusal(input.supersedes[0]!, 'no_ask'));
  const elsewhere = needs ? await namedElsewhere(taskId, by, input.supersedes, replaced) : [];
  // One subject is one thread, checked after the refusals about one decision (same_ask, other_open_asks), which say more.
  if (opts.sameSubject) {
    const { refuseSameSubjectThread } = await import('./thread-same-subject.js');
    await refuseSameSubjectThread(taskId, input.title, by, input);
    // Its first post and summary read alone, as a thread_update summary must (thread-summary-content.ts).
    if (by !== 'human') {
      const { ASKS_OUTSIDE_NEEDS, asksHimNow, summaryPointsElsewhere } = await import('./thread-summary-content.js');
      // Its summary waits on him when it opens in needs; its first post only says what reached the node.
      const empty = [input.reply, input.text].map((x, i) => (typeof x === 'string' ? summaryPointsElsewhere(x, { needs: needs && i === 0 }) : null)).find(Boolean);
      if (empty) throw new ThreadError('bad_input', 422, empty);
      // Its summary, or with none its first post, which his card shows in its place.
      const words = typeof input.reply === 'string' && input.reply.trim() ? input.reply : input.text;
      if (!needs && typeof words === 'string' && asksHimNow(words)) throw new ThreadError('bad_input', 422, ASKS_OUTSIDE_NEEDS);
    }
  }
  const at = new Date().toISOString();
  const thread = await mutateThreads(taskId, (cur) => {
    const r = openThread(cur, input, by, at, source);
    return { file: r.file, out: r.thread };
  });
  emit({ taskId, kind: 'opened', threadId: thread.id });
  await applySupersedes(taskId, replaced, thread, by);
  await applyElsewhere(elsewhere, thread, by);
  return thread;
}

/**
 * `source`: as for openNodeThread; it is recorded only when the patch changes the summary (`reply`).
 * `ask_owner`: the task that already asks him this thread's decision (thread-task-ask.ts): stored
 * with that task's decision id and words now, and the task linked; such a write is a pointer, never
 * refused as a second ask. "" takes it off; a write that changes what the thread asks drops it
 * unless it still asks that decision (thread-task-ask.ts askOwnerKept).
 */
export async function patchThread(taskId: string, id: string, patch: ThreadPatch, by: ThreadWriter, source?: ThreadTextSource): Promise<OrgThread> {
  await oneCardOn();
  const { ask_owner: ownerId, place, place_why: placeWhy, ...rest } = patch;
  const at = new Date().toISOString();
  // The node's decision on a thread he acknowledged (thread-ack.ts nodePlaced): checked before any write.
  const ackMod = place !== undefined || placeWhy !== undefined || (by !== 'human' && rest.close) ? await import('./thread-ack.js') : null;
  const placing = ackMod && (place !== undefined || placeWhy !== undefined) ? ackMod.checkPlace(by, place, placeWhy, rest) : null;
  // Placed in Closed: its close, with every close check (his pin, a reply on its way, nothing unseen).
  if (placing?.to === 'closed') rest.close = 'acked';
  let owner: ThreadAskOwner | null | undefined;
  if (ownerId !== undefined) {
    if (typeof ownerId !== 'string') throw new ThreadError('bad_input', 400, 'ask_owner must be a task id, or "" to take it off.');
    const want = ownerId.trim();
    if (!want) owner = null;
    else {
      const all = await (await import('../task-manager.js')).listTasks();
      try {
        const { treeAround } = await import('../same-ask-tree.js');
        const node = all.find((t) => t.id === taskId) ?? { id: taskId };
        const task = askOwnerTask(want, node, treeAround(taskId, all).map((row) => row.task), all);
        owner = askOwnerOf(want, node, task, by, at);
      } catch (err) {
        throw new ThreadError('bad_input', 409, err instanceof Error ? err.message : String(err));
      }
      rest.add_tasks = [...(rest.add_tasks ?? []), owner.task];
    }
  }
  let replaced: import('./thread-supersede.js').OpenAsk[] = [];
  let elsewhere: import('./thread-supersede.js').ElsewhereAsk[] = [];
  if (by !== 'human' && !owner) {
    const cur = (await readThreads(taskId)).threads.find((t) => t.id === id);
    const hands = !!cur && patchHandsToUser(cur, rest);
    if (cur && hands) {
      await refuseSameAskThread(taskId, rest.ask?.trim() || cur.ask || rest.title?.trim() || cur.title, by, rest);
      // A task around already asks him this subject on a thread of its own: one decision, one card.
      await (await import('./thread-same-subject.js')).refuseSameSubjectAsk(taskId, rest.title?.trim() || cur.title, [...(cur.tasks ?? []), ...(rest.add_tasks ?? [])], by, rest);
      // Its own refusals first (a missing kind, a return with no word on his message): a dry run.
      updateThread(await readThreads(taskId), id, rest, by, new Date().toISOString(), source);
      replaced = await (await import('./thread-supersede.js')).refuseOtherOpenAsks(taskId, by, rest, id);
    }
    // The asks it names beyond its own, while this thread waits on him after the write (handed to him
    // now, or already there): stepped aside on their own node, or refused by name (thread-supersede.ts).
    if (cur && rest.supersedes?.length) {
      const mod = await import('./thread-supersede.js');
      const waits = hands || (!cur.closed && !rest.close && (rest.state ?? cur.state) === 'needs');
      // Named on a write that leaves the thread asking nothing: refused, never ignored.
      if (!waits) throw new ThreadError('bad_input', 409, mod.namedRefusal(rest.supersedes[0]!, 'no_ask'));
      elsewhere = await mod.namedElsewhere(taskId, by, rest.supersedes, replaced, id);
    }
  }
  // His Acknowledge alone (experiment ack_means_known): read the open tasks it lists before the lock.
  const ack = by === 'human' && rest.close === 'acked' && Object.keys(rest).length === 1 ? await import('./thread-ack.js') : null;
  const ackOpen = ack ? await ack.ackOpenTasks(taskId, id) : null;
  const held: { reading?: import('./thread-ack-outcome.js').AckReading } = {};
  const thread = await mutateThreads(taskId, (cur) => {
    const before = cur.threads.find((t) => t.id === id);
    // He knows where it stands: it goes to Acknowledged and the node decides where it goes (thread-known.ts).
    // Acknowledged already by now (a double click, or the node just placed it): his ack closes it.
    if (ack && ackOpen && before && !before.closed && !ack.isKnown(before)) held.reading = ack.ackOutcome(before, ackOpen);
    const r = held.reading ? ack!.ackKnown(cur, id, at)
      : Object.keys(rest).length || !before ? updateThread(cur, id, rest, by, at, source) : { file: cur, thread: before };
    let next = r.thread;
    if (ackMod) next = ackMod.nodePlaced(before, next, placing, at);
    if (owner) next = { ...next, askOwner: owner };
    else if (next.askOwner && (owner === null || !before || !askOwnerKept(before, next))) {
      const { askOwner: _gone, ...kept } = next;
      next = kept;
    }
    if (next === r.thread) return { file: r.file, out: next };
    return { file: { ...r.file, threads: r.file.threads.map((t) => (t.id === id ? next : t)) }, out: next };
  });
  emit({ taskId, kind: 'updated', threadId: id });
  if (replaced.length) await (await import('./thread-supersede.js')).applySupersedes(taskId, replaced, thread, by);
  if (elsewhere.length) await (await import('./thread-supersede.js')).applyElsewhere(elsewhere, thread, by);
  if (ack && held.reading) await ack.rideToNode(taskId, id, ack.ackLine(thread, held.reading));
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

/** The thread that left `taskId` was merged into `intoId` where it went: its pointer here says so (thread-tree-merge.ts). */
export async function markMergedThere(taskId: string, threadId: string, intoId: string): Promise<void> {
  await mutateThreads(taskId, (cur) => {
    const t = cur.threads.find((x) => x.id === threadId);
    if (!t?.movedTo || t.movedTo.merged === intoId) return { file: cur, out: null };
    return { file: { ...cur, threads: cur.threads.map((x) => (x === t ? { ...t, movedTo: { ...t.movedTo!, merged: intoId } } : x)) }, out: null };
  });
}

export interface SplitThreadOptions {
  /** Keep the source open even when nothing is left open on it (threads-model.ts SplitOptions). */
  keepOpen?: boolean;
  /** Move the message straight into this open thread instead of a new one (splitMessageInto). */
  mergeInto?: string;
}

/**
 * One message out of a thread: into a new thread of its own, or with `mergeInto` straight into
 * another open thread, in one locked write. `closedFrom`: the source closed with it.
 */
export async function splitThread(taskId: string, threadId: string, messageId: string, by: ThreadWriter, opts: SplitThreadOptions = {}): Promise<{ thread: OrgThread; from: OrgThread; closedFrom: boolean; mergedInto?: string; already?: boolean }> {
  const at = new Date().toISOString();
  const lang = await letterLang();
  const keep = { keepOpen: opts.keepOpen === true };
  const into = opts.mergeInto;
  const { splitWhereItIs } = await import('./thread-join-check.js');
  const res = await mutateThreads(taskId, (cur) => {
    // The subject check at filing may have taken it out already (thread-join-check.ts).
    const moved = splitWhereItIs(cur, threadId, messageId, into, by, at, lang);
    if (moved) return { file: moved.file, out: { thread: moved.thread, from: moved.from, closedFrom: false, already: true as const, ...(into ? { mergedInto: into } : {}) } };
    const r = into
      ? splitMessageInto(cur, threadId, messageId, into, by, at, lang, keep)
      : splitThreadMessage(cur, threadId, messageId, by, at, undefined, lang, keep);
    return { file: r.file, out: { thread: r.thread, from: r.from, closedFrom: r.closedFrom, ...(into ? { mergedInto: into } : {}) } };
  });
  emit(into ? { taskId, kind: 'merged', threadId: into } : { taskId, kind: 'split', threadId: res.thread.id });
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
  // threads_pop_up: the move changes the owner; only a pointer stays behind (threadHolder follows it).
  const relocate = threadsPopUpNow();
  try {
    left = await mutateThreads(from.task, (f) => {
      const r = (relocate ? relocateThreadOut : moveThreadOut)(f, threadId, to, by, at, why, kind);
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

/**
 * His replies from a card above, on their way to this task's session (thread-reply.ts): `step`
 * returns a message's next delivery, or undefined to leave it. Only messages that carry one are
 * asked. Returns the changed messages with their threads, as they are now.
 */
export async function updateReplyDeliveries(taskId: string, step: (t: OrgThread, m: ThreadMessage) => ThreadDelivery | undefined): Promise<Array<{ thread: OrgThread; message: ThreadMessage }>> {
  if (isFollower()) return [];
  const changed = await mutateThreads(taskId, (cur) => {
    const out: Array<{ thread: OrgThread; message: ThreadMessage }> = [];
    const threads = cur.threads.map((t) => {
      if (!t.messages.some((m) => m.delivery)) return t;
      let touched = false;
      const messages = t.messages.map((m) => {
        const next = m.delivery ? step(t, m) : undefined;
        if (!next) return m;
        touched = true;
        return { ...m, delivery: next };
      });
      if (!touched) return t;
      const thread = { ...t, messages };
      for (const m of messages) if (m !== t.messages.find((x) => x.id === m.id)) out.push({ thread, message: m });
      return thread;
    });
    return { file: out.length ? { ...cur, threads } : cur, out };
  });
  if (changed.length) emit({ taskId, kind: 'updated', ...(new Set(changed.map((c) => c.thread.id)).size === 1 ? { threadId: changed[0].thread.id } : {}) });
  return changed;
}

/** Whether any of this task's threads holds a reply not yet in its session. */
export async function hasOpenDeliveries(taskId: string): Promise<boolean> {
  return (await readThreads(taskId)).threads.some((t) => t.messages.some(deliveryOpen));
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

/** A task's own write on one of its threads; `fallback` when the thread refuses `patch` (a close he has not reacted to). */
export interface OwnThreadWrite { id: string; patch: ThreadPatch; fallback?: ThreadPatch }
/** A subject the task opens itself, in its own state (a hidden one too). */
export interface OwnThreadOpen { title: string; text: string; state: ThreadState }

/**
 * A task's own writes on its threads from its status answer (sessions/status-threads.ts), in one
 * locked write: `plan` reads the threads as they are under the lock. Nothing here hands a thread to
 * the user (a write into needs, or a reopen, is dropped), so the same-ask check of patchThread and
 * openNodeThread has nothing to check. A write its thread refuses is left out. One change event.
 */
export async function writeOwnThreads(
  taskId: string, plan: (cur: ThreadsFile) => { writes: OwnThreadWrite[]; opens: OwnThreadOpen[] }, by: ThreadWriter,
  ask?: { ask: TaskAsk | null; named?: string },
  /** Runs first under the same lock (the answer's splits, sessions/status-thread-split.ts): its threads, and the ids it changed. */
  pre?: (cur: ThreadsFile) => { file: ThreadsFile; out: string[] },
): Promise<string[]> {
  const at = new Date().toISOString();
  const handsToUser = (p: ThreadPatch) => p.state === 'needs' || !!p.reopen;
  const changed = await mutateThreads(taskId, (cur) => {
    const first = pre ? pre(cur) : { file: cur, out: [] };
    const own = writeOwn(first.file);
    const r = { file: own.file, out: [...new Set([...first.out, ...own.out])] };
    if (!ask) return r;
    // The report's ask goes on its thread in the same write, after the lines (thread-report-ask.ts).
    const placed = placeAsk(r.file, ask.ask, at, ask.named);
    if (placed === r.file) return r;
    const moved = placed.threads.filter((t, i) => t.reportAsk?.id !== r.file.threads[i]?.reportAsk?.id).map((t) => t.id);
    return { file: placed, out: [...new Set([...r.out, ...moved])] };
  });
  function writeOwn(cur: ThreadsFile): { file: ThreadsFile; out: string[] } {
    const { writes, opens } = plan(cur);
    let file = cur;
    const done: string[] = [];
    for (const w of writes) {
      for (const p of [w.patch, w.fallback]) {
        if (!p || handsToUser(p)) continue;
        // `line`: the state it moves is the answer's own (lineState), so a later answer may move it again.
        try { file = updateThread(file, w.id, p, by, at, undefined, { line: true }).file; done.push(w.id); break; } catch (err) { if (!(err instanceof ThreadError)) throw err; }
      }
    }
    const open = new Set(file.threads.filter((t) => !t.closed).map((t) => t.title.trim().toLowerCase()));
    for (const o of opens) {
      if (o.state === 'needs' || open.has(o.title.trim().toLowerCase())) continue;
      try {
        // A thread a node opens starts in his sight (openThread); it takes the task's state in the same write.
        const r = openThread(file, { title: o.title, text: o.text, from: 'node', state: 'answered' }, by, at);
        file = o.state === 'answered' ? r.file : updateThread(r.file, r.thread.id, { state: o.state }, by, at, undefined, { line: true }).file;
        open.add(o.title.trim().toLowerCase());
        done.push(r.thread.id);
      } catch (err) { if (!(err instanceof ThreadError)) throw err; }
    }
    return { file: done.length ? file : cur, out: done };
  }
  if (changed.length) emit({ taskId, kind: 'updated', ...(changed.length === 1 ? { threadId: changed[0] } : {}) });
  return changed;
}

/** The task's ask placed on its thread on its own, or (null) its places taken off (thread-report-ask.ts keepAskOnThread); true when it wrote. */
export async function placeTaskAsk(taskId: string, ask: TaskAsk | null): Promise<boolean> {
  if (isFollower()) return false;
  const at = new Date().toISOString();
  const moved = await mutateThreads(taskId, (cur) => {
    const placed = placeAsk(cur, ask, at);
    return { file: placed, out: placed === cur ? [] : placed.threads.filter((t, i) => t.reportAsk?.id !== cur.threads[i]?.reportAsk?.id).map((t) => t.id) };
  });
  if (moved.length) emit({ taskId, kind: 'updated', ...(moved.length === 1 ? { threadId: moved[0] } : {}) });
  return moved.length > 0;
}

/** The primary's sweep: every node's closed threads past their week are deleted for good. */
export async function sweepClosedThreads(now = Date.now()): Promise<number> {
  if (isFollower()) return 0;
  const db = await useThreadsDb();
  let dropped = 0;
  const at = new Date(now).toISOString();
  for (const taskId of await threadTaskIds()) {
    // The database never loads a closed thread past its week: the sweep deletes those rows itself.
    const gone = db ? await dbDropExpired(taskId, now) : 0;
    const n = gone + await mutateThreads(taskId, (cur) => {
      const r = sweepClosed(cur, at);
      return { file: r.file, out: r.dropped };
    });
    if (n) { dropped += n; emit({ taskId, kind: 'swept' }); }
  }
  return dropped;
}
