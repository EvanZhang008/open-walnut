/**
 * His Acknowledge means he knows, not that it is over (experiment ack_means_known; 2026-11-20, the
 * user: "I acknowledge it, but that does not mean the thread is gone. A human acknowledge means I
 * now know the situation; the thread is truly closed only when the problem is really solved"; then
 * "I ack, she sees it herself, nothing else, so it closes, right?").
 *
 * Where the card goes at his Acknowledge is one rule (thread-ack-outcome.ts ackOutcome): closed
 * when its result is delivered and nothing on its subject still runs or waits; otherwise (a task it
 * lists still working or waiting on its subject, his reply not yet in the node's session, a decision
 * letter on it still waiting) everything on it is known to him, it goes pending and records
 * `ackedAt` (thread-known.ts), and his Threads draw it under Working or Waiting / Snoozed. The node
 * hears it once, riding its next message (status-riding.ts), and may close it then without a fresh
 * reaction of his (threads-model.ts checkClose); a later answered on it is news on his card again.
 * When nothing holds it any more, the node hears that once too (`ackDone`, from the follow pass in
 * thread-follow.ts), and KNOWN_CLOSE_MS later Walnut settles a thread the node left: back to Done
 * with something new, else closed (settleKnown). Neither buzzes his phone.
 *
 * The pure parts take the file or the thread; the async ones read the store and the task list.
 */
import { log } from '../../logging/index.js';
import { experimentalEnabled } from '../experimental.js';
import { updateThread, type OrgThread, type ThreadsFile } from './threads-model.js';
import { deliverableLine } from '../task-deliverable.js';
import { ackOutcome, type AckOutcome, type AckTask } from './thread-ack-outcome.js';
import { isKnown, KNOWN_CLOSE_MS, knownStep, type AckWaits } from './thread-known.js';
import { sharedAnswers } from './thread-view.js';

export type { AckWaits } from './thread-known.js';

const q = (s: string): string => JSON.stringify(s);

export type { AckTask } from './thread-ack-outcome.js';

/**
 * What still holds `t` at his Acknowledge, given the tasks (by id) read from the store; null when
 * nothing does and it closes (thread-ack-outcome.ts ackOutcome; tests/core/org/thread-ack-answered-guard.test.ts). Pure.
 */
export function ackWaitsOf(t: OrgThread, tasks: ReadonlyMap<string, AckTask>): AckWaits | null {
  return ackOutcome(t, tasks).waits;
}

/** His Acknowledge on an open thread whose work still runs: all known by him, pending, the ack recorded. Pure. */
export function ackKnown(file: ThreadsFile, id: string, at: string): { file: ThreadsFile; thread: OrgThread } {
  const cur = file.threads.find((t) => t.id === id);
  const r = updateThread(file, id, { state: 'pending', ...(cur?.messages.length ? { known: 'all' } : {}) }, 'human', at);
  // Acknowledged: out of his sight like a close, so no pin or snooze of his holds it.
  const { pinned: _pin, snoozed: _snooze, ackDone: _done, ...rest } = r.thread;
  const thread: OrgThread = { ...rest, reactedAt: at, ackedAt: at };
  return { file: { ...r.file, threads: r.file.threads.map((t) => (t.id === id ? thread : t)) }, thread };
}

/** What the node hears once about his ack. */
export function ackLine(t: Pick<OrgThread, 'id' | 'title'>, w: AckWaits): string {
  const on = [
    ...w.tasks.map((x) => `${q(x.title)} (${x.id})`),
    ...(w.replies ? ['his reply on its way to you'] : []),
    ...(w.letter ? ['the decision its letter asks'] : []),
  ].join(', ');
  return `- He acknowledged thread ${t.id} ${q(t.title)}: he knows where it stands; it waits on ${on}. When it is really over, `
    + 'set it answered with the outcome only if there is something he has not seen (he closes it); otherwise close it yourself.';
}

const CLOSE_MIN = Math.round(KNOWN_CLOSE_MS / 60_000);

/** What the node hears once when nothing is open any more on a thread he acknowledged. */
export function ackDoneLine(t: Pick<OrgThread, 'id' | 'title'>): string {
  return `- Thread ${t.id} ${q(t.title)}, which he acknowledged while its work ran: nothing on it is open now. If the outcome holds something `
    + `he has not seen, set it answered with it once; otherwise close it. Left as it is, Walnut closes it in ${CLOSE_MIN} minutes.`;
}

export async function ackMeansKnownOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    return experimentalEnabled((await getConfig()).experimental, 'ack_means_known');
  } catch {
    return false;
  }
}

/** The tasks that are not COMPLETE, by id: what a thread's list is judged against (a COMPLETE one holds nothing). Pure. */
export function openTasksOf<T extends AckTask>(tasks: Iterable<T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const t of tasks) if (t.phase !== 'COMPLETE') out.set(t.id, t);
  return out;
}

/**
 * Before his Acknowledge of `threadId` is written: the open tasks it lists, read now; null when the
 * experiment is off, the thread is gone or closed, or he acknowledged it already (a second
 * Acknowledge closes it): the ack then closes as before.
 */
export async function ackOpenTasks(taskId: string, threadId: string): Promise<Map<string, AckTask> | null> {
  if (!(await ackMeansKnownOn())) return null;
  const { readThreads } = await import('./threads-store.js');
  const t = (await readThreads(taskId)).threads.find((x) => x.id === threadId);
  if (!t || t.closed || isKnown(t)) return null;
  if (!t.tasks?.length) return new Map();
  const want = new Set(t.tasks);
  const { listTasks } = await import('../task-manager.js');
  return openTasksOf((await listTasks()).filter((task) => want.has(task.id)));
}

/**
 * Each thread of a read he acknowledged with where it stands now and what holds it (projected,
 * never stored; thread-ack-outcome.ts ackOutcome): `ackGroup` the group it is drawn in (closed: its
 * work is over and the follow pass closes it), `awaits` each task with what it is to finish (its
 * deliverable line); nothing holding it: empty lists.
 */
export function withAwaits<T extends OrgThread>(threads: readonly T[], tasks: readonly AckTask[]): Array<T & { awaits?: AckWaits; ackGroup?: AckOutcome }> {
  if (!threads.some(isKnown)) return [...threads];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const open = openTasksOf(tasks);
  return threads.map((t) => {
    if (!isKnown(t)) return t;
    const r = ackOutcome(t, open);
    const w = r.waits ?? { tasks: [], replies: false, letter: false };
    return { ...t, ackGroup: r.outcome, awaits: { ...w, tasks: w.tasks.map((x) => withWhat(x, byId.get(x.id))) } };
  });
}

/** withAwaits over the task store, read only when a thread was acknowledged at work; never throws (the read keeps its threads). */
export async function withKnownAwaits<T extends OrgThread>(threads: readonly T[]): Promise<Array<T & { awaits?: AckWaits; ackGroup?: AckOutcome }>> {
  if (!threads.some(isKnown)) return [...threads];
  try {
    const { listTasks } = await import('../task-manager.js');
    return withAwaits(threads, await listTasks());
  } catch (err) {
    log.task.warn('org threads: known awaits not read', { error: err instanceof Error ? err.message : String(err) });
    return [...threads];
  }
}

const WHAT_MAX = 160;

/** A task it waits on, with what it is to finish when that says more than its title. */
function withWhat(x: AckWaits['tasks'][number], task: { title?: string; description?: string; note?: string } | undefined): AckWaits['tasks'][number] {
  const line = task ? deliverableLine(task) : '';
  if (!line || line === x.title.trim()) return x;
  return { ...x, what: line.length <= WHAT_MAX ? line : `${line.slice(0, WHAT_MAX - 1).trimEnd()}\u2026` };
}

/** One line riding the node's next message (never a wake). One item per thread: a newer line replaces one unread. */
export async function rideToNode(taskId: string, threadId: string, line: string): Promise<boolean> {
  try {
    const { leadSession } = await import('./org-store.js');
    const s = await leadSession(taskId);
    if (!s) return false;
    const { rideLine } = await import('../sessions/status-riding.js');
    return rideLine(s.claudeSessionId, `thread-ack:${threadId}`, line);
  } catch (err) {
    log.task.warn('org threads: ack line not kept', { taskId, threadId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Every node's Known threads (thread-known.ts): the follow pass watches their tasks and settles them.
 * Not behind the flag: a thread acknowledged while it was on is settled after it went off, never left
 * Known for good.
 */
export async function ackedThreads(): Promise<KnownOnNode[]> {
  const { listThreadNodes, readThreads } = await import('./threads-store.js');
  const out: KnownOnNode[] = [];
  for (const node of await listThreadNodes()) {
    const all = (await readThreads(node)).threads;
    const threads = all.filter(isKnown);
    if (threads.length) out.push({ node, threads, all });
  }
  return out;
}

/** A node's Known threads, and all its threads as read with them (news is judged over all: sharedAnswers). */
export interface KnownOnNode { node: string; threads: OrgThread[]; all?: readonly OrgThread[] }

export interface KnownSettled {
  /** The node heard that nothing is open any more. */
  told: number;
  /** Back to Done with what the node wrote and left pending. */
  shown: number;
  /** Closed by Walnut, nothing new on them. */
  closed: number;
  /** When the next of them is due to settle (ms), for the follow pass's timer. */
  nextAt?: number;
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b![i]);

/**
 * The Known threads' step now (thread-known.ts knownStep), given the open tasks (by id) read
 * from the whole task store (listTasks, as at the ack): the node hears once when their waits end
 * (stamped `ackDone`, told or not: nobody to tell is no reason to keep it), and KNOWN_CLOSE_MS later
 * Walnut shows or closes the ones the node left. Each write is checked again under the lock against
 * the thread as it is then, and a thread whose task list changed since `acked` was read waits for
 * the next pass (a task added meanwhile is not in `openTasks`). The node is told only of what was
 * written. Never buzzes: only a move into needs does (push/thread-push.ts). `now` is the test seam.
 */
export async function settleKnown(acked: ReadonlyArray<KnownOnNode>, openTasks: ReadonlyMap<string, AckTask>, now: number = Date.now()): Promise<KnownSettled> {
  const out: KnownSettled = { told: 0, shown: 0, closed: 0 };
  const { writeThreadsFor } = await import('./threads-store.js');
  const stepOf = (t: OrgThread, all: readonly OrgThread[]) => knownStep(t, !!ackWaitsOf(t, openTasks), now, sharedAnswers(all));
  for (const { node, threads, all } of acked) {
    const steps = new Map<string, { step: ReturnType<typeof knownStep>; tasks?: string[] }>();
    for (const t of threads) {
      const step = stepOf(t, all ?? threads);
      if (step !== 'none' && step !== 'wait') steps.set(t.id, { step, ...(t.tasks ? { tasks: t.tasks } : {}) });
      const due = step === 'tell' ? now + KNOWN_CLOSE_MS : step === 'wait' && t.ackDone ? Date.parse(t.ackDone) + KNOWN_CLOSE_MS : NaN;
      if (Number.isFinite(due) && (out.nextAt === undefined || due < out.nextAt)) out.nextAt = due;
    }
    if (!steps.size) continue;
    const at = new Date(now).toISOString();
    const done = await writeThreadsFor(node, (cur) => {
      const did: Array<{ id: string; title: string; step: ReturnType<typeof knownStep> }> = [];
      const threadsNow = cur.threads.map((t) => {
        const want = steps.get(t.id);
        // Only the step still due on the thread as it is now: he or the node may have moved it meanwhile.
        if (!want || !sameList(t.tasks, want.tasks) || stepOf(t, cur.threads) !== want.step) return t;
        did.push({ id: t.id, title: t.title, step: want.step });
        return settled(t, want.step, at);
      });
      // One change event for the node's list: a client reads the whole list again on it.
      const seen = did.find((d) => d.step === 'show' || d.step === 'close');
      return { file: { ...cur, threads: threadsNow }, out: did, ...(seen ? { changed: { kind: 'updated' as const, threadId: seen.id } } : {}) };
    });
    for (const d of done) {
      if (d.step === 'tell') { out.told++; await rideToNode(node, d.id, ackDoneLine(d)); }
      else if (d.step === 'show') out.shown++;
      else if (d.step === 'close') out.closed++;
    }
    if (done.length) log.task.info('org threads: known threads settled', { taskId: node, threads: done.map(({ id, step }) => ({ id, step })) });
  }
  return out;
}

/** One Known thread after its step. Quiet for tell and rewait: nothing he sees changed. */
function settled(t: OrgThread, step: ReturnType<typeof knownStep>, at: string): OrgThread {
  if (step === 'tell') return { ...t, ackDone: at };
  if (step === 'rewait') { const { ackDone: _d, ...rest } = t; return rest; }
  if (step === 'show') return { ...t, state: 'answered', updatedAt: at, by: 'agent' };
  // Closed as his own Acknowledge already covered it (`reacted`): real news from the node opens it again.
  const { options: _o, snoozed: _s, pinned: _p, ...rest } = t;
  return { ...rest, closed: { how: 'acked', at, by: 'agent', reacted: true }, updatedAt: at, by: 'agent' };
}
