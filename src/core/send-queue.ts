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
 * the phone already holds. Every event that makes a held send deliverable
 * drains it at once, and a 60s sweep is the floor (send-queue-drain.ts).
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
 * `enqueueMessage`), and the relay fates kept with the Mac's queue
 * (core/relay-fates.ts) close the post-delivery window.
 *
 * ## What is deliberately NOT queued
 *
 * - A relay failure that MIGHT have enqueued on the primary (transport death
 *   mid-relay, relay timeout). Queuing that would risk a second delivery the
 *   moment the ledger has rotated; the route keeps reporting those as 503 so
 *   the phone retries with the same id and the dedupe decides.
 * - A session the primary declared unknown/dead (404/409): a domain answer,
 *   not a transport gap.
 *
 * Image sends are held too: the pictures reach the CLI as files on the
 * SESSION'S HOST, so a held one keeps its pictures here until the drain saves
 * them there (sessions/cloud-images.ts), and never goes as text alone.
 *
 * ## Direct delivery, and the ledger that keeps it single
 *
 * A host's daemon that has no primary behind it answers the relay at once with
 * "no primary server connected" (it forwarded nothing). A row nothing ever
 * carried toward the primary (`provablyUnsent`: banked with no bridge, or behind
 * an earlier held send) is then delivered by the host's direct path
 * (sessions/direct-host-send.ts) instead of waiting for the primary, when no
 * earlier message of its session may still wait anywhere (send-direct-gate.ts).
 * A row a relay once carried may already sit in the primary's queue, so it waits
 * for the primary, unless the Mac gives it back. The outcomes ledger below remembers the
 * same facts for messages that were never banked, so a phone retry of the same
 * messageId is never a second delivery by the other path.
 *
 * Files: cache/send-queue/<opId>.json, cache/send-queue/outcomes/ (NON-git on
 * both boxes).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withFileLock } from '../utils/file-lock.js';
import { CLOUD_MODE, SEND_QUEUE_DIR } from '../constants.js';
import { writeJsonFile } from '../utils/fs.js';
import { log } from '../logging/index.js';
import { readSendOutcome, unknownFateMessage } from './send-outcomes.js';
import { removeHeldImages, storeHeldImages, withImagePaths, type SessionImage } from './sessions/cloud-images.js';

export interface QueuedSessionSend {
  opId: string;
  at: string;
  sessionId: string;
  /** The exec host alias the send must be relayed to (NOT always '__local__'). */
  host: string;
  message: string;
  /** Client-stable `qm-*` id — the exactly-once anchor end to end. */
  messageId: string;
  stopFence?: string | null;
  /**
   * true = nothing has ever carried this message toward the primary (it was
   * banked with no bridge, or behind an earlier held send), so the host's direct
   * path may deliver it when no primary is behind the host. Absent or false = a
   * relay went out and its answer was lost: the primary MAY hold it, so only the
   * relay (whose queue dedupes on messageId) may deliver it. Rows from older
   * builds lack the flag and are the safe, relay-only kind.
   */
  provablyUnsent?: boolean;
  /** Resume hints for the direct path (the daemon may have lost the session's record). */
  cwd?: string;
  model?: string;
  /** When the phone's send reached the companion (ms). A stop asked for after it does not hold it back. */
  acceptedAt?: number;
  /** The host's display name when banked, for the sentence the phone gets if the row cannot go. */
  hostName?: string;
  /**
   * The host's own link to the companion did not answer a ping while the relay
   * was out: the wait is for the host, not for the Mac behind it, though the
   * bridge still looks connected (a half-open link). Cleared when the host
   * answers for the hop behind it.
   */
  hostSilent?: boolean;
  /**
   * The host answered that no Mac is behind it (the Mac's link to the host is
   * down): whatever the row waits for now, it waits on the Mac, though nothing
   * may ever have carried it there.
   */
  macLinkDown?: boolean;
  /**
   * Banked behind an earlier held message of its session that waited on the
   * Mac: this one waits on the Mac too (it goes after that one, through the
   * same queue), also once that one has gone, until something says otherwise.
   */
  behindMac?: boolean;
  /**
   * The send's pictures, not yet saved on the host: their media types, the
   * pictures themselves waiting beside the row (cloud-images.ts). The drain
   * saves them first and the text then names the files.
   */
  heldImages?: string[];
}

export interface BankOptions {
  provablyUnsent?: boolean;
  cwd?: string;
  model?: string;
  acceptedAt?: number;
  hostName?: string;
  hostSilent?: boolean;
  macLinkDown?: boolean;
  /** Pictures the host does not have yet: kept with the row until the drain saves them. */
  images?: SessionImage[];
}

export async function bindSessionSendFence(sessionId: string, messageId: string, candidate: string | null): Promise<string | null> {
  const key = createHash('sha256').update(JSON.stringify([sessionId, messageId])).digest('hex');
  const target = path.join(SEND_QUEUE_DIR, 'fences', `${key}.json`);
  return withFileLock(target, async () => {
    try {
      const saved = JSON.parse(await fsp.readFile(target, 'utf8'));
      if (saved.sessionId !== sessionId || saved.messageId !== messageId
        || (saved.stopFence !== null && typeof saved.stopFence !== 'string')) throw new Error('Invalid send stop fence');
      return saved.stopFence as string | null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const file = await fsp.open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify({ sessionId, messageId, stopFence: candidate }) + '\n');
        await file.sync();
      } finally { await file.close(); }
      await fsp.rename(temporary, target);
    } finally { await fsp.rm(temporary, { force: true }); }
    const directory = await fsp.open(path.dirname(target), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
    return candidate;
  });
}

let opSeq = 0;

/**
 * Row ids sort in the order sends reached the companion, not the order they
 * were banked: a send held at its answer deadline is banked seconds after a
 * later one held behind it, and must still go first (send-order.ts).
 */
function mintOpId(acceptedAt: number = Date.now()): string {
  return `${Math.floor(acceptedAt).toString().padStart(15, '0')}-${(opSeq++ % 10_000).toString().padStart(4, '0')}`;
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
  sessionId: string, host: string, message: string, messageId: string, stopFence: string | null = null,
  opts: BankOptions = {},
): Promise<string | null> {
  if (!CLOUD_MODE) return null;
  // One row per message: a phone retry of a send already held here is the same send.
  const existing = await bankedSendFor(messageId);
  if (existing) return existing.opId;
  const opId = mintOpId(typeof opts.acceptedAt === 'number' ? opts.acceptedAt : undefined);
  const images = opts.images ?? [];
  if (images.length && !(await storeHeldImages(opId, images))) return null;
  const earlier = (await listBankedSends()).find((row) => row.sessionId === sessionId);
  const behindMac = earlier ? (await waitOf(earlier)).onMac : false;
  const op: QueuedSessionSend = {
    opId, at: new Date().toISOString(), sessionId, host, message, messageId, stopFence,
    ...(opts.provablyUnsent ? { provablyUnsent: true } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(typeof opts.acceptedAt === 'number' ? { acceptedAt: opts.acceptedAt } : {}),
    ...(opts.hostName ? { hostName: opts.hostName } : {}),
    ...(opts.hostSilent ? { hostSilent: true } : {}),
    ...(opts.macLinkDown ? { macLinkDown: true } : {}),
    ...(behindMac ? { behindMac: true } : {}),
    ...(images.length ? { heldImages: images.map((img) => img.mediaType) } : {}),
  };
  try {
    // Durable: the phone is told "held" on the strength of this file.
    await writeJsonFile(path.join(SEND_QUEUE_DIR, `${op.opId}.json`), op, { durable: true });
    log.session.info('send-queue: phone send banked (bridge unavailable)', {
      opId: op.opId, sessionId, host, messageId, chars: message.length,
    });
    return op.opId;
  } catch (err) {
    log.session.error('send-queue: FAILED to bank phone send; message will not reach the session', {
      sessionId, host, messageId, err: String(err),
    });
    await removeHeldImages(opId, images.length);
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
      await removeHeldImages(op.opId, op.heldImages?.length ?? 0);
      log.session.info('send-queue: banked send dropped (relay confirmed late)', {
        opId: op.opId, sessionId: op.sessionId, messageId,
      });
      return true;
    } catch { continue; }
  }
  return false;
}

/**
 * The route's own save of a held send's pictures finished after the send was
 * held: the row's text names the files now, and the pictures kept for it go.
 */
export async function adoptSavedImages(messageId: string, savedPaths: string[]): Promise<void> {
  const row = await bankedSendFor(messageId);
  if (!row?.heldImages?.length) return;
  const next: QueuedSessionSend = { ...row, message: withImagePaths(row.message, savedPaths) };
  delete next.heldImages;
  try {
    await writeJsonFile(path.join(SEND_QUEUE_DIR, `${row.opId}.json`), next);
    await removeHeldImages(row.opId, row.heldImages.length);
  } catch (err) {
    // The drain saves them again from the kept copies (a second copy on the host, never a lost picture).
    log.session.warn('send-queue: could not record pictures saved for a held send', { messageId, err: String(err) });
  }
}

/** Every banked send, oldest first (opIds sort chronologically). Unreadable rows are skipped. */
export async function listBankedSends(): Promise<QueuedSessionSend[]> {
  let names: string[];
  try {
    names = (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out: QueuedSessionSend[] = [];
  for (const name of names) {
    try {
      const op = JSON.parse(await fsp.readFile(path.join(SEND_QUEUE_DIR, name), 'utf-8')) as QueuedSessionSend;
      if (op?.opId && op.sessionId && op.messageId) out.push(op);
    } catch { /* the sweep removes it */ }
  }
  return out;
}

/** The banked row for a messageId, if this companion holds it. */
export async function bankedSendFor(messageId: string): Promise<QueuedSessionSend | null> {
  if (!CLOUD_MODE) return null;
  return (await listBankedSends()).find((op) => op.messageId === messageId) ?? null;
}

/** Does this companion hold an undelivered send for the session? A newer one must wait behind it. */
export async function sessionHasBankedSend(sessionId: string): Promise<boolean> {
  if (!CLOUD_MODE) return false;
  return (await listBankedSends()).some((op) => op.sessionId === sessionId);
}

// The ledger (send-outcomes.ts), re-exported: callers know one module.
export {
  markSendOutcome, readSendOutcome, unknownFateMessage, isFinalOutcome, SEND_HORIZON_MS,
  markRelayIntent, clearRelayIntent,
  type SendOutcomeState, type SendOutcome,
} from './send-outcomes.js';

/**
 * Who a held message waits on, for the phone's sentence. The hop actually being
 * waited on is named, never just the session's host:
 *  - a row nothing ever carried, its host off the companion's bridge (or on it
 *    but not answering a ping, `hostSilent`), or a host that could not take it
 *    directly: the HOST ("Can't reach <host> right now.");
 *  - a relay-only row (a relay carried it once, so only the Mac's queue may
 *    deliver it until the Mac confirms it does not hold it) while the host is
 *    on the bridge: the host is answering, the wait is for the Mac ("Your Mac
 *    can't reach <host> right now.", or "Your Mac isn't connected right now."
 *    when the Mac is off the companion too). The same for a row whose host
 *    said no Mac is behind it (`macLinkDown`), however it got there. The same
 *    for a row banked behind one held for the Mac (`behindMac`): when that one
 *    goes, this one is still not the host's to wait on (gate r4 matrix, W2: the
 *    probe at the clear was told the host could not be reached);
 *  - either of those while the host's link to the companion came up AFTER the
 *    message was held, within the last minute: the host just restarted or
 *    redialed, and its daemon drops every link when it does, so the Mac's link
 *    to it is down because of the HOST ("<host> is reconnecting."). Gate r3, D2:
 *    the host daemon restarted, the Mac answered at once, and the phone was
 *    told the Mac could not reach the host.
 * `waitingFor` is the alias in v1 terms ("" = the Mac). A message held behind an
 * earlier one waits on what the session's oldest held message waits on.
 */
export interface HeldFor { waitingFor: string; waitingForName: string; heldNote: string }

export async function heldFor(sessionId: string): Promise<HeldFor | null> {
  const first = (await listBankedSends()).find((op) => op.sessionId === sessionId);
  return first ? (await waitOf(first)).held : null;
}

/** What a session's oldest held row waits on, and whether that is the Mac. */
async function waitOf(first: QueuedSessionSend): Promise<{ held: HeldFor; onMac: boolean }> {
  const onMac = (first.provablyUnsent !== true || first.macLinkDown === true || first.behindMac === true)
    && first.hostSilent !== true && first.host !== MAC_ALIAS && await hostOnBridge(first.host);
  if (!onMac) return { held: heldOn(first, false), onMac: false };
  const macOnBridge = await hostOnBridge(MAC_ALIAS);
  if (macOnBridge && await hostCameBackAfter(first)) {
    const name = first.hostName ?? first.host;
    return { held: { waitingFor: first.host, waitingForName: name, heldNote: `${name} is reconnecting.` }, onMac: false };
  }
  return { held: heldOn(first, true, macOnBridge), onMac: true };
}

/** How long a host's fresh link explains a Mac link that is still down. */
const HOST_BACK_GRACE_MS = 60_000;

/** The host's link to the companion came up after this row was held, within the grace. */
async function hostCameBackAfter(row: QueuedSessionSend): Promise<boolean> {
  const accepted = typeof row.acceptedAt === 'number' ? row.acceptedAt : Date.parse(row.at);
  try {
    const { bridgeHosts } = await import('../web/ws/bridge-registry.js');
    const since = bridgeHosts().find((h) => h.hostAlias === row.host)?.since;
    return typeof since === 'number' && Number.isFinite(accepted) && since > accepted
      && Date.now() - since < HOST_BACK_GRACE_MS;
  } catch {
    return false;
  }
}

/** The bridge alias of the Mac's own daemon (v1 calls it ""). */
const MAC_ALIAS = '__local__';

function heldOn(row: Pick<QueuedSessionSend, 'host' | 'hostName'>, onMac: boolean, macOnBridge = true): HeldFor {
  const name = row.hostName ?? (row.host === MAC_ALIAS ? 'your Mac' : row.host);
  if (onMac) {
    return {
      waitingFor: '', waitingForName: 'your Mac',
      heldNote: macOnBridge ? `Your Mac can't reach ${name} right now.` : "Your Mac isn't connected right now.",
    };
  }
  return {
    waitingFor: row.host === MAC_ALIAS ? '' : row.host, waitingForName: name,
    heldNote: `Can't reach ${name} right now.`,
  };
}

async function hostOnBridge(host: string): Promise<boolean> {
  try {
    const { bridgeForHost } = await import('../web/ws/bridge-registry.js');
    return bridgeForHost(host).connected;
  } catch {
    return false;
  }
}

/** The phone's answer for a message it was told is held: GET /sessions/:id/messages/:messageId. */
export type SendStatus =
  | ({ state: 'held' } & HeldFor)
  | { state: 'delivered' }
  | { state: 'not_sent'; code: string; message: string }
  | { state: 'unknown'; message: string };

/**
 * What became of a message, from what this companion holds: a banked row (still
 * held), else the outcomes ledger. Nothing known = 'unknown' (the ledger keeps
 * 24h; a phone asking later has outlived it).
 */
export async function sendStatus(sessionId: string, messageId: string): Promise<SendStatus> {
  const row = (await listBankedSends()).find((op) => op.messageId === messageId && op.sessionId === sessionId);
  if (row) return { state: 'held', ...(await heldFor(sessionId) ?? heldOn(row, false)) };
  const outcome = await readSendOutcome(sessionId, messageId);
  switch (outcome?.state) {
    case 'relayed':
    case 'delivered-direct':
      return { state: 'delivered' };
    case 'not-sent':
      return { state: 'not_sent', code: outcome.code ?? 'not_sent', message: outcome.message ?? 'Not sent.' };
    case 'unknown':
    case 'maybe-direct':
    case 'maybe-relayed':
    case 'withdrawn':
    case 'direct-intent':
      return { state: 'unknown', message: outcome.message ?? unknownFateMessage("the session's host") };
    default:
      return { state: 'unknown', message: 'Walnut has no record of this message any more. Check the conversation before sending it again.' };
  }
}

/** Pending banked sends (diagnostics/tests). */
export async function queuedSessionSendCount(): Promise<number> {
  try {
    return (await fsp.readdir(SEND_QUEUE_DIR)).filter((n) => n.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

// The drain (one pass per host, its triggers, the quick re-drain ladder) lives
// in send-queue-drain.ts; re-exported so callers know one module.
export { flushSendQueue, noteSendPathReady, startSendQueueFlush } from './send-queue-drain.js';
