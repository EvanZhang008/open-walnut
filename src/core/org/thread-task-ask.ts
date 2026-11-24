/**
 * A thread that waits on him (needs) for a decision a task of the node's team already asks him is
 * a pointer to that task's ask, never a second ask (2026-11-15: a lead's thread in needs repeated,
 * in other words, the review question its linked task already held in Needs you, so he saw one
 * decision twice and the counts said two).
 *
 * Projected on every read, never stored: the read shows the thread as `pending` with `askedIn`
 * naming the task (every client, an older phone included, already keeps pending out of his sight,
 * out of the counts and off the overdue clock), while the file keeps state needs and the whole
 * conversation, so it reads waiting on him again the moment that task completes, stops asking, or
 * asks another decision. The phone push skips it the same way (threads-store.ts).
 *
 * Two kinds of evidence, both strict, because a pointer hides an ask:
 *  - `owner`: the node named the task (patch `ask_owner`, stored as `askOwner` with that task's
 *    decision id and words then); it holds while that task asks the same decision (the same
 *    decision id, else the same words as named);
 *  - `words`: a task the thread is linked to (`tasks`) asks what the thread asks (its `ask`, else
 *    its summary's first sentence; never its title, a topic and no decision) in the same words or
 *    reworded with detail added (sameThreadDecision). A linked task asking something else never
 *    hides the thread.
 * A thread whose result waits to be read (answered) asks nothing, so holding it hides no ask
 * (heldResults, `via: 'thread'`): 2026-11-24, the user: "why the fuck there are so many dupciated
 * thread". His VP's card was his own request with the designs' result on it, beside the card of the
 * task it was handed to, which asked him to pick; he answered on the VP's and the task's kept
 * waiting. While a linked task asks him on a thread of its own Threads, the node's result nearest
 * that thread's title waits behind it, and stays there once he answered it there, until the node
 * writes it again. Two asks never hide one another this way: handing him one while a task around
 * asks its subject is refused at the write (thread-same-subject.ts refuseSameSubjectAsk).
 * Either kind stays a quiet pointer (`answered`) once the decision was settled in that task and it
 * asks nothing now (settledThere: an answer given for him there, his withdrawal, or his own message
 * to the task after it last asked it), so the thread never asks again what he already answered
 * there; with no such fact, or a new decision asked there, the thread is his own ask again.
 * Only a question that folds (a session's own, a Board choice: same-ask.ts FOLDABLE_SOURCES), and
 * only among the tasks the caller hands in (threads-store.ts withTaskAsks: the node's tree, in its
 * incoming-item area). Pure.
 */
import type { Task } from '../types.js';
import { sameTaskArea, type AreaScoped } from '../router/same-area.js';
import { answerFor, answersOf, askWords, FOLDABLE_SOURCES, sameAskReworded, sameAskText, withdrawnAtOf } from '../same-ask.js';
import { memoryOf, statusDecision } from '../ask-decision.js';
import { plainLine, type ThreadAskedIn } from './thread-view.js';
import type { OrgThread, ThreadAskOwner } from './threads-model.js';
import { sameSubjectCandidates, sharedPlaces } from './thread-same-subject.js';
import { matchIdRef } from '../../lib/id-ref.js';

type AskTask = Pick<Task, 'id' | 'title' | 'phase' | 'status' | 'user_status' | 'router_area_id'>
  & Partial<Pick<Task, 'ask_answered' | 'asks_answered' | 'asks_withdrawn' | 'status_report' | 'parent_task_id'>>;

/** A thread of a task's own Threads, as heldResults reads it. */
type OwnThread = Pick<OrgThread, 'id' | 'title' | 'state' | 'messages'> & Partial<Pick<OrgThread, 'closed' | 'needsAt' | 'movedTo'>>;

/** What a pointer reads beside the tasks: now, and when a person last wrote to a task's sessions
 *  (SessionRecord.humanInputAt / chatInputAt, read in one batch by threads-store.ts withTaskAsks). */
export interface AskPointerFacts {
  nowMs?: number;
  personAt?: (taskId: string) => string | null | undefined;
  /** A task's own Threads, closed ones too (threads-store.ts withTaskAsks reads them for ownThreadTaskIds). */
  threadsOf?: (taskId: string) => readonly OwnThread[] | undefined;
}

/**
 * Whether two asks, one a thread's and one a task's, are one decision by their words: word for word
 * (sameAskText), or one of them is the other with detail added after it: the same first word (what
 * is to be done), every content word of the shorter in the longer, and the same order, numbers,
 * "not" and directions (sameAskReworded). Stricter than sameAskReworded alone, which is for one
 * task's ask over time: across two writers shared words ("the Talos node image") are no evidence of
 * one decision, and "Roll back the Talos node image" is not "Upgrade the Talos node image". The
 * identity of two writers' asks, never news: whether an ask changed is its decision key
 * (ask-decision.ts). The one matcher threads use.
 */
export function sameThreadDecision(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a?.trim() || !b?.trim()) return false;
  if (sameAskText(a, b)) return true;
  if (!sameAskReworded(a, b)) return false;
  const wa = askWords(a);
  const wb = askWords(b);
  const [small, big] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  const inBig = new Set(big);
  return small[0] === big[0] && small.every((w) => inBig.has(w));
}

/** The task's ask shown to him now, one that folds (its session's own question, a Board choice): open, needs, with words. */
function askOf(t: AskTask | undefined): string | null {
  if (!t || t.phase === 'COMPLETE' || t.status === 'done') return null;
  const s = t.user_status;
  return s?.state === 'needs' && s.ask?.trim() && s.source && FOLDABLE_SOURCES.has(s.source) ? s.ask : null;
}

/** The decision id the task's shown ask carries (its session's, or a Board choice's): ask-decision.ts. */
const decisionOf = (t: AskTask): string | undefined => statusDecision(t.user_status)?.id;

/** The owner the node named still asks what it asked then. */
function ownerHolds(owner: ThreadAskOwner, task: AskTask, ask: string): boolean {
  const now = statusDecision(task.user_status)?.id;
  if (owner.decision && now) return owner.decision === now;
  if (owner.ask) return owner.ask === ask || sameThreadDecision(owner.ask, ask);
  // An incomplete hand edit proves no shared decision. Never hide an ask without its identity.
  return false;
}

/**
 * What the thread asks, as the node wrote it: its ask; with none, its summary's first sentence.
 * Never its title: a topic ("Talos node image") names no decision. The store judges a change of the
 * owner's thread by the same words (threads-store.ts patchThread).
 */
export function threadAskText(t: Pick<OrgThread, 'ask' | 'reply'>): string | null {
  if (t.ask?.trim()) return t.ask;
  // A label in front of it ("Needs you:", "Decision:") is not what it asks.
  const head = (t.reply ? plainLine(t.reply) : '').replace(/^[^:.!?\n]{1,24}:\s+/u, '').trim();
  return head || null;
}

/**
 * The decision the task's report asks while its shown status is a live prompt or a failure for a
 * moment (needs, a source that does not fold): the ask is still that task's, so the pointer holds,
 * as a plain one (not answered), until the prompt ends. Null otherwise. Pure.
 */
function askBehindPrompt(task: AskTask): { id?: string; ask: string } | null {
  const s = task.user_status;
  if (task.phase === 'COMPLETE' || task.status === 'done' || s?.state !== 'needs' || (s.source && FOLDABLE_SOURCES.has(s.source))) return null;
  const r = task.status_report;
  const memory = r?.state === 'needs' ? memoryOf(r) : null;
  return memory?.ask?.trim() ? { ...(memory.id ? { id: memory.id } : {}), ask: memory.ask } : null;
}

/**
 * The decision (`decision` id, else its words `ask`) was settled in that task, which asks him
 * nothing now: answered for him there by a lead, VP or Main or withdrawn by him for good, and not
 * taken back since (same-ask.ts answerFor, withdrawnAtOf); or he wrote to the task himself after its
 * last report asking that decision (its report's memory of it, ask-decision.ts memoryOf; `since` for
 * a report that remembers none; never when it remembers another decision). Facts only, never a
 * guess: a task that stopped asking with none of them puts the ask back on the thread. Pure.
 */
function settledThere(task: AskTask, ask: string, decision: string | undefined, since: string | undefined, facts: AskPointerFacts): boolean {
  if (task.user_status?.state === 'needs') return false;
  const answer = answerFor(answersOf(task), ask, facts.nowMs ?? Date.now(), decision ? { id: decision } : null);
  const back = answer ? withdrawnAtOf(task.asks_withdrawn, ask) : null;
  if (answer && (!back || back < answer.at)) return true;
  const person = facts.personAt?.(task.id);
  if (!person) return false;
  const memory = memoryOf(task.status_report);
  // A report that remembers another decision since: what he wrote may be about that one.
  if (memory && !(decision && memory.id ? memory.id.toLowerCase() === decision.toLowerCase() : sameThreadDecision(memory.ask, ask))) return false;
  const asked = memory ? memory.at : since;
  return !!asked && person > asked;
}

/**
 * The task that already asks him this thread's decision, or null. Only an open thread in needs;
 * `node` is the thread's node (its area bounds every task read here).
 */
export function threadAskedIn(
  t: Pick<OrgThread, 'state' | 'closed' | 'askOwner' | 'tasks' | 'ask' | 'reply'>,
  node: AreaScoped,
  byId: ReadonlyMap<string, AskTask>,
  facts: AskPointerFacts = {},
): ThreadAskedIn | null {
  if (t.closed || t.state !== 'needs') return null;
  const point = (task: AskTask, ask: string, via: ThreadAskedIn['via'], decision = decisionOf(task)): ThreadAskedIn => ({
    task: task.id, title: task.title, ask, via, ...(decision ? { decision } : {}),
  });
  const inScope = (task: AskTask | undefined): task is AskTask => !!task && task.id !== node.id && sameTaskArea(node, task);
  const o = t.askOwner;
  if (o) {
    const task = byId.get(o.task);
    const ask = askOf(task);
    if (inScope(task)) {
      if (ask && ownerHolds(o, task, ask)) return point(task, ask, 'owner');
      const held = askBehindPrompt(task);
      if (held && o.ask && (o.decision && held.id ? held.id.toLowerCase() === o.decision.toLowerCase() : sameThreadDecision(o.ask, held.ask))) {
        return point(task, held.ask, 'owner', held.id);
      }
      // Settled there: a quiet pointer, unless the task now asks him another decision.
      if (!ask && o.ask && settledThere(task, o.ask, o.decision, o.at, facts)) {
        return { task: task.id, title: task.title, ask: o.ask, via: 'owner', ...(o.decision ? { decision: o.decision } : {}), answered: true };
      }
    }
  }
  const mine = threadAskText(t);
  if (!mine) return null;
  for (const id of t.tasks ?? []) {
    const task = byId.get(id);
    if (!inScope(task)) continue;
    const ask = askOf(task);
    if (ask && sameThreadDecision(mine, ask)) return point(task, ask, 'words');
    const held = askBehindPrompt(task);
    if (held && sameThreadDecision(mine, held.ask)) return point(task, held.ask, 'words', held.id);
    // It stopped asking: settled there only on the same evidence, the decision its report last asked.
    const memory = ask ? null : memoryOf(task.status_report);
    if (memory && sameThreadDecision(mine, memory.ask) && settledThere(task, memory.ask, memory.id, undefined, facts)) {
      return { task: task.id, title: task.title, ask: memory.ask, via: 'words', ...(memory.id ? { decision: memory.id } : {}), answered: true };
    }
  }
  return null;
}

/** Up the parent chain this far: a subtask's subtask under a linked task (subtasks go 3 levels deep). */
const BELOW_DEPTH = 4;

/** The task's status says a thread of its own waits on him now (user-status.ts taskThreadNeeds). */
const asksOnThread = (t: AskTask): boolean => t.phase !== 'COMPLETE' && t.status !== 'done' && t.user_status?.state === 'needs' && t.user_status.source === 'thread';

/** A result a task's own thread may hold: open, waiting to be read, linked to tasks, written in the last week. */
const RESULT_RECENT_MS = 7 * 24 * 3_600_000;
export const heldCandidate = (t: Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'updatedAt'>, now: number): boolean =>
  !t.closed && t.state === 'answered' && !!t.tasks?.length && now - Date.parse(t.updatedAt) <= RESULT_RECENT_MS;

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

/** Files read for one node's held results at most: the tasks of its newest results first. */
const OWN_THREAD_TASKS_MAX = 40;

/** The tasks whose Threads heldResults reads for these threads (ownThreadTasks of each heldCandidate). Pure. */
export function ownThreadTaskIds(node: AreaScoped, threads: readonly Pick<OrgThread, 'closed' | 'state' | 'tasks' | 'updatedAt'>[], tasks: readonly AskTask[], now: number = Date.now()): Set<string> {
  const ids = new Set<string>();
  const results = threads.filter((t) => heldCandidate(t, now)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!results.length) return ids;
  const byId = new Map(tasks.map((x) => [x.id, x] as const));
  for (const t of results) {
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

/** A result is held on this many shared telling words with the task's thread, standing in this many places of its title. */
const RESULT_SHARED = 3;
const RESULT_PLACES = 2;

/**
 * The node's results (answered threads) that a linked task's own thread holds, by thread id: for
 * each thread of such a task that asks him now, or that he answered, the ONE thread of the node
 * linked to that task whose title shares the most telling words with it (RESULT_SHARED at least,
 * more than any other: a tie holds none), when that one is a result. The words are the same-subject
 * rule's (thread-same-subject.ts sameSubjectCandidates): one in many of the node's titles ("live",
 * the product's name) tells nothing. Two requests handed to one task share its area's name, so the
 * nearest title tells which one the task's ask is about; the shared words stand in two places of
 * the title at least (RESULT_PLACES: the area's name is one). Only a result the node wrote while that
 * thread was already asking him: one written before it was in his view then and stays there.
 * Answered there: held on while his words are newer than the result; the node writing it again is
 * news, and after RESULT_RECENT_MS with nothing written it is back in his view. Pure.
 */
export function heldResults<T extends OrgThread>(node: AreaScoped, threads: readonly T[], byId: ReadonlyMap<string, AskTask>, facts: AskPointerFacts): Map<string, ThreadAskedIn> {
  const out = new Map<string, ThreadAskedIn>();
  const now = facts.nowMs ?? Date.now();
  if (!facts.threadsOf || !threads.some((t) => heldCandidate(t, now))) return out;
  // Per task a result is linked to: every open thread of the node linked to it. The nearest of them
  // is the task's subject, a result or not.
  const byTask = new Map<string, { task: AskTask; mine: Map<string, T> }>();
  for (const t of threads) {
    if (!heldCandidate(t, now)) continue;
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
  const own = [{ task: { id: node.id, title: '' }, threads }];
  for (const { task, mine } of byTask.values()) {
    // Only his words newer than a result linked to this task can hold one: older threads are not scored.
    const oldest = [...mine.values()].filter((t) => heldCandidate(t, now)).map(lastWrittenAt).sort()[0];
    if (oldest === undefined) continue;
    const open = task.phase !== 'COMPLETE' && task.status !== 'done';
    for (const x of facts.threadsOf(task.id) ?? []) {
      const asking = open && !x.closed && x.state === 'needs';
      if (x.movedTo || !(asking || (answeredThere(x) && hisLastAt(x) > oldest))) continue;
      // Most shared first (sameSubjectCandidates), among the node's threads linked to this task.
      const [best, next] = sameSubjectCandidates(x.title, own, now).filter((c) => mine.has(c.id));
      const t = best ? mine.get(best.id) : undefined;
      if (!best || !t || best.shared < RESULT_SHARED || next?.shared === best.shared || !heldCandidate(t, now)) continue;
      // The area's name alone is one place, and a result written before the task asked is not about its ask.
      if (sharedPlaces(x.title, t.title) < RESULT_PLACES || !x.needsAt || lastWrittenAt(t) < x.needsAt) continue;
      const p: ThreadAskedIn = { task: task.id, title: task.title, ask: x.title, via: 'thread', thread: x.id };
      if (asking) out.set(t.id, p);
      else if (!out.has(t.id) && hisLastAt(x) > lastWrittenAt(t)) out.set(t.id, { ...p, answered: true });
    }
  }
  return out;
}

/**
 * The node's threads as he reads them: one in needs whose decision a task already asks, and a
 * result a linked task's own thread holds (heldResults), read `pending` with that task (`askedIn`);
 * every other thread as stored. Pure.
 */
export function withAskPointers<T extends OrgThread>(node: AreaScoped, threads: readonly T[], tasks: readonly AskTask[], facts: AskPointerFacts = {}): Array<T & { askedIn?: ThreadAskedIn }> {
  const byId = new Map(tasks.map((x) => [x.id, x] as const));
  const held = heldResults(node, threads, byId, facts);
  return threads.map((t) => {
    const p = threadAskedIn(t, node, byId, facts) ?? held.get(t.id);
    return (p ? { ...t, state: 'pending' as const, askedIn: p } : t) as T & { askedIn?: ThreadAskedIn };
  });
}

/** The tasks a pointer of these threads may name: each open needs thread's owner and linked tasks. Pure. */
export function pointerTaskIds(threads: readonly Pick<OrgThread, 'closed' | 'state' | 'askOwner' | 'tasks'>[]): Set<string> {
  const ids = new Set<string>();
  for (const t of threads) {
    if (t.closed || t.state !== 'needs') continue;
    if (t.askOwner) ids.add(t.askOwner.task);
    for (const id of t.tasks ?? []) ids.add(id);
  }
  return ids;
}

/**
 * What the pointers of these threads read of the tasks, as one string: a cache of counts built
 * with withAskPointers is current only while this is unchanged (a linked task completing or asking
 * another decision changes it, no thread write needed).
 */
export function askPointerSignature(threads: readonly OrgThread[], tasks: readonly AskTask[], facts: AskPointerFacts = {}): string {
  const ids = pointerTaskIds(threads);
  // A result held by a task's own thread reads its linked tasks too (heldResults).
  const now = facts.nowMs ?? Date.now();
  const results = threads.filter((t) => heldCandidate(t, now));
  for (const t of results) for (const id of t.tasks ?? []) ids.add(id);
  if (!ids.size) return '';
  const byId = new Map(tasks.map((x) => [x.id, x] as const));
  // A task under a linked one that asks him on a thread of its own now may hold a result too (ownThreadTasks).
  const below = results.length ? tasks.filter(asksOnThread).map((x) => `${x.id}:${x.parent_task_id ?? ''}/${x.user_status?.ask ?? ''}`).sort().join('\n+') : '';
  return [...ids].sort().map((id) => {
    const x = byId.get(id);
    const s = x?.user_status;
    const settled = answersOf(x).map((a) => `${a.key}@${a.at}${a.withdrawn ? '!' : ''}`).join(',') + `|${(x?.asks_withdrawn ?? []).map((w) => w.at).join(',')}`;
    const memory = x ? memoryOf(x.status_report) : null;
    return `${id}:${x ? `${x.phase ?? ''}/${x.status ?? ''}/${s?.state ?? ''}/${s?.source ?? ''}/${decisionOf(x) ?? ''}/${s?.ask ?? ''}/${x.router_area_id ?? ''}/${settled}/${memory?.id ?? ''}@${memory?.at ?? ''}/${facts.personAt?.(id) ?? ''}` : '-'}`;
  }).join('\n') + (below ? `\n+${below}` : '');
}

/**
 * Whether the owner the node named still stands after a write that did not name it again
 * (threads-store.ts patchThread): the thread's ask unchanged or said again in other words; a thread
 * with no ask keeps it over a new title only while its words still ask the owner's decision. A new
 * ask where there was none, or another decision, drops it: the words rule (`tasks`) still finds a
 * linked task that asks the same. Pure.
 */
export function askOwnerKept(before: Pick<OrgThread, 'ask' | 'title'>, next: Pick<OrgThread, 'ask' | 'title' | 'reply' | 'askOwner'>): boolean {
  if (!next.askOwner) return false;
  const was = before.ask?.trim() ?? '';
  const now = next.ask?.trim() ?? '';
  if (was !== now) return !!was && !!now && sameThreadDecision(was, now);
  if (!now && before.title !== next.title) return sameThreadDecision(threadAskText(next), next.askOwner.ask);
  return true;
}

/**
 * The task `ref` (an id or a unique prefix of one) names for ask_owner: one of `around` (the node's
 * tree, same-ask-tree.ts treeAround), or for a task with Threads on that is no Org node any task
 * below it (2026-11-23: such a task naming its own subtask was refused). None when nothing or
 * several match. Pure.
 */
export function askOwnerTask<T extends Pick<Task, 'id' | 'parent_task_id'>>(ref: string, node: Pick<Task, 'id' | 'org_role'>, around: readonly T[], all: readonly T[]): T | undefined {
  const pool = new Map(around.map((t) => [t.id, t] as const));
  if (!node.org_role) {
    const byId = new Map(all.map((t) => [t.id, t] as const));
    for (const t of all) {
      const seen = new Set<string>();
      for (let up = t.parent_task_id; up && !seen.has(up); up = byId.get(up)?.parent_task_id) {
        seen.add(up);
        if (up === node.id) { pool.set(t.id, t); break; }
      }
    }
  }
  // The whole id wins over a prefix (src/lib/id-ref.ts); a prefix names a task only when it is unique and 6+ long.
  const named = matchIdRef(pool.values(), ref);
  return named.length === 1 && (named[0]!.id === ref || ref.length >= 6) ? named[0] : undefined;
}

/**
 * The owner as the store keeps it (patch `ask_owner`): that task must ask him something now, in
 * the node's area. Throws a plain message the store turns into a 409. Pure.
 */
export function askOwnerOf(taskId: string, node: AreaScoped, task: AskTask | undefined, by: ThreadAskOwner['by'], at: string): ThreadAskOwner {
  if (!task || task.id === node.id || !sameTaskArea(node, task)) {
    throw new Error(`No task ${taskId} in this node's team to point the thread at: name a task above, below or beside yours (its id or a unique prefix), never your own.`);
  }
  const ask = askOf(task);
  if (!ask) throw new Error(`Task ${taskId} asks the user nothing now: the thread stays his own ask.`);
  const decision = decisionOf(task);
  return { task: task.id, ...(decision ? { decision } : {}), ask, at, by };
}
