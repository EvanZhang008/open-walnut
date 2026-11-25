/**
 * His reply on a thread that popped up from a task below (thread-popup.ts; experiment
 * `threads_pop_up`; 2026-11-20, the user: "if we reply I think it should go directly to that
 * thread, also send a buffer message to the main agent"). Wherever he answers, the reply is
 * written into the one record on the owner's Threads and goes to the owner's session as his own
 * message; the leaders above get one line riding their next message (thread-answered-notes.ts),
 * never a wake.
 *
 * Each reply keeps its way there on the message (`delivery`, threads-model.ts):
 *
 *   pending ──wake──▶ claimed (in the owner's queue, after its running turn) ──read──▶ delivered
 *      │                                                                     └─▶ the leaders' line, once
 *      └─ the thread closed before it went ──▶ dropped
 *
 * One wake per owner: a burst of replies to one task's cards gathers for GATHER_MS and goes as one
 * message. At the wake the owner's threads are read again under the lock, so a reply whose
 * thread settled meanwhile is dropped, not sent. With no session (or the task closed) the replies
 * stay pending and go when a session of the task starts (SESSION_STARTED) or at the sweep.
 */
import crypto from 'node:crypto';
import { log } from '../../logging/index.js';
import type { SessionRecord } from '../types.js';
import { threadsPopUpNow } from './thread-popup-rules.js';
import { oneIdNow } from './thread-one-id.js';
import { deliveryOpen, type FileMessageResult, type OrgThread, type ThreadDelivery, type ThreadMessage, type ThreadWriter } from './threads-model.js';

const GATHER_MS = 1_500;
const SWEEP_MS = 5 * 60_000;

function gatherMs(): number {
  const n = Number(process.env.WALNUT_THREAD_REPLY_GATHER_MS);
  return Number.isFinite(n) && n >= 0 && process.env.WALNUT_THREAD_REPLY_GATHER_MS !== '' ? n : GATHER_MS;
}

const q = (s: string) => JSON.stringify(s);
/** A claim this young whose row left the queue is waiting for its delivered event, never sent again. */
const CLAIM_SETTLES_MS = 10 * 60_000;

/** Owner → its one pending wake. */
const wakes = new Map<string, ReturnType<typeof setTimeout>>();
const flushing = new Set<string>();
const again = new Set<string>();
/** Owners holding a reply not yet sent (filled by a reply and by the sweep). */
const pendingOwners = new Set<string>();
/** Queue row → owner, for the delivered event. */
const queuedRows = new Map<string, string>();

export interface ThreadReplyInput {
  /** The node whose card he answered on. */
  viewer: string;
  /** The node that holds the thread (its owner). */
  node: string;
  threadId: string;
  text: string;
  images?: string[];
  /** The ask his card showed (PoppedThread.ask_id). */
  askId?: string;
  by: ThreadWriter;
  at: string;
  /** The send's own id: the same reply again is filed once. */
  key?: string;
}

/** File his reply on the owner's thread, pending, and line up the owner's one wake. */
export async function replyOnThread(input: ThreadReplyInput): Promise<FileMessageResult & { node: string }> {
  const store = await import('./threads-store.js');
  const cur = (await store.readThreads(input.node)).threads.find((t) => t.id === input.threadId);
  const stale = !!input.askId && (!cur || !!cur.closed || cur.state !== 'needs' || cur.askId !== input.askId);
  const delivery: ThreadDelivery = { state: 'pending', at: input.at, via: input.viewer, ...(input.by !== 'human' ? { by: input.by } : {}) };
  const res = await store.fileThreadMessage(input.node, {
    text: input.text, images: input.images ?? [], via: 'follow-up', threadId: input.threadId, at: input.at,
    key: input.key ?? `pr-${crypto.randomBytes(6).toString('hex')}`, delivery,
    ...(input.askId ? { answers: { ask_id: input.askId, ...(stale ? { stale: true } : {}) } } : {}),
  });
  if (!res.duplicate) {
    pendingOwners.add(res.node);
    scheduleWake(res.node);
  }
  log.task.info('org thread reply filed on its owner', { viewer: input.viewer, owner: res.node, threadId: res.thread.id, messageId: res.message.id, stale, duplicate: res.duplicate });
  return res;
}

/** At most one wake waits per owner: later replies join it. */
export function scheduleWake(owner: string): void {
  if (wakes.has(owner)) return;
  const timer = setTimeout(() => { wakes.delete(owner); void flushOwner(owner); }, gatherMs());
  timer.unref?.();
  wakes.set(owner, timer);
}

async function flushOwner(owner: string): Promise<void> {
  if (flushing.has(owner)) { again.add(owner); return; }
  flushing.add(owner);
  try {
    await deliverPending(owner);
  } catch (err) {
    log.task.warn('org thread replies not delivered', { owner, error: err instanceof Error ? err.message : String(err) });
  } finally {
    flushing.delete(owner);
    if (again.delete(owner)) scheduleWake(owner);
  }
}

async function sessionOf(owner: string): Promise<SessionRecord | null> {
  const { listTasksByIds } = await import('../task-manager.js');
  const task = (await listTasksByIds([owner]))[0];
  return task ? (await import('./thread-popup.js')).ownerSession(task) : null;
}

function backToPending(d: ThreadDelivery, at: string): ThreadDelivery {
  return { state: 'pending', at, ...(d.via ? { via: d.via } : {}), ...(d.by ? { by: d.by } : {}) };
}

const humanOf = (m: ThreadMessage) => !m.delivery?.by || m.delivery.by === 'human';

async function deliverPending(owner: string): Promise<void> {
  const session = await sessionOf(owner);
  // Kept: sent when a session of the task starts, or at the sweep.
  if (!session) return;
  const store = await import('./threads-store.js');
  const at = new Date().toISOString();
  const qm = `qm-reply-${crypto.randomUUID()}`;
  // One sender per message: his own replies go as his, an agent's as its own.
  let human: boolean | undefined;
  const claimed = await store.updateReplyDeliveries(owner, (t, m) => {
    if (m.delivery!.state !== 'pending') return undefined;
    if (t.closed) return { ...m.delivery!, state: 'dropped', at };
    human ??= humanOf(m);
    if (humanOf(m) !== human) return undefined;
    return { ...m.delivery!, state: 'claimed', at, queued: qm };
  });
  const going = claimed.filter((c) => c.message.delivery?.state === 'claimed');
  if (claimed.some((c) => c.message.delivery?.state === 'dropped')) {
    log.task.info('org thread replies dropped: their threads settled first', { owner, messages: claimed.filter((c) => c.message.delivery?.state === 'dropped').map((c) => c.message.id) });
  }
  if (!going.length) { if (!(await store.hasOpenDeliveries(owner))) pendingOwners.delete(owner); return; }
  queuedRows.set(qm, owner);
  try {
    await sendReplies(session, owner, going, qm, human !== false);
  } catch (err) {
    queuedRows.delete(qm);
    await store.updateReplyDeliveries(owner, (_t, m) => (m.delivery?.queued === qm && m.delivery.state === 'claimed' ? backToPending(m.delivery, at) : undefined));
    throw err;
  }
  log.task.info('org thread replies sent to their owner', { owner, sessionId: session.claudeSessionId, messageId: qm, replies: going.map((g) => g.message.id) });
  if (await store.hasOpenDeliveries(owner)) again.add(owner);
  else pendingOwners.delete(owner);
}

function wordsOf(m: ThreadMessage, header: (paths: readonly string[]) => string): string {
  return `${header(m.images ?? [])}${m.text}`;
}

/**
 * One message into the owner's session, after its running turn (queue-after-turn.ts): his words as
 * he wrote them, under the threads hint of the first; several replies each say their thread. A
 * reply to an ask the thread no longer asks gets Walnut's note riding in front, never in his words.
 */
async function sendReplies(s: SessionRecord, owner: string, going: Array<{ thread: OrgThread; message: ThreadMessage }>, qm: string, human: boolean): Promise<void> {
  const sid = s.claudeSessionId;
  const { attachmentHeaderBlock } = await import('../../lib/attachment-headers.js');
  const header = (paths: readonly string[]) => attachmentHeaderBlock('images', paths);
  const body = going.length === 1
    ? wordsOf(going[0].message, header)
    : going.map((g) => `In thread ${g.thread.id} ${q(g.thread.title)}:\n${wordsOf(g.message, header)}`).join('\n\n');
  const { rideLine } = await import('../sessions/status-riding.js');
  for (const g of going) {
    if (!g.message.answers?.stale) continue;
    rideLine(sid, `thread-stale:${g.message.id}`, `- His reply in thread ${g.thread.id} ${q(g.thread.title)} answers what it asked before${g.thread.ask ? `; it asks now: ${q(g.thread.ask)}` : ''}. Read his words against what the thread asks now.`);
  }
  const first = going[0];
  const { prepareHintedSend } = await import('../hints/hint-send.js');
  const { sendMessageToSession } = await import('../session-message-queue.js');
  // Already filed (under its key): the capture finds it filed and only names the thread.
  const prepared = await prepareHintedSend(sid, s, body, { sentBy: human ? 'person' : 'agent', threadId: first.thread.id, ...(first.message.key ? { threadKey: first.message.key } : {}) });
  await sendMessageToSession(sid, prepared.displayText, {
    source: human ? 'ui' : 'agent', taskId: owner, enqueueMessage: prepared.enqueueText, hinted: true, messageId: qm, afterTurn: true,
  });
  // Queued: from here it is on its way, whatever the hints' bookkeeping does (never sent twice).
  await prepared.commit(sid).catch((err: unknown) => log.task.warn('org thread replies: hints not committed', { owner, error: err instanceof Error ? err.message : String(err) }));
}

async function markWithdrawn(owner: string, qm: string): Promise<void> {
  const store = await import('./threads-store.js');
  const at = new Date().toISOString();
  await store.updateReplyDeliveries(owner, (_t, m) => (m.delivery?.queued === qm && m.delivery.state === 'claimed' ? { ...m.delivery, state: 'dropped', at, withdrawn: true } : undefined));
  queuedRows.delete(qm);
}

/**
 * The task that owns these threads read them in its own Threads (thread_list, or one thread): his
 * replies on them still on its way are in its hands now (2026-11-20: a reply held behind a stuck
 * queue row stayed "on its way" after the task had read it there, and every thread_update of the
 * task was refused with reply_pending while its stop hook asked for that very update). Each is
 * marked delivered (`read: 'threads'`); a queue row that carries only such replies and still waits
 * is withdrawn, so his words reach the task once. The leaders are told as for any delivery.
 */
export async function repliesReadByOwner(owner: string, threadIds: readonly string[]): Promise<number> {
  const store = await import('./threads-store.js');
  const ids = new Set(threadIds);
  if (!(await store.readThreads(owner)).threads.some((t) => ids.has(t.id) && t.messages.some(deliveryOpen))) return 0;
  const at = new Date().toISOString();
  const read = await store.updateReplyDeliveries(owner, (t, m) => (ids.has(t.id) && deliveryOpen(m) ? { ...m.delivery!, state: 'delivered', at, read: 'threads' } : undefined));
  const rows = new Set(read.map((r) => r.message.delivery?.queued).filter((qm): qm is string => !!qm));
  if (rows.size) {
    const { deleteMessage, findQueuedMessage } = await import('../session-message-queue.js');
    // A row that also carries a reply on a thread the task did not read keeps going.
    const still = new Set((await store.readThreads(owner)).threads.flatMap((t) => t.messages.filter(deliveryOpen).map((m) => m.delivery?.queued)));
    const sid = (await sessionOf(owner).catch(() => null))?.claudeSessionId;
    for (const qm of rows) {
      queuedRows.delete(qm);
      const row = still.has(qm) ? null : await findQueuedMessage(qm);
      if (row && row.status !== 'processing') await deleteMessage(row.sessionId, qm).catch(() => false);
      // Read by pull: its row reads `read` in the delivery ledger, not `queued` for ever (2026-11-24
      // audit). A row that also carries a reply not read here, or one already in the CLI, reads as the CLI reads it.
      if (!still.has(qm) && row?.status !== 'processing') {
        void import('../sessions/delivery-ledger.js').then((l) => l.recordDelivery({
          step: 'read', ids: [qm], via: 'threads', taskId: owner, ...(row?.sessionId ?? sid ? { sessionId: row?.sessionId ?? sid } : {}),
        })).catch(() => {});
      }
    }
  }
  if (!(await store.hasOpenDeliveries(owner))) pendingOwners.delete(owner);
  log.task.info('org thread replies read by their owner in its Threads', { owner, messages: read.map((r) => r.message.id), rows: [...rows] });
  if (read.length) await tellAbove(owner);
  return read.length;
}

/**
 * A task's threads changed: every node that lists them above it hears it as a change of its own
 * Threads (`kind: 'below'`), so its list, its count and its dot follow; owners changed within
 * VIEWERS_MS go together.
 */
const VIEWERS_MS = 250;
const changedOwners = new Set<string>();
let viewersTimer: ReturnType<typeof setTimeout> | null = null;
function noteOwnerChanged(owner: string): void {
  changedOwners.add(owner);
  if (viewersTimer) return;
  viewersTimer = setTimeout(() => {
    viewersTimer = null;
    const owners = [...changedOwners];
    changedOwners.clear();
    void (async () => {
      const { orgTasks } = await import('./org-store.js');
      const { viewerIdsOf } = await import('./thread-popup.js');
      const { bus, EventNames } = await import('../event-bus.js');
      const all = await orgTasks();
      for (const o of owners) {
        for (const v of await viewerIdsOf(o, all)) {
          bus.emit(EventNames.ORG_THREADS_CHANGED, { taskId: v, kind: 'below', owner: o }, ['web-ui'], { source: 'org-threads' });
        }
      }
    })().catch((err) => log.task.warn('org threads: the nodes above were not told', { error: err instanceof Error ? err.message : String(err) }));
  }, VIEWERS_MS);
  viewersTimer.unref?.();
}

/** The owner's session read the replies in row `qm`: delivered, then the leaders above hear it once. */
export async function markDelivered(owner: string, qm: string): Promise<void> {
  const store = await import('./threads-store.js');
  const at = new Date().toISOString();
  const done = await store.updateReplyDeliveries(owner, (_t, m) => (m.delivery?.queued === qm && m.delivery.state === 'claimed' ? { ...m.delivery, state: 'delivered', at } : undefined));
  queuedRows.delete(qm);
  if (done.length) await tellAbove(owner);
}

/** Each delivered reply the leaders were not told of yet: one line each, riding their next message. */
async function tellAbove(owner: string): Promise<void> {
  const store = await import('./threads-store.js');
  const untold = (await store.readThreads(owner)).threads.flatMap((t) => t.messages.filter((m) => m.delivery?.state === 'delivered' && !m.delivery.told).map((m) => ({ t, m })));
  if (!untold.length) return;
  const told = new Set(untold.map((x) => x.m.id));
  await store.updateReplyDeliveries(owner, (_t, m) => (told.has(m.id) && m.delivery && !m.delivery.told ? { ...m.delivery, told: true } : undefined));
  try {
    const { orgTasks, leadSession } = await import('./org-store.js');
    const { openTask, viewerIdsOf } = await import('./thread-popup.js');
    const { keepsThreads } = await import('./keeps-threads.js');
    const { orgDisplayTitle } = await import('./org-tree.js');
    const { rideAnswered } = await import('./thread-answered-notes.js');
    const all = await orgTasks();
    const ownerTask = all.find((t) => t.id === owner);
    if (!ownerTask) return;
    const byId = new Map(all.map((t) => [t.id, t] as const));
    const name = orgDisplayTitle(ownerTask);
    for (const id of await viewerIdsOf(owner, all)) {
      const v = byId.get(id);
      if (!v || !keepsThreads(v) || !openTask(v)) continue;
      const s = await leadSession(id).catch(() => null);
      if (!s) continue;
      for (const { t } of untold) await rideAnswered(s.claudeSessionId, `- ${q(name)} (${owner}): he answered its thread ${t.id} ${q(t.title)}.`);
    }
  } catch (err) {
    log.task.warn('org thread reply: the leaders were not told', { owner, error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Every node's replies on their way, read again (a boot, every SWEEP_MS): pending ones get their
 * wake when the owner can take them; a claimed one whose row went out as a line is delivered (its
 * event came before this server mapped the row); one whose queue row is gone with no line (a
 * crash before it was queued) goes back to pending: sent again rather than lost, and the leaders
 * are never told of a reply that did not arrive. Delivered
 * ones the leaders were not told of are told.
 */
export async function sweepThreadReplies(): Promise<void> {
  const { threadsPopUpOn } = await import('./thread-popup-rules.js');
  // threads_one_id: a handed thread's card takes his replies the same way (thread-one-id.ts).
  if (!(await threadsPopUpOn()) && !(await (await import('./thread-one-id.js')).oneIdOn())) return;
  const store = await import('./threads-store.js');
  const { findQueuedMessage } = await import('../session-message-queue.js');
  const { wentOutAsLine } = await import('../session-queue-lines.js');
  for (const node of await store.threadTaskIds()) {
    const msgs = (await store.readThreads(node)).threads.flatMap((t) => t.messages.filter((m) => m.delivery));
    if (!msgs.length) continue;
    if (msgs.some((m) => m.delivery!.state === 'pending')) { pendingOwners.add(node); scheduleWake(node); }
    for (const m of msgs.filter((x) => x.delivery!.state === 'claimed')) {
      const qm = m.delivery!.queued;
      if (qm && await findQueuedMessage(qm)) { queuedRows.set(qm, node); continue; }
      // Its row went out as a line and left the queue (its delivered event fell before this
      // server mapped the row, at a restart): delivered, never sent a second time.
      if (qm && await wentOutAsLine(qm)) { await markDelivered(node, qm); continue; }
      // Its delivered event may still be on its way.
      if (qm && queuedRows.has(qm) && Date.now() - Date.parse(m.delivery!.at) < CLAIM_SETTLES_MS) continue;
      if (qm) queuedRows.delete(qm);
      const at = new Date().toISOString();
      await store.updateReplyDeliveries(node, (_t, x) => (x.id === m.id && x.delivery?.state === 'claimed' ? backToPending(x.delivery, at) : undefined));
      pendingOwners.add(node);
      scheduleWake(node);
    }
    if (msgs.some((m) => m.delivery!.state === 'delivered' && !m.delivery!.told)) await tellAbove(node);
  }
}

/** Primary only (server.ts): the delivered events, a session coming back for an owner, the sweep. */
export function startThreadReplies(opts: { firstMs?: number } = {}): { stop: () => void } {
  let stopped = false;
  void (async () => {
    const { bus, EventNames } = await import('../event-bus.js');
    if (stopped) return;
    bus.subscribe('org-thread-replies', (event) => {
      const d = (event.data ?? {}) as { messageIds?: string[]; taskId?: string; kind?: string };
      if (event.name === EventNames.SESSION_MESSAGES_DELIVERED) {
        for (const id of d.messageIds ?? []) {
          const owner = queuedRows.get(id);
          if (owner) void markDelivered(owner, id).catch(() => {});
        }
        return;
      }
      if (event.name === EventNames.SESSION_QUEUED_CANCELLED) {
        // He took his reply back from the queue: it stays in the thread, and is not sent again.
        for (const id of d.messageIds ?? []) {
          const owner = queuedRows.get(id);
          if (owner) void markWithdrawn(owner, id).catch(() => {});
        }
        return;
      }
      if (event.name === EventNames.ORG_THREADS_CHANGED) {
        if (d.taskId && d.kind !== 'below' && (threadsPopUpNow() || oneIdNow())) noteOwnerChanged(d.taskId);
        return;
      }
      if (d.taskId && pendingOwners.has(d.taskId)) scheduleWake(d.taskId);
    }, { global: true, interest: [EventNames.SESSION_MESSAGES_DELIVERED, EventNames.SESSION_QUEUED_CANCELLED, EventNames.SESSION_STARTED, EventNames.ORG_THREADS_CHANGED] });
  })();
  const sweep = () => { void sweepThreadReplies().catch((err) => log.task.warn('org thread replies: sweep failed', { error: err instanceof Error ? err.message : String(err) })); };
  const first = setTimeout(sweep, opts.firstMs ?? 20_000);
  first.unref?.();
  const every = setInterval(sweep, SWEEP_MS);
  every.unref?.();
  return {
    stop: () => {
      stopped = true;
      if (viewersTimer) clearTimeout(viewersTimer);
      viewersTimer = null;
      changedOwners.clear();
      clearTimeout(first);
      clearInterval(every);
      for (const t of wakes.values()) clearTimeout(t);
      wakes.clear();
      void import('../event-bus.js').then(({ bus }) => bus.unsubscribe('org-thread-replies'));
    },
  };
}

/** Test seam: the wakes waiting now. */
export function _pendingWakes(): string[] { return [...wakes.keys()]; }
