/**
 * His Acknowledge means he knows, not that it is over (experiment ack_means_known; 2026-11-20, the
 * user: "I acknowledge it, but that does not mean the thread is gone. A human acknowledge means I
 * now know the situation; the thread is truly closed only when the problem is really solved").
 *
 * When he acknowledges a thread whose work is still open (a task it went to not COMPLETE, his reply
 * not yet in the node's session, a decision letter on it still waiting), Walnut does not close it:
 * everything on it is known to him, it goes pending (out of his sight, still tracked) and records
 * `ackedAt`. The node hears it once, riding its next message (status-riding.ts), and may close it
 * then without a fresh reaction of his (threads-model.ts checkClose); a later answered on it is
 * news on his card again. When every task it lists is COMPLETE, the node hears that once too
 * (`ackDone`, from the follow pass in thread-follow.ts). A thread with nothing open closes as before.
 *
 * The pure parts take the file or the thread; the async ones read the store and the task list.
 */
import { log } from '../../logging/index.js';
import { experimentalEnabled } from '../experimental.js';
import { deliveryOpen, updateThread, type OrgThread, type ThreadsFile } from './threads-model.js';
import { liveLetter } from './letter-thread-model.js';

export interface AckWaits {
  /** The tasks it lists that are not COMPLETE: id and title. */
  tasks: Array<{ id: string; title: string }>;
  /** His reply on it has not reached the node's session yet. */
  replies: boolean;
  /** A decision letter it holds still waits. */
  letter: boolean;
}

const q = (s: string): string => JSON.stringify(s);

/** What is still open on `t`, given the open tasks (id → title) read from the store; null when nothing is. Pure. */
export function ackWaitsOf(t: OrgThread, openTasks: ReadonlyMap<string, string>): AckWaits | null {
  const tasks = (t.tasks ?? []).filter((id) => openTasks.has(id)).map((id) => ({ id, title: openTasks.get(id)! }));
  const replies = t.messages.some(deliveryOpen);
  const letter = liveLetter(t);
  return tasks.length || replies || letter ? { tasks, replies, letter } : null;
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
    + 'set it answered once with the outcome (he closes it), or close it if there is nothing new to tell.';
}

/** What the node hears once when every task of a thread he acknowledged is done. */
export function ackDoneLine(t: Pick<OrgThread, 'id' | 'title'>): string {
  return `- Thread ${t.id} ${q(t.title)}, which he acknowledged while its work ran: its tasks are done. Tell him the outcome once (answered) or close it.`;
}

/** A thread he acknowledged while its work ran, whose every task is COMPLETE now, not told yet. Pure. */
export function ackDoneDue(t: OrgThread, phaseOf: (id: string) => string | undefined): boolean {
  return !t.closed && t.state === 'pending' && !!t.ackedAt && !t.ackDone && !!t.tasks?.length
    && t.tasks.every((id) => phaseOf(id) === 'COMPLETE');
}

export async function ackMeansKnownOn(): Promise<boolean> {
  try {
    const { getConfig } = await import('../config-manager.js');
    return experimentalEnabled((await getConfig()).experimental, 'ack_means_known');
  } catch {
    return false;
  }
}

/**
 * Before his Acknowledge of `threadId` is written: the open tasks it lists (id → title), read now;
 * null when the experiment is off or the thread is gone or closed (the ack then closes as before).
 */
export async function ackOpenTasks(taskId: string, threadId: string): Promise<Map<string, string> | null> {
  if (!(await ackMeansKnownOn())) return null;
  const { readThreads } = await import('./threads-store.js');
  const t = (await readThreads(taskId)).threads.find((x) => x.id === threadId);
  if (!t || t.closed) return null;
  const out = new Map<string, string>();
  if (!t.tasks?.length) return out;
  const { listTasks } = await import('../task-manager.js');
  const want = new Set(t.tasks);
  for (const task of await listTasks()) if (want.has(task.id) && task.phase !== 'COMPLETE') out.set(task.id, task.title);
  return out;
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

/** Every node's threads he acknowledged while their work ran, not yet told done (the follow pass watches their tasks). */
export async function ackedThreads(): Promise<Array<{ node: string; threads: OrgThread[] }>> {
  if (!(await ackMeansKnownOn())) return [];
  const { listThreadNodes, readThreads } = await import('./threads-store.js');
  const out: Array<{ node: string; threads: OrgThread[] }> = [];
  for (const node of await listThreadNodes()) {
    const threads = (await readThreads(node)).threads.filter((t) => !t.closed && t.state === 'pending' && t.ackedAt && !t.ackDone && t.tasks?.length);
    if (threads.length) out.push({ node, threads });
  }
  return out;
}

/** The ones whose tasks are all done now: the node hears it once (stamped only when it rides). Returns how many. */
export async function tellAckedDone(acked: ReadonlyArray<{ node: string; threads: readonly OrgThread[] }>, phaseOf: (id: string) => string | undefined): Promise<number> {
  let n = 0;
  for (const { node, threads } of acked) {
    const told: string[] = [];
    for (const t of threads) if (ackDoneDue(t, phaseOf) && await rideToNode(node, t.id, ackDoneLine(t))) told.push(t.id);
    if (!told.length) continue;
    const at = new Date().toISOString();
    const { writeThreadsFor } = await import('./threads-store.js');
    // Quiet: nothing he sees changed, so no change event. Only the ack that was told: a newer one of his is told again.
    const ackOf = new Map(threads.map((t) => [t.id, t.ackedAt] as const));
    await writeThreadsFor(node, (cur) => ({ file: { ...cur, threads: cur.threads.map((t) => (told.includes(t.id) && !t.closed && t.ackedAt === ackOf.get(t.id) ? { ...t, ackDone: at } : t)) }, out: undefined }));
    n += told.length;
    log.task.info('org threads: acknowledged threads told done', { taskId: node, threads: told });
  }
  return n;
}
