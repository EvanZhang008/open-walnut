/**
 * Cloud REPLICA: may a phone message go to its host by the direct path now?
 * (sessions/direct-host-send.ts; the sweep and the send route both ask here.)
 *
 * The rule (gate r2, B2), on every path that can start a delivery: per
 * session, nothing starts a delivery while an earlier accepted message of the
 * session may still be waiting anywhere: held here, in the Mac's queue, or on
 * a relay whose answer was lost. The Mac answers for its queue when it can be
 * asked (mobile-relay-ledger.ts): 'behind' and 'delivering' mean wait. When it
 * cannot be asked, a message a relay carried waits for it, and so does one
 * whose session has relayed messages nobody has seen delivered
 * (send-relay-index.ts), until their delivery markers show up on the host.
 *
 * A stop the phone asked for through this companion that nobody answered
 * holds every direct delivery of the session (cloud-stop-fence.ts): it may
 * have landed on the Mac, which alone applies it to a message.
 *
 * And for a crash (B3): a direct delivery writes its intent before its first
 * request that can start a turn (send-outcomes.ts 'direct-intent'). A pass
 * that finds an intent with no delivery running in this process asks the host
 * whether the message reached the CLI (its delivery marker in the host's
 * stream), and never sends it blind.
 */

import { log } from '../logging/index.js';
import { markSendOutcome } from './send-outcomes.js';
import { confirmSessionRelays, unconfirmedSessionRelays } from './send-relay-index.js';

/** Asking the Mac whether its queue holds a message (one control relay over the Mac's own bridge). */
const WITHDRAW_TIMEOUT_MS = 10_000;
/** How far back the host's stream is read for delivery markers when its daemon cannot search it (no marker-find-v1). */
const MARKER_TAIL_BYTES = 2 * 1024 * 1024;
const MARKER_READ_TIMEOUT_MS = 10_000;
/**
 * A direct delivery whose markers ride inside it (send-markers-v1) and whose
 * marker is missing proves the CLI never got the line only once nothing can
 * still be writing it: the daemon's own FIFO write deadline is 20 s, and a
 * frame of the send could still be on its way. A minute covers both.
 */
const ORDERED_INTENT_SETTLE_MS = 60_000;
/** Hosts whose daemon answered that it has no markers.find, until this time (it upgrades on reconnect). */
const noMarkerFind = new Map<string, number>();
const NO_MARKER_FIND_RETRY_MS = 10 * 60_000;

export type MacVerdict = 'free' | 'delivered' | 'removed' | 'stopped' | 'hold' | 'unreachable';

/**
 * The Mac's answer for one message. 'free' = its queue does not hold it and
 * never will (it removed a pending row, or never saw it, and fenced the id);
 * 'delivered' = it ran there; 'removed' = a person removed it there;
 * 'stopped' = a stop there parked it (it never runs); 'hold' = it is
 * mid-delivery, parked there for a person to retry, or an earlier message of
 * the session waits there;
 * 'unreachable' = the Mac could not be asked (offline, slow, or a Mac without
 * the action).
 */
export async function askMacToWithdraw(
  op: { opId?: string; sessionId: string; messageId: string }, timeoutMs = WITHDRAW_TIMEOUT_MS,
): Promise<MacVerdict> {
  const askedAt = Date.now();
  try {
    const { callPrimaryControl } = await import('../web/routes/v1-control-relay.js');
    const reply = await callPrimaryControl('message.withdraw', op.sessionId, { messageId: op.messageId }, Math.max(500, timeoutMs));
    if (!reply.ok) {
      log.session.info('send-queue: could not ask the Mac about a send', {
        opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, failure: reply.failure.kind,
      });
      return 'unreachable';
    }
    const state = reply.result.state;
    log.session.info('send-queue: the Mac answered for a send', { opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, state });
    if (state === 'withdrawn' || state === 'not-received') {
      // Nothing of the session waits ahead of it there: every relay before the question has left the Mac's queue.
      await confirmSessionRelays(op.sessionId, { before: askedAt });
      return 'free';
    }
    if (state === 'delivered') return 'delivered';
    if (state === 'removed') return 'removed';
    if (state === 'stopped') {
      // A stop on the Mac parked it. The Mac names that stop: every other held
      // message of the session sent under an older one is fenced by it now,
      // not once the session list shows it (it may never, with the Mac away).
      const { noteMacStop } = await import('./sessions/cloud-stop-fence.js');
      await noteMacStop(op.sessionId, (reply.result as { stop?: unknown }).stop);
      return 'stopped';
    }
    return 'hold';
  } catch (err) {
    log.session.warn('send-queue: asking the Mac about a send failed', { opId: op.opId, err: String(err) });
    return 'unreachable';
  }
}

/**
 * What the host's stream shows for some message ids. `complete`: the whole
 * stream was searched; `ordered`: the host's daemon writes a send's markers
 * inside the delivery (send-markers-v1). Both false for a tail read.
 */
export interface MarkerLookup { found: Set<string>; complete: boolean; ordered: boolean }

/**
 * Which of `ids` have a delivery marker in the session's stream on its host
 * (the Mac's runner and the direct path both write one per message, carrying
 * its id). The host's daemon searches its own file (markers.find, marker-find-
 * v1: gate r3, N6); a daemon without it gets the old read of the stream's
 * newest 2 MB. null = the host could not be read. A search that did not reach
 * back far enough simply finds fewer: never a false "delivered".
 */
export async function deliveryMarkersOnHost(
  host: string, sessionId: string, ids: string[], timeoutMs = MARKER_READ_TIMEOUT_MS,
): Promise<MarkerLookup | null> {
  if (ids.length === 0) return { found: new Set(), complete: true, ordered: false };
  const end = Date.now() + Math.max(500, timeoutMs);
  let bridge: typeof import('../web/ws/bridge-registry.js');
  try { bridge = await import('../web/ws/bridge-registry.js'); } catch { return null; }
  if ((noMarkerFind.get(host) ?? 0) <= Date.now()) {
    try {
      const res = await bridge.bridgeRequest(host, 'markers.find', { sid: sessionId, ids }, Math.max(500, end - Date.now()));
      if (res.ok !== false && Array.isArray(res.found)) {
        return {
          found: new Set((res.found as unknown[]).filter((id): id is string => typeof id === 'string' && ids.includes(id))),
          complete: res.complete === true, ordered: res.ordered === true,
        };
      }
      // A daemon that has the command and could not search: the host cannot be read now.
      if (res.ok === false && !/unknown command|not permitted over bridge/i.test(String(res.error ?? ''))) return null;
      // One that predates it (an unknown or refused command, a reply without the shape): the old read, for a while.
      noMarkerFind.set(host, Date.now() + NO_MARKER_FIND_RETRY_MS);
    } catch (err) {
      if (err instanceof bridge.BridgeOfflineError) return null;
      // No answer to the command: the old read, in what is left of the budget.
    }
  }
  try {
    const res = await bridge.bridgeRequest(host, 'read-history', { sid: sessionId, tailBytes: MARKER_TAIL_BYTES }, Math.max(500, end - Date.now()));
    if (res.ok !== true || typeof res.main !== 'string') return res.ok === true ? { found: new Set(), complete: false, ordered: false } : null;
    const found = new Set<string>();
    for (const id of ids) {
      if ((res.main as string).includes(`"walnutMessageId":${JSON.stringify(id)}`)) found.add(id);
    }
    return { found, complete: false, ordered: false };
  } catch {
    return null;
  }
}

/** Tests only: forget which hosts lacked markers.find. */
export function resetMarkerFindMemo(): void {
  noMarkerFind.clear();
}

export type DirectGate = 'go' | 'hold' | 'delivered' | 'removed' | 'stopped';

/** What one sweep pass learned about the Mac, shared by its rows. */
export interface GatePass { macUnreachable: boolean }

/**
 * May this message start a direct delivery now? `mayBeOnMac`: a relay carried
 * it, so the Mac's queue may hold it and only the Mac's answer frees it.
 * `budgetMs` bounds the questions (the route answers the phone by a deadline).
 * A 'go' records the message 'withdrawn' first: from here only the direct path
 * may deliver it, and it is never relayed again (the Mac fenced it).
 */
export async function directDeliveryGate(
  op: { opId?: string; host: string; sessionId: string; messageId: string },
  opts: { mayBeOnMac: boolean; budgetMs?: number; pass?: GatePass },
): Promise<DirectGate> {
  const end = Date.now() + (opts.budgetMs ?? WITHDRAW_TIMEOUT_MS + MARKER_READ_TIMEOUT_MS);
  // Before the Mac is asked to give the message back: a message it fenced can
  // only go directly, and a direct one would run past a stop that landed there.
  const { stopAskUnconfirmed } = await import('./sessions/cloud-stop-fence.js');
  if (await stopAskUnconfirmed(op.sessionId)) {
    log.session.info('send-queue: a stop asked here is not answered yet; holding for the Mac', {
      opId: op.opId, sessionId: op.sessionId, messageId: op.messageId,
    });
    return 'hold';
  }
  // A Mac that did not answer once this pass is not asked again for every row.
  const verdict = opts.pass?.macUnreachable ? 'unreachable' : await askMacToWithdraw(op, Math.min(WITHDRAW_TIMEOUT_MS, end - Date.now()));
  if (verdict === 'unreachable' && opts.pass) opts.pass.macUnreachable = true;
  if (verdict === 'delivered' || verdict === 'removed' || verdict === 'stopped' || verdict === 'hold') return verdict;
  if (verdict === 'free') {
    await markSendOutcome(op.sessionId, op.messageId, 'withdrawn');
    return 'go';
  }
  // The Mac could not be asked.
  if (opts.mayBeOnMac) return 'hold';
  const earlier = await unconfirmedSessionRelays(op.sessionId, op.messageId);
  if (earlier.length === 0) return 'go';
  if (end - Date.now() < 500) return 'hold';
  const lookup = await deliveryMarkersOnHost(op.host, op.sessionId, earlier, end - Date.now());
  if (!lookup) return 'hold';
  const seen = lookup.found;
  await confirmSessionRelays(op.sessionId, [...seen]);
  if (seen.size < earlier.length) {
    log.session.info('send-queue: an earlier relayed message of the session may still wait on the Mac; holding', {
      opId: op.opId, sessionId: op.sessionId, messageId: op.messageId, waiting: earlier.filter((id) => !seen.has(id)),
      searchedAll: lookup.complete,
    });
    return 'hold';
  }
  return 'go';
}

/**
 * A direct delivery whose intent is on disk and that no delivery in this
 * process is running: did it reach the CLI? 'delivered' = its marker is on the
 * host; 'not-delivered' = it provably never did: its marker rode inside the
 * send (send-markers-v1, `intent.ordered`), the host searched its whole stream,
 * found none, and nothing can still be writing it; 'unknown' = the host shows
 * none but it may still have run (a marker written after the delivery, or a
 * search that did not reach back far enough), so it is never sent again;
 * 'unreachable' = ask again later (also while an ordered delivery may still be
 * in flight).
 */
export async function resolveDirectIntent(
  op: { host: string; sessionId: string; messageId: string },
  intent: { ordered?: boolean; at?: string } = {},
): Promise<'delivered' | 'not-delivered' | 'unknown' | 'unreachable'> {
  const lookup = await deliveryMarkersOnHost(op.host, op.sessionId, [op.messageId]);
  if (!lookup) return 'unreachable';
  if (lookup.found.has(op.messageId)) return 'delivered';
  if (intent.ordered !== true || !lookup.complete || !lookup.ordered) return 'unknown';
  const age = Date.now() - Date.parse(intent.at ?? '');
  return Number.isFinite(age) && age >= ORDERED_INTENT_SETTLE_MS ? 'not-delivered' : 'unreachable';
}
