/**
 * One matter is asked in one place (2026-11-21, the user, after a decision letter, the thread that
 * held it, and a VP's chat all asked him about one switch, the letter's old buttons still on the
 * thread under a new question: "I already replied, why is it still there?").
 *
 * A task that puts a thread before him (opens it in needs, or moves it there) while it still asks
 * him something else (another of its threads waiting on him, a decision letter of its own he has
 * not answered) says which: `supersedes` names the asks this one replaces, and they leave his Needs
 * you now (a thread still waiting on him goes pending with a line naming where it is asked now, one
 * whose answer is his to read keeps it; a letter, or the letter a thread holds, is settled with that
 * line); `separate_reason` says why the others are other decisions. Neither: 409
 * other_open_asks, naming them. Only a task's own asks are read: his own threads and other teams'
 * asks are same-ask.ts's.
 *
 * Every id `supersedes` names is acted on or refused, never dropped without a word (2026-11-25, the
 * user, of two cards asking one decision, a task's and its lead's, "two threads for the same thing"; the task
 * had named its lead's card as replaced, the id was no ask of its own, so it was ignored and the write
 * still answered that `supersedes` changed). A thread named beyond the writer's own asks is found on
 * the Threads around it (namedElsewhere): one that waits on him and is the writer's to take off steps
 * aside there (stepAsideReplaced: pending, with the line naming where it is asked now); one that asks
 * him nothing now is left; anything else is a 409 naming it. After a write that named an ask, that
 * ask does not wait on him.
 */
import type { OrgThread, ThreadsFile, ThreadWriter } from './threads-model.js';
import { movedAway, ThreadError } from './threads-model.js';
import { answerUnread, holdsHim, replacedLine } from './thread-ended.js';

export const SEPARATE_REASON_MIN = 10;

export interface OpenAsk { id: string; kind: 'thread' | 'letter'; title: string }

/** The writer's own task id, or null for the user and an untracked agent. */
export function writerTask(by: ThreadWriter): string | null {
  return by.startsWith('task:') ? by.slice(5) : null;
}

/**
 * The writer task's threads waiting on him in this file, or holding a letter of its own whose buttons
 * still show (`openLetters`: the store's word, never the thread's copy), but `except`. Its own means
 * it opened it or it holds its letter: a lead writes the summary of every thread on its Threads, and
 * his own asks there are each their own matter. Pure.
 */
export function ownNeedsThreads(file: ThreadsFile, taskId: string, except?: string, openLetters?: ReadonlySet<string>, ref?: string, tasks: readonly string[] = []): OpenAsk[] {
  const by = `task:${taskId}`;
  // A request of his the node itself put in needs, naming a task this ask names: that task's decision
  // asked twice (the threads inspection, item 9: Main asked a task's pick on his card, then opened a
  // card of its own for it, and both showed).
  const named = new Set(tasks.filter((id) => id !== file.taskId));
  // His request (no opener) or the node's own card: one a task below opened there is that task's ask (review 2026-11-24).
  const sameTask = (t: OrgThread) => taskId === file.taskId && t.state === 'needs' && (!t.opener || t.opener.by === by)
    && (t.tasks ?? []).some((id) => named.has(id));
  return file.threads
    .filter((t: OrgThread) => t.id !== except && !t.closed && !t.movedTo && !otherItem(t, ref)
      && (((t.opener?.by === by || t.letter?.task === taskId)
        && (t.state === 'needs' || (!!t.letter && t.letter.task === taskId && t.state !== 'pending' && !!openLetters?.has(t.letter.id))))
        || sameTask(t)))
    .map((t) => ({ id: t.id, kind: 'thread' as const, title: t.title }));
}

/** The tasks an ask names: its own input's, and on an update the thread's (`except`) too. */
function askTasks(file: ThreadsFile, input: { tasks?: unknown; add_tasks?: unknown }, except?: string): string[] {
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  return [...list(input.tasks), ...list(input.add_tasks), ...(file.threads.find((t) => t.id === except)?.tasks ?? [])];
}

/**
 * Each points at its own outside item (a mail, a ticket: the opener's ref) and they differ: two
 * matters by construction (a lead opening one thread per mail he must answer), never one asked twice.
 */
function otherItem(t: OrgThread, ref?: string): boolean {
  // A letter's thread always counts: its buttons are an ask of the task's own.
  if (t.letter) return false;
  const a = (t.opener?.ref ?? '').trim();
  const b = (ref ?? '').trim();
  return !!a && !!b && a !== b;
}

/** Why the write is refused, or null. `others`: the writer's other open asks. Pure. */
export function otherAsksRefusal(others: readonly OpenAsk[], input: { supersedes?: unknown; separate_reason?: unknown }): string | null {
  if (!others.length) return null;
  const named = new Set(Array.isArray(input.supersedes) ? input.supersedes.filter((x): x is string => typeof x === 'string') : []);
  const left = others.filter((o) => !named.has(o.id));
  if (!left.length) return null;
  if (typeof input.separate_reason === 'string' && input.separate_reason.trim().length >= SEPARATE_REASON_MIN) return null;
  const list = left.map((o) => `${o.id} (${o.kind}: "${o.title.slice(0, 80)}")`).join('; ');
  return `Not handed to the user: your task still asks them ${left.length === 1 ? 'this' : 'these'} too: ${list}. One matter is asked `
    + 'in one place. Pass supersedes with the ids this one replaces (they leave the user\'s Needs you), or separate_reason '
    + `(${SEPARATE_REASON_MIN}+ characters) saying why they are other decisions. (Not in your tool list? walnut tools call thread_create with "supersedes":["${left[0]!.id}"].)`;
}

/** The ids `supersedes` names that are the writer's own open asks (anything else is ignored). */
export function supersededAsks(others: readonly OpenAsk[], supersedes: unknown): OpenAsk[] {
  const named = new Set(Array.isArray(supersedes) ? supersedes.filter((x): x is string => typeof x === 'string') : []);
  return others.filter((o) => named.has(o.id));
}

/** The writer task's other open asks: its needs threads here and its decision letters he has not answered. */
export async function otherOpenAsks(nodeTaskId: string, by: ThreadWriter, except?: string, ref?: string, input: { tasks?: unknown; add_tasks?: unknown } = {}): Promise<OpenAsk[]> {
  const taskId = writerTask(by);
  if (!taskId) return [];
  const { readThreads } = await import('./threads-store.js');
  const file = await readThreads(nodeTaskId);
  // A decision letter still showing its buttons: no option picked, not settled or archived (his
  // words back in it leave it in his inbox with the old buttons, 2026-11-21).
  const [{ listLetters }, { showsDecisionButtons }] = await Promise.all([import('../human-inbox/store.js'), import('../human-inbox/open-decision.js')]);
  const open = (await listLetters().catch(() => ({ letters: [] }))).letters
    .filter((l) => l.sender?.taskId === taskId && showsDecisionButtons(l));
  const threads = ownNeedsThreads(file, taskId, except, new Set(open.map((l) => l.id)), ref ?? file.threads.find((t) => t.id === except)?.opener?.ref, askTasks(file, input, except));
  // A letter a thread here holds is asked there: counted once, as that thread.
  const held = new Set(file.threads.map((t) => t.letter?.id).filter(Boolean));
  const letters = open.filter((l) => !held.has(l.id)).map((l) => ({ id: l.id, kind: 'letter' as const, title: l.subject }));
  return [...threads, ...letters];
}

/** Refuse a write that leaves the writer's other asks unnamed (409 other_open_asks). */
export async function refuseOtherOpenAsks(nodeTaskId: string, by: ThreadWriter, input: { supersedes?: unknown; separate_reason?: unknown; ref?: unknown; tasks?: unknown; add_tasks?: unknown }, except?: string): Promise<OpenAsk[]> {
  const others = await otherOpenAsks(nodeTaskId, by, except, typeof input.ref === 'string' ? input.ref : undefined, input);
  const why = otherAsksRefusal(others, input);
  if (why) throw new ThreadError('other_open_asks', 409, why);
  return supersededAsks(others, input.supersedes);
}

/** A thread `supersedes` names that is no ask of the writer's own in the file it writes: where it lives. */
export interface ElsewhereAsk { id: string; node: string; title: string }

/** What a thread named in `supersedes`, beyond the writer's own asks, comes to (namedVerdict). */
export type NamedVerdict = 'replace' | 'nothing' | 'refuse';

/**
 * What the writer task may do with a thread it names as replaced. Pure.
 *   replace  it waits on him and is the writer's to take off: on the writer's own Threads (`own`), on
 *            a node below it (`below`: a lead decides for its team), or naming the writer (its lead
 *            handed it the subject, pointed the card at it, or the writer opened it there);
 *   nothing  it asks him nothing now (closed, moved, any state but needs): a retry names it again;
 *   refuse   it waits on him and is another task's: hiding it would hide an ask he never answered.
 */
export function namedVerdict(t: Pick<OrgThread, 'state' | 'closed' | 'movedTo' | 'tasks' | 'askOwner' | 'opener'>, writer: string, where: { own: boolean; below: boolean }): NamedVerdict {
  if (t.closed || t.movedTo || t.state !== 'needs') return 'nothing';
  if (where.own || where.below) return 'replace';
  return (t.tasks ?? []).includes(writer) || t.askOwner?.task === writer || t.opener?.by === `task:${writer}` ? 'replace' : 'refuse';
}

/** The ids `supersedes` names, each once. */
function namedIds(supersedes: unknown): string[] {
  return [...new Set(Array.isArray(supersedes) ? supersedes.filter((x): x is string => typeof x === 'string') : [])];
}

/** Why a write naming `id` in supersedes was refused. Pure. */
export function namedRefusal(id: string, why: 'unknown' | 'not_yours' | 'letter', at?: { node: string; nodeTitle?: string; title?: string }): string {
  const head = `Not written: supersedes names ${id}, which `;
  if (why === 'letter') return `${head}is no decision letter of your task. Name only letters your task sent, or leave it out.`;
  if (why === 'unknown') {
    return `${head}is no open thread of your task, of the tasks above or below it, or of your team: nothing would leave the user's `
      + 'Needs you. Check the id (thread_list, with task for another node), or leave it out.';
  }
  return `${head}waits on the user on "${at?.nodeTitle ?? at?.node}" (${at?.node})${at?.title ? ` as "${at.title.slice(0, 80)}"` : ''} and does not name your task: `
    + `only that node takes it off. Ask it (task_send ${at?.node}) to step it aside for yours, or leave it out of supersedes.`;
}

/**
 * The asks `supersedes` names beyond the writer's own (`own`: thread-supersede.ts otherOpenAsks),
 * found on the Threads around the writer: the file it writes, its own, the tasks above it, below it
 * and beside it. Returns the threads to step aside; throws 409 for an id that names nothing there, a
 * thread that is another task's to take off, or a letter that is not the writer's. `except`: the
 * thread being written. The user's own writes name none.
 */
export async function namedElsewhere(nodeTaskId: string, by: ThreadWriter, supersedes: unknown, own: readonly OpenAsk[], except?: string): Promise<ElsewhereAsk[]> {
  const writer = writerTask(by);
  const mine = new Set(own.map((o) => o.id));
  const ids = namedIds(supersedes).filter((id) => !mine.has(id) && id !== except);
  if (!writer || !ids.length) return [];
  const refuse = (id: string, why: Parameters<typeof namedRefusal>[1], at?: Parameters<typeof namedRefusal>[2]): never => {
    throw new ThreadError('bad_input', 409, namedRefusal(id, why, at));
  };
  // A letter beyond the open ones: the writer's own, answered or settled already, asks nothing now.
  const letters = ids.filter((id) => id.startsWith('lt-'));
  if (letters.length) {
    const { getLetter } = await import('../human-inbox/store.js');
    for (const id of letters) {
      const l = await getLetter(id).catch(() => null);
      if (!l || l.sender?.taskId !== writer) refuse(id, 'letter');
    }
  }
  const left = new Set(ids.filter((id) => id.startsWith('th-')));
  if (!left.size) return [];
  const [{ readThreads }, { listTasks }, { treeAround }, { keepsThreads }] = await Promise.all([
    import('./threads-store.js'), import('../task-manager.js'), import('../same-ask-tree.js'), import('./keeps-threads.js'),
  ]);
  const everything = await listTasks();
  const byId = new Map(everything.map((t) => [t.id, t] as const));
  const self = byId.get(writer);
  const rank = { ancestor: 0, descendant: 1, team: 2 } as Record<string, number>;
  const around = treeAround(writer, everything)
    .filter((a) => keepsThreads(a.task) || !!a.task.org_role)
    .sort((a, b) => (rank[a.relation] ?? 3) - (rank[b.relation] ?? 3));
  const places = new Map<string, boolean>([[nodeTaskId, false], [writer, false]]);
  for (const a of around) if (!places.has(a.task.id)) places.set(a.task.id, a.relation === 'descendant' || (a.relation === 'team' && !!self?.org_role));
  const out: ElsewhereAsk[] = [];
  for (const [node, below] of places) {
    if (!left.size) break;
    const threads = (await readThreads(node).catch(() => null))?.threads ?? [];
    for (const t of threads) {
      if (!left.has(t.id) || movedAway(t)) continue;
      left.delete(t.id);
      const verdict = namedVerdict(t, writer, { own: node === writer, below });
      if (verdict === 'refuse') refuse(t.id, 'not_yours', { node, nodeTitle: byId.get(node)?.title, title: t.title });
      if (verdict === 'replace') out.push({ id: t.id, node, title: t.title });
    }
  }
  for (const id of left) refuse(id, 'unknown');
  return out;
}

/**
 * The file with a card another card replaced stepped aside: out of his Needs you (pending), its
 * summary the line naming where it is asked now, its buttons gone: 'aside'. Never closed from here:
 * its node keeps it and closes it itself (thread-ended.ts closes it once nothing of his holds it).
 * 'gone' when it no longer waits on him. Pure.
 */
export function stepAsideReplaced(file: ThreadsFile, id: string, line: string, by: ThreadWriter, at: string): { file: ThreadsFile; out: 'aside' | 'gone'; changed?: { kind: 'updated'; threadId: string } } {
  const t = file.threads.find((x) => x.id === id);
  if (!t || t.closed || t.movedTo || t.state !== 'needs') return { file, out: 'gone' };
  const { snoozed: _s, options: _o, reply_sid: _sid, reply_host: _host, ...rest } = t;
  const next: OrgThread = { ...rest, state: 'pending', reply: line, replyAt: at, reply_by: by, updatedAt: at };
  return { file: { ...file, threads: file.threads.map((x) => (x.id === id ? next : x)) }, out: 'aside', changed: { kind: 'updated', threadId: id } };
}

/**
 * Step the asks named elsewhere aside, each on its own node. Throws when one could not be written:
 * the writer must hear that a card it named still waits on him (never a write that only looks done).
 */
export async function applyElsewhere(asks: readonly ElsewhereAsk[], now: { id: string; title: string }, by: ThreadWriter): Promise<void> {
  if (!asks.length) return;
  const line = replacedLine(now);
  const { writeThreadsFor } = await import('./threads-store.js');
  for (const a of asks) {
    try {
      await writeThreadsFor(a.node, (cur) => stepAsideReplaced(cur, a.id, line, by, new Date().toISOString()));
    } catch (err) {
      throw new ThreadError('bad_input', 409, `Thread ${now.id} is written, but ${a.id} on ${a.node} could not be stepped aside and still waits on the user `
        + `(${err instanceof Error ? err.message : String(err)}): ask that node (task_send ${a.node}) to set it pending.`);
    }
  }
}

/**
 * Take the replaced asks off his Needs you: a thread closes with a line naming where it is asked now
 * (its letter, if it holds one, settled the same way), or goes pending with that line while something
 * on it is still his (thread-ended.ts holdsHim: a word of his unanswered, his pin, a reply on its way);
 * a letter is settled with that line. Closed, one decision shows once (the threads inspection, item 9:
 * a replaced card left pending was later written as a pointer and came back into Done).
 */
export async function applySupersedes(nodeTaskId: string, asks: readonly OpenAsk[], now: { id: string; title: string }, by: ThreadWriter): Promise<void> {
  if (!asks.length) return;
  // In the language the cards are written in (the new card's title).
  const line = replacedLine(now);
  const { patchThread, readThreads, writeThreadsFor } = await import('./threads-store.js');
  const { settleLetter } = await import('../human-inbox/store.js');
  const taskId = writerTask(by) ?? undefined;
  const settle = (id: string) => settleLetter(id, { reason: line, by: { sessionId: 'walnut', ...(taskId ? { taskId } : {}) } }).catch(() => null);
  const file = await readThreads(nodeTaskId);
  for (const a of asks) {
    if (a.kind === 'letter') { await settle(a.id); continue; }
    // Its letter first: a letter still waiting would hold its thread in needs.
    const t = file.threads.find((x) => x.id === a.id);
    if (t?.letter && !t.letter.done && t.letter.task === taskId) await settle(t.letter.id);
    // A thread whose answer is his to read keeps it: only one still waiting on him steps aside.
    if (t?.state !== 'needs') continue;
    // Judged again inside the lock: a reply of his may have come while the letter was settled (review 2026-11-24).
    const ownLetter = !!t.letter && t.letter.task === taskId;
    const done = await writeThreadsFor(nodeTaskId, (cur) => closeReplaced(cur, a.id, line, by, new Date().toISOString(), ownLetter)).catch(() => 'held' as const);
    if (done === 'held') await patchThread(nodeTaskId, a.id, { state: 'pending', reply: line }, by).catch(() => null);
  }
}

/**
 * The file with a replaced decision card closed, its summary the line naming where it is asked now:
 * 'closed'. Not while something of his is on it (holdsHim: a word of his unanswered, his pin, a reply
 * on its way; or an answer he has not read): 'held', and the caller only steps it aside. Nor once it
 * waits on him no more (he answered, it closed or moved meanwhile): 'gone', left as it is. `letterSettled`: its letter was the writer's, settled just
 * before. The node named it replaced, so no word of his is asked for, and it is not told again that
 * it closed. Pure.
 */
export function closeReplaced(file: ThreadsFile, id: string, line: string, by: ThreadWriter, at: string, letterSettled = false): { file: ThreadsFile; out: 'closed' | 'held' | 'gone'; changed?: { kind: 'updated'; threadId: string } } {
  const t = file.threads.find((x) => x.id === id);
  if (!t || t.closed || t.movedTo || t.state !== 'needs') return { file, out: 'gone' };
  if (holdsHim(t, Date.parse(at), letterSettled ? 'letter' : undefined) || answerUnread(t)) return { file, out: 'held' };
  const { snoozed: _s, options: _o, reply_sid: _sid, reply_host: _host, ...rest } = t;
  const next: OrgThread = { ...rest, reply: line, replyAt: at, reply_by: by, updatedAt: at, closed: { how: 'dropped', at, by, told: true } };
  return { file: { ...file, threads: file.threads.map((x) => (x.id === id ? next : x)) }, out: 'closed', changed: { kind: 'updated', threadId: id } };
}
