/**
 * A thread goes with its work (2026-11-08, the user, after his research thread stayed on one VP's
 * Threads while another VP did the work: "why this is ehre ... shoidl be walnut vp"; then, translated:
 * once the task is moved under the other VP, "then you no longer need to monitor it"). One of his Threads
 * (threads-model.ts) belongs to the Org node whose team does its work. When the work leaves a node,
 * the thread leaves with it: his messages, the answers, its state, pin and links move to the other
 * node's Threads, saying where it came from, and the old node keeps a closed copy pointing there
 * (`moved`), so it stops following it. Both nodes are told in one line riding their next message.
 *
 * Every way a thread's ask can leave a node, and what moves it:
 *
 *   1. its work moves: a thread's tasks are now in another lead's team (a task moved to another
 *      project or under another task, a project put under another VP, a task the node handed to
 *      another team and linked): `planThreadFollows`, a state rule over the tasks and the threads,
 *      run by `startThreadFollow` on every task or threads change (debounced) and every few
 *      minutes, so any path that changes a task (any route, a sync pull, a bulk move) is covered;
 *   2. the node itself goes: a lead whose project another VP took over (org-tree.ts successorOf)
 *      hands every open thread to that VP;
 *   3. the node hands it on: task_send, org_send, task_start or task_create naming `thread` (and a
 *      task_send or task_start with `hands_on` to another team, for the threads that list that
 *      task): `handOffThread`, called by each route in HANDOFF_ROUTES once the send succeeded;
 *   4. by hand: thread_move (POST /tasks/:id/threads/:thread/move).
 *
 * Main's threads never move by themselves (every team is under Main); Main moves one by handing it
 * on (3) or by thread_move (4). Only to an open lead: a thread never moves to Main by the state rule.
 * tests/core/org/thread-handoff-paths-guard.test.ts fails on a send, start or create route or op that
 * does not hand the thread on.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { leadsAlso, orgDisplayTitle, pickLead, pickMain, successorOf } from './org-tree.js';
import { isOpen, type MoveEnd, type OrgThread, type ThreadMoveKind, type ThreadWriter } from './threads-model.js';

/** Every route that hands work to another task, and so may hand a thread on with it (guard test). */
export const HANDOFF_ROUTES = [
  { method: 'POST', path: '/messages', file: 'src/web/routes/messages-v1.ts' },
  { method: 'POST', path: '/tasks/:id/start', file: 'src/web/routes/task-v1.ts' },
  { method: 'POST', path: '/tasks', file: 'src/web/routes/api-v1.ts' },
] as const;

/** The task fields the rule reads. */
export type FollowTask = Pick<Task, 'id' | 'title' | 'org_role' | 'parent_task_id' | 'project' | 'org_leads' | 'phase' | 'status' | 'created_at' | 'org_name'>;

const openTask = (t: FollowTask | undefined): boolean => !!t && t.phase !== 'COMPLETE' && t.status !== 'done';
const isNode = (t: FollowTask | undefined): boolean => t?.org_role === 'main' || t?.org_role === 'lead';

export interface OrgPlaces {
  byId: ReadonlyMap<string, FollowTask>;
  /** The open lead answering for a project, if any. */
  leadOf: (project: string | undefined) => FollowTask | undefined;
  main: FollowTask | undefined;
  all: readonly FollowTask[];
}

export function orgPlaces(all: readonly FollowTask[]): OrgPlaces {
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const openLeads = all.filter((t) => t.org_role === 'lead' && openTask(t));
  const main = pickMain(all.filter((t) => t.org_role === 'main' && openTask(t)) as Task[]);
  return { byId, leadOf: (project) => ((project ?? '').trim() ? pickLead(openLeads as Task[], project!.trim()) : undefined), main, all };
}

/**
 * The Org node whose team does a task's work: the task itself when it is one, else its nearest
 * node above it in the parent chain (the order statusFollowersOf in sessions/status-push.ts
 * follows), else the lead of its top task's project, else Main. One exception: a task a lead filed
 * that now sits in a project another open lead answers for, and this lead does not, is that lead's
 * work (2026-11-08, the user: moving the task into a project under the other VP is the whole
 * handoff), though its parent link still names the lead that made it. The current project
 * assignment also wins when that same project was delegated to another VP.
 */
export function ownerNodeOf(task: FollowTask, p: OrgPlaces): FollowTask | undefined {
  if (isNode(task)) return task;
  let top = task;
  const seen = new Set([task.id]);
  for (let id = task.parent_task_id; id && !seen.has(id);) {
    seen.add(id);
    const parent = p.byId.get(id);
    if (!parent) break;
    if (isNode(parent)) {
      if (parent.org_role === 'lead') {
        const there = p.leadOf(top.project);
        if (there && there.id !== parent.id && (leadsAlso(there, top.project ?? '')
          || ![parent.project, ...(parent.org_leads ?? [])].some((project) =>
            (project ?? '').trim().toLowerCase() === (top.project ?? '').trim().toLowerCase()))) return there;
      }
      return parent;
    }
    top = parent;
    id = parent.parent_task_id;
  }
  return p.leadOf(top.project) ?? p.main;
}

/** The nodes a task reports up through: its owner, the VP leading that owner's project, Main. */
export function orgNodesAbove(task: FollowTask, p: OrgPlaces): Set<string> {
  const out = new Set<string>();
  const owner = ownerNodeOf(task, p);
  if (owner) {
    out.add(owner.id);
    if (owner.org_role === 'lead') {
      const vp = p.leadOf(owner.project);
      if (vp && leadsAlso(vp, owner.project ?? '')) out.add(vp.id);
    }
  }
  if (p.main) out.add(p.main.id);
  return out;
}

/** Where each of a thread's listed tasks does its work, as one key: `task=node,...` (ThreadMove.owners). */
export function ownersKey(taskIds: readonly string[] | undefined, p: OrgPlaces): string {
  return [...new Set(taskIds ?? [])].map((id) => {
    const t = p.byId.get(id);
    return `${id}=${t ? ownerNodeOf(t, p)?.id ?? '' : ''}`;
  }).sort().join(',');
}

/**
 * A thread handed on: did the work of a task it listed then move to another team since? Tasks
 * listed later do not count (the node holding it chose them; it hands the thread on itself), and a
 * thread handed with no task stays where it was handed.
 */
function workMovedSince(owners: string, p: OrgPlaces): boolean {
  return owners.split(',').filter(Boolean).some((pair) => {
    const [id, was] = pair.split('=');
    const t = p.byId.get(id);
    return !!t && (ownerNodeOf(t, p)?.id ?? '') !== was;
  });
}

export interface PlannedMove {
  from: FollowTask;
  to: FollowTask;
  threadId: string;
  title: string;
  why: string;
}

const q = (s: string) => JSON.stringify(s);

/**
 * Pure: the threads whose work is now elsewhere. A lead's open thread moves to lead M when every
 * task it lists does its work in M's team and none in this lead's (a thread with no task, or with a
 * task still here, stays: the node still holds part of it); a lead another VP took over hands every
 * open thread to that VP. Main's threads stay; nothing moves to Main or to a closed lead.
 */
export function planThreadFollows(nodes: ReadonlyArray<{ node: FollowTask; threads: readonly OrgThread[] }>, p: OrgPlaces): PlannedMove[] {
  const moves: PlannedMove[] = [];
  for (const { node, threads } of nodes) {
    if (node.org_role !== 'lead') continue;
    const succ = successorOf(p.all.filter((t) => t.org_role === 'lead') as Task[], node as Task);
    for (const t of threads) {
      if (!isOpen(t)) continue;
      if (!openTask(node) && succ && openTask(succ) && succ.id !== node.id) {
        moves.push({ from: node, to: succ, threadId: t.id, title: t.title, why: `${orgDisplayTitle(node as Task)} handed its project over to ${orgDisplayTitle(succ as Task)}` });
        continue;
      }
      const listed = (t.tasks ?? []).map((id) => p.byId.get(id)).filter((x): x is FollowTask => !!x);
      if (!listed.length || listed.some((x) => orgNodesAbove(x, p).has(node.id))) continue;
      const owners = [...new Map(listed.map((x) => ownerNodeOf(x, p)).filter((o): o is FollowTask => !!o).map((o) => [o.id, o] as const)).values()];
      const to = owners.length === 1 ? owners[0] : undefined;
      if (!to || to.id === node.id || to.org_role !== 'lead' || !openTask(to)) continue;
      // Handed on on purpose (a node's hand-off, or by hand, once or through several nodes): its
      // tasks never pull it back while their work is where it was then; once that work moves on, it follows.
      const hand = t.movedFrom?.kind === 'hand' ? t.movedFrom : undefined;
      if (hand && (hand.owners !== undefined ? !workMovedSince(hand.owners, p) : hand.task === to.id)) continue;
      const toName = orgDisplayTitle(to as Task);
      moves.push({
        from: node, to, threadId: t.id, title: t.title,
        why: listed.length === 1 && listed[0].id !== to.id ? `its work ${q(listed[0].title)} is in ${toName}'s team` : `its work is with ${toName}`,
      });
    }
  }
  return moves;
}

function end(t: FollowTask): MoveEnd { return { task: t.id, title: orgDisplayTitle(t as Task) }; }

/** One line for each node, riding its next message (never a wake). The org off: nobody is told. */
async function tellNodes(move: { from: FollowTask; to: FollowTask; threadId: string; title: string; why: string }, opts: { tellFrom: boolean }): Promise<void> {
  try {
    const { isOrgEnabled } = await import('./org-enabled.js');
    if (!(await isOrgEnabled())) return;
    const { leadSession } = await import('./org-store.js');
    const { tellOrRide } = await import('../sessions/status-push.js');
    const fromName = orgDisplayTitle(move.from as Task);
    const toName = orgDisplayTitle(move.to as Task);
    const toSession = await leadSession(move.to.id);
    if (toSession) {
      await tellOrRide(toSession.claudeSessionId, `thread-moved-in:${move.threadId}`,
        `Thread ${move.threadId} ${q(move.title)} moved to your Threads from ${fromName} (${move.from.id}), because ${move.why}: the user's messages and the answers came with it. It is yours now: keep it current with thread_update and answer him in it.`);
    }
    if (!opts.tellFrom) return;
    const fromSession = await leadSession(move.from.id);
    if (fromSession) {
      await tellOrRide(fromSession.claudeSessionId, `thread-moved-out:${move.threadId}`,
        `Thread ${move.threadId} ${q(move.title)} moved to ${toName} (${move.to.id}), because ${move.why}: it is closed on your Threads and you no longer follow it.`);
    }
  } catch (err) {
    log.task.warn('org threads: move not told', { threadId: move.threadId, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * His Follow up on a moved thread reached the node it left (a card opened before the move): his
 * message goes to the node holding the thread now as his own message, words and pictures whole, filed
 * in that thread there, so that node answers it in its chat and the answer is read into the thread
 * (thread-answers.ts). `filed`: the store already filed it there under `key` (it moved between the
 * plan and the write), so the send finds it filed and files nothing again. With no session there, it is filed only. Never throws.
 */
export async function deliverMovedFollowUp(input: { node: string; threadId: string; title: string; message: string; key: string; from: string; filed: boolean }): Promise<void> {
  const store = await import('./threads-store.js');
  const fileOnly = async (): Promise<void> => {
    if (input.filed) return;
    const { userWordsOf } = await import('./thread-capture.js');
    const words = userWordsOf(input.message, { inChat: true });
    if (words) await store.fileThreadMessage(input.node, { text: words.text, images: words.images, via: 'follow-up', threadId: input.threadId, key: input.key, at: new Date().toISOString() });
  };
  try {
    const { leadSession } = await import('./org-store.js');
    const s = await leadSession(input.node);
    if (!s) { await fileOnly(); return; }
    const { prepareHintedSend } = await import('../hints/hint-send.js');
    const { sendMessageToSession } = await import('../session-message-queue.js');
    // Already filed (under `key`): the holder's own capture finds it filed and only says so.
    const prepared = await prepareHintedSend(s.claudeSessionId, s, input.message, { sentBy: 'person', threadId: input.threadId, threadKey: input.key });
    await sendMessageToSession(s.claudeSessionId, prepared.displayText, { source: 'ui', taskId: input.node, enqueueMessage: prepared.enqueueText, hinted: true });
    await prepared.commit(s.claudeSessionId);
  } catch (err) {
    log.task.warn('org threads: moved follow-up not delivered', { threadId: input.threadId, node: input.node, error: err instanceof Error ? err.message : String(err) });
    await fileOnly().catch(() => {});
  }
}

async function runMove(move: PlannedMove, by: ThreadWriter, opts: { tellFrom: boolean; owners?: string }, kind: ThreadMoveKind): Promise<OrgThread | null> {
  const { moveThread } = await import('./threads-store.js');
  try {
    const thread = await moveThread({ from: end(move.from), to: end(move.to), threadId: move.threadId, by, why: move.why, kind, ...(opts.owners !== undefined ? { owners: opts.owners } : {}) });
    log.task.info('org thread moved with its work', { threadId: move.threadId, from: move.from.id, to: move.to.id, why: move.why, by });
    await tellNodes(move, opts);
    return thread;
  } catch (err) {
    log.task.warn('org thread not moved', { threadId: move.threadId, from: move.from.id, to: move.to.id, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

async function readAllNodes(p: OrgPlaces): Promise<Array<{ node: FollowTask; threads: OrgThread[] }>> {
  const { listThreadNodes, readThreads } = await import('./threads-store.js');
  const out: Array<{ node: FollowTask; threads: OrgThread[] }> = [];
  for (const id of await listThreadNodes()) {
    const node = p.byId.get(id);
    if (!node || node.org_role !== 'lead') continue;
    const threads = (await readThreads(node.id)).threads.filter(isOpen);
    if (threads.length) out.push({ node, threads });
  }
  return out;
}

/** The ids whose change can move a thread: the tasks threads list and their ancestors (every node counts too). */
let watched = new Set<string>();

function watchSet(nodes: ReadonlyArray<{ threads: readonly OrgThread[] }>, p: OrgPlaces): Set<string> {
  const out = new Set<string>();
  for (const { threads } of nodes) {
    for (const t of threads) {
      for (const id of t.tasks ?? []) {
        const seen = new Set<string>();
        for (let cur: string | undefined = id; cur && !seen.has(cur); cur = p.byId.get(cur)?.parent_task_id) { seen.add(cur); out.add(cur); }
      }
    }
  }
  return out;
}

/** One pass of the state rule over every lead's open threads. Returns how many moved. */
export async function runThreadFollowPass(): Promise<number> {
  const { isFollower } = await import('../server-role.js');
  if (isFollower()) return 0;
  const { orgTasks } = await import('./org-store.js');
  const p = orgPlaces(await orgTasks());
  const nodes = await readAllNodes(p);
  watched = watchSet(nodes, p);
  let n = 0;
  for (const move of planThreadFollows(nodes, p)) if (await runMove(move, 'agent', { tellFrom: true }, 'work')) n++;
  return n;
}

export interface HandOffResult {
  moved: Array<{ id: string; title: string; to: MoveEnd }>;
  linked: Array<{ id: string; title: string }>;
  /** Why the named thread was not handed on. */
  refused?: string;
}

/**
 * A node handed work to task `target` (a send, a start, a create). With `threadId`, that thread of
 * the caller's goes with it: to the target's node when that is another node, else it only lists the
 * target. With `handsOn` (a request handed on), the caller's open threads that list the target go to
 * its node when that is another lead. Null when nothing was asked of a thread. Never throws.
 */
export async function handOffThread(input: { callerSid?: string; target: string; threadId?: string; handsOn?: boolean }): Promise<HandOffResult | null> {
  if (!input.threadId && !input.handsOn) return null;
  try {
    const { resolveBoardCaller } = await import('../boards/board-team.js');
    const caller = await resolveBoardCaller(input.callerSid);
    const refuse = (why: string): HandOffResult | null => (input.threadId ? { moved: [], linked: [], refused: why } : null);
    if (caller.kind !== 'task') return refuse('Only Main or a lead keeps Threads: no thread was handed on.');
    const { orgTasks } = await import('./org-store.js');
    const p = orgPlaces(await orgTasks());
    const from = p.byId.get(caller.taskId);
    const target = p.byId.get(input.target);
    if (!from || !isNode(from)) return refuse('Only Main or a lead keeps Threads: no thread was handed on.');
    if (!target) return refuse(`No task ${input.target}: no thread was handed on.`);
    const store = await import('./threads-store.js');
    const open = (await store.readThreads(from.id)).threads.filter(isOpen);
    const picked = input.threadId
      ? open.filter((t) => t.id === input.threadId)
      : open.filter((t) => (t.tasks ?? []).includes(target.id));
    if (input.threadId && !picked.length) return refuse(`No open thread ${input.threadId} on your Threads: none was handed on.`);
    const to = ownerNodeOf(target, p);
    const writer: ThreadWriter = `task:${from.id}`;
    const out: HandOffResult = { moved: [], linked: [] };
    for (const t of picked) {
      // The thread lists the task it went to (a node needs no chip of itself).
      if (to?.id !== target.id && !(t.tasks ?? []).includes(target.id)) {
        await store.patchThread(from.id, t.id, { add_tasks: [target.id] }, writer).catch(() => {});
      }
      if (!to || to.id === from.id || !openTask(to)) { out.linked.push({ id: t.id, title: t.title }); continue; }
      // hands_on alone moves it only to another lead's team; a thread named moves wherever its work went.
      if (!input.threadId && to.org_role !== 'lead') { out.linked.push({ id: t.id, title: t.title }); continue; }
      const why = `${orgDisplayTitle(from as Task)} handed it to ${q(target.title)}`;
      const tasks = (t.tasks ?? []).includes(target.id) || to?.id === target.id ? t.tasks : [...(t.tasks ?? []), target.id];
      const moved = await runMove({ from, to, threadId: t.id, title: t.title, why }, writer, { tellFrom: false, owners: ownersKey(tasks, p) }, 'hand');
      if (moved) out.moved.push({ id: t.id, title: t.title, to: end(to) });
    }
    return out.moved.length || out.linked.length ? out : null;
  } catch (err) {
    log.task.warn('org threads: hand-off failed', { target: input.target, threadId: input.threadId, error: err instanceof Error ? err.message : String(err) });
    return input.threadId ? { moved: [], linked: [], refused: `The thread was not handed on: ${err instanceof Error ? err.message : String(err)}` } : null;
  }
}

/** The line an op's outcome carries about a hand-off (empty when there was none). */
export function handOffLine(r: HandOffResult | null | undefined): string {
  if (!r) return '';
  const parts: string[] = [];
  for (const m of r.moved) parts.push(`Thread ${m.id} ${q(m.title)} moved to ${m.to.title}'s Threads with the work; it is closed on yours.`);
  for (const l of r.linked) parts.push(`Thread ${l.id} ${q(l.title)} lists this task now.`);
  if (r.refused) parts.push(r.refused);
  return parts.join(' ');
}

/**
 * Move one thread by hand (thread_move): to the node `to` names (a node's task id, a task whose
 * team's node takes it, a project or a VP's name), from any node.
 */
export async function moveThreadTo(input: { from: Task; threadId: string; to: string; by: ThreadWriter; why?: string }): Promise<{ thread: OrgThread; to: MoveEnd }> {
  const { orgTasks, resolveOrgContact } = await import('./org-store.js');
  const { ThreadError } = await import('./threads-model.js');
  const p = orgPlaces(await orgTasks());
  const want = input.to.trim();
  let target: FollowTask | undefined;
  if (want.length >= 6) {
    const { matchIdRef } = await import('../../lib/id-ref.js');
    const named = matchIdRef(p.byId.values(), want);
    if (named.length === 1) target = named[0];
  }
  if (!target) target = (await resolveOrgContact(want).catch(() => null))?.task;
  if (!target) throw new ThreadError('bad_input', 404, `No node, task, project or VP named "${want}". Read org_get for the nodes.`);
  const to = ownerNodeOf(p.byId.get(target.id) ?? target, p);
  if (!to) throw new ThreadError('bad_input', 404, `"${want}" is in no team Walnut can find.`);
  if (to.id === input.from.id) throw new ThreadError('same_node', 409, `Thread ${input.threadId} is already on ${orgDisplayTitle(to as Task)}'s Threads.`);
  if (!openTask(to)) throw new ThreadError('bad_input', 409, `${orgDisplayTitle(to as Task)} is closed: a thread moves only to an open node.`);
  const from = p.byId.get(input.from.id) ?? input.from;
  const why = input.why?.trim() || `${input.by === 'human' ? 'the user' : orgDisplayTitle(from as Task)} moved it there`;
  const { moveThread, readThreads } = await import('./threads-store.js');
  const listed = (await readThreads(from.id)).threads.find((t) => t.id === input.threadId)?.tasks;
  const thread = await moveThread({ from: end(from), to: end(to), threadId: input.threadId, by: input.by, why, kind: 'hand', owners: ownersKey(listed, p) });
  log.task.info('org thread moved by hand', { threadId: input.threadId, from: from.id, to: to.id, by: input.by });
  await tellNodes({ from, to, threadId: input.threadId, title: thread.title, why }, { tellFrom: input.by === 'human' });
  return { thread, to: end(to) };
}

const DEBOUNCE_MS = 5_000;
const SCAN_MS = 10 * 60_000;

/**
 * The primary runs the state rule on every change that can move a thread (a task a thread lists, or
 * one above it; any Org node; a node's threads; a bulk change) and every SCAN_MS, one pass at a time.
 * `WALNUT_THREAD_FOLLOW=0` turns it off.
 */
export function startThreadFollow(opts: { debounceMs?: number; firstMs?: number } = {}): { stop: () => void } {
  if (process.env.WALNUT_THREAD_FOLLOW === '0') return { stop: () => {} };
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  const debounce = opts.debounceMs ?? DEBOUNCE_MS;
  const nodeKeys = new Map<string, string>();
  const pass = async (): Promise<void> => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { await runThreadFollowPass(); } catch (err) {
      log.task.warn('org threads: follow pass failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
      if (again && !stopped) { again = false; schedule(); }
    }
  };
  const schedule = (): void => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; void pass(); }, debounce);
    timer.unref?.();
  };
  void (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    bus.subscribe('org-thread-follow', (event) => {
      const d = event.data as { task?: FollowTask | null; taskIds?: string[]; kind?: string } | undefined;
      if (event.name === EventNames.ORG_THREADS_CHANGED) {
        // Its own moves and answers read from a chat change no task list.
        if (d?.kind !== 'moved' && d?.kind !== 'answered') schedule();
        return;
      }
      const task = d?.task;
      if (!task) { schedule(); return; }
      if (isNode(task)) {
        // A node's own turns update it all the time: only what it leads, or its closing, can move a thread.
        const key = `${task.project ?? ''}|${(task.org_leads ?? []).join(',')}|${task.phase ?? ''}|${task.org_role ?? ''}`;
        if (nodeKeys.get(task.id) !== key) { nodeKeys.set(task.id, key); schedule(); }
        return;
      }
      if (watched.has(task.id) || d?.taskIds?.some((id) => watched.has(id))) schedule();
    }, { global: true, interest: [EventNames.TASK_CREATED, EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.ORG_THREADS_CHANGED] });
  })();
  const scan = setInterval(() => { void pass(); }, SCAN_MS);
  scan.unref?.();
  const first = setTimeout(() => { void pass(); }, opts.firstMs ?? 30_000);
  first.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearInterval(scan);
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe('org-thread-follow'));
    },
  };
}
