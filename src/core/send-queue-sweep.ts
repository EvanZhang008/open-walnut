/**
 * Cloud REPLICA: one pass of the phone-send sweep (send-queue.ts owns the bank
 * and the triggers; this file owns what a pass does with each held row).
 *
 * Every row ends one of three ways, and the phone is never left holding a
 * "queued" message that silently went away: it is delivered (by the primary's
 * queue, or by the host's direct path when no primary is behind the host), it
 * waits (its host or session is held this pass), or it is settled as one that
 * will not go, with the sentence the phone is told (send-outcomes.ts).
 *
 * Nothing here starts a delivery the session-order rule forbids, and a direct
 * delivery whose outcome a crash lost is resolved by asking the host, never by
 * sending it again (send-direct-gate.ts).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { SEND_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';
import type { QueuedSessionSend } from './send-queue.js';
import { directSendRunning } from './sessions/direct-host-send.js';
import {
  CloudImageError, imageSaveInFlight, readHeldImages, removeHeldImages, saveImagesViaBridge, withImagePaths,
} from './sessions/cloud-images.js';
import {
  markSendOutcome, readSendOutcome, pruneSendOutcomes, unknownFateMessage, isFinalOutcome, SEND_HORIZON_MS,
  markRelayIntent, clearRelayIntent,
} from './send-outcomes.js';
import { directDeliveryGate, resolveDirectIntent, type GatePass } from './send-direct-gate.js';

/** Delivery attempts per pass (rows that only wait behind a held one do not count). */
const FLUSH_ATTEMPTS_MAX = 50;
/** Same budget the live route gives the relay (the daemon's own is 45s). */
const RELAY_RPC_TIMEOUT_MS = 50_000;

/** What the phone is told for a message a person removed on the Mac before it ran. */
export const REMOVED_ON_MAC = 'Not sent: it was removed on your Mac before it ran.';

/**
 * A held row that will not go: write what the phone is told FIRST, then remove
 * the row, so there is never a moment where the message is neither held nor
 * accounted for. A row nothing ever carried is 'not-sent'; one a relay carried
 * may have run before, so it is 'unknown' and says so.
 */
async function settleUnsendable(
  op: QueuedSessionSend, file: string, code: string, notSentMessage: string, why: string,
): Promise<void> {
  const host = op.hostName ?? op.host;
  if (op.provablyUnsent === true) {
    await markSendOutcome(op.sessionId, op.messageId, 'not-sent', { code, message: notSentMessage });
  } else {
    await markSendOutcome(op.sessionId, op.messageId, 'unknown', {
      code: 'delivery_unknown',
      message: `This message may not have reached ${host} before it could no longer go (${why}). Check the conversation before sending it again.`,
    });
  }
  await removeRow(op, file);
}

/** A row leaves the bank with the pictures kept for it. */
async function removeRow(op: QueuedSessionSend, file: string): Promise<void> {
  await fsp.rm(file, { force: true }).catch(() => {});
  if (op.heldImages?.length) await removeHeldImages(op.opId, op.heldImages.length);
}

/**
 * A held send's pictures go to its host first, and the row's text then names
 * the files. 'hold' = the host cannot take them now (no bridge, a timeout);
 * 'refused' = it never will (an old daemon, a picture it turns down).
 */
async function saveRowImages(
  op: QueuedSessionSend, file: string,
): Promise<{ row: QueuedSessionSend } | { hold: 'offline' | 'transient' } | { refused: string; code: string }> {
  const images = await readHeldImages(op.opId, op.heldImages ?? []);
  if (!images) return { refused: 'its pictures could not be read back', code: 'image_upload_failed' };
  let paths: string[];
  try {
    paths = await saveImagesViaBridge(op.host, op.sessionId, images, op.hostName);
  } catch (err) {
    if (err instanceof CloudImageError) return { refused: err.message, code: err.code };
    const { BridgeOfflineError } = await import('../web/ws/bridge-registry.js');
    return { hold: err instanceof BridgeOfflineError ? 'offline' : 'transient' };
  }
  const row: QueuedSessionSend = { ...op, message: withImagePaths(op.message, paths) };
  delete row.heldImages;
  await writeJsonFile(file, row);
  await removeHeldImages(op.opId, images.length);
  return { row };
}

async function rewriteRow(op: QueuedSessionSend): Promise<void> {
  try { await writeJsonFile(path.join(SEND_QUEUE_DIR, `${op.opId}.json`), op); } catch { /* best effort: a sentence, not delivery */ }
}

/** Mark a banked row relay-only (a relay of it went out and its answer was lost). */
async function markRowMaybeRelayed(op: QueuedSessionSend): Promise<void> {
  if (op.provablyUnsent !== true) return;
  const next: QueuedSessionSend = { ...op };
  delete next.provablyUnsent;
  try { await writeJsonFile(path.join(SEND_QUEUE_DIR, `${op.opId}.json`), next); } catch { /* the outcome below still says so */ }
  await markSendOutcome(op.sessionId, op.messageId, 'maybe-relayed');
}

/** The relay's answer means it timed out somewhere past the companion: never a refusal. */
function isTimeoutReason(reason: string): boolean {
  const r = reason.toLowerCase();
  return r.includes('timed out') || r.includes('timeout');
}

/**
 * One pass over the rows for `onlyHost` (every host when absent). `waitingSoon`
 * = a row was left waiting on a hop that usually comes back within seconds (no
 * primary behind the host yet, a relay that timed out or lost its transport),
 * so the caller drains again soon (send-queue.ts scheduleSoonFlush).
 */
export async function flushOnce(onlyHost?: string): Promise<{ sent: number; waitingSoon: boolean }> {
  let names: string[];
  try {
    names = (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return { sent: 0, waitingSoon: false };
  }
  void pruneSendOutcomes();
  if (names.length === 0) return { sent: 0, waitingSoon: false };
  const { bridgeRequest, BridgeOfflineError } = await import('../web/ws/bridge-registry.js');
  const { projectedStops, stopSupersedes, STOPPED_AFTER_SEND } = await import('./sessions/cloud-stop-fence.js');
  const { earliestSendInFlight, relayStillOut } = await import('./send-order.js');
  // The stops the primary last reported, read once for the pass.
  const stops = await projectedStops();
  /** Hosts that cannot take a row now: every later row for them waits. */
  const heldHosts = new Set<string>();
  /** Sessions with an earlier row still waiting: their later rows wait behind it. */
  const heldSessions = new Set<string>();
  let sent = 0;
  let waitingSoon = false;
  const pass: GatePass = { macUnreachable: false };
  // The budget counts delivery attempts, not rows read: a session or host held
  // this pass with many rows behind it must not use up the pass for the rows of
  // every other session and host after them.
  let attempts = 0;
  for (const name of names) {
    if (attempts >= FLUSH_ATTEMPTS_MAX) break;
    const file = path.join(SEND_QUEUE_DIR, name);
    let op: QueuedSessionSend;
    try {
      op = JSON.parse(await fsp.readFile(file, 'utf-8')) as QueuedSessionSend;
      if (!op?.opId || !op.sessionId || !op.host || !op.message || !op.messageId) throw new Error('malformed op');
    } catch (err) {
      await settleUnreadable(file, err);
      continue;
    }
    if (onlyHost !== undefined && op.host !== onlyHost) continue;
    const host = op.hostName ?? op.host;
    if (Date.now() - new Date(op.at).getTime() > SEND_HORIZON_MS) {
      log.session.warn('send-queue: banked send expired before the host could take it; telling the phone', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, at: op.at,
      });
      await settleUnsendable(op, file, 'send_expired', `Not sent: it waited more than a day for ${host}.`, 'it waited more than a day');
      continue;
    }
    if (heldHosts.has(op.host) || heldSessions.has(op.sessionId)) continue;
    // A send of the session accepted before this row is still being handed
    // over: the row waits behind it; its answer drains the session again.
    // So does a row whose direct delivery is running here right now.
    const earlier = earliestSendInFlight(op.sessionId);
    if ((earlier !== null && earlier < rowAcceptedAt(op)) || directSendRunning(op.messageId)) {
      heldSessions.add(op.sessionId);
      continue;
    }
    // The route's own relay of it is still out: never a second one beside it.
    if (relayStillOut(op.messageId)) {
      heldSessions.add(op.sessionId);
      waitingSoon = true;
      continue;
    }
    attempts++;
    // Settled by another path already (a phone retry, a late relay answer): never send it again.
    const prior = await readSendOutcome(op.sessionId, op.messageId);
    if (prior && isFinalOutcome(prior.state)) {
      await removeRow(op, file);
      continue;
    }
    // A direct delivery went out, or was about to, and its end was never
    // recorded (the companion restarted): ask the host, never send it blind.
    // Only a delivery whose marker rode inside it can be proven never to have
    // run (send-markers-v1); it then goes back in line where it was.
    if (prior?.state === 'direct-intent') {
      const fate = await resolveDirectIntent(op, prior);
      if (fate === 'unreachable') { heldHosts.add(op.host); waitingSoon = true; continue; }
      if (fate === 'not-delivered') {
        const { clearDirectIntent } = await import('./send-outcomes.js');
        await clearDirectIntent(op.sessionId, op.messageId);
        log.session.info('send-queue: a direct delivery a restart interrupted never reached the CLI; it goes again', {
          opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
        });
        heldSessions.add(op.sessionId);
        waitingSoon = true;
        continue;
      }
      if (fate === 'delivered') {
        await markSendOutcome(op.sessionId, op.messageId, 'delivered-direct');
        sent++;
      } else {
        await markSendOutcome(op.sessionId, op.messageId, 'maybe-direct', { code: 'delivery_unknown', message: unknownFateMessage(host) });
      }
      log.session.warn('send-queue: resolved a direct delivery a restart interrupted', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, fate,
      });
      await removeRow(op, file);
      continue;
    }
    // A stop the companion knows of overtook it: it never runs, whichever path.
    const overtaken = await stopSupersedes(op.sessionId, op.stopFence ?? null, rowAcceptedAt(op), stops);
    if (overtaken) {
      log.session.warn('send-queue: banked send predates a later stop; telling the phone', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
      });
      await settleUnsendable(op, file, 'session_stopped', overtaken, 'the session was stopped');
      sent++; // off the queue, as a refusal from the primary is
      continue;
    }
    // Pictures first: the host must have them before the text naming them goes.
    if (op.heldImages?.length) {
      // The route is still saving them (a slow link): its end drains again.
      if (imageSaveInFlight(op.messageId)) { heldSessions.add(op.sessionId); continue; }
      const saved = await saveRowImages(op, file);
      if ('hold' in saved) {
        heldHosts.add(op.host);
        if (saved.hold === 'transient') waitingSoon = true;
        continue;
      }
      if ('refused' in saved) {
        await settleUnsendable(op, file, saved.code, `Not sent: ${saved.refused}`, saved.refused);
        sent++;
        continue;
      }
      op = saved.row;
    }
    // The Mac gave it back and fenced it: only the direct path may deliver it,
    // and a relay of it would be refused there (mobile-relay-ledger.ts).
    if (prior?.state === 'withdrawn') {
      const outcome = await deliverBankedDirect(op, file, { freed: true, pass });
      if (outcome === 'delivered') sent++;
      else if (outcome === 'hold-session') { heldSessions.add(op.sessionId); waitingSoon = true; }
      else if (outcome === 'hold-host') { heldHosts.add(op.host); waitingSoon = true; }
      continue;
    }
    // Relay-only on disk BEFORE the first byte (gate r3, N2b): a companion that
    // dies with this relay out must not deliver the row directly after it restarts.
    try { await markRelayIntent(op.sessionId, op.messageId); }
    catch { heldHosts.add(op.host); waitingSoon = true; continue; }
    let reply: Record<string, unknown>;
    try {
      reply = await bridgeRequest(op.host, 'session.message', {
        sessionId: op.sessionId, message: op.message, messageId: op.messageId, stopFence: op.stopFence ?? null,
      }, RELAY_RPC_TIMEOUT_MS);
    } catch (err) {
      heldHosts.add(op.host);
      if (err instanceof BridgeOfflineError) {
        // No socket: nothing left. Still down: its other rows would fail identically.
        await clearRelayIntent(op.sessionId, op.messageId);
        continue;
      }
      // Transport death mid-relay: the enqueue MAY have committed. Keep the
      // row, relay-only from now on; the messageId dedupe makes the eventual
      // retry exactly-once.
      await markRowMaybeRelayed(op);
      waitingSoon = true;
      log.session.warn('send-queue: relay transport failed; keeping banked send', {
        opId: op.opId, sessionId: op.sessionId, err: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (reply.ok === true) {
      log.session.info('send-queue: banked send delivered to the primary queue', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
      });
      // Remembered BEFORE the row goes: a phone retry of this id is answered, never sent again.
      await markSendOutcome(op.sessionId, op.messageId, 'relayed');
      await removeRow(op, file);
      sent++;
      continue;
    }
    const reason = String(reply.error ?? 'unknown');
    // The Mac refused it as one it gave back: the direct path is its only one.
    if (reply.errorKind === 'withdrawn') {
      await markSendOutcome(op.sessionId, op.messageId, 'withdrawn');
      const outcome = await deliverBankedDirect(op, file, { freed: true, pass });
      if (outcome === 'delivered') sent++;
      else if (outcome === 'hold-session') { heldSessions.add(op.sessionId); waitingSoon = true; }
      else if (outcome === 'hold-host') { heldHosts.add(op.host); waitingSoon = true; }
      continue;
    }
    if (reply.errorKind === 'removed') {
      await settleUnsendable({ ...op, provablyUnsent: true }, file, 'removed_on_mac', REMOVED_ON_MAC, 'it was removed on the Mac');
      sent++;
      continue;
    }
    // No primary behind the host ("no primary server connected"), or a daemon
    // that predates the relay ("unknown command"): the daemon forwarded nothing.
    if (reason.includes('no primary server connected') || reason.startsWith('unknown command')) {
      // This relay forwarded nothing: the row is back where it was.
      await clearRelayIntent(op.sessionId, op.messageId);
      // The host answered, so the wait, if any, is for the Mac (its link to the
      // host): the phone's sentence says so.
      if ((op.macLinkDown !== true || op.hostSilent) && reason.includes('no primary server connected')) {
        op = { ...op, macLinkDown: true, hostSilent: undefined };
        await rewriteRow(op);
      }
      const outcome = await deliverBankedDirect(op, file, { pass });
      if (outcome === 'delivered') sent++;
      else if (outcome === 'hold-session') { heldSessions.add(op.sessionId); waitingSoon = true; }
      else if (outcome === 'hold-host') { heldHosts.add(op.host); waitingSoon = true; }
      continue;
    }
    // "timed out": the daemon handed it to a primary that did not answer (the
    // 2026-08-21 incident: a Mac ASLEEP with its socket half alive; this branch
    // once read that as a domain REJECTION and DROPPED two sends the phone had
    // been told were accepted). A timeout is never a refusal; and the primary
    // may now hold the message, so the row is relay-only from here.
    if (isTimeoutReason(reason)) {
      await markRowMaybeRelayed(op);
      // The host answered (for the Mac behind it): the wait is for the Mac now.
      // (markRowMaybeRelayed above made it relay-only; that stays.)
      if (op.hostSilent) await rewriteRow({ ...op, provablyUnsent: undefined, hostSilent: undefined });
      heldHosts.add(op.host);
      waitingSoon = true;
      log.session.info('send-queue: primary not ready for banked sends yet; retrying later', { opId: op.opId, reason });
      continue;
    }
    // The primary ran it and refused (a domain answer: an identical retry is
    // refused identically). The phone was told "queued", so it is told this too.
    log.session.warn('send-queue: primary refused a banked send; telling the phone', {
      opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, reason,
    });
    if (reply.errorKind === 'session_stopped') {
      await settleUnsendable(op, file, 'session_stopped', STOPPED_AFTER_SEND, 'the session was stopped');
    } else {
      await settleUnsendable(op, file, String(reply.errorKind ?? 'send_refused'), `Not sent: ${host} refused it (${reason}).`, reason);
    }
    sent++;
  }
  return { sent, waitingSoon };
}

/** When the phone's send reached the companion; rows from before the field use their bank time. */
function rowAcceptedAt(op: QueuedSessionSend): number {
  if (typeof op.acceptedAt === 'number' && Number.isFinite(op.acceptedAt)) return op.acceptedAt;
  const at = new Date(op.at).getTime();
  return Number.isFinite(at) ? at : 0;
}

/**
 * A row that cannot be parsed into a send. When its ids survive, the phone that
 * holds it is told it is lost (it may have been carried before, so 'unknown');
 * a file with no ids left cannot be matched to any phone message.
 */
async function settleUnreadable(file: string, err: unknown): Promise<void> {
  let ids: { sessionId?: unknown; messageId?: unknown } = {};
  try { ids = JSON.parse(await fsp.readFile(file, 'utf-8')) as typeof ids; } catch { /* no ids left */ }
  if (typeof ids?.sessionId === 'string' && typeof ids?.messageId === 'string') {
    await markSendOutcome(ids.sessionId, ids.messageId, 'unknown', {
      code: 'delivery_unknown',
      message: 'Walnut could not read this held message back. Check the conversation before sending it again.',
    });
  }
  log.session.error('send-queue: unreadable banked send; removing', { file, err: String(err) });
  await fsp.rm(file, { force: true }).catch(() => {});
}

/**
 * The host's daemon has no primary behind it: deliver a banked row by the host's
 * direct path, when that can be neither a second delivery nor an overtaking one
 * (send-direct-gate.ts). `freed`: the Mac already gave it back. Returns what the
 * caller does with the rest of the queue.
 */
async function deliverBankedDirect(
  op: QueuedSessionSend, file: string, opts: { freed?: boolean; pass?: GatePass } = {},
): Promise<'delivered' | 'dropped' | 'hold-session' | 'hold-host'> {
  const prior = await readSendOutcome(op.sessionId, op.messageId);
  if (prior && isFinalOutcome(prior.state)) {
    await removeRow(op, file);
    return 'dropped';
  }
  if (!opts.freed) {
    // A relay of it went out once: the Mac's queue may hold it, and only that
    // queue may deliver it, unless the Mac says it does not hold it. And never
    // ahead of an earlier message of the session still waiting anywhere.
    const gate = await directDeliveryGate(op, { mayBeOnMac: op.provablyUnsent !== true || prior?.state === 'maybe-relayed', pass: opts.pass });
    if (gate === 'delivered') {
      await markSendOutcome(op.sessionId, op.messageId, 'relayed');
      await removeRow(op, file);
      return 'delivered';
    }
    if (gate === 'removed') {
      await settleUnsendable({ ...op, provablyUnsent: true }, file, 'removed_on_mac', REMOVED_ON_MAC, 'it was removed on the Mac');
      return 'dropped';
    }
    if (gate === 'stopped') {
      // A stop on the Mac parked it there: it never runs, by any path.
      const { STOPPED_AFTER_SEND } = await import('./sessions/cloud-stop-fence.js');
      await settleUnsendable({ ...op, provablyUnsent: true }, file, 'session_stopped', STOPPED_AFTER_SEND, 'the session was stopped');
      return 'dropped';
    }
    if (gate === 'hold') return 'hold-session';
  }
  if (op.provablyUnsent !== true) {
    // The Mac will not deliver it: from here on only this path may, so the row says so first.
    op = { ...op, provablyUnsent: true };
    try { await writeJsonFile(file, op); } catch { /* the outcome ('withdrawn') says the same */ }
  }
  const host = op.hostName ?? op.host;
  const { deliverDirectToHost } = await import('./sessions/direct-host-send.js');
  // deliverDirectToHost re-checks the stop right before it delivers: a stop may
  // have come in while the questions above were out.
  const outcome = await deliverDirectToHost({
    host: op.host, sessionId: op.sessionId, text: op.message, messageId: op.messageId,
    stopFence: op.stopFence ?? null, cwd: op.cwd, model: op.model, acceptedAt: rowAcceptedAt(op),
  });
  if (outcome.ok) {
    await markSendOutcome(op.sessionId, op.messageId, 'delivered-direct');
    await removeRow(op, file);
    log.session.info('send-queue: banked send delivered by the host directly (no primary behind it)', {
      opId: op.opId, sessionId: op.sessionId, host: op.host, messageId: op.messageId, path: outcome.path,
    });
    return 'delivered';
  }
  if (outcome.kind === 'refused') {
    if (outcome.code === 'session_stopped') {
      // The domain rule: a message from before the latest stop never runs.
      log.session.warn('send-queue: banked send predates the latest stop; telling the phone', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
      });
      await settleUnsendable(op, file, 'session_stopped', outcome.message, 'the session was stopped');
      return 'dropped';
    }
    // The host could not resume it now; a later try may.
    log.session.warn('send-queue: host could not take a banked send directly; keeping it', {
      opId: op.opId, sessionId: op.sessionId, reason: outcome.message,
    });
    return 'hold-session';
  }
  if (outcome.ambiguous) {
    // It may have run. A second delivery is worse than a missing one (an agent
    // doing the work twice), so it is not sent again; the phone is told so
    // (delivery_unknown), whether it asks or retries.
    await markSendOutcome(op.sessionId, op.messageId, 'maybe-direct', { code: 'delivery_unknown', message: unknownFateMessage(host) });
    await removeRow(op, file);
    log.session.error('send-queue: direct delivery of a banked send lost its answer; not sending it again', {
      opId: op.opId, sessionId: op.sessionId, host: op.host, messageId: op.messageId, err: outcome.message,
    });
    return 'dropped';
  }
  return 'hold-host';
}

// The Mac's answer for one message lives with the order rule (send-direct-gate.ts).
export { askMacToWithdraw } from './send-direct-gate.js';
