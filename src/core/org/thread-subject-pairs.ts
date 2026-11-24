/**
 * A node's own thread and a thread of a task it names, on one subject: one card for him, never two
 * (2026-11-24, the user: "why the fuck there are so many dupciated thread"; the threads inspection,
 * item 4: his VP held 22 open threads naming six tasks below it, those six held 29 of their own, and
 * a result on a task below never reached the VP where he had asked, since only Needs you pops up).
 *
 * For each task the node's open threads name (and a task under one of them that asks him on a thread
 * of its own), each of that task's own threads is paired with the node's thread naming that task
 * whose title is nearest (nearestCard: the same telling words as the same-subject rule, at least
 * RESULT_SHARED, more than any other, standing in RESULT_PLACES places of the title). Then:
 *   asking    the task's thread asks him now (needs): the node's result on that subject waits
 *             behind it (`askedIn` via thread), only a result the node wrote while it asked;
 *   answered  he answered there: the node's result stays quiet until the node writes it again;
 *   carried   (`carry`, experiment threads_pop_up) the task's thread holds a result for him newer
 *             than anything the node wrote on its thread: that result is listed above the node
 *             (thread-popup.ts, with `carries`), and the node's thread waits behind it;
 *   read      he read that result there (his reaction, his Acknowledge, whatever state that left it
 *             in): the node's thread stays quiet until the node writes it again.
 * Asking outranks a carried result, which outranks a quiet one. A node's thread he sees now (news
 * of its own unread, his word unanswered past the reminder), or with a word of his newer than the
 * task's result, never waits behind it: the
 * result is listed beside it, so a pairing on a few shared words can add a card, never hide one
 * (2026-11-24 review: "mark the margins live + revert the status icon" paired with "status icon:
 * reverted" would have hidden the margins). Pure.
 */
import { sameTaskArea, type AreaScoped } from '../router/same-area.js';
import { shownToHim, threadReactionAt, type ThreadAskedIn } from './thread-view.js';
import type { OrgThread } from './threads-model.js';
import { candidatesIn, sharedPlaces, subjectIndex, type SubjectIndex } from './thread-same-subject.js';
import type { AskPointerFacts, AskTask, OwnThread } from './thread-task-ask.js';

/** Up the parent chain this far: a subtask's subtask under a linked task (subtasks go 3 levels deep). */
const BELOW_DEPTH = 4;

/** The task's status says a thread of its own waits on him now (user-status.ts taskThreadNeeds). */
export const asksOnThread = (t: AskTask): boolean => t.phase !== 'COMPLETE' && t.status !== 'done' && t.user_status?.state === 'needs' && t.user_status.source === 'thread';

/** A result a task's own thread may hold: open, waiting to be read, linked to tasks, written in the last week. */
const RESULT_RECENT_MS = 7 * 24 * 3_600_000;
export const heldCandidate = (t: Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'updatedAt'>, now: number): boolean =>
  !t.closed && t.state === 'answered' && !!t.tasks?.length && now - Date.parse(t.updatedAt) <= RESULT_RECENT_MS;

/** A thread of the node a carried result may answer: open, not asking him itself, linked to tasks. */
const carryCandidate = (t: Pick<OrgThread, 'closed' | 'state' | 'tasks'>): boolean => !t.closed && t.state !== 'needs' && !!t.tasks?.length;

/**
 * The tasks whose own Threads may hold this thread: the ones it lists, and a task under one of them
 * whose status says a thread of its own waits on him (a subtask asking for the work its lead's
 * thread names; no file is read for the rest). In the node's area, never the node. Pure.
 */
function ownThreadTasks(t: Pick<OrgThread, 'tasks'>, node: AreaScoped, byId: ReadonlyMap<string, AskTask>): AskTask[] {
  const named = new Set((t.tasks ?? []).filter((id) => id !== node.id));
  if (!named.size) return [];
  const out: AskTask[] = [];
  for (const task of byId.values()) {
    if (task.id === node.id || !sameTaskArea(node, task)) continue;
    if (named.has(task.id)) { out.push(task); continue; }
    if (!asksOnThread(task)) continue;
    let up = task.parent_task_id ? byId.get(task.parent_task_id) : undefined;
    for (let i = 0; up && i < BELOW_DEPTH; i++) {
      if (named.has(up.id)) { out.push(task); break; }
      up = up.parent_task_id ? byId.get(up.parent_task_id) : undefined;
    }
  }
  return out;
}

/** Files read for one node's pairs at most: the tasks of its newest threads first. */
const OWN_THREAD_TASKS_MAX = 40;

/** The node's threads whose linked tasks are read: its results, and with `carry` every open one that is not asking. */
const pairedThreads = <T extends Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'updatedAt'>>(threads: readonly T[], now: number, carry: boolean): T[] =>
  threads.filter((t) => heldCandidate(t, now) || (carry && carryCandidate(t)));

/** The tasks whose Threads subjectPairs reads for these threads (ownThreadTasks of each paired thread), newest first. Pure. */
export function ownThreadTaskIds(node: AreaScoped, threads: readonly Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'updatedAt'>[], tasks: readonly AskTask[], now: number = Date.now(), carry = false): Set<string> {
  const ids = new Set<string>();
  const paired = pairedThreads(threads, now, carry).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!paired.length) return ids;
  const byId = new Map(tasks.map((x) => [x.id, x] as const));
  for (const t of paired) {
    for (const task of ownThreadTasks(t, node, byId)) if (ids.size < OWN_THREAD_TASKS_MAX) ids.add(task.id);
  }
  return ids;
}

/** When he last wrote on a thread. */
const hisLastAt = (x: OwnThread): string => x.messages.reduce((last, m) => (m.at > last ? m.at : last), '');

/** When the node last wrote a thread for him: handed it to him (`needsAt`) or wrote its summary (`replyAt`). */
const lastWrittenAt = (t: Partial<Pick<OrgThread, 'needsAt' | 'replyAt' | 'createdAt'>>): string =>
  [t.needsAt, t.replyAt].filter((x): x is string => !!x).sort().pop() ?? t.createdAt ?? '';

/** The task's thread asked him and he wrote on it since: it asks nothing now. */
const answeredThere = (x: OwnThread): boolean => x.state !== 'needs' && !!x.needsAt && hisLastAt(x) > x.needsAt;

/** When he last showed he read a thread: his reaction there, his Acknowledge (a human known mark or close). */
const seenThereAt = (x: OwnThread): string =>
  [threadReactionAt(x), x.known?.by === 'human' ? x.known.at : undefined, x.closed?.by === 'human' ? x.closed.at : undefined]
    .filter((v): v is string => !!v).sort().pop() ?? '';

/**
 * The task's thread held a result and he read it there: a summary, and his reaction or Acknowledge
 * after its last write. His Acknowledge leaves it pending, closed or answered (thread-ack.ts ackKnown):
 * the state says nothing of it.
 */
const readThere = (x: OwnThread): boolean => !!x.reply?.trim() && seenThereAt(x) > lastWrittenAt(x);

/**
 * A result `after` may stand for the node's thread `t`: `t` is out of his sight now (nothing of its
 * own unread, no word of his left unanswered past the reminder), and no word of his on `t` is newer.
 * A card he sees stays, beside the result (review 2: an overdue card's unanswered question was hidden
 * behind a result of the same task on another subject, and its reminder stopped).
 */
const waitsBehind = (t: OrgThread, after: string, now: number): boolean => !shownToHim(t, undefined, now) && hisLastAt(t as OwnThread) < after;

/** A result is paired on this many shared telling words with the task's thread, standing in this many places of its title. */
const RESULT_SHARED = 3;
const RESULT_PLACES = 2;

/**
 * The node's thread among `mine` (its threads naming that task) whose title is nearest `title`:
 * the most shared telling words, RESULT_SHARED at least and more than any other (a tie pairs none),
 * standing in RESULT_PLACES places of the title (the area's name alone is one place). Pure.
 */
export function nearestCard<T extends OrgThread>(index: SubjectIndex, title: string, mine: ReadonlyMap<string, T>): T | undefined {
  const [best, next] = candidatesIn(index, title).filter((c) => mine.has(c.id));
  const t = best ? mine.get(best.id) : undefined;
  if (!best || !t || best.shared < RESULT_SHARED || next?.shared === best.shared) return undefined;
  return sharedPlaces(title, t.title) >= RESULT_PLACES ? t : undefined;
}

/** A result of a task below listed above the node on the subject of the node's own thread `carries`. */
export interface CarriedResult { thread: OwnThread; task: AskTask; carries: string }

const RANK = { asking: 3, carried: 2, quiet: 1 } as const;
const rankOf = (p: ThreadAskedIn): number => (p.result && !p.answered ? RANK.carried : p.answered ? RANK.quiet : RANK.asking);

/** The pairs of the node's threads with its tasks' own threads (see the file's comment): what waits behind which, and the results listed above it. Pure. */
export function subjectPairs<T extends OrgThread>(node: AreaScoped, threads: readonly T[], byId: ReadonlyMap<string, AskTask>, facts: AskPointerFacts): { held: Map<string, ThreadAskedIn>; carried: CarriedResult[] } {
  const held = new Map<string, ThreadAskedIn>();
  const carried: CarriedResult[] = [];
  const now = facts.nowMs ?? Date.now();
  const carry = !!facts.carry;
  if (!facts.threadsOf || !pairedThreads(threads, now, carry).length) return { held, carried };
  const hold = (id: string, p: ThreadAskedIn): void => {
    const was = held.get(id);
    if (!was || rankOf(p) > rankOf(was)) held.set(id, p);
  };
  // Per task a paired thread names: every open thread of the node linked to it. The nearest of them
  // is the task's subject, whatever its state.
  const byTask = new Map<string, { task: AskTask; mine: Map<string, T> }>();
  for (const t of pairedThreads(threads, now, carry)) {
    for (const task of ownThreadTasks(t, node, byId)) {
      const row = byTask.get(task.id) ?? { task, mine: new Map<string, T>() };
      row.mine.set(t.id, t);
      byTask.set(task.id, row);
    }
  }
  for (const t of threads) {
    if (t.closed) continue;
    for (const id of t.tasks ?? []) byTask.get(id)?.mine.set(t.id, t);
  }
  const index = subjectIndex([{ task: { id: node.id, title: '' }, threads }], now);
  for (const { task, mine } of byTask.values()) {
    // Only his words newer than a result linked to this task can hold one: older threads are not scored.
    const oldest = [...mine.values()].filter((t) => heldCandidate(t, now)).map(lastWrittenAt).sort()[0];
    const open = task.phase !== 'COMPLETE' && task.status !== 'done';
    for (const x of facts.threadsOf(task.id) ?? []) {
      if (x.movedTo) continue;
      const asking = open && !x.closed && x.state === 'needs';
      // A result for him there outranks his answer there: it is news since.
      const result = carry && !x.closed && x.state === 'answered' && shownToHim(x, undefined, now);
      const answered = !asking && !result && oldest !== undefined && answeredThere(x) && hisLastAt(x) > oldest;
      const read = !asking && !answered && !result && carry && readThere(x);
      if (!asking && !answered && !result && !read) continue;
      const t = nearestCard(index, x.title, mine);
      if (!t) continue;
      const p: ThreadAskedIn = { task: task.id, title: task.title, ask: x.title, via: 'thread', thread: x.id };
      if (asking || answered) {
        // A result written before the task asked is not about its ask: it was in his view then and stays there.
        if (!heldCandidate(t, now) || !x.needsAt || lastWrittenAt(t) < x.needsAt) continue;
        if (asking) hold(t.id, p);
        else if (hisLastAt(x) > lastWrittenAt(t)) hold(t.id, { ...p, answered: true });
        continue;
      }
      // A result older than what the node wrote on its own thread is not news over it.
      if (lastWrittenAt(x) <= lastWrittenAt(t)) continue;
      if (!carryCandidate(t)) continue;
      if (result) {
        carried.push({ thread: x, task, carries: t.id });
        if (waitsBehind(t, lastWrittenAt(x), now)) hold(t.id, { ...p, result: true });
      } else if (seenThereAt(x) > lastWrittenAt(t) && waitsBehind(t, seenThereAt(x), now)) {
        hold(t.id, { ...p, result: true, answered: true });
      }
    }
  }
  return { held, carried };
}

/** The node's threads that wait behind a task's own thread (subjectPairs `held`), by thread id. Pure. */
export function heldResults<T extends OrgThread>(node: AreaScoped, threads: readonly T[], byId: ReadonlyMap<string, AskTask>, facts: AskPointerFacts): Map<string, ThreadAskedIn> {
  return subjectPairs(node, threads, byId, facts).held;
}
