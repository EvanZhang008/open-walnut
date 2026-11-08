/**
 * The panel's queued bubbles brought in line with the server's queue
 * (`session:get-queue`). Pure; useSessionSend runs it on every queue read.
 *
 * 2026-11-09, the user: "everything shows queued, why does every session freeze
 * without any warning", then "the newer message is delivered but the older one
 * is still queued". The server's queue file lock had jammed for ~40 minutes; rows
 * were delivered, taken by the CLI, or lost, but the events that move a bubble
 * never came, so each panel kept the Queued badge it drew at send time. The
 * events stay the fast path; a read of the queue is the truth they are checked
 * against.
 *
 * Rules, per bubble (a launch prompt, unless its row is parked, and a bubble whose send has not answered
 * yet, a `temp-` id, are left as they are):
 *   - its row waits (pending, held, after the turn) → Queued, with the row's reason;
 *   - its row is on its way (written, taken, processing and not held) → Delivered;
 *   - its row is parked → failed (Retry / Discard), with the server's reason;
 *   - the queue no longer has it → it leaves the queued list: Delivered, marked
 *     `leftQueueAt` so the chat refetches history (which absorbs it) and can say
 *     plainly if history never shows it.
 * A Delivered bubble whose row reads waiting again (its delivery was reverted and
 * the event saying so was lost) reads Queued again, so a lost event never leaves
 * either badge wrong. Nothing a read could not have seen is judged from it: a
 * bubble adopted after the read began, moved by an event since, or with a send,
 * retry, delete or edit of its own still in flight (`touched`).
 * Rows the panel has no bubble for are added, except ones it already retired
 * (removed after its batch, deleted, dismissed, absorbed by history).
 * The list is kept in the order the messages were enqueued, the server's order.
 */
import type { OptimisticMessage } from '@/components/sessions/SessionChatHistory';
import type { QueueRowWire } from './useSessionSend';
import type { SendAck } from '@/api/session-send';
import { acceptedBubble } from '@/components/sessions/send-acceptance';

export interface ReconcileContext {
  /** Real queue ids the panel held when the read began: only these can be judged gone. */
  known: ReadonlySet<string>;
  /** Ids an event moved after the read began: the read may be older than that move. */
  touched: ReadonlySet<string>;
  /** Ids this panel removed on purpose: a read that still lists one does not bring it back. */
  retired: ReadonlySet<string>;
  /** Clock for `leftQueueAt`. */
  now: number;
  /** The bubble a reload shows for a row (useSessionSend queueRowBubble). */
  toBubble: (row: QueueRowWire) => OptimisticMessage | null;
}

/** A bubble whose send has not answered: its id is the client's own, the server has none yet. */
export const isClientId = (queueId: string): boolean => queueId.startsWith('temp-');

type RowVerdict =
  | { kind: 'waiting'; heldReason?: string; afterTurn?: boolean }
  | { kind: 'sent' }
  | { kind: 'parked'; reason?: string; waitsFor?: string };

/** What the server's row says of the message. */
export function rowVerdict(row: QueueRowWire): RowVerdict {
  if (row.status === 'parked') return { kind: 'parked', ...(row.parkedReason ? { reason: row.parkedReason } : {}), ...(row.waitsFor ? { waitsFor: row.waitsFor } : {}) };
  if (row.delivered === true || row.stage === 'taken' || row.stage === 'written') return { kind: 'sent' };
  const held = (row.status === 'processing' || row.status === 'pending') && !!row.heldReason;
  // The server's stage is its word: `waiting` holds a processing row it cannot vouch for as
  // written (a cold resume, a line mid-delivery). Only an older server, with no stage, is read by status.
  if (row.stage === undefined && row.status === 'processing' && !held) return { kind: 'sent' };
  return { kind: 'waiting', ...(held ? { heldReason: row.heldReason } : {}), ...(row.afterTurn ? { afterTurn: true } : {}) };
}

function withoutWaitFacts(m: OptimisticMessage): OptimisticMessage {
  const { heldReason: _h, afterTurn: _a, failedError: _f, parked: _p, waitsFor: _w, ...rest } = m;
  return rest as OptimisticMessage;
}

function applyVerdict(m: OptimisticMessage, v: RowVerdict, touched: boolean): OptimisticMessage {
  if (v.kind === 'sent') {
    // An event since the read began (a delivery held, a revert) is newer than this read.
    if (m.status === 'delivered' || touched) return m;
    return { ...withoutWaitFacts(m), status: 'delivered' };
  }
  if (v.kind === 'parked') {
    if (touched || (m.status === 'failed' && m.parked && m.failedError === v.reason && m.waitsFor === v.waitsFor)) return m;
    // A launch prompt the server parked is no launch prompt any more: it reads as the
    // message that was not sent, with its Retry (parked-bubbles.ts).
    const { launch: _launch, ...base } = withoutWaitFacts(m);
    return {
      ...base, status: 'failed', parked: true, serverUndelivered: true,
      ...(v.reason ? { failedError: v.reason } : {}), ...(v.waitsFor ? { waitsFor: v.waitsFor } : {}),
    } as OptimisticMessage;
  }
  // Waiting. A failed bubble keeps its Retry; a Delivered one reads Queued again
  // unless something moved it after the read began.
  if (m.status === 'failed') return m;
  if (m.status === 'delivered' && touched) return m;
  if (m.status === 'received' && m.heldReason === v.heldReason && !!m.afterTurn === !!v.afterTurn) return m;
  const { leftQueueAt: _l, ...base } = withoutWaitFacts(m);
  return {
    ...base,
    status: 'received',
    ...(v.heldReason ? { heldReason: v.heldReason } : {}),
    ...(v.afterTurn ? { afterTurn: true } : {}),
  };
}

const timeOf = (m: OptimisticMessage): number => {
  const t = Date.parse(m.timestamp ?? '');
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/**
 * Enqueue order: the launch prompt first, then every bubble the server has an id
 * for by its enqueue time (ties: the server's row order, then the list's), then
 * the sends still waiting for their answer, as they were made.
 */
export function orderByEnqueue(list: OptimisticMessage[], serverIndex: ReadonlyMap<string, number> = new Map()): OptimisticMessage[] {
  const keyed = list.map((m, i) => ({
    m, i,
    group: m.launch ? 0 : isClientId(m.queueId) ? 2 : 1,
    t: timeOf(m),
    s: serverIndex.get(m.queueId) ?? Number.POSITIVE_INFINITY,
  }));
  keyed.sort((a, b) => a.group - b.group
    || (a.group === 1 ? (a.t - b.t || a.s - b.s) : 0)
    || a.i - b.i);
  const out = keyed.map((k) => k.m);
  return out.every((m, i) => m === list[i]) ? list : out;
}

/** The bubbles after one queue read. Returns `prev` itself when nothing changed. */
export function reconcileWithQueue(prev: OptimisticMessage[], rows: readonly QueueRowWire[], ctx: ReconcileContext): OptimisticMessage[] {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const serverIndex = new Map(rows.map((r, i) => [r.id, i] as const));
  let changed = false;
  const next: OptimisticMessage[] = [];
  for (const m of prev) {
    if (isClientId(m.queueId)) { next.push(m); continue; }
    const row = byId.get(m.queueId);
    // A launch prompt is the head of the conversation: only a park of its row (a refused
    // first message, same id) changes it (parked-bubbles.ts).
    if (m.launch) {
      const v = row ? rowVerdict(row) : undefined;
      const after = v?.kind === 'parked' ? applyVerdict(m, v, ctx.touched.has(m.queueId)) : m;
      if (after !== m) changed = true;
      next.push(after);
      continue;
    }
    if (row) {
      const after = applyVerdict(m, rowVerdict(row), ctx.touched.has(m.queueId));
      if (after !== m) changed = true;
      next.push(after);
      continue;
    }
    // The queue no longer has it.
    if (!ctx.known.has(m.queueId) || ctx.touched.has(m.queueId)) { next.push(m); continue; }
    if (m.status === 'pending' || m.status === 'received') {
      changed = true;
      next.push({ ...withoutWaitFacts(m), status: 'delivered', leftQueueAt: ctx.now });
      continue;
    }
    if (m.status === 'failed' && m.parked) { changed = true; continue; } // nothing left to discard
    next.push(m);
  }
  const have = new Set(next.map((m) => m.queueId));
  for (const row of rows) {
    if (have.has(row.id) || ctx.retired.has(row.id)) continue;
    const bubble = ctx.toBubble(row);
    if (!bubble) continue;
    changed = true;
    next.push(bubble);
  }
  const ordered = orderByEnqueue(changed ? next : prev, serverIndex);
  return ordered === prev ? prev : ordered;
}

/**
 * The panel's first read of the queue (a mount, a session switch): the rows join in
 * enqueue order (a send made while the read was in flight keeps its place after them)
 * and nothing is judged gone. The launch prompt opens the first turn, so it leads,
 * unless a row stands under its id (a refused first message, parked: that row is
 * the bubble, with its Retry; parked-bubbles.ts).
 */
export function rehydrateFromQueue(
  prev: OptimisticMessage[],
  rows: readonly QueueRowWire[],
  launch: OptimisticMessage | null,
  ctx: Pick<ReconcileContext, 'retired' | 'now' | 'toBubble'>,
): OptimisticMessage[] {
  const merged = reconcileWithQueue(prev, rows, { ...ctx, known: new Set(), touched: new Set() });
  const head = launch && !merged.some((m) => m.queueId === launch.queueId) ? [launch] : [];
  return head.length ? [...head, ...merged] : merged;
}

/**
 * A send's answer gives its bubble the server's id. A queue read that answered
 * first may already hold a bubble for that row (it read the row, not knowing the
 * client id): the send's own bubble stays (it has the pictures and hints the
 * person sent) and the read's copy goes, so no message shows twice. A copy the
 * read already saw delivered keeps the bubble delivered. What the answer itself
 * says (a lost answer's stand-in, a row the server parked, a line that already
 * ran) is send-acceptance.ts acceptedBubble.
 */
export function adoptSendAnswer(
  prev: OptimisticMessage[],
  clientId: string,
  res: SendAck,
  adopted: 'received' | 'delivered',
): OptimisticMessage[] {
  const copy = clientId !== res.messageId ? prev.find((m) => m.queueId === res.messageId) : undefined;
  const sentAlready = copy?.status === 'delivered';
  const list = copy ? prev.filter((m) => m !== copy) : prev;
  return list.map((m) => (m.queueId === clientId ? acceptedBubble(m, res, adopted === 'delivered' || sentAlready) : m));
}
