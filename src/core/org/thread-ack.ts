/**
 * His Acknowledge means he knows, not that it is over (experiment ack_means_known; 2026-11-20, the
 * user: "I acknowledge it, but that does not mean the thread is gone. A human acknowledge means I
 * now know the situation; the thread is truly closed only when the problem is really solved"; then
 * "if I ack and ai should determine if it should go to closed or wait or wip").
 *
 * His Acknowledge on an open thread sends it at once to Acknowledged (thread-known.ts): pending,
 * everything on it known to him, `ackedAt` recorded. The node hears it once, riding its next
 * message (status-riding.ts), with Walnut's own reading (thread-ack-outcome.ts ackOutcome), and
 * decides with thread_update `place` (closed, waiting with what it waits on, or working) and
 * `place_why` (ackPlace; threads-store.ts patchThread). Not decided KNOWN_CLOSE_MS after his ack,
 * Walnut places it by the rule and logs it (settleKnown, from the follow pass in thread-follow.ts).
 * One Walnut placed is settled when nothing holds it any more: the node hears that once
 * (`ackDone`), and KNOWN_CLOSE_MS later it is back to Done with something new, else closed. His
 * second Acknowledge closes it. Neither buzzes his phone.
 *
 * The pure parts take the file or the thread; the async ones read the store and the task list.
 */
import { log } from '../../logging/index.js';
import { experimentalEnabled } from '../experimental.js';
import { ThreadError, updateThread, type OrgThread, type ThreadPatch, type ThreadsFile, type ThreadWriter } from './threads-model.js';
import { deliverableLine } from '../task-deliverable.js';
import { ackOutcome, ackWhy, type AckOutcome, type AckReading, type AckTask } from './thread-ack-outcome.js';
import { ACK_PLACES, ackHoldsResult, isKnown, KNOWN_CLOSE_MS, knownStep, placedSinceAck, type AckPlace, type AckWaits } from './thread-known.js';
import { hasThreadNews, PLACE_WHY_MAX, sharedAnswers, snoozedNow, watchedNow } from './thread-view.js';

export type { AckWaits } from './thread-known.js';

const q = (s: string): string => JSON.stringify(s);

export type { AckTask } from './thread-ack-outcome.js';
// Walnut's reading at his Acknowledge, what the node hears (threads-store.ts patchThread).
export { ackOutcome } from './thread-ack-outcome.js';
export { isKnown } from './thread-known.js';

/**
 * What still holds `t` at his Acknowledge, given the tasks (by id) read from the store; null when
 * nothing does and it closes (thread-ack-outcome.ts ackOutcome; tests/core/org/thread-ack-answered-guard.test.ts). Pure.
 */
export function ackWaitsOf(t: OrgThread, tasks: ReadonlyMap<string, AckTask>): AckWaits | null {
  return ackOutcome(t, tasks).waits;
}

/** His Acknowledge on an open thread: all known by him, pending, the ack recorded: in Acknowledged until placed. Pure. */
export function ackKnown(file: ThreadsFile, id: string, at: string): { file: ThreadsFile; thread: OrgThread } {
  const cur = file.threads.find((t) => t.id === id);
  const r = updateThread(file, id, { state: 'pending', ...(cur?.messages.length ? { known: 'all' } : {}) }, 'human', at);
  // Acknowledged: out of his sight like a close, so no snooze of his holds it; a placement of an
  // earlier ack is gone. His watch stays: he follows the subject on, whatever group it is in.
  const { snoozed: _snooze, ackDone: _done, ackPlaced: _placed, ...rest } = r.thread;
  // Acknowledged with its result on it (answered, needs): that result is his, and no status line shows it again (thread-known.ts ackHoldsResult).
  const thread: OrgThread = { ...rest, reactedAt: at, ackedAt: at, ackedResult: !!cur && (cur.state === 'answered' || cur.state === 'needs') };
  return { file: { ...r.file, threads: r.file.threads.map((t) => (t.id === id ? thread : t)) }, thread };
}

const CLOSE_MIN = Math.round(KNOWN_CLOSE_MS / 60_000);

const PLACE_HINT: Record<AckOutcome, string> = {
  closed: 'nothing on it is still open, so it closes',
  waiting: 'it waits',
  working: 'work on it still runs',
};

/** What the node hears once about his ack: decide where it goes, with Walnut's own reading of it. */
export function ackLine(t: Pick<OrgThread, 'id' | 'title'>, r: AckReading): string {
  const w = r.waits;
  const on = w ? [
    ...w.tasks.map((x) => `${q(x.title)} (${x.id})`),
    ...(w.replies ? ['his reply on its way to you'] : []),
    ...(w.letter ? ['the decision its letter asks'] : []),
  ].join(', ') : '';
  return `- He acknowledged thread ${t.id} ${q(t.title)}: he knows where it stands, and his card reads "AI is deciding where this goes". `
    + 'Decide now with thread_update place (closed when it is over, waiting with what it waits on, working while work on it runs) and place_why, '
    + `one short line his card shows. Walnut reads it as ${r.outcome}: ${PLACE_HINT[r.outcome]}${on ? ` (${on})` : ''}; `
    + `left undecided, Walnut places it there in ${CLOSE_MIN} minutes.`;
}

/** What may ride with a `place`: nothing that changes what his card says or where it goes. */
const PLACE_WITH = new Set(['title', 'known']);

/**
 * The node's `place` and `place_why`, checked before any write: one of ACK_PLACES with a why
 * (trimmed to one line); never his (his Acknowledge is the ack), and alone but for a title or
 * known (a state, reply or close of its own would say something else). Pure; throws ThreadError.
 */
export function checkPlace(by: ThreadWriter, place: unknown, why: unknown, rest: ThreadPatch): { to: AckPlace; why: string } {
  if (by === 'human') throw new ThreadError('bad_input', 400, 'place is the node\'s decision on a thread he acknowledged; his own Acknowledge is close: acked.');
  const extra = Object.keys(rest).filter((k) => !PLACE_WITH.has(k) && (rest as Record<string, unknown>)[k] !== undefined);
  if (extra.length) throw new ThreadError('bad_input', 400, `place already says where it goes: send it with place_why alone (a title or known may ride along), not with ${extra.join(', ')}.`);
  if (typeof place !== 'string' || !(ACK_PLACES as readonly string[]).includes(place)) throw new ThreadError('bad_input', 400, `place must be one of ${ACK_PLACES.join(', ')}.`);
  const w = typeof why === 'string' ? why.replace(/\s+/g, ' ').trim() : '';
  if (!w) throw new ThreadError('bad_input', 400, 'place needs place_why: one short line his card shows (what it waits on, what still runs, or why it is over).');
  return { to: place as AckPlace, why: w.length <= PLACE_WHY_MAX ? w : `${w.slice(0, PLACE_WHY_MAX - 1).trimEnd()}\u2026` };
}

/**
 * Under the lock, after the node's write on `before` made `next` (a `place: closed` went through
 * updateThread as its close, so every close check holds: his watch, a reply still on its way): its
 * place is recorded only on a thread he acknowledged and wrote nothing in since (isKnown); a close
 * of its own on one is its decision too, recorded so the closed card says so. Anything else is
 * `next` as it is. Pure; throws ThreadError for a place on any other thread.
 */
export function nodePlaced(before: OrgThread | undefined, next: OrgThread, placing: { to: AckPlace; why: string } | null, at: string): OrgThread {
  // Also one a status line brought back to Done after his Acknowledge, before that was refused
  // (2026-11-23: a node's place was refused on such cards): his Acknowledge still holds (ackHoldsResult).
  const known = !!before && !before.closed && (isKnown(before) || (before.state === 'answered' && ackHoldsResult(before)));
  if (placing && !known) {
    throw new ThreadError('bad_input', 409, 'place is only for a thread he acknowledged and has not written in since (in Acknowledged, or placed from it); set its state instead.');
  }
  if (!known || (!placing && !(next.closed && !before!.closed))) return next;
  if (next.closed) return { ...next, ackPlaced: { to: 'closed', by: 'node', at, ...(placing ? { why: placing.why } : {}) } };
  return ackPlace(next, placing!.to, 'node', placing!.why, at);
}

/**
 * `t` placed from Acknowledged (or re-placed while it stays acknowledged): waiting and working keep
 * it pending with `ackPlaced`; closed closes it as his own Acknowledge already covered it (`reacted`:
 * real news from the node opens it again). Pure.
 */
export function ackPlace(t: OrgThread, to: AckPlace, by: 'node' | 'walnut', why: string | undefined, at: string): OrgThread {
  const ackPlaced = { to, by, at, ...(why ? { why } : {}) };
  // Back in Done by a line after his Acknowledge: placed, it is out of his sight again.
  if (to !== 'closed') return { ...t, ...(t.state === 'answered' ? { state: 'pending' as const } : {}), ackPlaced, updatedAt: at, by: 'agent' };
  const { options: _o, snoozed: _s, ...rest } = t;
  return { ...rest, ackPlaced, closed: { how: 'acked', at, by: 'agent', reacted: true }, updatedAt: at, by: 'agent' };
}

/** What the node hears once when nothing is open any more on a thread he acknowledged. */
export function ackDoneLine(t: Pick<OrgThread, 'id' | 'title'>): string {
  return `- Thread ${t.id} ${q(t.title)}, which he acknowledged while its work ran: nothing on it is open now. If the outcome holds something `
    + `he has not seen, write it with thread_update (state answered and the outcome) once; otherwise close it. Left as it is, Walnut closes it in ${CLOSE_MIN} minutes.`;
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
 * Before his Acknowledge of `threadId` is written: the open tasks it lists, read now (for Walnut's
 * reading the node hears); null when the experiment is off, the thread is gone or closed, or he
 * acknowledged it already (a second Acknowledge closes it): the ack then closes as before.
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
 * Each thread of a read he acknowledged with what holds it now (projected, never stored;
 * thread-ack-outcome.ts ackOutcome): `awaits` each task with what it is to finish (its deliverable
 * line); nothing holding it: empty lists.
 */
export function withAwaits<T extends OrgThread>(threads: readonly T[], tasks: readonly AckTask[]): Array<T & { awaits?: AckWaits }> {
  if (!threads.some(isKnown)) return [...threads];
  const byId = new Map(tasks.map((t) => [t.id, t] as const));
  const open = openTasksOf(tasks);
  return threads.map((t) => {
    if (!isKnown(t)) return t;
    const w = ackOutcome(t, open).waits ?? { tasks: [], replies: false, letter: false };
    return { ...t, awaits: { ...w, tasks: w.tasks.map((x) => withWhat(x, byId.get(x.id))) } };
  });
}

/** withAwaits over the task store, read only when a thread was acknowledged at work; never throws (the read keeps its threads). */
export async function withKnownAwaits<T extends OrgThread>(threads: readonly T[]): Promise<Array<T & { awaits?: AckWaits }>> {
  if (!threads.some(isKnown)) return [...threads];
  try {
    const { taskStoreSnapshot } = await import('../task-manager.js');
    return withAwaits(threads, await taskStoreSnapshot());
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
  /** Placed by Walnut's rule: the node had not decided KNOWN_CLOSE_MS after his ack. */
  placed: number;
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

/** A step as it is written: `place` resolved by the rule to where it goes (show when it would close with news on it). */
type Settle = { step: 'rewait' | 'tell' | 'show' | 'close' } | { step: 'place'; to: AckPlace; why: string };

/** What `step` writes on `t` now, given the open tasks; null for none and wait. Pure. */
function settleOf(t: OrgThread, step: ReturnType<typeof knownStep>, openTasks: ReadonlyMap<string, AckTask>, now: number, shared: ReadonlySet<string>): Settle | null {
  if (step === 'none' || step === 'wait') return null;
  if (step !== 'place') return { step };
  const r = ackOutcome(t, openTasks);
  if (r.outcome !== 'closed') return { step: 'place', to: r.outcome, why: ackWhy(r) };
  if (hasThreadNews(t, shared)) return { step: 'show' };
  // He watches or snoozed it: it stays in his hands, waiting, and settles as Walnut's waiting one does.
  if (watchedNow(t)) return { step: 'place', to: 'waiting', why: 'nothing on it is open; you watch it' };
  if (snoozedNow(t, now)) return { step: 'place', to: 'waiting', why: 'nothing on it is open; you snoozed it' };
  return { step: 'place', to: 'closed', why: ackWhy(r) };
}

/**
 * The acknowledged threads' step now (thread-known.ts knownStep), given the open tasks (by id) read
 * from the whole task store (listTasks, as at the ack): one the node has not placed
 * KNOWN_CLOSE_MS after his ack is placed by the rule (thread-ack-outcome.ts ackOutcome, one log
 * line); one Walnut placed is settled when its waits end: the node hears it once (stamped
 * `ackDone`, told or not: nobody to tell is no reason to keep it), and KNOWN_CLOSE_MS later Walnut
 * shows or closes it. Each write is checked again under the lock against the thread as it is then,
 * and a thread whose task list changed since `acked` was read waits for the next pass (a task added
 * meanwhile is not in `openTasks`). The node is told only of what was written. Never buzzes: only a
 * move into needs does (push/thread-push.ts). `now` is the test seam.
 */
export async function settleKnown(acked: ReadonlyArray<KnownOnNode>, openTasks: ReadonlyMap<string, AckTask>, now: number = Date.now()): Promise<KnownSettled> {
  const out: KnownSettled = { placed: 0, told: 0, shown: 0, closed: 0 };
  const { writeThreadsFor } = await import('./threads-store.js');
  const settleNow = (t: OrgThread, all: readonly OrgThread[]): Settle | null => {
    const shared = sharedAnswers(all);
    return settleOf(t, knownStep(t, !!ackWaitsOf(t, openTasks), now, shared), openTasks, now, shared);
  };
  const same = (a: Settle | null, b: Settle): boolean => !!a && a.step === b.step && (a.step !== 'place' || (b.step === 'place' && a.to === b.to));
  for (const { node, threads, all } of acked) {
    const steps = new Map<string, { want: Settle; tasks?: string[] }>();
    for (const t of threads) {
      const want = settleNow(t, all ?? threads);
      if (want) steps.set(t.id, { want, ...(t.tasks ? { tasks: t.tasks } : {}) });
      const due = dueAt(t, want, now);
      if (Number.isFinite(due) && (out.nextAt === undefined || due < out.nextAt)) out.nextAt = due;
    }
    if (!steps.size) continue;
    const at = new Date(now).toISOString();
    const done = await writeThreadsFor(node, (cur) => {
      const did: Array<{ id: string; title: string; s: Settle }> = [];
      const threadsNow = cur.threads.map((t) => {
        const got = steps.get(t.id);
        // Only the step still due on the thread as it is now: he or the node may have moved it meanwhile.
        if (!got || !sameList(t.tasks, got.tasks) || !same(settleNow(t, cur.threads), got.want)) return t;
        did.push({ id: t.id, title: t.title, s: got.want });
        return settled(t, got.want, at);
      });
      // One change event for the node's list: a client reads the whole list again on it.
      const seen = did.find((d) => d.s.step === 'show' || d.s.step === 'close' || d.s.step === 'place');
      return { file: { ...cur, threads: threadsNow }, out: did, ...(seen ? { changed: { kind: 'updated' as const, threadId: seen.id } } : {}) };
    });
    for (const d of done) {
      if (d.s.step === 'tell') { out.told++; await rideToNode(node, d.id, ackDoneLine(d)); }
      else if (d.s.step === 'place') {
        out.placed++;
        log.task.info('org threads: acknowledged thread placed by the rule, the node had not decided', { taskId: node, threadId: d.id, to: d.s.to, why: d.s.why });
      }
      else if (d.s.step === 'show') out.shown++;
      else if (d.s.step === 'close') out.closed++;
    }
    if (done.length) log.task.info('org threads: known threads settled', { taskId: node, threads: done.map(({ id, s }) => ({ id, step: s.step })) });
  }
  return out;
}

/** When `t` is next due: the end of its time in Acknowledged, or KNOWN_CLOSE_MS after its waits ended (NaN: nothing timed). */
function dueAt(t: OrgThread, want: Settle | null, now: number): number {
  if (want?.step === 'tell') return now + KNOWN_CLOSE_MS;
  if (want || !isKnown(t)) return NaN;
  const placed = placedSinceAck(t);
  if (!placed) return Date.parse(t.ackedAt!) + KNOWN_CLOSE_MS;
  if (placed.by !== 'walnut' || !t.ackDone) return NaN;
  // He watches it: it waits on his unwatch (a change event), never on a clock; snoozed, on its date too.
  if (watchedNow(t)) return NaN;
  const due = Date.parse(t.ackDone) + KNOWN_CLOSE_MS;
  return t.snoozed && snoozedNow(t, now) ? Math.max(due, Date.parse(t.snoozed.until)) : due;
}

/** Why Walnut closed one it had placed, once its waits ended and the node brought nothing new. */
const CLOSED_WHY = 'its work ended and nothing new came';

/** One acknowledged thread after its step. Quiet for tell and rewait: nothing he sees changed. */
function settled(t: OrgThread, s: Settle, at: string): OrgThread {
  if (s.step === 'tell') return { ...t, ackDone: at };
  if (s.step === 'rewait') { const { ackDone: _d, ...rest } = t; return rest; }
  if (s.step === 'show') return { ...t, state: 'answered', updatedAt: at, by: 'agent' };
  if (s.step === 'place') return ackPlace(t, s.to, 'walnut', s.why, at);
  return ackPlace(t, 'closed', 'walnut', CLOSED_WHY, at);
}
