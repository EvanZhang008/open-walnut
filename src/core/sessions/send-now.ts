/**
 * Send a queued line now, and say what it waits on: one path for the person and the agent.
 *
 * A message the host did not take in time stays queued and goes out again on a clock
 * (claude-code-session.ts armSlowHostRetry). The web bubble shows the reason, the next
 * try and a Send now (2026-10-29). A message one task sent another waits the same way,
 * so its sender reads the same facts (request_get, the task_send outcome) and can send
 * it now (message_send_now), through the very path the bubble's button takes.
 */
import { bus, EventNames } from '../event-bus.js';
import { findQueuedMessage, unparkMessage } from '../session-message-queue.js';
import { log } from '../../logging/index.js';

export interface DeliveryWait {
  /** queued: in line, nothing holds it; waiting: the host did not take it in time, sent
   *  again on a clock; parked: set aside (a stop, a refusal), it goes only on a person's Retry. */
  state: 'queued' | 'waiting' | 'parked';
  messageId: string;
  sessionId: string;
  reason?: string;
  /** When Walnut sends it again by itself (ISO). */
  retryAt?: string;
}

async function runner() {
  return (await import('../../providers/claude-code-session.js')).sessionRunner;
}

/** The session's own slow-host clock: every row queued now waits behind it. Null when none runs. */
export async function sessionDeliveryWait(sessionId: string): Promise<{ reason: string; retryAt?: string } | null> {
  return (await runner()).deliveryWait(sessionId);
}

/** Where one queued row stands, wherever its queue moved; null once it left (delivered, or deleted). */
export async function deliveryWaitOf(messageId: string): Promise<DeliveryWait | null> {
  const row = await findQueuedMessage(messageId);
  if (!row) return null;
  const { sessionId } = row;
  if (row.status === 'parked') return { state: 'parked', messageId, sessionId, ...(row.parkedReason ? { reason: row.parkedReason } : {}) };
  const r = await runner();
  // The row's own note, else the session's clock: while it runs, every pending row goes
  // out with its next try (a row taken by a try that failed again can lose its note).
  const held = r.deliveryWait(sessionId, messageId) ?? (row.status === 'pending' ? r.deliveryWait(sessionId) : null);
  return held
    ? { state: 'waiting', messageId, sessionId, reason: held.reason, ...(held.retryAt ? { retryAt: held.retryAt } : {}) }
    : { state: 'queued', messageId, sessionId };
}

export type SendNowResult = { sent: true; sessionId: string } | { sent: false; why: 'gone' | 'parked'; reason?: string };

/**
 * Re-drain the queue the row sits in, now. Never a second copy: a row no longer queued
 * (it went in, or was deleted) sends nothing. A parked row (a person's Stop, a refusal)
 * is put back in line only for a person (`unpark`, the bubble's Retry); an agent's send
 * now leaves it parked, since that park was told to the asker and may be the user's call.
 */
export async function sendQueuedNow(input: {
  messageId: string; sessionId?: string; taskId?: string; message?: string; source: string; unpark?: boolean;
}): Promise<SendNowResult> {
  const row = await findQueuedMessage(input.messageId);
  if (!row || (input.sessionId && row.sessionId !== input.sessionId)) return { sent: false, why: 'gone' };
  if (row.status === 'parked' && !input.unpark) return { sent: false, why: 'parked', ...(row.parkedReason ? { reason: row.parkedReason } : {}) };
  const unparked = row.status === 'parked' ? await unparkMessage(row.sessionId, row.id) : false;
  log.web.info('send now: re-draining the queued row (no duplicate enqueue)', {
    sessionId: row.sessionId, messageId: row.id, unparked, source: input.source,
  });
  // SESSION_SEND → session-runner → handleSend → processNext, which takes whatever is
  // pending. No SESSION_MESSAGE_QUEUED: the row already exists under this id.
  bus.emit(EventNames.SESSION_SEND, {
    sessionId: row.sessionId, taskId: input.taskId, message: input.message || row.message,
  }, ['session-runner'], { source: input.source });
  return { sent: true, sessionId: row.sessionId };
}
