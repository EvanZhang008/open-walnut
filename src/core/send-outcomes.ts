/**
 * Cloud REPLICA: the outcomes ledger for phone session sends (send-queue.ts).
 *
 * The bank holds a message while it waits; this ledger remembers what became
 * of a message once nothing holds it any more, so a phone retry of the same
 * messageId is answered instead of delivered a second time, and a phone that was
 * told "queued" can ask what happened (GET /sessions/:id/messages/:messageId).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CLOUD_MODE, SEND_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

/**
 * A banked send is a message a human typed; it stops being worth delivering
 * long before it stops being storable. 24h covers an overnight lid-closed Mac
 * while making sure a week-old thought never surprises a session. The ledger
 * keeps what it knows for the same horizon (a retry that late is a new message).
 */
export const SEND_HORIZON_MS = 24 * 60 * 60_000;

// ── Outcomes ledger ──────────────────────────────────────────────────────────
//
// What this companion knows about a message, by (session, messageId), so a
// phone retry of the same id is answered from it instead of becoming a second
// delivery, and so a phone holding a "queued" message can ask what became of it
// (sendStatus in send-queue.ts):
//  - 'maybe-relayed':    a relay went out and its answer was lost; the primary
//                        may hold it. Never take the direct path for it.
//  - 'relayed':          the primary's queue took it (the relay answered ok).
//                        Never send it again by any path; its queue owns it.
//  - 'delivered-direct': the host's direct path delivered it. Never send it
//                        again, by either path (the primary never saw it).
//  - 'maybe-direct':     a direct delivery went out and its answer was lost. It
//                        may have run; sending it again could run it twice.
//  - 'not-sent':         it will never run, and provably never ran (a stop came
//                        after it, it waited past the bank's horizon, or the
//                        primary refused it). `code` + `message` say why.
//  - 'unknown':          a held message that cannot go, but that a relay once
//                        carried, so the primary MAY have run it before.
//  - 'withdrawn':        the Mac confirmed its queue does not hold it and will
//                        never take it (it removed a pending row, or never saw
//                        it, and fenced the id: mobile-relay-ledger.ts). Only
//                        the direct path may deliver it now; it is never
//                        relayed again (the Mac would refuse it).
//  - 'direct-intent':    a direct delivery of it is about to go out, or went
//                        out, and nothing recorded how it ended (written BEFORE
//                        the first request that can start a turn). A pass that
//                        finds it asks the host whether the message reached the
//                        CLI, and never sends it blind (send-direct-gate.ts).
// A relay writes 'maybe-relayed' (flagged `relayIntent`) and the session's relay
// index BEFORE its first byte goes out (gate r3, N2): a companion that dies with
// the relay out leaves the message relay-only on disk, so neither the route nor
// the sweep delivers it again by the host's direct path. An answer that proves
// the relay forwarded nothing (no bridge, no primary behind the host) puts the
// message back where it was (clearRelayIntent).
// 'maybe-relayed', 'withdrawn' and 'direct-intent' are not final; a final state
// is never overwritten by any of them. Every write is durable (fsync): these are
// the records that keep a message from running twice.
// Files: cache/send-queue/outcomes/<sha256(session, messageId)>.json, 24h.

export type SendOutcomeState =
  | 'maybe-relayed' | 'withdrawn' | 'direct-intent' | 'relayed' | 'delivered-direct' | 'maybe-direct' | 'not-sent' | 'unknown';

const OUTCOME_STATES: ReadonlySet<string> = new Set<SendOutcomeState>([
  'maybe-relayed', 'withdrawn', 'direct-intent', 'relayed', 'delivered-direct', 'maybe-direct', 'not-sent', 'unknown',
]);

/** A settled message: never sent again by any path, and a retry is answered from it. */
export function isFinalOutcome(state: SendOutcomeState): boolean {
  return state !== 'maybe-relayed' && state !== 'withdrawn' && state !== 'direct-intent';
}

export interface SendOutcome {
  state: SendOutcomeState;
  at: string;
  /** not-sent / unknown: the v1 error code a retry of this id is answered with. */
  code?: string;
  /** not-sent / unknown: the phone's sentence for it. */
  message?: string;
  /** direct-intent / relay intent: the state it had before (what an attempt that provably sent nothing returns it to). */
  prev?: SendOutcomeState;
  /** maybe-relayed written right before a relay went out (markRelayIntent), not after an answer was lost. */
  relayIntent?: boolean;
  /** direct-intent: its marker rides inside the delivery (send-markers-v1), so no marker proves it never ran. */
  ordered?: boolean;
}

const OUTCOMES_DIR = () => path.join(SEND_QUEUE_DIR, 'outcomes');

function outcomeFile(sessionId: string, messageId: string): string {
  const key = createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex');
  return path.join(OUTCOMES_DIR(), `${key}.json`);
}

export async function markSendOutcome(
  sessionId: string, messageId: string, state: SendOutcomeState,
  detail: { code?: string; message?: string; prev?: SendOutcomeState } = {},
): Promise<void> {
  if (!CLOUD_MODE) return;
  try {
    if (!isFinalOutcome(state)) {
      const prior = await readSendOutcome(sessionId, messageId);
      if (prior && isFinalOutcome(prior.state)) return;
    }
    await writeJsonFile(outcomeFile(sessionId, messageId), {
      sessionId, messageId, state, at: new Date().toISOString(),
      ...(detail.code ? { code: detail.code } : {}),
      ...(detail.message ? { message: detail.message } : {}),
      ...(detail.prev ? { prev: detail.prev } : {}),
    }, { durable: true });
  } catch (err) {
    log.session.warn('send-queue: could not record a send outcome', { sessionId, messageId, state, err: String(err) });
  }
  const { noteSessionRelay, settleSessionRelay } = await import('./send-relay-index.js');
  if (state === 'relayed' || state === 'maybe-relayed') await noteSessionRelay(sessionId, messageId);
  else if (state !== 'direct-intent') await settleSessionRelay(sessionId, messageId);
}

/**
 * Written right before the first request of a direct delivery that can start a
 * turn (direct-host-send.ts). Throws when it cannot be written: a delivery
 * whose intent is not on disk must not go out (a restart would send it blind).
 */
export async function markDirectIntent(sessionId: string, messageId: string, opts: { ordered?: boolean } = {}): Promise<void> {
  if (!CLOUD_MODE) return;
  const prior = await readSendOutcome(sessionId, messageId);
  if (prior && isFinalOutcome(prior.state)) throw new Error(`send outcome already settled: ${prior.state}`);
  await writeJsonFile(outcomeFile(sessionId, messageId), {
    sessionId, messageId, state: 'direct-intent', at: new Date().toISOString(),
    ...(prior && prior.state !== 'direct-intent' ? { prev: prior.state } : prior?.prev ? { prev: prior.prev } : {}),
    // Only when every request of this delivery carries its marker inside: a
    // second intent written for a legacy request keeps no claim it cannot keep.
    ...(opts.ordered === true && (prior?.state !== 'direct-intent' || prior.ordered === true) ? { ordered: true } : {}),
  }, { durable: true });
}

/**
 * Written right before a relay of it goes out: the message is relay-only on
 * disk, and the session's relay index names it, before the first byte leaves.
 * Throws when either cannot be written (the relay must not go out then). A
 * settled message is left alone: its relay is a dedupe at the Mac's queue.
 */
export async function markRelayIntent(sessionId: string, messageId: string): Promise<void> {
  if (!CLOUD_MODE) return;
  const prior = await readSendOutcome(sessionId, messageId);
  if (prior && isFinalOutcome(prior.state)) return;
  // An intent already on disk is a relay that may have gone out (a process that
  // died with it out): it stays maybe-relayed whatever this attempt learns.
  const prev: SendOutcomeState | undefined = prior?.relayIntent ? 'maybe-relayed' : prior?.state;
  await writeJsonFile(outcomeFile(sessionId, messageId), {
    sessionId, messageId, state: 'maybe-relayed', relayIntent: true, at: new Date().toISOString(),
    ...(prev ? { prev } : {}),
  }, { durable: true });
  const { noteSessionRelay } = await import('./send-relay-index.js');
  await noteSessionRelay(sessionId, messageId, { strict: true });
}

/**
 * The relay provably forwarded nothing (no bridge socket, no primary behind
 * the host, a daemon without the relay): the message is back where it was.
 */
export async function clearRelayIntent(sessionId: string, messageId: string): Promise<void> {
  if (!CLOUD_MODE) return;
  const current = await readSendOutcome(sessionId, messageId);
  if (current?.state !== 'maybe-relayed' || !current.relayIntent) return;
  try {
    if (current.prev) {
      await writeJsonFile(outcomeFile(sessionId, messageId), {
        sessionId, messageId, state: current.prev, at: new Date().toISOString(),
      }, { durable: true });
    } else {
      await fsp.rm(outcomeFile(sessionId, messageId), { force: true });
    }
  } catch (err) {
    // Left relay-only: the safe side (it waits for the Mac, never runs twice).
    log.session.warn('send-queue: could not clear a relay intent', { sessionId, messageId, err: String(err) });
    return;
  }
  if (current.prev !== 'maybe-relayed' && current.prev !== 'relayed') {
    const { settleSessionRelay } = await import('./send-relay-index.js');
    await settleSessionRelay(sessionId, messageId);
  }
}

/** The direct delivery provably never started a turn: the message is back where it was. */
export async function clearDirectIntent(sessionId: string, messageId: string): Promise<void> {
  if (!CLOUD_MODE) return;
  const current = await readSendOutcome(sessionId, messageId);
  if (current?.state !== 'direct-intent') return;
  if (current.prev) {
    await writeJsonFile(outcomeFile(sessionId, messageId), {
      sessionId, messageId, state: current.prev, at: new Date().toISOString(),
    }, { durable: true }).catch(() => {});
  } else {
    await fsp.rm(outcomeFile(sessionId, messageId), { force: true }).catch(() => {});
  }
}

export async function readSendOutcome(sessionId: string, messageId: string): Promise<SendOutcome | null> {
  if (!CLOUD_MODE) return null;
  try {
    const saved = JSON.parse(await fsp.readFile(outcomeFile(sessionId, messageId), 'utf-8')) as {
      state?: string; at?: string; sessionId?: string; messageId?: string; code?: unknown; message?: unknown; prev?: unknown;
      relayIntent?: unknown;
    };
    if (saved.sessionId !== sessionId || saved.messageId !== messageId) return null;
    if (!saved.state || !OUTCOME_STATES.has(saved.state)) return null;
    if (Date.now() - new Date(saved.at ?? 0).getTime() > SEND_HORIZON_MS) return null;
    return {
      state: saved.state as SendOutcomeState, at: saved.at ?? '',
      ...(typeof saved.code === 'string' ? { code: saved.code } : {}),
      ...(typeof saved.message === 'string' ? { message: saved.message } : {}),
      ...(typeof saved.prev === 'string' && OUTCOME_STATES.has(saved.prev) ? { prev: saved.prev as SendOutcomeState } : {}),
      ...(saved.relayIntent === true ? { relayIntent: true } : {}),
      ...((saved as { ordered?: unknown }).ordered === true ? { ordered: true } : {}),
    };
  } catch {
    return null;
  }
}

/** The sentence for a message that may have run, but whose answer was lost. */
export function unknownFateMessage(host: string): string {
  return `This message may already have reached ${host}, but the answer was lost. Check the conversation before sending it again.`;
}

/**
 * Drop what is older than the bank's own horizon (a retry that late is a new
 * message): outcomes, the stop fences bound to sends (send-queue.ts), and the
 * per-session relay index (send-relay-index.ts). A pass runs at most once a
 * minute, whatever calls it.
 */
let lastPruneAt = 0;
export async function pruneSendOutcomes(): Promise<void> {
  if (Date.now() - lastPruneAt < 60_000) return;
  lastPruneAt = Date.now();
  for (const dir of [OUTCOMES_DIR(), path.join(SEND_QUEUE_DIR, 'fences'), path.join(SEND_QUEUE_DIR, 'relays')]) {
    let names: string[];
    try { names = await fsp.readdir(dir); } catch { continue; }
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const st = await fsp.stat(file);
        // A fence outlives its outcome by an hour: a row is banked at most a horizon.
        const keepMs = dir === OUTCOMES_DIR() ? SEND_HORIZON_MS : SEND_HORIZON_MS + 60 * 60_000;
        if (Date.now() - st.mtimeMs > keepMs) await fsp.rm(file, { force: true });
      } catch { /* gone */ }
    }
  }
}

/** Tests only: let the next prune run at once. */
export function resetSendOutcomePruneClock(): void {
  lastPruneAt = 0;
}
