/**
 * Where Walnut's rule says a thread he acknowledged goes (experiment ack_means_known): ONE rule,
 * read by the node at his Acknowledge as Walnut's own reading (thread-ack.ts ackLine), by the
 * fallback that places it when the node has not decided in KNOWN_CLOSE_MS (thread-ack.ts
 * settleKnown), by the read (thread-ack.ts withAwaits: what it waits on) and by the follow pass
 * that settles one Walnut placed. 2026-11-20, the user: "if I ack and ai should determine if it
 * should go to closed or wait or wip", "If U know why not close".
 *
 *   working  a task the thread lists is still working on this thread's subject
 *   waiting  it waits on someone or something or a time: a task it lists on its subject is
 *            waiting (its waitingOn, until when) or asks him, his reply has not reached the node
 *            yet, or a decision letter on it still waits
 *   closed   otherwise: its own result is delivered and he acknowledged it, so it is over
 *
 * Working outranks waiting: while work runs on it, it is Working. A task it lists is on its
 * subject when the task's title or deliverable shares a subject word with the thread's title or
 * ask (onSubject); a task listed once for this work and since moved on to another subject (titled
 * for that one) does not keep the card. When the words cannot tell (a side with no subject word, or
 * the two in different scripts) the task counts as on its subject: the card stays, never closes on
 * a guess. A task COMPLETE, or one whose status says its result is in
 * (read, done) or that waits only for his review (NEED_ACTION), holds nothing. Pure.
 */
import { deliveryOpen, type OrgThread } from './threads-model.js';
import { liveLetter } from './letter-thread-model.js';
import { deliverableLine } from '../task-deliverable.js';
import { storedUserState, type UserStatus } from '../user-status.js';
import type { AckPlace, AckWaits } from './thread-known.js';

/** What a task the thread lists says, as the store holds it. */
export interface AckTask {
  id: string;
  title: string;
  phase?: string;
  description?: string;
  note?: string;
  user_status?: (Partial<Pick<UserStatus, 'toRead' | 'snoozed'>> & { state?: UserStatus['state']; waitingOn?: string; until?: string }) | null;
}

export type AckOutcome = AckPlace;

/** Generic words that name no subject: a status, a surface, a filler. */
const STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'one', 'all', 'its', 'his', 'her', 'this', 'that', 'now', 'new',
  'live', 'done', 'fix', 'fixed', 'ready', 'ship', 'shipped', 'version', 'web', 'phone', 'mac', 'app', 'part', 'wait', 'waits',
  'waiting', 'still', 'first', 'next', 'add', 'make', 'show', 'work', 'working', 'task', 'thread', 'what', 'when', 'how', 'why',
]);

/** The words of a text that name its subject: Latin words of 3+ letters (a plural folded), and CJK pairs. Pure. */
export function subjectWords(text: string): Set<string> {
  const s = text.normalize('NFKC').toLowerCase();
  const out = new Set<string>();
  for (const w of s.match(/[a-z][a-z0-9]{2,}/g) ?? []) {
    const stem = w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
    if (!STOP.has(w) && !STOP.has(stem)) out.add(stem);
  }
  for (const run of s.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) continue;
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

const HAN = /\p{Script=Han}/u;
/** The scripts a set of subject words is written in. */
const scripts = (ws: ReadonlySet<string>): Set<'han' | 'latin'> => new Set([...ws].map((w) => (HAN.test(w) ? 'han' as const : 'latin' as const)));

/**
 * The task works on the thread's subject: its title or deliverable shares a subject word with the
 * thread's title or ask. Words that cannot tell (none on a side, or no script in common) count as
 * on its subject. Pure.
 */
export function onSubject(t: Pick<OrgThread, 'title' | 'ask'>, task: AckTask): boolean {
  const mine = subjectWords(`${t.title} ${t.ask ?? ''}`);
  const theirs = subjectWords(`${task.title} ${deliverableLine(task)}`);
  if (!mine.size || !theirs.size) return true;
  const ours = scripts(mine);
  if (![...scripts(theirs)].some((s) => ours.has(s))) return true;
  for (const w of theirs) if (mine.has(w)) return true;
  return false;
}

/**
 * What a task says of its own work: still working, waiting on someone or something (not started
 * yet included), or nothing open. Its stored status first (read as every reader does:
 * storedUserState); an open task with none is still in work. Pure.
 */
export function taskStands(task: AckTask): 'working' | 'waiting' | null {
  if (task.phase === 'COMPLETE') return null;
  const s = task.user_status;
  const us = s?.state ? storedUserState({ state: s.state, toRead: s.toRead, snoozed: s.snoozed }) : undefined;
  if (us === 'working') return 'working';
  if (us === 'waiting' || us === 'needs') return 'waiting';
  if (us === 'read' || us === 'done') return null;
  // No stored status (an older row): its work is open, never read off the phase as a state
  // (tests/core/task-state-ratchet.test.ts: the status decides needs and waiting).
  return 'working';
}

/**
 * Where `t` goes at his Acknowledge, and what holds it there (null when closed): `tasks` the tasks
 * it lists (by id) as the store holds them; one missing from the map is gone or unknown and holds
 * nothing. Pure.
 */
/** Walnut's reading of a thread: where it goes and what holds it there. */
export interface AckReading { outcome: AckOutcome; waits: AckWaits | null }

export function ackOutcome(t: OrgThread, tasks: ReadonlyMap<string, AckTask>): AckReading {
  const held: Array<AckWaits['tasks'][number] & { stands: 'working' | 'waiting' }> = [];
  for (const id of t.tasks ?? []) {
    const task = tasks.get(id);
    const stands = task ? taskStands(task) : null;
    if (!task || !stands || !onSubject(t, task)) continue;
    const us = task.user_status;
    held.push({
      id, title: task.title, stands,
      ...(stands === 'waiting' && us?.waitingOn ? { waitingOn: us.waitingOn } : {}),
      ...(stands === 'waiting' && us?.until ? { until: us.until } : {}),
    });
  }
  const replies = t.messages.some(deliveryOpen);
  const letter = liveLetter(t);
  const working = held.some((x) => x.stands === 'working');
  if (!working && !held.length && !replies && !letter) return { outcome: 'closed', waits: null };
  const list = held.filter((x) => (working ? x.stands === 'working' : true)).map(({ stands: _s, ...x }) => x);
  return { outcome: working ? 'working' : 'waiting', waits: { tasks: list, replies, letter } };
}

const q = (s: string): string => `\u201c${s}\u201d`;

/**
 * The rule's reason in a few words, for the card's line when Walnut places it ("waits on \u201cX\u201d",
 * "\u201cX\u201d is still at work", "nothing on it was still open"). The card's wait list says the
 * rest (on what, until when). Pure.
 */
export function ackWhy(r: AckReading): string {
  const w = r.waits;
  if (r.outcome === 'closed' || !w) return 'nothing on it was still open';
  const first = w.tasks[0];
  const more = w.tasks.length > 1 ? ` and ${w.tasks.length - 1} more` : '';
  if (first) return r.outcome === 'working' ? `${q(first.title)}${more} still at work on it` : `waits on ${q(first.title)}${more}`;
  if (w.replies) return 'your reply has not reached it yet';
  return 'its letter waits on your decision';
}
