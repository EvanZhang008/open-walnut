/**
 * The one rule for "the server accepted this message" (`session:send`).
 *
 * A send is accepted when its RPC answers, OR when the server shows it holds the
 * send's user line: the queue's `session:message-queued` event naming the send's
 * `userUuid`, or a queue read that lists a row carrying it. The second half is the
 * lost acknowledgement (2026-11-11 review, F3): the server queued the message and
 * the CLI answered it, but the RPC's answer never reached the client (a dropped
 * socket, a timeout, a proxy). The composer read the error as a refusal: the
 * words came back into the box, so Enter sent them twice, and a red error line
 * stayed over a conversation that had the answer in it.
 *
 * Every web send of a person's message goes through `sendSessionMessage` (the
 * guard test, tests/web/send-acceptance-guard.test.ts, fails on any other
 * `'session:send'` call), so every composer reads the same outcome: resolved =
 * accepted, thrown = refused. A refusal the server later proves it kept after all
 * (its queued event arrives late, history shows the line) reaches the bubbles and
 * composers through `onKept` (useSessionSend) and the draft store's settle
 * (utils/drafts.ts settleRetriedDraft).
 *
 * The proof is the user-line uuid, minted fresh for every send (utils/thread-tree.ts
 * newUserUuid): a row carrying it can only be this send's. A send without one
 * (no crypto.randomUUID) keeps the old rule: its RPC answer is the only proof.
 */
import { wsClient } from '@/api/ws';
import { withSendTestRun } from '@/api/test-run';
import { log } from '@/utils/log';
import { newUserUuid } from '@/utils/thread-tree';
import type { QueueRowWire } from '@/hooks/useSessionSend';

/** What the server holds for a send's user line. */
export interface KeptRow {
  sessionId: string;
  userUuid: string;
  /** The server's queue id (`qm-…`). */
  messageId: string;
  enqueuedAt?: string;
  /** The CLI already read it (the queue read's stage `taken`). */
  delivered?: boolean;
  /** The server parked it (not delivered, Retry sends it): kept, but not on its way. */
  parked?: { reason?: string; waitsFor?: string };
}

/** The `session:send` answer, as every caller reads it. `recovered`: the answer was lost, the server's own record stood in. */
export interface SendAck {
  messageId: string;
  dedupText?: string;
  enqueuedAt?: string;
  engineSwitch?: { state?: string };
  deliveredTo?: string;
  alreadyDelivered?: boolean;
  recovered?: KeptRow;
}

const KEPT_MAX = 200;
const KEPT_TTL_MS = 30 * 60_000;
/** How long the queue read that stands in for a lost answer may take. */
export const CONFIRM_READ_MS = 8_000;

const kept = new Map<string, KeptRow & { at: number }>();
const listeners = new Set<(row: KeptRow) => void>();
const keyOf = (sessionId: string, userUuid: string) => `${sessionId}\n${userUuid}`;

/** The server holds this send's user line: remembered, and every listener told once. */
export function noteKept(row: KeptRow): void {
  const key = keyOf(row.sessionId, row.userUuid);
  const had = kept.get(key);
  kept.set(key, { ...had, ...row, at: Date.now() });
  while (kept.size > KEPT_MAX) kept.delete(kept.keys().next().value!);
  if (had && had.messageId === row.messageId && !!had.delivered === !!row.delivered && !!had.parked === !!row.parked) return;
  for (const cb of [...listeners]) { try { cb(row); } catch { /* one reader never stops another */ } }
}

/** What the server is known to hold for `userUuid` of `sessionId`, if anything. */
export function keptRowOf(sessionId: string, userUuid: string | undefined): KeptRow | undefined {
  if (!userUuid) return undefined;
  const row = kept.get(keyOf(sessionId, userUuid));
  if (!row) return undefined;
  if (Date.now() - row.at > KEPT_TTL_MS) { kept.delete(keyOf(sessionId, userUuid)); return undefined; }
  const { at: _at, ...rest } = row;
  return rest;
}

/** Told whenever the server shows it holds a send's line (a late proof included). */
export function onKept(cb: (row: KeptRow) => void): () => void {
  watchQueuedEvents();
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** A queue row as proof: its id, and how far it got. */
export function keptFromQueueRow(sessionId: string, m: QueueRowWire): KeptRow | undefined {
  if (!m.userUuid || !m.id) return undefined;
  return {
    sessionId, userUuid: m.userUuid, messageId: m.id,
    ...(m.enqueuedAt ? { enqueuedAt: m.enqueuedAt } : {}),
    // Written to the CLI (a processing row not held back) or read by it: the bubble reads delivered, as on a reload.
    ...(m.delivered === true || m.stage === 'taken' || (m.status === 'processing' && !m.heldReason) ? { delivered: true } : {}),
    ...(m.status === 'parked' ? { parked: { ...(m.parkedReason ? { reason: m.parkedReason } : {}), ...(m.waitsFor ? { waitsFor: m.waitsFor } : {}) } } : {}),
  };
}

let watching = false;
/** The queue's event names the user line of every row it stores (server: session-message-queue.ts). */
function watchQueuedEvents(): void {
  if (watching || typeof wsClient.onEvent !== 'function') return;
  watching = true;
  wsClient.onEvent('session:message-queued', (data: unknown) => {
    const d = data as { sessionId?: unknown; messageId?: unknown; userUuid?: unknown; enqueuedAt?: unknown } | null;
    if (!d || typeof d.sessionId !== 'string' || typeof d.messageId !== 'string' || typeof d.userUuid !== 'string') return;
    noteKept({ sessionId: d.sessionId, userUuid: d.userUuid, messageId: d.messageId, ...(typeof d.enqueuedAt === 'string' ? { enqueuedAt: d.enqueuedAt } : {}) });
  });
}

function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(what)), ms); });
  return Promise.race([p, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Does the server hold the user line `userUuid`? The queue event already said so,
 * or a queue read lists its row. Undefined: no proof (refused, or already out of
 * the queue; history settles that one later, useSessionSend settleShownInHistory).
 */
export async function confirmKept(sessionId: string, userUuid: string): Promise<KeptRow | undefined> {
  const known = keptRowOf(sessionId, userUuid);
  if (known) return known;
  try {
    const res = await withDeadline(
      wsClient.sendRpc<{ messages?: QueueRowWire[] }>('session:get-queue', { sessionId }), CONFIRM_READ_MS, 'queue read timed out');
    for (const m of res?.messages ?? []) {
      const row = m.userUuid === userUuid ? keptFromQueueRow(sessionId, m) : undefined;
      if (row) { noteKept(row); return row; }
    }
  } catch (e) {
    log.warn('send', 'could not read the queue to confirm a send', { sessionId, error: (e as Error).message });
  }
  return keptRowOf(sessionId, userUuid);
}

/**
 * Send a person's message to a session. Resolves when the server accepted it
 * (its answer, or its own record of the line when the answer was lost); throws
 * the RPC's error when nothing shows the server kept it. `userUuid` absent: one
 * is minted (an engine switch's send keeps none: it starts another session).
 * `timeoutMs`: an answer slower than that counts as lost, and the record decides.
 */
export async function sendSessionMessage<T extends SendAck = SendAck>(
  payload: { sessionId: string; message: string; userUuid?: string; switchEngine?: unknown } & Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<T> {
  watchQueuedEvents();
  const userUuid = payload.userUuid ?? (payload.switchEngine ? undefined : newUserUuid());
  const body = userUuid && !payload.userUuid ? { ...payload, userUuid } : payload;
  try {
    // A test-run window says so on each send, as its HTTP requests do with the header.
    const rpc = wsClient.sendRpc<T>('session:send', withSendTestRun(body));
    return await (opts?.timeoutMs ? withDeadline(rpc, opts.timeoutMs, `no answer in ${Math.round(opts.timeoutMs / 1000)}s`) : rpc);
  } catch (e) {
    if (!userUuid || payload.switchEngine) throw e;
    const row = await confirmKept(payload.sessionId, userUuid);
    if (!row) throw e;
    log.info('send', 'the answer was lost, the server kept the message', {
      sessionId: payload.sessionId, messageId: row.messageId, error: (e as Error).message,
    });
    return {
      messageId: row.messageId,
      ...(row.enqueuedAt ? { enqueuedAt: row.enqueuedAt } : {}),
      ...(row.delivered ? { alreadyDelivered: true } : {}),
      recovered: row,
    } as T;
  }
}
