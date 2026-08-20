/**
 * Cloud → primary durable queue for phone SESSION SENDS (fast-accept).
 *
 * ## Why this exists (the gap it closes)
 *
 * A phone send rides POST /api/v1/sessions/:id/messages → the cloud replica →
 * the `session.message` bridge relay → the primary's durable message queue.
 * That relay is exactly-once by `messageId` and survives a daemon/CLI death
 * ANYWHERE AFTER the enqueue (the 2026-08-13 loss family). What it never
 * covered is the window BEFORE the enqueue: while the host has no live bridge
 * socket, `bridgeRequest` rejects with BridgeOfflineError and the route
 * answered 503 having written NOTHING. Durability started one hop too late.
 *
 * The phone's own 503 ladder (2/4/8/16/32s inside a 120s budget) was built to
 * ride that window out, but a bridge outage is not bounded by 120s: a real one
 * on 2026-08-20 lasted ~7 minutes (socket closed → two redials), so the ladder
 * exhausted and the bubble settled on the red "Not sent — tap to retry" while
 * the session itself was perfectly healthy and still STREAMING to the phone.
 * Raising the budget only moves the cliff; the fix is to stop requiring the
 * client to be present at the moment the link returns.
 *
 * So: when the relay cannot be attempted or provably never reached the primary,
 * the replica PERSISTS the send here and answers 202 with the same messageId
 * the phone already holds. Drain triggers are the same trio the sibling queues
 * use (core/task-queue.ts, core/control-queue.ts): the primary's bridge
 * reconnect, opportunism after a later successful send, and a 60s floor sweep.
 *
 * ## Why accepting a send is safe (it is NOT the same call as `mode`)
 *
 * The queued thing is not a fabricated success: enqueueing a message is the
 * ONLY thing the primary would have done synchronously, and the primary's own
 * queue is what owns delivery (FIFO / mid-turn / --resume) with reconnect
 * redelivery. A 202 already means "accepted, not delivered" in this contract,
 * so a queued 202 tells the phone exactly the truth it told before. Contrast
 * with session-lifecycle-v1's `mode` patch, which reconfigures a live CLI and
 * therefore stays a synchronous relay.
 *
 * Replays are harmless in BOTH directions: every row carries the client's
 * stable `qm-*` id, the primary's queue dedupes on it (session-message-queue
 * `enqueueMessage`), and the relay ledger in providers/daemon-connection.ts
 * closes the post-delivery window.
 *
 * ## What is deliberately NOT queued
 *
 * - A relay failure that MIGHT have enqueued on the primary (transport death
 *   mid-relay, relay timeout). Queuing that would risk a second delivery the
 *   moment the ledger has rotated; the route keeps reporting those as 503 so
 *   the phone retries with the same id and the dedupe decides.
 * - Image sends. The attachments live on the SESSION'S HOST, saved through the
 *   `image.save` bridge command — with no bridge there is no host-side file to
 *   reference, and banking the text alone would deliver a turn whose pictures
 *   silently vanished. Those keep the honest 503 + client ladder.
 * - A session the primary declared unknown/dead (404/409): a domain answer,
 *   not a transport gap.
 *
 * Files: cache/send-queue/<opId>.json (NON-git on both boxes).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { CLOUD_MODE, SEND_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';

export interface QueuedSessionSend {
  opId: string;
  at: string;
  sessionId: string;
  /** The exec host alias the send must be relayed to (NOT always '__local__'). */
  host: string;
  message: string;
  /** Client-stable `qm-*` id — the exactly-once anchor end to end. */
  messageId: string;
}

const FLUSH_INTERVAL_MS = 60_000;
const FLUSH_BATCH_MAX = 50;
/** Same budget the live route gives the relay (the daemon's own is 45s). */
const RELAY_RPC_TIMEOUT_MS = 50_000;
/**
 * A banked send is a message a human typed; it stops being worth delivering
 * long before it stops being storable. 24h covers an overnight lid-closed Mac
 * while making sure a week-old thought never surprises a session.
 */
const MAX_AGE_MS = 24 * 60 * 60_000;

let opSeq = 0;

function mintOpId(): string {
  return `${Date.now().toString().padStart(15, '0')}-${(opSeq++).toString().padStart(4, '0')}`;
}

/**
 * CLOUD box: durably bank one phone send for background delivery. Called only
 * after the synchronous relay could not be attempted (no bridge socket) or
 * provably never reached the primary — never as the first choice, so a live
 * bridge still gets authoritative synchronous behavior.
 *
 * Returns the opId, or null when the queue write itself failed (the caller then
 * falls back to the honest 503 — never a 202 for something we did not store).
 */
export async function enqueueSessionSend(
  sessionId: string, host: string, message: string, messageId: string,
): Promise<string | null> {
  if (!CLOUD_MODE) return null;
  const op: QueuedSessionSend = {
    opId: mintOpId(), at: new Date().toISOString(), sessionId, host, message, messageId,
  };
  try {
    await writeJsonFile(path.join(SEND_QUEUE_DIR, `${op.opId}.json`), op);
    log.session.info('send-queue: phone send banked (bridge unavailable)', {
      opId: op.opId, sessionId, host, messageId, chars: message.length,
    });
    return op.opId;
  } catch (err) {
    log.session.error('send-queue: FAILED to bank phone send — message will not reach the session', {
      sessionId, host, messageId, err: String(err),
    });
    return null;
  }
}

/**
 * Drop the banked row for a messageId. Used when a relay that blew the route's
 * answer deadline later reported success: the primary already holds the message,
 * so re-relaying it would only exercise the dedupe. Best-effort — leaving the
 * row is harmless (idempotent by messageId), removing it is just tidier.
 */
export async function dropBankedSend(messageId: string): Promise<boolean> {
  if (!CLOUD_MODE) return false;
  let names: string[];
  try {
    names = (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json'));
  } catch {
    return false;
  }
  for (const name of names) {
    const file = path.join(SEND_QUEUE_DIR, name);
    try {
      const op = JSON.parse(await fsp.readFile(file, 'utf-8')) as QueuedSessionSend;
      if (op?.messageId !== messageId) continue;
      await fsp.rm(file, { force: true });
      log.session.info('send-queue: banked send dropped (relay confirmed late)', {
        opId: op.opId, sessionId: op.sessionId, messageId,
      });
      return true;
    } catch { continue; }
  }
  return false;
}

/** Pending banked sends (diagnostics/tests). */
export async function queuedSessionSendCount(): Promise<number> {
  try {
    return (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

let flushing = false;

/**
 * Sweep the queue oldest-first (opIds sort chronologically, and message ORDER
 * within a session matters — unlike the LWW task/patch queues, so this one
 * stops at the first transport failure rather than skipping ahead).
 *
 * Per row: relay it, delete on success OR on a domain rejection (the primary
 * ran it and refused — an identical retry refuses identically), keep on
 * transport failure. Rows past MAX_AGE_MS are dropped loudly.
 */
export async function flushSendQueue(): Promise<number> {
  if (!CLOUD_MODE || flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    let names: string[];
    try {
      names = (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return 0;
    }
    const { bridgeRequest, BridgeOfflineError } = await import('../web/ws/bridge-registry.js');
    for (const name of names.slice(0, FLUSH_BATCH_MAX)) {
      const file = path.join(SEND_QUEUE_DIR, name);
      let op: QueuedSessionSend;
      try {
        op = JSON.parse(await fsp.readFile(file, 'utf-8')) as QueuedSessionSend;
        if (!op?.opId || !op.sessionId || !op.host || !op.message || !op.messageId) throw new Error('malformed op');
      } catch (err) {
        log.session.warn('send-queue: unreadable banked send — removing', { file, err: String(err) });
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - new Date(op.at).getTime() > MAX_AGE_MS) {
        log.session.warn('send-queue: banked send expired before the bridge returned — dropping', {
          opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, at: op.at,
        });
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      let reply: Record<string, unknown>;
      try {
        reply = await bridgeRequest(op.host, 'session.message', {
          sessionId: op.sessionId, message: op.message, messageId: op.messageId,
        }, RELAY_RPC_TIMEOUT_MS);
      } catch (err) {
        if (err instanceof BridgeOfflineError) break; // still down — the rest would fail identically
        // Transport death mid-relay: the enqueue MAY have committed. Keep the
        // row; the messageId dedupe makes the eventual retry exactly-once.
        log.session.warn('send-queue: relay transport failed — keeping banked send', {
          opId: op.opId, sessionId: op.sessionId, err: err instanceof Error ? err.message : String(err),
        });
        break;
      }
      if (reply.ok === true) {
        log.session.info('send-queue: banked send delivered to the primary queue', {
          opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
        });
      } else {
        const reason = String(reply.error ?? 'unknown');
        // "no primary server connected" = the daemon is up but its walnut
        // server is down. Nothing can enqueue yet, so this is transport, not a
        // domain refusal — keep the row and stop.
        if (reason.includes('no primary server connected') || reason.startsWith('unknown command')) {
          log.session.info('send-queue: primary not ready for banked sends yet — retrying later', {
            opId: op.opId, reason,
          });
          break;
        }
        log.session.warn('send-queue: primary rejected banked send — dropping', {
          opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, reason,
        });
      }
      await fsp.rm(file, { force: true }).catch(() => {});
      sent++;
    }
    return sent;
  } finally {
    flushing = false;
  }
}

/**
 * CLOUD box: start the drain triggers (same trio as task-queue/control-queue):
 * primary bridge (re)connect, post-enqueue opportunism is the caller's job, and
 * a 60s unref'd floor sweep.
 *
 * Note the bridge hook fires on the PRIMARY's reconnect only, while a banked
 * send may target another exec host. That is deliberate and sufficient: a
 * remote host's own send relay still terminates at the primary's server, so
 * the primary's link is the binding constraint, and the 60s sweep covers a
 * remote-only flap.
 */
export function startSendQueueFlush(): { stop: () => void } {
  const timer = setInterval(() => { void flushSendQueue(); }, FLUSH_INTERVAL_MS);
  timer.unref?.();
  let unhook: (() => void) | null = null;
  void (async () => {
    try {
      const { addPrimaryBridgeConnectedHandler } = await import('../web/ws/bridge-registry.js');
      unhook = addPrimaryBridgeConnectedHandler(() => {
        log.session.info('send-queue: primary bridge connected — draining banked phone sends');
        void flushSendQueue();
      });
    } catch (err) {
      log.session.warn('send-queue: could not hook the bridge-connected trigger', { err: String(err) });
    }
  })();
  return {
    stop: () => {
      clearInterval(timer);
      unhook?.();
    },
  };
}
